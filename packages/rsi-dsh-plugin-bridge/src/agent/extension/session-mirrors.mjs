import {SessionFacade, validateHeader} from '../../session/session.mjs';
import {forkSnapshot, validateLineage, validateSeed} from '../../session/fork.mjs';
import {ForkTransfers} from '../../session/fork-transfer.mjs';
import {restoreMapping} from '../../history/history.mjs';

class Lane {
  #tail = Promise.resolve();
  pending = 0;
  async acquire() {
    this.pending++;
    const previous = this.#tail;
    let release; this.#tail = new Promise(resolve => { release = resolve; });
    await previous; let held = true;
    return () => { if (held) { held = false; this.pending--; release(); } };
  }
}

export function sessionMirrors({ctx, api, llm, surface, request, records, intents, signal}) {
  const loading = new Map();
  function residentBytes(exceptId) {
    let bytes=0;
    for(const [id,record] of records)if(id!==exceptId)bytes+=record.session.encodedBytes;
    for(const [id,entry] of loading)if(id!==exceptId)bytes+=entry.bytes;
    return bytes;
  }
  const forks = new ForkTransfers(ctx, api, llm, surface, request, residentBytes);

  function makeRoom(id, bytes = 0) {
    function fits() {
      let sessions = records.size;
      for (const key of loading.keys()) if (!records.has(key)) sessions++;
      if (!records.has(id) && !loading.has(id)) sessions++;
      return sessions <= 256 && forks.encodedBytes + residentBytes(id) + bytes <= 256 * 1024 * 1024;
    }
    if (fits()) return;
    for (const [key, item] of records) {
      if (key === id || loading.has(key) || !item.settled || item.staged || item.active || item.executing.size || item.lane.pending) continue;
      records.delete(key); item.session.retire();
      if (fits()) return;
    }
    throw new Error('Session or generation mirror capacity');
  }
  function committedSnapshot(record) {
    return { ...record.canonical, events: record.session.snapshotEvents(0, record.committedCount) };
  }
  function restore(record, { events, ...canonical } = committedSnapshot(record)) {
    const mapping = restoreMapping(canonical.mapping);
    const metadata = structuredClone(canonical);
    const lineage = validateLineage(canonical.lineage, events.length);
    if ((canonical.inheritedEventCount ?? 0) !== (lineage?.inheritedEventCount ?? 0)) throw new Error('fork inherited count mismatch');
    let mirrored = forks.encodedBytes;
    for (const item of records.values()) if (item !== record) mirrored += item.session.encodedBytes;
    if (mirrored + Buffer.byteLength(JSON.stringify(events)) > 256 * 1024 * 1024) throw new Error('generation mirror capacity');
    const replacement = new SessionFacade(ctx, api, { ...canonical, events }, false);
    validateSeed(canonical.seed, lineage, ctx.sessionProjections, canonical.header);
    if (canonical.seed) {
      ctx.sessionProjections.hydrate(replacement, canonical.seed, replacement.snapshotEvents(), 0);
    }
    intents.restore(replacement, canonical.pendingIntent ?? null);
    let views;
    try {
      replacement.attach();
      views = ctx.sessionProjections.snapshot(replacement);
    } catch (error) {
      replacement.retire();
      throw error;
    }
    record.session?.retire();
    record.session = replacement;
    record.canonical = metadata;
    record.committedCount = replacement.seq;
    record.mapping = mapping;
    record.epoch++;
    record.agent=undefined;
    record.views = views;
  }
  function get(id) { const record = records.get(id); if (signal.aborted || !record) throw new Error('Session unavailable'); return record; }
  const protocol = {
    forks,
    beginAgentLoad({ session_id, created_at, local_cwd, revision, count }) {
      if (signal.aborted || !Number.isSafeInteger(revision) || revision < 0 || !Number.isSafeInteger(count) || count < 0 || count > 100_000) throw new Error('invalid load boundary');
      validateHeader({ version: 4, id: session_id, createdAt: created_at, isSeeded: false,
        ...(local_cwd==null?{}:{cwd:local_cwd}) });
      const record = records.get(session_id);
      if (record?.staged || record?.active) throw new Error('pending transaction');
      if (revision > 0 && record?.canonical.revision === revision && record.committedCount === count
        && record.canonical.header.createdAt === created_at && record.canonical.header.cwd === (local_cwd ?? undefined)
        && !record.executing.size && !record.parked && !loading.has(session_id)) {
        record.settled = false;
        return 'current';
      }
      makeRoom(session_id);
      if (record) record.settled = false;
      loading.set(session_id, { session_id, created_at, local_cwd, revision, count, events: [], bytes: 0 });
      return 'transfer';
    },
    appendAgentLoad({ session_id, offset, events }) {
      const load = loading.get(session_id);
      if (!load || offset !== load.events.length || !Array.isArray(events) || !events.length || events.length > 4096
          || events.length > load.count - offset) throw new Error('invalid load page');
      const bytes = Buffer.byteLength(JSON.stringify(events));
      const mirrored = forks.encodedBytes + residentBytes();
      if (bytes > 256 * 1024 || load.bytes + bytes > 64 * 1024 * 1024 || mirrored + bytes > 256 * 1024 * 1024) throw new Error('load page capacity');
      load.events.push(...structuredClone(events)); load.bytes += bytes;
    },
    abortAgentLoad({ session_id }) {
      loading.delete(session_id);
      const record = records.get(session_id);
      if (record && !record.active && !record.staged && !record.executing.size) record.settled = true;
    },
    async finishAgentLoad({ session_id, checkpoint }) {
      const load = loading.get(session_id);
      if (!load || load.events.length !== load.count) throw new Error('incomplete load');
      const bytes = Buffer.byteLength(JSON.stringify(checkpoint));
      if (bytes > 64 * 1024 || load.bytes + bytes > 64 * 1024 * 1024) throw new Error('checkpoint capacity');
      const mirrored = forks.encodedBytes + residentBytes();
      if (mirrored + bytes > 256 * 1024 * 1024) throw new Error('generation mirror capacity');
      loading.delete(session_id);
      await this.loadAgent({...load, checkpoint});
    },
    async loadAgent({ session_id, created_at, local_cwd, revision, events, checkpoint }) {
      const lineage = validateLineage(checkpoint?.lineage, events.length);
      await this.load({ header: { version: 4, id: session_id, createdAt: created_at, isSeeded: lineage !== null,
        ...(local_cwd==null?{}:{cwd:local_cwd}),
        ...(lineage ? { parentSession: lineage.parentSession } : {}) },
        revision, events, seed: checkpoint?.seed ?? undefined, lineage, inheritedEventCount: lineage?.inheritedEventCount ?? 0,
        pendingIntent: checkpoint?.pendingIntent ?? null, mapping: checkpoint?.mapping });
    },
    async load(canonical) {
      if (signal.aborted || !Number.isSafeInteger(canonical.revision) || canonical.revision < 0) throw new Error('invalid canonical revision');
      const id = canonical.header.id;
      let record = records.get(id);
      if (!record) {
        makeRoom(id, Buffer.byteLength(JSON.stringify(canonical.events)));
        record = { settled: false, lane: new Lane(), epoch: 0, staged: null, active: null, receipts: new Map(), executing: new Set() };
        restore(record, canonical); records.set(id, record);
      } else {
        const release = await record.lane.acquire();
        try { if (record.staged || record.active) throw new Error('pending transaction'); restore(record, canonical); record.settled = false; } finally { release(); }
      }
    },
    project(id) { return structuredClone(get(id).views); },
    canonical(id) { return structuredClone(committedSnapshot(get(id))); },
    fork(id, options) { return forkSnapshot(committedSnapshot(get(id)), options, ctx.sessionProjections, surface); },
    checkpoint(id) {
      const record = get(id);
      if (record.staged || record.active) throw new Error('checkpoint requires canonical state');
      return ctx.sessionProjections.checkpoint(record.session);
    },
    async flush(id, cursor) {
      const record = get(id);
      if (!Number.isSafeInteger(cursor) || cursor < -1 || cursor >= record.committedCount) throw new Error('flush cannot acknowledge a tentative suffix');
      return { revision: record.canonical.revision, throughSeq: cursor };
    },
  };

  return {
    protocol, get, restore,
    retire() {
      forks.close();
      for (const record of records.values()) record.session.retire();
    },
    clear() {
      records.clear();
      loading.clear();
    },
  };
}
