import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeInboxFixture,message} from '../../fixtures/native-inbox-fixture.mjs';
import {inboxReader} from '../../../src/session/inbox/inbox-state.mjs';

const enabled={skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,timeout:15000};

test('changing inbox reads fold only appended events and keep metadata current',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'}),journal=f.owner.journal;
  const initial=f.owner.input.snapshot();
  let copies=0,scans=0,reads=0;
  const snapshot=journal.session.snapshotEvents.bind(journal.session),operations=journal.operations.bind(journal),eventAt=journal.session.eventAt.bind(journal.session);
  journal.session.snapshotEvents=(...args)=>{copies++;return snapshot(...args);};
  journal.operations=()=>{scans++;return operations();};
  journal.session.eventAt=(...args)=>{reads++;return eventAt(...args);};
  for(let n=0;n<100;n++) {
    journal.accept('add-'+n,'agent/inbox/spliced',{target:'next-step',start:0,inserted:[message('input-'+n)]});
    const pending=f.owner.input.snapshot();
    assert.deepEqual(pending['next-step'],[message('input-'+n)]);
    journal.prepare('add-'+n,{kind:'observed-input',message_id:'native-'+n,source:{type:'human'}});
    assert.equal(f.owner.input.snapshot(),pending,'metadata does not change the public pending projection');
    journal.accept('remove-'+n,'agent/inbox/spliced',{target:'next-step',start:0,removedCount:1,inserted:[],outcome:'canceled'});
    assert.deepEqual(f.owner.input.snapshot(),initial);
    assert.deepEqual(pending['next-step'],[message('input-'+n)]);
  }
  assert.equal(copies,0);assert.equal(scans,0);assert.equal(reads,200);
  assert.deepEqual(f.projection(),initial);
});

test('an invalid appended splice cannot corrupt or advance a retained inbox fold',enabled,async t=>{
  const f=await nativeInboxFixture(t),journal=f.owner.journal;
  journal.accept('first','agent/inbox/spliced',{target:'next-step',start:0,inserted:[message('same')]});
  const reader=inboxReader(journal).prefix(),before=reader.snapshot();
  journal.accept('duplicate','agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message('same')]});
  for(let n=0;n<2;n++)assert.throws(()=>reader.prefix(),/duplicate pending/);
  assert.equal(reader.snapshot(),before);
  assert.deepEqual(before,{'next-step':[message('same')],'next-turn':[]});
  assert.throws(()=>inboxReader(journal).prefix(),/duplicate pending/);
});

test('unchanged inbox reads reuse immutable state without copying history or scanning operations',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'}),journal=f.owner.journal;
  for(let n=0;n<250;n++) {
    journal.accept('insert-'+n,'agent/inbox/spliced',{target:'next-step',start:0,inserted:[message('input-'+n)]});
    journal.prepare('insert-'+n,{kind:'observed-input',message_id:'native-'+n,source:{type:'human'}});
    journal.accept('remove-'+n,'agent/inbox/spliced',{target:'next-step',start:0,removedCount:1,inserted:[],outcome:'canceled'});
    journal.prepare('remove-'+n,{kind:'observed-withdrawal',message_id:'native-'+n});
  }
  const initial=f.owner.input.snapshot(),notifications=f.owner.input.notifications();
  let snapshots=0,scans=0;
  const original=journal.session.snapshotEvents.bind(journal.session),operations=journal.operations.bind(journal);
  journal.session.snapshotEvents=(...args)=>{snapshots++;return original(...args);};
  journal.operations=()=>{scans++;return operations();};
  for(let n=0;n<100;n++) {
    assert.equal(f.owner.input.snapshot(),initial);assert.equal(f.owner.input.notifications(),notifications);
    assert.equal(f.agent.inbox.hasPending,false);
  }
  assert.equal(snapshots,0);assert.equal(scans,0);
  await f.scope.runOwned(()=>f.agent.inject(message('new-input')));
  assert.deepEqual(f.owner.input.snapshot()['next-step'],[message('new-input')]);
  assert.deepEqual(initial,{'next-step':[],'next-turn':[]});
  assert.deepEqual(f.projection(),f.owner.input.snapshot());
});

test('native identity preparation invalidates a read captured by the synchronous acceptance observer',enabled,async t=>{
  const f=await nativeInboxFixture(t),original=message('external');
  const captured=[];f.owner.onEvent(()=>captured.push(f.owner.input.snapshot()));
  f.state.pending=[{message_id:'native-external',source_kind:'human',target:'next_step',message:{
    message_id:'native-external',source:{type:'human',attribution:{id:original.id,source:original.source}},content:original.content}}];
  f.state.revision++;await f.refresh();
  assert.deepEqual(captured[0]['next-step'],[original]);
  f.state.pending=[];f.state.revision++;await f.refresh();
  assert.equal(f.agent.inbox.hasPending,false,'the prepared identity permits observed draft withdrawal');
  assert.deepEqual(captured[0]['next-step'],[original],'the earlier immutable view stays unchanged');
  assert.deepEqual(f.projection(),{'next-step':[],'next-turn':[]});
});

test('a caught rejected input performs no native refresh or publication',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'});
  await f.scope.runOwned(()=>f.agent.inject(message('pending')));
  let captures=0;const capture=f.scope.inbox.capture;
  f.scope.inbox.capture=(...args)=>{captures++;return capture(...args);};
  const count=f.calls.length,revision=f.owner.journal.revision;
  await f.scope.runOwned(()=>{
    for(let n=0;n<10;n++)assert.throws(()=>f.agent.followup(message('pending')),/already pending/);
  });
  assert.equal(captures,0);assert.equal(f.calls.length,count);assert.equal(f.owner.journal.revision,revision);
  assert.deepEqual(f.agent.inbox.nextStep,[message('pending')]);
});

test('Agent refresh publishes each new Session event without reading browser projections or rebuilding notification maps',enabled,async t=>{
  const f=await nativeInboxFixture(t,{kind:'durable'}),{journal}=f.owner;
  let projections=0,iterations=0;
  const service=f.ctx.sessionProjections,original=service.snapshot.bind(service);
  service.snapshot=(...args)=>{projections++;return original(...args);};
  const notifications=f.owner.input.notifications(),iterate=notifications[Symbol.iterator].bind(notifications);
  notifications[Symbol.iterator]=function(){iterations++;return iterate();};
  const seen=[];
  f.ctx.on('session/event',(session,event)=>{if(session===f.agent.session)seen.push(event.seq);});
  const first=journal.seq;
  for(let n=0;n<64;n++)journal.accept('notice-'+n,'plan/mode',{active:n%2===0});
  await f.refresh();
  assert.deepEqual(seen,Array.from({length:64},(_,n)=>first+n));
  assert.deepEqual({projections,iterations},{projections:0,iterations:0});
});
