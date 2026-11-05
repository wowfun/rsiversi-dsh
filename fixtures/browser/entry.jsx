import React, { useState } from 'react';
import * as jsx from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ReactClient from 'react-dom/client';
import * as cordis from '@deepseek-ai/cordis';
import * as zod from 'zod';
import * as virtual from '@tanstack/react-virtual';
import * as store from '@deepseek-ai/dsh-client-store';
import * as slots from '@deepseek-ai/dsh-client-ui-slots';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import * as dockkit from '@deepseek-ai/dsh-client-ui-dockkit';
import { PartialArguments } from '@deepseek-ai/dsh-util-values';
import { installModuleLoader } from '../../packages/rsi-dsh-cordis/src/runtime/browser.mjs';
import approved from './approved.json';
import conversation from './conversation.json';
import './shell.css';

const loader = installModuleLoader({ react: React, 'react/jsx-runtime': jsx, 'react-dom': ReactDOM,
  'react-dom/client': ReactClient, '@deepseek-ai/cordis': cordis, zod, '@tanstack/react-virtual': virtual,
  '@deepseek-ai/dsh-client-store': store, '@deepseek-ai/dsh-client-ui-slots': slots,
  '@deepseek-ai/dsh-client-ui-primitives': primitives, '@deepseek-ai/dsh-client-ui-dockkit': dockkit,
}, approved);
const ctx = new cordis.Context();
const core = new slots.SlotCore();
const children = Object.fromEntries([
  ['conversation.input.plan', 'single'], ['conversation.chat.turnTail', 'list'],
  ['conversation.plan-review.actions', 'list'], ['sidebar.right.pane.tab', 'keyed'],
  ['sidebar.right.pane.tab.title', 'keyed'], ['conversation.chat.node', 'keyed'],
].map(([key, kind]) => [key, { kind, scope: 'session' }]));
core.register({ name: 'root', children }, () => null);
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
const translate = namespace => (key, params = {}) => {
  const value = dictionaries.get(namespace)?.[key] ?? ({ copy: 'Copy', copied: 'Copied', 'codeBlock.title': 'Code', 'codeBlock.wrap': 'Wrap', 'codeBlock.unwrap': 'Unwrap', 'markdown.footnotes': 'Footnotes' })[key] ?? key;
  return value.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? name));
};
const noop = () => () => {};
ctx.provide('locale', { register(name, locales) { dictionaries.set(name, locales.en); return () => dictionaries.delete(name); }, bind: translate });
ctx.provide('remote', { $host: { platform: 'win32', home: 'C:/fixture' }, commands: {}, session: {} });
ctx.provide('remote.commands', ctx.remote.commands);
ctx.provide('remote.session', ctx.remote.session);
ctx.provide('sessions', { binding: id => id, subagentAddress: () => undefined });
ctx.provide('uiConversation', { events: { register: noop }, views: { register: noop } });
ctx.provide('resources', { register: noop });
ctx.provide('sidebarRight', {});
ctx.provide('sidebarRightTabs', { register: noop });
ctx.provide('configForms', { get: () => ({ subscribe: noop, getSnapshot: () => ({ status: 'loading' }) }) });
await ctx.plugin(await loader.load('@deepseek-ai/dsh-client-ui-theme'));
await ctx.plugin(await loader.load('@deepseek-ai/dsh-client-ui-tool'));
await ctx.plugin(await loader.load('@deepseek-ai/dsh-client-ui-plan'));
const find = (name, key) => {
  const entry = core.entriesOfSlot(name).find(item => key === undefined || item.options.key === key);
  if (!entry) throw new Error(`original component missing: ${name}/${key}`);
  return entry.component;
};
const Todo = find('tool.call.toolview', 'todo_write');
const Chip = find('conversation.input.plan');
const Preview = find('sidebar.right.pane.tab', '@deepseek-ai/dsh-client-ui-plan');
const todos = [{ content: 'Read upstream source', status: 'completed' }, { content: 'Verify original Todo and Plan UI', status: 'in_progress' }, { content: 'Verify durable receipts', status: 'pending' }];
const argsRaw = JSON.stringify({ todos });
const block = { kind: 'tool-result', seq: 10, time: 2000, callTime: 1000, callId: 'todo-1', name: 'todo_write',
  args: PartialArguments.fromText(argsRaw), call: { name: 'todo_write', argsRaw },
  content: [{ type: 'text', text: 'Updated 3 todos.' }], isError: false, subCalls: [] };
const plan = { title: 'Original DSH compatibility', callId: 'plan-1', markdown: '# Original DSH compatibility\n\nRender the unchanged **Plan preview**, including syntax highlighting.\n\n```typescript\nconst compatibility = { original: true, version: 1 };\n```\n\n- Verify Todo details\n- Leave plan mode\n- Preserve recorded history' };
function App() {
  const [active, setActive] = useState(true);
  const [expanded, setExpanded] = useState(true);
  return <main><header><p>RSI · DSH original package validation</p><h1>Todo and Plan</h1><span role="status">Original bundles loaded</span></header>
    <div className="workspace"><article><h2>Conversation</h2><Todo toolName="todo_write" block={block} t={translate('conversation')}
      useDisclosure={() => ({ expanded, toggle: () => setExpanded(value => !value) })}
      useTodoHistory={selector => selector(new Map([['todo-1', { todos: undefined }]]))}
      useSession={selector => selector({ hasMore: false })}/>
      <div className="composer"><label htmlFor="message">Message</label><textarea id="message" placeholder="Continue the conversation"/>
        <Chip locked={false} useProjection={() => ({ active, pending: false })} t={translate('plan')} exitPlanMode={async () => { setActive(false); return null; }}/>
      </div><output>{active ? 'Plan mode active' : 'Plan mode off'}</output></article>
    <aside><h2>Plan preview</h2><Preview useTabInfo={() => ({ tab: { title: plan.title, navigation: { address: 'dsh-resource://plan/session/fixture/plan-1' } } })}
      useResource={() => ({ value: plan, status: 'ready' })} t={translate('plan')}/></aside></div>
    <footer>Fixture: original browser rendering with explicit service doubles; this is not the RSI application.</footer></main>;
}
ReactClient.createRoot(document.getElementById('root')).render(<App/>);
