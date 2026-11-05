import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workbenchPersistence} from '../../src/workbench/persistence.mjs';
import {workbenchHistory} from '../../src/workbench/history.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('a delayed capture does not hold other Sessions; point reads stay at the opening cut without copying the log',async()=>{
  const gate=Promise.withResolvers(),entered=Promise.withResolvers(),order=[];
  const events=Array.from({length:4096},(_,seq)=>({type:'retained',seq}));
  let slices=0;
  const history={
    async metadata(id){
      order.push(id);
      if(id==='slow'){entered.resolve();await gate.promise;}
      return {id,created_at:1,selection_cursor:{kind:'durable',fact_seq:1,control_seq:1}};
    },
    async capture(id){return {id,header:{id},seq:events.length,inheritedEventCount:0,encodedBytes:256,
      requestHeader:()=>undefined,eventAt:seq=>events[seq],snapshotEvents:(a,b)=>{slices++;return events.slice(a,b);}};},
  };
  const service=workbenchPersistence(history,{}),slow=service.capture('slow');
  await entered.promise;
  const same=service.capture('slow'),other=service.capture('fast');
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(order,['slow','fast']);
  } finally {gate.resolve();await Promise.all([slow,same,other]);}
  const view=await other;events.push({type:'retained',seq:4096},{type:'later',seq:4097});
  assert.equal(view.lastEvent('retained'),events[4095]);assert.equal(view.lastEvent('later'),undefined);
  assert.equal(view.eventAt(4),events[4]);assert.throws(()=>view.eventAt(4096),RangeError);
  assert.equal(slices,0);
});

test('native read handles refresh control-only history, bind opening authority, and release independently',{skip:!root},async()=>{
  const require=createRequire(join(root,'package.json'));
  const errors=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')));
  const scope=new AsyncLocalStorage(),header=Object.freeze({version:4,id:'one',createdAt:1,isSeeded:true,agentPreset:'native',parentSession:'parent'});
  let control=2,allowed=true,captures=0,reads=0,paused;
  const events=[Object.freeze({seq:0,type:'session/end-seed',data:Object.freeze({})}),Object.freeze({seq:1,type:'user/message',data:Object.freeze({content:'owned'})})];
  const service=workbenchPersistence({async metadata(id,signal){
    reads++;assert.equal(scope.getStore(),'opening');signal?.throwIfAborted();
    if(paused)await paused.promise;
    if(!allowed)throw Error('Request authority withdrawn');
    return {id,created_at:1,inherited:true,parent:'parent',preset:'native',selection_cursor:{kind:'durable',control_seq:control,fact_seq:5}};
  },snapshot:workbenchHistory({}).snapshot,async capture(){
    captures++;const frozen=[...events];
    return {id:'one',header,seq:frozen.length,inheritedEventCount:1,encodedBytes:256,
      requestHeader:()=>undefined,snapshotEvents:(start=0,end)=>frozen.slice(start,end),eventAt:seq=>frozen[seq],lastEvent:type=>frozen.findLast(e=>e.type===type)};
  }},errors);
  const [first,second]=await scope.run('opening',()=>Promise.all([service.open('one','read'),service.open('one','read')]));
  assert.equal(captures,1);assert.equal(first.inheritedEventCount,1);
  const initial=await scope.run('other',()=>first.read());
  assert.equal(initial.eventState,'shared-frozen');assert.ok(Object.isFrozen(initial.events[1].data));
  initial.events.length=0;assert.equal((await first.read()).events.length,2);
  const before=await scope.run('opening',()=>service.stat('one'));
  assert.deepEqual(before.header,first.header);
  control++;events.push(Object.freeze({seq:2,type:'model/selection',data:Object.freeze({model:'new'})}));
  const after=await scope.run('opening',()=>service.stat('one'));assert.notEqual(before.revision,after.revision);
  assert.equal(captures,1);
  assert.deepEqual((await first.read(2,10)).events,[events[2]]);assert.equal(captures,2);
  assert.deepEqual((await first.read(999)).events,[]);
  await assert.rejects(first.read(-1),RangeError);
  await assert.rejects(first.flush(),errors.SessionReadOnlyError);
  await assert.rejects(first.append([]),errors.SessionReadOnlyError);
  await first.close();await first.close();await assert.rejects(first.read(),errors.SessionHandleClosedError);
  assert.equal((await second.read()).events.length,3);
  paused=Promise.withResolvers();const inflight=second.read();await new Promise(resolve=>setImmediate(resolve));
  await second[Symbol.asyncDispose]();paused.resolve();await assert.rejects(inflight,errors.SessionHandleClosedError);paused=undefined;
  allowed=false;await assert.rejects(scope.run('opening',()=>service.capture('one')),/withdrawn/);
  assert.ok(reads>captures);
});

test('draft mirrors stay available to the request while persistence refuses to invent a durable log',{skip:!root},async()=>{
  const require=createRequire(join(root,'package.json'));
  const errors=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')));
  const service=workbenchPersistence({async metadata(id){return {id,created_at:1,selection_cursor:{kind:'draft',revision:0}};},
    async capture(id){return {id,header:{id},seq:0,inheritedEventCount:0,encodedBytes:0,requestHeader:()=>undefined,snapshotEvents:()=>[]};}},errors);
  assert.equal((await service.capture('draft')).seq,0);assert.equal(await service.stat('draft'),undefined);
  await assert.rejects(service.open('draft','read'),errors.SessionPersistenceNotFoundError);
  await assert.rejects(service.open('draft','write'),errors.SessionReadOnlyError);
});
