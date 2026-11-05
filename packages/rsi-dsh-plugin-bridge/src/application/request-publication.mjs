import {nativePublication} from './native-publication.mjs';

/** A finite reply cannot acknowledge synchronous staged writes before native receipts. */
export function requestPublication(response) {
  const native=Object.fromEntries(['writeHead','write','end','flushHeaders'].map(name=>[name,response[name]]));
  const cancellation=new AbortController();
  const publication=nativePublication(cancellation.signal);
  let sealed=false,flushing,bytes=0;
  const calls=[];
  const disconnected=()=>cancellation.abort(new Error('Application request disconnected'));
  response.once('close',disconnected);
  function capture(name,args) {
    if(sealed)throw Error('Application reply already ended');
    if(name==='write'||name==='end') {
      const chunk=args[0];
      if(typeof chunk==='string'||ArrayBuffer.isView(chunk)) {
        const value=Buffer.from(chunk,typeof args[1]==='string'?args[1]:undefined);
        bytes+=value.length;
        if(bytes>1024*1024)throw RangeError('Application publication reply exceeds 1 MiB');
        args=[value,...args.slice(1)];
      }
    }
    if(calls.length>=4096)throw RangeError('Application publication reply has too many chunks');
    calls.push([name,args]);
    if(name==='end') {sealed=true;void flush();}
    return name==='write'?true:response;
  }
  function restore() {for(const [name,method] of Object.entries(native))response[name]=method;}
  function flush() {
    return flushing??=(async()=>{
      let failure;
      try {await publication.finish();}catch(reason){failure=reason instanceof Error?reason:Error(String(reason));}
      restore();
      response.removeListener('close',disconnected);
      if(response.destroyed)return;
      if(failure) {
        for(const name of response.getHeaderNames())response.removeHeader(name);
        response.writeHead(502,{'content-type':'application/json'});
        const ended=calls.findLast(([name])=>name==='end');
        const callback=ended?.[1].findLast(value=>typeof value==='function');
        response.end(JSON.stringify({ok:false,error:{code:'publication-failed',
          message:String(failure.message??failure).slice(0,512)}}),callback);
        for(const [name,args] of calls)if(name==='write')args.findLast(value=>typeof value==='function')?.(failure);
      } else {
        for(const [name,args] of calls)native[name].apply(response,args);
      }
    })().catch(error=>{response.destroy(error);});
  }
  for(const name of Object.keys(native))response[name]=(...args)=>capture(name,args);
  return {
    get accepting(){return !sealed;},
    stage:publication.stage,
    finish() {sealed=true;return flush();},
    fail(error) {
      publication.fail(error);
      cancellation.abort(error);
      return this.finish();
    },
  };
}
