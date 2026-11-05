// Generated from DeepSeek Harness fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159. See LICENSE.
import {
  WeakMapWithValues,
  assertNever,
  isSurfaceEvent
} from "./shared/WLBUY26R.mjs";

// packages/client/ui-conversation/src/client/conversation/assembly.ts
import { Service as Service2 } from "@deepseek-ai/cordis";
import {
  createSnapshotStore as createSnapshotStore2
} from "@deepseek-ai/dsh-client-store";

// packages/client/ui-conversation/src/client/contract/request-inspection.ts
function inspectRequestPrompt(previous, event, system) {
  const header = event.data.header;
  const rawTools = header.tools;
  const prompt = {
    config: header.config,
    system: system?.text ?? "",
    tools: Array.isArray(rawTools) ? rawTools : []
  };
  if (previous === void 0 && event.data.reason !== "initial") return { prompt };
  const systemChanged = previous !== void 0 && previous.system !== prompt.system && system?.update !== true;
  const toolsChanged = previous !== void 0 && JSON.stringify(previous.tools) !== JSON.stringify(prompt.tools);
  if (previous !== void 0 && !systemChanged && !toolsChanged) return { prompt };
  const origin = system !== void 0 && (previous === void 0 || systemChanged) ? system : event;
  return {
    prompt,
    change: {
      seq: origin.seq,
      time: origin.time,
      kind: previous === void 0 ? "initial" : systemChanged && toolsChanged ? "system-and-tools" : systemChanged ? "system" : "tools",
      ...previous === void 0 ? {} : { previous }
    }
  };
}

// packages/client/ui-conversation/src/client/contract/system-prompt.ts
function inspectSystemPrompt(previous, event) {
  const op = isSurfaceEvent(event) ? event.surfaceOp : void 0;
  const firstSeq = previous?.firstSeq ?? event.seq;
  let nodes = previous?.nodes ?? [];
  let replacements = previous?.replacements ?? /* @__PURE__ */ new Map();
  const unknownEndpoint = (seq) => seq < firstSeq && !replacements.has(seq);
  const uncertain = previous?.uncertain === true || op !== void 0 && op !== "append" && (unknownEndpoint(op.startSeq) || unknownEndpoint(op.endSeq));
  if (uncertain) {
    return { firstSeq, uncertain, nodes: [], replacements: /* @__PURE__ */ new Map(), effective: void 0, introduced: void 0 };
  }
  let position = event.seq;
  if (op !== void 0 && op !== "append") {
    position = replacements.get(op.startSeq) ?? op.startSeq;
    const end = replacements.get(op.endSeq) ?? op.endSeq;
    nodes = nodes.filter((item) => item.position < position || item.position > end);
    const retained = new Map([...replacements].filter(([, value]) => value < position || value > end));
    retained.set(event.seq, position);
    replacements = retained;
  }
  const introduced = event.type === "system/message" ? {
    seq: event.seq,
    time: event.time,
    turn: event.data.turn,
    step: event.data.step,
    text: event.data.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(""),
    update: op === "append" && previous?.nodes.some((item) => item.node.text !== "") === true
  } : void 0;
  if (introduced !== void 0) {
    nodes = [...nodes, { position, node: introduced }].sort((a, b) => a.position - b.position);
  }
  const surviving = nodes.findLast((item) => item.node.text !== "")?.node;
  const effective = surviving === previous?.nodes.findLast((item) => item.node.text !== "")?.node ? previous?.effective : introduced !== void 0 && introduced === surviving ? introduced : {
    seq: event.seq,
    time: event.time,
    turn: surviving?.turn ?? 0,
    step: surviving?.step ?? 0,
    text: surviving?.text ?? "",
    update: false
  };
  return { firstSeq, uncertain, nodes, replacements, effective, introduced };
}

// packages/client/ui-conversation/src/client/contract/conversation.ts
function conversationContextKey(kind, id) {
  return `${kind.length}:${kind}${id}`;
}

// packages/client/ui-conversation/src/client/conversation/group-store.ts
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
function sameNodeReference(left, right) {
  return left.key === right.key && left.groupPart === right.groupPart;
}
function sameEntry(left, right) {
  return left.kind === right.kind && left.key === right.key && (left.kind === "group" || right.kind === "node" && left.groupPart === right.groupPart);
}
function reuseReferences(previous, next, equal) {
  return previous === next || previous.length === next.length && previous.every((value, index) => equal(value, next[index])) ? previous : next;
}
var ConversationGroupStore = class {
  root = [];
  rootGroups = /* @__PURE__ */ new Set();
  groups = /* @__PURE__ */ new Map();
  placements = /* @__PURE__ */ new Map();
  sources = /* @__PURE__ */ new Map();
  dirty = /* @__PURE__ */ new Set();
  /** @returns the identity-stable ordered root references. */
  get entries() {
    return this.root;
  }
  groupSource(key) {
    let source = this.sources.get(key);
    if (source === void 0) {
      const publication = createSnapshotStore(this.groups.get(key));
      source = {
        publication,
        observable: {
          getSnapshot: () => this.groups.get(key),
          subscribe: (listener) => publication.subscribe(listener)
        }
      };
      this.sources.set(key, source);
    }
    return source.observable;
  }
  /**
   * Install one validated update without notifying readers.
   * @param update - root replacement and complete or incremental group records.
   * @param readNode - synchronous reader of the current target Nodes.
   */
  prepareAndInstall(update, readNode) {
    const nextRoot = update.entries === void 0 ? this.root : reuseReferences(this.root, update.entries, sameEntry);
    const nextRootGroups = nextRoot === this.root ? this.rootGroups : this.collectRootGroups(nextRoot);
    const { upserts, removes } = this.collectChanges(update);
    const replaceReferences = update.groups.kind === "replace";
    const size = this.groups.size - removes.size + [...upserts.keys()].filter((key) => !this.groups.has(key)).length;
    if (size !== nextRootGroups.size) {
      throw new Error("conversation group records and root references must correspond one-to-one");
    }
    for (const key of removes) {
      if (nextRootGroups.has(key)) throw new Error(`conversation group "${key}" is still referenced`);
    }
    for (const key of upserts.keys()) {
      if (!nextRootGroups.has(key)) throw new Error(`conversation group "${key}" has no root reference`);
    }
    if (nextRootGroups !== this.rootGroups) {
      for (const key of nextRootGroups) {
        if (!upserts.has(key) && !this.groups.has(key)) {
          throw new Error(`conversation root references missing group "${key}"`);
        }
      }
    }
    const affectedParts = /* @__PURE__ */ new Map();
    const partsOf = (key) => {
      let parts = affectedParts.get(key);
      if (parts === void 0) {
        parts = new Set(this.placements.get(key));
        affectedParts.set(key, parts);
      }
      return parts;
    };
    const removeReference = (reference) => {
      partsOf(reference.key).delete(reference.groupPart);
    };
    const addReference = (reference) => {
      if (readNode(reference.key) === void 0) {
        throw new Error(`conversation group references missing Node "${reference.key}"`);
      }
      const parts = partsOf(reference.key);
      if (parts.has(reference.groupPart) || reference.groupPart === void 0 && parts.size > 0 || parts.has(void 0)) {
        throw new Error(`conversation Node "${reference.key}" has overlapping rendering positions`);
      }
      parts.add(reference.groupPart);
    };
    if (replaceReferences || nextRoot !== this.root) {
      for (const entry of this.root) if (entry.kind === "node") removeReference(entry);
    }
    for (const key of removes) {
      for (const member of this.groups.get(key).members) removeReference(member);
    }
    for (const [key, next] of upserts) {
      const previous = this.groups.get(key);
      if (previous !== void 0 && (replaceReferences || previous.members !== next.members)) {
        for (const member of previous.members) removeReference(member);
      }
    }
    if (replaceReferences || nextRoot !== this.root) {
      for (const entry of nextRoot) if (entry.kind === "node") addReference(entry);
    }
    for (const [key, next] of upserts) {
      if (replaceReferences || this.groups.get(key)?.members !== next.members) {
        for (const member of next.members) addReference(member);
      }
    }
    for (const [key, parts] of affectedParts) {
      if (parts.size === 0) this.placements.delete(key);
      else this.placements.set(key, parts);
    }
    for (const key of removes) {
      this.groups.delete(key);
      this.dirty.add(key);
    }
    for (const [key, next] of upserts) {
      if (this.groups.get(key) === next) continue;
      this.groups.set(key, next);
      this.dirty.add(key);
    }
    this.root = nextRoot;
    this.rootGroups = nextRootGroups;
  }
  /** Publish changed group sources after all related target data has been installed. */
  publish() {
    const keys = [...this.dirty];
    this.dirty.clear();
    for (const key of keys) this.sources.get(key)?.publication.set(this.groups.get(key));
  }
  /** Remove grouping without deleting its source Nodes; publication remains deferred. */
  clear() {
    this.prepareAndInstall(
      { entries: [], groups: { kind: "replace", snapshots: [] } },
      /* v8 ignore next -- an empty replacement never reads a Node reference. */
      () => void 0
    );
  }
  collectRootGroups(entries) {
    const keys = /* @__PURE__ */ new Set();
    for (const entry of entries) {
      if (entry.kind !== "group") continue;
      if (keys.has(entry.key)) throw new Error(`conversation group "${entry.key}" has duplicate root references`);
      keys.add(entry.key);
    }
    return keys;
  }
  collectChanges(update) {
    const upserts = /* @__PURE__ */ new Map();
    const removes = /* @__PURE__ */ new Set();
    const add = (snapshot) => {
      if (upserts.has(snapshot.key)) throw new Error(`conversation group "${snapshot.key}" has duplicate upserts`);
      const previous = this.groups.get(snapshot.key);
      if (previous === void 0) {
        upserts.set(snapshot.key, snapshot);
        return;
      }
      const members = reuseReferences(previous.members, snapshot.members, sameNodeReference);
      upserts.set(snapshot.key, previous.data === snapshot.data && previous.members === members ? previous : { ...snapshot, members });
    };
    switch (update.groups.kind) {
      case "replace":
        for (const snapshot of update.groups.snapshots) add(snapshot);
        for (const key of this.groups.keys()) if (!upserts.has(key)) removes.add(key);
        break;
      case "apply":
        for (const snapshot of update.groups.upserts) add(snapshot);
        for (const key of update.groups.removes) {
          if (removes.has(key)) throw new Error(`conversation group "${key}" has duplicate removals`);
          if (!this.groups.has(key)) throw new Error(`conversation group "${key}" cannot be removed because it is absent`);
          if (upserts.has(key)) throw new Error(`conversation group "${key}" cannot be upserted and removed together`);
          removes.add(key);
        }
        break;
      /* v8 ignore next 2 -- closed update union; TypeScript rejects other operation tags. */
      default:
        assertNever(update.groups);
    }
    return { upserts, removes };
  }
};

