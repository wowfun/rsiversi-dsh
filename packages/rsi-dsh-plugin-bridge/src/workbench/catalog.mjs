import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {sessionSummary} from './session-controller.mjs';

/** Native catalog reads are complete before any event can remove an earlier row. */
export function catalogObserver(ctx) {
  let previous=new Map();
  return rows=>{
    const next=new Map(rows.map(row=>[row.id,sessionSummary(ctx,row)]));
    for(const [id,row] of next) {
      const before=previous.get(id);
      if(!before||!isDeepStrictEqual(before,row))ctx.emit('api-session/added',row);
      if(before&&before.running!==row.running)ctx.emit('api-session/status',id,row.running);
      if(before&&before.updatedAt<row.updatedAt)ctx.emit('api-session/activity',id,row.updatedAt);
    }
    for(const id of previous.keys())if(!next.has(id))ctx.emit('api-session/removed',id);
    previous=next;
  };
}

export function watchWorkbenchCatalog(ctx,scope) {
  ctx.effect(()=>{
    const lifetime=new AbortController(),{signal}=lifetime,publish=catalogObserver(ctx);
    let wake,dirty=false;
    const invalidate=()=>{dirty=true;wake?.();};
    const pause=ms=>delay(ms,undefined,{signal}).catch(()=>{});
    for(const event of ['agent/created','agent/disposed','rsi/catalog-projection'])ctx.on(event,invalidate);

    // The same subscription feeds Workspace followers even if a Session page is unavailable.
    const observe=(async()=>{
      let open=true,failed=false;
      while(!signal.aborted){
        try{
          const change=await scope.observeOwned(stop=>scope.waitDirectory(open,stop),signal);
          scope.invalidateWorkspaces();
          if(change!=='workspace')invalidate();
          failed=false;
          // Workspace revisions are already sampled by the native clock.
          if(!open&&change!=='workspace')await pause(1000);
          open=false;
        }catch(error){
          if(signal.aborted)break;
          if(!failed)console.warn('Native directory observation:',String(error.message??error));
          failed=true;open=true;
          scope.invalidateWorkspaces();invalidate();
          await pause(1000);
        }
      }
    })();
    const capture=(async()=>{
      let nextRead=0,failed=false;
      while(!signal.aborted){
        if(!dirty)await new Promise(resolve=>{wake=resolve;});
        wake=undefined;
        const remaining=nextRead-performance.now();
        if(!signal.aborted&&remaining>0)await pause(remaining);
        if(signal.aborted)break;
        dirty=false;nextRead=performance.now()+1000;
        try{
          await scope.runOwned(async stop=>publish(await scope.list(stop)),signal);
          failed=false;
        }catch(error){
          if(signal.aborted)break;
          if(!failed)console.warn('Native Session catalog:',String(error.message??error));
          failed=true;dirty=true;
        }
      }
    })();
    return async()=>{lifetime.abort();invalidate();await Promise.all([observe,capture]);};
  },'native Session catalog');
}
