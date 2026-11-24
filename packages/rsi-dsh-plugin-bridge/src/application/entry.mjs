import {MessageChannel,Worker} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {receiveGoal} from './goal-control.mjs';

export const drainsOnCancel = method => method === 'application.stage';

export async function readWorkerLaunch() {
  const [generation,layoutFile,...paths]=process.argv.slice(2);
  if(!generation||!layoutFile||paths.length%2)throw Error('Invalid package launch');
  for(const name of ['log','info','warn','debug'])console[name]=console.error;
  const roots=new Map();
  for(let i=0;i<paths.length;i+=2)roots.set(paths[i],paths[i+1]);
  return {generation,roots,layout:JSON.parse(await readFile(layoutFile,'utf8'))};
}

// The worker owns the Cordis tree, including its sockets. Synchronous module
// loads and bundle compilation must not block the process protocol's pumps.
export function serveApplication(input,output,generation,arguments_,entry) {
  let worker,backend,closing;
  const lifetime=new AbortController();
  const close=()=>closing??=Promise.resolve().then(async()=>{
    lifetime.abort();
    backend?.close(new Error('Application carrier closed'));
    await worker?.terminate();
  });
  const carrier=new Peer({input,output,generation,drainOnCancel:drainsOnCancel,handler:async(method,payload,signal)=>{
    if(method==='extension.hello' && payload?.protocol===2) return {protocol:2};
    if(method==='extension.ping') return null;
    if(method==='extension.close') {
      lifetime.abort();
      if(backend) await backend.request(method,payload,{signal});
      await close();
      return null;
    }
    if(closing)throw new Error('Application carrier closed');
    if(!worker) {
      if(!['package.import','application.open'].includes(method))throw new Error('Application has not opened');
      const {port1,port2}=new MessageChannel();
      worker=new Worker(entry,{argv:arguments_,stdout:true,stderr:true,workerData:port2,transferList:[port2]});
      if(method==='application.open')worker.on('message',message=>{
        if(message?.type==='commit-goal')void receiveGoal(carrier,message,lifetime.signal,worker).catch(error=>carrier.close(error));
      });
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
  const worker=args.at(-2)==='--npm'?'./import-worker.mjs':'./process.mjs';
  serveApplication(process.stdin,process.stdout,args[0],args,new URL(worker,import.meta.url));
}
