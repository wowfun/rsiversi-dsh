import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {captureAgentView} from './agent-view.mjs';
import {retainedRegion} from './compaction.mjs';
import {bindCheckpointSession,captureCheckpointAppend} from './plugin-checkpoints.mjs';
import {nativeForkSeed} from './fork-seed.mjs';
import {snapshotForkAnnotations} from '../session/fork-annotations.mjs';
import {bindPluginRecords} from '../session/plugin-records.mjs';
import {isChildSetupEvent,isPermissionEvent} from '../session/session.mjs';
import {appendPermission,seedNativePermission} from './permission.mjs';

/** Context registrations owned upstream by the working-directory service and Agent loop. */
export async function registerWorkbenchContext(ctx,z) {
  const directory=z.string().min(1).refine(isAbsolute).nullable();
  await ctx.sessionProjections.register({
    key:'workingDirectory',stateVersion:3,stateSchema:directory,
    init:header=>header.cwd??null,
    apply:(state,event)=>event.type==='workspace-root/change'?event.data.cwd:state,
    wire:{viewSchema:directory,view:state=>state},
  });
  ctx.systemPrompt.variable('provider',context=>context.modelSelection?.provider??context.agent?.options.provider);
  ctx.systemPrompt.variable('model',context=>context.modelSelection?.model??context.agent?.options.model);
}

