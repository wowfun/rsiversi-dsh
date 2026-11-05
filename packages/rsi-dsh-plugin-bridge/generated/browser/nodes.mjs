// Generated from DeepSeek Harness fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159. See LICENSE.
import {
  PartialArguments,
  isAppendSurfaceEvent,
  isReplacementSurfaceEvent
} from "./shared/WLBUY26R.mjs";

// packages/client/ui-chat/src/client/conversation-nodes/common.ts
var CHAT_SYNTHETIC_SEQ_OFFSETS = {
  interruptedAssistant: -0.9,
  interruptedFollowup: -0.8,
  processControl: -0.1,
  maxTokensNotice: 0.05,
  finalizedFollowup: 0.1
};
function contextLocation(context) {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
}
function locationCoordinates(location) {
  if (location.kind === "step") return { turn: location.turn.turn, step: location.step.step };
  if (location.kind === "turn") return { turn: location.turn.turn };
  return {};
}
function chatNode(context, kind, anchorSeq, data, options = {}) {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: "chat",
    anchorSeq,
    location: options.location ?? contextLocation(context),
    visibility: options.visibility ?? "visible",
    groupTree: options.groupTree,
    data
  };
}

// packages/client/ui-chat/src/client/conversation-nodes/event-projection.ts
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function readString(record, key) {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
function collect(source, member, field) {
  const list = source[member];
  if (!Array.isArray(list)) return [];
  const seen = [];
  for (const entry of list) {
    const record = asRecord(entry);
    const value = record === null ? null : readString(record, field);
    if (value !== null && !seen.includes(value)) seen.push(value);
  }
  return seen;
}
function joined(names) {
  return names.length > 0 ? names.join(", ") : null;
}
var KNOWN_FORMS = [
  "instructions",
  "catalog",
  "snapshot",
  "notice",
  "relay",
  "recall"
];
function contextForm(source) {
  const record = asRecord(source);
  const form = record === null ? null : readString(record, "form");
  return form !== null && KNOWN_FORMS.includes(form) ? form : null;
}
function contextProducer(source) {
  const record = asRecord(source);
  const kind = record === null ? null : readString(record, "kind");
  if (record === null || kind === null) return { role: "inject", label: null };
  switch (kind) {
    case "session-reference":
      return { role: "recall", label: joined(collect(record, "references", "label")) ?? kind };
    case "agent-instructions":
      return { role: "inject", label: joined(collect(record, "changes", "path")) ?? kind };
    case "skill-invocation":
      return { role: "inject", label: readString(record, "name") ?? kind };
    default:
      return { role: "inject", label: kind };
  }
}
function sessionRecallLabels(source) {
  const record = asRecord(source);
  if (record === null || readString(record, "kind") !== "session-reference") return [];
  return collect(record, "references", "label");
}
function skillInvocationName(source) {
  const record = asRecord(source);
  if (record === null || readString(record, "kind") !== "skill-invocation") return null;
  return readString(record, "name");
}
function toAssistantBlocks(content) {
  return content.map(toAssistantBlock);
}
function toAssistantBlock(block) {
  switch (block.type) {
    case "text":
      return { kind: "text", text: block.text };
    case "reasoning":
      return { kind: "reasoning", text: block.text };
    case "image":
      return { kind: "image", attachment: block.attachment };
    case "tool-call":
      return { kind: "tool-call", callId: String(block.id), name: block.name, argsRaw: block.arguments };
    default:
      return { kind: "other", block };
  }
}
function emptyAssistantBlock(blockType) {
  switch (blockType) {
    case "text":
      return { kind: "text", text: "" };
    case "reasoning":
      return { kind: "reasoning", text: "" };
    case "tool-call":
      return { kind: "tool-call", callId: "", name: "", argsRaw: "" };
    default:
      return { kind: "other", block: null };
  }
}
function displayFailure(failure) {
  if (failure === null || typeof failure !== "object") return { message: String(failure) };
  const record = failure;
  const code = typeof record.code === "string" ? record.code : void 0;
  if (code === "AUTH") return { code, message: "" };
  return {
    ...code === void 0 ? {} : { code },
    message: typeof record.message === "string" ? record.message : JSON.stringify(failure)
  };
}
function isTokenDelta(chunk) {
  switch (chunk.type) {
    case "text-delta":
    case "reasoning-delta":
      return chunk.text !== "";
    case "tool-call-delta":
      return chunk.argumentsDelta !== "" || chunk.name !== void 0;
    default:
      return false;
  }
}

// packages/client/ui-chat/src/client/conversation-nodes/assistant.ts
function initialState(turn, step) {
  return {
    turn,
    step,
    blocks: [],
    visibleByIndex: [],
    visibleBlocks: 0,
    firstVisibleSeq: void 0,
    firstVisibleTime: void 0,
    firstTokenTime: void 0,
    final: void 0,
    usage: void 0
  };
}
function compactBlocks(blocks) {
  return blocks.filter((block) => block !== void 0);
}
function blockIsVisible(block) {
  if (block === void 0 || block.kind === "tool-call") return false;
  if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
  return true;
}
function hasVisibleContent(blocks) {
  return blocks.some(blockIsVisible);
}
function hasInterruptionEvidence(blocks) {
  return blocks.some((block) => {
    if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
    return true;
  });
}
function resetForRetry(state) {
  return {
    ...initialState(state.turn, state.step),
    firstTokenTime: state.firstTokenTime
  };
}
function updateChunk(state, chunk, seq, time) {
  if (chunk.type === "tool-call-delta") {
    const previous = state.blocks[chunk.index];
    if (previous?.kind === "tool-call" && previous.callId !== "" && (chunk.name === void 0 || chunk.name === previous.name) && (state.firstTokenTime !== void 0 || !isTokenDelta(chunk))) return state;
  }
  const blocks = [...state.blocks];
  let changedIndex = -1;
  let previousVisible = false;
  let nextVisible = false;
  switch (chunk.type) {
    case "block-start":
      changedIndex = chunk.index;
      previousVisible = state.visibleByIndex[chunk.index] === true;
      blocks[chunk.index] = emptyAssistantBlock(chunk.blockType);
      nextVisible = blockIsVisible(blocks[chunk.index]);
      break;
    case "text-delta": {
      const previous = blocks[chunk.index];
      changedIndex = chunk.index;
      previousVisible = state.visibleByIndex[chunk.index] === true;
      blocks[chunk.index] = { kind: "text", text: (previous?.kind === "text" ? previous.text : "") + chunk.text };
      nextVisible = previous?.kind === "text" && previousVisible || chunk.text.trim() !== "";
      break;
    }
    case "reasoning-delta": {
      const previous = blocks[chunk.index];
      changedIndex = chunk.index;
      previousVisible = state.visibleByIndex[chunk.index] === true;
      blocks[chunk.index] = { kind: "reasoning", text: (previous?.kind === "reasoning" ? previous.text : "") + chunk.text };
      nextVisible = previous?.kind === "reasoning" && previousVisible || chunk.text.trim() !== "";
      break;
    }
    case "tool-call-delta": {
      const previous = blocks[chunk.index];
      changedIndex = chunk.index;
      previousVisible = state.visibleByIndex[chunk.index] === true;
      blocks[chunk.index] = {
        kind: "tool-call",
        callId: (previous?.kind === "tool-call" ? previous.callId : "") || String(chunk.id),
        name: chunk.name ?? (previous?.kind === "tool-call" ? previous.name : ""),
        argsRaw: previous?.kind === "tool-call" ? previous.argsRaw : ""
      };
      break;
    }
    case "block-end":
      changedIndex = chunk.index;
      previousVisible = state.visibleByIndex[chunk.index] === true;
      blocks[chunk.index] = toAssistantBlock(chunk.block);
      nextVisible = blockIsVisible(blocks[chunk.index]);
      break;
    case "usage":
      return { ...state, usage: chunk.usage };
    default:
      return state;
  }
  const visibleBlocks = state.visibleBlocks - Number(previousVisible) + Number(nextVisible);
  let visibleByIndex = state.visibleByIndex;
  if (previousVisible !== nextVisible) {
    const next = [...visibleByIndex];
    next[changedIndex] = nextVisible;
    visibleByIndex = next;
  }
  const firstToken = isTokenDelta(chunk);
  return {
    ...state,
    blocks,
    visibleByIndex,
    visibleBlocks,
    ...visibleBlocks > 0 && state.firstVisibleSeq === void 0 ? { firstVisibleSeq: seq, firstVisibleTime: time } : {},
    ...firstToken && state.firstTokenTime === void 0 ? { firstTokenTime: time } : {}
  };
}
function settleMessage(state, match, event) {
  const blocks = toAssistantBlocks(event.data.message.content);
  const visibleByIndex = blocks.map(blockIsVisible);
  return {
    ...state,
    blocks,
    visibleByIndex,
    visibleBlocks: visibleByIndex.reduce((count, visible) => count + Number(visible), 0),
    final: match,
    usage: event.data.usage
  };
}
function closedBoundary(location) {
  if (location.kind === "step" && location.step.status === "closed" && location.step.end !== void 0) {
    return location.step.end;
  }
  if ((location.kind === "step" || location.kind === "turn") && location.turn.status === "closed" && location.turn.end !== void 0) {
    return location.turn.end;
  }
  return void 0;
}
function finalNode(state, context) {
  const final = state.final;
  if (final?.event.type === "assistant/message") {
    const event = final.event;
    return {
      kind: "assistant",
      seq: event.seq,
      messageId: event.data.message.id,
      time: event.time,
      turn: state.turn,
      step: state.step,
      blocks: toAssistantBlocks(event.data.message.content),
      usage: event.data.usage,
      timing: {
        stepStartTime: context.start?.event.time ?? null,
        firstTokenTime: state.firstTokenTime ?? null,
        completedTime: event.time
      },
      ...event.data.interrupted === true ? { interrupted: true } : {}
    };
  }
  const location = context.start?.location ?? context.matches.at(-1)?.location;
  const boundary = location === void 0 ? void 0 : closedBoundary(location);
  if (boundary === void 0) return void 0;
  const blocks = compactBlocks(state.blocks);
  if (!hasInterruptionEvidence(blocks)) return void 0;
  return {
    kind: "assistant",
    seq: boundary.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
    time: boundary.time,
    turn: state.turn,
    step: state.step,
    blocks,
    interrupted: true
  };
}
function fallbackState(context) {
  let state;
  for (const match of context.matches) {
    if (match.event.type === "assistant/live-chunk") {
      state ??= initialState(match.event.data.turn, match.event.data.step);
      state = updateChunk(state, match.event.data.chunk, match.event.seq, match.event.time);
      continue;
    }
    if (match.event.type === "assistant/message") {
      state ??= initialState(match.event.data.turn, match.event.data.step);
      state = settleMessage(state, match, match.event);
      continue;
    }
    if (match.event.type === "llm/retry" && state !== void 0) {
      state = resetForRetry(state);
    }
  }
  return state;
}
function projectAssistant(context) {
  const state = context.state ?? fallbackState(context);
  if (state === void 0) return void 0;
  const settled = finalNode(state, context);
  const blocks = settled?.blocks ?? compactBlocks(state.blocks);
  const visible = settled === void 0 ? state.visibleBlocks > 0 : hasVisibleContent(blocks);
  const status = settled?.interrupted === true ? "interrupted" : settled === void 0 ? "running" : "settled";
  const anchorSeq = (settled?.interrupted === true ? settled.seq : state.firstVisibleSeq ?? settled?.seq) ?? context.matches[0]?.event.seq ?? 0;
  const time = settled?.time ?? state.firstVisibleTime ?? context.matches[0]?.event.time ?? 0;
  return {
    anchorSeq,
    visible,
    settled,
    data: {
      status,
      turn: state.turn,
      step: state.step,
      blocks,
      time,
      ...state.usage === void 0 ? {} : { usage: state.usage },
      ...settled === void 0 ? {} : { finalNode: settled }
    }
  };
}
function publishedAssistantData(context) {
  const location = context.start?.location ?? context.matches.at(-1)?.location;
  return location?.kind === "step" ? location.step.data.get("assistant-step") : void 0;
}
var assistantDefinition = {
  kind: "assistant-step",
  target: "chat",
  match: (event) => {
    if (event.type === "step/start") return { id: `${event.data.turn}:${event.data.step}`, role: "start" };
    if (event.type === "assistant/live-chunk" || event.type === "assistant/message" && event.surfaceOp === "append") {
      return { id: `${event.data.turn}:${event.data.step}`, role: "update" };
    }
    if (event.type === "llm/retry") {
      return { id: `${event.data.turn}:${event.data.step}`, role: "update" };
    }
    return null;
  },
  start: (_context, match) => {
    if (match.event.type !== "step/start") throw new Error("assistant-step start requires step/start");
    return initialState(match.event.data.turn, match.event.data.step);
  },
  update: (context, match) => {
    if (match.event.type === "assistant/live-chunk") {
      return updateChunk(context.state, match.event.data.chunk, match.event.seq, match.event.time);
    }
    if (match.event.type === "assistant/message") return settleMessage(context.state, match, match.event);
    if (match.event.type === "llm/retry") {
      return resetForRetry(context.state);
    }
    return context.state;
  },
  publication: (match) => {
    if (match.event.type === "step/start") return "none";
    if (match.event.type !== "assistant/live-chunk") return "immediate";
    const type = match.event.data.chunk.type;
    return type === "usage" || type === "finish" ? "none" : "animation-frame";
  },
  buildLocationData: (context, scope) => {
    if (scope !== "step") return null;
    const projected = projectAssistant(context);
    if (projected === void 0) return null;
    return {
      kind: "step",
      turn: projected.data.turn,
      step: projected.data.step,
      key: "assistant-step",
      value: projected.data
    };
  },
  buildViewNode: (context) => {
    const current = context.current.get("chat");
    const state = context.state ?? fallbackState(context);
    const data = publishedAssistantData(context);
    if (state === void 0 || data === void 0) {
      return current == null ? null : { ...current, visibility: "hidden" };
    }
    const settled = data.finalNode;
    const visible = settled === void 0 ? state.visibleBlocks > 0 : hasVisibleContent(data.blocks);
    if (settled === void 0 && !visible && current == null) return null;
    const anchorSeq = (settled?.interrupted === true ? settled.seq : state.firstVisibleSeq ?? settled?.seq) ?? context.matches[0]?.event.seq ?? 0;
    return chatNode(context, "assistant-step", anchorSeq, data, {
      visibility: settled?.interrupted === true || visible ? "visible" : "hidden"
    });
  }
};
function registerAssistantConversationNode(ctx) {
  const match = assistantDefinition.match.bind(assistantDefinition);
  ctx.uiConversation.events.register({
    ...assistantDefinition,
    match: {
      "step/start": match,
      "assistant/live-chunk": match,
      "assistant/message": match,
      "llm/retry": match
    }
  });
}

// packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts
import { notifySubscribers } from "@deepseek-ai/dsh-client-store";

// packages/client/ui-chat/src/client/contract/chat-nodes.ts
function isSettledTool(block) {
  return "kind" in block;
}
function isRunningTool(block) {
  return !isSettledTool(block);
}

// packages/client/ui-chat/src/client/contract/chat-visibility.ts
function isVisibleChatNode(node) {
  if (node.kind === "command") {
    if (node.data.name === "permission") return false;
    if (node.data.name === "team" && node.data.outcome?.kind !== "error") {
      const selection = node.data.args?.trim();
      if (selection === "on" || selection === "off") return false;
    }
  }
  return node.visibility === "visible" && node.kind !== "system-prompt";
}

// packages/client/ui-chat/src/client/contract/group-tree.ts
var DEPTH = { exchange: 0, input: 1, turn: 2, process: 3 };
function isAtOrOutside(node, position) {
  return node.groupTree !== void 0 && DEPTH[node.groupTree] <= DEPTH[position];
}

// packages/client/ui-chat/src/client/conversation-nodes/group-tree-segments.ts
var NO_TURNS = [];
var GroupTreeSegments = class {
  /** @param position - group-tree position whose Nodes open a segment. */
  constructor(position) {
    this.position = position;
  }
  position;
  /** Opening Node count by owning Turn. */
  openings = /* @__PURE__ */ new Map();
  latestOpening;
  latestStart;
  /**
   * Account one Node change.
   * @param previous - replaced Node; absent for an addition.
   * @param next - replacing Node; absent for a removal.
   */
  track(previous, next) {
    const before = this.openingTurn(previous);
    const after = this.openingTurn(next);
    if (before === after) return;
    if (before !== void 0 && this.adjust(before, -1) === 0 && before === this.latestOpening) {
      this.latestOpening = this.lastOpeningTurn();
    }
    if (after !== void 0) {
      this.adjust(after, 1);
      if (this.latestOpening === void 0 || after > this.latestOpening) this.latestOpening = after;
    }
  }
  /**
   * Test latest-segment membership as of the last `settle`.
   * @param turn - owning Turn, when resolved.
   * @returns whether the Turn belongs to the latest segment.
   */
  inLatest(turn) {
    return turn !== void 0 && this.latestStart !== void 0 && turn >= this.latestStart;
  }
  /**
   * Move the latest segment start for the currently loaded Turns.
   * @param turnOrder - loaded Turns in ascending timeline order.
   * @returns loaded Turns that entered or left the latest segment, in ascending order.
   */
  settle(turnOrder) {
    const previous = this.latestStart;
    const start = this.latestOpening ?? turnOrder[0];
    if (start === previous) return NO_TURNS;
    this.latestStart = start;
    const bounded = previous !== void 0 && start !== void 0;
    const low = bounded ? Math.min(previous, start) : Number.NEGATIVE_INFINITY;
    const high = bounded ? Math.max(previous, start) : Number.POSITIVE_INFINITY;
    const changed = [];
    for (const turn of turnOrder.slice(turnOrder.findLastIndex((turn2) => turn2 < low) + 1)) {
      if (turn >= high) break;
      changed.push(turn);
    }
    return changed;
  }
  openingTurn(node) {
    return node !== void 0 && isAtOrOutside(node, this.position) ? locationCoordinates(node.location).turn : void 0;
  }
  lastOpeningTurn() {
    let last;
    for (const turn of this.openings.keys()) {
      if (last === void 0 || turn > last) last = turn;
    }
    return last;
  }
  /** @returns the Turn's opening count after the change; zero removes the Turn. */
  adjust(turn, delta) {
    const next = (this.openings.get(turn) ?? 0) + delta;
    if (next > 0) this.openings.set(turn, next);
    else this.openings.delete(turn);
    return next;
  }
};

// packages/client/ui-chat/src/client/conversation-nodes/turn-navigation.ts
var PROMPT_PREVIEW_LIMIT = 50;
var RESPONSE_PREVIEW_LIMIT = 120;
function preview(parts, limit) {
  let text = "";
  let unread = false;
  for (const part of parts) {
    if (text.length >= limit * 2) {
      unread = true;
      break;
    }
    const clipped = part.length > limit * 2;
    const chunk = clipped ? part.slice(0, limit * 2) : part;
    text += text === "" ? chunk : ` ${chunk}`;
    if (clipped) {
      unread = true;
      break;
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length > limit - 1) return `${normalized.slice(0, limit - 1).trimEnd()}\u2026`;
  return unread ? `${normalized}\u2026` : normalized;
}
function promptText(node) {
  if (node.kind !== "user") return "";
  return preview(node.data.content.flatMap((block) => block.type === "text" ? [block.text] : []), PROMPT_PREVIEW_LIMIT);
}
function responseText(node) {
  if (node.kind !== "assistant-step") return "";
  return preview(
    node.data.blocks.flatMap((block) => block.kind === "text" ? [block.text] : []),
    RESPONSE_PREVIEW_LIMIT
  );
}
function sameTurnNavigationItem(left, right) {
  if (left === void 0 || right === void 0) return left === right;
  return left.turn === right.turn && left.anchorKey === right.anchorKey && left.prompt === right.prompt && left.response === right.response;
}
function turnNavigationItem(turn, locations, nodes) {
  const loaded = locations.getTurn(turn).map((key) => nodes.get(key)).filter((node) => node !== void 0 && isVisibleChatNode(node));
  const user = loaded.find((node) => node.kind === "user");
  const anchor = user ?? loaded[0];
  if (anchor === void 0) return void 0;
  const response = loaded.findLast((node) => responseText(node) !== "");
  return {
    turn,
    anchorKey: anchor.key,
    prompt: user === void 0 ? "" : promptText(user),
    response: response === void 0 ? "" : responseText(response)
  };
}

// packages/client/ui-chat/src/client/conversation-nodes/turn-process-presentation.ts
function nodeTurn(node) {
  const location = node?.location;
  return location?.kind === "turn" || location?.kind === "step" ? location.turn.turn : void 0;
}
function samePresentation(left, right) {
  return left === right || left !== void 0 && right !== void 0 && left.spec === right.spec && left.turn === right.turn && left.turnStarted === right.turnStarted && left.turnClosed === right.turnClosed && left.hasExternalProcess === right.hasExternalProcess && left.hasNonReplyProcess === right.hasNonReplyProcess && left.hasInterleavedInput === right.hasInterleavedInput;
}
function derivePresentation(turn, locations, nodes) {
  const keys = locations.getTurn(turn);
  const control = keys.map((key) => nodes.get(key)).find((node) => node?.kind === "turn-process");
  if (control === void 0) return void 0;
  const spec = control.data;
  const location = control.location;
  if (location.kind !== "turn" && location.kind !== "step") return void 0;
  let openingHumanAnchor;
  for (const key of keys) {
    const node = nodes.get(key);
    if (node !== void 0 && isAtOrOutside(node, "input") && (spec.controlAnchorSeq === location.turn.start?.seq || node.anchorSeq < spec.controlAnchorSeq)) {
      openingHumanAnchor = Math.max(openingHumanAnchor ?? node.anchorSeq, node.anchorSeq);
    }
  }
  let hasExternalProcess = false;
  let hasNonReplyProcess = false;
  let hasInterleavedInput = false;
  for (const key of keys) {
    const node = nodes.get(key);
    if (node === void 0 || !isVisibleChatNode(node) || node.kind === "turn-process") continue;
    if (isAtOrOutside(node, "input") && (openingHumanAnchor === void 0 || node.anchorSeq > openingHumanAnchor)) {
      hasInterleavedInput = true;
    }
    if (isAtOrOutside(node, "turn") || node.anchorSeq < spec.processStartSeq || spec.answerAnchorSeq !== null && node.anchorSeq >= spec.answerAnchorSeq) continue;
    if (node.kind !== "assistant-step" || spec.answerStep === null || node.data.step !== spec.answerStep) {
      hasExternalProcess = true;
      if (node.kind !== "assistant-step" || node.data.blocks.some((block) => block.kind === "reasoning" && block.text.trim() !== "")) {
        hasNonReplyProcess = true;
      }
    }
  }
  return {
    turn,
    spec,
    turnStarted: location.turn.start !== void 0,
    turnClosed: location.turn.status === "closed",
    hasExternalProcess,
    hasNonReplyProcess,
    hasInterleavedInput
  };
}
var ChatTurnProcessProjector = class {
  presentations = /* @__PURE__ */ new Map();
  /**
   * Read the retained process presentation for a Node's Turn.
   * @param node - Current Chat Node.
   * @returns The Turn's process presentation, when present.
   */
  get(node) {
    const turn = nodeTurn(node);
    return turn === void 0 ? void 0 : this.presentations.get(turn);
  }
  /**
   * Replace every projected Turn.
   * @param order - visible Chat Node order.
   * @param locations - current Chat Location index.
   * @param nodes - current Chat Node store.
   * @returns Turns whose process presentation changed.
   */
  replace(order, locations, nodes) {
    const turns = /* @__PURE__ */ new Set();
    for (const key of order) {
      const turn = nodeTurn(nodes.get(key));
      if (turn !== void 0) turns.add(turn);
    }
    const changed = /* @__PURE__ */ new Set();
    for (const turn of /* @__PURE__ */ new Set([...this.presentations.keys(), ...turns])) {
      if (this.set(turn, turns.has(turn) ? derivePresentation(turn, locations, nodes) : void 0)) {
        changed.add(turn);
      }
    }
    return changed;
  }
  /**
   * Recompute selected Turns after incremental Node changes.
   * @param turns - affected Turn numbers.
   * @param locations - current Chat Location index.
   * @param nodes - current Chat Node store.
   * @returns Turns whose process presentation changed.
   */
  update(turns, locations, nodes) {
    const changed = /* @__PURE__ */ new Set();
    for (const turn of turns) {
      if (this.set(turn, derivePresentation(turn, locations, nodes))) changed.add(turn);
    }
    return changed;
  }
  set(turn, next) {
    const current = this.presentations.get(turn);
    if (samePresentation(current, next)) return false;
    if (next === void 0) this.presentations.delete(turn);
    else this.presentations.set(turn, next);
    return true;
  }
};

// packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts
var EMPTY_KEYS = [];
var EMPTY_TURNS = [];
var EMPTY_ITEMS = [];
var EMPTY_LIST = [];
function sameReferences(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function cachedSource(sources, key, create) {
  let source = sources.get(key);
  if (source === void 0) {
    source = create();
    sources.set(key, source);
  }
  return source;
}
var MutableChatSource = class {
  constructor(read, label) {
    this.read = read;
    this.label = label;
    this.published = read();
  }
  read;
  label;
  listeners = /* @__PURE__ */ new Set();
  published;
  getSnapshot = () => this.read();
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
    notifySubscribers(this.listeners, this.label);
  }
};
var TurnKindNodes = class {
  nodes = /* @__PURE__ */ new Map();
  current = EMPTY_LIST;
  dirty = false;
  observable;
  source() {
    return this.observable ??= new MutableChatSource(() => this.read(), "[ui-chat] turn kind nodes");
  }
  set(node) {
    const previous = this.nodes.get(node.key);
    this.nodes.set(node.key, node);
    if (previous !== void 0 && previous.data === node.data && previous.anchorSeq === node.anchorSeq) return;
    this.dirty = true;
  }
  delete(key) {
    this.nodes.delete(key);
    this.dirty = true;
  }
  publish() {
    this.observable?.publish();
  }
  read() {
    if (this.dirty) {
      this.current = [...this.nodes.values()].sort((a, b) => a.anchorSeq - b.anchorSeq).map((node) => node.data);
      this.dirty = false;
    }
    return this.current;
  }
};
var MutableChatNodeStore = class {
  byKey = /* @__PURE__ */ new Map();
  turnProcesses = new ChatTurnProcessProjector();
  sources = /* @__PURE__ */ new Map();
  processSources = /* @__PURE__ */ new Map();
  bottomSources = /* @__PURE__ */ new Map();
  /** Bottom membership: the latest loaded exchange. */
  exchanges = new GroupTreeSegments("exchange");
  dirtyKeys = /* @__PURE__ */ new Set();
  dirtyBottomKeys = /* @__PURE__ */ new Set();
  dirtyProcessKeys = /* @__PURE__ */ new Set();
  turnKinds = /* @__PURE__ */ new Map();
  dirtyTurnKinds = /* @__PURE__ */ new Set();
  valuesCache = EMPTY_LIST;
  valuesDirty = false;
  get(key) {
    return this.byKey.get(key);
  }
  source(key) {
    return cachedSource(this.sources, key, () => new MutableChatSource(
      () => this.get(key),
      `[ui-chat] node source ${key}`
    ));
  }
  bottomSource(key) {
    return cachedSource(this.bottomSources, key, () => new MutableChatSource(() => {
      const node = this.get(key);
      return node !== void 0 && isVisibleChatNode(node) && this.exchanges.inLatest(locationCoordinates(node.location).turn);
    }, `[ui-chat] node bottom source ${key}`));
  }
  /**
   * Settle the latest exchange for the loaded Turns and mark the Nodes of
   * Turns that entered or left it.
   * @param turnOrder - loaded Turns in ascending timeline order.
   * @param locations - current Chat Location index.
   */
  settleBottom(turnOrder, locations) {
    for (const turn of this.exchanges.settle(turnOrder)) {
      for (const key of locations.getTurn(turn)) this.dirtyBottomKeys.add(key);
    }
  }
  turnDataSource(turn, kind) {
    return this.turnKind(turn, kind).source();
  }
  turnKind(turn, kind) {
    const kinds = cachedSource(this.turnKinds, turn, () => /* @__PURE__ */ new Map());
    return cachedSource(kinds, kind, () => new TurnKindNodes());
  }
  updateTurnKind(previous, next) {
    const before = previous === void 0 ? void 0 : locationCoordinates(previous.location).turn;
    const after = next === void 0 ? void 0 : locationCoordinates(next.location).turn;
    if (previous !== void 0 && before !== void 0 && (before !== after || previous.kind !== next?.kind)) {
      const collection = this.turnKind(before, previous.kind);
      collection.delete(previous.key);
      this.dirtyTurnKinds.add(collection);
    }
    if (next !== void 0 && after !== void 0) {
      const collection = this.turnKind(after, next.kind);
      collection.set(next);
      this.dirtyTurnKinds.add(collection);
    }
  }
  processSource(key) {
    return cachedSource(this.processSources, key, () => new MutableChatSource(
      () => this.process(key),
      `[ui-chat] node process source ${key}`
    ));
  }
  process(key) {
    return this.turnProcesses.get(this.get(key));
  }
  values() {
    if (this.valuesDirty) {
      this.valuesCache = [...this.byKey.values()];
      this.valuesDirty = false;
    }
    return this.valuesCache;
  }
  replace(nodes) {
    const previous = new Map(this.byKey);
    this.byKey.clear();
    for (const node of nodes) {
      this.byKey.set(node.key, node);
      if (previous.get(node.key) !== node) {
        this.updateTurnKind(previous.get(node.key), node);
        this.exchanges.track(previous.get(node.key), node);
        this.dirtyKeys.add(node.key);
        this.dirtyProcessKeys.add(node.key);
      }
      previous.delete(node.key);
    }
    for (const key of previous.keys()) {
      this.updateTurnKind(previous.get(key), void 0);
      this.exchanges.track(previous.get(key), void 0);
      this.dirtyKeys.add(key);
      this.dirtyProcessKeys.add(key);
    }
    this.valuesCache = [...this.byKey.values()];
    this.valuesDirty = false;
  }
  upsert(nodes) {
    let changed = false;
    for (const node of nodes) {
      if (this.byKey.get(node.key) === node) continue;
      this.updateTurnKind(this.byKey.get(node.key), node);
      this.exchanges.track(this.byKey.get(node.key), node);
      this.byKey.set(node.key, node);
      this.dirtyKeys.add(node.key);
      this.dirtyProcessKeys.add(node.key);
      changed = true;
    }
    if (changed) this.valuesDirty = true;
  }
  touchProcesses(turns, locations) {
    for (const turn of turns) {
      for (const key of locations.getTurn(turn)) this.dirtyProcessKeys.add(key);
    }
  }
  replaceProcesses(order, locations) {
    this.touchProcesses(this.turnProcesses.replace(order, locations, this), locations);
  }
  updateProcesses(turns, locations) {
    this.touchProcesses(this.turnProcesses.update(turns, locations, this), locations);
  }
  publish() {
    const dirty = [...this.dirtyKeys];
    const dirtyBottom = /* @__PURE__ */ new Set([...this.dirtyBottomKeys, ...dirty]);
    const dirtyProcesses = [...this.dirtyProcessKeys];
    const dirtyTurnKinds = [...this.dirtyTurnKinds];
    this.dirtyKeys.clear();
    this.dirtyBottomKeys.clear();
    this.dirtyProcessKeys.clear();
    this.dirtyTurnKinds.clear();
    for (const key of dirty) this.sources.get(key)?.publish();
    for (const key of dirtyBottom) this.bottomSources.get(key)?.publish();
    for (const key of dirtyProcesses) this.processSources.get(key)?.publish();
    for (const collection of dirtyTurnKinds) collection.publish();
  }
};
var MutableChatLocationIndex = class {
  turns = /* @__PURE__ */ new Map();
  steps = /* @__PURE__ */ new Map();
  positions = /* @__PURE__ */ new Map();
  getTurn(turn) {
    return this.turns.get(turn) ?? EMPTY_KEYS;
  }
  getStep(turn, step) {
    return this.steps.get(stepKey(turn, step)) ?? EMPTY_KEYS;
  }
  getPosition(key) {
    return this.positions.get(key);
  }
  rebuild(order, store) {
    const turns = /* @__PURE__ */ new Map();
    const steps = /* @__PURE__ */ new Map();
    const positions = /* @__PURE__ */ new Map();
    const changedTurns = /* @__PURE__ */ new Set();
    for (const [index, key] of order.entries()) {
      const location = store.get(key)?.location;
      if (location === void 0) continue;
      const coordinates = locationCoordinates(location);
      const previous = this.positions.get(key);
      const position = {
        turn: coordinates.turn,
        previous: order[index - 1],
        next: order[index + 1]
      };
      const unchanged = previous !== void 0 && previous.turn === position.turn && previous.previous === position.previous && previous.next === position.next;
      positions.set(key, unchanged ? previous : position);
      if (!unchanged) {
        if (previous?.turn !== void 0) changedTurns.add(previous.turn);
        if (position.turn !== void 0) changedTurns.add(position.turn);
      }
      if (coordinates.turn === void 0) continue;
      const turnKeys = turns.get(coordinates.turn) ?? [];
      turnKeys.push(key);
      turns.set(coordinates.turn, turnKeys);
      if (coordinates.step === void 0) continue;
      const step = stepKey(coordinates.turn, coordinates.step);
      const stepKeys = steps.get(step) ?? [];
      stepKeys.push(key);
      steps.set(step, stepKeys);
    }
    for (const [key, position] of this.positions) {
      if (!positions.has(key) && position.turn !== void 0) changedTurns.add(position.turn);
    }
    this.positions = positions;
    this.turns = updateIndex(this.turns, turns);
    this.steps = updateIndex(this.steps, steps);
    return [...changedTurns];
  }
  /** Invalidate aggregate readers when member data changes without moving. */
  touch(nodes) {
    const turns = /* @__PURE__ */ new Set();
    const steps = /* @__PURE__ */ new Set();
    for (const node of nodes) {
      const coordinates = locationCoordinates(node.location);
      if (coordinates.turn === void 0 || !this.turns.get(coordinates.turn)?.includes(node.key)) continue;
      turns.add(coordinates.turn);
      if (coordinates.step !== void 0) steps.add(stepKey(coordinates.turn, coordinates.step));
    }
    for (const turn of turns) {
      const keys = this.turns.get(turn);
      if (keys === void 0) continue;
      this.turns.set(turn, [...keys]);
    }
    for (const step of steps) {
      const keys = this.steps.get(step);
      if (keys === void 0) continue;
      this.steps.set(step, [...keys]);
    }
  }
};
function updateIndex(previous, nextMutable) {
  const next = /* @__PURE__ */ new Map();
  const keys = /* @__PURE__ */ new Set([...previous.keys(), ...nextMutable.keys()]);
  for (const key of keys) {
    const before = previous.get(key) ?? EMPTY_KEYS;
    const candidate = nextMutable.get(key) ?? EMPTY_KEYS;
    const value = sameReferences(before, candidate) ? before : candidate;
    if (candidate.length > 0) next.set(key, value);
  }
  return next;
}
var MutableTurnNavigationIndex = class {
  current = EMPTY_ITEMS;
  byTurn = /* @__PURE__ */ new Map();
  items() {
    return this.current;
  }
  /** Re-derive the whole Turn set; runs only when the loaded structure moves. */
  rebuild(timeline, locations, nodes) {
    const next = [];
    const byTurn = /* @__PURE__ */ new Map();
    for (const turn of timeline.turnOrder) {
      const derived = turnNavigationItem(turn, locations, nodes);
      if (derived === void 0) continue;
      const previous = this.byTurn.get(turn);
      const item = previous !== void 0 && sameTurnNavigationItem(previous, derived) ? previous : derived;
      next.push(item);
      byTurn.set(turn, item);
    }
    this.byTurn = byTurn;
    const unchanged = next.length === this.current.length && next.every((item, index) => item === this.current[index]);
    if (!unchanged) this.current = next;
  }
  /** Re-derive only the Turns a content-only upsert touched. */
  touch(turns, locations, nodes) {
    if (turns.size === 0) return;
    const next = this.current.map((item) => {
      if (!turns.has(item.turn)) return item;
      const derived = turnNavigationItem(item.turn, locations, nodes);
      if (derived === void 0 || sameTurnNavigationItem(item, derived)) return item;
      this.byTurn.set(item.turn, derived);
      return derived;
    });
    if (next.some((item, index) => item !== this.current[index])) this.current = next;
  }
};
function stepKey(turn, step) {
  return `${turn}:${step}`;
}
function locationTurnStatus(location) {
  return location.kind === "turn" || location.kind === "step" ? location.turn.status : void 0;
}
function processPresentationInputChanged(previous, next, structural) {
  if (structural || previous === void 0) return true;
  if (locationTurnStatus(previous.location) !== locationTurnStatus(next.location)) return true;
  if (previous.kind === "turn-process" && next.kind === "turn-process") {
    return previous.data !== next.data;
  }
  return previous.kind === "assistant-step" && next.kind === "assistant-step" && previous.data.step !== next.data.step;
}
function turnProcessPresentations(nodes) {
  const presentations = /* @__PURE__ */ new Map();
  for (const raw of nodes) {
    const node = raw;
    if (node.kind === "turn-process") {
      presentations.set(node.data.turn, { ...presentations.get(node.data.turn), control: node });
    }
  }
  for (const raw of nodes) {
    const node = raw;
    const location = node.location;
    if (location.kind !== "turn" && location.kind !== "step") continue;
    const current = presentations.get(location.turn.turn) ?? {};
    const controlAnchor = current.control?.data.controlAnchorSeq;
    if (isAtOrOutside(node, "input") && controlAnchor !== void 0 && (controlAnchor === location.turn.start?.seq || node.anchorSeq < controlAnchor)) {
      presentations.set(location.turn.turn, {
        ...current,
        openingInputAnchor: Math.max(current.openingInputAnchor ?? node.anchorSeq, node.anchorSeq)
      });
      continue;
    }
    if (isAtOrOutside(node, "turn")) continue;
    presentations.set(location.turn.turn, {
      ...current,
      earliestProcessAnchor: Math.min(current.earliestProcessAnchor ?? node.anchorSeq, node.anchorSeq)
    });
  }
  return presentations;
}
function presentationPosition(raw, presentations) {
  const node = raw;
  const location = node.location;
  if (location.kind !== "turn" && location.kind !== "step") {
    return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq };
  }
  const presentation = presentations.get(location.turn.turn);
  if (presentation === void 0) {
    return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq };
  }
  const openingInputAnchor = presentation.openingInputAnchor;
  if (openingInputAnchor !== void 0 && node.anchorSeq < openingInputAnchor && !isAtOrOutside(node, "turn")) {
    return { anchor: openingInputAnchor, rank: 2, originalAnchor: node.anchorSeq };
  }
  if (presentation.control !== void 0 && node.key === presentation.control.key) {
    return openingInputAnchor === void 0 ? {
      anchor: presentation.earliestProcessAnchor ?? node.anchorSeq,
      rank: -1,
      originalAnchor: node.anchorSeq
    } : { anchor: openingInputAnchor, rank: 1, originalAnchor: node.anchorSeq };
  }
  return { anchor: node.anchorSeq, rank: 0, originalAnchor: node.anchorSeq };
}
function orderedVisibleChatNodes(nodes) {
  const visible = nodes.filter((node) => isVisibleChatNode(node));
  const presentations = turnProcessPresentations(visible);
  return visible.sort((left, right) => {
    const leftPosition = presentationPosition(left, presentations);
    const rightPosition = presentationPosition(right, presentations);
    return leftPosition.anchor - rightPosition.anchor || leftPosition.rank - rightPosition.rank || leftPosition.originalAnchor - rightPosition.originalAnchor || left.key.localeCompare(right.key);
  });
}
function referenceMessageSeq(node) {
  const candidate = node;
  return candidate.kind === "user" || candidate.kind === "steering" ? candidate.data.seq : void 0;
}
function followingRecall(node) {
  const candidate = node;
  if (candidate.kind !== "context") return void 0;
  return {
    messageSeq: candidate.data.seq - 1,
    labels: sessionRecallLabels(candidate.data.source)
  };
}
function withReferenceLabels(node, labels) {
  const candidate = node;
  if (candidate.kind !== "user" && candidate.kind !== "steering") return node;
  const current = candidate.data.referenceLabels ?? EMPTY_KEYS;
  const hasLabels = Object.hasOwn(candidate.data, "referenceLabels");
  if (sameReferences(current, labels) && hasLabels === labels.length > 0) return node;
  const data = { ...candidate.data };
  if (labels.length === 0) delete data.referenceLabels;
  else data.referenceLabels = labels;
  return { ...candidate, data };
}
var ReferenceLabelProjector = class {
  messagesBySeq = /* @__PURE__ */ new Map();
  labelsByMessageSeq = /* @__PURE__ */ new Map();
  replace(nodes) {
    this.messagesBySeq.clear();
    this.labelsByMessageSeq.clear();
    for (const node of nodes) {
      const messageSeq = referenceMessageSeq(node);
      if (messageSeq !== void 0) this.messagesBySeq.set(messageSeq, node.key);
      const recall = followingRecall(node);
      if (recall !== void 0 && recall.labels.length > 0) {
        this.labelsByMessageSeq.set(recall.messageSeq, recall.labels);
      }
    }
    return nodes.map((node) => {
      const messageSeq = referenceMessageSeq(node);
      return messageSeq === void 0 ? node : withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS);
    });
  }
  apply(upserts, store) {
    const byKey = new Map(upserts.map((node) => [node.key, node]));
    const affected = /* @__PURE__ */ new Set();
    for (const node of upserts) {
      const messageSeq = referenceMessageSeq(node);
      if (messageSeq !== void 0) {
        this.messagesBySeq.set(messageSeq, node.key);
        affected.add(messageSeq);
      }
      const recall = followingRecall(node);
      if (recall === void 0) continue;
      const current = this.labelsByMessageSeq.get(recall.messageSeq);
      if (recall.labels.length === 0) this.labelsByMessageSeq.delete(recall.messageSeq);
      else {
        this.labelsByMessageSeq.set(
          recall.messageSeq,
          current !== void 0 && sameReferences(current, recall.labels) ? current : recall.labels
        );
      }
      affected.add(recall.messageSeq);
    }
    for (const messageSeq of affected) {
      const key = this.messagesBySeq.get(messageSeq);
      if (key === void 0) continue;
      const node = byKey.get(key) ?? store.get(key);
      if (node === void 0) continue;
      byKey.set(key, withReferenceLabels(node, this.labelsByMessageSeq.get(messageSeq) ?? EMPTY_KEYS));
    }
    return [...byKey.values()];
  }
};
function withSkillNames(node, names) {
  const candidate = node;
  if (candidate.kind !== "user" && candidate.kind !== "steering") return node;
  const current = candidate.data.skillNames ?? EMPTY_KEYS;
  const hasNames = Object.hasOwn(candidate.data, "skillNames");
  if (sameReferences(current, names) && hasNames === names.length > 0) return node;
  const data = { ...candidate.data };
  if (names.length === 0) delete data.skillNames;
  else data.skillNames = names;
  return { ...candidate, data };
}
function slashEntryOf(node) {
  const candidate = node;
  if (candidate.kind === "user" || candidate.kind === "steering") {
    return { key: node.key, seq: node.anchorSeq, kind: "message", name: null };
  }
  if (candidate.kind === "context") {
    const name = skillInvocationName(candidate.data.source);
    return name === null ? null : { key: node.key, seq: node.anchorSeq, kind: "skill", name };
  }
  return { key: node.key, seq: node.anchorSeq, kind: "boundary", name: null };
}
function sameSlashEntry(left, right) {
  return left.seq === right.seq && left.kind === right.kind && left.name === right.name;
}
var SkillNameProjector = class {
  entries = /* @__PURE__ */ new Map();
  /** Every indexed entry in `anchorSeq` order. */
  sorted = [];
  /**
   * Rebuild the index from a whole Node set and attach names to its messages.
   * @param nodes - every materialized Chat Node, in any order.
   * @returns the same Nodes, direct messages carrying their batch's names.
   */
  replace(nodes) {
    this.entries.clear();
    this.sorted = [];
    for (const node of nodes) {
      const entry = slashEntryOf(node);
      if (entry === null) continue;
      this.entries.set(entry.key, entry);
      this.sorted.push(entry);
    }
    this.sorted.sort((left, right) => left.seq - right.seq);
    const names = /* @__PURE__ */ new Map();
    for (let index = 0; index < this.sorted.length; index++) {
      if (this.sorted[index]?.kind === "boundary") continue;
      const end = this.runEnd(index);
      this.assignRun(index, end, names);
      index = end;
    }
    return nodes.map((node) => withSkillNames(node, names.get(node.key) ?? EMPTY_KEYS));
  }
  /**
   * Fold one incremental upsert set: re-read only the batches around the
   * Nodes whose classification changed.
   * @param upserts - the changed Nodes.
   * @param store - the resident Nodes, read by key for the messages of an affected batch.
   * @returns the upserts plus any resident message whose names changed.
   */
  apply(upserts, store) {
    const dirty = [];
    for (const node of upserts) {
      const next = slashEntryOf(node);
      const previous = this.entries.get(node.key);
      if (previous !== void 0) {
        if (next !== null && sameSlashEntry(previous, next)) {
          if (next.kind === "message") dirty.push(next.seq);
          continue;
        }
        this.remove(previous);
        dirty.push(previous.seq);
      }
      if (next === null) continue;
      this.insert(next);
      dirty.push(next.seq);
    }
    if (dirty.length === 0) return upserts;
    const names = /* @__PURE__ */ new Map();
    for (const seq of dirty) this.collectAround(seq, names);
    const byKey = new Map(upserts.map((node) => [node.key, node]));
    for (const [key, list] of names) {
      const node = byKey.get(key) ?? store.get(key);
      if (node === void 0) continue;
      const next = withSkillNames(node, list);
      if (next !== node || byKey.has(key)) byKey.set(key, next);
    }
    return [...byKey.values()];
  }
  insert(entry) {
    this.sorted.splice(this.lowerBound(entry.seq), 0, entry);
    this.entries.set(entry.key, entry);
  }
  remove(entry) {
    this.sorted.splice(this.sorted.indexOf(entry), 1);
    this.entries.delete(entry.key);
  }
  /** First index whose seq is at least `seq`. */
  lowerBound(seq) {
    let low = 0;
    let high = this.sorted.length;
    while (low < high) {
      const middle = low + high >>> 1;
      if ((this.sorted[middle]?.seq ?? Number.POSITIVE_INFINITY) < seq) low = middle + 1;
      else high = middle;
    }
    return low;
  }
  /** Last index of the boundary-free run containing `index`. */
  runEnd(index) {
    let end = index;
    while (end + 1 < this.sorted.length && this.sorted[end + 1]?.kind !== "boundary") end++;
    return end;
  }
  /** First index of the boundary-free run containing `index`. */
  runStart(index) {
    let start = index;
    while (start - 1 >= 0 && this.sorted[start - 1]?.kind !== "boundary") start--;
    return start;
  }
  /** Record the names every message of the run `[start, end]` carries. */
  assignRun(start, end, names) {
    const list = [];
    for (let index = start; index <= end; index++) {
      const entry = this.sorted[index];
      if (entry?.kind === "skill" && entry.name !== null && !list.includes(entry.name)) list.push(entry.name);
    }
    for (let index = start; index <= end; index++) {
      const entry = this.sorted[index];
      if (entry?.kind === "message") names.set(entry.key, list);
    }
  }
  /**
   * Re-read the run(s) around one changed seq: the run holding a message or
   * skill entry, or — for a boundary, or a seq that left the index — the runs
   * on both sides of that position.
   */
  collectAround(seq, names) {
    const at = this.lowerBound(seq);
    const here = this.sorted[at];
    if (here !== void 0 && here.seq === seq && here.kind !== "boundary") {
      this.assignRun(this.runStart(at), this.runEnd(at), names);
      return;
    }
    if (at - 1 >= 0 && this.sorted[at - 1]?.kind !== "boundary") {
      this.assignRun(this.runStart(at - 1), at - 1, names);
    }
    const right = here !== void 0 && here.seq === seq ? at + 1 : at;
    if (right < this.sorted.length && this.sorted[right]?.kind !== "boundary") {
      this.assignRun(right, this.runEnd(right), names);
    }
  }
};
var EMPTY_CONTRIBUTION = {
  anchorSeq: 0,
  nodes: EMPTY_LIST,
  partial: null,
  running: null
};
function legacyContribution(raw) {
  const node = raw;
  if (raw.visibility !== "visible" && node.kind !== "assistant-step") return EMPTY_CONTRIBUTION;
  switch (node.kind) {
    case "user":
    case "steering":
    case "context":
    case "command":
    case "compaction":
    case "turn-error":
    case "turn-max-tokens":
    case "unknown":
      return { anchorSeq: node.anchorSeq, nodes: [node.data], partial: null, running: null };
    case "assistant-step": {
      const data = node.data;
      if (data.status === "running") {
        if (raw.visibility !== "visible") return EMPTY_CONTRIBUTION;
        return {
          anchorSeq: node.anchorSeq,
          nodes: EMPTY_LIST,
          partial: { turn: data.turn, step: data.step, blocks: data.blocks },
          running: null
        };
      }
      return {
        anchorSeq: node.anchorSeq,
        nodes: data.finalNode === void 0 ? EMPTY_LIST : [data.finalNode],
        partial: null,
        running: null
      };
    }
    case "tool-call": {
      const root = node.data.root;
      return isRunningTool(root) ? { anchorSeq: node.anchorSeq, nodes: EMPTY_LIST, partial: null, running: root } : { anchorSeq: node.anchorSeq, nodes: [root], partial: null, running: null };
    }
    case "manual-compaction": {
      const data = node.data;
      return {
        anchorSeq: node.anchorSeq,
        nodes: data.compaction === null ? [data.command] : [data.command, data.compaction],
        partial: null,
        running: null
      };
    }
    case "model-retry":
      return {
        anchorSeq: node.anchorSeq,
        nodes: node.data.attempts,
        partial: null,
        running: null
      };
    case "turn-tail":
    case "system-prompt":
      return EMPTY_CONTRIBUTION;
    default:
      return EMPTY_CONTRIBUTION;
  }
}
function sameContribution(left, right) {
  return left !== void 0 && left.anchorSeq === right.anchorSeq && left.partial?.blocks === right.partial?.blocks && left.partial?.turn === right.partial?.turn && left.partial?.step === right.partial?.step && left.running === right.running && sameReferences(left.nodes, right.nodes);
}
var LegacySliceBuilder = class {
  contributions = /* @__PURE__ */ new Map();
  finalizedContributions = /* @__PURE__ */ new Map();
  runningContributions = /* @__PURE__ */ new Map();
  partialContributions = /* @__PURE__ */ new Map();
  finalized = EMPTY_LIST;
  runningCalls = EMPTY_LIST;
  partial = null;
  timeline;
  turnTimings = /* @__PURE__ */ new Map();
  turnEnds = /* @__PURE__ */ new Map();
  replace(nodes, timeline) {
    this.contributions.clear();
    this.finalizedContributions.clear();
    this.runningContributions.clear();
    this.partialContributions.clear();
    for (const node of nodes) {
      const contribution = legacyContribution(node);
      this.contributions.set(node.key, contribution);
      this.indexContribution(node.key, contribution);
    }
    this.rebuildFinalized();
    this.rebuildRunning();
    this.rebuildPartial();
    this.updateTimeline(timeline);
    return this.snapshot();
  }
  apply(upserts, timeline) {
    let finalizedChanged = false;
    let runningChanged = false;
    let partialChanged = false;
    for (const node of upserts) {
      const contribution = legacyContribution(node);
      const previous = this.contributions.get(node.key);
      if (sameContribution(previous, contribution)) continue;
      finalizedChanged ||= finalizedContributionChanged(previous, contribution);
      runningChanged ||= runningContributionChanged(previous, contribution);
      partialChanged ||= partialContributionChanged(previous, contribution);
      this.contributions.set(node.key, contribution);
      this.indexContribution(node.key, contribution);
    }
    if (finalizedChanged) this.rebuildFinalized();
    if (runningChanged) this.rebuildRunning();
    if (partialChanged) this.rebuildPartial();
    this.updateTimeline(timeline);
    return this.snapshot();
  }
  indexContribution(key, contribution) {
    updateContributionIndex(this.finalizedContributions, key, contribution, contribution.nodes.length > 0);
    updateContributionIndex(this.runningContributions, key, contribution, contribution.running !== null);
    updateContributionIndex(this.partialContributions, key, contribution, contribution.partial !== null);
  }
  rebuildFinalized() {
    const finalized = [...this.finalizedContributions.values()].flatMap((value) => value.nodes).sort((left, right) => left.seq - right.seq);
    if (!sameReferences(this.finalized, finalized)) this.finalized = finalized;
  }
  rebuildRunning() {
    const runningCalls = [...this.runningContributions.values()].sort((left, right) => left.anchorSeq - right.anchorSeq).flatMap((value) => value.running === null ? [] : [value.running]);
    if (!sameReferences(this.runningCalls, runningCalls)) this.runningCalls = runningCalls;
  }
  rebuildPartial() {
    const partial = [...this.partialContributions.values()].sort((left, right) => left.anchorSeq - right.anchorSeq).findLast((value) => value.partial !== null)?.partial ?? null;
    if (this.partial?.blocks !== partial?.blocks || this.partial?.turn !== partial?.turn || this.partial?.step !== partial?.step) this.partial = partial;
  }
  updateTimeline(timeline) {
    if (this.timeline === timeline) return;
    this.timeline = timeline;
    const turnTimings = /* @__PURE__ */ new Map();
    const turnEnds = /* @__PURE__ */ new Map();
    for (const turn of timeline.turns.values()) {
      if (turn.start !== void 0) {
        turnTimings.set(turn.turn, {
          startTime: turn.start.time,
          ...turn.end === void 0 ? {} : { endTime: turn.end.time }
        });
      }
      if (turn.end !== void 0) turnEnds.set(turn.turn, turn.end.seq);
    }
    this.turnTimings = turnTimings;
    this.turnEnds = turnEnds;
  }
  snapshot() {
    return {
      nodes: this.finalized,
      turnTimings: this.turnTimings,
      turnEnds: this.turnEnds,
      partial: this.partial,
      runningCalls: this.runningCalls
    };
  }
};
function updateContributionIndex(index, key, contribution, present) {
  if (present) index.set(key, contribution);
  else index.delete(key);
}
function finalizedContributionChanged(previous, next) {
  const previousNodes = previous?.nodes ?? EMPTY_LIST;
  return !sameReferences(previousNodes, next.nodes) || (previousNodes.length > 0 || next.nodes.length > 0) && previous?.anchorSeq !== next.anchorSeq;
}
function runningContributionChanged(previous, next) {
  return previous?.running !== next.running || (previous.running !== null || next.running !== null) && previous.anchorSeq !== next.anchorSeq;
}
function partialContributionChanged(previous, next) {
  return previous?.partial?.blocks !== next.partial?.blocks || previous?.partial?.turn !== next.partial?.turn || previous?.partial?.step !== next.partial?.step || ((previous?.partial ?? null) !== null || next.partial !== null) && previous?.anchorSeq !== next.anchorSeq;
}
var ChatSnapshotBuilder = class {
  store = new MutableChatNodeStore();
  locations = new MutableChatLocationIndex();
  navigation = new MutableTurnNavigationIndex();
  legacy = new LegacySliceBuilder();
  referenceLabels = new ReferenceLabelProjector();
  skillNames = new SkillNameProjector();
  order = EMPTY_KEYS;
  latestGroupInput;
  readGroupNode = (key) => this.store.get(key);
  readGroupTurn = (turn) => this.locations.getTurn(turn);
  readGroupPosition = (key) => this.locations.getPosition(key);
  /** Last published timeline: a Turn boundary can land without a new node. */
  timeline = null;
  empty;
  constructor() {
    this.empty = this.snapshot({ turnOrder: EMPTY_TURNS, turns: /* @__PURE__ */ new Map() });
    this.latestGroupInput = {
      kind: "replace",
      order: this.order,
      readNode: this.readGroupNode,
      readTurn: this.readGroupTurn,
      readPosition: this.readGroupPosition,
      timeline: this.empty.timeline
    };
  }
  replace(input) {
    const nodes = this.skillNames.replace(this.referenceLabels.replace(input.nodes));
    this.store.replace(nodes);
    this.order = orderedVisibleChatNodes(nodes).map((node) => node.key);
    this.locations.rebuild(this.order, this.store);
    this.store.replaceProcesses(this.order, this.locations);
    this.store.settleBottom(input.timeline.turnOrder, this.locations);
    this.navigation.rebuild(input.timeline, this.locations, this.store);
    this.timeline = input.timeline;
    this.latestGroupInput = {
      kind: "replace",
      order: this.order,
      readNode: this.readGroupNode,
      readTurn: this.readGroupTurn,
      readPosition: this.readGroupPosition,
      timeline: input.timeline
    };
    const snapshot = this.snapshot(input.timeline, this.legacy.replace(nodes, input.timeline));
    return snapshot;
  }
  apply(input) {
    const upserts = this.skillNames.apply(this.referenceLabels.apply(input.upserts, this.store), this.store);
    const processTurns = /* @__PURE__ */ new Set();
    let structural = false;
    const contentOnly = [];
    const changes = [];
    for (const node of upserts) {
      const previous = this.store.get(node.key);
      if (previous !== node) changes.push({ previous, current: node });
      const nodeStructural = previous === void 0 || previous.kind !== node.kind || previous.anchorSeq !== node.anchorSeq || previous.visibility !== node.visibility || previous.groupTree !== node.groupTree || locationIdentity(previous.location) !== locationIdentity(node.location);
      structural ||= nodeStructural;
      if (!nodeStructural) contentOnly.push(node);
      if (processPresentationInputChanged(previous, node, nodeStructural)) {
        const previousTurn = previous === void 0 ? void 0 : locationCoordinates(previous.location).turn;
        const nextTurn = locationCoordinates(node.location).turn;
        if (previousTurn !== void 0) processTurns.add(previousTurn);
        if (nextTurn !== void 0) processTurns.add(nextTurn);
      }
    }
    this.store.upsert(upserts);
    let changedTurnOrders = EMPTY_TURNS;
    if (structural) {
      const next = orderedVisibleChatNodes(this.store.values()).map((node) => node.key);
      this.order = sameReferences(this.order, next) ? this.order : next;
      changedTurnOrders = this.locations.rebuild(this.order, this.store);
    }
    this.locations.touch(contentOnly);
    this.store.updateProcesses(processTurns, this.locations);
    this.store.settleBottom(input.timeline.turnOrder, this.locations);
    if (structural || input.timeline !== this.timeline) {
      this.navigation.rebuild(input.timeline, this.locations, this.store);
    } else {
      this.navigation.touch(turnsOf(contentOnly), this.locations, this.store);
    }
    this.timeline = input.timeline;
    this.latestGroupInput = {
      kind: "apply",
      changes,
      order: this.order,
      readNode: this.readGroupNode,
      readTurn: this.readGroupTurn,
      readPosition: this.readGroupPosition,
      timeline: input.timeline,
      changedTurns: input.changedTurns ?? EMPTY_TURNS,
      changedTurnOrders
    };
    const snapshot = this.snapshot(input.timeline, this.legacy.apply(upserts, input.timeline));
    return snapshot;
  }
  groupInput() {
    return this.latestGroupInput;
  }
  publish() {
    this.store.publish();
  }
  snapshot(timeline, legacy = this.legacy.replace(EMPTY_LIST, timeline)) {
    return {
      order: this.order,
      nodes: this.store,
      locations: this.locations,
      navigation: this.navigation,
      timeline,
      legacy
    };
  }
};
function turnsOf(nodes) {
  const turns = /* @__PURE__ */ new Set();
  for (const node of nodes) {
    const turn = locationCoordinates(node.location).turn;
    if (turn !== void 0) turns.add(turn);
  }
  return turns;
}
function locationIdentity(location) {
  const coordinates = locationCoordinates(location);
  return `${location.kind}:${coordinates.turn ?? ""}:${coordinates.step ?? ""}`;
}
var chatViewDefinition = {
  target: "chat",
  create: () => new ChatSnapshotBuilder(),
  isActive: (snapshot) => snapshot.order.some((key) => snapshot.nodes.get(key)?.kind !== "command")
};
function registerChatConversationView(ctx) {
  ctx.uiConversation.views.register(chatViewDefinition);
}

