import { Context } from '@deepseek-ai/cordis';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { UiConversation } from '../../generated/browser/conversation.mjs';
import { registerConversationNodes } from '../../generated/browser/nodes.mjs';
import { en as common } from '../../generated/browser/common.mjs';
import { en as conversation } from '../../generated/browser/messages.mjs';
import { JournalWindow } from './journal.mjs';

export function presentationServices(ctx) {
  const core = new SlotCore();
  core.register({ name: 'root', children: Object.fromEntries([
    ['conversation.input.plan', 'single'], ['conversation.chat.turnTail', 'list'],
    ['conversation.plan-review.actions', 'list'], ['sidebar.right.pane.tab', 'keyed'],
    ['sidebar.right.pane.tab.title', 'keyed'], ['conversation.chat.node', 'keyed'],
  ].map(([key, kind]) => [key, { kind, scope: 'session' }])) }, () => null);
  ctx.provide('slots', {
    register: core.register.bind(core),
    inject(key, callback) {
      return ctx.effect(() => {
        let active, epoch;
        const reconcile = () => {
          const next = core.declarationEpoch(key);
          if (active && next === epoch) return;
          active?.(); active = undefined;
          if (core.specDynamic(key)) { active = ctx.effect(callback); epoch = next; }
        };
        const unsubscribe = core.subscribeDeclaration(key, reconcile); reconcile();
        return () => { unsubscribe(); active?.(); };
      });
    },
  });
  const dictionaries = new Map([['conversation', conversation]]);
  const translate = namespace => (key, parameters = {}) => (dictionaries.get(namespace)?.[key] ?? common[key] ?? key)
    .replace(/\{(\w+)\}/g, (_, name) => String(parameters[name] ?? name));
  ctx.provide('locale', {
    register(name, locales) { dictionaries.set(name, locales.en); return () => dictionaries.delete(name); },
    bind: translate,
  });
  return { core, translate };
}

