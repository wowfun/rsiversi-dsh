import {createBridge} from './agent/extension/bridge.mjs';

export {createBridge};

/** Business protocol adapter; the Cordis process host only owns transport/lifetime. */
export async function createExtension({ cohortRoot, cohortLoader, configuration, request }) {
  const bridge = await createBridge({ cohortRoot, cohortLoader, configuration, request, ask: async (question, signal, { operationId, callId, UserQuestionError }) => {
    const review = question.questions.length === 1 && question.questions[0].intent?.kind === 'plan-review'
      ? question.questions[0] : null;
    if (review && (review.intent.callId !== callId || review.options.length !== 2
      || review.intent.approve !== review.options[0].label)) throw new Error('unsupported original review identity');
    const answer = await request('user-question.ask', {
      session_id: question.agent.id, operation_id: operationId,
      questions: question.questions.map(item => ({ id: item.id,
        prompt: review ? review.detail : [item.header, item.question, item.detail].filter(Boolean).join('\n\n'),
        options: review ? [] : (item.options ?? []).map(option => option.label) })),
      review: review ? [
        { id: 'approve', label: review.options[0].label },
        { id: 'keep_planning', label: review.options[1].label },
        { id: 'dismiss', label: 'Dismiss and reply in my own words' },
      ] : null,
    }, signal);
    signal.throwIfAborted();
    if (review) {
      if (answer.review?.choice_id === 'dismiss') throw new UserQuestionError('review dismissed', 'ASK_CANCELLED');
      const index = { approve: 0, keep_planning: 1 }[answer.review?.choice_id];
      if (index === undefined) throw new Error('invalid closed review answer');
      return { answers: [{ id: review.id, selected: [review.options[index].label],
        ...(answer.review.feedback ? { custom: answer.review.feedback } : {}) }] };
    }
    if (!Array.isArray(answer.answers) || answer.answers.length !== question.questions.length) throw new Error('invalid question answers');
    return { answers: question.questions.map((item, index) => ({ id: item.id,
      ...((item.options ?? []).some(option => option.label === answer.answers[index])
        ? { selected: [answer.answers[index]] } : { selected: [], custom: answer.answers[index] }) })) };
  } });
  return { close: () => bridge.close(), async handle(method, args, signal) {
    if (method === 'agent.catalog') return bridge.catalog();
    if (method === 'agent.load.begin') return bridge.beginAgentLoad(args);
    if (method === 'agent.load.events') { bridge.appendAgentLoad(args); return null; }
    if (method === 'agent.load.abort') { bridge.abortAgentLoad(args); return null; }
    if (method === 'agent.load.finish') { await bridge.finishAgentLoad(args); return null; }
    if (method === 'agent.tool') return bridge.agentTool(args, signal);
    if (method === 'agent.command') return bridge.agentCommand(args, signal);
    if (method === 'agent.step-decision.read') return bridge.readStepDecision(args);
    if (method === 'agent.before-step') return bridge.agentBeforeStep(args, signal);
    if (method === 'agent.fork.begin') { bridge.forks.begin(args); return null; }
    if (method === 'agent.fork.events') { bridge.forks.append(args); return null; }
    if (method === 'agent.fork.finish') return bridge.forks.finish(args, signal);
    if (method === 'agent.fork.read') return bridge.forks.read(args);
    if (method === 'agent.fork.release') { bridge.forks.release(args.operation_id); return null; }
    if (method === 'session.load') { await bridge.load(args); return null; }
    if (method === 'session.project') return bridge.project(args.sessionId);
    if (method === 'tools.describe') return bridge.describe(args.sessionId);
    if (method === 'session.flush') return bridge.flush(args.sessionId, args.cursor);
    if (method === 'tool.execute') return bridge.tool(args.sessionId, args.operationId, args.name, args.arguments, signal);
    if (method === 'command.execute') return bridge.command(args.sessionId, args.operationId, args.name, args.input, signal);
    if (method === 'step.prepare') return bridge.beforeStep(args.sessionId, args.operationId, signal);
    if (method === 'operation.receipt') return await bridge.receipt(args.sessionId, args.operationId, args.token, args.outcome, args.revision) ?? null;
    if (method === 'operation.abandon') { await bridge.abandon(args.sessionId, args.operationId); return null; }
    throw new Error('unsupported bridge method');
  } };
}
