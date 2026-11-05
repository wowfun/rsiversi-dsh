import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBridge } from '../../src/index.mjs';

const cohortRoot = process.env.RSI_DSH_COHORT;
const integration = (name, run) => test(name, { skip: !cohortRoot }, run);
const canonical = (events = []) => ({ header: { version: 4, id: 'session-one', createdAt: 0, isSeeded: false }, events, revision: 0 });

integration('a rejected composition retires its Cordis root without masking the cause', async () => {
  await assert.rejects(createBridge({cohortRoot, configuration:{format:1, plugins:[]}}), /Invalid imported plugin selection/);
});

integration('native command catalog preserves draft revision zero and stages original steer text', async t => {
  const bridge = await setup(t);
  assert.equal(bridge.catalog().protocol, 5);
  assert.deepEqual(bridge.catalog().commands.map(command => [command.id, command.name, command.draft_safe]),
    [['rsi.extension.command.plan', 'plan', true]]);
  const call = (operation_id, input) => bridge.agentCommand({ session_id: 'session-one', operation_id, name: 'plan', input, fact_horizon: 0 });
  const first = await call('draft-on', 'Inspect the source');
  assert.equal(first.kind, 'staged', first.diagnostic);
  assert.deepEqual(first.inputs, [{ delivery: 'steer', text: 'Inspect the source' }]);
  await bridge.receipt('session-one', 'draft-on', first.token, 'draft_committed', 0);
  await bridge.receipt('session-one', 'draft-on', first.token, 'draft_committed', 0);
  assert.equal(bridge.canonical('session-one').revision, 0);
  const second = await call('draft-off', 'off');
  assert.equal(second.kind, 'staged', second.diagnostic);
  await bridge.receipt('session-one', 'draft-off', second.token, 'draft_committed', 0);
  assert.equal(bridge.project('session-one').values.plan.active, false);
  await assert.rejects(bridge.abandon('session-one', 'draft-on'), /acknowledged mutation/);
});

