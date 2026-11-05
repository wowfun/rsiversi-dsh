import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {packageLocation, runtimePayloads, splitPayloads} from '../../src/release/layout.mjs';
import {installReleaseResolver} from '../../src/release/resolver.mjs';

test('two large independent plugins partition at a package boundary',()=>{
  const group = n=>({location:'node_modules/pkg'+n,files:Array.from({length:9000},(_,i)=>({path:'node_modules/pkg'+n+'/'+i,bytes:1}))});
  assert.deepEqual(splitPayloads([group(1),group(2)]).map(part=>part.length),[1,1]);
  assert.throws(()=>packageLocation('node_modules/pkg/../../secrets'));
});

test('child runners keep transitive npm dependencies in their own physical payload',()=>{
  const pkg=(name,bytes,dependencies={})=>({location:'node_modules/'+name,dependencies,
    files:[{path:'node_modules/'+name+'/index.js',bytes}]});
  const helper=pkg('helper',100),library=pkg('library',100,{helper:helper.location});
  const runner=pkg('@deepseek-ai/dsh-subprocess-local',100,{library:library.location});
  const acl=pkg('host/node_modules/@deepseek-ai/dsh-sandbox-windows-acl',100,{helper:helper.location});
  const large=pkg('independent',4*1024**3-200);
  const packages=[runner,large,acl,library,helper];
  assert.ok(!splitPayloads(packages)[0].includes(helper));
  const [first,second]=runtimePayloads(packages);
  assert.deepEqual(new Set(first),new Set([runner,library,helper,acl]));
  assert.deepEqual(second,[large]);
  runner.dependencies.large=large.location;
  assert.throws(()=>runtimePayloads(packages),/exceed one runtime payload/);
});

test('installation bundle lookup keeps the runtime dependency across a market shadow',t=>{
  const runtime='node_modules/runtime',bundle='node_modules/bundle';
  const nested=runtime+'/'+bundle;
  const roots=new Map([['release',tmpdir()],['market',join(tmpdir(),'market')]]);
  const resolver=installReleaseResolver({format:1,runtime:'runtime',locations:{
    [runtime]:{package:'release',dependencies:{bundle:nested}},
    [nested]:{package:'release',dependencies:{}},
  }},roots);
  t.after(()=>resolver.close());
  resolver.add({format:1,locations:{[bundle]:{package:'market',dependencies:{}}}},roots,['bundle']);
  assert.equal(resolver.directory('bundle'),join(roots.get('market'),bundle));
  assert.equal(resolver.installationDependency('bundle'),join(roots.get('release'),nested));
  assert.equal(resolver.installationDependency('runtime'),undefined);
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
  const cjs=createRequire(import.meta.url), ext=cjs(resolver.entry('ext'));
  assert.equal(ext.shared,cjs(resolver.entry('shared')));
  assert.equal(ext.version,'private');
  assert.equal((await import(pathToFileURL(join(roots.get('extension'),'node_modules/ext/main.mjs')))).default.shared,ext.shared);
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
