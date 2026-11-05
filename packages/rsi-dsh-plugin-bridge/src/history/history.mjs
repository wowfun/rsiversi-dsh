import { observeRequest } from './request-history.mjs';
import { observeAttempt } from './model-history.mjs';
import { observeInput, observeTool } from './conversation-history.mjs';
import { stepMessageText } from './step-messages.mjs';
import { claimInput, clearClaims, preparedMessages } from './input-history.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const keys = ['version', 'factCursor', 'turn', 'step', 'turnId', 'stepId', 'stepOpen', 'model', 'calls', 'pendingMessages', 'claims'];
export function restoreMapping(value) {
  if (value == null) return { version: 4, factCursor: 0, turn: 0, step: 0, turnId: null, stepId: null, stepOpen: false, model: null, calls: [], pendingMessages: [], claims: [] };
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
      || value.version !== 4 || ![value.factCursor, value.turn, value.step].every(integer)
      || ![value.turnId, value.stepId].every(id => id === null || typeof id === 'string' && id.length > 0 && id.length <= 256)
      || typeof value.stepOpen !== 'boolean' || value.stepOpen && (value.turnId === null || value.stepId === null)) {
    throw new Error('invalid history checkpoint');
  }
  if (value.model !== null && (Object.keys(value.model).sort().join(',') !== 'effectId,model,provider,startedAt'
    || !['effectId', 'provider', 'model'].every(key => typeof value.model[key] === 'string' && value.model[key].length > 0 && value.model[key].length <= 256)
    || value.model.startedAt !== null && !integer(value.model.startedAt))) throw new Error('invalid captured model identity');
  if (!Array.isArray(value.calls) || value.calls.length > 256 || value.calls.some(call =>
    Object.keys(call).sort().join(',') !== 'callEvent,effect,event,id,model,started,step,turn'
    || ![call.event, call.turn, call.step].every(integer) || call.callEvent !== null && !integer(call.callEvent)
    || ![call.id, call.model].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)
    || typeof call.started !== 'boolean' || call.started && call.effect === null
    || call.effect !== null && (typeof call.effect !== 'string' || !call.effect || call.effect.length > 256))
    || new Set(value.calls.map(call => call.id)).size !== value.calls.length) throw new Error('invalid pending model calls');
  const pendingMessages = value.pendingMessages;
  if (!Array.isArray(pendingMessages) || pendingMessages.length > 64 || pendingMessages.length && value.stepId === null)
    throw new Error('invalid pending Step messages');
  for (const message of pendingMessages) stepMessageText(message);
  if (!Array.isArray(value.claims) || value.claims.length && value.turnId === null || value.claims.some((row, index) =>
    Object.keys(row).sort().join(',') !== 'count,fact_seq' || !integer(row.fact_seq) || row.fact_seq === 0 || row.fact_seq > value.factCursor
    || index > 0 && value.claims[index - 1].fact_seq >= row.fact_seq || !integer(row.count) || row.count === 0 || row.count > 0xffffffff))
    throw Error('invalid claimed input coordinates');
  return structuredClone(value);
}

/** Fragments belong to one captured, claim-visible horizon, never the mutable Store tail. */
export async function readHistory(request, identity, after, horizon, consume, signal) {
  if (!integer(after) || !integer(horizon) || after > horizon) throw new Error('invalid history horizon');
  let cursor = after;
  while (cursor < horizon) {
    const { through, value: facts } = await readPage(request, 'agent.history.read', { ...identity, through_seq: horizon }, cursor, horizon, signal);
    if (!Array.isArray(facts) || facts.length > 512 || facts.some((fact, i) => !integer(fact.seq) || fact.seq <= (i ? facts[i - 1].seq : cursor) || fact.seq > through)) {
      throw new Error('invalid captured Fact page');
    }
    for (const fact of facts) await consume(fact);
    cursor = through;
  }
  return cursor;
}

async function readPage(request, method, identity, after, horizon, signal) {
  let offset = 0, through, total; const fragments = [];
  do {
    signal?.throwIfAborted();
    const page = await request(method, { ...identity, after_seq: after, offset }, signal);
    if (!integer(page.through_seq) || page.through_seq <= after || page.through_seq > horizon
        || !integer(page.total_bytes) || page.total_bytes < 2 || page.total_bytes > 36 * 1024 * 1024 + 2
        || page.offset !== offset || !integer(page.next_offset) || page.next_offset <= offset
        || page.next_offset > page.total_bytes || typeof page.json !== 'string'
        || page.next_offset - offset > 128 * 1024 || Buffer.byteLength(page.json) !== page.next_offset - offset
        || through !== undefined && (through !== page.through_seq || total !== page.total_bytes)) throw new Error('invalid history fragment');
    through = page.through_seq; total = page.total_bytes; offset = page.next_offset; fragments.push(page.json);
  } while (offset < total);
  return { through, value: JSON.parse(fragments.join('')) };
}
export async function readAttempt(request, identity, seq, signal) {
  if (!integer(seq) || seq === 0) throw new Error('invalid model attempt sequence');
  const { through, value } = await readPage(request, 'agent.history.attempt.read', identity, seq - 1, seq, signal);
  if (through !== seq || value.seq !== seq) throw new Error('model attempt projection identity mismatch');
  return value;
}

