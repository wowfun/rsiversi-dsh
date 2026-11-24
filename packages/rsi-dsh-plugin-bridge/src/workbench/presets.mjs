import {orderedOperations} from '../application/sessions.mjs';

function metadata({id,name,description,broken}) {
  const row={id};
  if(name!=null)row.name=name;
  if(description!=null)row.description=description;
  if(broken!=null)row.broken=broken;
  return row;
}
const nativeSource=Symbol('Host composition');

/** Use the DSH registry's generation and scope lifetime for both sources.
 * Native tools are supplied by the Host, so its Cordis child plugin list is empty. */
export function workbenchPresetRegistry(Registry,RemoteError,sessions,refresh,{scopeOf}) {
  return class extends Registry {
    declarations=new Map();
    sources=new Map();
    changes=orderedOperations();
    selections=orderedOperations();

    async [Registry.init]() {
      await super[Registry.init]();
      this.ctx.on('agent/created',async({agent})=>{
        const id=this.presetForSession(agent.session),record=this.sources.get(id);
        if(record&&record.source!==nativeSource&&this.composedPreset(agent.ctx)!==id)
          await super.mount(agent.ctx,id);
      });
    }
    nativeRoster() {
      return sessions.withCaller(signal=>sessions.readPresets({type:'list'},signal),this.ctx.invocation?.signal);
    }
    async nativePreset(id) {
      const {presets}=await this.nativeRoster();
      return presets.find(row=>id===undefined?row.is_default:row.id===id);
    }
    useSource(id,native) {
      return this.changes([id],async()=>{
        const source=native?nativeSource:this.declarations.get(id);
        const current=this.sources.get(id);
        if(source===current?.source)return;
        if(current){await current.dispose();this.sources.delete(id);}
        if(source){
          const dispose=native?await super.register({id,plugins:[]}):await source.install();
          this.sources.set(id,{source,dispose});
        }
      });
    }
    async register(definition) {
      const {id}=definition;
      if(this.declarations.has(id))throw Error('Duplicate agent preset: '+id);
      // Keep the declaring context for relative child modules if the native source is removed.
      const declaration={install:()=>super.register(definition)};
      this.declarations.set(id,declaration);
      try {await this.useSource(id,!!await this.nativePreset(id));}
      catch(error){this.declarations.delete(id);throw error;}
      return async()=>{
        if(this.declarations.get(id)!==declaration)return;
        this.declarations.delete(id);
        await this.useSource(id,this.sources.get(id)?.source===nativeSource);
      };
    }
    async remoteExportList() {
      const {presets}=await this.nativeRoster();
      const names=new Set(presets.map(row=>row.id));
      await Promise.all([...this.sources].filter(([id,row])=>names.has(id)!==(row.source===nativeSource))
        .map(([id])=>this.useSource(id,names.has(id))));
      const declared=await super.list();
      return {presets:[
        ...presets.map(row=>({...metadata(row),isDefault:row.is_default})),
        ...declared.filter(row=>!names.has(row.id)).map(row=>({...row,isDefault:false})),
      ]};
    }
    async list() {
      return (await this.remoteExportList()).presets.map(({isDefault,...row})=>row);
    }
    async resolve(id) {
      const row=await this.nativePreset(id);
      if(row)return row.broken==null?{id:row.id}:{id:row.id,broken:row.broken};
      await this.useSource(id??this.defaultId,false);
      return super.resolve(id);
    }
    readDocument(id) {
      return sessions.withCaller(async signal=>{
        const doc=await sessions.readPresets({type:'document',id},signal);
        if(doc.code==='not_found'){await this.useSource(id,false);return super.readDocument(id);}
        if(doc.code==='broken')throw this.invalid(id,doc.reason);
        const result={agentPreset:id,content:doc.content};
        if(doc.name!=null)result.name=doc.name;
        if(doc.description!=null)result.description=doc.description;
        return result;
      },this.ctx.invocation?.signal);
    }
    invalid(id,reason) {
      return new RemoteError('agent-preset/invalid',reason,{agentPreset:id,reason});
    }
    async prepare(id) {
      const row=await this.nativePreset(id);
      const wanted=row?.id??id??this.defaultId;
      if(row?.broken!=null)throw this.invalid(wanted,row.broken);
      await this.useSource(wanted,!!row);
      return {id:wanted,native:!!row};
    }
    async acquireScope(id) {
      return super.acquireScope((await this.prepare(id)).id);
    }
    async commitNative(agent,id,signal) {
      const result=await sessions.selectPreset(agent.id,id,signal);
      if(result.code==='locked')throw new RemoteError('agent-preset/locked','This session has already started',
        {sessionId:agent.id,agentPreset:id});
      if(result.selected!==id)throw Error('Native preset selection was not confirmed');
      const mounted=await super.mount(agent.ctx,id);
      await refresh(agent.id,signal);
      if(this.presetForSession(agent.session)!==id)agent.session.append('agent-preset/selected',{agentPreset:id});
      return mounted;
    }
    async mount(ctx,id) {
      const source=await this.prepare(id),agent=scopeOf(ctx);
      if(source.native&&agent?.session&&this.presetForSession(agent.session)!==source.id)
        return sessions.withCaller(signal=>this.commitNative(agent,source.id,signal),this.ctx.invocation?.signal);
      return super.mount(ctx,source.id);
    }
    select(agent,id) {
      return this.selections([agent.id],async()=>{
        const source=await this.prepare(id);
        if(!source.native)return super.select(agent,id);
        const mounted=await sessions.withCaller(signal=>this.commitNative(agent,id,signal),this.ctx.invocation?.signal);
        return mounted.id;
      });
    }
  };
}
