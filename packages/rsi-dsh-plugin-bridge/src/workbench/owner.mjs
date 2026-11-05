import {isDeepStrictEqual} from 'node:util';
import {SessionProjectionJournal} from '../session/session-projection-journal.mjs';
import {modelIntents,modelObservationCorrelations} from '../session/model-intents.mjs';
import {inboxObservationProjection} from '../session/inbox/inbox-observations.mjs';
import {inputIntents} from '../session/inbox/input-intents.mjs';
import {workbenchSource} from './source.mjs';
import {workbenchModel} from './model.mjs';
import {readNativeMessage} from '../history/history.mjs';
import {journalCatalog} from '../session/session-journal-store.mjs';

const cut=meta=>meta.selection_cursor??{kind:'durable',fact_seq:meta.through,control_seq:0};
function compare(a,b) {
  if(a.kind!==b.kind)return a.kind==='durable'?1:-1;
  if(a.kind==='draft')return Math.sign(a.revision-b.revision);
  const fact=Math.sign(a.fact_seq-b.fact_seq),control=Math.sign(a.control_seq-b.control_seq);
  if(fact*control===-1)throw Error('Native observation cuts are incomparable');
  return fact||control;
}

/** One event owner while any Agent, reader or pending write retains its Session. */
export function workbenchOwners({ctx,api,llm,command,submit,read,inbox,storage,creationMeta}) {
  const rows=new Map(),opening=new Map(),retained=new WeakMap();let closed=false;
  const collected=new FinalizationRegistry(({id,reference})=>{if(rows.get(id)===reference)rows.delete(id);});
  async function create(header,meta,call,release,signal) {
    const document=await storage?.read(header.id);
    const creation=document===undefined?await creationMeta?.(header.id,header.createdAt):undefined;
    const declared=creation?.meta??journalCatalog(document)?.header;
    let annotations=creation?.annotations;
    if(meta.inherited&&declared?.origin==='subagent')
      header={...header,origin:declared.origin,...(declared.delegationDepth===undefined?{}:{delegationDepth:declared.delegationDepth})};
    const source=await workbenchSource({ctx,api,llm,header,meta,call,release,signal});
    if(header.origin&&source.current.session.header.parentSession!==declared.parentSession)
      throw Error('Declared fork parent differs from its native seed');
    const newOrigin=document===undefined&&header.origin!==undefined;
    const listeners=new Set(),waiters=new Set();let version=0,batch,tail=Promise.resolve();
    const report=error=>ctx.logger.warn('Application Session observer failed:',error);
    const changed=()=>{version++;for(const wake of waiters)wake();};
    const publish=event=>{
      changed();for(const listener of listeners)try{listener(event);}catch(error){report(error);}
    };
    const journal=new SessionProjectionJournal(ctx,api,{header:source.current.session.header},{document,
      save:storage?value=>storage.save(header.id,value):undefined,report,
      notify:(_session,event)=>batch?batch.push(event):publish(event)});
    const nativeCommand=(operation,signal)=>{
      if(!command)throw Error('Native Session commands unavailable');
      return command(header.id,operation,signal);
    };
    const driver=modelIntents(journal,nativeCommand),input=inputIntents(journal,{command:nativeCommand,
      submit:(value,signal)=>submit(header.id,value,signal),beforeSubmit:signal=>driver.ready(signal),
      messageStatus:(id,signal)=>inbox.messageStatus(header.id,id,signal),
      readMessage:(id,seq,signal)=>readNativeMessage(operation=>read(header.id,operation,signal),id,seq,signal),
      transitions:()=>source.current.inbox.transitions,inbox:{
        capture:signal=>inbox.capture(header.id,signal),
        discardDraft:(ids,signal)=>inbox.discardDraft(header.id,ids,signal),
        mutate:(mutation,signal)=>inbox.mutate(header.id,mutation,signal),
      }});
    async function reconcileClears(signal) {
      if(input.needsClearReconciliation)input.reconcileClears(await inbox.capture(header.id,signal));
    }
    const row={journal,driver,input,source,meta:undefined,merged:false,
      get version(){return version;},
      onEvent(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
      wait(after,signal) {
        signal?.throwIfAborted();if(after!==version)return Promise.resolve();
        return new Promise((resolve,reject)=>{
          const done=()=>{waiters.delete(done);signal?.removeEventListener('abort',aborted);resolve();};
          const aborted=()=>{waiters.delete(done);reject(signal.reason);};
          waiters.add(done);signal?.addEventListener('abort',aborted,{once:true});
        });
      },
      async apply(meta,call,signal) {
        const update=tail.catch(()=>{}).then(async()=>{
          signal?.throwIfAborted();if(closed)throw Error('Application Session owner retired');
          if(row.meta&&compare(cut(meta),cut(row.meta))<=0) {
            await reconcileClears(signal);
            if(journal.hasLocalEvents)await journal.flush();return;
          }
          const nextCut=cut(meta),through=meta.through,controlThrough=nextCut.control_seq??0;
          const localRequests=new Set(journal.operations().map(row=>row.id));
          const staged=await source.stage(call,signal,through,controlThrough,localRequests,journal.inboxSlotFrom),native=staged.value;
          if(nextCut.kind==='draft')native.model=workbenchModel(meta.model_selection);
          const saveCreation=!row.merged&&newOrigin;
          const after=row.merged?source.current.session.seq:0,events=native.session.snapshotEvents(after);
          const correlations=modelObservationCorrelations(journal,driver,events,native.origins);
          const inbox=inboxObservationProjection(journal,events,native.inbox.transitions);
          for(const [seq,id] of inbox.correlations)correlations.set(seq,id);
          batch=[];
          let appended;
          try {
            if(row.merged)journal.advance(after,events,correlations,inbox.projections);
            else journal.merge(events,correlations,native.session.inheritedEventCount,inbox.projections,annotations);
            staged.commit();row.meta=structuredClone(meta);row.merged=true;annotations=undefined;appended=batch;
          }finally{batch=undefined;}
          changed();for(const event of appended)publish(event);
          await reconcileClears(signal);
          if(journal.hasLocalEvents||saveCreation)await journal.flush();
        });
        tail=update;await update;
      },
      async flush(){await tail.catch(()=>{}); if(journal.hasLocalEvents)await journal.flush();},
      cursor(){return {control_seq:source.current.controlThrough,fact_seq:source.current.mapping.factCursor};},
      applicationSeq(nativeSeq){
        if(nativeSeq===-1)return -1;
        const row=journal.sourceAt(nativeSeq);if(!row)throw Error('Native position has no application event');return row.seq;
      },
      mapping(){
        const mapping=source.current.mapping;
        return {...mapping,model:mapping.model?{...mapping.model,
          ...(mapping.model.startedAfterSeq===undefined?{}:{startedAfterSeq:row.applicationSeq(mapping.model.startedAfterSeq)})}:null};
      },
      settled(effect){
        const event=source.current.settled.get(effect);
        return event?{...event,seq:row.applicationSeq(event.seq)}:undefined;
      },
      model(){
        const value=source.current.model.snapshot(journal.session),chosen=journal.session.lastEvent('model/selection');
        return chosen?{...value,next:chosen.data}:value;
      },
    };
    retained.set(journal.session,row);
    return row;
  }
  return {
    async open(header,meta,call,release,signal) {
      if(closed)throw Error('Application Session owner retired');
      let row=rows.get(header.id)?.deref();
      if(!row) {
        let pending=opening.get(header.id);
        if(!pending) {
          pending=create(header,meta,call,release,signal).then(row=>{
            const reference=new WeakRef(row);rows.set(header.id,reference);
            collected.register(row,{id:header.id,reference});return row;
          });
          opening.set(header.id,pending);
          void pending.finally(()=>{if(opening.get(header.id)===pending)opening.delete(header.id);}).catch(()=>{});
        }
        row=await pending;
      }
      const {parentSession,origin,delegationDepth,...existing}=row.journal.session.header;
      if(!isDeepStrictEqual(existing,header))throw Error('Application Session identity changed');
      await row.apply(meta,call,signal);return row;
    },
    get(session){return retained.get(session);},
    journal(id){return rows.get(id)?.deref()?.journal;},
    revision(id){return rows.get(id)?.deref()?.journal.revision??0;},
    async close(){closed=true;await Promise.allSettled(opening.values());
      await Promise.all([...rows.values()].flatMap(reference=>{const row=reference.deref();return row?[row.flush()]:[];}));},
  };
}
