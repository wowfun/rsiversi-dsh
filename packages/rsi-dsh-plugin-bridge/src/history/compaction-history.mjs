import {modelProjection} from './model-history.mjs';
import {modelTextBlock} from './conversation-history.mjs';

const headId = effect => 'rsi:checkpoint:head:' + effect;

/** Load the published pricing and checkpoint contracts only for an installed summary. */
export function compactionLanguage(llm, load) {
  let contracts;
  return {...llm, compactionContracts: () => contracts ??= Promise.all([
    load('@deepseek-ai/dsh-token-meter','estimate'), load('@deepseek-ai/dsh-compaction','checkpoint'),
  ])};
}

// A replacement copy retains the original message's position in its native Turn.
// A region checkpoint takes the first selected message's position. A head
// checkpoint is a separate native position ahead of all retained Turns.
function nativeOrigin(session, seq) {
  for (;;) {
    const event = session.eventAt(seq);
    if (!event || event.surfaceOp === 'append') return seq;
    const refs = event.sourceEventSeqs;
    const source = event.type === 'user/message' && event.data.source;
    if (source?.kind === 'compact-checkpoint' && session.eventAt(refs?.[0])?.type === 'compaction/start') {
      if (event.data.id === headId(source.compactionId)) return null;
      seq = refs[2];
    } else if (refs?.length) seq = refs[0];
    else throw Error('Replacement has no native message coordinate');
  }
}

function selection(session, plan) {
  const nodes = session.surface.nodes.filter(seq => session.eventAt(seq).type !== 'system/message');
  const origins = nodes.map(seq => nativeOrigin(session, seq));
  const owners = new Map(origins.map(seq => [seq, null]));
  let turn;
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(seq);
    if (event.type === 'turn/start') turn = event.data.rsi;
    else if (event.type === 'turn/end') turn = undefined;
    else if (turn && owners.has(seq) && !event.data?.rsi?.syntheticToolResult) owners.set(seq, turn);
  }
  const bySession = new Map();
  for (let index = 0; index < nodes.length; index++) {
    const owner = owners.get(origins[index]);
    if (!owner) continue;
    let turns = bySession.get(owner.session);
    if (!turns) bySession.set(owner.session, turns = new Map());
    let positions = turns.get(owner.turn);
    if (!positions) turns.set(owner.turn, positions = []);
    positions.push(index);
  }
  const selected = new Set();
  if (plan.prior) {
    const first = session.eventAt(nodes[0]);
    if (first?.data?.id !== headId(plan.prior.effect)) throw Error('Native prior checkpoint is absent');
    selected.add(0);
  }
  for (const {session: id, turn, first, count} of plan.selections) {
    const positions = bySession.get(id)?.get(turn);
    if (!positions || first + count > positions.length) throw Error('Native compaction selection is outside its Turn');
    for (let offset = first; offset < first + count; offset++) selected.add(positions[offset]);
  }
  const shadowedSeqs = nodes.filter((_, index) => selected.has(index));
  if (!shadowedSeqs.length) throw Error('Native compaction has no visible sources');
  return {nodes, selected, shadowedSeqs};
}

// The release supports one new node per contiguous replacement. For a later
// selected run, replace its retained predecessor and the run with that same
// predecessor. This keeps both the protected message and the untouched suffix.
function replacements(session, time, nodes, selected, checkpoint, atHead) {
  const ranges = [];
  for (let i = 0; i < nodes.length; i++) {
    if (!selected.has(i)) continue;
    const first = i;
    while (selected.has(i + 1)) i++;
    ranges.push([first, i]);
  }
  const copy = seq => {
    const {type, data} = session.eventAt(seq);
    return {type, data, sourceEventSeqs: [seq]};
  };
  const replace = (body, first, last) => session.adoptObserved({...body, seq:session.seq, time,
    sourceEventSeqs:[...new Set([...body.sourceEventSeqs, ...nodes.slice(first, last + 1)])],
    surfaceOp:{op:'replace', startSeq:nodes[first], endSeq:nodes[last]}});
  const [first, last] = ranges[0];
  if (atHead && first > 0) {
    replace(checkpoint, 0, 0);
    for (let i = 1; i < first; i++) replace(copy(nodes[i - 1]), i, i);
    replace(copy(nodes[first - 1]), first, last);
  } else replace(checkpoint, first, last);
  for (const [start, end] of ranges.slice(1)) replace(copy(nodes[start - 1]), start - 1, end);
}

export function compactionPrepared(fact) {
  if (fact.type === 'manual_compaction' && fact.event.stage === 'prepared') return fact.event;
  if (fact.type === 'model_intent' && fact.purpose.kind === 'context_compaction') {
    return {plan:fact.purpose.plan, snapshot:fact.snapshot};
  }
}

export function compactionStart(session, mapping, fact) {
  mapping.compaction = fact.seq;
  session.adoptObserved({type:'compaction/start', seq:session.seq, time:fact.timestamp_ms,
    data:{compactionId:fact.effect_id, turn:fact.command_id ? null : mapping.turn,
      ...(fact.command_id ? {sourceCommandId:fact.command_id} : {})}});
}

