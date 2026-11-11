/** Sidebar-only model choices. No operation here saves agentDefaultModel. */
export class SidebarModels {
  constructor(ctx, config, parentOf) {
    this.ctx = ctx;
    this.config = config;
    this.parentOf = parentOf;
    this.pending = new Map();
    this.disposed = false;
  }

  settings() {
    const entry = this.ctx.fiber.entry;
    const descriptor = this.ctx.get('settings')?.describe().find((item) => item.ns === entry?.options.id);
    return {
      defaults: structuredClone(this.config.modelDefaults.get()),
      revision: descriptor?.revision,
      writable: Boolean(entry && this.ctx.get('configEditor') && descriptor),
    };
  }

  async validate(selection) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)
      || Object.keys(selection).some((key) => !['provider', 'model', 'reasoningEffort'].includes(key))
      || ![selection.provider, selection.model].every((value) => typeof value === 'string' && value.length > 0)
      || (selection.reasoningEffort !== undefined && (typeof selection.reasoningEffort !== 'string' || !selection.reasoningEffort))) {
      throw new Error('Expected a provider, model, and optional reasoning effort');
    }
    const { provider, model, reasoningEffort } = selection;
    if (!this.ctx.llm.listProviders().some((item) => item.id === provider)
      || !(await this.ctx.llm.listModels(provider)).some((item) => item.id === model)) {
      throw new Error(`Model is currently unavailable: ${provider}/${model}`);
    }
    const info = await this.ctx.llm.resolveModelInfo(provider, model);
    if (reasoningEffort !== undefined && !info.reasoning?.efforts.some((effort) => effort.id === reasoningEffort)) {
      throw new Error(`Reasoning effort is unavailable for ${provider}/${model}: ${reasoningEffort}`);
    }
    const selected = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
    await this.ctx.llm.resolveCallConfig(selected);
    return selected;
  }

  async configure(defaults, expectedRevision) {
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)
      || !['dsh', 'parent', 'fixed'].includes(defaults.mode)
      || Object.keys(defaults).some((key) => !['mode', 'fixed'].includes(key))) throw new Error('Invalid sidebar model defaults');
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw new Error('Invalid settings revision');
    // Keep one complete volatile field so readers never observe half a route.
    const fixed = defaults.mode === 'fixed' ? await this.validate(defaults.fixed) : undefined;
    const current = this.settings();
    if (!current.writable) throw new Error('Sidebar model settings are read-only in this profile');
    await this.ctx.settings.mutate(this.ctx.fiber.entry.options.id, [{
      op: 'set', path: ['modelDefaults'], value: { mode: defaults.mode, ...(fixed === undefined ? {} : { fixed }) },
    }], expectedRevision);
    return this.settings();
  }

  async resolve(sessionId) {
    const resolved = await this.ctx.sessionController.resolveAgent(sessionId);
    if (resolved.error) throw resolved.error;
    return resolved.agent;
  }

  /** The awaited creation listener runs before the new Session can accept input. */
  async initialize({ agent, source, signal }) {
    const parentId = this.parentOf(agent.id);
    if (!parentId || source !== 'startup' || agent.session.header.isSeeded || agent.session.firstLiveSeq !== 0) return;
    const recorded = this.ctx.sessionProjections.snapshot(agent.session, ['modelSelection']).values.modelSelection;
    if (recorded?.next || recorded?.lastUsed) return;
    const defaults = structuredClone(this.config.modelDefaults.get());
    if (defaults.mode === 'dsh') return;
    const requested = defaults.mode === 'parent' ? (await this.resolve(parentId)).model.current() : defaults.fixed;
    const selected = await this.validate(requested);
    if (signal?.aborted) throw new Error('Sidebar creation cancelled');
    agent.model.select(selected);
  }

  /** Only managed sidebar identities are accepted; serialize independent UI/tool callers. */
  select(sessionId, selection) {
    if (this.disposed) return Promise.reject(new Error('Sidebar models are unavailable'));
    if (!this.parentOf(sessionId)) return Promise.reject(new Error('Model isolation only applies to sidebar Sessions'));
    const previous = this.pending.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const selected = await this.validate(selection);
      const agent = await this.resolve(sessionId);
      // Validation has finished; record synchronously without changing global defaults.
      agent.model.select(selected);
      return { selected: { ...selected } };
    });
    this.pending.set(sessionId, operation);
    void operation.finally(() => { if (this.pending.get(sessionId) === operation) this.pending.delete(sessionId); }).catch(() => {});
    return operation;
  }

  async run(input) {
    switch (input?.action) {
      case 'catalog': return this.ctx.sessionController.modelCatalog();
      case 'settings': return this.settings();
      case 'configure': return this.configure(input.defaults, input.expectedRevision);
      case 'select': return this.select(input.sessionId, input.selection);
      default: throw new Error('Unknown sidebar model operation');
    }
  }

  async dispose() { this.disposed = true; await Promise.allSettled([...this.pending.values()]); }
}

