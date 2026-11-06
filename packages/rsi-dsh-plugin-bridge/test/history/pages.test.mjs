import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historyReader,readHistory} from '../../src/history/pages.mjs';

const reply=(through,facts)=>{
  const json=JSON.stringify(facts),bytes=Buffer.byteLength(json);
  return {through_seq:through,offset:0,next_offset:bytes,total_bytes:bytes,json};
};

test('one captured page crosses control anchors without observing later Facts or fetching it twice',async()=>{
  const calls=[],observed=[];
  const read=historyReader(async(method,args)=>{
    assert.equal(method,'agent.history.read');calls.push(args);
    return args.after_seq===0?reply(6,[{seq:2},{seq:4}]):reply(12,[{seq:7},{seq:9},{seq:11}]);
  },{session_id:'one'},0,12);
  const consume=fact=>observed.push(fact.seq);
  assert.equal(await read(0,consume),0);assert.equal(calls.length,0);
  assert.equal(await read(3,consume),3);assert.deepEqual(observed,[2]);
  observed.push('control@3');
  assert.equal(await read(6,consume),6);assert.deepEqual(observed,[2,'control@3',4]);
  assert.equal(calls.length,1);
  assert.equal(await read(8,consume),8);assert.equal(calls.length,2);
  observed.push('control@8');
  assert.equal(await read(12,consume),12);
  assert.deepEqual(observed,[2,'control@3',4,7,'control@8',9,11]);
  assert.deepEqual(calls.map(row=>[row.after_seq,row.through_seq]),[[0,12],[6,12]]);
  await assert.rejects(read(11,consume),/history anchor/);
  await assert.rejects(read(13,consume),/history anchor/);
});

test('a retained page obeys cancellation between anchors and within observation',async()=>{
  for(const during of [false,true]) {
    const abort=new AbortController(),seen=[];let calls=0;
    const read=historyReader(async()=>{calls++;return reply(3,[{seq:1},{seq:2},{seq:3}]);},{},0,3,abort.signal);
    if(during) {
      await assert.rejects(read(3,fact=>{seen.push(fact.seq);abort.abort(Error('stop'));}),/stop/);
    } else {
      await read(1,fact=>seen.push(fact.seq));abort.abort(Error('stop'));
      await assert.rejects(read(3,fact=>seen.push(fact.seq)),/stop/);
    }
    assert.deepEqual(seen,[1]);assert.equal(calls,1);
  }
});

test('fragment admission and empty visible pages preserve the complete captured horizon',async()=>{
  let calls=0;const seen=[];
  const json=JSON.stringify([{seq:4,text:'雪'}]),prefix=json.indexOf('雪');
  const through=await readHistory(async(_method,args)=>{
    calls++;
    if(args.after_seq===0)return reply(3,[]);
    const bytes=Buffer.from(json),end=args.offset===0?prefix:bytes.length;
    return {through_seq:5,total_bytes:bytes.length,offset:args.offset,next_offset:end,json:bytes.subarray(args.offset,end).toString()};
  },{},0,5,fact=>seen.push(fact));
  assert.equal(through,5);assert.deepEqual(seen,[{seq:4,text:'雪'}]);assert.equal(calls,3);
  for(const bad of [reply(0,[]),reply(6,[]),reply(5,[{seq:3},{seq:2}]),reply(5,[{seq:6}])]) {
    await assert.rejects(readHistory(async()=>bad,{},0,5,()=>{}),/invalid/);
  }
});
