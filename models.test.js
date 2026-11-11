import test from 'node:test';
import assert from 'node:assert/strict';
import { SidebarModels, modelRequestHandler, nativeModelRequestHandler } from './models.js';
import { Config } from './index.js';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const parent = 'session-parent';
const sidebar = `session-sb-${Buffer.from(parent).toString('base64url')}.test`;
const parentOf = (id) => id === sidebar ? parent : undefined;
const A = { provider: 'p', model: 'a', reasoningEffort: 'high' };
const B = { provider: 'p', model: 'b', reasoningEffort: 'low' };
const catalog = { groups: [{ id: 'p', name: 'Provider', models: [
  { id: 'a', name: 'A', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
  { id: 'b', name: 'B', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
  { id: 'plain', name: 'Plain' },
] }], failures: [] };

function fixture(defaults = { mode: 'dsh' }) {
  let current = structuredClone(defaults);
  let revision = 0;
  const selected = [];
  const savedGlobals = [];
  const agents = new Map();
  const agent = (id, selection) => {
    const value = {
      id, session: { header: { isSeeded: false }, firstLiveSeq: 0 },
      recorded: null,
      model: { current: () => value.recorded ?? selection, select(next) { value.recorded = structuredClone(next); selected.push({ id, selection: next }); } },
    };
    agents.set(id, value);
    return value;
  };
  const main = agent(parent, A);
  const child = agent(sidebar, A);
  const config = { modelDefaults: { get: () => current } };
  const ctx = {
    fiber: { entry: { id: 'include:sidebar-agent', options: { id: 'sidebar-agent' } } },
    get(name) { return name === 'settings' ? this.settings : name === 'configEditor' ? {} : undefined; },
    settings: {
      describe: () => [{ ns: 'sidebar-agent', revision }],
      async mutate(ns, operations, expected) {
        assert.equal(ns, 'sidebar-agent');
        if (expected !== undefined && expected !== revision) throw new Error('Settings conflict');
        assert.deepEqual(operations[0].path, ['modelDefaults']);
        current = structuredClone(operations[0].value); revision += 1;
      },
    },
    llm: {
      listProviders: () => [{ id: 'p' }],
      listModels: async () => catalog.groups[0].models,
      resolveModelInfo: async (_provider, model) => catalog.groups[0].models.find((item) => item.id === model),
      resolveCallConfig: async (selection) => ({ ...selection }),
    },
    sessionController: {
      resolveAgent: async (id) => agents.has(id) ? { agent: agents.get(id) } : { error: new Error('Session unavailable') },
      modelCatalog: async () => ({ ...catalog, default: A }),
    },
    sessionProjections: { snapshot: (session) => ({ values: { modelSelection: { next: [...agents.values()].find((a) => a.session === session)?.recorded } } }) },
  };
  const gateway = { async invoke({ namespace, method, args }) {
    assert.equal(namespace, 'session'); assert.equal(method, 'selectModel');
    const { sessionId, ...selection } = args.request;
    agents.get(sessionId).model.select(selection);
    savedGlobals.push(selection);
    return { selected: selection };
  } };
  const models = new SidebarModels(ctx, config, parentOf);
  return { ctx, config, models, main, child, agent, selected, savedGlobals, gateway };
}
const req = (body, headers = { 'content-type': 'application/json' }) => new Request('http://dsh/api/session/selectModel', { method: 'POST', headers, body: JSON.stringify(body) });
const rpc = (selection, sessionId = sidebar) => ({ type: 'client-request', rpcId: 'rpc-test', method: 'session/selectModel', payload: { args: { request: { sessionId, ...selection } } } });

test('Config keeps old installations valid and supports one atomic model default', () => {
  assert.deepEqual(Config({}).modelDefaults.get(), { mode: 'dsh' });
  assert.deepEqual(Config({ modelDefaults: { mode: 'parent' } }).modelDefaults.get(), { mode: 'parent' });
  assert.deepEqual(Config({ modelDefaults: { mode: 'fixed', fixed: B } }).modelDefaults.get(), { mode: 'fixed', fixed: B });
});

test('DSH default mode leaves a fresh sidebar unpinned', async () => {
  const f = fixture();
  await f.models.initialize({ agent: f.child, source: 'startup' });
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.child.model.current(), A);
});

test('fixed model initialization carries effort without changing main or global defaults', async () => {
  const f = fixture({ mode: 'fixed', fixed: B });
  await f.models.initialize({ agent: f.child, source: 'startup' });
  assert.deepEqual(f.child.model.current(), B);
  assert.deepEqual(f.main.model.current(), A);
  assert.deepEqual(f.savedGlobals, []);
});

test('parent initialization copies its current pending model and effort only once', async () => {
  const f = fixture({ mode: 'parent' });
  f.main.model.select(B);
  await f.models.initialize({ agent: f.child, source: 'startup' });
  f.main.model.select(A);
  assert.deepEqual(f.child.model.current(), B);
  await f.models.configure({ mode: 'fixed', fixed: A }, 0);
  await f.models.initialize({ agent: f.child, source: 'startup' });
  assert.deepEqual(f.child.model.current(), B);
});

for (const scenario of ['resume', 'seeded', 'started', 'normal']) test(`model defaults do not overwrite ${scenario} Sessions`, async () => {
  const f = fixture({ mode: 'fixed', fixed: B });
  if (scenario === 'seeded') f.child.session.header.isSeeded = true;
  if (scenario === 'started') f.child.session.firstLiveSeq = 4;
  await f.models.initialize({ agent: scenario === 'normal' ? f.main : f.child, source: scenario === 'resume' ? 'resume' : 'startup' });
  assert.deepEqual(f.selected, []);
});

test('settings persist independently with revisions and omitted effort clears the old value', async () => {
  const f = fixture();
  assert.equal(f.models.settings().writable, true);
  assert.deepEqual((await f.models.run({ action: 'configure', defaults: { mode: 'fixed', fixed: B }, expectedRevision: 0 })).defaults.fixed, B);
  await assert.rejects(f.models.configure({ mode: 'parent' }, 0), /conflict/);
  await f.models.configure({ mode: 'fixed', fixed: { provider: 'p', model: 'b' } }, 1);
  assert.equal(f.models.settings().defaults.fixed.reasoningEffort, undefined);
  const reloaded = new SidebarModels(f.ctx, f.config, parentOf);
  assert.deepEqual(reloaded.settings().defaults, { mode: 'fixed', fixed: { provider: 'p', model: 'b' } });
  assert.deepEqual(f.savedGlobals, []);
});

test('unsupported model and effort fail before any session or settings mutation', async () => {
  const f = fixture();
  for (const selection of [{ provider: 'missing', model: 'a' }, { provider: 'p', model: 'absent' }, { provider: 'p', model: 'b', reasoningEffort: 'high' }, { provider: 'p', model: 'plain', reasoningEffort: 'low' }]) {
    await assert.rejects(f.models.select(sidebar, selection), /unavailable/);
    await assert.rejects(f.models.configure({ mode: 'fixed', fixed: selection }, 0), /unavailable/);
  }
  assert.deepEqual(f.selected, []);
  assert.deepEqual(f.models.settings().defaults, { mode: 'dsh' });
});

test('an unavailable saved model cannot prevent switching away from fixed defaults', async () => {
  const f = fixture({ mode: 'fixed', fixed: { provider: 'missing', model: 'gone' } });
  const state = await f.models.configure({ mode: 'parent', fixed: { provider: 'missing', model: 'gone' } }, 0);
  assert.deepEqual(state.defaults, { mode: 'parent' });
});

test('independent manual model and effort choices serialize and never touch ordinary Sessions', async () => {
  const f = fixture();
  await Promise.all([f.models.select(sidebar, B), f.models.select(sidebar, { provider: 'p', model: 'b' })]);
  assert.deepEqual(f.child.model.current(), { provider: 'p', model: 'b' });
  assert.deepEqual(f.main.model.current(), A);
  await assert.rejects(f.models.select(parent, B), /only applies/);
  assert.deepEqual(f.savedGlobals, []);
  assert.equal(f.models.pending.size, 0);
});

test('native model menu and /model RPC keep the wire result and isolate sidebar choices', async () => {
  const f = fixture();
  const handler = nativeModelRequestHandler(f.models, f.gateway, {}, parentOf);
  for (const selection of [B, { provider: 'p', model: 'b' }]) {
    const reply = await (await handler(req(rpc(selection)))).json();
    assert.deepEqual(reply, { type: 'server-response', rpcId: 'rpc-test', result: { ok: true, value: { selected: selection } } });
  }
  assert.deepEqual(f.savedGlobals, []);
  assert.deepEqual(f.main.model.current(), A);
  await handler(req(rpc(B, parent)));
  assert.deepEqual(f.savedGlobals, [B], 'ordinary Sessions keep native default saving');
});

test('invalid native RPC returns an explicit error and never changes a model', async () => {
  const f = fixture();
  const handler = nativeModelRequestHandler(f.models, f.gateway, {}, parentOf);
  for (const body of [null, {}, { ...rpc(B), method: 'other' }, rpc({ provider: 'p', model: 'b', reasoningEffort: 'high' })]) {
    assert.equal((await (await handler(req(body))).json()).result.ok, false);
  }
  assert.equal((await handler(req(rpc(B), {}))).status, 415);
  assert.deepEqual(f.selected, []);
});

test('tool and settings HTTP endpoint use the same operation with no command or model turn', async () => {
  const f = fixture();
  const handler = modelRequestHandler(f.models);
  const input = { action: 'configure', defaults: { mode: 'fixed', fixed: B }, expectedRevision: 0 };
  const reply = await (await handler(req(input))).json();
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.value, await f.models.run({ action: 'settings' }));
  assert.equal((await (await handler(req({ action: 'select', sessionId: parent, selection: B }))).json()).ok, false);
});

