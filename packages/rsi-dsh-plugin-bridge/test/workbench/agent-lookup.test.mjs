import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {sessionController} from '../../src/workbench/session-controller.mjs';

test('a trusted registry lookup uses the native actor check and preserves an existing caller',async t=>{
  const agent={id:'source',session:{id:'source'}},calls=[];
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
  const Controller=sessionController({TypertRemoteService:Service},scope,undefined,undefined,async id=>{
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
