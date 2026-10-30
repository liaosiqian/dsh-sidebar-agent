import test from 'node:test';
import assert from 'node:assert/strict';
import { SidebarQuestionArchive, questionRequestHandler } from './archive.js';

function fixture(saved = {}) {
  const archived = new Set();
  let active = false;
  const records = { ...saved };
  const workspace = {
    get archivedSessionIds() { return [...archived]; },
    async archiveSession(id, options) {
      assert.equal(options, undefined, 'automatic archival must never stop work');
      if (active) {
        const error = new Error('Work is running');
        error.name = 'WorkspaceActiveSessionError';
        error.activity = [{ family: 'job', label: 'Background task' }];
        throw error;
      }
      archived.add(id);
    },
    async unarchiveSession(id) { archived.delete(id); },
  };
  const unit = {
    async loadAll() { return { tables: { questions: records } }; },
    async putRecord(_table, key, value) { records[key] = structuredClone(value); },
    async deleteRecord(_table, key) { delete records[key]; },
    async close() {},
  };
  const archive = new SidebarQuestionArchive(workspace, unit, () => 'session-parent');
  return { archive, records, archived, setActive(value) { active = value; } };
}
const request = { parentId: 'session-parent', childId: 'session-sb-child.123', label: 'Question 1' };

test('close archives and reopen cancels archival without losing registration', async () => {
  const f = fixture();
  assert.equal((await f.archive.run({ ...request, action: 'close' })).archived, true);
  assert.equal((await f.archive.run({ ...request, action: 'open' })).archived, false);
  await f.archive.retry();
  assert.equal(f.archived.size, 0);
  assert.equal((await f.archive.run({ action: 'list' })).items.length, 1);
});

test('running jobs defer archival, persist across restart, then archive', async () => {
  const f = fixture(); f.setActive(true);
  const result = await f.archive.run({ ...request, action: 'close' });
  assert.equal(result.state, 'pending');
  assert.equal(result.activity[0].family, 'job');
  assert.equal(f.archived.size, 0);
  const restarted = fixture(f.records);
  await restarted.archive.load();
  await restarted.archive.retry();
  assert.equal(restarted.archived.size, 1);
});

test('reopen wins over already queued archive retries', async () => {
  const f = fixture(); f.setActive(true);
  await f.archive.run({ ...request, action: 'close' });
  f.setActive(false);
  await Promise.all([f.archive.retry(), f.archive.run({ ...request, action: 'open' })]);
  await f.archive.retry();
  assert.equal(f.archived.size, 0);
});

test('forget removes management and restores ordinary access', async () => {
  const f = fixture();
  await f.archive.run({ ...request, action: 'close' });
  await f.archive.run({ ...request, action: 'forget' });
  assert.equal(f.archived.size, 0);
  assert.equal(Object.keys(f.records).length, 0);
});

test('a mismatched parent cannot mutate another question', async () => {
  const f = fixture();
  await assert.rejects(f.archive.run({ ...request, parentId: 'session-other', action: 'close' }), /does not match/);
  assert.equal(f.archived.size, 0);
});

test('unloading drains already accepted mutations', async () => {
  const f = fixture();
  const operation = f.archive.run({ ...request, action: 'close' });
  await f.archive.dispose();
  assert.equal((await operation).state, 'archived');
  await assert.rejects(f.archive.run({ ...request, action: 'open' }), /unavailable/);
});

const httpRequest = (input) => new Request('http://localhost/api/sidebar-agent/questions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
});

test('background requests share archive behavior without command or Agent services', async () => {
  const f = fixture();
  const handle = questionRequestHandler(f.archive);
  const close = await handle(httpRequest({ ...request, action: 'close' }));
  assert.equal(close.status, 200);
  assert.equal(close.headers.get('cache-control'), 'no-store');
  assert.equal((await close.json()).value.archived, true);
  const opened = await (await handle(httpRequest({ ...request, action: 'open' }))).json();
  assert.equal(opened.ok, true);
  assert.equal(opened.value.archived, false);
  const listed = await (await handle(httpRequest({ action: 'list', parentId: request.parentId }))).json();
  assert.equal(listed.value.items.length, 1);
  assert.deepEqual(listed.value.items, (await f.archive.run({ action: 'list' })).items);
});

test('invalid background input cannot invoke archive operations', async () => {
  let calls = 0;
  const handle = questionRequestHandler({ run() { calls++; } });
  for (const input of [null, [], { action: 'delete' }, { action: 'open' },
    { action: 'list', parentId: 2 }, { action: 'list', stopActivity: true }]) {
    const response = await handle(httpRequest(input));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  }
  const malformed = await handle(new Request('http://localhost', { method: 'POST', body: '{' }));
  assert.equal(malformed.status, 400);
  assert.equal(calls, 0);
});

test('background operation failures stay explicit and never succeed silently', async () => {
  const handle = questionRequestHandler({ run() { throw new Error('Storage unavailable'); } });
  const response = await handle(httpRequest({ action: 'list' }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.message, 'Storage unavailable');
});
