import {workerData} from 'node:worker_threads';
import {importRelease} from '../../../rsi-dsh-cordis/src/release/import.mjs';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {readWorkerLaunch} from './entry.mjs';

const {generation,roots,layout}=await readWorkerLaunch();
const npmRoot=roots.get('--npm');
roots.delete('--npm');
let importing,closed=false;
function close() {
  closed=true;
  return importing?.catch(()=>{});
}
new Peer({port:workerData,generation,onClose:close,handler:async(method,args,signal)=>{
  if(method==='extension.close'){await close();return null;}
  if(method!=='package.import'||!npmRoot||importing||closed)throw Error('Package import unavailable');
  importing=importRelease(layout,npmRoot,args,signal,roots);
  return importing;
}});
