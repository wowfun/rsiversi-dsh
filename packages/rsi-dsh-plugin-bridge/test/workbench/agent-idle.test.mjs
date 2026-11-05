import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {nativeInboxFixture,message} from '../fixtures/native-inbox-fixture.mjs';

const enabled={skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,timeout:15000};
const until=async predicate=>{for(let n=0;!predicate();n++){assert.ok(n<2000);await setImmediate();}};
const waits=f=>f.calls.filter(row=>row.method==='application.inbox'&&row.op.type==='wait_idle');

test('concurrent idle waiters share native convergence and drain a preceding accepted write',enabled,async t=>{
  const f=await nativeInboxFixture(t);f.state.submitGate=Promise.withResolvers();f.state.idleGate=Promise.withResolvers();
  const activity=f.scope.runOwned(()=>f.agent.followup(message('pending')));
  const first=f.agent.whenIdle(),second=f.agent.whenIdle();assert.equal(first,second);
  let settled=false;void first.then(()=>{settled=true;});
  await until(()=>f.calls.some(row=>row.method==='application.submit'));assert.equal(waits(f).length,0);
  f.state.submitGate.resolve();await activity;await until(()=>waits(f).length===1);assert.equal(settled,false);
  f.state.idleGate.resolve();await first;assert.equal(waits(f).length,1);assert.equal(f.agent.inbox.hasPending,false);
});

test('idle waiting follows replacement input accepted before convergence returns',enabled,async t=>{
  const f=await nativeInboxFixture(t),original=f.scope.inbox.waitIdle;let rounds=0;
  f.scope.inbox.waitIdle=async(...args)=>{
    await original(...args);
    if(rounds++===0){f.state.submitGate=Promise.withResolvers();f.agent.followup(message('replacement'));}
  };
  let settled=false;const idle=f.agent.whenIdle().then(()=>{settled=true;});
  await until(()=>f.calls.some(row=>row.method==='application.submit'));assert.equal(settled,false);
  f.state.submitGate.resolve();await idle;
  assert.equal(rounds,2);assert.equal(f.agent.inbox.hasPending,false);
});

test('idle-status listeners can start replacement work followed by the same idle waiter',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});f.state.activeTurn=true;await f.refresh();
  let notified=false;
  f.ctx.on('agent/status',({agent,status})=>{
    assert.equal(agent,f.agent);
    if(status==='idle'&&!notified){notified=true;f.state.submitGate=Promise.withResolvers();agent.followup(message('replacement'));}
  });
  let settled=false;const idle=f.agent.whenIdle().then(()=>{settled=true;});
  await until(()=>waits(f).length===1);f.state.activeTurn=false;f.changed();
  await until(()=>f.calls.some(row=>row.method==='application.submit'));assert.equal(settled,false);
  f.state.submitGate.resolve();await idle;assert.equal(notified,true);assert.equal(waits(f).length,2);
});

test('original fused dispatch supplies the Agent subject and isolates throwing inbox listeners',enabled,async t=>{
  const f=await nativeInboxFixture(t),notices=[];
  f.ctx.on('agent/inbox/inserted',()=>{throw Error('deliberately failing observer');});
  f.ctx.on('agent/inbox/inserted',value=>notices.push(value));
  await f.scope.runOwned(()=>f.agent.inject(message('observed')));
  assert.equal(notices.length,1);assert.equal(notices[0].agent,f.agent);assert.deepEqual(notices[0].message,message('observed'));
});

test('idle waiting includes activation cleanup but ignores a paused retained queue',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});f.state.activeTurn=true;f.state.activationActive=true;
  let settled=false;const idle=f.agent.whenIdle().then(()=>{settled=true;});
  await until(()=>waits(f).length===1);
  f.state.activeTurn=false;f.changed();await setImmediate();assert.equal(settled,false);
  f.state.activationActive=false;f.state.paused=true;f.changed();await idle;
  assert.equal(waits(f).length,1);
});

test('retiring an automatic mirror cancels its idle read without cancelling independently owned execution',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});f.state.activeTurn=true;
  const idle=f.agent.whenIdle(),rejected=assert.rejects(idle,/retired/);
  await until(()=>waits(f).length===1);await f.ctx.fiber.dispose();await rejected;
  assert.equal(f.calls.filter(row=>row.method==='application.cancel').length,0);
  await f.agent.whenIdle();
});
