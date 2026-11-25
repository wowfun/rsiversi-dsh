import {isDeepStrictEqual} from 'node:util';
import {SessionFacade,digest,isChildSetupEvent,isJournalEvent,remap} from './session.mjs';
import {isForkAnnotation,isInheritedMarker} from './fork-annotations.mjs';
import {restoreJournalEvents,encodeJournalDocument,createSourceDigest} from './journal-document.mjs';

const integer=value=>Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const identity=value=>typeof value==='string'&&value.length>0&&value.length<=256;
const shape=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const body=({seq,time,...value})=>value;

/** One synchronous application event owner; native commands remain outside this log. */
export class SessionProjectionJournal {
  #ctx;#api;#session;#sources=[];#operations=new Map();#operationIds=[];#publishing=false;
  #modelSelectionId;#revision=0;#saved=-1;#writing;#nextWrite;#annotationCount=0;#rewrite=false;
  #save;#notify;#report;#inboxSlotFrom=0;#owned=[];#sharedNative;
  #sourceDigest=createSourceDigest();#nativePreset;
  #liveTimer;#liveWrite=false;#liveRevision=-1;
  constructor(ctx,api,seed,{save,notify=()=>{},report=()=>{},restore,adoptRestore=false,native,transitions,nativeEventState,nativePreset}={}) {
    this.#ctx=ctx;this.#api=api;this.#save=save;this.#notify=notify;this.#report=report;
    this.#sharedNative=nativeEventState==='shared-frozen';
    this.#nativePreset=nativePreset;
    if(restore!==undefined) {
      if(!isDeepStrictEqual(restore.header,seed.header))throw Error('Invalid application journal identity');
      if(adoptRestore) {
        if(!api.isJsonValue(restore))throw Error('Application journal requires lossless JSON');
        api.deepFreeze(restore);
      } else restore=this.#snapshot(restore);
      const sources=restore.version>=7?restore.sources.map((source,index)=>{
        const event=native?.[index];
        if(event?.seq!==index)throw Error('Native event prefix moved backwards');
        return Object.freeze({...source,hash:digest(event)});
      }):restore.sources.slice();
      for(const source of sources)this.#sourceDigest.update(source.hash);
      if(restore.version>=7&&this.#sourceDigest.copy().digest('hex')!==restore.sourceDigest)
        throw Error('Native event prefix changed');
      seed={header:restore.header,events:this.#nativeInput(restoreJournalEvents(restore,native,transitions)),inheritedEventCount:restore.inheritedEventCount};
      this.#session=this.#create(seed);this.#inboxSlotFrom=restore.inboxSlotFrom;
      this.#restore(sources,restore.operations);
      this.#saved=0;this.#rewrite=restore.version<8;
    } else {
      if(seed.events?.length)throw Error('Import native events through merge');
      this.#session=this.#create(seed);
    }
  }
  #create(seed) {return new SessionFacade(this.#ctx,this.#api,{...seed,eventState:'shared-frozen'},false);}
  #snapshot(value) {
    const result=this.#api.snapshotJsonValue(value);
    if(result===undefined)throw Error('Application journal requires lossless JSON');
    return this.#api.deepFreeze(result);
  }
  #nativeInput(value) {return this.#sharedNative?value:this.#snapshot(value);}
  #restore(sources,operations) {
    for(const operation of operations) {
      if(!shape(operation,['id','seq','invocation','receipt','source','failure'])||!identity(operation.id)
        ||this.#operations.has(operation.id)||!integer(operation.seq)||operation.seq>=this.seq
        ||operation.seq<this.#session.inheritedEventCount
        ||this.#operationIds[operation.seq]!==undefined||operation.receipt!==undefined&&operation.invocation===undefined
        ||operation.failure!==undefined&&(typeof operation.failure!=='string'||Buffer.byteLength(operation.failure)>4096)
        ||operation.source!==undefined&&(!integer(operation.source)||sources[operation.source]?.operation!==operation.id
          ||!isDeepStrictEqual(body(this.#session.eventAt(sources[operation.source].seq)),
            body(this.#session.eventAt(operation.seq)))))throw Error('Invalid application mutation record');
      this.#addOperation(operation,this.#session.eventAt(operation.seq).type);
    }
    const nativeAt=new Uint8Array(sources.length?this.seq:0);
    for(const [index,row] of sources.entries()) {
      const accepted=this.#operationIds[row.seq];
      if(row.operation===undefined?accepted!==undefined:this.#operations.get(row.operation)?.source!==index||
        accepted!==undefined&&accepted!==row.operation)
        throw Error('Application mutation correlation changed');
      nativeAt[row.seq]=1;
    }
    const cut=this.#session.inheritedEventCount;
    let annotationStart=cut;
    if(this.#session.header.isSeeded&&nativeAt[cut]&&isInheritedMarker(this.#session.eventAt(cut))) {
      while(annotationStart>0&&!nativeAt[annotationStart-1]&&isForkAnnotation(this.#session.eventAt(annotationStart-1).type))annotationStart--;
    }
    this.#annotationCount=cut-annotationStart;
    for(let seq=0;seq<this.seq;seq++) {
      const native=nativeAt[seq],operation=this.#operationIds[seq]!==undefined;
      if(native&&!operation)continue;
      const event=this.#session.eventAt(seq);
      if(!native&&!operation&&(seq<cut?seq<annotationStart:!this.#isLocalEvent(event)&&
          !(isChildSetupEvent(event.type)&&this.#session.header.origin==='subagent')))
        throw Error('Application journal contains unowned event positions');
      this.#owned.push(event);
    }
    this.#sources=sources;
  }
  get session(){return this.#session;}
  get seq(){return this.#session.seq;}
  get nativeSeq(){return this.#sources.length;}
  get ownedEventCount(){return this.#owned.length;}
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
  latestModelSelection(){return this.#operations.get(this.#modelSelectionId);}
  #addOperation(operation,type) {
    this.#operations.set(operation.id,operation);
    this.#operationIds[operation.seq]=operation.id;
    if(type==='model/selection')this.#modelSelectionId=operation.id;
  }
  #entry(){if(this.#publishing)throw Error('Reentrant application journal mutation');}
  #isLocalEvent(event){return isJournalEvent(event?.type)||!!this.#api.pluginRecordOf?.(event);}
  #publish(events) {
    this.#publishing=true;
    try {for(const event of events)try{this.#notify(this.#session,event);}catch(error){try{this.#report(error);}catch{}}}
    finally{this.#publishing=false;}
  }
  append(type,data,opts={},delegating=false) {
    if(!isJournalEvent(type)&&!(delegating&&this.#session.header.origin==='subagent'&&isChildSetupEvent(type)))
      throw Error('This Session event requires its owning native command');
    return this.#append(type,data,opts,Date.now());
  }
  appendPluginRecord(type,data) {
    if(!this.#api.pluginRecordOf({type,ignorable:true}))throw Error('Invalid plugin record type');
    return this.#append(type,data,{ignorable:true},Date.now());
  }
  /** Persistence callers supply exact coordinates and times, not new commands. */
  appendStored(input) {
    this.#entry();
    const events=this.#snapshot(input);
    if(!Array.isArray(events))throw TypeError('Expected an event batch');
    for(const [index,event] of events.entries()) {
      if(!this.#isLocalEvent(event))throw Error('This Session event requires its owning native command');
      if(event.seq!==this.seq+index)throw Error('Stored event batch does not continue the Session');
    }
    if(!events.length)return;
    this.#session.adoptBatch(events);
    for(const event of events)this.#owned.push(event);
    this.#revision++;this.#publish(events);
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
      this.#addOperation(Object.freeze({id,seq:event.seq,...(invocation===undefined?{}:{invocation})}),type);
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
  merge(nativeEvents,correlations=new Map(),inheritedEventCount=0,projections=new Map(),annotations=[],preceding=[]) {
    return this.#merge(nativeEvents,correlations,inheritedEventCount,0,projections,annotations,preceding);
  }
  advance(after,nativeEvents,correlations=new Map(),projections=new Map(),preceding=[]) {
    if(after!==this.#sources.length)throw Error('Native delta does not follow the retained source cursor');
    return this.#merge(nativeEvents,correlations,this.#session.inheritedEventCount-this.#annotationCount,after,projections,[],preceding);
  }
  #merge(nativeEvents,correlations,inheritedEventCount,after,projections,annotations,preceding) {
    this.#entry();
    const input=this.#nativeInput(nativeEvents);
    if(!Array.isArray(input)||after+input.length<this.#sources.length||!integer(inheritedEventCount)
      ||inheritedEventCount>after+input.length)throw Error('Native event prefix moved backwards');
    if(annotations.length&&(this.seq||after||!this.#session.header.isSeeded||!isInheritedMarker(input[inheritedEventCount])))
      throw Error('Fork annotations require a fresh inherited boundary');
    if(preceding.some(event=>!isJournalEvent(event?.type)))throw Error('Preceding events must be log-only');
    if(!input.length&&!preceding.length&&after===this.#sources.length) {
      if(this.#rewrite){this.#revision++;this.#rewrite=false;}
      return Object.freeze([]);
    }
    const start=this.seq,sourceStart=this.#sources.length;
    const sources=[],operations=new Map(),events=preceding.map((event,index)=>this.#snapshot({...event,seq:start+index}));
    const sourceAt=seq=>seq<sourceStart?this.#sources[seq]:sources[seq-sourceStart];
    const eventAt=seq=>seq<start?this.#session.eventAt(seq):events[seq-start];
    const operationAt=id=>operations.get(id)??this.#operations.get(id);
    for(const [index,event] of input.entries()) {
      if(event.seq!==after+index)throw Error('Native event positions are not dense');
      if(event.seq===inheritedEventCount)for(const annotation of annotations) {
        if(!isForkAnnotation(annotation.type))throw Error('Unknown fork annotation');
        events.push(this.#snapshot({...annotation,seq:start+events.length}));
      }
      const translated=projections.has(event.seq)?{...event,data:this.#nativeInput(projections.get(event.seq))}:event;
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
    if(!sourceStart&&inherited&&(start||preceding.length))throw Error('Local application mutation cannot enter an inherited prefix');
    if(count&&!after&&(sourceAt(inheritedEventCount)?.seq!==inherited||!isInheritedMarker(input[inheritedEventCount])))
      throw Error('Fork annotations moved outside their inherited boundary');
    if(this.#sources.length&&inherited!==this.#session.inheritedEventCount)
      throw Error('Native inherited prefix changed');
    if(events.length) {
      this.#session.adoptBatch(events);
      this.#session.inheritedEventCount=inherited;
    }
    for(let index=0;index<preceding.length;index++)this.#owned.push(this.#session.eventAt(start+index));
    for(let index=0;index<annotations.length;index++) {
      const seq=inherited-annotations.length+index;
      this.#owned.push(this.#session.eventAt(seq));
    }
    this.#annotationCount=count;
    for(const source of sources){this.#sources.push(source);this.#sourceDigest.update(source.hash);}
    for(const [id,operation] of operations)this.#operations.set(id,operation);
    if(sources.length||preceding.length||this.#rewrite)this.#revision++;
    this.#rewrite=false;
    const appended=this.#session.snapshotEvents(start);this.#publish(appended);return Object.freeze(appended);
  }
  encode() {
    let selected;
    const events=this.#owned.map(event=>{
      if(event.type==='agent-preset/selected')selected=event.data.agentPreset;
      const operation=this.operationAt(event.seq);
      if(event.type==='goal/change'&&operation?.source!==undefined&&this.#sources[operation.source].seq===event.seq)
        return {...event,data:null};
      if(event.type==='agent/inbox/spliced'&&event.data.inserted.length===1&&
        operation?.source!==undefined&&this.#sources[operation.source].seq===event.seq)
        return {...event,data:{...event.data,inserted:null}};
      return event;
    });
    const native=selected===undefined?undefined:this.#nativePreset?.();
    return encodeJournalDocument(this.#session,events,this.#sources,this.#sourceDigest.copy().digest('hex'),this.operations(),this.#inboxSlotFrom,
      native===selected?undefined:native);
  }

  scheduleFlush() {
    this.#liveRevision=this.#revision;
    if(this.#liveTimer||this.#liveWrite)return;
    this.#liveTimer=setTimeout(async()=>{
      this.#liveTimer=undefined;
      this.#liveWrite=true;
      try{
        while(this.#saved<this.#liveRevision)await this.flush();
      }catch(error){this.#report(error);}
      finally{this.#liveWrite=false;}
    },200);
  }
  flush({observed=false}={}) {
    if(observed&&this.#revision===this.#liveRevision)return Promise.resolve();
    clearTimeout(this.#liveTimer);this.#liveTimer=undefined;
    if(this.#saved===this.#revision)return Promise.resolve();
    if(this.#writing){
      if(this.#writing.revision===this.#revision)return this.#writing.promise;
      // Capture the next cumulative snapshot only when the writer becomes available.
      return this.#nextWrite??=this.#writing.promise.catch(()=>{}).then(()=>{
        this.#nextWrite=undefined;
        return this.flush();
      });
    }
    if(!this.#save)return Promise.reject(Error('Application journal has no persistence writer'));
    const revision=this.#revision,value=this.encode();
    const promise=Promise.resolve().then(async()=>{
      try{await this.#save(value);this.#saved=revision;}
      finally{this.#writing=undefined;}
    });
    this.#writing={revision,promise};
    return promise;
  }
}
