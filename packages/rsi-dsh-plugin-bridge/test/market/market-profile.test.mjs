import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {AsyncResource} from 'node:async_hooks';
import {chmod,link,lstat,mkdir,mkdtemp,readFile,readdir,realpath,unlink,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createMarketProfile} from '../../src/market/market-profile.mjs';
import {managedPackages} from '../../src/market/managed-packages.mjs';
import {captureProfileFiles,captureRecovery,readSelections,saveSelections,linkProfilePackage} from '../../src/market/profile-files.mjs';
import {createApplication} from '../../src/application/application.mjs';
import {requestBoundary} from '../../src/application/request-boundary.mjs';
import {packageCommand} from '../../src/market/package-command.mjs';
import {rootSet,stage} from '../fixtures/fixture-roots.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;

test('invalid staged candidates keep their validation error when lease cleanup also fails',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-invalid-stage-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  let released=0;
  const market=await createMarketProfile({profile,state:join(profile,'state'),call:async method=>{
    if(method==='application.roots')return {};
    if(method==='application.stage')return {stage:'candidate',packages:{}};
    assert.equal(method,'application.stage.release');released++;throw Error('stage lease unavailable');
  }});
  await assert.rejects(market.prepare('fixture',new AbortController().signal,undefined,{write(){}}),error=>{
    assert(error instanceof AggregateError);
    assert.match(error.message,/Importer did not publish a DSH selection.*stage lease unavailable/);
    assert.equal(error.errors.length,2);return true;
  });
  assert.equal(released,1);
});
test('restored bundle layers follow current platform, version exemptions and package boundaries',{skip:!root},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-bundle-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const name='bundled-plugin',directory=join(profile,name);
  const boot=await import(pathToFileURL(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh-app-boot')));
  const version=boot.getDshRuntimeVersion(),patches=[{insert:[{id:'probe',name:'probe'}]}];
  await mkdir(directory);
  await writeFile(join(directory,'ok.yml'),JSON.stringify(patches));
  const bundle={patch:'ok.yml',platforms:[process.platform==='win32'?'linux':'win32']};
  const manifest={name,version:'1.0.0',engines:{dsh:'999.0.0'},dsh:{bundle}};
  const publish=()=>writeFile(join(directory,'package.json'),JSON.stringify(manifest));
  await publish();
  await writeFile(join(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:[name]}}}));
  const reconciled=[];
  const market=await createMarketProfile({profile,state:join(profile,'state'),boot,
    modules:{installationDependency:id=>id===name?directory:undefined},call:async()=>({}),
    reconcile:layers=>{reconciled.push(layers.flat());}});
  assert.deepEqual(await market.layers(true),[]);
  assert.match((await market.activate()).warnings.join(' '),/platform/i);
  bundle.platforms=[process.platform];await publish();
  assert.match((await market.activate()).warnings.join(' '),/999\.0\.0/);
  await writeFile(join(profile,'compatibility.json'),JSON.stringify({[name+'@1.0.0']:[version]}));
  assert.deepEqual(await market.activate(),{ok:true});assert.deepEqual(reconciled.at(-1),patches);
  bundle.patch='../outside.yml';await publish();
  assert.match((await market.activate()).error,/outside its package/);
  assert.equal(reconciled.length,3);
});

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
test('market restart preserves the exact manifest until it needs a dependency map',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-market-manifest-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const options={profile,state:join(profile,'state'),call:async()=>({})};
  const path=join(profile,'package.json');
  const source='{"name":"operator-profile","dependencies":{}}\n';
  await writeFile(path,source);
  await createMarketProfile(options);
  assert.equal(await readFile(path,'utf8'),source);
  await writeFile(path,'{"name":"operator-profile"}');
  await createMarketProfile(options);
  assert.deepEqual(JSON.parse(await readFile(path)),{name:'operator-profile',dependencies:{}});
});

