import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createApplication} from '../../src/application/application.mjs';
import {createBridge} from '../../src/index.mjs';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT, entry=process.env.RSI_DSH_MODS_ENTRY;
const name='@deepseek-ai/dsh-experimental-claude-code-mods';
async function temporaryApplication(t) {
  const profile=await mkdtemp(join(tmpdir(),'rsi-mods-contract-'));
  const require=createRequire(join(root,'package.json'));
  let app;
  t.after(async()=>{
    try { await app?.close(); }
    finally { await rm(profile,{force:true,recursive:true}); }
  });
  app=await createApplication({profile,provide:async()=>{},
    modules:{entry:id=>id===name?entry:require.resolve(id)}});
  return app;
}
test('the published Claude Code Mods reports the missing working-directory service', {skip:!root || !entry},async t=>{
  const app=await temporaryApplication(t);
  await assert.rejects(app.reconcile([{insert:[{id:'mods',name}]}]),error=>
    error.message.includes(name) && error.message.includes('workingDirectory'));
  // Reconciliation can still use the previous selection after rejection.
  await app.reconcile([]);
});

test('restoring a pending bundle retains its diagnosis and the healthy fibers', {skip:!root || !entry},async t=>{
  const app=await temporaryApplication(t);
  const rows=[{id:'pending-mods',name},{id:'projection',name:'@deepseek-ai/dsh-session-projection'}];
  const initial=await app.reconcile([{insert:rows}],{restore:true});
  assert.ok(initial.some(message=>message.includes('pending-mods')&&message.includes('workingDirectory')),JSON.stringify(initial));
  assert.ok(app.ctx.get('sessionProjections'));
  await app.reconcile([{insert:[...rows,{id:'system',name:'@deepseek-ai/dsh-system-prompt'}]}]);
  assert.ok(app.ctx.get('systemPrompt'));
  await assert.rejects(app.reconcile([{insert:[...rows,{id:'new-pending',name}]}]));
  assert.ok(app.ctx.get('sessionProjections'));
});

test('a released Claude Code Mod can deny the original DSH Todo before its body', {skip:!root || !entry},async t=>{
  const original=await loadCohort(root),mods=await import(pathToFileURL(entry)),calls=[];
  const guard='@test/mod-guard';
  const definition=mods.defineMod({name:'deny-todo',register(on) {
    on('tool.call',(_api,input)=>{
      calls.push(input.tool_use_id);
      return {deny:'denied by the fixture mod'};
    });
  }});
  const cohort={...original,import:id=>id===name?mods:id===guard?{default:definition}:original.import(id)};
  const bridge=await createBridge({cohortRoot:root,cohortLoader:async()=>cohort,
    configuration:{format:1,plugins:[name,guard]}});
  t.after(()=>bridge.close());
  const id='mods-denied';
  await bridge.load({header:{version:4,id,createdAt:1,isSeeded:false,cwd:root},events:[],revision:0});
  const result=await bridge.tool(id,'deny-original-todo','todo_write',{todos:[{content:'must not run',status:'completed'}]});
  assert.deepEqual(calls,['deny-original-todo']);
  assert.match(JSON.stringify(result.payload.result),/denied by the fixture mod/);
  await bridge.receipt(id,'deny-original-todo',result.token,'committed',1);
  assert.equal(bridge.project(id).values.todos,null);
});

