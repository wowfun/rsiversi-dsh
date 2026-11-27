import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {packageLocation, releaseLayout, splitPayloads} from '../../src/release/layout.mjs';
import {installReleaseResolver} from '../../src/release/resolver.mjs';
import {writePayload, writePayloadFiles} from '../../src/archive/payload.mjs';

test('both packers retain POSIX execution for regular npm package files', {skip:process.platform==='win32'}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-package-mode-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const location='node_modules/example', pkg=join(root,location);
  await mkdir(pkg,{recursive:true});
  await writeFile(join(pkg,'helper'),'#!/bin/sh\nexit 0\n');
  await chmod(join(pkg,'helper'),0o755);
  await writeFile(join(pkg,'package.json'),'{"name":"example","version":"1.0.0"}');
  await chmod(join(pkg,'package.json'),0o644);
  await writeFile(join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{[location]:{version:'1.0.0'}}}));
  const groups=await releaseLayout(root,[],['example']);
  const direct=join(root,'direct.rsi'), release=join(root,'release.rsi');
  await writePayload(pkg,direct,{prefix:location});
  await writePayloadFiles(groups.get('example')[0].files,release);
  for(const file of [direct,release]){
    const bytes=await readFile(file);
    const {files}=JSON.parse(bytes.subarray(12,12+bytes.readUInt32LE(8)));
    assert.deepEqual(files.map(({path,executable})=>[path,executable]),[[location+'/helper',true],[location+'/package.json',false]]);
  }
});

test('Office uses the target engine while separately requested engines remain installable',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-office-engines-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const provider='@deepseek-ai/dsh-office-kit',kit='@deepseek-ai/libreoffice-kit';
  const native=kit+'-win32-x64',wasm=kit+'-wasm';
  const graph={
    [provider]:{dependencies:{[kit]:'1'}},
    [kit]:{optionalDependencies:{[native]:'1',[wasm]:'1',helper:'1'}},
    [native]:{optional:true},[wasm]:{optional:true},helper:{optional:true},
    extension:{dependencies:{[wasm]:'1'}},
  };
  const packages={};
  for(const [name,fields] of Object.entries(graph)){
    const location='node_modules/'+name,directory=join(root,location);
    await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'package.json'),JSON.stringify({name,version:'1',...fields}));
    packages[location]={version:'1',...fields};
  }
  await writeFile(join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages}));
  const build=(platform,plugins=[])=>releaseLayout(root,[provider],plugins,undefined,{runtimeTarget:{platform,arch:'x64'}});
  const names=rows=>rows.map(row=>row.location.slice(13)).sort();
  const windows=await build('win32',['extension']);
  assert.deepEqual(names(windows.get('runtime')),[provider,kit,native,'helper'].sort());
  assert.deepEqual(names(windows.get('extension')),['extension',wasm].sort());
  assert.deepEqual(names((await build('linux')).get('runtime')),[provider,kit,wasm,'helper'].sort());
  const independent=await releaseLayout(root,['helper'],[kit],undefined,{runtimeTarget:{platform:'win32',arch:'x64'}});
  assert.deepEqual(names(independent.get(kit)),[kit,native,wasm].sort());
  await rm(join(root,'node_modules',native),{recursive:true});
  await assert.rejects(build('win32'),/Missing dependency @deepseek-ai\/libreoffice-kit-win32-x64/);
});

test('only the host terminal ships target-specific prebuilds',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-terminal-prebuilds-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const host='node_modules/node-pty',guest='node_modules/extension',privatePty=guest+'/'+host;
  const common=['build/Release/pty.node','package.json','prebuilds/README'];
  const linux='prebuilds/linux-x64/pty.node',windows='prebuilds/win32-x64/conpty/pty.node';
  const all=[...common,linux,windows].sort();
  const packages={[host]:{version:'1'},[guest]:{version:'1',dependencies:{'node-pty':'2'}},[privatePty]:{version:'2'}};
  for(const [location,manifest] of Object.entries(packages)){
    for(const file of location===guest?['package.json']:all){
      const path=join(root,location,file);
      await mkdir(dirname(path),{recursive:true});
      await writeFile(path,file==='package.json'?JSON.stringify(manifest):file);
    }
  }
  await writeFile(join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages}));
  for(const [platform,expected] of [['win32',[...common,windows]],['linux',[...common,linux]],[undefined,all]]){
    const runtimeTarget=platform && {platform,arch:'x64'};
    const groups=await releaseLayout(root,['node-pty'],['extension'],undefined,{runtimeTarget});
    const paths=row=>row.files.map(file=>file.path.slice(row.location.length+1)).sort();
    assert.deepEqual(paths(groups.get('runtime')[0]),expected.sort());
    assert.deepEqual(paths(groups.get('extension').find(row=>row.location===privatePty)),all);
  }
});

