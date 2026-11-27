import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {assertForkAnnotation, isForkAnnotation} from './fork-annotations.mjs';
import {callSessionListeners,notifySession} from './observers.mjs';

// Event-local validation is reusable. Position and surface checks belong to each destination.
const admitted = new WeakMap();
const journalEvents = new Set(['session/title', 'session/title-llm-request', 'approval/asked', 'approval/decided',
  'command/run', 'command/done', 'hook/invoked', 'hook/result', 'job/registered', 'job/settled',
  'feedback/message-put', 'feedback/message-delete', 'feedback/record', 'agent-preset/selected',
  'action-cards/decision','workspace/changes','subagent/catalog','subagent/descriptor','session-log-deepseek/delivery-accepted']);
export const isJournalEvent = type => journalEvents.has(type);
export const isPermissionEvent = type => type==='sandbox/mode'||type==='permission/preset'||type==='approval/policy';
export const isChildSetupEvent = type => isPermissionEvent(type)||type==='workspace-root/change';
export function validatePermissionEvent(type,data,options={}) {
  if(options.surfaceOp!==undefined||options.sourceEventSeqs!==undefined)throw Error('Permission changes are log-only');
  if(type==='permission/preset'){
    if(!shape(data,['preset'])||!presetId(data.preset))throw Error('Invalid permission preset');
  }else {
    const [key,values]=type==='sandbox/mode'?['mode',['read-only','workspace-write','danger-full-access']]:['policy',['ask','never']];
    if(!shape(data,[key,'source'])||(data.source!==undefined&&data.source!=='delegation')||!values.includes(data[key]))
      throw Error('Invalid Session permission knob');
  }
}
const allowed = new Set([...journalEvents, 'todo/write', 'plan/mode', 'turn/start', 'turn/end', 'step/start', 'step/end',
  'request/header', 'user/message', 'developer/message', 'system/message', 'assistant/attempt', 'assistant/message',
  'tool/call', 'tool/result', 'session/end-seed', 'model/selection', 'goal/change', 'agent/inbox/spliced']);
