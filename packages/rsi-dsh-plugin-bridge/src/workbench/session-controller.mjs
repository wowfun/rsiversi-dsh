/** Use the release's generated session codec and dispatch machinery. */
export function sessionSummary(ctx,{id,cwd,updatedAt,blank,running,parent,projections}) {
  return {sessionId:id,cwd,updatedAt,blank,running,formatStatus:'current',
    agentAvailable:!!ctx.get('agents')?.get(id),
    ...(projections?{projections}:{}),
    ...(parent?{parentSessionId:parent,origin:'subagent'}:{})};
}

export function sessionController({TypertRemoteService,RemoteError,SessionTitleInvalidError},scope,history,interactions,activate) {
  return class extends TypertRemoteService {
    static inject=['typert'];
    constructor(ctx) {super(ctx,'sessionController',{namespace:'session'});}
    [TypertRemoteService.init]() {
      const lookup=id=>scope.lookupAgent(id,activate);
      this.ctx.typert.lookups.configure('agent',lookup);
      this.ctx.typert.contexts.configureHost('agent',async id=>(await lookup(id)).ctx);
      this.ctx.inject(['fileUploads'],ctx=>ctx.effect(()=>ctx.fileUploads.registerAgentResolver(lookup),
        'file-upload Agent resolver'));
    }
    async resolveAgent(id) {
      try {return {agent:await scope.runOwned(signal=>activate(id,signal))};}
      catch(error){return {error};}
    }
    summary(row) {return sessionSummary(this.ctx,row);}
    async create(request,signal) {
      const result=await scope.create(request,signal);
      this.ctx.emit('api-session/added',this.summary(result.summary));
      return {sessionId:result.id,agentPreset:result.preset};
    }
    modelCatalog() {return scope.modelCatalog();}
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
    async attachment(request,signal) {
      const ref=request.attachment??await history.imageReference(request.sessionId,request.attachmentId,signal);
      const {ref:attachment,data}=await this.ctx.get('attachments').readImage(ref,signal);
      return {attachment,data:Buffer.from(data.buffer,data.byteOffset,data.byteLength).toString('base64')};
    }
    cancel(request,signal) {return scope.cancel(request,signal);}
    async *follow(request,signal) {
      if(request.address.kind==='session')await activate?.(request.address.sessionId,signal);
      const lifetime=new AbortController();
      const stop=AbortSignal.any([signal,lifetime.signal]);
      const observation=interactions&&request.address.kind==='session'
        ?interactions.observe(request.address.sessionId,stop).catch(error=>{
          if(!stop.aborted)console.error('Native interaction observation:',error.message);
        }):undefined;
      try{yield* history.follow(request,stop);}
      finally{lifetime.abort();await observation;}
    }
    page(request,signal) {return history.page(request,signal);}
    projections(request,signal) {return history.projections(request,signal);}
    observeProjections(request,signal) {return history.observeProjections(request,signal);}
    control(signal) {return history.control(signal);}
    async list(_request,signal) {
      const rows=await scope.list(signal);
      return {items:rows.map(row=>this.summary(row))};
    }
  };
}