test('files and shared directories use the native entry budget',()=>{
  const group = n=>({location:'node_modules/pkg'+n,dependencies:{},files:Array.from({length:32766},(_,i)=>({path:'node_modules/pkg'+n+'/'+i,bytes:1}))});
  const packages=[group(1),group(2)];
  packages[0].files.push({path:'node_modules/pkg1/extra',bytes:1});
  assert.deepEqual(splitPayloads(packages).map(part=>part.length),[2]);
  packages[0].files.push({path:'node_modules/pkg1/another',bytes:1});
  assert.deepEqual(splitPayloads(packages).map(part=>part.length),[1,1]);
  assert.throws(()=>packageLocation('node_modules/pkg/../../secrets'));
});

test('transitive, cyclic and shared dependencies stay together when their physical tree fits',()=>{
  const pkg=(name,bytes,dependencies={})=>({location:'node_modules/'+name,dependencies,
    files:[{path:'node_modules/'+name+'/index.js',bytes}]});
  const helper=pkg('helper',1),library=pkg('library',1,{helper:helper.location});
  const runner=pkg('new-plugin',2*1024**3,{library:library.location});
  const sibling=pkg('another-plugin',1,{helper:helper.location,peer:'node_modules/host-peer'});
  helper.dependencies.library=library.location;
  const large=pkg('independent',3*1024**3);
  const packages=[runner,large,sibling,library,helper];
  const [first,second]=splitPayloads(packages);
  assert.deepEqual(new Set(first),new Set([runner,library,helper,sibling]));
  assert.deepEqual(second,[large]);
  runner.dependencies.large=large.location;
  const overflow=splitPayloads(packages);
  assert.equal(overflow.length,2);
  assert.deepEqual(new Set(overflow.flat()),new Set(packages));
  large.files[0].bytes=4*1024**3;
  assert.throws(()=>splitPayloads(packages),/Package exceeds a payload/);
});

test('the native container budget includes its prefix and encoded index',()=>{
  const maximum=4*1024**3,path='node_modules/example/document.txt';
  const record={path,bytes:maximum,digest:'0'.repeat(64),executable:false};
  const indexBytes=12+Buffer.byteLength(JSON.stringify({format:1,files:[record]}));
  const file={path,bytes:maximum-indexBytes};
  const pkg={location:'node_modules/example',dependencies:{},files:[file]};
  assert.deepEqual(splitPayloads([pkg]),[[pkg]]);
  file.bytes++;
  assert.throws(()=>splitPayloads([pkg]),/Package exceeds a payload/);
});

