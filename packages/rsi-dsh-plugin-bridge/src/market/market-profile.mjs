import {AsyncLocalStorage} from 'node:async_hooks';
import {lstat, mkdir} from 'node:fs/promises';
import {basename, isAbsolute, join, relative, sep} from 'node:path';
import {packageLocation} from '../../../rsi-dsh-cordis/src/release/layout.mjs';
import {applicationBundle} from '../application/application.mjs';
import {packageRunners} from './package-runners.mjs';
import {buildDecisions, linkProfilePackage, publishReleaseAgeDefault, readJson, readSelections, save, unlinkProfilePackage} from './profile-files.mjs';

/** Publish npm layout links only after the Store holds their exact generation.
 * dshmarket owns its bundle rows. Its activation callback reconciles those
 * rows with the running application before returning success. */
export async function createMarketProfile({profile,state,modules,call,reconcile,active,boot,view,manager,inUse}) {
  await mkdir(state,{recursive:true});
  await publishReleaseAgeDefault(profile).catch(error=>{
    if(!['EACCES','EPERM','EROFS'].includes(error.code))throw error;
  });
  const path=join(profile,'package.json'), journal=join(state,'selections.json');
  const manifest=()=>readJson(path,{name:'rsi-managed-profile',private:true,dependencies:{},dsh:{profile:{bundles:[]}}});
  const durable=await readSelections(journal);
  let installed=durable.installed;
  let pinned=await call('application.roots',{});
  const loaded=new Map();
  const bindings=new Map();
  async function retain(rows) {
    const next={};
    for(const row of rows) if(row && (loaded.has(row.digest)||Object.hasOwn(pinned,row.digest))) next[row.digest]=row.package;
    await call('application.roots',{expected:pinned,next});
    pinned=next;
  }
  const unavailable=new Map();
  function reportUnavailable(name,error) {
    const diagnostic=name+': '+String(error.message??error).slice(0,500);
    unavailable.set(name,diagnostic);
    console.warn('DSH profile:',diagnostic);
  }
  const retiring=new Set();
  function retireBinding(name) {
    const binding=bindings.get(name);
    if(binding) {retiring.add(binding);bindings.delete(name);}
  }
  function disposeRetired(digest) {
    for(const binding of [...retiring].reverse()) if(!digest||binding.digest===digest) {
      if(inUse?.(loaded.get(binding.digest)))continue;
      binding.release?.();
      retiring.delete(binding);
    }
  }
  let last=Promise.resolve();
  let lastProfile=Promise.resolve();
  const owner=new AsyncLocalStorage();
  function exclusive(operation) {
    if(owner.getStore()?.active) return operation();
    const turn=lastProfile.then(async()=>{
      const token={active:true};
      try {return await owner.run(token,operation);}
      finally {token.active=false;}
    });
    lastProfile=turn.catch(()=>{});
    return turn;
  }
  function serialize(operation) {
    const turn=last.then(operation);
    last=turn.catch(()=>{});
    return turn;
  }
  async function load(selection,signal) {
    const {package:name,digest}=selection;
    let graph=loaded.get(digest);
    if (!graph) {
      const held=await call('application.payloads',{package:name,digest,export:'profile',dependency_export:'runtime'},signal);
      try {
        const layout=await readJson(join(held.profile,'layout.json'));
        if (!layout || !Array.isArray(layout.plugins) || !layout.plugins.length) throw new Error('Missing admitted DSH plugin graph');
        graph={layout,roots:new Map(Object.entries(held.roots))};
        loaded.set(digest,graph);
      } catch(error) {
        await call('application.release',{digest});
        throw error;
      }
    }
    return graph;
  }
  async function materialize(name,selection,value) {
    if (selection) {
      const {layout,roots}=await load(selection);
      if(!layout.plugins.includes(name)) throw new Error('Installed selection has no plugin '+name);
      if(bindings.get(name)?.digest!==selection.digest) {
        const release=modules.add(layout,roots,[name]);
        retireBinding(name);
        bindings.set(name,{digest:selection.digest,release});
      }
      await linkProfilePackage(profile,name,modules.directory(name),modules.setProfileLink);
      value.dependencies[name]=selection.version;
    }
    else {
      retireBinding(name);
      delete value.dependencies[name];
      await unlinkProfilePackage(profile,name,modules.setProfileLink);
    }
  }
  async function syncManifest(selections=installed,restoring=false) {
    const value=await manifest();value.dependencies??={};
    for(const [name,selection] of Object.entries(selections)) {
      try {
        await materialize(name,selection,value);
        unavailable.delete(name);
      } catch(error) {
        if(!restoring) throw error;
        reportUnavailable(name,error);
      }
    }
    await save(path,value);
  }
  async function restore(previous,names,restoring=false) {
    const rollback=Object.fromEntries(names.map(name=>[name,previous[name]??null]));
    await syncManifest(restoring?{...previous,...rollback}:rollback,restoring);
    await save(journal,{installed:previous,preparing:[]});
  }
  if(durable.preparing.length) await restore(installed,durable.preparing,true);
  else await syncManifest(installed,true);
  await retain(Object.values(installed));
  async function publish(changes,signal) {
    const names=Object.keys(changes),next={...installed,...changes};
    const selected=Object.fromEntries(Object.entries(next).filter(([,row])=>row!==null));
    for(const name of names) {
      if(packageLocation('node_modules/'+name)!==name) throw new Error('Invalid plugin root');
      const link=await lstat(join(profile,'node_modules',name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(link&&!link.isSymbolicLink()) throw new Error('Profile package view collides with '+name);
    }
    signal?.throwIfAborted();
    await retain([...Object.values(installed),...Object.values(changes)]);
    await save(journal,{installed,preparing:names});
    try {
      await syncManifest(changes);
      signal?.throwIfAborted();
      await save(journal,{installed:selected,preparing:[]});
    } catch(error) {
      try {await restore(installed,names);}
      catch(rollback) {throw new AggregateError([error,rollback],'Could not restore the previous package view',{cause:error});}
      await retain(Object.values(installed));
      throw error;
    }
    installed=selected;
    // Publication is durable. If retirement loses its receipt, restart can
    // remove the extra roots without undoing the successfully installed view.
    try {await retain(Object.values(installed));}
    catch(error) {console.warn('Committed package view; root cleanup pending:',String(error.message??error).slice(0,500));}
  }
  async function install(spec,signal,registry,log) {
    const existing=Object.entries(installed).find(([name,row])=>row && spec===name+'@'+row.version);
    if (existing) {await syncManifest(Object.fromEntries([existing]));return;}
    log.write('Importing '+spec+' into the package store\n');
    const builds=await buildDecisions(profile,modules);
    const options={source:'registry',...(registry?{registry}:{}),...(Object.keys(builds).length?{builds}:{})};
    const result=await call('application.import',{specifications:[spec],options,expected_roots:pinned},signal);
    pinned=result.roots;
    let digest,alreadyHeld;
    try {
      const selections=Object.entries(result.packages).filter(([name])=>name.startsWith('rsi-dsh-selection-'));
      if(selections.length!==1) throw new Error('Importer did not publish a DSH selection');
      const [name,selected]=selections[0];
      digest=selected;
      log.write('Preparing the installed package view for '+spec+'\n');
      alreadyHeld=loaded.has(digest);
      const {layout}=await load({package:name,digest},signal);
      const updates={};
      for(const plugin of layout.plugins) updates[plugin]={package:name,digest,version:layout.locations['node_modules/'+plugin].version};
      await publish(updates,signal);
    }
    catch(error) {
      if(digest && loaded.has(digest) && !alreadyHeld && !Object.values(installed).some(row=>row?.digest===digest)) {
        disposeRetired(digest);
        await call('application.release',{digest});
        loaded.delete(digest);
      }
      await retain(Object.values(installed));
      throw error;
    }
  }
  async function remove(name,signal) {
    if (!Object.hasOwn(installed,name) || !installed[name]) throw new Error('Plugin is not installed: '+name);
    await publish({[name]:null},signal);
  }
  async function restoreManifest(signal,registry,log) {
    const dependencies=(await manifest()).dependencies??{};
    const failed=[];
    const missing=[];
    for(const [name,version] of Object.entries(dependencies)) {
      signal.throwIfAborted();
      if(name===applicationBundle) continue;
      try {
        if(packageLocation('node_modules/'+name)!==name || typeof version!=='string' || !version.length)
          throw new Error('Invalid dependency specification');
        await install(name+'@'+version,signal,registry,log);
      } catch(error) {
        signal.throwIfAborted();
        failed.push(name+': '+error.message);
        if(!installed[name]) missing.push(name);
      }
    }
    const removed=Object.keys(installed).filter(name=>installed[name]&&!Object.hasOwn(dependencies,name));
    if(removed.length) await publish(Object.fromEntries(removed.map(name=>[name,null])),signal);
    if(failed.length) {
      // A restored file may already name a version the target Home could not
      // install. Keep working selections and leave failed new bundles inactive.
      await syncManifest(installed,true);
      const value=await manifest();
      for(const name of missing) delete value.dependencies[name];
      if(value.dsh?.profile?.bundles) value.dsh.profile.bundles=value.dsh.profile.bundles.filter(name=>!missing.includes(name));
      await save(path,value);
      throw new Error(failed.join('\n'));
    }
  }
  async function layers(restoring=false) {
    const value=await manifest();
    const patches=[];
    for (const name of value.dsh?.profile?.bundles ?? []) {
      if(name===applicationBundle || unavailable.has(name)) continue;
      try {
        if (!Object.hasOwn(installed,name) || !installed[name]) throw new Error('Bundle has no installed RSI selection: '+name);
        const directory=modules.directory(name);
        const pkg=await readJson(join(directory,'package.json'));
        for(const patch of boot.bundlePatchPaths(directory,pkg.dsh.bundle)) {
          const local=relative(directory,patch);
          if(!local||local==='..'||local.startsWith('..'+sep)||isAbsolute(local))
            throw new Error('Bundle patch is outside its package: '+name);
          patches.push(boot.loadOverlayPatches('rsi-dsh',patch));
        }
      } catch(error) {
        if(!restoring) throw error;
        reportUnavailable(name,error);
      }
    }
    return patches;
  }
  const activate=()=>exclusive(()=>serialize(async()=>{
    try {
      const warnings=await reconcile(await layers());
      disposeRetired();
      const retained=new Set(Object.values(installed).map(row=>row?.digest));
      for(const binding of retiring)retained.add(binding.digest);
      for(const digest of loaded.keys()) if(!retained.has(digest)) {
        await call('application.release',{digest});
        loaded.delete(digest);
      }
      const diagnostics=[...unavailable.values(),...(warnings??[])];
      return diagnostics.length?{ok:true,warnings:diagnostics}:{ok:true};
    }
    catch(error) {return {ok:false,error:String(error.message ?? error)};}
  }));
  return {layers,activate,
    ...packageRunners({view, manager, selections: () => installed, serialize, install, remove, restoreManifest}),
    hmr:{runExclusive:exclusive,async reconcileProfile(required=[]) {
      const result=await activate();
      if(!result.ok) throw new Error(result.error);
      return {warnings:result.warnings??[],pending:required.filter(id=>!active(id)).map(id=>({id,reason:'entry-not-active'}))};
    }},
    desktopProfiles:{current:{name:basename(profile),dir:profile},pluginActivation:{activate}}};
}
