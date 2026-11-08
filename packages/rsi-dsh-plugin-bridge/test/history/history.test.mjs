import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadCohort } from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import { createBridge } from '../../src/index.mjs';
import { observeRequest } from '../../src/history/request-history.mjs';
import { SessionFacade } from '../../src/session/session.mjs';
import { restoreMapping, observeFact } from '../../src/history/history.mjs';
import {projectFacts} from '../../src/workbench/seed.mjs';

const cohortRoot = process.env.RSI_DSH_COHORT;
const integration = (name, run) => test(name, { skip: !cohortRoot }, run);
const inline = value => {
  const text = JSON.stringify(value);
  return { kind: 'inline', text, sha256: createHash('sha256').update(text).digest('hex') };
};
const snapshot = { deployment_id: 'actual-route', model: 'actual-model', language_settings: {} };
const evidence = () => ({ availability: 'available',
  configuration: inline({ prepared: { deployment: 'actual-route', model: 'actual-model', language_settings: {} },
    settings: { stop: [] }, response_format: { type: 'text' }, extensions: [] }),
  tools: inline({ definitions: [{ name: 'todo_write', description: 'Actual schema', input_schema: { type: 'object' } }], hosted: [], choice: { type: 'auto' } }),
  system: inline([{ role: 'system', content: [{ type: 'text', content: {text:'Actual instructions'} }] }]) });

integration('privately decoded request schemas transfer once while external inputs remain detached', async t => {
  const cohort = await loadCohort(cohortRoot);
  const ctx = new (await cohort.import('@deepseek-ai/cordis')).Context();
  t.after(() => ctx.fiber.dispose());
  const api = {...await cohort.import('@deepseek-ai/dsh-session'),
    ...await cohort.subpath('@deepseek-ai/dsh-session', 'surface'),
    ...await cohort.import('@deepseek-ai/dsh-util-values')};
  const snapshots = [], snapshotValue = api.snapshotJsonValue;
  api.snapshotJsonValue = value => { snapshots.push(value); return snapshotValue(value); };
  const session = new SessionFacade(ctx, api, {header:{version:4,id:'owned-header',createdAt:1,isSeeded:false}}, false);
  const fact = {seq:1,timestamp_ms:10,purpose:{kind:'conversation'},snapshot,evidence:evidence()};
  session.begin();
  try {
    await observeRequest(session, fact);
    const event = session.eventAt(0), tools = event.data.header.tools;
    assert.equal(snapshots.length, 0, 'private decoded schemas need no detached copy');
    assert.equal(session.requestHeader().tools, tools);
    assert.ok(Object.isFrozen(tools[0].parameters));
    assert.throws(() => { tools[0].parameters.type = 'changed'; }, TypeError);
    const external = {reason:'series',header:{config:{provider:'actual-route',model:'actual-model'},
      tools:[{name:'external',description:'External schema',parameters:{type:'object'}}]}};
    session.appendObserved('request/header', external, 11);
    external.header.tools[0].parameters.type = 'outside mutation';
    assert.equal(session.requestHeader().tools[0].parameters.type, 'object');
    assert.equal(snapshots.length, 1);
    const invalid = {...fact,evidence:evidence()};
    invalid.evidence.tools = {...invalid.evidence.tools,sha256:'0'.repeat(64)};
    await assert.rejects(observeRequest(session, invalid), /digest mismatch/);
    assert.equal(session.seq, 2);
  } finally { session.end(); }
});
const events = terminal => [[0, { type: 'content_started', index: 0, content: { type: 'reasoning' } }],
  [7, { type: 'content_delta', index: 0, delta: { type: 'reasoning', value: '想一想' } }],
  [8, { type: 'content_finished', index: 0 }],
  [9, { type: 'content_started', index: 1, content: { type: 'text' } }],
  [11, { type: 'content_delta', index: 1, delta: { type: 'text', value: '你好' } }],
  [13, { type: 'content_delta', index: 1, delta: { type: 'text', value: ' 🌏' } }],
  [17, { type: 'content_finished', index: 1 }],
  [19, { type: 'content_started', index: 2, content: { type: 'tool_call', id: 'call-one', name: 'todo_write', kind: 'function' } }],
  [21, { type: 'content_delta', index: 2, delta: { type: 'tool_arguments', value: '{"todos":[]}' } }],
  [22, { type: 'content_finished', index: 2 }],
  [23, { type: 'usage', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 60, cache_write_tokens: 10, reasoning_tokens: 5 } }],
  [27, terminal]];

