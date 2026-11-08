import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {searchDistribution} from './distribution.mjs';
import {createApplication} from '../../packages/rsi-dsh-plugin-bridge/src/application/application.mjs';
import {applicationSessions} from '../../packages/rsi-dsh-plugin-bridge/src/application/sessions.mjs';
import {applicationTools} from '../../packages/rsi-dsh-plugin-bridge/src/tools/application-tools.mjs';
import {SessionFacade} from '../../packages/rsi-dsh-plugin-bridge/src/session/session.mjs';
import {workbenchPersistence} from '../../packages/rsi-dsh-plugin-bridge/src/workbench/persistence.mjs';

export const toolNames=['session_search','session_event_search','session_trace','session_event_trace','session_event_read'];

/** Adapter fixture: native metadata/history callbacks use synthetic memory state.
 * The original side uses the distribution's JSONL backend. Neither is a Host benchmark. */
export async function searchRuntime({cohort,profile,corpus,kind,callerLog}) {
  await mkdir(profile,{recursive:true});
  const {modules,load,patches,version}=await searchDistribution(cohort);
  const api={...await load('@deepseek-ai/dsh-session'),...await load('@deepseek-ai/dsh-session/surface'),...await load('@deepseek-ai/dsh-util-values')};
  const llm=await load('@deepseek-ai/dsh-llm');
  const cold=new Map(),counters={metadata:0,capture:0,pages:0};
  let caller,app,detach,world,persistence,selection,post;
  const meta=id=>{const session=cold.get(id);return session&&{id,created_at:session.header.createdAt,
    selection_cursor:{kind:'durable',fact_seq:session.seq,control_seq:0}};};
  const snapshot=meta=>({header:cold.get(meta.id).header,formatStatus:'current',revision:String(meta.selection_cursor.fact_seq)});
  const scope=applicationSessions(async(method,args)=>{
    assert.equal(method,'application.sessions');assert.equal(args.history,true);counters.pages++;
    const start=Number(args.after??0),items=[...cold.keys()].slice(start,start+64).map(meta);
    return {items,next:start+items.length<cold.size?String(start+items.length):null};
  },{owner:'search-fixture',attached:()=>caller?[caller]:[],agent:id=>id===caller?.id?{session:caller}:undefined});
  try {
    app=await createApplication({profile,modules,provide:async ctx=>{
      for(const name of ['dsh-session-projection','dsh-system-prompt','dsh-tools'])
        await ctx.plugin((await load('@deepseek-ai/'+name)).default);
      await ctx.plugin((await load('@deepseek-ai/dsh-agent')).AgentRegistry);
      if(kind==='original') {
        await ctx.plugin(api.default);
        await ctx.plugin(await load('@deepseek-ai/dsh-session-persistence-jsonl'),{root:join(profile,'sessions'),compression:'none'});
        await ctx.plugin(await load('@deepseek-ai/dsh-tool-executor-native'));
        persistence=ctx.sessionPersistence;
      } else {
        ctx.provide('sessions',scope.sessions);
        persistence=workbenchPersistence({
          async metadata(id,signal){signal?.throwIfAborted();counters.metadata++;return meta(id);},
          async stored(id,signal){return {meta:await this.metadata(id,signal)};},
          async capture(id){counters.capture++;return cold.get(id);},snapshot,
        },await load('@deepseek-ai/dsh-session-persistence'),scope.storedPages);
        ctx.provide('sessionPersistence',persistence);
      }
    }});
    for(const row of corpus) {
      if(kind==='original') {
        const writer=await persistence.create(row.header,{inheritedEventCount:row.inheritedEventCount??0});
        try {await writer.append(row.events);}finally{await writer.close();}
      }else cold.set(row.header.id,new SessionFacade(app.ctx,api,row,false));
    }
    assert.deepEqual(await app.reconcile(patches),[]);
    if(kind==='original') {
      if(callerLog)caller=app.ctx.sessions.create(callerLog.header.id,{seed:callerLog.events,meta:callerLog.header,
        inheritedEventCount:callerLog.inheritedEventCount??0});
      else {
        caller=app.ctx.sessions.create('caller',{meta:{createdAt:1000,cwd:corpus[0].header.cwd}});
        caller.append('turn/start',{turn:1});
        caller.append('user/message',llm.createUserMessage({content:[{type:'text',text:'priorvisible marker'}],source:{kind:'user'}}),{surfaceOp:'append'});
        caller.append('step/start',{turn:1,step:1});
        caller.append('user/message',llm.createUserMessage({content:[{type:'text',text:'performinghidden marker'}],source:{kind:'user'}}),{surfaceOp:'append'});
      }
    }else caller=new SessionFacade(app.ctx,api,callerLog);
    const agent={id:caller.id,session:caller,inbox:{nextStep:[]}};
    world=(await load('@deepseek-ai/dsh-scope')).createScope(app.ctx,agent);agent.ctx=world.ctx;
    detach=app.ctx.agents.enter(agent);
    let pipeline;
    if(kind==='bridge') {
      const key=randomUUID();
      const {port}=await applicationTools(app.ctx,{load,key,generation:randomUUID(),directory:join(profile,'outcomes'),
        sessions:scope,resolveAgent:id=>id===agent.id?agent:undefined});
      post=async(operation,input,signal)=>{
        const response=await fetch('http://127.0.0.1:'+port+'/v1/'+operation,{method:'POST',
          headers:{authorization:key,'content-type':'application/json'},body:JSON.stringify(input),signal});
        const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
      };
      selection=await post('capture',{view:randomUUID(),header:caller.header,reserved:[],modelSelection:{provider:'fixture',model:'fixture'}});
      assert.deepEqual(new Set(selection.tools.map(row=>row.definition.name)),new Set(toolNames));
    }else pipeline=new (await load('@deepseek-ai/dsh-tools/pipeline')).ToolExecutionPipeline(app.ctx);
    return {version,counters,caller,app,async reopen(){
      if(post)await post('release',{view:selection.view});
      await app.reconcile([]);await app.reconcile(patches);
      if(post)selection=await post('capture',{view:randomUUID(),header:caller.header,reserved:[],modelSelection:{provider:'fixture',model:'fixture'}});
    },async execute(name,args,signal=new AbortController().signal){
      if(kind==='bridge') {
        const effect=randomUUID();
        const input={session:caller.id,view:selection.view,effect,name,args,
          registration:selection.tools.find(row=>row.definition.name===name).registration,
          identity:{owner_id:'search-fixture',invocation_id:effect,call_id:randomUUID(),request_sha256:'a'.repeat(64)}};
        const {result}=await post('start',input,signal);
        return {isError:result.is_error,content:result.content};
      }
      const prepared=await pipeline.prepare({agent,name,arguments:args,callId:randomUUID(),signal});
      const outcome=prepared.kind==='dispatch'?await pipeline.dispatch(prepared.exec):prepared;
      const result=await pipeline.complete(prepared.exec,outcome);
      return {isError:result.isError,content:result.content};
    },async append(id,event){
      if(kind==='original') {const writer=await persistence.open(id,'write');try{await writer.append([event]);}finally{await writer.close();}}
      else {const session=cold.get(id);session.begin();try{
        session.appendObserved(event.type,event.data,event.time,{surfaceOp:event.surfaceOp});
      }finally{session.end();}}
    },async close(){
      await world.dispose();detach();await app.close();await scope.close();
    }};
  }catch(error){await world?.dispose();detach?.();await app?.close();await scope.close();throw error;}
}
