import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {nativePage} from '../../src/history/native-pages.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const one=()=>({through_seq:1,offset:0,next_offset:2,total_bytes:2,json:'[]'});
const operation={type:'fact',after_seq:0,through_seq:1};

test('a frame-sized native page needs only one read and no close RPC',async()=>{
  const text='界'.repeat(100_000),json=JSON.stringify([{seq:1,text}]),size=Buffer.byteLength(json);
  let reads=0;
  const page=await nativePage(async()=>{
    reads++;return {through_seq:1,offset:0,next_offset:size,total_bytes:size,json};
  },async()=>assert.fail('complete page must not need a close RPC'),operation,0,1);
  assert.deepEqual(page,{through:1,value:[{seq:1,text}]});assert.equal(reads,1);
});

test('one native reader spans UTF-8 fragments and needs no final close RPC',async()=>{
  const text='界'.repeat(100_000),body=Buffer.from(JSON.stringify([{seq:1,text}]));
  const calls=[],closed=[];
  const page=await nativePage(async op=>{
    calls.push(op);
    let end=Math.min(op.offset+128*1024,body.length);
    while(end<body.length&&(body[end]&0xc0)===0x80)end--;
    return {through_seq:1,offset:op.offset,next_offset:end,total_bytes:body.length,json:body.subarray(op.offset,end).toString()};
  },async op=>closed.push(op),operation,0,1);
  assert.deepEqual(page,{through:1,value:[{seq:1,text}]});
  assert.equal(calls.length,3);assert.equal(new Set(calls.map(op=>op.reader)).size,1);
  assert.equal(calls.filter(op=>op.offset===0).length,1);assert.deepEqual(closed,[]);
});

test('cancelled or malformed transfers close through a separate release path',async()=>{
  for(const cancel of [false,true]) {
    const abort=new AbortController(),closed=[];let first;
    const reading=nativePage(async op=>{
      first=op;
      if(cancel)abort.abort(Error('stopped'));
      return {through_seq:1,offset:0,next_offset:cancel?1:0,total_bytes:2,json:cancel?'[':''};
    },async op=>{closed.push(op);},operation,0,1,abort.signal);
    await assert.rejects(reading,cancel?/stopped/:/invalid history fragment/);
    assert.deepEqual(closed,[{type:'page_close',reader:first.reader}]);
  }
});

test('queued readers send no RPC and cancellation does not consume a page slot',async()=>{
  const pending=[],calls=[];
  const call=async op=>{calls.push(op);const next=Promise.withResolvers();pending.push(next);return next.promise;};
  const release=async()=>assert.fail('complete single-fragment pages need no close');
  const a=nativePage(call,release,operation,0,1),b=nativePage(call,release,operation,0,1);
  const abort=new AbortController();
  const c=nativePage(call,release,operation,0,1,abort.signal);
  const cancelled=assert.rejects(c,/queued cancellation/);
  const d=nativePage(call,release,operation,0,1);
  await setImmediate();assert.equal(calls.length,2);
  abort.abort(Error('queued cancellation'));await cancelled;
  pending[0].resolve(one());await a;await setImmediate();assert.equal(calls.length,3);
  pending[1].resolve(one());pending[2].resolve(one());await Promise.all([b,d]);
  assert.equal(new Set(calls.map(op=>op.reader)).size,3);
});

test('close failure still releases the sender slot',async()=>{
  await assert.rejects(nativePage(async()=>{throw Error('read');},async()=>{throw Error('close');},operation,0,1),/close/);
  const completed=await Promise.all([0,1].map(()=>nativePage(async()=>one(),async()=>{},operation,0,1)));
  assert.equal(completed.length,2);
});


test('native page cancellation closes through the application owner after abort',async()=>{
  const abort=new AbortController(),calls=[];
  const scope=applicationSessions(async(method,args,signal)=>{
    assert.equal(method,'application.history');assert.equal(args.request,'owner');
    calls.push(args.operation);
    if(args.operation.type==='page_close'){assert.equal(signal,undefined);return;}
    signal.throwIfAborted();abort.abort(Error('stopped'));
    return {through_seq:1,offset:0,next_offset:1,total_bytes:2,json:'['};
  },{owner:'owner'});
  try {
    await assert.rejects(scope.runOwned(()=>nativePage(op=>scope.history('thread',op),
      op=>scope.releaseHistory('thread',op),operation,0,1,abort.signal),abort.signal),/stopped/);
    assert.deepEqual(calls.map(row=>row.type),['fact','page_close']);
    assert.equal(calls[0].reader,calls[1].reader);
  } finally {await scope.close();}
});
