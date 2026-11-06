import {inboxObservationProjection} from './inbox/inbox-observations.mjs';
import {restoreInputOperation} from './inbox/input-invocation.mjs';

const maximumBytes=128*1024*1024;
const integer=value=>Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const shape=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));

/** Parse the durable boundary once, before native history is captured. */
export function readJournalDocument(document) {
  if(document===undefined)return;
  if(typeof document!=='string'||Buffer.byteLength(document)>maximumBytes)throw Error('Invalid application journal size');
  const state=JSON.parse(document);
  if(!shape(state,['version','header','inheritedEventCount','events','sources','operations','catalogTitle','eventCount','inboxSlotFrom'])
    ||![1,2,3].includes(state.version)||!Array.isArray(state.events)||!Array.isArray(state.sources)||!Array.isArray(state.operations))
    throw Error('Invalid application journal');
  if(state.version===1) {
    if(state.eventCount===undefined)state.eventCount=state.events.length;
    if(state.inboxSlotFrom===undefined)state.inboxSlotFrom=state.sources.length;
    if(state.eventCount!==state.events.length)throw Error('Invalid application journal event count');
  }
  if(!integer(state.eventCount)||state.eventCount>100_000||!integer(state.inheritedEventCount)
    ||state.inheritedEventCount>state.eventCount||state.events.length>state.eventCount
    ||state.sources.length>state.eventCount||state.operations.length>state.eventCount)
    throw Error('Invalid application journal');
  if(!integer(state.inboxSlotFrom)||state.inboxSlotFrom>state.sources.length)throw Error('Invalid saved inbox source boundary');
  const used=new Set();
  for(const row of state.sources) {
    if(!shape(row,['hash','seq','operation'])||!integer(row.seq)||row.seq>=state.eventCount||used.has(row.seq)
      ||typeof row.hash!=='string'||!/^[a-f0-9]{64}$/.test(row.hash)
      ||row.operation!==undefined&&(typeof row.operation!=='string'||!row.operation||row.operation.length>256))
      throw Error('Invalid application source map');
    used.add(row.seq);
  }
  const events=new Map(state.events.map(event=>[event?.seq,event]));
  state.operations=state.operations.map(operation=>restoreInputOperation(operation,events.get(operation?.seq),state.version));
  return state;
}

/** Translate source-log references, never application-local references. */
export function remap(input,seq,sourceAt) {
  const event={...input,seq};
  const reference=value=>{
    if(!integer(value)||value>=input.seq||!sourceAt(value))throw Error('Native event reference is outside its observed prefix');
    return sourceAt(value).seq;
  };
  if(event.surfaceOp&&event.surfaceOp!=='append')event.surfaceOp={
    ...event.surfaceOp,startSeq:reference(event.surfaceOp.startSeq),endSeq:reference(event.surfaceOp.endSeq),
  };
  if(event.sourceEventSeqs)event.sourceEventSeqs=event.sourceEventSeqs.map(reference);
  if(event.type==='developer/message'&&event.data.headerSeq!==undefined)
    event.data={...event.data,headerSeq:reference(event.data.headerSeq)};
  if(event.type==='command/done'&&event.data.sourceEventSeq!==undefined)
    event.data={...event.data,sourceEventSeq:reference(event.data.sourceEventSeq)};
  return event;
}

/** Rebuild a candidate log; the owner's first merge verifies its source hashes and correlations. */
export function restoreJournalEvents(state,native=[],transitions=new Map()) {
  if(state.version===1)return state.events;
  if(native.length<state.sources.length)throw Error('Native event prefix moved backwards');
  const events=new Array(state.eventCount),owned=new Set();
  const operations=new Map(state.operations.map(row=>[row.id,row])),at=new Map(state.operations.map(row=>[row.seq,row]));
  let previous=-1;
  for(const event of state.events) {
    if(!integer(event?.seq)||event.seq>=events.length||event.seq<=previous)throw Error('Invalid local application event position');
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

export function encodeJournalDocument(session,events,sources,operations,inboxSlotFrom) {
  const event=session.lastEvent('session/title');
  const prefix=JSON.stringify({header:session.header,eventCount:session.seq,...(event?{catalogTitle:{value:event.data.title,seq:event.seq}}:{})});
  const document=JSON.stringify({version:3,inheritedEventCount:session.inheritedEventCount,inboxSlotFrom,events,sources,operations});
  const value=prefix.slice(0,-1)+',\n'+document.slice(1);
  if(Buffer.byteLength(value)>maximumBytes)throw Error('Application journal document capacity');
  return value;
}
