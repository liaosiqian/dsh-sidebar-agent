/** Durable archive intent. Every mutation is serialized with reopen and retries. */
export class SidebarQuestionArchive {
  constructor(workspaces, unit, parentOf) {
    this.workspaces = workspaces;
    this.unit = unit;
    this.parentOf = parentOf;
    this.records = new Map();
    this.tail = Promise.resolve();
    this.disposed = false;
  }

  async load() {
    const saved = await this.unit.loadAll();
    for (const record of Object.values(saved.tables.questions ?? {})) {
      if (record && typeof record.childId === 'string' && typeof record.parentId === 'string') {
        this.records.set(record.childId, record);
      }
    }
  }

  serial(operation) {
    if (this.disposed) return Promise.reject(new Error('Sidebar questions are unavailable'));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  async save(record) {
    await this.unit.putRecord('questions', Buffer.from(record.childId).toString('base64url'), record);
    this.records.set(record.childId, record);
    return record;
  }

  view(record) {
    return { ...record, archived: this.workspaces.archivedSessionIds.includes(record.childId) };
  }

  async archive(record) {
    try {
      // Never stop work: the registry checks turns, subagents, jobs and schedules.
      await this.workspaces.archiveSession(record.childId);
      return this.save({ ...record, state: 'archived', error: null, activity: [] });
    } catch (error) {
      const code = error?.code ?? error?.rpcError?.code;
      const pending = code === 'workspace/session-active' || error?.name === 'WorkspaceActiveSessionError';
      return this.save({
        ...record,
        state: pending ? 'pending' : 'error',
        activity: pending ? (error.activity ?? error.details?.activity ?? []).map((item) => ({ family: item.family, label: item.label ?? '' })) : [],
        error: pending ? null : String(error?.message ?? error),
      });
    }
  }

  run(input) {
    return this.serial(async () => {
      const { action, childId, parentId } = input ?? {};
      if (action === 'list') {
        return { items: [...this.records.values()].filter((item) => !parentId || item.parentId === parentId).map((item) => this.view(item)) };
      }
      if (!['open', 'close', 'forget'].includes(action) || typeof childId !== 'string' || !childId.startsWith('session-')) {
        throw new Error('Expected open, close or forget and a child Session id');
      }
      const known = this.records.get(childId);
      const parent = parentId ?? known?.parentId ?? this.parentOf(childId);
      if (typeof parent !== 'string' || !parent.startsWith('session-') || parent === childId) throw new Error('A parent Session is required');
      const encodedParent = this.parentOf(childId);
      if (encodedParent !== undefined && encodedParent !== parent) throw new Error('Sidebar parent does not match');
      if (known !== undefined && known.parentId !== parent) throw new Error('Sidebar already belongs to another Session');
      if (action === 'forget') {
        // Removing the shortcut must leave the ordinary Session accessible.
        await this.workspaces.unarchiveSession(childId);
        await this.unit.deleteRecord('questions', Buffer.from(childId).toString('base64url'));
        this.records.delete(childId);
        return { childId, parentId: parent, state: 'forgotten', archived: false };
      }
      const record = {
        childId, parentId: parent,
        label: typeof input.label === 'string' ? input.label.slice(0, 200) : known?.label ?? '',
        closed: action === 'close',
        state: action === 'close' ? 'pending' : 'open',
        error: null,
      };
      if (action === 'open') {
        // Cancel a saved close before lifting the gate, including after restart.
        await this.save(record);
        await this.workspaces.unarchiveSession(childId);
        return this.view(record);
      }
      await this.save(record);
      return this.view(await this.archive(record));
    });
  }

  retry() {
    return this.serial(async () => {
      for (const record of this.records.values()) {
        if (record.closed === true && record.state === 'pending') await this.archive(record);
      }
    });
  }

  async dispose() {
    this.disposed = true;
    await this.tail;
    await this.unit.close();
  }
}

/** Connection owns authentication; this handler never opens an Agent or appends commands. */
export function questionRequestHandler(archive) {
  const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  return async (request) => {
    let input;
    try {
      if (request.signal.aborted) throw new Error('Question operation cancelled');
      const text = await request.text();
      if (text.length > 16384) throw new Error('Question request is too large');
      input = JSON.parse(text);
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || !['list', 'open', 'close', 'forget'].includes(input.action)
        || Object.keys(input).some((key) => !['action', 'parentId', 'childId', 'label'].includes(key))
        || ['parentId', 'childId', 'label'].some((key) => input[key] !== undefined && typeof input[key] !== 'string')
        || (input.action !== 'list' && !input.childId)) {
        throw new Error('Invalid sidebar question request');
      }
      if (request.signal.aborted) throw new Error('Question operation cancelled');
    } catch (error) {
      return json({ ok: false, error: { message: String(error?.message ?? error) } }, 400);
    }
    try {
      return json({ ok: true, value: await archive.run(input) });
    } catch (error) {
      return json({ ok: false, error: { message: String(error?.message ?? error) } }, 500);
    }
  };
}

export const archiveInput = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['list', 'open', 'close', 'forget'] },
    childId: { type: 'string', description: 'Question Session id; required except for list.' },
    parentId: { type: 'string', description: 'Main Session id. Filters list; required for a legacy question not registered yet.' },
    label: { type: 'string', description: 'Optional question label when opening or closing.' },
  },
  required: ['action'],
};
