import {randomUUID,createHash} from 'node:crypto';
import {RemoteRequestError} from '../../../../rsi-dsh-cordis/src/runtime/transport.mjs';
import {isDeepStrictEqual} from 'node:util';
import {commandReceipt} from '../command-receipts.mjs';
import {contextInputArguments,inboxReader,inputNativeId,isDirectSubmission,submissionInput} from './inbox-state.mjs';
import {contentBlocks,nativeMessageId,nativeMessageSource} from '../../history/conversation-history.mjs';
const mutationFor=(id,input)=>({operation_id:id,slot_id:input.slot_id,expected_message_id:input.message_id,mutation:{action:'withdraw'}});
function queueReceipt(id,input,receipt) {
  const mutation=mutationFor(id,input),fingerprint=createHash('sha256').update('rsi.queue-mutation.v1\0').update(JSON.stringify(mutation)).digest('hex');
  if(receipt?.operation_id!==id||receipt.request_fingerprint!==fingerprint||receipt.slot_id!==input.slot_id||
    receipt.expected_message_id!==input.message_id||!Number.isSafeInteger(receipt.control_seq)||receipt.control_seq<1||
    !['withdrawn','rejected'].includes(receipt.outcome?.result))throw Error('Native withdrawal receipt changed its accepted intent');
  return receipt;
}

