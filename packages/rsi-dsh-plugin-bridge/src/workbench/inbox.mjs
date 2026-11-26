import {contentBlocks,nativeMessageSource,nativeMessageId} from '../history/conversation-history.mjs';
import {inboxTransitions} from '../session/inbox/inbox-state.mjs';

/** Fold committed controls; the native queue remains the only execution owner. */
export function workbenchInbox(seed) {
  const rows=new Map(seed?.rows);
  let successor=seed?.successor;
  const list=target=>[...rows.values()].filter(row=>row.target===target)
    .sort((a,b)=>a.accepted-b.accepted);
  function splice(session,time,target,start,removed,inserted,outcome,effects=[],transition) {
    const event=session.adoptObserved({type:'agent/inbox/spliced',seq:session.seq,time,data:{
      target:target.replace('_','-'),start,...(removed?{removedCount:removed}:{}),inserted,
      ...(outcome?{outcome}:{}),
    }});
    for(let index=0;index<transition.inserted.length;index++)
      transition.inserted[index].message=event.data.inserted[index];
    if(effects.length)transition.notifications=effects.map(effect=>effect.type==='agent/inbox/inserted'
      ?{...effect,data:{message:event.data.inserted.find(message=>message.id===effect.data.message.id)}}:effect);
    inboxTransitions.set(event,transition);
  }
  function insert(session,time,row,kind,effects) {
    rows.set(row.nativeId,row);
    const ordered=list(row.target),index=ordered.indexOf(row);
    splice(session,time,row.target,index,0,[row.message],undefined,effects,
      {kind,predecessors:ordered.slice(0,index),removed:[],inserted:[row]});
  }
  function remove(session,event,effect,turn) {
    const row=rows.get(event.message_id);
    if(!row)throw Error('Native inbox transition lost its accepted input');
    const index=list(row.target).indexOf(row);rows.delete(event.message_id);
    splice(session,event.time,row.target,index,1,[],effect==='discarded'?'canceled':undefined,
      effect?[{type:'agent/inbox/'+effect,data:{message:row.message,...(effect==='claimed'?{turn}:{})}}]:[],
      {kind:event.kind,removed:[row],inserted:[]});
    return row;
  }
  return {branch:()=>workbenchInbox({rows,successor}),
    snapshot:()=>({'next-step':list('next_step').map(row=>row.message),
    'next-turn':list('next_turn').map(row=>row.message)}),observe(event,session,turn,inboxSlotFrom=0) {
    if(successor&&event.kind!=='accepted')throw Error('Native inbox successor lacks its next acceptance');
    if(event.kind==='successor') {
      const row=rows.get(event.predecessor_id);
      if(!row||rows.has(event.successor_id))throw Error('Native inbox successor lost its predecessor');
      successor={...event,row};return;
    }
    if(event.kind==='accepted') {
      if(rows.has(event.message_id)||!['next_step','next_turn'].includes(event.target))throw Error('Invalid native inbox acceptance');
      const native=event.message;
      if(native?.message_id!==event.message_id)throw Error('Native inbox acceptance identity mismatch');
      const slotId=successor?.slot.id??event.message_id;
      const useSlot=session.seq>=inboxSlotFrom;
      const identity=useSlot?slotId:native.message_id;
      const message={id:nativeMessageId(native.source,identity),role:'user',content:contentBlocks(native.content),
        source:structuredClone(nativeMessageSource(native.source,identity))};
      const accepted=useSlot&&successor?.row.target===event.target?successor.row.accepted:event.seq;
      if(successor) {
        if(successor.successor_id!==event.message_id)throw Error('Native inbox successor identity changed');
        const replaced=successor.row,predecessor=successor.predecessor_id;successor=undefined;
        const index=list(replaced.target).indexOf(replaced);rows.delete(predecessor);
        splice(session,event.time,replaced.target,index,1,[],undefined,
          [{type:'agent/inbox/discarded',data:{message:replaced.message}}],
          {kind:'replaced',removed:[replaced],inserted:[]});
      }
      const row={nativeId:event.message_id,slotId,source:native.source,message,target:event.target,accepted};
      insert(session,event.time,row,'accepted',[{type:'agent/inbox/inserted',data:{message}}]);
    } else if(event.kind==='promoted') {
      const row=remove(session,event);
      if(row.target!=='next_step')throw Error('Only next-Step input can be promoted');
      insert(session,event.time,{...row,target:'next_turn'},'promoted');
    } else if(event.kind==='claimed'||event.kind==='discarded')remove(session,event,event.kind,turn);
    else throw Error('Unknown native inbox transition');
  }};
}
