import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {nativeInboxFixture,message} from '../../fixtures/native-inbox-fixture.mjs';
import {workbenchHistory} from '../../../src/workbench/history.mjs';

const enabled={skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,timeout:15000};
const until=async predicate=>{for(let n=0;!predicate();n++){assert.ok(n<2000);await setImmediate();}};
const cancels=f=>f.calls.filter(row=>row.method==='application.cancel');
const sends=f=>f.calls.filter(row=>row.method==='application.submit');
const pending=(count=4)=>Array.from({length:count},(_,i)=>{
  const original=message('input-'+i),id='native-'+i;
  return {message_id:id,target:i%2?'next_turn':'next_step',source_kind:'command',queue_slot:{id},
    message:{message_id:id,source:{type:'command',source:{attribution:{id:original.id,source:original.source}}},content:original.content}};
});
async function cold(t,f) {
  const history=workbenchHistory(f.options);t.after(()=>history.close());
  const session=await history.capture('one',await history.metadata('one'));
  return {session,owner:history.owner(session)};
}

for(const kind of ['draft','durable'])for(const stop of [false,true])
test(`${kind} ${stop?'default cancel':'inbox clear'} clears 64 inputs in two synchronous splices and one native request`,enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind,pending:pending(64)});
  f.state.activeTurn=true;await f.refresh();
  const before=f.agent.session.seq,notices=[];f.ctx.on('agent/inbox/discarded',({message})=>notices.push(message.id));
  await f.scope.runOwned(()=>{
    if(stop)f.agent.cancel({kind:'user'});else f.agent.inbox.clear();
    assert.equal(f.agent.session.seq,before+2);assert.equal(f.agent.inbox.hasPending,false);
    assert.deepEqual(f.projection(),{'next-step':[],'next-turn':[]});assert.equal(cancels(f).length,0);
  });
  assert.equal(notices.length,64);assert.equal(cancels(f).length,1);
  assert.equal(cancels(f)[0].args.keep_inbox,false);assert.equal(!!cancels(f)[0].args.inbox_only,!stop);
  assert.equal(f.state.pending.length,0);assert.equal(!!f.state.cancelled,stop);
  assert.equal(f.calls.filter(row=>row.op?.type==='mutate'||row.op?.type==='discard_draft').length,0);
  const reopened=await cold(t,f);assert.deepEqual(reopened.session.snapshotEvents(),f.agent.session.snapshotEvents());
  assert.deepEqual(reopened.owner.input.snapshot(),f.projection());
});

test('keepInbox preserves inputs and a steer accepted immediately after cancellation wakes the next turn',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable',pending:pending(2)});f.state.activeTurn=true;f.state.holdSubmissions=true;await f.refresh();
  await f.scope.runOwned(()=>{
    f.agent.cancel({kind:'user'},{keepInbox:true});
    assert.equal(f.agent.inbox.nextStep.length+f.agent.inbox.nextTurn.length,2);
    f.agent.steer(message('after-stop'));assert.equal(f.agent.inbox.nextTurn.at(-1).id,'after-stop');
  });
  assert.equal(cancels(f).length,1);assert.equal(cancels(f)[0].args.keep_inbox,true);
  assert.equal(sends(f)[0].args.delivery,'next_turn');assert.equal(f.state.pending.length,3);
});

test('earlier readiness cannot submit input accepted after a later cancel',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});f.state.holdSubmissions=true;
  await f.scope.runOwned(()=>{
    f.agent.followup(message('withdrawn'));
    f.agent.cancel({kind:'user'});
    f.agent.followup(message('survives'));
  });
  assert.deepEqual(f.calls.filter(row=>['application.cancel','application.submit'].includes(row.method)).map(row=>row.method),
    ['application.cancel','application.submit']);
  assert.deepEqual(f.state.pending.map(row=>row.message.source.attribution.id),['survives']);
  assert.deepEqual(f.agent.inbox.nextTurn,[message('survives')]);
});

test('clear during an in-flight acceptance waits for its receipt and removes that batch once',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});f.state.holdSubmissions=true;f.state.submitGate=Promise.withResolvers();
  const sent=f.scope.runOwned(()=>f.agent.followup(message('flight')));
  await until(()=>sends(f).length===1);
  const cleared=f.scope.runOwned(()=>f.agent.inbox.clear());assert.equal(f.agent.inbox.hasPending,false);
  f.state.submitGate.resolve();await Promise.all([sent,cleared]);
  assert.equal(sends(f).length,1);assert.equal(cancels(f).length,1);assert.equal(f.state.pending.length,0);
});

