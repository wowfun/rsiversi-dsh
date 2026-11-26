import {randomUUID} from 'node:crypto';

/** The Kernel owns idle admission, paid dispatch, installation and idempotence. */
export function workbenchCompaction(Basic, ManualCompactionError, scope, refresh) {
  return class extends Basic {
    static inject = ['sessionProjections'];
    constructor(ctx,config) {
      super(ctx,{...config,auto:false});
    }
    async compactNow(agent,signal,sourceCommandId) {
      signal?.throwIfAborted();
      const id=sourceCommandId??randomUUID();
      const outcome=await scope.command(agent.id,{type:'compact',request_id:id},signal);
      if(outcome==='no_change')return null;
      if(outcome!=='compacted'){
        const code={busy:'busy',started:'busy',interrupted:'cancelled',failed:'summary'}[outcome];
        if(!code)throw Error('Unrecognized native compaction outcome');
        throw new ManualCompactionError(code,'Native compaction returned '+outcome);
      }
      await refresh(agent.id,signal);
      const {session}=agent;
      let summary, end;
      for(let seq=session.seq-1;seq>=0;seq--){
        const event=session.eventAt(seq);
        if(event.data?.sourceCommandId!==id)continue;
        if(event.type==='compaction/end')end=event;
        else if(event.type==='compaction/summary')summary=event;
        else if(event.type==='compaction/start'&&summary&&end
            &&event.data.compactionId===summary.data.compactionId&&event.data.compactionId===end.data.compactionId) {
          const {compactionId,shadowedRange,shadowedSeqs,shadowedTokenCount}=summary.data;
          return {compactionId,sourceCommandId:id,startSeq:seq,endSeq:end.seq,summarySeq:summary.seq,
            summary:summary.data.summary,shadowedRange,shadowedSeqs,shadowedTokenCount};
        }
      }
      throw new ManualCompactionError('commit','Installed native summary is missing from the Session');
    }
  };
}
