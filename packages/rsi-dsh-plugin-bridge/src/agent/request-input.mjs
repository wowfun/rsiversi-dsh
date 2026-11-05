import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { contentBlocks, inputMessage } from '../history/conversation-history.mjs';
import { messagePart } from './file-input.mjs';

function nativeMessage(message, original, references) {
  if (message.role !== 'user') throw Error('DSH pre-step returned a non-user message');
  return { role: 'user', attribution: { id: message.id, source: message.source }, content: message.content.map((block, index) => {
    if (block.type === 'text') {
      const reference = references.get(block);
      if (reference && block.text === reference.text) return reference.part;
      const part = original?.nativeContent?.[index];
      return part?.type === 'reference' && block.text === original.message.content[index].text ? part : block;
    }
    return messagePart(block);
  }) };
}

export function claimRows(sessionId, fact) {
  const count = fact.type === 'tool_contexts_claimed' ? fact.messages.length : 1;
  return Array.from({ length: count }, (_, ordinal) => ({
    entry: { kind: 'claimed', claim: { fact_seq: fact.seq, ordinal } },
    message: inputMessage(sessionId, fact, ordinal),
    nativeContent: fact.content,
  }));
}

function previousRows(rows, previous) {
  if (!previous) return rows;
  const originals = new Map(rows.map(row => [row.entry.claim.fact_seq + '/' + row.entry.claim.ordinal, row]));
  return previous.messages.map(entry => {
    if (entry.kind === 'claimed') {
      const row = originals.get(entry.claim.fact_seq + '/' + entry.claim.ordinal);
      if (!row) throw Error('Preset decision references an absent input');
      return row;
    }
    const { role, attribution, content } = entry.message;
    return { entry, nativeContent: content, message: { role, ...attribution, content: contentBlocks(content) } };
  });
}

// Hooks may mutate their input. Text strings are immutable and can stay shared
// with the captured Fact while block objects, attachments and sources are private.
function editable({message, nativeContent}, references) {
  return { ...message, source: structuredClone(message.source),
    content: message.content.map((block, index) => {
      if (block.type !== 'text') return structuredClone(block);
      const copy = { ...block }, part = nativeContent?.[index];
      if (part?.type === 'reference') references.set(copy, { text: block.text, part });
      return copy;
    }) };
}

export function prepareRequestInputs({ ctx, agent, input, modelSelection, assembly, signal }, api) {
  const rows = previousRows(input.claims.flatMap(fact => claimRows(agent.id, fact)), input.previous);
  if (!input.previous || input.previous.messages.length) {
    const staged = input.contributed ?? [];
    for (const [index, fact] of staged.entries()) {
      const claim = { preceding: staged.length - index + input.trailing_facts, ordinal: 0 };
      const message = inputMessage(agent.id, fact);
      // A staged user claim has no absolute sequence yet. Persist the same ID
      // that the waterfall saw when this message is eventually entered.
      if (message.role === 'user') message.id = randomUUID();
      rows.push({ entry: message.role === 'user' ? { kind: 'replacement', claim, message: {
        role: message.role, attribution: { id: message.id, source: message.source }, content: fact.content,
      } } : { kind: 'claimed', claim }, message, nativeContent: fact.content });
    }
  }
  return prepareRows({ ctx, agent, rows, modelSelection, assembly, signal }, api);
}

/** Native guidance stays in its slots; the waterfall owns the ordered user list. */
export async function prepareRows({ ctx, agent, rows, previous, modelSelection, assembly, signal }, api) {
  rows = previousRows(rows, previous);
  const users = rows.filter(row => row.message.role === 'user');
  const messages = [], copies = new Map(), byObject = new WeakMap(), byId = new Map(), references = new WeakMap();
  for (const row of users) {
    let message = copies.get(row);
    if (!message) {
      message = editable(row, references);
      copies.set(row, message);
      byObject.set(message, row);
    }
    messages.push(message);
    byId.set(message.id, byId.has(message.id) ? null : row);
  }
  const turn = agent.session.lastEvent?.('turn/start')?.data.turn ?? 1;
  const lastStep = agent.session.lastEvent?.('step/start')?.data;
  const step = lastStep?.turn === turn ? lastStep.step + 1 : 1;
  const decision = await api.agentEvents(ctx, agent).waterfall('agent/pre-step', {
    messages, turn, step, signal, modelSelection,
  }, async () => {
    const context = api.runtimeContext(agent.session, assembly);
    return { kind: 'enter', messages: context === undefined ? messages : [...messages, context] };
  });
  signal.throwIfAborted();
  if (decision.kind === 'reject') return { kind: 'reject' };
  if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) throw Error('Invalid pre-step decision');
  // Removing every waking/user input must not turn native guidance into a new
  // request. Guidance-only later rounds remain outside the user waterfall.
  if (users.length && decision.messages.length === 0) return { kind: 'enter', messages: [] };
  const prepared = decision.messages.map(message => {
    const original = byObject.get(message) ?? byId.get(message.id);
    if (original && isDeepStrictEqual(original.message, message)) return original.entry;
    const authored = nativeMessage(message, original, references);
    return original?.entry.claim ? { kind: 'replacement', claim: original.entry.claim, message: authored } : { kind: 'added', message: authored };
  });
  const final = []; let next = 0;
  for (const row of rows) {
    if (row.message.role === 'developer') final.push(row.entry);
    else if (next < prepared.length) final.push(prepared[next++]);
  }
  for (; next < prepared.length; next++) final.push(prepared[next]);
  return { kind: 'enter', messages: final };
}

/** DSH's committed runtime-context baseline, read incrementally without another event subscriber. */
export function runtimeContextProjection({ renderContextSections, joinContextSections, createUserMessage }) {
  const sessions = new WeakMap();
  const owned = event => event?.type === 'user/message' && event.data.source?.kind === 'runtime-context';
  const retained = event => ({ seq: event.seq, text: event.data.content.length === 1 && event.data.content[0].type === 'text'
    ? event.data.content[0].text : undefined });
  return (session, assembly) => {
    let state = sessions.get(session);
    if (!state) {
      state = { through: session.seq ?? 0, retained: undefined };
      const surface = new Set(session.surface?.nodes ?? []);
      for (let seq = state.through - 1; seq >= 0; seq--) {
        const event = session.eventAt(seq);
        if (!owned(event)) continue;
        state.retained = null;
        if (surface.has(seq)) { state.retained = retained(event); break; }
      }
      sessions.set(session, state);
    } else {
      for (; state.through < session.seq; state.through++) {
        const event = session.eventAt(state.through);
        if (owned(event)) state.retained = retained(event);
        else if (state.retained && event.surfaceOp && event.surfaceOp !== 'append'
          && event.sourceEventSeqs?.includes(state.retained.seq)) state.retained = null;
      }
    }
    const sections = renderContextSections(assembly), current = joinContextSections(sections);
    if (state.retained === undefined && !current.length) return;
    const snapshot = current.length ? current : 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
    if (state.retained?.text === snapshot) return;
    return createUserMessage({ content: [{ type: 'text', text: snapshot }], source: sections.length
      ? { kind: 'runtime-context', form: 'snapshot', sections } : { kind: 'runtime-context' } });
  };
}
