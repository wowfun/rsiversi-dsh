import {contentBlocks,nativeMessageSource,nativeMessageId} from '../history/conversation-history.mjs';
import {readNativeMessage} from '../history/pages.mjs';

/** Fold committed controls; the native queue remains the only execution owner. */
export function workbenchInbox(seed) {
  const rows=new Map(seed?.rows?.map(([id,row])=>[id,{...row}]));
  const transitions=new Map(seed?.transitions);
  let successor=seed?.successor?{...seed.successor,row:rows.get(seed.successor.predecessor_id)}:undefined;
  const list=target=>[...rows.values()].filter(row=>row.target===target)
    .sort((a,b)=>a.accepted-b.accepted);
  function splice(session,time,target,start,removed,inserted,outcome,effects=[],transition) {
    const event=session.appendObserved('agent/inbox/spliced',{
      target:target.replace('_','-'),start,...(removed?{removedCount:removed}:{}),inserted,
      ...(outcome?{outcome}:{}),
    },time);
    for(let index=0;index<transition.inserted.length;index++)
      transition.inserted[index].message=event.data.inserted[index];
    if(effects.length)transition.notifications=effects.map(effect=>effect.type==='agent/inbox/inserted'
      ?{...effect,data:{message:event.data.inserted.find(message=>message.id===effect.data.message.id)}}:effect);
    transitions.set(event.seq,transition);
    return event;
  }
  const before=target=>list(target).map(row=>({...row}));
  function remove(session,event,effect,turn) {
    const row=rows.get(event.message_id);
    if(!row)throw Error('Native inbox transition lost its accepted input');
    const prior=before(row.target),index=list(row.target).findIndex(item=>item===row);rows.delete(event.message_id);
    splice(session,event.time,row.target,index,1,[],effect==='discarded'?'canceled':undefined,
      effect?[{type:'agent/inbox/'+effect,data:{message:row.message,...(effect==='claimed'?{turn}:{})}}]:[],
      {kind:event.kind,before:prior,removed:[{...row}],inserted:[]});
    return row;
  }
  return {transitions,branch:()=>workbenchInbox({rows:[...rows],transitions,successor}),
    snapshot:()=>({'next-step':list('next_step').map(row=>row.message),
    'next-turn':list('next_turn').map(row=>row.message)}),async observe(event,session,call,signal,turn,inboxSlotFrom=0) {
    if(successor&&event.kind!=='accepted')throw Error('Native inbox successor lacks its next acceptance');
    if(event.kind==='successor') {
      const row=rows.get(event.predecessor_id);
      if(!row||rows.has(event.successor_id))throw Error('Native inbox successor lost its predecessor');
      successor={...event,row};return;
    }
    if(event.kind==='accepted') {
      if(rows.has(event.message_id)||!['next_step','next_turn'].includes(event.target))throw Error('Invalid native inbox acceptance');
      const native=await readNativeMessage(call,event.message_id,event.seq,signal);
      const slotId=successor?.slot.id??event.message_id;
      const useSlot=session.seq>=inboxSlotFrom;
      const identity=useSlot?slotId:native.message_id;
      const message={id:nativeMessageId(native.source,identity),role:'user',content:contentBlocks(native.content),
        source:nativeMessageSource(native.source,identity)};
      const accepted=useSlot&&successor?.row.target===event.target?successor.row.accepted:event.seq;
      if(successor) {
        if(successor.successor_id!==event.message_id)throw Error('Native inbox successor identity changed');
        const replaced=successor.row,predecessor=successor.predecessor_id;successor=undefined;
        const prior=before(replaced.target),index=list(replaced.target).findIndex(row=>row===replaced);rows.delete(predecessor);
        splice(session,event.time,replaced.target,index,1,[],undefined,
          [{type:'agent/inbox/discarded',data:{message:replaced.message}}],
          {kind:'replaced',before:prior,removed:[{...replaced}],inserted:[]});
      }
      const prior=before(event.target),row={nativeId:event.message_id,slotId,source:native.source,
        message,target:event.target,accepted};rows.set(event.message_id,row);
      const index=list(row.target).findIndex(item=>item===row);
      const appended=splice(session,event.time,row.target,index,0,[message],undefined,
        [{type:'agent/inbox/inserted',data:{message}}],
        {kind:'accepted',before:prior,removed:[],inserted:[{...row}]});
      row.message=appended.data.inserted[0];
    } else if(event.kind==='promoted') {
      const row=remove(session,event);
      if(row.target!=='next_step')throw Error('Only next-Step input can be promoted');
      const prior=before('next_turn');row.target='next_turn';rows.set(event.message_id,row);
      splice(session,event.time,row.target,list(row.target).findIndex(item=>item===row),0,[row.message],undefined,[],
        {kind:'promoted',before:prior,removed:[],inserted:[{...row}]});
    } else if(event.kind==='claimed'||event.kind==='discarded')remove(session,event,event.kind,turn);
    else throw Error('Unknown native inbox transition');
  }};
}
