import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {readJournalDocument} from '../../src/session/journal-document.mjs';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {nativeInboxFixture} from '../fixtures/native-inbox-fixture.mjs';

test('the released log contributor resumes at the accepted prefix in a cold workbench Session', {
  skip:!process.env.RSI_DSH_MARKET_COHORT||!process.env.RSI_DSH_INBOX_SOURCE,
},async t=>{
  const require=createRequire(join(process.env.RSI_DSH_MARKET_COHORT,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const f=await nativeInboxFixture(t),session=f.agent.session;
  f.ctx.provide('sessions',{get:id=>id===session.id?session:undefined});
  await f.ctx.plugin((await load('dsh-deepseek-llm-api-extensions')).default);
  const upload=await load('dsh-session-log-deepseek');
  const prepare=()=>f.ctx.deepseekLlmApiExtensions.prepare({body:{model:'test'},sessionId:session.id,signal:new AbortController().signal});
  const disabled=f.ctx.plugin(upload,{enabled:false});await disabled;
  session.append('feedback/record',{text:'before enabling'});
  assert.deepEqual(Object.keys((await prepare()).fields),[]);
  await disabled.dispose();await f.ctx.plugin(upload,{enabled:true});
  const uncertain=await prepare(),confirmed=await prepare();
  const field=confirmed.fields.dsh_session_log;
  assert.deepEqual(field,uncertain.fields.dsh_session_log);
  assert.equal(field.afterSeq,-1);
  assert(field.events.some(event=>event.data.text==='before enabling'));
  await f.scope.runOwned(()=>confirmed.accept());
  await confirmed.accept();
  assert.equal(upload.acceptedThrough(session),field.throughSeq);
  await f.agents.flush(session);
  const api={...await load('dsh-session'),...await load('dsh-session/surface'),...await load('dsh-util-values')};
  const cold=new SessionProjectionJournal(f.ctx,api,{header:session.header},{restore:readJournalDocument(f.documents.get(session.id)),native:[]});
  assert.equal(upload.acceptedThrough(cold.session),field.throughSeq);
  assert.equal(cold.session.snapshotEvents().filter(event=>event.type==='session-log-deepseek/delivery-accepted').length,1);
  assert.equal((await prepare()).fields.dsh_session_log.afterSeq,field.throughSeq);
  assert.throws(()=>session.append('session-log-deepseek/delivery-accepted',{sessionId:session.id,throughSeq:session.seq}),/Invalid Session log acceptance/);
});
