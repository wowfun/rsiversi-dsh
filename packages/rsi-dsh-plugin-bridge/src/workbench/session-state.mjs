/** The release reads a live Agent's inbox, or the event cursor of a detached Session. */
export async function readSessionState(ctx, history, RemoteError, id, signal) {
  signal.throwIfAborted();
  const agents = ctx.get('agents');
  let agent = agents.get(id), session = agent?.session;
  if (!agent) {
    const meta = await history.metadata(id, signal);
    if (meta?.id === id && meta.cwd) session = await history.capture(id, meta, signal);
    signal.throwIfAborted();
    // Activation may complete while the native history is being read.
    agent = agents.get(id);
    if (agent) session = agent.session;
  }
  if (!session?.header.cwd)
    throw new RemoteError('session/not-found', 'session "' + id + '" not found', {sessionId:id});

  const pending = new Set();
  for (const {event, agentId} of ctx.get('typertGateway').getPendingRemoteEvents()) {
    if (String(agentId) === id)
      pending.add(event === 'approval/request' ? 'approval' : event === 'user-questions/request' ? 'question' : 'other');
  }
  const queue = agent ? [] : null;
  if (agent) {
    const append = (message, placement) => queue.push({
      id:message.id, placement, content:message.content,
      ...(message.source.kind === 'user' && 'rpcId' in message.source ? {rpcId:message.source.rpcId} : {}),
    });
    for (const message of agent.inbox.nextTurn) append(message, 'queued');
    for (const message of agent.inbox.nextStep) append(message, message.source.kind === 'user' ? 'steering' : 'context');
  }
  return {cursor:session.seq - 1, active:!!agent, running:agent?.status === 'running', queue, pendingInput:[...pending]};
}

/** Coalesce invalidations and discard any read overtaken by a newer revision. */
export async function* observeSessionState(ctx, id, signal, read) {
  signal.throwIfAborted();
  const lifetime = new AbortController(), stop = AbortSignal.any([signal, lifetime.signal]);
  let revision = 0, wake;
  const releases = [];
  function close() {
    lifetime.abort();
    wake?.();
    for (const release of releases.splice(0).reverse()) void release();
  }
  function changed(sessionId) {
    if (sessionId === id) { revision++; wake?.(); }
  }
  try {
    signal.addEventListener('abort', close, {once:true});
    releases.push(() => signal.removeEventListener('abort', close));
    releases.push(ctx.effect(() => close, 'passive Session state'));
    for (const event of ['session/event', 'session/created', 'session/disposed'])
      releases.push(ctx.on(event, session => changed(session.id), {global:true}));
    for (const event of ['agent/status', 'agent/created', 'agent/disposed'])
      releases.push(ctx.on(event, ({agent}) => changed(agent.id), {global:true}));
    while (!stop.aborted) {
      const cut = revision, state = await read(stop);
      if (stop.aborted) return;
      if (cut !== revision) continue;
      yield state;
      if (cut === revision && !stop.aborted) await new Promise(resolve => { wake = resolve; });
      wake = undefined;
    }
  } finally { close(); }
}
