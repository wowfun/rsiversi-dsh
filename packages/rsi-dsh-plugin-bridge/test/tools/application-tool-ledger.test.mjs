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

test('publication returns the owned materialized result without retaining a decoded copy',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-snapshot-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const value=Object.freeze({text:'界'.repeat(500_000)});
  const ledger=await toolLedger(directory,writeFile);
  const live=await ledger.start(input,()=>value);
  assert.equal(live.state,'settled');assert.ok(live.result===value,'reuse the admitted immutable result');
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

test('canonical publication retires only the matching receipt and keeps the live invocation fenced',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-published-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const ledger=await toolLedger(directory,writeFile);t.after(()=>ledger.close());
  const settled=await ledger.start(input,()=>({text:'canonical body'}));
  for(const [session,effect,identity] of [
    ['other',input.effect,input.identity],
    [input.session,'other',input.identity],
    ...Object.keys(input.identity).map(key=>[input.session,input.effect,{...input.identity,[key]:'other'}]),
  ])await ledger.retire(session,effect,identity);
  assert.deepEqual(await ledger.outcome(input),settled);
  assert.equal((await readdir(directory)).length,1);
  await ledger.retire(input.session,input.effect,input.identity);
  assert.deepEqual(await readdir(directory),[]);
  assert.deepEqual(await ledger.outcome(input),{state:'unknown'});
  assert.deepEqual(await ledger.start(input,()=>assert.fail('published body repeated')),{state:'unknown'});
  await assert.rejects(ledger.start({...input,args:{changed:true}},()=>assert.fail('rebound body')),/another call/);
  await ledger.retire(input.session,input.effect,input.identity);
});

test('cold native observation can retire a settled receipt without retaining its result',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-ledger-cold-published-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const first=await toolLedger(directory,writeFile);
  const expected=await first.start(input,()=>({text:'recover before publication'}));
  await first.close();
  const cold=await toolLedger(directory,writeFile);t.after(()=>cold.close());
  assert.deepEqual(await cold.outcome(input),expected);
  await cold.retire(input.session,input.effect,input.identity);
  assert.deepEqual(await readdir(directory),[]);
  assert.deepEqual(await cold.start(input,()=>assert.fail('cold published body repeated')),{state:'unknown'});
});
