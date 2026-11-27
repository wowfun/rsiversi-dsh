import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {installReleaseResolver} from '../../../rsi-dsh-cordis/src/release/resolver.mjs';
import {createApplication} from '../../src/application/application.mjs';
import {requestBoundary} from '../../src/application/request-boundary.mjs';
import {createMarketProfile} from '../../src/market/market-profile.mjs';
import {managedPackages} from '../../src/market/managed-packages.mjs';
import {managedBoundary} from '../../src/market/management.mjs';
import {packageCommand} from '../../src/market/package-command.mjs';
import {captureProfileFiles} from '../../src/market/profile-files.mjs';
import {rootSet,stage} from '../fixtures/fixture-roots.mjs';

const cohort=process.env.RSI_DSH_MARKET_COHORT;
test('real local module replacement drains old callbacks, resolves same-version content and restores exact files and code',
  {skip:!cohort,timeout:120000},async t=>{
    const base=await mkdtemp(join(tmpdir(),'rsi-replacement-')),profile=join(base,'profile'),source=join(base,'source');
    t.after(()=>rm(base,{recursive:true,force:true}));
    await mkdir(profile);await mkdir(source);
    // This application supplies the manager and installs one local bundle.
    // Its installation manifest contains only the services it actually ships.
    const installAnchor=join(base,'package.json');
    await writeFile(installAnchor,JSON.stringify({dependencies:{'@deepseek-ai/dsh-plugin-manager':'*'}}));
    const name='fixture-runtime-replacement',selection='rsi-dsh-selection-replacement',shard='fixture-module';
    await writeFile(join(source,'package.json'),JSON.stringify({name,version:'1.0.0',type:'module',
      exports:{'.':{import:'./index.mjs'},'./package.json':'./package.json'},
      dsh:{bundle:{patch:'cordis.patch.yml'}}}));
    await writeFile(join(source,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'replacement-probe',name}]}]));
    const writeVersion=version=>writeFile(join(source,'index.mjs'),version==='bad'
      ?'export function apply(){throw Error("candidate activation rejected");}'
      :`export function apply(ctx){ctx.provide('replacementProbe',{version:'${version}',async work(gate){await gate;return '${version}';}});}`);
    await writeVersion('v1');
    const require=createRequire(join(cohort,'package.json'));
    const resolver=installReleaseResolver({format:1,locations:{}},new Map(),profile);
    t.after(()=>resolver.close());
    const modules={...resolver,entry:id=>id===name?resolver.entry(id):require.resolve(id),
      directory:id=>id===name?resolver.directory(id):join(cohort,'node_modules',id)};
    const boot=await import(pathToFileURL(modules.entry('@deepseek-ai/dsh-app-boot')));
    const roots=rootSet(),generations=new Map(),releases=[];
    let imports=0,market,app,importing,preparation;
    const boundary=requestBoundary(),hostModules=new Map(),managerName='@deepseek-ai/dsh-plugin-manager';
    const options={profile,state:join(base,'state'),modules,boot,boundary,
      inUse:graph=>app.usesPayload([...graph.roots.values()]),
      manager:()=>app.ctx.get('pluginManager'),reconcile:layers=>app.reconcile(layers),
      active:id=>[...app.ctx.loader.entries()].some(entry=>(entry.id===id||entry.options.id===id)&&entry.fiber?.state===app.ctx.fiber.state),
      async call(method,args,signal) {
        if(method==='application.stage.release')return null;
      if(method==='application.roots')return roots(args);
        if(method==='application.release'){releases.push(args.digest);return;}
        if(method==='application.stage') {
          assert.deepEqual(args.specifications,[source]);imports++;
          if(preparation){
            const held=preparation;preparation=undefined;held.downloading.resolve();
            await held.download.promise;held.building.resolve();await held.build.promise;
          }
          if(importing) {
            importing.resolve();
            await new Promise((_,reject)=>{
              signal.throwIfAborted();
              signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
            });
          }
          const code=await readFile(join(source,'index.mjs'));
          const digest=createHash('sha256').update(code).digest('hex'),root=join(base,'objects',digest);
          if(!generations.has(digest)) {
            await mkdir(join(root,'node_modules'),{recursive:true});
            await cp(source,join(root,'node_modules',name),{recursive:true});
            await writeFile(join(root,'layout.json'),JSON.stringify({format:1,plugins:[name],locations:{
              ['node_modules/'+name]:{package:shard,version:'1.0.0',dependencies:{}}}}));
            generations.set(digest,root);
          }
          return stage(roots,args,{[selection]:digest});
        }
        assert.equal(method,'application.payloads');
        return {profile:generations.get(args.digest),roots:{[shard]:generations.get(args.digest)}};
      }};
    app=await createApplication({profile,modules,boundary,hostModules,
      baseRows:[{id:'plugin-manager',name:managerName}],provide:async(ctx,load)=>{
        const original=await load(managerName);
        hostModules.set(managerName,managedPackages(managedBoundary(original.default,()=>market),()=>market,original));
        market=await createMarketProfile(options);
        const command=await packageCommand(profile,market.packageRunner);
        ctx.effect(()=>()=>command.close());
        ctx.provide('profileContext',{name:basename(profile),dir:profile,patchPath:join(profile,'cordis.patch.yml'),
          installAnchor,cwd:profile,home:dirname(profile),
          startedBundles:[],overlayPaths:[],telemetryDisabledEnv:'1',packageManager:command.invocation});
        ctx.provide('hmr',market.hmr);
        await ctx.plugin(boot.PluginPackages,{});
      }});
    t.after(()=>app.close());
    await app.reconcile([]);
    const manager=app.ctx.pluginManager;
    const inventory=t.mock.method(manager,'listBundles');
    const first=await manager.installBundle(source,{requestId:'first'});
    assert.equal(first.application,'applied',JSON.stringify(first));
    assert.equal(inventory.mock.callCount(),0,'a first install does not enumerate installed bundles');
    assert.equal(app.ctx.replacementProbe.version,'v1');
    inventory.mock.mockImplementationOnce(async()=>[{name,installed:true,removable:false}]);
    const protectedResult=await manager.installBundle(source,{requestId:'protected'});
    assert.equal(protectedResult.error.code,'not-removable');
    assert.equal(imports,1,'a protected dependency must not stage replacement code');
    const firstDigest=Object.keys(roots({}))[0];
    const gate=Promise.withResolvers(),view=await boundary.capture(new AbortController().signal,()=>{});
    const callback=view.run(()=>app.ctx.replacementProbe.work(gate.promise));
    await writeVersion('v2');
    const preparing={downloading:Promise.withResolvers(),download:Promise.withResolvers(),building:Promise.withResolvers(),build:Promise.withResolvers()};
    preparation=preparing;
    const ready=Promise.withResolvers(),prepare=market.prepare;
    market.prepare=async(...args)=>{const value=await prepare(...args);ready.resolve();return value;};
    const replacing=manager.installBundle(source,{requestId:'second'});
    await preparing.downloading.promise;
    let disabled=false;
    const disabling=manager.setBundleEnabled(name,false).then(value=>{disabled=true;return value;});
    const queued=manager.installBundle(source,{requestId:'queued-behind-disable'});
    const waiting=manager.waitForInstall('queued-behind-disable');
    assert.equal((await manager.cancelInstall('queued-behind-disable')).status,'cancelled');
    assert.equal((await queued).application,'cancelled');
    assert.deepEqual(await waiting,await queued);
    assert.equal(await manager.waitForInstall('queued-behind-disable'),null);
    assert.deepEqual(await manager.cancelInstall('queued-behind-disable'),{status:'not-running'});
    for(const phase of ['download','build']){
      const concurrent=await boundary.capture(new AbortController().signal,()=>{});
      assert.equal(await concurrent.run(()=>app.ctx.replacementProbe.work(Promise.resolve())),'v1');
      concurrent.release();assert.equal(disabled,false);
      assert.equal(imports,2,'the queued install must not prepare');
      if(phase==='download'){preparing.download.resolve();await preparing.building.promise;}
    }
    view.release();
    preparing.build.resolve();await ready.promise;
    // The ready candidate now owns admission, but the released view still has
    // an active callback. No new captured step may observe partial publication.
    await new Promise(resolve=>setImmediate(resolve));
    let captured=false;
    const next=boundary.capture(new AbortController().signal,()=>{}).then(value=>{captured=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(captured,false);assert.equal(app.ctx.replacementProbe.version,'v1');
    gate.resolve();assert.equal(await callback,'v1');
    const second=await replacing;
    assert.equal(second.application,'applied',JSON.stringify(second));
    (await next).release();
    assert.equal((await disabling).application,'applied');
    assert.equal((await manager.setBundleEnabled(name,true)).application,'applied');
    assert.equal(app.ctx.replacementProbe.version,'v2');
    market.prepare=prepare;
    assert.ok(releases.includes(firstDigest));
    assert.equal((await manager.inspect(source)).status,'accepted');
    const selected=roots({}),files=await captureProfileFiles(profile);
    await writeVersion('bad');
    const failed=await manager.installBundle(source,{requestId:'failed'});
    assert.equal(failed.application,'failed',JSON.stringify(failed));
    assert.equal(failed.restored,true);
    assert.equal(failed.changed,false);
    assert.equal(app.ctx.replacementProbe.version,'v2');
    assert.deepEqual(await captureProfileFiles(profile),files,'failure restores exact bytes and absence');
    assert.deepEqual(roots({}),selected,'failure retains the exact old digest, not the now-broken local source');
    assert.equal(await manager.waitForInstall('failed'),null);
    await assert.rejects(readFile(join(options.state,'install-receipts.json')),{code:'ENOENT'});
    assert.equal(JSON.parse(await readFile(join(options.state,'selections.json'))).rollback,null);
    importing=Promise.withResolvers();
    await writeVersion('v3');
    const cancelled=manager.installBundle(source,{requestId:'cancelled'});
    await importing.promise;
    assert.deepEqual(await manager.cancelInstall('cancelled'),{status:'cancelled'});
    const cancelledResult=await cancelled;
    assert.equal(cancelledResult.application,'cancelled',JSON.stringify(cancelledResult));
    assert.equal(cancelledResult.restored,undefined,'preparation cancellation has no profile changes to restore');
    assert.equal(app.ctx.replacementProbe.version,'v2');
    assert.deepEqual(await captureProfileFiles(profile),files);
    assert.deepEqual(roots({}),selected);
  });
