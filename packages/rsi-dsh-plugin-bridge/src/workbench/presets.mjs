import {orderedOperations} from '../application/sessions.mjs';

function metadata({id,name,description,broken}) {
  const row={id};
  if(name!=null)row.name=name;
  if(description!=null)row.description=description;
  if(broken!=null)row.broken=broken;
  return row;
}
const nativeSource=Symbol('Host composition');

/** Native tools belong to the Host. Cordis owns its scoped providers and revision leases. */
export function workbenchPresetRegistry(Registry,RemoteError,sessions,refresh,{scopeOf,scopeParentOf},nativePlugins=()=>[],defaults) {
  return class extends Registry {
    declarations=new Map();
    sources=new Map();
    changes=orderedOperations();
    selections=orderedOperations();
    get defaultId() {return defaults?.id??super.defaultId;}
    async currentDefault() {
      return defaults?(await defaults.refresh(this.ctx.invocation?.signal)).id:this.defaultId;
    }

    async resolveApplication(id) {
      if(!this.declarations.has(id))return null;
      await this.useSource(id,false);
      return super.resolve(id);
    }

    async bindSession(agent,nativeId,nativeChanged=false) {
      const id=this.presetForSession(agent.session);
      const bound=this.composedPreset(agent.ctx);
      if(id==null||bound===id||bound!==undefined&&!nativeChanged)return;
      const record=this.sources.get(id);
      if(!record&&id===nativeId)await this.prepare(id);
      else if(!record||record.source===nativeSource&&id!==nativeId)return;
      await super.mount(agent.ctx,id);
    }
    nativeRoster() {
      return sessions.withCaller(signal=>sessions.readPresets({type:'list'},signal),this.ctx.invocation?.signal);
    }
    nativePreset(id) {
      return sessions.withCaller(signal=>sessions.resolvePreset(id,signal),this.ctx.invocation?.signal);
    }
    useSource(id,native) {
      return this.changes([id],async()=>{
        const source=native?nativeSource:this.declarations.get(id);
        const current=this.sources.get(id);
        if(source===current?.source)return;
        if(current){await current.dispose();this.sources.delete(id);}
        if(source){
          const dispose=native?await super.register({id,plugins:nativePlugins(id)}):await source.install();
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
      const selected=presets.find(row=>row.is_default)?.id
        ??await this.currentDefault();
      return {presets:[
        ...presets.map(row=>({...metadata(row),isDefault:row.is_default})),
        ...declared.filter(row=>!names.has(row.id)).map(row=>({...row,isDefault:row.id===selected})),
      ]};
    }
    async list() {
      return (await this.remoteExportList()).presets.map(({isDefault,...row})=>row);
    }
    async resolve(id) {
      const row=await this.nativePreset(id);
      if(row)return row.broken==null?{id:row.id}:{id:row.id,broken:row.broken};
      const wanted=id??await this.currentDefault();
      await this.useSource(wanted,false);
      return super.resolve(wanted);
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
      const wanted=row?.id??id??await this.currentDefault();
      if(row?.broken!=null)throw this.invalid(wanted,row.broken);
      await this.useSource(wanted,!!row);
      return wanted;
    }
    async acquireScope(id) {
      return super.acquireScope(await this.prepare(id));
    }
    async commitNative(agent,id,signal,announce=false) {
      const previous=scopeParentOf(agent),recorded=this.presetForSession(agent.session),start=agent.session.seq;
      const result=await sessions.selectPreset(agent.id,id,signal);
      if(result.code==='locked')throw new RemoteError('agent-preset/locked','This session has already started',
        {sessionId:agent.id,agentPreset:id});
      if(result.selected!==id||typeof result.changed!=='boolean')throw Error('Native preset selection was not confirmed');
      const mounted=await super.mount(agent.ctx,id);
      const rebound=recorded!==id||previous!==scopeParentOf(agent);
      if(!result.changed&&!rebound)return mounted;
      const switched=announce&&rebound;
      if(switched){
        try{this.ctx.emit('tools/change');}
        catch(error){this.ctx.logger.warn('Preset tools observer:',error);}
      }
      await refresh(agent.id,signal);
      // Native refresh can already have published this selection into the shared journal.
      const needsRecord=this.presetForSession(agent.session)!==id
        ||switched&&!agent.session.snapshotEvents(start).some(event=>
          event.type==='agent-preset/selected'&&event.data.agentPreset===id);
      if(needsRecord)
        agent.session.append('agent-preset/selected',{agentPreset:id});
      return mounted;
    }
    async mount(ctx,id) {
      const wanted=await this.prepare(id),agent=scopeOf(ctx);
      if(agent?.session&&this.presetForSession(agent.session)!==wanted)
        return sessions.withCaller(signal=>this.commitNative(agent,wanted,signal),this.ctx.invocation?.signal);
      return super.mount(ctx,wanted);
    }
    select(agent,id) {
      return this.selections([agent.id],async()=>{
        const wanted=await this.prepare(id);
        const mounted=await sessions.withCaller(signal=>this.commitNative(agent,wanted,signal,true),this.ctx.invocation?.signal);
        return mounted.id;
      });
    }
  };
}
