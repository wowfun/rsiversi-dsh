import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,symlink} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {workbenchProfile} from '../../src/workbench/profile.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('the selected original Cordis host runner serves the client inventory and inspect manifest', {skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-runner-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  await mkdir(join(profile,'node_modules'));
  await symlink(join(root,'node_modules/@deepseek-ai'),join(profile,'node_modules/@deepseek-ai'),process.platform==='win32'?'junction':'dir');
  const require=createRequire(join(root,'package.json')),key=randomBytes(32).toString('hex');
  const modules={entry:name=>require.resolve(name),directory:name=>dirname(require.resolve(name+'/package.json'))};
  const boot=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
  const selected=await workbenchProfile(modules,boot,profile),runner=selected.rows.find(row=>row.name==='@deepseek-ai/dsh-cordis-host-runner');
  assert.deepEqual(selected.rows.find(row=>row.name==='@deepseek-ai/dsh-message-feedback')?.config,{maxNoteBytes:8192});
  assert.ok(selected.rows.some(row=>row.name==='@deepseek-ai/dsh-command-feedback'),'the Session feedback dialog needs its original Host Remote and command');
  assert.ok(runner,'the client face needs its original host service');
  const connection=selected.rows.find(row=>row.name==='@deepseek-ai/dsh-client-connection');
  const hostModules=new Map([[connection.name,{inject:['connection'],apply(){}}]]);
  const app=await createApplication({profile,modules,hostModules,provide:async(ctx,load)=>{
    await provideHttp(ctx,load,key);
    ctx.provide('profileContext',{name:'runner',dir:profile,installAnchor:join(root,'package.json')});
    await ctx.plugin(boot.PluginPackages);
  }});t.after(()=>app.close());
  const entries=['dsh-typert-registry','dsh-typert-loader','dsh-api-remote-access','dsh-api-gateway','dsh-api-remotes','dsh-system-prompt','dsh-tools'];
  await app.reconcile([{insert:[...entries.map(id=>({id,name:'@deepseek-ai/'+id})),runner,connection]}]);
  for(const [method,args,expected] of [['inventory',{},[]],['syncInspectManifest',{providers:[]},null]]){
    const remote='dynamicCordisRunner/'+method,response=await fetch(app.ctx.webServer.getOrigin()+'/api/'+remote,{
      method:'POST',headers:{'x-rsi-upstream-key':key,'content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:remote,payload:{args}})});
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).result,{ok:true,value:expected});
  }
});
