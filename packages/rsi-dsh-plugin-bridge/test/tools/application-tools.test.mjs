import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {applicationTools} from '../../src/tools/application-tools.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
const nativeSelection={provider:'native',model:'selected',reasoningEffort:'low'};

test('original application policy allows by default, asks once when requested and preserves denial and guards',
  {skip:!root,timeout:30000},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'rsi-tool-policy-'));
    const require=createRequire(join(root,'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
    const ctx=new (await load('@deepseek-ai/cordis')).Context(),tools=await load('@deepseek-ai/dsh-tools');
    for(const name of ['dsh-session-projection','dsh-system-prompt'])await ctx.plugin((await load('@deepseek-ai/'+name)).default);
    await ctx.plugin(tools.default);
    const sessions=applicationSessions(()=>{throw Error('policy should not read another native Session');});
    let decision,guardDenied=false,invalidOutput=false,asks=0,calls=0,answer='allowed-once',outputChecks=0;
    ctx.provide('approval',{async request(input){assert.equal(input.toolName,'policy_probe');asks++;return answer;}});
    ctx.on('tools/pre-execute',(_,next)=>decision??next());
    ctx.tools.guard(()=>guardDenied?'local guard denied':undefined);
    ctx.tools.register(tools.defineTool({name:'policy_probe',description:'Count actual body execution',parameters:{},
      output:{schema:{type:'number'},render:(_,value)=>[{type:'text',text:String(value)}]},execute(){calls++;return invalidOutput?'invalid number':calls;}}));
    const countedLoad=async name=>name==='@deepseek-ai/dsh-tools'?{...tools,validateJsonSchemaValue(schema,...args){
      if(schema.type==='number')outputChecks++;return tools.validateJsonSchemaValue(schema,...args);
    }}:load(name);
    const key=randomUUID(),listener=await applicationTools(ctx,{load:countedLoad,key,generation:randomUUID(),directory,sessions});
    t.after(async()=>{await ctx.fiber.dispose();await sessions.close();await rm(directory,{recursive:true,force:true});});
    const post=async(path,input)=>{
      const response=await fetch('http://127.0.0.1:'+listener.port+'/v1/'+path,{method:'POST',headers:{authorization:key,'content-type':'application/json'},body:JSON.stringify(input)});
      const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
    };
    const capture=await post('capture',{view:randomUUID(),header:{id:'policy',cwd:directory},reserved:[],modelSelection:nativeSelection});
    const invoke=async()=>{
      const effect=randomUUID(),input={view:capture.view,session:'policy',effect,name:'policy_probe',args:{},registration:capture.tools[0].registration,
        identity:{owner_id:'policy',invocation_id:effect,call_id:randomUUID(),request_sha256:'a'.repeat(64)}};
      const outcome=await post('start',input);
      assert.equal(outcome.state,'settled');return outcome.result;
    };
    assert.equal((await invoke()).is_error,false);assert.equal(asks,0);assert.equal(calls,1);
    decision={kind:'ask',reason:'installed policy'};
    assert.equal((await invoke()).is_error,false);assert.equal(asks,1);assert.equal(calls,2);
    answer='rejected';
    assert.equal((await invoke()).is_error,true);assert.equal(asks,2);assert.equal(calls,2);
    decision={kind:'deny',reason:'installed denial'};
    assert.equal((await invoke()).is_error,true);assert.equal(asks,2);assert.equal(calls,2);
    decision=undefined;guardDenied=true;
    assert.equal((await invoke()).is_error,true);assert.equal(asks,2);assert.equal(calls,2);
    guardDenied=false;invalidOutput=true;
    const invalid=await invoke();assert.equal(invalid.is_error,true);assert.equal(calls,3);
    assert.match(JSON.stringify(invalid.content),/number|output|contract/i);
    assert.equal(outputChecks,0,'The original pipeline owns output validation; the bridge does not repeat it');
  });

