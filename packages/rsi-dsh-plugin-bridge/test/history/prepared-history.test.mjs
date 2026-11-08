import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { restoreMapping, factObserver } from '../../src/history/history.mjs';
import { cloneMapping, claimedRows } from '../../src/history/input-history.mjs';
import { prepareRequestInputs } from '../../src/agent/request-input.mjs';
import { SessionFacade } from '../../src/session/session.mjs';

const root = process.env.RSI_DSH_MARKET_COHORT;
async function fixture(t, original) {
  const events = [];
  let session = { id: 'prepared', surface: { nodes: [] }, eventAt: seq => events[seq],
    snapshotEvents: () => events,
    appendObserved(type, data, time, options = {}) {
      const event = { seq: events.length, type, data, time, ...options };
      events.push(event);
      if (options.surfaceOp === 'append') this.surface.nodes.push(event.seq);
      return event;
    } };
  if (original) {
    const require = createRequire(join(root, 'package.json'));
    const load = name => import(pathToFileURL(require.resolve('@deepseek-ai/' + name)));
    const ctx = new (await load('cordis')).Context(); t.after(() => ctx.fiber.dispose());
    const api = Object.assign({}, await load('dsh-session'), await load('dsh-session/surface'), await load('dsh-util-values'));
    session = new SessionFacade(ctx, api, { header: { version: 4, id: 'prepared', createdAt: 1, isSeeded: false } });
    session.begin(); t.after(() => session.end());
  }
  let mapping = restoreMapping(), reads = 0;
  const facts = [];
  const read = async seq => { reads++; return facts[seq - 1]; };
  return { session, facts, read, get reads() { return reads; }, get mapping() { return mapping; },
    restore() { mapping = restoreMapping(JSON.parse(JSON.stringify(mapping))); },
    branch() { mapping = cloneMapping(mapping); },
    async observe(body) {
      const fact = { seq: facts.length + 1, timestamp_ms: 100 + facts.length, turn_id: 'turn', step_id: 'step', ...body };
      facts.push(fact);
      await factObserver(session, mapping, read)(fact);
      mapping.factCursor = fact.seq;
      return fact;
    },
    messages() { return session.snapshotEvents().filter(row => ['user/message', 'developer/message'].includes(row.type))
      .map(row => row.type === 'user/message' ? row.data : row.data.message); },
  };
}
const text = value => [{ type: 'text', text: value }];
const claim = (fact_seq, ordinal = 0) => ({ kind: 'claimed', claim: { fact_seq, ordinal } });
const authored = (id, content, role = 'user') => ({ role, attribution: { id, source: { kind: 'test-context' } }, content });