// Test the settings controller's behavior, not a DOM or visual rendering substitute.
const controllerSource = readFileSync(new URL('./model-settings-client.js', import.meta.url), 'utf8');
function clientController(call) {
  return runInNewContext(`${controllerSource}\ncreateModelSettingsController(call)`, { call, console });
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('settings editor keeps a default effort omission and resets it on model changes', async () => {
  let saved;
  const controller = clientController(async (input) => {
    if (input.action === 'catalog') return catalog;
    if (input.action === 'settings') return { defaults: { mode: 'fixed', fixed: A }, revision: 1, writable: true };
    saved = plain(input);
    return { defaults: saved.defaults, revision: 2, writable: true };
  });
  await controller.load();
  controller.route(JSON.stringify(['p', 'b']));
  assert.deepEqual(plain(controller.getSnapshot().draft.fixed), { provider: 'p', model: 'b' });
  controller.effort('low');
  await controller.save();
  assert.equal(saved.defaults.fixed.reasoningEffort, 'low');
  assert.equal(saved.expectedRevision, 1);
  controller.effort('');
  await controller.save();
  assert.equal(saved.defaults.fixed.reasoningEffort, undefined);
  controller.dispose();
});

test('refresh and failed concurrent save preserve an edited draft and its revision', async () => {
  let revision = 1;
  const controller = clientController(async (input) => {
    if (input.action === 'catalog') return catalog;
    if (input.action === 'settings') return { defaults: { mode: 'dsh' }, revision, writable: true };
    if (input.expectedRevision !== revision) throw new Error('Settings conflict');
  });
  await controller.load(); controller.edit({ mode: 'parent' }); revision = 2;
  await controller.load();
  assert.equal(controller.getSnapshot().draft.mode, 'parent');
  assert.equal(controller.getSnapshot().revision, 1);
  await controller.save();
  assert.match(controller.getSnapshot().error, /conflict/);
  assert.equal(controller.getSnapshot().dirty, true);
  controller.dispose();
});

test('a pre-save refresh cannot overwrite the accepted settings write', async () => {
  let refreshGate;
  let reads = 0;
  const controller = clientController(async (input) => {
    if (input.action === 'catalog') return catalog;
    if (input.action === 'settings') {
      reads += 1;
      if (reads > 1) await new Promise((resolve) => { refreshGate = resolve; });
      return { defaults: { mode: 'dsh' }, revision: 0, writable: true };
    }
    return { defaults: { mode: 'parent' }, revision: 1, writable: true };
  });
  await controller.load(); controller.edit({ mode: 'parent' });
  const refresh = controller.load();
  await controller.save(); refreshGate(); await refresh;
  assert.equal(controller.getSnapshot().draft.mode, 'parent');
  assert.equal(controller.getSnapshot().revision, 1);
  controller.dispose();
});

test('plugin disposal rejects later model mutations', async () => {
  const f = fixture();
  await f.models.dispose();
  await assert.rejects(f.models.select(sidebar, B), /unavailable/);
  assert.deepEqual(f.selected, []);
});

test('read-only and disposed settings editor never submits a write', async () => {
  let writes = 0;
  const controller = clientController(async (input) => {
    if (input.action === 'catalog') return catalog;
    if (input.action === 'settings') return { defaults: { mode: 'dsh' }, revision: 0, writable: false };
    writes += 1;
  });
  await controller.load(); controller.edit({ mode: 'parent' }); await controller.save();
  assert.equal(writes, 0); controller.dispose();
});