integration('canonical timed attempts survive original stream decoding, receipt, restart and exact rejection', async t => {
  const llm = await (await loadCohort(cohortRoot)).import('@deepseek-ai/dsh-llm');
  const facts = [{ seq: 1, timestamp_ms: 10, type: 'step_started', turn_id: 'turn', step_id: 'step' }];
  const request = async (method, args) => {
    const fact = facts.find(fact => fact.seq > args.after_seq);
    assert.equal(method, 'agent.history.read');
    const value = [fact];
    assert.ok(value, method);
    const bytes = Buffer.from(JSON.stringify(value));
    // Deliberately small UTF-8-safe fragments exercise identity/offset handling.
    const remaining = bytes.subarray(args.offset).toString();
    const json = [...remaining].slice(0, 23).join('');
    return { through_seq: fact.seq, offset: args.offset, next_offset: args.offset + Buffer.byteLength(json), total_bytes: bytes.length, json };
  };
  let bridge = await createBridge({ cohortRoot, request }); t.after(() => bridge.close());
  await bridge.load({ header: { version: 4, id: 'history', createdAt: 1, isSeeded: false }, events: [], revision: 0 });
  const prepare = operation_id => bridge.agentBeforeStep({ model_selection: {model:{deployment:'fixture',model:'test'}}, session_id: 'history', operation_id, turn_id: 'turn', step_id: 'step', fact_horizon: facts.at(-1).seq, tools: ['todo_write'] });
  let stage = await prepare('initial');
  assert.equal(stage.kind, 'staged', stage.diagnostic);
  await bridge.receipt('history', 'initial', stage.token, 'committed', 1);
  const add = (id, terminal, retain_context) => {
    facts.push({ seq: facts.length + 1, timestamp_ms: 20, type: 'model_intent', effect_id: id, purpose: { kind: 'conversation' }, snapshot, evidence: evidence() });
    facts.push({ seq: facts.length + 1, timestamp_ms: 100, type: 'model_started', effect_id: id });
    const seq = facts.length + 1;
    facts.push({ seq, timestamp_ms: 130, type: 'model_attempt_settled', effect_id: id, purpose: 'conversation',
      attempt: {retain_context, events: events(terminal)} });
  };
  add('success', { type: 'finished', reason: 'tool_calls', replay: null }, false);
  stage = await prepare('success');
  assert.equal(stage.kind, 'staged', stage.diagnostic);
  const event = stage.events.find(event => event.type === 'assistant/message');
  assert.equal(event.data.message.id, 'rsi:history:model:success');
  assert.deepEqual(event.data.message.content, [{ type: 'reasoning', text: '想一想' }, { type: 'text', text: '你好 🌏' },
    { type: 'tool-call', id: 'call-one', name: 'todo_write', arguments: '{"todos":[]}' }]);
  assert.deepEqual(event.data.usage, { inputTokens: 30, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5, totalTokens: 120 });
  const expanded = llm.expandAssistantStream(event.data.stream);
  assert.deepEqual(expanded.filter(item => item.chunk.type === 'text-delta').map(item => [item.time, item.chunk.text]), [[111, '你好'], [113, ' 🌏']]);
  await bridge.receipt('history', 'success', stage.token, 'committed', 2);
  const canonical = bridge.canonical('history');
  const old = bridge; await old.close();
  bridge = await createBridge({ cohortRoot, request }); await bridge.load(canonical);
  stage = await prepare('no-duplicate');
  assert.ok(!stage.events.some(event => event.type.startsWith('assistant/')));
  await bridge.receipt('history', 'no-duplicate', stage.token, 'committed', 3);
  const error = { kind: 'transport', safe_summary: 'Connection ended', status: 503, retry_after_ms: 100, request_id: 'provider-request' };
  add('retry', { type: 'failed', error, replay: null }, false);
  stage = await prepare('retry'); assert.equal(stage.kind, 'staged', stage.diagnostic);
  const retry = stage.events.find(event => event.type === 'assistant/attempt');
  assert.ok(retry); assert.equal(retry.surfaceOp, undefined);
  assert.deepEqual(llm.expandAssistantStream(retry.data.stream).at(-1).chunk.reason.failure,
    { code: 'provider.transport', message: 'Connection ended', status: 503, providerRetryAfterMs: 100, requestId: 'provider-request' });
  await bridge.receipt('history', 'retry', stage.token, 'committed', 4);
  add('retained', { type: 'failed', error, replay: null }, true);
  stage = await prepare('retained'); assert.equal(stage.kind, 'staged', stage.diagnostic);
  const partial = stage.events.find(event => event.type === 'assistant/message');
  assert.equal(partial.data.interrupted, true);
  assert.deepEqual(partial.data.message.content.map(block => block.type), ['reasoning', 'text']);
  const before = bridge.canonical('history');
  await bridge.receipt('history', 'retained', stage.token, 'rejected', 4);
  assert.deepEqual(bridge.canonical('history'), before);
  stage = await prepare('retained-again'); assert.equal(stage.kind, 'staged', stage.diagnostic);
  assert.equal(stage.events.find(event => event.type === 'assistant/message').data.message.id, partial.data.message.id);
  await bridge.receipt('history', 'retained-again', stage.token, 'committed', 5);
  add('truncated', { type: 'finished', reason: 'max_tokens', replay: null }, true);
  stage = await prepare('truncated'); assert.equal(stage.kind, 'staged', stage.diagnostic);
  assert.deepEqual(stage.events.find(event => event.type === 'assistant/message').data.message.content.map(block => block.type), ['reasoning', 'text']);
  await bridge.receipt('history', 'truncated', stage.token, 'committed', 6);
  add('unsupported', { type: 'finished', reason: 'content_filter', replay: null }, true);
  const saved = bridge.canonical('history');
  stage = await prepare('unsupported'); assert.equal(stage.kind, 'rejected');
  assert.match(stage.diagnostic, /cannot be represented/);
  assert.deepEqual(bridge.canonical('history'), saved);
});

