import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createApplication} from '../../src/application/application.mjs';
import {createMarketProfile} from '../../src/market/market-profile.mjs';
import {packageCommand} from '../../src/market/package-command.mjs';
import {rootSet,stage} from '../fixtures/fixture-roots.mjs';
import {replayableInstalls} from '../../src/market/install-receipts.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('released Discover manager runs its configured package command and can install without enabling', {skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-discover-'));
  const held=await mkdtemp(join(tmpdir(),'rsi-discover-lease-'));
  t.after(()=>Promise.all([profile,held].map(dir=>rm(dir,{recursive:true,force:true}))));
  const name='dsh-better-sidebar',spec=name+'@0.28.2';
  await writeFile(join(held,'layout.json'),JSON.stringify({format:1,plugins:[name],locations:{
    ['node_modules/'+name]:{version:'0.28.2'}}}));
  const document='- id: existing-profile-row\n  name: "@deepseek-ai/dsh-plugin-manager"\n  disabled: true\n';
  await writeFile(join(profile,'cordis.yml'),document);
  const require=createRequire(join(root,'package.json'));
  const modules={entry:name=>require.resolve(name),directory:name=>join(root,'node_modules',name),add(){}};
  const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
  let imports=0;
  const roots=rootSet();
  let managed;
  const baseRows=[{id:'config-editor',name:'@deepseek-ai/dsh-config-editor'},
    {id:'settings',name:'@deepseek-ai/dsh-settings'}, {id:'plugin-manager',name:'@deepseek-ai/dsh-plugin-manager'},
    {id:'plugin-market',name:'@deepseek-ai/dsh-plugin-market'}];
  const hostModules=new Map();
  const app=await createApplication({modules,profile,baseRows,hostModules,provide:async(ctx,load)=>{
    const manager='@deepseek-ai/dsh-plugin-manager';
    hostModules.set(manager,await replayableInstalls((await load(manager)).default,join(held,'state'),await load('@deepseek-ai/dsh-atomic-write')));
    managed=await createMarketProfile({modules,profile,state:join(held,'state'),boot,reconcile:layers=>app.reconcile(layers),
      manager:()=>ctx.get('pluginManager'),active:id=>[...ctx.loader.entries()].some(entry=>entry.options.id===id && entry.fiber?.state===ctx.fiber.state),
      view:async candidate=>{assert.equal(candidate,spec);return {name,version:'0.28.2',description:'sidebar',dsh:{bundle:{patch:'cordis.patch.yml'}}};},
      call:async(method,args)=>{
        if(method==='application.roots')return roots(args);
        if(method==='application.import') {imports++;assert.deepEqual(args.specifications,[spec]);
          assert.equal(args.options.builds['build-second'],false);
          if(!args.options.builds['build-first']) throw new Error('Ignored build scripts: build-first');
          if(imports===2) assert.equal(args.options.registry,'https://mirror.example/');
          return stage(roots,args,{'rsi-dsh-selection-proof':'a'.repeat(64)});}
        if(method==='application.release') {assert.equal(args.digest,'a'.repeat(64));return null;}
        assert.equal(method,'application.payloads');return {profile:held,roots:{}};
      }});
    const cmd=await packageCommand(profile,managed.packageRunner);
    ctx.effect(()=>()=>cmd.close(),'managed package command');
    ctx.provide('profileContext',{name:basename(profile),dir:profile,patchPath:join(profile,'cordis.patch.yml'),
      installAnchor:join(modules.directory('@deepseek-ai/dsh'),'package.json'),cwd:profile,home:dirname(profile),
      startedBundles:[],overlays:[],telemetryDisabledEnv:'1',packageManager:cmd.invocation});
    ctx.provide('hmr',managed.hmr);
    await ctx.plugin(boot.PluginPackages,{});
    await ctx.plugin((await load('@deepseek-ai/dsh-typert-registry')).default);
    ctx.provide('sessions',{get:()=>undefined});
    ctx.provide('connection',{isTrusted:()=>true});
    for (const name of ['dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent','dsh-host-webserver']){
      const plugin=await load('@deepseek-ai/'+name);
      await ctx.plugin(name==='dsh-agent'?plugin.AgentRegistry:plugin.default,
        name==='dsh-host-webserver'?{host:'127.0.0.1',port:0}:undefined);
    }
  }});
  t.after(()=>app.close());
  await app.reconcile([]);
  assert.ok([...app.ctx.loader.entries()].some(entry=>entry.options.id==='existing-profile-row' && entry.disabled));
  assert.equal(await readFile(join(profile,'cordis.yml'),'utf8'),document);
  const composed=boot.loadProfileDirectory('dsh',profile,join(modules.directory('@deepseek-ai/dsh'),'package.json'));
  assert.deepEqual(composed.skippedBundles,[]);
  assert.deepEqual(composed.layers.flatMap(layer=>layer.patches),[{insert:baseRows}]);
  const index='https://example.test/market/index.json';
  await app.ctx.pluginMarket.setIndexes([index]);
  assert.ok((await readFile(join(profile,'cordis.patch.yml'),'utf8')).includes(index));
  assert.ok(Array.isArray(await app.ctx.pluginManager.listBundles()));
  const preview=await app.ctx.pluginManager.inspect(spec);
  assert.equal(preview.name,name,JSON.stringify(preview));
  assert.equal(imports,0);
  await writeFile(join(profile,'pnpm-workspace.yaml'),'allowBuilds:\n  build-second: false\n');
  const blocked=await app.ctx.pluginManager.installBundle(spec,{requestId:'discover-first',enabled:false});
  assert.deepEqual(blocked.pendingBuilds,['build-first'],JSON.stringify(blocked));
  const result=await app.ctx.pluginManager.installBundle(spec,{requestId:'discover-retry',enabled:false,approvedBuilds:['build-first'],registry:'https://mirror.example/'});
  assert.equal(result.packageResult.exitCode,0,JSON.stringify(result));
  assert.equal(result.enabled,false);
  assert.equal(result.application,'applied',JSON.stringify(result));
  assert.deepEqual(await app.ctx.pluginManager.installBundle(spec,{requestId:'discover-retry',enabled:false,approvedBuilds:['build-first'],registry:'https://mirror.example/'}),result);
  assert.equal(imports,2);
  assert.equal(JSON.parse(await readFile(join(profile,'package.json'))).dependencies[name],'0.28.2');
  assert.ok(![...app.ctx.loader.entries()].some(entry=>entry.options.id==='better-sidebar' && entry.fiber));
  const market=await import(pathToFileURL(join(modules.directory('dshmarket'),'lib/dsh-cli.js')));
  const runtime=market.createDesktopPluginRuntime(managed.desktopPnpm,profile,profile);
  t.after(()=>runtime.dispose());
  const added=await runtime.runPlugin(basename(profile),['add',spec]);
  assert.equal(added.exitCode,0,added.stderr);
  assert.equal(imports,2);
  assert.ok(JSON.parse(await readFile(join(profile,'package.json'))).dsh.profile.bundles.includes(name));
  assert.ok([...app.ctx.loader.entries()].some(entry=>entry.options.id==='better-sidebar' && entry.fiber?.state===app.ctx.fiber.state));
  const removed=await app.ctx.pluginManager.removeBundle(name);
  assert.equal(removed.application,'applied',JSON.stringify(removed));
  const fresh=await runtime.runPlugin(basename(profile),['add',spec]);
  assert.equal(fresh.exitCode,0,fresh.stderr);
  assert.equal(imports,3);
  assert.ok([...app.ctx.loader.entries()].some(entry=>entry.options.id==='better-sidebar' && entry.fiber?.state===app.ctx.fiber.state));
});
