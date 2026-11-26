import {isDeepStrictEqual} from 'node:util';
import {SessionProjectionJournal} from '../session/session-projection-journal.mjs';
import {modelIntents,modelObservationCorrelations} from '../session/model-intents.mjs';
import {inboxObservationProjection} from '../session/inbox/inbox-observations.mjs';
import {inputIntents} from '../session/inbox/input-intents.mjs';
import {workbenchSource} from './source.mjs';
import {restoredPermissionSeed} from './permission.mjs';
import {workbenchModel} from './model.mjs';
import {readNativeMessage} from '../history/native-pages.mjs';
import {readJournalDocument} from '../session/journal-document.mjs';

const cut=meta=>meta.selection_cursor??{kind:'durable',fact_seq:meta.through,control_seq:0};
const identityHeader=({agentPreset,...header})=>header;
function compare(a,b) {
  if(a.kind!==b.kind){
    const durable=a.kind==='durable'?a:b;
    // A stored Header exists before the editable draft. The first row publishes it.
    const durableOrder=durable.fact_seq===0&&durable.control_seq===0?-1:1;
    return a.kind==='durable'?durableOrder:-durableOrder;
  }
  if(a.kind==='draft')return Math.sign(a.revision-b.revision);
  const fact=Math.sign(a.fact_seq-b.fact_seq),control=Math.sign(a.control_seq-b.control_seq);
  if(fact*control===-1)throw Error('Native observation cuts are incomparable');
  return fact||control;
}

