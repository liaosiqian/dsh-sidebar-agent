import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';

const clientUrl = new URL('./client.js', import.meta.url);
const clientSource = readFileSync(clientUrl, 'utf8');
const threadsPrefix = 'dsh.sidebar-agent.v1:';
const parentId = 'session-parent';
const childId = 'session-child';
const legacy = { id: childId, label: 'Question 1', hidden: true, closedAt: '2026-10-01T00:00:00Z' };
const tabFor = (id = childId) => ({
  id: `tab-${id}`, contentId: `content-${id}`, sessionId: parentId, kind: 'sidebaragent',
  navigation: { params: { childId: id, parentId } },
});

function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(next) { value = next; for (const listener of [...listeners]) listener(); },
    get listenerCount() { return listeners.size; },
  };
}

/** Load the unmodified browser artifact through its real factory and registrations. */
function fixture(rows = [], { nativeQuote = false, nativeSlot = true, interactionService = true, confirmNew = true, nativeTargetQuote = false } = {}) {
  const values = { [threadsPrefix + parentId]: JSON.stringify(rows) };
  const catalog = Object.fromEntries([parentId, ...rows.map((row) => row.id)].map((id) => [id, { title: id }]));
  const pages = new Set();
  const requests = [];
  let openGate;
  let nextId = 0;
  const emitStorage = (origin, key) => {
    for (const page of pages) if (page !== origin) page.emit('storage', { key });
  };
  const readRows = () => JSON.parse(values[threadsPrefix + parentId] ?? '[]');
  const writeRows = (next) => {
    values[threadsPrefix + parentId] = JSON.stringify(next);
    emitStorage(null, threadsPrefix + parentId);
  };
  const page = ({ tabs: initialTabs = [], mainView = [], phase = 'ready' } = {}) => {
    const timers = new Map();
    const events = new Map();
    const disposers = [];
    const registrations = new Map();
    const registrationOptions = new Map();
    const slotInjections = new Set();
    const interactions = observable(nativeQuote ? ['quote'] : []);
    const drafts = new Map();
    const insertions = [];
    const nativeQuotes = [];
    let draftBlocked = false;
    let quoteBlocked = false;
    let targetSession = { removed: false, subagent: null };
    const languages = new Map();
    const localeState = observable({ id: 'zh' });
    const retainedMain = new Set(mainView);
    const tabs = observable(initialTabs);
    const list = observable({ phase, byId: { ...catalog } });
    let nextTimer = 0;
    let module;
    let closeHandler;
    const instance = {
      tabs, list, interactions, drafts, insertions, nativeQuotes,
      registrationOptions,
      blockQuote(value) { quoteBlocked = value; },
      setTargetSession(value) { targetSession = value; },
      render(name, props = {}) { return registrations.get(name)?.(props); },
      setLocale(id) { localeState.set({ id }); },
      blockDraft(value) { draftBlocked = value; },
      setNativeQuote(enabled) { interactions.set(enabled ? ['quote'] : []); },
      setNativeSlot(enabled) {
        for (const injection of slotInjections) {
          if (injection.name !== 'conversation.chat.text-interaction') continue;
          if (!enabled) { injection.dispose?.(); injection.dispose = undefined; }
          else if (!injection.dispose) injection.dispose = injection.register();
        }
      },
      emit(type, event) { for (const listener of [...(events.get(type) ?? [])]) listener(event); },
      async flush() {
        // Timers are deterministic; the event-loop yield settles real operation promises.
        for (let pass = 0; pass < 20; pass += 1) {
          const pending = [...timers];
          timers.clear();
          for (const [, callback] of pending) callback();
          await setImmediate();
          if (timers.size === 0) return;
        }
        assert.fail('Client synchronization did not settle');
      },
      setPhase(next) { list.set({ ...list.getSnapshot(), phase: next }); },
      setMainView(id, retained) { if (retained) retainedMain.add(id); else retainedMain.delete(id); },
      close(tab = tabFor()) {
        closeHandler(parentId, tab);
        tabs.set(tabs.getSnapshot().filter((item) => item.id !== tab.id));
      },
      create() {
        const component = registrations.get('conversation.session.header.actions');
        const element = component({ sessionId: parentId });
        return element.props.children.find((child) => child?.type === 'button').props.onClick();
      },
      dispose() { for (const dispose of disposers.reverse()) dispose(); pages.delete(instance); },
      get storageListenerCount() { return events.get('storage')?.size ?? 0; },
    };
    pages.add(instance);
    const localStorage = new Proxy({}, {
      ownKeys: () => Object.keys(values),
      getOwnPropertyDescriptor: (_target, key) => Object.hasOwn(values, key)
        ? { configurable: true, enumerable: true, value: values[key] } : undefined,
      get: (_target, key) => ({
        getItem: (name) => values[name] ?? null,
        setItem(name, value) {
          if (values[name] === value) return;
          values[name] = value;
          emitStorage(instance, name);
        },
        removeItem(name) {
          if (!Object.hasOwn(values, name)) return;
          delete values[name];
          emitStorage(instance, name);
        },
      })[key] ?? values[key],
    });
    const context = {
      effect(operation) { const dispose = operation(); if (typeof dispose === 'function') disposers.push(dispose); },
      locale: {
        register(namespace, dicts) { languages.set(namespace, dicts); return () => languages.delete(namespace); },
        bind: (namespace) => (key) => languages.get(namespace)?.[localeState.getSnapshot().id]?.[key] ?? key,
        getSnapshot: localeState.getSnapshot,
        subscribe: localeState.subscribe,
      },
      get: (name) => {
        if (name === 'uiConversation') return interactionService ? { interactions } : undefined;
        if (name === 'conversation') return {
          blocks: { storeFor: () => ({ getSnapshot: () => quoteBlocked ? { reason: 'blocked' } : undefined }) },
          input: {
            for: nativeTargetQuote ? (scope) => ({
              state: { getSnapshot: () => ({ phase: draftBlocked ? 'sending' : 'plain' }) },
              insertQuote(text) {
                assert.equal(draftBlocked || quoteBlocked, false);
                nativeQuotes.push({ id: scope.id, text });
                drafts.set(scope.id, (drafts.get(scope.id) ?? '') + text.split('\n').map((line) => `> ${line}`).join('\n'));
                return true;
              },
            }) : undefined,
            requestDraftInitialization(binding, options) {
              if (draftBlocked) return 'blocked';
              insertions.push({ id: binding.id, ...options });
              drafts.set(binding.id, (drafts.get(binding.id) ?? '') + options.prompt);
              return 'applied';
            },
          },
        };
        return { register: () => () => {} };
      },
      slots: {
        inject(name, register) {
          const injection = { name, register, dispose: undefined };
          slotInjections.add(injection);
          if (name !== 'conversation.chat.text-interaction' || nativeSlot) injection.dispose = register();
          return () => { injection.dispose?.(); slotInjections.delete(injection); };
        },
        register(options, component) {
          registrations.set(options.name, component);
          registrationOptions.set(options.name, options);
          return () => { registrations.delete(options.name); registrationOptions.delete(options.name); };
        },
      },
      sessions: {
        list,
        retain(id) { return { ready: Promise.resolve(), binding: { id, ctx: { id }, session: { getSnapshot: () => targetSession } }, release() {} }; },
        retainInfo: (id) => ({ getSnapshot: () => ({ retainedBy: retainedMain.has(id) ? { mainView: 1 } : {} }) }),
        async create({ sessionId }) {
          catalog[sessionId] = { title: sessionId, blank: true };
          for (const other of pages) other.list.set({ ...other.list.getSnapshot(), byId: { ...catalog } });
          return sessionId;
        },
      },
      sidebarRight: {
        openTabs: tabs,
        registerCloseHandler(_kind, handler) { closeHandler = handler; return () => { closeHandler = undefined; }; },
        isExpanded: () => true,
        tabsIn: (id) => tabs.getSnapshot().filter((tab) => tab.sessionId === id),
        openTabIn(id, kind, { params }) { tabs.set([...tabs.getSnapshot(), { ...tabFor(params.childId), sessionId: id, kind }]); },
      },
    };
    const React = {
      Fragment: Symbol('Fragment'),
      createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
      useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
      useEffect() {},
      useRef: (initial) => ({ current: initial }),
      useCallback: (callback) => callback,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    runInNewContext(clientSource, {
      console, URL, btoa, atob,
      requestAnimationFrame(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      crypto: { randomUUID: () => `question-${++nextId}` },
      window: {
        localStorage,
        __ModuleLoader__: { load(value) { module = value; } },
        confirm: () => confirmNew,
        setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimeout: (id) => timers.delete(id),
        addEventListener(type, listener) {
          if (!events.has(type)) events.set(type, new Set());
          events.get(type).add(listener);
        },
        removeEventListener(type, listener) { events.get(type)?.delete(listener); },
      },
      document: {
        baseURI: 'http://dsh.example/', head: { appendChild() {} }, querySelectorAll: () => [],
        createElement: () => ({ setAttribute() {}, remove() {} }),
      },
      async fetch(url, options) {
        assert.equal(url.pathname, '/api/sidebar-agent/questions');
        const request = JSON.parse(options.body);
        requests.push(request);
        if (request.action === 'open' && openGate) await openGate;
        return { ok: true, async json() {
          return { ok: true, value: { state: request.action === 'close' ? 'archived' : 'open' } };
        } };
      },
    }, { filename: clientUrl.pathname });
    module.factory((name) => { assert.equal(name, 'react'); return React; }).apply(context);
    return instance;
  };
  return {
    page, requests, readRows, writeRows,
    holdOpen() {
      let release;
      openGate = new Promise((resolve) => { release = resolve; });
      return release;
    },
  };
}

const closes = (f) => f.requests.filter((request) => request.action === 'close');

test('a second page never closes a new child while its create/open request is pending', async () => {
  const f = fixture();
  const creator = f.page();
  const observer = f.page();
  await observer.flush();
  const release = f.holdOpen();
  const creation = creator.create();
  try {
    await setImmediate();
    assert.equal(f.requests.filter((request) => request.action === 'open').length, 1);
    assert.equal(creator.tabs.getSnapshot().length, 0, 'the child is registered before a tab opens');
    await observer.flush();
    assert.equal(closes(f).length, 0);
    assert.equal(f.readRows()[0].hidden, undefined);
  } finally { release(); }
  await creation;
  await creator.flush();
  await observer.flush();
  assert.equal(creator.tabs.getSnapshot().length, 1);
  assert.equal(f.readRows()[0].archiveState, 'open');
  assert.equal(closes(f).length, 0);
});

test('startup never archives open, ambiguous, or already managed question records', async () => {
  const rows = [
    { id: 'session-new' },
    { id: 'session-open', hidden: false },
    { id: 'session-ambiguous', closedAt: legacy.closedAt },
    ...['open', 'pending', 'archived', 'error'].map((archiveState) => ({
      id: `session-managed-${archiveState}`, hidden: true, archiveState,
    })),
  ];
  const f = fixture(rows);
  const page = f.page();
  await page.flush();
  page.tabs.set([tabFor('session-open')]);
  await page.flush();
  page.tabs.set([]);
  await page.flush();
  assert.equal(closes(f).length, 0);
  assert.deepEqual(f.readRows(), rows);
});

test('positively closed legacy questions migrate exactly once after the catalog is ready', async () => {
  const f = fixture([legacy]);
  const page = f.page({ phase: 'loading' });
  await page.flush();
  assert.equal(closes(f).length, 0);
  page.setPhase('ready');
  await page.flush();
  assert.deepEqual(closes(f).map((request) => request.childId), [childId]);
  assert.equal(f.readRows()[0].archiveState, 'archived');
  page.setPhase('ready');
  f.writeRows(f.readRows());
  await page.flush();
  assert.equal(closes(f).length, 1);
});

test('storage discoveries after activation never become migration candidates', async () => {
  const f = fixture();
  const page = f.page({ phase: 'loading' });
  f.writeRows([legacy]);
  page.list.set({ phase: 'ready', byId: { [childId]: {} } });
  await page.flush();
  assert.equal(closes(f).length, 0);
  assert.deepEqual(f.readRows(), [legacy]);
});

for (const owner of ['saved sidebar tab', 'main view']) {
  test(`legacy question open in a ${owner} at activation stays open after navigation`, async () => {
    const f = fixture([legacy]);
    const page = f.page({
      phase: 'loading', tabs: owner === 'saved sidebar tab' ? [tabFor()] : [],
      mainView: owner === 'main view' ? [childId] : [],
    });
    page.tabs.set([]);
    page.setMainView(childId, false);
    page.setPhase('ready');
    await page.flush();
    assert.equal(closes(f).length, 0);
  });

  test(`opening a legacy question in a ${owner} during catalog loading cancels migration`, async () => {
    const f = fixture([legacy]);
    const page = f.page({ phase: 'loading' });
    if (owner === 'saved sidebar tab') page.tabs.set([tabFor()]);
    else page.setMainView(childId, true);
    await page.flush();
    page.tabs.set([]);
    page.setMainView(childId, false);
    page.setPhase('ready');
    await page.flush();
    assert.equal(closes(f).length, 0);
  });
}

test('a legacy candidate reopened by another page is revalidated before migration', async () => {
  const f = fixture([legacy]);
  const page = f.page();
  f.writeRows([{ ...legacy, hidden: false, archiveState: 'open' }]);
  await page.flush();
  page.tabs.set([]);
  await page.flush();
  assert.equal(closes(f).length, 0);
});

test('removed legacy candidates cannot be adopted if their shortcut reappears later', async () => {
  const f = fixture([legacy]);
  const page = f.page({ phase: 'loading' });
  f.writeRows([]);
  await page.flush();
  f.writeRows([legacy]);
  page.setPhase('ready');
  await page.flush();
  assert.equal(closes(f).length, 0);
});

test('explicit tab close still archives a managed question through the registered handler', async () => {
  const f = fixture([{ ...legacy, hidden: false, archiveState: 'open' }]);
  const page = f.page({ tabs: [tabFor()] });
  await page.flush();
  page.close();
  assert.equal(f.readRows()[0].hidden, true);
  assert.equal(f.readRows()[0].archiveState, 'pending');
  await page.flush();
  assert.deepEqual(closes(f).map((request) => request.childId), [childId]);
  assert.equal(f.readRows()[0].archiveState, 'archived');
});

test('plugin disposal cancels migration timers and subscriptions', async () => {
  const f = fixture([legacy]);
  const page = f.page();
  page.dispose();
  page.setPhase('ready');
  f.writeRows([legacy]);
  await page.flush();
  assert.equal(closes(f).length, 0);
  assert.equal(page.list.listenerCount, 0);
  assert.equal(page.tabs.listenerCount, 0);
  assert.equal(page.storageListenerCount, 0);
});

const nativeSeat = 'conversation.chat.text-interaction';
const legacySeat = 'conversation.composer.dock';
function selectionSurface(page, overrides = {}) {
  const calls = { quotes: [], cleared: 0, dismissed: 0 };
  const props = {
    sessionId: parentId,
    useSession: (select) => select({ removed: false, subagent: null }),
    readText: () => 'Visible math: x².\nSecond line',
    clearSelection: () => { calls.cleared += 1; },
    dismiss: () => { calls.dismissed += 1; },
    inputActions: { insertQuote(text) { calls.quotes.push(text); return true; } },
    ...overrides,
  };
  const element = page.render(nativeSeat, props);
  const buttons = element?.type === 'button' ? [element] : element?.props.children.filter((item) => item?.type === 'button') ?? [];
  return { element, buttons, calls, props };
}

test('native Quote uses one local surface and never mounts the legacy selection listeners', () => {
  const page = fixture([], { nativeQuote: true }).page();
  const options = page.registrationOptions.get(nativeSeat);
  assert.equal(options.key, 'quote');
  assert.equal(options.priority, -100);
  assert.equal(page.render(legacySeat, { sessionId: parentId }), null);
  const { element, buttons, calls } = selectionSurface(page);
  assert.equal(element.props['data-sidebar-agent-selection'], 'native');
  assert.deepEqual(buttons.map((button) => button.props.children[0]), ['复制', '引用文本', '在侧边栏提问']);
  buttons[1].props.onClick();
  assert.deepEqual(calls.quotes, ['Visible math: x².\nSecond line']);
  assert.equal(calls.cleared, 1);
  assert.equal(calls.dismissed, 1);
  page.dispose();
});

test('native Quote preserves a locked draft and dismisses stale selections without insertion', () => {
  const page = fixture([], { nativeQuote: true }).page();
  const locked = selectionSurface(page, { inputActions: { insertQuote: () => false } });
  locked.buttons[1].props.onClick();
  assert.equal(locked.calls.cleared, 0);
  assert.equal(locked.calls.dismissed, 0);
  const stale = selectionSurface(page, { readText: () => null });
  stale.buttons[1].props.onClick();
  assert.equal(stale.calls.quotes.length, 0);
  assert.equal(stale.calls.dismissed, 1);
  page.dispose();
});

test('native quote availability follows runtime registration, slot collapse and plugin unload', () => {
  const page = fixture([], { nativeQuote: true }).page();
  assert.equal(page.render(legacySeat), null);
  page.setNativeSlot(false);
  assert.equal(page.render(legacySeat).type.name, 'SidebarAgentSelectionToolbar');
  page.setNativeSlot(true);
  assert.equal(page.render(legacySeat), null);
  page.setNativeQuote(false);
  assert.equal(page.registrationOptions.has(nativeSeat), false);
  assert.equal(page.render(legacySeat).type.name, 'SidebarAgentSelectionToolbar');
  page.setNativeQuote(true);
  assert.equal(page.render(legacySeat), null);
  page.dispose();
  assert.equal(page.interactions.listenerCount, 0);
  assert.equal(page.registrationOptions.has(nativeSeat), false);
});

test('older DSH keeps the legacy toolbar when native quotes are absent', () => {
  for (const interactionService of [false, true]) {
    const page = fixture([], { interactionService }).page();
    assert.equal(page.registrationOptions.has(nativeSeat), false);
    assert.equal(page.render(legacySeat).type.name, 'SidebarAgentSelectionToolbar');
    page.dispose();
  }
});

test('native admission can register before its Slot without suppressing the legacy fallback early', () => {
  const page = fixture([], { nativeQuote: true, nativeSlot: false }).page();
  assert.equal(page.registrationOptions.has(nativeSeat), false);
  assert.equal(page.render(legacySeat).type.name, 'SidebarAgentSelectionToolbar');
  page.setNativeSlot(true);
  assert.equal(page.render(legacySeat), null);
  page.dispose();
});

test('read-only child Sessions cannot quote and sidebar children never offer recursive Ask', () => {
  const page = fixture([], { nativeQuote: true }).page();
  for (const session of [
    { removed: true, subagent: null },
    { removed: false, subagent: { address: { mode: 'oneShot' }, parentAvailable: true } },
    { removed: false, subagent: { address: { mode: 'continuable' }, parentAvailable: false } },
  ]) assert.equal(selectionSurface(page, { useSession: (select) => select(session) }).element, null);
  const childSessionId = `session-sb-${Buffer.from(parentId).toString('base64url')}.child`;
  const child = selectionSurface(page, { sessionId: childSessionId });
  assert.equal(child.buttons.length, 1);
  assert.equal(child.buttons[0].props.children[0], '引用文本');
  child.buttons[0].props.onClick();
  assert.equal(child.calls.quotes.length, 1);
  assert.equal(child.calls.cleared, 1);
  page.dispose();
});

test('selection actions follow the active locale', () => {
  const page = fixture([], { nativeQuote: true }).page();
  page.setLocale('en');
  assert.deepEqual(selectionSurface(page).buttons.map((button) => button.props.children[0]), ['Copy', 'Quote text', 'Ask in sidebar']);
  page.dispose();
});

test('Ask captures sanitized native text, guards double clicks, then appends to the same sidebar draft', async () => {
  const f = fixture([], { nativeQuote: true });
  const page = f.page();
  const release = f.holdOpen();
  const first = selectionSurface(page);
  first.buttons[2].props.onClick();
  first.buttons[2].props.onClick();
  await setImmediate();
  assert.equal(f.readRows().length, 1);
  assert.equal(f.requests.filter((request) => request.action === 'open').length, 1);
  release();
  await page.flush();
  assert.equal(page.insertions.length, 1);
  const id = f.readRows()[0].id;
  assert.ok(page.drafts.get(id).includes('> Visible math: x².\n> Second line'));
  assert.equal(page.drafts.has(parentId), false);
  assert.equal(first.calls.cleared, 1);
  assert.equal(first.calls.dismissed, 1);
  const second = selectionSurface(page, { readText: () => 'Another excerpt' });
  second.buttons[2].props.onClick();
  await page.flush();
  assert.equal(f.readRows().length, 1);
  assert.equal(page.insertions.length, 2);
  assert.equal(page.insertions[1].id, id);
  assert.ok(page.drafts.get(id).includes('> Another excerpt'));
  assert.ok(f.requests.every((request) => request.action === 'open'));
  page.dispose();
});

test('sidebar excerpts use the target Session native Quote with source and follow-up outside it', async () => {
  const f = fixture([], { nativeQuote: true, nativeTargetQuote: true });
  const page = f.page();
  const first = selectionSurface(page);
  first.buttons[2].props.onClick();
  await page.flush();
  const id = f.readRows()[0].id;
  assert.deepEqual(page.nativeQuotes, [{ id, text: 'Visible math: x².\nSecond line' }]);
  assert.equal(page.insertions.length, 2);
  assert.ok(page.insertions[0].prompt.includes('### 主会话选中内容'));
  assert.ok(page.insertions[1].prompt.includes('我的追问：'));
  assert.ok(page.insertions.every((item) => !item.prompt.includes('> Visible math')));
  assert.equal(page.drafts.has(parentId), false);
  const second = selectionSurface(page, { readText: () => 'Second excerpt' });
  second.buttons[2].props.onClick();
  await page.flush();
  assert.equal(page.nativeQuotes.length, 2);
  assert.equal(page.nativeQuotes[1].id, id);
  assert.equal(f.readRows().length, 1);
  assert.ok(page.drafts.get(id).includes('Visible math: x².'));
  assert.ok(page.drafts.get(id).includes('Second excerpt'));
  page.dispose();
});

test('native sidebar Quote preserves an existing draft and never replaces its content', async () => {
  const f = fixture([{ id: childId, hidden: false }], { nativeQuote: true, nativeTargetQuote: true });
  const page = f.page({ tabs: [tabFor()] });
  page.drafts.set(childId, 'Existing unsent draft and reference chip');
  selectionSurface(page).buttons[2].props.onClick();
  await page.flush();
  assert.ok(page.drafts.get(childId).startsWith('Existing unsent draft and reference chip'));
  assert.equal(page.nativeQuotes.length, 1);
  assert.ok(page.insertions.every((item) => item.whenDraftExists === 'append'));
  page.dispose();
});

for (const reason of ['submission', 'composer block', 'removed Session']) {
  test(`native sidebar Quote leaves the entire draft unchanged under ${reason}`, async () => {
    const f = fixture([{ id: childId, hidden: false }], { nativeQuote: true, nativeTargetQuote: true });
    const page = f.page({ tabs: [tabFor()] });
    page.drafts.set(childId, 'Keep this draft');
    if (reason === 'submission') page.blockDraft(true);
    if (reason === 'composer block') page.blockQuote(true);
    if (reason === 'removed Session') page.setTargetSession({ removed: true, subagent: null });
    const surface = selectionSurface(page);
    surface.buttons[2].props.onClick();
    await page.flush();
    assert.equal(page.drafts.get(childId), 'Keep this draft');
    assert.equal(page.nativeQuotes.length, 0);
    assert.equal(page.insertions.length, 0);
    assert.equal(surface.calls.cleared, 0);
    page.dispose();
  });
}

test('a pending sidebar operation does not clear or dismiss a newer selection', async () => {
  const f = fixture([], { nativeQuote: true });
  const page = f.page();
  const release = f.holdOpen();
  let text = 'Original excerpt';
  const surface = selectionSurface(page, { readText: () => text });
  surface.buttons[2].props.onClick();
  await setImmediate();
  text = 'A newer selection';
  release();
  await page.flush();
  assert.equal(page.insertions.length, 1);
  assert.ok(page.insertions[0].prompt.includes('> Original excerpt'));
  assert.equal(page.insertions[0].prompt.includes('A newer selection'), false);
  assert.equal(surface.calls.cleared, 0);
  assert.equal(surface.calls.dismissed, 0);
  page.dispose();
});

test('Ask truncates only sidebar excerpts and keeps the native Quote input intact', async () => {
  const page = fixture([], { nativeQuote: true }).page();
  const text = '界'.repeat(4500);
  const surface = selectionSurface(page, { readText: () => text });
  surface.buttons[1].props.onClick();
  assert.equal(surface.calls.quotes[0], text);
  surface.buttons[2].props.onClick();
  await page.flush();
  assert.ok(page.insertions[0].prompt.includes('界'.repeat(4000)));
  assert.equal(page.insertions[0].prompt.includes('界'.repeat(4001)), false);
  assert.ok(page.insertions[0].prompt.includes('选区已截断'));
  page.dispose();
});

test('cancelling a new sidebar leaves the selection and all existing question drafts unchanged', async () => {
  const f = fixture([{ id: childId, hidden: true, archiveState: 'archived' }], { nativeQuote: true, confirmNew: false });
  const page = f.page();
  const surface = selectionSurface(page);
  surface.buttons[2].props.onClick();
  await page.flush();
  assert.equal(f.readRows().length, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(page.insertions.length, 0);
  assert.equal(surface.calls.cleared, 0);
  assert.equal(surface.calls.dismissed, 0);
  page.dispose();
});

test('Ask retains selection on blocked target drafts and ignores expired selections', async () => {
  const f = fixture([{ id: childId, hidden: false }], { nativeQuote: true });
  const page = f.page({ tabs: [tabFor()] });
  page.blockDraft(true);
  const blocked = selectionSurface(page);
  blocked.buttons[2].props.onClick();
  await page.flush();
  assert.equal(page.insertions.length, 0);
  assert.equal(blocked.calls.cleared, 0);
  assert.equal(blocked.calls.dismissed, 0);
  const stale = selectionSurface(page, { readText: () => null });
  stale.buttons[2].props.onClick();
  await page.flush();
  assert.equal(stale.calls.dismissed, 1);
  assert.equal(page.insertions.length, 0);
  page.dispose();
});
