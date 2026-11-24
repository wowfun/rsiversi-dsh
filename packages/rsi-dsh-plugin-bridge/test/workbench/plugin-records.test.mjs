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
      assert.throws(()=>sdk.appendPluginRecord(session,type,{}),/during publication/);
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
  const state=readJournalDocument(f.documents.get('one'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const api={...sdk,...await load('dsh-session/surface'),...await load('dsh-util-values')};
  const cold=new SessionProjectionJournal(f.ctx,api,{header:session.header},{restore:state,native:[]});
  assert.deepEqual(cold.session.eventAt(start),event);
  assert.equal(cold.seq,start+1);
});
