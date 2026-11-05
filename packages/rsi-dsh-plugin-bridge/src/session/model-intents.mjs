import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {commandReceipt as receiptFor} from './command-receipts.mjs';

const nativeSelection=value=>({model:{deployment:value.provider,model:value.model},
  ...(value.reasoningEffort===undefined?{}:{reasoning_effort:value.reasoningEffort})});
const failure=error=>Array.from(String(error?.message??error)).slice(0,1000).join('');
const integer=value=>Number.isSafeInteger(value)&&value>=0;

/** Synchronous choice acceptance; native effects settle through the supplied publication owner. */
export function modelIntents(journal,command) {
  let tail=Promise.resolve();
  const latest=()=>journal.operations().findLast(row=>journal.session.eventAt(row.seq).type==='model/selection');
  // Retained JSON is an external boundary; newly prepared in-process records are already frozen.
  for(const operation of journal.operations()) {
    const event=journal.session.eventAt(operation.seq);if(event.type!=='model/selection')continue;
    const input=operation.invocation;
    if(input) {
      const revision=input.expected_revision;
      if(input.request_id!==operation.id||typeof input.command!=='string'||!input.command||
        !isDeepStrictEqual(input.arguments,nativeSelection(event.data))||
        (revision?.kind==='draft'?!integer(revision.revision):revision?.kind!=='durable'||!integer(revision.control_seq)))
        throw Error('Retained model invocation disagrees with its accepted choice');
      if(operation.receipt)receiptFor(operation,operation.receipt);
    }
  }
  async function dispatch(id,signal) {
    let operation=journal.operation(id);
    if(!operation||journal.session.eventAt(operation.seq).type!=='model/selection')throw Error('Unknown model selection');
    if(latest()?.id!==id)return {kind:'superseded'};
    try {
      if(!operation.receipt) {
        if(!operation.invocation) {
          const catalog=await command({type:'list'},signal);
          // A choice may have arrived while the native catalog was being read.
          if(latest()?.id!==id)return {kind:'superseded'};
          const descriptor=catalog.commands.find(row=>row.name==='model-selection');
          if(!descriptor)throw Error('Native Session has no model-selection command');
          journal.prepare(id,{command:descriptor.id,request_id:id,expected_revision:catalog.revision,
            arguments:nativeSelection(journal.session.eventAt(operation.seq).data)});
          operation=journal.operation(id);
        }
        await journal.flush();
        signal?.throwIfAborted();
        if(latest()?.id!==id)return {kind:'superseded'};
        const receipt=await command({type:'execute',invocation:operation.invocation},signal);
        journal.complete(id,receiptFor(operation,receipt));
      }
      await journal.flush();
      return {kind:'confirmed',receipt:journal.operation(id).receipt};
    } catch(error) {
      journal.failed(id,failure(error));
      // Keep the original native/persistence error; a later retry retains the same invocation.
      await journal.flush().catch(()=>{});
      throw error;
    }
  }
  function settle(id,signal) {
    const next=tail.catch(()=>{}).then(()=>dispatch(id,signal));tail=next;
    return next;
  }
  return {
    accept(data,opts={},time=Date.now()) {return journal.accept(randomUUID(),'model/selection',data,opts,time);},
    latest,
    settle,
    async ready(signal) {
      for(;;) {
        const current=latest();if(!current)return;
        await settle(current.id,signal);
        if(latest()?.id===current.id)return;
      }
    },
    observe(control) {
      const id=control.invocation?.request_id,operation=journal.operation(id);
      if(!operation)return;
      if(control.kind!=='model'||journal.session.eventAt(operation.seq).type!=='model/selection'||
        !isDeepStrictEqual(operation.invocation,control.invocation))
        throw Error('Native model control changed its prepared invocation');
      journal.complete(id,receiptFor(operation,control.receipt));
      return id;
    },
  };
}

/** Reconcile native effective order while retaining a newer locally accepted choice. */
export function modelObservationCorrelations(journal,driver,events,origins) {
  if(!origins.size) {
    return new Map(events.flatMap(event=>{
      const source=journal.sourceAt(event.seq);
      if(!source?.operation)return [];
      return [[event.seq,source.seq===journal.operation(source.operation).seq?source.operation:{id:source.operation,reconcile:true}]];
    }));
  }
  const operations=new Map(journal.operations().map(row=>[row.seq,row]));
  const correlations=new Map();let pending,lastUsed,pendingOperation;
  function fold(event,operation) {
    if(event.type==='model/selection') {pending=event.data;pendingOperation=operation;}
    if(event.type==='request/header') {
      const {config,adapterDefaults}=event.data.header;
      lastUsed={provider:config.provider,model:config.model,
        ...(adapterDefaults?.reasoningEffort||config.reasoningEffort===undefined?{}:{reasoningEffort:config.reasoningEffort})};
      if(isDeepStrictEqual(pending,lastUsed)){pending=undefined;pendingOperation=undefined;}
    }
  }
  for(const event of journal.session.snapshotEvents())fold(event,operations.get(event.seq));
  for(const event of events) {
    const previous=journal.sourceAt(event.seq);
    if(previous) {
      if(previous.operation)correlations.set(event.seq,previous.seq===journal.operation(previous.operation).seq?
        previous.operation:{id:previous.operation,reconcile:true});
      continue;
    }
    const origin=origins.get(event.seq),id=origin?driver.observe(origin):undefined;
    if(!id){fold(event);continue;}
    const operation=journal.operation(id);
    if(isDeepStrictEqual(pending??lastUsed,event.data)||pendingOperation?.seq>operation.seq)
      correlations.set(event.seq,id);
    else {correlations.set(event.seq,{id,reconcile:true});fold(event);}
  }
  return correlations;
}
