import {MessageFrames,WireFrames} from './frames.mjs';

export const MAX_PENDING = 64;
const requestClass = method => method === 'extension.ping' ? 'ping' : method === 'extension.close' ? 'close' : 'business';
const capacity = kind => kind === 'business' ? MAX_PENDING : 1;
function countClass(entries, kind) {
  let count = 0;
  for (const entry of entries) if (entry.kind === kind) count++;
  return count;
}
/** The peer finished handling the request and returned an error response. */
export class RemoteRequestError extends Error {}
/** Independent input/output pumps; no request holds either pump while awaiting a callback. */
export class Peer {
  #input; #output; #frames; #handler; #port; #drainOnCancel;
  #pending = new Map(); #incoming = new Map(); #next = 0; #lastIncoming = 0;
  #failure; #queue = []; #writing = false; #timer; #closing = false;
  #onData; #onEnd; #onError; #onClose;
  constructor({ input, output, port, generation, handler, onClose = () => {}, drainOnCancel = () => false }) {
    this.#frames = port ? new MessageFrames(generation) : new WireFrames(generation);
    this.#port = port;
    this.#input = port ?? input; this.#output = port ?? output;
    this.#handler = handler; this.#onClose = onClose; this.#drainOnCancel = drainOnCancel;
    this.#onData = chunk => {
      try {
        for (const message of this.#frames.read(chunk)) {
          this.#dispatch(message);
          if (this.closed) break;
        }
      } catch (error) { this.close(error); }
    };
    this.#onEnd = () => this.close(new Error('unexpected extension EOF'));
    this.#onError = error => this.close(error);
    if (port) {
      port.on('message', this.#onData); port.on('close', this.#onEnd); port.on('messageerror', this.#onError);
    } else {
      input.on('data', this.#onData); input.on('end', this.#onEnd); input.on('error', this.#onError);
      output.on('error', this.#onError);
    }
  }
  get closed() { return this.#failure !== undefined; }
  #send(message) {
    if (this.#failure) throw this.#failure;
    const frame = {bytes: this.#frames.encode(message), id: message.id, reply: message.kind === 'reply'};
    if (this.#port) {
      if (frame.reply) this.#incoming.delete(frame.id);
      this.#port.postMessage(frame.bytes);
      this.#written(frame); return;
    }
    // Each outbound slot retains request + cancel; each inbound slot retains one reply.
    if (this.#queue.length >= (MAX_PENDING + 2) * 3) throw new Error('output capacity');
    this.#queue.push(frame);
    this.#pump();
  }
  #pump() {
    if (this.#writing || this.closed) return;
    this.#writing = true;
    const next = () => {
      if (this.closed) { this.#writing = false; return; }
      const frame = this.#queue.shift();
      if (!frame) { this.#writing = false; return; }
      if (frame.reply) this.#incoming.delete(frame.id);
      this.#output.write(frame.bytes, error => {
        if (error) this.close(error);
        else { this.#written(frame); next(); }
      });
    };
    next();
  }
  #written(frame) {
    if (frame.reply) return;
    const entry = this.#pending.get(frame.id);
    if (entry) { entry.writes--; this.#settle(frame.id, entry); }
  }
  #settle(id, entry) {
    if (entry.writes || !entry.replied) return;
    this.#pending.delete(id);
    if (entry.result.status === 'ok') entry.resolve(entry.result.value);
    else entry.reject(new RemoteRequestError(entry.result.value));
  }
  #scheduleDeadline() {
    clearTimeout(this.#timer); this.#timer = undefined;
    let next = Infinity;
    for (const entry of this.#pending.values()) if (entry.deadline !== undefined) next = Math.min(next, entry.deadline);
    if (next === Infinity) return;
    this.#timer = setTimeout(() => {
      const now = performance.now();
      for (const entry of this.#pending.values()) {
        if (entry.deadline !== undefined && entry.deadline <= now) { this.close(new Error('cancellation did not settle')); return; }
      }
      this.#scheduleDeadline();
    }, Math.max(0, next - performance.now()));
    this.#timer.unref();
  }
  request(method, payload, { signal, drainOnCancel = this.#drainOnCancel(method) } = {}) {
    if (this.closed) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(signal.reason);
    const kind = requestClass(method);
    if (this.#closing && kind !== 'close') return Promise.reject(new Error('extension closing'));
    if (countClass(this.#pending.values(), kind) >= capacity(kind) || this.#next >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error('request capacity'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, kind, writes: 1, replied: false, deadline: undefined, dispose: () => {} };
      const abort = () => {
        if (!this.#pending.has(id) || entry.replied) return;
        if (!drainOnCancel) {
          entry.reject(signal.reason ?? new Error('cancelled'));
          entry.resolve = entry.reject = () => {};
        }
        entry.writes++;
        if (!drainOnCancel) entry.deadline = performance.now() + 5000;
        try { this.#send({ kind: 'cancel', id }); } catch (error) { this.close(error); return; }
        if (!drainOnCancel) this.#scheduleDeadline();
      };
      entry.dispose = () => { signal?.removeEventListener('abort', abort); entry.deadline = undefined; };
      this.#pending.set(id, entry);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.#send({ kind: 'request', id, method, payload });
        // Once admitted, a failed/cancelled close cannot undo remote teardown.
        if (kind === 'close') this.#closing = true;
      }
      catch (error) { this.#pending.delete(id); entry.dispose(); reject(error); }
    });
  }
  #dispatch(m) {
    if (m.kind === 'reply') {
      const pending = this.#pending.get(m.id);
      if (!pending || pending.replied) throw new Error('unknown reply');
      const timed = pending.deadline !== undefined;
      pending.replied = true; pending.result = m.result; pending.dispose();
      this.#settle(m.id, pending);
      if (timed) this.#scheduleDeadline();
    } else if (m.kind === 'cancel') {
      if (m.id > this.#lastIncoming) throw new Error('unknown cancellation');
      this.#incoming.get(m.id)?.controller.abort(new Error('cancelled'));
    } else {
      if (m.id <= this.#lastIncoming) throw new Error('reused request identity');
      const kind = requestClass(m.method);
      if (countClass(this.#incoming.values(), kind) >= capacity(kind)) throw new Error('incoming capacity');
      this.#lastIncoming = m.id;
      const controller = new AbortController();
      this.#incoming.set(m.id, {kind, controller});
      const work = Promise.resolve().then(() => this.#handler(m.method, m.payload, controller.signal));
      const completed = this.#drainOnCancel(m.method) ? work : Promise.race([work,
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      ]);
      completed.then(
        value => ({ status: 'ok', value: value ?? null }),
        error => ({ status: 'error', value: String(error?.message ?? error).slice(0, 1000) || 'request failed' }),
      ).then(result => {
        if (!this.closed) this.#send({ kind: 'reply', id: m.id, result });
      }).catch(error => this.close(error));
    }
  }
  close(error = new Error('extension closed')) {
    if (this.closed) return;
    this.#failure = error;
    clearTimeout(this.#timer); this.#timer = undefined;
    if (this.#port) {
      this.#port.off('message', this.#onData); this.#port.off('close', this.#onEnd); this.#port.off('messageerror', this.#onError);
      this.#port.close();
    } else {
      this.#input.off('data', this.#onData); this.#input.off('end', this.#onEnd); this.#input.off('error', this.#onError);
    }
    // Keep the output error listener while an already accepted write drains.
    for (const p of this.#pending.values()) { p.dispose(); p.reject(error); }
    this.#pending.clear();
    for (const {controller} of this.#incoming.values()) controller.abort(error);
    this.#incoming.clear(); this.#queue = []; this.#frames = undefined;
    this.#onClose(error);
  }
}
