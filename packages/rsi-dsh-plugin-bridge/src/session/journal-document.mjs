import {createHash} from 'node:crypto';
import {presetId,remap} from './session.mjs';
import {inboxObservationProjection} from './inbox/inbox-observations.mjs';
import {inboxReader,inboxTransitions,inputNativeId} from './inbox/inbox-state.mjs';
import {restoreInputOperation} from './inbox/input-invocation.mjs';

export const maximumJournalBytes=128*1024*1024;
const integer=value=>Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const shape=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const isDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

export const createSourceDigest=()=>createHash('sha256').update('rsi.dsh.native-source-prefix.v1\0');

/** Accepted operations keep their first position when preparation or a receipt replaces the row. */
export class JournalOperations extends Map {
  #inputAliases;
  set(id,row) {
    const input=row.invocation;
    if((input?.kind==='observed-input'||input?.kind==='context-input')&&input!==this.get(id)?.invocation) {
      const aliases=this.#inputAliases??=new Map(),nativeId=inputNativeId(row);
      const previous=this.get(aliases.get(nativeId));
      // Command IDs establish draft membership. Correlating a command needs its request provenance.
      if(!previous||input.kind==='observed-input'&&(previous.invocation.kind!=='observed-input'||row.seq>previous.seq))
        aliases.set(nativeId,id);
    }
    return super.set(id,row);
  }
  nativeInput(id) {
    const operation=this.get(id);
    const direct=operation?.invocation?.kind==='submission'?operation:undefined;
    const observed=this.#inputAliases&&this.get(this.#inputAliases.get(id));
    return observed?.invocation.kind==='observed-input'&&observed.seq>(direct?.seq??-1)?observed:direct;
  }
  hasNativeInput(id){return this.#inputAliases?.has(id)||this.get(id)?.invocation?.kind==='submission';}
}

function expandSourceRuns(state,limit) {
  let count=0,end=0;
  for(const run of state.sources) {
    if(!Array.isArray(run)||run.length!==2)throw Error('Invalid application source map');
    const [start,length]=run;
    if(!integer(start)||!integer(length)||!length||start+length>limit||count+length>limit)
      throw Error('Invalid application source map');
    count+=length;
    end=Math.max(end,start+length);
  }
  const rows=new Array(count),used=new Uint8Array(end);
  let index=0;
  for(const [start,length] of state.sources) {
    for(let seq=start;seq<start+length;seq++) {
      if(used[seq])throw Error('Overlapping application source map');
      used[seq]=1;
      rows[index++]={seq};
    }
  }
  for(const operation of state.operations) {
    const source=operation?.source;
    if(source===undefined)continue;
    if(!integer(source)||!rows[source]||rows[source].operation!==undefined||
      typeof operation.id!=='string'||!operation.id||operation.id.length>256)
      throw Error('Invalid native mutation correlation');
    rows[source].operation=operation.id;
  }
  state.sources=rows;
  return end;
}

/** Parse the durable boundary once, before native history is captured. */
export function readJournalDocument(document) {
  if(document===undefined)return;
  if(typeof document!=='string'||Buffer.byteLength(document)>maximumJournalBytes)throw Error('Invalid application journal size');
  return decodeJournal(JSON.parse(document));
}
function decodeJournal(state) {
  if(!shape(state,['version','header','inheritedEventCount','events','sources','sourceDigest','operations','catalogTitle','eventCount','ownedEventCount','inboxSlotFrom','nativePreset'])
    ||state.nativePreset!==undefined&&(state.version<7||!presetId(state.nativePreset))
    ||![1,2,3,4,5,6,7,8].includes(state.version)||!Array.isArray(state.events)||!Array.isArray(state.sources)||!Array.isArray(state.operations))
    throw Error('Invalid application journal');
  const prefixDigest=state.version>=7;
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
  let count=state.version===8?expandSourceRuns(state,limit):0;
  if(!integer(state.inboxSlotFrom)||state.inboxSlotFrom>state.sources.length)throw Error('Invalid saved inbox source boundary');
  const inboxEvents=new Map();
  for(const event of state.events){
    if(derivesCount){
      if(!integer(event?.seq)||event.seq>=limit)throw Error('Invalid application journal event position');
      count=Math.max(count,event.seq+1);
    }
    if(state.operations.length&&event?.type==='agent/inbox/spliced')inboxEvents.set(event.seq,event);
  }
  if(state.version<8) {
    const used=new Set();
    for(const row of state.sources) {
      if(!shape(row,prefixDigest?['seq','operation']:['hash','seq','operation'])||!integer(row.seq)||row.seq>=limit||used.has(row.seq)
        ||!prefixDigest&&!isDigest(row.hash)
        ||row.operation!==undefined&&(typeof row.operation!=='string'||!row.operation||row.operation.length>256))
        throw Error('Invalid application source map');
      used.add(row.seq);
      if(derivesCount)count=Math.max(count,row.seq+1);
    }
  }
  if(derivesCount)state.eventCount=count;
  if(!integer(state.inheritedEventCount)||state.inheritedEventCount>state.eventCount||state.events.length>state.eventCount
    ||state.sources.length>state.eventCount||state.operations.length>state.eventCount)throw Error('Invalid application journal');
  state.operations=state.operations.map(operation=>restoreInputOperation(operation,inboxEvents.get(operation?.seq),state.version));
  return state;
}

/** Finish a collected reader's contiguous native suffix without retaining its Session. */
export function checkpointNativeTail(document,tail) {
  if(typeof document!=='string'||Buffer.byteLength(document)>maximumJournalBytes)throw Error('Invalid application journal size');
  const raw=JSON.parse(document),state=decodeJournal({...raw});
  if(state.version!==8||state.sourceDigest!==tail.base)throw Error('Application journal checkpoint changed');
  const length=tail.nativeSeq-state.sources.length;
  if(length<=0||state.eventCount+length!==tail.seq)throw Error('Invalid application journal tail');
  const last=raw.sources.at(-1);
  if(last&&last[0]+last[1]===state.eventCount)last[1]+=length;
  else raw.sources.push([state.eventCount,length]);
  const {header,ownedEventCount,catalogTitle,...body}=raw;
  return packDocument({header,ownedEventCount,catalogTitle},{...body,sourceDigest:tail.digest});
}

/** Rebuild a candidate log; the owner's first merge verifies its source hashes and correlations. */
export function restoreJournalEvents(state,native=[]) {
  if(state.version===1)return state.events;
  if(native.length<state.sources.length)throw Error('Native event prefix moved backwards');
  const events=new Array(state.eventCount),at=new Map(state.operations.map(row=>[row.seq,row]));
  let previous=-1;
  for(let event of state.events) {
    if(!integer(event?.seq)||event.seq>=events.length||event.seq<=previous)throw Error('Invalid local application event position');
    if(event.type==='goal/change'&&event.data===null) {
      const operation=at.get(event.seq),source=state.sources[operation?.source],observed=native[operation?.source];
      if(!source||source.seq!==event.seq||source.operation!==operation.id||observed?.type!==event.type)
        throw Error('Retained Goal has no correlated native change');
      event={...event,data:observed.data};
    }
    if(state.version>=5&&event.type==='agent/inbox/spliced'&&event.data?.inserted===null) {
      const operation=at.get(event.seq),source=state.sources[operation?.source],observed=native[operation?.source];
      if(!source||source.seq!==event.seq||source.operation!==operation.id||
        observed?.type!==event.type||observed.data.inserted?.length!==1||
        !['submission','context-input','observed-input'].includes(operation.invocation?.kind))
        throw Error('Retained input body has no correlated native acceptance');
      event={...event,data:{...event.data,inserted:observed.data.inserted}};
      restoreInputOperation(operation,event,state.version);
    }
    previous=event.seq;events[event.seq]=event;
  }
  for(const operation of state.operations)if(!integer(operation.seq)||!events[operation.seq])throw Error('Application mutation record lost its accepted event');
  const splices=[];
  for(const [index,source] of state.sources.entries()) {
    const event=native[index];
    if(event?.seq!==index)throw Error('Native event positions are not dense');
    if(inboxTransitions.has(event))splices.push(event);
    if(events[source.seq]) {
      if(at.get(source.seq)?.id!==source.operation||source.operation===undefined)
        throw Error('Native-only event body persisted in application journal');
    } else events[source.seq]=remap(event,source.seq,seq=>state.sources[seq]);
  }
  for(let seq=0;seq<events.length;seq++)if(!events[seq])throw Error('Application journal contains unowned event positions');
  if(!splices.length)return events;
  const operations=new JournalOperations();
  for(const row of state.operations)operations.set(row.id,row);
  const view={session:{seq:events.length,eventAt:seq=>events[seq]},nativeSeq:state.sources.length,revision:0,
    sourceAt:seq=>state.sources[seq],nativeInputOperation:id=>operations.nativeInput(id),operation:id=>operations.get(id),operationAt:seq=>at.get(seq)};
  const {projections}=inboxObservationProjection(view,splices,inboxReader(view,seq=>native[seq]));
  for(const [index,data] of projections) {
    const seq=state.sources[index].seq;
    // An application event at a native position already matched its operation above.
    if(!at.has(seq))events[seq]={...events[seq],data};
  }
  return events;
}

export function encodeJournalDocument(session,events,sources,sourceDigest,operations,inboxSlotFrom,nativePreset) {
  const event=session.lastEvent('session/title');
  const prefix={header:session.header,ownedEventCount:events.length,...(event?{catalogTitle:{value:event.data.title,seq:event.seq}}:{})};
  const runs=[];
  let run;
  for(const {seq} of sources) {
    if(run&&run[0]+run[1]===seq)run[1]++;
    else {run=[seq,1];runs.push(run);}
  }
  return packDocument(prefix,{version:8,inheritedEventCount:session.inheritedEventCount,inboxSlotFrom,nativePreset,events,sources:runs,sourceDigest,operations});
}
function packDocument(prefix,body) {
  const value=JSON.stringify(prefix).slice(0,-1)+',\n'+JSON.stringify(body).slice(1);
  if(Buffer.byteLength(value)>maximumJournalBytes)throw Error('Application journal document capacity');
  return value;
}
