import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createApplication} from '../../src/application/application.mjs';
import {requestBoundary} from '../../src/application/request-boundary.mjs';
import {managedBoundary,managementTools} from '../../src/market/management.mjs';
import {fixtureTools} from '../fixtures/tool-host.mjs';
import {applicationSessions} from '../../src/application/sessions.mjs';
import {packageRunners} from '../../src/market/package-runners.mjs';

test('managed package failures preserve the original manager diagnostic',async()=>{
  const {desktopPnpm}=packageRunners({
    admitRaw:()=>assert.fail('managed install must not use raw admission'),
    manager:()=>({async installBundle(){return {application:'failed',error:{code:'operation-error',diagnostic:'missing selected dependency'}};}})});
  const run=desktopPnpm.runPlugin(['add','fixture@1.0.0']);
  const [result,errors]=await Promise.all([run.done,Array.fromAsync(run.stderr)]);
  assert.equal(result.exitCode,1);
  assert.equal(Buffer.concat(errors).toString(),'missing selected dependency');
});

const root=process.env.RSI_DSH_MARKET_COHORT;
test('management separates read authority and uses its operation identity for install cancellation',{skip:!root},async()=>{
  const require=createRequire(join(root,'package.json'));
  const tools=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')));
  const registered=new Map(),finish=Promise.withResolvers();let requestId;
  managementTools(tools,requestBoundary()).apply({tools:{register:tool=>registered.set(tool.name,tool)},pluginManager:{
    installBundle(target,options){assert.equal(target,'fixture@2');requestId=options.requestId;return finish.promise;},
    cancelInstall(id){assert.equal(id,requestId);finish.resolve({application:'cancelled',changed:false});return {status:'cancelled'};},
  }});
  const read=registered.get('plugin_inspect'),write=registered.get('plugin_manager');
  assert.notEqual(read.requiresFullAccess,true);assert.equal(write.requiresFullAccess,true);
  const exec={signal:new AbortController().signal,callId:'call',agent:{id:'session'}};
  const pending=JSON.parse(await write.execute({action:'install_bundle',target:'fixture@2'},exec));
  assert.equal(requestId,pending.operation);
  assert.deepEqual(JSON.parse(await write.execute({action:'cancel_install',target:pending.operation},exec)),{operation:pending.operation,status:'cancelled'});
  assert.equal(JSON.parse(await read.execute({action:'operation_status',target:pending.operation},exec)).application,'cancelled');
  for(const args of [undefined,{}, {action:42}])assert.equal(write.presentCall(args),undefined,'DSH validates replay presentation at its schema boundary');
  assert.equal(write.presentCall({action:'install_bundle',target:'fixture@2'}).title,'Install bundle fixture@2');
  assert.equal(write.presentCall({action:'set_plugin',target:'probe',enabled:false}).title,'Disable plugin probe');
  assert.equal(read.presentCall({action:'list_plugins'}).kind,'read');
});
test('managed package results require live activation and contain unavailable manager errors',async()=>{
  for(const application of ['restart-required','overridden','cancelled']) {
    const {desktopPnpm}=packageRunners({admitRaw:()=>assert.fail('unexpected raw operation'),manager:()=>({installBundle:()=>({application,changed:true})})});
    const run=desktopPnpm.runPlugin(['add','fixture']);
    const [result,errors]=await Promise.all([run.done,Array.fromAsync(run.stderr)]);
    assert.equal(result.exitCode,1);
    assert.match(Buffer.concat(errors).toString(),new RegExp(application));
  }
  const {desktopPnpm}=packageRunners({admitRaw:()=>assert.fail('unexpected raw operation'),manager:()=>{throw Error('manager unavailable');}});
  const run=desktopPnpm.runPlugin(['add','fixture']);
  const [result,errors]=await Promise.all([run.done,Array.fromAsync(run.stderr)]);
  assert.equal(result.exitCode,1);
  assert.equal(Buffer.concat(errors).toString(),'manager unavailable');
});