test('transaction reservation excludes another caller before recovery files are read',async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-market-reservation-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const profile=join(base,'profile');await mkdir(profile);
  const market=await createMarketProfile({profile,state:join(base,'state'),call:async()=>({})});
  await market.hmr.runExclusive(async()=>{
    const release=Promise.withResolvers();
    const first=market.transaction(async()=>{await release.promise;return {application:'applied',changed:false};});
    try {
      await assert.rejects(market.transaction(async()=>({application:'applied',changed:false})),/already owns/);
    } finally {release.resolve();await first;}
  });
});

test('independent raw imports wait for the managed transaction to settle',async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-market-lanes-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const profile=join(base,'profile');await mkdir(profile);
  const boundary=requestBoundary();t.after(()=>boundary.close());
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),events=[];
  const market=await createMarketProfile({profile,state:join(base,'state'),boundary,modules:{},
    call:async(method)=>{
      if(method==='application.stage.release')return null;
      if(method==='application.roots')return {};
      assert.equal(method,'application.stage');events.push('raw import');throw Error('import probe');
    }});
  const managed=boundary.run(()=>market.transaction(async()=>{
    entered.resolve();await release.promise;events.push('managed settled');
    return {application:'applied',changed:false};
  }));
  await entered.promise;
  const raw=market.packageRunner.runPlugin(['add','probe@1.0.0'],profile);
  try {await new Promise(resolve=>setTimeout(resolve,50));}
  finally {release.resolve();await managed;}
  assert.equal((await raw.done).exitCode,1);
  assert.deepEqual(events,['managed settled','raw import']);
});

test('failed recovery capture releases admission and subprocess identity expires with its transaction',async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-market-admission-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const profile=join(base,'profile');await mkdir(profile);
  const market=await createMarketProfile({profile,state:join(base,'state'),modules:{},reconcile:()=>[],call:async(method)=>{
    if(method==='application.stage.release')return null;
      if(method==='application.roots')return {};
    assert.equal(method,'application.stage');throw Error('child reached importer');
  }});
  const patch=join(profile,'cordis.patch.yml');await writeFile(patch,'a'.repeat(1024*1024+1));
  await assert.rejects(market.transaction(()=>assert.fail('capture was not admitted')),/cordis.patch.yml exceeds profile capacity/);
  await unlink(patch);
  let identity;
  const result=await market.transaction(async()=>{
    identity=market.packageRunner.transactionId();assert.equal(typeof identity,'string');
    const child=market.packageRunner.runPlugin(['add','child@1.0.0'],profile,undefined,identity);
    assert.equal((await child.done).exitCode,1);
    assert.match(Buffer.concat(await Array.fromAsync(child.stderr)).toString(),/child reached importer/);
    const retry=market.packageRunner.runPlugin(['install'],profile,undefined,identity);
    assert.equal((await retry.done).exitCode,0);
    return {application:'applied',changed:false};
  });
  assert.equal(result.application,'applied');
  assert.equal(market.packageRunner.transactionId(),undefined);
  const stale=market.packageRunner.runPlugin(['add','stale@1.0.0'],profile,undefined,identity);
  assert.equal((await stale.done).exitCode,1);
  assert.match(Buffer.concat(await Array.fromAsync(stale.stderr)).toString(),/transaction is no longer active/);
  assert.deepEqual(await Array.fromAsync(stale.stdout),[]);
});

