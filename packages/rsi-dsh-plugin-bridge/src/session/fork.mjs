import { restoreMapping } from '../history/history.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const schemas = new Set(['todo/write', 'plan/mode', 'turn/start', 'turn/end', 'step/start', 'step/end',
  'request/header', 'user/message', 'developer/message', 'system/message', 'assistant/attempt', 'assistant/message',
  'tool/call', 'tool/result', 'session/end-seed', 'command/run', 'command/done', 'model/selection', 'agent/inbox/spliced']);

export function validateLineage(value, count) {
  if (value == null) return null;
  if (Object.keys(value).sort().join(',') !== 'afterFact,inheritedEventCount,parentSession,seedEventCount,throughFact,version'
      || value.version !== 1 || !identity(value.parentSession)
      || ![value.afterFact, value.throughFact, value.inheritedEventCount, value.seedEventCount].every(integer)
      || value.afterFact > value.throughFact || value.inheritedEventCount > count
      || value.seedEventCount > 2 || value.seedEventCount > value.inheritedEventCount) throw new Error('invalid fork lineage');
  return structuredClone(value);
}

export function validateSeed(seed, lineage, projections, header) {
  if (seed == null) {
    if (lineage?.seedEventCount) throw new Error('fork metadata requires a projection seed');
    return;
  }
  const expected = projections.restore({}, [], 0, header, 0).checkpoint;
  if (Object.keys(expected).length !== Object.keys(seed).length) throw new Error('incompatible fork seed keys');
  for (const [key, row] of Object.entries(expected)) {
    const supplied = seed[key];
    if (!supplied || supplied.ver !== row.ver || supplied.seq !== (lineage?.seedEventCount ?? 0) - 1) throw new Error(`missing or incompatible fork seed: ${key}`);
  }
}

/** Pure cut transformation; neither the source mirror nor plugin callbacks mutate. */
export function forkSnapshot(canonical, { header, afterFact, throughFact, includeInherited }, projections, surface) {
  if (!integer(afterFact) || !integer(throughFact) || afterFact > throughFact
      || typeof includeInherited !== 'boolean' || canonical.mapping?.factCursor !== throughFact || canonical.mapping.turnId !== null
      || canonical.mapping.model !== null || canonical.mapping.calls.length) throw new Error('fork requires a synchronized completed cut');
  if (!identity(header.id) || header.id === canonical.header.id) throw new Error('fork requires a new Session identity');
  const all = canonical.events;
  validateSeed(canonical.seed, validateLineage(canonical.lineage, all.length), projections, canonical.header);
  for (const event of all) if (!schemas.has(event.type)) throw new Error(`event lacks a fork reference schema: ${event.type}`);
  const mapping = restoreMapping(); mapping.turn = canonical.mapping.turn;
  let events, seed, seedEventCount;
  if (afterFact === 0 && includeInherited) {
    events = structuredClone(all); seed = structuredClone(canonical.seed ?? null);
    seedEventCount = canonical.lineage?.seedEventCount ?? 0;
  } else {
    const start = afterFact === throughFact ? all.length : all.findIndex(event => event.type === 'turn/start'
      && event.data.rsi?.session === canonical.header.id && event.data.rsi.fact > afterFact && event.data.rsi.fact <= throughFact);
    if (start < 0) throw new Error('fork window lacks canonical Turn provenance');
    const prefix = all.slice(0, start);
    const restored = projections.restore(canonical.seed ?? {}, prefix, 0, canonical.header, canonical.inheritedEventCount ?? 0);
    // Both released and development timeContext states contain only clocks
    // and browser-zone values. They do not store parent event references.
    const {timeContext,...core} = restored.checkpoint;
    if (Object.keys(core).sort().join(',') !== 'plan,todos,turnBoundary'
      || ![3,4].includes(restored.checkpoint.plan.ver) || restored.checkpoint.todos.ver !== 2
      || restored.checkpoint.turnBoundary.ver !== 2 || timeContext && ![2,3].includes(timeContext.ver))
      throw new Error('fork projection schema is not admitted');
    seed = structuredClone(restored.checkpoint);
    // The omitted prefix is closed. Its old step locations are not child events.
    if (seed.turnBoundary.val.openTurnStartSeq !== null) throw new Error('fork window begins inside an open Turn');
    seed.turnBoundary.val.lastStepStartSeq = null;
    seed.turnBoundary.val.lastStepBoundary = null;
    events = []; const remap = new Map();
    const push = (event, sourceSeq) => { event.seq = events.length; events.push(event); if (sourceSeq !== undefined) remap.set(sourceSeq, event.seq); };
    const headSeq = surface.foldSurface(prefix).nodes[0];
    const head = headSeq === undefined ? undefined : prefix[headSeq];
    if (head && head.type !== 'system/message') throw new Error('fork prefix lacks system head');
    if (head) {
      const copy = structuredClone(head); copy.surfaceOp = 'append'; delete copy.sourceEventSeqs;
      push(copy, head.seq);
    }
    const request = prefix.findLast(event => event.type === 'request/header');
    if (request) { const copy = structuredClone(request); copy.data.reason = 'resume'; push(copy, request.seq); }
    seedEventCount = events.length;
    for (const row of Object.values(seed)) row.seq = seedEventCount - 1;
    for (const original of all.slice(start)) {
      const event = structuredClone(original);
      if (event.surfaceOp && event.surfaceOp !== 'append') {
        const { startSeq, endSeq } = event.surfaceOp;
        if (!remap.has(startSeq) || !remap.has(endSeq)) {
          if (event.type === 'tool/result' && startSeq < start && endSeq < start) continue;
          throw new Error('fork replacement crosses excluded conversation');
        }
        event.surfaceOp.startSeq = remap.get(startSeq); event.surfaceOp.endSeq = remap.get(endSeq);
      }
      if (event.sourceEventSeqs) event.sourceEventSeqs = event.sourceEventSeqs.map(seq => {
        if (!remap.has(seq)) throw new Error('fork source reference points outside the window');
        return remap.get(seq);
      });
      if (event.type === 'developer/message' && event.data.headerSeq !== undefined) {
        if (!remap.has(event.data.headerSeq)) throw new Error('fork tool update lacks its request header');
        event.data.headerSeq = remap.get(event.data.headerSeq);
      }
      if (event.type === 'command/done' && event.data.sourceEventSeq !== undefined) {
        if (!remap.has(event.data.sourceEventSeq)) throw new Error('fork command result points outside the window');
        event.data.sourceEventSeq = remap.get(event.data.sourceEventSeq);
      }
      push(event, original.seq);
    }
  }
  surface.foldSurface(events);
  const inheritedEventCount=events.length;
  events.push({type:'session/end-seed',seq:inheritedEventCount,time:header.createdAt,data:{inherited:true}});
  const lineage = validateLineage({ version: 1, parentSession: canonical.header.id, afterFact, throughFact,
    inheritedEventCount, seedEventCount }, events.length);
  const child = { header: { ...header, isSeeded: true, parentSession: canonical.header.id }, events, seed, lineage,
      inheritedEventCount, mapping, pendingIntent: structuredClone(canonical.pendingIntent ?? null), revision: 0 };
  child.views = projections.restore(seed ?? {}, events, 0, child.header, inheritedEventCount).snapshot;
  return child;
}
