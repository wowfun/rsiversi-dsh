import {SessionFacade} from '../session/session.mjs';
import {restoreMapping} from '../history/history.mjs';
import {inheritedSession,factProjector} from './seed.mjs';
import {workbenchModel} from './model.mjs';
import {workbenchInbox} from './inbox.mjs';
import {cloneMapping} from '../history/input-history.mjs';
import {readControls,nativeFactPages} from '../history/native-pages.mjs';

/** A retained native projector has no retained request authority or partial published batches. */
export async function workbenchSource({ctx,api,llm,header,meta,call,release,signal,retireToolOutcome}) {
  const seed=meta.inherited?await inheritedSession(ctx,api,llm,call,release,header,signal):{header};
  const session=new SessionFacade(ctx,api,seed,false);
  let current={session,mapping:seed.mapping??restoreMapping(null),controlThrough:0,
    model:workbenchModel(meta.selection_cursor?.kind==='durable'?meta.model_baseline:meta.model_selection),
    inbox:workbenchInbox(),spawning:new Set(),spawned:new Map(),settled:new Map(),origins:new Map()};
  return {
    get current(){return current;},
    async stage(call,release,signal,through,controlThrough,localRequests=new Set(),inboxSlotFrom=0) {
      const original=current;
      const next={...original,session:session.branch(),mapping:cloneMapping(original.mapping),
        model:original.model.branch(),inbox:original.inbox.branch(),
        spawning:new Set(original.spawning),spawned:new Map(original.spawned),
        settled:new Map(original.settled),origins:new Map()};
      const fetch=nativeFactPages(call,release,signal);
      const project=factProjector(next.session,next.mapping,fetch,through,signal,llm,fact=>{
        if(fact.type==='model_started'&&next.mapping.model?.effectId===fact.effect_id)
          next.mapping.model.startedAfterSeq=next.session.seq-1;
        if(fact.type==='model_attempt_settled') {
          const event=next.session.seq?next.session.eventAt(next.session.seq-1):undefined;
          if(['assistant/message','assistant/attempt'].includes(event?.type))
            next.settled.set(fact.effect_id,{kind:'committed',eventType:event.type,seq:event.seq});
        }
        if(fact.type==='tool_intent'&&fact.name==='spawn_agent')next.spawning.add(fact.effect_id);
        if(fact.type==='tool_result'&&next.spawning.delete(fact.effect_id)&&!fact.result.is_error) {
          const id=fact.result.value?.session_id;
          if(typeof id==='string') {
            if(!next.spawned.has(id))next.spawned.set(id,next.session.seq-1);
            if(next.spawned.size>256)throw Error('Session child catalog exceeds the native tree limit');
          }
        }
        if(fact.type==='turn_terminal')next.spawning.clear();
        if(fact.type==='tool_result')return retireToolOutcome?.(header.id,fact.effect_id,fact.identity);
      });
      while(next.controlThrough<controlThrough) {
        const page=await readControls(call,release,next.controlThrough,controlThrough,signal);
        for(const event of page.events) {
          if(event.after_fact_seq<next.mapping.factCursor||event.after_fact_seq>through)
            throw Error('Control history changed its Fact anchor');
          await project(event.after_fact_seq);next.session.begin();
          try {
            if(event.kind==='model') {
              const appended=next.model.observe(event,next.session);
              if(localRequests.has(event.invocation?.request_id))next.origins.set(appended.seq,event);
            }
            else next.inbox.observe(event,next.session,next.mapping.turn,inboxSlotFrom);
          }finally{next.session.end();}
        }
        next.controlThrough=page.through;
      }
      await project(through);
      return {value:next,commit() {
        if(current!==original)throw Error('Native projection batch lost its original source');
        session.adoptBranch(next.session);next.session=session;next.origins.clear();current=next;
      }};
    },
  };
}
