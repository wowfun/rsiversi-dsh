import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {chmod,link,mkdir,mkdtemp,readFile,rename,rm,stat,symlink,utimes,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {get} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../fixtures/application-http.mjs';
import {workbenchProfile} from '../../src/workbench/profile.mjs';
import {workbenchHostSettings} from '../../src/workbench/host-settings.mjs';
import {workbenchDeepSeekFields} from '../../src/workbench/deepseek-fields.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('a late settings read cannot restore a retired Host default',async()=>{
  const original={id:'old',selected:'old',version:{scope_id:'first',revision:9}};
  const replacement={id:'current',selected:'current',version:{scope_id:'second',revision:0}};
  const delayed=Promise.withResolvers();
  const replies=[original,delayed.promise,replacement];
  const sessions={withCaller:fn=>fn(),presetDefault:()=>replies.shift(),loopSettings:async()=>null,permissionSettings:async()=>null};
  const defaults=await workbenchHostSettings(new Map(),async()=>({default:class{}}),sessions);
  const reading=defaults.refresh();
  assert.equal((await defaults.refresh()).id,'current');
  delayed.resolve(original);
  assert.equal((await reading).id,'current');
  assert.equal(defaults.id,'current');
});
test('base workbench configures live plugins and discovers local apps without an importer',{skip:!root},async t=>{
  const home=await mkdtemp(join(tmpdir(),'rsi-settings-')),profile=join(home,'market');
  t.after(()=>rm(home,{recursive:true,force:true}));
  await mkdir(join(profile,'node_modules'),{recursive:true});
  await symlink(join(root,'node_modules/@deepseek-ai'),join(profile,'node_modules/@deepseek-ai'),process.platform==='win32'?'junction':'dir');
  const probe=join(profile,'node_modules/settings-probe');await mkdir(probe);
  await writeFile(join(probe,'package.json'),JSON.stringify({name:'settings-probe',type:'module',main:'index.mjs'}));
  await writeFile(join(probe,'index.mjs'),`import z from '@deepseek-ai/schemastery';
export const Config=z.object({count:z.number().min(1).default(2).volatile(),token:z.string().role('secret').volatile()});
export function apply(ctx,config){ctx.provide('settingsProbe',{read:()=>({count:config.count.get(),token:config.token.get()})});}
`);
  const require=createRequire(join(root,'package.json')),key=randomBytes(32).toString('hex');
  const modules={entry:name=>name==='settings-probe'?join(probe,'index.mjs'):require.resolve(name),
    directory:name=>dirname(require.resolve(name+'/package.json'))};
  const boot=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
  const selected=await workbenchProfile(modules,boot,profile);
  const web=modules.directory('@deepseek-ai/dsh-web-app');
  const webManifest=JSON.parse(await readFile(join(web,'package.json'),'utf8'));
  const declared=entries=>entries.filter(row=>row.name==='@deepseek-ai/dsh-agent-preset');
  const upstream=boot.composeEntries(boot.bundlePatchPaths(web,webManifest.dsh.bundle)
    .map(file=>boot.loadOverlayPatches('test',file)));
  assert.ok(declared(upstream).some(row=>row.config.id==='minimal'));
  assert.deepEqual(declared(selected.rows),declared(upstream));
  const office=upstream.find(row=>row.name==='@deepseek-ai/dsh-office-kit');
  assert.ok(office?.config.outputDirectory);
  assert.deepEqual(selected.rows.find(row=>row.id===office.id),office);
  assert.ok(selected.rows.some(row=>row.id==='action-cards'));
  const managed=await workbenchProfile(modules,boot,profile,{importer:true,language:true});
  for(const {rows} of [selected,managed]){
    assert.deepEqual(rows.filter(row=>['@deepseek-ai/dsh-plugin-market','@deepseek-ai/dsh-client-ui-plugin-market'].includes(row.name)),[]);
  }
  const kinds=rows=>rows.filter(row=>['plugin-recommendations','creation-recommendations'].includes(row.id)).map(row=>row.id);
  assert.deepEqual(kinds(selected.rows),[]);
  assert.deepEqual(kinds(managed.rows),['creation-recommendations','plugin-recommendations']);
  assert.ok(!selected.rows.some(row=>row.id==='session-title-llm'));
  const title=managed.rows.find(row=>row.id==='session-title-llm');
  assert.equal(title?.name,'@deepseek-ai/dsh-session-title-first-prompt-llm');
  assert.equal(title.config.maxOutputTokens,4096);
  const permissions=selected.rows.find(row=>row.name==='@deepseek-ai/dsh-permission-presets');
  assert.deepEqual(permissions.config.presets['danger-full-access'],{sandbox:'danger-full-access',approval:'never'});
  assert.ok(selected.rows.some(row=>row.name==='@deepseek-ai/dsh-client-ui-permission-presets'&&selected.clientOnly.has(row.id)));
  const names=new Set(['dsh-typert-registry','dsh-typert-loader','dsh-api-remote-access','dsh-api-gateway',
    'dsh-config-editor','dsh-settings','dsh-api-settings-controller','dsh-subprocess-local','dsh-host-open-in-app','dsh-agent-loop','dsh-permission-presets','dsh-agent-preset-registry','dsh-tool-subagent/model-selection-settings',
    'dsh-deepseek-llm-api-extensions','dsh-session-log-deepseek']);
  const rows=selected.rows.filter(row=>names.has(row.name.replace('@deepseek-ai/','')));
  permissions.config.presets['team-review']={sandbox:'read-only',approval:'never'};
  rows.push({id:'probe',name:'settings-probe',config:{token:'isolated-test-secret'}});
  let app,fields,stored=null,revision=1;
  const fieldActivity=[];
  const snapshot=()=>({id:stored??'standard',selected:stored,version:{scope_id:'test',revision}});
  let cap=null,loopRevision=0;
  const loopSnapshot=()=>({base:2,selected:cap,version:{scope_id:'loop',revision:loopRevision}});
  let permission=null,permissionRevision=0;
  const permissionSnapshot=()=>({base:'workspace-write',selected:permission,version:{scope_id:'agent',revision:permissionRevision}});
  const sessions={withCaller:fn=>fn(),permissionSettings:async()=>permissionSnapshot(),async setPermissionSettings(value,expected){
    assert.deepEqual(expected,permissionSnapshot().version);permission=value;permissionRevision++;return permissionSnapshot();
  },loopSettings:async()=>loopSnapshot(),async setLoopSettings(value,expected){
    assert.deepEqual(expected,loopSnapshot().version);cap=value;loopRevision++;return loopSnapshot();
  },presetDefault:async()=>snapshot(),async setPresetDefault(id,expected){
    assert.deepEqual(expected,snapshot().version);
    revision++;stored=id;return snapshot();
  }};
  t.after(async()=>{await app?.close();});
  async function start(){
    const hostModules=new Map();
    app=await createApplication({profile,modules,baseRows:rows,hostModules,provide:async(ctx,load)=>{
      fields=await workbenchDeepSeekFields(hostModules,load,enabled=>fieldActivity.push(enabled));
      await workbenchHostSettings(hostModules,load,sessions,fields.flush);
      await ctx.plugin((await load('@deepseek-ai/dsh-session')).default);
      await ctx.plugin((await load('@deepseek-ai/dsh-session-projection')).default);
      await ctx.plugin((await load('@deepseek-ai/dsh-agent')).AgentRegistry);
      ctx.provide('shell',{sandboxMode:'workspace-write'});ctx.provide('approval',{config:{policy:'ask'}});
      if(!ctx.get('sessions'))ctx.provide('sessions',{});
      await provideHttp(ctx,load,key);
      ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/fixture/listener',handler:(req,res)=>{
        res.end(JSON.stringify([ctx.webServer.getOrigin(),req.socket.remoteAddress,req.socket.remotePort,req.socket.remoteFamily]));
      }}));
      ctx.effect(()=>ctx.webServer.registerUpgrade({path:'/fixture/upgrade',
        auth:request=>request.url.pathname==='/fixture/upgrade'&&request.socket.remoteAddress==='2001:db8::9'&&
          ctx.webServer.getOrigin()==='https://workbench.example'?'required':'deny',
        handler:(_req,socket)=>socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n')}));
      ctx.provide('profileContext',{name:'settings',dir:profile,patchPath:join(profile,'cordis.patch.yml'),
        installAnchor:join(root,'package.json'),cwd:profile,home,startedBundles:[],overlayPaths:[]});
      await ctx.plugin(boot.PluginPackages);
    }});
    const patch=await readFile(join(profile,'cordis.patch.yml'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;});
    await app.reconcile(patch?[boot.loadOverlayPatches('test',join(profile,'cordis.patch.yml'))]:[]);
  }
  async function rpc(method,args={}){
    const res=await fetch(app.ctx.webServer.getOrigin()+'/api/'+method,{method:'POST',
      headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}})});
    const body=await res.text();assert.equal(res.status,200,body);return JSON.parse(body).result;
  }
  await start();
  const listener=app.ctx.webServer.getOrigin();
  const coordinates=await fetch(listener+'/fixture/listener',{headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,
    'x-rsi-upstream-peer':'[2001:db8::9]:1414','x-rsi-upstream-origin':'https://workbench.example'}});
  assert.deepEqual(await coordinates.json(),['https://workbench.example','2001:db8::9',1414,'IPv6']);
    for(const path of ['/fixture/upgrade','/document/fixture/upgrade']){
      const code=await new Promise((resolve,reject)=>get(listener+path,{headers:{connection:'Upgrade',upgrade:'fixture',
        'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key,'x-rsi-upstream-peer':'[2001:db8::9]:1414','x-rsi-upstream-origin':'https://workbench.example'}},
        res=>{res.resume();resolve(res.statusCode);}).on('error',reject));
      assert.equal(code,204,path);
    }
  assert.equal(app.ctx.webServer.getOrigin(),listener);
  const apps=await fetch(app.ctx.webServer.getOrigin()+'/open-in-app/apps',{headers:{'x-rsi-upstream-owner':'1','x-rsi-upstream-key':key}});
  assert.equal(apps.status,200);assert.ok(Array.isArray((await apps.json()).apps));
  const before=await rpc('settings/describe');assert.equal(before.ok,true,JSON.stringify(before));
  const permissionForm=before.value.namespaces.find(row=>row.ns==='permission');
  assert.equal(permissionForm?.value.defaultPreset,'workspace-write');
  const savePermission=name=>[{op:'set',path:['defaultPreset'],value:name}];
  const savedPermission=await rpc('settings/mutate',{ns:'permission',ops:savePermission('danger-full-access'),expectedRevision:permissionForm.revision});
  assert.equal(savedPermission.ok,true,JSON.stringify(savedPermission));
  assert.deepEqual(permission,{preset:'danger-full-access',sandbox:'danger-full-access',approval:'never'});
  assert.equal(app.ctx.permissionPresets.catalog().defaultPreset,'danger-full-access');
  await assert.rejects(app.ctx.settings.mutate('permission',savePermission('not-in-this-catalog')));
  assert.equal(permissionRevision,1);
  await app.ctx.settings.mutate('permission',[{op:'unset',path:['defaultPreset']}]);
  assert.equal(permission,null);
  assert.equal(app.ctx.permissionPresets.catalog().defaultPreset,'workspace-write');
  await app.ctx.settings.mutate('permission',savePermission('team-review'));
  assert.deepEqual(permission,{preset:'team-review',sandbox:'read-only',approval:'never'});
  const modelNs='subagent-model-selection-settings';
  const logNs='session-log-deepseek';
  const logForm=before.value.namespaces.find(row=>row.ns===logNs);
  assert.equal(logForm?.value.enabled,false);
  assert.deepEqual(fieldActivity,[]);
  const logSession=app.ctx.sessions.create('opt-in-log');
  logSession.append('turn/start',{turn:1});
  const prepareLog=()=>app.ctx.deepseekLlmApiExtensions.prepare({body:{model:'fixture'},sessionId:logSession.id,signal:AbortSignal.timeout(5000)});
  assert.deepEqual(Object.keys((await prepareLog()).fields),[]);
  const enabled=await rpc('settings/mutate',{ns:logNs,ops:[{op:'set',path:['enabled'],value:true}],expectedRevision:logForm.revision});
  assert.equal(enabled.ok,true,JSON.stringify(enabled));
  assert.deepEqual(fieldActivity,[true]);
  assert.equal((await prepareLog()).fields.dsh_session_log.events[0].type,'turn/start');
  const modelForm=before.value.namespaces.find(row=>row.ns===modelNs);
  assert.deepEqual(modelForm?.value,{enabled:false,allowedModels:[]});
  assert.equal(app.ctx.subagentModelSelection.allowedRoutes(),undefined);
  const allowed=[{provider:'fixture',model:'small'}];
  const modelChoice=await rpc('settings/update',{ns:modelNs,patch:{enabled:true,allowedModels:allowed},expectedRevision:modelForm.revision});
  assert.equal(modelChoice.ok,true,JSON.stringify(modelChoice));
  assert.deepEqual(app.ctx.subagentModelSelection.allowedRoutes(),allowed);
  const loopForm=before.value.namespaces.find(row=>row.ns==='agent-loop');
  assert.deepEqual(loopForm.base,{maxParallelToolCalls:2});
  assert.deepEqual(loopForm.value,loopForm.base);assert.deepEqual(loopForm.user,{});
  const setCap=value=>[{op:'set',path:['maxParallelToolCalls'],value}];
  await assert.rejects(app.ctx.settings.mutate('agent-loop',setCap(0)));
  assert.equal(loopRevision,0);
  const savedLoop=await rpc('settings/mutate',{ns:'agent-loop',ops:setCap(10),expectedRevision:loopForm.revision});
  assert.equal(savedLoop.ok,true,JSON.stringify(savedLoop));
  assert.deepEqual(savedLoop.value.user,{maxParallelToolCalls:10});assert.equal(cap,10);
  cap=7;loopRevision++;
  const staleLoop=await rpc('settings/mutate',{ns:'agent-loop',ops:setCap(9),expectedRevision:savedLoop.value.revision});
  assert.equal(staleLoop.error?.code,'settings/conflict');assert.equal(cap,7);
  await app.ctx.settings.mutate('agent-loop',[{op:'unset',path:['maxParallelToolCalls']}]);
  assert.equal(cap,null);
  assert.deepEqual(app.ctx.settings.describe().find(row=>row.ns==='agent-loop').value,loopForm.base);
  const ns='agent-preset-registry',preset=before.value.namespaces.find(row=>row.ns===ns);
  assert.deepEqual(preset.value,{});
  assert.deepEqual(preset.user,{});
  const savedPreset=await rpc('settings/update',{ns,patch:{selectedDefault:'dsh-only'},expectedRevision:preset.revision});
  assert.equal(savedPreset.ok,true,JSON.stringify(savedPreset));
  assert.equal(stored,'dsh-only');
  assert.equal(savedPreset.value.value.selectedDefault,stored);
  stored='native-selection';revision++;
  const conflict=await rpc('settings/update',{ns,patch:{selectedDefault:'old'},expectedRevision:savedPreset.value.revision});
  assert.equal(conflict.error?.code,'settings/conflict',JSON.stringify(conflict));
  assert.equal(stored,'native-selection');
  const current=await rpc('settings/describe');
  assert.equal(current.value.namespaces.find(row=>row.ns===ns).value.selectedDefault,stored);
  await app.ctx.settings.mutate(ns,[{op:'unset',path:['selectedDefault']}]);
  assert.equal(stored,null);
  const explicit=await rpc('settings/update',{ns,patch:{selectedDefault:'standard'}});
  assert.deepEqual(explicit.value.user,{selectedDefault:'standard'});
  await app.ctx.settings.mutate(ns,[{op:'unset',path:['selectedDefault']}]);
  assert.deepEqual(app.ctx.settings.describe().find(row=>row.ns===ns).user,{});
  assert.equal(before.value.writable,true);assert.ok(!JSON.stringify(before).includes('isolated-test-secret'));
  const original=before.value.namespaces.find(row=>row.ns==='probe');assert.ok(original);
  const updated=await rpc('settings/mutate',{ns:'probe',ops:[{op:'set',path:['count'],value:7}],expectedRevision:original.revision});
  assert.equal(updated.ok,true,JSON.stringify(updated));assert.equal(updated.value.value.count,7);
  assert.deepEqual(app.ctx.settingsProbe.read(),{count:7,token:'isolated-test-secret'});
  const stale=await rpc('settings/update',{ns:'probe',patch:{count:9},expectedRevision:original.revision});
  assert.equal(stale.ok,false);assert.equal(stale.error.code,'settings/conflict');
  const credentials=await rpc('credentials/describe',{refs:[]});
  assert.equal(credentials.ok,false);assert.match(credentials.error.message,/credentials service is absent/);
  await app.close();app=undefined;
  assert.match(await readFile(join(profile,'cordis.patch.yml'),'utf8'),/count: 7/);
  assert.doesNotMatch(await readFile(join(profile,'cordis.patch.yml'),'utf8'),/maxParallelToolCalls|selectedDefault|agent-preset-registry/);
  const bundle=join(profile,'node_modules/@rsiversi/dsh-workbench');
  const manifest=join(profile,'package.json');
  const generated=[join(bundle,'package.json'),join(bundle,'cordis.patch.yml')];
  const saved=await Promise.all(generated.map(path=>readFile(path)));
  const privateMode=(await stat(generated[0])).mode&0o777;
  if(process.platform!=='win32')await chmod(generated[0],0o644);
  const stamp=new Date('2001-01-01T00:00:00Z');
  const unchanged=[manifest,...generated];
  await Promise.all(unchanged.map(path=>utimes(path,stamp,stamp)));
  await writeFile(manifest+'.lock',String(process.pid)+'\n',{flag:'wx'});
  try {await start();} finally {await rm(manifest+'.lock');}
  assert.deepEqual(await Promise.all(unchanged.map(async path=>(await stat(path)).mtimeMs)),unchanged.map(()=>stamp.getTime()));
  assert.equal((await stat(generated[0])).mode&0o777,privateMode);
  assert.deepEqual(app.ctx.settingsProbe.read(),{count:7,token:'isolated-test-secret'});
  const restored=await rpc('settings/describe');assert.equal(restored.ok,true);
  assert.deepEqual(app.ctx.subagentModelSelection.allowedRoutes(),allowed);
  assert.equal(restored.value.namespaces.find(row=>row.ns==='probe').value.count,7);
  assert.ok(!JSON.stringify(restored).includes('isolated-test-secret'));
  await app.close();app=undefined;
  await rm(generated[0]);
  await writeFile(generated[1],Buffer.alloc(saved[1].length,32));
  await start();
  assert.deepEqual(await Promise.all(generated.map(path=>readFile(path))),saved);
  assert.equal((await stat(manifest)).mtimeMs,stamp.getTime());
  assert.equal(app.ctx.settingsProbe.read().count,7);
  await app.close();app=undefined;
  const alias=join(profile,'hard-linked-manifest'),target=join(profile,'linked-patch');
  await link(generated[0],alias);
  if(process.platform!=='win32'){
    await chmod(alias,0o644);
    await rename(generated[1],target);await symlink(target,generated[1]);
    await utimes(target,stamp,stamp);
  }
  const aliasMode=(await stat(alias)).mode;
  await start();
  assert.equal((await stat(alias)).nlink,1);
  assert.equal(app.ctx.permissionPresets.catalog().defaultPreset,'team-review');
  assert.equal(app.ctx.settings.describe().find(row=>row.ns===logNs).value.enabled,true);
  assert.notEqual((await stat(generated[0],{bigint:true})).ino,(await stat(alias,{bigint:true})).ino);
  assert.equal((await stat(alias)).mode,aliasMode);
  if(process.platform!=='win32'){
    assert.notEqual((await stat(generated[1],{bigint:true})).ino,(await stat(target,{bigint:true})).ino);
    assert.equal((await stat(target)).mtimeMs,stamp.getTime());
  }
  assert.deepEqual(await Promise.all(generated.map(path=>readFile(path))),saved);
  await app.ctx.settings.mutate(logNs,[{op:'unset',path:['enabled']}]);
  assert.equal(app.ctx.settings.describe().find(row=>row.ns===logNs).value.enabled,false);
  assert.equal(fieldActivity.at(-1),false);
  const contribution=app.ctx.inject(['deepseekLlmApiExtensions'],ctx=>{ctx.deepseekLlmApiExtensions.register('sample_field',{prepare:()=>({value:3})});});
  await contribution;
  await fields.flush();
  assert.equal(fieldActivity.at(-1),true);
  await contribution.dispose();
  await fields.flush();
  assert.equal(fieldActivity.at(-1),false);
});
