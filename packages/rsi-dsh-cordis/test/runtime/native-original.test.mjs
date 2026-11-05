import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Peer } from '../../src/runtime/transport.mjs';
import { runtimeEnvironment } from '../../src/runtime/node.mjs';
const cohort = process.env.RSI_DSH_COHORT;
const integration = (name, run) => test(name, { skip: !cohort, timeout: 20_000 }, run);
async function host(t, handler = async () => { throw new Error('no callback authority'); }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../src/host.mjs', import.meta.url)), 'native-original',
    fileURLToPath(new URL('../../../rsi-dsh-plugin-bridge/src/index.mjs', import.meta.url)), cohort],
    { windowsHide: true, env: runtimeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(-64 * 1024); });
  const exit = once(child, 'exit');
  const peer = new Peer({ input: child.stdout, output: child.stdin, generation: 'native-original', handler });
  t.after(async () => {
    try { if (!peer.closed) await peer.request('extension.close', null, { signal: AbortSignal.timeout(2000) }); } catch {}
    peer.close(new Error('fixture retirement')); child.kill(); await exit;
  });
  assert.deepEqual(await peer.request('extension.hello', { protocol: 1 }, { signal: AbortSignal.timeout(10_000) }).catch(error => { throw new Error(`${error.message}: ${diagnostic}`); }), { protocol: 1 });
  return { peer, child, exit };
}
const canonical = () => ({ header: { version: 4, id: 'native-session', createdAt: 1, isSeeded: false }, revision: 0, events: [] });
const args = { sessionId: 'native-session' };
const command = (peer, operationId, input = '') => peer.request('command.execute', { ...args, operationId, name: 'plan', input });
const commit = (peer, staged, revision) => peer.request('operation.receipt', { ...args, operationId: staged.payload.operationId, token: staged.token, outcome: 'committed', revision });
integration('original host supports reverse Plan review while another command commits', async t => {
  let entered, answer;
  const asked = new Promise(resolve => { entered = resolve; });
  const { peer } = await host(t, async (method, request) => {
    assert.equal(method, 'user-question.ask'); assert.equal(request.operation_id, 'native-review');
    assert.deepEqual(request.review.map(choice => choice.id), ['approve', 'keep_planning', 'dismiss']);
    entered(); return new Promise(resolve => { answer = resolve; });
  });
  await peer.request('session.load', canonical());
  await commit(peer, await command(peer, 'native-on'), 1);
  const review = peer.request('tool.execute', { ...args, operationId: 'native-review', name: 'exit_plan_mode', arguments: { plan: '# Native review\nRead the original source.' } });
  const rejected = assert.rejects(review, /review no longer/);
  await asked;
  await commit(peer, await command(peer, 'native-off', 'off'), 2);
  answer({ answers: [], review: { choice_id: 'approve', feedback: null } });
  await rejected;
  assert.deepEqual((await peer.request('session.project', args)).values.plan, { active: false, pending: false });
});
integration('explicit review dismissal preserves original class identity and concludes the Turn', async t => {
  const { peer } = await host(t, async (method, request) => {
    assert.equal(method, 'user-question.ask');
    assert.equal(request.session_id, 'native-session');
    assert.match(request.questions[0].prompt, /# Dismissed plan/);
    return { answers: [], review: { choice_id: 'dismiss', feedback: null } };
  });
  await peer.request('session.load', canonical());
  await commit(peer, await command(peer, 'on'), 1);
  const staged = await peer.request('tool.execute', { ...args, operationId: 'review', name: 'exit_plan_mode', arguments: { plan: '# Dismissed plan\nKeep planning.' } });
  assert.deepEqual(staged.payload.result.value, { approved: false });
  assert.equal(staged.payload.result.concludeTurn, true);
  await commit(peer, staged, 2);
  assert.equal((await peer.request('session.project', args)).values.plan.active, true);
});
integration('process loss discards an uncommitted original Todo suffix without replay', async t => {
  const { peer, child, exit } = await host(t);
  await peer.request('session.load', canonical());
  const pending = await peer.request('tool.execute', { ...args, operationId: 'lost', name: 'todo_write', arguments: { todos: [{ content: 'Uncommitted', status: 'pending' }] } });
  assert.equal(pending.payload.suffix[0].seq, 0);
  child.kill(); await exit;
  const restarted = await host(t);
  await restarted.peer.request('session.load', canonical());
  assert.equal((await restarted.peer.request('session.project', args)).values.todos, null);
  const next = await restarted.peer.request('tool.execute', { ...args, operationId: 'new', name: 'todo_write', arguments: { todos: [] } });
  assert.equal(next.payload.suffix[0].seq, 0);
  await commit(restarted.peer, next, 1);
});
