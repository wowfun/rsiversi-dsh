import { requestObserver } from './request-history.mjs';
import { observeAttempt } from './model-history.mjs';
import {compactionInstalled, compactionPrepared, compactionStart, pluginCheckpoint} from './compaction-history.mjs';
import { observeInput, observeTool } from './conversation-history.mjs';
import { stepMessageText } from './step-messages.mjs';
import { claimInput, clearClaims, preparedMessages } from './input-history.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const keys = ['version', 'factCursor', 'turn', 'step', 'turnId', 'stepId', 'stepOpen', 'model', 'calls', 'pendingMessages', 'claims'];
const optional = ['compaction','compactionSettlement','startsRequestSeries','requestGeneration','preparedGeneration','cancelCause'];
function validCancelCause(cause) {
  return cause && (cause.kind==='hook' ? typeof cause.reason==='string' && Object.keys(cause).length===2
    : ['user','parent','disposed'].includes(cause.kind) && Object.keys(cause).length===1);
}
export function restoreMapping(value) {
  if (value == null) return { version: 4, factCursor: 0, turn: 0, step: 0, turnId: null, stepId: null, stepOpen: false, model: null, calls: [], pendingMessages: [], claims: [] };
  if (keys.some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => !keys.includes(key) && !optional.includes(key))
      || 'startsRequestSeries' in value && (value.startsRequestSeries !== true || !value.stepOpen)
      || 'cancelCause' in value && (!value.turnId || !validCancelCause(value.cancelCause))
      || ['requestGeneration','preparedGeneration'].some(key => key in value &&
        (typeof value[key] !== 'string' || !value[key].length || value[key].length > 256))
      || 'compaction' in value && (!integer(value.compaction) || !value.compaction || value.compaction > value.factCursor)
      || 'compactionSettlement' in value && (!integer(value.compactionSettlement) || !(value.compaction < value.compactionSettlement) || value.compactionSettlement > value.factCursor)
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

function closeStep(session, mapping, time) {
  if (mapping.pendingMessages.length) throw new Error('Step closed before its committed messages');
  if (mapping.stepOpen) session.adoptObserved({type:'step/end',seq:session.seq,time,
    data:{turn:mapping.turn,step:mapping.step}});
  mapping.stepOpen = false;
}
export function factObserver(session, mapping, readFact, llm, projectMessage) {
  const observeRequest = requestObserver(readFact);
  return fact => observeFact(session, mapping, fact, readFact, llm, observeRequest, projectMessage);
}

/** Only lifecycle Facts affect these counters; provider attempts do not fabricate acceptance. */
async function observeFact(session, mapping, fact, readFact, llm, observeRequest, projectMessage) {
  if (!integer(fact.timestamp_ms) || fact.timestamp_ms === 0) throw new Error('invalid canonical Fact time');
  if (fact.type === 'plugin_context_compacted') return pluginCheckpoint(session, mapping, fact, llm);
  const manual = fact.type === 'manual_compaction' && fact.event.stage;
  if (manual === 'installed' || fact.type === 'context_compaction_installed') {
    await compactionInstalled(session, mapping, fact, readFact, llm);
    delete mapping.compactionSettlement;
    return;
  }
  const pending = mapping.compaction && session.lastEvent('compaction/start');
  const prepared = compactionPrepared(fact);
  const closeFailed = () => {
    session.adoptObserved({type:'compaction/end', seq:session.seq, time:fact.timestamp_ms,
      data:{...pending.data, error:'The native attempt ended without installing a checkpoint.'}});
    delete mapping.compaction;
    delete mapping.compactionSettlement;
  };
  // A region can settle while another model is running. Ordinary model
  // activity does not decide whether that region installed.
  if (pending && (fact.type === 'turn_terminal' || prepared
      || mapping.compactionSettlement && pending.data.turn === null)) closeFailed();
  if (prepared) {
    compactionStart(session, mapping, fact);
    return;
  }
  if (manual === 'settled' || fact.type === 'model_attempt_settled' && fact.purpose === 'context_compaction') {
    if (pending?.data.compactionId !== fact.effect_id) throw Error('Compaction settled without its native intent');
    const attempt = (manual ? fact.event : fact).attempt;
    const terminal = attempt.events.at(-1)?.[1];
    if (terminal?.type === 'finished' && terminal.reason === 'stop') mapping.compactionSettlement = fact.seq;
    else closeFailed();
    return;
  }
  if (fact.type === 'model_intent') {
    await observeRequest(session, fact, mapping);
    if (fact.purpose?.kind === 'conversation') mapping.model = { effectId: fact.effect_id, provider: fact.snapshot.deployment_id, model: fact.snapshot.model, startedAt: null };
  } else if (fact.type === 'model_started' && mapping.model?.effectId === fact.effect_id) {
    mapping.model.startedAt = fact.timestamp_ms;
  } else if (fact.type === 'model_attempt_settled') {
    if (observeAttempt(session, mapping, fact, llm)) closeStep(session, mapping, fact.timestamp_ms);
  } else if (['turn_accepted', 'message_turn_accepted', 'step_started'].includes(fact.type)) {
    if (mapping.turnId !== fact.turn_id) {
      if (mapping.turnId !== null) throw new Error('new Turn precedes canonical terminal');
      if (!Number.isSafeInteger(mapping.turn + 1)) throw new Error('Turn counter exhausted');
      mapping.turnId = fact.turn_id; mapping.turn++; mapping.step = 0;
      session.adoptObserved({type:'turn/start',seq:session.seq,time:fact.timestamp_ms,
        data:{turn:mapping.turn,rsi:{session:session.id,fact:fact.seq,turn:fact.turn_id}}});
    }
    if (fact.type === 'step_started') mapping.stepId = fact.step_id;
    if (fact.type === 'turn_accepted') claimInput(mapping, fact);
  } else if (['input_message_claimed', 'tool_contexts_claimed'].includes(fact.type)) {
    claimInput(mapping, fact);
  } else if (fact.type === 'step_prepared') {
    const generation = fact.application?.generation;
    if (generation && generation !== mapping.requestGeneration) mapping.preparedGeneration = generation;
    else delete mapping.preparedGeneration;
  } else if (fact.type === 'step_inputs_prepared') {
    if (mapping.turnId !== fact.turn_id || mapping.stepId !== fact.step_id) throw Error('prepared Step is outside captured history');
    delete mapping.startsRequestSeries;
    const messages = await preparedMessages(session, mapping, fact, readFact, projectMessage);
    if (messages !== null && (messages.length || mapping.step > 0)) {
      prepareStep(session, mapping, fact.turn_id, fact.step_id, fact.timestamp_ms);
      if (fact.decision.starts_request_series) mapping.startsRequestSeries = true;
      for (const message of messages) observeInput(session, mapping, message, fact.timestamp_ms);
    }
  } else if (['tool_intent', 'tool_started', 'tool_rejected', 'tool_result', 'tool_calls_superseded'].includes(fact.type)) {
    const pending = mapping.calls.length;
    observeTool(session, mapping, fact);
    if (pending && !mapping.calls.length) closeStep(session, mapping, fact.timestamp_ms);
  } else if (fact.type === 'step_ended' && fact.turn_id === mapping.turnId) {
    closeStep(session, mapping, fact.timestamp_ms);
    delete mapping.startsRequestSeries;
    delete mapping.preparedGeneration;
    mapping.stepId = null;
  } else if (fact.type === 'cancel_requested' && fact.turn_id === mapping.turnId && fact.reason && typeof fact.reason === 'object') {
    mapping.cancelCause = fact.reason;
  } else if (fact.type === 'turn_terminal' && fact.turn_id === mapping.turnId) {
    delete mapping.startsRequestSeries;
    delete mapping.preparedGeneration;
    clearClaims(mapping); mapping.pendingMessages = [];
    observeTool(session, mapping, fact);
    closeStep(session, mapping, fact.timestamp_ms);
    const outcome = fact.outcome;
    const reason = { completed: { kind: 'completed' }, blocked: { kind: 'blocked' }, cancelled: { kind: 'aborted', reason: mapping.cancelCause ?? { kind: 'legacy' } },
      interrupted: { kind: 'interrupted' }, max_tokens: { kind: 'max-tokens' } }[outcome.status]
      ?? { kind: 'error', error: { code: outcome.code, message: outcome.message } };
    session.adoptObserved({type:'turn/end',seq:session.seq,time:fact.timestamp_ms,
      data:{turn:mapping.turn,reason,rsi:{session:session.id,fact:fact.seq,turn:fact.turn_id}}});
    delete mapping.cancelCause;
    mapping.turnId = null; mapping.stepId = null; mapping.model = null;
  }
}
export function prepareStep(session, mapping, turnId, stepId, now=Date.now()) {
  if (mapping.turnId !== turnId || mapping.stepId !== stepId) throw new Error('prepared Step is outside captured history');
  if (!Number.isSafeInteger(mapping.step + 1)) throw new Error('Step counter exhausted');
  closeStep(session, mapping, now);
  mapping.step++; mapping.stepOpen = true;
  session.adoptObserved({type:'step/start',seq:session.seq,time:now,data:{turn:mapping.turn,step:mapping.step}});
}
