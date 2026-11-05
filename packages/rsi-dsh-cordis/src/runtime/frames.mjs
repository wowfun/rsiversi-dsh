export const MAX_FRAME_BYTES = 1024 * 1024;
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const methodName = /^[a-zA-Z0-9._/-]{1,128}$/;
const exactKeys = (value, keys) => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));

function validate(frame, generation) {
  if (!exactKeys(frame, ['generation', 'message']) || frame.generation !== generation) throw new Error('generation mismatch');
  const m = frame.message;
  if (!m || !Number.isSafeInteger(m.id) || m.id < 1) throw new Error('invalid correlation');
  if (m.kind === 'request') {
    if (!exactKeys(m, ['kind', 'id', 'method', 'payload']) || typeof m.method !== 'string' || !methodName.test(m.method)) throw new Error('invalid request');
  } else if (m.kind === 'cancel') {
    if (!exactKeys(m, ['kind', 'id'])) throw new Error('invalid cancellation');
  } else if (m.kind === 'reply') {
    if (!exactKeys(m, ['kind', 'id', 'result']) || !exactKeys(m.result, ['status', 'value'])) throw new Error('invalid reply');
    if (m.result.status === 'error') {
      if (typeof m.result.value !== 'string' || !m.result.value || Buffer.byteLength(m.result.value) > 4096) throw new Error('invalid error');
    } else if (m.result.status !== 'ok') throw new Error('invalid result status');
  } else throw new Error('unknown frame');
  return m;
}

export class WireFrames {
  #generation;
  #decoder = new TextDecoder('utf-8', {fatal: true});
  #partial;
  #used = 0;

  constructor(generation) {
    if (typeof generation !== 'string' || !identifier.test(generation)) throw new Error('invalid generation');
    this.#generation = generation;
  }

  *read(input) {
    const chunk = Buffer.isBuffer(input) ? input : Buffer.from(input);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const size = this.#used + end - start;
      if (size > MAX_FRAME_BYTES) throw new Error('frame capacity');

      let frame = chunk.subarray(start, end);
      if (newline < 0 || this.#used) {
        // Keep our own incomplete bytes. Geometric growth bounds both copying
        // and retained objects when the writer sends just one byte at a time.
        if (!this.#partial || size > this.#partial.length) {
          const capacity = Math.max(size, Math.min(MAX_FRAME_BYTES, (this.#partial?.length ?? 512) * 2));
          const next = Buffer.allocUnsafe(capacity);
          this.#partial?.copy(next, 0, 0, this.#used);
          this.#partial = next;
        }
        frame.copy(this.#partial, this.#used);
        this.#used = size;
        if (newline < 0) return;
        frame = this.#partial.subarray(0, size);
        this.#partial = undefined;
        this.#used = 0;
      }
      yield validate(JSON.parse(this.#decoder.decode(frame)), this.#generation);
      start = newline + 1;
    }
  }

  encode(message) {
    const frame = {generation: this.#generation, message};
    validate(frame, this.#generation);
    const bytes = Buffer.from(JSON.stringify(frame) + '\n');
    if (bytes.length - 1 > MAX_FRAME_BYTES) throw new Error('output capacity');
    return bytes;
  }
}
