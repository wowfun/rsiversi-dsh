import {createHash} from 'node:crypto';
import {remap} from './session.mjs';
import {inboxObservationProjection} from './inbox/inbox-observations.mjs';
import {restoreInputOperation} from './inbox/input-invocation.mjs';

const maximumBytes=128*1024*1024;
const integer=value=>Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const shape=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const isDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export const createSourceDigest=()=>createHash('sha256').update('rsi.dsh.native-source-prefix.v1\0');

/** Parse the durable boundary once, before native history is captured. */
export function readJournalDocument(document) {
  if(document===undefined)return;
  if(typeof document!=='string'||Buffer.byteLength(document)>maximumBytes)throw Error('Invalid application journal size');
  const state=JSON.parse(document);
  if(!shape(state,['version','header','inheritedEventCount','events','sources','sourceDigest','operations','catalogTitle','eventCount','ownedEventCount','inboxSlotFrom'])
    ||![1,2,3,4,5,6,7].includes(state.version)||!Array.isArray(state.events)||!Array.isArray(state.sources)||!Array.isArray(state.operations))
    throw Error('Invalid application journal');
  const prefixDigest=state.version===7;
  if(prefixDigest?!isDigest(state.sourceDigest):Object.hasOwn(state,'sourceDigest'))throw Error('Invalid application source digest');
  const derivesCount=state.version>=6;
  if(derivesCount){
    if(Object.hasOwn(state,'eventCount')||!integer(state.ownedEventCount)||state.ownedEventCount!==state.events.length)
      throw Error('Invalid application journal event count');
  }else if(Object.hasOwn(state,'ownedEventCount'))throw Error('Invalid legacy application journal');
  if(state.version===1) {
    if(state.eventCount===undefined)state.eventCount=state.events.length;
    if(state.inboxSlotFrom===undefined)state.inboxSlotFrom=state.sources.length;
    if(state.eventCount!==state.events.length)throw Error('Invalid application journal event count');
  }
  const limit=derivesCount?100_000:state.eventCount;
  if(!integer(limit)||limit>100_000||state.events.length>limit||state.sources.length>limit||state.operations.length>limit)
    throw Error('Invalid application journal');
  if(!integer(state.inboxSlotFrom)||state.inboxSlotFrom>state.sources.length)throw Error('Invalid saved inbox source boundary');
  let count=0;
  const events=new Map();
  for(const event of state.events){
    if(derivesCount){
      if(!integer(event?.seq)||event.seq>=limit)throw Error('Invalid application journal event position');
      count=Math.max(count,event.seq+1);
    }
    events.set(event?.seq,event);
  }
  const used=new Set();
  for(const row of state.sources) {
    if(!shape(row,prefixDigest?['seq','operation']:['hash','seq','operation'])||!integer(row.seq)||row.seq>=limit||used.has(row.seq)
      ||!prefixDigest&&!isDigest(row.hash)
      ||row.operation!==undefined&&(typeof row.operation!=='string'||!row.operation||row.operation.length>256))
      throw Error('Invalid application source map');
    used.add(row.seq);
    if(derivesCount)count=Math.max(count,row.seq+1);
  }
  if(derivesCount)state.eventCount=count;
  if(!integer(state.inheritedEventCount)||state.inheritedEventCount>state.eventCount||state.events.length>state.eventCount
    ||state.sources.length>state.eventCount||state.operations.length>state.eventCount)throw Error('Invalid application journal');
  state.operations=state.operations.map(operation=>restoreInputOperation(operation,events.get(operation?.seq),state.version));
  return state;
}

/** Translate source-log references, never application-local references. */
/** Rebuild a candidate log; the owner's first merge verifies its source hashes and correlations. */
export function restoreJournalEvents(state,native=[],transitions=new Map()) {
  if(state.version===1)return state.events;
  if(native.length<state.sources.length)throw Error('Native event prefix moved backwards');
  const events=new Array(state.eventCount),owned=new Set();
  const operations=new Map(state.operations.map(row=>[row.id,row])),at=new Map(state.operations.map(row=>[row.seq,row]));
  let previous=-1;
  for(let event of state.events) {
    if(!integer(event?.seq)||event.seq>=events.length||event.seq<=previous)throw Error('Invalid local application event position');
    if(state.version>=5&&event.type==='agent/inbox/spliced'&&event.data?.inserted===null) {
      const operation=at.get(event.seq),source=state.sources[operation?.source],observed=native[operation?.source];
      if(!source||source.seq!==event.seq||source.operation!==operation.id||
        observed?.type!==event.type||observed.data.inserted?.length!==1||
        !['submission','context-input','observed-input'].includes(operation.invocation?.kind))
        throw Error('Retained input body has no correlated native acceptance');
      event={...event,data:{...event.data,inserted:observed.data.inserted}};
      restoreInputOperation(operation,event,state.version);
    }
    previous=event.seq;events[event.seq]=event;owned.add(event.seq);
  }
  for(const operation of state.operations)if(!owned.has(operation.seq))throw Error('Application mutation record lost its accepted event');
  for(const [index,source] of state.sources.entries()) {
    const event=native[index];
    if(event?.seq!==index)throw Error('Native event positions are not dense');
    if(owned.has(source.seq)) {
      if(at.get(source.seq)?.id!==source.operation||source.operation===undefined)
        throw Error('Native-only event body persisted in application journal');
    } else events[source.seq]=remap(event,source.seq,seq=>state.sources[seq]);
  }
  for(let seq=0;seq<events.length;seq++)if(!events[seq])throw Error('Application journal contains unowned event positions');
  const view={session:{seq:events.length,eventAt:seq=>events[seq]},nativeSeq:state.sources.length,revision:0,
    sourceAt:seq=>state.sources[seq],operations:()=>state.operations,operation:id=>operations.get(id),operationAt:seq=>at.get(seq)};
  const {projections}=inboxObservationProjection(view,native.slice(0,state.sources.length),transitions);
  for(const [index,data] of projections) {
    const seq=state.sources[index].seq;
    if(!owned.has(seq))events[seq]={...events[seq],data};
  }
  return events;
}

export function encodeJournalDocument(session,events,sources,sourceDigest,operations,inboxSlotFrom) {
  const event=session.lastEvent('session/title');
  const prefix=JSON.stringify({header:session.header,ownedEventCount:events.length,...(event?{catalogTitle:{value:event.data.title,seq:event.seq}}:{})});
  const sourceMap=sources.map(({seq,operation})=>({seq,...(operation===undefined?{}:{operation})}));
  const document=JSON.stringify({version:7,inheritedEventCount:session.inheritedEventCount,inboxSlotFrom,events,sources:sourceMap,sourceDigest,operations});
  const value=prefix.slice(0,-1)+',\n'+document.slice(1);
  if(Buffer.byteLength(value)>maximumBytes)throw Error('Application journal document capacity');
  return value;
}
