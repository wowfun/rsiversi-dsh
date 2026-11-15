import {workerData} from 'node:worker_threads';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {drainsOnCancel} from '../../src/application/entry.mjs';
const peer=new Peer({port:workerData,generation:process.argv[2],drainOnCancel:drainsOnCancel,handler:async method=>{
  if(method==='extension.close')return null;
  const stop=new AbortController();
  const staged=peer.request('application.stage',{}, {signal:stop.signal});
  await peer.request('fixture.wait',{});stop.abort();return staged;
}});