// packages/client/ui-conversation/src/client/conversation/location-index.ts
import { notifySubscribers } from "@deepseek-ai/dsh-client-store";
var MutableLocationDataSource = class {
  constructor(store, key) {
    this.store = store;
    this.key = key;
    this.published = store.get(key);
  }
  store;
  key;
  listeners = /* @__PURE__ */ new Set();
  published;
  getSnapshot = () => this.store.get(this.key);
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish() {
    const next = this.getSnapshot();
    if (this.published === next) return;
    this.published = next;
    notifySubscribers(this.listeners, `[ui-conversation] Location data ${this.key}`);
  }
};
var MutableLocationDataStore = class {
  constructor(markDirty) {
    this.markDirty = markDirty;
  }
  markDirty;
  entries = /* @__PURE__ */ new Map();
  sources = /* @__PURE__ */ new Map();
  dirtyKeys = /* @__PURE__ */ new Set();
  get(key) {
    return this.entries.get(key)?.value;
  }
  source(key) {
    let source = this.sources.get(key);
    if (source === void 0) {
      source = new MutableLocationDataSource(this, key);
      this.sources.set(key, source);
    }
    return source;
  }
  remove(owner, key) {
    const current = this.entries.get(key);
    if (current?.owner !== owner) return false;
    this.entries.delete(key);
    this.changed(key);
    return true;
  }
  set(owner, key, value) {
    const current = this.entries.get(key);
    if (current !== void 0 && current.owner !== owner) {
      throw new Error(`conversation Location data "${key}" is already owned by ${current.owner}`);
    }
    if (current?.value === value) return false;
    this.entries.set(key, { owner, value });
    this.changed(key);
    return true;
  }
  replace(entries) {
    const changedKeys = [];
    for (const key of /* @__PURE__ */ new Set([...this.entries.keys(), ...entries.keys()])) {
      const current = this.entries.get(key);
      const next = entries.get(key);
      if (current?.owner !== next?.owner || current?.value !== next?.value) changedKeys.push(key);
    }
    if (changedKeys.length === 0) return false;
    this.entries = new Map(entries);
    for (const key of changedKeys) this.changed(key);
    return true;
  }
  publish() {
    const dirty = [...this.dirtyKeys];
    this.dirtyKeys.clear();
    for (const key of dirty) this.sources.get(key)?.publish();
  }
  changed(key) {
    this.dirtyKeys.add(key);
    this.markDirty(this);
  }
};
var SESSION_LOCATION = { kind: "session" };
var UNRESOLVED_LOCATION = { kind: "unresolved" };
function payloadCoordinates(event) {
  const data = event.data;
  if (data.turn === null) return { session: true, location: void 0 };
  const turn = Number.isSafeInteger(data.turn) && data.turn >= 0 ? data.turn : void 0;
  const step = Number.isSafeInteger(data.step) && data.step >= 0 ? data.step : void 0;
  if (turn === void 0) return step === void 0 ? { location: void 0 } : { step, location: void 0 };
  return step === void 0 ? { turn, location: void 0 } : { turn, step, location: void 0 };
}
function sameReferences(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function sameStep(left, right) {
  return left !== void 0 && left.start === right.start && left.end === right.end && left.status === right.status && left.data === right.data;
}
function sameTurn(left, right) {
  return left !== void 0 && left.start === right.start && left.end === right.end && left.status === right.status && left.data === right.data && sameReferences(left.steps, right.steps);
}
function sameLocation(left, right) {
  if (left === void 0 || right === void 0 || left.kind !== right.kind) return left === right;
  if (left.kind === "session" || left.kind === "unresolved") return true;
  if (right.kind === "session" || right.kind === "unresolved") return false;
  if (left.kind === "turn" || right.kind === "turn") {
    return left.kind === "turn" && right.kind === "turn" && left.turn === right.turn;
  }
  return left.turn === right.turn && left.step === right.step;
}
var ConversationLocationIndex = class {
  coordinates = /* @__PURE__ */ new Map();
  seqsByTurn = /* @__PURE__ */ new Map();
  stepsByTurn = /* @__PURE__ */ new Map();
  timeline = { turnOrder: [], turns: /* @__PURE__ */ new Map() };
  turnDataStores = /* @__PURE__ */ new Map();
  stepDataStores = /* @__PURE__ */ new Map();
  dirtyDataStores = /* @__PURE__ */ new Set();
  changedTurns = /* @__PURE__ */ new Set();
  currentTurn;
  currentStep;
  /**
   * Return the current reference-stable timeline.
   * @returns current timeline snapshot.
   */
  snapshot() {
    return this.timeline;
  }
  /**
   * Drain the Turn changes accumulated for one assembly flush.
   * @returns Turn identities changed since the preceding drain.
   */
  takeChangedTurns() {
    const turns = [...this.changedTurns];
    this.changedTurns.clear();
    return turns;
  }
  /**
   * Replace all Definition-owned Location values while preserving reader identities.
   * @param entries - complete current set of Definition-owned Location values.
   * @returns whether any published Location data changed.
   */
  replaceData(entries) {
    const turns = /* @__PURE__ */ new Map();
    const steps = /* @__PURE__ */ new Map();
    for (const { owner, data } of entries) {
      const values = data.kind === "turn" ? turns.get(data.turn) ?? /* @__PURE__ */ new Map() : steps.get(stepDataKey(data.turn, requireStep(data))) ?? /* @__PURE__ */ new Map();
      const current = values.get(data.key);
      if (current !== void 0 && current.owner !== owner) {
        throw new Error(`conversation Location data "${data.key}" is already owned by ${current.owner}`);
      }
      values.set(data.key, { owner, value: data.value });
      if (data.kind === "turn") turns.set(data.turn, values);
      else steps.set(stepDataKey(data.turn, requireStep(data)), values);
    }
    let changed = false;
    for (const turn of /* @__PURE__ */ new Set([...this.turnDataStores.keys(), ...turns.keys()])) {
      changed = this.mutableTurnData(turn).replace(turns.get(turn) ?? /* @__PURE__ */ new Map()) || changed;
    }
    for (const step of /* @__PURE__ */ new Set([...this.stepDataStores.keys(), ...steps.keys()])) {
      changed = this.mutableStepData(step).replace(steps.get(step) ?? /* @__PURE__ */ new Map()) || changed;
    }
    return changed;
  }
  /**
   * Apply changed Context publications without rebuilding Turn/Step membership.
   * @param changes - incremental removals and replacements from published Contexts.
   * @returns whether any published Location data changed.
   */
  applyData(changes) {
    let changed = false;
    for (const change of changes) {
      const previous = change.previous;
      if (previous === null) continue;
      changed = this.storeFor(previous).remove(change.owner, previous.key) || changed;
    }
    for (const change of changes) {
      const next = change.next;
      if (next === null) continue;
      changed = this.storeFor(next).set(change.owner, next.key, next.value) || changed;
    }
    return changed;
  }
  /** Publish committed Location-data changes to their keyed sources. */
  publishData() {
    const dirty = [...this.dirtyDataStores];
    this.dirtyDataStores.clear();
    for (const store of dirty) store.publish();
  }
  /**
   * Resolve the latest Location for one event.
   * @param event - event already ingested into this index.
   * @returns current Location, falling back to session when it has no Turn/Step affinity.
   */
  locationOf(event) {
    return this.coordinates.get(event.seq)?.location ?? SESSION_LOCATION;
  }
  /**
   * Rebuild timeline facts after replace/prepend or a boundary append.
   * @param entries - complete current window in ascending seq order.
   * @returns seqs whose resolved Location changed.
   */
  rebuild(entries) {
    const previousCoordinates = this.coordinates;
    const turns = /* @__PURE__ */ new Map();
    const coordinates = /* @__PURE__ */ new Map();
    let currentTurn;
    let currentStep;
    const turnDraft = (turn, seq) => {
      let draft = turns.get(turn);
      if (draft === void 0) {
        draft = { turn, firstSeq: seq, steps: /* @__PURE__ */ new Map() };
        turns.set(turn, draft);
      } else {
        draft.firstSeq = Math.min(draft.firstSeq, seq);
      }
      return draft;
    };
    const stepDraft = (turn, step, seq) => {
      const owner = turnDraft(turn, seq);
      let draft = owner.steps.get(step);
      if (draft === void 0) {
        draft = { turn, step, firstSeq: seq };
        owner.steps.set(step, draft);
      } else {
        draft.firstSeq = Math.min(draft.firstSeq, seq);
      }
      return draft;
    };
    for (const { event } of entries) {
      const explicit = payloadCoordinates(event);
      if (event.type === "turn/start") {
        currentTurn = event.data.turn;
        currentStep = void 0;
      }
      if (event.type === "step/start") {
        currentTurn = event.data.turn;
        currentStep = event.data.step;
      }
      if (explicit.session !== true && explicit.turn !== void 0) {
        if (currentTurn !== explicit.turn) currentStep = void 0;
        currentTurn = explicit.turn;
        if (explicit.step !== void 0) currentStep = explicit.step;
      }
      const turn = explicit.session === true ? void 0 : explicit.turn ?? currentTurn;
      const step = explicit.session === true || event.type === "turn/start" || event.type === "turn/end" ? void 0 : explicit.step ?? (turn === currentTurn ? currentStep : void 0);
      coordinates.set(event.seq, {
        ...turn === void 0 ? {} : { turn },
        ...turn === void 0 || step === void 0 ? {} : { step },
        location: void 0
      });
      if (turn !== void 0) turnDraft(turn, event.seq);
      if (turn !== void 0 && step !== void 0) stepDraft(turn, step, event.seq);
      if (event.type === "turn/start") {
        turnDraft(event.data.turn, event.seq).start = event;
      } else if (event.type === "turn/end") {
        turnDraft(event.data.turn, event.seq).end = event;
      } else if (event.type === "step/start") {
        stepDraft(event.data.turn, event.data.step, event.seq).start = event;
      } else if (event.type === "step/end") {
        stepDraft(event.data.turn, event.data.step, event.seq).end = event;
      }
      if (event.type === "step/end" && currentTurn === event.data.turn && currentStep === event.data.step) {
        currentStep = void 0;
      }
      if (event.type === "turn/end" && currentTurn === event.data.turn) {
        currentTurn = void 0;
        currentStep = void 0;
      }
    }
    const previousTurns = this.timeline.turns;
    const nextTurns = /* @__PURE__ */ new Map();
    const orderedDrafts = [...turns.values()].sort((left, right) => left.firstSeq - right.firstSeq);
    for (const draft of orderedDrafts) {
      const previousTurn = previousTurns.get(draft.turn);
      const previousSteps = new Map(previousTurn?.steps.map((step) => [step.step, step]) ?? []);
      const steps = [...draft.steps.values()].sort((left, right) => left.firstSeq - right.firstSeq).map((candidate) => {
        const value2 = {
          turn: candidate.turn,
          step: candidate.step,
          start: candidate.start,
          end: candidate.end,
          status: candidate.end !== void 0 ? "closed" : candidate.start === void 0 ? "unknown" : "open",
          data: this.stepData(candidate.turn, candidate.step)
        };
        const previous = previousSteps.get(candidate.step);
        return sameStep(previous, value2) ? previous : value2;
      });
      const value = {
        turn: draft.turn,
        start: draft.start,
        end: draft.end,
        status: draft.end !== void 0 ? "closed" : draft.start === void 0 ? "unknown" : "open",
        steps,
        data: this.turnData(draft.turn)
      };
      nextTurns.set(draft.turn, sameTurn(previousTurn, value) ? previousTurn : value);
    }
    const nextOrder = orderedDrafts.map((draft) => draft.turn);
    const turnOrder = this.timeline.turnOrder.length === nextOrder.length && this.timeline.turnOrder.every((turn, index) => turn === nextOrder[index]) ? this.timeline.turnOrder : nextOrder;
    let sameMap = previousTurns.size === nextTurns.size;
    if (sameMap) {
      for (const [turn, value] of nextTurns) {
        if (previousTurns.get(turn) !== value) {
          sameMap = false;
          break;
        }
      }
    }
    for (const turn of /* @__PURE__ */ new Set([...previousTurns.keys(), ...nextTurns.keys()])) {
      if (previousTurns.get(turn) !== nextTurns.get(turn)) this.changedTurns.add(turn);
    }
    this.timeline = sameMap && turnOrder === this.timeline.turnOrder ? this.timeline : { turnOrder, turns: nextTurns };
    this.stepsByTurn.clear();
    for (const [number, turn] of this.timeline.turns) {
      this.stepsByTurn.set(number, new Map(turn.steps.map((step) => [step.step, step])));
    }
    this.coordinates = coordinates;
    this.seqsByTurn = /* @__PURE__ */ new Map();
    for (const { event } of entries) {
      const coordinates2 = this.coordinates.get(event.seq);
      if (coordinates2.turn !== void 0) this.indexTurnSeq(coordinates2.turn, event.seq);
      coordinates2.location = this.resolve(event.seq);
    }
    this.currentTurn = currentTurn;
    this.currentStep = currentStep;
    const changed = /* @__PURE__ */ new Set();
    for (const { event } of entries) {
      if (!sameLocation(
        previousCoordinates.get(event.seq)?.location,
        this.coordinates.get(event.seq)?.location
      )) {
        changed.add(event.seq);
      }
    }
    return changed;
  }
  /**
   * Append one Turn/Step boundary while revisiting only the owning Turn.
   * @param event - contiguous tail boundary event.
   * @returns seqs whose immutable Location reference changed.
   */
  appendBoundary(event) {
    if (event.type !== "turn/start" && event.type !== "turn/end" && event.type !== "step/start" && event.type !== "step/end") {
      throw new Error(`conversation Location boundary expected, received ${event.type}`);
    }
    const explicit = payloadCoordinates(event);
    if (event.type === "turn/start") {
      this.currentTurn = event.data.turn;
      this.currentStep = void 0;
    } else if (event.type === "step/start") {
      this.currentTurn = event.data.turn;
      this.currentStep = event.data.step;
    }
    if (explicit.turn !== void 0) {
      if (this.currentTurn !== explicit.turn) this.currentStep = void 0;
      this.currentTurn = explicit.turn;
      if (explicit.step !== void 0) this.currentStep = explicit.step;
    }
    const turnNumber = explicit.turn ?? this.currentTurn;
    if (turnNumber === void 0) throw new Error(`conversation boundary ${event.type} has no turn`);
    const stepNumber = event.type === "turn/start" || event.type === "turn/end" ? void 0 : explicit.step ?? (turnNumber === this.currentTurn ? this.currentStep : void 0);
    this.coordinates.set(event.seq, {
      turn: turnNumber,
      ...stepNumber === void 0 ? {} : { step: stepNumber },
      location: this.coordinates.get(event.seq)?.location
    });
    this.indexTurnSeq(turnNumber, event.seq);
    const previousTurn = this.timeline.turns.get(turnNumber);
    let steps = previousTurn?.steps ?? [];
    if (event.type === "step/start" || event.type === "step/end") {
      const number = event.data.step;
      const indexedSteps = this.stepsByTurn.get(turnNumber) ?? /* @__PURE__ */ new Map();
      const previousStep = indexedSteps.get(number);
      const candidate2 = {
        turn: turnNumber,
        step: number,
        start: event.type === "step/start" ? event : previousStep?.start,
        end: event.type === "step/end" ? event : previousStep?.end,
        status: event.type === "step/end" || previousStep?.end !== void 0 ? "closed" : "open",
        data: this.stepData(turnNumber, number)
      };
      const nextStep = sameStep(previousStep, candidate2) ? previousStep : candidate2;
      indexedSteps.set(number, nextStep);
      this.stepsByTurn.set(turnNumber, indexedSteps);
      const index = steps.findIndex((step) => step.step === number);
      steps = index < 0 ? [...steps, nextStep] : steps.map((step, at) => at === index ? nextStep : step);
    }
    const candidate = {
      turn: turnNumber,
      start: event.type === "turn/start" ? event : previousTurn?.start,
      end: event.type === "turn/end" ? event : previousTurn?.end,
      status: event.type === "turn/end" || previousTurn?.end !== void 0 ? "closed" : event.type === "turn/start" || previousTurn?.start !== void 0 ? "open" : "unknown",
      steps,
      data: this.turnData(turnNumber)
    };
    const turn = sameTurn(previousTurn, candidate) ? previousTurn : candidate;
    const turns = new Map(this.timeline.turns);
    turns.set(turnNumber, turn);
    const turnOrder = previousTurn === void 0 ? [...this.timeline.turnOrder, turnNumber] : this.timeline.turnOrder;
    this.timeline = { turnOrder, turns };
    if (turn !== previousTurn) this.changedTurns.add(turnNumber);
    const changed = /* @__PURE__ */ new Set();
    for (const seq of this.seqsByTurn.get(turnNumber) ?? []) {
      const coordinates = this.coordinates.get(seq);
      const previous = coordinates.location;
      const next = this.resolve(seq);
      coordinates.location = next;
      if (!sameLocation(previous, next)) changed.add(seq);
    }
    if (event.type === "step/end" && this.currentTurn === event.data.turn && this.currentStep === event.data.step) {
      this.currentStep = void 0;
    }
    if (event.type === "turn/end" && this.currentTurn === event.data.turn) {
      this.currentTurn = void 0;
      this.currentStep = void 0;
    }
    return changed;
  }
  /**
   * Index one non-boundary tail event without scanning the window or the Turn's Steps.
   * @param event - contiguous appended event.
   */
  appendNonBoundary(event) {
    const explicit = payloadCoordinates(event);
    if (explicit.session === true) {
      this.coordinates.set(event.seq, { location: SESSION_LOCATION });
      return;
    }
    if (explicit.turn !== void 0) {
      if (this.currentTurn !== explicit.turn) this.currentStep = void 0;
      this.currentTurn = explicit.turn;
      if (explicit.step !== void 0) this.currentStep = explicit.step;
    }
    const turn = explicit.turn ?? this.currentTurn;
    const step = explicit.step ?? (turn === this.currentTurn ? this.currentStep : void 0);
    const coordinates = explicit.turn !== void 0 && explicit.step !== void 0 ? explicit : {
      ...turn === void 0 ? {} : { turn },
      ...turn === void 0 || step === void 0 ? {} : { step },
      location: void 0
    };
    this.coordinates.set(event.seq, coordinates);
    if (turn !== void 0) this.indexTurnSeq(turn, event.seq);
    coordinates.location = this.resolve(event.seq);
  }
  /**
   * Remove indexed Assistant transients without rebuilding the Turn/Step timeline.
   * @param events - transient events retired by one Assistant settlement.
   */
  removeAssistantTransients(events) {
    for (const event of events) {
      const turn = this.coordinates.get(event.seq)?.turn;
      if (turn !== void 0) {
        const seqs = this.seqsByTurn.get(turn);
        seqs?.delete(event.seq);
        if (seqs?.size === 0) this.seqsByTurn.delete(turn);
      }
      this.coordinates.delete(event.seq);
    }
  }
  /**
   * Index one durable Assistant settlement inserted before an already visible tail.
   * @param event - message or attempt settlement with explicit Turn and Step coordinates.
   */
  insertAssistantSettlement(event) {
    const coordinates = {
      turn: event.data.turn,
      step: event.data.step,
      location: void 0
    };
    this.coordinates.set(event.seq, coordinates);
    this.indexTurnSeq(event.data.turn, event.seq);
    coordinates.location = this.resolve(event.seq);
  }
  indexTurnSeq(turn, seq) {
    let current = this.seqsByTurn.get(turn);
    if (current === void 0) {
      current = /* @__PURE__ */ new Set();
      this.seqsByTurn.set(turn, current);
    }
    current.add(seq);
  }
  turnData(turn) {
    return this.mutableTurnData(turn);
  }
  stepData(turn, step) {
    return this.mutableStepData(stepDataKey(turn, step));
  }
  mutableTurnData(turn) {
    const current = this.turnDataStores.get(turn) ?? this.createDataStore(turn);
    this.turnDataStores.set(turn, current);
    return current;
  }
  mutableStepData(key) {
    const current = this.stepDataStores.get(key) ?? this.createDataStore(Number(key.slice(0, key.indexOf(":"))));
    this.stepDataStores.set(key, current);
    return current;
  }
  createDataStore(turn) {
    return new MutableLocationDataStore((store) => {
      this.dirtyDataStores.add(store);
      this.changedTurns.add(turn);
    });
  }
  storeFor(data) {
    return data.kind === "turn" ? this.mutableTurnData(data.turn) : this.mutableStepData(stepDataKey(data.turn, requireStep(data)));
  }
  resolve(seq) {
    const coordinates = this.coordinates.get(seq);
    if (coordinates?.turn === void 0) return SESSION_LOCATION;
    const turn = this.timeline.turns.get(coordinates.turn);
    if (turn === void 0) return UNRESOLVED_LOCATION;
    if (coordinates.step === void 0) return { kind: "turn", turn };
    const step = this.stepsByTurn.get(coordinates.turn)?.get(coordinates.step);
    return step === void 0 ? { kind: "turn", turn } : { kind: "step", turn, step };
  }
};
function stepDataKey(turn, step) {
  return `${turn}:${step}`;
}
function requireStep(data) {
  if (data.kind === "step" && data.step !== void 0) return data.step;
  throw new Error(`conversation Step data "${data.key}" requires a step`);
}

// packages/client/ui-conversation/src/client/conversation/assembler.ts
var ConversationUpdateError = class extends Error {
  /** Whether every active view shows the complete rebuild. */
  rebuilt;
  /**
   * @param rebuilt - whether every active view shows the complete rebuild.
   * @param options - the original failure, or an `AggregateError` of both failures, as `cause`.
   */
  constructor(rebuilt, options) {
    super(rebuilt ? "conversation update failed; the loaded window was rebuilt" : "conversation update failed, and rebuilding the loaded window also failed", options);
    this.name = "ConversationUpdateError";
    this.rebuilt = rebuilt;
  }
};
var PUBLICATION_RANK = {
  none: 0,
  "animation-frame": 1,
  immediate: 2
};
var LOCATION_DATA_SCOPES = ["step", "turn"];
function emptyLocationData() {
  return { step: null, turn: null };
}
function maximumPublication(left, right) {
  return PUBLICATION_RANK[left] >= PUBLICATION_RANK[right] ? left : right;
}
function startSeq(context) {
  return context.startSeq;
}
function insertionIndex(contexts, seq) {
  let low = 0;
  let high = contexts.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = contexts[middle];
    if (candidate !== void 0 && candidate.startSeq < seq) low = middle + 1;
    else high = middle;
  }
  return low;
}
function contextSnapshot(context) {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    matches: context.matches,
    start: context.start,
    state: context.state,
    current: context.current
  };
}
function mergeMatches(key, additions, existing) {
  const merged = [];
  let added = 0;
  let current = 0;
  while (added < additions.length || current < existing.length) {
    const left = additions[added];
    const right = existing[current];
    if (left !== void 0 && right !== void 0 && left.event.seq === right.event.seq) {
      throw new Error(`conversation Context ${key} received duplicate Match ${left.event.seq}`);
    }
    if (right === void 0 || left !== void 0 && left.event.seq < right.event.seq) {
      merged.push(left);
      added++;
    } else {
      merged.push(right);
      current++;
    }
  }
  return merged;
}
function conversationMatch(input, role, location) {
  return { event: input.event, role, location };
}
var NO_GROUPS = { entries: () => [], forTarget: () => void 0 };
var ConversationNodeAssembler = class {
  /**
   * @param eventDefinitions - live Event Definition registry.
   * @param viewDefinitions - live view builder registry.
   * @param groupDefinitions - optional registered grouping rules, independent of presentation modes.
   */
  constructor(eventDefinitions, viewDefinitions, groupDefinitions = NO_GROUPS) {
    this.eventDefinitions = eventDefinitions;
    this.viewDefinitions = viewDefinitions;
    this.groupDefinitions = groupDefinitions;
    this.resetViewBuilders();
  }
  eventDefinitions;
  viewDefinitions;
  groupDefinitions;
  contexts = /* @__PURE__ */ new Map();
  contextsByKind = /* @__PURE__ */ new Map();
  contextsBySeq = /* @__PURE__ */ new Map();
  contextsByTarget = /* @__PURE__ */ new Map();
  inputs = /* @__PURE__ */ new Map();
  locationIndex = new ConversationLocationIndex();
  dirty = /* @__PURE__ */ new Set();
  dirtyByTarget = /* @__PURE__ */ new Map();
  revised = /* @__PURE__ */ new Set();
  dependents = /* @__PURE__ */ new Map();
  views = /* @__PURE__ */ new Map();
  groups = /* @__PURE__ */ new Map();
  pendingGroupStores = /* @__PURE__ */ new Set();
  activeTargets = /* @__PURE__ */ new Set();
  /** Matches of the event in dispatch, kept by index; dispatch is not reentrant and reuses both arrays. */
  matchedDefinitions = [];
  matchedResults = [];
  hasMore = false;
  rebuildPending = false;
  replacePending = true;
  timelineDirty = true;
  /**
   * Read the current open turn without activating a View.
   * @returns the latest turn number when its start is loaded and it remains open, otherwise undefined.
   */
  openTurn() {
    const snapshot = this.locationIndex.snapshot();
    const latest = snapshot.turnOrder.at(-1);
    const turn = latest === void 0 ? void 0 : snapshot.turns.get(latest);
    return turn?.status === "open" && turn.start !== void 0 ? turn.turn : void 0;
  }
  /**
   * Replace the complete loaded window after open, resync, or gap repair.
   * @param entries - complete contiguous window.
   * @param hasMore - whether older history remains outside the window.
   * @returns immediate publication request.
   */
  replaceWindow(entries, hasMore) {
    this.contexts.clear();
    this.contextsByKind.clear();
    this.contextsBySeq.clear();
    this.contextsByTarget.clear();
    this.inputs.clear();
    this.dirty.clear();
    this.dirtyByTarget.clear();
    this.revised.clear();
    this.dependents.clear();
    this.hasMore = hasMore;
    const sorted = [...entries].sort((left, right) => left.event.seq - right.event.seq);
    for (const entry of sorted) this.inputs.set(entry.event.seq, entry);
    this.locationIndex.rebuild(sorted);
    this.timelineDirty = true;
    for (const entry of sorted) this.matchInput(entry);
    this.replayDependencies();
    this.revised.clear();
    for (const context of this.contexts.values()) this.markDirty(context);
    this.replacePending = true;
    return "immediate";
  }
  /**
   * Add one contiguous live tail event without scanning existing Contexts.
   * @param record - appended Session event entry.
   * @returns highest requested publication cadence.
   */
  append(record) {
    const event = record.event;
    if (this.inputs.has(event.seq)) return "none";
    if (this.revised.size > 0) this.revised.clear();
    this.inputs.set(event.seq, record);
    let publication = "none";
    if (event.type !== "assistant/live-chunk" && isLocationBoundary(event.type)) {
      const previousTimeline = this.locationIndex.snapshot();
      const changed = this.locationIndex.appendBoundary(event);
      if (this.locationIndex.snapshot() !== previousTimeline) {
        this.timelineDirty = true;
        publication = "immediate";
      }
      this.replayContexts(this.refreshMatchLocations(changed));
      if (changed.size > 0) publication = "immediate";
    } else {
      this.locationIndex.appendNonBoundary(event);
    }
    publication = maximumPublication(publication, this.matchInput(record));
    if (this.replayRevisedDependents()) publication = "immediate";
    if (this.revised.size > 0) this.revised.clear();
    return publication;
  }
  /**
   * Retire one Assistant attempt's transient matches and apply its optional durable settlement.
   * Empty Contexts retain their keys and published nodes until the loaded window is rebuilt;
   * Definitions may hide those nodes when no start remains instead of withdrawing their identities.
   * @param attemptId - process-local attempt whose transient presentation ended.
   * @param entry - durable message or attempt event committed for the stream.
   * @returns highest requested publication cadence.
   */
  settleAssistant(attemptId, entry) {
    this.revised.clear();
    const retired = [...this.inputs.values()].filter((candidate) => candidate.type === "transient" && candidate.event.data.attemptId === attemptId);
    const retiredSeqs = new Set(retired.map((candidate) => candidate.event.seq));
    const affected = /* @__PURE__ */ new Set();
    for (const seq of retiredSeqs) {
      this.inputs.delete(seq);
      for (const context of this.contextsBySeq.get(seq) ?? []) affected.add(context);
      this.contextsBySeq.delete(seq);
    }
    for (const context of affected) {
      context.matches = context.matches.filter((match) => !retiredSeqs.has(match.event.seq));
    }
    this.locationIndex.removeAssistantTransients(retired.map((candidate) => candidate.event));
    let publication = retired.length === 0 ? "none" : "immediate";
    if (entry !== void 0 && !this.inputs.has(entry.event.seq)) {
      this.inputs.set(entry.event.seq, entry);
      this.locationIndex.insertAssistantSettlement(entry.event);
      const pending = /* @__PURE__ */ new Map();
      publication = maximumPublication(publication, this.collectInput(entry, pending));
      this.applyPendingMatches(pending, affected);
    }
    this.replayContexts(affected);
    if (this.replayRevisedDependents()) publication = "immediate";
    this.revised.clear();
    return publication;
  }
  /**
   * Add an older page while preserving existing Context and view identities.
   * @param entries - newly loaded older Events.
   * @param hasMore - whether history still precedes the expanded window.
   * @returns highest requested publication cadence.
   */
  prepend(entries, hasMore) {
    this.revised.clear();
    let publication = "none";
    const previousHasMore = this.hasMore;
    const fresh = entries.filter((entry) => !this.inputs.has(entry.event.seq)).sort((left, right) => left.event.seq - right.event.seq);
    for (const entry of fresh) this.inputs.set(entry.event.seq, entry);
    this.hasMore = hasMore;
    const previousTimeline = this.locationIndex.snapshot();
    const changedLocations = this.locationIndex.rebuild(this.sortedInputs());
    if (this.locationIndex.snapshot() !== previousTimeline) this.timelineDirty = true;
    const affected = this.refreshMatchLocations(changedLocations);
    const pending = /* @__PURE__ */ new Map();
    for (const entry of fresh) {
      publication = maximumPublication(publication, this.collectInput(entry, pending));
    }
    this.applyPendingMatches(pending, affected);
    this.replayContexts(affected);
    if ((this.revised.size > 0 || previousHasMore !== hasMore) && this.replayDependencies()) {
      publication = "immediate";
    }
    if (changedLocations.size > 0) publication = "immediate";
    this.revised.clear();
    return publication;
  }
  /**
   * Rebuild against the current Registry set after a low-frequency plugin change.
   * @returns immediate publication request.
   */
  rebuildRegistry() {
    this.resetViewBuilders();
    return this.replaceWindow(this.sortedInputs(), this.hasMore);
  }
  /**
   * Materialize dirty Contexts and advance every active view builder.
   * When an incremental update throws, the assembler replays the complete loaded
   * window into new Contexts and replaces every active view before it throws a
   * {@link ConversationUpdateError}. A Definition that throws on every incremental
   * update therefore makes each flush replay the whole window. A failure on the
   * complete-replacement path propagates unchanged, publishes no view, and keeps
   * the replacement pending for the next flush.
   * @returns whether any view snapshot was rebuilt or incrementally applied.
   * @throws {@link ConversationUpdateError} when an incremental update fails.
   */
  flush() {
    if (this.rebuildPending) this.rebuildWindow();
    if (!this.replacePending && this.dirty.size === 0 && !this.timelineDirty) return false;
    if (this.replacePending) return this.flushReplacement();
    try {
      return this.flushIncremental();
    } catch (error) {
      return this.recoverIncremental(error);
    }
  }
  flushReplacement() {
    this.replaceLocationData();
    const updated = [];
    const changedTurns = this.locationIndex.takeChangedTurns();
    for (const target of this.activeTargets) {
      const view = this.views.get(target);
      if (view === void 0) continue;
      this.updateView(view, true, this.buildTargetNodes(target, this.contextsByTarget.get(target)), changedTurns);
      updated.push(view);
    }
    this.replacePending = false;
    this.dirty.clear();
    this.dirtyByTarget.clear();
    this.timelineDirty = false;
    return this.publishViews(updated);
  }
  /** Replace partial incremental state with a complete rebuild, then report the original failure. */
  recoverIncremental(error) {
    try {
      this.rebuildWindow();
      this.flushReplacement();
    } catch (recoveryError) {
      throw new ConversationUpdateError(false, {
        cause: new AggregateError([error, recoveryError], "conversation update and its rebuild failed")
      });
    }
    throw new ConversationUpdateError(true, { cause: error });
  }
  /** Rebuild every Context from the loaded inputs; a failed rebuild stays pending for the next flush. */
  rebuildWindow() {
    this.rebuildPending = true;
    this.replaceWindow(this.sortedInputs(), this.hasMore);
    this.rebuildPending = false;
  }
  flushIncremental() {
    const updated = [];
    if (this.applyDirtyLocationData()) this.timelineDirty = true;
    const changedTurns = this.locationIndex.takeChangedTurns();
    const timelineDirty = this.timelineDirty;
    for (const target of this.activeTargets) {
      const view = this.views.get(target);
      if (view === void 0) continue;
      const builder = view.builder;
      if (builder === void 0) continue;
      const upserts = this.buildTargetUpserts(target, this.dirtyByTarget.get(target));
      if (upserts.length === 0 && !timelineDirty) continue;
      this.updateView(view, false, upserts, changedTurns);
      updated.push(view);
    }
    this.dirty.clear();
    this.dirtyByTarget.clear();
    this.timelineDirty = false;
    return this.publishViews(updated);
  }
  /**
   * Add one target to the monotonic active set and materialize its current snapshot.
   * Pending Context work is flushed before the first complete replacement. When that
   * flush throws, the target stays inactive and a later activation retries it.
   * @param target - registered or subsequently registered view target.
   * @returns whether any active target snapshot changed.
   */
  activateTarget(target) {
    const view = this.views.get(target);
    if (this.activeTargets.has(target)) return false;
    const published = this.flush();
    this.activeTargets.add(target);
    if (view === void 0) return published;
    this.replaceView(view);
    this.publishViews([view]);
    return true;
  }
  /**
   * Read the latest snapshot of a registered target.
   * @param target - registered view target.
   * @returns target snapshot, or undefined before registration or activation.
   */
  snapshot(target) {
    return this.views.get(target)?.snapshot;
  }
  get(target) {
    return this.snapshot(target);
  }
  grouped(target) {
    return this.groups.get(target)?.store;
  }
  /**
   * Read targets whose owners classify their latest snapshot as visible activity.
   * @returns target ids contributing visible activity.
   */
  activityTargets() {
    const active = /* @__PURE__ */ new Set();
    for (const target of this.activeTargets) {
      const view = this.views.get(target);
      if (view === void 0) continue;
      if (view.isActive?.(view.snapshot) === true) active.add(view.target);
    }
    return active;
  }
  sortedInputs() {
    return [...this.inputs.values()].sort((left, right) => left.event.seq - right.event.seq);
  }
  matchInput(input) {
    return this.dispatchInput(input, this.acceptMatch);
  }
  collectInput(input, pending) {
    return this.dispatchInput(input, (definition, id, match) => {
      const key = conversationContextKey(definition.kind, id);
      const matches = pending.get(key) ?? [];
      matches.push({ definition, id, match });
      pending.set(key, matches);
      return definition.publication?.(match) ?? "immediate";
    });
  }
  dispatchInput(input, accept) {
    const event = input.event;
    let startMatch;
    let updateMatch;
    let location;
    const matchFor = (role) => {
      location ??= this.locationIndex.locationOf(event);
      return role === "start" ? startMatch ??= conversationMatch(input, role, location) : updateMatch ??= conversationMatch(input, role, location);
    };
    const definitions = this.matchedDefinitions;
    const results = this.matchedResults;
    definitions.length = 0;
    results.length = 0;
    const routes = this.eventDefinitions.forEvent?.(event.type);
    if (routes === void 0) {
      for (const definition of this.eventDefinitions.entries()) {
        const result = definition.match(event);
        if (result === null) continue;
        definitions.push(definition);
        results.push(result);
      }
    } else {
      for (const { definition, match } of routes) {
        const result = match(event);
        if (result === null) continue;
        definitions.push(definition);
        results.push(result);
      }
    }
    let claims;
    for (let index = 0; index < results.length; index++) {
      if (results[index].exclusive !== true) continue;
      const definition = definitions[index];
      const target2 = definition.target;
      if (target2 === void 0) {
        throw new Error(`conversation Definition "${definition.kind}" claims ${event.type} at seq ${String(event.seq)} without a target`);
      }
      const claimant = claims?.get(target2);
      if (claimant !== void 0) {
        throw new Error(`conversation Definitions "${claimant}" and "${definition.kind}" both claim ${event.type} at seq ${String(event.seq)} on target "${target2}"`);
      }
      (claims ??= /* @__PURE__ */ new Map()).set(target2, definition.kind);
    }
    let firstTarget;
    let secondTarget;
    let otherTargets;
    let publication = "none";
    for (let index = 0; index < results.length; index++) {
      const definition = definitions[index];
      const result = results[index];
      const target2 = definition.target;
      if (target2 !== void 0 && result.exclusive !== true && claims?.has(target2) === true) continue;
      if (target2 !== void 0 && target2 !== firstTarget && target2 !== secondTarget) {
        if (firstTarget === void 0) firstTarget = target2;
        else if (secondTarget === void 0) secondTarget = target2;
        else (otherTargets ??= /* @__PURE__ */ new Set()).add(target2);
      }
      publication = maximumPublication(publication, accept.call(this, definition, result.id, matchFor(result.role)));
    }
    const fallback = this.eventDefinitions.fallbackEntry();
    const target = fallback?.target;
    if (fallback !== void 0 && target !== void 0 && target !== firstTarget && target !== secondTarget && otherTargets?.has(target) !== true) {
      const result = fallback.match(event);
      if (result !== null) {
        publication = maximumPublication(publication, accept.call(this, fallback, result.id, matchFor(result.role)));
      }
    }
    return publication;
  }
  createContext(definition, id, key) {
    const context = {
      key,
      kind: definition.kind,
      id,
      definition,
      startSeq: void 0,
      start: void 0,
      matches: [],
      state: void 0,
      revision: 0,
      current: /* @__PURE__ */ new Map(),
      locationData: emptyLocationData(),
      dependencies: /* @__PURE__ */ new Map()
    };
    this.contexts.set(key, context);
    this.indexTargetContext(context);
    return context;
  }
  acceptMatch(definition, id, match) {
    const latest = this.contextsByKind.get(definition.kind)?.at(-1);
    const key = latest?.id === id ? latest.key : conversationContextKey(definition.kind, id);
    let context = this.contexts.get(key);
    context ??= this.createContext(definition, id, key);
    const starting = match.role === "start" && context.start === void 0;
    const previous = context.matches.at(-1);
    if (previous !== void 0 && previous.event.seq >= match.event.seq) {
      throw new Error(`conversation Context ${key} received non-appended Match ${match.event.seq}`);
    }
    if (starting && context.matches.length > 0) {
      throw new Error(`conversation Context ${key} received an update before its start Match`);
    }
    context.matches.push(match);
    if (starting) {
      context.startSeq = match.event.seq;
      context.start = match;
      this.indexStartedContext(context);
    }
    let owners = this.contextsBySeq.get(match.event.seq);
    if (owners === void 0) {
      owners = [];
      this.contextsBySeq.set(match.event.seq, owners);
    }
    owners.push(context);
    if (starting) {
      this.replayContext(context);
    } else if (context.state !== void 0) {
      const typed = contextSnapshot(context);
      context.state = requireState(definition, "update", definition.update(typed, match));
      context.revision++;
      this.revised.add(context);
    }
    this.markDirty(context);
    return definition.publication?.(match) ?? "immediate";
  }
  applyPendingMatches(pending, affected) {
    for (const [key, entries] of pending) {
      const first = entries[0];
      if (first === void 0) continue;
      let context = this.contexts.get(key);
      context ??= this.createContext(first.definition, first.id, key);
      const additions = entries.map((entry) => {
        if (entry.definition !== context.definition || entry.id !== context.id) {
          throw new Error(`conversation Context ${key} received inconsistent Definition identity`);
        }
        let owners = this.contextsBySeq.get(entry.match.event.seq);
        if (owners === void 0) {
          owners = [];
          this.contextsBySeq.set(entry.match.event.seq, owners);
        }
        owners.push(context);
        return entry.match;
      }).sort((left, right) => left.event.seq - right.event.seq);
      context.matches = mergeMatches(context.key, additions, context.matches);
      affected.add(context);
      this.markDirty(context);
    }
  }
  replayContexts(contexts) {
    this.refreshStarts(contexts);
    const ordered = [...contexts].sort((left, right) => (left.startSeq ?? Number.POSITIVE_INFINITY) - (right.startSeq ?? Number.POSITIVE_INFINITY));
    for (const context of ordered) {
      if (context.start === void 0) {
        context.state = void 0;
        this.replaceDependencies(context, /* @__PURE__ */ new Map());
        context.revision++;
        this.revised.add(context);
        this.markDirty(context);
        continue;
      }
      this.replayContext(context);
    }
  }
  refreshStarts(contexts) {
    const changed = /* @__PURE__ */ new Set();
    const startsByKind = /* @__PURE__ */ new Map();
    for (const context of contexts) {
      const start = context.matches.find((match) => match.role === "start");
      if (start === context.start) continue;
      context.start = start;
      context.startSeq = start?.event.seq;
      changed.add(context);
      const starts = startsByKind.get(context.kind) ?? [];
      if (start !== void 0) starts.push(context);
      startsByKind.set(context.kind, starts);
    }
    for (const [kind, starts] of startsByKind) {
      const existing = this.contextsByKind.get(kind) ?? [];
      this.contextsByKind.set(kind, existing.filter((context) => !changed.has(context)));
      this.indexStartedContexts(kind, starts);
    }
  }
  replayContext(context) {
    const start = context.start;
    if (start === void 0) {
      context.state = void 0;
      return;
    }
    if (context.matches[0] !== start) {
      throw new Error(`conversation Context ${context.key} received an update before its start Match`);
    }
    const dependencies = /* @__PURE__ */ new Map();
    const reader = this.readerFor(start.event.seq, dependencies);
    context.state = void 0;
    context.state = requireState(
      context.definition,
      "start",
      context.definition.start(contextSnapshot(context), start, reader)
    );
    this.replaceDependencies(context, dependencies);
    for (let index = 1; index < context.matches.length; index++) {
      const match = context.matches[index];
      if (match === void 0) continue;
      const typed = contextSnapshot(context);
      context.state = requireState(
        context.definition,
        "update",
        context.definition.update(typed, match)
      );
    }
    context.revision++;
    this.revised.add(context);
    this.markDirty(context);
  }
  indexTargetContext(context) {
    const target = context.definition.target;
    if (target === void 0) return;
    const contexts = this.contextsByTarget.get(target) ?? /* @__PURE__ */ new Set();
    contexts.add(context);
    this.contextsByTarget.set(target, contexts);
  }
  markDirty(context) {
    if (this.dirty.has(context)) return;
    this.dirty.add(context);
    const target = context.definition.target;
    if (target === void 0 || !this.activeTargets.has(target)) return;
    let contexts = this.dirtyByTarget.get(target);
    if (contexts === void 0) {
      contexts = /* @__PURE__ */ new Set();
      this.dirtyByTarget.set(target, contexts);
    }
    contexts.add(context);
  }
  replaceDependencies(context, dependencies) {
    for (const dependency of context.dependencies.values()) {
      if (dependency.key === void 0) continue;
      const current = this.dependents.get(dependency.key);
      current?.delete(context);
      if (current?.size === 0) this.dependents.delete(dependency.key);
    }
    context.dependencies = dependencies;
    for (const dependency of dependencies.values()) {
      if (dependency.key === void 0) continue;
      const current = this.dependents.get(dependency.key) ?? /* @__PURE__ */ new Set();
      current.add(context);
      this.dependents.set(dependency.key, current);
    }
  }
  replayRevisedDependents() {
    if (this.dependents.size === 0) return false;
    const pending = [...this.revised];
    const affected = /* @__PURE__ */ new Set();
    for (let index = 0; index < pending.length; index++) {
      const dependency = pending[index];
      if (dependency === void 0) continue;
      for (const dependent of this.dependents.get(dependency.key) ?? []) {
        if (affected.has(dependent)) continue;
        affected.add(dependent);
        pending.push(dependent);
      }
    }
    if (affected.size > 0) this.replayContexts(affected);
    return affected.size > 0;
  }
  readerFor(beforeSeq, dependencies) {
    return {
      previous: (kind) => {
        const predecessor = this.previousContext(kind, beforeSeq);
        dependencies.set(kind, {
          kind,
          key: predecessor?.key,
          revision: predecessor?.revision,
          windowGap: predecessor === void 0 && this.hasMore
        });
        if (predecessor?.state === void 0) return void 0;
        const seq = startSeq(predecessor);
        if (seq === void 0) return void 0;
        return {
          key: predecessor.key,
          kind: predecessor.kind,
          id: predecessor.id,
          startSeq: seq,
          state: predecessor.state,
          matches: predecessor.matches
        };
      }
    };
  }
  previousContext(kind, beforeSeq) {
    const candidates = this.contextsByKind.get(kind) ?? [];
    const indexBefore = insertionIndex(candidates, beforeSeq);
    for (let index = indexBefore - 1; index >= 0; index--) {
      const candidate = candidates[index];
      if (candidate?.state !== void 0) return candidate;
    }
    return void 0;
  }
  /** Insert one newly discovered start into its Definition's ordered predecessor index. */
  indexStartedContext(context) {
    const seq = context.startSeq;
    if (seq === void 0) return;
    const candidates = this.contextsByKind.get(context.kind) ?? [];
    const previous = candidates.at(-1);
    if (previous === void 0 || previous.startSeq < seq) candidates.push(context);
    else candidates.splice(insertionIndex(candidates, seq), 0, context);
    this.contextsByKind.set(context.kind, candidates);
  }
  indexStartedContexts(kind, additions) {
    if (additions.length === 0) return;
    const sorted = [...additions].sort((left, right) => left.startSeq - right.startSeq);
    const existing = this.contextsByKind.get(kind) ?? [];
    const merged = [];
    let before = 0;
    let added = 0;
    while (before < existing.length || added < sorted.length) {
      const left = existing[before];
      const right = sorted[added];
      if (right === void 0 || left !== void 0 && left.startSeq < right.startSeq) {
        merged.push(left);
        before++;
      } else {
        merged.push(right);
        added++;
      }
    }
    this.contextsByKind.set(kind, merged);
  }
  replayDependencies() {
    let replayed = false;
    const ordered = [...this.contexts.values()].filter((context) => startSeq(context) !== void 0).sort((left, right) => startSeq(left) - startSeq(right));
    for (const context of ordered) {
      if (context.state === void 0 || context.dependencies.size === 0) continue;
      const before = startSeq(context);
      if (before === void 0) continue;
      let changed = false;
      for (const dependency of context.dependencies.values()) {
        const current = this.previousContext(dependency.kind, before);
        const windowGap = current === void 0 && this.hasMore;
        if (current?.key !== dependency.key || current?.revision !== dependency.revision || windowGap !== dependency.windowGap) {
          changed = true;
          break;
        }
      }
      if (changed) {
        this.replayContext(context);
        replayed = true;
      }
    }
    return replayed;
  }
  refreshMatchLocations(changedSeqs) {
    const affected = /* @__PURE__ */ new Set();
    if (changedSeqs.size === 0) return affected;
    for (const seq of changedSeqs) {
      for (const context of this.contextsBySeq.get(seq) ?? []) affected.add(context);
    }
    for (const context of affected) {
      let start = context.start;
      const matches = context.matches.map((match) => {
        if (!changedSeqs.has(match.event.seq)) return match;
        if (match.role === "start") {
          const refreshed = {
            ...match,
            location: this.locationIndex.locationOf(match.event)
          };
          if (match === start) start = refreshed;
          return refreshed;
        }
        return { ...match, location: this.locationIndex.locationOf(match.event) };
      });
      context.matches = matches;
      context.start = start;
    }
    return affected;
  }
  buildNode(context, target) {
    if (context.definition.target !== target || context.definition.buildViewNode === void 0) return null;
    const node = context.definition.buildViewNode(contextSnapshot(context));
    if (node === null) return null;
    if (node.key !== context.key) {
      throw new Error(`conversation Definition "${context.kind}" returned unstable key "${node.key}"; expected "${context.key}"`);
    }
    if (node.target !== target) {
      throw new Error(`conversation Definition "${context.kind}" returned target "${node.target}" while building "${target}"`);
    }
    return node;
  }
  replaceView(view) {
    this.updateView(view, true, this.buildTargetNodes(view.target, this.contextsByTarget.get(view.target)), []);
  }
  updateView(view, replacing, nodes, changedTurns) {
    const builder = view.builder ?? view.definition.create();
    const definition = view.groupDefinition;
    if (definition !== void 0 && builder.groupInput === void 0) {
      throw new Error(`conversation group target "${view.target}" requires builder.groupInput()`);
    }
    view.builder = builder;
    const timeline = this.locationIndex.snapshot();
    const snapshot = replacing ? builder.replace({ nodes, timeline, changedTurns }) : builder.apply({ upserts: nodes, timeline, changedTurns });
    if (definition !== void 0 && builder.groupInput !== void 0) {
      let context = this.groups.get(view.target);
      const initial = context === void 0;
      if (context === void 0) {
        context = { definition, state: definition.create(), store: new ConversationGroupStore() };
      }
      const input = builder.groupInput();
      context.state = definition.update(context, input);
      const change = definition.buildGroups(context);
      if ((initial || input.kind === "replace") && (change === null || change.entries === void 0 || change.groups.kind !== "replace")) {
        throw new Error(`conversation group target "${view.target}" requires complete grouping for replacement input`);
      }
      if (change !== null) {
        context.store.prepareAndInstall(change, input.readNode);
        this.pendingGroupStores.add(context.store);
      }
      this.groups.set(view.target, context);
    }
    view.snapshot = snapshot;
  }
  publishViews(updated) {
    const changed = updated.length > 0 || this.pendingGroupStores.size > 0;
    const stores = [...this.pendingGroupStores];
    this.pendingGroupStores.clear();
    for (const view of updated) view.builder?.publish?.();
    for (const store of stores) store.publish();
    this.locationIndex.publishData();
    return changed;
  }
  buildTargetNodes(target, contexts) {
    const nodes = [];
    for (const context of contexts ?? []) {
      const node = this.buildNode(context, target);
      context.current.set(target, node);
      if (node !== null) nodes.push(node);
    }
    return nodes;
  }
  buildTargetUpserts(target, contexts) {
    const upserts = [];
    for (const context of contexts ?? []) {
      const previous = context.current.get(target) ?? null;
      const node = this.buildNode(context, target);
      if (node === null && previous !== null) {
        throw new Error(
          `conversation Definition "${context.kind}" withdrew materialized target "${target}"; return the same key with hidden visibility instead`
        );
      }
      context.current.set(target, node);
      if (node !== null) upserts.push(node);
    }
    return upserts;
  }
  buildLocationData(context, scope, previous) {
    if (context.definition.buildLocationData === void 0) return null;
    const data = context.definition.buildLocationData(contextSnapshot(context), scope, previous);
    if (data === null) return null;
    if (data.kind !== scope) {
      throw new Error(
        `conversation Definition "${context.kind}" published ${data.kind} data through its ${scope} scope`
      );
    }
    if (data.key !== context.kind) {
      throw new Error(
        `conversation Definition "${context.kind}" published Location data key "${data.key}"; expected its owned kind`
      );
    }
    if (!Number.isSafeInteger(data.turn) || data.turn < 0) {
      throw new Error(`conversation Definition "${context.kind}" published invalid turn ${data.turn}`);
    }
    if (data.kind === "step" && (!Number.isSafeInteger(data.step) || data.step < 0)) {
      throw new Error(`conversation Definition "${context.kind}" published invalid step ${String(data.step)}`);
    }
    return data;
  }
  replaceLocationData() {
    const entries = [];
    for (const scope of LOCATION_DATA_SCOPES) {
      for (const context of this.contexts.values()) {
        const data = this.buildLocationData(context, scope, context.locationData[scope]);
        context.locationData[scope] = data;
        if (data !== null) entries.push({ owner: context.key, data });
      }
      this.locationIndex.replaceData(entries);
    }
  }
  applyDirtyLocationData() {
    let changed = false;
    for (const scope of LOCATION_DATA_SCOPES) {
      const changes = [];
      for (const context of this.dirty) {
        const previous = context.locationData[scope];
        const next = this.buildLocationData(context, scope, previous);
        if (previous === next) continue;
        context.locationData[scope] = next;
        changes.push({ owner: context.key, previous, next });
      }
      changed = this.locationIndex.applyData(changes) || changed;
    }
    return changed;
  }
  resetViewBuilders() {
    const definitions = this.viewDefinitions.entries();
    const targets = new Set(definitions.map((definition) => definition.target));
    for (const [target, group] of this.groups) {
      if (!targets.has(target) || this.groupDefinitions.forTarget(target) !== group.definition) {
        group.store.clear();
        this.pendingGroupStores.add(group.store);
        this.groups.delete(target);
      }
    }
    this.views.clear();
    for (const definition of definitions) {
      const view = {
        target: definition.target,
        definition,
        groupDefinition: this.groupDefinitions.forTarget(definition.target),
        isActive: definition.isActive === void 0 ? void 0 : (snapshot) => definition.isActive?.(snapshot) === true,
        builder: void 0,
        snapshot: void 0
      };
      this.views.set(definition.target, view);
    }
    this.replacePending = true;
  }
};
function isLocationBoundary(type) {
  return type === "turn/start" || type === "turn/end" || type === "step/start" || type === "step/end";
}
function requireState(definition, phase, state) {
  if (state === void 0) {
    throw new Error(`conversation Definition "${definition.kind}" returned undefined from ${phase}()`);
  }
  return state;
}

