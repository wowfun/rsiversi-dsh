import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,stat,symlink,utimes,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {createApplication} from '../../src/application/application.mjs';
import {provideHttp} from '../../src/application/http.mjs';
import {workbenchProfile} from '../../src/workbench/profile.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('base workbench configures live plugins and discovers local apps without an importer',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-settings-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  await mkdir(join(profile,'node_modules'));
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
  assert.ok(!selected.rows.some(row=>row.name==='@deepseek-ai/dsh-client-ui-permission-presets'),
    'must not offer permission writes without a native authority adapter');
  const names=new Set(['dsh-typert-registry','dsh-typert-loader','dsh-api-remote-access','dsh-api-gateway',
    'dsh-config-editor','dsh-settings','dsh-api-settings-controller','dsh-subprocess-local','dsh-host-open-in-app']);
  const rows=selected.rows.filter(row=>names.has(row.name.replace('@deepseek-ai/','')));
  rows.push({id:'probe',name:'settings-probe',config:{token:'isolated-test-secret'}});
  let app;
  t.after(async()=>{await app?.close();});
  async function start(){
    app=await createApplication({profile,modules,baseRows:rows,provide:async(ctx,load)=>{
      await provideHttp(ctx,load,key);
      ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/fixture/listener',handler:(req,res)=>{
        res.end(JSON.stringify([ctx.webServer.getOrigin(),req.socket.remoteAddress,req.socket.remotePort,req.socket.remoteFamily]));
      }}));
      ctx.provide('profileContext',{name:'settings',dir:profile,patchPath:join(profile,'cordis.patch.yml'),
        installAnchor:join(root,'package.json'),cwd:profile,home:profile,startedBundles:[],overlayPaths:[]});
      await ctx.plugin(boot.PluginPackages);
    }});
    const patch=await readFile(join(profile,'cordis.patch.yml'),'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;});
    await app.reconcile(patch?[boot.loadOverlayPatches('test',join(profile,'cordis.patch.yml'))]:[]);
  }
  async function rpc(method,args={}){
    const res=await fetch(app.ctx.webServer.getOrigin()+'/api/'+method,{method:'POST',
      headers:{'x-rsi-upstream-key':key,'content-type':'application/json'},
      body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method,payload:{args}})});
    const body=await res.text();assert.equal(res.status,200,body);return JSON.parse(body).result;
  }
  await start();
  const listener=app.ctx.webServer.getOrigin();
  const coordinates=await fetch(listener+'/fixture/listener',{headers:{'x-rsi-upstream-key':key,
    'x-rsi-upstream-peer':'[2001:db8::9]:1414','x-rsi-upstream-origin':'https://workbench.example'}});
  assert.deepEqual(await coordinates.json(),['https://workbench.example','2001:db8::9',1414,'IPv6']);
  assert.equal(app.ctx.webServer.getOrigin(),listener);
  const apps=await fetch(app.ctx.webServer.getOrigin()+'/open-in-app/apps',{headers:{'x-rsi-upstream-key':key}});
  assert.equal(apps.status,200);assert.ok(Array.isArray((await apps.json()).apps));
  const before=await rpc('settings/describe');assert.equal(before.ok,true,JSON.stringify(before));
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
  const bundle=join(profile,'node_modules/@rsiversi/dsh-workbench');
  const manifest=join(profile,'package.json');
  const generated=[join(bundle,'package.json'),join(bundle,'cordis.patch.yml')];
  const saved=await Promise.all(generated.map(path=>readFile(path)));
  const stamp=new Date('2001-01-01T00:00:00Z');
  const unchanged=[manifest,...generated];
  await Promise.all(unchanged.map(path=>utimes(path,stamp,stamp)));
  await writeFile(manifest+'.lock',String(process.pid)+'\n',{flag:'wx'});
  try {await start();} finally {await rm(manifest+'.lock');}
  assert.deepEqual(await Promise.all(unchanged.map(async path=>(await stat(path)).mtimeMs)),unchanged.map(()=>stamp.getTime()));
  assert.deepEqual(app.ctx.settingsProbe.read(),{count:7,token:'isolated-test-secret'});
  const restored=await rpc('settings/describe');assert.equal(restored.ok,true);
  assert.equal(restored.value.namespaces.find(row=>row.ns==='probe').value.count,7);
  assert.ok(!JSON.stringify(restored).includes('isolated-test-secret'));
  await app.close();app=undefined;
  await rm(generated[0]);
  await writeFile(generated[1],Buffer.alloc(saved[1].length,32));
  await start();
  assert.deepEqual(await Promise.all(generated.map(path=>readFile(path))),saved);
  assert.equal((await stat(manifest)).mtimeMs,stamp.getTime());
  assert.equal(app.ctx.settingsProbe.read().count,7);
});
