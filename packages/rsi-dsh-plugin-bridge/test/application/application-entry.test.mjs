import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {Peer} from '../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {serveApplication} from '../../src/application/entry.mjs';

test('the existing carrier returns a native Goal receipt or rejection before the plugin continues',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-goal-carrier-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const transport=new URL('../../../rsi-dsh-cordis/src/runtime/transport.mjs',import.meta.url).href;
  const goal=new URL('../../src/application/session-control.mjs',import.meta.url).href;
  const file=join(directory,'worker.mjs');
  await writeFile(file,`import {Peer} from ${JSON.stringify(transport)};
    import {commitControl} from ${JSON.stringify(goal)};
    import {workerData} from 'node:worker_threads';
    new Peer({port:workerData,generation:'goal-test',handler:(method,control)=>
      method==='application.open'?commitControl('request','one',control):null});`);
  const input=new PassThrough(),output=new PassThrough(),received=[],waiting=Promise.withResolvers();
  const carrier=serveApplication(input,output,'goal-test',[],pathToFileURL(file));
  const host=new Peer({input:output,output:input,generation:'goal-test',handler:async(method,args,signal)=>{
    assert.equal(method,'application.command');
    assert.equal(args.request,'request');assert.equal(args.session_id,'one');
    const op=args.operation;received.push(op);
    if(op.type==='prepare')return {kind:'durable',control_seq:7};
    if(op.type==='disarm_goal')return null;
    if(op.type==='begin_maintenance')return true;
    if(op.type==='goal'&&op.control.request_id==='pending'){
      waiting.resolve();
      await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
      throw Error('native control cancelled');
    }
    if(op.type==='execute')throw Error('lost reply after commit');
    if(op.type==='status')return ['create','select'].includes(op.request_id)?{request_id:op.request_id}:null;
    throw Error('stale goal revision');
  }});
  t.after(()=>{host.close();carrier.close();});
  const create={request_id:'create',expected_revision:{kind:'draft',revision:4},
    action:{action:'create',id:'goal'},published_at_ms:10};
  const first=await host.request('application.open',create);
  assert.deepEqual(first.control.expected_revision,{kind:'durable',control_seq:7});
  assert.equal(first.receipt.request_id,'create');
  assert.deepEqual(received[0],{type:'prepare',expected_draft_revision:4});
  assert.equal(received[1].invocation.arguments.published_at_ms,10);
  await assert.rejects(host.request('application.open',{...create,request_id:'end',expected_revision:first.control.expected_revision,
    action:{action:'complete',id:'goal'}}),/stale goal revision/);
  assert.deepEqual(received.map(op=>op.type),['prepare','execute','status','goal','status']);
  const permission={type:'execute',command:'rsi.permission.select',request_id:'select',
    arguments:{preset:'read-only',sandbox:'read-only',approval:'ask'},expected_revision:first.control.expected_revision};
  const {receipt}=await host.request('application.open',permission);
  assert.equal(receipt.request_id,'select');
  const {type,...expectedInvocation}=permission;
  assert.deepEqual(received.slice(-2),[{type:'execute',invocation:expectedInvocation},{type:'status',request_id:'select'}]);
  await assert.rejects(host.request('application.open',{...permission,request_id:'denied'}),/lost reply after commit/);
  assert.deepEqual(received.slice(-2).map(op=>op.type),['execute','status']);
  const before=received.length;
  assert.equal(await host.request('application.open',{type:'disarm_goal'}),null);
  assert.deepEqual(received.slice(before),[{type:'disarm_goal'}]);
  const maintenance={type:'begin_maintenance',key:'callback-one'};
  assert.equal(await host.request('application.open',maintenance),true);
  assert.deepEqual(received.slice(before+1),[maintenance]);
  assert.equal(await host.request('extension.ping',null),null);
  const pending=host.request('application.open',{...create,request_id:'pending',expected_revision:first.control.expected_revision,
    action:{action:'complete',id:'goal'}});
  const rejected=assert.rejects(pending);
  await waiting.promise;
  try {assert.equal(await host.request('extension.close',{}, {signal:AbortSignal.timeout(1800)}),null);}
  finally {host.close();await rejected;}
});

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
