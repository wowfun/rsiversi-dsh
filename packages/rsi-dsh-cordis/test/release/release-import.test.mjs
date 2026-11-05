import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {importRelease} from '../../src/release/import.mjs';

const npmRoot=process.env.RSI_DSH_NPM_ROOT;
test('an app-boot compatible prerelease peer binds to the host without leasing a second payload',{skip:!npmRoot},async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-host-peer-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const npm=createRequire(join(npmRoot,'package.json')),peer='@deepseek-ai/dsh-agent',version='0.2.2-rc.1';
  const source=join(root,'package'),plugin=join(root,'plugin'),staging=join(root,'staging');
  await Promise.all([source,plugin,staging].map(path=>mkdir(path)));
  const manifest={name:peer,version};await writeFile(join(source,'package.json'),JSON.stringify(manifest));
  const archive=join(root,'peer.tgz');await npm('tar').c({cwd:root,gzip:true,file:archive},['package']);
  const bytes=await readFile(archive),integrity='sha512-'+createHash('sha512').update(bytes).digest('base64');
  const server=createServer((req,res)=>{
    if(decodeURIComponent(req.url)==='/'+peer){res.setHeader('content-type','application/json');
      res.end(JSON.stringify({name:peer,'dist-tags':{latest:version},versions:{[version]:{...manifest,dist:{tarball:registry+'peer.tgz',integrity}}}}));}
    else if(req.url==='/peer.tgz')res.end(bytes);else res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const registry='http://127.0.0.1:'+server.address().port+'/';
  await writeFile(join(plugin,'package.json'),JSON.stringify({name:'peer-plugin',version:'1.0.0',
    peerDependencies:{[peer]:'^0.2.1-rc.1'},peerDependenciesMeta:{[peer]:{optional:true}},dsh:{bundle:{patch:'bundle.yml'}}}));
  await writeFile(join(plugin,'bundle.yml'),'plugins: []\n');
  const held={package:'rsi-dsh-runtime-0',version,dependencies:{}};
  const base={version,plugins:[],locations:{'node_modules/@deepseek-ai/dsh':held,['node_modules/'+peer]:held}};
  const result=await importRelease(base,npmRoot,{format:1,workspace:root,staging,specifications:[plugin],options:{registry}},new AbortController().signal);
  const selection=join(staging,result.directories.at(-1));
  const layout=JSON.parse(await readFile(join(selection,'layout.json'),'utf8'));
  assert.deepEqual(layout.hostPeers,{['node_modules/'+peer]:version});
  assert.deepEqual(Object.keys(layout.locations),['node_modules/peer-plugin']);
  const stored=JSON.parse(await readFile(join(selection,'package.json'),'utf8'));
  assert.deepEqual(stored.dependencies.map(row=>row.name),[layout.locations['node_modules/peer-plugin'].package]);
});

test('importing a plugin with no runtime edges does not fetch the DSH host or an unrelated runtime package',{skip:!npmRoot},async t=>{
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
  const result=await importRelease(base,npmRoot,{format:1,workspace:root,staging,target:'fixture',
    specifications:[plugin],importer:{dependencies:[]},options:{registry:'http://127.0.0.1:'+server.address().port}},
    new AbortController().signal);
  const name=result.directories.find(n=>n.startsWith('rsi-dsh-selection-'));
  assert.ok(name);const declared=JSON.parse(await readFile(join(staging,name,'package.json'),'utf8'));
  assert.equal(declared.dependencies.length,1);
  assert.deepEqual(requests,[]);
});
