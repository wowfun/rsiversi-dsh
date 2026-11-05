import {createHash} from 'node:crypto';

export function stagedMutations({records, get, restore, intents, ctx, lifetime}) {
  const operations = new Set();
  async function runStage(id, operationId, invoke, signal) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256) throw new Error('invalid operation identity');
    const record = get(id); let release = await record.lane.acquire();
    if (record.parked) {
      // Another callback must never inherit an unanswered Tool's observations.
      try { if (record.parked.session === record.session) restore(record); }
      catch (error) { release(); throw error; }
      record.parked = undefined;
    }
    const operation = { id: operationId, session: record.session, start: record.session.seq, inputs: [], signal, release };
    try {
      if (record.staged) throw new Error('canonical receipt required before another mutation');
      signal.throwIfAborted();
      record.active = operation; operation.session.begin();
      const result = await invoke(record, operation);
      if (operation.invalidated) throw operation.invalidated;
      signal.throwIfAborted();
      const selected = intents.capture(record.session, operationId);
      const previous = record.canonical.pendingIntent;
      if (selected && previous && selected.active === previous.active && selected.narrate === previous.narrate) selected.causeIdentity = previous.causeIdentity;
      const payload = { operationId, expectedRevision: record.canonical.revision,
        suffix: record.session.snapshotEvents(operation.start), pendingIntent: selected, inputs: operation.inputs, result,
        checkpoint: { pendingIntent: selected, seed: record.canonical.seed ?? null, lineage: record.canonical.lineage ?? null,
          views: ctx.sessionProjections.snapshot(record.session), mapping: structuredClone(record.mapping) } };
      const encoded = JSON.stringify(payload);
      let decisionBytes;
      if (Buffer.byteLength(encoded) > 256 * 1024) {
        if (!result?.decision) throw new Error('settlement payload capacity');
        decisionBytes = Buffer.from(JSON.stringify(result.decision));
        if (decisionBytes.length > 32 * 1024 * 1024 + 64) throw new Error('Step decision capacity');
        payload.result = {...result, decision:{bytes:decisionBytes.length}};
        if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024) throw new Error('settlement payload capacity');
      }
      const token = createHash('sha256').update(encoded).digest('hex');
      const reply = structuredClone(payload);
      record.staged = { operationId, token, decisionBytes, pendingIntent: selected, mapping: payload.checkpoint.mapping, views: payload.checkpoint.views };
      return { payload: reply, token };
    } catch (error) {
      if (record.active === operation) { restore(record); record.settled = true; }
      throw error;
    } finally {
      if (record.active === operation) record.active = null;
      operation.session.end(); operation.release();
    }
  }
  function stage(id, operationId, invoke, signal) {
    const record = get(id);
    if (record.executing.has(operationId) || record.receipts.has(operationId)) return Promise.reject(new Error('operation identity was already used'));
    record.executing.add(operationId);
    const pending = runStage(id, operationId, invoke, AbortSignal.any([lifetime, ...(signal ? [signal] : [])]));
    operations.add(pending);
    const settled = () => { operations.delete(pending); record.executing.delete(operationId); };
    pending.then(settled, settled);
    return pending;
  }
  const receipts = {
    async abandon(id, operationId) {
      if (!records.has(id) && !lifetime.aborted) return;
      const record = get(id), release = await record.lane.acquire();
      try {
        if (record.executing.has(operationId)) throw new Error('operation is still executing');
        if (['committed', 'draft_committed'].includes(record.receipts.get(operationId)?.outcome)) throw new Error('cannot abandon an acknowledged mutation');
        if (record.staged) {
          if (record.staged.operationId !== operationId) throw new Error('abandon identity mismatch');
          restore(record); record.staged = null; record.settled = true;
        }
      } finally { release(); }
    },
    async receipt(id, operationId, token, outcome, revision) {
      if (!['committed', 'draft_committed', 'rejected'].includes(outcome)) throw new Error('unknown commit outcome requires canonical reconciliation');
      if (![id, operationId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
        || !/^[a-f0-9]{64}$/.test(token) || !Number.isSafeInteger(revision) || revision < 0) throw new Error('invalid receipt identity');
      if (!records.has(id) && !lifetime.aborted) return { state: 'unloaded' };
      const record = get(id), release = await record.lane.acquire();
      try {
        const staged = record.staged;
        const confirmed = record.receipts.get(operationId);
        if (!staged && confirmed && confirmed.token === token && confirmed.outcome === outcome && confirmed.revision === revision) return;
        if (!staged || staged.operationId !== operationId || staged.token !== token) throw new Error('receipt identity mismatch');
        if (outcome === 'committed' || outcome === 'draft_committed') {
          if (outcome === 'draft_committed'
            ? revision !== 0 || record.canonical.revision !== 0
            : revision <= record.canonical.revision) throw new Error('invalid receipt revision');
          record.committedCount = record.session.seq;
          record.canonical.pendingIntent = staged.pendingIntent;
          record.canonical.mapping = staged.mapping;
          record.canonical.revision = revision; record.views = staged.views; record.epoch++;
        } else restore(record);
        record.staged = null; record.settled = true;
        record.receipts.set(operationId, { token, outcome, revision });
        if (record.receipts.size > 64) record.receipts.delete(record.receipts.keys().next().value);
      } finally { release(); }
    },
  };
  return {stage, receipts, drain: () => Promise.allSettled(operations)};
}
