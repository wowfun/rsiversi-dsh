import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmod,link,lstat,mkdir,mkdtemp,readFile,realpath,unlink,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createMarketProfile} from '../../src/market/market-profile.mjs';
import {linkProfilePackage} from '../../src/market/profile-files.mjs';
import {createApplication} from '../../src/application/application.mjs';
import {rootSet,stage} from '../fixtures/fixture-roots.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
test('managed profiles advertise the installer release age and preserve operator policy',{skip:!root},async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-market-age-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const require=createRequire(join(root,'package.json'));
  const marketRoot=new URL('./install.js',pathToFileURL(require.resolve('dshmarket')));
  const {readMinimumReleaseAgeMs}=await import(marketRoot);
  for(const [name,before,minutes] of [['fresh',undefined,0],['registry','registry=https://registry.npmjs.org/',0],
    ['operator','minimum-release-age=37\n',37],['workspace',undefined,71]]){
    const profile=join(base,name);await mkdir(profile);
    const file=join(profile,'.npmrc');if(before!==undefined)await writeFile(file,before);
    if(name==='workspace')await writeFile(join(profile,'pnpm-workspace.yaml'),'minimumReleaseAge: 71\n');
    const options={profile,state:join(base,name+'-state'),call:async()=>({})};
    await createMarketProfile(options);
    assert.equal(readMinimumReleaseAgeMs(name,profile),minutes*60000,name);
    const first=await readFile(file,'utf8');
    if(name==='operator')assert.equal(first,before);
    if(name==='registry')assert.ok(first.startsWith(before+'\n'));
    await createMarketProfile(options);assert.equal(await readFile(file,'utf8'),first);
  }
});
test('market startup leaves shared and read-only npm configuration alone',async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-profile-config-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const profile=join(base,'profile');await mkdir(profile);
  const shared=join(base,'operator.npmrc'),file=join(profile,'.npmrc'),setting='registry=https://registry.npmjs.org/\n';
  await writeFile(shared,setting);await link(shared,file);
  const options={profile,state:join(base,'state'),call:async()=>({})};
  await createMarketProfile(options);assert.equal(await readFile(shared,'utf8'),setting);
  await unlink(file);await writeFile(file,setting);await chmod(file,0o444);
  try {await createMarketProfile(options);assert.equal(await readFile(file,'utf8'),setting);}
  finally {await chmod(file,0o600);}
});
test('the profile follows the leased package after replacement or collection and preserves ordinary directories',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-package-view-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const name='@deepseek-ai/cordis',link=join(dir,'node_modules',name),first=join(dir,'old'),next=join(dir,'new');
  await mkdir(first);await mkdir(next);
  await linkProfilePackage(dir,name,first);
  const original=await lstat(link,{bigint:true});
  await linkProfilePackage(dir,name,first);
  assert.equal((await lstat(link,{bigint:true})).ctimeNs,original.ctimeNs);
  await linkProfilePackage(dir,name,next);
  assert.equal(await realpath(link),await realpath(next));
  await rm(next,{recursive:true});
  await linkProfilePackage(dir,name,first);
  assert.equal(await realpath(link),await realpath(first));
  await unlink(link);await mkdir(link);await writeFile(join(link,'keep'),'local data');
  await assert.rejects(linkProfilePackage(dir,name,first),/collides/);
  assert.equal(await readFile(join(link,'keep'),'utf8'),'local data');
});

