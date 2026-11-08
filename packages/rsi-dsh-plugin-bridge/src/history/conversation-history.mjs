import { toolUserMessage } from './step-messages.mjs';
import { dshFile, dshImage } from '../agent/file-input.mjs';

/** Session surface operations are validated by the original DSH SurfaceManager. */
export function systemHead(session, mapping, time, content) {
  const headSeq = session.surface.nodes[0];
  const previous = headSeq === undefined ? undefined : session.eventAt(headSeq);
  if (previous && previous.type !== 'system/message') throw new Error('conversation lacks its system head');
  if (previous && (content === undefined || JSON.stringify(previous.data.message.content) === JSON.stringify(content))) return;
  session.adoptObserved({type:'system/message',seq:session.seq,time,data:{turn:mapping.turn,step:mapping.step,
    message:{id:`rsi:${session.id}:system`,role:'system',source:{kind:'system-prompt'},content:content??[]}},
    ...(previous?{surfaceOp:{op:'replace',startSeq:headSeq,endSeq:headSeq},sourceEventSeqs:[headSeq]}:{surfaceOp:'append'})});
}

export function contentBlocks(content, seq, offset = 0) {
  return content.map((part, index) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'file') return { type: 'file', attachment: dshFile(part.file) };
    if (part.type === 'image') return { type: 'image', attachment: dshImage(part) };
    if (part.type === 'reference') {
      const { metadata, preview } = part.reference;
      const source = metadata.source.kind === 'native' ? metadata.source.binding.session_id :
        `${metadata.source.owner}/${metadata.source.id} (observed epoch ${metadata.source.epoch})`;
      const selection = metadata.capture.kind === 'suffix' ? metadata.capture.interval : metadata.capture.selection;
      const locator = seq === undefined ? '' : `\nRead more with reference_read using recorded_session_id=${JSON.stringify(metadata.target.session_id)}, fact_seq="${seq}", content_index=${offset + index}.`;
      return { type: 'text', text: `Referenced conversation data from ${source} through record ${selection.through_seq}.${selection.omissions?.length ? ' Earlier material was omitted by capture limits.' : ''}\n${preview}${locator}` };
    }
    throw new Error(`input content needs an explicit DSH mapping: ${part.type}`);
  });
}

function attribution(source) {
  return source.type==='command'?source.source?.attribution:source.attribution;
}

export function nativeMessageSource(source,messageId=source.message_id) {
  const original=attribution(source);if(original)return original.source;
  return {kind:source.type==='human'?'user':`rsi-${source.type}`,
    ...(source.type==='human'&&messageId?{rpcId:messageId}:{}),rsi:source};
}

export function nativeMessageId(source,fallback) {
  return attribution(source)?.id??fallback;
}

export function inputMessage(sessionId, fact, ordinal = 0) {
  if (fact.type === 'tool_contexts_claimed') {
    const { message } = fact.messages[ordinal];
    return toolUserMessage(message.id, structuredClone(message.source), message.text.map(text => ({ type: 'text', text })));
  }
  if (fact.source?.type === 'plugin_context' && fact.source.tool) {
    const origin=fact.source.tool;
    return toolUserMessage(origin.message_id,structuredClone(origin.source),contentBlocks(fact.content, fact.seq));
  }
  const source = fact.type === 'turn_accepted' ? { type: 'human' } : fact.source;
  const role = ['agent_instructions', 'skill_catalog', 'plugin_context'].includes(source.type) ? 'developer' : 'user';
  let content = fact.type === 'turn_accepted' ? [{ type: 'text', text: fact.text }] : contentBlocks(fact.content, fact.seq);
  // RSI Context renders these sources as one developer text message.
  if (role === 'developer') {
    if (content.some(block => block.type !== 'text')) throw new Error('developer input must be text');
    content = [{ type: 'text', text: content.map(block => block.text).join('\n') }];
  }
  return { id: nativeMessageId(source,`rsi:${sessionId}:input:${source.message_id ?? fact.seq}`), role, content,
    source: structuredClone(nativeMessageSource(source)) };
}

export function observeInput(session, mapping, message, time) {
  systemHead(session, mapping, time);
  const { role } = message;
  const data = role === 'user' ? message : { turn: mapping.turn, step: mapping.step, message };
  session.adoptObserved({type:`${role}/message`,seq:session.seq,time,data,surfaceOp:'append'});
}