// packages/client/ui-chat/src/client/conversation-nodes/command.ts
var COMPACT_KIND = "compact-checkpoint";
function commandFromRun(match) {
  if (match.event.type !== "command/run") throw new Error("command start requires command/run");
  const data = match.event.data;
  return {
    kind: "command",
    seq: match.event.seq,
    time: match.event.time,
    commandId: data.commandId,
    name: data.name,
    args: data.args ?? null,
    outcome: null
  };
}
function commandFromDone(match, previous) {
  if (match.event.type !== "command/done") throw new Error("command update requires command/done");
  const data = match.event.data;
  const sourceEventSeq = data.kind === "success" && data.sourceEventSeq !== void 0 && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0 ? data.sourceEventSeq : void 0;
  return {
    kind: "command",
    seq: previous?.seq ?? match.event.seq,
    time: previous?.time ?? match.event.time,
    commandId: data.commandId,
    name: previous?.name ?? null,
    args: previous?.args ?? null,
    outcome: {
      kind: data.kind,
      ...data.text === void 0 ? {} : { text: data.text },
      ...sourceEventSeq === void 0 ? {} : { sourceEventSeq }
    }
  };
}
function compactSource(event) {
  if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return void 0;
  const source = event.data.source;
  if (source.kind !== COMPACT_KIND || typeof source.compactionId !== "string") return void 0;
  return {
    compactionId: source.compactionId,
    ...source.sourceCommandId === void 0 ? {} : { sourceCommandId: source.sourceCommandId }
  };
}
function compactSummary(match, checkpoint) {
  let summary = null;
  let shadowedItemCount = null;
  let shadowedTokenCount = null;
  if (match?.event.type === "compaction/summary") {
    const data = match.event.data;
    if (Array.isArray(data.summary)) {
      const text = data.summary.map((block) => block.type === "text" ? block.text : "").join("");
      summary = text.trim() === "" ? null : text;
    }
    shadowedItemCount = Array.isArray(data.shadowedSeqs) && data.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0) ? data.shadowedSeqs.length : null;
    shadowedTokenCount = Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0 ? data.shadowedTokenCount : null;
  }
  return {
    kind: "compaction",
    seq: checkpoint.event.seq,
    time: checkpoint.event.time,
    summary,
    summaryEventSeq: match?.event.seq ?? null,
    shadowedItemCount,
    shadowedTokenCount
  };
}
function fallbackState2(context) {
  const done = context.matches.find((match) => match.event.type === "command/done");
  const checkpoint = context.matches.find((match) => compactSource(match.event) !== void 0);
  const summary = context.matches.find((match) => match.event.type === "compaction/summary");
  if (checkpoint === void 0) return done === void 0 ? void 0 : { command: commandFromDone(done) };
  const source = compactSource(checkpoint.event);
  if (source?.sourceCommandId === void 0) return done === void 0 ? void 0 : { command: commandFromDone(done) };
  const fallbackCommand = done === void 0 ? {
    kind: "command",
    seq: checkpoint.event.seq,
    time: checkpoint.event.time,
    commandId: source.sourceCommandId,
    name: "compact",
    args: null,
    outcome: null
  } : { ...commandFromDone(done), name: "compact" };
  return {
    command: fallbackCommand,
    checkpoint,
    ...summary === void 0 ? {} : { summary }
  };
}
function updateCompactionState(state, match) {
  if (match.event.type === "compaction/summary") return { ...state, summary: match };
  if (compactSource(match.event) !== void 0) return { ...state, checkpoint: match };
  return state;
}
var commandDefinition = {
  kind: "command",
  target: "chat",
  match: (event) => {
    if (event.type === "command/run") {
      return { id: String(event.data.commandId), role: "start" };
    }
    if (event.type === "command/done") {
      return { id: String(event.data.commandId), role: "update" };
    }
    const checkpoint = compactSource(event);
    if (checkpoint?.sourceCommandId !== void 0) {
      return { id: String(checkpoint.sourceCommandId), role: "update" };
    }
    if (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") {
      if (event.data.sourceCommandId !== void 0) {
        return { id: String(event.data.sourceCommandId), role: "update" };
      }
    }
    return null;
  },
  start: (_context, match) => ({ command: commandFromRun(match) }),
  update: (context, match) => {
    if (match.event.type === "command/done") {
      return { ...context.state, command: commandFromDone(match, context.state.command) };
    }
    return updateCompactionState(context.state, match);
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState2(context);
    if (state === void 0) return null;
    if (state.command.name !== "compact") {
      return chatNode(context, "command", state.command.seq, state.command);
    }
    const compaction = state.checkpoint === void 0 ? null : compactSummary(state.summary, state.checkpoint);
    const data = { command: state.command, compaction };
    return chatNode(context, "manual-compaction", compaction?.seq ?? state.command.seq, data);
  }
};
function registerCommandConversationNode(ctx) {
  ctx.uiConversation.events.register(commandDefinition);
}