/** Original Cordis owns Agent lifetime; native Session services own execution and history. */
export async function workbenchAgents(ctx,scope,history,{createScope,scopeTarget},{agentEvents,AgentModel,modelSelectionProjectionDefinition},snapshotJsonValue,subagents,goals) {
  const modelProjection=await ctx.sessionProjections.register(modelSelectionProjectionDefinition);
  const records=new Map(),opening=new Map(),creating=new Map(),changedDuringSetup=new Set();
  function notifySession(record,name,event) {
    const args=[record.sessionCarrier,name,record.agent.session];
    if(event!==undefined)args.push(event);
    // Cordis removes the carrier and name when it resolves the scoped listeners.
    for(const listener of ctx.events.dispatch('emit',args)){
      try{
        const result=listener(...args);
        if(result!==undefined)void Promise.resolve(result).catch(error=>
          ctx.logger.warn(`session "${record.id}": ${name} listener rejected: ${String(error)}`));
      }catch(error){
        if(name==='session/created')throw error;
        ctx.logger.warn(`session "${record.id}": ${name} listener threw: ${String(error)}`);
      }
    }
  }
  function publishEvents(record) {
    const through=record.view.session.seq;
    const events=record.view.session.snapshotEvents(record.notified,through);record.notified=through;
    for(const event of events) {
      try {
        const previous=record.publishingEvent;
        record.publishingEvent=true;
        try{notifySession(record,'session/event',event);}
        finally{record.publishingEvent=previous;}
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
      const previous=record.agent.status,presetChanged=record.view.preset!==captured.preset;
      record.view=captured;
      if(presetChanged)await ctx.get('agentPresets')?.bindSession?.(record.agent,captured.preset,true);
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
    void settled.finally(()=>{
      record.pending.delete(settled);
      if(record.pendingWake===settled)record.pendingWake=undefined;
    }).catch(error=>ctx.logger.warn('Native Agent mutation failed:',error));
    return settled;
  }
  function whenIdle(record) {
    if(record.closed)return Promise.resolve();
    if(record.idleWait)return record.idleWait;
    const pending=scope.observeOwned(async signal=>{
      for(;;) {
        const prior=record.tail;
        await prior?.catch(()=>{});
        if(record.maintenance)await record.maintenance.done;
        await scope.inbox.waitIdle(record.id,signal);
        if(record.closed)return;
        await refresh(record,signal);
        if(!record.maintenance&&prior===record.tail&&!record.view.inbox.driver_active&&!record.view.inbox.active_turn_id)return;
      }
    },record.idleStop.signal);
    record.idleWait=pending;
    void pending.then(()=>{if(record.idleWait===pending)record.idleWait=undefined;},
      ()=>{if(record.idleWait===pending)record.idleWait=undefined;});
    return pending;
  }
  function mirror(record,newSession) {
    function requireAppendableSession(){
      if(!record.sessionAnnounced)throw Error(`session "${record.id}" cannot append before session/created completes`);
      if(record.publishingEvent)throw Error('session append cannot reenter while another append is being published');
    }
    function appendOwned(write,setup=false) {
      if(record.closed||(record.closing&&!record.maintenance))throw Error('Agent has retired');
      if(!record.owner)throw Error('This Session event requires its owning native command');
      let event;
      if(setup)stage(record,async()=>{if(event)await record.owner.flush();return false;});
      event=write(record.owner.journal);
      if(!setup)record.owner.journal.scheduleFlush();
      publishEvents(record);
      return event;
    }
    const session={id:record.id,
      firstLiveSeq:record.view.session.seq,
      firstLifecycleSeq:newSession&&record.view.session.header.isSeeded?record.view.session.inheritedEventCount:record.view.session.seq,
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
        requireAppendableSession();
        if(!record.owner)throw Error('This Session event requires its owning native command');
        const checkpoint=captureCheckpointAppend(session,type,data,opts);
        if(checkpoint)return checkpoint;
        if(type==='goal/change'&&goals)return goals.commit(record,scope,data,opts,stage,publishEvents);
        if(isPermissionEvent(type)&&!subagents?.configuring(record.id)){
          // The published service pins existing Sessions from its own initializer.
          const presets=ctx.get('permissionPresets',false);
          return appendOwned(()=>appendPermission(ctx,presets,record,scope,type,data,opts));
        }
        if(type!=='model/selection'){
          if(type==='workspace-root/change'&&data?.cwd!==record.owner.cwd)
            throw Error('Working directory must match the native Session');
          return appendOwned(journal=>journal.append(type,data,opts,subagents?.configuring(record.id)&&!ctx.agents.get(record.id)),isChildSetupEvent(type));
        }
        let accepted,id;
        stage(record,async signal=>{if(!accepted)return false;await record.owner.driver.settle(id,signal);});
        accepted=record.owner.driver.accept(data,opts);id=record.owner.driver.latest().id;
        publishEvents(record);return accepted;
      },
    };
    bindPluginRecords(session,(type,data)=>{
      requireAppendableSession();
      return appendOwned(journal=>journal.appendPluginRecord(type,data)).seq;
    });
    const input=()=>{if(!record.owner)throw Error('Agent inbox requires its shared Session owner');return record.owner.input;};
    function change(action,wakes=false) {
      let accepted=false,through;
      const pending=stage(record,async signal=>{if(!accepted)return false;await input().ready(signal,through);});
      const before=record.view.session.seq;
      try {return action();}
      finally {
        through=record.view.session.seq;accepted=through!==before;
        if(accepted){
          if(wakes)record.pendingWake=pending;
          publishEvents(record);
        }
      }
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
      get status(){return !record.maintenance&&(record.view.inbox.driver_active||record.view.inbox.active_turn_id)?'running':'idle';},
      runMaintenance(job){
        if(record.closing||record.closed)throw Error('Agent has retired');
        const key=randomUUID();
        if(record.maintenance||record.pendingWake||!scope.commitControl(record.id,{type:'begin_maintenance',key}))
          throw Error(`agent "${record.id}" already has active work`);
        const controller=new AbortController(), watcher=new AbortController();
        const settled=Promise.withResolvers();
        record.maintenance={controller,done:settled.promise};
        return (async()=>{
          try {
            void scope.observeOwned(async signal=>{
              await scope.command(record.id,{type:'wait_maintenance_cancel',key},signal);
              controller.abort({kind:'user'});
            },watcher.signal).catch(error=>{if(!watcher.signal.aborted)controller.abort(error);});
            return await job(controller.signal);
          } finally {
            watcher.abort();
            try {
                try {if(record.maintenance.stopping)await record.maintenance.stopping;}
                finally {await scope.runOwned(signal=>scope.command(record.id,{type:'finish_maintenance',key},signal));}
            } finally {
              record.maintenance=undefined;
              settled.resolve();
              if(!record.closing&&agent.status==='running')record.dispatch.emit('agent/status',{status:'running'});
            }
          }
        })();
      },
      inject(message){
        change(()=>input().accept(message));
      },
      followup(message){
        change(()=>input().accept(message,'next_turn'),true);
      },
      steer(message){
        const aborted=record.maintenance?.controller.signal.aborted
          ?? (record.abortingTurn && record.abortingTurn===record.view.inbox.active_turn_id);
        change(()=>input().accept(message,aborted?'next_turn':'steer'),true);
      },
      cancel(cause,{keepInbox=false}={}){
        try {clear(false,keepInbox);}
        finally {
          if(record.maintenance) {
            record.maintenance.stopping=record.tail;
            record.maintenance.controller.abort(cause);
          }
          record.abortingTurn=record.view.inbox.active_turn_id;
        }
      },
    };
    bindCheckpointSession(session,{scope,region:(start,end)=>retainedRegion(record.owner,start,end),
      lifecycle:(type,data)=>appendOwned(journal=>journal.accept(
        type + ':' + data.compactionId,type,data)),
      refresh:signal=>refresh(record,signal)});
    return agent;
  }
  function attach(owner,options,source,created,prepare) {
    const id=options.sessionId??options.resumeSessionId;
    if(opening.has(id)||records.has(id)||ctx.agents.get(id))return Promise.reject(Error('Agent is already attached: '+id));
    // Reserve the Agent before native creation can publish its directory entry.
    const pending=prepare?Promise.resolve().then(prepare).then(()=>build(owner,options,source,created)):build(owner,options,source,created);
    opening.set(id,pending);
    void pending.finally(()=>{
      opening.delete(id);
      if(changedDuringSetup.delete(id)&&records.get(id)?.passive)return sharedBlankChanged(id);
    }).catch(error=>{
      if(records.has(id))ctx.logger.warn('Shared Agent observation failed:',error);
    });
    return pending;
  }
  async function build(owner,options,source,created) {
    const id=options.sessionId??options.resumeSessionId;
    const record={id,closed:false,pending:new Set(),idleStop:new AbortController(),view:await captureAgentView(scope,history,id,options.signal)};
    record.owner=history.owner?.(record.view.session);record.notified=record.view.session.seq;
    owner.fiber.assertActive();options.signal?.throwIfAborted();
    const agent=record.agent=mirror(record,options.sessionId!==undefined);
    record.sessionCarrier=scopeTarget(agent.session,agent);record.dispatch=agentEvents(ctx,agent);
    let detach,announced=false,disposing,world;
    const publication=Promise.withResolvers(),retentionStop=new AbortController();
    async function stop() {
      let failure;
      try {if(record.maintenance)agent.cancel({kind:'disposed'},{keepInbox:!announced});}
      catch(error){failure=error;}
      record.closing=true;
      retentionStop.abort(Error('Agent owner retired'));
      await publication.promise;
      try {
        record.observerStop?.abort();await record.observation;
        await Promise.allSettled([...record.pending]);
        if(record.maintenance)await record.maintenance.done;
        await record.owner?.flush();
        if(created)await scope.runOwned(async signal=>{
          if(!record.view.inbox.driver_active&&!record.view.inbox.active_turn_id)return;
          await scope.cancel({sessionId:id,keepInbox:true},signal);
          await scope.inbox.waitIdle(id,signal);
        });
        if(failure)throw failure;
      } finally {
        try {await record.releaseDraft?.();}
        finally {
          record.closed=true;record.idleStop.abort(Error('Agent has retired'));
          await Promise.allSettled([record.refreshing,record.refreshQueued]);detach?.();
          if(records.get(id)===record)records.delete(id);
          if(announced){
            try{notifySession(record,'session/disposed');}
            catch(error){ctx.logger.warn(`session "${id}": session/disposed dispatch threw: ${String(error)}`);}
          }
        }
      }
    }
    const releaseScope=ctx.effect(function*(){
      world=createScope(ctx,agent,{parent:options.parentAgent});agent.ctx=world.ctx;
      yield world.rawDispose;
      yield stop;
    },'native Agent '+id);
    const release=owner===ctx?releaseScope:owner.effect(()=>()=>releaseScope(),'native Agent owner '+id);
    function dispose(){
      return disposing??=(async()=>{
        try {await release();}finally{await world.dispose();}
      })();
    }
    try {
      const inbox=record.view.inbox;
      record.passive=inbox.kind==='draft'&&inbox.shared===true&&inbox.revision===0;
      if(inbox.kind==='draft'&&!record.passive)record.releaseDraft=await scope.retainDraft(id,options.signal?
        AbortSignal.any([options.signal,retentionStop.signal]):retentionStop.signal);
      owner.fiber.assertActive();options.signal?.throwIfAborted();
      if(record.closing)throw Error('Agent owner retired during draft acquisition');
      records.set(id,record);
      announced=true;notifySession(record,'session/created');
      record.sessionAnnounced=true;
      const setup=await options.setup?.(agent.ctx,agent);
      await ctx.get('agentPresets')?.bindSession?.(agent,record.view.preset);
      owner.fiber.assertActive();options.signal?.throwIfAborted();
      if(record.closing)throw Error('Agent owner retired during setup');
      setup?.commit();
      detach=ctx.agents.enter(agent,options.parentAgent);
      if(options.resumeSessionId||record.owner?.meta.plugin_child_depth===undefined)seedNativePermission(ctx,record);
      await ctx.agents.announce(agent,source,options.signal);
      record.dispose=dispose;
      if(!record.passive)observe(record);
      publication.resolve();
      return {agent,dispose};
    }catch(error){publication.resolve();await dispose();throw error;}
  }
  const factory={
    async createAgent(owner,options) {
      const meta={...options.meta},parent=meta.parentSession,id=options.sessionId;
      const supplied=options.seed??[];
      if(!parent&&(supplied.length||options.parentSource||meta.isSeeded||meta.origin||meta.delegationDepth!==undefined))
        throw Error('Native seeded or delegated creation requires a source Session');
      const pluginChild=subagents?.creation(owner,options);
      if(pluginChild&&(meta.isSeeded||options.seed!==undefined))
        throw Error('This subagent provider requires a managed native history fork');
      const seed=parent&&!pluginChild?nativeForkSeed(parent,supplied,records.get(parent)?.view.session):undefined;
      const annotations=snapshotForkAnnotations(supplied,options.inheritedEventCount,snapshotJsonValue);
      if(creating.has(id))throw Error('Agent creation already in progress');
      const receipt=Promise.withResolvers();
      creating.set(id,receipt.promise);
      const selection=options.agentOptions&&{...options.agentOptions};
      async function prepare(signal) {
        owner.fiber.assertActive();signal?.throwIfAborted();
        const result=pluginChild?await scope.createChild({...pluginChild,session_id:id,preset:meta.agentPreset},signal):
          seed?await scope.create({sessionId:id,fork:{source_session_id:parent,point:seed.point,turns:'all'}},signal):
          await scope.claimBlank(id,meta,signal);
        receipt.resolve({meta,annotations,createdAt:result.summary.createdAt});
        if(seed?.context){
          const catalog=await scope.command(id,{type:'list'},signal);
          const command=catalog.commands.find(command=>command.name==='context-seed');
          if(!command)throw Error('Native Session has no context-seed command');
          await scope.command(id,{type:'execute',invocation:{command:command.id,
            request_id:'initial-context',expected_revision:catalog.revision,arguments:{text:seed.context}}},signal);
        }
        if(selection?.provider&&selection?.model)
          await scope.selectModel({sessionId:id,...selection},signal);
      }
      try {
        return await scope.withCaller(signal=>attach(owner,{...options,signal},'startup',true,()=>prepare(signal)),options.signal);
      }finally{receipt.resolve();creating.delete(id);}
    },
    resume:(owner,options)=>scope.withCaller(signal=>attach(owner,{...options,signal},'resume',true),options.signal),
  };
  ctx.agents.setFactory(factory);
  async function sharedBlankChanged(id) {
    // A plugin can hold setup open. Remember changes without blocking the directory.
    if(id===null) {
      for(const key of new Set([...opening.keys(),...records.keys()])){
        // An unavailable or retired Session cannot prevent other mirrors catching up.
        try{await sharedBlankChanged(key);}
        catch(error){ctx.logger.warn('Shared Agent observation failed:',error);}
      }
      return;
    }
    if(opening.has(id)){changedDuringSetup.add(id);return;}
    const record=records.get(id);
    if(!record?.passive||record.closing)return;
    await refresh(record,record.idleStop.signal);
    if(record.closing||!record.passive)return;
    const inbox=record.view.inbox;
    if(inbox.kind==='draft'&&inbox.revision===0)return;
    record.passive=false;
    try {
      if(inbox.kind==='draft'){
        const release=await scope.retainDraft(id,record.idleStop.signal);
        if(record.closing){await release?.();return;}
        record.releaseDraft=release;
      }
      observe(record);
    }catch(error){record.passive=true;throw error;}
  }
  return {
    async creationMeta(id,createdAt){
      const row=await creating.get(id);
      return row&&row.createdAt===createdAt?row:undefined;
    },
    get:id=>records.get(id)?.agent,
    directoryOf(session){
      const record=records.get(session?.id);
      if(record?.agent.session===session)return record.owner?.cwd;
    },
    sessions:()=>Array.from(records.values(),record=>record.agent.session),
    async flush(session) {
      const record=records.get(session.id);
      if(record?.agent.session!==session)throw Error('Session is not registered');
      const listeners=ctx.events.dispatch('emit',[record.sessionCarrier,'session/flush',session]);
      const results=await Promise.allSettled([record.tail,record.owner?.flush(),...Array.from(listeners,async fn=>fn(session))]);
      const failed=results.find(result=>result.status==='rejected');
      if(failed)throw failed.reason;
      return true;
    },
    refresh:(id,signal)=>refresh(records.get(id),signal),
    compactionRegion(agent,start,end) {
      const record=records.get(agent.id);
      if(!record?.owner || record.agent.session!==agent.session)throw Error('Agent Session is not registered');
      return retainedRegion(record.owner,start,end);
    },
    sharedBlankChanged,
    async ensure(id,signal,source='resume') {
      const pending=opening.get(id);
      if(pending)return (await pending).agent;
      const record=records.get(id);
      if(record)return refresh(record,signal);
      return (await attach(ctx,{resumeSessionId:id,signal},source,false)).agent;
    },
  };
}
