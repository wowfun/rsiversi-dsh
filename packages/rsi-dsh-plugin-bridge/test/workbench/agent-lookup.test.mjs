import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {sessionController} from '../../src/workbench/session-controller.mjs';

test('ordinary Session lookup leaves cold and registered subagents with their routing owner',async t=>{
  const metas=new Map([
    ['child',{id:'child',parent:'parent',plugin_child_depth:1}],
    ['seeded-child',{id:'seeded-child',parent:'parent',inherited:true}],
    ['fork',{id:'fork',parent:'parent',inherited:true}],
  ]);
  const agents=new Map(),starts=[],headers=[],snapshots=[];
  const header=id=>({id,parentSession:'parent',...(id==='fork'?{}:{origin:'subagent'})});
  const history={metadata:async id=>{headers.push(id);return metas.get(id);},
    snapshot:async meta=>{snapshots.push(meta.id);return {header:header(meta.id)};}};
  const scope=applicationSessions(async method=>{assert.equal(method,'application.actor');},{owner:'host',registered:id=>agents.get(id)});
  t.after(()=>scope.close());
  class Service {static init=Symbol();constructor(ctx){this.ctx=ctx;}}
  class RemoteError extends Error {constructor(code,text){super(text);this.code=code;}}
  let lookup,upload;
  const ctx={get:()=>({get:id=>agents.get(id)}),typert:{resources:{register(){}},contexts:{configureHost(){}},lookups:{register(){},configure(_,fn){lookup=fn;}}},
    inject(_,ready){ready({effect:fn=>fn(),fileUploads:{registerAgentResolver(fn){upload=fn;}}});}};
  const Controller=sessionController({TypertRemoteService:Service,RemoteError},scope,history,undefined,async id=>{
    starts.push(id);const agent={id,session:{header:header(id)}};agents.set(id,agent);return agent;
  });
  const service=new Controller(ctx);service[Service.init]();
  for(const id of ['child','seeded-child']){
    assert.equal((await service.resolveAgent(id)).error?.code,'session/agent-busy');
    assert(!agents.has(id));
  }
  const child={id:'child',session:{header:header('child')}};agents.set('child',child);
  assert.equal((await service.resolveAgent('child')).error?.code,'session/agent-busy');
  await assert.rejects(lookup('child'),{code:'session/agent-busy'});
  await assert.rejects(scope.runOwned(()=>upload('child')),{code:'session/agent-busy'});
  assert.equal(agents.get('child'),child);
  assert.equal((await service.resolveAgent('fork')).agent,agents.get('fork'));
  assert.equal((await service.resolveAgent('fork')).agent,agents.get('fork'));
  assert.deepEqual(starts,['fork']);assert.deepEqual(headers,['child','seeded-child','fork']);
  assert.deepEqual(snapshots,['seeded-child','fork']);
});

test('a trusted registry lookup uses the native actor check and preserves an existing caller',async t=>{
  const agent={id:'source',session:{id:'source',header:{id:'source'}}},calls=[];
  const scope=applicationSessions(async(method,args)=>{
    assert.equal(method,'application.actor');calls.push([args.request,args.session_id]);
    if(args.request!=='host'||args.session_id!==agent.id)throw Error('Actor unavailable');
  },{owner:'host'});
  t.after(()=>scope.close());
  class Service {static init=Symbol();constructor(ctx){this.ctx=ctx;}}
  let lookup,upload;
  const ctx={typert:{resources:{register(){}},contexts:{configureHost(){}},lookups:{
    register(){},configure(_key,resolve){lookup=resolve;},
  }},inject(_names,ready){ready({effect:fn=>fn(),fileUploads:{registerAgentResolver(resolve){upload=resolve;}}});}};
  const Controller=sessionController({TypertRemoteService:Service},scope,{metadata:async id=>({id})},undefined,async id=>{
    assert.equal(id,agent.id);return agent;
  });
  new Controller(ctx)[Service.init]();
  assert.equal(await lookup('source'),agent);
  await assert.rejects(async()=>lookup('other'),/Actor unavailable/);
  const browser=await scope.prepare({url:'/',headers:{'x-rsi-upstream-request':'browser'}});
  await assert.rejects(browser(()=>lookup('source')),/Actor unavailable/);
  const later=Promise.withResolvers();
  await scope.observeOwned(()=>{setImmediate(()=>later.resolve(assert.rejects(async()=>lookup('source'),/active native request/)));});
  await later.promise;
  await assert.rejects(async()=>upload('source'),/active native request/);
  assert.deepEqual(calls,[['host','source'],['host','other'],['browser','source']]);
});