// packages/client/ui-chat/src/client/conversation-nodes/compaction.ts
function fallbackState3(context) {
  const summary = context.matches.find((match) => match.event.type === "compaction/summary");
  const checkpoint = context.matches.find((match) => compactSource(match.event) !== void 0);
  return {
    ...summary === void 0 ? {} : { summary },
    ...checkpoint === void 0 ? {} : { checkpoint }
  };
}
var compactionDefinition = {
  kind: "compaction",
  target: "chat",
  match: (event) => {
    const checkpoint = compactSource(event);
    if (checkpoint !== void 0 && checkpoint.sourceCommandId === void 0) {
      return { id: checkpoint.compactionId, role: "update" };
    }
    if (event.type === "compaction/start" || event.type === "compaction/summary" || event.type === "compaction/end") {
      if (event.data.sourceCommandId !== void 0) return null;
      const compactionId = event.data.compactionId;
      if (typeof compactionId !== "string" || compactionId === "") return null;
      return { id: compactionId, role: event.type === "compaction/start" ? "start" : "update" };
    }
    return null;
  },
  start: () => ({}),
  update: (context, match) => updateCompactionState(context.state, match),
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState3(context);
    if (state.checkpoint === void 0) return null;
    const marker = compactSummary(state.summary, state.checkpoint);
    return chatNode(context, "compaction", marker.seq, marker);
  }
};
function registerCompactionConversationNode(ctx) {
  ctx.uiConversation.events.register(compactionDefinition);
}

