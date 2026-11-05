import {captureAgentView} from './agent-view.mjs';
import {followAssistant,followAgentAssistant} from './assistant.mjs';
import {projectionFrame,workbenchControl} from './control.mjs';
import {inboxReader} from '../session/inbox/inbox-state.mjs';
import {lastUsedModel} from './model.mjs';
import {workbenchOwners} from './owner.mjs';

export function historyHeader(meta) {
  return {version:4,id:meta.id,createdAt:meta.created_at,...(meta.cwd?{cwd:meta.cwd}:{}),
    ...(meta.preset?{agentPreset:meta.preset}:{}),isSeeded:meta.inherited};
}

function windowOf(request) {
  const max=request.maxMessages??50,window=request.turnWindow;
  if(!Number.isSafeInteger(max)||max<=0 || window && (!Number.isSafeInteger(window.minMessages)||
    window.minMessages<=0||window.minMessages>max||!Number.isSafeInteger(window.minTurns)||window.minTurns<=0))
    throw new Error('Invalid Session history window');
  return {max,window};
}

/** Page boundaries follow the release controller's message and turn coordinates. */
function pageOf(session,api,end,{max,window}) {
  let start=0,messages=0,turns=0;
  for(let i=end-1;i>=0;i--) {
    const event=session.eventAt(i);
    if(window && event.type==='turn/start' && ++turns>=window.minTurns && messages>=window.minMessages) {start=i;break;}
    if(!['user/message','assistant/message'].includes(event.type)||!api.isAppendSurfaceEvent(event))continue;
    if(++messages>=max) {
      start=event.seq;
      for(const source of event.sourceEventSeqs??[])start=Math.min(start,source);
      break;
    }
  }
  return {records:session.snapshotEvents(start,end).map(event=>({type:'event',event})),hasMore:start>0};
}

