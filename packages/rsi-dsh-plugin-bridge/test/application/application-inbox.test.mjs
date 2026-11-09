import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applicationInbox} from '../../src/application/inbox.mjs';

function fixture({draft=false,empty=false}={}) {
  const pending=[{message_id:'held',source_kind:'command',target:'next_step'}];
  const snapshot={kind:draft?'draft':'durable',session_id:'session',pending,
    ...(draft?{revision:3}:{cursor:{fact_seq:1,control_seq:4},active_turn_id:'turn'})};
  if(draft)pending[0].message={message_id:'held',source:{type:'command',source:{request_id:'command'}},
    content:[{type:'text',text:'排队输入'.repeat(10_000)}]};
  if(empty)pending.length=0;
  const calls=[],inbox=applicationInbox(async(id,op,signal)=>{
    assert.equal(id,'session');calls.push(op);signal?.throwIfAborted();
    if(op.type==='open')return structuredClone(snapshot);
    if(op.type==='mutate')return {outcome:{result:'rejected',reason:'stale_message'}};
    throw Error('unexpected '+op.type);
  });
  return {inbox,calls,snapshot};
}

for(const draft of [false,true])for(const empty of [false,true])
  test(`${empty?'empty':'pending'} ${draft?'draft':'durable'} inbox captures its authoritative cut in one call`,async()=>{
    const f=fixture({draft,empty});
    assert.deepEqual(await f.inbox.capture('session'),f.snapshot);
    assert.deepEqual(f.calls,[{type:'open'}]);
  });

test('durable queue mutation does not edit the previously captured inbox',async()=>{
  const f=fixture(),captured=await f.inbox.capture('session');
  const mutation={operation_id:'once',slot_id:'slot',expected_message_id:'held',mutation:{action:'withdraw'}};
  assert.equal((await f.inbox.mutate('session',mutation)).outcome.reason,'stale_message');
  assert.deepEqual(f.calls.at(-1),{type:'mutate',mutation});
  assert.deepEqual(captured,f.snapshot);
});

for(const [name,edit] of [
  ['wrong session',s=>{s.session_id='other';}],
  ['unknown kind',s=>{s.kind='unknown';}],
  ['duplicate identity',s=>s.pending.push(s.pending[0])],
  ['changed message',s=>{s.pending[0].message.message_id='other';}],
  ['changed source',s=>{s.pending[0].message.source.type='human';}],
])test(`inbox rejects ${name} at its native reply boundary`,async()=>{
  const f=fixture({draft:true});edit(f.snapshot);
  await assert.rejects(f.inbox.capture('session'));
  assert.deepEqual(f.calls,[{type:'open'}]);
});

test('cancellation after capture needs no follow-up resource release',async()=>{
  const stop=new AbortController(),f=fixture({draft:true});
  const inbox=applicationInbox(async()=>{stop.abort(Error('caller left'));return f.snapshot;});
  await assert.rejects(inbox.capture('session',stop.signal),/caller left/);
});