test('original model-dependent activation uses the native request choice instead of the live Agent choice',
  {skip:!process.env.RSI_DSH_SOURCE_COHORT},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'rsi-model-tools-'));
    const require=createRequire(join(process.env.RSI_DSH_SOURCE_COHORT,'package.json'));
    const load=name=>import(pathToFileURL(require.resolve(name)));
    const ctx=new (await load('@deepseek-ai/cordis')).Context(),tools=await load('@deepseek-ai/dsh-tools');
    for(const name of ['dsh-session-projection','dsh-system-prompt'])await ctx.plugin((await load('@deepseek-ai/'+name)).default);
    await ctx.plugin(tools.default);
    const agent={id:'selected',ctx,session:{id:'selected',header:{id:'selected',cwd:directory}},
      options:{provider:'stale',model:'unrelated',reasoningEffort:'low'}};
    const seen=[];
    for(const model of ['first','second'])ctx.tools.register(tools.defineTool({name:'for_'+model,description:'Selected model tool',parameters:{},
      output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute(){return model;}}),{
      when(context){
        assert.equal(context.agent,agent);seen.push(context.modelSelection);
        return context.modelSelection.provider==='native'&&context.modelSelection.model===model&&context.modelSelection.reasoningEffort==='high';
      },
    });
    const sessions=applicationSessions(()=>{throw Error('capture must not infer selection from another native request');});
    const key=randomUUID(),listener=await applicationTools(ctx,{load,key,generation:randomUUID(),directory,sessions,resolveAgent:async()=>agent});
    assert.equal(listener.protocol,10);
    t.after(async()=>{await ctx.fiber.dispose();await sessions.close();await rm(directory,{recursive:true,force:true});});
    const post=async input=>{
      const response=await fetch('http://127.0.0.1:'+listener.port+'/v1/capture',{method:'POST',headers:{authorization:key,'content-type':'application/json'},
        body:JSON.stringify({view:randomUUID(),header:agent.session.header,reserved:[],...input})});
      return {status:response.status,value:await response.json()};
    };
    assert.equal((await post({})).status,400);
    assert.equal((await post({modelSelection:{provider:'native',model:'first',reasoningEffort:null}})).status,400);
    for(const model of ['first','second']){
      const modelSelection={provider:'native',model,reasoningEffort:'high'};
      const reply=await post({modelSelection});assert.equal(reply.status,200,JSON.stringify(reply.value));
      assert.deepEqual(reply.value.tools.map(row=>row.definition.name),['for_'+model]);
      assert.deepEqual(seen.slice(-2),[modelSelection,modelSelection]);
    }
  });