test('accepted package children drain before a returned manager can commit or compensate',async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-market-child-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const profile=join(base,'profile');await mkdir(profile);
  const entered=Promise.withResolvers(),returned=Promise.withResolvers(),release=Promise.withResolvers(),imports=[];
  const market=await createMarketProfile({profile,state:join(base,'state'),modules:{},reconcile:()=>[],call:async(method,args)=>{
    if(method==='application.stage.release')return null;
      if(method==='application.roots')return {};
    assert.equal(method,'application.stage');imports.push(args.specifications[0]);
    entered.resolve();await release.promise;throw Error('import probe');
  }});
  let first,queued,identity,settled=false;
  const changing=market.transaction(async()=>{
    identity=market.packageRunner.transactionId();
    first=market.packageRunner.runPlugin(['add','first@1.0.0'],profile,undefined,identity);
    await entered.promise;
    queued=market.packageRunner.runPlugin(['add','queued@1.0.0'],profile,undefined,identity);
    returned.resolve();
    return {application:'applied',changed:false};
  }).then(result=>{settled=true;return result;});
  try {
    await returned.promise;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'the owner must retain accepted children');
    const stale=market.packageRunner.runPlugin(['add','stale@1.0.0'],profile,undefined,identity);
    assert.equal((await stale.done).exitCode,1);
    assert.match(Buffer.concat(await Array.fromAsync(stale.stderr)).toString(),/transaction is no longer active/);
    assert.deepEqual(await Array.fromAsync(stale.stdout),[]);
  } finally {release.resolve();}
  const result=await changing;
  assert.equal(result.application,'failed');
  assert.equal(result.restored,true);
  assert.match(result.error.diagnostic,/import probe/);
  assert.equal((await first.done).exitCode,1);
  assert.equal((await queued.done).exitCode,1);
  assert.deepEqual(imports,['first@1.0.0','queued@1.0.0']);
});

test('a successful child returned without joining cannot commit an unreconciled selection',async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-unjoined-success-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const profile=join(base,'profile'),held=join(base,'held');await mkdir(profile);await mkdir(held);
  await writeFile(join(held,'layout.json'),JSON.stringify({plugins:['fixture'],locations:{'node_modules/fixture':{version:'1.0.0'}}}));
  const roots=rootSet(),entered=Promise.withResolvers(),release=Promise.withResolvers();
  const market=await createMarketProfile({profile,state:join(base,'state'),modules:{add(){},prepare(){return {directory:()=>held,publish(){}};},directory:()=>held,installationDependency(){}},reconcile:()=>[],
    boot:{readProfileVersionExemptions:()=>({}),getDshRuntimeVersion:()=>'',readProfileManifest:()=>({dsh:{bundle:{}}}),assertBundlePlatform(){},evaluatePluginCompatibility(){},bundlePatchPaths:()=>[]},
    call:async(method,args)=>{
      if(method==='application.stage.release')return null;
      if(method==='application.roots')return roots(args);
      if(method==='application.stage'){entered.resolve();await release.promise;return stage(roots,args,{'rsi-dsh-selection-fixture':'a'.repeat(64)});}
      if(method==='application.payloads')return {profile:held,roots:{}};
      assert.equal(method,'application.release');
    }});
  let child;
  const work=market.transaction(async()=>{
    child=market.packageRunner.runPlugin(['add','fixture@1.0.0'],profile,undefined,market.packageRunner.transactionId());
    await entered.promise;return {application:'applied',changed:true};
  });
  await entered.promise;await new Promise(resolve=>setImmediate(resolve));release.resolve();
  const result=await work;
  assert.equal((await child.done).exitCode,0);
  assert.equal(result.application,'failed');assert.equal(result.restored,true);
  assert.match(result.error.diagnostic,/before.*subprocess.*settled/);
  assert.deepEqual(JSON.parse(await readFile(join(profile,'package.json'))).dependencies,{});
  assert.deepEqual(roots({}),{});
});

