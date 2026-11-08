import { contentBlocks, inputMessage } from './conversation-history.mjs';
import { claimRows } from '../agent/request-input.mjs';
import { takeCommittedMessage } from './step-messages.mjs';

// Facts are immutable native observations. Checkpoints retain only coordinates;
// a branch shares bodies instead of cloning a potentially multi-MiB pending input.
const captured = new WeakMap();
const count = fact => fact.type === 'tool_contexts_claimed' ? fact.messages.length :
  ['turn_accepted', 'input_message_claimed'].includes(fact.type) ? 1 : 0;

export function cloneMapping(mapping) {
  const next = structuredClone(mapping), facts = captured.get(mapping);
  if (facts) captured.set(next, new Map(facts));
  return next;
}

export function claimInput(mapping, fact) {
  const size = count(fact);
  if (!size) return;
  mapping.claims.push({ fact_seq: fact.seq, count: size });
  let facts = captured.get(mapping);
  if (!facts) captured.set(mapping, facts = new Map());
  facts.set(fact.seq, fact);
}

async function originalFact(mapping, row, readFact) {
  let facts = captured.get(mapping);
  if (!facts) captured.set(mapping, facts = new Map());
  let fact = facts.get(row.fact_seq);
  if (!fact) {
    fact = await readFact(row.fact_seq);
    if (fact?.seq !== row.fact_seq || count(fact) !== row.count || fact.turn_id !== mapping.turnId)
      throw Error('Claimed input differs from captured history');
    facts.set(row.fact_seq, fact);
  }
  return fact;
}

export async function claimedRows(session, mapping, readFact, previous) {
  const rows = [];
  const needed = previous && new Set(previous.messages.filter(entry=>entry.kind==='claimed').map(entry=>entry.claim.fact_seq));
  for (const row of mapping.claims) {
    if (!needed || needed.has(row.fact_seq)) rows.push(...claimRows(session.id, await originalFact(mapping, row, readFact)));
  }
  return rows;
}

export function clearClaims(mapping) {
  mapping.claims = [];
  captured.delete(mapping);
}

export async function preparedMessages(session, mapping, fact, readFact) {
  const { decision } = fact;
  if (decision.kind === 'reject') {
    clearClaims(mapping); mapping.pendingMessages = [];
    return null;
  }
  if (decision.kind !== 'enter') throw Error('Unknown input preparation decision');
  const rows = new Map(mapping.claims.map(row => [row.fact_seq, row]));
  const originals = new Map(), result = [];
  let offset = 0;
  for (const entry of decision.messages) {
    let row;
    if (entry.kind === 'claimed' || entry.kind === 'replacement') {
      row = rows.get(entry.claim.fact_seq ?? fact.seq - entry.claim.preceding);
      if (!row || !Number.isSafeInteger(entry.claim.ordinal) || entry.claim.ordinal < 0 || entry.claim.ordinal >= row.count)
        throw Error('Prepared input is outside the captured claimed set');
    }
    if (entry.kind === 'claimed') {
      const key = `${row.fact_seq}:${entry.claim.ordinal}`;
      let message = originals.get(key);
      if (!message) {
        const original = await originalFact(mapping, row, readFact);
        message = takeCommittedMessage(mapping, original) ?? inputMessage(session.id, original, entry.claim.ordinal);
        originals.set(key, message);
      }
      result.push(message);
    } else if (entry.kind === 'replacement' || entry.kind === 'added') {
      const { role, attribution, content } = entry.message;
      let blocks = contentBlocks(content, fact.seq, offset);
      offset += content.length;
      if (role === 'developer' && blocks.length) blocks = [{ type: 'text', text: blocks.map(block => block.text).join('\n') }];
      result.push({ role, id: attribution.id, source: structuredClone(attribution.source), content: blocks });
    } else throw Error('Unknown prepared input entry');
  }
  clearClaims(mapping);
  return result;
}
