import {isDeepStrictEqual} from 'node:util';
import {inboxReader} from './inbox-state.mjs';

/** Translate native queue operations into the shared application's positional log. */
export function inboxObservationProjection(journal,events,transitions) {
  const projections=new Map(),correlations=new Map();
  if(!events.some(event=>transitions.has(event.seq)))return {projections,correlations};
  const reader=inboxReader(journal,transitions),{identity,session,state,withdrawn}=reader;
  for(const event of events) {
    const transition=transitions.get(event.seq);if(!transition)continue;
    const inserted=transition.inserted.map(row=>({...identity(row),message:row.message,target:event.data.target}));
    const accepted=transition.kind==='accepted'&&inserted.length===1?inserted[0].operation:undefined;
    if(accepted) {
      const original=session.eventAt(accepted.seq);
      const idleSteer=accepted.invocation?.kind==='submission'&&accepted.invocation.delivery==='steer'&&
        original.data.target==='next-step'&&event.data.target==='next-turn';
      if(original.data.target!==event.data.target&&!idleSteer)throw Error('Native inbox acceptance changed its target');
      correlations.set(event.seq,accepted.id);projections.set(event.seq,original.data);
      continue;
    }
    const source=journal.sourceAt(event.seq);reader.prefix(source?source.seq:session.seq);
    let target=event.data.target,list=state[target],start=0,removedCount=0;
    if(transition.removed.length) {
      const removed=transition.removed[0],key=identity(removed).key;
      const located=Object.entries(state).find(([,rows])=>rows.some(row=>row.key===key));
      if(located)[target,list]=located;
      start=list.findIndex(row=>row.key===key);
      if(start<0) {
        if(!withdrawn.has(key))throw Error('Native inbox transition lost its application input');
        start=0;
      } else {
        if(!isDeepStrictEqual(list[start].message,removed.message))throw Error('Native inbox transition changed its message');
        removedCount=1;
      }
    } else {
      // Native predecessors determine insertion order; pending local inputs form the tail.
      for(const row of transition.before.slice(0,event.data.start)) {
        const index=list.findIndex(item=>item.key===identity(row).key);
        if(index>=0)start=index+1;
      }
    }
    const visible=inserted.filter(row=>!withdrawn.has(row.key));
    const data={target,start,...(removedCount?{removedCount}:{}),inserted:visible.map(row=>row.message),
      ...(removedCount&&event.data.outcome?{outcome:event.data.outcome}:{})};
    projections.set(event.seq,data);reader.apply(data,visible);
    if(source)reader.observed(source.seq);
  }
  return {projections,correlations};
}
