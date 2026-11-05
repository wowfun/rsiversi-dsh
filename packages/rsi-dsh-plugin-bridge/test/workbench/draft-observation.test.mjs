import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {test} from 'node:test';
import {nativeInboxFixture,message} from '../fixtures/native-inbox-fixture.mjs';

test('draft observation refreshes only on revision changes and releases its pending wait',
  {skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,timeout:15000},async t=>{
    const f=await nativeInboxFixture(t);
    assert.equal(f.draftOwners.size,1);
    const until=async predicate=>{for(let n=0;!predicate();n++){assert.ok(n<1000,'observer converges');await setImmediate();}};
    await until(()=>f.observerWaiters()===1);
    let captures=0;const capture=f.scope.inbox.capture;
    f.scope.inbox.capture=(...args)=>{captures++;return capture(...args);};
    t.mock.timers.enable({apis:['setTimeout']});
    t.mock.timers.tick(2000);await setImmediate();
    assert.equal(captures,0,'idle draft performs no periodic inbox/history refresh');
    assert.equal(f.calls.filter(row=>row.op?.type==='wait_draft').length,1);
    t.mock.timers.reset();
    const original=message('external-notification');
    f.state.pending=[{message_id:'native-notification',source_kind:'human',target:'next_step',message:{
      message_id:'native-notification',source:{type:'human',attribution:{id:original.id,source:original.source}},content:original.content}}];
    f.state.revision++;f.changed();
    await until(()=>f.agent.inbox.nextStep.length===1&&f.observerWaiters()===1);
    assert.deepEqual(f.agent.inbox.nextStep,[original]);
    const before=captures;f.changed();await setImmediate();
    assert.equal(captures,before,'an equal revision does not refresh');
    await f.ctx.fiber.dispose();
    assert.equal(f.observerWaiters(),0,'teardown cancels the native wait');
    assert.equal(f.draftOwners.size,0,'teardown releases the native draft owner');
  });
