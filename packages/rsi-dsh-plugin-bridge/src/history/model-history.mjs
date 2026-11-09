const integer = value => Number.isSafeInteger(value) && value >= 0;

function usage(value) {
  const fields = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'];
  if (fields.some(key => value[key] != null && !integer(value[key]))) throw new Error('model usage exceeds exact integer range');
  const cached = (value.cache_read_tokens ?? 0) + (value.cache_write_tokens ?? 0);
  if (!integer(cached) || cached > value.input_tokens) throw new Error('invalid inclusive model usage');
  const result = { inputTokens: value.input_tokens - cached, outputTokens: value.output_tokens };
  for (const [source, target] of [['cache_read_tokens', 'cacheReadTokens'], ['cache_write_tokens', 'cacheWriteTokens'], ['reasoning_tokens', 'reasoningTokens']]) {
    if (value[source] != null) result[target] = value[source];
  }
  const total = value.input_tokens + value.output_tokens;
  if (!integer(total)) throw new Error('model usage total exceeds exact integer range');
  result.totalTokens = total;
  return result;
}
function finish(event) {
  if (event.replay != null) throw new Error('provider replay envelope requires an explicit DSH adapter');
  if (event.type === 'failed') {
    const error = event.error;
    const failure = { code: `provider.${error.kind}`, message: error.safe_summary };
    for (const [source, target] of [['status', 'status'], ['retry_after_ms', 'providerRetryAfterMs'], ['request_id', 'requestId']]) {
      if (error[source] != null) failure[target] = error[source];
    }
    return { kind: error.kind === 'cancelled' ? 'aborted' : 'error', failure };
  }
  const kind = { stop: 'stop', tool_calls: 'tool-calls', max_tokens: 'max-tokens' }[event.reason];
  if (kind) return { kind };
  if (event.reason === 'cancelled') return { kind: 'aborted', failure: { code: 'CANCELLED', message: 'The canonical model attempt was cancelled.' } };
  throw new Error('model finish cannot be represented by DSH');
}

/** The same native events produce DSH chunks for a live prefix and a durable settlement. */
export function modelProjection(llm,startedAt,onChunk) {
  const stream = new llm.AssistantStreamAccumulator();
  const open = new Map(); let previous = 0;
  function push(time, chunk) {
    const item=stream.push({time,chunk});
    onChunk?.(item);
  }
  function accept(elapsed,event) {
    if (!integer(elapsed) || elapsed < previous || !integer(startedAt + elapsed)) throw new Error('invalid canonical model timing');
    previous = elapsed; const time = startedAt + elapsed;
    switch (event.type) {
      case 'content_started': {
        const type = { text: 'text', reasoning: 'reasoning', tool_call: 'tool-call' }[event.content.type];
        if (!type || type === 'tool-call' && event.content.kind !== 'function') throw new Error('unsupported model content kind');
        open.set(event.index,type==='tool-call'
          ?{type,id:event.content.id,name:event.content.name,arguments:''}:{type,text:''});
        push(time, { type: 'block-start', index: event.index, blockType: type });
        if (type === 'tool-call') push(time, { type: 'tool-call-delta', index: event.index, id: event.content.id, name: event.content.name, argumentsDelta: '' });
        break;
      }
      case 'content_delta': {
        const block = open.get(event.index);
        if (!block) throw new Error('model delta lacks its content start');
        if (event.delta.type === 'tool_arguments') {
          block.arguments+=event.delta.value;
          push(time, { type: 'tool-call-delta', index: event.index, id: block.id, argumentsDelta: event.delta.value });
        } else if (['text', 'reasoning'].includes(event.delta.type)) {
          block.text+=event.delta.value;
          push(time, { type: `${event.delta.type}-delta`, index: event.index, text: event.delta.value });
        }
        else throw new Error('unsupported model delta');
        break;
      }
      case 'content_finished': {
        const block = open.get(event.index);
        if (!block) throw new Error('model close lacks its content');
        open.delete(event.index);
        push(time, { type: 'block-end', index: event.index, block });
        break;
      }
      case 'usage': push(time, { type: 'usage', usage: usage(event.usage) }); break;
      case 'finished': case 'failed':
        push(time, { type: 'finish', reason: finish(event) });open.clear();break;
      default: throw new Error(`model event needs an explicit DSH mapping: ${event.type}`);
    }
  }
  return {stream,accept};
}

export function observeAttempt(session, mapping, fact, llm) {
  if (fact.purpose !== 'conversation') return;
  const model = mapping.model;
  if (!model || model.effectId !== fact.effect_id || !integer(model.startedAt)) throw new Error('attempt lacks its captured model start');
  const projected = fact.attempt;
  if (!projected || typeof projected.retain_context !== 'boolean' || !Array.isArray(projected.events)) throw new Error('invalid normalized model projection');
  const {stream,accept}=modelProjection(llm,model.startedAt);
  for(const [elapsed,event] of projected.events)accept(elapsed,event);
  const data = { turn: mapping.turn, step: mapping.step, stream: stream.snapshot() };
  const blocks = llm.assembleAssistantStream(data.stream);
  const partial = ['error', 'aborted', 'max-tokens'].includes(blocks.finish.kind);
  const content = partial ? blocks.interruptedBlocks() : blocks.blocks();
  if (!partial || projected.retain_context && content.length) {
    data.message = { id: `rsi:${session.id}:model:${fact.effect_id}`, role: 'assistant',
      source: { kind: 'model', provider: model.provider, model: model.model },
      content };
    if (blocks.usage) data.usage = blocks.usage;
    if (partial) data.interrupted = true;
    // Assembly owns the new containers; stream snapshots and closed blocks are already immutable.
    const event = session.adoptObserved({type:'assistant/message',seq:session.seq,time:fact.timestamp_ms,data,surfaceOp:'append'});
    // A truncated batch is diagnostic only, including its complete sibling calls.
    if (blocks.finish.kind !== 'max-tokens') retainCalls(mapping, fact, event);
  } else session.adoptObserved({type:'assistant/attempt',seq:session.seq,time:fact.timestamp_ms,data});
  mapping.model = null;
  return blocks.finish.kind === 'max-tokens' || !partial && !mapping.calls.length;
}
import { retainCalls } from './conversation-history.mjs';