test('real manager defers its Tool mutation, preserves siblings and reports its completed receipt',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-management-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json')),probe=join(profile,'probe.mjs');
  await writeFile(probe,`export const inject=['tools'];export function apply(ctx){ctx.tools.register({name:'probe',description:'old code',parameters:{},
    output:{schema:{type:'string'},render:(_,value)=>[{type:'text',text:value}]},execute(){return 'old code';}});}`);
  const modules={entry:name=>name==='probe'?probe:require.resolve(name),directory:name=>join(root,'node_modules',name)};
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  const boundary=requestBoundary(),key=randomUUID(),hostModules=new Map();let listener;
  const managerName='@deepseek-ai/dsh-plugin-manager';
  const sessions=applicationSessions(()=>{throw Error('unexpected native request');});
  const patch=join(profile,'cordis.patch.yml'),rows=[];
  await writeFile(patch,JSON.stringify([{insert:[{id:'probe',name:'probe'}]}]));
  const app=await createApplication({modules,profile,boundary,hostModules,
    baseRows:[{id:'plugin-manager',name:managerName},{id:'plugin-manager-tools',name:managerName+'/tools'}],
    provide:async(ctx,load)=>{
      hostModules.set(managerName,managedBoundary((await load(managerName)).default,()=>({mutate:operation=>boundary.run(operation)})));
      hostModules.set(managerName+'/tools',managementTools(await load('@deepseek-ai/dsh-tools'),boundary));
      ctx.provide('profileContext',{name:basename(profile),dir:profile,patchPath:patch,
        installAnchor:join(modules.directory('@deepseek-ai/dsh'),'package.json'),cwd:profile,home:dirname(profile),
        startedBundles:[],overlayPaths:[],telemetryDisabledEnv:'1'});
      ctx.provide('hmr',{runExclusive:operation=>boundary.run(operation),async reconcileProfile(){
        const exists=await stat(patch).catch(error=>{if(error.code!=='ENOENT')throw error;});
        const warnings=await app.reconcile([...rows,...(exists?[boot.loadOverlayPatches('rsi-dsh',patch)]:[])]);
        return {warnings,pending:[]};
      }});
      for(const name of ['dsh-session-projection','dsh-system-prompt','dsh-tools'])await ctx.plugin((await load('@deepseek-ai/'+name)).default);
      listener=await fixtureTools(ctx,{load,key,generation:randomUUID(),directory:join(profile,'outcomes'),sessions,boundary});
    }});
  t.after(async()=>{await app.close();await sessions.close();});
  await app.reconcile([boot.loadOverlayPatches('rsi-dsh',patch)]);
  const post=async(path,input)=>{
    const response=await fetch('http://127.0.0.1:'+listener.port+'/v1/'+path,{method:'POST',headers:{authorization:key},body:JSON.stringify(input)});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const capture=()=>post('capture',{view:randomUUID(),header:{id:'management',cwd:profile},reserved:[],modelSelection:{provider:'fixture',model:'fixture'}});
  const invoke=async(view,name,args={})=>{
    const effect=randomUUID(),registration=view.tools.find(row=>row.definition.name===name).registration;
    const outcome=await post('start',{view:view.view,session:'management',effect,name,args,registration,
      identity:{owner_id:'owner',invocation_id:effect,call_id:randomUUID(),request_sha256:'a'.repeat(64)}});
    assert.equal(outcome.state,'settled');assert.equal(outcome.result.is_error,false,JSON.stringify(outcome));return outcome.result.value;
  };
  const old=await capture();
  assert.equal(old.tools.find(row=>row.definition.name==='plugin_manager').requires_full_access,true);
  assert.equal(old.tools.find(row=>row.definition.name==='plugin_inspect').requires_full_access,false);
  const {entries}=JSON.parse(await invoke(old,'plugin_inspect',{action:'list_plugins'}));
  const target=entries.find(row=>row.moduleName==='probe').entryId;
  const pending=JSON.parse(await invoke(old,'plugin_manager',{action:'set_plugin',target,enabled:false}));
  assert.equal(pending.application,'pending');
  assert.equal(await invoke(old,'probe'),'old code');
  await post('release',{view:old.view});
  const next=await capture();
  const receipt=JSON.parse(await invoke(next,'plugin_inspect',{action:'operation_status',target:pending.operation}));
  assert.equal(receipt.application,'applied',JSON.stringify(receipt));assert.equal(receipt.changed,true);
  assert.equal(next.tools.some(row=>row.definition.name==='probe'),false);
  const rejected=JSON.parse(await invoke(next,'plugin_manager',{action:'set_plugin',target:'missing',enabled:true}));
  const human=app.ctx.pluginManager.setPluginEnabled(target,true);
  await post('release',{view:next.view});
  assert.equal((await human).application,'applied');
  const final=await capture();assert.equal(final.tools.some(row=>row.definition.name==='probe'),true);
  const failed=JSON.parse(await invoke(final,'plugin_inspect',{action:'operation_status',target:rejected.operation}));
  assert.equal(failed.application,'failed');assert.equal(failed.error.code,'unknown-plugin');
  const missing=JSON.parse(await invoke(final,'plugin_inspect',{action:'operation_status',target:randomUUID()}));
  assert.equal(missing.application,'unknown');
  const recovered=JSON.parse(await invoke(final,'plugin_inspect',{action:'operation_status'})).operations;
  assert.deepEqual(recovered.map(row=>row.operation),[pending.operation,rejected.operation]);
  assert.equal(recovered[0].origin.session,'management');
  await post('release',{view:final.view});
});
