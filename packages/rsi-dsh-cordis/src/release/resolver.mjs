import { createRequire, isBuiltin, registerHooks } from 'node:module';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageLocation } from './layout.mjs';
import { checkRequirements } from '../registry/requirements.mjs';

// writeShards reserves this namespace for the active DSH release. Plugin shards use an owner digest.
const runtimeShard = /^rsi-dsh-runtime-\d+$/;
function barePackageName(request) {
  if(!request || request[0]==='.' || request[0]==='/' || request[0]==='\\' ||
    request[0]==='#' || request.includes(':') || isBuiltin(request)) return;
  const first=request.indexOf('/');
  if(request[0]!=='@') return first<0?request:request.slice(0,first);
  if(first<0)return;
  const second=request.indexOf('/',first+1);
  return second<0?request:request.slice(0,second);
}

/** Resolve public exports with Node's own ESM/CJS conditions. Root paths are
 * supplied by the owner of the immutable leases, never taken from the lock. */
export function installReleaseResolver(layout, roots, profile) {
  const byDirectory=new Map(), rootsByName=new Map();
  const profileURL=profile&&pathToFileURL(resolve(profile)+sep).href;
  const profileModules=profile&&join(resolve(profile),'node_modules');
  const profileLinks=new Map();
  let release, lastParent, lastOwner;
  function releaseBinding(location,version) {
    const row=layout.locations[location];
    if(row && row.version===version && runtimeShard.test(row.package)) return release.get(location);
  }
  function add(graph,paths,names) {
    const externalPeers=release!==undefined && graph?.format===2;
    if ((!externalPeers && graph?.format!==1) || !graph.locations || Object.keys(graph.locations).length>32768 ||
      (externalPeers && !graph.hostPeers))
      throw new Error('Invalid profile module layout');
    const local=new Map(),owned=[];
    const sameRelease=release!==undefined && layout.version!==undefined && graph.version===layout.version;
    for (const [location,row] of Object.entries(graph.locations)) {
      const name=packageLocation(location);
      if(sameRelease && runtimeShard.test(row.package)) continue;
      const root=paths.get(row.package);
      if (!root) throw new Error('Missing package lease: '+row.package);
      const directory=resolve(root,location);
      const lookupRoot=directory.slice(0,-('node_modules/'+name).length);
      const binding={name,directory,location,parent:pathToFileURL(join(lookupRoot,'__rsi_lookup__.cjs')).href,dependencies:row.dependencies,local};
      local.set(location,binding);
      owned.push(binding);
    }
    if(sameRelease || externalPeers) for(const owner of owned) for(const dependency of Object.values(owner.dependencies)) {
      if(local.has(dependency)) continue;
      const captured=graph.locations[dependency];
      if(!externalPeers && !runtimeShard.test(captured?.package)) continue;
      const version=externalPeers?graph.hostPeers[dependency]:captured.version;
      if(typeof version!=='string') throw new Error('Missing host dependency binding: '+dependency);
      const active=releaseBinding(dependency,version) ?? releaseBinding('node_modules/'+packageLocation(dependency),version);
      if(!active) throw new Error('Reinstall the plugin to resolve its host dependency: '+dependency+'@'+version);
      local.set(dependency,active);
    }
    for(const name of ['@deepseek-ai/cordis','react','react-dom']) {
      const shared=rootsByName.get(name),candidate=local.get('node_modules/'+name);
      if (shared && candidate && shared.directory!==candidate.directory)
        throw new Error('Application restart required for shared '+name);
    }
    const selected=names ?? (externalPeers?graph.plugins:owned.filter(row=>row.location==='node_modules/'+row.name).map(row=>row.name));
    const entries=selected.map(name=>{
      const row=local.get('node_modules/'+name);
      if(!row) throw new Error('Missing selected plugin: '+name);
      return [name,row];
    });
    if(externalPeers && !sameRelease) {
      const semver=createRequire(entry('@deepseek-ai/dsh-app-boot'))('semver');
      for(const [,row] of entries) checkRequirements(JSON.parse(readFileSync(join(row.directory,'package.json'),'utf8')),layout.version,semver);
    }
    for(const row of owned) {
      if(!byDirectory.has(row.directory)) byDirectory.set(row.directory,new Set());
      byDirectory.get(row.directory).add(row);
    }
    for(const [name,row] of entries) rootsByName.set(name,row);
    lastParent=lastOwner=undefined;
    release??=local;
    return () => {
      lastParent=lastOwner=undefined;
      for(const [name,row] of entries) if(rootsByName.get(name)===row) rootsByName.delete(name);
      for(const row of owned) {
        const owners=byDirectory.get(row.directory);
        if(owners?.delete(row) && !owners.size) byDirectory.delete(row.directory);
      }
    };
  }
  add(layout,roots);
  const host=new Map(rootsByName);
  for(const name of layout.plugins??[]) host.delete(name);
  function destinationFor(owner,name) {
    const declared=owner.local.get(owner.dependencies[name]);
    if(declared) return declared;
    let location=owner.location;
    while(location) {
      const nested=owner.local.get(location+'/node_modules/'+name);
      if(nested) return nested;
      const parent=location.lastIndexOf('/node_modules/');
      if(parent<0) break;
      location=location.slice(0,parent);
    }
    return owner.local.get('node_modules/'+name) ?? host.get(name);
  }
  const packageAt=directory=>byDirectory.get(directory)?.values().next().value;
  function findOwner(url) {
    if (!url?.startsWith('file:')) return;
    // Resolving one plugin's exports and locales repeatedly uses the same
    // issuer. A graph change invalidates even a previous miss.
    if(url===lastParent)return lastOwner;
    let directory = dirname(fileURLToPath(url));
    lastParent=url;
    while(true) {
      const owner=packageAt(directory);
      if (owner) return lastOwner=owner;
      const parent = dirname(directory);
      if (parent === directory) return lastOwner=undefined;
      directory = parent;
    }
  }
  // A successful profile link and an active lease have different lifetimes.
  function setProfileLink(name,directory) {
    if(directory===undefined) profileLinks.delete(name);
    else profileLinks.set(name,directory);
  }
  function profileBinding(name,parentURL) {
    const linked=profileLinks.get(name);
    if(!linked || !parentURL?.startsWith(profileURL))return;
    if(parentURL.lastIndexOf('/')===profileURL.length-1)return packageAt(linked);
    // An editable caller can shadow the published root with a nearer package.
    for(const lookup of createRequire(parentURL).resolve.paths(name)) {
      if(lookup===profileModules)return packageAt(linked);
      const candidate=join(lookup,name);
      if(statSync(candidate,{throwIfNoEntry:false})?.isDirectory())return packageAt(realpathSync.native(candidate));
    }
  }
  function bindingFor(specifier,parentURL) {
    const name=barePackageName(specifier);
    if(!name)return;
    const owner=findOwner(parentURL);
    return owner?(name===owner.name?owner:destinationFor(owner,name)):profileBinding(name,parentURL);
  }
  let resolvingFromLease = false;
  const hook = registerHooks({resolve(specifier,context,next) {
    if (resolvingFromLease)return next(specifier,context);
    const name=barePackageName(specifier);
    if(!name)return next(specifier,context);
    const owner=findOwner(context.parentURL);
    if (name===owner?.name) return next(specifier,context); // package self-reference
    const destination=owner?destinationFor(owner,name):profileBinding(name,context.parentURL);
    if (!destination) return next(specifier,context);
    // Node's CJS delegate closes over the original Module, even if its hook
    // context has a new parentURL. Ask a real require anchored at the lease.
    if (Array.from(context.conditions ?? []).includes('require')) {
      resolvingFromLease = true;
      try {return {url:pathToFileURL(createRequire(destination.parent).resolve(specifier)).href,shortCircuit:true};}
      finally {resolvingFromLease = false;}
    }
    return next(specifier,{...context,parentURL:destination.parent});
  }});
  function directory(name) {
    const target = rootsByName.get(name);
    if (!target) throw new Error('Not a profile package: '+name);
    return target.directory;
  }
  function entry(specifier) {
    if(specifier.startsWith('file:') || isAbsolute(specifier)) {
      const path=realpathSync(specifier.startsWith('file:')?fileURLToPath(specifier):specifier);
      if(!findOwner(pathToFileURL(path).href)) throw new Error('Module is outside the leased profile: '+specifier);
      return path;
    }
    const name = barePackageName(specifier);
    const target = rootsByName.get(name);
    if (!target) throw new Error('Not a profile package: '+name);
    return createRequire(target.parent).resolve(specifier);
  }
  return {entry,directory,bindingFor,packageAt,setProfileLink,add,close:()=>hook.deregister()};
}
