import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applicationInbox} from '../../src/application/inbox.mjs';

function fixture({failMessage=false,badOffset=false,replacement=false,draft=false,empty=false}={}) {
  const pending=[{message_id:'old',source_kind:'human',queue_slot:{id:'slot'},accepted_control_seq:4,target:'next_turn'}];
  const snapshot={session_id:'session',cursor:{fact_seq:1,control_seq:4},active_turn_id:'turn',pending};
  const message={message_id:'old',source:{type:'human'},content:[{type:'text',text:'排队输入'.repeat(40_000)}]};
  if(draft){
    snapshot.kind='draft';snapshot.revision=3;delete snapshot.cursor;delete snapshot.active_turn_id;
    delete pending[0].queue_slot;delete pending[0].accepted_control_seq;
    pending[0].source_kind='command';pending[0].target='next_step';message.source={type:'command',source:{request_id:'command'}};
  }
  if(empty)pending.length=0;
  const calls=[];let open=false;
  const inbox=applicationInbox(async(id,operation,signal)=>{
    assert.equal(id,'session');calls.push(operation);
    signal?.throwIfAborted();
    if(operation.type==='close'){open=false;return null;}
    if(operation.type==='mutate')return {operation_id:operation.mutation.operation_id,
      outcome:{result:'rejected',reason:'stale_message',current_message_id:'successor'}};
    if(operation.type==='open'){open=!empty;return structuredClone(snapshot);}
    assert.ok(open);
    if(operation.type==='message'&&failMessage)throw Error('native read retired');
    const encoded=JSON.stringify(replacement?{...message,message_id:'other'}:message);
    const bytes=Buffer.from(encoded),start=operation.offset;
    let end=Math.min(start+64*1024,bytes.length);
    while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end--;
    return {json:bytes.subarray(start,end).toString(),offset:badOffset?start+1:start,next_offset:end,total_bytes:bytes.length};
  });
  return {inbox,calls,message,snapshot,isOpen:()=>open};
}

for(const draft of [false,true])test(`empty ${draft?'draft':'durable'} inbox completes in one call without a native resource`,async()=>{
  const f=fixture({empty:true,draft});
  assert.deepEqual(await f.inbox.capture('session'),f.snapshot);
  assert.deepEqual(f.calls.map(call=>call.type),['open']);assert.equal(f.isOpen(),false);
});

test('draft inbox preserves held Command input without inventing durable coordinates',async()=>{
  const f=fixture({draft:true}),captured=await f.inbox.capture('session');
  assert.equal(captured.kind,'draft');assert.equal(captured.revision,3);
  assert.equal(captured.cursor,undefined);assert.equal(captured.pending[0].queue_slot,undefined);
  assert.equal(captured.pending[0].accepted_control_seq,undefined);
  assert.deepEqual(captured.pending[0].message,f.message);
});

test('inbox reads exact native acceptance in byte fragments and releases its snapshot',async()=>{
  const f=fixture();
  const captured=await f.inbox.capture('session');
  assert.equal(captured.active_turn_id,'turn');
  assert.deepEqual(captured.cursor,{fact_seq:1,control_seq:4});
  assert.deepEqual(captured.pending[0].message,f.message);
  assert.equal(f.calls.filter(call=>call.type==='open').length,1);
  assert.equal(f.calls.filter(call=>call.type==='read').length,0,'opening already returned the complete metadata');
  assert.ok(f.calls.filter(call=>call.type==='message').length>2);
  assert.equal(f.calls.at(-1).type,'close');assert.equal(f.isOpen(),false);
  const mutation={operation_id:'once',slot_id:'slot',expected_message_id:'old',mutation:{action:'withdraw'}};
  const receipt=await f.inbox.mutate('session',mutation);
  assert.deepEqual(f.calls.at(-1),{type:'mutate',mutation});
  assert.equal(receipt.outcome.reason,'stale_message');
  assert.equal(captured.pending.length,1,'rejected withdrawal must not remove the captured input');
});

for(const option of ['failMessage','badOffset','replacement'])test(`inbox rejects ${option} and closes the native snapshot`,async()=>{
  const f=fixture({[option]:true});
  await assert.rejects(f.inbox.capture('session'));
  assert.equal(f.calls.at(-1).type,'close');assert.equal(f.isOpen(),false);
});

test('inbox close runs without the cancelled read signal',async()=>{
  const stop=new AbortController(),calls=[];let closed=false;
  const inbox=applicationInbox(async(_id,operation,signal)=>{
    calls.push(operation.type);
    if(operation.type==='open'){stop.abort();return {session_id:'session',pending:[{message_id:'pending'}]};}
    assert.equal(operation.type,'close');assert.equal(signal,undefined);
    closed=true;
  });
  await assert.rejects(inbox.capture('session',stop.signal));
  assert.deepEqual(calls,['open','close']);
  assert.equal(closed,true);
});
