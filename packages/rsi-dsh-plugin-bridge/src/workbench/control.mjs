import {isDeepStrictEqual} from 'node:util';

export function projectionFrame(previous,snapshot){
  if(snapshot.asOfSeq<=(previous?.asOfSeq??-1))return;
  const changes=[];
  for(const [key,val] of Object.entries(snapshot.values)){
    if(!previous||!isDeepStrictEqual(previous.values[key],val))changes.push({key,val});
  }
  if(changes.length)return {type:'projection',seq:snapshot.asOfSeq,changes};
}

/** Live mirrors supply original DSH projection frames; each receiver authorizes its own read. */
export function workbenchControl(authorize) {
  const sessions=new Map(),listeners=new Set();
  function notify(id,previous,value){
    const change=projectionFrame(previous,value);
    if(!change)return;
    const frame={...change,sessionId:id};
    for(const listener of listeners)listener(frame);
  }
  function open(id,value,intermediate){
    let entry=sessions.get(id);
    function publish(snapshot,intermediate){
      let previous=entry.value;
      if(snapshot.asOfSeq<=previous.asOfSeq)return;
      if(listeners.size){
        if(intermediate)for(const step of intermediate(previous,snapshot)){
          notify(id,previous,step);previous=step;
        }
        notify(id,previous,snapshot);
      }
      entry.value=snapshot;
    }
    if(entry){entry.references++;publish(value,intermediate);}
    else {
      entry={value,references:1};sessions.set(id,entry);
      if(listeners.size)notify(id,undefined,value);
    }
    return {publish,close(){
      if(--entry.references===0)sessions.delete(id);
    }};
  }
  async function* control(signal){
    signal.throwIfAborted();
    let pending=[],wake;
    const queue=frame=>{pending.push(frame);wake?.();};
    const aborted=()=>wake?.();
    const visible=async id=>{try{await authorize(id,signal);return true;}catch(error){if(signal.aborted)throw error;return false;}};
    listeners.add(queue);signal.addEventListener('abort',aborted,{once:true});
    try{
      const projections=Object.create(null);
      const initial=Array.from(sessions,([id,entry])=>[id,entry.value]);
      for(const [id,value] of initial)if(await visible(id))projections[id]=value;
      yield {type:'baseline',value:{projections}};
      while(!signal.aborted){
        if(!pending.length){await new Promise(resolve=>{wake=resolve;});wake=undefined;continue;}
        const batch=pending;pending=[];
        let lastId,admitted;
        for(const frame of batch){
          if(signal.aborted)return;
          if(frame.sessionId!==lastId){lastId=frame.sessionId;admitted=await visible(lastId);}
          if(admitted&&!signal.aborted)yield frame;
        }
      }
    }finally{listeners.delete(queue);signal.removeEventListener('abort',aborted);}
  }
  return {open,control};
}
