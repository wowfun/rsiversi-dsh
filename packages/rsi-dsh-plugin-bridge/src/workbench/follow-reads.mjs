/** A pull-based follower rearms each source only after consuming its last read. */
export class FollowReads {
  #reads = new Map();
  #wake;

  watch(source, promise) {
    const read = {source};
    this.#reads.set(source, read);
    promise.then(value => {
      read.value = value;
      this.#wake?.();
    }, error => {
      read.error = error;
      this.#wake?.();
    });
  }

  forget(source) { this.#reads.delete(source); }

  async next() {
    for (;;) {
      for (const [source, read] of this.#reads) {
        if ('error' in read) throw read.error;
        if ('value' in read) {
          this.#reads.delete(source);
          return read;
        }
      }
      await new Promise(resolve => { this.#wake = resolve; });
      this.#wake = undefined;
    }
  }
}