/** Application acceptance is synchronous; the native command/queue remains the execution owner. */
export function inputIntents(journal,{command,submit,messageStatus,readMessage,beforeSubmit,inbox,transitions}) {
  let tail=Promise.resolve(),settledThrough=0;const undispatched=new Set(),reader=inboxReader(journal,transitions);
  const read=()=>reader.prefix();
  const inputs=()=>journal.operations().filter(row=>journal.session.eventAt(row.seq).type==='agent/inbox/spliced');
  const pendingClears=new Set(inputs().filter(row=>row.invocation?.kind==='clear-inputs'&&!row.receipt).map(row=>row.id));
  const activeClears=new Set(),blockedRestorations=new Set();
  function insert(message,target='next-step',invocation) {
    const state=read().state;
    if(Object.values(state).flat().some(row=>row.message.id===message.id))throw Error('Message is already pending: '+message.id);
    const id=randomUUID(),event=journal.accept(id,'agent/inbox/spliced',{target,start:state[target].length,inserted:[message]}, {},Date.now(),invocation);
    return {id,event};
  }
  function remove(messageId,invocation) {
    const state=read().state;
    for(const target of ['next-step','next-turn']) {
      const start=state[target].findIndex(row=>row.message.id===messageId&&
        (!invocation?.acceptance||row.operation?.id===invocation.acceptance));if(start<0)continue;
      const id=randomUUID(),event=journal.accept(id,'agent/inbox/spliced',{target,start,removedCount:1,inserted:[],outcome:'canceled'});
      if(invocation)journal.prepare(id,invocation);
      return {id,event};
    }
  }
  function verify(operation) {
    const event=journal.session.eventAt(operation.seq),input=operation.invocation,receipt=operation.receipt;
    if(event.data.inserted.length) {
      if(event.data.inserted.length!==1||event.data.removedCount||event.data.outcome)throw Error('Invalid retained input acceptance');
      if(['observed-input','restored-input'].includes(input?.kind))return;
      if(input?.kind==='submission') {
        const delivery=event.data.target==='next-step'?'steer':'next_turn';
        if(!isDeepStrictEqual(input,submissionInput(operation.id,event.data.inserted[0],delivery)))
          throw Error('Retained submission disagrees with its accepted message');
        if(receipt&&!['not-dispatched','rejected'].includes(receipt.kind)&&!isDeepStrictEqual(receipt,submissionReceipt(operation,receipt)))
          throw Error('Invalid retained submission receipt');
        return;
      }
      const revision=input?.expected_revision;
      if(input&&(typeof input.command!=='string'||!input.command||input.request_id!==operation.id||
        !isDeepStrictEqual(input.arguments,contextInputArguments(event.data.inserted[0]))||
        (revision?.kind==='draft'? !Number.isSafeInteger(revision.revision)||revision.revision<0:
          revision?.kind!=='durable'||!Number.isSafeInteger(revision.control_seq)||revision.control_seq<0)))
        throw Error('Retained input invocation disagrees with its accepted message');
      if(receipt&&receipt.kind!=='not-dispatched')commandReceipt(operation,receipt);
    } else {
      if(input?.kind==='clear-inputs') {
        if(event.data.start!==0||!Number.isSafeInteger(event.data.removedCount)||event.data.removedCount<1||event.data.outcome!=='canceled'||
          receipt&&!['cleared','reconciled'].includes(receipt.kind))throw Error('Invalid retained inbox clear');
        return;
      }
      if(event.data.removedCount!==1||event.data.outcome!=='canceled')throw Error('Invalid retained input withdrawal');
      if(input&& !['observed-withdrawal','local-withdrawal','withdraw-input'].includes(input.kind))throw Error('Invalid retained withdrawal intent');
      if(receipt?.kind==='queue')queueReceipt(operation.id,input,receipt.value);
      else if(receipt&&!['local','draft'].includes(receipt.kind))throw Error('Invalid retained withdrawal receipt');
    }
  }
  function submissionReceipt(operation,receipt) {
    if(receipt?.session_id!==journal.session.id||receipt.message_id!==operation.invocation.message_id||
      !Number.isSafeInteger(receipt.accepted_control_seq)||receipt.accepted_control_seq<1)
      throw Error('Native submission receipt changed its accepted identity');
    return {kind:'submitted',session_id:receipt.session_id,message_id:receipt.message_id,accepted_control_seq:receipt.accepted_control_seq};
  }
  async function submittedStatus(operation,signal) {
    const receipt=await messageStatus(operation.invocation.message_id,signal);
    if(!receipt)return;
    const accepted=submissionReceipt(operation,receipt),native=await readMessage(accepted.message_id,accepted.accepted_control_seq,signal);
    const message=journal.session.eventAt(operation.seq).data.inserted[0];
    if(native.message_id!==accepted.message_id||!isDirectSubmission(native.source)||
      !isDeepStrictEqual(native.source.attribution,operation.invocation.attribution)||!isDeepStrictEqual(contentBlocks(native.content),message.content))
      throw Error('Native submission acceptance changed its original message');
    return accepted;
  }
  async function send(operation,signal) {
    const id=operation.id;
    if(operation.receipt||read().withdrawn.has('local:'+id))return;
    if(blockedRestorations.has(journal.session.eventAt(operation.seq).data.inserted[0].id))
      throw Error('A reused message ID still has native pending input after an unconfirmed clear');
    if(operation.invocation?.kind!=='submission')return inject(operation,signal);
    await journal.flush();signal?.throwIfAborted();
    if(read().withdrawn.has('local:'+id))return;
    let receipt=!undispatched.has(id)?await submittedStatus(operation,signal):undefined;
    // Status reads may yield to a synchronous withdrawal; do not replay merely to remove it.
    if(!receipt) {
      await beforeSubmit?.(signal);
      if(read().withdrawn.has('local:'+id))return;
      const {kind,...input}=operation.invocation;
      undispatched.delete(id);
      try {receipt=submissionReceipt(operation,await submit(input,signal));}
      catch(error) {
        if(!(error instanceof RemoteRequestError))throw error;
        receipt=await submittedStatus(operation,signal);
        if(!receipt) {
          journal.complete(id,{kind:'rejected'});
          const message=journal.session.eventAt(operation.seq).data.inserted[0];
          const withdrawn=remove(message.id,{kind:'local-withdrawal',acceptance:id});
          if(withdrawn)journal.complete(withdrawn.id,{kind:'local'});
          throw error;
        }
      }
    }
    journal.complete(id,receipt);await journal.flush();
  }
  async function inject(operation,signal) {
    const id=operation.id;
    if(operation.receipt||read().withdrawn.has('local:'+id))return;
    if(!operation.invocation) {
      const catalog=await command({type:'list'},signal);
      if(read().withdrawn.has('local:'+id))return;
      const descriptor=catalog.commands.find(row=>row.name==='context-input');
      if(!descriptor)throw Error('Native Session has no context-input command');
      journal.prepare(id,{command:descriptor.id,request_id:id,expected_revision:catalog.revision,
        arguments:contextInputArguments(journal.session.eventAt(operation.seq).data.inserted[0])});
      operation=journal.operation(id);undispatched.add(id);
    }
    await journal.flush();signal?.throwIfAborted();
    if(read().withdrawn.has('local:'+id)) {
      if(undispatched.delete(id))journal.complete(id,{kind:'not-dispatched'});
      return;
    }
    let receipt=!undispatched.has(id)?await command({type:'status',request_id:id},signal):undefined;
    if(!receipt) {
      if(read().withdrawn.has('local:'+id))return;
      undispatched.delete(id);
      receipt=await command({type:'execute',invocation:operation.invocation},signal);
    }
    journal.complete(id,commandReceipt(operation,receipt));await journal.flush();
  }
  async function withdraw(operation,signal) {
    if(operation.receipt)return;
    const removed=read().removed.get(operation.id);
    if(removed?.length!==1)throw Error('Withdrawal lost its accepted input');
    const entry=removed[0];let accepted=entry.operation&&journal.operation(entry.operation.id);
    if(accepted?.invocation&&undispatched.has(accepted.id)&&!accepted.receipt) {
      journal.complete(accepted.id,{kind:'not-dispatched'});undispatched.delete(accepted.id);accepted=journal.operation(accepted.id);
    }
    if(accepted&&(!accepted.invocation||['not-dispatched','rejected'].includes(accepted.receipt?.kind))) {
      journal.prepare(operation.id,{kind:'local-withdrawal',acceptance:accepted.id});
      journal.complete(operation.id,{kind:'local'});await journal.flush();return;
    }
    if(accepted?.invocation?.command&&!accepted.receipt) {
      const receipt=await command({type:'status',request_id:accepted.id},signal);
      if(!receipt)throw Error('Input withdrawal is unconfirmed: native command outcome is unknown');
      journal.complete(accepted.id,commandReceipt(accepted,receipt));accepted=journal.operation(accepted.id);
    }
    if(accepted?.invocation?.kind==='submission'&&!accepted.receipt) {
      const receipt=await submittedStatus(accepted,signal);
      if(!receipt)throw Error('Input withdrawal is unconfirmed: native submission outcome is unknown');
      journal.complete(accepted.id,receipt);accepted=journal.operation(accepted.id);
    }
    const nativeId=entry.nativeId??inputNativeId(accepted);
    if(!nativeId)throw Error('Withdrawal lacks its native acceptance identity');
    const captured=await inbox.capture(signal),pending=captured.pending.find(row=>row.message_id===nativeId);
    if(!operation.invocation) {
      journal.prepare(operation.id,{kind:'withdraw-input',message_id:nativeId,slot_id:pending?.queue_slot?.id??entry.slotId??nativeId});
      operation=journal.operation(operation.id);
    }
    if(operation.invocation.message_id!==nativeId)throw Error('Retained withdrawal changed its native input');
    await journal.flush();
    if(captured.kind==='draft') {
      let receipt;
      try {receipt=await inbox.discardDraft([nativeId],signal);}
      catch(error) {
        const next=await inbox.capture(signal).catch(()=>undefined);
        if(next?.kind!=='durable')throw error;
      }
      if(receipt) {journal.complete(operation.id,{kind:'draft',revision:receipt.revision});await journal.flush();return;}
    }
    const receipt=queueReceipt(operation.id,operation.invocation,
      await inbox.mutate(mutationFor(operation.id,operation.invocation),signal));
    journal.complete(operation.id,{kind:'queue',value:receipt});await journal.flush();
    const absentDraft=receipt.outcome.reason==='missing_slot'&&accepted?.receipt?.outcome?.kind==='draft_changed';
    if(receipt.outcome.result==='rejected'&&receipt.outcome.reason!=='discarded'&&!absentDraft)
      throw Error('Pending input could not be removed: '+receipt.outcome.reason);
  }
  function clear() {
    const operations=[];
    try {
    for(const target of ['next-step','next-turn']) {
      const removedCount=read().state[target].length;if(!removedCount)continue;
      const id=randomUUID();activeClears.add(id);pendingClears.add(id);
      try {journal.accept(id,'agent/inbox/spliced',{target,start:0,removedCount,inserted:[],outcome:'canceled'}, {},Date.now(),{kind:'clear-inputs'});}
      catch(error){activeClears.delete(id);pendingClears.delete(id);throw error;}
      operations.push(id);
    }
    }catch(error){for(const id of operations)activeClears.delete(id);throw error;}
    return operations;
  }
  function reconcileClears(captured) {
    if(!pendingClears.size||activeClears.size)return;
    const present=new Map(captured.pending.map((row,index)=>[row.message_id,{...row,index}]));blockedRestorations.clear();
    for(const id of pendingClears) {
      let blocked=false;
      const operation=journal.operation(id);verify(operation);
      for(const entry of read().removed.get(id)??[]) {
        const native=present.get(entry.nativeId);if(!native)continue;
        const visible=Object.values(read().state).flat();if(visible.some(row=>row.key===entry.key))continue;
        if(visible.some(row=>row.message.id===entry.message.id)) {
          blockedRestorations.add(entry.message.id);blocked=true;continue;
        }
        const target=native.target.replace('_','-');
        const rows=read().state[target],after=rows.findIndex(row=>(present.get(row.nativeId)?.index??Infinity)>native.index);
        journal.accept(randomUUID(),'agent/inbox/spliced',{target,start:after<0?rows.length:after,inserted:[entry.message]},
          {},Date.now(),{kind:'restored-input',clear:id,key:entry.key});
      }
      if(!blocked){journal.complete(id,{kind:'reconciled'});pendingClears.delete(id);}
    }
  }
  async function settle(signal,through) {
    if(pendingClears.size&&!activeClears.size)reconcileClears(await inbox.capture(signal));
    read();
    for(const stale of journal.operationsBetween(Math.min(settledThrough,through),through)) {
      const operation=journal.operation(stale.id),event=journal.session.eventAt(operation.seq);
      if(event.type==='agent/inbox/spliced') {
        verify(operation);
        const kind=operation.invocation?.kind;
        if(!kind?.startsWith('observed-')&&!['clear-inputs','restored-input'].includes(kind)) {
        try {
          if(event.data.inserted.length)await send(operation,signal);
          else await withdraw(operation,signal);
        }catch(error) {
          journal.failed(operation.id,Array.from(String(error?.message??error)).slice(0,1000).join(''));
          await journal.flush().catch(()=>{});throw error;
        }
        }
      }
      settledThrough=Math.max(settledThrough,operation.seq+1);
    }
    settledThrough=Math.max(settledThrough,through);
    if(journal.hasLocalEvents)await journal.flush();
  }
  return {
    accept(message,delivery) {
      if(!message?.id||message.role!=='user'||!Array.isArray(message.content)||
        message.content.some(part=>!['text','file','image'].includes(part.type)))
        throw Error('Native Agent input requires text, file or image user content');
      if(delivery!==undefined&&!['next_turn','steer'].includes(delivery))throw Error('Invalid native input delivery');
      const accepted=insert(message,delivery==='next_turn'?'next-turn':'next-step');
      if(delivery) {
        journal.prepare(accepted.id,submissionInput(accepted.id,accepted.event.data.inserted[0],delivery));
        undispatched.add(accepted.id);
      }
      return accepted;
    },remove,clear,reconcileClears,
    get needsClearReconciliation(){return pendingClears.size>0&&activeClears.size===0;},
    async confirmClear(operations) {
      for(const id of operations){journal.complete(id,{kind:'cleared'});pendingClears.delete(id);activeClears.delete(id);}
      await journal.flush();
    },
    abandonClear(operations){for(const id of operations)activeClears.delete(id);},
    snapshot:()=>read().snapshot(),notifications:()=>read().notifications,
    ready(signal,through=journal.seq){const next=tail.catch(()=>{}).then(()=>settle(signal,through));tail=next;return next;},
    observeDraft(captured) {
      if(captured.kind!=='draft')return;
      const known=new Map(inputs().flatMap(row=>{const id=inputNativeId(row);return id?[[id,row]]:[];}));
      for(const row of captured.pending) {
        if(known.has(row.message_id))continue;
        const source=row.message.source,message={id:nativeMessageId(source,row.message_id),role:'user',
          source:nativeMessageSource(source,row.message_id),content:contentBlocks(row.message.content)};
        insert(message,row.target.replace('_','-'),{kind:'observed-input',message_id:row.message_id,source});
      }
      const present=new Set(captured.pending.map(row=>row.message_id));
      for(const entry of Object.values(read().state).flat()) {
        const operation=entry.operation;
        if(entry.nativeId&&!present.has(entry.nativeId)&&(operation?.invocation?.kind==='observed-input'||
          operation?.receipt?.outcome?.kind==='draft_changed'&&operation.receipt.outcome.revision<=captured.revision))
          remove(entry.message.id,{kind:'observed-withdrawal',message_id:entry.nativeId});
      }
    },
  };
}
