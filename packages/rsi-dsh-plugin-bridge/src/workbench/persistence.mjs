import {AsyncLocalStorage} from 'node:async_hooks';
import {isDeepStrictEqual} from 'node:util';

const integer=value=>Number.isSafeInteger(value)&&value>=0;
const revision=meta=>JSON.stringify([meta.created_at,meta.selection_cursor]);

/** Native reads supply immutable mirrors; no DSH writer or Agent owns this cache. */
export function workbenchPersistence(history,errors,storedPages) {
  const cache=new Map(),loading=new Map();let bytes=0;
  function capture(id,signal){
    const next=(loading.get(id)??Promise.resolve()).then(async()=>{
      signal?.throwIfAborted();
      const metadataOnly=cache.get(id)?.durable===true;
      const meta=await history.metadata(id,signal,metadataOnly);
      if(!meta)throw new errors.SessionPersistenceNotFoundError(id);
      const currentRevision=()=>revision(meta)+':'+(history.revision?.(id)??0),key=currentRevision();
      let row=cache.get(id);
      if(row?.revision===key){cache.delete(id);cache.set(id,row);return row;}
      const session=await history.capture(id,metadataOnly?undefined:meta,signal);
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
      row={revision:currentRevision(),durable:meta.selection_cursor.kind==='durable',view,bytes:session.encodedBytes};
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
  const stored=row=>{if(!row.durable)throw new errors.SessionPersistenceNotFoundError(row.view.id);return row.view;};
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
      if(access!=='read')throw new errors.SessionReadOnlyError(id,'open for write');
      const run=AsyncLocalStorage.snapshot(),initial=stored(await capture(id,signal));
      const header=initial.header,inheritedEventCount=initial.inheritedEventCount;
      let closed=false,lastSeq=initial.seq;
      const available=operation=>{if(closed)throw new errors.SessionHandleClosedError(id,operation);};
      const handle={id,header,inheritedEventCount,access,
        async read(offset=0,length,options={}){
          available('read');options.signal?.throwIfAborted();
          if(!integer(offset)||length!==undefined&&!integer(length))throw RangeError('Invalid Session read range');
          const view=stored(await run(()=>capture(id,options.signal)));
          available('read');
          if(view.seq<lastSeq||view.inheritedEventCount!==inheritedEventCount||!isDeepStrictEqual(header,view.header))
            throw Error('Native Session history changed its captured identity');
          lastSeq=view.seq;
          const start=Math.min(offset,view.seq),end=length===undefined?view.seq:Math.min(view.seq,start+length);
          return {events:view.snapshotEvents(start,end),eventState:'shared-frozen'};
        },
        async append(){available('append');throw new errors.SessionReadOnlyError(id,'append');},
        async flush(){available('flush');throw new errors.SessionReadOnlyError(id,'flush');},
        async close(){closed=true;},
        async [Symbol.asyncDispose](){await handle.close();},
      };
      return handle;
    },
  };
}