export function workbenchHistory({ctx,api,llm,read,release:releaseRead=read,listChildren,authorize,command,submit,inbox,storage,creationMeta}) {
  const owners=workbenchOwners({ctx,api,llm,command,submit,read,inbox,storage,creationMeta});
  const live=workbenchControl(authorize);
  async function open(request,signal,captured) {
    const {address}=request;
    const child=address.kind==='subagent';
    if(address.kind!=='session'&&(!child||!address.parentSessionId||!address.childSessionId||address.mode!=='continuable'))
      throw new Error('Subagent history requires its native parent authority');
    const id=child?address.childSessionId:address.sessionId;
    const call=(operation,override=signal)=>read(id,operation,override,child?address.parentSessionId:undefined);
    const release=operation=>releaseRead(id,operation,undefined,child?address.parentSessionId:undefined);
    const meta=captured??await call({type:'open'});
    if(!meta||meta.id!==id)throw new Error('Session history unavailable for this identity');
    const owner=await owners.open(historyHeader(meta),meta,call,release,signal);
    const session=owner.journal.session;
    async function projections(){
      const base=ctx.sessionProjections.snapshot(session),{spawned}=owner.source.current;
      const modelSelection=owner.model(),pending=owner.input.snapshot();
      const subagentCatalog=spawned.size?(await listChildren(session.id,signal)).filter(child=>spawned.has(child.id)):[];
      const imageLimits=ctx.get('attachments')?.imageLimits;
      return {...base,values:{...base.values,subagentCatalog,modelSelection,inbox:pending,
        ...(imageLimits?{imageLimits}:{})}};
    }
    // A native wake may cover several committed DSH events. The original
    // registry advances its cells incrementally against this bounded log view.
    let prefix,inboxPrefix;
    function* intermediate(previous,next){
      let {modelSelection,inbox,subagentCatalog,imageLimits}=previous.values;
      for(let seq=previous.asOfSeq+1;seq<next.asOfSeq;seq++){
        prefix??={header:session.header,inheritedEventCount:session.inheritedEventCount,
          eventAt:index=>session.eventAt(index),snapshotEvents:(start=0,end=prefix.seq)=>session.snapshotEvents(start,end)};
        prefix.seq=seq+1;
        const event=session.eventAt(seq),base=ctx.sessionProjections.snapshot(prefix);
        if(event.type==='model/selection')modelSelection={...modelSelection,next:event.data};
        if(event.type==='request/header')modelSelection={...modelSelection,lastUsed:lastUsedModel(api.canonicalHeader(event.data.header))};
        if(event.type==='agent/inbox/spliced'){
          inboxPrefix??=inboxReader(owner.journal,()=>owner.source.current.inbox.transitions);
          inbox=inboxPrefix.prefix(seq+1).snapshot();
        }
        if(event.type==='tool/result'&&next.values.subagentCatalog.length){
          const {spawned}=owner.source.current;
          subagentCatalog=next.values.subagentCatalog.filter(child=>owner.applicationSeq(spawned.get(child.id))<=seq);
        }
        yield {...base,values:{...base.values,subagentCatalog,modelSelection,inbox,...(imageLimits?{imageLimits}:{})}};
      }
    }
    const view={session,owner,call,projections,intermediate,
      get through(){return owner.cursor().fact_seq;},get controlThrough(){return owner.cursor().control_seq;},
      get mapping(){return owner.mapping();},
      releaseModel:key=>release({type:'model_close',key}),
      async advance(through,observedEffect,controlThrough) {
        await owner.apply({...owner.meta,through,selection_cursor:{kind:'durable',fact_seq:through,control_seq:controlThrough}},call,signal);
        if(view.publish)view.publish(await projections(),intermediate);
        return owner.settled(observedEffect);
      },
      async wait(cursor,after,observer=signal) {
        if(session.seq>after)return owner.cursor();
        const version=owner.version,stop=new AbortController();
        const lifetime=observer?AbortSignal.any([observer,stop.signal]):stop.signal;
        try {
          const next=await Promise.race([call({type:'wait',cursor},lifetime),owner.wait(version,lifetime).then(()=>owner.cursor())]);
          const current=owner.cursor();
          return {fact_seq:Math.max(next.fact_seq,current.fact_seq),control_seq:Math.max(next.control_seq,current.control_seq)};
        }finally{stop.abort();}
      },
    };
    return view;
  }
  return {
    close:owners.close,
    revision:owners.revision,
    async snapshot(meta) {
      const journal=owners.journal(meta.id);
      const saved=journal?.revision?undefined:await storage?.metadata(meta.id);
      const hint=saved?.header?.id===meta.id&&saved.header.createdAt===meta.created_at?saved:undefined;
      const header={...historyHeader(meta),...(meta.parent?{parentSession:meta.parent}:{})};
      const declared=journal?.session.header??hint?.header;
      if(meta.inherited&&declared?.parentSession===meta.parent&&declared?.origin==='subagent') {
        header.origin=declared.origin;
        if(declared.delegationDepth!==undefined)header.delegationDepth=declared.delegationDepth;
      }
      const count=journal?.revision?journal.seq:hint?.eventCount??0;
      return {header,formatStatus:'current',revision:JSON.stringify([meta.created_at,
        meta.selection_cursor.fact_seq,meta.selection_cursor.control_seq,count])};
    },
    owner:session=>owners.get(session),
    async *observeAgent(id,signal) {
      const view=await open({address:{kind:'session',sessionId:id}},signal);
      yield* followAgentAssistant(view,llm,signal);
    },
    metadata:(id,signal,metadataOnly=false)=>read(id,{type:'open',...(metadataOnly?{metadata_only:true}:{})},signal),
    async queueItem(id,itemId,signal) {
      const meta=await read(id,{type:'open'},signal);
      if(!meta)return;
      const {session}=meta.selection_cursor.kind==='draft'
        ?await captureAgentView({inbox},this,id,signal)
        :await open({address:{kind:'session',sessionId:id}},signal,meta);
      const owner=owners.get(session),row=await owner.input.pending(itemId,signal);
      if(row)return {...row,kind:owner.meta.selection_cursor.kind,turn:owner.source.current.mapping.turnId};
    },
    async selectModel({sessionId,provider,model,reasoningEffort},signal) {
      const view=await open({address:{kind:'session',sessionId}},signal);
      const selected={provider,model,...(reasoningEffort===undefined?{}:{reasoningEffort})};
      view.owner.driver.accept(selected);await view.owner.driver.ready(signal);
      return {selected};
    },
    async capture(id,meta,signal){
      const view=await open({address:{kind:'session',sessionId:id}},signal,meta);
      return view.session;
    },
    async imageReference(sessionId,id,signal){
      // Digest-only clients omit the metadata required by the original store.
      const {session}=await open({address:{kind:'session',sessionId}},signal);
      const find=blocks=>blocks?.find(block=>block.type==='image'&&block.attachment.attachmentId===id)?.attachment;
      for(let seq=session.seq-1;seq>=0;--seq){
        const {type,data}=session.eventAt(seq);
        const ref=find(type==='user/message'?data.content:data.message?.content);
        if(ref)return ref;
        if(type==='agent/inbox/spliced')for(const message of data.inserted){
          const inserted=find(message.content);
          if(inserted)return inserted;
        }
      }
      throw Error('Image is not referenced by this Session');
    },
    async captureAgent(id,meta,signal){
      const view=await open({address:{kind:'session',sessionId:id}},signal,meta);
      return {session:view.session,options:view.owner.model().next,sourceCursor:view.owner.meta.selection_cursor};
    },
    control:live.control,
    async forkTurn({sessionId,atSeq},signal){
      const {session}=await open({address:{kind:'session',sessionId}},signal);
      if(atSeq!==undefined && (!Number.isSafeInteger(atSeq)||atSeq<0||atSeq>=session.seq))
        throw new Error('Invalid Session fork cursor');
      for(let seq=atSeq??session.seq-1;seq>=0;seq--){
        const event=session.eventAt(seq);
        if(event.type==='turn/end' && event.data.rsi?.session===sessionId)return event.data.rsi.turn;
        if(atSeq!==undefined)throw new Error('This fork cursor requires an interrupted-history seed');
      }
      throw new Error('Session has no completed local Turn to fork');
    },
    async projections({sessionId},signal) {
      const view=await open({address:{kind:'session',sessionId}},signal);
      return {kind:'sequenced',...await view.projections()};
    },
    async *observeProjections({sessionId},signal) {
      const view=await open({address:{kind:'session',sessionId}},signal);
      let previous=await view.projections(),cursor={control_seq:view.controlThrough,fact_seq:view.through},after=previous.asOfSeq+1;
      yield {type:'ready'};
      while(!signal.aborted){
        cursor=await view.wait(cursor,after);
        await view.advance(cursor.fact_seq,undefined,cursor.control_seq);
        const next=await view.projections();
        after=next.asOfSeq+1;
        for(const step of view.intermediate(previous,next)){
          const frame=projectionFrame(previous,step);previous=step;if(frame)yield frame;
        }
        const frame=projectionFrame(previous,next);if(frame)yield frame;
        previous=next;
      }
    },
    async page(request,signal) {
      const window=windowOf(request);
      const {session}=await open(request,signal);
      const through=request.throughSeq,before=request.beforeSeq??through+1;
      if(!Number.isSafeInteger(through)||through< -1||through>=session.seq||!Number.isSafeInteger(before)||before<0)
        throw new Error('Invalid Session history cursor');
      return pageOf(session,api,Math.min(before,through+1),window);
    },
    async *follow(request,signal) {
      const window=windowOf(request);
      const view=await open(request,signal),{session,advance,through,projections}=view;
      let opening=await projections();
      const observer=live.open(session.id,opening,view.intermediate);
      view.publish=observer.publish;
      try {
      const snapshot=async (assistantStream,immediate)=>{
        const values=immediate&&opening.asOfSeq===session.seq-1?opening:await projections();
        opening=undefined;
        return {type:'snapshot',header:session.header,cursor:values.asOfSeq,...pageOf(session,api,values.asOfSeq+1,window),
          projections:values,...(assistantStream?{assistantStream}:{})};
      };
      if(request.assistantStream){yield* followAssistant(view,llm,signal,snapshot);return;}
      const first=await snapshot(undefined,true);
      let after=first.cursor+1;yield first;
      let cursor={control_seq:view.controlThrough,fact_seq:through};
      while(!signal.aborted) {
        const next=await view.wait(cursor,after);
        if(next.fact_seq<cursor.fact_seq||next.control_seq<cursor.control_seq)throw new Error('Session observation moved backwards');
        const start=after;
        await advance(next.fact_seq,undefined,next.control_seq);
        cursor=next;
        const events=session.snapshotEvents(start);after=session.seq;
        for(const event of events)yield {type:'event',event};
      }
      }finally{observer.close();}
    },
  };
}
