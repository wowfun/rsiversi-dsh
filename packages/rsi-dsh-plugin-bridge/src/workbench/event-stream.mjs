/** The release's passive ready/event contract, driven by the owning Cordis scope. */
export async function* observeSessionEvents(ctx, id, signal, {RemoteError, Deque}) {
  signal.throwIfAborted();
  const pending = new Deque();
  let wake, closed = false, first, next;
  const releases = [];
  function close() {
    if (closed) return;
    closed = true;
    pending.clear();
    wake?.();
    for (const release of releases.splice(0).reverse()) void release();
  }
  function recordFirst(seq) {
    first = first === undefined ? seq : Math.min(first, seq);
  }
  try {
    signal.addEventListener('abort', close, {once: true});
    releases.push(() => signal.removeEventListener('abort', close));
    releases.push(ctx.effect(() => close, 'passive Session events'));
    releases.push(ctx.on('session/event', (session, event) => {
      if (session.id !== id) return;
      recordFirst(event.seq);
      pending.pushBack({event});
      wake?.();
    }, {global: true}));
    releases.push(ctx.on('session/created', session => {
      if (session.id !== id) return;
      if (session.firstLiveSeq < session.seq) recordFirst(session.firstLiveSeq);
      pending.pushFront({session, end: session.seq});
      wake?.();
    }, {global: true}));
    yield {type: 'ready'};
    while (!closed) {
      if (!pending.size) {
        await new Promise(resolve => { wake = resolve; });
        wake = undefined;
        continue;
      }
      const item = pending.popFront();
      next ??= first;
      const start = item.event?.seq ?? next ?? item.session.firstLiveSeq;
      const end = item.event ? start + 1 : item.end;
      for (let seq = start; seq < end; seq++) {
        if (closed) return;
        const event = item.event ?? item.session.eventAt(seq);
        if (next !== undefined && event.seq < next) continue;
        if (next !== undefined && event.seq !== next)
          throw new RemoteError('gateway/internal', 'session event stream skipped seq ' + next, {});
        next = event.seq + 1;
        yield {type: 'event', event};
      }
    }
  } finally {
    close();
  }
}
