import {toolPipeline} from '../../src/tools/tool-pipeline.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadCohort} from '../../../rsi-dsh-cordis/src/runtime/cohort.mjs';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {applicationTools} from '../../src/tools/application-tools.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('a released registry cannot dispatch a withdrawn registration after an asynchronous hook', {skip:!root},async()=>{
  const cohort=await loadCohort(root);
  const {Context}=await cohort.import('@deepseek-ai/cordis'), tools=await cohort.import('@deepseek-ai/dsh-tools');
  const ctx=new Context(), agent={id:'selection'},signal=AbortSignal.timeout(10000);
  const entered=Promise.withResolvers(), resume=Promise.withResolvers();
  try {
    await ctx.plugin((await cohort.import('@deepseek-ai/dsh-session-projection')).default);
    await ctx.plugin((await cohort.import('@deepseek-ai/dsh-system-prompt')).default);
    await (await ctx.plugin(tools.default)).await();
    const invoke=toolPipeline(ctx,await cohort.subpath('@deepseek-ai/dsh-tools','pipeline'),tools);
    let bodies=0;
    const definition=tools.defineTool({name:'sample',description:'sample',parameters:{},
      output:{schema:{type:'string'},render:(_,text)=>[{type:'text',text}]},
      async execute(){bodies++;return 'executed';}});
    const remove=ctx.tools.register(definition);
    ctx.on('tools/execute',async(exec,next)=>{
      if(exec.callId==='old') {entered.resolve();await resume.promise;}
      return next();
    });
    const old=await ctx.tools.resolve({agent,signal});
    assert.equal(old.view(agent).get('sample'),definition);
    const run=(callId,toolSet)=>invoke({callId,toolSet,agent,signal,name:'sample',arguments:{}});
    const pending=run('old',old);
    await entered.promise;remove();ctx.tools.register(definition);resume.resolve();
    assert.equal((await pending).error.info.code,'UNKNOWN_TOOL');
    assert.equal(old.view(agent).size,0);
    const next=await ctx.tools.resolve({agent,signal});
    assert.equal(next.view({id:'other'}).size,0);
    const swapped=await invoke({callId:'swapped',toolSet:next,agent:{id:'other'},signal,name:'sample',arguments:{}});
    assert.equal(swapped.error.info.code,'UNKNOWN_TOOL');
    assert.equal((await run('fresh',next)).value,'executed');
    next.dispose();
    assert.equal((await run('closed',next)).error.info.code,'UNKNOWN_TOOL');
    assert.equal(bodies,1);
  } finally {resume.resolve();await ctx.fiber.dispose();}
});

test('an admitted application call retains the original structured withdrawal result', {skip:!root},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-tool-withdrawal-'));
  const require=createRequire(join(root,'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
  const ctx=new (await load('@deepseek-ai/cordis')).Context(),tools=await load('@deepseek-ai/dsh-tools');
  const sessions=applicationSessions(()=>{throw Error('unexpected native Session access');});
  t.after(async()=>{await ctx.fiber.dispose();await sessions.close();await rm(directory,{recursive:true,force:true});});
  for(const name of ['dsh-session-projection','dsh-system-prompt','dsh-tools'])await ctx.plugin((await load('@deepseek-ai/'+name)).default);
  let calls=0;
  const definition=tools.defineTool({name:'withdrawn',description:'Withdrawn tool',parameters:{},
    output:{schema:{type:'number'},render:(_,value)=>[{type:'text',text:String(value)}]},execute(){return ++calls;}});
  const remove=ctx.tools.register(definition),key=randomUUID();
  const listener=await applicationTools(ctx,{key,generation:randomUUID(),directory,sessions,load});
  const results=[];
  ctx.on('tools/result',(exec,result)=>results.push([exec.callId,result.error?.info?.code]));
  const post=async(operation,input)=>{
    const response=await fetch('http://127.0.0.1:'+listener.port+'/v1/'+operation,{method:'POST',
      headers:{authorization:key,'content-type':'application/json'},body:JSON.stringify(input)});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const capture=()=>post('capture',{view:randomUUID(),header:{id:'withdrawal'},reserved:[],
    modelSelection:{provider:'fixture',model:'fixture'}});
  const input=view=>{
    const effect=randomUUID();return {session:'withdrawal',view:view.view,effect,name:'withdrawn',args:{},
      registration:view.tools[0].registration,identity:{owner_id:'owner',invocation_id:effect,
        call_id:randomUUID(),request_sha256:'a'.repeat(64)}};
  };
  const previous=await capture(),call=input(previous);
  remove();ctx.tools.register(definition);
  const failed=await post('start',call);
  assert.equal(failed.state,'settled');assert.equal(failed.result.is_error,true);
  assert.equal(failed.result.metadata?.dsh?.error?.code,'UNKNOWN_TOOL');
  assert.equal(calls,0,'same-name replacement cannot run through the withdrawn selection');
  assert.deepEqual(results,[[call.identity.call_id,'UNKNOWN_TOOL']]);
  await post('release',{view:previous.view});
  assert.deepEqual(await post('outcome',call),failed,'recovery preserves the original pipeline error');
  assert.equal(results.length,1,'receipt recovery does not notify plugin result observers again');
  const current=await capture(),succeeded=await post('start',input(current));
  assert.equal(succeeded.result.is_error,false);assert.equal(succeeded.result.value,1);
  assert.equal(results.length,2);
});