test('installation bundle lookup keeps the runtime dependency across a market shadow',async t=>{
  const runtime='node_modules/runtime',bundle='node_modules/bundle';
  const nested=runtime+'/'+bundle;
  const root=await mkdtemp(join(tmpdir(),'rsi-bundle-lookup-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const roots=new Map([['release',root],['market',join(root,'market')]]);
  const shipped=join(root,nested),profile=join(roots.get('market'),bundle);
  for(const directory of [shipped,profile]) {
    await mkdir(directory,{recursive:true});await writeFile(join(directory,'index.js'),'module.exports = {}');
  }
  const resolver=installReleaseResolver({format:1,runtime:'runtime',locations:{
    [runtime]:{package:'release',dependencies:{bundle:nested}},
    [nested]:{package:'release',dependencies:{}},
  }},roots);
  t.after(()=>resolver.close());
  const unselect=resolver.add({format:1,locations:{[bundle]:{package:'market',dependencies:{}}}},roots,['bundle']);
  assert.equal(resolver.directory('bundle'),join(roots.get('market'),bundle));
  assert.equal(resolver.entry('bundle'),join(shipped,'index.js'));
  assert.equal(resolver.installationDependency('bundle'),join(roots.get('release'),nested));
  assert.equal(resolver.installationDependency('runtime'),undefined);
  unselect();
  assert.equal(resolver.directory('bundle'),join(roots.get('release'),nested));
});

test('profile entries and public metadata resolve hoisted market dependencies for the life of their link',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-profile-hoisting-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const profile=join(root,'profile'),base=pathToFileURL(join(profile,'cordis.yml')).href;
  const roots=new Map([['host',join(root,'host')],['market',join(root,'market')]]);
  const resolver=installReleaseResolver({format:1,locations:{}},roots,profile);t.after(()=>resolver.close());
  const locations={};
  for(const name of ['bundle','tool','bundle/node_modules/private-tool']){
    const location='node_modules/'+name,directory=join(roots.get('market'),location);
    await mkdir(directory,{recursive:true});await writeFile(join(directory,'index.js'),'module.exports={}');
    locations[location]={package:'market',dependencies:{}};
  }
  const bundle=resolver.prepare({format:1,locations},roots,['bundle']);
  const retire=bundle.publish();
  assert.throws(()=>resolver.entry('tool'),/Not a profile package/);
  resolver.setProfileLink('bundle',bundle.directory('bundle'));
  assert.equal(resolver.entry('tool'),join(bundle.directory('tool'),'index.js'));
  assert.equal(resolver.bindingFor('tool',base).directory,bundle.directory('tool'));
  assert.equal(resolver.bindingFor('private-tool',base),undefined);
  assert.throws(()=>resolver.entry('private-tool'),/Not a profile package/);
  resolver.setProfileLink('bundle',undefined);
  assert.equal(resolver.bindingFor('tool',base),undefined);
  assert.throws(()=>resolver.entry('tool'),/Not a profile package/);
  retire();
});

test('a repacked host owns a captured peer and its internal dependencies even after hoisting',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-repacked-peer-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const shared='node_modules/shared',ext='node_modules/ext',oldShared=ext+'/node_modules/shared';
  for(const [location,body] of [[shared,'module.exports = {}'],[ext,"module.exports = require('shared')"]]){
    await mkdir(join(dir,location),{recursive:true});await writeFile(join(dir,location,'index.js'),body);
  }
  const format={format:1,version:'0.2.1-rc.5'};
  const resolver=installReleaseResolver({...format,locations:{[shared]:{package:'rsi-dsh-runtime-0',version:'1.0.0',dependencies:{}}}},new Map([['rsi-dsh-runtime-0',dir]]));
  t.after(()=>resolver.close());
  const graph={...format,locations:{[ext]:{package:'private',dependencies:{shared:oldShared}},
    [oldShared]:{package:'rsi-dsh-runtime-3',version:'1.0.0',dependencies:{inner:'node_modules/inner'}},
    'node_modules/inner':{package:'rsi-dsh-runtime-2',version:'9.0.0',dependencies:{}}}};
  const roots=new Map([['private',dir]]),release=resolver.add(graph,roots);
  const require=createRequire(import.meta.url);
  assert.equal(require(resolver.entry('ext')),require(resolver.entry('shared')));
  release();assert.throws(()=>resolver.entry('ext'),/Not a profile package/);
  graph.locations[oldShared].version='2.0.0';
  assert.throws(()=>resolver.add(graph,roots,['ext']),/Reinstall.*shared@2\.0\.0/);
  assert.ok(resolver.entry('shared'));
});

