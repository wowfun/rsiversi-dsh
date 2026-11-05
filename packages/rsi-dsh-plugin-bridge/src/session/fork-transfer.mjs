import { SessionFacade } from './session.mjs';
import { restoreMapping, readHistory, readAttempt, observeFact } from '../history/history.mjs';
import { forkSnapshot, validateLineage } from './fork.mjs';

const bytes = value => Buffer.byteLength(JSON.stringify(value));
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

/** Bounded, disposable read-only transforms; no parent record or business callback is attached. */
export class ForkTransfers {
  #entries = new Map();
  constructor(ctx, api, llm, surface, request, otherBytes) {
    Object.assign(this, { ctx, api, llm, surface, request, otherBytes });
  }
  get encodedBytes() { return [...this.#entries.values()].reduce((sum, entry) => sum + entry.bytes, 0); }
  #get(id) { const entry = this.#entries.get(id); if (!entry) throw new Error('fork transfer unavailable'); return entry; }
  begin(args) {
    const { operation_id, session_id, created_at, count, checkpoint, after_seq, through_seq, include_inherited } = args;
    if (!identity(operation_id) || !identity(session_id) || ![created_at, count, after_seq, through_seq].every(integer)
      || typeof include_inherited !== 'boolean' || count > 100_000 || after_seq > through_seq || bytes(checkpoint) > 64 * 1024) throw new Error('invalid fork transfer boundary');
    if (this.#entries.has(operation_id) || this.#entries.size >= 2) throw new Error('fork transfer capacity');
    const size = bytes(checkpoint);
    if (this.otherBytes() + this.encodedBytes + size > 256 * 1024 * 1024) throw new Error('generation mirror capacity');
    const controller = new AbortController();
    const timer = setTimeout(() => this.release(operation_id), 35_000); timer.unref();
    this.#entries.set(operation_id, { ...structuredClone(args), events: [], bytes: size, controller, timer, result: null, running: false });
  }
  append({ operation_id, offset, events }) {
    const entry = this.#get(operation_id);
    if (entry.running || entry.result || offset !== entry.events.length || !Array.isArray(events) || !events.length
      || events.length > 4096 || events.length > entry.count - offset) throw new Error('invalid fork input page');
    const size = bytes(events);
    if (size > 256 * 1024 || entry.bytes + size > 64 * 1024 * 1024
      || this.otherBytes() + this.encodedBytes + size > 256 * 1024 * 1024) throw new Error('fork input capacity');
    entry.events.push(...structuredClone(events)); entry.bytes += size;
  }
  async finish({ operation_id }, signal) {
    const entry = this.#get(operation_id);
    if (entry.running || entry.result || entry.events.length !== entry.count) throw new Error('incomplete fork input');
    entry.running = true;
    const cancellation = AbortSignal.any([entry.controller.signal, ...(signal ? [signal] : [])]);
    try {
      const lineage = validateLineage(entry.checkpoint?.lineage, entry.events.length);
      const canonical = { header: { version: 4, id: entry.session_id, createdAt: entry.created_at, isSeeded: lineage !== null,
        ...(lineage ? { parentSession: lineage.parentSession } : {}) }, events: entry.events,
        inheritedEventCount: lineage?.inheritedEventCount ?? 0, lineage, seed: entry.checkpoint?.seed ?? null,
        pendingIntent: entry.checkpoint?.pendingIntent ?? null,
        mapping: restoreMapping(entry.checkpoint?.mapping), revision: 0 };
      if (canonical.mapping.factCursor > entry.through_seq) throw new Error('fork checkpoint exceeds captured horizon');
      const session = new SessionFacade(this.ctx, this.api, canonical, false); session.begin();
      const identity = { session_id: entry.session_id, operation_id };
      const readFact = async seq => {
        let value;
        await readHistory(this.request, identity, seq - 1, seq, fact => { value = fact; }, cancellation);
        if (value?.seq !== seq) throw new Error('fork evidence reference absent');
        return value;
      };
      canonical.mapping.factCursor = await readHistory(this.request, identity, canonical.mapping.factCursor, entry.through_seq,
        fact => observeFact(session, canonical.mapping, fact, readFact, seq => readAttempt(this.request, identity, seq, cancellation), this.llm), cancellation);
      cancellation.throwIfAborted();
      canonical.events = session.snapshotEvents();
      const result = forkSnapshot(canonical, { header: { version: 4, id: `fork-${operation_id}`.slice(0, 256), createdAt: entry.created_at },
        afterFact: entry.after_seq, throughFact: entry.through_seq, includeInherited: entry.include_inherited }, this.ctx.sessionProjections, this.surface);
      const checkpoint = { seed: result.seed, lineage: result.lineage, mapping: result.mapping, pendingIntent: result.pendingIntent,
        views: result.views };
      const size = bytes(result.events) + bytes(checkpoint);
      if (bytes(checkpoint) > 64 * 1024 || size > 64 * 1024 * 1024
        || this.otherBytes() + this.encodedBytes - entry.bytes + size > 256 * 1024 * 1024) throw new Error('fork result capacity');
      entry.events = []; entry.checkpoint = null; entry.bytes = size; entry.result = { events: result.events, checkpoint };
      return { count: result.events.length, checkpoint };
    } catch (error) { this.release(operation_id); throw error; }
  }
  read({ operation_id, offset }) {
    const { result } = this.#get(operation_id);
    if (!result || !integer(offset) || offset >= result.events.length) throw new Error('invalid fork result cursor');
    const events = []; let size = 2;
    for (const event of result.events.slice(offset, offset + 4096)) {
      const next = bytes(event) + (events.length ? 1 : 0);
      if (size + next > 256 * 1024) break;
      size += next; events.push(event);
    }
    if (!events.length) throw new Error('fork event exceeds page capacity');
    return { offset, events, next_offset: offset + events.length };
  }
  release(id) {
    const entry = this.#entries.get(id); if (!entry) return;
    entry.controller.abort(); clearTimeout(entry.timer); this.#entries.delete(id);
  }
  close() { for (const id of this.#entries.keys()) this.release(id); }
}