integration('a Plan review parks captured Tool history privately and fences a superseded answer', async t => {
  for (const supersede of [false, true]) {
    const inbox = Promise.withResolvers(); const answer = Promise.withResolvers();
    const args = { plan: '# Review\nRead the evidence.' };
    const facts = [
      { type: 'turn_accepted', turn_id: 'turn', text: 'Review' },
      { type: 'step_started', turn_id: 'turn', step_id: 'step' },
      { type: 'model_intent', effect_id: 'model', purpose: { kind: 'conversation' }, snapshot, evidence: evidence() },
      { type: 'model_started', effect_id: 'model' },
      { type: 'model_attempt_settled', effect_id: 'model', purpose: 'conversation' },
      { type: 'tool_intent', effect_id: 'native-effect', origin: { kind: 'model', effect_id: 'model' }, identity: { call_id: 'provider-call' }, name: 'exit_plan_mode', arguments: args },
      { type: 'tool_started', effect_id: 'native-effect', identity: { call_id: 'provider-call' } },
    ].map((fact, i) => ({ ...fact, seq: i + 1, timestamp_ms: 10 * (i + 1) }));
    facts[4].attempt = { retain_context: false, events: [
      [0, { type: 'content_started', index: 0, content: { type: 'tool_call', id: 'provider-call', name: 'exit_plan_mode', kind: 'function' } }],
      [1, { type: 'content_delta', index: 0, delta: { type: 'tool_arguments', value: JSON.stringify(args) } }],
      [2, { type: 'content_finished', index: 0 }], [3, { type: 'finished', reason: 'tool_calls', replay: null }],
    ] };
    const request = async (method, { after_seq, offset }) => {
      assert.equal(method, 'agent.history.read');
      const fact = facts[after_seq]; const json = JSON.stringify([fact]);
      return { through_seq: fact.seq, offset, next_offset: Buffer.byteLength(json), total_bytes: Buffer.byteLength(json), json };
    };
    const bridge = await createBridge({ cohortRoot, request, ask(question, signal, { operationId, callId }) {
      inbox.resolve([question.questions[0].intent.callId, callId, operationId]); return answer.promise;
    } });
    t.after(() => bridge.close());
    await bridge.load({ header: { version: 4, id: 'history', createdAt: 1, isSeeded: false }, events: [], revision: 0 });
    const on = await bridge.command('history', 'on', 'plan');
    await bridge.receipt('history', 'on', on.token, 'committed', 1);
    const previous = bridge.canonical('history');
    const review = bridge.tool('history', 'native-effect', 'exit_plan_mode', args, undefined, 7);
    assert.deepEqual(await Promise.race([inbox.promise, review]), ['provider-call', 'provider-call', 'native-effect']);
    assert.deepEqual(bridge.canonical('history'), previous);
    if (supersede) {
      const off = await bridge.command('history', 'off', 'plan', 'off');
      assert.ok(off.payload.suffix.every(event => !['tool/call', 'assistant/message', 'user/message'].includes(event.type)));
      await bridge.receipt('history', 'off', off.token, 'committed', 2);
      const saved = bridge.canonical('history');
      answer.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] });
      await assert.rejects(review, error => error.code === 'ASK_ABORTED');
      assert.deepEqual(bridge.canonical('history'), saved);
    } else {
      answer.resolve({ answers: [{ id: 'plan-review', selected: ['Approve'] }] });
      const stage = await review;
      assert.equal(stage.payload.suffix.find(event => event.type === 'tool/call').data.callId, 'provider-call');
      assert.equal(stage.payload.pendingIntent.causeIdentity, 'native-effect');
      await bridge.receipt('history', 'native-effect', stage.token, 'committed', 2);
      assert.equal(bridge.canonical('history').mapping.factCursor, 7);
    }
  }
});