test('a plugin can cross a DSH release when its manifest and resolved host peer agree', {skip:!process.env.RSI_DSH_NPM_ROOT},async t=>{
  const npm=process.env.RSI_DSH_NPM_ROOT,dir=await mkdtemp(join(tmpdir(),'rsi-portable-peer-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const boot='node_modules/@deepseek-ai/dsh-app-boot',ext='node_modules/ext',dep='node_modules/semver';
  for(const location of [boot,ext]){await mkdir(join(dir,location),{recursive:true});await writeFile(join(dir,location,'index.js'),"module.exports = require('semver')");}
  const version=JSON.parse(await readFile(join(npm,dep,'package.json'),'utf8')).version;
  const resolver=installReleaseResolver({format:1,version:'0.2.1-rc.5',locations:{
    [boot]:{package:'rsi-dsh-runtime-0',dependencies:{semver:dep}},[dep]:{package:'rsi-dsh-runtime-1',version,dependencies:{}}}},
    new Map([['rsi-dsh-runtime-0',dir],['rsi-dsh-runtime-1',npm]]));
  t.after(()=>resolver.close());
  const graph={format:2,version:'0.2.1-rc.4',plugins:['ext'],hostPeers:{[dep]:version},locations:{[ext]:{package:'private',dependencies:{semver:dep}}}};
  const roots=new Map([['private',dir]]),manifest=join(dir,ext,'package.json');
  await writeFile(manifest,JSON.stringify({name:'ext',engines:{dsh:'^0.2.1-rc.1'}}));
  const release=resolver.add(graph,roots),require=createRequire(import.meta.url);
  assert.equal(require(resolver.entry('ext')),require(resolver.entry('semver')));release();
  await writeFile(manifest,JSON.stringify({name:'ext',engines:{dsh:'>=0.3.0'}}));
  assert.throws(()=>resolver.add(graph,roots),/Incompatible engines.dsh/);
  graph.hostPeers[dep]='99.0.0';assert.throws(()=>resolver.add(graph,roots),/Reinstall.*semver@99/);
});

test('leased runtime peers share identity while nested private dependencies keep their own version',async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'rsi-resolve-'));
  t.after(()=>rm(tmp,{recursive:true,force:true}));
  const roots=new Map([['host',join(tmp,'host')],['private',join(tmp,'private')],['extension',join(tmp,'extension')]]);
  const locations={};
  async function pkg(layer,path,name,contents,dependencies={}) {
    const dir=join(roots.get(layer),path);
    await mkdir(dir,{recursive:true});
    await writeFile(join(dir,'package.json'),JSON.stringify({name,main:'main.cjs',exports:{'.':{import:'./main.mjs',require:'./main.cjs'}}}));
    await writeFile(join(dir,'main.cjs'),contents);
    await writeFile(join(dir,'main.mjs'),"import value from './main.cjs'; export default value;");
    locations[path]={package:layer,dependencies};
  }
  await pkg('host','node_modules/shared','shared',"module.exports = {}");
  await pkg('private','node_modules/ext/node_modules/private-lib','private-lib',"module.exports = 'private'");
  await pkg('extension','node_modules/ext','ext',"module.exports={shared:require('shared'),version:require('private-lib')};",
    {shared:'node_modules/shared','private-lib':'node_modules/ext/node_modules/private-lib'});
  const resolver=installReleaseResolver({format:1,locations},roots);
  t.after(()=>resolver.close());
  const cjs=createRequire(join(roots.get('extension'),'package.json'));
  const ext=cjs('ext');
  assert.equal(resolver.entry('ext'),join(roots.get('extension'),'node_modules/ext/main.mjs'));
  assert.equal(ext.shared,(await import(pathToFileURL(resolver.entry('shared')))).default);
  assert.equal(ext.version,'private');
  assert.equal((await import(pathToFileURL(resolver.entry('ext')))).default.shared,ext.shared);
  const extraPath=join(roots.get('extension'),'node_modules/market-probe');
  await mkdir(extraPath,{recursive:true});
  await writeFile(join(extraPath,'probe.mjs'),"export const shared=(await import('shared')).default");
  resolver.add({format:1,locations:{'node_modules/market-probe':{package:'extension',dependencies:{}}}},
    roots,['market-probe']);
  const probe=createRequire(pathToFileURL(join(extraPath,'probe.mjs')));
  assert.equal(resolver.entry(pathToFileURL(join(extraPath,'probe.mjs')).href),join(extraPath,'probe.mjs'));
  assert.throws(()=>resolver.entry(import.meta.url),/outside the leased profile/);
  assert.equal(probe('shared'),ext.shared);
  assert.equal((await import(pathToFileURL(join(extraPath,'probe.mjs')))).shared,ext.shared);
});