export async function readNativeMessage(call, messageId, seq, signal) {
  const {through,value}=await readPage((_method,{offset})=>call({type:'message',message_id:messageId,
    accepted_control_seq:seq,offset}), 'message', {}, seq-1, seq, signal);
  if(through!==seq||value.message_id!==messageId)throw new Error('Native inbox acceptance identity mismatch');
  return value;
}

function closeStep(session, mapping, time) {
  if (mapping.pendingMessages.length) throw new Error('Step closed before its committed messages');
  if (mapping.stepOpen) session.appendObserved('step/end', { turn: mapping.turn, step: mapping.step }, time);
  mapping.stepOpen = false;
}
/** Only lifecycle Facts affect these counters; provider attempts do not fabricate acceptance. */
export async function observeFact(session, mapping, fact, readFact, readAttempt, llm) {
  if (!integer(fact.timestamp_ms) || fact.timestamp_ms === 0) throw new Error('invalid canonical Fact time');
  if (fact.type === 'model_intent') {
    await observeRequest(session, fact, readFact, mapping);
    if (fact.purpose?.kind === 'conversation') mapping.model = { effectId: fact.effect_id, provider: fact.snapshot.deployment_id, model: fact.snapshot.model, startedAt: null };
  } else if (fact.type === 'model_started' && mapping.model?.effectId === fact.effect_id) {
    mapping.model.startedAt = fact.timestamp_ms;
  } else if (fact.type === 'model_attempt_settled') {
    if (await observeAttempt(session, mapping, fact, readAttempt, llm)) closeStep(session, mapping, fact.timestamp_ms);
  } else if (['turn_accepted', 'message_turn_accepted', 'step_started'].includes(fact.type)) {
    if (mapping.turnId !== fact.turn_id) {
      if (mapping.turnId !== null) throw new Error('new Turn precedes canonical terminal');
      if (!Number.isSafeInteger(mapping.turn + 1)) throw new Error('Turn counter exhausted');
      mapping.turnId = fact.turn_id; mapping.turn++; mapping.step = 0;
      session.appendObserved('turn/start', { turn: mapping.turn, rsi: { session: session.id, fact: fact.seq, turn: fact.turn_id } }, fact.timestamp_ms);
    }
    if (fact.type === 'step_started') mapping.stepId = fact.step_id;
    if (fact.type === 'turn_accepted') claimInput(mapping, fact);
  } else if (['input_message_claimed', 'tool_contexts_claimed'].includes(fact.type)) {
    claimInput(mapping, fact);
  } else if (fact.type === 'step_inputs_prepared') {
    if (mapping.turnId !== fact.turn_id || mapping.stepId !== fact.step_id) throw Error('prepared Step is outside captured history');
    const messages = await preparedMessages(session, mapping, fact, readFact);
    if (messages !== null && (messages.length || mapping.step > 0)) {
      prepareStep(session, mapping, fact.turn_id, fact.step_id, fact.timestamp_ms);
      for (const message of messages) observeInput(session, mapping, message, fact.timestamp_ms);
    }
  } else if (['tool_intent', 'tool_started', 'tool_rejected', 'tool_result', 'tool_calls_superseded'].includes(fact.type)) {
    const pending = mapping.calls.length;
    observeTool(session, mapping, fact);
    if (pending && !mapping.calls.length) closeStep(session, mapping, fact.timestamp_ms);
  } else if (fact.type === 'step_ended' && fact.turn_id === mapping.turnId) {
    closeStep(session, mapping, fact.timestamp_ms);
    mapping.stepId = null;
  } else if (fact.type === 'turn_terminal' && fact.turn_id === mapping.turnId) {
    clearClaims(mapping); mapping.pendingMessages = [];
    observeTool(session, mapping, fact);
    closeStep(session, mapping, fact.timestamp_ms);
    const outcome = fact.outcome;
    const reason = { completed: { kind: 'completed' }, blocked: { kind: 'blocked' }, cancelled: { kind: 'aborted', reason: { kind: 'legacy' } },
      interrupted: { kind: 'interrupted' }, max_tokens: { kind: 'max-tokens' } }[outcome.status]
      ?? { kind: 'error', error: { code: outcome.code, message: outcome.message } };
    session.appendObserved('turn/end', { turn: mapping.turn, reason, rsi: { session: session.id, fact: fact.seq, turn: fact.turn_id } }, fact.timestamp_ms);
    mapping.turnId = null; mapping.stepId = null; mapping.model = null;
  }
}
export function prepareStep(session, mapping, turnId, stepId, now=Date.now()) {
  if (mapping.turnId !== turnId || mapping.stepId !== stepId) throw new Error('prepared Step is outside captured history');
  if (!Number.isSafeInteger(mapping.step + 1)) throw new Error('Step counter exhausted');
  closeStep(session, mapping, now);
  mapping.step++; mapping.stepOpen = true;
  session.appendObserved('step/start', { turn: mapping.turn, step: mapping.step }, now);
}
