import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {nativeInboxFixture} from '../fixtures/native-inbox-fixture.mjs';

const enabled={skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,timeout:10000};

function captureGate(t,f,{fail=false}={}) {
  const entered=Promise.withResolvers(),release=Promise.withResolvers();let captures=0;
  t.after(()=>release.resolve());
  f.scope.inbox.capture=async()=>{
    const snapshot=f.snapshot();
    if(++captures===1){entered.resolve();await release.promise;if(fail)throw Error('capture failed');}
    return snapshot;
  };
  return {entered:entered.promise,release:release.resolve,count:()=>captures};
}

test('overlapping Agent refreshes share one later native cut instead of reading once per caller',enabled,async t=>{
  const f=await nativeInboxFixture(t),gate=captureGate(t,f);
  const first=f.refresh();await gate.entered;
  f.state.activeTurn=true;
  const later=Array.from({length:8},()=>f.refresh());
  gate.release();const agents=await Promise.all([first,...later]);
  assert.ok(agents.every(agent=>agent===f.agent));
  assert.equal(f.agent.status,'running','later callers observe a cut started after their request');
  assert.equal(gate.count(),2,'one active capture and one shared follow-up');
  await f.refresh();assert.equal(gate.count(),3,'completed reads are not cached for later callers');
});

test('a failed capture does not poison the coalesced follow-up or later reads',enabled,async t=>{
  const f=await nativeInboxFixture(t),gate=captureGate(t,f,{fail:true});
  const first=assert.rejects(f.refresh(),/capture failed/);await gate.entered;
  const later=Array.from({length:4},()=>f.refresh());
  gate.release();await first;await Promise.all(later);
  assert.equal(gate.count(),2);await f.refresh();assert.equal(gate.count(),3);
});

test('cancelling a queued caller releases its wait while the shared refresh remains live',enabled,async t=>{
  const f=await nativeInboxFixture(t),gate=captureGate(t,f),stop=new AbortController();
  const first=f.refresh();await gate.entered;
  let cancelled=false;
  const abandoned=assert.rejects(f.scope.runOwned(()=>f.agents.ensure('one',stop.signal),stop.signal),/caller left/)
    .then(()=>{cancelled=true;});
  const survivor=f.refresh();stop.abort(Error('caller left'));
  await setImmediate();
  try {assert.equal(cancelled,true,'cancellation must not wait for an earlier capture');}
  finally {gate.release();await Promise.allSettled([first,abandoned,survivor]);}
  assert.equal(gate.count(),2);assert.equal(await f.refresh(),f.agent);
});

test('the caller that starts a capture cannot cancel the Agent-owned read for other callers',enabled,async t=>{
  const f=await nativeInboxFixture(t),gate=captureGate(t,f),stop=new AbortController();
  const first=assert.rejects(f.scope.runOwned(()=>f.agents.ensure('one',stop.signal),stop.signal),/caller left/);
  await gate.entered;const survivor=f.refresh();stop.abort(Error('caller left'));await first;
  gate.release();assert.equal(await survivor,f.agent);assert.equal(gate.count(),2);
});

test('Agent disposal cancels active refresh and drains its queued follow-up without cancelling native execution',enabled,async t=>{
  const f=await nativeInboxFixture(t),entered=Promise.withResolvers();let aborted=false,captures=0;
  f.scope.inbox.capture=async(_id,signal)=>{
    captures++;entered.resolve();signal.throwIfAborted();
    await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}));
  };
  const first=assert.rejects(f.refresh(),/retired/);await entered.promise;
  const second=assert.rejects(f.refresh(),/retired/);
  await f.ctx.fiber.dispose();await Promise.all([first,second]);
  assert.equal(aborted,true);assert.equal(captures,1);
  assert.equal(f.calls.filter(row=>row.method==='application.cancel').length,0);
});
