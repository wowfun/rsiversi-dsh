/** Finite canonical journal reads through one generation-fenced RSI Session. */
export class JournalWindow {
  constructor(read, session) { this.read = read; this.session = session; this.closed = false; }
  close() { this.closed = true; }
  async resource(id, signal) {
    if (this.closed) throw new Error('Session occurrence retired');
    signal?.throwIfAborted();
    const request = { kind: 'read', source: 'rsi.extension.journal', id };
    const response = await this.read(request);
    signal?.throwIfAborted();
    if (this.closed || response.session_id !== this.session || response.request?.id !== id || response.value?.kind !== 'read')
      throw new Error('Journal response does not belong to this Session');
    return JSON.parse(response.value.text);
  }
  async head(signal) {
    const head = await this.resource('head', signal);
    if (!Array.isArray(head.segments) || head.segments.length > 256) throw new Error('Invalid journal head');
    return head;
  }
  async page(head, before = Infinity, count = 16, signal) {
    const segments = head.segments.filter(segment => segment.first < before).slice(-count);
    const chunks = [];
    for (const segment of segments) {
      const events = await this.resource(segment.sha256, signal);
      if (!Array.isArray(events) || events.length !== segment.count) throw new Error('Invalid journal segment');
      chunks.push(events.filter(event => event.seq < before));
    }
    const entries = chunks.flat();
    return { entries, hasMore: segments.length > 0 && segments[0] !== head.segments[0] };
  }
}
