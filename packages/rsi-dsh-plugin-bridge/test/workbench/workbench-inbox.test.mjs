import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {nativeInboxFixture} from '../fixtures/native-inbox-fixture.mjs';

const enabled={skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,timeout:10000};
async function fixture(t,kind) {
  const row=(id,target='next_step')=>({message_id:id,target,source_kind:'command',queue_slot:{id},
    message:{message_id:id,source:{type:'command',source:{attribution:{id:'original-'+id,source:{kind:'plugin:fixture'}}}},
      content:[{type:'text',text:id}]}});
  const f=await nativeInboxFixture(t,{kind,pending:[row('one'),row('two','next_turn')]});
  assert.equal(f.calls.filter(row=>row.op?.type==='retain_draft').length,kind==='draft'?1:0,
    'a captured durable Session needs no draft ownership round trip');
  f.state.withdrawGate=Promise.withResolvers();
  return {...f,cancellations:()=>f.calls.filter(row=>row.method==='application.cancel'),get calls(){return f.calls.filter(row=>row.method==='application.inbox'&&
    ['discard_draft','mutate'].includes(row.op.type)).map(row=>row.op);}};
}

for(const kind of ['draft','durable'])test(`original Agent ${kind} inbox selects input synchronously and waits for native deletion`,enabled,async t=>{
  const f=await fixture(t,kind),snapshot=f.agent.inbox.nextStep;
  let complete=false;
  const removal=f.scope.runOwned(()=>{
    assert.equal(f.agent.inbox.remove('original-one'),true);assert.equal(f.agent.inbox.remove('original-one'),false);
    assert.equal(f.agent.inbox.nextStep.length,0);assert.equal(f.agent.inbox.hasPending,true);
    assert.equal(f.projection()['next-step'].length,0,'original DSH fold sees the same immediate removal');
  }).then(()=>{complete=true;});
  while(!f.calls.length)await setImmediate();assert.equal(complete,false);
  assert.equal(f.state.pending.length,2,'intent is not a native deletion');assert.equal(snapshot.length,1);
  f.state.withdrawGate.resolve();await removal;
  assert.deepEqual(f.state.pending.map(row=>row.message_id),['two']);
  await f.scope.runOwned(()=>{f.agent.inbox.clear();assert.equal(f.agent.inbox.hasPending,false);});
  assert.deepEqual(f.state.pending,[]);assert.equal(f.calls.length,1);assert.equal(f.cancellations().length,1);
  assert.equal(f.calls[0].type,kind==='draft'?'discard_draft':'mutate');
  assert.deepEqual(kind==='draft'?f.calls[0].message_ids:[f.calls[0].mutation.expected_message_id],['one']);
});

for(const failure of ['io','claimed'])test(`withdrawal ${failure} fails its publication without retracting accepted removals or cancelling a turn`,enabled,async t=>{
  const f=await fixture(t,'durable');f.state.failWithdraw=failure;f.state.withdrawGate.resolve();
  await assert.rejects(f.scope.runOwned(()=>{
    f.agent.inbox.remove('original-one');f.agent.inbox.remove('original-two');assert.equal(f.agent.inbox.hasPending,false);
  }),
    failure==='io'?/storage unavailable/:/claimed/);
  assert.equal(f.agent.inbox.hasPending,false);assert.equal(f.state.pending.length,failure==='io'?2:0);
  assert.equal(f.calls.length,1,'a failed withdrawal does not dispatch the later removal');
});
