import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {sessionController} from '../../src/workbench/session-controller.mjs';
import {SessionFacade} from '../../src/session/session.mjs';

const enabled = {skip: !process.env.RSI_DSH_MARKET_COHORT};
async function fixture(t) {
  const require = createRequire(join(process.env.RSI_DSH_MARKET_COHORT, 'package.json'));
  const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
  const ctx = new (await load('cordis')).Context();
  t.after(() => ctx.fiber.dispose());
  const api = {...await load('dsh-session'), ...await load('dsh-session/surface'), ...await load('dsh-util-values')};
  const unavailable = new Proxy({}, {get() { throw Error('Passive subscription touched native history'); }});
  class Service { constructor(ctx) { this.ctx = ctx; } }
  const Controller = sessionController({TypertRemoteService: Service, RemoteError: (await load('dsh-typert-protocol')).RemoteError,
    Deque: (await load('dsh-deque')).Deque},
    unavailable, unavailable);
  const controller = new Controller(ctx);
  const stop = new AbortController();
  t.after(() => stop.abort());
  function session(id, events = []) {
    return new SessionFacade(ctx, api, {header: {version: 4, id, createdAt: 0, isSeeded: false}, events}, false);
  }
  function append(session, turn) {
    session.begin();
    try { return session.append('turn/start', {turn}); }
    finally { session.end(); }
  }
  const observe = (id, signal = stop.signal) => controller.observeEvent({address: {kind: 'session', sessionId: id}}, signal);
  return {ctx, session, append, observe, stop};
}

test('passive readiness precedes Session creation and only the target events are delivered', enabled, async t => {
  const f = await fixture(t), stream = f.observe('future');
  assert.deepEqual(await stream.next(), {done: false, value: {type: 'ready'}});
  const session = f.session('future'), other = f.session('other');
  session.attach(); other.attach();
  f.append(other, 1);
  const first = f.append(session, 1), second = f.append(session, 2);
  assert.deepEqual((await stream.next()).value, {type: 'event', event: first});
  assert.deepEqual((await stream.next()).value, {type: 'event', event: second});
  const idle = stream.next();
  f.stop.abort();
  assert.equal((await idle).done, true);
  assert.equal((await stream.next()).done, true);
});

test('creation backfills live events once and excludes restored history', enabled, async t => {
  const f = await fixture(t);
  const seed = {seq: 0, time: 0, type: 'turn/start', data: {turn: 1}};
  const session = f.session('restored', [seed]), stream = f.observe('restored');
  assert.equal(session.firstLiveSeq, 1);
  await stream.next();
  const first = f.append(session, 2);
  // DSH can publish an event while a Session's creation notification is queued.
  f.ctx.emit('session/event', session, first);
  const second = f.append(session, 3);
  const third = f.append(session, 4);
  f.ctx.emit('session/event', session, third);
  assert.deepEqual((await stream.next()).value, {type: 'event', event: first});
  session.attach();
  assert.deepEqual((await stream.next()).value, {type: 'event', event: second});
  assert.deepEqual((await stream.next()).value, {type: 'event', event: third});
  const fourth = f.append(session, 5);
  assert.deepEqual((await stream.next()).value, {type: 'event', event: fourth});
  await stream.return();
});

test('passive streams stop on scope disposal and reject a sequence gap', enabled, async t => {
  const f = await fixture(t), stream = f.observe('scope');
  await stream.next();
  const idle = stream.next();
  await f.ctx.fiber.dispose();
  assert.equal((await idle).done, true);
  const g = await fixture(t), events = g.observe('gap'), session = g.session('gap');
  session.attach(); await events.next();
  const first = g.append(session, 1);
  assert.equal((await events.next()).value.event, first);
  g.ctx.emit('session/event', session, {...first, seq: first.seq + 2});
  await assert.rejects(events.next(), error => error.code === 'gateway/internal');
});
