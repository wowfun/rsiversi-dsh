import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {importRelease} from '../../src/release/import.mjs';

const npmRoot=process.env.RSI_DSH_NPM_ROOT;
test('a shipped bundle can be selected from a profile while runtime services remain immutable',{skip:!npmRoot},async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-shipped-bundle-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime='@deepseek-ai/dsh',name='@deepseek-ai/installable-fixture',location='node_modules/'+name;
  const installed=join(root,'lease',location),candidate=join(root,'candidate'),staging=join(root,'staging');
  await Promise.all([installed,candidate,staging].map(path=>mkdir(path,{recursive:true})));
  const bundle={name,version:'1.0.0',dsh:{bundle:{patch:'./patch.yml'}}};
  await writeFile(join(installed,'package.json'),JSON.stringify(bundle));
  await writeFile(join(candidate,'package.json'),JSON.stringify({...bundle,version:'1.0.1'}));
  await writeFile(join(candidate,'patch.yml'),'[]\n');
  const base={runtime,plugins:[],version:'1.0.0',locations:{
    ['node_modules/'+runtime]:{version:'1.0.0',dependencies:{[name]:location}},
    [location]:{package:'shard',version:'1.0.0',dependencies:{}}}};
  const roots=new Map([['shard',join(root,'lease')]]),signal=new AbortController().signal;
  const request={format:1,workspace:root,staging,specifications:[candidate],options:{registry:'http://127.0.0.1:1'}};
  const result=await importRelease(base,npmRoot,request,signal,roots);
  const layout=JSON.parse(await readFile(join(staging,result.directories.at(-1),'layout.json')));
  assert.deepEqual(layout.plugins,[name]);assert.equal(layout.locations[location].version,'1.0.1');
  await writeFile(join(installed,'package.json'),JSON.stringify({name,version:'1.0.0'}));
  await assert.rejects(importRelease(base,npmRoot,request,signal,roots),/Cannot replace active runtime package/);
});
test('an app-boot compatible prerelease peer binds to the host without leasing a second payload',{skip:!npmRoot},async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-host-peer-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const peer='@deepseek-ai/dsh-agent',cordis='@deepseek-ai/cordis',version='0.2.3-alpha.2';
  const plugin=join(root,'plugin'),staging=join(root,'staging');
  await Promise.all([plugin,staging].map(path=>mkdir(path)));
  const requests=[];
  const server=createServer((req,res)=>{requests.push(req.url);res.writeHead(404).end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const registry='http://127.0.0.1:'+server.address().port+'/';
  await writeFile(join(plugin,'package.json'),JSON.stringify({name:'peer-plugin',version:'1.0.0',
    peerDependencies:{[peer]:'^0.2.1-rc.1',[cordis]:'^4.0.1','optional-ui':'^1',react:'^18'},
    peerDependenciesMeta:{[peer]:{optional:true},'optional-ui':{optional:true}},dsh:{bundle:{patch:'bundle.yml'}}}));
  await writeFile(join(plugin,'bundle.yml'),'plugins: []\n');
  const held={package:'rsi-dsh-runtime-0',version,dependencies:{}};
  const base={version,plugins:[],locations:{'node_modules/@deepseek-ai/dsh':held,['node_modules/'+peer]:held,
    ['node_modules/'+cordis]:{...held,version:'4.2.0-alpha.1'}}};
  const result=await importRelease(base,npmRoot,{format:1,workspace:root,staging,specifications:[plugin],options:{registry}},new AbortController().signal);
  const selection=join(staging,result.directories.at(-1));
  const layout=JSON.parse(await readFile(join(selection,'layout.json'),'utf8'));
  assert.deepEqual(requests,[]);
  assert.deepEqual(layout.hostPeers,{['node_modules/'+peer]:version,['node_modules/'+cordis]:'4.2.0-alpha.1'});
  assert.deepEqual(Object.keys(layout.locations),['node_modules/peer-plugin']);
  const stored=JSON.parse(await readFile(join(selection,'package.json'),'utf8'));
  assert.deepEqual(stored.dependencies.map(row=>row.name),[layout.locations['node_modules/peer-plugin'].package]);
});

test('local same-version imports snapshot new bytes without fetching the DSH host or unrelated packages',{skip:!npmRoot},async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-actual-plugin-edges-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const staging=join(root,'staging'),plugin=join(root,'tiny-plugin');
  await mkdir(staging);await mkdir(plugin);
  await writeFile(join(plugin,'package.json'),JSON.stringify({name:'tiny-plugin',version:'1.0.0',main:'index.js',dsh:{bundle:{patch:['first.yml','patch.yml']}}}));
  await writeFile(join(plugin,'first.yml'),'plugins: []\n');
  await writeFile(join(plugin,'patch.yml'),'plugins: []\n');
  await writeFile(join(plugin,'index.js'),'module.exports=()=>{};');
  const requests=[];
  const server=createServer((req,res)=>{requests.push(req.url);res.writeHead(404).end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const active={package:'rsi-runtime',version:'0.2.1-rc.5',dependencies:{}};
  const base={version:'0.2.1-rc.5',plugins:[],locations:{'node_modules/@deepseek-ai/dsh':active,'node_modules/@deepseek-ai/unrelated':active}};
  const workspace=join(root,'profile');await mkdir(workspace);
  const result=await importRelease(base,npmRoot,{format:1,workspace,staging,target:'fixture',
    specifications:[plugin],importer:{dependencies:[]},options:{cache:true,registry:'http://127.0.0.1:'+server.address().port}},
    new AbortController().signal);
  const name=result.directories.find(n=>n.startsWith('rsi-dsh-selection-'));
  assert.ok(name);const declared=JSON.parse(await readFile(join(staging,name,'package.json'),'utf8'));
  assert.equal(declared.dependencies.length,1);
  const original=await payloadEntry(staging,declared.dependencies[0].name,'node_modules/tiny-plugin/index.js');
  assert.equal(original,'module.exports=()=>{};');
  await writeFile(join(plugin,'index.js'),'module.exports="replacement";');
  const next=join(root,'next');await mkdir(next);
  const replaced=await importRelease(base,npmRoot,{format:1,workspace,staging:next,
    specifications:[plugin],options:{cache:true,registry:'http://127.0.0.1:'+server.address().port}},new AbortController().signal);
  const replacement=JSON.parse(await readFile(join(next,replaced.directories.at(-1),'package.json'),'utf8'));
  assert.notEqual(replacement.dependencies[0].digest,declared.dependencies[0].digest);
  assert.equal(await payloadEntry(next,replacement.dependencies[0].name,'node_modules/tiny-plugin/index.js'),'module.exports="replacement";');
  assert.equal(await payloadEntry(staging,declared.dependencies[0].name,'node_modules/tiny-plugin/index.js'),original);
  assert.deepEqual(requests,[]);
});

async function payloadEntry(staging,name,path) {
  const directory=join(staging,name),manifest=JSON.parse(await readFile(join(directory,'package.json')));
  const payload=await readFile(join(directory,manifest.exports.runtime.path));
  assert.equal(payload.subarray(0,8).toString(),'RSITREE1');
  const size=payload.readUInt32LE(8),tree=JSON.parse(payload.subarray(12,12+size));
  let offset=12+size;
  for(const file of tree.files) {
    if(file.path===path)return payload.subarray(offset,offset+file.bytes).toString();
    offset+=file.bytes;
  }
  assert.fail('Missing payload entry '+path);
}