// packages/client/ui-conversation/src/client/conversation/definition-registry.ts
import { Service } from "@deepseek-ai/cordis";
import { notifySubscribers as notifySubscribers2 } from "@deepseek-ai/dsh-client-store";
var ConversationDefinitionRegistry = class {
  /** @param ctx - Context whose effects own contributed Definitions. */
  constructor(ctx) {
    this.ctx = ctx;
    Object.defineProperty(this, Service.tracker, {
      value: { property: "ctx" }
    });
  }
  ctx;
  definitions = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  cached = [];
  /**
   * Return reference-stable Definitions in registration order.
   * @returns current Definitions.
   */
  entries() {
    return this.cached;
  }
  /**
   * Observe low-frequency registry changes.
   * @param listener - synchronous invalidation callback.
   * @returns unsubscribe callback.
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /**
   * Register one uniquely keyed Definition for the caller's lifetime.
   * @param key - registry-local unique key.
   * @param definition - contributed Definition.
   * @param duplicateMessage - error raised when the key is already owned.
   * @param effectName - Cordis effect diagnostic label.
   * @returns idempotent disposer.
   */
  registerDefinition(key, definition, duplicateMessage, effectName) {
    if (this.definitions.has(key)) throw new Error(duplicateMessage);
    const owner = this.ctx;
    const dispose = owner.effect(() => {
      this.definitions.set(key, definition);
      this.refresh();
      return () => {
        if (this.definitions.get(key) !== definition) return;
        this.definitions.delete(key);
        this.refresh();
      };
    }, effectName);
    return () => {
      void dispose();
    };
  }
  /** Refresh cached entries and synchronously invalidate subscribers. */
  refresh() {
    this.cached = [...this.definitions.values()];
    notifySubscribers2(this.listeners, "[ui-conversation] definition registry");
  }
};