// packages/client/ui-chat/src/client/conversation-nodes/fallback.ts
var unknownFallbackDefinition = {
  kind: "unknown-surface",
  target: "chat",
  match: (event) => event.type !== "assistant/live-chunk" && isAppendSurfaceEvent(event) ? { id: String(event.seq), role: "start" } : null,
  start: (_context, match) => ({
    kind: "unknown",
    seq: match.event.seq,
    time: match.event.time,
    type: match.event.type,
    data: match.event.data
  }),
  update: (context) => context.state,
  buildViewNode: (context) => context.state === void 0 ? null : chatNode(context, "unknown", context.state.seq, context.state)
};
function registerUnknownConversationFallback(ctx) {
  ctx.uiConversation.events.registerFallback(unknownFallbackDefinition);
}

// packages/client/ui-chat/src/client/conversation-nodes/inbox.ts
var EMPTY_PENDING = { kind: "snapshot", ids: [] };
var EMPTY_CURRENT_CLAIMED = /* @__PURE__ */ new Set();
function materializePending(state) {
  const splices = [];
  let current = state;
  while (current.kind === "splice") {
    splices.push(current);
    current = current.previous;
  }
  const pending = [...current.ids];
  for (const splice of splices.reverse()) {
    pending.splice(splice.start, splice.removedCount, ...splice.inserted);
  }
  return pending;
}
function withoutInserted(claimed, inserted) {
  let next;
  for (const { id } of inserted) {
    if (!claimed.has(id)) continue;
    next ??= new Set(claimed);
    next.delete(id);
  }
  return next ?? claimed;
}
function applySplice(previous, splice, seq) {
  const priorPending = previous?.state.pending ?? EMPTY_PENDING;
  const inserted = splice.inserted;
  const removedCount = splice.removedCount ?? 0;
  if (removedCount > 0 && splice.outcome !== "canceled") {
    const pending = materializePending(priorPending);
    const removed = pending.splice(splice.start, removedCount, ...inserted);
    return {
      pending: { kind: "snapshot", ids: pending },
      currentClaimed: new Set(removed.map((message) => message.id)),
      claimSeq: seq,
      firstClaimedHuman: removed.find((message) => message.source.kind === "user")?.id
    };
  }
  const currentClaimed = withoutInserted(
    previous?.state.currentClaimed ?? EMPTY_CURRENT_CLAIMED,
    inserted
  );
  return {
    pending: {
      kind: "splice",
      previous: priorPending,
      start: splice.start,
      removedCount,
      inserted
    },
    currentClaimed,
    claimSeq: previous?.state.claimSeq ?? -1,
    firstClaimedHuman: previous?.state.firstClaimedHuman
  };
}
function inboxDefinition(target) {
  const kind = `inbox-${target}`;
  return {
    kind,
    match: (event) => event.type === "agent/inbox/spliced" && event.data.target === target ? { id: String(event.seq), role: "start" } : null,
    start: (_context, match, reader) => {
      if (match.event.type !== "agent/inbox/spliced") throw new Error("inbox start requires agent/inbox/spliced");
      return applySplice(reader.previous(kind), match.event.data, match.event.seq);
    },
    update: (context) => context.state,
    publication: () => "none"
  };
}
var nextStepInboxDefinition = inboxDefinition("next-step");
var nextTurnInboxDefinition = inboxDefinition("next-turn");
function registerInboxConversationNodes(ctx) {
  ctx.uiConversation.events.register(nextStepInboxDefinition);
  ctx.uiConversation.events.register(nextTurnInboxDefinition);
}

// packages/client/ui-chat/src/client/conversation-nodes/message.ts
function isCompactionCheckpoint(event) {
  if (event.type !== "user/message" || !isReplacementSurfaceEvent(event)) return false;
  const source = event.data.source;
  return source.kind === "compact-checkpoint";
}
function contextMessage(event, message) {
  return {
    kind: "context",
    seq: event.seq,
    time: event.time,
    content: message.content,
    source: message.source,
    producer: contextProducer(message.source),
    form: contextForm(message.source)
  };
}
function followsProcessEvidence(location, reader) {
  if (location.kind !== "turn" && location.kind !== "step") return false;
  return reader.previous("process-evidence")?.state.turn === location.turn.turn;
}
var messageDefinition = {
  kind: "input-message",
  target: "chat",
  match: (event) => {
    if (event.type === "user/message") {
      return isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event) ? { id: String(event.data.id), role: "start" } : null;
    }
    return null;
  },
  start: (_context, match, reader) => {
    const event = match.event;
    if (event.type !== "user/message") throw new Error("input-message start requires user/message");
    if (event.data.source.kind !== "user") {
      const nextTurn = reader.previous("inbox-next-turn")?.state;
      const nextStep = reader.previous("inbox-next-step")?.state;
      const location = match.location;
      const turnStart = location.kind === "step" ? location.turn.start?.seq : void 0;
      const idleSteer = location.kind === "step" && location.step.step === 1 && turnStart !== void 0 && (nextStep?.claimSeq ?? -1) > turnStart && (nextTurn?.claimSeq ?? -1) < turnStart && nextStep !== void 0 && nextStep.firstClaimedHuman === void 0 && nextStep.currentClaimed.has(String(event.data.id));
      return {
        ...contextMessage(event, event.data),
        waking: nextTurn?.currentClaimed.has(String(event.data.id)) === true || idleSteer
      };
    }
    const id = String(event.data.id);
    const claim = reader.previous("inbox-next-step")?.state;
    return claim?.currentClaimed.has(id) === true ? {
      kind: "steering",
      messageId: event.data.id,
      seq: event.seq,
      time: event.time,
      content: event.data.content,
      source: event.data.source,
      ...claim.firstClaimedHuman === id && followsProcessEvidence(match.location, reader) ? { batchStart: true } : {}
    } : {
      kind: "user",
      messageId: event.data.id,
      seq: event.seq,
      time: event.time,
      content: event.data.content,
      source: event.data.source
    };
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === void 0) return null;
    const location = contextLocation(context);
    if (context.state.kind === "context" && context.start?.event.type === "user/message" && context.start.event.data.source.kind === "retry" && context.start.event.data.content.length === 0) {
      return chatNode(context, "turn-trigger", context.state.seq, context.state, { location, groupTree: "input" });
    }
    const waking = context.state.kind === "context" && context.start?.event.type === "user/message" && context.state.waking === true;
    const human = context.state.kind === "user" || context.state.kind === "steering";
    const opensExchange = human && location.kind === "step" && location.step.step === 1;
    return chatNode(
      context,
      waking ? "turn-trigger" : context.state.kind,
      context.state.seq,
      context.state,
      { location, groupTree: opensExchange ? "exchange" : human || waking ? "input" : void 0 }
    );
  }
};
var developerMessageDefinition = {
  ...messageDefinition,
  kind: "developer-message",
  match: (event) => event.type === "developer/message" ? { id: String(event.data.message.id), role: "start" } : null,
  start: (_context, match) => {
    const event = match.event;
    if (event.type !== "developer/message") throw new Error("developer-message start requires developer/message");
    return contextMessage(event, event.data.message);
  }
};
function registerMessageConversationNode(ctx) {
  ctx.uiConversation.events.register(messageDefinition);
  ctx.uiConversation.events.register(developerMessageDefinition);
}

// packages/client/ui-chat/src/client/conversation-nodes/request-prompt.ts
function requestPromptAnchor(match, previous, isInitial) {
  if (match.location.kind !== "step") return match.event.seq;
  if (previous === void 0 && !isInitial) return match.event.seq;
  if (previous?.turn === match.location.turn.turn && previous.step === match.location.step.step) return match.event.seq;
  return match.location.step.step === 1 ? match.location.turn.start?.seq ?? match.location.step.start?.seq ?? match.event.seq : match.location.step.start?.seq ?? match.event.seq;
}
function stableRequestPromptAnchor(context, match, previous, isInitial) {
  const current = context.current.get("chat");
  return current?.kind === "system-prompt" ? current.anchorSeq : requestPromptAnchor(match, previous, isInitial);
}
function systemMessageDefinition(inspect) {
  return {
    kind: "system-message",
    target: "chat",
    match: (event) => event.type === "system/message" || "surfaceOp" in event && event.surfaceOp !== "append" ? { id: String(event.seq), role: "start" } : null,
    start: (_context, match, reader) => {
      if (match.event.type === "assistant/live-chunk") throw new Error("system-message requires a durable event");
      return inspect(reader.previous("system-message")?.state, match.event);
    },
    update: (context) => context.state,
    buildViewNode: (context) => {
      const state = context.state?.introduced;
      if (state === void 0 || state.text === "" || context.start?.event.type !== "system/message" || context.start.event.surfaceOp !== "append") {
        const current = context.current.get("chat");
        if (current?.kind !== "system-prompt") return null;
        return chatNode(context, "system-prompt", current.anchorSeq, current.data, { visibility: "hidden" });
      }
      const anchor = state.update ? state.seq : requestPromptAnchor(context.start, void 0, true);
      return chatNode(context, "system-prompt", anchor, { text: state.text, ...state.update ? { update: true } : {} });
    }
  };
}
function requestPromptDefinition(inspect) {
  return {
    kind: "request-prompt",
    target: "chat",
    match: (event) => event.type === "request/header" ? { id: String(event.seq), role: "start" } : null,
    start: (context, match, reader) => {
      if (match.event.type !== "request/header") {
        throw new Error("request-prompt start requires request/header");
      }
      const previous = reader.previous("request-prompt")?.state;
      const systemContext = reader.previous("system-message");
      const system = systemContext?.state.effective;
      const location = match.location.kind === "step" ? { turn: match.location.turn.turn, step: match.location.step.step } : {};
      const inspection = inspect(previous?.prompt, match.event, system);
      const change = inspection.change?.kind;
      const systemEvent = systemContext?.matches[0]?.event;
      const shownByUpdate = system !== void 0 && systemEvent?.type === "system/message" && systemEvent.surfaceOp === "append" && (system.update || previous === void 0) && system.turn === location.turn && system.step === location.step;
      return {
        anchorSeq: stableRequestPromptAnchor(
          context,
          match,
          previous,
          match.event.data.reason === "initial"
        ),
        showsPrompt: !shownByUpdate && (previous === void 0 || match.event.data.reason !== "change" || match.event.data.startsSeries === true || change === "system" || change === "system-and-tools"),
        ...location,
        ...inspection
      };
    },
    update: (context) => context.state,
    buildViewNode: (context) => {
      const state = context.state;
      if (state === void 0) return null;
      const current = context.current.get("chat");
      const visible = state.showsPrompt && state.prompt.system !== "";
      if (!visible && current?.kind !== "system-prompt") return null;
      return chatNode(
        context,
        "system-prompt",
        state.anchorSeq,
        { text: state.prompt.system },
        { visibility: visible ? "visible" : "hidden" }
      );
    }
  };
}
function registerRequestPromptConversationNode(ctx) {
  ctx.uiConversation.events.register(systemMessageDefinition(
    (previous, event) => ctx.uiConversation.inspectSystemPrompt(previous, event)
  ));
  ctx.uiConversation.events.register(requestPromptDefinition(
    (previous, event, system) => ctx.uiConversation.inspectRequestPrompt(previous, event, system)
  ));
}

