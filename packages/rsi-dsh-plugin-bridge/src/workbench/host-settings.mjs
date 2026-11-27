const presets='agent-preset-registry', loop='agent-loop', permissions='permission';

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
 * Host-owned fields share the original form's revision and reset semantics. */
export async function workbenchHostSettings(modules,load,sessions,flushSettings) {
  const settingsName='@deepseek-ai/dsh-settings',controllerName='@deepseek-ai/dsh-api-settings-controller';
  const loopName='@deepseek-ai/dsh-agent-loop';
  const permissionName='@deepseek-ai/dsh-permission-presets';
  const [{default:Settings,SettingsConflictError},{default:Controller},{default:AgentLoop},{default:PermissionPresets}]=
    await Promise.all([load(settingsName),load(controllerName),load(loopName),load(permissionName)]);
  modules.set(loopName,{Config:AgentLoop.Config,apply(){}});
  let owner;
  const changed=ns=>revision=>owner?.emit('settings/document-updated',ns,revision);
  const preset=hostField('selectedDefault',sessions.presetDefault,sessions.setPresetDefault,
    snapshot=>typeof snapshot?.id==='string',changed(presets));
  const parallel=hostField('maxParallelToolCalls',sessions.loopSettings,sessions.setLoopSettings,
    snapshot=>snapshot===null||Number.isInteger(snapshot?.base)&&snapshot.base>=1,changed(loop));
  function permissionView(snapshot){
    if(snapshot==null||snapshot.code)return snapshot;
    return {...snapshot,selected:snapshot.selected?.preset??null};
  }
  const permission=hostField('defaultPreset',async signal=>permissionView(await sessions.permissionSettings(signal)),
    async(name,expected,signal)=>{
      const service=owner.get('permissionPresets');
      let choice=null;
      if(name!=null){
        if(!service?.catalog().defaultOptions.some(option=>option.value===name))throw Error('Unknown default permission preset: '+name);
        const {sandbox,approval}=service.resolve(name);
        choice={preset:name,sandbox,approval};
      }
      return permissionView(await sessions.setPermissionSettings(choice,expected,signal));
    },snapshot=>snapshot===null||typeof snapshot?.base==='string',changed(permissions));
  let permissionBase;
  modules.set(permissionName,class extends PermissionPresets {
    constructor(ctx,config){
      const base=()=>Object.keys(config.presets).find(name=>{
        const spec=config.presets[name];
        return spec.sandbox===permission.current?.base&&spec.approval==='ask';
      })??config.defaultPreset.get();
      super(ctx,{...config,defaultPreset:{get:()=>permission.current?.selected??base()}});
      permissionBase=base;
      ctx.effect(()=>()=>{if(permissionBase===base)permissionBase=undefined;});
    }
  });
  const fields=new Map([[presets,preset],[loop,parallel],[permissions,permission]]);
  const refreshAll=signal=>sessions.withCaller(stop=>Promise.all([...fields.values()].map(field=>field.refresh(stop))),signal);
  await refreshAll();
  modules.set(settingsName,class extends Settings {
    constructor(ctx) {
      const editor=ctx.configEditor;
      const formEditor=Object.create(editor);
      formEditor.edit=(entry,change)=>{
        const ns=entry.options.id, field=fields.get(ns);
        if(!field){
          const edited=editor.edit(entry,change);
          return flushSettings?Promise.resolve(edited).then(flushSettings):edited;
        }
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
        const baseValue=field===permission?permissionBase?.():snapshot.base;
        const user={...row.user,...field.values(snapshot.selected)},base={...row.base,...field.values(baseValue)};
        if(snapshot.selected==null)delete user[field.key];
        return [{...row,revision:field.revision,value:{...row.value,...base,...user},user,base}];
      });
    }
  });
  modules.set(controllerName,class extends Controller {
    async describe(){await refreshAll(this.ctx.invocation?.signal);return super.describe();}
  });
  return {get id(){return preset.current.id;},refresh:signal=>sessions.withCaller(preset.refresh,signal)};
}