/** One event owner while any Agent, reader or pending write retains its Session. */
export function workbenchOwners({ctx,api,llm,command,submit,read,release:releaseRead,inbox,storage,creationMeta,retireToolOutcome}) {
  const rows=new Map(),opening=new Map(),retained=new WeakMap();let closed=false;
  const collected=new FinalizationRegistry(({id,reference})=>{if(rows.get(id)===reference)rows.delete(id);});
  async function create(header,meta,call,release,signal,first) {
    let restore=readJournalDocument(await storage?.read(header.id));
    const persisted=restore!==undefined,initialCut=cut(meta),restoredNativePreset=restore?.nativePreset;
    const creation=persisted?undefined:await creationMeta?.(header.id,header.createdAt);
    const declared=creation?.meta??restore?.header;
    let annotations=creation?.annotations;
    if(meta.inherited&&declared?.origin==='subagent')
      header={...header,origin:declared.origin,...(declared.delegationDepth===undefined?{}:{delegationDepth:declared.delegationDepth})};
    if(restore)header={...identityHeader(header),...restore.header.agentPreset===undefined?{}:{agentPreset:restore.header.agentPreset}};
    const source=await workbenchSource({ctx,api,llm,header,meta,call,release,signal,retireToolOutcome});
    source.current.permission=restoredPermissionSeed(restore);
    if(header.origin&&declared&&source.current.session.header.parentSession!==declared.parentSession)
      throw Error('Declared fork parent differs from its native seed');
    const newOrigin=!persisted&&header.origin!==undefined&&(meta.inherited||header.cwd!==meta.cwd);
    let initial;
    if(restore) {
      const ids=new Set(restore.operations.map(row=>row.id));
      initial=await source.stage(call,release,signal,meta.through,initialCut.control_seq??0,
        id=>ids.has(id),restore.inboxSlotFrom,first,meta.preset);
    }
    const listeners=new Set(),waiters=new Set();let version=0,batch,selectedModel,tail=Promise.resolve();
    const report=error=>ctx.logger.warn('Application Session observer failed:',error);
    const changed=()=>{version++;for(const wake of waiters)wake();};
    const publish=event=>{
      changed();for(const listener of listeners)try{listener(event);}catch(error){report(error);}
    };
    const journal=new SessionProjectionJournal(ctx,api,{header:source.current.session.header},{restore,adoptRestore:true,nativeEventState:'shared-frozen',
      native:initial?.value.session.snapshotEvents(),transitions:initial?.value.inbox.transitions,nativePreset:()=>source.current.preset??row.meta?.preset,
      save:storage?value=>storage.save(header.id,value):undefined,report,
      notify:(_session,event)=>{
        if(event.type==='model/selection')selectedModel=event.data;
        if(batch)batch.push(event);else publish(event);
      }});
    selectedModel=journal.session.lastEvent('model/selection')?.data;
    restore=undefined;
    const nativeCommand=(operation,signal)=>{
      if(!command)throw Error('Native Session commands unavailable');
      return command(header.id,operation,signal);
    };
    const driver=modelIntents(journal,nativeCommand),input=inputIntents(journal,{command:nativeCommand,
      submit:(value,signal)=>submit(header.id,value,signal),beforeSubmit:signal=>driver.ready(signal),
      messageStatus:(id,signal)=>inbox.messageStatus(header.id,id,signal),
      readMessage:(id,seq,signal)=>readNativeMessage(operation=>read(header.id,operation,signal),
        operation=>releaseRead(header.id,operation),id,seq,signal),
      transitions:()=>source.current.inbox.transitions,inbox:{
        capture:signal=>inbox.capture(header.id,signal),
        discardDraft:(ids,signal)=>inbox.discardDraft(header.id,ids,signal),
        mutate:(mutation,signal)=>inbox.mutate(header.id,mutation,signal),
      }});
    async function reconcileClears(signal) {
      if(input.needsClearReconciliation)input.reconcileClears(await inbox.capture(header.id,signal));
    }
    const row={journal,driver,input,source,meta:undefined,merged:false,
      get cwd(){return source.current.session.lastEvent('workspace-root/change')?.data.cwd??meta.cwd;},
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
      async apply(meta,call,release,signal,first) {
        const update=tail.catch(()=>{}).then(async()=>{
          signal?.throwIfAborted();if(closed)throw Error('Application Session owner retired');
          if(row.meta&&compare(cut(meta),cut(row.meta))<=0) {
            await reconcileClears(signal);
            if(journal.hasLocalEvents||persisted)await journal.flush({observed:true});return;
          }
          const nextCut=cut(meta),through=meta.through,controlThrough=nextCut.control_seq??0;
          const acceptedThrough=journal.seq;
          const staged=initial&&compare(nextCut,initialCut)===0?initial:
            await source.stage(call,release,signal,through,controlThrough,
              id=>journal.operation(id)?.seq<acceptedThrough,journal.inboxSlotFrom,first,meta.preset);
          const native=staged.value;
          if(nextCut.kind==='draft')native.model=workbenchModel(meta.model_selection);
          const saveCreation=!row.merged&&newOrigin;
          const after=row.merged?source.current.session.seq:0,events=native.session.snapshotEvents(after);
          const correlations=modelObservationCorrelations(journal,driver,events,native.origins);
          const inbox=inboxObservationProjection(journal,events,native.inbox.transitions);
          for(const [seq,id] of inbox.correlations)correlations.set(seq,id);
          const preceding=[];
          if(native.preset===undefined&&meta.preset!==undefined&&meta.preset!==(row.merged?row.meta?.preset:restoredNativePreset)) {
            const selected=journal.session.lastEvent('agent-preset/selected')?.data.agentPreset??journal.session.header.agentPreset;
            if(meta.preset!==selected)preceding.push({type:'agent-preset/selected',data:{agentPreset:meta.preset},time:Date.now()});
          }
          batch=[];
          let appended;
          try {
            if(row.merged)journal.advance(after,events,correlations,inbox.projections,preceding);
            else journal.merge(events,correlations,native.session.inheritedEventCount,inbox.projections,annotations,preceding);
            staged.commit();initial=undefined;row.meta=structuredClone(meta);row.merged=true;annotations=undefined;appended=batch;
          }finally{batch=undefined;}
          changed();for(const event of appended)publish(event);
          await reconcileClears(signal);
          if(journal.hasLocalEvents||saveCreation||persisted)await journal.flush();
        });
        tail=update;await update;
      },
      async flush(options){await tail.catch(()=>{}); if(row.merged&&(journal.hasLocalEvents||persisted))await journal.flush(options);},
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
      watchSettlement(){
        const attempt=source.watchSettlement();
        return ()=>{
          const event=attempt.outcome;
          return event&&{...event,seq:row.applicationSeq(event.seq)};
        };
      },
      model(){return source.current.model.snapshot(journal.session,selectedModel);},
    };
    retained.set(journal.session,row);
    return row;
  }
  return {
    async open(header,meta,call,release,signal,first) {
      if(closed)throw Error('Application Session owner retired');
      let row=rows.get(header.id)?.deref();
      if(!row) {
        let pending=opening.get(header.id);
        if(!pending) {
          pending=create(header,meta,call,release,signal,first).then(row=>{
            const reference=new WeakRef(row);rows.set(header.id,reference);
            collected.register(row,{id:header.id,reference});return row;
          });
          opening.set(header.id,pending);
          void pending.finally(()=>{if(opening.get(header.id)===pending)opening.delete(header.id);}).catch(()=>{});
        }
        row=await pending;
      }
      const existing=identityHeader(row.journal.session.header);
      if(meta.inherited){
        delete existing.parentSession;delete existing.origin;delete existing.delegationDepth;
      }
      if(!isDeepStrictEqual(existing,identityHeader(header)))throw Error('Application Session identity changed');
      await row.apply(meta,call,release,signal,first);return row;
    },
    get(session){return retained.get(session);},
    journal(id){return rows.get(id)?.deref()?.journal;},
    cursor(id){return rows.get(id)?.deref()?.cursor();},
    revision(id){return rows.get(id)?.deref()?.journal.revision??0;},
    async close(){closed=true;await Promise.allSettled(opening.values());
      await Promise.all([...rows.values()].flatMap(reference=>{const row=reference.deref();return row?[row.flush()]:[];}));},
  };
}
