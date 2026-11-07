import {MessageFrames,WireFrames} from './frames.mjs';

export {MAX_FRAME_BYTES} from './frames.mjs';
export const MAX_PENDING = 64;
/** The peer finished handling the request and returned an error response. */
export class RemoteRequestError extends Error {}
/** Independent input/output pumps; no request holds either pump while awaiting a callback. */
export class Peer {
  #input; #output; #frames; #handler; #port;
  #pending = new Map(); #incoming = new Map(); #next = 0; #lastIncoming = 0;
  #failure; #queue = []; #writing = false;
  #onData; #onEnd; #onError; #onClose;
  constructor({ input, output, port, generation, handler, onClose = () => {} }) {
    this.#frames = port ? new MessageFrames(generation) : new WireFrames(generation);
    this.#port = port;
    this.#input = port ?? input; this.#output = port ?? output;
    this.#handler = handler; this.#onClose = onClose;
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
    if (this.#port) { this.#port.postMessage(this.#frames.encode(message)); return; }
    if (this.#queue.length >= MAX_PENDING * 2) throw new Error('output capacity');
    this.#queue.push(this.#frames.encode(message));
    this.#pump();
  }
  #pump() {
    if (this.#writing || this.closed) return;
    this.#writing = true;
    const next = () => {
      if (this.closed) { this.#writing = false; return; }
      const bytes = this.#queue.shift();
      if (!bytes) { this.#writing = false; return; }
      this.#output.write(bytes, error => {
        if (error) this.close(error);
        else next();
      });
    };
    next();
  }
  request(method, payload, { signal } = {}) {
    if (this.closed) return Promise.reject(this.#failure);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#pending.size >= MAX_PENDING || this.#next >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error('request capacity'));
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined, dispose: () => {} };
      const abort = () => {
        if (!this.#pending.has(id)) return;
        entry.reject(signal.reason ?? new Error('cancelled'));
        entry.resolve = entry.reject = () => {};
        try { this.#send({ kind: 'cancel', id }); } catch (error) { this.close(error); return; }
        entry.timer = setTimeout(() => this.close(new Error('cancellation did not settle')), 5000);
        entry.timer.unref();
      };
      entry.dispose = () => { signal?.removeEventListener('abort', abort); clearTimeout(entry.timer); };
      this.#pending.set(id, entry);
      signal?.addEventListener('abort', abort, { once: true });
      try { this.#send({ kind: 'request', id, method, payload }); }
      catch (error) { this.#pending.delete(id); entry.dispose(); reject(error); }
    });
  }
  #dispatch(m) {
    if (m.kind === 'reply') {
      const pending = this.#pending.get(m.id);
      if (!pending) throw new Error('unknown reply');
      this.#pending.delete(m.id); pending.dispose();
      if (m.result.status === 'ok') pending.resolve(m.result.value);
      else pending.reject(new RemoteRequestError(m.result.value));
    } else if (m.kind === 'cancel') {
      if (m.id > this.#lastIncoming) throw new Error('unknown cancellation');
      this.#incoming.get(m.id)?.abort(new Error('cancelled'));
    } else {
      if (m.id <= this.#lastIncoming) throw new Error('reused request identity');
      if (this.#incoming.size >= MAX_PENDING) throw new Error('incoming capacity');
      this.#lastIncoming = m.id;
      const controller = new AbortController();
      this.#incoming.set(m.id, controller);
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
      const work = Promise.resolve().then(() => this.#handler(m.method, m.payload, controller.signal));
      Promise.race([work, aborted]).then(
        value => ({ status: 'ok', value: value ?? null }),
        error => ({ status: 'error', value: String(error?.message ?? error).slice(0, 1000) || 'request failed' }),
      ).then(result => {
        this.#incoming.delete(m.id);
        if (!this.closed) this.#send({ kind: 'reply', id: m.id, result });
      }).catch(error => this.close(error));
    }
  }
  close(error = new Error('extension closed')) {
    if (this.closed) return;
    this.#failure = error;
    if (this.#port) {
      this.#port.off('message', this.#onData); this.#port.off('close', this.#onEnd); this.#port.off('messageerror', this.#onError);
      this.#port.close();
    } else {
      this.#input.off('data', this.#onData); this.#input.off('end', this.#onEnd); this.#input.off('error', this.#onError);
    }
    // Keep the output error listener while an already accepted write drains.
    for (const p of this.#pending.values()) { p.dispose(); p.reject(error); }
    this.#pending.clear();
    for (const controller of this.#incoming.values()) controller.abort(error);
    this.#incoming.clear(); this.#queue = []; this.#frames = undefined;
    this.#onClose(error);
  }
}
