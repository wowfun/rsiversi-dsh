import {isDeepStrictEqual} from 'node:util';
import {invocationDigest} from '../command-receipts.mjs';
import {messageContent,submissionContent} from '../../agent/file-input.mjs';

export const isDirectSubmission=source=>source?.type==='human'||source?.type==='application';

export const submissionInput=(id,message,delivery)=>({kind:'submission',message_id:id,delivery,
  content:submissionContent(message.content),attribution:{id:message.id,source:message.source}});

export const contextInputArguments=message=>({content:messageContent(message.content),attribution:{id:message.id,source:message.source}});

export function inputNativeId(operation) {
  const invocation=operation?.invocation;
  return ['observed-input','submission'].includes(invocation?.kind)?invocation.message_id:
    invocation?.command?`command-${invocationDigest(invocation)}-0`:undefined;
}

/** Bind native acceptances to local operations without using a reusable presentation ID. */
export function inputIdentities(journal) {
  const observed=new Map(journal.operations().filter(row=>['observed-input','submission'].includes(row.invocation?.kind))
    .map(row=>[row.invocation.message_id,row])),cache=new Map();
  return row=>{
    if(cache.has(row.nativeId))return cache.get(row.nativeId);
    const source=row.source.type==='command'?row.source.source:undefined;
    const operation=(source?journal.operation(source.request_id):undefined)??observed.get(row.nativeId);
    let key='native:'+row.nativeId;
    if(operation) {
      const accepted=journal.session.eventAt(operation.seq),invocation=operation.invocation;
      const message=accepted.type==='agent/inbox/spliced'&&accepted.data.inserted.length===1?accepted.data.inserted[0]:undefined;
      const provenance=invocation?.kind==='observed-input'
        ?invocation.message_id===row.nativeId&&isDeepStrictEqual(invocation.source,row.source)
        :invocation?.kind==='submission'
        ?invocation.message_id===row.nativeId&&isDirectSubmission(row.source)&&
          isDeepStrictEqual(row.source.attribution,invocation.attribution)&&
          isDeepStrictEqual(invocation,submissionInput(operation.id,row.message,invocation.delivery))
        :invocation&&source?.command===invocation.command&&source.request_id===invocation.request_id&&source.ordinal===0
          &&source.invocation_sha256===invocationDigest(invocation)&&row.nativeId===inputNativeId(operation)
          &&isDeepStrictEqual(invocation.arguments,contextInputArguments(row.message));
      if(!provenance||operation.receipt?.kind==='not-dispatched'||!isDeepStrictEqual(message,row.message)||accepted.data.removedCount||accepted.data.outcome)
        throw Error('Native inbox acceptance disagrees with its prepared application input');
      key='local:'+operation.id;
    }
    const result={key,nativeId:row.nativeId,slotId:row.slotId??row.nativeId,operation};cache.set(row.nativeId,result);return result;
  };
}

/** A prefix fold used by observation, public snapshots and mutation settlement. */
export function inboxReader(journal,transitions=()=>new Map()) {
  const session=journal.session,nativeAtApplication=new Map();
  const state={'next-step':[],'next-turn':[]},withdrawn=new Set(),removed=new Map(),notifications=new Map();
  let through=0,nativeThrough=0,snapshot,identities,identityRevision;
  function identity(row) {
    if(identityRevision!==journal.revision){identities=inputIdentities(journal);identityRevision=journal.revision;}
    return identities(row);
  }
  function updateSources() {
    const current=typeof transitions==='function'?transitions():transitions;
    for(;nativeThrough<journal.nativeSeq;nativeThrough++) {
      const source=journal.sourceAt(nativeThrough),transition=current.get(nativeThrough);
      if(transition&&!source.operation)nativeAtApplication.set(source.seq,transition);
    }
  }
  function liveOperation(entry) {
    if(!entry.operation)return entry;
    const id=entry.operation.id;
    return {...entry,get operation(){return journal.operation(id);},
      get nativeId(){return inputNativeId(journal.operation(id));}};
  }
  function apply(data,inserted,operation,event) {
    const list=state[data.target],count=data.removedCount??0;
    if(!list||!Number.isSafeInteger(data.start)||data.start<0||!Number.isSafeInteger(count)||count<0||data.start+count>list.length)
      throw Error('Application inbox splice is outside its accepted prefix');
    const next=list.toSpliced(data.start,count,...inserted);
    const other=state[data.target==='next-step'?'next-turn':'next-step'];
    const ids=new Set();
    for(const row of [...next,...other]) {
      if(ids.has(row.message.id))throw Error('Application inbox contains a duplicate pending message');
      ids.add(row.message.id);
    }
    const old=list.slice(data.start,data.start+count);state[data.target]=next;
    snapshot=undefined;
    if(operation) {
      removed.set(operation.id,old);
      if(data.outcome==='canceled')for(const row of old)withdrawn.add(row.key);
      if(operation.invocation?.kind==='restored-input')for(const row of inserted)withdrawn.delete(row.key);
      notifications.set(event.seq,[...(data.outcome==='canceled'?old.map(row=>({type:'agent/inbox/discarded',data:{message:row.message}})):[]),
        ...inserted.map(row=>({type:'agent/inbox/inserted',data:{message:row.message}}))]);
    }
  }
  function fold(event) {
    if(event.type!=='agent/inbox/spliced')return;
    const operation=journal.operationAt(event.seq),native=nativeAtApplication.get(event.seq);
    if(operation?.invocation?.kind==='restored-input') {
      const {clear,key}=operation.invocation;
      const original=removed.get(clear)?.find(row=>row.key===key);
      if(journal.operation(clear)?.invocation?.kind!=='clear-inputs'||!original||event.data.inserted.length!==1||
        event.data.removedCount||event.data.outcome||!isDeepStrictEqual(event.data.inserted[0],original.message))
        throw Error('Restored inbox input changed its cleared acceptance');
      apply(event.data,[liveOperation({...original,target:event.data.target})],operation,event);return;
    }
    const inserted=event.data.inserted.map((message,index)=>liveOperation({message,target:event.data.target,
      ...(operation?{key:'local:'+operation.id,operation,nativeId:inputNativeId(operation)}:
        native?.inserted[index]?identity(native.inserted[index]):{key:'inherited:'+event.seq+':'+index})}));
    apply(event.data,inserted,operation,event);
    if(native?.notifications)notifications.set(event.seq,native.notifications.filter(effect=>
      effect.type==='agent/inbox/claimed'||(effect.type==='agent/inbox/inserted'
        ?inserted.some(row=>row.message.id===effect.data.message.id):event.data.removedCount>0)));
  }
  return {session,state,withdrawn,removed,notifications,identity,apply,
    prefix(end=session.seq) {
      if(end<through)throw Error('Native inbox observation rewound its application prefix');
      updateSources();
      while(through<end){fold(session.eventAt(through));through++;}return this;
    },
    observed(position){through=position+1;},
    snapshot(){return snapshot??=Object.freeze(Object.fromEntries(Object.entries(state).map(([target,rows])=>[target,Object.freeze(rows.map(row=>row.message))])));},
  };
}
