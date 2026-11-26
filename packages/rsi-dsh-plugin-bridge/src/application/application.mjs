import {isAbsolute,join,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {constants} from 'node:fs';
import {lstat,open,writeFile} from 'node:fs/promises';
import {inactiveFiber} from '../agent/fiber.mjs';
import {readProfileManifest} from '../market/profile-files.mjs';

export const applicationBundle='@rsiversi/dsh-workbench';
async function reuseGenerated(path,expected,mode) {
  let file;
  try {
    if(process.platform==='win32' && !(await lstat(path)).isFile())return false;
    file=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    const info=await file.stat();
    if(!info.isFile()||info.nlink!==1||info.size!==expected.length)return false;
    // Compare at most one extra byte. Permissions apply to the same opened file.
    const bytes=Buffer.allocUnsafe(expected.length+1);
    let length=0;
    while(length<bytes.length){
      const {bytesRead}=await file.read(bytes,length,bytes.length-length);
      if(!bytesRead)break;
      length+=bytesRead;
    }
    if(length!==expected.length||!bytes.subarray(0,length).equals(expected))return false;
    if(process.platform!=='win32' && (info.mode&0o777)!==mode)await file.chmod(mode);
    return true;
  } catch(error) {
    if(['ENOENT','ELOOP','EACCES','EPERM','EOPNOTSUPP'].includes(error.code))return false;
    throw error;
  } finally {await file?.close();}
}

async function publishBase(profile,rows,load) {
  if(!rows.length) return [];
  const {writeFileAtomic,withFileLock}=await load('@deepseek-ai/dsh-atomic-write');
  const directory=join(profile,'node_modules',applicationBundle);
  const patches=[{insert:rows}];
  const privateFile={mode:0o600};
  async function publish(name,value) {
    const path=join(directory,name),bytes=Buffer.from(JSON.stringify(value));
    if(!await reuseGenerated(path,bytes,privateFile.mode))await writeFileAtomic(path,bytes,privateFile);
  }
  await publish('cordis.patch.yml',patches);
  await publish('package.json',{name:applicationBundle,version:'0.1.0',dsh:{bundle:{patch:'cordis.patch.yml'}}});
  const path=join(profile,'package.json');
  const selected=manifest=>{
    const bundles=manifest?.dsh?.profile?.bundles;
    return bundles?.[0]===applicationBundle && !bundles.includes(applicationBundle,1);
  };
  if(selected(await readProfileManifest(path)))return patches;
  await withFileLock(path,async()=>{
    const manifest=await readProfileManifest(path,{name:'rsi-managed-profile',private:true});
    if(selected(manifest))return;
    manifest.dsh??={};manifest.dsh.profile??={};
    const bundles=manifest.dsh.profile.bundles??[];
    manifest.dsh.profile.bundles=[applicationBundle,...bundles.filter(name=>name!==applicationBundle)];
    await writeFileAtomic(path,JSON.stringify(manifest,null,2)+'\n',privateFile);
  });
  return patches;
}

/**
 * A profile owns exactly one Cordis tree. Adapters are installed once at
 * the root, not once per Session. The caller retains every package lease
 * until this scope (including all plugin disposers) has retired.
 */
export async function createApplication({modules, profile, provide,hostModules=new Map(),clientOnly=new Set(),baseRows=[],boundary}) {
  const sources=new WeakMap(),restoringImports=new Map(),retainedModules=new Set();
  const load = async name => {
    const file=modules.entry(name),value=await import(pathToFileURL(file).href);
    sources.set(value,file);
    return value;
  };
  const [cordis, {default:Loader}, boot, environment] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-app-boot'),
    load('@deepseek-ai/dsh-launch-environment'),
  ]);
  const ctx = new cordis.Context();
  const document=join(profile,'cordis.yml');
  ctx.baseUrl = pathToFileURL(document).href;
  let base=[], rootInclude, mounted=false, retired = false, last = Promise.resolve();
  try {
    ctx.provide(environment.DSH_LAUNCH_ENVIRONMENT_KEY,
      environment.createLaunchEnvironmentSnapshot([{source:'process',values:process.env}]));
    await ctx.plugin(Loader);
    ctx.loader.internal = {
      import: async name => restoringImports.get(name) ?? hostModules.get(name) ?? load(name),
      resolveSync: name => ({url:pathToFileURL(sources.get(restoringImports.get(name))??modules.entry(name)).href}),
    };
    await provide(ctx,load);
    base=await publishBase(profile,baseRows,load);
    await writeFile(document,'[]\n',{flag:'wx',mode:0o600}).catch(error=>{
      if(error.code!=='EEXIST') throw error;
    });
  } catch(error) {
    try { await ctx.fiber.dispose(); }
    catch(cleanup) { throw new AggregateError([error,cleanup],error.message,{cause:error}); }
    throw error;
  }
  const required=new Set(baseRows.map(entry=>entry.id));
  function pendingEntries() {
    const pending=new Map();
    for(const entry of ctx.loader.entries()) {
      if(entry.disabled || clientOnly.has(entry.options.id) || entry.fiber?.state===ctx.loader.ctx.fiber.state)continue;
      pending.set(entry.id,{id:entry.options.id,fiber:entry.fiber,config:JSON.stringify(entry.options),
        label:entry.options.id+' ('+entry.options.name+')'});
    }
    return pending;
  }
  async function apply(patches,restore=false,running=[]) {
    const previous=mounted?pendingEntries():new Map();
    let warnings=[];
    if(mounted) {
      const result=await boot.recomposeProfile(ctx,patches,'rsi-dsh',{running});
      if(result.restartReason)throw new Error('Profile requires restart: '+result.restartReason);
      warnings=result.warnings;
    }
    else {
      const include=await boot.mountRootInclude(ctx,document,patches,undefined,'rsi-dsh');
      if(!include) throw new Error('Root Include retired before configuration');
      rootInclude=include;
      mounted=true;
    }
    await ctx.loader.await();
    const failures=[];
    for(const [id,row] of pendingEntries()) {
      const prior=previous.get(id);
      const diagnostic=!required.has(row.id) && (restore || (prior && prior.fiber===row.fiber && prior.config===row.config))
        ? warnings : failures;
      try {await row.fiber?.await();}
      catch(error) {diagnostic.push(row.label+': '+(error instanceof Error?error.message:String(error)));continue;}
      diagnostic.push(inactiveFiber(row.label,row.fiber));
    }
    if(failures.length) throw new Error('Inactive profile entries: '+failures.join(', '));
    return [...new Set(warnings)];
  }
  async function replacements(patches,previous) {
    const changed=new Set();
    const rows=patches=>{
      const result=new Map();
      const visit=entries=>{for(const row of entries){
        result.set(row.id,row);
        if((row.group===true||row.name==='cordis:group')&&Array.isArray(row.config))visit(row.config);
      }};
      visit(boot.composeEntries([patches]));return result;
    };
    let before,after,replaced=false;
    for(const entry of ctx.loader.entries()) {
      const source=sources.get(entry.moduleNamespace);
      if(!source || entry.disabled)continue;
      let resolutionError;
      try {if(source===modules.entry(entry.options.name))continue;}
      catch(error){resolutionError=error;}
      replaced=true;
      // Match DSH's root-composition ownership: nested Includes own their own IDs.
      if(entry.parent.tree===rootInclude?.subgroup?.tree) {
        before??=rows(previous);
        after??=rows(patches);
        if(before.has(entry.options.id)&&after.get(entry.options.id)?.name!==entry.options.name)continue;
      }
      if(resolutionError)throw resolutionError;
      changed.add(entry);
    }
    // Replacing an ancestor already retires its configured descendants. The
    // original Loader rebuilds those entries under the new owning Fiber.
    for(const entry of changed) {
      let parent=entry.parent.ctx.fiber.entry;
      while(parent) {
        if(changed.has(parent)){changed.delete(entry);break;}
        parent=parent.parent.ctx.fiber.entry;
      }
    }
    for(const entry of changed)await load(entry.options.name);
    return {changed:[...changed],replaced};
  }
  async function retire(entry) {
    if(!entry.fiber)return;
    const fiber=entry.fiber.ctx.fiber;
    // Follow DSH HMR: deleting the runtime avoids Loader's self-disposal
    // handler persisting an unintended `disabled` override in cordis.yml.
    ctx.registry.delete(fiber.runtime.callback);
    // Cordis await() joins cleanup but also rethrows a remembered activation
    // error. DSH HMR contains that error before restoring a failed candidate.
    await fiber.await().catch(()=>{});
  }
  async function restoreComposition(patches,snapshots) {
    for(const {name,module} of snapshots)restoringImports.set(name,module);
    try {
      const running=[];
      for(const entry of ctx.loader.entries()) {
        const previous=restoringImports.get(entry.options.name);
        if(previous&&entry.moduleNamespace!==previous){await retire(entry);running.push(entry);}
      }
      await apply(patches,true,running);
    } finally {restoringImports.clear();}
  }
  return {
    ctx,
    usesPayload(directories) {
      const namespaces=new Set(retainedModules);
      for(const entry of ctx.loader.entries())if(entry.fiber)namespaces.add(entry.moduleNamespace);
      for(const namespace of namespaces) {
        const source=sources.get(namespace);
        if(source&&directories.some(root=>{
          const path=relative(root,source);
          return path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);
        }))return true;
      }
      return false;
    },
    reconcile(layers,{restore=false}={}) {
      if (retired) return Promise.reject(new Error('Profile retired'));
      const next=[...base,...layers.flat()];
      const reconcile=async()=>{
        const previous=rootInclude?.options.config.patches??[];
        const {changed,replaced}=await replacements(next,previous);
        const rollback=replaced?structuredClone(previous):undefined;
        const snapshots=replaced?[...ctx.loader.entries()].filter(entry=>entry.moduleNamespace)
          .map(entry=>({name:entry.options.name,module:entry.moduleNamespace})):[];
        for(const {module} of snapshots)retainedModules.add(module);
        try {
          for(const entry of changed)await retire(entry);
          return await apply(next,restore,changed);
        } catch(error) {
          if(rollback) {
            try {await restoreComposition(rollback,snapshots);}
            catch(rollback){throw new AggregateError([error,rollback],'Plugin replacement and recovery failed',{cause:error});}
          }
          throw error;
        } finally {
          for(const {module} of snapshots)retainedModules.delete(module);
        }
      };
      if(boundary)return boundary.run(reconcile);
      const turn=last.then(reconcile);
      last=turn.catch(()=>{});
      return turn;
    },
    async close() {retired=true; try {await boundary?.close();await last;}finally {await ctx.fiber.dispose();}},
  };
}