integration('canonical request headers restore Plan narration and resolve exact evidence references', async t => {
  const facts = [{ seq: 1, timestamp_ms: 9, type: 'turn_accepted', turn_id: 'turn', text: 'Make a plan' },
    { seq: 2, timestamp_ms: 10, type: 'step_started', turn_id: 'turn', step_id: 'step' }];
  const request = async (_, args) => {
    const next = facts.find(fact => fact.seq > args.after_seq);
    const text = JSON.stringify(next ? [next] : []);
    return { through_seq: next?.seq ?? args.after_seq, offset: 0, next_offset: Buffer.byteLength(text), total_bytes: Buffer.byteLength(text), json: text };
  };
  let bridge = await setup(t, { request });
  const prepare = operation_id => bridge.agentBeforeStep({ model_selection: {model:{deployment:'fixture',model:'test'}}, session_id: 'session-one', operation_id,
    turn_id: 'turn', step_id: 'step', fact_horizon: facts.at(-1).seq, tools: ['todo_write', 'exit_plan_mode'] });
  await commit(bridge, await bridge.command('session-one', 'initial-plan', 'plan'), 1);
  let stage = await prepare('step-one');
  assert.equal(stage.kind, 'staged');
  await bridge.receipt('session-one', 'step-one', stage.token, 'committed', 2);
  const snapshot = { deployment_id: 'actual-route', model: 'actual-model', language_settings: {
    requested_reasoning_effort: null, effective_reasoning_effort: 'high' } };
  const inline = value => {
    const text = JSON.stringify(value);
    return { kind: 'inline', text, sha256: createHash('sha256').update(text).digest('hex') };
  };
  const evidence = { availability: 'available',
    configuration: inline({ settings: { max_output_tokens: 2048, temperature: 0.3, top_p: null, seed: null, stop: [], reasoning_effort: null },
      prepared: { deployment: snapshot.deployment_id, model: snapshot.model, language_settings: snapshot.language_settings } }),
    tools: inline({ definitions: [{ name: 'todo_write', description: 'Actual schema', input_schema: { type: 'object', properties: {} } }], hosted: [], choice: { type: 'auto' } }), system: inline([]) };
  const prepared = (seq, messages) => ({ seq, timestamp_ms: 19, type: 'step_inputs_prepared', turn_id: 'turn', step_id: 'step',
    decision: { kind: 'enter', messages } });
  facts.push(prepared(3, [{ kind: 'claimed', claim: { fact_seq: 1, ordinal: 0 } }]));
  const intent = { seq: 4, timestamp_ms: 20, type: 'model_intent', effect_id: 'model-one', purpose: { kind: 'conversation' }, snapshot, evidence };
  facts.push(intent);
  stage = await prepare('step-two');
  assert.equal(stage.kind, 'staged', stage.diagnostic);
  const header = stage.events.find(event => event.type === 'request/header');
  assert.equal(header.time, 20);
  assert.deepEqual(header.data.header, { config: { provider: 'actual-route', model: 'actual-model', reasoningEffort: 'high', temperature: 0.3, maxTokens: 2048 },
    adapterDefaults: { reasoningEffort: true }, tools: [{ name: 'todo_write', description: 'Actual schema', parameters: { type: 'object', properties: {} } }] });
  await bridge.receipt('session-one', 'step-two', stage.token, 'committed', 3);
  await commit(bridge, await bridge.command('session-one', 'plan-off', 'plan', 'off'), 4);
  const saved = bridge.canonical('session-one');
  bridge = await createBridge({ cohortRoot, request }); t.after(() => bridge.close()); await bridge.load(saved);
  const referenced = { availability: 'available' };
  for (const name of ['configuration', 'tools', 'system']) referenced[name] = { kind: 'reference', seq: intent.seq, section: name, sha256: evidence[name].sha256, bytes: Buffer.byteLength(evidence[name].text) };
  facts.push(prepared(5, []), { ...intent, seq: 6, timestamp_ms: 21, effect_id: 'model-two', evidence: referenced });
  referenced.tools.sha256 = '0'.repeat(64);
  stage = await prepare('bad-evidence');
  assert.equal(stage.kind, 'rejected'); assert.match(stage.diagnostic, /digest mismatch/);
  assert.deepEqual(bridge.canonical('session-one'), saved);
  referenced.tools.sha256 = evidence.tools.sha256;
  stage = await prepare('step-three');
  assert.equal(stage.kind, 'staged', stage.diagnostic);
  assert.deepEqual(stage.decision.messages.map(row=>row.message?.content[0]?.text), ['The user switched this session back to the default mode.']);
  assert.equal(stage.checkpoint.pendingIntent, null);
  assert.equal(stage.events.find(event => event.type === 'request/header').data.reason, 'series');
});

