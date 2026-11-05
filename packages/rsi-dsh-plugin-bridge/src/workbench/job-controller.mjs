/** The native Session admits the caller. The release controller owns job
 * visibility, cancellation, and each browser's non-consuming output stream. */
export function jobController(Controller,history) {
  async function admit(id,signal) {
    if(!await history.metadata(id,signal))throw Error('Session unavailable to caller');
  }
  return class extends Controller {
    async *list(request,signal) {
      await admit(request.sessionId,signal);
      yield* super.list(request,signal);
    }
    async *follow(request,signal) {
      if(request.sessionId!==undefined)await admit(request.sessionId,signal);
      yield* super.follow(request,signal);
    }
    async kill(request,signal) {
      await admit(request.sessionId,signal);
      return super.kill(request);
    }
  };
}
