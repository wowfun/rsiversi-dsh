/** Ordered native writes share a failure boundary and settle before publication. */
export function nativePublication(signal) {
  let tail=Promise.resolve(),failure,sealed=false;
  function fail(reason){failure??={reason};}
  return {
    get accepting(){return !sealed;},
    stage(operation) {
      if(sealed)throw Error('Native publication already ended');
      const settled=tail.then(async()=>{
        if(failure)throw failure.reason;
        signal.throwIfAborted();
        await operation(signal);
      });
      tail=settled.catch(fail);
      return settled;
    },
    fail,
    async finish(){let last;do{await (last=tail);}while(last!==tail);sealed=true;if(failure)throw failure.reason;},
  };
}