integration('captured RSI lifecycle resets Todo only after receipt and survives restart without cursor drift', async t => {
  const facts = [{ seq: 1, timestamp_ms: 9, type: 'turn_accepted', turn_id: 'turn-one', text: 'First turn' },
    { seq: 2, timestamp_ms: 10, type: 'step_started', turn_id: 'turn-one', step_id: 'step-one' }];
  const request = async (method, args) => {
    assert.equal(method, 'agent.history.read');
    assert.equal(args.session_id, 'session-one'); assert.equal(args.offset, 0);
    const next = facts.find(fact => fact.seq > args.after_seq);
    const text = JSON.stringify(next ? [next] : []);
    return { through_seq: next?.seq ?? args.after_seq, offset: 0, next_offset: Buffer.byteLength(text), total_bytes: Buffer.byteLength(text), json: text };
  };
  let bridge = await setup(t, { request });
  const prepare = (operation_id, turn_id, step_id, fact_horizon) => bridge.agentBeforeStep({ model_selection: {model:{deployment:'fixture',model:'test'}}, session_id: 'session-one', operation_id,
    turn_id, step_id, fact_horizon, tools: ['todo_write', 'exit_plan_mode'] });
  let stage = await prepare('prepare-one', 'turn-one', 'step-one', 2);
  assert.equal(stage.kind, 'staged');
  assert.deepEqual(stage.events.map(event => event.type), ['turn/start']);
  assert.equal(stage.events[0].time, 9);
  await bridge.receipt('session-one', 'prepare-one', stage.token, 'committed', 1);
  await commit(bridge, await bridge.tool('session-one', 'todo', 'todo_write', { todos: [{ content: 'Keep until next Turn', status: 'completed' }] }), 2);
  const saved = bridge.canonical('session-one');
  bridge = await createBridge({ cohortRoot, request }); t.after(() => bridge.close()); await bridge.load(saved);
  facts.push({ seq: 3, timestamp_ms: 11, type: 'step_inputs_prepared', turn_id: 'turn-one', step_id: 'step-one',
      decision: { kind: 'enter', messages: [{ kind: 'claimed', claim: { fact_seq: 1, ordinal: 0 } }] } },
    { seq: 4, timestamp_ms: 20, type: 'step_ended', turn_id: 'turn-one', step_id: 'step-one' },
    { seq: 5, timestamp_ms: 21, type: 'turn_terminal', turn_id: 'turn-one', outcome: { status: 'completed' } },
    { seq: 6, timestamp_ms: 29, type: 'turn_accepted', turn_id: 'turn-two', text: 'Second turn' },
    { seq: 7, timestamp_ms: 30, type: 'step_started', turn_id: 'turn-two', step_id: 'step-two' });
  stage = await prepare('prepare-rejected', 'turn-two', 'step-two', 7);
  assert.equal(stage.kind, 'staged'); assert.equal(stage.checkpoint.mapping.turn, 2);
  assert.equal(stage.checkpoint.mapping.factCursor, 7); assert.equal(stage.checkpoint.views.values.todos, null);
  assert.equal(bridge.project('session-one').values.todos[0].content, 'Keep until next Turn');
  await bridge.receipt('session-one', 'prepare-rejected', stage.token, 'rejected', 2);
  assert.deepEqual(bridge.canonical('session-one'), saved);
  stage = await prepare('prepare-two', 'turn-two', 'step-two', 7);
  await bridge.receipt('session-one', 'prepare-two', stage.token, 'committed', 3);
  assert.equal(bridge.project('session-one').values.todos, null);
  const events = bridge.canonical('session-one').events;
  assert.deepEqual(events.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2]);
  assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index));
  stage = await prepare('prepare-again', 'turn-two', 'step-two', 7);
  assert.deepEqual(stage.events, []);
  assert.equal(stage.checkpoint.mapping.step, 0);
  assert.deepEqual(events.filter(event => event.type === 'step/start').map(event => event.time), [11]);
});
async function setup(t, options = {}) {
  const bridge = await createBridge({ cohortRoot, ...options });
  t.after(() => bridge.close()); await bridge.load(canonical()); return bridge;
}
async function commit(bridge, staged, revision) { await bridge.receipt('session-one', staged.payload.operationId, staged.token, 'committed', revision); }
integration('original Todo stages atomically, hides uncommitted views and restores without markers', async t => {
  const bridge = await setup(t);
  const staged = await bridge.tool('session-one', 'todo1', 'todo_write', { todos: [{ content: 'Read source', status: 'in_progress' }] });
  assert.equal(staged.payload.suffix[0].type, 'todo/write');
  assert.equal(staged.payload.result.value.counts.inProgress, 1);
  assert.equal(bridge.project('session-one').values.todos, null);
  staged.payload.checkpoint.views.values.todos[0].content = 'Changed in caller';
  staged.payload.suffix[0].data.todos[0].content = 'Changed in caller';
  assert.deepEqual(bridge.canonical('session-one').events, []);
  await assert.rejects(bridge.flush('session-one', 0), /tentative/);
  await assert.rejects(bridge.receipt('session-one', 'wrong', staged.token, 'committed', 1), /identity/);
  await commit(bridge, staged, 1);
  assert.equal(bridge.project('session-one').values.todos[0].content, 'Read source');
  assert.deepEqual(await bridge.flush('session-one', 0), { revision: 1, throughSeq: 0 });
  const saved = bridge.canonical('session-one');
  assert.equal(saved.events[0].data.todos[0].content, 'Read source');
  const restarted = await createBridge({ cohortRoot }); t.after(() => restarted.close());
  await restarted.load(saved);
  assert.deepEqual(restarted.canonical('session-one').events, saved.events);
  assert.deepEqual(restarted.project('session-one'), bridge.project('session-one'));
  saved.events.push({ seq: 1, time: 1, type: 'turn/start', data: { turn: 2 } }); saved.revision++;
  await restarted.load(saved);
  assert.equal(restarted.project('session-one').values.todos, null);
});
integration('catalog declares human interaction and paged recovery publishes only the complete prefix', async t => {
  const bridge = await setup(t);
  assert.deepEqual(bridge.catalog().tools.map(tool => [tool.definition.name, tool.interaction.kind]), [['todo_write', 'execution'], ['exit_plan_mode', 'human']]);
  const event = { seq: 0, time: 1, type: 'todo/write', data: { todos: [{ content: 'paged', status: 'pending' }] } };
  const boundary = { session_id: 'session-one', created_at: 0, revision: 1, count: 1 };
  assert.equal(bridge.beginAgentLoad(boundary), 'transfer');
  await assert.rejects(bridge.finishAgentLoad({ session_id: 'session-one', checkpoint: null }), /incomplete/);
  assert.equal(bridge.project('session-one').values.todos, null);
  assert.throws(() => bridge.appendAgentLoad({ session_id: 'session-one', offset: 1, events: [event] }), /page/);
  bridge.appendAgentLoad({ session_id: 'session-one', offset: 0, events: [event] });
  event.data.todos[0].content = 'mutated caller';
  assert.equal(bridge.project('session-one').values.todos, null);
  await bridge.finishAgentLoad({ session_id: 'session-one', checkpoint: null });
  assert.equal(bridge.project('session-one').values.todos[0].content, 'paged');
  assert.equal(bridge.beginAgentLoad(boundary), 'current');
  const advanced = { ...boundary, revision: 2 };
  assert.equal(bridge.beginAgentLoad(advanced), 'transfer');
  bridge.appendAgentLoad({ session_id: 'session-one', offset: 0, events: [event] });
  await assert.rejects(bridge.finishAgentLoad({ session_id: 'session-one', checkpoint: { mapping: { version: -1 } } }), /history checkpoint/);
  bridge.abortAgentLoad(advanced);
  assert.equal(bridge.canonical('session-one').revision, 1);
  assert.equal(bridge.beginAgentLoad(boundary), 'current');
  assert.equal(bridge.beginAgentLoad({...boundary, created_at: 1}), 'transfer');
  bridge.abortAgentLoad(boundary);
  assert.equal(bridge.beginAgentLoad({...boundary, revision: 0}), 'transfer');
  bridge.abortAgentLoad(boundary);
});
integration('Agent BeforeStep preserves foreign Tool names and separates current instructions', async t => {
  const bridge = await setup(t);
  const request = { model_selection: {model:{deployment:'fixture',model:'test'}}, session_id: 'session-one', operation_id: 'prepare-off', turn_id: 'turn', step_id: 'step', tools: ['todo_write', 'exit_plan_mode', 'native_read'] };
  const off = await bridge.agentBeforeStep(request);
  assert.equal(off.kind, 'staged');
  assert.deepEqual(off.tools, ['todo_write', 'native_read']);
  assert.equal(off.instructions, 'You are an AI agent powered by DeepSeek Harness.');
  assert.deepEqual(off.decision, {kind:"enter", messages:[]});
  await bridge.receipt('session-one', request.operation_id, off.token, 'committed', 1);
  await commit(bridge, await bridge.command('session-one', 'plan-on', 'plan'), 2);
  const on = await bridge.agentBeforeStep({ ...request, operation_id: 'prepare-on' });
  assert.equal(on.kind, 'staged');
  assert.deepEqual(on.tools, request.tools);
  assert.match(on.instructions, /Plan the work before making changes\./);
  assert.deepEqual(on.decision, {kind:"enter", messages:[]});
  await bridge.receipt('session-one', 'prepare-on', on.token, 'committed', 3);
});
integration('definite rejection retires tentative Todo state and permits a later operation', async t => {
  const bridge = await setup(t);
  const staged = await bridge.tool('session-one', 'rejected', 'todo_write', { todos: [{ content: 'discard', status: 'pending' }] });
  await bridge.receipt('session-one', 'rejected', staged.token, 'rejected', 0);
  assert.equal(bridge.canonical('session-one').events.length, 0);
  const next = await bridge.tool('session-one', 'next', 'todo_write', { todos: [] });
  assert.equal(next.payload.suffix[0].seq, 0);
  await commit(bridge, next, 1);
});
integration('Agent Tool rejection is explicit and abandon cannot discard another effect', async t => {
  const bridge = await setup(t);
  const rejected = await bridge.agentTool({ session_id: 'session-one', operation_id: 'invalid', name: 'todo_write', arguments: { unknown: true } });
  assert.equal(rejected.kind, 'rejected');
  assert.equal(bridge.canonical('session-one').events.length, 0);
  const staged = await bridge.agentTool({ session_id: 'session-one', operation_id: 'lost', name: 'todo_write', arguments: { todos: [] } });
  assert.equal(staged.kind, 'staged');
  await assert.rejects(bridge.abandon('session-one', 'wrong'), /identity/);
  await bridge.abandon('session-one', 'lost');
  assert.equal(bridge.canonical('session-one').events.length, 0);
  const next = await bridge.tool('session-one', 'fresh', 'todo_write', { todos: [] });
  await commit(bridge, next, 1);
  await assert.rejects(bridge.abandon('session-one', 'fresh'), /acknowledged/);
});
integration('Plan approval survives restart with silent pending exit until BeforeStep receipt', async t => {
  const bridge = await setup(t, { ask: async () => ({ answers: [{ id: 'plan-review', selected: ['Approve'] }] }) });
  await commit(bridge, await bridge.command('session-one', 'plan-on', 'plan'), 1);
  const opened = bridge.canonical('session-one');
  opened.events.push({ seq: opened.events.length, time: 2, type: 'turn/start', data: { turn: 1 } }); opened.revision++;
  await bridge.load(opened);
  const approved = await bridge.tool('session-one', 'approve', 'exit_plan_mode', { plan: '# Verified plan\nRead source.' });
  assert.deepEqual(approved.payload.pendingIntent, { active: false, narrate: false, causeIdentity: 'approve' });
  await commit(bridge, approved, 3);
  const restarted = await createBridge({ cohortRoot }); t.after(() => restarted.close());
  await restarted.load(bridge.canonical('session-one'));
  const step = await restarted.beforeStep('session-one', 'step');
  assert.deepEqual(step.payload.suffix.map(event => [event.type, event.data]), [['plan/mode', { active: false }]]);
  assert.equal(step.payload.pendingIntent, null);
  assert.deepEqual(step.payload.result.decision, {kind:'enter', messages:[]});
  assert.equal(restarted.project('session-one').values.plan.active, true);
  await commit(restarted, step, 4);
  assert.equal(restarted.project('session-one').values.plan.active, false);
});
integration('command can complete during review; old answer is aborted without changing its state', async t => {
  let entered, answer;
  const asked = new Promise(resolve => { entered = resolve; });
  const bridge = await setup(t, { ask: async () => { entered(); return new Promise(resolve => { answer = resolve; }); } });
  await commit(bridge, await bridge.command('session-one', 'on', 'plan'), 1);
  const review = bridge.tool('session-one', 'review', 'exit_plan_mode', { plan: '# Plan\nReview me.' });
  await asked;
  await commit(bridge, await bridge.command('session-one', 'off', 'plan', 'off'), 2);
  answer({ answers: [{ id: 'plan-review', selected: ['Approve'] }] });
  await assert.rejects(review, error => error.code === 'ASK_ABORTED');
  assert.equal(bridge.project('session-one').values.plan.active, false);
  assert.equal(bridge.canonical('session-one').pendingIntent, null);
});
integration('unknown event and malformed projection seed fail before Session publication', async t => {
  const bridge = await setup(t);
  const malformed = canonical([{ seq: 0, time: 1, type: 'unknown/custom', data: { reference: 0 } }]);
  await assert.rejects(bridge.load(malformed), /unsupported/);
  await assert.rejects(bridge.load({ ...canonical(), seed: { todos: { ver: 999, seq: -1, val: null } } }), /seed/);
  assert.equal(bridge.canonical('session-one').events.length, 0);
});
integration('original parameter schema rejects unknown fields before any event', async t => {
  const bridge = await setup(t);
  await assert.rejects(bridge.tool('session-one', 'invalid', 'todo_write', { todos: [{ content: 'x', status: 'pending', hidden: true }] }), /arguments/);
  assert.equal(bridge.canonical('session-one').events.length, 0);
  assert.equal((await bridge.describe('session-one'))[0].name, 'todo_write');
});
integration('duplicate receipt does not replay and open-turn command intent survives recovery', async t => {
  const bridge = await setup(t);
  const opened = canonical([{ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } }]);
  await bridge.load(opened);
  const command = await bridge.command('session-one', 'queued-on', 'plan');
  assert.deepEqual(command.payload.suffix.map(event => event.type), ['command/run', 'command/done']);
  await commit(bridge, command, 1); await commit(bridge, command, 1);
  assert.deepEqual(bridge.project('session-one').values.plan, { active: false, pending: true });
  const restarted = await createBridge({ cohortRoot }); t.after(() => restarted.close());
  await restarted.load(bridge.canonical('session-one'));
  const step = await restarted.beforeStep('session-one', 'boundary');
  assert.equal(step.payload.suffix[0].type, 'plan/mode');
  await commit(restarted, step, 2);
  assert.deepEqual(restarted.project('session-one').values.plan, { active: true, pending: false });
});
integration('generation disposal cancels a review even if the caller never answers', async t => {
  let entered;
  const asked = new Promise(resolve => { entered = resolve; });
  const bridge = await setup(t, { ask: async () => { entered(); return new Promise(() => {}); } });
  await commit(bridge, await bridge.command('session-one', 'on-close', 'plan'), 1);
  const review = bridge.tool('session-one', 'review-close', 'exit_plan_mode', { plan: '# Waiting\nNo answer.' });
  const rejected = assert.rejects(review, error => error.code === 'ASK_ABORTED');
  await asked; await bridge.close(); await rejected;
});
integration('an empty Last window honors its compatible seed instead of resetting to init', async t => {
  const bridge = await setup(t);
  const checkpoint = bridge.checkpoint('session-one');
  const state = { ...canonical(), seed: { ...checkpoint,
    plan: { ...checkpoint.plan, val: { ...checkpoint.plan.val, active: true, activeAtLastHeader: true,
      ...(Object.hasOwn(checkpoint.plan.val,'entered')?{entered:true}:{}) } },
    todos: { ver: 2, seq: -1, val: [{ content: 'inherited', status: 'completed' }] },
  } };
  await bridge.load(state);
  assert.equal(bridge.project('session-one').values.plan.active, true);
  assert.equal(bridge.project('session-one').values.todos[0].content, 'inherited');
});