const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

/** Exact Connection Fetch routes are owner-only and authenticated by DSH. */
export function modelRequestHandler(models) {
  return async (request) => {
    let input;
    try {
      const text = await request.text();
      if (text.length > 16384 || request.signal.aborted) throw new Error('Invalid sidebar model request');
      input = JSON.parse(text);
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['action', 'sessionId', 'selection', 'defaults', 'expectedRevision'].includes(key))) throw new Error('Invalid sidebar model request');
    } catch (error) { return json({ ok: false, error: { message: String(error.message ?? error) } }, 400); }
    try { return json({ ok: true, value: await models.run(input) }); }
    catch (error) { return json({ ok: false, error: { message: String(error.message ?? error) } }, 400); }
  };
}

/** Preserve the native RPC envelope and delegate ordinary Sessions through the Gateway. */
export function nativeModelRequestHandler(models, gateway, peer, parentOf) {
  return async (request) => {
    let rpcId = 'sidebar-model-invalid';
    try {
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return new Response('content type must be application/json', { status: 415 });
      const message = await request.json();
      if (typeof message?.rpcId === 'string') rpcId = message.rpcId;
      if (!message || message.type !== 'client-request' || message.method !== 'session/selectModel'
        || typeof message.rpcId !== 'string' || !message.payload?.args?.request
        || Object.keys(message.payload).some((key) => key !== 'args')
        || Object.keys(message.payload.args).some((key) => key !== 'request')) throw new Error('Invalid model RPC request');
      if (request.signal.aborted) throw new Error('Model selection cancelled');
      const input = message.payload.args.request;
      let value;
      if (parentOf(input.sessionId)) {
        if (Object.keys(input).some((key) => !['sessionId', 'provider', 'model', 'reasoningEffort'].includes(key))) throw new Error('Invalid model selection');
        const { sessionId, ...selection } = input;
        value = await models.select(sessionId, selection);
      } else {
        value = await gateway.invoke({ namespace: 'session', method: 'selectModel', args: message.payload.args, peer, signal: request.signal });
      }
      return json({ type: 'server-response', rpcId, result: { ok: true, value } });
    } catch (error) {
      return json({ type: 'server-response', rpcId, result: { ok: false, error: {
        code: error.code ?? 'session/model-unavailable', message: String(error.message ?? error), details: error.details ?? {},
      } } });
    }
  };
}

export const modelInput = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['catalog', 'settings', 'configure', 'select'] },
    sessionId: { type: 'string', description: 'Sidebar Session id; required for select.' },
    selection: { ...selectionSchema(), description: 'Model and optional reasoning effort for select.' },
    defaults: { type: 'object', additionalProperties: false, properties: {
      mode: { type: 'string', enum: ['dsh', 'parent', 'fixed'] },
      fixed: selectionSchema(),
    }, required: ['mode'], description: 'Defaults for configure; fixed requires a model. Applies only to new sidebars.' },
    expectedRevision: { type: 'integer', minimum: 0, description: 'Revision from settings; use when configuring to detect concurrent changes.' },
  }, required: ['action'],
};
function selectionSchema() {
  return { type: 'object', additionalProperties: false, properties: {
    provider: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 }, reasoningEffort: { type: 'string', minLength: 1 },
  }, required: ['provider', 'model'] };
}