// packages/client/ui-conversation/src/client/conversation/event-registry.ts
var ConversationEventRegistry = class extends ConversationDefinitionRegistry {
  fallback;
  routes = /* @__PURE__ */ new Map();
  unrestricted = /* @__PURE__ */ new Set();
  tables = /* @__PURE__ */ new WeakMap();
  /**
   * Register a uniquely named business Definition for the caller's lifetime.
   * @param definition - Definition contribution.
   * @returns idempotent disposer.
   */
  register(definition) {
    assertDefinitionTarget(definition);
    return this.registerDefinition(
      definition.kind,
      this.resolve(definition),
      `conversation Definition "${definition.kind}" is already registered`,
      `uiConversation.events.register(${JSON.stringify(definition.kind)})`
    );
  }
  /**
   * Register the sole fallback used only when no ordinary Definition matches.
   * @param input - fallback Definition.
   * @returns idempotent disposer.
   */
  registerFallback(input) {
    assertDefinitionTarget(input);
    const target = input.target;
    if (target === void 0) throw new Error("conversation fallback Definition must declare a target");
    if (this.fallback !== void 0) throw new Error("conversation fallback Definition is already registered");
    const definition = this.resolve(input);
    const dispose = this.ctx.effect(() => {
      this.fallback = definition;
      this.refresh();
      return () => {
        if (this.fallback !== definition) return;
        this.fallback = void 0;
        this.refresh();
      };
    }, `uiConversation.events.registerFallback(${JSON.stringify(definition.kind)})`);
    return () => {
      void dispose();
    };
  }
  /**
   * Return the current unmatched-event fallback.
   * @returns installed fallback, when present.
   */
  fallbackEntry() {
    return this.fallback;
  }
  /**
   * Read precomputed candidates in registration order; the returned Set is borrowed read-only.
   * @param type - current event type.
   * @returns table handlers for this type together with all function-form handlers.
   */
  forEvent(type) {
    return this.routes.get(type) ?? this.unrestricted;
  }
  resolve(input) {
    if (typeof input.match === "function") return input;
    const table = new Map(Object.entries(input.match));
    const definition = {
      ...input,
      match: (event) => table.get(event.type)?.call(definition, event) ?? null
    };
    this.tables.set(definition, table);
    return definition;
  }
  refresh() {
    const routes = /* @__PURE__ */ new Map();
    const unrestricted = /* @__PURE__ */ new Set();
    for (const definition of this.definitions.values()) {
      const table = this.tables.get(definition);
      if (table === void 0) {
        const route = { definition, match: definition.match.bind(definition) };
        unrestricted.add(route);
        for (const candidates of routes.values()) candidates.add(route);
      } else {
        for (const [type, match] of table) {
          let candidates = routes.get(type);
          if (candidates === void 0) {
            candidates = new Set(unrestricted);
            routes.set(type, candidates);
          }
          candidates.add({ definition, match: match.bind(definition) });
        }
      }
    }
    this.routes = routes;
    this.unrestricted = unrestricted;
    super.refresh();
  }
};
function assertDefinitionTarget(definition) {
  if (definition.target === void 0 !== (definition.buildViewNode === void 0)) {
    throw new Error(
      `conversation Definition "${definition.kind}" must declare target and buildViewNode together`
    );
  }
}

