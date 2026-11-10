import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {installReleaseResolver} from '../../../rsi-dsh-cordis/src/release/resolver.mjs';
import {leasedPluginPackages} from '../../src/application/package-metadata.mjs';
import {linkProfilePackage,unlinkProfilePackage} from '../../src/market/profile-files.mjs';

const root=process.env.RSI_DSH_MARKET_COHORT;
for(const initial of ['market','host'])test('a running profile resolves a relinked '+initial+' package from the same config URL', {skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
  const boot=await load('dsh-app-boot'), ctx=new (await load('cordis')).Context();
  const work=await mkdtemp(join(tmpdir(),'rsi-profile-lookup-'));t.after(()=>rm(work,{recursive:true,force:true}));
  const profile=join(work,'profile'),parent=pathToFileURL(join(profile,'cordis.yml')).href;
  const name='market-test',location='node_modules/'+name;
  const payload=version=>new Map([['payload',join(work,version)]]);
  const exportsManifest=version=>initial==='market'||version==='1.0.0';
  const graph=version=>({format:1,plugins:[name],locations:{[location]:{package:'payload',version,dependencies:{}}}});
  for(const version of ['1.0.0','2.0.0']){
    const directory=join(work,version,location);
    await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'package.json'),JSON.stringify({name,version,description:version,
      exports:{...(exportsManifest(version)?{'./package.json':'./package.json'}:{}),'./resource':{import:'./item.mjs',require:'./item.cjs'}}}));
    for(const file of ['item.mjs','item.cjs'])await writeFile(join(directory,file),'');
  }
  const resolver=installReleaseResolver({...graph('1.0.0'),plugins:initial==='market'?[name]:[]},payload('1.0.0'),profile);
  t.after(()=>resolver.close());await ctx.plugin(leasedPluginPackages(boot,resolver));t.after(()=>ctx.fiber.dispose());
  const inspect=version=>{
    const directory=join(work,version,location);
    assert.equal(ctx.pluginPackages.packageOf(name+'/resource',parent).version,version);
    assert.equal(ctx.pluginPackages.packageOf(name,parent).dir,directory);
    if(exportsManifest(version))assert.equal(ctx.pluginPackages.metaOf(name,parent).description,version);
    else {
      assert.equal(ctx.pluginPackages.metaOf(name,parent),undefined);
      assert.throws(()=>boot.resolvePluginResource(name+'/package.json',parent),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
    }
    assert.equal(boot.resolvePluginResource(name+'/resource',parent),join(directory,'item.mjs'));
    assert.equal(createRequire(parent).resolve(name+'/resource'),join(directory,'item.cjs'));
  };
  const publish=version=>linkProfilePackage(profile,name,join(work,version,location),resolver.setProfileLink);
  const oldParent=pathToFileURL(join(work,'1.0.0',location,'item.mjs')).href;
  await publish('1.0.0');inspect('1.0.0');
  const retire=resolver.add(graph('2.0.0'),payload('2.0.0'),[name]);
  inspect('1.0.0');
  await publish('2.0.0');inspect('2.0.0');
  assert.equal(ctx.pluginPackages.packageOf(name,oldParent).version,'1.0.0');
  const shadow=join(profile,'node_modules','editable','node_modules',name);
  await mkdir(shadow,{recursive:true});await writeFile(join(shadow,'package.json'),JSON.stringify({name,version:'local'}));
  const local=pathToFileURL(join(profile,'node_modules/editable/entry.mjs')).href;
  assert.equal(ctx.pluginPackages.packageOf(name,local).version,'local');
  await unlinkProfilePackage(profile,name,resolver.setProfileLink);
  assert.equal(ctx.pluginPackages.packageOf(name,parent),undefined);
  assert.equal(ctx.pluginPackages.metaOf(name,parent),undefined);
  assert.throws(()=>boot.resolvePluginResource(name+'/resource',parent),{code:'ERR_MODULE_NOT_FOUND'});
  assert.throws(()=>createRequire(parent).resolve(name+'/resource'),{code:'MODULE_NOT_FOUND'});
  assert.equal(ctx.pluginPackages.packageOf(name,oldParent).version,'1.0.0');
  assert.equal(ctx.pluginPackages.packageOf(name,local).version,'local');
  retire();await publish('1.0.0');inspect('1.0.0');
});

test('original package metadata follows its resolved lease; editable, subpath and failed reads stay live',{skip:!root},async t=>{
  const require=createRequire(join(root,'package.json'));
  const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)).href);
  const boot=await load('dsh-app-boot'),ctx=new (await load('cordis')).Context();
  const work=await mkdtemp(join(tmpdir(),'rsi-meta-display-'));
  t.after(()=>rm(work,{recursive:true,force:true}));
  const name='fixture-pkg',location='node_modules/'+name;
  async function tree(id,title) {
    const base=join(work,id),dir=join(base,location);
    await mkdir(join(dir,'locale'),{recursive:true});
    await writeFile(join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',exports:{
      './package.json':'./package.json','./locale/*.json':'./locale/*.json','./extra/locale/*.json':'./locale/*.json'}}));
    const locale=join(dir,'locale/en.json');
    await writeFile(locale,JSON.stringify({meta:{title}}));
    return {base,parent:pathToFileURL(join(base,'cordis.yml')).href,locale};
  }
  const first=await tree('one','One'),next=await tree('next','Next'),local=await tree('editable','Editable');
  const graph={format:1,plugins:[name],locations:{[location]:{package:'fixture',version:'1.0.0',dependencies:{}}}};
  const resolver=installReleaseResolver(graph,new Map([['fixture',first.base]]));t.after(()=>resolver.close());
  let reads=0,resolutions=0;
  class CountingPackages extends boot.PluginPackages {
    metaOf(...args){reads++;return super.metaOf(...args);}
  }
  await ctx.plugin(leasedPluginPackages({...boot,PluginPackages:CountingPackages,
    resolvePluginResource(...args){resolutions++;return boot.resolvePluginResource(...args);}},resolver));t.after(()=>ctx.fiber.dispose());
  const packages=ctx.pluginPackages;
  const value=packages.metaOf(name,first.parent);
  assert.deepEqual(value,boot.readPluginMeta(name,first.parent));
  assert.equal(packages.metaOf(name,first.parent),value);
  assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.title));
  assert.equal(reads,1);
  const owned=pathToFileURL(join(first.base,location,'entry.mjs')).href;
  const resolved=resolutions;
  assert.equal(packages.metaOf(name,owned),value);
  assert.equal(resolutions,resolved,'a retained package binding already identifies cached root metadata');
  const release=resolver.add(graph,new Map([['fixture',next.base]]),[name]);
  await writeFile(next.locale,'{');
  assert.match(packages.metaOf(name,next.parent).error,/metadata/i);
  await writeFile(next.locale,JSON.stringify({meta:{title:'Next'}}));
  assert.deepEqual(packages.metaOf(name,next.parent),boot.readPluginMeta(name,next.parent));
  assert.notDeepEqual(packages.metaOf(name,next.parent),value);assert.equal(reads,3);
  assert.equal(packages.metaOf(name,first.parent),value);
  packages.metaOf(name+'/extra',first.parent);
  packages.metaOf(name+'/extra',first.parent);
  assert.equal(reads,5);
  release();
  for(const source of [next,local]){
    const previous=packages.metaOf(name,source.parent);
    await writeFile(source.locale,JSON.stringify({meta:{title:'Edited'}}));
    assert.notDeepEqual(packages.metaOf(name,source.parent),previous);
  }
  assert.equal(reads,9);
});
