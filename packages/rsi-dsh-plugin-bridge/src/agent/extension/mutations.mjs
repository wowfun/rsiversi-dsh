import {randomBytes} from 'node:crypto';
import {encodedPart,eventPage,eventPageSizes,readPart,TOOL_RESULT_BYTES} from './settlement.mjs';

export function stagedMutations({records, get, restore, intents, ctx, lifetime, reserveOutput}) {
  const operations = new Set();
  function reserveToolOutput(record,operation) {
    const events=record.session.snapshotEvents(operation.start);
    if(events.length>4096)throw Error('settlement event capacity');
    const bytes=Math.max(TOOL_RESULT_BYTES,eventPageSizes(events).pageCapacity);
    operation.output.resize(bytes);operation.toolOutput=true;
  }
  async function runStage(id, operationId, invoke, signal) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256) throw new Error('invalid operation identity');
    const record = get(id); let release = await record.lane.acquire();
    if (record.parked) {
      // Another callback must never inherit an unanswered Tool's observations.
      try { if (record.parked.session === record.session) restore(record); }
      catch (error) { release(); throw error; }
      record.parked = undefined;
    }
    const operation = { id: operationId, session: record.session, start: record.session.seq, inputs: [], signal, release, output:reserveOutput() };
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
      const decision=result?.decision?JSON.stringify(result.decision):undefined;
      const decisionLength=decision?Buffer.byteLength(decision):0;
      if(decisionLength>32*1024*1024+64)throw Error('Step decision capacity');
      if(payload.suffix.length>4096||Buffer.byteLength(JSON.stringify(payload.checkpoint))>64*1024)throw Error('settlement metadata capacity');
      const token = randomBytes(32).toString('hex');
      const {pageCapacity}=eventPageSizes(payload.suffix);
      const outputBytes=Math.max(pageCapacity,operation.toolOutput?TOOL_RESULT_BYTES:0)
        +(decisionLength>256*1024?decisionLength:0);
      operation.output.resize(outputBytes);
      const decisionBytes=decisionLength>256*1024?Buffer.from(decision):undefined;
      if(decisionBytes)payload.result={...result,decision:{bytes:decisionLength}};
      record.staged = { operationId, token, output:operation.output, pageCapacity, decisionBytes, events:payload.suffix,
        pendingIntent: selected, mapping: structuredClone(payload.checkpoint.mapping), views: structuredClone(payload.checkpoint.views) };
      return { payload, token };
    } catch (error) {
      if (record.active === operation) { restore(record); record.settled = true; }
      throw error;
    } finally {
      if(record.staged?.output!==operation.output)operation.output.release();
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
    retainToolResult(id,operationId,token,result) {
      const staged=get(id).staged;
      if(staged?.operationId!==operationId||staged.token!==token)throw Error('operation identity mismatch');
      const data=encodedPart(result,TOOL_RESULT_BYTES,token);
      staged.output.resize(Math.max(staged.pageCapacity,data.size)+(staged.decisionBytes?.length??0));
      staged.result={value:result,body:data.body};
      staged.cache={part:'result',offset:0,data};
      return data.body;
    },
    readOperationBody({session_id,operation_id,token,part,offset=0,body_offset}) {
      const staged=get(session_id).staged;
      if(staged?.operationId!==operation_id||staged.token!==token)throw Error('operation identity mismatch');
      if(part==='result') {
        if(offset!==0||!staged.result)throw Error('operation result unavailable');
        if(staged.cache?.part!=='result') {
          staged.cache=null;
          staged.cache={part,offset,data:encodedPart(staged.result.value,TOOL_RESULT_BYTES,token)};
        }
        return readPart(staged.cache.data,body_offset);
      }
      if(part!=='events')throw Error('unknown operation body');
      if(staged.cache?.part!=='events'||staged.cache.offset!==offset) {
        staged.cache=null;
        staged.cache={part,offset,data:eventPage(staged.events,offset,token)};
      }
      return readPart(staged.cache.data,body_offset);
    },
    async abandon(id, operationId) {
      if (!records.has(id) && !lifetime.aborted) return;
      const record = get(id), release = await record.lane.acquire();
      try {
        if (record.executing.has(operationId)) throw new Error('operation is still executing');
        if (['committed', 'draft_committed'].includes(record.receipts.get(operationId)?.outcome)) throw new Error('cannot abandon an acknowledged mutation');
        if (record.staged) {
          if (record.staged.operationId !== operationId) throw new Error('abandon identity mismatch');
          restore(record); record.staged.output.release(); record.staged = null; record.settled = true;
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
        staged.output.release(); record.staged = null; record.settled = true;
        record.receipts.set(operationId, { token, outcome, revision });
        if (record.receipts.size > 64) record.receipts.delete(record.receipts.keys().next().value);
      } finally { release(); }
    },
  };
  return {stage, reserveToolOutput, receipts, drain: () => Promise.allSettled(operations)};
}
