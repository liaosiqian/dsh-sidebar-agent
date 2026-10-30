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
function fixture(rows = []) {
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
    const retainedMain = new Set(mainView);
    const tabs = observable(initialTabs);
    const list = observable({ phase, byId: { ...catalog } });
    let nextTimer = 0;
    let module;
    let closeHandler;
    const instance = {
      tabs, list,
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
      locale: { register: () => () => {} },
      get: () => ({ register: () => () => {} }),
      slots: {
        inject: (_name, register) => register(),
        register(options, component) { registrations.set(options.name, component); return () => registrations.delete(options.name); },
      },
      sessions: {
        list,
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
      useCallback: (callback) => callback,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    };
    runInNewContext(clientSource, {
      console, URL, btoa, atob,
      crypto: { randomUUID: () => `question-${++nextId}` },
      window: {
        localStorage,
        __ModuleLoader__: { load(value) { module = value; } },
        confirm: () => true,
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
