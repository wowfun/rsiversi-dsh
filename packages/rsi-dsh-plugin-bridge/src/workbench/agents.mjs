import {setTimeout as delay} from 'node:timers/promises';
import {captureAgentView} from './agent-view.mjs';
import {nativeForkSeed} from './fork-seed.mjs';
import {snapshotForkAnnotations} from '../session/fork-annotations.mjs';

/** Original Cordis owns Agent lifetime; native Session services own execution and history. */
export async function workbenchAgents(ctx,scope,history,{createScope,scopeTarget},{agentEvents,AgentModel,modelSelectionProjectionDefinition},snapshotJsonValue) {
  const modelProjection=await ctx.sessionProjections.register(modelSelectionProjectionDefinition);
  const records=new Map(),opening=new Map(),creating=new Map();
  function publishEvents(record) {
    const through=record.view.session.seq;
    const events=record.view.session.snapshotEvents(record.notified,through);record.notified=through;
    for(const event of events) {
      try {
        ctx.emit(record.sessionCarrier,'session/event',record.agent.session,event);
        if(event.type==='agent/inbox/spliced')
          for(const notification of record.owner.input.notifications().get(event.seq)??[])
            record.dispatch.emit(notification.type,notification.data);
      }catch(error){ctx.logger.warn('Agent Session observer failed:',error);}
    }
  }
  function capture(record) {
    const next=scope.observeOwned(async signal=>{
      if(record.closed)throw Error('Agent has retired');
      const captured=await captureAgentView(scope,history,record.id,signal);
      if(record.closed)throw Error('Agent has retired');
      if(captured.session.seq<record.notified)throw Error('Native Agent history moved backwards');
      const previous=record.agent.status;record.view=captured;
      publishEvents(record);
      if(record.agent.status!==previous)record.dispatch.emit('agent/status',{status:record.agent.status});
      return record.agent;
    },record.idleStop.signal);
    record.refreshing=next;
    const clear=()=>{record.refreshing=undefined;};
    void next.then(clear,clear);
    return next;
  }
  async function refresh(record,signal) {
    signal?.throwIfAborted();
    if(record.closed)throw Error('Agent has retired');
    // Callers arriving during a read share the next pass, never a cut captured
    // before their request.
    const next=record.refreshQueued??(record.refreshing
      ?record.refreshQueued=record.refreshing.catch(()=>{}).then(()=>{
        record.refreshQueued=undefined;
        return capture(record);
      }):capture(record));
    if(!signal)return next;
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(signal.reason);
      signal.addEventListener('abort',abort,{once:true});
      void next.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},
        error=>{signal.removeEventListener('abort',abort);reject(error);});
    });
  }
  function observe(record) {
    const stop=record.observerStop=new AbortController();
    let active,revision=0;
    function emit(frame) {
      if(frame.type==='start')active={id:frame.attemptId,index:0};
      if(frame.type==='chunk')active.index=frame.index+1;
      if(frame.type==='end')active=undefined;
      const {startedAfterSeq,...event}=frame;
      try {record.dispatch.emit('agent/assistant-stream',
        {frame:{...event,revision:++revision}});}
      catch(error){ctx.logger.warn('Agent stream observer failed:',error);}
    }
    function abandon(){if(active)emit({type:'end',attemptId:active.id,index:active.index,outcome:{kind:'abandoned'}});}
    record.observation=scope.observeOwned(async signal=>{
      try {
      while(!signal.aborted){
        try {
          if(record.view.inbox.kind==='draft') {
            await scope.inbox.waitDraft(record.id,record.view.inbox.revision,signal);
            await refresh(record,signal);continue;
          }
          for await(const entry of history.observeAgent(record.id,signal)) {
            signal.throwIfAborted();
            if(entry.type==='snapshot'||entry.type==='event'&&entry.event.seq>=record.notified)
              await refresh(record,signal);
            if(entry.type==='assistant-stream')emit(entry.frame);
          }
        }catch(error){
          abandon();
          if(signal.aborted)return;
          ctx.logger.warn('Native Agent observation failed:',error);
          await delay(1000,undefined,{signal});
        }
      }
      }finally{abandon();}
    },stop.signal).catch(error=>{if(!stop.signal.aborted)throw error;});
    void record.observation.catch(error=>ctx.logger.warn('Native Agent observer stopped:',error));
  }
  function stage(record,operation) {
    if(record.closing||record.closed)throw Error('Agent has retired');
    const prior=record.tail;
    const settled=scope.publish(async signal=>{
      await prior?.catch(()=>{});
      // A synchronously rejected call reserved a publication but changed no state.
      try {if(await operation(signal)===false)return;}
      catch(error){await refresh(record,signal).catch(()=>{});throw error;}
      await refresh(record,signal);
    });
    record.tail=settled;
    record.pending.add(settled);
    void settled.finally(()=>record.pending.delete(settled)).catch(error=>ctx.logger.warn('Native Agent mutation failed:',error));
    return settled;
  }
  function whenIdle(record) {
    if(record.closed)return Promise.resolve();
    if(record.idleWait)return record.idleWait;
    const pending=scope.observeOwned(async signal=>{
      for(;;) {
        const prior=record.tail;
        await prior?.catch(()=>{});
        await scope.inbox.waitIdle(record.id,signal);
        if(record.closed)return;
        await refresh(record,signal);
        if(prior===record.tail&&!record.view.inbox.driver_active&&!record.view.inbox.active_turn_id)return;
      }
    },record.idleStop.signal);
    record.idleWait=pending;
    void pending.then(()=>{if(record.idleWait===pending)record.idleWait=undefined;},
      ()=>{if(record.idleWait===pending)record.idleWait=undefined;});
    return pending;
  }
  function mirror(record) {
    const session={id:record.id,
      firstLiveSeq:record.view.session.seq,
      get header(){return record.view.session.header;},get seq(){return record.view.session.seq;},
      get inheritedEventCount(){return record.view.session.inheritedEventCount;},
      get surface(){return record.view.session.surface;},
      deriveMessages:()=>record.view.session.deriveMessages(),
      deriveEventMessage:event=>record.view.session.deriveEventMessage(event),
      requestHeader:()=>record.view.session.requestHeader(),
      snapshotEvents:(...args)=>record.view.session.snapshotEvents(...args),
      ownEvents:()=>record.view.session.snapshotEvents(record.view.session.inheritedEventCount),
      eventAt:seq=>record.view.session.eventAt(seq),lastEvent:type=>record.view.session.lastEvent(type),
      isOwnSeq:seq=>record.view.session.isOwnSeq(seq),
      append(type,data,opts={}) {
        if(!record.owner)throw Error('This Session event requires its owning native command');
        if(type!=='model/selection'){
          let event;
          stage(record,async()=>{if(event)await record.owner.flush();return false;});
          event=record.owner.journal.append(type,data,opts);
          publishEvents(record);return event;
        }
        let accepted,id;
        stage(record,async signal=>{if(!accepted)return false;await record.owner.driver.settle(id,signal);});
        accepted=record.owner.driver.accept(data,opts);id=record.owner.driver.latest().id;
        publishEvents(record);return accepted;
      },
    };
    const input=()=>{if(!record.owner)throw Error('Agent inbox requires its shared Session owner');return record.owner.input;};
    function change(action) {
      let accepted=false,through;
      stage(record,async signal=>{if(!accepted)return false;await input().ready(signal,through);});
      const before=record.view.session.seq;
      try {return action();}
      finally {through=record.view.session.seq;accepted=through!==before;if(accepted)publishEvents(record);}
    }
    function clear(inboxOnly,keepInbox=false) {
      let operations=[],accepted=false;
      const pending=stage(record,async signal=>{
        if(!accepted)return false;
        try {
          await record.owner.flush();
          await scope.cancel({sessionId:record.id,keepInbox,inboxOnly},signal);
          await input().confirmClear(operations);
        }catch(error){input().abandonClear(operations);throw error;}
      });
      // An earlier publication failure can skip the staged callback altogether.
      void pending.then(()=>input().abandonClear(operations),()=>input().abandonClear(operations));
      if(!keepInbox)operations=input().clear();
      accepted=!inboxOnly||operations.length>0;
      if(operations.length)publishEvents(record);
    }
    const inbox={get nextStep(){return input().snapshot()['next-step'];},get nextTurn(){return input().snapshot()['next-turn'];},
      get hasPending(){return inbox.nextStep.length+inbox.nextTurn.length>0;},
      clear(){if(inbox.hasPending)clear(true);},
      remove(id){if(![...inbox.nextStep,...inbox.nextTurn].some(message=>message.id===id))return false;
        return !!change(()=>input().remove(id));},
    };
    const agent={id:record.id,session,inbox,
      model:new AgentModel(modelProjection.readerFor(session),session,record.view.options),
      get options(){return record.owner?.model().next??record.view.options;},
      whenIdle:()=>whenIdle(record),
      get status(){return record.view.inbox.driver_active||record.view.inbox.active_turn_id?'running':'idle';},
      inject(message){
        change(()=>input().accept(message));
      },
      followup(message){
        change(()=>input().accept(message,'next_turn'));
      },
      steer(message){
        const delivery=record.abortingTurn&&record.abortingTurn===record.view.inbox.active_turn_id?'next_turn':'steer';
        change(()=>input().accept(message,delivery));
      },
      cancel(_cause,{keepInbox=false}={}){
        clear(false,keepInbox);
        record.abortingTurn=record.view.inbox.active_turn_id;
      },
    };
    return agent;
  }
  function attach(owner,options,source,created) {
    const id=options.sessionId??options.resumeSessionId;
    if(opening.has(id)||records.has(id)||ctx.agents.get(id))return Promise.reject(Error('Agent is already attached: '+id));
    const pending=build(owner,options,source,created);
    opening.set(id,pending);
    void pending.finally(()=>{if(opening.get(id)===pending)opening.delete(id);}).catch(()=>{});
    return pending;
  }
  async function build(owner,options,source,created) {
    const id=options.sessionId??options.resumeSessionId;
    const record={id,closed:false,pending:new Set(),idleStop:new AbortController(),view:await captureAgentView(scope,history,id,options.signal)};
    record.owner=history.owner?.(record.view.session);record.notified=record.view.session.seq;
    owner.fiber.assertActive();options.signal?.throwIfAborted();
    const agent=record.agent=mirror(record);
    record.sessionCarrier=scopeTarget(agent.session,agent);record.dispatch=agentEvents(ctx,agent);
    let detach,announced=false,disposing,world;
    const publication=Promise.withResolvers(),retentionStop=new AbortController();
    async function stop() {
      record.closing=true;
      retentionStop.abort(Error('Agent owner retired'));
      await publication.promise;
      try {
        record.observerStop?.abort();await record.observation;
        await Promise.allSettled([...record.pending]);
        if(created)await scope.runOwned(async signal=>{
          if(!record.view.inbox.driver_active&&!record.view.inbox.active_turn_id)return;
          await scope.cancel({sessionId:id,keepInbox:true},signal);
          await scope.inbox.waitIdle(id,signal);
        });
      } finally {
        try {await record.releaseDraft?.();}
        finally {
          record.closed=true;record.idleStop.abort(Error('Agent has retired'));
          await Promise.allSettled([record.refreshing,record.refreshQueued]);detach?.();
          if(records.get(id)===record)records.delete(id);
          if(announced)ctx.emit(scopeTarget(agent.session,agent),'session/disposed',agent.session);
        }
      }
    }
    const release=owner.effect(function*(){
      world=createScope(owner,agent,{parent:options.parentAgent});agent.ctx=world.ctx;
      yield world.rawDispose;
      yield stop;
    },'native Agent '+id);
    function dispose(){
      return disposing??=(async()=>{
        try {await release();}finally{await world.dispose();}
      })();
    }
    try {
      if(record.view.inbox.kind==='draft')record.releaseDraft=await scope.retainDraft(id,options.signal?
        AbortSignal.any([options.signal,retentionStop.signal]):retentionStop.signal);
      owner.fiber.assertActive();options.signal?.throwIfAborted();
      if(record.closing)throw Error('Agent owner retired during draft acquisition');
      records.set(id,record);
      announced=true;await ctx.parallel(scopeTarget(agent.session,agent),'session/created',agent.session);
      const setup=await options.setup?.(agent.ctx,agent);
      owner.fiber.assertActive();options.signal?.throwIfAborted();
      if(record.closing)throw Error('Agent owner retired during setup');
      setup?.commit();
      detach=ctx.agents.enter(agent,options.parentAgent);
      await ctx.agents.announce(agent,source,options.signal);
      record.dispose=dispose;
      observe(record);
      publication.resolve();
      return {agent,dispose};
    }catch(error){publication.resolve();await dispose();throw error;}
  }
  const factory={
    async createAgent(owner,options) {
      const meta={...options.meta},parent=meta.parentSession,id=options.sessionId;
      if(!parent)throw Error('Native factory creation requires a source Session');
      const supplied=options.seed??[];
      const seed=nativeForkSeed(parent,supplied,records.get(parent)?.view.session);
      const annotations=snapshotForkAnnotations(supplied,options.inheritedEventCount,snapshotJsonValue);
      if(creating.has(id))throw Error('Agent creation already in progress');
      const receipt=Promise.withResolvers();
      creating.set(id,receipt.promise);
      try {
        const result=await scope.create({sessionId:id,fork:{source_session_id:parent,point:seed.point,turns:'all'}},options.signal);
        receipt.resolve({meta,annotations,createdAt:result.summary.createdAt});
        if(seed.context){
          const catalog=await scope.command(id,{type:'list'},options.signal);
          const command=catalog.commands.find(command=>command.name==='context-seed');
          if(!command)throw Error('Native Session has no context-seed command');
          await scope.command(id,{type:'execute',invocation:{command:command.id,
            request_id:'initial-context',expected_revision:catalog.revision,arguments:{text:seed.context}}},options.signal);
        }
        if(options.agentOptions?.provider&&options.agentOptions?.model)
          await scope.selectModel({sessionId:id,...options.agentOptions},options.signal);
        return await attach(owner,options,'startup',true);
      }finally{receipt.resolve();creating.delete(id);}
    },
    resume:(owner,options)=>attach(owner,options,'resume',true),
  };
  ctx.agents.setFactory(factory);
  return {
    async creationMeta(id,createdAt){
      const row=await creating.get(id);
      return row&&row.createdAt===createdAt?row:undefined;
    },
    get:id=>records.get(id)?.agent,
    sessions:()=>Array.from(records.values(),record=>record.agent.session),
    async flush(session) {
      const record=records.get(session.id);
      if(record?.agent.session!==session)throw Error('Session is not registered');
      const listeners=ctx.events.dispatch('emit',[record.sessionCarrier,'session/flush',session]);
      const results=await Promise.allSettled([record.tail,...Array.from(listeners,async fn=>fn(session))]);
      const failed=results.find(result=>result.status==='rejected');
      if(failed)throw failed.reason;
      return true;
    },
    refresh:(id,signal)=>refresh(records.get(id),signal),
    async ensure(id,signal) {
      const pending=opening.get(id);
      if(pending)return (await pending).agent;
      const record=records.get(id);
      if(record)return refresh(record,signal);
      return (await attach(ctx,{resumeSessionId:id,signal},'resume',false)).agent;
    },
  };
}