// packages/util/crypto/lib/index.js
function bytesToBase64(data) {
  let binary = "";
  const chunk = 32768;
  for (let offset = 0; offset < data.length; offset += chunk) binary += String.fromCharCode(...data.subarray(offset, offset + chunk));
  return btoa(binary);
}

// packages/client/ui-conversation/src/client/conversation/historical-images.ts
var HistoricalImageCache = class {
  /**
   * @param ctx - Owning ui-conversation fiber.
   * @param sessions - Session Controller object layer.
   */
  constructor(ctx, sessions) {
    this.sessions = sessions;
    ctx.effect(() => () => {
      this.dispose();
    }, "ui-conversation historical image cache");
  }
  sessions;
  entries = new WeakMapWithValues();
  scopeDisposers = new WeakMapWithValues();
  urls = /* @__PURE__ */ new Set();
  disposed = false;
  /**
   * Resolve and cache one stored image URL.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference.
   * @returns browser URL valid until the Session binding is released.
   */
  resolve(sessionId, attachment) {
    if (this.disposed) return Promise.reject(new Error("ui-conversation image cache is disposed"));
    const binding = this.sessions.binding(sessionId);
    if (binding === void 0) {
      return Promise.reject(new Error(`ui-conversation: unknown session "${sessionId}"`));
    }
    const entries = this.bindScope(binding);
    const key = attachment.attachmentId;
    const cached = entries.get(key);
    if (cached !== void 0) return cached.pending;
    const entry = {
      binding,
      pending: Promise.resolve("")
    };
    entries.set(key, entry);
    entry.pending = this.loadCanonical(key, entry, attachment);
    return entry.pending;
  }
  /**
   * Return an already-displayable URL without starting a read.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference.
   * @returns current preview or canonical URL when cached.
   */
  peek(sessionId, attachment) {
    const binding = this.sessions.binding(sessionId);
    return binding === void 0 ? void 0 : this.entries.get(binding)?.get(attachment.attachmentId)?.current;
  }
  /**
   * Adopt a submission preview while fetching the durable admitted bytes.
   * The preview is available synchronously, then replaced and revoked when
   * the canonical attachment read completes.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference the URL temporarily displays.
   * @param url - browser URL to adopt.
   * @returns whether the cache took ownership.
   */
  seed(sessionId, attachment, url) {
    if (this.disposed) return false;
    const binding = this.sessions.binding(sessionId);
    if (binding === void 0) return false;
    const entries = this.bindScope(binding);
    const key = attachment.attachmentId;
    if (entries.has(key)) return false;
    const entry = {
      binding,
      current: url,
      pending: Promise.resolve(url)
    };
    this.urls.add(url);
    entries.set(key, entry);
    entry.pending = this.loadCanonical(key, entry, attachment).catch((error) => {
      if (entries.get(key) === entry && entry.current === url) {
        entries.delete(key);
        this.releaseUrl(url);
      }
      throw error;
    });
    void entry.pending.catch(() => {
    });
    return true;
  }
  loadCanonical(key, entry, attachment) {
    return entry.binding.session.readAttachment(attachment).then((result) => {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
      this.assertLive(key, entry);
      let url;
      if (typeof URL.createObjectURL !== "function") {
        url = `data:${result.value.attachment.mediaType};base64,${bytesToBase64(result.value.data)}`;
      } else {
        const bytes = Uint8Array.from(result.value.data);
        url = URL.createObjectURL(new Blob([bytes.buffer], { type: result.value.attachment.mediaType }));
      }
      this.assertLive(key, entry);
      this.urls.add(url);
      const previous = entry.current;
      entry.current = url;
      if (previous !== void 0 && previous !== url) this.releaseUrl(previous);
      return url;
    }).catch((error) => {
      const entries = this.entries.get(entry.binding);
      if (entries?.get(key) === entry && entry.current === void 0) entries.delete(key);
      throw error;
    });
  }
  assertLive(key, entry) {
    if (this.disposed) throw new Error("ui-conversation image cache was disposed before loading completed");
    if (this.entries.get(entry.binding)?.get(key) !== entry) {
      throw new Error("ui-conversation image scope was released before loading completed");
    }
  }
  bindScope(binding) {
    const existing = this.entries.get(binding);
    if (existing !== void 0) return existing;
    const entries = /* @__PURE__ */ new Map();
    this.entries.set(binding, entries);
    const dispose = binding.ctx.effect(() => () => {
      this.scopeDisposers.delete(binding);
      this.release(binding, entries);
    }, "ui-conversation historical image scope");
    const release = () => {
      void dispose();
    };
    this.scopeDisposers.set(binding, release);
    return entries;
  }
  release(binding, entries) {
    if (this.entries.get(binding) === entries) this.entries.delete(binding);
    for (const entry of entries.values()) {
      if (entry.current !== void 0) this.releaseUrl(entry.current);
    }
    entries.clear();
  }
  releaseUrl(url) {
    if (!this.urls.delete(url)) return;
    revokeUrl(url);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of [...this.scopeDisposers.values]) dispose();
    this.scopeDisposers.clear();
    for (const url of this.urls) revokeUrl(url);
    this.urls.clear();
    for (const entries of this.entries.values) entries.clear();
    this.entries.clear();
  }
};
function revokeUrl(url) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

