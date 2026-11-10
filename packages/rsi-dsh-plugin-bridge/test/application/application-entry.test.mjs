import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {serveApplication} from '../../src/application/entry.mjs';

for(const operation of ['application.open','package.import'])test(`blocking ${operation} keeps the carrier responsive and closes the worker`,{timeout:10000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-dsh-worker-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const module=new URL('../../../rsi-dsh-cordis/src/runtime/transport.mjs',import.meta.url).href;
  const file=join(directory,'worker.mjs');
  await writeFile(file,`import {Peer} from ${JSON.stringify(module)};
    import {workerData} from 'node:worker_threads';
    const peer=new Peer({port:workerData,generation:'worker',handler:async (method,payload)=>{
      if(method==='application.open'||method==='package.import'){
        console.log('worker stdout is diagnostic output');
        await peer.request('started',null);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3400);
        return {opened:true,value:await peer.request('echo',payload)};
      }
      if(method==='extension.close')return null;
      throw new Error(method);
    }});`);
  const input=new PassThrough(), output=new PassThrough();
  const carrier=serveApplication(input,output,'worker',['worker'],pathToFileURL(file));
  const started=Promise.withResolvers();
  const caller=new Peer({input:output,output:input,generation:'worker',
    handler:async (name,value)=>{
      if(name==='echo')return value;
      assert.equal(name,'started');started.resolve();return null;
    }});
  t.after(()=>{caller.close();carrier.close();});
  const payload={text:'界'.repeat(200_000)},opened=caller.request(operation,payload);
  await Promise.race([started.promise,opened]);
  assert.equal(await caller.request('extension.ping',null,{signal:AbortSignal.timeout(2500)}),null);
  assert.deepEqual(await opened,{opened:true,value:payload});
  assert.equal(await caller.request('extension.close',{}),null);
});
