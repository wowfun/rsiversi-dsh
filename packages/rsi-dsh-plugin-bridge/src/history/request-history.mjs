import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { systemHead } from './conversation-history.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
async function section(fact, name, readFact, decoded) {
  if (fact.evidence?.availability !== 'available') throw new Error('request evidence unavailable');
  const part = fact.evidence[name];
  let inline = part;
  if (part?.kind === 'reference') {
    if (!Number.isSafeInteger(part.seq) || part.seq < 1 || part.seq >= fact.seq || part.section !== name) throw new Error('invalid request evidence reference');
    const original = await readFact(part.seq);
    inline = original?.type === 'model_intent' && original.evidence?.availability === 'available'
      ? original.evidence[name] : undefined;
    if (inline?.kind !== 'inline') throw new Error('missing original inline request evidence');
  }
  if (inline?.kind !== 'inline' || typeof inline.text !== 'string' || inline.sha256 !== part.sha256)
    throw new Error('request evidence digest mismatch');
  let entry = decoded.get(inline);
  if (!entry || entry.text !== inline.text || entry.sha256 !== inline.sha256) {
    const bytes = Buffer.byteLength(inline.text);
    if (bytes > 16 * 1024 * 1024 || hash(inline.text) !== part.sha256) throw new Error('request evidence digest mismatch');
    entry = {text:inline.text,sha256:inline.sha256,bytes,value:JSON.parse(inline.text)};
    decoded.set(inline, entry);
  }
  if (part.kind === 'reference' && entry.bytes !== part.bytes) throw new Error('missing original inline request evidence');
  return entry;
}

/** One projection owns decoded evidence; weak keys do not keep old native pages alive. */
export function requestObserver(readFact) {
  const decoded = new WeakMap();
  return (session, fact, mapping) => observeRequest(session, fact, readFact, mapping, decoded);
}

/** Only canonical conversation intents establish what the model has been told. */
async function observeRequest(session, fact, readFact, mapping, decoded) {
  if (fact.purpose?.kind !== 'conversation') return;
  const { value: configuration } = await section(fact, 'configuration', readFact, decoded);
  const toolSection = await section(fact, 'tools', readFact, decoded);
  const tools = toolSection.value;
  if (mapping) {
    const { value: system } = await section(fact, 'system', readFact, decoded);
    if (!Array.isArray(system) || system.some(message => !['system', 'developer'].includes(message.role))) throw new Error('invalid system request evidence');
    const content = system.filter(message => message.role === 'system').flatMap(message => message.content.map(block => {
      if (block.type !== 'text' || typeof block.content?.text !== 'string') throw new Error('unsupported system request content');
      return {type:'text',text:block.content.text};
    }));
    systemHead(session, mapping, fact.timestamp_ms, content);
  }
  const { snapshot } = fact;
  const settings = configuration.settings;
  if (configuration.prepared.deployment !== snapshot.deployment_id || configuration.prepared.model !== snapshot.model
      || !isDeepStrictEqual(configuration.prepared.language_settings, snapshot.language_settings)) throw new Error('request route differs from prepared snapshot');
  if (settings.top_p != null || settings.seed != null || tools.hosted.length
      || configuration.response_format != null && configuration.response_format.type !== 'text'
      || Object.keys(configuration.extensions ?? {}).length
      || tools.definitions.some(tool => tool.freeform != null)
      || !['auto', 'none'].includes(typeof tools.choice === 'string' ? tools.choice : tools.choice?.type)) throw new Error('request controls cannot be represented by DSH EpochHeader');
  const config = { provider: snapshot.deployment_id, model: snapshot.model };
  const effort = snapshot.language_settings?.effective_reasoning_effort;
  if (effort != null) config.reasoningEffort = effort;
  if (settings.temperature != null) config.temperature = settings.temperature;
  if (settings.max_output_tokens != null) config.maxTokens = settings.max_output_tokens;
  if (settings.stop.length) config.stop = settings.stop;
  const header = { config };
  if (effort != null && settings.reasoning_effort == null) header.adapterDefaults = { reasoningEffort: true };
  const choice = typeof tools.choice === 'string' ? tools.choice : tools.choice.type;
  if (choice !== 'none' && tools.definitions.length) {
    header.tools = toolSection.projectedTools ??= tools.definitions.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.input_schema }));
  }
  const previous = session.lastEvent('request/header');
  const step = session.lastEvent('step/start');
  const changed = previous && !isDeepStrictEqual(previous.data.header, header);
  if (!previous || changed || step && step.seq > previous.seq) {
    // Evidence decoding owns this graph; admission validates and freezes it in place.
    session.adoptObserved({type:'request/header',seq:session.seq,time:fact.timestamp_ms,
      data:{header,reason:!previous?'initial':changed?'change':'series'}});
  }
}