for (const original of [false, true]) {
  const label = original ? 'original released DSH Surface' : 'projection';
  const options = { skip: original && !root };
  test(`${label}: file identity survives cold prepared history without a path or file body`, options, async t=>{
    const f=await fixture(t,original),file={id:'a'.repeat(64),name:'report.csv',bytes:8_000_000_000};
    await f.observe({type:'message_turn_accepted'});await f.observe({type:'step_started'});
    await f.observe({type:'input_message_claimed',source:{type:'human',message_id:'uploaded'},content:[{type:'file',file}]});
    f.restore();
    await f.observe({type:'step_inputs_prepared',decision:{kind:'enter',messages:[claim(3)]}});
    assert.equal(f.reads,1);
    assert.deepEqual(f.messages()[0].content,[{type:'file',attachment:{attachmentId:'sha256:'+file.id,name:file.name,bytes:file.bytes}}]);
  });
  test(`${label}: final entry owns replacement, omission, order, repeats and empty bodies`, options, async t => {
    const f = await fixture(t, original);
    await f.observe({ type: 'turn_accepted', text: 'UNENTERED waking text' });
    await f.observe({ type: 'step_started' });
    await f.observe({ type: 'input_message_claimed', source: { type: 'human', message_id: 'human' }, content: text('UNENTERED original') });
    await f.observe({ type: 'tool_contexts_claimed', messages: ['first', 'second'].map(id => ({ message: { id, source: { kind: 'tool-extra' }, text: [id] } })) });
    assert.deepEqual(f.messages(), []);
    assert.equal(f.session.snapshotEvents().filter(row => row.type === 'step/start').length, 0);
    f.branch();
    const prepared = await f.observe({ type: 'step_inputs_prepared', decision: { kind: 'enter', messages: [
      claim(4, 1), { kind: 'replacement', claim: { preceding: 2, ordinal: 0 }, message: authored('human', text('rewritten')) },
      claim(4, 1), { kind: 'replacement', claim: { fact_seq: 1, ordinal: 0 }, message: authored('empty', []) },
      { kind: 'added', message: authored('guidance', text('developer guidance'), 'developer') },
    ] } });
    assert.deepEqual(f.messages().map(message => [message.id, message.role, message.content]), [
      ['second', 'user', text('second')], ['human', 'user', text('rewritten')], ['second', 'user', text('second')],
      ['empty', 'user', []], ['guidance', 'developer', text('developer guidance')],
    ]);
    assert.equal(f.reads, 0, 'warm branches reuse captured Fact bodies');
    assert.deepEqual(f.mapping.claims, []);
    assert.ok(!JSON.stringify(f.session.snapshotEvents()).includes('UNENTERED'));
    assert.ok(f.session.snapshotEvents().filter(row => /^(user|developer)\/message$/.test(row.type))
      .every(row => row.time === prepared.timestamp_ms));
    await assert.rejects(f.observe({ type: 'step_inputs_prepared', decision: { kind: 'enter', messages: [claim(3)] } }), /claimed set/);
  });

  test(`${label}: cold restore reads one Fact for an arbitrary ordered subset of its batch`, options, async t => {
    const f = await fixture(t, original);
    await f.observe({ type: 'message_turn_accepted' }); await f.observe({ type: 'step_started' });
    await f.observe({ type: 'tool_contexts_claimed', messages: Array.from({ length: 96 }, (_, i) => ({
      message: { id: `item-${i}`, source: { kind: 'tool-extra' }, text: [`body-${i}`] },
    })) });
    f.restore();
    const entries = [95, 0, 95, ...Array.from({ length: 70 }, (_, i) => i)].map(i => claim(3, i));
    await f.observe({ type: 'step_inputs_prepared', decision: { kind: 'enter', messages: entries } });
    assert.equal(f.reads, 1, 'one lookup per needed Fact, not per Tool context or repeat');
    assert.deepEqual(f.messages().map(message => message.id), entries.map(entry => `item-${entry.claim.ordinal}`));
  });

  test(`${label}: rejected or initially empty entry leaves no Step or input in history`, options, async t => {
    for (const decision of [{ kind: 'reject' }, { kind: 'enter', messages: [] }]) {
      const f = await fixture(t, original);
      await f.observe({ type: 'turn_accepted', text: 'dropped' }); await f.observe({ type: 'step_started' });
      f.restore(); await f.observe({ type: 'step_inputs_prepared', decision });
      assert.equal(f.reads, 0); assert.deepEqual(f.messages(), []); assert.deepEqual(f.mapping.claims, []);
      await f.observe({ type: 'turn_terminal', outcome: { status: decision.kind === 'reject' ? 'blocked' : 'completed' } });
      assert.deepEqual(f.session.snapshotEvents().map(row => row.type), ['turn/start', 'turn/end']);
      assert.equal(f.session.snapshotEvents().at(-1).data.reason.kind, decision.kind === 'reject' ? 'blocked' : 'completed');
    }
  });
}

