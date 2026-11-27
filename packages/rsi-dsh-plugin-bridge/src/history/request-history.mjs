import { isDeepStrictEqual } from 'node:util';
import { modelTextBlock, systemHead } from './conversation-history.mjs';

const projected = new WeakMap();

export function inheritRequestEvidence(parent, branch) {
  const sections = projected.get(parent);
  if (sections) projected.set(branch, sections);
}

async function section(fact, name, readFact, previous, project) {
  const part = fact.evidence[name];
  let seq = fact.seq, inline = part;
  if (part?.kind === 'reference') {
    seq = part.seq;
    if (!Number.isSafeInteger(seq) || seq < 1 || seq >= fact.seq || part.section !== name)
      throw new Error('invalid request evidence reference');
    if (previous && previous.seq === seq && previous.sha256 === part.sha256 && previous.bytes === part.bytes)
      return previous;
    const original = await readFact(seq);
    inline = original?.seq === seq && original.type === 'model_intent' && original.evidence?.availability === 'available'
      ? original.evidence[name] : undefined;
  }
  if (inline?.kind !== 'inline' || typeof inline.text !== 'string') throw new Error('missing original inline request evidence');
  const bytes = Buffer.byteLength(inline.text);
  if (part.kind === 'reference' && (inline.sha256 !== part.sha256 || bytes !== part.bytes))
    throw new Error('request evidence reference differs from original');
  const value = previous && previous.sha256 === inline.sha256 ? previous.value : project(JSON.parse(inline.text));
  return {seq, sha256:part.sha256, bytes, value};
}

function configurationOf({prepared, settings, response_format, extensions}) {
  if (settings.top_p != null || settings.seed != null || response_format != null && response_format.type !== 'text'
      || Object.keys(extensions ?? {}).length) throw new Error('request controls cannot be represented by DSH EpochHeader');
  const config = {provider:prepared.deployment, model:prepared.model};
  const effort = prepared.language_settings?.effective_reasoning_effort;
  if (effort != null) config.reasoningEffort = effort;
  if (settings.temperature != null) config.temperature = settings.temperature;
  if (settings.max_output_tokens != null) config.maxTokens = settings.max_output_tokens;
  if (settings.stop.length) config.stop = settings.stop;
  const header = {config};
  if (effort != null && settings.reasoning_effort == null) header.adapterDefaults = {reasoningEffort:true};
  return {header, languageSettings:prepared.language_settings};
}

function toolsOf(tools) {
  const choice = typeof tools.choice === 'string' ? tools.choice : tools.choice?.type;
  if (tools.hosted.length || tools.definitions.some(tool => tool.freeform != null) || !['auto', 'none'].includes(choice))
    throw new Error('request controls cannot be represented by DSH EpochHeader');
  if (choice !== 'none' && tools.definitions.length)
    return tools.definitions.map(tool => ({name:tool.name, description:tool.description, parameters:tool.input_schema}));
}

function systemOf(system) {
  if (!Array.isArray(system) || system.some(message => !['system', 'developer'].includes(message.role)))
    throw new Error('invalid system request evidence');
  return system.filter(message => message.role === 'system').flatMap(message => message.content.map(modelTextBlock));
}

// Staged mirrors share their prefix. Inspect only events since the last observation
// without materializing a second surface. A restored observer stops at its header.
function replacedSinceRequest(session, through) {
  for (let seq = session.seq - 1; seq >= through; seq--) {
    const event = session.eventAt(seq);
    if (event.type === 'request/header' || event.type === 'session/end-seed') break;
    if (event.surfaceOp?.op === 'replace') return true;
  }
  return false;
}

/** Retain only projected sections at this native cut. The original Fact pages can be released. */
export function requestObserver(readFact) {
  return async (session, fact, mapping) => {
    if (fact.purpose?.kind !== 'conversation') return;
    if (fact.evidence?.availability !== 'available') throw new Error('request evidence unavailable');
    const owner = mapping ?? session, prior = projected.get(owner);
    let originals;
    async function originalAt(seq) {
      originals ??= new Map();
      if (!originals.has(seq)) originals.set(seq, await readFact(seq));
      return originals.get(seq);
    }
    const configuration = await section(fact, 'configuration', originalAt, prior?.configuration, configurationOf);
    const {header:base, languageSettings} = configuration.value;
    const {snapshot} = fact;
    if (base.config.provider !== snapshot.deployment_id || base.config.model !== snapshot.model
        || !isDeepStrictEqual(languageSettings, snapshot.language_settings)) throw new Error('request route differs from prepared snapshot');
    const tools = await section(fact, 'tools', originalAt, prior?.tools, toolsOf);
    const system = mapping && await section(fact, 'system', originalAt, prior?.system, systemOf);
    const surfaceChanged = mapping?.startsRequestSeries === true || replacedSinceRequest(session, prior?.through ?? 0);
    const systemChanged = system && systemHead(session, mapping, fact.timestamp_ms, system.value);
    const header = tools.value ? {...base, tools:tools.value} : base;
    const previous = session.requestHeader();
    const startsSeries = surfaceChanged || systemChanged;
    const generation = mapping?.preparedGeneration;
    const resumed = generation || (!prior && session.inheritedEventCount > 0
      && session.lastEvent('request/header')?.seq < session.inheritedEventCount);
    const changed = previous && !session.matchesRequestHeader(header);
    if (!previous || resumed || changed || startsSeries) {
      const reason = !previous ? 'initial' : resumed ? 'resume' : changed ? 'change' : 'series';
      session.adoptObserved({type:'request/header', seq:session.seq, time:fact.timestamp_ms,
        data:{header,reason,...(startsSeries && reason !== 'series' && {startsSeries:true})}});
    }
    if (generation) {
      mapping.requestGeneration = generation;
      delete mapping.preparedGeneration;
    }
    if (mapping) delete mapping.startsRequestSeries;
    projected.set(owner, {configuration, tools, system, through:session.seq});
  };
}