// packages/client/ui-conversation/src/client/conversation/view-registry.ts
var ConversationViewRegistry = class extends ConversationDefinitionRegistry {
  /**
   * Register a uniquely named view builder factory for the caller's lifetime.
   * @param definition - target builder contribution.
   * @returns idempotent disposer.
   */
  register(definition) {
    return this.registerDefinition(
      definition.target,
      definition,
      `conversation view target "${definition.target}" is already registered`,
      `uiConversation.views.register(${JSON.stringify(definition.target)})`
    );
  }
};

// packages/client/ui-conversation/src/client/conversation/group-registry.ts
var ConversationGroupRegistry = class extends ConversationDefinitionRegistry {
  /**
   * @param ctx - owning plugin context.
   * @param views - registered target Builder definitions.
   */
  constructor(ctx, views) {
    super(ctx);
    this.views = views;
  }
  views;
  /**
   * Register grouping rules for an existing target.
   * @param definition - business State and grouping output for the declared target data.
   * @returns the effect-owned, idempotent registration disposer.
   */
  register(definition) {
    if (!this.views.entries().some((view) => view.target === definition.target)) {
      throw new Error(`conversation group target "${definition.target}" is not registered`);
    }
    return this.registerDefinition(
      definition.target,
      definition,
      `conversation group target "${definition.target}" is already registered`,
      `uiConversation.groups.register(${JSON.stringify(definition.target)})`
    );
  }
  /**
   * Find the grouping rules registered for one target.
   * @param target - View target.
   * @returns its grouping Definition, when registered.
   */
  forTarget(target) {
    return this.definitions.get(target);
  }
};