test('a skipped clear publication does not leave recovery suppressed',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable',pending:pending(2)});f.state.failSave=true;
  await assert.rejects(f.scope.runOwned(()=>{f.agent.inject(message('local'));f.agent.inbox.clear();}),/disk unavailable/);
  f.state.failSave=false;await f.refresh();
  assert.equal(cancels(f).length,0);assert.deepEqual(f.agent.inbox.nextStep,[message('input-0')]);
  assert.deepEqual(f.agent.inbox.nextTurn,[message('input-1')]);
});

test('settled readiness does not enumerate all historical operations again',enabled,async t=>{
  const f=await nativeInboxFixture(t);await f.scope.runOwned(()=>f.agent.inject(message('settled')));
  const original=f.owner.journal.operations;let enumerations=0;
  f.owner.journal.operations=function(){enumerations++;return original.call(this);};
  for(let i=0;i<20;i++)await f.scope.runOwned(()=>f.owner.input.ready());
  assert.equal(enumerations,0);assert.equal(f.calls.filter(row=>row.method==='application.command'&&row.op.type==='execute').length,1);
});

for(const kind of ['draft','durable'])for(const failure of ['before','after'])
test(`${kind} ${failure}-commit clear failure reconciles native truth without replay`,enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind,pending:pending()});f.state.failCancel=failure;
  await assert.rejects(f.scope.runOwned(()=>f.agent.inbox.clear()),/cancel/);
  const expected=failure==='before'?{'next-step':[message('input-0'),message('input-2')],'next-turn':[message('input-1'),message('input-3')]}:
    {'next-step':[],'next-turn':[]};
  assert.deepEqual(f.owner.input.snapshot(),expected);assert.deepEqual(f.projection(),expected);
  const reopened=await cold(t,f);assert.deepEqual(reopened.owner.input.snapshot(),expected);
  await f.scope.runOwned(()=>reopened.owner.input.ready());assert.equal(cancels(f).length,1);assert.equal(sends(f).length,0);
  if(failure==='before') {
    const old=f.state.pending.shift();
    if(kind==='durable')f.control({kind:'discarded',message_id:old.message_id});else f.state.revision++;
    await f.refresh();assert.equal(f.agent.inbox.nextStep.some(row=>row.id==='input-0'),false);
  }
});

for(const kind of ['draft','durable'])test(`${kind} cold unconfirmed clear restores original native identities before new local inputs`,enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind,pending:pending()});
  f.owner.input.clear();f.owner.input.accept(message('later'),'next_turn');await f.owner.flush();
  const reopened=await cold(t,f);
  assert.deepEqual(reopened.owner.input.snapshot(),{'next-step':[message('input-0'),message('input-2')],
    'next-turn':[message('input-1'),message('input-3'),message('later')]});
  assert.equal(cancels(f).length,0);assert.equal(sends(f).length,0);
  const restored=reopened.owner.journal.operations().filter(row=>row.invocation?.kind==='restored-input');
  assert.equal(restored.length,4);assert.ok(restored.every(row=>row.invocation.key));
});

test('failed clear with a reused pending ID preserves both intents until an explicit new clear resolves them',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable',pending:pending(1)});f.state.cancelGate=Promise.withResolvers();f.state.failCancel='before';
  const cleared=f.scope.runOwned(()=>f.agent.inbox.clear());const rejectedClear=assert.rejects(cleared,/cancel outcome/);
  await until(()=>cancels(f).length===1);
  const sent=f.scope.runOwned(()=>f.agent.followup(message('input-0','new intent')));
  const rejectedSend=assert.rejects(sent,/reused message ID/);
  f.state.cancelGate.resolve();await Promise.all([rejectedClear,rejectedSend]);
  assert.equal(f.state.pending.length,1);assert.equal(sends(f).length,0);
  f.state.failCancel=undefined;await f.scope.runOwned(()=>f.agent.inbox.clear());
  assert.equal(f.state.pending.length,0);assert.equal(f.agent.inbox.hasPending,false);assert.equal(cancels(f).length,2);
  const reopened=await cold(t,f);assert.deepEqual(reopened.owner.input.snapshot(),{'next-step':[],'next-turn':[]});
});
