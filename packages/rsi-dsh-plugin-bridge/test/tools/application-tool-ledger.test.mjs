import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {toolLedger} from '../../src/tools/application-tool-ledger.mjs';

const input={session:'session',effect:'effect',registration:'registration',name:'tool',args:{},
  identity:{invocation_id:'effect',call_id:'call',owner_id:'owner',request_sha256:'a'.repeat(64)}};

test('pending calls are cancellable without a second durable admission record',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-admit-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const running=Promise.withResolvers(),states=[];
  const ledger=await toolLedger(directory,async(path,data,options)=>{
    states.push(JSON.parse(data).state);await writeFile(path,data,options);
  });
  const started=ledger.start(input,async signal=>{
    running.resolve();
    if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    return 'cancelled';
  });
  await running.promise;
  assert.deepEqual(await readdir(directory),[]);
  assert.deepEqual(await ledger.outcome(input),{state:'pending'});
  assert.deepEqual(await ledger.start(input,()=>assert.fail('duplicate body')),{state:'pending'});
  assert.deepEqual(await ledger.cancel(input),{accepted:true});
  assert.deepEqual(await started,{state:'settled',result:'cancelled'});
  assert.deepEqual(states,['settled']);await ledger.close();
});

test('a failed settlement write withholds the result and does not repeat the body',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-settle-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const ledger=await toolLedger(directory,async(path,data,options)=>{
    if(JSON.parse(data).state==='settled')throw Error('injected write failure');
    await writeFile(path,data,options);
  });
  let runs=0;
  const execute=()=>++runs;
  assert.deepEqual(await ledger.start(input,execute),{state:'unknown'});
  assert.deepEqual(await ledger.outcome(input),{state:'unknown'});
  assert.deepEqual(await ledger.start(input,execute),{state:'unknown'});
  assert.equal(runs,1);assert.deepEqual(await readdir(directory),[]);
  await ledger.close();
  const recovered=await toolLedger(directory,writeFile);
  assert.deepEqual(await recovered.outcome(input),{state:'unknown'});await recovered.close();
});

test('retiring a tool source during admission never enters the plugin after disposal',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-retire-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const ledger=await toolLedger(directory,writeFile);let runs=0;
  const started=ledger.start(input,()=>++runs),retiring=ledger.close();
  await retiring;assert.deepEqual(await started,{state:'unknown'});
  assert.equal(runs,0);assert.deepEqual(await readdir(directory),[]);
  const recovered=await toolLedger(directory,writeFile);
  assert.deepEqual(await recovered.outcome(input),{state:'unknown'});
  assert.equal(runs,0);await recovered.close();
});

test('a closing source drains the active result write before handing off its ledger',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-handoff-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const running=Promise.withResolvers(),writing=Promise.withResolvers(),publish=Promise.withResolvers();
  const ledger=await toolLedger(directory,async(path,data,options)=>{
    if(JSON.parse(data).state==='settled'){writing.resolve();await publish.promise;}
    await writeFile(path,data,options);
  });
  const started=ledger.start(input,async signal=>{
    running.resolve();
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    return 'stopped';
  });
  await running.promise;
  let handedOff=false;
  const retiring=ledger.close().then(()=>{handedOff=true;});
  await writing.promise;
  try {
    await assert.rejects(ledger.start(input,()=>assert.fail('source retired')),/closed/);
    assert.equal(handedOff,false);
  } finally {publish.resolve();}
  await retiring;
  const recovered=await toolLedger(directory,writeFile);
  assert.deepEqual(await recovered.outcome(input),await started);
  assert.deepEqual(await recovered.outcome(input),{state:'settled',result:'stopped'});
  await recovered.close();
});

test('the live caller gets exactly the serialized outcome when a plugin mutates its value',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-snapshot-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const value={text:'original'};
  const ledger=await toolLedger(directory,async(path,data,options)=>{
    if(JSON.parse(data).state==='settled')value.text='changed during write';
    await writeFile(path,data,options);
  });
  const live=await ledger.start(input,()=>value);
  assert.deepEqual(live,{state:'settled',result:{text:'original'}});
  assert.deepEqual(await ledger.outcome(input),live);
  await ledger.close();
});

test('unknown live outcomes remain bounded and bind their exact call identity',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-unknown-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const ledger=await toolLedger(directory,()=>assert.fail('unknown calls need no receipt write'));
  let runs=0;
  const fail=()=>{runs++;throw Error('lost result');};
  await assert.rejects(ledger.start({...input,identity:{...input.identity,owner_id:'x'.repeat(257)}},fail),/receipt identity/);
  assert.deepEqual(await ledger.start(input,fail),{state:'unknown'});
  await assert.rejects(ledger.start({...input,args:{changed:true}},fail),/another call/);
  assert.deepEqual(await ledger.start(input,fail),{state:'unknown'});assert.equal(runs,1);
  for(let index=0;index<128;index++) {
    const effect='effect-'+index;
    await ledger.start({...input,effect,identity:{...input.identity,invocation_id:effect}},fail);
  }
  // The existing bounded-retention contract also applies to memory-only bindings.
  await ledger.start(input,fail);assert.equal(runs,130);
  assert.deepEqual(await readdir(directory),[]);await ledger.close();
});