test('failed compensation retains recovery intent and blocks further writes until reopening',async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-market-recovery-'));
  t.after(()=>rm(base,{recursive:true,force:true}));
  const profile=join(base,'profile'),state=join(base,'state');await mkdir(profile);
  const manifest=join(profile,'package.json'),patch=join(profile,'cordis.patch.yml');
  const roots=rootSet();
  const options={profile,state,modules:{},call:async(method,args)=>{
    assert.equal(method,'application.roots');return roots(args);
  },reconcile:()=>{throw Error('old plugin failed to reactivate');}};
  const market=await createMarketProfile(options);
  const before=await captureProfileFiles(profile);
  await assert.rejects(market.transaction(async()=>{
    await writeFile(manifest,'broken candidate manifest');
    await writeFile(patch,'candidate patch');
    return {application:'failed',changed:true};
  }),/recovery is incomplete/);
  const journal=join(state,'selections.json');
  assert.deepEqual((await readSelections(journal)).rollback.files,
    Object.fromEntries(Object.entries(before).map(([name,value])=>[name,value===null?null:Buffer.from(value,'base64')])));
  assert.deepEqual(await captureProfileFiles(profile),before);
  await assert.rejects(market.transaction(()=>{throw Error('must not run');}),/recovery requires restarting the application with the same profile/);
  await assert.rejects(market.hmr.runExclusive(async()=>assert.fail('must not mutate a fenced profile')),/recovery requires restarting the application with the same profile/);
  const raw=market.packageRunner.runPlugin(['add','fixture@1.0.0'],profile);
  assert.equal((await raw.done).exitCode,1);
  assert.match(Buffer.concat(await Array.fromAsync(raw.stderr)).toString(),/recovery requires restarting the application with the same profile/);
  const reopened=await createMarketProfile({...options,reconcile:()=>[]});
  await assert.rejects(lstat(journal),{code:'ENOENT'});
  assert.deepEqual(await captureProfileFiles(profile),before);
  assert.deepEqual(await reopened.activate(),{ok:true});
});

test('late subprocess environments retain their expired transaction instead of escaping as raw work',async t=>{
  const base=await mkdtemp(join(tmpdir(),'rsi-market-late-'));t.after(()=>rm(base,{recursive:true,force:true}));
  const profile=join(base,'profile');await mkdir(profile);
  const entered=Promise.withResolvers(),release=Promise.withResolvers(),late=Promise.withResolvers(),after=Promise.withResolvers();
  const market=await createMarketProfile({profile,state:join(base,'state'),modules:{},reconcile:()=>[],call:async method=>{
    if(method==='application.stage.release')return null;
      if(method==='application.roots')return {};
    assert.equal(method,'application.stage');entered.resolve();await release.promise;throw Error('fixture import');
  }});
  const command=await packageCommand(profile,market.packageRunner);t.after(()=>command.close());
  let identity,duringDrain,afterCommit;
  const changing=market.transaction(async()=>{
    identity=market.packageRunner.transactionId();
    duringDrain=late.promise.then(()=>command.invocation.env);
    afterCommit=after.promise.then(()=>command.invocation.env);
    market.packageRunner.runPlugin(['add','first@1'],profile,undefined,identity);
    await entered.promise;return {application:'applied',changed:false};
  });
  try {
    await entered.promise;await new Promise(resolve=>setImmediate(resolve));
    late.resolve();const env=await duringDrain;
    assert.equal(env.RSI_DSH_PACKAGE_TRANSACTION,identity,'expired ownership must not disappear');
    const child=market.packageRunner.runPlugin(['install'],profile,undefined,env.RSI_DSH_PACKAGE_TRANSACTION);
    assert.equal((await child.done).exitCode,1);
    assert.match(Buffer.concat(await Array.fromAsync(child.stderr)).toString(),/transaction is no longer active/);
  } finally {release.resolve();await changing;after.resolve();}
  assert.equal((await afterCommit).RSI_DSH_PACKAGE_TRANSACTION,identity);
  assert.equal(command.invocation.env.RSI_DSH_PACKAGE_TRANSACTION,undefined);
  await market.transaction(async()=>{
    assert.notEqual(command.invocation.env.RSI_DSH_PACKAGE_TRANSACTION,identity);
    return {application:'applied',changed:false};
  });
});

