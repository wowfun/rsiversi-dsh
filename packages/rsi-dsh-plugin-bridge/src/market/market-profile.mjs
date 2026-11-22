import {wait} from '../application/request-boundary.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
import {lstat, mkdir, readFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {packageLocation} from '../../../rsi-dsh-cordis/src/release/layout.mjs';
import {applicationBundle} from '../application/application.mjs';
import {bundlePatches} from './bundles.mjs';
import {packageRunners} from './package-runners.mjs';
import {withCleanup} from './cleanup.mjs';
import {buildDecisions, captureRecovery, discardRecovery, restoreProfileFiles, linkProfilePackage, publishReleaseAgeDefault, readProfileManifest, readSelections, save, saveSelections, unlinkProfilePackage} from './profile-files.mjs';

/** Publish npm layout links only after the Store holds their exact generation.
 * dshmarket owns its bundle rows. Its activation callback reconciles those
 * rows with the running application before returning success. */
export async function createMarketProfile({profile,state,modules,call,reconcile,active,boot,view,manager,inUse,boundary}) {
  await mkdir(state,{recursive:true});
  await publishReleaseAgeDefault(profile).catch(error=>{
    if(!['EACCES','EPERM','EROFS'].includes(error.code))throw error;
  });
  const path=join(profile,'package.json'), journal=join(state,'selections.json');
  const emptyManifest=()=>({name:'rsi-managed-profile',private:true,dependencies:{},dsh:{profile:{bundles:[]}}});
  const manifest=async()=>await readProfileManifest(path)??emptyManifest();
  const durable=await readSelections(journal);
  let installed=durable.installed;
  let pending;
  let pinned=await call('application.roots',{});
  const loaded=new Map();
  const bindings=new Map();
  async function retain(rows) {
    const next={};
    for(const row of [...Object.values(pending?.installed??{}),...rows])
      if(row && (loaded.has(row.digest)||Object.hasOwn(pinned,row.digest))) next[row.digest]=row.package;
    await call('application.roots',{expected:pinned,next});
    pinned=next;
  }
  const unavailable=new Map();
  function reportUnavailable(name,error,issues) {
    const diagnostic=name+': '+String(error.message??error).slice(0,500);
    if(issues.get(name)!==diagnostic) console.warn('DSH profile:',diagnostic);
    issues.set(name,diagnostic);
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
  function exclusive(operation,signal) {
    const error=boundary?.mutationError();if(error)return Promise.reject(error);
    const apply=()=>{
      signal?.throwIfAborted();
      if(pending?.failed)throw new Error('Package recovery requires restarting the application with the same profile');
      return operation();
    };
    if(owner.getStore()?.active) return apply();
    const previous=lastProfile;
    const turn=(async()=>{
      if(signal)await wait(previous,signal);else await previous;
      const token={active:true};
      try {return await owner.run(token,apply);}finally {token.active=false;}
    })();
    lastProfile=Promise.all([previous,turn.catch(()=>{})]).then(()=>{});
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
        const layout=JSON.parse(await readFile(join(held.profile,'layout.json'),'utf8'));
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
  async function materialize(name,selection,value,prepared) {
    if (selection) {
      const {layout,roots}=await load(selection);
      if(!layout.plugins.includes(name)) throw new Error('Installed selection has no plugin '+name);
      if(bindings.get(name)?.digest!==selection.digest) {
        const release=prepared?prepared.publish():modules.add(layout,roots,[name]);
        retireBinding(name);
        bindings.set(name,{digest:selection.digest,release});
      }
      await linkProfilePackage(profile,name,modules.directory(name),modules.setProfileLink);
      if(value.dependencies[name]===selection.version)return false;
      value.dependencies[name]=selection.version;
    }
    else {
      retireBinding(name);
      const shipped=modules.installationDependency(name);
      if(shipped)await linkProfilePackage(profile,name,shipped,modules.setProfileLink);
      else await unlinkProfilePackage(profile,name,modules.setProfileLink);
      if(!Object.hasOwn(value.dependencies,name))return false;
      delete value.dependencies[name];
    }
    return true;
  }
  async function materializeSelections(selections,value,restoring,prepared) {
    let changed=false;
    for(const [name,selection] of Object.entries(selections)) {
      try {
        if(await materialize(name,selection,value,prepared?.get(name)))changed=true;
        unavailable.delete(name);
      } catch(error) {
        if(!restoring) throw error;
        reportUnavailable(name,error,unavailable);
      }
    }
    return changed;
  }
  async function syncManifest(selections=installed,restoring=false,prepared) {
    const existing=await readProfileManifest(path);
    const initialize=existing?.dependencies==null;
    const value=existing??emptyManifest();
    value.dependencies??={};
    const changed=await materializeSelections(selections,value,restoring,prepared);
    if(initialize||changed)await save(path,value);
  }
  const saveSelection=(selected,rollback=null)=>saveSelections(journal,selected,rollback);
  async function restore(previous,rollback,restoring=false) {
    const changes=Object.fromEntries(rollback.touched.map(name=>[name,previous[name]??null]));
    await materializeSelections({...previous,...changes},{dependencies:{}},restoring);
    await restoreProfileFiles(profile,rollback.files);
    installed=previous;
  }
  if(durable.rollback) {
    await restore(installed,durable.rollback,true);
    await saveSelection(installed);
  }
  else {await syncManifest(installed,true);await discardRecovery(journal);}
  await retain(Object.values(installed));

  async function transaction(operation,managed=false,identity) {
    if(pending)throw new Error('Package mutation already owns the profile');
    const previous=installed;
    pending={installed:previous,childrenActive:0};
    let rollback;
    try {
      rollback=await captureRecovery(journal,profile,managed);
      await saveSelection(previous,rollback);
      pending.rollback=rollback;
      pending.id=rollback.id;
    } catch(error) {pending=undefined;throw error;}
    const scope={active:true,transaction:rollback.id};
    let result,error,unjoined;
    try {
      try {result=await owner.run(scope,operation);}
      finally {scope.active=false;pending.id=undefined;unjoined=pending.childrenActive>0;await pending.children;}
      if(pending.childError)throw pending.childError;
      if(unjoined)throw new Error('Package manager returned before its subprocess settled');
      if(managed && result.application!=='applied')throw new Error(result.error?.diagnostic??result.application);
      await saveSelection(installed);
    } catch(failure) {
      error=failure;
      try {
        await restore(previous,rollback);
        if(managed) {
          const restored=await activate();
          if(!restored.ok)throw new Error(restored.error);
        }
        await saveSelection(previous);
      } catch(recovery) {
        pending.failed=true;
        throw new AggregateError([failure,recovery],'Package replacement recovery is incomplete',{cause:failure});
      }
    }
    pending.installed={};
    // A committed selection or completed compensation is authoritative even
    // when pruning redundant roots loses its response. Startup repairs them.
    try {await releaseUnused();await retain(Object.values(installed));}
    catch(cleanup) {console.warn('Package selection settled; root cleanup pending:',String(cleanup.message??cleanup).slice(0,500));}
    finally {pending=undefined;}
    if(error) {
      if(managed)return {...(!result||result.application==='applied'
        ?{...identity,...result,application:'failed',error:{code:'operation-error',diagnostic:String(error.message??error)}}
        :result),changed:false,restored:true};
      throw error;
    }
    return result;
  }
  async function publish(changes,signal,prepared) {
    if(pending?.failed)throw new Error('Package recovery requires restarting the application with the same profile');
    if(!pending)return transaction(()=>publish(changes,signal,prepared));
    const names=Object.keys(changes),next={...installed,...changes};
    const selected=Object.fromEntries(Object.entries(next).filter(([,row])=>row!==null));
    for(const name of names) {
      if(packageLocation('node_modules/'+name)!==name) throw new Error('Invalid plugin root');
      const link=await lstat(join(profile,'node_modules',name)).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(link&&!link.isSymbolicLink()) throw new Error('Profile package view collides with '+name);
    }
    signal?.throwIfAborted();
    await retain([...Object.values(installed),...Object.values(changes)]);
    pending.rollback.touched=[...new Set([...pending.rollback.touched,...names])];
    await saveSelection(pending.installed,pending.rollback);
    await syncManifest(changes,false,prepared);
    signal?.throwIfAborted();
    installed=selected;
  }
  async function prepare(spec,signal,registry,log,expected) {
    log.write('Preparing '+spec+' in the package store\n');
    const builds=await buildDecisions(profile,modules);
    const options={cache:true,...(registry?{registry}:{}),...(Object.keys(builds).length?{builds}:{})};
    const result=await call('application.stage',{specifications:[spec],options},signal);
    if(result.cancelled)throw signal?.reason??new Error('Package staging was cancelled');
    let digest,alreadyHeld;
    const dispose=()=>withCleanup(async()=>{
      if(digest && loaded.has(digest) && !alreadyHeld && !Object.values(installed).some(row=>row?.digest===digest)) {
        disposeRetired(digest);
        await call('application.release',{digest});loaded.delete(digest);
      }
    },()=>call('application.stage.release',{stage:result.stage}));
    try {
      const selections=Object.entries(result.packages).filter(([name])=>name.startsWith('rsi-dsh-selection-'));
      if(selections.length!==1)throw new Error('Importer did not publish a DSH selection');
      const [name,selected]=selections[0];digest=selected;alreadyHeld=loaded.has(digest);
      const {layout,roots}=await load({package:name,digest},signal);
      const updates={},prepared=new Map(),patches=new Map();
      for(const plugin of layout.plugins) {
        updates[plugin]={package:name,digest,version:layout.locations['node_modules/'+plugin].version};
        const mapping=modules.prepare(layout,roots,[plugin]);prepared.set(plugin,mapping);
        patches.set(plugin,bundlePatches(boot,modules.installationDependency(plugin)??mapping.directory(plugin),boot.readProfileVersionExemptions(profile),boot.getDshRuntimeVersion()));
      }
      if(expected && (layout.plugins.length!==1 || layout.plugins[0]!==expected.name || updates[expected.name].version!==expected.version))
        throw Object.assign(new Error('unexpected-package'),{code:'unexpected-package'});
      signal?.throwIfAborted();
      return {updates,prepared,patches,dispose};
    } catch(error) {return withCleanup(()=>{throw error;},dispose);}
  }
  async function install(spec,signal,registry,log) {
    const candidate=await prepare(spec,signal,registry,log);
    await withCleanup(async()=>{
      const apply=()=>publish(candidate.updates,signal,candidate.prepared);
      await changeRaw(apply,signal);
    },()=>candidate.dispose());
  }
  async function commitBundle(candidate,enabled,onApply,signal) {
    return change(()=>{onApply();return transaction(async()=>{
      await publish(candidate.updates,undefined,candidate.prepared);
      const names=Object.keys(candidate.updates);
      if(names.length!==1)throw new Error('ambiguous-install');
      const name=names[0],value=await manifest();
      value.dsh??={};value.dsh.profile??={};
      const bundles=value.dsh.profile.bundles??[];
      value.dsh.profile.bundles=enabled?(bundles.includes(name)?bundles:[...bundles,name]):bundles.filter(item=>item!==name);
      await save(path,value);
      const outcome=await activate();
      if(!outcome.ok)throw new Error(outcome.error);
      const flatten=rows=>rows.flatMap(row=>[row,...(row.group&&Array.isArray(row.config)?flatten(row.config):[])]);
      const required=enabled?flatten(boot.composeEntries(candidate.patches.get(name))).filter(row=>!row.disabled):[];
      if(required.some(row=>!active(row.id)))throw new Error('entry-not-active');
      return {application:'applied',changed:true,stage:'enable',target:name,bundle:name,
        version:candidate.updates[name].version,enabled,...(outcome.warnings?{warnings:outcome.warnings}:{})};
    },true,{stage:'install',target:Object.keys(candidate.updates)[0]});},signal);
  }
  async function remove(name,signal) {
    if (!Object.hasOwn(installed,name) || !installed[name]) throw new Error('Plugin is not installed: '+name);
    const apply=()=>publish({[name]:null},signal);
    await changeRaw(apply,signal);
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
        const selected=installed[name];
        if(selected?.version===version&&loaded.has(selected.digest)&&!unavailable.has(name)) {
          await changeRaw(()=>materialize(name,selected,{dependencies:{}}),signal);
          continue;
        }
        await install(name+'@'+version,signal,registry,log);
      } catch(error) {
        signal.throwIfAborted();
        failed.push(name+': '+error.message);
        if(!installed[name]) missing.push(name);
      }
    }
    const removed=Object.keys(installed).filter(name=>installed[name]&&!Object.hasOwn(dependencies,name));
    if(removed.length) await changeRaw(()=>publish(Object.fromEntries(removed.map(name=>[name,null])),signal),signal);
    if(failed.length) {
      // A restored file may already name a version the target Home could not
      // install. Keep working selections and leave failed new bundles inactive.
      const cleanup=async()=>{
        const value=await manifest();value.dependencies??={};
        await materializeSelections(installed,value,true);
        for(const name of missing) delete value.dependencies[name];
        if(value.dsh?.profile?.bundles) value.dsh.profile.bundles=value.dsh.profile.bundles.filter(name=>!missing.includes(name));
        await save(path,value);
      };
      await(pending?cleanup():change(()=>transaction(cleanup),signal));
      throw new Error(failed.join('\n'));
    }
  }
  const skippedBundles=new Map();
  async function layers(restoring=false) {
    const value=await manifest();
    const patches=[];
    const selected=(value.dsh?.profile?.bundles??[]).filter(name=>name!==applicationBundle);
    for(const name of skippedBundles.keys()) if(!selected.includes(name))skippedBundles.delete(name);
    if(!selected.length)return patches;
    const exemptions=boot.readProfileVersionExemptions(profile),runtimeVersion=boot.getDshRuntimeVersion();
    for (const name of selected) {
      try {
        const shipped=modules.installationDependency(name);
        if(!shipped&&unavailable.has(name))continue;
        const directory=shipped ??
          (Object.hasOwn(installed,name) && installed[name] ? modules.directory(name) : undefined);
        if(!directory) throw new Error('Bundle is absent from the DSH installation and market selections: '+name);
        patches.push(...bundlePatches(boot,directory,exemptions,runtimeVersion));
        skippedBundles.delete(name);
      } catch(error) {
        if(!restoring&&!skippedBundles.has(name)) throw error;
        reportUnavailable(name,error,skippedBundles);
      }
    }
    return patches;
  }
  const change=(operation,signal)=>boundary?boundary.run(operation,signal):operation();
  // admitRaw validates the transaction identity before a subprocess shares its boundary.
  const changeRaw=(operation,signal)=>pending?operation():change(operation,signal);
  function admitRaw(operation,transactionId) {
    if(transactionId!==undefined) {
      if(pending?.failed)throw new Error('Package recovery requires restarting the application with the same profile');
      if(!pending?.rollback || pending.id!==transactionId)throw new Error('Package transaction is no longer active');
      const transaction=pending,result=serialize(operation);
      transaction.childrenActive++;
      // The FIFO tail drains every accepted child. The manager owns earlier failures/retries;
      // a failure after it returns must still prevent a successful commit.
      transaction.children=result.catch(error=>{if(transaction.id===undefined)transaction.childError??=error;})
        .finally(()=>{transaction.childrenActive--;});
      return result;
    }
    return exclusive(()=>serialize(operation));
  }
  async function releaseUnused() {
    disposeRetired();
    const retained=new Set([...Object.values(installed),...Object.values(pending?.installed??{})].map(row=>row?.digest));
    for(const binding of retiring)retained.add(binding.digest);
    for(const digest of loaded.keys()) if(!retained.has(digest)) {
      await call('application.release',{digest});
      loaded.delete(digest);
    }
  }
  const activate=()=>exclusive(()=>change(()=>serialize(async()=>{
    try {
      const warnings=await reconcile(await layers());
      await releaseUnused();
      const diagnostics=[...unavailable.values(),...skippedBundles.values(),...(warnings??[])];
      return diagnostics.length?{ok:true,warnings:diagnostics}:{ok:true};
    }
    catch(error) {return {ok:false,error:String(error.message ?? error)};}
  })));
  return {profile,modules,exclusive,prepare,commitBundle,layers,activate,
    transaction:(operation,identity,signal)=>exclusive(()=>change(()=>transaction(operation,true,identity),signal),signal),
    mutate:(operation,signal)=>exclusive(()=>change(operation,signal),signal),
    ...packageRunners({view, manager, install, remove, restoreManifest,admitRaw,
      transactionId:()=>owner.getStore()?.transaction}),
    hmr:{runExclusive:operation=>exclusive(()=>change(operation)),async reconcileProfile(required=[]) {
      const result=await activate();
      if(!result.ok) throw new Error(result.error);
      return {warnings:result.warnings??[],pending:required.filter(id=>!active(id)).map(id=>({id,reason:'entry-not-active'}))};
    }},
    desktopProfiles:{current:{name:basename(profile),dir:profile},pluginActivation:{activate}}};
}
