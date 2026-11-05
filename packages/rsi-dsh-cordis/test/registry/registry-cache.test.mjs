import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdir,mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {installNpm,moveRegistryCache,profileState,registryCache,registryEnvironment} from '../../src/registry/npm-install.mjs';

const npm=process.env.RSI_DSH_NPM_ROOT;
test('compatible plugin dependency ranges share one installed module', {skip:!npm},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'rsi-npm-placement-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const leaf='shared-fixture', versions={}, archives=new Map();
  const source=join(dir,'package'), stage=join(dir,'stage'), work=join(dir,'work');
  await Promise.all([source,stage,work].map(path=>mkdir(path)));
  const server=createServer((req,res)=>{
    if(req.url==='/'+leaf){
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({name:leaf,'dist-tags':{latest:'1.1.0'},versions}));
    }else if(archives.has(req.url))res.end(archives.get(req.url));
    else res.writeHead(404).end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const registry='http://127.0.0.1:'+server.address().port+'/';
  const tar=createRequire(join(npm,'package.json'))('tar');
  for(const version of ['1.0.0','1.1.0']){
    const manifest={name:leaf,version};
    await writeFile(join(source,'package.json'),JSON.stringify(manifest));
    const file=version+'.tgz';
    await tar.c({cwd:dir,gzip:true,file:join(dir,file)},['package']);
    const bytes=await readFile(join(dir,file));
    archives.set('/'+file,bytes);
    versions[version]={...manifest,dist:{tarball:registry+file,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')}};
  }
  const roots=[];
  for(const [name,range] of [['a-flexible','^1.0.0'],['b-exact','1.0.0'],['c-exact','1.0.0']]){
    const path=join(dir,name);roots.push(path);await mkdir(path);
    await writeFile(join(path,'package.json'),JSON.stringify({name,version:'1.0.0',dependencies:{[leaf]:range}}));
  }
  await writeFile(join(stage,'package.json'),'{"name":"probe","private":true}');
  await installNpm(npm,stage,work,roots,AbortSignal.timeout(30000),registry,join(dir,'cache'));
  const {packages}=JSON.parse(await readFile(join(stage,'package-lock.json'),'utf8'));
  assert.deepEqual(Object.keys(packages).filter(location=>location.endsWith('/'+leaf)),['node_modules/'+leaf]);
  const shared=join(stage,'node_modules',leaf,'package.json');
  assert.equal(JSON.parse(await readFile(shared,'utf8')).version,'1.0.0');
  for(const path of roots){
    const name=JSON.parse(await readFile(join(path,'package.json'),'utf8')).name;
    assert.equal(createRequire(join(stage,'node_modules',name,'package.json')).resolve(leaf+'/package.json'),shared);
  }
});
test('only credential-free registry networking survives the npm child environment',()=>{
  assert.deepEqual(registryEnvironment({HTTP_PROXY:'http://user:password@proxy:123',https_proxy:'http://localhost:456',
    NO_PROXY:'127.0.0.1',TOKEN:'secret',NODE_OPTIONS:'--inspect'}),{HTTPS_PROXY:'http://localhost:456',NO_PROXY:'127.0.0.1',NODE_USE_ENV_PROXY:'1'});
  assert.deepEqual(registryEnvironment({HTTP_PROXY:'socks://proxy',NO_PROXY:'localhost'}),{NO_PROXY:'localhost'});
});
test('opening an existing profile moves only its npm cache outside portable backup',async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-portable-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const profile=join(root,'work'),legacy=join(profile,'cache','npm');
  await mkdir(legacy,{recursive:true});await writeFile(join(legacy,'tarball'),'previous');
  await writeFile(join(profile,'cache','mine'),'profile data');
  await moveRegistryCache(profile);await moveRegistryCache(profile);
  assert.equal(await readFile(join(registryCache(profile),'tarball'),'utf8'),'previous');
  assert.deepEqual(await readdir(join(profile,'cache')),['mine']);
  await mkdir(legacy);await writeFile(join(legacy,'tarball'),'alternate');
  await moveRegistryCache(profile);
  const old=(await readdir(profileState(profile))).find(name=>name.startsWith('npm-previous-'));
  assert.equal(await readFile(join(profileState(profile),old,'tarball'),'utf8'),'alternate');
});
test('two isolated installs reuse the integrity-checked registry tarball', {skip:!npm},async t=>{
  const root=await mkdtemp(join(tmpdir(),'rsi-registry-cache-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),name='cached-fixture',version='1.0.0';
  await mkdir(source);
  await writeFile(join(source,'package.json'),JSON.stringify({name,version}));
  await writeFile(join(source,'receipt'),'one published tarball');
  const [packed]=JSON.parse(execFileSync(process.execPath,[join(npm,'bin/npm-cli.js'),'pack','--ignore-scripts','--json',
    '--pack-destination',root],{cwd:source,windowsHide:true,encoding:'utf8'}));
  const bytes=await readFile(join(root,packed.filename));
  let registry,downloads=0;
  const server=createServer((req,res)=>{
    if(req.url==='/'+name) {
      const dist={tarball:registry+packed.filename,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')};
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({name,'dist-tags':{latest:version},versions:{[version]:{name,version,dist}}}));
    } else if(req.url==='/'+packed.filename) {
      downloads++;
      res.setHeader('cache-control','public, max-age=86400');
      res.end(bytes);
    } else {res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  registry='http://127.0.0.1:'+server.address().port+'/';
  for(const id of ['first','second']) {
    const stage=join(root,id),work=join(root,id+'-work');
    await mkdir(stage);await mkdir(work);
    await writeFile(join(stage,'package.json'),'{"name":"probe","private":true}');
    await installNpm(npm,stage,work,[name+'@'+version],AbortSignal.timeout(120000),registry,join(root,'cache','npm'));
    assert.equal(await readFile(join(stage,'node_modules',name,'receipt'),'utf8'),'one published tarball');
  }
  assert.equal(downloads,1);
});