// packages/client/ui-chat/src/client/conversation-nodes/retry.ts
function scheduledNode(match) {
  if (match.event.type !== "llm/retry") return void 0;
  return {
    kind: "model-retry",
    seq: match.event.seq,
    time: match.event.time,
    retryState: "scheduled",
    ...match.event.data
  };
}
function isClosed(location) {
  return location.kind === "step" && location.step.status === "closed" || (location.kind === "step" || location.kind === "turn") && location.turn.status === "closed";
}
var retryDefinition = {
  kind: "model-retry",
  target: "chat",
  match: (event) => {
    if (event.type === "llm/retry") {
      const retryId = event.data.retryId;
      if (typeof retryId !== "string" || retryId === "") return null;
      return { id: retryId, role: event.data.retry === 1 ? "start" : "update" };
    }
    if (event.type === "llm/retry-started") {
      const retryId = event.data.retryId;
      return typeof retryId === "string" && retryId !== "" ? { id: retryId, role: "update" } : null;
    }
    return null;
  },
  start: (_context, match) => {
    const node = scheduledNode(match);
    if (node === void 0) throw new Error("model-retry start requires a valid llm/retry event");
    return { turn: node.turn, step: node.step, attempts: [node] };
  },
  update: (context, match) => {
    if (match.event.type === "llm/retry") {
      const node = scheduledNode(match);
      return node === void 0 ? context.state : { ...context.state, attempts: [...context.state.attempts, node] };
    }
    if (match.event.type !== "llm/retry-started") return context.state;
    const retry = match.event.data.retry;
    return {
      ...context.state,
      attempts: context.state.attempts.map((attempt) => attempt.retry === retry ? { ...attempt, retryState: "started" } : attempt)
    };
  },
  buildViewNode: (context) => {
    if (context.state === void 0 || context.state.attempts.length === 0) return null;
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: "unresolved" };
    const stateAttempts = context.state.attempts;
    const attempts = stateAttempts.map((attempt, index) => index === stateAttempts.length - 1 && attempt.retryState === "scheduled" && isClosed(location) ? { ...attempt, retryState: "cancelled" } : attempt);
    const current = attempts.at(-1);
    if (current === void 0) return null;
    const data = { attempts, current };
    return chatNode(context, "model-retry", attempts[0]?.seq ?? current.seq, data, { groupTree: "process" });
  }
};
function registerRetryConversationNode(ctx) {
  ctx.uiConversation.events.register(retryDefinition);
}

// packages/client/ui-chat/src/client/conversation-nodes/tool.ts
var MAX_DEPTH = 256;
var projectedBlocks = /* @__PURE__ */ new WeakMap();
function jsonArguments(value) {
  return JSON.stringify(value);
}
function rootCall(match, previous) {
  if (match.event.type !== "tool/call") throw new Error("tool-call start requires tool/call");
  return {
    phase: "start",
    callId: String(match.event.data.callId),
    name: match.event.data.name,
    argsRaw: match.event.data.arguments,
    args: previous === void 0 ? PartialArguments.fromText(match.event.data.arguments) : previous.args.settle(match.event.data.arguments),
    turn: match.event.data.turn,
    step: match.event.data.step,
    time: match.event.time,
    subCalls: []
  };
}
function applyDelta(state, match) {
  const event = match.event;
  if (event.type !== "assistant/live-chunk") return state;
  const chunk = event.data.chunk;
  const root = state.root;
  if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
    if (root === void 0 || "kind" in root || root.phase !== "preparing") return state;
    return { ...state, root: { ...root, name: chunk.block.name, args: root.args.settle(chunk.block.arguments) } };
  }
  if (chunk.type !== "tool-call-delta") return state;
  if (root === void 0) {
    if (!chunk.name) return state;
    const args = new PartialArguments();
    args.append(chunk.argumentsDelta);
    return {
      ...state,
      root: {
        phase: "preparing",
        callId: String(chunk.id),
        name: chunk.name,
        turn: event.data.turn,
        step: event.data.step,
        time: event.time,
        subCalls: [],
        args
      }
    };
  }
  if ("kind" in root || root.phase !== "preparing" || root.args.isSealed) return state;
  root.args.append(chunk.argumentsDelta);
  return state;
}
function preparingBlock(root, current) {
  const changed = root.args.refresh();
  if (!changed && current !== void 0 && !("kind" in current) && current.phase === "preparing" && current.name === root.name && current.args === root.args) return current;
  return changed ? { ...root } : root;
}
function rootResult(match, previous) {
  if (match.event.type !== "tool/result") return void 0;
  const message = match.event.data.message;
  return {
    kind: "tool-result",
    seq: match.event.seq,
    time: match.event.time,
    callId: String(message.source.callId),
    name: previous?.name ?? "",
    args: previous?.args ?? PartialArguments.EMPTY,
    call: previous === void 0 ? null : { name: previous.name, argsRaw: previous.argsRaw },
    callTime: previous?.time ?? null,
    content: message.content,
    isError: message.isError === true,
    ...match.event.data.error === void 0 ? {} : { error: match.event.data.error },
    meta: match.event.data.meta,
    subCalls: []
  };
}
function childCall(match, data) {
  return {
    phase: "start",
    callId: data.subCallId,
    parentCallId: data.parentCallId,
    name: data.name,
    argsRaw: jsonArguments(data.arguments),
    args: PartialArguments.fromObject(data.arguments),
    turn: locationTurn(match),
    step: locationStep(match),
    time: match.event.time,
    subCalls: []
  };
}
function childResult(match, data, previous) {
  return {
    kind: "tool-result",
    seq: match.event.seq,
    time: match.event.time,
    callId: data.subCallId,
    parentCallId: data.parentCallId,
    name: data.name,
    args: previous !== void 0 && !("kind" in previous) ? previous.args : PartialArguments.fromObject(data.arguments),
    call: { name: data.name, argsRaw: jsonArguments(data.arguments) },
    callTime: previous?.time ?? null,
    content: data.content ?? [],
    meta: data.meta,
    isError: data.isError === true,
    ...data.error === void 0 ? {} : { error: data.error },
    subCalls: []
  };
}
function locationTurn(match) {
  return match.location.kind === "step" || match.location.kind === "turn" ? match.location.turn.turn : 0;
}
function locationStep(match) {
  return match.location.kind === "step" ? match.location.step.step : 0;
}
function acceptsEdge(state, parent, child) {
  if (parent === child || state.parents.has(child)) return false;
  let cursor = parent;
  let parentDepth = 0;
  const ancestors = /* @__PURE__ */ new Set();
  while (cursor !== void 0) {
    if (cursor === child || ancestors.has(cursor)) return false;
    ancestors.add(cursor);
    parentDepth++;
    cursor = state.parents.get(cursor);
  }
  const pending = [{ callId: child, depth: 1 }];
  const descendants = /* @__PURE__ */ new Set();
  let subtreeDepth = 0;
  for (const candidate of pending) {
    if (descendants.has(candidate.callId)) return false;
    descendants.add(candidate.callId);
    subtreeDepth = Math.max(subtreeDepth, candidate.depth);
    for (const nested of state.children.get(candidate.callId) ?? []) {
      pending.push({ callId: nested.callId, depth: candidate.depth + 1 });
    }
  }
  return parentDepth + subtreeDepth <= MAX_DEPTH;
}
function updateDispatch(state, match) {
  const event = match.event;
  if (event.type !== "tool/ptc-dispatch-start" && event.type !== "tool/ptc-dispatch") return state;
  const data = event.data;
  const parentCallId = String(data.parentCallId);
  const subCallId = String(data.subCallId);
  const siblings = state.children.get(parentCallId) ?? [];
  const index = siblings.findIndex((candidate) => candidate.callId === subCallId);
  if (event.type === "tool/ptc-dispatch-start") {
    if (index >= 0 || !acceptsEdge(state, parentCallId, subCallId)) return state;
    const children2 = new Map(state.children);
    children2.set(parentCallId, [...siblings, childCall(match, data)]);
    const parents2 = new Map(state.parents);
    parents2.set(subCallId, parentCallId);
    return { ...state, children: children2, parents: parents2 };
  }
  if (index < 0 && !acceptsEdge(state, parentCallId, subCallId)) return state;
  const previous = index < 0 ? void 0 : siblings[index];
  const settled = childResult(match, data, previous);
  const children = new Map(state.children);
  children.set(parentCallId, index < 0 ? [...siblings, settled] : siblings.map((child, at) => at === index ? settled : child));
  const parents = new Map(state.parents);
  if (index < 0) parents.set(subCallId, parentCallId);
  return { ...state, children, parents };
}
function projectBlock(block, state, interruptedAt, visited = /* @__PURE__ */ new Set(), depth = 1) {
  if (!("kind" in block) && block.phase === "preparing") return block;
  if (visited.has(block.callId) || depth > MAX_DEPTH) return { ...block, subCalls: [] };
  const nextVisited = new Set(visited);
  nextVisited.add(block.callId);
  const children = (state.children.get(block.callId) ?? block.subCalls).map((child) => projectBlock(child, state, interruptedAt, nextVisited, depth + 1));
  const interruptionSeq = "kind" in block ? void 0 : interruptedAt?.seq;
  const interruptionTime = "kind" in block ? void 0 : interruptedAt?.time;
  const cached = projectedBlocks.get(block);
  if (cached !== void 0 && cached.interruptionSeq === interruptionSeq && cached.interruptionTime === interruptionTime && sameReferences2(cached.children, children)) {
    return cached.value;
  }
  const projected = "kind" in block || interruptedAt === void 0 ? sameReferences2(block.subCalls, children) ? block : { ...block, subCalls: children } : {
    kind: "tool-result",
    seq: interruptedAt.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.interruptedFollowup,
    time: interruptedAt.time,
    callId: block.callId,
    ...block.parentCallId === void 0 ? {} : { parentCallId: block.parentCallId },
    name: block.name,
    args: block.args,
    call: { name: block.name, argsRaw: block.argsRaw },
    callTime: block.time,
    content: [],
    isError: true,
    error: { name: "Interrupted", code: "interrupted" },
    subCalls: children
  };
  projectedBlocks.set(block, { children, interruptionSeq, interruptionTime, value: projected });
  return projected;
}
function sameReferences2(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function interruption(context) {
  const location = context.start?.location;
  if (location?.kind === "step" && location.step.status === "closed") return location.step.end;
  if ((location?.kind === "step" || location?.kind === "turn") && location.turn.status === "closed") {
    return location.turn.end;
  }
  return void 0;
}
function fallbackState4(context) {
  const match = context.matches.find((candidate) => candidate.event.type === "tool/result");
  const root = match === void 0 ? void 0 : rootResult(match);
  if (root === void 0) return void 0;
  let state = { root, children: /* @__PURE__ */ new Map(), parents: /* @__PURE__ */ new Map() };
  for (const candidate of context.matches) state = updateDispatch(state, candidate);
  return state;
}
var toolDefinition = {
  kind: "tool-call",
  target: "chat",
  match: (event) => {
    if (event.type === "assistant/live-chunk") {
      const chunk = event.data.chunk;
      if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
        return { id: String(chunk.block.id), role: "start" };
      }
      return chunk.type === "tool-call-delta" ? { id: String(chunk.id), role: "start" } : null;
    }
    if (event.type === "tool/call") return { id: String(event.data.callId), role: "start" };
    if (event.type === "tool/result" && isAppendSurfaceEvent(event)) {
      return { id: String(event.data.message.source.callId), role: "update" };
    }
    if (event.type === "tool/ptc-dispatch-start" || event.type === "tool/ptc-dispatch") {
      const rootCallId = event.data.rootCallId;
      return typeof rootCallId === "string" && rootCallId !== "" ? { id: rootCallId, role: "update" } : null;
    }
    return null;
  },
  start: (_context, match) => {
    const state = { root: void 0, children: /* @__PURE__ */ new Map(), parents: /* @__PURE__ */ new Map() };
    return match.event.type === "tool/call" ? { ...state, root: rootCall(match) } : applyDelta(state, match);
  },
  update: (context, match) => {
    if (match.event.type === "assistant/live-chunk") return applyDelta(context.state, match);
    if (match.event.type === "tool/call") return { ...context.state, root: rootCall(match, context.state.root) };
    if (match.event.type === "tool/result") {
      const root = context.state.root;
      const running = root !== void 0 && !("kind" in root) && root.phase === "start" ? root : void 0;
      const result = rootResult(match, running);
      return result === void 0 ? context.state : { ...context.state, root: result };
    }
    return updateDispatch(context.state, match);
  },
  publication: (match) => match.event.type === "assistant/live-chunk" ? "animation-frame" : "immediate",
  buildViewNode: (context) => {
    const current = context.current.get("chat");
    const state = context.state ?? fallbackState4(context);
    if (state?.root === void 0) {
      return current == null ? null : current.visibility === "hidden" ? current : { ...current, visibility: "hidden" };
    }
    const interruptedAt = interruption(context);
    const root = !("kind" in state.root) && state.root.phase === "preparing" ? preparingBlock(state.root, current?.data.root) : state.root;
    const projected = projectBlock(root, state, interruptedAt);
    const anchor = context.start?.event.seq ?? ("kind" in state.root ? state.root.seq : context.matches[0]?.event.seq ?? 0);
    const preparing = !("kind" in projected) && projected.phase === "preparing";
    const visibility = preparing && interruptedAt !== void 0 ? "hidden" : "visible";
    const location = contextLocation(context);
    const data = current?.data.root === projected ? current.data : { root: projected };
    if (current?.data === data && current.anchorSeq === anchor && current.visibility === visibility && current.location === location) return current;
    return chatNode(context, "tool-call", anchor, data, { visibility, location });
  }
};
function registerToolConversationNode(ctx) {
  const match = toolDefinition.match.bind(toolDefinition);
  ctx.uiConversation.events.register({
    ...toolDefinition,
    match: {
      "assistant/live-chunk": match,
      "tool/call": match,
      "tool/result": match,
      "tool/ptc-dispatch-start": match,
      "tool/ptc-dispatch": match
    }
  });
}

// packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts
function lastStep(context) {
  const location = context.start?.location ?? context.matches[0]?.location;
  if (location?.kind !== "turn" && location?.kind !== "step") return 0;
  return location.turn.steps.at(-1)?.step ?? 0;
}
function endFailure(reason) {
  switch (reason.kind) {
    case "error":
      return reason.error;
    case "aborted":
      return reason.reason.kind === "hook" && reason.reason.reason === "deepseek-account/signed-out" ? { message: "Stopped because you signed out of DeepSeek.", code: "ACCOUNT_SIGNED_OUT" } : void 0;
    case "interrupted":
      return { message: "The DSH process exited before this turn finished.", code: "INTERRUPTED" };
    default:
      return void 0;
  }
}
function failureFrom(match) {
  if (match.event.type !== "turn/end") return void 0;
  const failure = endFailure(match.event.data.reason);
  if (failure === void 0) return void 0;
  const display = displayFailure(failure);
  return {
    seq: match.event.seq,
    time: match.event.time,
    message: display.message,
    ...display.code === void 0 ? {} : { code: display.code }
  };
}
function fallbackState5(context) {
  const end = context.matches.find((match) => failureFrom(match) !== void 0);
  if (end?.event.type !== "turn/end") return void 0;
  const failure = failureFrom(end);
  if (failure === void 0) return void 0;
  return { turn: end.event.data.turn, failure };
}
var turnErrorDefinition = {
  kind: "turn-error",
  target: "chat",
  match: (event) => {
    if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
    if (event.type === "turn/end" && endFailure(event.data.reason) !== void 0) {
      return { id: String(event.data.turn), role: "update" };
    }
    return null;
  },
  start: (_context, match) => {
    if (match.event.type !== "turn/start") throw new Error("turn-error start requires turn/start");
    return { turn: match.event.data.turn };
  },
  update: (context, match) => {
    const failure = failureFrom(match);
    return failure === void 0 ? context.state : { ...context.state, failure };
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState5(context);
    if (state?.failure === void 0) return null;
    const failure = state.failure;
    const node = {
      kind: "turn-error",
      seq: failure.seq,
      time: failure.time,
      turn: state.turn,
      step: lastStep(context),
      message: failure.message,
      ...failure.code === void 0 ? {} : { code: failure.code }
    };
    return chatNode(context, "turn-error", node.seq, node, { groupTree: "turn" });
  }
};
function registerTurnErrorConversationNode(ctx) {
  ctx.uiConversation.events.register(turnErrorDefinition);
}

// packages/client/ui-chat/src/client/conversation-nodes/turn-max-tokens.ts
function lastStep2(context) {
  const location = context.start?.location ?? context.matches[0]?.location;
  if (location?.kind !== "turn" && location?.kind !== "step") return 0;
  return location.turn.steps.at(-1)?.step ?? 0;
}
function noticeAnchor(context, seq) {
  const location = context.start?.location ?? context.matches[0]?.location;
  if (location?.kind !== "turn" && location?.kind !== "step") return seq;
  const closing = location.turn.data.get("turn-tail")?.closing;
  return closing === null || closing === void 0 ? seq : closing.finalNode.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.maxTokensNotice;
}
function stateFrom(match) {
  if (match.event.type !== "turn/end" || match.event.data.reason.kind !== "max-tokens") return void 0;
  return { turn: match.event.data.turn, seq: match.event.seq, time: match.event.time };
}
var turnMaxTokensDefinition = {
  kind: "turn-max-tokens",
  target: "chat",
  match: (event) => {
    if (event.type === "turn/end" && event.data.reason.kind === "max-tokens") {
      return { id: String(event.data.turn), role: "start" };
    }
    return null;
  },
  start: (_context, match) => {
    const state = stateFrom(match);
    if (state === void 0) throw new Error("turn-max-tokens start requires a max-tokens turn/end");
    return state;
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    const state = context.state;
    if (state === void 0) return null;
    const node = {
      kind: "turn-max-tokens",
      seq: state.seq,
      time: state.time,
      turn: state.turn,
      step: lastStep2(context)
    };
    return chatNode(context, "turn-max-tokens", noticeAnchor(context, state.seq), node, { groupTree: "turn" });
  }
};
function registerTurnMaxTokensConversationNode(ctx) {
  ctx.uiConversation.events.register(turnMaxTokensDefinition);
}

// packages/client/ui-chat/src/client/contract/assistant-content.ts
function hasAssistantReplyContent(blocks) {
  return blocks.some((block) => {
    if (block.kind === "reasoning" || block.kind === "tool-call") return false;
    if (block.kind === "text") return block.text.trim() !== "";
    return true;
  });
}

// packages/client/ui-chat/src/client/contract/turn-process.ts
function sameTurnProcessSpec(left, right) {
  return left.turn === right.turn && left.controlAnchorSeq === right.controlAnchorSeq && left.processStartSeq === right.processStartSeq && left.answerAnchorSeq === right.answerAnchorSeq && left.answerStep === right.answerStep && left.inlineReasoning === right.inlineReasoning && left.messageCount === right.messageCount && left.toolCallCount === right.toolCallCount && left.subagentCount === right.subagentCount;
}
function isSubagentDelegationTool(name) {
  return name === "subagent" || name.startsWith("subagent_");
}

// packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts
function eventTurn(event) {
  const data = event.data;
  return typeof data.turn === "number" ? data.turn : void 0;
}
function visibleChunk(chunk) {
  if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") return chunk.text.trim() !== "";
  if (chunk.type === "block-start") {
    return chunk.blockType !== "text" && chunk.blockType !== "reasoning" && chunk.blockType !== "tool-call";
  }
  if (chunk.type !== "block-end") return false;
  const block = chunk.block;
  if (block.type === "tool-call") return false;
  if (block.type === "text" || block.type === "reasoning") return block.text.trim() !== "";
  return true;
}
function visibleAssistantEvent(event) {
  if (event.type === "assistant/live-chunk") return visibleChunk(event.data.chunk);
  if (event.type === "assistant/attempt") return false;
  return event.type === "assistant/message" && event.surfaceOp === "append" && toAssistantBlocks(event.data.message.content).some((block) => {
    if (block.kind === "tool-call") return false;
    if (block.kind === "text" || block.kind === "reasoning") return block.text.trim() !== "";
    return true;
  });
}
function processEvidence(event) {
  if (visibleAssistantEvent(event)) {
    if (event.type !== "assistant/live-chunk" && event.type !== "assistant/message" && event.type !== "assistant/attempt") return void 0;
    return { kind: "assistant", seq: event.seq, step: event.data.step };
  }
  if (event.type === "tool/call" || event.type === "tool/result" && event.surfaceOp === "append" || event.type === "llm/retry") return { kind: "other", seq: event.seq };
  return void 0;
}
function durableEvidenceStep(event) {
  if (processEvidence(event) === void 0) return void 0;
  switch (event.type) {
    case "assistant/message":
    case "tool/call":
    case "tool/result":
    case "llm/retry":
      return { turn: event.data.turn, step: event.data.step };
    default:
      return void 0;
  }
}
var processEvidenceDefinition = {
  kind: "process-evidence",
  match: (event) => {
    const coordinates = durableEvidenceStep(event);
    return coordinates === void 0 ? null : { id: `${coordinates.turn}:${coordinates.step}`, role: "start" };
  },
  start: (_context, match) => {
    const coordinates = durableEvidenceStep(match.event);
    if (coordinates === void 0) throw new Error("process-evidence start requires durable process evidence");
    return { turn: coordinates.turn };
  },
  update: (context) => context.state,
  publication: () => "none"
};
function turnLocation(context) {
  const location = context.start?.location ?? context.matches.at(-1)?.location;
  return location?.kind === "turn" || location?.kind === "step" ? location.turn : void 0;
}
function fallbackState6(context) {
  const turn = context.matches.map((match) => eventTurn(match.event)).find((candidate) => candidate !== void 0);
  if (turn === void 0) return void 0;
  let state = {
    turn,
    assistantStartByStep: /* @__PURE__ */ new Map(),
    messageCountByStep: /* @__PURE__ */ new Map(),
    messageCount: 0,
    toolCallCount: 0,
    subagentCount: 0
  };
  for (const match of context.matches) state = updateProcessState(state, match.event);
  return state;
}
function isFinalAssistant(data) {
  return data?.finalNode !== void 0;
}
function latestAnswer(turn) {
  const latestStep = turn.steps.at(-1);
  const data = latestStep?.data.get("assistant-step");
  if (!isFinalAssistant(data) || !hasAssistantReplyContent(data.blocks)) return null;
  return data.blocks.some((block) => block.kind === "tool-call") ? null : data;
}
function processSpec(state, turn) {
  const controlAnchorSeq = state.controlAnchorSeq ?? turn.start?.seq;
  if (controlAnchorSeq === void 0) return null;
  const answer = latestAnswer(turn);
  const counts = {
    messageCount: answer === null ? state.messageCount : [...state.messageCountByStep].filter(([step]) => step < answer.step).reduce((total, [, count]) => total + count, 0),
    toolCallCount: state.toolCallCount,
    subagentCount: state.subagentCount
  };
  if (answer === null) {
    return {
      turn: turn.turn,
      controlAnchorSeq,
      processStartSeq: controlAnchorSeq,
      answerAnchorSeq: null,
      answerStep: null,
      inlineReasoning: false,
      ...counts
    };
  }
  const inlineReasoning = answer.blocks.some((block) => block.kind === "reasoning" && block.text.trim() !== "");
  const earlierAssistantSeq = Math.min(
    ...[...state.assistantStartByStep].filter(([step]) => step < answer.step).map(([, seq]) => seq)
  );
  const externalProcessSeq = Math.min(
    state.otherStartSeq ?? Number.POSITIVE_INFINITY,
    earlierAssistantSeq
  );
  return {
    turn: turn.turn,
    controlAnchorSeq,
    processStartSeq: turn.start?.seq ?? (Number.isFinite(externalProcessSeq) ? externalProcessSeq : answer.finalNode.seq),
    answerAnchorSeq: answer.finalNode.seq,
    answerStep: answer.step,
    inlineReasoning,
    ...counts
  };
}
function updateProcessState(state, event) {
  let current = state;
  if (event.type === "assistant/message" && event.surfaceOp === "append" && hasAssistantReplyContent(toAssistantBlocks(event.data.message.content))) {
    const messageCountByStep = new Map(current.messageCountByStep);
    messageCountByStep.set(event.data.step, (messageCountByStep.get(event.data.step) ?? 0) + 1);
    current = { ...current, messageCountByStep, messageCount: current.messageCount + 1 };
  }
  if (event.type === "tool/call") {
    const subagent = isSubagentDelegationTool(event.data.name);
    current = {
      ...current,
      toolCallCount: current.toolCallCount + (subagent ? 0 : 1),
      subagentCount: current.subagentCount + (subagent ? 1 : 0)
    };
  }
  const evidence = processEvidence(event);
  if (evidence === void 0) return current;
  if (evidence.kind === "other") {
    return current.otherStartSeq === void 0 ? {
      ...current,
      otherStartSeq: evidence.seq,
      controlAnchorSeq: Math.min(current.controlAnchorSeq ?? Number.POSITIVE_INFINITY, evidence.seq)
    } : current;
  }
  if (current.assistantStartByStep.has(evidence.step)) return current;
  const assistantStartByStep = new Map(current.assistantStartByStep);
  assistantStartByStep.set(evidence.step, evidence.seq);
  return {
    ...current,
    assistantStartByStep,
    controlAnchorSeq: Math.min(current.controlAnchorSeq ?? Number.POSITIVE_INFINITY, evidence.seq)
  };
}
var turnProcessDefinition = {
  kind: "turn-process",
  target: "chat",
  match: (event) => {
    if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
    const turn = eventTurn(event);
    if (turn === void 0) return null;
    if (event.type === "assistant/live-chunk" || event.type === "assistant/message" || event.type === "tool/call" || event.type === "tool/result" || event.type === "llm/retry" || event.type === "step/start" || event.type === "step/end" || event.type === "turn/end") {
      return { id: String(turn), role: "update" };
    }
    return null;
  },
  start: (_context, match) => {
    if (match.event.type !== "turn/start") throw new Error("turn-process start requires turn/start");
    return {
      turn: match.event.data.turn,
      assistantStartByStep: /* @__PURE__ */ new Map(),
      messageCountByStep: /* @__PURE__ */ new Map(),
      messageCount: 0,
      toolCallCount: 0,
      subagentCount: 0
    };
  },
  update: (context, match) => updateProcessState(context.state, match.event),
  publication: (match) => {
    if (match.event.type === "assistant/live-chunk") {
      const type = match.event.data.chunk.type;
      return type === "usage" || type === "finish" ? "none" : "animation-frame";
    }
    return "immediate";
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== "turn") return null;
    const state = context.state ?? fallbackState6(context);
    if (state === void 0) return null;
    const turn = turnLocation(context);
    if (turn === void 0) return null;
    const current = context.current.get("chat");
    const latestStep = turn.steps.at(-1);
    if (previous?.kind === "turn" && previous.key === "turn-process" && current?.kind === "turn-process" && current.data.answerAnchorSeq === null && current.data.controlAnchorSeq === state.controlAnchorSeq && current.data.messageCount === state.messageCount && current.data.toolCallCount === state.toolCallCount && current.data.subagentCount === state.subagentCount && turn.status !== "closed" && latestStep?.status !== "closed") return previous;
    const spec = processSpec(state, turn);
    if (spec === null) return null;
    if (previous?.kind === "turn" && previous.turn === spec.turn && previous.key === "turn-process" && sameTurnProcessSpec(previous.value, spec)) return previous;
    return {
      kind: "turn",
      turn: turn.turn,
      key: "turn-process",
      value: spec
    };
  },
  buildViewNode: (context) => {
    const turn = turnLocation(context);
    const data = turn?.data.get("turn-process");
    if (turn === void 0 || data === void 0) return null;
    const current = context.current.get("chat");
    const state = context.state;
    if (current?.kind === "turn-process" && state !== void 0 && current.data.answerAnchorSeq === null && current.data.controlAnchorSeq === state.controlAnchorSeq && current.data.messageCount === state.messageCount && current.data.toolCallCount === state.toolCallCount && current.data.subagentCount === state.subagentCount && turn.status !== "closed" && turn.steps.at(-1)?.status !== "closed" && current.location === (context.start?.location ?? context.matches[0]?.location)) return current;
    return chatNode(
      context,
      "turn-process",
      data.controlAnchorSeq + CHAT_SYNTHETIC_SEQ_OFFSETS.processControl,
      data,
      { groupTree: "turn" }
    );
  }
};
function registerTurnProcess(ctx) {
  const match = turnProcessDefinition.match.bind(turnProcessDefinition);
  ctx.uiConversation.events.register({
    ...turnProcessDefinition,
    match: {
      "turn/start": match,
      "assistant/live-chunk": match,
      "assistant/message": match,
      "tool/call": match,
      "tool/result": match,
      "llm/retry": match,
      "step/start": match,
      "step/end": match,
      "turn/end": match
    }
  });
  const evidence = processEvidenceDefinition.match.bind(processEvidenceDefinition);
  ctx.uiConversation.events.register({
    ...processEvidenceDefinition,
    match: {
      "assistant/message": evidence,
      "tool/call": evidence,
      "tool/result": evidence,
      "llm/retry": evidence
    }
  });
}

