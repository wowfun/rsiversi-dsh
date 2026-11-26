import {randomUUID} from 'node:crypto';

// The native projection and journal use different event sequences once plugins
// append records. Only native retained messages occupy context positions.
export function retainedRegion(owner, start, end) {
  const {session, mapping} = owner.source.current;
  if (!mapping.turnId) throw Error('compactRegion requires an open Turn');
  let position = 0, first;
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq);
    const application = owner.journal.sourceAt(seq).seq;
    if (event.type === 'system/message' || event.data?.rsi?.syntheticToolResult) {
      if (application === start || application === end || first !== undefined)
        throw Error('compactRegion includes a message without a selectable native position');
      continue;
    }
    if (application === start) first = position;
    if (application === end) {
      if (first === undefined) break;
      return {turn_id:mapping.turnId, through_seq:mapping.factCursor, start:first, end:position};
    }
    position++;
  }
  throw Error('compactRegion requires ordered endpoints on the current surface');
}

function installedResult(session, matches, ManualCompactionError) {
  let summary, end;
  for (let seq = session.seq - 1; seq >= 0; seq--) {
    const event = session.eventAt(seq);
    if (!matches(event.data)) continue;
    if (event.type === 'compaction/end') end = event;
    else if (event.type === 'compaction/summary') summary = event;
    else if (event.type === 'compaction/start' && summary && end
        && event.data.compactionId === summary.data.compactionId && event.data.compactionId === end.data.compactionId) {
      const {compactionId,sourceCommandId,shadowedRange,shadowedSeqs,shadowedTokenCount} = summary.data;
      return {compactionId,...(sourceCommandId ? {sourceCommandId} : {}),startSeq:seq,endSeq:end.seq,summarySeq:summary.seq,
        summary:summary.data.summary,shadowedRange,shadowedSeqs,shadowedTokenCount};
    }
  }
  throw new ManualCompactionError('commit','Installed native summary is missing from the Session');
}

/** The Kernel owns paid dispatch and installation for both compaction entry points. */
export function workbenchCompaction(Basic, ManualCompactionError, scope, refresh, regionFor) {
  return class extends Basic {
    static inject = ['sessionProjections'];
    constructor(ctx,config) {
      super(ctx,{...config,auto:false});
    }
    async compactRegion(start,end,agent,signal) {
      signal?.throwIfAborted();
      const region=regionFor(agent,start,end);
      const effect=await scope.withCaller(stop=>scope.command(agent.id,{type:'compact_region',region},stop),signal);
      await refresh(agent.id,signal);
      return installedResult(agent.session,data=>data?.compactionId===effect,ManualCompactionError);
    }
    async compactNow(agent,signal,sourceCommandId) {
      signal?.throwIfAborted();
      const id=sourceCommandId??randomUUID();
      const outcome=await scope.withCaller(stop=>scope.command(agent.id,{type:'compact',request_id:id},stop),signal);
      if(outcome==='no_change')return null;
      if(outcome!=='compacted'){
        const code={busy:'busy',started:'busy',interrupted:'cancelled',failed:'summary'}[outcome];
        if(!code)throw Error('Unrecognized native compaction outcome');
        throw new ManualCompactionError(code,'Native compaction returned '+outcome);
      }
      await refresh(agent.id,signal);
      return installedResult(agent.session,data=>data?.sourceCommandId===id,ManualCompactionError);
    }
  };
}