const compactionEvents = new Set(['compaction/start','compaction/summary','compaction/end']);
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
export const presetId = value => typeof value === 'string' && value.length <= 256 && value.trim().length > 0;
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
function envelope(event, seq, api, validated) {
  if (event.seq !== seq || typeof event.type !== 'string' || !allowed.has(event.type) && !compactionEvents.has(event.type)
      && !isForkAnnotation(event.type) && !isChildSetupEvent(event.type)
      && (!api.pluginRecordOf?.(event) || event.surfaceOp !== undefined || event.sourceEventSeqs !== undefined))
    throw new Error('unsupported or invalid event envelope');
  if (validated) return;
  if (!shape(event, ['seq', 'time', 'type', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
      || !integer(event.seq) || !Number.isSafeInteger(event.time)
      || !Object.hasOwn(event, 'data')
      || (event.ignorable !== undefined && event.ignorable !== true)) throw new Error('unsupported or invalid event envelope');
  const data = event.data;
  if (isForkAnnotation(event.type)) assertForkAnnotation(event);
  if (event.surfaceOp !== undefined && (isJournalEvent(event.type)||compactionEvents.has(event.type)||isChildSetupEvent(event.type)||event.type==='goal/change'))
    throw new Error('Log-only Session event cannot edit the message surface');
  if(compactionEvents.has(event.type)) {
    if(!data || typeof data.compactionId!=='string' || !data.compactionId
        || data.sourceCommandId!==undefined && typeof data.sourceCommandId!=='string')throw Error('Invalid compaction identity');
    if(event.type==='compaction/summary'){
      const seqs=data.shadowedSeqs;
      if(!Array.isArray(seqs)||!seqs.length||seqs.some(value=>!integer(value)||value>=seq)
          ||seqs[0]!==data.shadowedRange?.start||seqs.at(-1)!==data.shadowedRange?.end
          ||!Array.isArray(data.summary)||!integer(data.shadowedTokenCount)
          ||typeof data.provider!=='string'||typeof data.model!=='string')throw Error('Invalid compaction summary');
    }else if(data.turn!==null&&!integer(data.turn))throw Error('Invalid compaction owner');
  } else if(event.type==='workspace/changes') {
    if(!shape(data,['turn'])||!Number.isSafeInteger(data.turn)||data.turn<1)throw Error('Invalid workspace change announcement');
  } else if(event.type==='workspace-root/change') {
    if(!shape(data,['cwd'])||typeof data.cwd!=='string'||!isAbsolute(data.cwd))throw Error('Invalid working directory');
  } else if(isPermissionEvent(event.type)) {
    validatePermissionEvent(event.type,data,event);
  } else if (event.type === 'todo/write') {
    if (!shape(data, ['todos']) || !Array.isArray(data.todos) || data.todos.length > 512
        || data.todos.some(todo => !shape(todo, ['content', 'status']) || typeof todo.content !== 'string'
          || !todo.content.trim() || Buffer.byteLength(todo.content) > 16 * 1024
          || !['pending', 'in_progress', 'completed'].includes(todo.status))) throw new Error('invalid Todo event');
  } else if (event.type === 'plan/mode') {
    if (!shape(data, ['active']) || typeof data.active !== 'boolean') throw new Error('invalid Plan event');
  } else if (event.type === 'agent-preset/selected') {
    if (!shape(data, ['agentPreset']) || !presetId(data.agentPreset))
      throw new Error('invalid Agent preset selection');
  } else if (event.type === 'session/title') {
    if(typeof data?.title!=='string'||!data.title.trim()||typeof data.source?.kind!=='string'||
      !Array.isArray(data.messageSeqs)||data.messageSeqs.some(value=>!integer(value)||value>=seq))throw Error('Invalid Session title');
  } else if (event.type === 'session-log-deepseek/delivery-accepted') {
    if (!data || typeof data.sessionId !== 'string' || !data.sessionId ||
        !integer(data.throughSeq) || data.throughSeq >= seq ||
        (data.sessionFormatVersion !== undefined && !integer(data.sessionFormatVersion))) {
      throw Error('Invalid Session log acceptance');
    }
  } else if (event.type === 'turn/start') {
    if (!shape(data, ['turn', 'rsi']) || !integer(data.turn)) throw new Error('invalid Turn start');
  } else if (event.type === 'step/start') {
    if (!shape(data, ['turn', 'step']) || !integer(data.turn) || !integer(data.step)) throw new Error('invalid Step start');
  } else if (event.type === 'command/run') {
    if (!shape(data, ['commandId', 'name', 'args', 'source']) || typeof data.commandId !== 'string' || !data.commandId
        || data.commandId.length > 256 || typeof data.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(data.name)
        || (data.args !== undefined && (typeof data.args !== 'string' || Buffer.byteLength(data.args) > 16 * 1024 + 1)) || !shape(data.source, ['kind'])
        || data.source.kind !== 'user') throw new Error('invalid command invocation');
  } else if (event.type === 'command/done') {
    if (!shape(data, ['commandId', 'kind', 'text', 'sourceEventSeq']) || typeof data.commandId !== 'string' || !data.commandId || data.commandId.length > 256
        || !['success', 'error'].includes(data.kind) || (data.text !== undefined && typeof data.text !== 'string')
        || (data.sourceEventSeq !== undefined && (data.kind !== 'success' || !integer(data.sourceEventSeq) || data.sourceEventSeq >= seq))) throw new Error('invalid command settlement');
  }
  if (['turn/start', 'turn/end'].includes(event.type) && data.rsi !== undefined) {
    if (!shape(data.rsi, ['session', 'fact', 'turn']) || !integer(data.rsi.fact) || data.rsi.fact === 0
      || ![data.rsi.session, data.rsi.turn].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)) throw new Error('invalid canonical Turn provenance');
  }
}
export function validateHeader(header) {
  if (!shape(header, ['version', 'id', 'createdAt', 'cwd', 'isSeeded', 'origin', 'parentSession', 'delegationDepth', 'agentPreset'])
      || header.version !== 4 || typeof header.id !== 'string' || !header.id || header.id.length > 256
      || !integer(header.createdAt) || typeof header.isSeeded !== 'boolean'
      || (header.cwd !== undefined && (typeof header.cwd !== 'string' || !isAbsolute(header.cwd)))
      || (header.origin !== undefined && header.origin !== 'subagent')
      || (header.parentSession !== undefined && typeof header.parentSession !== 'string')
      || (header.agentPreset !== undefined && !presetId(header.agentPreset))
      || (header.delegationDepth !== undefined && !integer(header.delegationDepth))) throw new Error('invalid Session header');
  return Object.freeze(structuredClone(header));
}
const encodedDigest = encoded => createHash('sha256').update(encoded).digest('hex');
/** Byte evidence follows the already admitted immutable event identity. */
export function encodedEventBytes(event) {
  return admitted.get(event)?.bytes ?? Buffer.byteLength(JSON.stringify(event));
}
export function digest(value) {
  const known=admitted.get(value);
  if(known?.hash!==undefined)return known.hash;
  const hash=encodedDigest(JSON.stringify(value));
  if(known)known.hash=hash;
  return hash;
}

/** Summary coordinates are in surface order; a replacement can place a newer seq before an older one. */
export function remapCompactionSummary(data,reference) {
  const shadowedSeqs=data.shadowedSeqs.map(reference);
  const start=reference(data.shadowedRange.start),end=reference(data.shadowedRange.end);
  if(start===data.shadowedRange.start && end===data.shadowedRange.end &&
      shadowedSeqs.every((value,index)=>value===data.shadowedSeqs[index]))return data;
  return {...data,shadowedSeqs,shadowedRange:{start,end}};
}

/** Internal transfer only: frozen children have already crossed the deep-freeze boundary. */
function freezeTransferred(value) {
  const pending=[value];
  while(pending.length) {
    const node=pending.pop();
    if(node===null||typeof node!=='object'||Object.isFrozen(node))continue;
    Object.freeze(node);
    for(const key of Object.keys(node))pending.push(node[key]);
  }
}

/** Remap only local coordinates; admitted immutable bodies keep their exact size evidence. */
export function remap(input,seq,sourceAt) {
  let event=input,bytes=admitted.get(input)?.bytes;
  const coordinate=(before,after)=>{
    if(bytes!==undefined)bytes=integer(after)?bytes+String(after).length-String(before).length:undefined;
    return after;
  };
  const set=(key,value)=>{
    if(value===input[key])return;
    if(event===input)event={...input};
    event[key]=value;
  };
  set('seq',coordinate(input.seq,seq));
  const reference=value=>{
    const target=integer(value)&&value<input.seq?sourceAt(value):undefined;
    if(!target)throw Error('Native event reference is outside its observed prefix');
    return coordinate(value,target.seq);
  };
  if(input.surfaceOp&&input.surfaceOp!=='append'){
    const startSeq=reference(input.surfaceOp.startSeq),endSeq=reference(input.surfaceOp.endSeq);
    if(startSeq!==input.surfaceOp.startSeq||endSeq!==input.surfaceOp.endSeq)
      set('surfaceOp',{...input.surfaceOp,startSeq,endSeq});
  }
  if(input.sourceEventSeqs){
    const references=input.sourceEventSeqs.map(reference);
    if(references.some((value,index)=>value!==input.sourceEventSeqs[index]))set('sourceEventSeqs',references);
  }
  if(input.type==='developer/message'&&input.data.headerSeq!==undefined){
    const headerSeq=reference(input.data.headerSeq);
    if(headerSeq!==input.data.headerSeq)set('data',{...input.data,headerSeq});
  }
  if(input.type==='command/done'&&input.data.sourceEventSeq!==undefined){
    const sourceEventSeq=reference(input.data.sourceEventSeq);
    if(sourceEventSeq!==input.data.sourceEventSeq)set('data',{...input.data,sourceEventSeq});
  }
  if(input.type==='compaction/summary')set('data',remapCompactionSummary(input.data,reference));
  if(event!==input&&bytes!==undefined){
    freezeTransferred(event);
    admitted.set(event,{bytes});
  }
  return event;
}

/** No upstream constructor: it appends seed/resume markers before attachment. */
export class SessionFacade {
  #events = []; #ctx; #api; #surface; #active = false; #bytes = 0; #retired = false; #announced = false;
  #branch; #base = 0; #requestHeader; #titleEvent; #journalSource;
  #eventsSnapshot; #derived; #publishing=false;
  constructor(ctx, api, { header, events = [], inheritedEventCount = 0, eventState, journalSource = false }, announce = true) {
    this.header = validateHeader(header); this.id = header.id;
    if (!integer(inheritedEventCount) || inheritedEventCount > events.length) throw new Error('invalid inherited prefix');
    this.inheritedEventCount = inheritedEventCount;
    this.#ctx = ctx; this.#api = api; this.#journalSource = journalSource;
    for (const event of events) this.#admit(event, false, eventState === 'shared-frozen' || admitted.has(event));
    this.firstLiveSeq = this.seq;
    if (announce) this.attach();
  }
  attach() {
    if(this.#announced||this.#retired)return;
    this.#announced=true;this.#publishing=true;
    try{notifySession(this.#ctx,'session/created',this);}
    catch(error){this.retire();throw error;}
    finally{this.#publishing=false;}
  }
  get seq() { return this.#base + this.#events.length; }
  get encodedBytes() { return this.#bytes; }
  #materializePrefix() {
    if (!this.#base) return;
    const parent = this.#branch.parent;
    parent.#materializePrefix();
    const events = parent.#events.slice(0, this.#base);
    for (const event of this.#events) events.push(event);
    this.#events = events;
    this.#base = 0;
  }
  get surface() {
    this.#materializePrefix();
    return this.#surface ??= new this.#api.SurfaceManager(this.#events);
  }
  get #readSurface() {
    if (this.#base && !this.#events.length && this.#branch.parent.seq === this.#base)
      return this.#branch.parent.surface;
    return this.surface;
  }
  get surfaceNodes() { return this.#readSurface.nodes; }
  firstSurfaceEvent() {
    const branch = this.#branch;
    if (this.#base && !branch.replaced && branch.parent.seq === this.#base) {
      const head = branch.parent.surface.nodes[0];
      if (head !== undefined) return branch.parent.eventAt(head);
    }
    const head = this.surface.nodes[0];
    return head === undefined ? undefined : this.eventAt(head);
  }
  deriveEventMessage(event) { return this.#readSurface.deriveEventMessage(event); }
  deriveMessages() {
    const surface = this.surface, nodes = surface.nodes;
    const generation = surface.contentGeneration;
    if (this.#derived?.generation !== generation) {
      this.#derived = {generation, count: 0, messages: []};
    }
    const cached = this.#derived;
    for (; cached.count < nodes.length; cached.count++) {
      const message = this.deriveEventMessage(this.#events[nodes[cached.count]]);
      if (message) cached.messages.push(message);
    }
    return cached.messages.slice();
  }
  requestHeader() { return this.#requestHeader; }
  matchesRequestHeader(header) {
    const previous = this.#requestHeader;
    return previous !== undefined && (previous.config === header.config && previous.tools === header.tools
      && previous.adapterDefaults === header.adapterDefaults || this.#api.headerEquals(previous, header));
  }
  eventAt(seq) {
    return this.#base && seq < this.#base ? this.#branch.parent.eventAt(seq) : this.#events[seq - this.#base];
  }
  lastEvent(type) {
    if (type === 'session/title') return this.#titleEvent;
    for (let i = this.seq - 1; i >= 0; i--) {
      const event = this.eventAt(i);
      if (event.type === type) return event;
    }
  }
  snapshotEvents(start = 0, end = this.seq) {
    if (this.#base && start >= this.#base && end >= 0)
      return Object.freeze(this.#events.slice(start - this.#base, Math.max(0, end - this.#base)));
    this.#materializePrefix();
    if (start === 0 && end === this.seq) return this.#eventsSnapshot ??= Object.freeze(this.#events.slice());
    return Object.freeze(this.#events.slice(start, end));
  }
  /** Stage a batch over already validated immutable events without cloning its prefix. */
  branch() {
    if(this.#active||this.#retired||this.#announced)throw new Error('Only an idle unpublished mirror can stage a batch');
    const candidate=new SessionFacade(this.#ctx,this.#api,{header:this.header,journalSource:this.#journalSource},false);
    candidate.#base=this.seq;candidate.#bytes=this.#bytes;
    candidate.#requestHeader=this.#requestHeader;
    candidate.#titleEvent=this.#titleEvent;
    candidate.inheritedEventCount=this.inheritedEventCount;
    candidate.#branch={parent:this,seq:this.seq};return candidate;
  }
  /** Validate the entire suffix before either the native mirror or its journal publishes it. */
  prepareBranch(candidate) {
    if(!(candidate instanceof SessionFacade)||candidate.#branch?.parent!==this||candidate.#branch.seq!==this.seq
      ||this.#active||candidate.#active||this.#retired||candidate.#retired||this.#announced)
      throw new Error('Session batch lost its original prefix');
    const start = this.seq;
    const suffix = candidate.#base === start ? candidate.#events : candidate.#events.slice(start);
    const commitSurface = suffix.length ? this.surface.prepareBatch(suffix) : undefined;
    candidate.#retired = true;
    return () => {
      if (this.seq !== start || this.#active || this.#retired || this.#announced)
        throw Error('Session batch lost its original prefix');
      if (suffix.length) this.#eventsSnapshot = undefined;
      for (const event of suffix) this.#events.push(event);
      commitSurface?.();
      this.#bytes = candidate.#bytes;
      this.#requestHeader = candidate.#requestHeader;
      this.#titleEvent = candidate.#titleEvent;
      this.inheritedEventCount = candidate.inheritedEventCount;
    };
  }
  isOwnSeq(seq) { return integer(seq) && seq >= this.inheritedEventCount && seq < this.seq; }
  begin() { if (this.#retired || this.#active) throw new Error('Session mutation unavailable'); this.#active = true; }
  end() { this.#active = false; }
  retire() {
    if(this.#retired)return;
    this.#retired=true;this.#active=false;
    if(this.#announced)notifySession(this.#ctx,'session/disposed',this);
  }
  append(type, data, opts = {}) {
    if (!this.#active || this.#retired) throw new Error('append outside owning transaction');
    if(type==='model/selection')throw new Error('Model selection requires the native Session command');
    if(type==='goal/change')throw new Error('Goal changes require the native Session command');
    if(compactionEvents.has(type))throw Error('Compaction history requires its owning native operation');
    if (!shape(opts, ['surfaceOp', 'sourceEventSeqs'])) throw new Error('invalid append metadata');
    return this.#admit({ type, seq: this.seq, time: Date.now(), data, ...opts }, true);
  }
  appendObserved(type, data, time, opts = {}) {
    if (!this.#active || this.#retired || !integer(time)) throw new Error('observed append outside owning transaction');
    if (!shape(opts, ['surfaceOp', 'sourceEventSeqs', 'ignorable'])) throw new Error('invalid observed append metadata');
    return this.#admit({ type, seq: this.seq, time, data, ...opts }, true);
  }
  /** Internal transfer: owned containers may alias only validated, deeply frozen values. */
  adoptObserved(event) {
    if (!this.#active || this.#retired || !integer(event.time)) throw new Error('observed append outside owning transaction');
    return this.#admit(event, true, true);
  }
  /** The journal publishes notifications after the entire native suffix commits. */
  adoptBatch(events) {
    if(this.#active||this.#retired||this.#announced)throw Error('Only an idle unpublished mirror can accept a batch');
    if(!events.length)return;
    let bytes=this.#bytes,header=this.#requestHeader,title=this.#titleEvent;
    for(const [index,event] of events.entries()){
      if(!integer(event.time))throw Error('Invalid observed event time');
      bytes+=this.#prepare(event,this.seq+index,bytes,true);
      if(event.type==='request/header')header=Object.freeze(this.#api.canonicalHeader(event.data.header));
      if(event.type==='session/title')title=event;
    }
    const commitSurface=this.surface.prepareBatch(events);
    for(const event of events)this.#events.push(event);
    commitSurface();
    this.#bytes=bytes;this.#requestHeader=header;this.#titleEvent=title;this.#eventsSnapshot=undefined;
  }
  #admit(input, notify, adopt = false) {
    if(this.#publishing)throw Error('session append cannot reenter while another append is being published');
    const event = adopt ? input : this.#api.snapshotJsonValue(input);
    if (!event) throw new Error('event must be lossless JSON');
    const bytes=this.#prepare(event,this.seq,this.#bytes,adopt);
    if (!this.#branch || this.#surface) this.surface.validateNext(event);
    if(notify&&this.#announced){
      this.#publishing=true;
      try {
        const args=['session/event',this,event];
        const listeners=this.#ctx.events.dispatch('emit',args);
        this.#record(event,bytes);
        callSessionListeners(this.#ctx,'session/event',args,listeners);
      } finally {this.#publishing=false;}
    }else this.#record(event,bytes);
    return event;
  }
  #record(event,bytes) {
    if(event.type==='request/header')this.#requestHeader=Object.freeze(this.#api.canonicalHeader(event.data.header));
    if(event.type==='session/title')this.#titleEvent=event;
    if(this.#branch && typeof event.surfaceOp === 'object') this.#branch.replaced = true;
    this.#events.push(event); this.#bytes += bytes; this.#eventsSnapshot = undefined;
  }
  #prepare(event, seq, usedBytes, adopt) {
    const known = adopt ? admitted.get(event) : undefined;
    const validated = known && known.validate === this.#api.adoptSessionEvent;
    envelope(event, seq, this.#api, validated);
    const encoded = known ? undefined : JSON.stringify(event);
    const bytes = known?.bytes ?? Buffer.byteLength(encoded);
    if (usedBytes + bytes > 64 * 1024 * 1024 || seq >= 100_000) throw new Error('Session mirror capacity');
    if (!validated) {
      this.#api.adoptSessionEvent(event);
      if (!known) {
        if(adopt)freezeTransferred(event);else this.#api.deepFreeze(event);
      }
      admitted.set(event, {bytes,hash:this.#journalSource && !known ? encodedDigest(encoded) : known?.hash,validate:this.#api.adoptSessionEvent});
    }
    return bytes;
  }
}
