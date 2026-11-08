import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SessionProjectionJournal} from '../../src/session/session-projection-journal.mjs';
import {readJournalDocument} from '../../src/session/journal-document.mjs';
import {workbenchPersistence} from '../../src/workbench/persistence.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
const header={version:4,id:'feedback-test',createdAt:1,isSeeded:false};
async function fixture(t,{restore,native,live=false}={}) {
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const llm=await load('dsh-llm');
  native??=[{seq:0,time:1,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,stream:[],
    message:llm.createAssistantMessage({content:[{type:'text',text:'Native reply'}],source:{provider:'test',model:'test'}})}}];
  let saved,saveFailure;
  const journal=new SessionProjectionJournal(ctx,api,{header},{restore:readJournalDocument(restore),native,
    save:async value=>{if(saveFailure)throw saveFailure;saved=structuredClone(value);}});
  if(!restore)journal.merge(native);
  const history={revision:()=>journal.revision,
    async metadata(id){if(id===header.id)return {id,created_at:1,selection_cursor:{kind:'durable',fact_seq:1,control_seq:0}};},
    async snapshot(){return {header,revision:String(journal.revision)};},
    async capture(){return journal.session;},owner:()=>({journal})};
  const errors=await load('dsh-session-persistence'),persistence=workbenchPersistence(history,errors);
  const session={id:header.id,header,snapshotEvents:()=>journal.session.snapshotEvents(),
    append:(...args)=>journal.append(...args)};
  ctx.provide('sessionPersistence',persistence);
  ctx.provide('sessions',{get:()=>live?session:undefined,async flush(){await journal.flush();return true;}});
  await (await ctx.plugin((await load('dsh-message-feedback')).default,{maxNoteBytes:8192})).await();
  return {ctx,journal,persistence,native,errors,saved:()=>saved,failWrites:error=>{saveFailure=error;},messageId:native[0].data.message.id};
}

for(const live of [false,true])test(`original feedback service persists ${live?'live':'cold'} ratings in the shared journal`,{skip:!root},async t=>{
  const first=await fixture(t,{live}),request={sessionId:header.id,messageId:first.messageId,rating:'negative',note:'Explain the result.',ifVersion:null};
  assert.deepEqual(await first.ctx.messageFeedback.list({sessionId:header.id}),{ok:true,value:{items:[]}});
  const rated=await first.ctx.messageFeedback.put(request);assert.equal(rated.ok,true);
  assert.equal(first.journal.seq,2);assert.equal(readJournalDocument(first.saved()).events.length,1,'only the app-owned feedback body is stored');
  const stale=await first.ctx.messageFeedback.put(request);assert.equal(stale.error.code,'version-conflict');assert.equal(first.journal.seq,2);
  const cold=await fixture(t,{native:first.native,restore:first.saved()});
  assert.deepEqual(await cold.ctx.messageFeedback.list({sessionId:header.id}),{ok:true,value:{items:[rated.value]}});
  const same=await cold.ctx.messageFeedback.put({...request,ifVersion:rated.value.version});assert.deepEqual(same,rated);assert.equal(cold.journal.seq,2);
  const removed=await cold.ctx.messageFeedback.delete({sessionId:header.id,messageId:first.messageId,ifVersion:rated.value.version});
  assert.deepEqual(removed,{ok:true,value:{absent:true}});
  const reopened=await fixture(t,{native:first.native,restore:cold.saved()});
  assert.deepEqual(await reopened.ctx.messageFeedback.list({sessionId:header.id}),{ok:true,value:{items:[]}});
  assert.equal(reopened.journal.session.deriveMessages().length,1,'feedback does not alter the conversation');
});

test('application write handles preserve ownership, atomic batches and the close durability barrier',{skip:!root},async t=>{
  const f=await fixture(t),{persistence,journal,errors}=f;
  for(let i=0;i<2;i++)await assert.rejects(persistence.open('missing','write'),errors.SessionPersistenceNotFoundError);
  const writer=await persistence.open(header.id,'write');
  await assert.rejects(persistence.open(header.id,'write'),errors.SessionAlreadyOwnedError);
  const reader=await persistence.open(header.id,'read');t.after(()=>reader.close());
  const original=(await reader.read()).events[0];
  const first={seq:1,time:20,type:'approval/policy',data:{policy:'ask'}};
  const second={seq:2,time:21,type:'approval/policy',data:{policy:'deny'}};
  await assert.rejects(writer.append([first,{...second,time:-1}]));assert.equal(journal.seq,1);
  await assert.rejects(writer.append([first],{signal:AbortSignal.abort()}));assert.equal(journal.seq,1);
  await assert.rejects(writer.append([{...first,type:'user/message'}]),/owning native command/);
  await writer.append([first,second]);
  const events=(await reader.read()).events;
  assert.equal(events[0],original);assert.deepEqual(events.slice(1),[first,second]);
  first.data.policy='caller mutation';assert.equal(events[1].data.policy,'ask');
  await assert.rejects(writer.append([second]),/continue the Session/);
  await writer.close();await writer.close();assert.equal(readJournalDocument(f.saved()).events.length,2);
  await assert.rejects(writer.append([]),errors.SessionHandleClosedError);
  const retry=await persistence.open(header.id,'write');
  await retry.append([{seq:3,time:22,type:'approval/policy',data:{policy:'ask'}}]);
  f.failWrites(Error('disk failure'));await assert.rejects(retry.close(),/disk failure/);
  f.failWrites(undefined);const next=await persistence.open(header.id,'write');await next.close();
  assert.equal(readJournalDocument(f.saved()).events.length,3,'a later barrier retries accepted but unflushed events');
});
