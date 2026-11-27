import {hostname} from 'node:os';
import {resolve} from 'node:path';
import {updateQueue} from './queue.mjs';
import {searchSessionMessages} from './session-search.mjs';
import {observeSessionEvents} from './event-stream.mjs';
import {observeSessionState,readSessionState} from './session-state.mjs';

/** Use the release's generated session codec and dispatch machinery. */
export function sessionSummary(ctx,{id,cwd,updatedAt,blank,running,parent,projections}) {
  return {sessionId:id,cwd,updatedAt,blank,running,formatStatus:'current',
    agentAvailable:!!ctx.get('agents')?.get(id),
    ...(projections?{projections}:{}),
    ...(parent?{parentSessionId:parent,origin:'subagent'}:{})};
}

// DSH gives an explicit wire ID precedence over the first structured argument.
function sessionResource({args,parameters}) {
  const direct=parameters.find(parameter=>parameter.name==='sessionId'||parameter.wire==='sessionId');
  if(direct)return args[direct.wire];
  for(const parameter of parameters) {
    const request=args[parameter.wire];
    if(!request||typeof request!=='object'||Array.isArray(request))continue;
    const {sessionId,address}=request;
    if(sessionId!==undefined&&address!==undefined)
      throw Error('Session resource request must not contain both sessionId and address');
    if(address===undefined)return sessionId;
    return address.kind==='session'?address.sessionId:address.childSessionId;
  }
}

