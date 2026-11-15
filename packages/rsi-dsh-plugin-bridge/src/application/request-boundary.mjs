import {AsyncLocalStorage} from 'node:async_hooks';
import {addAbortListener} from 'node:events';

export async function wait(promise,signal) {
  signal.throwIfAborted();
  const abort=Promise.withResolvers();
  const listener=addAbortListener(signal,()=>abort.reject(signal.reason));
  try {await Promise.race([promise,abort.promise]);}
  finally {listener[Symbol.dispose]();}
}

/** Request captures and their callbacks own the old tree until they return.
 * A mutation excludes new captures, including while it waits for old ones. */
export function requestBoundary() {
  const leases=new Set(),owner=new AsyncLocalStorage(),closed=new AbortController();
  let pending,drained;
  const mutationError=()=>owner.getStore()?.callback
    ? new Error('A view callback cannot await profile mutation; return first or use the plugin_manager Tool.') : undefined;
  return {
    mutationError,
    detach:operation=>owner.exit(operation),
    /** @param {AbortSignal} signal Capture admission cancellation.
     * @param {() => void} dispose Synchronously close the resolved Tool selection,
     * after release and all admitted callbacks return. Fiber cleanup belongs to
     * the application lifecycle, not this selection disposer. */
    async capture(signal,dispose) {
      const stop=AbortSignal.any([signal,closed.signal]);
      while(pending)await wait(pending,stop);
      stop.throwIfAborted();
      if(!leases.size)drained=Promise.withResolvers();
      const controller=new AbortController();
      let references=1,released=false;
      const done=()=>{
        if(--references)return;
        try {dispose();}
        finally {leases.delete(lease);if(!leases.size)drained.resolve();}
      };
      const lease={signal:controller.signal,
        release() {if(!released){released=true;controller.abort();done();}},
        async run(operation) {
          controller.signal.throwIfAborted();references++;
          const token={callback:true};
          try {return await owner.run(token,operation);}finally {token.callback=false;done();}
        },
      };
      leases.add(lease);
      return lease;
    },
    run(operation,signal) {
      if(signal?.aborted)return Promise.reject(signal.reason);
      const error=mutationError();if(error)return Promise.reject(error);
      if(owner.getStore()?.active)return operation();
      if(closed.signal.aborted)return Promise.reject(closed.signal.reason);
      const stop=signal?AbortSignal.any([signal,closed.signal]):closed.signal;
      const previous=pending??Promise.resolve();
      const result=(async()=>{
        await wait(previous,stop);
        if(leases.size)await wait(drained.promise,stop);
        stop.throwIfAborted();
        const token={active:true};
        try {return await owner.run(token,operation);}finally {token.active=false;}
      })();
      // A cancelled admission settles immediately, but cannot erase its predecessor
      // from the queue and let later captures or mutations overtake running work.
      const settled=Promise.all([previous,result.catch(()=>{})]).finally(()=>{if(pending===settled)pending=undefined;});
      pending=settled;
      return result;
    },
    async close() {
      closed.abort();
      const failures=[];
      for(const lease of leases)try{lease.release();}catch(error){failures.push(error);}
      if(leases.size)await drained.promise;
      await pending;
      if(failures.length)throw new AggregateError(failures,'Request selection disposal failed');
    },
  };
}
