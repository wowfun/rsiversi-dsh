/** The public Plan setter always narrates. Approved silent exits retain their intent here. */
export class PlanIntentAdapter {
  constructor(controller) {
    if (!(controller.pendingIntents instanceof WeakMap)) throw new Error('unsupported Plan private layout');
    this.controller = controller;
  }
  capture(session, causeIdentity) {
    const intent = this.controller.pendingIntents.get(session);
    if (intent === undefined) return null;
    if (typeof intent.active !== 'boolean' || typeof intent.narrate !== 'boolean') throw new Error('invalid private Plan intent');
    return { active: intent.active, narrate: intent.narrate, causeIdentity };
  }
  restore(session, intent) {
    if (intent === null) { this.controller.pendingIntents.delete(session); return; }
    if (typeof intent.active !== 'boolean' || typeof intent.narrate !== 'boolean'
        || typeof intent.causeIdentity !== 'string' || !intent.causeIdentity || intent.causeIdentity.length > 256) throw new Error('invalid durable Plan intent');
    this.controller.pendingIntents.set(session, { active: intent.active, narrate: intent.narrate });
  }
}