// packages/client/ui-conversation/src/client/conversation/interaction-registry.ts
var ConversationInteractionRegistry = class extends ConversationDefinitionRegistry {
  ids = [];
  /**
   * Register a synchronous handler and its keyed renderer identity.
   * @param definition - uniquely named plugin handler.
   * @returns idempotent disposer tied to the registering plugin's lifetime.
   */
  register(definition) {
    if (definition.id === "") throw new Error("text interaction ID must not be empty");
    return this.registerDefinition(
      definition.id,
      definition,
      `Duplicate text interaction: ${definition.id}`,
      `uiConversation.interactions.register(${JSON.stringify(definition.id)})`
    );
  }
  /**
   * Offer a gesture until one handler opens its surface; opening never prevents browser defaults.
   * @param sessionId - conversation where the gesture occurred.
   * @param gesture - synchronous access to the browser event and DOM text.
   * @returns selected renderer ID, or null when no plugin opens a surface.
   */
  dispatch(sessionId, gesture) {
    for (const definition of this.entries()) {
      const state = { opened: false };
      let dispatching = true;
      try {
        definition.onInteraction({
          ...gesture,
          sessionId,
          open: () => {
            if (dispatching) state.opened = true;
          },
          preventDefault: () => {
            if (dispatching) gesture.preventDefault();
          }
        });
      } finally {
        dispatching = false;
      }
      if (state.opened) return definition.id;
    }
    return null;
  }
  /**
   * Observe registration changes so Chat views can dismiss stale surfaces.
   * @returns stable IDs until the registry changes.
   */
  getSnapshot() {
    return this.ids;
  }
  refresh() {
    this.ids = [...this.definitions.keys()];
    super.refresh();
  }
};

// packages/client/ui-conversation/src/client/conversation/user-text-document.ts
var UserTextTransformError = class extends Error {
  constructor(ruleId, cause) {
    super(`user-text rule "${ruleId}" failed to evaluate`, { cause });
    this.ruleId = ruleId;
    this.name = "UserTextTransformError";
  }
  ruleId;
};
var UserTextDocument = class {
  text;
  rules;
  initial = [];
  output = [];
  matchers = /* @__PURE__ */ new Map();
  complete = false;
  evaluating = false;
  /**
   * Reconcile original text using current rule definitions and valid query records.
   * @param input - original text and readonly Facts, compared by fields actually read.
   * @param rules - unique definitions ordered by ascending order and stable ID.
   * @returns complete readonly nodes; failures retain caches but publish no partial result.
   */
  evaluate(input, rules) {
    if (this.evaluating) throw new Error("user-text document evaluation cannot be reentrant");
    this.evaluating = true;
    try {
      const { changed, matchers } = this.prepare(input, rules);
      if (!changed && this.complete) return this.output;
      this.complete = false;
      this.output = alignNodes(this.reconcile(input, matchers), this.output, this.initial);
      this.complete = true;
      return this.output;
    } finally {
      this.evaluating = false;
    }
  }
  prepare(input, rules) {
    let changed = this.rules !== rules;
    if (this.text !== input.text) {
      changed = true;
      this.text = input.text;
      this.matchers.clear();
      this.initial = input.text.length === 0 ? [] : [textNode(input.text, 0, input.text.length)];
      this.output = this.initial;
    }
    const ids = new Set(rules.map((rule) => rule.id));
    const matchers = [];
    for (const definition of rules) {
      let matcher = this.matchers.get(definition.id);
      if (matcher === void 0 || matcher.definition !== definition || factsChanged(matcher.reads, input)) {
        matcher = { definition, queries: [], reads: /* @__PURE__ */ new Map() };
        this.matchers.set(definition.id, matcher);
        changed = true;
      }
      matchers.push(matcher);
    }
    for (const id of this.matchers.keys()) if (!ids.has(id)) this.matchers.delete(id);
    this.rules = rules;
    return { changed, matchers };
  }
  reconcile(input, matchers) {
    const traversals = matchers.map((matcher) => ({ matcher, added: [], index: -1, head: void 0 }));
    const nodes = [];
    let cursor = 0;
    try {
      while (true) {
        let winner;
        for (const traversal of traversals) {
          const node = nextCandidate(traversal, input, cursor);
          if (node !== void 0 && (winner === void 0 || node.start < winner.start)) winner = node;
        }
        if (winner === void 0) {
          if (cursor < input.text.length) nodes.push(textNode(input.text, cursor, input.text.length));
          return nodes;
        }
        if (cursor < winner.start) nodes.push(textNode(input.text, cursor, winner.start));
        nodes.push(winner);
        cursor = winner.end;
      }
    } finally {
      for (const { matcher, added } of traversals) {
        if (added.length > 0) matcher.queries = mergeQueries(matcher.queries, added);
      }
    }
  }
};
function factsChanged(reads, input) {
  for (const [key, value] of reads) if (!Object.is(value, input.facts[key])) return true;
  return false;
}
function withFacts(input, reads, run) {
  let active = true;
  try {
    return run({
      read: (key) => {
        if (!active) throw new Error("user-text transform context is closed; read is synchronous only");
        const value = input.facts[key];
        reads.set(key, value);
        return value;
      }
    });
  } finally {
    active = false;
  }
}
function nextCandidate(traversal, input, cursor) {
  const { matcher } = traversal;
  if (traversal.head === void 0 || traversal.head.node !== void 0 && traversal.head.node.start < cursor) {
    let next = matcher.queries[traversal.index + 1];
    while (next !== void 0 && next.from <= cursor) {
      traversal.index++;
      next = matcher.queries[traversal.index + 1];
    }
    const recorded = matcher.queries[traversal.index];
    if (recorded !== void 0 && (recorded.error !== void 0 ? recorded.from === cursor : recorded.node === void 0 || recorded.node.start >= cursor)) {
      traversal.head = recorded;
    } else {
      let node;
      let error;
      try {
        node = withFacts(input, matcher.reads, (context) => matcher.definition.match(input.text, cursor, context));
        if (node !== void 0) validateCandidate(input.text, matcher.definition.id, cursor, node);
      } catch (cause) {
        error = new UserTextTransformError(matcher.definition.id, cause);
      }
      traversal.head = { from: cursor, node, error };
      traversal.added.push(traversal.head);
    }
  }
  if (traversal.head.error !== void 0) throw traversal.head.error;
  return traversal.head.node;
}
function validateCandidate(text, ruleId, from, node) {
  if (!Number.isInteger(node.start) || !Number.isInteger(node.end) || node.start < from || node.end <= node.start || node.end > text.length) {
    throw new Error(`invalid candidate range [${node.start}, ${node.end}); expected a nonempty range from ${from} to ${text.length}`);
  }
  if (node.id === "text") {
    if (node.data.text !== text.slice(node.start, node.end)) throw new Error("text candidate must preserve its original substring");
  } else if (node.id !== ruleId) {
    throw new Error(`candidate must use rule ID "${ruleId}" or text`);
  }
}
function mergeQueries(previous, added) {
  if (previous.length === 0) return added;
  const merged = [];
  const remaining = previous.values();
  let old = remaining.next().value;
  for (const query of added) {
    while (old !== void 0 && old.from < query.from) {
      merged.push(old);
      old = remaining.next().value;
    }
    merged.push(query);
  }
  while (old !== void 0) {
    merged.push(old);
    old = remaining.next().value;
  }
  return merged;
}
function textNode(text, start, end) {
  return { id: "text", start, end, data: { text: text.slice(start, end) } };
}
function alignNodes(output, previous, input) {
  let previousIndex = 0;
  let inputIndex = 0;
  let aligned;
  for (const [index, node] of output.entries()) {
    let inputNode = input[inputIndex];
    while (inputNode && inputNode.start < node.start) inputNode = input[++inputIndex];
    let previousNode = previous[previousIndex];
    while (previousNode && previousNode.start < node.start) previousNode = previous[++previousIndex];
    const reused = inputNode && equalNode(node, inputNode) ? inputNode : previousNode && equalNode(node, previousNode) ? previousNode : node;
    if (reused !== node && !aligned) aligned = output.slice(0, index);
    aligned?.push(reused);
  }
  const nodes = aligned ?? output;
  if (equalElements(nodes, previous)) return previous;
  return equalElements(nodes, input) ? input : nodes;
}
function equalElements(left, right) {
  return left === right || left.length === right.length && left.every((node, index) => node === right[index]);
}
function equalNode(left, right) {
  return Object.is(left, right) || left.id === right.id && left.start === right.start && left.end === right.end && equalJson(left.data, right.data);
}
function equalJson(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && equalJson(Reflect.get(left, key), Reflect.get(right, key)));
}

