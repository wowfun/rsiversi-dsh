import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {isAbsolute,join} from 'node:path';
import {installNpm,npmManifest,rebuildApproved,registryCache} from '../registry/npm-install.mjs';
import {checkRequirements,prereleasePeerOverrides} from '../registry/requirements.mjs';
import {packageLocation,releaseLayout} from './layout.mjs';
import {writeShards,digest,json} from './artifacts.mjs';
import {writePayloadFiles} from '../archive/payload.mjs';

// PackageStore supplies the staging directory, importer dependencies and
// actual toolchain lease. Stage only the extension to the running release.
export async function importRelease(base,npmRoot,request,signal) {
  const {staging,workspace,specifications} = request;
  if (request.format !== 1 || !isAbsolute(staging) || !isAbsolute(workspace) ||
      !Array.isArray(specifications) || !specifications.length || specifications.length>128)
    throw new Error('Invalid release import');
  const toolchain=createRequire(join(npmRoot,'package.json'));
  const npa=toolchain('npm-package-arg'), semver=toolchain('semver');
  const specs=specifications.map(value=>{
    if (typeof value!=='string' || !value || value.startsWith('-')) throw new Error('Invalid package specification');
    const parsed=npa(value,workspace);
    if(request.options?.source==='registry' && !['version','range','tag'].includes(parsed.type))
      throw new Error('This market installs named npm registry packages only');
    if (!['version','range','tag','file','directory'].includes(parsed.type)) throw new Error('Unsupported package specification');
    return parsed;
  });
  const work=await mkdtemp(join(tmpdir(),'rsi-release-import-'));
  try {
    const root=join(work,'stage'); await mkdir(root);
    const runtime = Object.fromEntries(Object.entries(base.locations).flatMap(([location,row])=>{
      const name=packageLocation(location);
      return location==='node_modules/'+name && (name.startsWith('@deepseek-ai/')||['cordis','react','react-dom'].includes(name)) && !base.plugins.includes(name) ?
        [[name,row.version]] : [];
    }));
    if (!runtime['@deepseek-ai/dsh']) throw new Error('Missing release runtime');
    if (specs.some(spec=>Object.hasOwn(runtime,spec.name))) throw new Error('Cannot replace active runtime package');
    const cache=request.options?.source==='registry'?registryCache(workspace):undefined;
    const manifests=await Promise.all(specs.map(spec=>npmManifest(npmRoot,spec,request.options?.registry,cache??join(work,'metadata-cache'),signal)));
    const pins={};
    for(const manifest of manifests) {
      if(Object.hasOwn(runtime,manifest.name))throw new Error('Cannot replace active runtime package');
      for(const name of Object.keys({...manifest.dependencies,...manifest.peerDependencies,...manifest.optionalDependencies}))
        if(Object.hasOwn(runtime,name))pins[name]=runtime[name];
    }
    const overrides=prereleasePeerOverrides(manifests,pins,semver);
    await writeFile(join(root,'package.json'),json({name:'rsi-release-import',private:true,dependencies:pins,overrides}));
    await installNpm(npmRoot,root,work,specs.map(spec=>['file','directory'].includes(spec.type)?spec.fetchSpec:spec.raw),signal,request.options?.registry,cache);
    const {dependencies}=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    const added=Object.keys(dependencies).filter(name=>!Object.hasOwn(runtime,name));
    const plugins=specs.map(spec=>spec.name ?? added.find(name=>npa.resolve(name,dependencies[name],root).fetchSpec===spec.fetchSpec));
    if (plugins.some(name=>!added.includes(name)) || new Set(plugins).size!==added.length || added.length!==specs.length)
      throw new Error('Could not resolve ordered DSH plugin roots');
    for (const name of plugins) {
      const manifest=JSON.parse(await readFile(join(root,'node_modules',name,'package.json'),'utf8'));
      checkRequirements(manifest,base.version,semver);
      const patch=manifest.dsh?.bundle?.patch;
      if (typeof patch!=='string'&&!(Array.isArray(patch)&&patch.every(file=>typeof file==='string')))
        throw new Error(name+' has no DSH bundle patch');
    }
    const policy=request.options?.builds??{};
    if(typeof policy!=='object' || Array.isArray(policy) || Object.entries(policy).some(([name,value])=>
      packageLocation('node_modules/'+name)!==name || typeof value!=='boolean')) throw new Error('Invalid registry build decisions');
    const lock=JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
    const present=Object.keys(runtime).filter(name=>Object.hasOwn(lock.packages,'node_modules/'+name));
    const groups=await releaseLayout(root,present,plugins,signal,true,
      builds=>rebuildApproved(npmRoot,root,work,builds,policy,signal,cache));
    const hostPeers = {};
    const resolvedRuntime=new Map((groups.get('runtime') ?? []).map(item=>[item.location,item]));
    groups.delete('runtime');
    // Only the plugin's edges cross the application boundary. The active
    // runtime has already resolved its own internal and optional dependencies.
    for(const records of groups.values()) for(const item of records) {
      for(const dependency of Object.values(item.dependencies)) {
        const proposed=resolvedRuntime.get(dependency);
        if(!proposed) continue;
        const held=base.locations[dependency];
        if(!held || held.version!==proposed.version)
          throw new Error('Plugin dependency requires a different runtime instance: '+dependency);
        hostPeers[dependency]=held.version;
      }
    }
    const target=({win32:'windows',linux:'linux',darwin:'macos'})[process.platform]+'-'+({x64:'x86_64',arm64:'aarch64'})[process.arch];
    const packed=await writeShards(staging,groups,base.version,target,signal);
    const name='rsi-dsh-selection-'+digest(json(plugins)).slice(0,16);
    const directory=join(staging,name);await mkdir(directory);
    const layout=json({format:2,runtime:'@deepseek-ai/dsh',version:base.version,plugins,locations:packed.locations,hostPeers});
    const source=join(directory,'layout.json');await writeFile(source,layout);
    const tree=await writePayloadFiles([{path:'layout.json',source,bytes:layout.length}],join(directory,'profile.rsi'),signal);
    const dependenciesOfSelection=packed.artifacts.map(row=>({name:row.name,digest:row.manifestDigest}));
    await writeFile(join(directory,'package.json'),json({format:2,name,version:base.version,target,
      dependencies:dependenciesOfSelection,requires:[],files:[{path:'profile.rsi',bytes:tree.bytes,digest:tree.digest,executable:false}],
      exports:{profile:{kind:'payload_tree',path:'profile.rsi',index_digest:tree.indexDigest}}}));
    return {format:1,directories:[...packed.artifacts.map(row=>row.name),name]};
  } finally {await rm(work,{recursive:true,force:true});}
}
