import {AsyncLocalStorage} from 'node:async_hooks';
import {isDeepStrictEqual} from 'node:util';

const integer=value=>Number.isSafeInteger(value)&&value>=0;
const revision=meta=>JSON.stringify([meta.created_at,meta.selection_cursor]);

/** Native history remains immutable; write handles own only application events. */
export function workbenchPersistence(history,errors,storedPages) {
  const cache=new Map(),loading=new Map(),writers=new Set();let bytes=0;
  function capture(id,signal,durableOnly=false){
    const next=(loading.get(id)??Promise.resolve()).then(async()=>{
      signal?.throwIfAborted();
      const metadataOnly=durableOnly||cache.get(id)?.durable===true;
      const {meta,first}=metadataOnly?await history.stored(id,signal):{meta:await history.metadata(id,signal)};
      if(!meta||durableOnly&&meta.selection_cursor.kind!=='durable')throw new errors.SessionPersistenceNotFoundError(id);
      const currentRevision=()=>revision(meta)+':'+(history.revision?.(id)??0),key=currentRevision();
      let row=cache.get(id);
      if(row?.revision===key){cache.delete(id);cache.set(id,row);return row;}
      const session=await history.capture(id,meta,signal,first);
      const through=session.seq,header=session.requestHeader();
      const snapshotEvents=(start=0,end=through)=>{
        if(!integer(start)||!integer(end)||end>through||start>end)throw RangeError('Invalid captured Session interval');
        return session.snapshotEvents(start,end);
      };
      const view=Object.freeze({id:session.id,header:session.header,seq:through,
        inheritedEventCount:session.inheritedEventCount,
        requestHeader:()=>header,snapshotEvents,eventAt(seq){
          if(!integer(seq)||seq>=through)throw RangeError('Invalid captured Session interval');
          return session.eventAt(seq);
        },
        lastEvent(type){
          for(let seq=through-1;seq>=0;seq--){const event=session.eventAt(seq);if(event.type===type)return event;}
        }});
      row={revision:currentRevision(),durable:meta.selection_cursor.kind==='durable',view,session,bytes:session.encodedBytes};
      const previous=cache.get(id);if(previous){bytes-=previous.bytes;cache.delete(id);}
      while(cache.size>=16||bytes+row.bytes>64*1024*1024){
        const oldest=cache.keys().next().value;
        if(oldest===undefined)throw Error('Session mirror exceeds retained history capacity');
        bytes-=cache.get(oldest).bytes;cache.delete(oldest);
      }
      cache.set(id,row);bytes+=row.bytes;return row;
    });
    const settled=next.then(release,release);
    loading.set(id,settled);
    function release(){if(loading.get(id)===settled)loading.delete(id);}
    return next;
  }
  return {
    async capture(id,signal){return (await capture(id,signal)).view;},
    async stat(id,{signal}={}){
      const meta=await history.metadata(id,signal,true);
      if(meta?.selection_cursor.kind==='durable')return history.snapshot(meta);
    },
    async list({signal}={}){
      const snapshots=[];
      for await(const page of storedPages(signal)) {
        for(const meta of page)snapshots.push(await history.snapshot(meta));
      }
      return snapshots;
    },
    async open(id,access,{signal}={}){
      if(access!=='read'&&access!=='write')throw TypeError('Invalid Session access');
      const writable=access==='write',run=AsyncLocalStorage.snapshot();
      if(writable){
        if(writers.has(id))throw new errors.SessionAlreadyOwnedError(id);
        writers.add(id);
      }
      let initial,journal;
      try{
        const captured=await capture(id,signal,true);initial=captured.view;
        if(writable)journal=history.owner(captured.session).journal;
      }catch(error){if(writable)writers.delete(id);throw error;}
      const header=initial.header,inheritedEventCount=initial.inheritedEventCount;
      let closed=false,closing,lastSeq=initial.seq;
      const available=operation=>{if(closed)throw new errors.SessionHandleClosedError(id,operation);};
      const handle={id,header,inheritedEventCount,access,
        async read(offset=0,length,options={}){
          available('read');options.signal?.throwIfAborted();
          if(!integer(offset)||length!==undefined&&!integer(length))throw RangeError('Invalid Session read range');
          const view=(await run(()=>capture(id,options.signal,true))).view;
          available('read');
          if(view.seq<lastSeq||view.inheritedEventCount!==inheritedEventCount||!isDeepStrictEqual(header,view.header))
            throw Error('Native Session history changed its captured identity');
          lastSeq=view.seq;
          const start=Math.min(offset,view.seq),end=length===undefined?view.seq:Math.min(view.seq,start+length);
          return {events:view.snapshotEvents(start,end),eventState:'shared-frozen'};
        },
        async append(events,options={}){
          available('append');
          if(!writable)throw new errors.SessionReadOnlyError(id,'append');
          options.signal?.throwIfAborted();journal.appendStored(events);
        },
        async flush(options={}){
          available('flush');
          if(!writable)throw new errors.SessionReadOnlyError(id,'flush');
          options.signal?.throwIfAborted();await journal.flush();
        },
        close(){
          if(closing)return closing;
          closed=true;
          return closing=(async()=>{try{if(writable)await journal.flush();}finally{if(writable)writers.delete(id);}})();
        },
        async [Symbol.asyncDispose](){await handle.close();},
      };
      return handle;
    },
  };
}