// packages/client/ui-conversation/src/client/conversation/user-text-registry.ts
var UserTextRegistry = class extends ConversationDefinitionRegistry {
  rules = [];
  revision = 0;
  /**
   * Register a uniquely named rule; invalid IDs, duplicate IDs and non-finite order throw before publication.
   * @param rule - readonly synchronous candidate matcher with a nonempty ID other than the reserved `text` ID.
   * @returns idempotent disposer; removal synchronously publishes a new revision.
   */
  register(rule) {
    if (rule.id.length === 0) throw new Error("user-text rule ID must not be empty");
    if (rule.id === "text") throw new Error('user-text rule "text" is reserved for original text');
    if (!Number.isFinite(rule.order)) throw new Error(`user-text rule "${rule.id}" order must be finite`);
    return this.registerDefinition(
      rule.id,
      rule,
      `user-text rule "${rule.id}" is already registered`,
      `uiConversation.userText.register(${JSON.stringify(rule.id)})`
    );
  }
  /**
   * Create an independent document evaluator; it reads current rules at each call and never subscribes.
   * @returns callback owning its document cache, released when the caller releases the callback.
   */
  createEvaluator() {
    const document = new UserTextDocument();
    return (input) => document.evaluate(input, this.rules);
  }
  /**
   * Read the observable rule revision.
   * @returns monotonic revision, stable until a successful registration or disposal.
   */
  getSnapshot() {
    return this.revision;
  }
  refresh() {
    this.rules = [...this.definitions.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.revision++;
    super.refresh();
  }
};

// packages/client/ui-conversation/src/client/conversation/assembly.ts
var BoundConversation = class {
  constructor(feed, assembler) {
    this.assembler = assembler;
    this.viewStore = assembler;
    this.snapshot = createSnapshotStore2(this.currentSnapshot());
    this.openTurn = createSnapshotStore2(assembler.openTurn());
    this.replace(feed.getSnapshot());
    this.disposeFeed = feed.subscribe(() => {
      this.accept(feed.getSnapshot());
    });
  }
  assembler;
  snapshot;
  openTurn;
  viewStore;
  targetSources = /* @__PURE__ */ new Map();
  revision = -1;
  frame;
  disposeFeed = () => {
  };
  target(target) {
    let source = this.targetSources.get(target);
    if (source === void 0) {
      const views = this.viewStore;
      source = {
        getSnapshot: () => views.get(target),
        subscribe: (listener) => {
          const unsubscribe = this.snapshot.subscribe(listener);
          this.activate(target);
          return unsubscribe;
        }
      };
      this.targetSources.set(target, source);
    }
    return source;
  }
  activate(target) {
    this.publishing(() => this.assembler.activateTarget(target));
  }
  rebuild() {
    this.publish(this.assembler.rebuildRegistry());
  }
  dispose() {
    this.cancelFrame();
    this.disposeFeed();
  }
  replace(window) {
    this.revision = window.revision;
    this.publish(this.assembler.replaceWindow(window.entries, window.hasMore));
  }
  accept(window) {
    if (window.revision === this.revision) return;
    if (window.revision !== this.revision + 1 || window.change.kind === "replace") {
      this.replace(window);
      return;
    }
    this.revision = window.revision;
    switch (window.change.kind) {
      case "prepend":
        this.publish(this.assembler.prepend(window.change.entries, window.hasMore));
        return;
      case "append": {
        let publication = "none";
        for (const event of window.change.entries) {
          const next = this.assembler.append(event);
          if (next === "immediate" || publication === "none") publication = next;
        }
        this.publish(publication);
        return;
      }
      case "settle-assistant":
        this.publish(this.assembler.settleAssistant(
          window.change.attemptId,
          window.change.entry
        ));
        return;
    }
  }
  publish(publication) {
    if (publication === "none") return;
    if (publication === "animation-frame" && typeof requestAnimationFrame === "function") {
      if (this.frame !== void 0) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = requestAnimationFrame(() => {
          this.frame = requestAnimationFrame(() => {
            this.frame = void 0;
            this.flush();
          });
        });
      });
      return;
    }
    this.cancelFrame();
    this.flush();
  }
  cancelFrame() {
    if (this.frame !== void 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(this.frame);
    }
    this.frame = void 0;
  }
  flush() {
    this.publishing(() => this.assembler.flush());
  }
  /** Publish an assembler result, including a complete rebuild that the assembler finished before it reported a failure. */
  publishing(operation) {
    let changed;
    try {
      changed = operation();
    } catch (error) {
      if (error instanceof ConversationUpdateError && error.rebuilt) this.publishSnapshot(true);
      throw error;
    }
    this.publishSnapshot(changed);
  }
  publishSnapshot(changed) {
    if (changed) this.snapshot.set(this.currentSnapshot());
    this.openTurn.set(this.assembler.openTurn());
  }
  currentSnapshot() {
    return {
      views: this.viewStore,
      activeTargets: this.assembler.activityTargets()
    };
  }
};
var UiConversation = class extends Service2 {
  /**
   * @param ctx - owning Client context.
   * @param sessions - Session Controller object layer.
   */
  constructor(ctx, sessions) {
    super(ctx, "uiConversation");
    this.sessions = sessions;
    this.events = new ConversationEventRegistry(ctx);
    this.views = new ConversationViewRegistry(ctx);
    this.groups = new ConversationGroupRegistry(ctx, this.views);
    this.userText = new UserTextRegistry(ctx);
    this.interactions = new ConversationInteractionRegistry(ctx);
    this.images = new HistoricalImageCache(ctx, sessions);
    const rebuild = () => {
      for (const record of this.bindings.values) record.binding.rebuild();
    };
    let rebuildQueued = false;
    const scheduleRebuild = () => {
      if (rebuildQueued) return;
      rebuildQueued = true;
      queueMicrotask(() => {
        rebuildQueued = false;
        rebuild();
      });
    };
    ctx.effect(() => {
      const disposeEvents = this.events.subscribe(scheduleRebuild);
      const disposeViews = this.views.subscribe(scheduleRebuild);
      const disposeGroups = this.groups.subscribe(scheduleRebuild);
      return () => {
        disposeGroups();
        disposeViews();
        disposeEvents();
        for (const record of [...this.bindings.values]) this.drop(record, true);
      };
    }, "ui-conversation assembly");
  }
  sessions;
  /** Registry of event matchers and target snapshot builders. */
  events;
  /** Registry of target View definitions. */
  views;
  /** Business grouping rules over already materialized target Nodes. */
  groups;
  /** Pure text rules and parser snapshots, independent of durable Session assembly. */
  userText;
  /** Plugin-owned handlers for selection and context-menu gestures. */
  interactions;
  bindings = new WeakMapWithValues();
  images;
  /**
   * Resolve the Conversation binding for one Controller binding or Session id.
   * @param source - Session binding or identity.
   * @returns stable Conversation binding.
   * @throws if the Session is unknown or its binding is no longer current.
   */
  binding(source) {
    const sessionId = typeof source === "string" ? source : source.sessionId;
    const owner = typeof source === "string" ? this.sessions.binding(source) : source;
    if (owner === void 0) throw new Error(`uiConversation.binding: unknown session "${sessionId}"`);
    if (this.sessions.binding(sessionId) !== owner) {
      throw new Error(`uiConversation.binding: inactive session "${sessionId}"`);
    }
    const current = this.bindings.get(owner);
    if (current !== void 0) return current.binding;
    const binding = new BoundConversation(
      owner.eventSource,
      new ConversationNodeAssembler(this.events, this.views, this.groups)
    );
    const record = { source: owner, binding, disposeScope: () => {
    } };
    this.bindings.set(owner, record);
    const disposeScope = owner.ctx.effect(
      () => () => {
        this.drop(record, false);
      },
      "ui-conversation binding"
    );
    record.disposeScope = () => {
      void disposeScope();
    };
    return binding;
  }
  /**
   * Resolve one Gateway-authorized durable image URL, cached per Session so
   * every Conversation target shares one read and one browser URL.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference from a session event.
   * @returns browser URL valid until the Session binding is released.
   */
  imageUrl(sessionId, attachment) {
    return this.images.resolve(sessionId, attachment);
  }
  /**
   * Read a cached durable image URL synchronously when one is available.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference from a session event.
   * @returns current preview or canonical URL, if cached.
   */
  peekImageUrl(sessionId, attachment) {
    return this.images.peek(sessionId, attachment);
  }
  /**
   * Adopt an already-displayable URL for one durable reference (see
   * HistoricalImageCache.seed): the transcript node then renders it without a
   * byte round-trip.
   * @param sessionId - Session binding that owns the cached URL lifetime.
   * @param attachment - Durable image reference the URL displays.
   * @param url - browser URL to adopt.
   * @returns whether the cache took URL ownership.
   */
  seedImageUrl(sessionId, attachment, url) {
    return this.images.seed(sessionId, attachment, url);
  }
  /**
   * Interpret a system message or surface replacement for target-owned prompt Definitions.
   * @param previous - System facts at the preceding relevant loaded event.
   * @param event - Durable system message or positional replacement.
   * @returns Immutable prompt interpretation at this event.
   */
  inspectSystemPrompt(previous, event) {
    return inspectSystemPrompt(previous, event);
  }
  /**
   * Canonicalize one `request/header` event against the previous prompt state
   * and the `system/message` node in force.
   *
   * A pure interpretation shared by the Chat and Trajectory Definitions, exposed
   * as a service method because cross-plugin value imports are forbidden in
   * client bundles.
   * @param previous - prompt recorded by the preceding loaded header, if any.
   * @param event - the `request/header` session event to interpret.
   * @param system - effective prompt after loaded surface replacements, if any.
   * @returns the canonical prompt snapshot and any model-visible change.
   */
  inspectRequestPrompt(previous, event, system) {
    return inspectRequestPrompt(previous, event, system);
  }
  drop(record, releaseScope) {
    if (this.bindings.get(record.source) !== record) return;
    this.bindings.delete(record.source);
    record.binding.dispose();
    if (releaseScope) record.disposeScope();
  }
};
export {
  UiConversation
};
