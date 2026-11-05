import { createHash } from 'node:crypto';
import { systemHead } from './conversation-history.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
async function section(fact, name, readFact) {
  if (fact.evidence?.availability !== 'available') throw new Error('request evidence unavailable');
  const part = fact.evidence[name];
  let inline = part;
  if (part?.kind === 'reference') {
    if (!Number.isSafeInteger(part.seq) || part.seq < 1 || part.seq >= fact.seq || part.section !== name) throw new Error('invalid request evidence reference');
    const original = await readFact(part.seq);
    inline = original?.type === 'model_intent' && original.evidence?.availability === 'available'
      ? original.evidence[name] : undefined;
    if (inline?.kind !== 'inline' || Buffer.byteLength(inline.text) !== part.bytes) throw new Error('missing original inline request evidence');
  }
  if (inline?.kind !== 'inline' || typeof inline.text !== 'string' || Buffer.byteLength(inline.text) > 16 * 1024 * 1024
      || inline.sha256 !== part.sha256 || hash(inline.text) !== part.sha256) throw new Error('request evidence digest mismatch');
  return JSON.parse(inline.text);
}

/** Only canonical conversation intents establish what the model has been told. */
export async function observeRequest(session, fact, readFact, mapping) {
  if (fact.purpose?.kind !== 'conversation') return;
  const configuration = await section(fact, 'configuration', readFact);
  const tools = await section(fact, 'tools', readFact);
  if (mapping) {
    const system = await section(fact, 'system', readFact);
    if (!Array.isArray(system) || system.some(message => !['system', 'developer'].includes(message.role))) throw new Error('invalid system request evidence');
    const content = system.filter(message => message.role === 'system').flatMap(message => message.content);
    if (content.some(block => block.type !== 'text')) throw new Error('unsupported system request content');
    systemHead(session, mapping, fact.timestamp_ms, content);
  }
  const { snapshot } = fact;
  const settings = configuration.settings;
  if (configuration.prepared.deployment !== snapshot.deployment_id || configuration.prepared.model !== snapshot.model
      || JSON.stringify(configuration.prepared.language_settings) !== JSON.stringify(snapshot.language_settings)) throw new Error('request route differs from prepared snapshot');
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
  if (choice !== 'none' && tools.definitions.length) header.tools = tools.definitions.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.input_schema }));
  const previous = session.lastEvent('request/header');
  const step = session.lastEvent('step/start');
  const changed = previous && JSON.stringify(previous.data.header) !== JSON.stringify(header);
  if (!previous || changed || step && step.seq > previous.seq) {
    session.appendObserved('request/header', { header, reason: !previous ? 'initial' : changed ? 'change' : 'series' }, fact.timestamp_ms);
  }
}
