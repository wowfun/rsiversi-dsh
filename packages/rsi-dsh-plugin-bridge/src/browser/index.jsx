import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import * as cordis from '@deepseek-ai/cordis';
import * as zod from 'zod';
import * as virtual from '@tanstack/react-virtual';
import * as store from '@deepseek-ai/dsh-client-store';
import * as slots from '@deepseek-ai/dsh-client-ui-slots';
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives';
import * as dockkit from '@deepseek-ai/dsh-client-ui-dockkit';
import { installModuleLoader } from 'rsi-dsh-cordis/browser';
import { BrowserScope, presentationServices } from './scope.mjs';
import { ThemePresenter } from '../../generated/browser/theme.mjs';
import './workbench.css';

const Bridge = createContext(undefined);
const observe = source => useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);

/** Explicit bootstrap composition; the supplied SDK owns React and Session authority. */
export async function installWorkbenchBridge(sdk, approved) {
  const loader = installModuleLoader({ ...sdk.documentModules, '@deepseek-ai/cordis': cordis,
    zod, '@tanstack/react-virtual': virtual, '@deepseek-ai/dsh-client-store': store,
    '@deepseek-ai/dsh-client-ui-slots': slots, '@deepseek-ai/dsh-client-ui-primitives': primitives,
    '@deepseek-ai/dsh-client-ui-dockkit': dockkit }, approved);
  const theme = await loader.load('@deepseek-ai/dsh-client-ui-theme');
  const plugins = await Promise.all(['ui-tool', 'ui-plan'].map(name => loader.load(`@deepseek-ai/dsh-client-${name}`)));
  const root = new cordis.Context();
  presentationServices(root);
  root.provide('remote', {});
  // Complete ThemeSettings contract from the pinned upstream theme-settings.ts.
  const themeValue = () => ({ preference: document.documentElement.dataset.theme ?? 'system',
    fontSize: 14, codeFontSize: 11, terminalFontSize: 13,
    textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' });
  const themeForm = store.createSnapshotStore({ value: themeValue() });
  root.provide('configForms', { get: () => themeForm });
  await root.plugin(theme);
  const presenter = new ThemePresenter();
  presenter.apply(root.theme.getTheme());
  const detachTheme = root.on('theme/change', snapshot => presenter.apply(snapshot));
  const themeObserver = new MutationObserver(() => themeForm.set({ value: themeValue() }));
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  function Provider({ children }) {
    const owner = sdk.useOptionalDocumentSession();
    const [scope, setScope] = useState();
    const [failure, setFailure] = useState();
    useEffect(() => {
      setScope(undefined); setFailure(undefined);
      if (!owner) return;
      const scope = new BrowserScope(owner);
      let alive = true;
      void scope.start(plugins).then(() => { if (alive) setScope(scope); }, error => { if (alive) setFailure(String(error.message ?? error)); });
      return () => { alive = false; void scope.close().catch(error => console.error('DSH scope cleanup failed', error)); };
    }, [owner?.view.session, owner?.view.generation]);
    useEffect(() => { if (owner && scope?.owner.view.session === owner.view.session && scope.owner.view.generation === owner.view.generation) scope.update(owner); }, [scope, owner?.view]);
    return <Bridge.Provider value={owner && scope?.owner.view.session === owner.view.session && scope.owner.view.generation === owner.view.generation ? scope : undefined}>{children}{failure && <p role="alert">{failure}</p>}</Bridge.Provider>;
  }
  function Composer() {
    const scope = useContext(Bridge);
    return scope ? <PlanChip scope={scope}/> : null;
  }
  function PlanChip({ scope }) {
    const state = observe(scope.state);
    const { view } = sdk.useDocumentSession();
    const entry = scope.entry('conversation.input.plan');
    const Component = entry.component;
    const injected = entry.inject(view.session);
    return <div className="rsi-dsh-accessory"><Component {...injected}
      locked={view.protected === true} useProjection={key => state.checkpoint?.views?.values?.[key]}
      t={scope.translate('plan')}/>{state.failure && <p role="status">{state.failure}</p>}</div>;
  }
  function Transcript({ block, fallback }) {
    const scope = useContext(Bridge);
    return scope ? <Todo scope={scope} block={block} fallback={fallback}/> : fallback;
  }
  function Todo({ scope, block, fallback }) {
    const chat = observe(scope.chat);
    const baseline = observe(scope.todos);
    const feed = observe(scope.feed);
    const [expanded, setExpanded] = useState(false);
    const identity = JSON.parse(block.key);
    const turn = feed.entries.find(({event}) => event.type === 'turn/start' && event.data.rsi?.session === scope.owner.view.session && event.data.rsi?.turn === identity.turn)?.event.data.turn;
    const original = chat?.nodes.values().find(node => node.kind === 'tool-call' && node.data.root.callId === identity.identity?.call_id
      && (node.location.kind === 'step' ? node.location.turn.turn : node.location.kind === 'turn' ? node.location.turn.turn : undefined) === turn)?.data.root;
    if (!original) return fallback;
    const Component = scope.entry('tool.call.toolview', 'todo_write').component;
    return <div className="rsi-dsh-todo"><Component block={original} toolName="todo_write"
      useTodoHistory={selector => selector(baseline)} useSession={selector => selector(feed)}
      useDisclosure={() => ({ expanded, toggle: () => setExpanded(value => !value) })}
      t={scope.translate('conversation')}/></div>;
  }
  function TurnTail({ turn }) {
    const scope = useContext(Bridge);
    return scope ? <Plans scope={scope} turn={turn}/> : null;
  }
  function Plans({ scope, turn }) {
    const feed = observe(scope.feed);
    observe(scope.chat);
    const number = feed.entries.find(({event}) => event.type === 'turn/start' && event.data.rsi?.session === scope.owner.view.session && event.data.rsi?.turn === turn)?.event.data.turn;
    if (number === undefined) return null;
    return <BoundPlans scope={scope} turn={number}/>;
  }
  function BoundPlans({ scope, turn }) {
    const entry = scope.entry('conversation.chat.turnTail');
    const injected = entry.inject(scope.owner.view.session);
    const plans = observe(injected.keyedHooks.plans(String(turn)));
    const Component = entry.component;
    return <Component turn={{ turn }} usePlans={() => plans} openPlan={injected.openPlan} t={scope.translate('plan')}/>;
  }
  function Panel() {
    const scope = useContext(Bridge);
    return scope ? <Preview scope={scope}/> : null;
  }
  function Review({request}) {
    const scope = useContext(Bridge);
    return scope && request.questions.length === 1 && request.questions[0].id === 'plan-review'
      ? <ReviewOpen scope={scope} request={request}/> : null;
  }
  function ReviewOpen({scope, request}) {
    const entry = scope.entry('conversation.plan-review.actions');
    const injected = React.useMemo(() => entry.inject(scope.owner.view.session), [entry,scope]);
    const state = observe(scope.reviewStore ??= entry.store.create(scope.owner.view.session));
    const mounted = observe(injected.hooks.sidebarMounted);
    const review = React.useMemo(() => ({plan:request.questions[0].prompt}), [request.questions[0].prompt]);
    const Component = entry.component;
    return <Component review={review} requestKey={request.id} openReview={injected.openReview}
      useSidebarMounted={select=>select(mounted)} useStore={select=>select(state)} actions={scope.reviewStore.actions} t={scope.translate('plan')}/>;
  }
  function Preview({ scope }) {
    const { preview } = observe(scope.state);
    if (!preview) return null;
    const Component = scope.entry('sidebar.right.pane.tab', '@deepseek-ai/dsh-client-ui-plan').component;
    return <aside className="rsi-dsh-preview" aria-label="Plan preview"><header><strong>{preview.resource.value?.title ?? preview.tab.title}</strong>
      <button type="button" aria-label="Close plan preview" onClick={() => scope.closePreview()}>×</button></header>
      <Component useTabInfo={() => ({ tab: preview.tab })} useResource={() => preview.resource} t={scope.translate('plan')}/></aside>;
  }
  sdk.registerDocumentPlugin({ id: 'rsi-dsh-plugin-bridge', provider: Provider, composer: Composer,
    transcript: { matches: block => block.tool?.name === 'todo_write', component: Transcript }, turnTail: TurnTail, panel: Panel, review: Review });
  return async () => { themeObserver.disconnect(); detachTheme(); presenter.dispose(); await root.fiber.dispose(); };
}