integration('settled mirrors recycle beyond lifetime capacity and unknown outcomes stay pinned', async t => {
  const bridge = await setup(t);
  const pending = await bridge.command('session-one', 'uncertain', 'plan');
  let saved, token;
  for (let index = 0; index < 258; index++) {
    const id = `recyclable-${index}`;
    await bridge.load({ ...canonical(), header: { ...canonical().header, id } });
    const stage = await bridge.command(id, 'on', 'plan');
    await bridge.receipt(id, 'on', stage.token, 'committed', 1);
    if (index === 0) { saved = bridge.canonical(id); token = stage.token; }
  }
  assert.throws(() => bridge.canonical('recyclable-0'), /unavailable/);
  assert.deepEqual(await bridge.receipt('recyclable-0', 'on', token, 'committed', 1), { state: 'unloaded' });
  await assert.rejects(bridge.command('session-one', 'blocked', 'plan'), /receipt required/);
  await bridge.receipt('session-one', 'uncertain', pending.token, 'committed', 1);
  await bridge.load(saved);
  assert.equal(bridge.project('recyclable-0').values.plan.active, true);
  assert.deepEqual(bridge.canonical('recyclable-0').events, saved.events);
});

integration('unfinished loads pin capacity until explicitly aborted', async t => {
  const bridge = await setup(t);
  for (let index = 0; index < 255; index++) bridge.beginAgentLoad({
    session_id: `loading-${index}`, created_at: 0, revision: 0, count: 1,
  });
  assert.equal(bridge.beginAgentLoad({ session_id: 'session-one', created_at: 0, revision: 0, count: 1 }), 'transfer');
  assert.throws(() => bridge.beginAgentLoad({ session_id: 'overflow', created_at: 0, revision: 0, count: 0 }), /capacity/);
  bridge.abortAgentLoad({ session_id: 'loading-0' });
  bridge.beginAgentLoad({ session_id: 'after-abort', created_at: 0, revision: 0, count: 0 });
  await bridge.finishAgentLoad({ session_id: 'after-abort', checkpoint: null });
  assert.equal(bridge.canonical('after-abort').events.length, 0);
});