// packages/util/values/src/partial-json.ts
var SIMPLE_ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "	"
};
var CONTENT_ESCAPE = /[\\\u0000-\u001f]/u;
function isWhitespace(c) {
  return c === " " || c === "\n" || c === "\r" || c === "	";
}
function isHex(c) {
  return c >= "0" && c <= "9" || c >= "a" && c <= "f" || c >= "A" && c <= "F";
}
var PartialArguments2 = class _PartialArguments {
  /** The view of a call with no arguments available. */
  static EMPTY = _PartialArguments.fromObject({});
  /**
   * View finished argument text without scanning it until a reader asks.
   * @param text - the complete argument JSON text.
   * @returns a sealed view.
   */
  static fromText(text) {
    const view = new _PartialArguments();
    view.append(text);
    view.sealed = true;
    return view;
  }
  /**
   * View an already parsed argument payload, such as a PTC dispatch object.
   * @param value - the parsed argument value.
   * @returns a sealed view; a non-object payload has no fields.
   */
  static fromObject(value) {
    const view = new _PartialArguments();
    view.object = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
    view.sealed = true;
    return view;
  }
  /**
   * The source: text so far or a parsed object, plus whether it can still grow.
   * These are the only enumerable fields, so two views over the same source
   * compare equal structurally however far each has been read.
   */
  chunks = [];
  object;
  sealed = false;
  // Scan progress, located fields, and remembered reads are caches over the source.
  #ends = [];
  #size = 0;
  #consumed = 0;
  #mode = "root";
  #escape = false;
  #keyStart = 0;
  #keyEscaped = false;
  #key = "";
  #current = null;
  #nestedEnds = [];
  #nestedInString = false;
  #invalidAt;
  #invalidValue = false;
  #entries = /* @__PURE__ */ new Map();
  #order = [];
  #reads = /* @__PURE__ */ new Map();
  /** Whether this view rejects further appends; does not scan text or register reads. */
  get isSealed() {
    return this.sealed;
  }
  /** Whether indexing or a content read found invalid JSON; unread value contents are not validated. */
  get invalid() {
    this.scan();
    return this.#mode === "invalid" || this.#invalidValue;
  }
  /**
   * Retain streamed argument text without scanning or comparing observed answers.
   * @param fragment - the text following every fragment appended before.
   */
  append(fragment) {
    if (this.sealed) throw new Error("PartialArguments: cannot append to a sealed view");
    if (fragment.length === 0) return;
    this.chunks.push(fragment);
    this.#size += fragment.length;
    this.#ends.push(this.#size);
  }
  /**
   * Reconcile a streamed prefix with authoritative complete text without joining the fragments.
   * @param text - the final argument text, which replaces missing or conflicting deltas.
   * @returns this view sealed with its caches retained when every character matches; otherwise a new sealed view.
   */
  settle(text) {
    if (this.object !== void 0 || text.length !== this.#size) return _PartialArguments.fromText(text);
    let offset = 0;
    for (const chunk of this.chunks) {
      if (!text.startsWith(chunk, offset)) return _PartialArguments.fromText(text);
      offset += chunk.length;
    }
    this.chunks = text.length === 0 ? [] : [text];
    this.#ends = text.length === 0 ? [] : [text.length];
    this.sealed = true;
    return this;
  }
  /**
   * Compare observed answers and advance their publication baseline. Unread views remain unscanned.
   * @returns whether any observed answer changed since its first read or the preceding refresh.
   */
  refresh() {
    if (this.#reads.size === 0) return false;
    this.scan();
    let changed = false;
    let completions = false;
    for (const read of this.#reads.values()) {
      if (read.completion) {
        completions = true;
        continue;
      }
      changed = this.refreshRead(read) || changed;
    }
    if (completions) {
      for (const read of this.#reads.values()) if (read.completion) changed = this.refreshRead(read) || changed;
    }
    if (this.sealed) this.#reads.clear();
    return changed;
  }
  refreshRead(read) {
    const now = read.answer();
    if (Object.is(now, read.last)) return false;
    read.last = now;
    return true;
  }
  /**
   * Check whether no further fields can arrive.
   * @returns whether the outer object closed, indexing failed, or the view is sealed; unread values are not validated.
   */
  closed() {
    return this.remember("closed", "", () => this.closedNow());
  }
  /**
   * List discovered fields in first-appearance order.
   * @returns top-level keys seen so far, in first-appearance order.
   */
  keys() {
    return this.remember("keys", "", () => this.keysNow(), (keys) => keys.length);
  }
  /**
   * Check whether a top-level field has appeared.
   * @param key - argument name.
   * @returns whether the field has appeared (a string opened or another value began).
   */
  has(key) {
    return this.remember("has", key, () => this.hasNow(key));
  }
  /**
   * Check whether a field's closing delimiter has arrived, without validating its contents.
   * @param key - argument name.
   * @returns whether its delimiter arrived and no content reader has reported an error for this value.
   */
  complete(key) {
    return this.remember("complete", key, () => this.completeNow(key));
  }
  /**
   * Read string length without materializing its text.
   * @param key - argument name.
   * @param options - change granularity for a streaming string.
   * @returns decoded UTF-16 length of the string field so far; undefined when absent or not a string.
   */
  stringLength(key, options) {
    const step = Math.max(1, Math.floor(options?.step ?? 1));
    const offset = options?.offset ?? 0;
    return this.remember(
      `length:${step}:${offset}`,
      key,
      () => this.lengthNow(key),
      (length) => length === void 0 ? void 0 : Math.ceil((length + offset) / step)
    );
  }
  /**
   * Check a string against a decoded UTF-16 length limit without materializing it.
   * @param key - argument name.
   * @param maxLength - decoded UTF-16 limit, floored to at least zero.
   * @returns whether the string is longer than the limit; false when absent or not a string.
   */
  stringExceeds(key, maxLength) {
    const limit = Math.max(0, Math.floor(maxLength));
    return this.remember(
      `exceeds:${limit}`,
      key,
      () => (this.lengthNow(key, limit + 1) ?? 0) > limit
    );
  }
  /**
   * Read a decoded string, including a streaming prefix.
   * @param key - argument name.
   * @returns the string field's decoded text so far; undefined when absent or not a string.
   */
  text(key) {
    return this.remember("text", key, () => this.textNow(key));
  }
  /**
   * Read at most the first decoded UTF-16 units of a string.
   * @param key - argument name.
   * @param maxLength - maximum decoded UTF-16 length, floored to at least one.
   * @returns the bounded string prefix; undefined when absent or not a string.
   */
  textPrefix(key, maxLength) {
    const limit = Math.max(1, Math.floor(maxLength));
    return this.remember(
      `prefix:${limit}`,
      key,
      () => this.textPrefixNow(key, limit)
    );
  }
  /**
   * Read a completed non-string argument.
   * @param key - argument name.
   * @returns the parsed non-string value once it closed; undefined while open, absent, or a string.
   */
  value(key) {
    return this.remember("value", key, () => this.valueNow(key));
  }
  /** Answer a question and, on a streaming view, remember it for change detection. */
  remember(kind, key, read, comparison) {
    this.scan();
    const result = read();
    if (!this.sealed) {
      const id = `${kind}/${key}`;
      if (!this.#reads.has(id)) {
        this.#reads.set(id, {
          completion: kind === "complete",
          answer: comparison === void 0 ? read : () => comparison(read()),
          last: comparison === void 0 ? result : comparison(result)
        });
      }
    }
    return result;
  }
  closedNow() {
    return this.sealed || this.#mode === "closed" || this.#mode === "invalid";
  }
  keysNow() {
    return this.object === void 0 ? this.#order : Object.keys(this.object);
  }
  hasNow(key) {
    return this.object === void 0 ? this.#entries.has(key) : Object.hasOwn(this.object, key);
  }
  completeNow(key) {
    if (this.object !== void 0) return Object.hasOwn(this.object, key);
    const entry = this.#entries.get(key);
    return entry !== void 0 && entry.end >= 0 && (entry.kind === "string" ? entry.invalidAt === void 0 : !entry.invalid);
  }
  lengthNow(key, limit = Number.POSITIVE_INFINITY) {
    if (this.object !== void 0) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
      return typeof field === "string" ? field.length : void 0;
    }
    const entry = this.#entries.get(key);
    if (entry?.kind !== "string") return void 0;
    if (entry.text !== void 0 && entry.text.at === entry.end) return entry.text.length;
    const read = entry.length ??= { at: entry.start, length: 0, text: "" };
    this.readString(entry, read, limit, false);
    return read.length;
  }
  textNow(key) {
    if (this.object !== void 0) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
      return typeof field === "string" ? field : void 0;
    }
    const entry = this.#entries.get(key);
    if (entry?.kind !== "string") return void 0;
    if (entry.text === void 0 && entry.end >= 0 && entry.needsDecoding && entry.invalidAt === void 0) {
      let text;
      try {
        text = JSON.parse(`"${this.slice(entry.start, entry.end)}"`);
      } catch (_error) {
      }
      if (text !== void 0) entry.text = { at: entry.end, length: text.length, text };
    }
    const read = entry.text ??= { at: entry.start, length: 0, text: "" };
    this.readString(entry, read, Number.POSITIVE_INFINITY, true);
    return read.text;
  }
  textPrefixNow(key, maxLength) {
    if (this.object !== void 0) {
      const field = Object.hasOwn(this.object, key) ? this.object[key] : void 0;
      return typeof field === "string" ? field.slice(0, maxLength) : void 0;
    }
    const entry = this.#entries.get(key);
    if (entry?.kind !== "string") return void 0;
    const prefixes = entry.prefixes ??= /* @__PURE__ */ new Map();
    let read = prefixes.get(maxLength);
    if (read === void 0) {
      read = { at: entry.start, length: 0, text: "" };
      prefixes.set(maxLength, read);
    }
    this.readString(entry, read, maxLength, true);
    return read.text;
  }
  valueNow(key) {
    if (this.object !== void 0) {
      if (!Object.hasOwn(this.object, key)) return void 0;
      const field = this.object[key];
      return typeof field === "string" ? void 0 : field;
    }
    const entry = this.#entries.get(key);
    if (entry?.kind !== "value" || entry.end < 0 || entry.invalid) return void 0;
    if (entry.parsed === void 0) {
      try {
        entry.parsed = JSON.parse(this.slice(entry.start, entry.end));
      } catch (_error) {
        entry.invalid = true;
        this.#invalidValue = true;
      }
    }
    return entry.parsed;
  }
  chunkAt(at) {
    let low = 0;
    let high = this.#ends.length;
    while (low < high) {
      const mid = low + high >>> 1;
      if (this.#ends[mid] <= at) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  /** Materialize only a requested range, never the cumulative source. */
  slice(start, end) {
    if (start >= end) return "";
    const first = this.chunkAt(start);
    const last = this.chunkAt(end - 1);
    const base = first === 0 ? 0 : this.#ends[first - 1];
    if (first === last) return this.chunks[first].slice(start - base, end - base);
    const parts = [this.chunks[first].slice(start - base)];
    for (let i = first + 1; i < last; i++) parts.push(this.chunks[i]);
    parts.push(this.chunks[last].slice(0, end - this.#ends[last - 1]));
    return parts.join("");
  }
  readString(entry, read, limit, materialize) {
    const end = Math.min(
      entry.end < 0 ? this.#consumed : entry.end,
      entry.invalidAt ?? Number.POSITIVE_INFINITY,
      this.#invalidAt ?? Number.POSITIVE_INFINITY
    );
    if (!entry.needsDecoding) {
      const length = Math.min(end - read.at, limit - read.length);
      if (length <= 0) return;
      if (materialize) read.text += this.slice(read.at, read.at + length);
      read.at += length;
      read.length += length;
      return;
    }
    let chunkIndex = this.chunkAt(read.at);
    while (read.at < end && read.length < limit) {
      const base = chunkIndex === 0 ? 0 : this.#ends[chunkIndex - 1];
      const chunk = this.chunks[chunkIndex];
      const remaining = chunk.slice(read.at - base, Math.min(chunk.length, end - base));
      const boundary = remaining.search(CONTENT_ESCAPE);
      const length = Math.min(boundary < 0 ? remaining.length : boundary, limit - read.length);
      if (length > 0) {
        if (materialize) read.text += remaining.slice(0, length);
        read.at += length;
        read.length += length;
        if (read.at === base + chunk.length) chunkIndex++;
        continue;
      }
      const type = remaining.length > 1 ? remaining[1] : read.at + 1 < end ? this.chunks[chunkIndex + 1][0] : void 0;
      let decoded;
      let width = 2;
      if (remaining[0] === "\\" && type === void 0 && entry.end < 0) return;
      if (remaining[0] === "\\" && type === "u") {
        const hex = this.slice(read.at + 2, Math.min(end, read.at + 6));
        let valid = true;
        for (let i = 0; i < hex.length; i++) if (!isHex(hex[i])) valid = false;
        if (valid) {
          if (hex.length < 4 && entry.end < 0) return;
          if (hex.length === 4) decoded = String.fromCharCode(Number.parseInt(hex, 16));
        }
        width = 6;
      } else if (remaining[0] === "\\" && type !== void 0) {
        decoded = SIMPLE_ESCAPES[type];
      }
      if (decoded === void 0) {
        entry.invalidAt = read.at;
        this.#invalidValue = true;
        return;
      }
      if (materialize) read.text += decoded;
      read.length++;
      read.at += width;
      while (chunkIndex < this.chunks.length && read.at >= this.#ends[chunkIndex]) chunkIndex++;
    }
  }
  /** Locate new field ranges without decoding or parsing their contents. */
  scan() {
    if (this.object !== void 0 || this.#consumed === this.#size) return;
    for (let i = this.chunkAt(this.#consumed); i < this.chunks.length && this.#invalidAt === void 0; i++) {
      const pending = this.chunks[i];
      const base = i === 0 ? 0 : this.#ends[i - 1];
      for (let index = this.#consumed - base; index < pending.length && this.#mode !== "invalid"; index++) {
        if (this.#mode === "string" || this.#mode === "nested" && this.#nestedInString) {
          const end = this.stringBoundary(pending, index);
          this.#consumed += end - index;
          index = end;
          if (index === pending.length) break;
        }
        this.step(pending[index], this.#consumed);
        this.#consumed++;
      }
    }
  }
  /** Only raw quotes and their preceding backslash runs can terminate a string. */
  stringBoundary(fragment, start) {
    let at = start;
    while (true) {
      const quote = fragment.indexOf('"', at);
      const end = quote < 0 ? fragment.length : quote;
      if (this.#mode === "string") {
        const entry = this.#current;
        if (!entry.needsDecoding && CONTENT_ESCAPE.test(fragment.slice(at, end))) entry.needsDecoding = true;
      }
      let slashStart = end;
      while (slashStart > at && fragment[slashStart - 1] === "\\") slashStart--;
      const escaped = (end - slashStart) % 2 === 1 !== (slashStart === at && this.#escape);
      this.#escape = quote < 0 && escaped;
      if (quote < 0 || !escaped) return end;
      at = quote + 1;
    }
  }
  step(c, at) {
    switch (this.#mode) {
      case "root":
        if (isWhitespace(c)) return;
        if (c === "{") {
          this.#mode = "key-or-end";
          return;
        }
        this.fail();
        return;
      case "key-or-end":
        if (isWhitespace(c)) return;
        if (c === "}") {
          this.#mode = "closed";
          return;
        }
        if (c === '"') {
          this.beginKey(at);
          return;
        }
        this.fail();
        return;
      case "key-only":
        if (isWhitespace(c)) return;
        if (c === '"') {
          this.beginKey(at);
          return;
        }
        this.fail();
        return;
      case "key":
        this.stepKey(c, at);
        return;
      case "colon":
        if (isWhitespace(c)) return;
        if (c === ":") {
          this.#mode = "value";
          return;
        }
        this.fail();
        return;
      case "value":
        this.beginValue(c, at);
        return;
      case "string": {
        const entry = this.#current;
        entry.end = at;
        this.#current = null;
        this.#mode = "comma-or-end";
        return;
      }
      case "scalar":
        this.stepScalar(c, at);
        return;
      case "nested":
        this.stepNested(c, at);
        return;
      case "comma-or-end":
        if (isWhitespace(c)) return;
        if (c === ",") {
          this.#mode = "key-only";
          return;
        }
        if (c === "}") {
          this.#mode = "closed";
          return;
        }
        this.fail();
        return;
      case "closed":
        if (isWhitespace(c)) return;
        this.fail();
        return;
      /* v8 ignore next 2 -- scan() stops stepping once the view is invalid. */
      case "invalid":
        return;
      /* v8 ignore next 2 -- Every scanner mode has a handler above. */
      default:
        assertNever(this.#mode);
    }
  }
  fail() {
    this.#invalidAt = this.#consumed;
    this.#mode = "invalid";
    this.#current = null;
  }
  beginKey(at) {
    this.#mode = "key";
    this.#keyStart = at + 1;
    this.#keyEscaped = false;
    this.#escape = false;
  }
  stepKey(c, at) {
    if (c < " ") {
      this.fail();
      return;
    }
    if (this.#escape) {
      this.#escape = false;
      return;
    }
    if (c === "\\") {
      this.#escape = true;
      this.#keyEscaped = true;
      return;
    }
    if (c !== '"') return;
    const raw = this.slice(this.#keyStart, at);
    if (this.#keyEscaped) {
      try {
        this.#key = JSON.parse(`"${raw}"`);
      } catch (_error) {
        this.fail();
        return;
      }
    } else {
      this.#key = raw;
    }
    this.#mode = "colon";
  }
  open(entry) {
    if (!this.#entries.has(this.#key)) this.#order.push(this.#key);
    this.#entries.set(this.#key, entry);
    this.#current = entry;
  }
  beginValue(c, at) {
    if (isWhitespace(c)) return;
    if (c === '"') {
      this.open({
        kind: "string",
        start: at + 1,
        end: -1,
        needsDecoding: false,
        invalidAt: void 0,
        length: void 0,
        text: void 0,
        prefixes: void 0
      });
      this.#escape = false;
      this.#mode = "string";
      return;
    }
    if (c === "}" || c === "," || c === ":" || c === "]") {
      this.fail();
      return;
    }
    this.open({ kind: "value", start: at, end: -1, parsed: void 0, invalid: false });
    if (c === "{" || c === "[") {
      this.#mode = "nested";
      this.#nestedEnds = [c === "{" ? "}" : "]"];
      this.#nestedInString = false;
      this.#escape = false;
      return;
    }
    this.#mode = "scalar";
  }
  stepScalar(c, at) {
    if (c !== "," && c !== "}" && !isWhitespace(c)) return;
    this.closeValue(at);
    this.#mode = c === "," ? "key-only" : c === "}" ? "closed" : "comma-or-end";
  }
  stepNested(c, at) {
    if (this.#nestedInString) {
      this.#nestedInString = false;
      return;
    }
    if (c === '"') {
      this.#nestedInString = true;
      return;
    }
    if (c === "{" || c === "[") {
      this.#nestedEnds.push(c === "{" ? "}" : "]");
      return;
    }
    if (c === "}" || c === "]") {
      if (this.#nestedEnds.pop() !== c) {
        this.fail();
        return;
      }
      if (this.#nestedEnds.length === 0) {
        this.closeValue(at + 1);
        this.#mode = "comma-or-end";
      }
    }
  }
  closeValue(end) {
    const entry = this.#current;
    entry.end = end;
    this.#current = null;
  }
};

// packages/util/values/src/index.ts
function assertNever(value, context) {
  const rendered = JSON.stringify(value) ?? String(value);
  throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}

// packages/llm/llm/src/assistant-stream.ts
function lastAssistantStreamChunk(stream, type) {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record.type === "chunk" && record.chunk.type === type) return record.chunk;
  }
  return void 0;
}

// packages/llm/token-meter/lib/types/turn-usage.js
function isCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeSum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total))
      return void 0;
  }
  return total;
}
function messageRoute(message) {
  const { provider, model } = message.source;
  return provider.length > 0 && model.length > 0 ? { provider, model } : void 0;
}
function streamUsage(stream) {
  return lastAssistantStreamChunk(stream, "usage")?.usage;
}
function normalizeUsage(usage, route) {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage;
  if (!isCount(inputTokens) || !isCount(outputTokens))
    return void 0;
  if (cacheReadTokens !== void 0 && !isCount(cacheReadTokens))
    return void 0;
  if (cacheWriteTokens !== void 0 && !isCount(cacheWriteTokens))
    return void 0;
  if (reasoningTokens !== void 0 && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) {
    return void 0;
  }
  const knownPrompt = safeSum([
    inputTokens,
    ...cacheReadTokens === void 0 ? [] : [cacheReadTokens],
    ...cacheWriteTokens === void 0 ? [] : [cacheWriteTokens]
  ]);
  if (knownPrompt === void 0)
    return void 0;
  let exactTotal;
  if (totalTokens !== void 0) {
    if (!isCount(totalTokens))
      return void 0;
    const exactPrompt = totalTokens - outputTokens;
    if (!isCount(exactPrompt) || exactPrompt < knownPrompt)
      return void 0;
    if (cacheReadTokens !== void 0 && cacheWriteTokens !== void 0 && exactPrompt !== knownPrompt) {
      return void 0;
    }
    exactTotal = totalTokens;
  } else {
    if (cacheReadTokens === void 0 || cacheWriteTokens === void 0)
      return void 0;
    const derivedTotal = safeSum([knownPrompt, outputTokens]);
    if (derivedTotal === void 0)
      return void 0;
    exactTotal = derivedTotal;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: exactTotal,
    ...cacheReadTokens === void 0 ? {} : { cacheReadTokens },
    ...cacheWriteTokens === void 0 ? {} : { cacheWriteTokens },
    ...reasoningTokens === void 0 ? {} : { reasoningTokens },
    ...route === void 0 ? {} : { route }
  };
}
function aggregateAttempts(attempts) {
  if (attempts.length === 0)
    return void 0;
  const inputTokens = safeSum(attempts.map((attempt) => attempt.inputTokens));
  const outputTokens = safeSum(attempts.map((attempt) => attempt.outputTokens));
  const totalTokens = safeSum(attempts.map((attempt) => attempt.totalTokens));
  if (inputTokens === void 0 || outputTokens === void 0 || totalTokens === void 0)
    return void 0;
  const cacheRead = attempts.map((attempt) => attempt.cacheReadTokens);
  const cacheWrite = attempts.map((attempt) => attempt.cacheWriteTokens);
  const reasoning2 = attempts.map((attempt) => attempt.reasoningTokens);
  const cacheReadTokens = cacheRead.every(isCount) ? safeSum(cacheRead) : void 0;
  const cacheWriteTokens = cacheWrite.every(isCount) ? safeSum(cacheWrite) : void 0;
  const reasoningTokens = reasoning2.every(isCount) ? safeSum(reasoning2) : void 0;
  let routes;
  const attributed = attempts.map((attempt) => attempt.route);
  if (attributed.every((route) => route !== void 0)) {
    const unique = /* @__PURE__ */ new Map();
    for (const route of attributed)
      unique.set(`${route.provider}\0${route.model}`, route);
    routes = [...unique.values()];
  }
  return {
    uncachedInputTokens: inputTokens,
    outputTokens,
    totalTokens,
    ...cacheReadTokens === void 0 ? {} : { cacheReadTokens },
    ...cacheWriteTokens === void 0 ? {} : { cacheWriteTokens },
    ...reasoningTokens === void 0 ? {} : { reasoningTokens },
    ...routes === void 0 ? {} : { routes }
  };
}
function sameAttempt(state, turn, step) {
  return state.turn === turn && state.step === step;
}
function deriveTurnTokenUsage(events) {
  let state = { kind: "idle" };
  const attempts = [];
  let turn;
  let sawEnd = false;
  let invalid = false;
  const closeOpen = (route) => {
    if (state.kind !== "open" || state.sample === void 0)
      return false;
    const normalized = normalizeUsage(state.sample, route);
    if (normalized === void 0)
      return false;
    attempts.push(normalized);
    return true;
  };
  for (const event of events) {
    if (invalid)
      break;
    if (event.type === "turn/start") {
      if (turn !== void 0 || state.kind !== "idle")
        invalid = true;
      else
        turn = event.data.turn;
      continue;
    }
    if (turn === void 0) {
      invalid = true;
      break;
    }
    if (event.type === "turn/end") {
      if (event.data.turn !== turn || state.kind !== "idle" || sawEnd)
        invalid = true;
      else
        sawEnd = true;
      continue;
    }
    if (sawEnd) {
      invalid = true;
      break;
    }
    if (event.type === "step/start") {
      if (event.data.turn !== turn || state.kind !== "idle")
        invalid = true;
      else
        state = { kind: "open", turn, step: event.data.step };
      continue;
    }
    if (event.type === "llm/retry-started") {
      if (event.data.turn !== turn || state.kind !== "settled" || state.by !== "retry" || !sameAttempt(state, event.data.turn, event.data.step))
        invalid = true;
      else
        state = { kind: "open", turn, step: event.data.step };
      continue;
    }
    if (event.type === "assistant/attempt") {
      if (event.data.turn !== turn || state.kind !== "open" || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true;
        continue;
      }
      const sample = streamUsage(event.data.stream) ?? state.sample;
      state = { kind: "open", turn, step: event.data.step, ...sample === void 0 ? {} : { sample } };
      if (!closeOpen())
        invalid = true;
      else
        state = { kind: "finishClosed", turn, step: event.data.step };
      continue;
    }
    if (event.type === "assistant/message") {
      if (event.data.turn !== turn || state.kind !== "open" || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true;
        continue;
      }
      const sample = event.data.usage ?? streamUsage(event.data.stream);
      if (sample !== void 0)
        state = { ...state, sample };
      if (!closeOpen(messageRoute(event.data.message)))
        invalid = true;
      else
        state = { kind: "settled", turn, step: event.data.step, by: "message" };
      continue;
    }
    if (event.type === "llm/retry") {
      if (event.data.turn !== turn || state.kind === "idle" || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true;
        continue;
      }
      if (state.kind === "settled" || state.kind === "open" && !closeOpen())
        invalid = true;
      if (!invalid)
        state = { kind: "settled", turn, step: event.data.step, by: "retry" };
      continue;
    }
    if (event.type === "step/end") {
      if (event.data.turn !== turn || state.kind === "idle" || !sameAttempt(state, event.data.turn, event.data.step)) {
        invalid = true;
        continue;
      }
      if (state.kind === "open" && !closeOpen())
        invalid = true;
      if (!invalid)
        state = { kind: "idle" };
    }
  }
  return invalid || !sawEnd || state.kind !== "idle" ? void 0 : aggregateAttempts(attempts);
}

// packages/client/ui-chat/src/client/conversation-nodes/turn-tail.ts
function isSessionEvent(event) {
  return event.type !== "assistant/live-chunk";
}
function turnCoordinates(event) {
  if (event.type === "assistant/message" || event.type === "assistant/attempt" || event.type === "assistant/live-chunk" || event.type === "step/start" || event.type === "step/end") {
    return { turn: event.data.turn, step: event.data.step };
  }
  if (event.type === "llm/retry" || event.type === "llm/retry-started") {
    return { turn: event.data.turn, step: event.data.step };
  }
  return void 0;
}
function turnLocation2(context) {
  const location = context.start?.location ?? context.matches[0]?.location;
  return location?.kind === "turn" || location?.kind === "step" ? location.turn : void 0;
}
function hasText(data) {
  return data.finalNode !== void 0 && data.blocks.some((block) => block.kind === "text" && block.text.trim() !== "");
}
function tailData(context) {
  const end = context.state === void 0 ? context.matches.find((match) => match.event.type === "turn/end") : context.state.end;
  if (end?.event.type !== "turn/end") return null;
  const turn = turnLocation2(context);
  if (turn === void 0) return null;
  const assistants = turn.steps.map((step) => step.data.get("assistant-step")).filter((candidate) => candidate !== void 0);
  const finalized = assistants.filter((candidate) => candidate.finalNode !== void 0).sort((left, right) => left.finalNode.seq - right.finalNode.seq);
  const closing = finalized.findLast(hasText) ?? null;
  let latestTranscriptSeq = finalized.at(-1)?.finalNode.seq;
  for (const match of context.matches) {
    const event = match.event;
    const candidate = event.type === "tool/call" || event.type === "tool/result" && event.surfaceOp === "append" || event.type === "turn/end" && event.data.reason.kind === "error" || event.type === "llm/retry" ? event.seq : void 0;
    if (candidate !== void 0 && (latestTranscriptSeq === void 0 || candidate > latestTranscriptSeq)) {
      latestTranscriptSeq = candidate;
    }
  }
  const tokenUsage = context.start?.event.type === "turn/start" ? deriveTurnTokenUsage(context.matches.map((match) => match.event).filter(isSessionEvent)) : void 0;
  return {
    turn: end.event.data.turn,
    seq: end.event.seq,
    time: end.event.time,
    closing,
    branchUnavailable: closing === null || latestTranscriptSeq !== closing.finalNode.seq,
    ...tokenUsage === void 0 ? {} : { tokenUsage }
  };
}
var turnTailDefinition = {
  kind: "turn-tail",
  target: "chat",
  match: (event) => {
    if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
    if (event.type === "turn/end") return { id: String(event.data.turn), role: "update" };
    if (event.type === "tool/call" || event.type === "tool/result") {
      return { id: String(event.data.turn), role: "update" };
    }
    const coordinates = turnCoordinates(event);
    if (coordinates !== void 0) return { id: String(coordinates.turn), role: "update" };
    return null;
  },
  start: (_context, match) => {
    if (match.event.type !== "turn/start") throw new Error("turn-tail start requires turn/start");
    return { turn: match.event.data.turn };
  },
  update: (context, match) => match.event.type === "turn/end" ? { ...context.state, end: match } : context.state,
  publication: (match) => match.event.type === "turn/end" ? "immediate" : "none",
  buildLocationData: (context, scope) => {
    if (scope !== "turn") return null;
    const value = tailData(context);
    return value === null ? null : {
      kind: "turn",
      turn: value.turn,
      key: "turn-tail",
      value
    };
  },
  buildViewNode: (context) => {
    const turn = turnLocation2(context);
    const data = turn?.data.get("turn-tail");
    return data === void 0 ? null : chatNode(context, "turn-tail", data.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup, data, { groupTree: "turn" });
  }
};
function registerTurnTailConversationNode(ctx) {
  const match = turnTailDefinition.match.bind(turnTailDefinition);
  ctx.uiConversation.events.register({
    ...turnTailDefinition,
    match: {
      "turn/start": match,
      "turn/end": match,
      "tool/call": match,
      "tool/result": match,
      "assistant/message": match,
      "assistant/attempt": match,
      "assistant/live-chunk": match,
      "step/start": match,
      "step/end": match,
      "llm/retry": match,
      "llm/retry-started": match
    }
  });
}

// packages/util/brand/lib/index.js
function brandString2(value) {
  return value;
}

// packages/client/ui-chat/src/client/reasoning-text.ts
function reasoningText(text) {
  if (text[0] !== "<") return text;
  const opening = "<signature>";
  if (opening.startsWith(text)) return "";
  if (!text.startsWith(opening)) return text;
  const closing = "</signature>";
  const end = text.indexOf(closing, opening.length);
  if (end === -1) return "";
  let start = end + closing.length;
  while (start < text.length) {
    if (text[start] === "\n") start++;
    else if (text[start] === "\r" && text[start + 1] === "\n") start += 2;
    else break;
  }
  return text.slice(start);
}

// packages/client/ui-chat/src/client/conversation-nodes/process-activity.ts
function activity(name) {
  if (name === "read") return "read";
  if (name === "read_image") return "readImage";
  if (name === "grep" || name === "glob" || name.endsWith("_inspect")) return "search";
  if (name === "write") return "write";
  if (name === "edit" || name === "apply_patch") return "edit";
  if (["bash", "pwsh", "exec_command", "write_stdin"].includes(name) || name.startsWith("terminal_")) return "commands";
  if (name === "run_code") return "code";
  if (name === "web_search") return "webSearch";
  if (name === "web_fetch") return "webFetch";
  if (name === "subagent" || name.startsWith("subagent_")) return "subagents";
  if (["todo_write", "create_goal", "update_goal", "get_goal"].includes(name)) return "plan";
  if (name === "ask_user_question" || name === "request_user_input") return "questions";
  return "tools";
}
var LIVE_TOOL_DETAIL_MAX_CHARS = 160;
var LIVE_TOOL_DETAIL_PREFIX_CHARS = 512;
var LIVE_TOOL_DETAIL_SEGMENTER = new Intl.Segmenter(void 0, { granularity: "grapheme" });
var LIVE_TOOL_DETAIL_KEYS = [
  "title",
  "description",
  "objective",
  "task",
  "task_name",
  "name",
  "question",
  "questions",
  "prompt",
  "message",
  "command",
  "cmd",
  "queries",
  "query",
  "pattern",
  "url",
  "uri",
  "file_path",
  "path",
  "target",
  "action",
  "status"
];
function normalizeLiveToolText(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= LIVE_TOOL_DETAIL_MAX_CHARS) return { text: normalized, truncated: false };
  const chars = [];
  for (const { segment } of LIVE_TOOL_DETAIL_SEGMENTER.segment(normalized)) {
    if (chars.length === LIVE_TOOL_DETAIL_MAX_CHARS) {
      return {
        text: `${chars.slice(0, LIVE_TOOL_DETAIL_MAX_CHARS - 1).join("").trimEnd()}\u2026`,
        truncated: true
      };
    }
    chars.push(segment);
  }
  return { text: normalized, truncated: false };
}
function normalizeLiveToolDetail(value) {
  const text = typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join(", ") : "";
  return normalizeLiveToolText(text).text;
}
function argumentTextDetail(args, key) {
  let limit = LIVE_TOOL_DETAIL_PREFIX_CHARS;
  while (true) {
    let prefix = args.textPrefix(key, limit);
    if (prefix === void 0) return void 0;
    const last = prefix.charCodeAt(prefix.length - 1);
    if (last >= 55296 && last <= 56319) {
      const extended = args.textPrefix(key, limit + 1);
      const next = extended.charCodeAt(prefix.length);
      if (next >= 56320 && next <= 57343) {
        prefix = extended;
        limit++;
      } else if (extended.length === prefix.length && !args.isSealed && !args.complete(key)) {
        prefix = prefix.slice(0, -1);
      }
    }
    const detail = normalizeLiveToolText(prefix);
    if (detail.truncated || !args.stringExceeds(key, limit)) return detail.text;
    limit *= 2;
  }
}
function questionDetail(value) {
  if (!Array.isArray(value)) return "";
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const detail = normalizeLiveToolDetail(Reflect.get(item, "question"));
    if (detail !== "") return detail;
  }
  return "";
}
function liveReasoningDetail(nodes) {
  for (let nodeIndex = nodes.length - 1; nodeIndex >= 0; nodeIndex--) {
    const node = nodes[nodeIndex];
    if (node?.kind !== "assistant-step" || node.data.status !== "running") continue;
    for (let blockIndex = node.data.blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = node.data.blocks[blockIndex];
      if (block?.kind !== "reasoning") continue;
      const paragraphs = reasoningText(block.text).split(/\r?\n[\t ]*\r?\n/);
      for (let paragraphIndex = paragraphs.length - 1; paragraphIndex >= 0; paragraphIndex--) {
        const detail = normalizeLiveToolDetail(paragraphs[paragraphIndex]?.replaceAll("**", ""));
        if (detail !== "") return detail;
      }
    }
  }
  return "";
}
function liveToolDetail(name, args) {
  for (const key of LIVE_TOOL_DETAIL_KEYS) {
    if (!args.has(key)) continue;
    const detail = key === "questions" ? questionDetail(args.value(key)) : argumentTextDetail(args, key) ?? normalizeLiveToolDetail(args.value(key));
    if (detail !== "") return detail;
  }
  return args.closed() ? normalizeLiveToolDetail(name) : "";
}
function processActivity(nodes) {
  const counts = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  let running;
  let runningDetail = "";
  let runningTime = -Infinity;
  let preparing;
  const visit = (tool) => {
    if (seen.has(tool.callId)) return;
    seen.add(tool.callId);
    const call = isRunningTool(tool) ? tool : tool.call;
    if (call !== null) {
      const kind = activity(call.name);
      if (isRunningTool(tool) && tool.time >= runningTime) {
        running = kind;
        preparing = tool.phase === "preparing";
        runningDetail = liveToolDetail(tool.name, tool.args);
        runningTime = tool.time;
      }
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const child of tool.subCalls) visit(child);
  };
  for (const node of nodes) {
    if (node.kind === "tool-call") visit(node.data.root);
  }
  if (running === void 0) runningDetail = liveReasoningDetail(nodes);
  if (nodes.length > 0 && nodes.every((node) => node.kind === "context")) counts.set("context", nodes.length);
  return {
    counts: [...counts].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    running,
    runningDetail,
    ...preparing ? { preparing: true } : {}
  };
}

// packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts
function turnOf(node) {
  const location = node.location;
  return location.kind === "turn" || location.kind === "step" ? location.turn.turn : void 0;
}
function reasoning(node) {
  return node.kind === "assistant-step" && node.data.blocks.some((block) => block.kind === "reasoning" && block.text.trim() !== "");
}
function reply(node) {
  return node.kind === "assistant-step" && hasAssistantReplyContent(node.data.blocks);
}
function sameSummary(left, right) {
  return left.running === right.running && left.runningDetail === right.runningDetail && left.preparing === right.preparing && left.counts.length === right.counts.length && left.counts.every((value, index) => value.kind === right.counts[index]?.kind && value.count === right.counts[index].count);
}
function sameMembers(left, right) {
  return left.length === right.length && left.every((value, index) => value.key === right[index]?.key && value.groupPart === right[index].groupPart);
}
function structureChanged(previous, current) {
  if (!isVisibleChatNode(current) && (previous === void 0 || !isVisibleChatNode(previous))) return false;
  return previous === void 0 || previous.kind !== current.kind || turnOf(previous) !== turnOf(current) || isVisibleChatNode(previous) !== isVisibleChatNode(current) || previous.groupTree !== current.groupTree || reasoning(previous) !== reasoning(current) || reply(previous) !== reply(current);
}
function readNode(input, key) {
  const node = input.readNode(key);
  if (node === void 0) throw new Error(`Chat grouping input is missing Node ${key}`);
  return node;
}
var ProcessGroup = class {
  constructor(key, turn, members) {
    this.key = key;
    this.turn = turn;
    this.members = members;
    this.snapshot = { key, members, data: { turn, closed: false, summary: { counts: [], running: void 0, runningDetail: "" } } };
  }
  key;
  turn;
  members;
  nodes = [];
  snapshot;
  refresh(input, closed) {
    const nodes = this.members.map((member) => readNode(input, member.key));
    const unchanged = nodes.length === this.nodes.length && nodes.every((node, index) => node === this.nodes[index]);
    const previous = this.snapshot.data;
    const activity2 = unchanged && previous.closed === closed ? previous.summary : processActivity(nodes);
    const summary = closed ? { counts: activity2.counts, running: void 0, runningDetail: "" } : activity2;
    this.nodes = nodes;
    if (previous.closed !== closed || !sameSummary(previous.summary, summary)) {
      this.snapshot = {
        key: this.key,
        members: this.members,
        data: { turn: this.turn, closed, summary }
      };
    }
  }
};
var TurnGroups = class {
  constructor(turn) {
    this.turn = turn;
  }
  turn;
  groups = /* @__PURE__ */ new Map();
  membership = /* @__PURE__ */ new Map();
  roots = /* @__PURE__ */ new Map();
  references(key) {
    return this.roots.get(key) ?? [];
  }
  snapshots() {
    return [...this.groups.values()].map((group) => group.snapshot);
  }
  refresh(input, changed) {
    const dirty = /* @__PURE__ */ new Set();
    for (const node of changed) {
      const group = this.membership.get(node);
      if (group !== void 0) dirty.add(group);
    }
    const ended = input.timeline.turns.get(this.turn)?.status === "closed";
    if (ended) {
      for (const group of this.groups.values()) {
        if (!group.snapshot.data.closed) dirty.add(group.key);
      }
    }
    const upserts = [];
    for (const key of dirty) {
      const group = this.groups.get(key);
      const previous = group.snapshot;
      group.refresh(input, previous.data.closed || ended);
      if (group.snapshot !== previous) upserts.push(group.snapshot);
    }
    return upserts;
  }
  rebuild(input, added) {
    const roots = /* @__PURE__ */ new Map();
    const groups = /* @__PURE__ */ new Map();
    const membership = /* @__PURE__ */ new Map();
    let pending = [];
    const upserts = [];
    const emit = (key, entry) => {
      roots.set(key, [...roots.get(key) ?? [], entry]);
    };
    const flush = (closed) => {
      const first = pending[0];
      if (first === void 0) return;
      const retained = this.extendedGroup(pending, added);
      const key = retained?.key ?? brandString2(JSON.stringify(["process", first.key, first.groupPart ?? null]));
      const previous2 = this.groups.get(key);
      const before = previous2?.snapshot;
      const group = previous2 !== void 0 && sameMembers(previous2.members, pending) ? previous2 : new ProcessGroup(key, this.turn, pending);
      group.refresh(input, closed || input.timeline.turns.get(this.turn)?.status === "closed");
      groups.set(group.key, group);
      emit(first.key, { kind: "group", key: group.key });
      for (const member of pending) membership.set(member.key, group.key);
      if (group.snapshot !== before) upserts.push(group.snapshot);
      pending = [];
    };
    let previous;
    let followed = false;
    for (const key of input.readTurn(this.turn)) {
      const position = readPosition(input, key);
      if (previous !== void 0 && position.previous !== previous) flush(true);
      previous = key;
      followed = position.next !== void 0;
      const node = readNode(input, key);
      if (isAtOrOutside(node, "process")) {
        flush(true);
        emit(key, { kind: "node", key });
      } else if (node.kind === "assistant-step") {
        if (reasoning(node)) pending.push({ kind: "node", key, groupPart: "reasoning" });
        if (reply(node)) {
          flush(true);
          emit(key, { kind: "node", key, groupPart: "response" });
        }
      } else pending.push({ kind: "node", key });
    }
    flush(followed);
    const removes = [...this.groups.keys()].filter((key) => !groups.has(key));
    this.groups = groups;
    this.membership = membership;
    this.roots = roots;
    return { upserts, removes };
  }
  extendedGroup(members, added) {
    const offset = members.findIndex((member) => !added.has(member.key));
    const first = members[offset];
    if (first === void 0) return void 0;
    const key = this.membership.get(first.key);
    const previous = key === void 0 ? void 0 : this.groups.get(key);
    if (previous === void 0 || offset + previous.members.length > members.length) return void 0;
    for (let index = 0; index < previous.members.length; index++) {
      const before = previous.members[index];
      const after = members[offset + index];
      if (before.key !== after.key || before.groupPart !== after.groupPart) return void 0;
    }
    for (let index = offset + previous.members.length; index < members.length; index++) {
      if (!added.has(members[index].key)) return void 0;
    }
    return previous;
  }
};
function readPosition(input, key) {
  const position = input.readPosition(key);
  if (position === void 0) throw new Error(`Chat grouping order is missing position for Node ${key}`);
  return position;
}
var ProcessState = class {
  turns = /* @__PURE__ */ new Map();
  order = [];
  pending = null;
  /**
   * Consume one synchronous Builder input without retaining its readers.
   * @param input - projected Node changes, indexed positions, and Turn lifecycle.
   */
  accept(input) {
    if (input.kind === "replace") {
      const previousKeys = new Set(this.order);
      const added2 = new Set(input.order.filter((key) => !previousKeys.has(key)));
      const turns = /* @__PURE__ */ new Map();
      for (const key of input.order) {
        const turn = readPosition(input, key).turn;
        if (turn === void 0 || turns.has(turn)) continue;
        const groups = this.turns.get(turn) ?? new TurnGroups(turn);
        groups.rebuild(input, added2);
        turns.set(turn, groups);
      }
      this.turns = turns;
      this.order = input.order;
      this.pending = {
        entries: this.rootEntries(input),
        groups: { kind: "replace", snapshots: [...turns.values()].flatMap((turn) => turn.snapshots()) }
      };
      return;
    }
    const regroup = new Set(input.changedTurnOrders);
    const added = /* @__PURE__ */ new Set();
    const changed = /* @__PURE__ */ new Map();
    const touch = (turn) => {
      let keys = changed.get(turn);
      if (keys === void 0) {
        keys = /* @__PURE__ */ new Set();
        changed.set(turn, keys);
      }
      return keys;
    };
    for (const change of input.changes) {
      const before = change.previous;
      const after = change.current;
      const turn = turnOf(after);
      if (before === void 0 || !isVisibleChatNode(before)) added.add(after.key);
      if (structureChanged(before, after)) {
        const previousTurn = before === void 0 ? void 0 : turnOf(before);
        if (previousTurn !== void 0) regroup.add(previousTurn);
        if (turn !== void 0) regroup.add(turn);
      }
      if (turn !== void 0) touch(turn).add(after.key);
    }
    for (const turn of input.changedTurns) touch(turn);
    const upserts = [];
    const removes = [];
    for (const turn of regroup) {
      const groups = this.turns.get(turn) ?? new TurnGroups(turn);
      const update = groups.rebuild(input, added);
      upserts.push(...update.upserts);
      removes.push(...update.removes);
      if (input.readTurn(turn).length === 0) this.turns.delete(turn);
      else this.turns.set(turn, groups);
    }
    for (const [turn, keys] of changed) {
      if (!regroup.has(turn)) upserts.push(...this.turns.get(turn)?.refresh(input, keys) ?? []);
    }
    const reordered = input.order !== this.order || regroup.size > 0;
    this.order = input.order;
    const installed = new Set(upserts.map((group) => group.key));
    this.pending = reordered || upserts.length > 0 || removes.length > 0 ? {
      ...reordered ? { entries: this.rootEntries(input) } : {},
      groups: { kind: "apply", upserts, removes: removes.filter((key) => !installed.has(key)) }
    } : null;
  }
  rootEntries(input) {
    return input.order.flatMap((key) => {
      const turn = readPosition(input, key).turn;
      if (turn === void 0) return [{ kind: "node", key }];
      const groups = this.turns.get(turn);
      if (groups === void 0) throw new Error(`Chat grouping order is missing Turn ${turn}`);
      return groups.references(key);
    });
  }
  /**
   * Read pending output without advancing State.
   * @returns the repeatable update for the last input batch.
   */
  output() {
    return this.pending;
  }
};
var processGroupDefinition = {
  kind: "process-groups",
  target: "chat",
  create: () => new ProcessState(),
  update: (context, input) => {
    context.state.accept(input);
    return context.state;
  },
  buildGroups: (context) => context.state.output()
};

// packages/client/ui-chat/src/client/conversation-nodes/register.ts
function registerConversationNodes(ctx) {
  registerInboxConversationNodes(ctx);
  registerMessageConversationNode(ctx);
  registerRequestPromptConversationNode(ctx);
  registerAssistantConversationNode(ctx);
  registerTurnProcess(ctx);
  registerToolConversationNode(ctx);
  registerCommandConversationNode(ctx);
  registerCompactionConversationNode(ctx);
  registerRetryConversationNode(ctx);
  registerTurnErrorConversationNode(ctx);
  registerTurnMaxTokensConversationNode(ctx);
  registerTurnTailConversationNode(ctx);
  registerUnknownConversationFallback(ctx);
  registerChatConversationView(ctx);
  ctx.uiConversation.groups.register(processGroupDefinition);
}
export {
  registerConversationNodes
};
