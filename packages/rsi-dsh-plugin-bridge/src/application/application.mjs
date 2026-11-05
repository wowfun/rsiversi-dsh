import {isAbsolute,join,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {inactiveFiber} from '../agent/fiber.mjs';

export const applicationBundle='@rsiversi/dsh-workbench';
async function publishBase(profile,rows,load) {
  if(!rows.length) return [];
  const {writeFileAtomic,withFileLock}=await load('@deepseek-ai/dsh-atomic-write');
  const directory=join(profile,'node_modules',applicationBundle);
  await mkdir(directory,{recursive:true});
  const patches=[{insert:rows}];
  const privateFile={mode:0o600};
  await writeFileAtomic(join(directory,'cordis.patch.yml'),JSON.stringify(patches),privateFile);
  await writeFileAtomic(join(directory,'package.json'),JSON.stringify({name:applicationBundle,version:'0.1.0',
    dsh:{bundle:{patch:'cordis.patch.yml'}}}),privateFile);
  const path=join(profile,'package.json');
  await withFileLock(path,async()=>{
    const manifest=await readFile(path,'utf8').then(JSON.parse).catch(error=>{
      if(error.code!=='ENOENT')throw error;return {name:'rsi-managed-profile',private:true};
    });
    manifest.dsh??={};manifest.dsh.profile??={};
    manifest.dsh.profile.bundles=[applicationBundle,...(manifest.dsh.profile.bundles??[]).filter(name=>name!==applicationBundle)];
    await writeFileAtomic(path,JSON.stringify(manifest,null,2)+'\n',privateFile);
  });
  return patches;
}

/**
 * A profile owns exactly one Cordis tree. Adapters are installed once at
 * the root, not once per Session. The caller retains every package lease
 * until this scope (including all plugin disposers) has retired.
 */
export async function createApplication({modules, profile, provide,hostModules=new Map(),clientOnly=new Set(),baseRows=[]}) {
  const sources=new WeakMap();
  const load = async name => {
    const file=modules.entry(name),value=await import(pathToFileURL(file).href);
    sources.set(value,file);
    return value;
  };
  const [cordis, {default:Loader}, boot] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-app-boot'),
  ]);
  const ctx = new cordis.Context();
  const document=join(profile,'cordis.yml');
  ctx.baseUrl = pathToFileURL(document).href;
  let rows = [], base=[], mounted=false, retired = false, last = Promise.resolve();
  try {
    await ctx.plugin(Loader);
    ctx.loader.internal = {
      import: async name => hostModules.get(name) ?? load(name),
      resolveSync: name => ({url:pathToFileURL(modules.entry(name)).href}),
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
        reason:inactiveFiber(entry.options.id+' ('+entry.options.name+')',entry.fiber)});
    }
    return pending;
  }
  async function apply(next,restore=false) {
    const patches=[...base,...next];
    const previous=mounted?pendingEntries():new Map();
    let warnings=[];
    if(mounted) warnings=await boot.reconcileProfilePatches(ctx,patches,'rsi-dsh');
    else {
      const include=await boot.mountRootInclude(ctx,document,patches,undefined,'rsi-dsh');
      if(!include) throw new Error('Root Include retired before configuration');
      mounted=true;
    }
    await ctx.loader.await();
    const failures=[];
    for(const [id,row] of pendingEntries()) {
      const prior=previous.get(id);
      if(!required.has(row.id) && (restore || (prior && prior.fiber===row.fiber && prior.config===row.config))) warnings.push(row.reason);
      else failures.push(row.reason);
    }
    if(failures.length) throw new Error('Inactive profile entries: '+failures.join(', '));
    return [...new Set(warnings)];
  }
  return {
    ctx,
    usesPayload(directories) {
      for(const entry of ctx.loader.entries()) {
        if(!entry.fiber)continue;
        const source=sources.get(entry.moduleNamespace);
        if(source&&directories.some(root=>{
          const path=relative(root,source);
          return path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);
        }))return true;
      }
      return false;
    },
    reconcile(layers,{restore=false}={}) {
      if (retired) return Promise.reject(new Error('Profile retired'));
      const next=layers.flat();
      const turn=last.then(async()=>{
        let warnings;
        try { warnings=await apply(next,restore); }
        catch(error) {
          try { await apply(rows); }
          catch(rollback) { throw new AggregateError([error,rollback],'Profile rollback failed',{cause:error}); }
          throw error;
        }
        rows=next;
        return warnings;
      });
      last=turn.catch(()=>{});
      return turn;
    },
    async close() {retired=true; await last; await ctx.fiber.dispose();},
  };
}
