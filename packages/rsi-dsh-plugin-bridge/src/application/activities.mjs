import {nativePublication} from './native-publication.mjs';

/** Cordis-owned activity retains the native application caller, never a browser request. */
export function applicationActivities(scope,owner) {
  const lifetime=new AbortController(),pending=new Set();let closing;
  function activitySignal(signal) {
    lifetime.signal.throwIfAborted();
    if(typeof owner!=='string'||!owner)throw Error('Application owner callback unavailable');
    const stop=signal?AbortSignal.any([lifetime.signal,signal]):lifetime.signal;
    stop.throwIfAborted();
    return stop;
  }
  function enter(operation,signal,publishing) {
    const stop=activitySignal(signal);
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
  // The DSH carrier owns cancellation and closes the iterator before the application retires.
  // Bind each pull to one native read context, including the release of a partially consumed history.
  async function* observeStream(open,signal) {
    const active={request:owner,signal:activitySignal(signal)};
    const source=scope.run(active,()=>open(active.signal)[Symbol.asyncIterator]());
    try{
      for(;;){
        const step=await scope.run(active,()=>source.next());
        if(step.done)return;
        yield step.value;
      }
    }finally{
      try{await scope.run(active,()=>source.return?.());}finally{active.released=true;}
    }
  }
  return {signal:lifetime.signal,run:(operation,signal)=>enter(operation,signal,true),observeStream,
    observe:(operation,signal)=>enter(operation,signal,false),close(){
    return closing??=(async()=>{
      lifetime.abort(Error('Application activities retired'));
      await Promise.allSettled([...pending]);
    })();
  }};
}
