const namespace='agent-preset-registry';

/** Keep DSH's form validation and path edits; the Host owns this form's only volatile field. */
export async function workbenchPresetSettings(modules,load,sessions) {
  const settingsName='@deepseek-ai/dsh-settings',controllerName='@deepseek-ai/dsh-api-settings-controller';
  const {default:Settings,SettingsConflictError}=await load(settingsName);
  const {default:Controller}=await load(controllerName);
  let current,revision=0,owner;
  function selectedForm(snapshot) {
    return snapshot.selected==null?{}:{selectedDefault:snapshot.selected};
  }
  function accept(snapshot,observed) {
    if(!snapshot.version||typeof snapshot.id!=='string')throw Error('Host preset Settings are unavailable');
    const same=current?.version.scope_id===snapshot.version.scope_id;
    if(!same&&observed!==current)return current;
    if(same&&snapshot.version.revision<=current.version.revision)return current;
    if(current)revision++;
    current=snapshot;
    owner?.emit('settings/document-updated',namespace,revision);
    return current;
  }
  async function read(signal) {
    const observed=current;
    return accept(await sessions.presetDefault(signal),observed);
  }
  const refresh=signal=>sessions.withCaller(read,signal);
  await refresh();
  modules.set(settingsName,class extends Settings {
    constructor(ctx) {
      const editor=ctx.configEditor;
      const formEditor=Object.create(editor);
      formEditor.edit=(entry,change)=>{
        if(entry.options.id!==namespace)return editor.edit(entry,change);
        return sessions.withCaller(async signal=>{
          const snapshot=await read(signal),observed=revision;
          const inherited={...entry.options.config};
          delete inherited.selectedDefault;
          const next=change({...inherited,...selectedForm(snapshot)},inherited);
          entry.fiber.resolveConfig(next);
          const result=await sessions.setPresetDefault(next.selectedDefault??null,snapshot.version,signal);
          if(result.code==='conflict'||result.code==='stale_registration'){
            await refresh(signal);
            throw new SettingsConflictError(namespace,observed,revision);
          }
          if(result.code)throw Error('Host rejected the default preset: '+result.code);
          accept(result,snapshot);
        },ctx.invocation?.signal);
      };
      super(ctx.extend({configEditor:formEditor}));
      owner=ctx;
      ctx.effect(()=>()=>{if(owner===ctx)owner=undefined;});
    }
    describe(options) {
      const rows=super.describe(options);
      return rows.map(row=>row.ns===namespace?{...row,revision,
        value:selectedForm(current),user:selectedForm(current),base:{}}:row);
    }
  });
  modules.set(controllerName,class extends Controller {
    async describe() {await refresh(this.ctx.invocation?.signal);return super.describe();}
  });
  return {get id(){return current.id;},refresh};
}