integration('native semantic system evidence round-trips through original JSONL persistence',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
  const root=await mkdtemp(join(tmpdir(),'rsi-system-log-')),cohort=await loadCohort(cohortRoot);
  const {Context}=await cohort.import('@deepseek-ai/cordis'),api=await cohort.import('@deepseek-ai/dsh-session');
  const ctx=new Context();
  t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});});
  await ctx.plugin(api.default);
  await ctx.plugin(await cohort.import('@deepseek-ai/dsh-session-persistence-jsonl'),{root,compression:'none'});
  const session=new SessionFacade(ctx,{...api,...await cohort.subpath('@deepseek-ai/dsh-session','surface'),
    ...await cohort.import('@deepseek-ai/dsh-util-values')},{header:{version:4,id:'system-log',createdAt:1,isSeeded:false}});
  const first=evidence(),reference={availability:'available'};
  for(const key of ['configuration','tools','system'])reference[key]={kind:'reference',seq:4,section:key,
    sha256:first[key].sha256,bytes:Buffer.byteLength(first[key].text)};
  const facts=[{type:'turn_accepted',turn_id:'turn',text:'input'},
    {type:'step_started',turn_id:'turn',step_id:'step'},
    {type:'step_inputs_prepared',turn_id:'turn',step_id:'step',decision:{kind:'enter',messages:[{kind:'claimed',claim:{fact_seq:1,ordinal:0}}]}},
    ...[first,reference].map((evidence,index)=>({type:'model_intent',effect_id:'model-'+index,purpose:{kind:'conversation'},snapshot,evidence}))]
    .map((fact,index)=>({...fact,seq:index+1,timestamp_ms:10+index}));
  let reads=0;
  await projectFacts(session,restoreMapping(),async after=>{
    reads++;assert.equal(after,0,'references borrow the already decoded page');
    return {through:5,value:facts};
  },5,undefined,await cohort.import('@deepseek-ai/dsh-llm'));
  assert.equal(reads,1);
  const writer=await ctx.sessionPersistence.create(session.header);
  try{await writer.append(session.snapshotEvents());}finally{await writer.close();}
  const reader=await ctx.sessionPersistence.open(session.id,'read');
  try{
    const {events}=await reader.read();assert.deepEqual(events,session.snapshotEvents());
    assert.deepEqual(events.findLast(event=>event.type==='system/message').data.message.content,[{type:'text',text:'Actual instructions'}]);
  }finally{await reader.close();}
});

test('disabled tools and unsupported request controls cannot publish misleading headers', async () => {
  const appended = [];
  const session = { seq:0, lastEvent() {}, adoptObserved(event) { appended.push(event); } };
  const fact = { seq: 1, timestamp_ms: 10, purpose: { kind: 'conversation' }, snapshot, evidence: evidence() };
  const tools = JSON.parse(fact.evidence.tools.text); tools.choice = { type: 'none' }; fact.evidence.tools = inline(tools);
  await observeRequest(session, fact);
  assert.equal(appended[0].data.header.tools, undefined);
  const configuration = JSON.parse(fact.evidence.configuration.text);
  configuration.response_format = { type: 'json_object' }; fact.evidence.configuration = inline(configuration);
  await assert.rejects(observeRequest(session, fact), /cannot be represented/);
  configuration.response_format = { type: 'text' }; configuration.extensions = [{ namespace: 'example', version: 1, value: {} }];
  fact.evidence.configuration = inline(configuration);
  await assert.rejects(observeRequest(session, fact), /cannot be represented/);
  assert.equal(appended.length, 1);
});

