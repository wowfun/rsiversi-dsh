import {isDeepStrictEqual} from 'node:util';

/** Match pending work and replay to one native publication boundary. */
export async function captureAgentView(scope,history,id,signal) {
  for(;;){
    signal?.throwIfAborted();
    const inbox=await scope.inbox.capture(id,signal),meta=await history.metadata(id,signal);
    if(!meta)throw Error('Agent Session is no longer available');
    if(inbox.kind==='draft') {
      if(meta.selection_cursor.kind!=='draft'||meta.selection_cursor.revision!==inbox.revision)continue;
    } else {
      if(meta.selection_cursor.kind!=='durable')throw Error('Published Session reverted to draft');
      meta.through=inbox.cursor.fact_seq;
      meta.selection_cursor={kind:'durable',...inbox.cursor};
    }
    const {session,options,sourceCursor}=await history.captureAgent(id,meta,signal);
    if(sourceCursor&&!isDeepStrictEqual(sourceCursor,meta.selection_cursor))continue;
    const owner=history.owner?.(session);
    if(owner) {
      owner.input.reconcileClears(inbox);
      if(inbox.kind==='draft')owner.input.observeDraft(inbox);
      await owner.flush();
    }
    return {session,inbox,options};
  }
}