test('native tool capture uses the owned Agent scope and waits for its native writes',{skip:!root},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rsi-owned-tools-'));
  const require=createRequire(join(root,'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
  const ctx=new (await load('@deepseek-ai/cordis')).Context(),tools=await load('@deepseek-ai/dsh-tools');
  for(const name of ['dsh-session-projection','dsh-system-prompt'])await ctx.plugin((await load('@deepseek-ai/'+name)).default);
  await ctx.plugin(tools.default);
  const entered=Promise.withResolvers(),released=Promise.withResolvers();
  const sessions=applicationSessions(async(method,args)=>{
    assert.equal(method,'application.command');assert.equal(args.request,'native-owner');
    entered.resolve();await released.promise;return {committed:true};
  },{owner:'native-owner'});
  const agent={id:'owned',session:{id:'owned',header:{id:'owned',cwd:directory}}};
  const world=(await load('@deepseek-ai/dsh-scope')).createScope(ctx,agent);agent.ctx=world.ctx;
  let assemblies=0;
  ctx.systemPrompt.section({name:'global-proof',order:100,text:'GLOBAL_SYSTEM_PROOF'});
  const other=(await load('@deepseek-ai/dsh-scope')).createScope(ctx,{id:'other'});
  await other.ctx.plugin({inject:['systemPrompt'],apply(ctx){
    ctx.systemPrompt.section({name:'scoped-proof',order:101,text:'OTHER_AGENT_PROOF'});
  }});
  await world.ctx.plugin({inject:['systemPrompt'],apply(ctx){
    ctx.systemPrompt.variable('native_model',context=>{
      assert.equal(context.agent,agent);assert.equal(context.scope,agent);
      assert.deepEqual([...context.toolSet.view(agent).keys()],['scoped_probe']);
      assemblies++;return context.modelSelection.model;
    });
    ctx.systemPrompt.section({name:'scoped-proof',order:101,text:'SCOPED_SYSTEM_{{native_model}}'});
    ctx.on('system-prompt/assemble',async(_,context,next)=>{
      assert.equal(context.agent,agent);
      const result=await next();return {...result,sections:[...result.sections,{name:'waterfall-proof',text:'ORIGINAL_ASSEMBLY_WATERFALL'}]};
    });
  }});
  await world.ctx.plugin({inject:['tools'],apply(ctx){ctx.tools.register(tools.defineTool({name:'scoped_probe',description:'Scoped native probe',parameters:{},
    output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute(_,exec){
      assert.equal(exec.agent,agent);assert.equal(exec.agent.ctx,world.ctx);
      sessions.stage(signal=>sessions.command(agent.id,{type:'status'},signal));return 'committed';
    }}));}});
  const key=randomUUID(),{port}=await applicationTools(ctx,{load,key,generation:randomUUID(),directory,sessions,
    resolveAgent:async id=>{assert.equal(id,agent.id);return agent;}});
  t.after(async()=>{released.resolve();await ctx.fiber.dispose();await sessions.close();await rm(directory,{recursive:true,force:true});});
  const post=async(path,input)=>{
    const response=await fetch('http://127.0.0.1:'+port+'/v1/'+path,{method:'POST',headers:{authorization:key,'content-type':'application/json'},body:JSON.stringify(input)});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const capture=await post('capture',{view:randomUUID(),header:agent.session.header,reserved:[],modelSelection:nativeSelection});
  assert.deepEqual(capture.tools.map(row=>row.definition.name),['scoped_probe']);
  assert.equal(assemblies,1);
  assert.ok(capture.instructions.includes('GLOBAL_SYSTEM_PROOF\n\nSCOPED_SYSTEM_selected\n\nORIGINAL_ASSEMBLY_WATERFALL'));
  assert.ok(!capture.instructions.includes('OTHER_AGENT_PROOF'));
  const later=await post('capture',{view:randomUUID(),header:agent.session.header,reserved:[],modelSelection:{...nativeSelection,model:'later'}});
  assert.equal(assemblies,2);assert.ok(later.instructions.includes('SCOPED_SYSTEM_later'));
  assert.ok(!later.instructions.includes('SCOPED_SYSTEM_selected'));
  const effect=randomUUID(),input={view:capture.view,session:agent.id,effect,name:'scoped_probe',args:{},
    registration:capture.tools[0].registration,identity:{owner_id:'owned-probe',invocation_id:effect,
      call_id:randomUUID(),request_sha256:'b'.repeat(64)}};
  const started=post('start',input);await entered.promise;
  assert.equal((await post('outcome',input)).state,'pending');released.resolve();
  const outcome=await started;
  assert.equal(outcome.result?.value,'committed');assert.equal(outcome.result.is_error,false);
});
test('a captured Cordis registration settles once in its own Session and survives worker replacement',
  {skip:!root,timeout:30000},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'rsi-tools-'));
    for(const id of ['one','two'])await mkdir(join(directory,id));
    const require=createRequire(join(root,'package.json'));
    const load=name=>import(pathToFileURL(require.resolve(name)));
    const {Context}=await load('@deepseek-ai/cordis');
    const tools=await load('@deepseek-ai/dsh-tools');
    const sessions=applicationSessions(()=>{throw Error('tool authority cannot become an HTTP request');});
    const key=randomUUID();
    let ctx;
    t.after(async()=>{await ctx?.fiber.dispose();await rm(directory,{recursive:true,force:true});});
    async function open() {
      ctx=new Context();
      ctx.provide('sessions',sessions.sessions);
      ctx.provide('workingDirectory',sessions.workingDirectory);
      for(const name of ['dsh-session-projection','dsh-system-prompt'])
        await ctx.plugin((await load('@deepseek-ai/'+name)).default);
      await (await ctx.plugin(tools.default)).await();
      const {port}=await applicationTools(ctx,{load,key,generation:randomUUID(),directory,sessions});
      return async(operation,payload,headers={})=>{
        const reply=await fetch('http://127.0.0.1:'+port+'/v1/'+operation,{method:'POST',
          headers:{authorization:key,'content-type':'application/json',...headers},body:JSON.stringify(payload)});
        return {status:reply.status,value:await reply.text().then(text=>text?JSON.parse(text):null)};
      };
    }
    let post=await open(),calls=0,escaped;
    const definition=tools.defineTool({name:'session_probe',description:'Return the calling workspace.',parameters:{},
      output:{schema:{type:'string'},render:(_,text)=>[{type:'text',text}]},
      async execute(_,exec){
        calls++;
        const cwd=await ctx.workingDirectory.ensure(exec.agent,exec.signal);
        assert.equal(ctx.workingDirectory.get(ctx.sessions.get(exec.agent.session.id)),cwd);
        await assert.rejects(ctx.workingDirectory.ensure({...exec.agent},exec.signal),/no longer owns/);
        escaped=AsyncLocalStorage.bind(()=>ctx.workingDirectory.ensure(exec.agent));
        return cwd;
      }});
    let unregister=ctx.tools.register(definition);
    const capture=async(id,options={})=>{
      const reply=await post('capture',{header:{id,cwd:join(directory,id)},view:randomUUID(),reserved:[],modelSelection:nativeSelection,...options});
      assert.equal(reply.status,200,JSON.stringify(reply.value));
      return reply.value;
    };
    assert.equal((await post('capture',{},{authorization:'wrong'})).status,403);
    assert.equal((await post('capture',{},{origin:'http://browser.local'})).status,403);
    assert.equal((await capture('one',{reserved:['session_probe']})).tools.length,0);
    assert.equal((await capture('one',{allowed:[]})).tools.length,0);
    function request(view,session) {
      const effect=randomUUID();
      return {view:view.view,session,effect,identity:{owner_id:'worker-test',invocation_id:effect,call_id:randomUUID(),
        request_sha256:'a'.repeat(64)},name:'session_probe',
        args:{},registration:view.tools[0].registration};
    }
    async function outcome(operation,input) {
      const reply=await post(operation,input);
      assert.equal(reply.status,200);
      return reply.value;
    }
    const old=await capture('one');
    const entered=Promise.withResolvers(),resume=Promise.withResolvers();
    const stale=request(old,'one');
    ctx.on('tools/execute',async(exec,next)=>{
      if(exec.callId===stale.identity.call_id){entered.resolve(exec.signal);await resume.promise;}
      return next();
    });
    const starting=post('start',stale);
    const signal=await entered.promise;
    assert.equal((await post('cancel',{...stale,registration:randomUUID()})).value.accepted,false);
    assert.equal(signal.aborted,false);
    unregister();unregister=ctx.tools.register(definition);resume.resolve();
    assert.equal((await starting).value.result.is_error,true);
    assert.equal(calls,0);
    const message={role:'user',id:'native-hook',source:{kind:'post-tool'},content:[{type:'text',text:'first'},{type:'text',text:'second'}]};
    const contexts=[{id:message.id,source:message.source,text:['first','second']}];
    ctx.on('tools/post-execute',async(_exec,_result,next)=>({...await next(),additionalContexts:[message]}));
    const inputs=[];
    for(const session of ['one','two']){
      const selected=await capture(session),input=request(selected,session);
      inputs.push(input);
      const started=await outcome('start',input);
      assert.equal(started.result.value,join(directory,session));assert.deepEqual(started.result.additional_contexts,contexts);
      await assert.rejects(escaped(),/no longer owns/);
      assert.equal((await post('start',input)).status,200);
      assert.equal((await post('start',{...input,args:{changed:true}})).status,400);
      assert.equal((await post('outcome',{...input,identity:{...input.identity,request_sha256:'b'.repeat(64)}})).value.state,'unknown');
      assert.equal((await post('outcome',{...input,registration:randomUUID()})).value.state,'unknown');
      const wrong=request(selected,session==='one'?'two':'one');
      assert.equal((await outcome('start',wrong)).result.value.code,'UNKNOWN_TOOL');
      await post('release',{view:selected.view});
    }
    assert.equal(calls,2);
    await ctx.fiber.dispose();
    post=await open();
    for(const input of inputs){
      const recovered=await outcome('outcome',input);
      assert.equal(recovered.result.value,join(directory,input.session));assert.deepEqual(recovered.result.additional_contexts,contexts);
      assert.equal((await post('start',input)).status,200);
    }
    const missing=randomUUID();
    assert.equal((await outcome('outcome',{...inputs[0],effect:missing,identity:{...inputs[0].identity,invocation_id:missing}})).state,'unknown');
    assert.equal(calls,2);
    const modsEntry=process.env.RSI_DSH_MODS_ENTRY;
    await t.test('published Claude Code Mods reads the market Agent cwd and denies a real tool body',
      {skip:!modsEntry},async()=>{
        await (await ctx.plugin((await load('@deepseek-ai/dsh-agent')).AgentRegistry)).await();
        const mods=await import(pathToFileURL(modsEntry));
        await (await ctx.plugin(mods.default)).await();
        let observed,allowedCall;
        await (await ctx.plugin(mods.defineMod({name:'market-guard',register(on){
          on('tool.call',async(api,event,next)=>{
            observed=await api.session.cwd();
            if(event.tool_use_id!==allowedCall)return {deny:'denied by the market mod'};
            const downstream=await next(event);
            return {...downstream,result:'post-hook rendering'};
          });
        }}))).await();
        ctx.tools.register(definition);
        const input=request(await capture('two'),'two');
        const result=(await outcome('start',input)).result;
        assert.equal(result.is_error,true);assert.match(JSON.stringify(result),/denied by the market mod/);
        assert.equal(observed,join(directory,'two'));assert.equal(calls,2);
        const wrapped=request(await capture('one'),'one');
        allowedCall=wrapped.identity.call_id;
        const completed=(await outcome('start',wrapped)).result;
        assert.equal(completed.value,join(directory,'one'));assert.equal(completed.is_error,false);
        assert.deepEqual(completed.content,[{type:'text',text:'post-hook rendering'}]);
        assert.equal(calls,3);
      });
  });