export function sessionController({TypertRemoteService,RemoteError,principalOf,canonicalClientTimeZone,SessionTitleInvalidError,Deque,desktop,searchApi},scope,history,interactions,activate) {
  const childOwned=id=>new RemoteError('session/agent-busy',`session "${id}" is owned by subagent routing`,
    {reason:'use subagent delivery for this child session'});
  function ordinary(agent) {
    if(agent.session.header.origin==='subagent')throw childOwned(agent.id);
    return agent;
  }
  async function resumeOrdinary(id,signal) {
    const meta=await history.metadata(id,signal,true);
    if(!meta)throw new RemoteError('session/not-found',`session "${id}" not found`,{sessionId:id});
    if(meta.plugin_child_depth!==undefined || (meta.inherited&&(await history.snapshot(meta)).header.origin==='subagent'))throw childOwned(id);
    return activate(id,signal);
  }
  const lookup=(id,registry=false)=>scope.lookupAgent(id,resumeOrdinary,registry).then(ordinary);
  return class extends TypertRemoteService {
    claims=new Map();
    static inject=['typert','remoteAccess'];
    constructor(ctx,config={}) {super(ctx,'sessionController',{namespace:'session'});this.nativeOpen=config.nativeOpen;}
    [TypertRemoteService.init]() {
      const registryLookup=id=>lookup(id,true);
      this.ctx.typert.resources.register('session',{resolve:sessionResource});
      this.ctx.typert.lookups.register('session',{
        parameter:'session',wire:'sessionId',resource:'session',
        hostTypeSymbol:'@deepseek-ai/dsh-session#Session',
        wireTypeSymbol:'@deepseek-ai/dsh-session/types#SessionId',
        resolve:async id=>(await registryLookup(id)).session,
      });
      this.ctx.typert.lookups.configure('agent',registryLookup);
      this.ctx.typert.contexts.configureHost('agent',async id=>(await registryLookup(id)).ctx);
      this.ctx.inject(['fileUploads'],ctx=>ctx.effect(()=>ctx.fileUploads.registerAgentResolver(id=>lookup(id)),
        'file-upload Agent resolver'));
    }
    async resolveAgent(id) {
      try {
        const live=this.ctx.get('agents')?.get(id);
        return {agent:ordinary(live??await scope.runOwned(signal=>resumeOrdinary(id,signal)))};
      }
      catch(error){return {error};}
    }
    summary(row) {return sessionSummary(this.ctx,row);}
    async create(request,signal) {
      const id=request.sessionId;
      if(id===undefined)return this.claim(request,signal);
      const result=(this.claims.get(id)??Promise.resolve()).then(()=>this.claim(request,signal));
      const settled=result.then(()=>{},()=>{});
      this.claims.set(id,settled);
      try{return await result;}
      finally{if(this.claims.get(id)===settled)this.claims.delete(id);}
    }
    async claim(request,signal) {
      const result=await scope.create(request,signal);
      const agent=await scope.runOwned(stop=>activate(result.id,stop,result.reused?'resume':'startup'),signal);
      if(request.workspaceId)scope.workspaceMetadata?.attach(request.workspaceId,agent?.session?.header,result.workspace_updated_at);
      this.ctx.emit('api-session/added',this.summary(result.summary));
      const preset=this.ctx.get('agentPresets')?.presetForSession(agent.session)??result.preset;
      return {sessionId:result.id,agentPreset:preset};
    }
    get readerAccess() {
      const peer=this.ctx.invocation?.peer;
      if(peer && peer.principal.kind!=='owner')return this.ctx.remoteAccess;
    }
    read(operation,signal) {
      return this.readerAccess?scope.observeOwned(operation,signal):operation(signal);
    }
    modelCatalog() {return this.read(stop=>scope.modelCatalog(stop),this.ctx.invocation?.signal);}
    canOpenWorkspacePath() {return this.nativeOpen??desktop.canOpenNativePath();}
    workspaceDesktop() {
      const fileManager=desktop.nativeFileManager();
      return {name:hostname(),available:fileManager!==null&&this.canOpenWorkspacePath(),fileManager};
    }
    async verifiedDesktopPath(path,signal) {
      if(!path.length)throw new RemoteError('gateway/bad-request','A non-empty file path is required',{});
      signal.throwIfAborted();
      const host=resolve(path),fs=this.ctx.get('fs'),mapped=fs.processPathFromHostPath(host);
      if(mapped===undefined||fs.processPath(await fs.resolve(mapped,{signal}))!==host)
        throw new RemoteError('gateway/bad-request','Path has no verified Host path',{});
      signal.throwIfAborted();return host;
    }
    async openWorkspacePath({path,action,application},signal) {
      try {
        if(!this.canOpenWorkspacePath())throw new RemoteError('gateway/bad-request','Host desktop unavailable',{});
        const host=await this.verifiedDesktopPath(path,signal);
        if(action==='reveal')await desktop.revealNativePath(host,signal);
        else if(application!==undefined)await desktop.openNativeFileApplication(host,application,signal);
        else await desktop.openNativeAssociatedPath(host,signal);
        return {opened:true};
      }catch(error){
        if(signal.aborted)throw new RemoteError('gateway/cancelled','path open was aborted',{});
        if(error instanceof RemoteError)throw error;
        throw new RemoteError('gateway/internal','path open failed',{},{cause:error});
      }
    }
    async workspacePathApplications({path},signal) {
      if(!this.canOpenWorkspacePath())return [];
      try{return await desktop.nativeFileApplications(await this.verifiedDesktopPath(path,signal),signal);}
      catch(error){
        if(signal.aborted)throw new RemoteError('gateway/cancelled','application query was aborted',{});
        if(error instanceof RemoteError)throw error;
        throw new RemoteError('gateway/internal','file application query failed',{},{cause:error});
      }
    }
    selectModel(request,signal) {return scope.selectModel(request,signal);}
    async rename({sessionId,title}) {
      const agent=await lookup(sessionId);
      const titles=this.ctx.get('sessionTitle');
      if(!titles)throw new RemoteError('gateway/internal','Session title service is unavailable',{});
      try {
        const accepted=titles.rename(agent.session,title);
        return {title:accepted.title,seq:accepted.eventSeq};
      }catch(error) {
        if(error instanceof SessionTitleInvalidError)
          throw new RemoteError('session/title-invalid',error.message,{sessionId});
        throw error;
      }
    }
    async fork(request,signal) {
      const turn=await history.forkTurn(request,signal);
      const result=await scope.fork(request.sessionId,turn,signal);
      this.ctx.emit('api-session/added',this.summary(result.summary));
      return {sessionId:result.id};
    }
    async prompt(request,signal) {
      signal.throwIfAborted();
      if(request.content.length && !request.content.some(part=>part.type!=='text'||part.text.trim().length))
        throw new RemoteError('gateway/bad-request','prompt content must include non-whitespace text or an attachment',{});
      const clientTimeZone=request.clientTimeZone===undefined?undefined:canonicalClientTimeZone(request.clientTimeZone);
      if(request.clientTimeZone!==undefined && clientTimeZone===undefined)
        throw new RemoteError('session/invalid-time-zone','clientTimeZone must be UTC or a valid IANA Area/Location name',{value:request.clientTimeZone});
      const principal=principalOf(this.ctx.invocation);
      const source={kind:request.content.length?'user':'retry',rpcId:request.requestId,
        ...(clientTimeZone===undefined?{}:{clientTimeZone}),...(principal===undefined?{}:{principal})};
      if(request.content.every(part=>part.type==='text'))return scope.prompt(request,request.content,source,signal);
      try{return await this.submitAttachments(request,source,signal);}
      catch(error){
        if(error?.code==='session/attachment-invalid'&&error.details?.reason==='FILE_NOT_STAGED'&&
          await scope.acceptedPrompt(request.sessionId,request.requestId,signal))return {accepted:true};
        throw error;
      }
    }
    async submitAttachments(request,source,signal) {
      let content=request.content,agent,uploads,receipts;
      if(content.some(part=>part.type==='file')){
        agent=await lookup(request.sessionId);
        uploads=this.ctx.get('fileUploads');
        const ids=new Set();
        content=content.map(part=>{
          if(part.type!=='file')return part;
          const staged=uploads.resolve(agent,part.receiptId);
          if(staged===undefined)throw new RemoteError('session/attachment-invalid','File was not uploaded for this session.',{reason:'FILE_NOT_STAGED'});
          ids.add(part.receiptId);
          return staged.type?staged:{type:'file',attachment:staged};
        });
        receipts=[...ids];
      }
      if(content.some(part=>part.type==='image'))content=await this.ctx.get('attachments').admitPromptContent(content);
      if(!receipts)return scope.prompt(request,content,source,signal);
      return scope.withFileReceipts(receipts,async()=>{
        signal.throwIfAborted();
        const binding=uploads.bindPrompt(agent,receipts,request.requestId);
        try{
          const result=await scope.prompt(request,content,source,signal);
          binding.commit();
          return result;
        }finally{binding[Symbol.dispose]();}
      });
    }
    attachment(request,signal) {
      return this.read(stop=>this.readAttachment(request,stop),signal);
    }
    async readAttachment(request,signal) {
      const ref=request.attachment??await history.imageReference(request.sessionId,request.attachmentId,signal);
      const {ref:attachment,data}=await this.ctx.get('attachments').readImage(ref,signal);
      return {attachment,data:Buffer.from(data.buffer,data.byteOffset,data.byteLength).toString('base64')};
    }
    cancel(request,signal) {return scope.cancel(request,signal);}
    async updateQueue(request,signal) {
      const source=await updateQueue(request,scope.inbox,history,RemoteError,signal);
      if(request.action.kind==='remove'&&source.kind==='user'&&source.rpcId) {
        const agent=this.ctx.get('agents')?.get(request.sessionId);
        if(agent)this.ctx.get('fileUploads')?.retirePrompt(agent,source.rpcId);
      }
      return {accepted:true};
    }
    follow(request,signal) {
      const open=stop=>this.followHistory(request,stop);
      return this.readerAccess?scope.observeStream(open,signal):open(signal);
    }
    async *followHistory(request,signal) {
      const lifetime=new AbortController();
      const stop=AbortSignal.any([signal,lifetime.signal]);
      let observation;
      try{
        for await(const frame of history.follow(request,stop)){
          if(frame.type==='snapshot'&&request.address.kind==='session'&&!stop.aborted){
            const id=request.address.sessionId;
            observation=interactions?.observe(id,stop).catch(error=>{
              if(!stop.aborted)console.error('Native interaction observation:',error.message);
            });
            if(request.activate===true&&frame.header.origin!=='subagent'&&!this.ctx.get('agents')?.get(id)){
              // The authorized snapshot already supplied the child-ownership check.
              void scope.runOwned(signal=>activate(id,signal)).then(ordinary)
                .catch(error=>this.ctx.emit('api-session/error',id,error.message))
                .catch(error=>this.ctx.logger.error('Session activation failed:',error));
            }
          }
          yield frame;
        }
      }
      finally{lifetime.abort();await observation;}
    }
    events(request,signal) {return this.read(stop=>history.page(request,stop),signal);}
    page(request,signal) {return this.events(request,signal);}
    state({sessionId},signal) {
      return this.read(stop=>readSessionState(this.ctx,history,RemoteError,sessionId,stop),signal);
    }
    observeState({sessionId},signal) {
      const open=stop=>observeSessionState(this.ctx,sessionId,stop,
        readSignal=>readSessionState(this.ctx,history,RemoteError,sessionId,readSignal));
      return this.readerAccess?scope.observeStream(open,signal):open(signal);
    }
    observeEvent({address},signal) {
      return observeSessionEvents(this.ctx,address.kind==='subagent'?address.childSessionId:address.sessionId,signal,{RemoteError,Deque});
    }
    projections(request,signal) {return this.read(stop=>history.projections(request,stop),signal);}
    observeProjections(request,signal) {return history.observeProjections(request,signal);}
    control(signal) {
      const access=this.readerAccess;
      return history.control(signal,access && (id=>access.allows({kind:'session',id})));
    }
    async list(_request,signal) {
      const access=this.readerAccess;
      const rows=access
        ? (await scope.observeOwned(scope.list,signal)).filter(row=>access.allows({kind:'session',id:row.id}))
        : await scope.list(signal);
      const items=rows.map(row=>this.summary(row));
      items.sort((left,right)=>right.updatedAt-left.updatedAt);
      return {items};
    }
    async search({query},signal) {
      const access=this.readerAccess;
      const result=await this.read(stop=>searchSessionMessages(this.ctx.get('sessionQuery'),query,stop,searchApi),signal);
      if(access)result.items=result.items.filter(item=>access.allows({kind:'session',id:item.sessionId}));
      return result;
    }
  };
}