test('a published Mods fiber activates in the Agent bridge with the canonical local working directory', {skip:!root || !entry},async t=>{
  const original=await loadCohort(root);
  const observed=new Map(),probe='@test/working-directory';
  const cohort={...original,import:id=>id===name?import(pathToFileURL(entry)):id===probe?{default(ctx) {
    ctx.on('tools/execute',async(exec,next)=>{
      try {observed.set(exec.agent.id,await ctx.workingDirectory.ensure(exec.agent,exec.signal));}
      catch(error) {observed.set(exec.agent.id,error.message);}
      if(exec.agent.id==='mods-local') {
        assert.equal(await ctx.workingDirectory.set(exec.agent,'.',exec.signal),root);
        await assert.rejects(ctx.workingDirectory.set(exec.agent,'..',exec.signal),/requires a new Session/);
      }
      return next();
    });
  }}:original.import(id)};
  const bridge=await createBridge({cohortRoot:root,cohortLoader:async()=>cohort,
    configuration:{format:1,plugins:[name,probe]}});
  t.after(()=>bridge.close());
  bridge.beginAgentLoad({session_id:'mods-local',created_at:1,local_cwd:root,revision:0,count:0});
  await bridge.finishAgentLoad({session_id:'mods-local',checkpoint:null});
  assert.equal(bridge.canonical('mods-local').header.cwd,root);
  bridge.beginAgentLoad({session_id:'mods-remote',created_at:1,local_cwd:null,revision:0,count:0});
  await bridge.finishAgentLoad({session_id:'mods-remote',checkpoint:null});
  assert.equal(bridge.canonical('mods-remote').header.cwd,undefined);
  for(const id of ['mods-local','mods-remote']) {
    const staged=await bridge.tool(id,'cwd-'+id,'todo_write',{todos:[{content:'Check cwd',status:'completed'}]});
    assert.equal(staged.payload.result.value?.counts?.completed,1,JSON.stringify(staged.payload.result));
    await bridge.receipt(id,'cwd-'+id,staged.token,'committed',1);
  }
  assert.equal(observed.get('mods-local'),root);
  assert.match(observed.get('mods-remote'),/no available local working directory/);
});
test('an original prompt.submit drop stages journal changes and consumes no Step input', {skip:!root || !entry},async t=>{
  const original = await loadCohort(root);
  const mods = await import(pathToFileURL(entry));
  const calls = [];
  const mod = mods.defineMod({name:'reject-preset-input', register(on) {
    on('prompt.submit', (_, event) => { calls.push(event.text); return {drop:'refused by test mod'}; });
  }});
  const observer = ctx => ctx.on('agent/pre-step', async ({agent, modelSelection}, next) => {
    const result = await next();
    if (result.kind === 'reject') agent.session.append('todo/write', {todos:[{
      content:modelSelection.provider+'/'+modelSelection.model+'/'+modelSelection.reasoningEffort, status:'completed',
    }]});
    return result;
  });
  const cohort = {...original, import: id => {
    if (id === name) return mods;
    if (id === '@test/reject') return {default:mod};
    if (id === '@test/observe') return {default:observer};
    return original.import(id);
  }};
  const facts = [{seq:1,timestamp_ms:1,type:'turn_accepted',turn_id:'t',text:'drop me'},
    {seq:2,timestamp_ms:2,type:'step_started',turn_id:'t',step_id:'s'}];
  const options = {cohortRoot:root, cohortLoader:async()=>cohort,
    configuration:{format:1,plugins:['@test/observe',name,'@test/reject']},
    request: async (_, {after_seq}) => {
      const fact=facts[after_seq], json=JSON.stringify([fact]), bytes=Buffer.byteLength(json);
      return {through_seq:fact.seq,offset:0,next_offset:bytes,total_bytes:bytes,json};
    }};
  let bridge=await createBridge(options);
  t.after(()=>bridge.close());
  const id='reject-preset', header={version:4,id,createdAt:1,isSeeded:false,cwd:root};
  await bridge.load({header,events:[],revision:0});
  const response=await bridge.agentBeforeStep({session_id:id,operation_id:'reject',turn_id:'t',step_id:'s',tools:[],
    fact_horizon:2,model_selection:{model:{deployment:'native',model:'model'},reasoning_effort:'high'}});
  assert.equal(response.kind,'staged',response.diagnostic);
  assert.deepEqual(response.decision,{kind:'reject'});
  assert.equal(bridge.project(id).values.todos,null);
  await bridge.receipt(id,'reject',response.token,'committed',1);
  await bridge.receipt(id,'reject',response.token,'committed',1);
  const snapshot=bridge.canonical(id);
  await bridge.close(); bridge=await createBridge(options);
  await bridge.load(snapshot);
  assert.deepEqual(bridge.project(id).values.todos,[{content:'native/model/high',status:'completed'}]);
  assert.deepEqual(calls,['drop me']);
});