test('pending checkpoints do not copy large input bodies; branch preparation does not reread them', async t => {
  const f = await fixture(t, false);
  await f.observe({ type: 'turn_accepted', text: 'x'.repeat(1024 * 1024) }); await f.observe({ type: 'step_started' });
  const encoded = JSON.stringify(f.mapping);
  assert.ok(Buffer.byteLength(encoded) < 512);
  f.branch();
  assert.equal((await claimedRows(f.session, f.mapping, f.read))[0].message.content[0].text.length, 1024 * 1024);
  assert.equal(f.reads, 0);
  f.restore();
  assert.equal((await claimedRows(f.session, f.mapping, f.read))[0].message.content[0].text.length, 1024 * 1024);
  assert.equal(f.reads, 1);
  await f.observe({ type: 'step_inputs_prepared', decision: { kind: 'enter', messages: [claim(1)] } });
  assert.equal(f.reads, 1);
});

test('terminal cleanup and checkpoint admission enforce coordinates without retaining rejected content', async t => {
  const f = await fixture(t, false);
  await f.observe({ type: 'turn_accepted', text: 'not prepared' });
  const good = JSON.parse(JSON.stringify(f.mapping));
  for (const value of [{ ...good, version: 3 }, { ...good, claims: [{ fact_seq: 2, count: 1 }] },
    { ...good, claims: [{ fact_seq: 1, count: 0 }] }, { ...good, claims: [good.claims[0], good.claims[0]] }])
    assert.throws(() => restoreMapping(value), /checkpoint|coordinates/);
  await f.observe({ type: 'turn_terminal', outcome: { status: 'cancelled' } });
  assert.deepEqual(f.mapping.claims, []); assert.deepEqual(f.messages(), []);
  assert.doesNotThrow(() => f.restore());
});

test('a discarded projection branch leaves the source claims reusable without another native read', async t => {
  const f = await fixture(t, false);
  await f.observe({ type: 'turn_accepted', text: 'source retained' }); await f.observe({ type: 'step_started' });
  const parent = f.mapping;
  f.branch();
  await f.observe({ type: 'step_inputs_prepared', decision: { kind: 'reject' } });
  assert.deepEqual(parent.claims, [{ fact_seq: 1, count: 1 }]);
  assert.deepEqual((await claimedRows(f.session, cloneMapping(parent), f.read))[0].message.content, text('source retained'));
  assert.equal(f.reads, 0);
});

test('rewritten references use preparation block offsets while unchanged references retain their claim', async t => {
  const f = await fixture(t, false);
  const reference = { type: 'reference', reference: { preview: 'preview', metadata: {
    source: { kind: 'native', binding: { session_id: 'source' } }, target: { session_id: 'prepared' },
    capture: { kind: 'suffix', interval: { through_seq: '17', omissions: ['fact_limit'] } },
  } } };
  await f.observe({ type: 'message_turn_accepted' }); await f.observe({ type: 'step_started' });
  await f.observe({ type: 'input_message_claimed', source: { type: 'human' }, content: [reference] });
  const previous = { kind: 'enter', messages: [
    { kind: 'added', message: authored('prefix', text('prefix')) }, claim(3),
    { kind: 'replacement', claim: { fact_seq: 3, ordinal: 0 }, message: authored('new', [...text('text'), reference]) },
  ] };
  const decision = await prepareRequestInputs({ agent: { id: 'prepared', session: f.session },
    input: { claims: [f.facts[2]], previous }, signal: new AbortController().signal }, {
    agentEvents: () => ({ waterfall: (_, event) => {
      assert.match(event.messages[1].content[0].text, /fact_seq="3"/);
      assert.equal(event.messages[2].content[1].text, 'Referenced conversation data from source through record 17. Earlier material was omitted by capture limits.\npreview');
      event.messages[2].content[0].text = 'edited next to a reference';
      return { kind: 'enter', messages: event.messages };
    } }),
  });
  assert.deepEqual(decision.messages[2].message.content, [...text('edited next to a reference'), reference]);
  await f.observe({ type: 'step_inputs_prepared', decision });
  assert.equal(f.messages()[1].content[0].text, 'Referenced conversation data from source through record 17. Earlier material was omitted by capture limits.\npreview\nRead more with reference_read using recorded_session_id="prepared", fact_seq="3", content_index=0.');
  assert.match(f.messages()[2].content[1].text, /fact_seq="4", content_index=2\.$/);
});