/** One native application Fact supplies the checkpoint and its attribution on replay. */
export async function pluginCheckpoint(session, mapping, fact, llm) {
  const {start, end, message, presentation, plugin, summary_blocks} = fact.checkpoint;
  const selected = [];
  let position = 0;
  for (const seq of session.surfaceNodes) {
    const event = session.eventAt(seq);
    if (event.type === 'system/message' || event.data?.rsi?.syntheticToolResult) continue;
    if (position >= start) selected.push(seq);
    if (position === end) break;
    position++;
  }
  if (!selected.length || selected.length !== end - start + 1) throw Error('Plugin checkpoint source is absent');
  const [{estimateMessage},{compactCheckpointSource}] = await llm.compactionContracts();
  const id = fact.effect_id, time = fact.timestamp_ms;
  const lifecycle = {compactionId:id, turn:mapping.turn};
  const shadowedTokenCount = presentation?.shadowedTokenCount ?? selected.reduce((total, seq) =>
    total + estimateMessage(session.deriveEventMessage(session.eventAt(seq))), 0);
  const opening = session.adoptObserved({seq:session.seq,time,type:'compaction/start',data:lifecycle});
  const shadowedRange = {start:selected[0],end:selected.at(-1)};
  const content = message.content.map(modelTextBlock);
  const summary = summary_blocks ? content.slice(summary_blocks.start, summary_blocks.end) : content;
  const data = {...presentation, compactionId:id, summary, shadowedRange, shadowedSeqs:selected, shadowedTokenCount,
    provider:presentation?.provider ?? '', model:presentation?.model ?? '', rsi:{plugin}};
  const written = session.adoptObserved({seq:session.seq,time,type:'compaction/summary',data});
  const first = session.eventAt(selected[0]);
  const head = first.data.id === headId(first.data.source?.compactionId);
  session.adoptObserved({seq:session.seq,time,type:'user/message',
    data:{...message,content,id:head ? headId(id) : 'rsi:checkpoint:region:' + id,source:compactCheckpointSource(id)},
    sourceEventSeqs:[opening.seq,written.seq,...selected],
    surfaceOp:{op:'replace',startSeq:shadowedRange.start,endSeq:shadowedRange.end}});
  session.adoptObserved({seq:session.seq,time,type:'compaction/end',data:lifecycle});
}

export async function compactionInstalled(session, mapping, fact, readFact, llm) {
  const start = session.lastEvent('compaction/start');
  const [intent, settled] = await Promise.all([readFact(mapping.compaction), readFact(fact.settlement_seq ?? fact.seq - 1)]);
  const prepared = intent && compactionPrepared(intent);
  const attempt = settled?.type === 'manual_compaction' ? settled.event.attempt : settled?.attempt;
  if (!prepared || !attempt || [start?.data.compactionId,intent.effect_id,settled.effect_id].some(id => id !== fact.effect_id)) {
    throw Error('Installed checkpoint has no matching native intent and settlement');
  }
  const {plan, snapshot} = prepared;
  const {accept, stream} = modelProjection(llm, start.time);
  for (const [elapsed, event] of attempt.events) accept(elapsed, event);
  const output = llm.assembleAssistantStream(stream.snapshot());
  if (output.finish.kind !== 'stop') throw Error('Installed checkpoint has no completed summary');
  const text = output.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
  const summary = [{type:'text', text}];
  const {nodes, selected, shadowedSeqs} = selection(session, plan);
  const shadowedRange = {start:shadowedSeqs[0], end:shadowedSeqs.at(-1)};
  const [{estimateMessage},{compactCheckpointSource}] = await llm.compactionContracts();
  const shadowedTokenCount = shadowedSeqs.reduce((sum, seq) => {
    const message = session.deriveEventMessage(session.eventAt(seq));
    return sum + (message ? estimateMessage(message) : 0);
  }, 0);
  const {turn, ...identity} = start.data;
  const summaryEvent = session.adoptObserved({type:'compaction/summary', seq:session.seq, time:fact.timestamp_ms,
    data:{...identity, summary, shadowedRange, shadowedSeqs, shadowedTokenCount,
      provider:snapshot.deployment_id, model:snapshot.model, maxTokens:plan.maximum_output_tokens,
      ...(output.usage ? {usage:output.usage} : {})}});
  const atHead = plan.trigger.kind !== 'region' || plan.prior != null;
  const data = {id:atHead ? headId(fact.effect_id) : 'rsi:checkpoint:region:' + fact.effect_id,
    role:'user', source:compactCheckpointSource(fact.effect_id, start.data.sourceCommandId),
    content:[{type:'text',text:'[Internal context summary; source Facts remain authoritative]\n' + text}]};
  replacements(session, fact.timestamp_ms, nodes, selected,
    {type:'user/message', data, sourceEventSeqs:[start.seq, summaryEvent.seq, ...shadowedSeqs]}, atHead);
  session.adoptObserved({type:'compaction/end', seq:session.seq, time:fact.timestamp_ms, data:start.data});
  delete mapping.compaction;
}