test('manifest publication cannot write more bytes than its next recovery capture accepts',async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-manifest-cap-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  const path=join(profile,'package.json'),before=JSON.stringify({padding:'a'.repeat(1024*1024-16)});
  assert.ok(Buffer.byteLength(before)<1024*1024);await writeFile(path,before);
  await assert.rejects(createMarketProfile({profile,state:join(profile,'state'),call:async()=>({})}),/package.json exceeds profile capacity/);
  assert.equal(await readFile(path,'utf8'),before);
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

test('an interrupted Windows junction installation can reopen the package',{skip:process.platform!=='win32'},async t=>{
  const profile=await mkdtemp(join(tmpdir(),'rsi-interrupted-link-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const name='@example/plugin',root=join(profile,'lease'),dest=join(profile,'node_modules',name);
  await mkdir(root);
  // Stop between the two filesystem changes involved in creating a Windows junction.
  const action=`
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    const [module,profile,name,root,step]=process.argv.slice(1);
    if(step==='create')fs.symlink=async(_root,path,type)=>{
      if(type!=='junction')throw Error('unexpected link type');
      await fs.mkdir(path);
      process.exit(71);
    };
    else fs.rename=async()=>process.exit(71);
    syncBuiltinESMExports();
    await (await import(module)).linkProfilePackage(profile,name,root);
  `;
  const module=new URL('../../src/market/profile-files.mjs',import.meta.url).href;
  function interrupt(target,step){
    const child=spawnSync(process.execPath,['--input-type=module','-e',action,module,profile,name,target,step],{encoding:'utf8',windowsHide:true});
    assert.equal(child.status,71,child.stderr);
  }
  interrupt(root,'create');
  await assert.rejects(lstat(dest),{code:'ENOENT'});
  await linkProfilePackage(profile,name,root);
  assert.equal(await realpath(dest),await realpath(root));
  const next=join(profile,'next');
  await mkdir(next);await writeFile(join(next,'keep'),'lease content');
  interrupt(next,'create');
  assert.equal(await realpath(dest),await realpath(root));
  interrupt(next,'rename');
  await linkProfilePackage(profile,name,next);
  assert.equal(await readFile(join(dest,'keep'),'utf8'),'lease content');
  assert.deepEqual(await readdir(join(profile,'node_modules','@example')),['plugin']);
  await unlink(dest);await mkdir(dest);
  await assert.rejects(linkProfilePackage(profile,name,root),/collides/);
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
test('published dshmarket raw runtime resolves explicit installs, restores and removes its profile view',
  {skip:!root},async t=>{
    const profile=await mkdtemp(join(tmpdir(),'rsi-managed-market-'));
    const held=await mkdtemp(join(tmpdir(),'rsi-managed-lease-'));
    t.after(()=>Promise.all([profile,held].map(path=>rm(path,{force:true,recursive:true}))));
    const name='dsh-better-sidebar';
    const entry=join(root,'node_modules',name);
    const {version}=JSON.parse(await readFile(join(entry,'package.json'),'utf8')),spec=name+'@'+version;
    await writeFile(join(held,'layout.json'),JSON.stringify({format:1,plugins:[name],locations:{
      ['node_modules/'+name]:{version}
    }}));
    let imports=0, admissions=0, activations=0,releases=0;
    const selection='rsi-dsh-selection-fixture',digest='a'.repeat(64);
    const state=join(held,'state'),journal=join(state,'selections.json'),roots=rootSet();
    const require=createRequire(join(root,'package.json'));
    const boot=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
    const boundary=requestBoundary();t.after(()=>boundary.close());
    const options={profile,state,boundary,modules:{add(){},prepare(){return {directory:()=>entry,publish(){}};},directory:()=>entry,installationDependency(){}},boot:{...boot,loadOverlayPatches:(_,path)=>path},
      async call(method,request) {
        if(method==='application.stage.release')return null;
      if(method==='application.roots') return roots(request);
        if (method==='application.stage') {imports++;assert.deepEqual(request.specifications,[spec]);
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
    await assert.rejects(lstat(journal),{code:'ENOENT'});
    await rm(collision,{recursive:true});
    for(const _ of [1,2]) {
      const result=await run(['add',spec]);
      assert.equal(result.exitCode,0,result.stderr);
    }
    assert.equal(imports,3);assert.equal(admissions,2);assert.equal(releases,1);
    await unlink(collision);
    const restoredView=await run(['install']);
    assert.equal(restoredView.exitCode,0,restoredView.stderr);
    assert.equal(imports,3,'manifest restoration reuses the exact already held selection');
    assert.equal(await realpath(collision),await realpath(entry),'restoration repairs a missing profile link');
    // A package subprocess arrives outside the parent's async-local context.
    const external=new AsyncResource('package-subprocess');t.after(()=>external.emitDestroy());
    await unlink(collision);
    const repaired=await service.transaction(async()=>{
      const identity=service.packageRunner.transactionId();
      const child=external.runInAsyncScope(()=>service.packageRunner.runPlugin(['install'],profile,AbortSignal.timeout(2000),identity));
      const result=await child.done;
      assert.equal(result.exitCode,0,Buffer.concat(await Array.fromAsync(child.stderr)).toString());
      assert.deepEqual(await service.activate(),{ok:true});
      return {application:'applied',changed:false};
    });
    assert.equal(repaired.application,'applied',JSON.stringify(repaired));
    assert.equal(await realpath(collision),await realpath(entry));
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
    const rollback=await captureRecovery(journal,profile);rollback.touched.push(name);
    await saveSelections(journal,committed.installed,rollback);
    const retained=roots({});
    roots({expected:retained,next:{...retained,['d'.repeat(64)]:'rsi-dsh-selection-abandoned'}});
    manifest.dependencies[name]='broken';await writeFile(path,JSON.stringify(manifest));
    const restarted=await createMarketProfile(options);
    assert.equal(JSON.parse(await readFile(path)).dependencies[name],version);
    assert.equal(JSON.parse(await readFile(journal)).rollback,null);
    assert.deepEqual(roots({}),{[digest]:selection});
    assert.equal(admissions,3);
    assert.deepEqual(await restarted.activate(),{ok:true});assert.equal(activations,3);
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
          if(method==='application.stage.release')return null;
      if(method==='application.roots')return targetRoots(args);
          if(method==='application.stage') {
            assert.deepEqual(args.specifications,[spec]);
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
        await assert.rejects(lstat(join(targetState,'selections.json')),{code:'ENOENT'});
        assert.deepEqual(targetRoots({}),{});
        assert.deepEqual(await restored.activate(),{ok:true});
      } finally {runtime.dispose();}
    }
    const removed=await run(['remove',name]);assert.equal(removed.exitCode,0,removed.stderr);
    assert.equal(releases,2);
    const retired=JSON.parse(await readFile(path));
    retired.dsh.profile.bundles=[];await writeFile(path,JSON.stringify(retired));
    assert.deepEqual(await service.activate(),{ok:true});assert.equal(releases,2);
    assert.equal(JSON.parse(await readFile(path)).dependencies[name],undefined);
    await assert.rejects(readFile(join(profile,'node_modules',name,'package.json')),{code:'ENOENT'});
  });

test('local directory and tarball installs record file provenance and never query npm on cross-host restore',
  {skip:!root},async t=>{
    const base=await mkdtemp(join(tmpdir(),'rsi-local-provenance-'));
    t.after(()=>rm(base,{recursive:true,force:true}));
    const profile=join(base,'profile'),state=join(base,'state'),held=join(base,'held');
    const localDir=join(base,'local-dir-plugin'),localTarball=join(base,'local-tarball-plugin.tgz');
    await Promise.all([profile,held,localDir].map(dir=>mkdir(dir,{recursive:true})));
    const dirName='local-dir-fixture',tarName='local-tar-fixture',regName='dsh-better-sidebar';
    const regEntry=join(root,'node_modules',regName);
    const {version:regVersion}=JSON.parse(await readFile(join(regEntry,'package.json'),'utf8'));
    await writeFile(join(localDir,'package.json'),JSON.stringify({name:dirName,version:'0.1.0',dsh:{bundle:{patch:'patch.yml'}}}));
    await writeFile(join(localDir,'patch.yml'),'[]\n');
    await writeFile(localTarball,'tarball-placeholder');
    const tarExtracted=join(base,'tar-extracted');await mkdir(tarExtracted);
    await writeFile(join(tarExtracted,'package.json'),JSON.stringify({name:tarName,version:'0.2.0',dsh:{bundle:{patch:'patch.yml'}}}));
    await writeFile(join(tarExtracted,'patch.yml'),'[]\n');
    for(const [id,plugin,version] of [['dir',dirName,'0.1.0'],['tar',tarName,'0.2.0'],['reg',regName,regVersion]]){
      const folder=join(held,id);await mkdir(folder);
      await writeFile(join(folder,'layout.json'),JSON.stringify({format:1,plugins:[plugin],locations:{['node_modules/'+plugin]:{version}}}));
    }
    const dirs={[dirName]:localDir,[tarName]:tarExtracted,[regName]:regEntry};
    const require=createRequire(join(root,'package.json'));
    const boot=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')));
    const managerModule=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager')));
    const roots=rootSet(),stagedSpecs=[];
    const selectionFor=spec=>{
      if(spec.includes('local-dir-plugin'))return ['rsi-dsh-selection-dir','1'.repeat(64),'dir'];
      if(spec.includes('local-tarball-plugin.tgz'))return ['rsi-dsh-selection-tar','2'.repeat(64),'tar'];
      if(spec===regName+'@'+regVersion)return ['rsi-dsh-selection-reg','3'.repeat(64),'reg'];
      throw Error('unexpected stage specification: '+spec);
    };
    const byDigest={['1'.repeat(64)]:'dir',['2'.repeat(64)]:'tar',['3'.repeat(64)]:'reg'};
    let market;
    const options={profile,state,modules:{entry:require.resolve,add(){},prepare(_l,_r,[plugin]){return {directory:()=>dirs[plugin],publish(){}};},
      directory:name=>dirs[name],installationDependency(){}},boot,reconcile:()=>[],
      async call(method,request){
        if(method==='application.stage.release'||method==='application.release')return null;
        if(method==='application.roots')return roots(request);
        if(method==='application.stage'){
          stagedSpecs.push(request.specifications[0]);
          const [sel,digest]=selectionFor(request.specifications[0]);
          return stage(roots,request,{[sel]:digest});
        }
        assert.equal(method,'application.payloads');
        return {profile:join(held,byDigest[request.digest]),roots:{}};
      }};
    market=await createMarketProfile(options);
    for(const spec of [localDir,localTarball,regName+'@'+regVersion]){
      const run=market.packageRunner.runPlugin(['add',spec],profile);
      assert.equal((await run.done).exitCode,0,Buffer.concat(await Array.fromAsync(run.stderr)).toString());
    }
    const manifest=JSON.parse(await readFile(join(profile,'package.json'),'utf8'));
    assert.equal(manifest.dependencies[dirName],'file:'+localDir);
    assert.equal(manifest.dependencies[tarName],'file:'+localTarball);
    assert.equal(manifest.dependencies[regName],regVersion);
    const saved=await readSelections(join(state,'selections.json'));
    assert.equal(saved.installed[dirName].source,'file:'+localDir);
    assert.equal(saved.installed[tarName].source,'file:'+localTarball);
    assert.equal(saved.installed[regName].source,undefined);

    // Verify real upstream PluginManager.listBundles() and managedPackages replacement inspection for both path and tarball.
    const hostModules=new Map(),managerName='@deepseek-ai/dsh-plugin-manager';
    const app=await createApplication({
      modules:{entry:require.resolve,directory:name=>join(root,'node_modules',name)},
      profile,hostModules,baseRows:[{id:'plugin-manager',name:managerName}],
      provide:async ctx=>{
        hostModules.set(managerName,managedPackages(managerModule.default,()=>market,managerModule));
        ctx.provide('profileContext',{name:'profile',dir:profile,patchPath:join(profile,'cordis.patch.yml'),
          installAnchor:join(root,'node_modules/@deepseek-ai/dsh/package.json'),cwd:profile,home:base,
          startedBundles:[],overlayPaths:[],telemetryDisabledEnv:'1'});
      }});
    t.after(()=>app.close());
    await app.reconcile([]);
    const bundles=await app.ctx.pluginManager.listBundles();
    const dirBundle=bundles.find(b=>b.name===dirName),tarBundle=bundles.find(b=>b.name===tarName);
    assert.equal(dirBundle?.source,'file:'+localDir);
    assert.equal(tarBundle?.source,'file:'+localTarball);
    app.ctx.pluginManager.registries=async()=>({registry:'https://registry.npmjs.org/',resolved:'https://registry.npmjs.org/',fallbackRegistries:[]});
    assert.equal((await app.ctx.pluginManager.inspect(localDir)).replacement,true);
    assert.equal((await app.ctx.pluginManager.inspect(localTarball)).replacement,true);

    // Same-host restore reuses held local selections without staging or touching npm.
    stagedSpecs.length=0;
    await unlink(join(profile,'node_modules',dirName));
    const sameHost=market.packageRunner.runPlugin(['install'],profile);
    assert.equal((await sameHost.done).exitCode,0);
    assert.deepEqual(stagedSpecs,[]);
    assert.equal(await realpath(join(profile,'node_modules',dirName)),await realpath(localDir));

    // Cross-host restore with reachable local directory, missing local tarball, and healthy registry dependency:
    // never queries npm for name@version on either local dependency.
    const target=join(base,'target-profile'),targetState=join(base,'target-state');
    await mkdir(target,{recursive:true});
    const missingTarball=join(base,'absent-plugin.tgz');
    await writeFile(join(target,'package.json'),JSON.stringify({
      name:'restored-profile',private:true,
      dependencies:{[dirName]:'file:'+localDir,[tarName]:'file:'+missingTarball,[regName]:regVersion},
      dsh:{profile:{bundles:[dirName,tarName,regName]}},
    }));
    const targetRoots=rootSet(),targetSpecs=[];
    const restored=await createMarketProfile({...options,profile:target,state:targetState,
      async call(method,request){
        if(method==='application.stage.release'||method==='application.release')return null;
        if(method==='application.roots')return targetRoots(request);
        if(method==='application.stage'){
          const spec=request.specifications[0];
          assert.notEqual(spec,dirName+'@0.1.0','must never query registry for local directory');
          assert.notEqual(spec,tarName+'@0.2.0','must never query registry for missing local tarball');
          targetSpecs.push(spec);
          const [sel,digest]=selectionFor(spec);
          return stage(targetRoots,request,{[sel]:digest});
        }
        return {profile:join(held,byDigest[request.digest]),roots:{}};
      }});
    const restoreRun=restored.packageRunner.runPlugin(['--no-frozen-lockfile','install'],target);
    assert.equal((await restoreRun.done).exitCode,1);
    const errText=Buffer.concat(await Array.fromAsync(restoreRun.stderr)).toString();
    assert.match(errText,/Local package path is unavailable on this host/);
    assert.deepEqual(targetSpecs,['file:'+localDir,regName+'@'+regVersion]);
    const cleaned=JSON.parse(await readFile(join(target,'package.json'),'utf8'));
    assert.deepEqual(cleaned.dependencies,{[dirName]:'file:'+localDir,[regName]:regVersion});
    assert.deepEqual(cleaned.dsh.profile.bundles,[dirName,regName]);
  });
