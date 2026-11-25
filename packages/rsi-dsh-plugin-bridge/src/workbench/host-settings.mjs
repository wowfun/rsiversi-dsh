const presets='agent-preset-registry', loop='agent-loop';

/** Each native registration has its own CAS version. DSH clients observe a revision
 * that keeps increasing across withdrawal and replacement of that registration. */
function hostField(key,read,write,valid,changed) {
  let current,revision=0;
  function accept(snapshot,observed) {
    if(!valid(snapshot)||(snapshot!=null&&!snapshot.version))throw Error('Invalid Host Settings response for '+key);
    const same=current!=null&&snapshot!=null&&current.version.scope_id===snapshot.version.scope_id;
    if(!same&&observed!==current)return current;
    if(snapshot===current||same&&snapshot.version.revision<=current.version.revision)return current;
    if(current!==undefined)revision++;
    current=snapshot;
    changed(revision);
    return current;
  }
  return {key,write,accept,get current(){return current;},get revision(){return revision;},
    async refresh(signal){const observed=current;return accept(await read(signal),observed);},
    values(value){return value==null?{}:{[key]:value};}};
}

/** Retain the original Loader schemas, staged forms, path edits and validation.
 * The native executor runs the loop and Host Settings owns both overrides. */
export async function workbenchHostSettings(modules,load,sessions) {
  const settingsName='@deepseek-ai/dsh-settings',controllerName='@deepseek-ai/dsh-api-settings-controller';
  const loopName='@deepseek-ai/dsh-agent-loop';
  const [{default:Settings,SettingsConflictError},{default:Controller},{default:AgentLoop}]=
    await Promise.all([load(settingsName),load(controllerName),load(loopName)]);
  modules.set(loopName,{Config:AgentLoop.Config,apply(){}});
  let owner;
  const changed=ns=>revision=>owner?.emit('settings/document-updated',ns,revision);
  const preset=hostField('selectedDefault',sessions.presetDefault,sessions.setPresetDefault,
    snapshot=>typeof snapshot?.id==='string',changed(presets));
  const parallel=hostField('maxParallelToolCalls',sessions.loopSettings,sessions.setLoopSettings,
    snapshot=>snapshot===null||Number.isInteger(snapshot?.base)&&snapshot.base>=1,changed(loop));
  const fields=new Map([[presets,preset],[loop,parallel]]);
  const refreshAll=signal=>sessions.withCaller(stop=>Promise.all([preset.refresh(stop),parallel.refresh(stop)]),signal);
  await refreshAll();
  modules.set(settingsName,class extends Settings {
    constructor(ctx) {
      const editor=ctx.configEditor;
      const formEditor=Object.create(editor);
      formEditor.edit=(entry,change)=>{
        const ns=entry.options.id, field=fields.get(ns);
        if(!field)return editor.edit(entry,change);
        return sessions.withCaller(async signal=>{
          const snapshot=await field.refresh(signal),observed=field.revision;
          if(!snapshot)throw Error('Host Settings unavailable: '+ns);
          // Omission means reset, including when the Host initial value differs from the schema default.
          const inherited={...entry.options.config};
          delete inherited[field.key];
          const next=change({...inherited,...field.values(snapshot.selected)},inherited);
          entry.fiber.resolveConfig(next);
          const result=await field.write(next[field.key]??null,snapshot.version,signal);
          if(result?.code==='conflict'||result?.code==='stale_registration'){
            await field.refresh(signal);
            throw new SettingsConflictError(ns,observed,field.revision);
          }
          if(!result||result.code)throw Error('Host rejected Settings edit: '+(result?.code??ns));
          field.accept(result,snapshot);
        },ctx.invocation?.signal);
      };
      super(ctx.extend({configEditor:formEditor}));
      owner=ctx;
      ctx.effect(()=>()=>{if(owner===ctx)owner=undefined;});
    }
    describe(options) {
      return super.describe(options).flatMap(row=>{
        const field=fields.get(row.ns);
        if(!field)return [row];
        const snapshot=field.current;
        if(!snapshot)return [];
        const user=field.values(snapshot.selected),base=field.values(snapshot.base);
        return [{...row,revision:field.revision,value:{...base,...user},user,base}];
      });
    }
  });
  modules.set(controllerName,class extends Controller {
    async describe(){await refreshAll(this.ctx.invocation?.signal);return super.describe();}
  });
  return {get id(){return preset.current.id;},refresh:signal=>sessions.withCaller(preset.refresh,signal)};
}
