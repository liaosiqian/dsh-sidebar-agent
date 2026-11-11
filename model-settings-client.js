/** Model settings UI, bundled into the plain client artifact by build-client.mjs. */
const MODELS_NS = 'sidebarAgent.models';
const modelText = {
  zh: {
    title: '侧边栏 Agent', description: '为新建侧边栏选择默认模型和思考程度。已有侧边栏保留自己的选择。',
    policy: '默认模型策略', dsh: '跟随 DSH 默认', parent: '继承主会话', fixed: '固定模型',
    dshHelp: '未指定模型的侧边栏跟随 DSH 默认值，直到手动选择模型或发起首次请求。',
    parentHelp: '创建时复制主会话当前模型和思考程度，之后各自独立。',
    fixedHelp: '只用于之后新建的侧边栏；不会修改 DSH 的默认模型。',
    model: '模型', effort: '思考程度', defaultEffort: '使用模型默认值', choose: '请选择模型',
    save: '保存', saving: '保存中…', saved: '已保存，仅影响新建侧边栏', discard: '放弃修改', refresh: '刷新模型列表', loading: '正在加载…',
    unavailable: '当前不可用', noModels: '当前没有可用模型，请先在「模型」设置中配置提供方。',
    partial: '部分提供方加载失败；已保存的选择会保留。', readOnly: '当前配置为只读。',
    isolation: '侧边栏的原生模型菜单和 /model 只修改当前侧边栏，模型与思考程度都不会更新 DSH 全局默认。',
    conflict: '设置已在其他位置更新。请放弃修改并重新选择。', failed: '保存失败，修改已保留。',
  },
  en: {
    title: 'Sidebar Agent', description: 'Choose a model and reasoning effort for new sidebars. Existing sidebars keep their own selection.',
    policy: 'Default model policy', dsh: 'Follow DSH default', parent: 'Inherit main session', fixed: 'Fixed model',
    dshHelp: 'Sidebars without a recorded choice follow the DSH default until a model is selected or their first request starts.',
    parentHelp: 'Copy the main session model and reasoning effort on creation; later choices are independent.',
    fixedHelp: 'Applies to new sidebars only and leaves the DSH default unchanged.',
    model: 'Model', effort: 'Reasoning effort', defaultEffort: 'Use model default', choose: 'Choose a model',
    save: 'Save', saving: 'Saving…', saved: 'Saved for new sidebars', discard: 'Discard changes', refresh: 'Refresh models', loading: 'Loading…',
    unavailable: 'Currently unavailable', noModels: 'No models are available. Configure a provider in Models settings first.',
    partial: 'Some providers could not load. Saved choices are retained.', readOnly: 'This profile stores settings read-only.',
    isolation: 'The native model menu and /model change only the current sidebar. Model and reasoning choices leave the DSH global default unchanged.',
    conflict: 'Settings changed elsewhere. Discard this draft and choose again.', failed: 'Could not save. Your changes are retained.',
  },
};
async function modelOperation(input) {
  const response = await fetch(new URL('api/sidebar-agent/models', document.baseURI), {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Sidebar model settings unavailable (HTTP ${response.status})`); }
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? 'Sidebar model operation failed');
  return result.value;
}

function createModelSettingsController(call = modelOperation) {
  const listeners = new Set();
  let state = { status: 'loading', catalog: null, defaults: null, draft: null, revision: undefined, writable: false, busy: false, dirty: false, error: null, saved: false };
  let generation = 0;
  let disposed = false;
  const update = (patch) => { if (disposed) return; state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async load() {
      if (disposed || state.busy) return;
      const current = ++generation;
      update({ status: state.defaults ? 'ready' : 'loading', error: null });
      try {
        const [settings, catalog] = await Promise.all([call({ action: 'settings' }), call({ action: 'catalog' })]);
        if (current !== generation || disposed) return;
        // A refresh never replaces an in-progress edit or its revision fence.
        update({ status: 'ready', catalog, defaults: settings.defaults, writable: settings.writable,
          ...(state.dirty || state.busy ? {} : { draft: settings.defaults, revision: settings.revision }) });
      } catch (error) { if (current === generation) update({ status: state.defaults ? 'ready' : 'error', error: String(error.message ?? error) }); }
    },
    edit(patch) {
      if (state.busy || !state.writable || !state.draft) return;
      update({ draft: { ...state.draft, ...patch }, dirty: true, saved: false, error: null });
    },
    route(key) {
      let route;
      for (const group of state.catalog?.groups ?? []) for (const model of group.models) {
        if (JSON.stringify([group.id, model.id]) === key) route = { provider: group.id, model: model.id };
      }
      if (route) this.edit({ fixed: route }); // A new model starts at its own default effort.
    },
    effort(value) {
      if (!state.draft?.fixed) return;
      const { reasoningEffort: _previous, ...route } = state.draft.fixed;
      this.edit({ fixed: { ...route, ...(value ? { reasoningEffort: value } : {}) } });
    },
    discard() { if (state.busy) return; update({ dirty: false, draft: state.defaults, saved: false, error: null }); void this.load(); },
    async save() {
      if (disposed || state.busy || !state.writable || !state.draft || !state.dirty) return;
      const draft = state.draft;
      generation += 1; // A pre-save refresh must never overwrite the accepted write.
      update({ busy: true, error: null, saved: false });
      try {
        const settings = await call({ action: 'configure', defaults: draft, expectedRevision: state.revision });
        update({ defaults: settings.defaults, draft: settings.defaults, revision: settings.revision, writable: settings.writable, dirty: false, saved: true });
      } catch (error) { update({ error: String(error.message ?? error) }); }
      finally { update({ busy: false }); }
    },
    dispose() { disposed = true; generation += 1; listeners.clear(); },
  };
}

let modelSettings;
function SidebarAgentModelSettings() {
  const t = useModelText();
  const state = React.useSyncExternalStore(modelSettings.subscribe, modelSettings.getSnapshot);
  React.useEffect(() => { void modelSettings.load(); }, []);
  const draft = state.draft;
  const fixed = draft?.fixed;
  const groups = state.catalog?.groups ?? [];
  const chosen = groups.find((group) => group.id === fixed?.provider)?.models.find((model) => model.id === fixed?.model);
  const route = fixed ? JSON.stringify([fixed.provider, fixed.model]) : '';
  const disabled = !state.writable || state.busy;
  return React.createElement('section', { className: 'dsh-sa-model-settings', 'data-sidebar-agent-model-settings': '' },
    React.createElement('h2', null, t('title')),
    React.createElement('p', null, t('description')),
    state.status === 'loading' ? React.createElement('p', { role: 'status' }, t('loading')) : null,
    state.error ? React.createElement('p', { className: 'dsh-sa-model-error', role: 'alert' }, `${t('failed')} ${state.error}`) : null,
    state.status === 'ready' && !state.writable ? React.createElement('p', null, t('readOnly')) : null,
    draft ? React.createElement(React.Fragment, null,
      React.createElement('label', { className: 'dsh-sa-model-field' }, t('policy'),
        React.createElement('select', { value: draft.mode, disabled, onChange: (event) => modelSettings.edit({ mode: event.target.value }) },
          ...['dsh', 'parent', 'fixed'].map((mode) => React.createElement('option', { key: mode, value: mode }, t(mode))))),
      React.createElement('p', null, t(`${draft.mode}Help`)),
      draft.mode === 'fixed' ? React.createElement(React.Fragment, null,
        React.createElement('label', { className: 'dsh-sa-model-field' }, t('model'),
          React.createElement('select', { value: route, disabled, onChange: (event) => modelSettings.route(event.target.value) },
            React.createElement('option', { value: '', disabled: true }, t('choose')),
            fixed && !chosen ? React.createElement('option', { value: route, disabled: true }, `${fixed.provider} / ${fixed.model} · ${t('unavailable')}`) : null,
            ...groups.map((group) => React.createElement('optgroup', { key: group.id, label: displayModelText(group.name) },
              ...group.models.map((model) => React.createElement('option', { key: model.id, value: JSON.stringify([group.id, model.id]) }, displayModelText(model.name))))))),
        chosen?.reasoning?.efforts?.length ? React.createElement('label', { className: 'dsh-sa-model-field' }, t('effort'),
          React.createElement('select', { value: fixed.reasoningEffort ?? '', disabled, onChange: (event) => modelSettings.effort(event.target.value) },
            React.createElement('option', { value: '' }, t('defaultEffort')),
            fixed.reasoningEffort && !chosen.reasoning.efforts.some((item) => item.id === fixed.reasoningEffort)
              ? React.createElement('option', { value: fixed.reasoningEffort, disabled: true }, `${fixed.reasoningEffort} · ${t('unavailable')}`) : null,
            ...chosen.reasoning.efforts.map((effort) => React.createElement('option', { key: effort.id, value: effort.id }, displayModelText(effort.name))))) : null,
        groups.length === 0 ? React.createElement('p', null, t('noModels')) : null,
        state.catalog?.failures?.length ? React.createElement('p', { role: 'status' }, t('partial')) : null,
      ) : null,
      React.createElement('div', { className: 'dsh-sa-model-actions' },
        React.createElement('button', { type: 'button', className: 'dsh-sa-btn', disabled: disabled || !state.dirty || (draft.mode === 'fixed' && !chosen), onClick: () => void modelSettings.save() }, t(state.busy ? 'saving' : 'save')),
        React.createElement('button', { type: 'button', className: 'dsh-sa-btn', disabled: state.busy || !state.dirty, onClick: () => modelSettings.discard() }, t('discard')))) : null,
    React.createElement('button', { type: 'button', className: 'dsh-sa-btn', disabled: state.busy, onClick: () => void modelSettings.load() }, t('refresh')),
    state.saved ? React.createElement('p', { role: 'status' }, t('saved')) : null,
    React.createElement('p', null, t('isolation')));
}
function displayModelText(value) {
  if (typeof value === 'string') return value;
  const locale = ctx.locale.getSnapshot().id;
  return value?.[locale] ?? value?.en ?? value?.zh ?? '';
}
function useModelText() {
  React.useSyncExternalStore((listener) => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot());
  return ctx.locale.bind(MODELS_NS);
}
function startModelSettings(context) {
  modelSettings = createModelSettingsController();
  context.effect(() => context.locale.register(MODELS_NS, modelText), 'sidebar-agent: model settings language');
  context.effect(() => () => modelSettings.dispose(), 'sidebar-agent: model settings store');
  return context.slots.inject('settings.section', () => context.slots.register({
    name: 'settings.section', id: 'sidebar-agent', order: 25, label: () => context.locale.bind(MODELS_NS)('title'),
  }, SidebarAgentModelSettings));
}
