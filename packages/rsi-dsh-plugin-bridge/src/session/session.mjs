import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {assertForkAnnotation, isForkAnnotation} from './fork-annotations.mjs';

const journalEvents = new Set(['session/title', 'approval/asked', 'approval/decided', 'approval/policy',
  'command/run', 'command/done', 'hook/invoked', 'hook/result', 'job/registered', 'job/settled']);
export const isJournalEvent = type => journalEvents.has(type);
const allowed = new Set([...journalEvents, 'todo/write', 'plan/mode', 'turn/start', 'turn/end', 'step/start', 'step/end',
  'request/header', 'user/message', 'developer/message', 'system/message', 'assistant/attempt', 'assistant/message',
  'tool/call', 'tool/result', 'session/end-seed', 'model/selection', 'agent/inbox/spliced']);
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const shape = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
function envelope(event, seq) {
  if (!shape(event, ['seq', 'time', 'type', 'data', 'surfaceOp', 'sourceEventSeqs', 'ignorable'])
      || event.seq !== seq || !integer(event.seq) || !Number.isSafeInteger(event.time)
      || (!allowed.has(event.type) && !isForkAnnotation(event.type)) || !Object.hasOwn(event, 'data')
      || (event.ignorable !== undefined && event.ignorable !== true)) throw new Error('unsupported or invalid event envelope');
  const data = event.data;
  if (isForkAnnotation(event.type)) assertForkAnnotation(event);
  if (event.surfaceOp !== undefined && isJournalEvent(event.type))
    throw new Error('Log-only Session event cannot edit the message surface');
  if (event.type === 'todo/write') {
    if (!shape(data, ['todos']) || !Array.isArray(data.todos) || data.todos.length > 512
        || data.todos.some(todo => !shape(todo, ['content', 'status']) || typeof todo.content !== 'string'
          || !todo.content.trim() || Buffer.byteLength(todo.content) > 16 * 1024
          || !['pending', 'in_progress', 'completed'].includes(todo.status))) throw new Error('invalid Todo event');
  } else if (event.type === 'plan/mode') {
    if (!shape(data, ['active']) || typeof data.active !== 'boolean') throw new Error('invalid Plan event');
  } else if (event.type === 'session/title') {
    if(typeof data?.title!=='string'||!data.title.trim()||typeof data.source?.kind!=='string'||
      !Array.isArray(data.messageSeqs)||data.messageSeqs.some(value=>!integer(value)||value>=seq))throw Error('Invalid Session title');
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
      || (header.agentPreset !== undefined && typeof header.agentPreset !== 'string')
      || (header.delegationDepth !== undefined && !integer(header.delegationDepth))) throw new Error('invalid Session header');
  return Object.freeze(structuredClone(header));
}
export function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

/** No upstream constructor: it appends seed/resume markers before attachment. */
export class SessionFacade {
  #events = []; #ctx; #api; #surface; #active = false; #bytes = 0; #retired = false; #announced = false;
  #branch; #requestHeader; #titleEvent;
  constructor(ctx, api, { header, events = [], inheritedEventCount = 0 }, announce = true) {
    this.header = validateHeader(header); this.id = header.id;
    if (!integer(inheritedEventCount) || inheritedEventCount > events.length) throw new Error('invalid inherited prefix');
    this.inheritedEventCount = inheritedEventCount;
    this.#ctx = ctx; this.#api = api; this.#surface = new api.SurfaceManager(this.#events);
    for (const event of events) this.#admit(event, false);
    if (announce) this.attach();
  }
  attach() { if (!this.#announced && !this.#retired) { this.#announced = true; this.#ctx.emit('session/created', this); } }
  get seq() { return this.#events.length; }
  get encodedBytes() { return this.#bytes; }
  get surface() { return this.#surface; }
  requestHeader() { return this.#requestHeader; }
  eventAt(seq) { if (!integer(seq) || seq >= this.seq) throw new RangeError('Session sequence'); return this.#events[seq]; }
  lastEvent(type) { return type==='session/title'?this.#titleEvent:this.#events.findLast(event => event.type === type); }
  snapshotEvents(start = 0, end = this.seq) {
    if (!integer(start) || !integer(end) || end > this.seq || start > end) throw new RangeError('Session interval');
    return this.#events.slice(start, end);
  }
  /** Stage a batch over already validated immutable events without cloning its prefix. */
  branch() {
    if(this.#active||this.#retired||this.#announced)throw new Error('Only an idle unpublished mirror can stage a batch');
    const candidate=new SessionFacade(this.#ctx,this.#api,{header:this.header},false);
    candidate.#events=this.#events.slice();candidate.#bytes=this.#bytes;
    candidate.#requestHeader=this.#requestHeader;
    candidate.#titleEvent=this.#titleEvent;
    candidate.inheritedEventCount=this.inheritedEventCount;
    candidate.#surface=new this.#api.SurfaceManager(candidate.#events);
    candidate.#branch={parent:this,seq:this.seq};return candidate;
  }
  /** Commit an entire validated branch; its owner publishes notifications afterwards. */
  adoptBranch(candidate) {
    if(!(candidate instanceof SessionFacade)||candidate.#branch?.parent!==this||candidate.#branch.seq!==this.seq
      ||this.#active||candidate.#active||this.#retired||candidate.#retired||this.#announced)
      throw new Error('Session batch lost its original prefix');
    this.#events=candidate.#events;this.#bytes=candidate.#bytes;this.#surface=candidate.#surface;
    this.#requestHeader=candidate.#requestHeader;
    this.#titleEvent=candidate.#titleEvent;
    this.inheritedEventCount=candidate.inheritedEventCount;
    candidate.#branch=undefined;candidate.#retired=true;
  }
  isOwnSeq(seq) { return integer(seq) && seq >= this.inheritedEventCount && seq < this.seq; }
  begin() { if (this.#retired || this.#active) throw new Error('Session mutation unavailable'); this.#active = true; }
  end() { this.#active = false; }
  retire() { if (this.#retired) return; this.#retired = true; this.#active = false; this.#ctx.emit('session/disposed', this); }
  append(type, data, opts = {}) {
    if (!this.#active || this.#retired) throw new Error('append outside owning transaction');
    if(type==='model/selection')throw new Error('Model selection requires the native Session command');
    if (!shape(opts, ['surfaceOp', 'sourceEventSeqs'])) throw new Error('invalid append metadata');
    return this.#admit({ type, seq: this.seq, time: Date.now(), data, ...opts }, true);
  }
  appendObserved(type, data, time, opts = {}) {
    if (!this.#active || this.#retired || !integer(time)) throw new Error('observed append outside owning transaction');
    if (!shape(opts, ['surfaceOp', 'sourceEventSeqs', 'ignorable'])) throw new Error('invalid observed append metadata');
    return this.#admit({ type, seq: this.seq, time, data, ...opts }, true);
  }
  #admit(input, notify) {
    const event = this.#api.snapshotJsonValue(input);
    if (!event) throw new Error('event must be lossless JSON');
    envelope(event, this.seq);
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.#bytes + bytes > 64 * 1024 * 1024 || this.seq >= 100_000) throw new Error('Session mirror capacity');
    this.#api.adoptSessionEvent(event);
    this.#surface.validateNext(event);
    this.#api.deepFreeze(event);
    if(event.type==='request/header')this.#requestHeader=this.#api.deepFreeze(this.#api.canonicalHeader(event.data.header));
    if(event.type==='session/title')this.#titleEvent=event;
    this.#events.push(event); this.#bytes += bytes;
    if (notify && this.#announced) this.#ctx.emit('session/event', this, event);
    return event;
  }
}
