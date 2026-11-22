import {MessageChannel,Worker} from 'node:worker_threads';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';

export const drainsOnCancel = method => method === 'application.stage';

// The worker owns the Cordis tree, including its sockets. Synchronous module
// loads and bundle compilation must not block the process protocol's pumps.
export function serveApplication(input,output,generation,arguments_,entry) {
  let worker,backend,closing;
  const close=()=>closing??=Promise.resolve().then(async()=>{
    backend?.close(new Error('Application carrier closed'));
    await worker?.terminate();
  });
  const carrier=new Peer({input,output,generation,drainOnCancel:drainsOnCancel,handler:async(method,payload,signal)=>{
    if(method==='extension.hello' && payload?.protocol===2) return {protocol:2};
    if(method==='extension.ping') return null;
    if(method==='extension.close') {
      if(backend) await backend.request(method,payload,{signal});
      await close();
      return null;
    }
    if(closing)throw new Error('Application carrier closed');
    if(!worker) {
      if(!['package.import','application.open'].includes(method))throw new Error('Application has not opened');
      const {port1,port2}=new MessageChannel();
      worker=new Worker(entry,{argv:arguments_,stdout:true,stderr:true,workerData:port2,transferList:[port2]});
      worker.stdout.pipe(process.stderr,{end:false});
      worker.stderr.pipe(process.stderr,{end:false});
      backend=new Peer({port:port1,generation,
        drainOnCancel:drainsOnCancel,
        handler:(name,args,cancel)=>carrier.request(name,args,{signal:cancel}),
        onClose:error=>{if(!closing) carrier.close(error);}});
      worker.once('error',error=>carrier.close(error));
      worker.once('exit',()=>{if(!closing) carrier.close(new Error('Application worker exited'));});
    }
    return backend.request(method,payload,{signal});
  },onClose:()=>{input.destroy();return close();}});
  return carrier;
}

if(import.meta.main) {
  const args=process.argv.slice(2);
  serveApplication(process.stdin,process.stdout,args[0],args,new URL('./process.mjs',import.meta.url));
}