export function retainCalls(mapping, fact, event) {
  for (const block of event.data.message.content) {
    if (block.type !== 'tool-call') continue;
    if (mapping.calls.length >= 256 || mapping.calls.some(call => call.id === block.id)) throw new Error('pending model-call capacity or duplicate identity');
    mapping.calls.push({ id: block.id, model: fact.effect_id, effect: null, event: event.seq,
      callEvent: null, started: false, turn: mapping.turn, step: mapping.step });
  }
}
function callBlock(session, call) {
  const event = session.eventAt(call.event);
  const block = event.type === 'assistant/message' && event.data.message.content.find(block => block.type === 'tool-call' && block.id === call.id);
  if (!block) throw new Error('pending call lost its assistant message');
  return block;
}
function observeCall(session, call, block, time) {
  call.callEvent = session.adoptObserved({type:'tool/call',seq:session.seq,time,
    data:{turn:call.turn,step:call.step,callId:call.id,name:block.name,arguments:block.arguments}}).seq;
}
function result(session, mapping, call, time, content, isError, error, meta) {
  if (call.callEvent === null) observeCall(session, call, callBlock(session, call), time);
  const message = { id: `rsi:${session.id}:result:${call.model}:${call.id}`, role: 'tool', toolCallId: call.id,
    source: { kind: 'tool', callId: call.id }, content, isError };
  session.adoptObserved({type:'tool/result',seq:session.seq,time,
    data:{turn:call.turn,step:call.step,message,...(error?{error}:{}),...(meta!==undefined?{meta}:{})},
    surfaceOp:'append',sourceEventSeqs:[call.callEvent]});
  mapping.calls.splice(mapping.calls.indexOf(call), 1);
}
export function observeTool(session, mapping, fact) {
  if (fact.type === 'tool_intent' || fact.type === 'tool_rejected') {
    if (fact.origin.kind !== 'model') return;
    const call = mapping.calls.find(call => call.id === fact.identity.call_id && call.model === fact.origin.effect_id);
    if (!call || call.effect !== null) throw new Error('Tool admission lacks its pending model call');
    const block = callBlock(session, call);
    if (block.name !== fact.name) throw new Error('Tool admission changed its model name');
    call.effect = fact.effect_id;
    observeCall(session, call, block, fact.timestamp_ms);
    if (fact.type === 'tool_rejected') {
      const rejection = fact.rejection;
      const text = rejection.type === 'policy_denied' ? rejection.reason : rejection.outcome.reason == null
        ? 'Live approval denied the Tool call; it was not executed.' : `Live approval denied the Tool call: ${rejection.outcome.reason}`;
      result(session, mapping, call, fact.timestamp_ms, [{ type: 'text', text }], true,
        { name: 'ToolNotStartedError', code: `rsi.${rejection.type}`, reason: text });
    }
  } else if (fact.type === 'tool_started') {
    const call = mapping.calls.find(call => call.effect === fact.effect_id);
    if (call) call.started = true;
  } else if (fact.type === 'tool_result') {
    const call = mapping.calls.find(call => call.effect === fact.effect_id);
    if (!call) return; // Program-origin internal results do not join the model conversation.
    if (fact.identity.call_id !== call.id) throw new Error('Tool result identity mismatch');
    const content = fact.result.content.length ? contentBlocks(fact.result.content) : [{ type: 'text', text: JSON.stringify(fact.result.value) }];
    const details=fact.result.metadata?.dsh;
    result(session, mapping, call, fact.timestamp_ms, content, fact.result.is_error,
      structuredClone(details?.error),structuredClone(details?.meta));
  } else {
    const selected = [...mapping.calls].filter(call => fact.type === 'turn_terminal' || call.model === fact.source_model_effect_id && call.effect === null);
    for (const call of selected) {
      const started = call.started;
      const text = started ? 'The canonical Turn ended without a recorded Tool result. Its external outcome is unknown.'
        : fact.type === 'tool_calls_superseded' ? 'New input superseded this Tool call before execution.' : 'The canonical Turn ended before this Tool call was admitted.';
      result(session, mapping, call, fact.timestamp_ms, [{ type: 'text', text }], true,
        { name: started ? 'ToolOutcomeUnknownError' : 'ToolNotStartedError', code: started ? 'TOOL_OUTCOME_UNKNOWN' : 'TOOL_NOT_STARTED', reason: text });
    }
  }
}
