import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {workbenchHistory} from '../../../src/workbench/history.mjs';
import {invocationDigest} from '../../../src/session/command-receipts.mjs';
import {contextIntent,contextRequest} from '../../../src/session/inbox/input-invocation.mjs';
import {inboxObservationProjection} from '../../../src/session/inbox/inbox-observations.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT,source=process.env.RSI_DSH_INBOX_SOURCE;
const enabled={skip:!root||!source};
const user=(id,text=id)=>({id,role:'user',source:{kind:'plugin:test'},content:[{type:'text',text},{type:'text',text:'second block'}]});
async function fixture(t) {
  const require=createRequire(join(root,'package.json')),load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const ctx=new (await load('cordis')).Context();t.after(()=>ctx.fiber.dispose());
  await ctx.plugin((await load('dsh-session-projection')).default);
  const directory=await mkdtemp(join(tmpdir(),'rsi-inbox-order-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const outfile=join(directory,'inbox.mjs');
  const {build}=await import('esbuild');
  await build({entryPoints:[source],outfile,bundle:true,format:'esm',platform:'node',
    nodePaths:[join(root,'node_modules')],logLevel:'silent'});
  ctx.sessionProjections.register((await import(pathToFileURL(outfile))).inboxProjectionDefinition);
  const api=Object.assign({},await load('dsh-session'),await load('dsh-session/surface'),await load('dsh-util-values'));
  const controls=[],messages=new Map(),documents=new Map(),baseline={model:{deployment:'native',model:'configured'}};
  const meta=()=>({id:'inbox',created_at:1,inherited:false,through:0,model_baseline:baseline,model_selection:baseline,
    selection_cursor:{kind:'durable',fact_seq:0,control_seq:controls.length}});
  const options={ctx,api,llm:await load('dsh-llm'),authorize:async()=>{},
    storage:{read:async id=>documents.get(id),save:async(id,value)=>{documents.set(id,value);}},
    async read(id,op) {
      assert.equal(id,'inbox');
      if(op.type==='open')return meta();
      if(op.type==='controls')return {through:op.through_seq,events:controls.filter(row=>row.seq>op.after_seq&&row.seq<=op.through_seq)};
      assert.equal(op.type,'message');const json=JSON.stringify(messages.get(op.message_id));
      return {through_seq:op.accepted_control_seq,offset:0,next_offset:Buffer.byteLength(json),total_bytes:Buffer.byteLength(json),json};
    }};
  const history=workbenchHistory(options);t.after(()=>history.close());
  const capture=()=>history.capture('inbox',meta()),session=await capture(),owner=history.owner(session),journal=owner.journal;
  const state=(value=session)=>ctx.sessionProjections.snapshot(value).values.inbox;
  const control=value=>controls.push({seq:controls.length+1,after_fact_seq:0,time:controls.length+10,...value});
  function accept(id,message) {
    const event=journal.accept(id,'agent/inbox/spliced',{target:'next-step',start:state()['next-step'].length,inserted:[message]}, {},1);
    journal.prepare(id,contextIntent('rsi.context-input.command',{kind:'durable',control_seq:controls.length},id,event));
    return event;
  }
  function acknowledgement(id) {
    const operation=journal.operation(id),invocation=contextRequest(operation,journal.session.eventAt(operation.seq)),
      digest=invocationDigest(invocation),nativeId=`command-${digest}-0`;
    const message=journal.session.eventAt(journal.operation(id).seq).data.inserted[0];
    messages.set(nativeId,{message_id:nativeId,source:{type:'command',source:{command:invocation.command,request_id:id,
      invocation_sha256:digest,ordinal:0,attribution:invocation.arguments.attribution}},content:message.content});
    control({kind:'accepted',message_id:nativeId,target:'next_step'});return nativeId;
  }
  function external(id,target='next_step') {
    messages.set(id,{message_id:id,source:{type:'human'},content:[{type:'text',text:id}]});
    control({kind:'accepted',message_id:id,target});
  }
  function remove(id,operation) {
    const start=state()['next-step'].findIndex(row=>row.id===id);assert.ok(start>=0);
    return journal.accept(operation,'agent/inbox/spliced',{target:'next-step',start,removedCount:1,inserted:[],outcome:'canceled'}, {},2);
  }
  async function cold() {
    const cold=workbenchHistory(options);t.after(()=>cold.close());
    const result=await cold.capture('inbox',meta());
    assert.deepEqual(result.snapshotEvents(),session.snapshotEvents());
    assert.deepEqual(state(result),state());return result;
  }
  return {session,owner,journal,capture,state,control,accept,acknowledgement,external,remove,cold,messages,controls};
}

test('the shared owner translates interleaved queue positions and aliases exact native acknowledgements',enabled,async t=>{
  const f=await fixture(t),first=f.accept('first',user('原始 id'));
  f.external('external-first');await f.capture();
  assert.deepEqual(f.state()['next-step'].map(row=>row.id),['external-first','原始 id']);
  const nativeFirst=f.acknowledgement('first');await f.capture();
  assert.equal(f.owner.source.current.session.eventAt(1).data.start,1);
  assert.equal(first.data.start,0);assert.equal(f.session.eventAt(first.seq),first);
  assert.equal(f.session.seq,2,'native acceptance does not publish a second insertion');
  const second=f.accept('second',user('second'));
  f.external('external-between');await f.capture();
  f.acknowledgement('second');await f.capture();
  assert.deepEqual(f.state()['next-step'].map(row=>row.id),['external-first','原始 id','external-between','second']);
  assert.equal(f.session.eventAt(second.seq),second);
  f.control({kind:'discarded',message_id:'external-first'});
  f.control({kind:'claimed',message_id:nativeFirst});await f.capture();
  assert.deepEqual(f.state()['next-step'].map(row=>row.id),['external-between','second']);
  await f.cold();
});

test('withdrawal, native promotion and a late claim cannot resurrect input or consume a reused presentation ID',enabled,async t=>{
  const f=await fixture(t);f.accept('old',user('reused','old input'));
  const old=f.acknowledgement('old');await f.capture();
  const withdrawn=f.remove('reused','withdraw-old'),replacement=f.accept('new',user('reused','new input'));
  f.control({kind:'promoted',message_id:old});await f.capture();
  assert.deepEqual(f.state()['next-turn'],[]);
  f.external('other','next_turn');f.control({kind:'claimed',message_id:old});await f.capture();
  assert.equal(f.state()['next-step'][0].content[0].text,'new input');
  f.acknowledgement('new');await f.capture();
  const claims=[...f.owner.input.notifications().values()].flat().filter(row=>row.type==='agent/inbox/claimed');
  assert.equal(claims.length,1);assert.equal(claims[0].data.message.content[0].text,'old input');
  assert.equal(f.session.eventAt(withdrawn.seq),withdrawn);assert.equal(f.session.eventAt(replacement.seq),replacement);
  await f.cold();
});

test('already withdrawn native input produces no second discarded notification',enabled,async t=>{
  const f=await fixture(t);f.accept('input',user('input'));const native=f.acknowledgement('input');await f.capture();
  f.remove('input','remove');f.control({kind:'discarded',message_id:native});await f.capture();
  assert.deepEqual(f.state(),{'next-step':[],'next-turn':[]});
  const discarded=[...f.owner.input.notifications().entries()].filter(([,rows])=>rows.some(row=>row.type==='agent/inbox/discarded'));
  assert.equal(discarded.length,1,'the local withdrawal emits once; its native no-op emits nothing');
  assert.equal(discarded[0][0],f.journal.operation('remove').seq);
  assert.deepEqual(f.session.lastEvent('agent/inbox/spliced').data,{target:'next-step',start:0,inserted:[]});
  await f.cold();
});

test('withdrawal before acknowledgement remains removed when acceptance and claim arrive in one batch',enabled,async t=>{
  const f=await fixture(t);f.accept('old',user('same','old'));
  f.remove('same','remove-old');f.accept('new',user('same','new'));
  const old=f.acknowledgement('old');f.control({kind:'claimed',message_id:old});f.acknowledgement('new');
  await f.capture();assert.equal(f.state()['next-step'].length,1);
  assert.equal(f.state()['next-step'][0].content[0].text,'new');
  assert.equal(f.session.snapshotEvents().filter(event=>event.data.inserted?.length).length,2);
  await f.cold();
});

test('an acceptance with altered command provenance or content cannot acknowledge a local insertion',enabled,async t=>{
  const f=await fixture(t);f.accept('input',user('input'));const native=f.acknowledgement('input');
  const before=f.journal.encode(),message=f.messages.get(native),provenance=message.source.source;
  provenance.ordinal=1;
  await assert.rejects(f.capture(),/prepared application input/);
  assert.equal(f.journal.encode(),before);assert.equal(f.owner.source.current.controlThrough,0);
  provenance.ordinal=0;message.content=message.content.map((part,index)=>index?part:{...part,text:'changed'});
  await assert.rejects(f.capture(),/prepared application input/);
  assert.equal(f.journal.encode(),before);message.content=f.session.eventAt(0).data.inserted[0].content;
  await f.capture();assert.equal(f.session.seq,1);await f.cold();
});

test('cold verification hashes the native splice before coordinate translation',enabled,async t=>{
  const f=await fixture(t);f.accept('input',user('input'));f.external('external');f.acknowledgement('input');await f.capture();
  const events=f.owner.source.current.session.snapshotEvents(),before=f.journal.encode();
  const {projections,correlations}=inboxObservationProjection(f.journal,events,f.owner.source.current.inbox.transitions);
  const changed=structuredClone(events);changed[1].data.start=999;
  assert.throws(()=>f.journal.merge(changed,correlations,0,projections),/Native event prefix changed/);
  assert.equal(f.journal.encode(),before);await f.cold();
});
