import {updateQueue} from './queue.mjs';
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

export function sessionController({TypertRemoteService,RemoteError,SessionTitleInvalidError,Deque},scope,history,interactions,activate) {
  return class extends TypertRemoteService {
    claims=new Map();
    static inject=['typert','remoteAccess'];
    constructor(ctx) {super(ctx,'sessionController',{namespace:'session'});}
    [TypertRemoteService.init]() {
      const lookup=id=>scope.lookupAgent(id,activate,true);
      this.ctx.typert.resources.register('session',{resolve:sessionResource});
      this.ctx.typert.lookups.register('session',{
        parameter:'session',wire:'sessionId',resource:'session',
        hostTypeSymbol:'@deepseek-ai/dsh-session#Session',
        wireTypeSymbol:'@deepseek-ai/dsh-session/types#SessionId',
        resolve:async id=>(await lookup(id)).session,
      });
      this.ctx.typert.lookups.configure('agent',lookup);
      this.ctx.typert.contexts.configureHost('agent',async id=>(await lookup(id)).ctx);
      this.ctx.inject(['fileUploads'],ctx=>ctx.effect(()=>ctx.fileUploads.registerAgentResolver(id=>scope.lookupAgent(id,activate)),
        'file-upload Agent resolver'));
    }
    async resolveAgent(id) {
      try {return {agent:await scope.runOwned(signal=>activate(id,signal))};}
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
      return {sessionId:result.id,agentPreset:result.preset};
    }
    get readerAccess() {
      const peer=this.ctx.invocation?.peer;
      if(peer && peer.principal.kind!=='owner')return this.ctx.remoteAccess;
    }
    read(operation,signal) {
      return this.readerAccess?scope.observeOwned(operation,signal):operation(signal);
    }
    modelCatalog() {return this.read(stop=>scope.modelCatalog(stop),this.ctx.invocation?.signal);}
    selectModel(request,signal) {return scope.selectModel(request,signal);}
    async rename({sessionId,title}) {
      const agent=await scope.lookupAgent(sessionId,activate);
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
      const admit=async content=>{
        if(content.some(part=>part.type==='image'))content=await this.ctx.get('attachments').admitPromptContent(content);
        return scope.prompt(content===request.content?request:{...request,content},signal);
      };
      if(!request.content.some(part=>part.type==='file'))return admit(request.content);
      const receipts=[...new Set(request.content.filter(part=>part.type==='file').map(part=>part.receiptId))];
      const agent=this.ctx.get('agents').get(request.sessionId)??await scope.lookupAgent(request.sessionId,activate);
      const uploads=this.ctx.get('fileUploads');
      const binding=uploads.bindPrompt(agent,receipts,request.requestId);
      try {
        const content=request.content.map(part=>{
          if(part.type!=='file')return part;
          const staged=uploads.resolve(agent,part.receiptId);
          return staged.type?staged:{type:'file',attachment:staged};
        });
        const result=await admit(content);
        binding.commit();
        return result;
      } finally {binding[Symbol.dispose]();}
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
              void this.resolveAgent(id).then(result=>{
                if(result.error)this.ctx.emit('api-session/error',id,result.error.message);
              }).catch(error=>this.ctx.logger.error('Session activation failed:',error));
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
      return {items:rows.map(row=>this.summary(row))};
    }
  };
}
