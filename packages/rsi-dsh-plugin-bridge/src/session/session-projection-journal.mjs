import {isDeepStrictEqual} from 'node:util';
import {SessionFacade,digest,isJournalEvent} from './session.mjs';
import {isForkAnnotation,isInheritedMarker} from './fork-annotations.mjs';
import {remap,restoreJournalEvents,encodeJournalDocument} from './journal-document.mjs';

const integer=value=>Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const shape=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const body=({seq,time,...value})=>value;

/** One synchronous application event owner; native commands remain outside this log. */
export class SessionProjectionJournal {
  #ctx;#api;#session;#sources=[];#operations=new Map();#operationIds=[];#publishing=false;
  #revision=0;#saved=-1;#tail=Promise.resolve();#queued;#annotationCount=0;#rewrite=false;
  #save;#notify;#report;#inboxSlotFrom=0;#owned=[];
  constructor(ctx,api,seed,{save,notify=()=>{},report=()=>{},restore,native,transitions}={}) {
    this.#ctx=ctx;this.#api=api;this.#save=save;this.#notify=notify;this.#report=report;
    if(restore!==undefined) {
      if(!isDeepStrictEqual(restore.header,seed.header))throw Error('Invalid application journal identity');
      seed={header:restore.header,events:restoreJournalEvents(restore,native,transitions),inheritedEventCount:restore.inheritedEventCount};
      this.#session=this.#create(seed);this.#inboxSlotFrom=restore.inboxSlotFrom;
      this.#restore(restore.sources,restore.operations);
      this.#saved=0;this.#rewrite=restore.version===1;
    } else {
      if(seed.events?.length)throw Error('Import native events through merge');
      this.#session=this.#create(seed);
    }
  }
  #create(seed) {return new SessionFacade(this.#ctx,this.#api,seed,false);}
  #snapshot(value) {
    const result=this.#api.snapshotJsonValue(value);
    if(result===undefined)throw Error('Application journal requires lossless JSON');
    return this.#api.deepFreeze(result);
  }
  #restore(sources,operations) {
    const used=new Set(sources.map(row=>row.seq));
    const positions=new Set();
    for(const operation of operations) {
      if(!shape(operation,['id','seq','invocation','receipt','source','failure'])||!identity(operation.id)
        ||this.#operations.has(operation.id)||!integer(operation.seq)||operation.seq>=this.seq
        ||operation.seq<this.#session.inheritedEventCount
        ||positions.has(operation.seq)||operation.receipt!==undefined&&operation.invocation===undefined
        ||operation.failure!==undefined&&(typeof operation.failure!=='string'||Buffer.byteLength(operation.failure)>4096)
        ||operation.source!==undefined&&(!integer(operation.source)||sources[operation.source]?.operation!==operation.id
          ||!isDeepStrictEqual(body(this.#session.eventAt(sources[operation.source].seq)),
            body(this.#session.eventAt(operation.seq)))))throw Error('Invalid application mutation record');
      positions.add(operation.seq);this.#operations.set(operation.id,this.#snapshot(operation));
      this.#operationIds[operation.seq]=operation.id;
    }
    for(const [index,row] of sources.entries()) {
      if(row.operation===undefined?positions.has(row.seq):this.#operations.get(row.operation)?.source!==index||
        positions.has(row.seq)&&this.#operations.get(row.operation).seq!==row.seq)
        throw Error('Application mutation correlation changed');
    }
    const cut=this.#session.inheritedEventCount;
    let annotationStart=cut;
    if(this.#session.header.isSeeded&&used.has(cut)&&isInheritedMarker(this.#session.eventAt(cut))) {
      while(annotationStart>0&&!used.has(annotationStart-1)&&isForkAnnotation(this.#session.eventAt(annotationStart-1).type))annotationStart--;
    }
    this.#annotationCount=cut-annotationStart;
    for(let seq=0;seq<this.seq;seq++) {
      if(!used.has(seq)&&!positions.has(seq)&&(seq<cut?seq<annotationStart:!isJournalEvent(this.#session.eventAt(seq).type)))
        throw Error('Application journal contains unowned event positions');
      if(!used.has(seq)||positions.has(seq))this.#owned.push(this.#session.eventAt(seq));
    }
    this.#sources=[...this.#snapshot(sources)];
  }
  get session(){return this.#session;}
  get seq(){return this.#session.seq;}
  get nativeSeq(){return this.#sources.length;}
  get inboxSlotFrom(){return this.#inboxSlotFrom;}
  get revision(){return this.#revision;}
  get hasLocalEvents(){return this.#operations.size>0||this.seq>this.nativeSeq;}
  sourceAt(seq){return this.#sources[seq];}
  operations(){return Object.freeze([...this.#operations.values()]);}
  *operationsBetween(after,through=this.seq) {
    if(!integer(after)||!integer(through)||after>through||through>this.seq)throw Error('Invalid application operation boundary');
    for(let seq=after;seq<through;seq++) {
      const id=this.#operationIds[seq];if(id!==undefined)yield this.#operations.get(id);
    }
  }
  operation(id){return this.#operations.get(id);}
  operationAt(seq){return this.#operations.get(this.#operationIds[seq]);}
  #entry(){if(this.#publishing)throw Error('Reentrant application journal mutation');}
  #publish(events) {
    this.#publishing=true;
    try {for(const event of events)try{this.#notify(this.#session,event);}catch(error){try{this.#report(error);}catch{}}}
    finally{this.#publishing=false;}
  }
  append(type,data,opts={}) {
    if(!isJournalEvent(type))throw Error('This Session event requires its owning native command');
    return this.#append(type,data,opts,Date.now());
  }
  accept(id,type,data,opts={},time=Date.now(),prepared) {
    if(!identity(id)||this.#operations.has(id))throw Error('Application mutation identity is already used or invalid');
    return this.#append(type,data,opts,time,id,prepared);
  }
  #append(type,data,opts,time,id,prepared) {
    this.#entry();
    const invocation=prepared===undefined?undefined:this.#snapshot(prepared);
    this.#session.begin();let event;
    try{event=this.#session.appendObserved(type,data,time,opts);}finally{this.#session.end();}
    if(id!==undefined){
      this.#operations.set(id,Object.freeze({id,seq:event.seq,...(invocation===undefined?{}:{invocation})}));
      this.#operationIds[event.seq]=id;
    }
    this.#owned.push(event);this.#revision++;
    this.#publish([event]);return event;
  }
  #assign(id,key,value) {
    this.#entry();const previous=this.#operations.get(id);
    if(!previous)throw Error('Unknown application mutation');
    const next=this.#snapshot(value);
    if(previous[key]!==undefined) {
      if(!isDeepStrictEqual(previous[key],next))throw Error('Application mutation '+key+' is immutable');
      return;
    }
    if(key==='receipt'&&previous.invocation===undefined)throw Error('Native receipt lacks its prepared invocation');
    this.#operations.set(id,Object.freeze({...previous,[key]:next}));this.#revision++;
  }
  prepare(id,invocation){this.#assign(id,'invocation',invocation);}
  complete(id,receipt){this.#assign(id,'receipt',receipt);}
  failed(id,message) {
    this.#entry();const operation=this.#operations.get(id);
    if(!operation||typeof message!=='string'||Buffer.byteLength(message)>4096)throw Error('Invalid application mutation failure');
    if(operation.failure===message)return;
    this.#operations.set(id,Object.freeze({...operation,failure:message}));this.#revision++;
  }
  merge(nativeEvents,correlations=new Map(),inheritedEventCount=0,projections=new Map(),annotations=[]) {
    return this.#merge(nativeEvents,correlations,inheritedEventCount,0,projections,annotations);
  }
  advance(after,nativeEvents,correlations=new Map(),projections=new Map()) {
    if(after!==this.#sources.length)throw Error('Native delta does not follow the retained source cursor');
    return this.#merge(nativeEvents,correlations,this.#session.inheritedEventCount-this.#annotationCount,after,projections,[]);
  }
  #merge(nativeEvents,correlations,inheritedEventCount,after,projections,annotations) {
    this.#entry();
    const input=this.#snapshot(nativeEvents);
    if(!Array.isArray(input)||after+input.length<this.#sources.length||!integer(inheritedEventCount)
      ||inheritedEventCount>after+input.length)throw Error('Native event prefix moved backwards');
    if(annotations.length&&(this.seq||after||!this.#session.header.isSeeded||!isInheritedMarker(input[inheritedEventCount])))
      throw Error('Fork annotations require a fresh inherited boundary');
    if(!input.length&&after===this.#sources.length) {
      if(this.#rewrite){this.#revision++;this.#rewrite=false;}
      return Object.freeze([]);
    }
    const start=this.seq,sourceStart=this.#sources.length;
    const sources=[],operations=new Map(),events=[];
    const sourceAt=seq=>seq<sourceStart?this.#sources[seq]:sources[seq-sourceStart];
    const eventAt=seq=>seq<start?this.#session.eventAt(seq):events[seq-start];
    const operationAt=id=>operations.get(id)??this.#operations.get(id);
    for(const [index,event] of input.entries()) {
      if(event.seq!==after+index)throw Error('Native event positions are not dense');
      if(event.seq===inheritedEventCount)for(const annotation of annotations) {
        if(!isForkAnnotation(annotation.type))throw Error('Unknown fork annotation');
        events.push({...annotation,seq:start+events.length});
      }
      const translated=projections.has(event.seq)?{...event,data:this.#snapshot(projections.get(event.seq))}:event;
      const existing=sourceAt(event.seq),correlation=correlations.get(event.seq);
      if(correlation!==undefined&&typeof correlation!=='string'&&
        (!shape(correlation,['id','reconcile'])||!identity(correlation.id)||correlation.reconcile!==true))
        throw Error('Invalid native mutation correlation');
      const operationId=typeof correlation==='string'?correlation:correlation?.id;
      const reconcile=correlation?.reconcile===true;
      if(existing) {
        if(existing.hash!==digest(event)||existing.operation!==operationId||
          operationId!==undefined&&(existing.seq!==operationAt(operationId)?.seq)!==reconcile)
          throw Error('Native event prefix changed');
        const expected=remap(translated,existing.seq,sourceAt),stored=eventAt(existing.seq);
        if(!isDeepStrictEqual(existing.operation===undefined?expected:body(expected),
          existing.operation===undefined?stored:body(stored)))throw Error('Stored application event disagrees with native history');
        continue;
      }
      const operation=operationId===undefined?undefined:operationAt(operationId);
      if(operationId!==undefined&&(!operation||operation.source!==undefined))throw Error('Native event has an unknown or repeated mutation correlation');
      const seq=operation&&!reconcile?operation.seq:start+events.length,projected=remap(translated,seq,sourceAt);
      if(operation) {
        if(!isDeepStrictEqual(body(projected),body(eventAt(operation.seq))))throw Error('Native event disagrees with its accepted application mutation');
        operations.set(operationId,Object.freeze({...operation,source:event.seq}));
      }
      if(!operation||reconcile)events.push(projected);
      sources.push(Object.freeze({hash:digest(event),seq,...(operation?{operation:operationId}:{})}));
    }
    const count=this.#annotationCount+annotations.length;
    const inherited=(inheritedEventCount?sourceAt(inheritedEventCount-1).seq+1:0)+count;
    if(count&&!after&&(sourceAt(inheritedEventCount)?.seq!==inherited||!isInheritedMarker(input[inheritedEventCount])))
      throw Error('Fork annotations moved outside their inherited boundary');
    if(this.#sources.length&&inherited!==this.#session.inheritedEventCount)
      throw Error('Native inherited prefix changed');
    if(!sourceStart&&inherited&&start)throw Error('Local application mutation cannot enter an inherited prefix');
    if(events.length) {
      const candidate=this.#session.branch();candidate.inheritedEventCount=inherited;
      candidate.begin();
      try {for(const event of events) {
        const {type,data,time,seq,...opts}=event;
        candidate.appendObserved(type,data,time,opts);
      }}finally{candidate.end();}
      this.#session.adoptBranch(candidate);
    }
    for(let index=0;index<annotations.length;index++) {
      const seq=inherited-annotations.length+index;
      this.#owned.push(this.#session.eventAt(seq));
    }
    this.#annotationCount=count;
    for(const source of sources)this.#sources.push(source);
    for(const [id,operation] of operations)this.#operations.set(id,operation);
    if(sources.length||this.#rewrite)this.#revision++;
    this.#rewrite=false;
    const appended=this.#session.snapshotEvents(start);this.#publish(appended);return Object.freeze(appended);
  }
  encode() {
    return encodeJournalDocument(this.#session,this.#owned,this.#sources,this.operations(),this.#inboxSlotFrom);
  }

  flush() {
    if(this.#saved===this.#revision)return Promise.resolve();
    if(this.#queued?.revision===this.#revision)return this.#queued.promise;
    if(!this.#save)return Promise.reject(Error('Application journal has no persistence writer'));
    const revision=this.#revision,value=this.encode();
    const promise=this.#tail.catch(()=>{}).then(async()=>{await this.#save(value);this.#saved=revision;});
    this.#tail=promise;this.#queued={revision,promise};
    void promise.finally(()=>{if(this.#queued?.promise===promise)this.#queued=undefined;}).catch(()=>{});
    return promise;
  }
}
