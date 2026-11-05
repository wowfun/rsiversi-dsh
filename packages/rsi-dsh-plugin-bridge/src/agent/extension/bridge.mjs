import {agentOperations} from './operations.mjs';
import {sessionMirrors} from './session-mirrors.mjs';
import {stagedMutations} from './mutations.mjs';
import {nativeWorkingDirectory} from '../../session/working-directory.mjs';
import { PlanIntentAdapter } from '../plan-intent.mjs';
import { inactiveFiber } from '../fiber.mjs';
import { toolPipeline } from '../../tools/tool-pipeline.mjs';
import { toolContextOutput } from '../../history/step-messages.mjs';
import { prepareRows, runtimeContextProjection } from '../request-input.mjs';
import { claimedRows } from '../../history/input-history.mjs';
import { readHistory, readAttempt, observeFact } from '../../history/history.mjs';

/** Original Cordis + original Todo/Plan, with RSI-owned receipt and Session seams. */
export async function createBridge({ cohortRoot, cohortLoader, configuration, request, ask = async () => { throw new Error('question channel unavailable'); }, section = 'Plan the work before making changes.' }) {
  const loadCohort = cohortLoader ?? (await import('rsi-dsh-cordis/cohort')).loadCohort;
  const cohort = await loadCohort(cohortRoot);
  const [cordis, projections, tools, prompt, agents, session, surface, values, todo, plan, questions, llm, commands] = await Promise.all([
    cohort.import('@deepseek-ai/cordis'), cohort.import('@deepseek-ai/dsh-session-projection'),
    cohort.import('@deepseek-ai/dsh-tools'), cohort.import('@deepseek-ai/dsh-system-prompt'),
    cohort.import('@deepseek-ai/dsh-agent'), cohort.import('@deepseek-ai/dsh-session'),
    cohort.subpath('@deepseek-ai/dsh-session', 'surface'), cohort.import('@deepseek-ai/dsh-util-values'),
    cohort.import('@deepseek-ai/dsh-tool-todo'), cohort.import('@deepseek-ai/dsh-plan-mode'),
    cohort.import('@deepseek-ai/dsh-user-questions'),
    cohort.import('@deepseek-ai/dsh-llm'), cohort.import('@deepseek-ai/dsh-commands'),
  ]);
  const ctx = new cordis.Context();
  const records = new Map(); const catalogScope = Object.freeze({}); let closing;
  const lifetime = new AbortController();
  await ctx.plugin(projections.default);
  const toolsFiber = await ctx.plugin(tools.default);
  await ctx.plugin(prompt.default);
  await ctx.plugin(agents.AgentRegistry);
  const runtimeContext = runtimeContextProjection({...prompt,...llm});
  const executeTool = toolPipeline(ctx,await cohort.subpath('@deepseek-ai/dsh-tools','pipeline'),tools);
  await ctx.plugin(commands.default);
  ctx.provide('workingDirectory',nativeWorkingDirectory(
    session=>!lifetime.signal.aborted&&records.get(session.id)?.session===session,
    agent=>!lifetime.signal.aborted&&records.get(agent.id)?.agent===agent));
  ctx.provide('userQuestions', { async ask(request) {
    const record = records.get(request.agent.id); const operation = record?.active;
    if (!operation || operation.session.seq !== (operation.observedThrough ?? operation.start) || operation.inputs.length) throw new Error('question requires a canonical-prefix barrier');
    const identity = operation.session; const epoch = record.epoch;
    if (identity.seq !== operation.start) record.parked = operation;
    operation.session.end(); record.active = null; operation.release();
    let answer, failure;
    try {
      answer = await new Promise((resolve, reject) => {
        const abort = () => reject(new questions.UserQuestionError('review cancelled', 'ASK_ABORTED'));
        operation.signal.addEventListener('abort', abort, { once: true });
        if (operation.signal.aborted) abort();
        Promise.resolve().then(() => ask(request, operation.signal, { operationId: operation.id, callId:operation.callId, UserQuestionError: questions.UserQuestionError })).then(resolve, reject)
          .finally(() => operation.signal.removeEventListener('abort', abort));
      });
    } catch (error) { failure = error; }
    operation.release = await record.lane.acquire();
    if (record.parked === operation) record.parked = undefined;
    if (lifetime.signal.aborted || operation.signal.aborted || record.epoch !== epoch || record.session !== identity || record.staged) {
      if (!lifetime.signal.aborted && record.epoch === epoch && record.session === identity && !record.staged && identity.seq !== operation.start) restore(record);
      operation.invalidated = new questions.UserQuestionError('review no longer belongs to the current Session state', 'ASK_ABORTED');
      throw operation.invalidated;
    }
    record.active = operation; identity.begin();
    if (failure) throw failure;
    return answer;
  } });
  await ctx.plugin(todo, { allowParallelInProgress: false });
  await ctx.plugin(plan.default, { section });
  if (configuration !== undefined) {
    try {
      await toolsFiber.await();
      if (!ctx.get('tools')) throw new Error('Tool registry failed to activate');
      const activeFiberState = toolsFiber.state;
      if (configuration?.format !== 1 || !Array.isArray(configuration.plugins) || !configuration.plugins.length
        || configuration.plugins.length > 128 || new Set(configuration.plugins).size !== configuration.plugins.length
        || Object.keys(configuration).some(key => !['format','plugins'].includes(key))) throw new Error('Invalid imported plugin selection');
      const fibers = [];
      for (const name of configuration.plugins) {
        const module = await cohort.import(name);
        fibers.push([name, await ctx.plugin(module.default ?? module)]);
      }
      for (const [name, fiber] of fibers) {
        await fiber.await();
        if (fiber.state !== activeFiberState) throw new Error('Imported plugin services unavailable: '+inactiveFiber(name,fiber));
      }
    } catch (error) {
      try { await ctx.fiber.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], error.message, {cause:error}); }
      throw error;
    }
  }
  const intents = new PlanIntentAdapter(ctx.planMode);
  const api = { ...session, ...surface, ...values };
  const mirrors = sessionMirrors({ctx, api, llm, surface, request, records, intents, signal: lifetime.signal});
  const {get, restore} = mirrors;
  const mutations = stagedMutations({records, get, restore, intents, ctx, lifetime: lifetime.signal});
  const {stage} = mutations;

  function agent(record) {
    return record.agent ??= { id: record.session.id, ctx, get session() { return record.session; },
      inject(message) { if (!record.active) throw new Error('inject outside transaction'); record.active.inputs.push({ kind: 'inject', message }); },
      steer(message) { if (!record.active) throw new Error('steer outside transaction'); record.active.inputs.push({ kind: 'steer', message }); },
    };
  }
  async function syncHistory(record, operation, horizon) {
    if (!Number.isSafeInteger(horizon) || horizon < record.mapping.factCursor) throw new Error('invalid captured history horizon');
    if (horizon === record.mapping.factCursor) return;
    if (typeof request !== 'function') throw new Error('captured history channel unavailable');
    const identity = { session_id: record.session.id, operation_id: operation.id };
    const readFact = async seq => {
      let original;
      await readHistory(request, identity, seq - 1, seq, fact => { original = fact; }, operation.signal);
      if (original?.seq !== seq) throw new Error('referenced Fact is not visible');
      return original;
    };
    record.mapping.factCursor = await readHistory(request, identity,
      record.mapping.factCursor, horizon, fact => observeFact(record.session, record.mapping, fact, readFact,
        seq => readAttempt(request, identity, seq, operation.signal), llm), operation.signal);
  }
  return Object.freeze({
    ...mirrors.protocol,
    ...mutations.receipts,
    catalog() {
      return { protocol: 5, commands: ctx.commands.list(catalogScope).map(command => ({
        id: `rsi.extension.command.${command.name}`, name: command.name, description: command.description, draft_safe: true,
      })), tools: ctx.tools.definitions().map(definition => {
        const schema = tools.projectToolSchema(definition, true);
        return { definition: { name: schema.name, description: schema.description, input_schema: schema.parameters },
          interaction: definition.name === plan.EXIT_PLAN_MODE ? { kind: 'human' } : { kind: 'execution', timeout_ms: definition.timeoutMs ?? 30_000 } };
      }) };
    },
    ...agentOperations({get,registry:ctx.tools,request}),
    async describe(id) {
      const record = get(id), release = await record.lane.acquire();
      try {
        if (record.staged) throw new Error('canonical receipt required before schema selection');
        const owner = agent(record);
        const selection = await ctx.tools.resolve({ agent: owner, signal: lifetime.signal });
        try { return [...selection.view(owner).values()].map(definition => tools.projectToolSchema(definition, true)); }
        finally { selection.dispose(); }
      } finally { release(); }
    },
    async tool(id, operationId, name, args, signal, factHorizon) {
      return stage(id, operationId, async (record, operation) => {
        if (factHorizon !== undefined) await syncHistory(record, operation, factHorizon);
        const callId = record.mapping.calls.find(call => call.effect === operationId)?.id ?? operationId;
        operation.observedThrough = record.session.seq; operation.callId = callId;
        const owner = agent(record);
        const selection = await ctx.tools.resolve({ agent: owner, signal: operation.signal });
        try {
          const definition = selection.view(owner).get(name);
          if (!definition) throw new Error('tool not admitted for this Step');
          const inputViolations = tools.validateJsonSchemaValue(tools.projectToolSchema(definition, false).parameters, args, '');
          if (inputViolations.length) throw new Error(`invalid original Tool arguments: ${inputViolations.join('; ')}`);
          const result=await executeTool({agent:owner, callId, name, arguments:args, toolSet:selection, signal:operation.signal});
          if(operation.inputs.some(input=>input.kind!=='inject'))throw Error('Tool steering requires native interrupt admission');
          const deferred=[...operation.inputs.map(input=>input.message),...(result.additionalContexts??[])];
          operation.inputs=[];
          if (!result.isError && tools.validateJsonSchemaValue(definition.output.schema, result.value, '').length)
            throw new Error('invalid original Tool result');
          return {value:result.value??null,content:result.content,isError:result.isError===true,concludeTurn:result.concludesTurn===true,
            contexts:toolContextOutput(deferred)};
        } finally { selection.dispose(); }
      }, signal);
    },
    async command(id, operationId, name, rawInput = '', signal, factHorizon) {
      return stage(id, operationId, async (record, operation) => {
        if (factHorizon !== undefined) await syncHistory(record, operation, factHorizon);
        const line = `/${name}${rawInput && !/^[\t\n\r ]/.test(rawInput) ? ' ' : ''}${rawInput}`;
        const execution = await ctx.commands.execute(agent(record),line,[],operation.signal);
        if (!execution) throw new Error('unknown command');
        return execution.result;
      }, signal);
    },
    async beforeStep(id, operationId, signal, captured, modelSelection, previous) {
      return stage(id, operationId, async (record, operation) => {
        if (captured) {
          await syncHistory(record, operation, captured.fact_horizon);
          if (record.mapping.turnId !== captured.turn_id || record.mapping.stepId !== captured.step_id)
            throw Error('prepared Step is outside captured history');
        }
        const owner = agent(record);
        const selection = await ctx.tools.resolve({ agent: owner, modelSelection, signal: operation.signal });
        try {
          const assembly = await ctx.systemPrompt.assemble({ agent: owner, modelSelection, signal: operation.signal, toolSet: selection });
          const rows = captured ? await claimedRows(record.session, record.mapping, async seq => {
            let fact;
            await readHistory(request, {session_id:id,operation_id:operationId}, seq-1, seq, value=>{fact=value;}, operation.signal);
            return fact;
          }, previous) : [];
          const decision = await prepareRows({ ctx, agent: owner, rows, previous,
            modelSelection, assembly, signal: operation.signal }, {agentEvents: agents.agentEvents, runtimeContext});
          return { prompts: assembly.sections, instructions: prompt.renderPrompt(assembly), decision,
            tools: [...selection.view(owner).keys()] };
        } finally { selection.dispose(); }
      }, signal);
    },
    close() {
      if (closing) return closing;
      lifetime.abort();
      mirrors.retire();
      closing = mutations.drain().then(() => ctx.fiber.dispose()).then(mirrors.clear);
      return closing;
    },
  });
}