test('standalone pre-step can omit, duplicate, replace and reorder claimed inputs around native guidance',
  {skip:!root}, async t=>{
    const original=await loadCohort(root);
    const plugin='@test/reorder';
    const facts=['first','second','third','guide'].map((text,index)=>({
      seq:index+2,timestamp_ms:2,type:'input_message_claimed',turn_id:'t',step_id:'s',
      source:index===3 ? {type:'plugin_context',contribution_id:'native'} : {type:'human',message_id:text},
      content:[{type:'text',text}],
    }));
    facts.unshift({seq:1,timestamp_ms:1,type:'step_started',turn_id:'t',step_id:'s'});
    const cohort={...original,import:id=>id!==plugin?original.import(id):{default(ctx){
      ctx.on('agent/pre-step',async({messages},next)=>{
        await next();
        const [first,,third]=messages;
        return {kind:'enter',messages:[third,{...first,content:[]},third]};
      });
    }}};
    const bridge=await createBridge({cohortRoot:root,cohortLoader:async()=>cohort,configuration:{format:1,plugins:[plugin]},
      request:async(method,{after_seq,through_seq,offset})=>{
        assert.equal(method,'agent.history.read'); const json=JSON.stringify(facts.slice(after_seq,through_seq));
        const bytes=Buffer.byteLength(json);return {through_seq,offset,next_offset:bytes,total_bytes:bytes,json};
      }});
    t.after(()=>bridge.close());
    await bridge.load({header:{version:4,id:'edit',createdAt:1,isSeeded:false},events:[],revision:0});
    const result=await bridge.agentBeforeStep({session_id:'edit',operation_id:'reorder',turn_id:'t',step_id:'s',tools:[],
      fact_horizon:5,model_selection:{model:{deployment:'fixture',model:'test'}}});
    assert.equal(result.kind,'staged',result.diagnostic);
    assert.deepEqual(result.decision.messages.map(row=>[row.kind,row.claim.fact_seq]),
      [['claimed',4],['replacement',2],['claimed',4],['claimed',5]]);
    assert.deepEqual(result.decision.messages[1].message.content,[]);
  });

test('large upstream and downstream decisions use UTF-8 fragments only while their operation owns them',
  {skip:!root},async t=>{
    const text='界🚀'.repeat(110000);
    const previous={kind:'enter',messages:['one','two'].map(id=>({kind:'added',message:{
      role:'user',attribution:{id,source:{kind:'foreign'}},content:[{type:'text',text}]}}))};
    const data=Buffer.from(JSON.stringify(previous)), reads=[];
    assert.ok(data.length>1024*1024);
    const bridge=await createBridge({cohortRoot:root,request:async(method,{offset})=>{
      assert.equal(method,'agent.step-decision.read'); reads.push(offset);
      let end=Math.min(data.length,offset+128*1024);
      while(end<data.length && (data[end]&0xc0)===0x80) end--;
      return data.toString('utf8',offset,end);
    }});
    t.after(()=>bridge.close());
    const id='large-previous',operation='edit';
    await bridge.load({header:{version:4,id,createdAt:1,isSeeded:false},events:[],revision:0});
    const result=await bridge.agentBeforeStep({session_id:id,operation_id:operation,
      turn_id:'t',step_id:'s',tools:[],previous:{bytes:data.length},
      model_selection:{model:{deployment:'fixture',model:'test'}}});
    assert.equal(result.kind,'staged',result.diagnostic);
    assert.ok(reads.length>1);
    const args={session_id:id,operation_id:operation,token:result.token};
    assert.throws(()=>bridge.readStepDecision({...args,token:'other',offset:0}));
    const parts=[];
    for(let offset=0;offset<result.decision.bytes;){
      const part=bridge.readStepDecision({...args,offset});parts.push(part);offset+=Buffer.byteLength(part);
    }
    assert.deepEqual(JSON.parse(parts.join('')),previous);
    await bridge.receipt(id,operation,result.token,'rejected',0);
    assert.throws(()=>bridge.readStepDecision({...args,offset:0}));
  });