test('Cordis keeps the exact imported payload until its entry retires',{skip:!root},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-market-fiber-')),payload=join(dir,'payload'),profile=join(dir,'profile');
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(payload);await mkdir(profile);
  const file=join(payload,'entry.mjs');
  await writeFile(file,'export function apply(ctx){ctx.provide("replacementProbe",{live:true});}');
  const require=createRequire(join(root,'package.json'));
  const app=await createApplication({profile,modules:{entry:name=>name==='probe'?file:require.resolve(name)},provide:async()=>{}});
  t.after(()=>app.close());
  await app.reconcile([{insert:[{id:'probe',name:'probe'}]}]);
  assert.equal(app.ctx.get('replacementProbe').live,true);
  assert.equal(app.usesPayload([payload]),true);assert.equal(app.usesPayload([profile]),false);
  await app.reconcile([]);assert.equal(app.usesPayload([payload]),false);
});
test('an external market replacement keeps the old graph alive through its serving Fiber',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-market-update-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const name='test-market',selection='rsi-dsh-selection-test',roots=rootSet(),releases=[];
  const generations=new Map();let current,oldServing=true;
  for(const [version,id] of [['1.0.0','a'],['2.0.0','b']]) {
    const dir=join(profile,id),digest=id.repeat(64);await mkdir(dir);
    await writeFile(join(dir,'layout.json'),JSON.stringify({format:1,plugins:[name],locations:{
      ['node_modules/'+name]:{version}}}));
    await writeFile(join(dir,'package.json'),JSON.stringify({name,version,dsh:{bundle:{patch:'patch.yml'}}}));
    generations.set(version,{dir,digest});
  }
  const market=await createMarketProfile({profile,state:join(profile,'state'),
    modules:{add(layout){current=generations.get(layout.locations['node_modules/'+name].version);},directory:()=>current.dir},
    boot:{loadOverlayPatches:(_,path)=>path},async reconcile(){},
    manager:()=>{throw new Error('an installed package cannot use installBundle');},
    inUse:graph=>oldServing&&graph.layout.locations['node_modules/'+name].version==='1.0.0',
    async call(method,args) {
      if(method==='application.roots')return roots(args);
      if(method==='application.release'){releases.push(args.digest);return;}
      if(method==='application.import'){
        const version=args.specifications[0].slice(name.length+1);
        const selected=generations.get(version);if(!selected)throw Error('unpublished candidate');
        return stage(roots,args,{[selection]:selected.digest});
      }
      assert.equal(method,'application.payloads');
      return {profile:[...generations.values()].find(item=>item.digest===args.digest).dir,roots:{}};
    }});
  const run=(runner,version)=>runner.runPlugin(['add',name+'@'+version],profile).done;
  assert.equal((await run(market.packageRunner,'1.0.0')).exitCode,0);
  assert.equal((await run(market.desktopPnpm,'9.0.0')).exitCode,1);
  assert.deepEqual(roots({}),{['a'.repeat(64)]:selection});
  assert.equal((await run(market.desktopPnpm,'2.0.0')).exitCode,0);
  assert.deepEqual(roots({}),{['b'.repeat(64)]:selection});
  assert.equal(JSON.parse(await readFile(join(profile,'node_modules',name,'package.json'))).version,'2.0.0');
  assert.deepEqual(await market.activate(),{ok:true});assert.deepEqual(releases,[]);
  oldServing=false;assert.deepEqual(await market.activate(),{ok:true});
  assert.deepEqual(releases,['a'.repeat(64)]);
});
test('published dshmarket managed runtime installs once, reconciles, restores and removes its profile view',
  {skip:!root},async t=>{
    const profile=await mkdtemp(join(tmpdir(),'rsi-managed-market-'));
    const held=await mkdtemp(join(tmpdir(),'rsi-managed-lease-'));
    t.after(()=>Promise.all([profile,held].map(path=>rm(path,{force:true,recursive:true}))));
    const name='dsh-better-sidebar', version='0.28.2', spec=name+'@'+version;
    const entry=join(root,'node_modules',name);
    await writeFile(join(held,'layout.json'),JSON.stringify({format:1,plugins:[name],locations:{
      ['node_modules/'+name]:{version}
    }}));
    let imports=0, admissions=0, activations=0,releases=0;
    const selection='rsi-dsh-selection-fixture',digest='a'.repeat(64);
    const state=join(held,'state'),journal=join(state,'selections.json'),roots=rootSet();
    const require=createRequire(join(root,'package.json'));
    const boot=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
    const options={profile,state,modules:{add(){},directory:()=>entry},boot:{bundlePatchPaths:boot.bundlePatchPaths,loadOverlayPatches:(_,path)=>path},
      async call(method,request) {
        if(method==='application.roots') return roots(request);
        if (method==='application.import') {imports++;assert.deepEqual(request.specifications,[spec]);
          return stage(roots,request,{[selection]:digest});}
        if(method==='application.release') {assert.equal(request.digest,digest);releases++;return null;}
        assert.equal(method,'application.payloads');admissions++;assert.equal(request.package,selection);
        return {profile:held,roots:{}};
      },async reconcile(layers){activations++;if(layers.length)assert.deepEqual(layers,[join(entry,'cordis.patch.yml')]);}};
    const market=await import(pathToFileURL(join(root,'node_modules/dshmarket/lib/dsh-cli.js')));
    const service=await createMarketProfile(options);
    const runtime=market.createDesktopPluginRuntime(service.packageRunner,profile,profile);
    t.after(()=>runtime.dispose());
    const run=args=>runtime.runPlugin(service.desktopProfiles.current.name,args);
    const collision=join(profile,'node_modules',name);
    await mkdir(collision,{recursive:true});
    const failed=await run(['add',spec]);
    assert.equal(failed.exitCode,1);
    assert.match(failed.stderr,/collides/);
    await assert.rejects(readFile(journal),{code:'ENOENT'});
    await rm(collision,{recursive:true});
    for(const _ of [1,2]) {
      const result=await run(['add',spec]);
      assert.equal(result.exitCode,0,result.stderr);
    }
    assert.equal(imports,2);assert.equal(admissions,2);assert.equal(releases,1);
    const path=join(profile,'package.json');
    const manifest=JSON.parse(await readFile(path));assert.equal(manifest.dependencies[name],version);
    assert.deepEqual(manifest.dsh.profile.bundles,[]);
    // The original market writes its selected bundle before asking its host to activate.
    manifest.dsh.profile.bundles=[name];await writeFile(path,JSON.stringify(manifest));
    assert.deepEqual(await service.desktopProfiles.pluginActivation.activate(),{ok:true});
    // Simulate interruption after a candidate changed the manifest and before
    // it published a new Store selection. The Host recovers the committed one.
    const committed=JSON.parse(await readFile(journal));
    assert.equal(committed.installed[name].digest,digest);
    await writeFile(journal,JSON.stringify({...committed,preparing:[name]}));
    const retained=roots({});
    roots({expected:retained,next:{...retained,['d'.repeat(64)]:'rsi-dsh-selection-abandoned'}});
    manifest.dependencies[name]='broken';await writeFile(path,JSON.stringify(manifest));
    const restarted=await createMarketProfile(options);
    assert.equal(JSON.parse(await readFile(path)).dependencies[name],version);
    assert.deepEqual(JSON.parse(await readFile(journal)).preparing,[]);
    assert.deepEqual(roots({}),{[digest]:selection});
    assert.equal(admissions,3);
    assert.deepEqual(await restarted.activate(),{ok:true});assert.equal(activations,2);
    const unavailableName='missing-selection';
    await writeFile(journal,JSON.stringify({...committed,installed:{...committed.installed,
      [unavailableName]:{package:'rsi-dsh-selection-missing',digest:'c'.repeat(64),version:'1.0.0'}}}));
    const savedManifest=await readFile(path,'utf8'),withMissing=JSON.parse(savedManifest);
    withMissing.dsh.profile.bundles.push(unavailableName);await writeFile(path,JSON.stringify(withMissing));
    const partialRestart=await createMarketProfile({...options,call(method,args) {
      if(args.package==='rsi-dsh-selection-missing')throw new Error('fixture object unavailable');
      return options.call(method,args);
    }});
    const resumed=await partialRestart.activate();
    assert.equal(resumed.ok,true);assert.match(resumed.warnings.join('\n'),/missing-selection.*fixture object unavailable/);
    await writeFile(journal,JSON.stringify(committed));await writeFile(path,savedManifest);
    const backups=await import(pathToFileURL(join(root,'node_modules/dshmarket/lib/backup.js')));
    for(const opts of [undefined,{includeDeps:[name]}]) {
      const target=await mkdtemp(join(tmpdir(),'rsi-market-restore-'));
      t.after(()=>rm(target,{recursive:true,force:true}));
      const portable=backups.createProfileBackup('source',profile,opts);
      assert.ok(!JSON.stringify(portable).includes(digest));
      backups.restoreProfileBackup('target',portable,target);
      const targetDigest='b'.repeat(64),targetState=join(held,'target-'+(opts?'selected':'full')),targetRoots=rootSet();
      const restored=await createMarketProfile({...options,profile:target,state:targetState,
        async call(method,args) {
          if(method==='application.roots')return targetRoots(args);
          if(method==='application.import') {
            assert.deepEqual(args.specifications,[spec]);assert.equal(args.options.source,'registry');
            assert.equal(args.options.registry,'https://example.invalid/');
            return stage(targetRoots,args,{[selection]:targetDigest});
          }
          if(method==='application.release') {assert.equal(args.digest,targetDigest);return null;}
          assert.equal(method,'application.payloads');assert.equal(args.digest,targetDigest);
          return {profile:held,roots:{}};
        }});
      const runtime=market.createDesktopPluginRuntime(restored.desktopPnpm,target,target);
      try {
        const materialized=await runtime.runPlugin('target',['--registry=https://example.invalid/','--no-frozen-lockfile','install']);
        assert.equal(materialized.exitCode,0,materialized.stderr);
        assert.equal(JSON.parse(await readFile(join(targetState,'selections.json'))).installed[name].digest,targetDigest);
        assert.deepEqual(targetRoots({}),{[targetDigest]:selection});
        assert.deepEqual(await restored.activate(),{ok:true});
        const targetManifest=join(target,'package.json'), value=JSON.parse(await readFile(targetManifest));
        value.dependencies[name]='bad-version';
        value.dependencies['missing-bundle']='1.0.0';
        value.dsh.profile.bundles.push('missing-bundle');
        await writeFile(targetManifest,JSON.stringify(value));
        const partial=await runtime.runPlugin('target',['--no-frozen-lockfile','install']);
        assert.notEqual(partial.exitCode,0);
        const recovered=JSON.parse(await readFile(targetManifest));
        assert.deepEqual(recovered.dependencies,{[name]:version});
        assert.deepEqual(recovered.dsh.profile.bundles,[name]);
        recovered.dependencies={};recovered.dsh.profile.bundles=[];
        await writeFile(targetManifest,JSON.stringify(recovered));
        assert.equal((await runtime.runPlugin('target',['install','--no-frozen-lockfile'])).exitCode,0);
        assert.deepEqual(JSON.parse(await readFile(join(targetState,'selections.json'))).installed,{});
        assert.deepEqual(targetRoots({}),{});
        assert.deepEqual(await restored.activate(),{ok:true});
      } finally {runtime.dispose();}
    }
    const removed=await run(['remove',name]);assert.equal(removed.exitCode,0,removed.stderr);
    assert.equal(releases,1);
    const retired=JSON.parse(await readFile(path));
    retired.dsh.profile.bundles=[];await writeFile(path,JSON.stringify(retired));
    assert.deepEqual(await service.activate(),{ok:true});assert.equal(releases,2);
    assert.equal(JSON.parse(await readFile(path)).dependencies[name],undefined);
    await assert.rejects(readFile(join(profile,'node_modules',name,'package.json')),{code:'ENOENT'});
  });
