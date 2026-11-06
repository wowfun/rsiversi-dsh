import {isDeepStrictEqual} from 'node:util';

export function projectionFrame(previous,snapshot){
  if(snapshot.asOfSeq<=(previous?.asOfSeq??-1))return;
  const changes=[];
  for(const [key,val] of Object.entries(snapshot.values)){
    if(!previous||!isDeepStrictEqual(previous.values[key],val))changes.push({key,val});
  }
  if(changes.length)return {type:'projection',seq:snapshot.asOfSeq,changes};
}

/** Live mirrors share per-event changes; Host-wide readers authorize their baselines and updates. */
export function workbenchControl(authorize) {
  const sessions=new Map(),listeners=new Set();
  function notify(id,previous,value){
    const change=projectionFrame(previous,value);
    if(!change)return;
    const frame={...change,sessionId:id};
    for(const listener of listeners)listener.push(frame,previous===undefined);
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
  async function* observe(signal,sessionId){
    signal.throwIfAborted();
    let pending=[],wake,closed=false;
    const listener={
      push(frame,baseline){
        if(sessionId!==undefined&&(baseline||frame.sessionId!==sessionId))return;
        pending.push(frame);wake?.();
      },
      close(){
        closed=true;pending=[];listeners.delete(listener);
        signal.removeEventListener('abort',listener.close);wake?.();
      },
    };
    const visible=async id=>{try{await authorize(id,signal);return true;}catch(error){if(signal.aborted)throw error;return false;}};
    listeners.add(listener);signal.addEventListener('abort',listener.close,{once:true});
    try{
      if(sessionId===undefined){
        const projections=Object.create(null);
        const initial=Array.from(sessions,([id,entry])=>[id,entry.value]);
        for(const [id,value] of initial)if(await visible(id))projections[id]=value;
        yield {type:'baseline',value:{projections}};
      }else yield {type:'ready'};
      while(!closed){
        if(!pending.length){await new Promise(resolve=>{wake=resolve;});wake=undefined;continue;}
        const batch=pending;pending=[];
        let lastId,admitted;
        for(const frame of batch){
          if(closed)return;
          if(sessionId!==undefined){
            const {sessionId:_,...change}=frame;
            yield change;
          }else{
            if(frame.sessionId!==lastId){lastId=frame.sessionId;admitted=await visible(lastId);}
            if(admitted&&!closed)yield frame;
          }
        }
      }
    }finally{listener.close();}
  }
  return {open,control:signal=>observe(signal),
    observeProjections:({sessionId},signal)=>observe(signal,sessionId),
    close(){for(const listener of listeners)listener.close();listeners.clear();sessions.clear();},
  };
}
