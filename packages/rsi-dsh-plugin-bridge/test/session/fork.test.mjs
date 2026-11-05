import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../../src/index.mjs';
import { restoreMapping } from '../../src/history/history.mjs';

for (const clocks of [false,true]) {
const cohortRoot = clocks ? process.env.RSI_DSH_MARKET_COHORT : process.env.RSI_DSH_COHORT;
test('Full, Last, empty and nested cuts restore exact original projections without omitted messages or dangling references'+(clocks?' with published time-context':''), { skip: !cohortRoot }, async t => {
  const facts = [
    { seq: 6, timestamp_ms: 60, type: 'turn_accepted', turn_id: 'turn-2', text: 'Selected conversation from canonical Fact' },
    { seq: 7, timestamp_ms: 70, type: 'step_started', turn_id: 'turn-2', step_id: 'step-2' },
    { seq: 8, timestamp_ms: 80, type: 'input_message_claimed', turn_id:'turn-2', step_id:'step-2', source: { type: 'human', message_id: 'entered' }, content: [{ type: 'text', text: 'Captured suffix' }] },
    { seq: 9, timestamp_ms: 90, type: 'step_inputs_prepared', turn_id:'turn-2', step_id:'step-2', decision:{kind:'enter',messages:
      [6,8].map(fact_seq=>({kind:'claimed',claim:{fact_seq,ordinal:0}}))} },
    { seq: 10, timestamp_ms: 100, type: 'turn_terminal', turn_id: 'turn-2', outcome: { status: 'completed' } },
  ];
  const request = async (method, args) => {
    assert.equal(method, 'agent.history.read'); assert.equal(args.operation_id, 'transfer'); assert.equal(args.session_id, 'parent');
    const next = facts.find(fact => fact.seq > args.after_seq); assert.ok(next);
    const json = JSON.stringify([next]);
    return { through_seq: next.seq, offset: 0, next_offset: Buffer.byteLength(json), total_bytes: Buffer.byteLength(json), json };
  };
  const configuration=clocks ? {format:1,plugins:['@deepseek-ai/dsh-time-context']} : undefined;
  const bridge = await createBridge({ cohortRoot, request, configuration }); t.after(() => bridge.close());
  const events = [];
  const add = (type, data, opts = {}) => {
    const event = { seq: events.length, time: events.length + 1, type, data, ...opts };
    events.push(event); return event.seq;
  };
  const message = (id, role, text) => ({ id, role, content: [{ type: 'text', text }], source: { kind: role === 'system' ? 'system-prompt' : 'user' } });
  const boundary = (turn, fact) => ({ turn, rsi: { session: 'parent', fact, turn: `turn-${turn}` } });
  add('plan/mode', { active: true });
  add('request/header', { header: { config: { provider: 'provider', model: 'model' } }, reason: 'initial' });
  const head = add('system/message', { turn: 0, step: 0, message: message('system', 'system', 'Old instructions') }, { surfaceOp: 'append' });
  add('turn/start', boundary(1, 1));
  add('user/message', message('excluded', 'user', 'EXCLUDED_PRIVATE_CONVERSATION'), { surfaceOp: 'append' });
  add('todo/write', { todos: [{ content: 'Prior state', status: 'completed' }] });
  add('turn/end', { ...boundary(1, 5), reason: { kind: 'completed' } });
  add('plan/mode', { active: false });
  add('turn/start', boundary(2, 6));
  add('user/message', message('visible', 'user', 'Selected conversation'), { surfaceOp: 'append' });
  add('system/message', { turn: 2, step: 1, message: message('system', 'system', 'New instructions') },
    { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] });
  add('request/header', { header: { config: { provider: 'provider', model: 'model' } }, reason: 'series' });
  add('todo/write', { todos: [{ content: 'Selected state', status: 'pending' }] });
  add('turn/end', { ...boundary(2, 10), reason: { kind: 'completed' } });
  const mapping = restoreMapping(); mapping.factCursor = 10; mapping.turn = 2;
  await bridge.load({ header: { version: 4, id: 'parent', createdAt: 1, isSeeded: false }, events, mapping, revision: 3 });
  const original = bridge.canonical('parent');
  const fork = (id, afterFact, throughFact = 10, source = 'parent') => bridge.fork(source,
    { header: { version: 4, id, createdAt: 20, isSeeded: true }, afterFact, throughFact, includeInherited: afterFact === 0 });
  const full = fork('full', 0);
  assert.deepEqual(full.events.slice(0,full.inheritedEventCount),original.events);
  assert.deepEqual(full.events[full.inheritedEventCount],{seq:original.events.length,time:20,
    type:'session/end-seed',data:{inherited:true}});
  const last = fork('last', 5);
  assert.equal(last.lineage.seedEventCount, 2);
  if(clocks) { assert.ok([2,3].includes(last.seed.timeContext.ver));assert.equal(last.seed.timeContext.seq,1); }
  assert.equal(last.seed.plan.seq, 1);
  assert.equal(last.seed.plan.val.active, false);
  assert.equal(last.seed.plan.val.activeAtLastHeader, true, 'metadata replay must not overwrite the exact baseline');
  assert.ok(!JSON.stringify(last).includes('EXCLUDED_PRIVATE_CONVERSATION'));
  assert.deepEqual(last.events.map(event => event.seq), last.events.map((_, index) => index));
  const replacement = last.events.find(event => event.surfaceOp?.op === 'replace');
  assert.deepEqual(replacement.sourceEventSeqs, [0]);
  assert.equal(replacement.surfaceOp.startSeq, 0);
  await bridge.load(last);
  assert.deepEqual(bridge.project('last').values, bridge.project('parent').values);
  assert.equal(bridge.canonical('last').mapping.factCursor, 0);
  const nested = fork('nested', 0, 0, 'last');
  assert.equal(nested.events[nested.inheritedEventCount].type,'session/end-seed');
  assert.equal(nested.inheritedEventCount,last.events.length);
  await bridge.load(nested);
  assert.deepEqual(bridge.project('nested').values, bridge.project('last').values);
  assert.ok(!JSON.stringify(nested).includes('EXCLUDED_PRIVATE_CONVERSATION'));
  const empty = fork('empty', 10);
  await bridge.load(empty);
  assert.equal(empty.events.filter(event => event.type === 'user/message').length, 0);
  assert.deepEqual(bridge.project('empty').values, bridge.project('parent').values);
  const restarted = await createBridge({ cohortRoot, configuration }); t.after(() => restarted.close());
  await restarted.loadAgent({ session_id: 'last', created_at: 20, revision: 1, events: last.events,
    checkpoint: { seed: last.seed, lineage: last.lineage, mapping: last.mapping, pendingIntent: null } });
  assert.deepEqual(restarted.project('last'), bridge.project('last'));
  assert.deepEqual(bridge.canonical('parent'), original);
  const captured = restoreMapping(); captured.factCursor = 5; captured.turn = 1;
  bridge.forks.begin({ operation_id: 'transfer', session_id: 'parent', created_at: 1, count: 8,
    checkpoint: { mapping: captured }, after_seq: 5, through_seq: 10, include_inherited: false });
  bridge.forks.append({ operation_id: 'transfer', offset: 0, events: original.events.slice(0, 8) });
  const result = await bridge.forks.finish({ operation_id: 'transfer' });
  const page = bridge.forks.read({ operation_id: 'transfer', offset: 0 });
  assert.equal(page.next_offset, result.count);
  assert.ok(JSON.stringify(page.events).includes('Captured suffix'));
  assert.ok(!JSON.stringify(page.events).includes('EXCLUDED_PRIVATE_CONVERSATION'));
  await restarted.loadAgent({ session_id: 'transferred', created_at: 20, revision: 0, events: page.events, checkpoint: result.checkpoint });
  assert.equal(restarted.project('transferred').values.todos, null, 'canonical Turn start resets Todo even with no attached event observers');
  assert.deepEqual(bridge.canonical('parent'), original, 'fork synchronization must not replace the live parent');
  bridge.forks.release('transfer'); bridge.forks.release('transfer');
  assert.throws(() => bridge.forks.read({ operation_id: 'transfer', offset: 0 }), /unavailable/);
  const unsafe = structuredClone(original);
  unsafe.events[9].sourceEventSeqs = [4];
  await bridge.load(unsafe);
  assert.throws(() => fork('bad-reference', 5), /outside the window/);
  assert.throws(() => fork('bad-cut', 5, 9), /synchronized completed cut/);
  const commandLog = structuredClone(original);
  const terminal = commandLog.events.pop();
  const push = (type,data) => commandLog.events.push({seq:commandLog.events.length,time:100,type,data});
  push('command/run',{commandId:'test-command',name:'imported',source:{kind:'user'}});
  const source = commandLog.events.find(event => event.data?.id === 'visible');
  push('command/done',{commandId:'test-command',kind:'success',text:'done',sourceEventSeq:source.seq});
  commandLog.events.push({...terminal,seq:commandLog.events.length});
  await bridge.load(commandLog);
  const commandChild = fork('command-child',5);
  const settlement = commandChild.events.find(event => event.type === 'command/done');
  assert.equal(commandChild.events[settlement.data.sourceEventSeq].data.id,'visible');
  commandLog.events.at(-2).data.sourceEventSeq = 4;
  await bridge.load(commandLog);
  assert.throws(() => fork('omitted-command-source',5), /command result points outside the window/);
});
}
