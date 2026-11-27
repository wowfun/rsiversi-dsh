import { SessionFacade } from './session.mjs';
import { restoreMapping, factObserver } from '../history/history.mjs';
import { readHistory } from '../history/pages.mjs';
import { forkSnapshot, validateLineage } from './fork.mjs';
import {eventPage,eventPageSizes,readPart} from '../agent/extension/settlement.mjs';

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
      || typeof include_inherited !== 'boolean' || count > 100_000 || after_seq > through_seq) throw new Error('invalid fork transfer boundary');
    const size = bytes(checkpoint);
    if (size > 64 * 1024) throw new Error('invalid fork transfer boundary');
    if (this.#entries.has(operation_id) || this.#entries.size >= 2) throw new Error('fork transfer capacity');
    if (this.otherBytes() + this.encodedBytes + size > 256 * 1024 * 1024) throw new Error('generation mirror capacity');
    const controller = new AbortController();
    const timer = setTimeout(() => this.release(operation_id), 35_000); timer.unref();
    this.#entries.set(operation_id, { ...structuredClone(args), events: [], bytes: size, eventBytes:0, controller, timer, result: null, running: false });
  }
  append({ operation_id, offset, events }) {
    const entry = this.#get(operation_id);
    if (entry.running || entry.result || offset !== entry.events.length || !Array.isArray(events) || !events.length
      || events.length > 4096 || events.length > entry.count - offset) throw new Error('invalid fork input page');
    const size = bytes(events);
    if (size > 64 * 1024 * 1024 || entry.eventBytes + size > 64 * 1024 * 1024
      || this.otherBytes() + this.encodedBytes + size > 256 * 1024 * 1024) throw new Error('fork input capacity');
    entry.events.push(...events); entry.bytes += size; entry.eventBytes += size;
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
        factObserver(session, canonical.mapping, readFact, this.llm), cancellation);
      cancellation.throwIfAborted();
      canonical.events = session.snapshotEvents();
      const result = forkSnapshot(canonical, { header: { version: 4, id: `fork-${operation_id}`.slice(0, 256), createdAt: entry.created_at },
        afterFact: entry.after_seq, throughFact: entry.through_seq, includeInherited: entry.include_inherited }, this.ctx.sessionProjections, this.surface);
      const checkpoint = { seed: result.seed, lineage: result.lineage, mapping: result.mapping, pendingIntent: result.pendingIntent,
        views: result.views };
      const {bytes:eventBytes,pageCapacity} = eventPageSizes(result.events);
      const checkpointBytes = bytes(checkpoint);
      const size = eventBytes + checkpointBytes + pageCapacity;
      if (checkpointBytes > 64 * 1024 || eventBytes > 64 * 1024 * 1024
        || this.otherBytes() + this.encodedBytes - entry.bytes + size > 256 * 1024 * 1024) throw new Error('fork result capacity');
      entry.events = []; entry.checkpoint = null; entry.bytes = size; entry.result = { events: result.events, checkpoint };
      return { count: result.events.length, checkpoint };
    } catch (error) { this.release(operation_id); throw error; }
  }
  read({ operation_id, offset, body_offset }) {
    const entry = this.#get(operation_id), { result } = entry;
    if (!result || !integer(offset) || offset >= result.events.length) throw new Error('invalid fork result cursor');
    if(entry.page?.offset!==offset) {
      if(body_offset!==undefined)throw Error('fork page retired');
      entry.page=null;
      entry.page={offset,part:eventPage(result.events,offset,operation_id)};
    }
    if(body_offset!==undefined)return readPart(entry.page.part,body_offset);
    return {offset,events:entry.page.part.body,next_offset:offset+entry.page.part.count};
  }
  release(id) {
    const entry = this.#entries.get(id); if (!entry) return;
    entry.controller.abort(); clearTimeout(entry.timer); this.#entries.delete(id);
  }
  close() { for (const id of this.#entries.keys()) this.release(id); }
}