/** One workbench occurrence, including its original upstream assembler and services. */
export class BrowserScope {
  constructor(owner) {
    this.owner = owner;
    this.ctx = new Context();
    Object.assign(this, presentationServices(this.ctx));
    this.journal = new JournalWindow(request => this.owner.action('document_resource', { request }), owner.view.session);
    this.feed = createSnapshotStore({ revision: 0, entries: [], hasMore: false, change: { kind: 'replace' } });
    this.state = createSnapshotStore({ checkpoint: undefined, failure: undefined, preview: undefined });
    const id = owner.view.session;
    const binding = { ctx: this.ctx, sessionId: id, eventSource: this.feed };
    this.ctx.provide('sessions', { binding: selected => selected === id ? binding : undefined, subagentAddress: () => undefined });
    this.assembly = new UiConversation(this.ctx, this.ctx.sessions);
    registerConversationNodes(this.ctx);
    const resources = new Map(), tabs = new Map();
    this.ctx.provide('resources', { register(provider) {
      if (resources.has(provider.protocol)) throw new Error('Duplicate resource provider');
      resources.set(provider.protocol, provider); return () => resources.delete(provider.protocol);
    } });
    this.ctx.provide('sidebarRightTabs', { register(tab) {
      tabs.set(tab.id, tab); return () => tabs.delete(tab.id);
    } });
    this.ctx.provide('sidebarRight', {
      mounted: createSnapshotStore(id),
      openResource: (address, options) => this.openResource(address, options, resources, tabs),
    });
    const remote = {
      // Only Todo and Plan seats are mounted; host-path Tool seats are not bound.
      $host: undefined,
      commands: { execute: async (session, command, images) => {
        if (session !== id || command !== '/plan off' || images.length) throw new Error('Unsupported document command');
        await this.owner.action('document_command', { name: 'plan', input: 'off' });
        return { ok: true, value: {} };
      } },
      session: {
        events: async ({ address }, signal) => {
          this.assertAddress(address);
          const head = await this.journal.head(signal);
          const page = await this.journal.page(head, Infinity, 1, signal);
          const last = head.segments.at(-1);
          const cursor = last ? last.first + last.count - 1 : -1;
          this.resourceCut = { cursor, head };
          return { ok: true, value: { records: page.entries.map(event => ({ event })), hasMore: page.hasMore, cursor } };
        },
        page: async ({ address, throughSeq, beforeSeq }, signal) => {
          this.assertAddress(address);
          if (this.resourceCut?.cursor !== throughSeq) throw new Error('Plan history cut expired; reopen the preview');
          const page = await this.journal.page(this.resourceCut.head, beforeSeq, 1, signal);
          return { ok: true, value: { records: page.entries.map(event => ({ event })), hasMore: page.hasMore } };
        },
      },
    };
    this.ctx.provide('remote', remote);
    this.ctx.provide('remote.commands', remote.commands);
    this.ctx.provide('remote.session', remote.session);
  }
  assertAddress(address) {
    if (this.closed || address.kind !== 'session' || address.sessionId !== this.owner.view.session)
      throw new Error('Plan resource does not belong to this Session occurrence');
  }
  async start(plugins) {
    for (const plugin of plugins) {
      if (this.closed) return;
      await this.ctx.plugin(plugin);
    }
    if (this.closed) return;
    this.conversation = this.assembly.binding(this.owner.view.session);
    this.conversation.activate('chat');
    this.conversation.activate('tool-todo-history');
    this.chat = this.conversation.target('chat');
    this.todos = this.conversation.target('tool-todo-history');
    this.ready = true;
  }
  entry(name, key) {
    const entry = this.core.entriesOfSlot(name).find(entry => key === undefined || entry.options.key === key);
    if (!entry) throw new Error(`Original browser seat unavailable: ${name}/${key}`);
    return entry;
  }
  update(owner) {
    this.owner = owner;
    const checkpoint = owner.view.projections?.entries.find(entry => entry.producer === 'rsi.extension.view')?.content.value;
    if (checkpoint && checkpoint !== this.state.getSnapshot().checkpoint) this.state.update(state => { state.checkpoint = checkpoint; });
    if (!checkpoint || (owner.view.creation && !owner.view.transcript.blocks.length && !owner.view.active)) return;
    this.dirty = true;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
  }
  async refresh() {
    while (this.dirty && !this.closed) {
      this.dirty = false;
      try {
        const head = await this.journal.head();
        if (this.headRevision === head.revision) continue;
        const page = await this.journal.page(head);
        if (this.closed) return;
        this.feed.set({ entries: page.entries.map(event => ({type: 'event', event})), hasMore: page.hasMore,
          revision: this.feed.getSnapshot().revision + 1, change: { kind: 'replace' } });
        this.headRevision = head.revision;
        this.state.update(state => { state.failure = undefined; });
      } catch (error) {
        if (!this.closed) this.state.update(state => { state.failure = String(error.message ?? error); });
      }
    }
  }
  openResource(address, options, resources, tabs) {
    if (this.closed) throw new Error('Session occurrence retired');
    this.previewAbort?.abort();
    const abort = this.previewAbort = new AbortController();
    const tab = [...tabs.values()].find(tab => tab.canOpen(address));
    if (!tab) throw new Error('No original plan resource tab');
    const preview = { tab: { title: tab.title(), navigation: { address, params: options?.params } }, resource: { status: 'loading' } };
    this.state.update(state => { state.preview = preview; });
    const protocol = new URL(address).hostname;
    const provider = resources.get(protocol);
    if (!provider) return; // Original temporary review previews use tab params.
    void (async () => {
      try {
        for await (const result of provider.open(address, { signal: abort.signal })) {
          if (abort.signal.aborted || this.closed) return;
          this.state.update(state => { state.preview.resource = result.ok
            ? { status: 'ready', value: result.value } : { status: 'failed', failure: result.error }; });
        }
      } catch (error) {
        if (!abort.signal.aborted && !this.closed) this.state.update(state => { state.preview.resource = { status: 'failed', failure: { message: String(error.message ?? error) } }; });
      }
    })();
  }
  closePreview() { this.previewAbort?.abort(); this.state.update(state => { state.preview = undefined; }); }
  async close() {
    this.closed = true; this.journal.close(); this.previewAbort?.abort();
    await this.ctx.fiber.dispose();
  }
}