integration('original surface folds preserve roles, system replacements, raw calls and canonical outcome provenance', async t => {
  const cohort = await loadCohort(cohortRoot);
  const [cordis, sessionApi, surface, values, llm] = await Promise.all([
    cohort.import('@deepseek-ai/cordis'), cohort.import('@deepseek-ai/dsh-session'), cohort.subpath('@deepseek-ai/dsh-session', 'surface'),
    cohort.import('@deepseek-ai/dsh-util-values'), cohort.import('@deepseek-ai/dsh-llm')]);
  const ctx = new cordis.Context(); t.after(() => ctx.fiber.dispose());
  const session = new SessionFacade(ctx, { ...sessionApi, ...surface, ...values },
    { header: { version: 4, id: 'conversation', createdAt: 1, isSeeded: false }, events: [] });
  session.begin();
  let mapping = restoreMapping(); let seq = 0;
  let projected;
  const observe = body => observeFact(session, mapping, { seq: ++seq, timestamp_ms: seq * 100, ...body },
    () => { throw new Error('unexpected reference'); }, llm);
  await observe({ type: 'turn_accepted', turn_id: 'turn', text: 'Original user text' });
  await observe({ type: 'step_started', turn_id: 'turn', step_id: 'step' });
  await observe({ type: 'input_message_claimed', turn_id: 'turn', step_id: 'step', source: { type: 'plugin_context', contribution_id: 'context' },
    content: [{ type: 'text', text: 'First instruction' }, { type: 'text', text: 'Second instruction' }] });
  await observe({ type: 'input_message_claimed', turn_id: 'turn', step_id: 'step', source: { type: 'command', message_id: 'command-input', source: { command_id: 'plan' } },
    content: [{ type: 'text', text: 'Requested task' }] });
  await observe({ type: 'step_inputs_prepared', turn_id: 'turn', step_id: 'step', decision: {kind:'enter',messages:
    [1,3,4].map(fact_seq=>({kind:'claimed',claim:{fact_seq,ordinal:0}}))} });
  const model = async (effect_id, ids) => {
    await observe({ type: 'model_intent', effect_id, purpose: { kind: 'conversation' }, snapshot, evidence: evidence() });
    await observe({ type: 'model_started', effect_id });
    projected = ids.flatMap((id, index) => [
      [index * 4, { type: 'content_started', index, content: { type: 'tool_call', id, name: 'todo_write', kind: 'function' } }],
      [index * 4 + 1, { type: 'content_delta', index, delta: { type: 'tool_arguments', value: '{ "todos": [] }' } }],
      [index * 4 + 2, { type: 'content_finished', index }],
    ]);
    projected.push([ids.length * 4, { type: 'finished', reason: 'tool_calls', replay: null }]);
    await observe({ type: 'model_attempt_settled', effect_id, purpose: 'conversation', attempt: {retain_context:true,events:projected} });
  };
  await model('first-model', ['a', 'b']);
  const intent = (id, model, type = 'tool_intent') => ({ type, effect_id: `effect-${id}`, origin: { kind: 'model', effect_id: model },
    identity: { call_id: id }, name: 'todo_write', arguments: { todos: [] } });
  await observe(intent('a', 'first-model'));
  await observe({ type: 'tool_started', effect_id: 'effect-a', identity: { call_id: 'a' } });
  // A checkpoint between intent and result must retain the exact event references.
  mapping = restoreMapping(JSON.parse(JSON.stringify(mapping)));
  await observe({ type: 'tool_result', effect_id: 'program-internal', identity: { call_id: 'internal' },
    result: { content: [{ type: 'text', text: 'Internal only' }], value: null, is_error: false } });
  await observe({ type: 'tool_result', effect_id: 'effect-a', identity: { call_id: 'a' },
    result: { content: [{ type: 'text', text: 'Exact result' }], value: null, is_error: true,
      metadata: { dsh: { error: { name: 'ToolError', code: 'INVALID_ARGS' }, meta: null } } } });
  assert.equal(mapping.stepOpen,true,'the sibling call still owns the Step');
  await observe({ ...intent('b', 'first-model', 'tool_rejected'), rejection: { type: 'policy_denied', reason: 'Denied by exact policy', contribution_id: 'policy' } });
  assert.equal(session.lastEvent('step/end').data.step,1);
  await model('second-model', ['c', 'd', 'e']);
  await observe(intent('c', 'second-model'));
  await observe(intent('d', 'second-model'));
  await observe({ type: 'tool_started', effect_id: 'effect-d', identity: { call_id: 'd' } });
  await observe({ type: 'tool_calls_superseded', source_model_effect_id: 'second-model' });
  await observe({ type: 'turn_terminal', turn_id: 'turn', outcome: { status: 'interrupted' } });
  assert.equal(mapping.calls.length, 0);
  const log = session.snapshotEvents();
  const folded = surface.foldSurface(log);
  const messages = folded.nodes.map(seq => log[seq]).map(event => event.type === 'user/message' ? event.data : event.data.message);
  assert.deepEqual(messages.slice(0, 4).map(message => [message.role, message.content]), [
    ['system', [{ type: 'text', text: 'Actual instructions' }]],
    ['user', [{ type: 'text', text: 'Original user text' }]],
    ['developer', [{ type: 'text', text: 'First instruction\nSecond instruction' }]],
    ['user', [{ type: 'text', text: 'Requested task' }]],
  ]);
  assert.equal(messages[3].source.kind, 'rsi-command');
  assert.equal(messages[3].id, 'rsi:conversation:input:command-input');
  assert.equal(log.find(event => event.type === 'tool/call').data.arguments, '{ "todos": [] }');
  const results = log.filter(event => event.type === 'tool/result');
  assert.deepEqual(results.map(event => event.data.message.toolCallId), ['a', 'b', 'e', 'c', 'd']);
  assert.deepEqual(results.map(event => event.data.error?.code), ['INVALID_ARGS', 'rsi.policy_denied', 'TOOL_NOT_STARTED', 'TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN']);
  assert.equal(results[0].data.meta, null);
  assert.ok(results.slice(1).every(event => !Object.hasOwn(event.data, 'meta')));
  assert.equal(results[0].data.message.isError, true);
  assert.deepEqual(results[0].data.message.content, [{ type: 'text', text: 'Exact result' }]);
  assert.ok(!JSON.stringify(messages).includes('Internal only'));
  assert.deepEqual(log.filter(event => event.type === 'tool/call').map(event => event.data.callId), ['a', 'b', 'c', 'd', 'e']);
  for (const event of results) {
    assert.equal(event.sourceEventSeqs?.length, 1, 'even a refused or skipped call needs its invocation for original cold rendering');
    const call = log[event.sourceEventSeqs[0]];
    assert.equal(call.type, 'tool/call');
    assert.equal(call.data.callId, event.data.message.toolCallId);
    assert.equal(call.data.arguments, '{ "todos": [] }');
  }
  const restored = new SessionFacade(ctx, { ...sessionApi, ...surface, ...values }, { header: session.header, events: JSON.parse(JSON.stringify(log)) }, false);
  assert.deepEqual(restored.surface.nodes, session.surface.nodes);
  const original = sessionApi.Session.fromRestore(session.id, log, session.header, 0, 'shared-frozen');
  assert.deepEqual(restored.deriveMessages(), original.deriveMessages());
  const before = restored.deriveMessages();
  const eventsBefore = restored.snapshotEvents();
  assert.ok(Object.isFrozen(eventsBefore));
  assert.equal(restored.snapshotEvents(), eventsBefore);
  const [head] = restored.surface.nodes;
  const first = restored.eventAt(head);
  const changed = { ...first.data, message: { ...first.data.message, content: [{ type: 'text', text: 'New system prompt' }] } };
  const replace = { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] };
  const candidate = restored.branch();
  candidate.begin();
  candidate.append('system/message', changed, replace);
  candidate.end();
  assert.deepEqual(restored.deriveMessages(), before);
  assert.equal(restored.snapshotEvents(), eventsBefore);
  restored.adoptBranch(candidate);
  original.append('system/message', changed, replace);
  assert.deepEqual(restored.deriveMessages(), original.deriveMessages());
  assert.deepEqual(before[0].content, [{ type: 'text', text: 'Actual instructions' }]);
  assert.deepEqual(restored.deriveEventMessage(first), original.deriveEventMessage(first));
  assert.equal(eventsBefore.length + 1, restored.snapshotEvents().length);
  const independent = restored.deriveMessages();
  independent.pop();
  assert.equal(independent.length + 1, restored.deriveMessages().length);
});
