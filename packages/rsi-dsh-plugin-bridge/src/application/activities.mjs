import {nativePublication} from './native-publication.mjs';

/** Cordis-owned activity retains the native application caller, never a browser request. */
export function applicationActivities(scope,owner) {
  const lifetime=new AbortController(),pending=new Set();let closing;
  function enter(operation,signal,publishing) {
    lifetime.signal.throwIfAborted();
    if(typeof owner!=='string'||!owner)throw Error('Application owner callback unavailable');
    const stop=signal?AbortSignal.any([lifetime.signal,signal]):lifetime.signal;
    stop.throwIfAborted();
    const publication=publishing?nativePublication(stop):undefined,active={request:owner,signal:stop,publication};
    const task=scope.run(active,async()=>{
      try {
        let result;
        if(publication) {
          try {result=await operation(stop);}catch(error){publication.fail(error);}
          await publication.finish();
        }else result=await operation(stop);
        stop.throwIfAborted();
        return result;
      } finally {active.released=true;}
    });
    pending.add(task);
    void task.then(()=>pending.delete(task),()=>pending.delete(task));
    return task;
  }
  return {run:(operation,signal)=>enter(operation,signal,true),
    observe:(operation,signal)=>enter(operation,signal,false),close(){
    return closing??=(async()=>{
      lifetime.abort(Error('Application activities retired'));
      await Promise.allSettled([...pending]);
    })();
  }};
}
