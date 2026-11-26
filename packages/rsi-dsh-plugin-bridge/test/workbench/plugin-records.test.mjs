import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {installSessionRecordWriter} from '../../src/session/plugin-records.mjs';
import {readJournalDocument} from '../../src/session/journal-document.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {nativeInboxFixture} from '../fixtures/native-inbox-fixture.mjs';

test('the released SDK writes opaque plugin records into the owning workbench Session', {
  skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,
},async t=>{
  const require=createRequire(join(process.env.RSI_DSH_MARKET_COHORT,'package.json'));
  const entry=require.resolve('@deepseek-ai/dsh-session');
  const hook=installSessionRecordWriter(entry);t.after(()=>hook.deregister());
  const sdk=await import(pathToFileURL(entry));
  const cjs=require('@deepseek-ai/dsh-session');
  assert.equal(cjs.Session,sdk.Session);
  const original=sdk.Session.create('ordinary');
  const type='plugin:annotation/bookmark';
  assert.equal(sdk.pluginRecordOf(original.eventAt(cjs.appendPluginRecord(original,type,{page:1}))).data.page,1);

  const f=await nativeInboxFixture(t);
  const session=f.agent.session,start=session.seq,payload={bookmark:{page:3}};
  let notifications=0;
  f.ctx.on('session/event',(observed,event)=>{
    if(observed===session&&event.type===type){
      notifications++;
      assert.throws(()=>sdk.appendPluginRecord(session,type,{}),/cannot reenter/);
    }
  });
  await f.scope.runOwned(()=>{
    assert.throws(()=>sdk.appendPluginRecord(session,'turn/start',{}),/record type/);
    assert.throws(()=>sdk.appendPluginRecord(session,type,{bad:undefined}));
    assert.equal(cjs.appendPluginRecord(session,type,payload),start);
  });
  payload.bookmark.page=4;
  assert.equal(notifications,1);
  const event=session.eventAt(start);
  assert.equal(sdk.pluginRecordOf(event).data.bookmark.page,3);
  assert.equal(event.surfaceOp,undefined);
  assert.ok(await f.agents.flush(session));
  const state=readJournalDocument(f.documents.get('one'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const api={...sdk,...await load('dsh-session/surface'),...await load('dsh-util-values')};
  const cold=new SessionProjectionJournal(f.ctx,api,{header:session.header},{restore:state,native:[]});
  assert.deepEqual(cold.session.eventAt(start),event);
  assert.equal(cold.seq,start+1);
});

test('a Session observer cannot publish a later log entry ahead of the event being observed',{
  skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,
},async t=>{
  const require=createRequire(join(process.env.RSI_DSH_MARKET_COHORT,'package.json'));
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const ctx=new Context(),seen=[],errors=[];
  t.after(()=>ctx.fiber.dispose());
  ctx.on('session/created',session=>{
    try{session.append('feedback/record',{text:'during creation'});}
    catch(error){errors.push(error.message);}
  });
  const f=await nativeInboxFixture(t,{context:ctx}),session=f.agent.session;
  assert.equal(session.lastEvent('feedback/record'),undefined);
  assert.match(errors[0],/before session\/created completes/);
  f.ctx.on('session/event',(_session,event)=>{
    if(event.type==='feedback/record'&&event.data.text==='first'){
      try{session.append('feedback/record',{text:'nested'});}
      catch(error){errors.push(error.message);}
    }
  });
  f.ctx.on('session/event',(_session,event)=>{if(event.type==='feedback/record')seen.push(event.data.text);});
  await f.scope.runOwned(()=>{
    session.append('feedback/record',{text:'first'});
    session.append('feedback/record',{text:'second'});
  });
  await f.agents.flush(session);
  assert.deepEqual(seen,['first','second']);
  assert.match(errors[1],/cannot reenter/);
  assert.deepEqual(readJournalDocument(f.documents.get('one')).events.map(event=>event.data.text),seen);
});

test('live log acknowledgements precede disk and shutdown drains the last batch', {
  skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,
  timeout:15000,
},async t=>{
  const f=await nativeInboxFixture(t);
  const session=f.agent.session;
  const started=Promise.withResolvers(),gate=Promise.withResolvers();
  t.signal.addEventListener('abort',()=>gate.resolve(),{once:true});
  f.state.saveGate={get promise(){started.resolve();return gate.promise;},resolve:gate.resolve};
  const writes=t.mock.method(f.documents,'set');
  let returned=false;
  const accepted=f.scope.runOwned(()=>{
    session.append('feedback/record',{text:'first'});
    session.append('feedback/record',{text:'second'});
  }).then(()=>{returned=true;});
  try{
    await started.promise;
    assert.equal(returned,true);
    assert.equal(writes.mock.callCount(),0);
    const attached=await f.scope.runOwned(()=>f.agents.ensure('one'));
    assert.equal(attached.session.lastEvent('feedback/record').data.text,'second');
    session.append('feedback/record',{text:'third'});
    assert.equal(session.lastEvent('feedback/record').data.text,'third');
  }finally{gate.resolve();await accepted;}
  await f.agents.flush(session);
  assert.deepEqual(readJournalDocument(f.documents.get('one')).events.map(event=>event.data.text),['first','second','third']);
  assert.ok(writes.mock.callCount()<=2);
  session.append('feedback/record',{text:'last'});
  await f.history.close();
  assert.equal(readJournalDocument(f.documents.get('one')).events.at(-1).data.text,'last');
});

test('an explicit flush can retry a failed live log write without appending the event twice', {
  skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,
},async t=>{
  const f=await nativeInboxFixture(t);
  f.state.failSave=true;
  const session=f.agent.session;
  await f.scope.runOwned(()=>session.append('feedback/record',{text:'retry me'}));
  await assert.rejects(f.agents.flush(session),/disk unavailable/);
  assert.equal(session.lastEvent('feedback/record').data.text,'retry me');
  f.state.failSave=false;
  await f.agents.flush(session);
  assert.deepEqual(readJournalDocument(f.documents.get('one')).events.map(event=>event.data.text),['retry me']);
});
