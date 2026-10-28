(function () {
/**
 * Sidebar Agent — an independent normal Session shown in a right-Sidebar tab.
 *
 * Why a normal Session instead of a subagent:
 * - The built-in subagent manager disposes a local activation when it settles.
 *   A later follow-up cold-resumes it with `delivery: 'parent'`, which posts a
 *   `subagent-settled` message into the main conversation. That is exactly the
 *   pollution this plugin must avoid.
 * - A normal Session keeps the full Session Controller API surface, so the
 *   shared embedded Conversation body gives us the real composer: model
 *   selection, permissions, plan, attachments, stop, queue/steer, tool calls.
 * - It has no parent Agent, so the Host never appends settlement notices to the
 *   main Session and never runs an extra main-model turn.
 *
 * The tradeoff is that the child is a real Session: after its first turn it can
 * appear in the Session list (ungrouped). The parent association is encoded in
 * the child id and decoded by the Host half; the client-side registry only owns
 * tabs and history entries, not the conversation relationship.
 */

let React;
let ctx;

const PLUGIN_ID = '@local/dsh-sidebar-agent';
const KIND = 'sidebaragent';
const THREADS_PREFIX = 'dsh.sidebar-agent.v1:';
const CHILD_PREFIX = 'dsh.sidebar-agent.child.v1:';
const TAB_PREFIX = 'dsh.sidebar-agent.tab.v1:';
const STYLE_ATTR = 'data-dsh-sidebar-agent-style';
const EMPTY_OPEN_TABS = [];
const SELECTION_MAX_CHARS = 4000;

const CSS = `
.dsh-sa-root{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.dsh-sa-root>*{min-height:0;flex:1 1 auto}
.dsh-sa-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sa-pane-bar{box-sizing:border-box;display:flex;align-items:center;justify-content:flex-end;gap:4px;min-height:27px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dsh-sa-root>.dsh-sa-pane-bar{flex:0 0 auto}
.dsh-sa-btn{box-sizing:border-box;border:0;background:0 0;font:inherit;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:var(--dsw-radius-sm);white-space:nowrap;display:inline-flex;align-items:center;padding:3px 6px;font-size:12px;line-height:18px;gap:3px}
.dsh-sa-quote-short{display:none}
.dsh-sa-history-text{display:inline}
.dsh-sa-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-sa-btn:disabled{opacity:.45;cursor:default}
.dsh-sa-notice{height:100%;display:flex;align-items:center;justify-content:center;padding:24px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;text-align:center}
.dsh-sa-error{color:var(--dsw-alias-state-error-primary)}
.dsh-sa-intro{flex:0 0 auto;box-sizing:border-box;display:flex;align-items:baseline;gap:6px;padding:7px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-intro-name{flex:none;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dsh-sa-intro-hint{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sa-history{position:relative;display:inline-flex;align-items:center}
.dsh-sa-history-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:3px;border:1px solid var(--dsw-alias-border-l2);background:0 0;font:inherit;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap}
.dsh-sa-history-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-sa-history-pop{position:absolute;bottom:calc(100% + 6px);right:0;z-index:80;box-sizing:border-box;width:270px;max-height:320px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 28px rgba(0,0,0,.22),0 1px 3px rgba(0,0,0,.12);isolation:isolate}
.dsh-sa-history-pop-left{left:0;right:auto}
.dsh-sa-history-pop-down{top:calc(100% + 6px);bottom:auto}
.dsh-sa-history-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:5px 7px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-weight:600}
.dsh-sa-history-count{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-history-empty{padding:8px 7px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-history-row{box-sizing:border-box;width:100%;display:flex;align-items:stretch;gap:1px;border-radius:6px;padding:0}
.dsh-sa-history-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sa-history-main{box-sizing:border-box;min-width:0;display:flex;align-items:center;gap:8px;flex:1 1 auto;border:0;background:0 0;font:inherit;color:var(--dsw-alias-label-primary);padding:5px 4px 5px 7px;cursor:pointer;text-align:left;border-radius:6px 0 0 6px}
.dsh-sa-history-copy{min-width:0;display:flex;flex-direction:column;gap:1px;flex:1 1 auto}
.dsh-sa-history-remove{box-sizing:border-box;flex:none;width:22px;border:0;background:0 0;font:inherit;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;padding:0;cursor:pointer;border-radius:0 6px 6px 0;opacity:.35}
.dsh-sa-history-row:hover .dsh-sa-history-remove{opacity:1}
.dsh-sa-history-remove:hover{background:var(--dsw-alias-state-error-secondary,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-state-error-primary)}
.dsh-sa-history-confirm{box-sizing:border-box;width:100%;display:flex;align-items:center;gap:5px;padding:5px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}
.dsh-sa-history-confirm-text{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sa-history-confirm-yes,.dsh-sa-history-confirm-no{flex:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:10px;line-height:15px;border-radius:4px;padding:1px 5px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dsh-sa-history-confirm-yes{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-sa-history-confirm-yes:hover,.dsh-sa-history-confirm-no:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sa-history-label{font-size:12px;line-height:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sa-history-title{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-sa-history-state{flex:none;font-size:10px;line-height:15px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsh-sa-quote{position:relative;display:inline-flex;align-items:center}
.dsh-sa-quote-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:3px;border:1px solid var(--dsw-alias-border-l2);background:0 0;font:inherit;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 7px;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap}
.dsh-sa-quote-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-sa-quote-pop{position:absolute;bottom:calc(100% + 6px);right:0;z-index:81;box-sizing:border-box;width:min(320px,calc(100vw - 24px));max-height:min(420px,calc(100vh - 120px));overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 28px rgba(0,0,0,.22),0 1px 3px rgba(0,0,0,.12);isolation:isolate}
.dsh-sa-quote-pop-down{top:calc(100% + 6px);bottom:auto}
.dsh-sa-quote-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:4px 4px 4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-weight:600}
.dsh-sa-quote-purpose{padding:0 4px 7px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-count{font-weight:400;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-target{display:flex;flex-direction:column;gap:4px;padding:2px 4px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-target-hint{padding:0 4px 6px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-select{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;line-height:16px;padding:3px 5px}
.dsh-sa-quote-toggle{display:flex;align-items:flex-start;gap:5px;padding:0 4px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);cursor:pointer}
.dsh-sa-quote-toggle input{margin:1px 0 0;flex:none}
.dsh-sa-quote-scope{padding:0 4px 6px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-list{display:flex;flex-direction:column;gap:2px}
.dsh-sa-quote-row{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:2px;border:0;background:0 0;font:inherit;color:var(--dsw-alias-label-primary);text-align:left;border-radius:6px;padding:6px 7px;cursor:pointer}
.dsh-sa-quote-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sa-quote-row:disabled{opacity:.55;cursor:default}
.dsh-sa-quote-meta{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-text{font-size:11px;line-height:16px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;word-break:break-word}
.dsh-sa-quote-empty{padding:8px 7px 10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-foot{padding:6px 4px 2px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-error{padding:2px 4px 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);word-break:break-word}
.dsh-sa-quote-summary{box-sizing:border-box;width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;padding:7px 8px;margin:2px 0 4px;cursor:pointer}
.dsh-sa-quote-summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sa-quote-summary:disabled{opacity:.55;cursor:default}
.dsh-sa-quote-summary-title{display:flex;align-items:center;gap:5px;font-size:11px;line-height:16px;font-weight:600}
.dsh-sa-quote-summary-desc{font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-loading{padding:2px 7px 6px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-divider{display:flex;align-items:center;gap:6px;padding:4px 4px 5px;font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary)}
.dsh-sa-quote-divider::before,.dsh-sa-quote-divider::after{content:'';height:1px;flex:1 1 auto;background:var(--dsw-alias-border-l2)}
.dsh-sa-sel-toolbar{position:fixed;z-index:1200;display:flex;align-items:center;gap:2px;padding:4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-panel);backdrop-filter:var(--dsw-menu-backdrop-filter);transform:translateX(-50%);font-family:var(--dsw-font-family)}
.dsh-sa-sel-btn{border:0;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:20px;padding:2px 8px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}
.dsh-sa-sel-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-sa-sel-btn-primary{color:var(--dsw-alias-state-business-primary);font-weight:500}
.dsh-sa-sel-sep{width:.5px;height:16px;background:var(--dsw-alias-border-l2);margin:0 2px}
.dsh-sa-sel-toast{position:fixed;z-index:1201;left:50%;bottom:24px;transform:translateX(-50%);padding:6px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:normal;max-width:min(560px,80vw);text-align:center}
@media (max-width:560px){
  .dsh-sa-pane-bar{padding-left:6px;padding-right:6px}
  .dsh-sa-quote-btn,.dsh-sa-history-btn{padding:1px 5px}
  .dsh-sa-quote-long{display:none}
  .dsh-sa-quote-short{display:inline}
  .dsh-sa-history-text{display:none}
}
`;

const zh = {
  create: '侧边栏',
  createTitle: '新建侧边栏 Agent',
  confirmNewSidebar: '当前主会话已有 {count} 个侧边栏对话，仍要新增吗？',
  fallbackTitle: '侧边栏 Agent',
  fallbackChip: '侧边栏',
  connecting: '正在连接侧边栏 Agent…',
  missing: '这个侧边栏 Agent 找不到对应的会话。',
  failed: '侧边栏 Agent 打开失败',
  independent: '独立会话，不会写入主会话',
  removeTitle: '移除入口（会话仍保留在列表中）',
  closeTitle: '关闭标签，可在侧边栏历史里恢复',
  history: '历史',
  historyTitle: '侧边栏历史',
  historyEmpty: '还没有侧边栏历史',
  historyClosed: '已关闭',
  historyOpen: '在侧边栏',
  running: '运行中',
  historyRemove: '从历史移除（不删除子会话）',
  historyRemoveConfirm: '移除这条历史入口？',
  historyRemoveYes: '移除',
  historyRemoveNo: '取消',
  quote: '引用主会话',
  quoteShort: '引',
  quoteTitle: '把主会话上下文引用到侧边栏追问',
  quoteHeader: '引用主会话上下文',
  quotePurpose: '把主会话的提问、回答或整段摘要复制到侧边栏；只插入草稿，不会写入主会话，也不会自动发送。',
  quoteEmpty: '主会话里还没有可引用的提问',
  quoteSummary: '引用主会话总结',
  quoteSummaryDesc: '整理目标、最近几轮问答、工具动作和压缩摘要，适合让侧边栏接手当前工作。',
  quoteSummaryEmpty: '暂无可总结的主会话内容',
  quoteSummaryLoading: '正在读取主会话事件并整理摘要…',
  quoteDivider: '或引用某一条提问',
  quoteTarget: '引用到',
  quoteNew: '+ 新建侧边栏',
  quoteOpen: '已打开',
  quoteWillCreate: '将新建一个侧边栏',
  quoteWillAppendOpen: '将追加到已打开的侧边栏',
  quoteWillAppend: '将追加到已有侧边栏',
  quoteWillRestore: '将重新打开并追加到该侧边栏',
  quoteContext: '带上该轮回答和会话简报',
  quoteHint: '只插入草稿，不会自动发送；可在输入框继续编辑',
  quoteModeLabel: '引用范围',
  quoteModeFull: '问题 + 完整回答 + 上下文',
  quoteModeAnswer: '问题 + 完整回答',
  quoteModeQuestion: '仅问题',
  quoteScopeFull: '将插入：整条提问 + 完整回答 + 相邻上下文 + 主会话脉络',
  quoteScopeAnswer: '将插入：整条提问 + 完整回答',
  quoteScopeQuestion: '将插入：仅整条提问',
  quoteReading: '正在读取主会话上下文…',
  quoteLoaded: '已读取最近 {turns} 轮主会话',
  quoteLoadedMore: '已读取最近 {turns} 轮；更早历史未加载',
  quoteFailed: '插入失败',
  selectionFromAssistant: '助手',
  selectionFromUser: '我的消息',
  selectionFromSteering: '补充消息',
  selectionIntro: '以下内容是我从主会话中选中的原文，只作为这次侧边栏追问的引用上下文，不是本侧边栏已发送的消息。',
  selectionHeading: '主会话选中内容',
  selectionTruncated: '选区已截断',
  selectionSource: '引用来源',
  selectionFollowup: '我的追问：',
  selectionCreatePending: '侧边栏正在创建，请稍后再试',
  selectCopy: '复制',
  selectQuote: '引用',
  selectAsk: '在侧边栏提问',
  selectToolbar: '选中文字操作',
  selectCopied: '已复制',
  selectCopyFailed: '复制失败，请检查浏览器剪贴板权限',
  selectInserted: '已插入输入框',
  selectInsertFailed: '输入框内容已变化，请重试',
  selectAskFailed: '侧边栏插入失败',
  selectCreated: '已新建侧边栏，选区已放入草稿',
  selectAppended: '选区已追加到侧边栏草稿',
  selectCancelled: '已取消新增侧边栏，选区仍在',
};

function storageGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A private window may reject storage; the tab still works, only the
    // parent-side shortcut list is lost.
  }
}

function storageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures; the in-memory tab close still happens.
  }
}

const subscribers = new Set();

function notifyThreads() {
  for (const listener of [...subscribers]) {
    try {
      listener();
    } catch (error) {
      console.error('[sidebar-agent] thread listener failed', error);
    }
  }
}

function subscribeThreads(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function readThreads(parentId) {
  const raw = storageGet(THREADS_PREFIX + parentId);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string');
  } catch {
    return [];
  }
}

function writeThreads(parentId, threads) {
  if (threads.length === 0) storageRemove(THREADS_PREFIX + parentId);
  else storageSet(THREADS_PREFIX + parentId, JSON.stringify(threads));
  notifyThreads();
}

function addThread(parentId, thread) {
  const threads = readThreads(parentId).filter((item) => item.id !== thread.id);
  threads.push(thread);
  writeThreads(parentId, threads);
  storageSet(CHILD_PREFIX + thread.id, parentId);
}

function updateThread(parentId, threadId, patch) {
  const threads = readThreads(parentId).map((thread) => {
    if (thread.id !== threadId) return thread;
    const next = { ...thread, ...patch };
    if (patch.hidden === false) delete next.closedAt;
    return next;
  });
  writeThreads(parentId, threads);
  return threads.find((thread) => thread.id === threadId);
}

function removeTabMaps(childId) {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (!key.startsWith(TAB_PREFIX)) continue;
      if (readTab(key.slice(TAB_PREFIX.length))?.childId === childId) storageRemove(key);
    }
  } catch {
    // Storage enumeration can fail in a locked-down window; the thread record
    // and child link are already gone, so the stale address is harmless.
  }
}

function restoreThread(parentId, thread) {
  const updated = updateThread(parentId, thread.id, { hidden: false });
  openThread(parentId, updated ?? thread);
  return updated;
}

function parentOf(childId) {
  return storageGet(CHILD_PREFIX + childId) ?? undefined;
}

/**
 * A page tab is opened with `navigation.params`, but a restored dock layout
 * keeps only the address. Remember the child behind that address so a refresh
 * can rebuild the tab body and its title.
 */
function rememberTab(contentId, record) {
  if (typeof contentId !== 'string' || contentId.length === 0) return;
  if (record === null || typeof record !== 'object' || typeof record.childId !== 'string') return;
  storageSet(TAB_PREFIX + contentId, JSON.stringify({
    childId: record.childId,
    parentId: typeof record.parentId === 'string' ? record.parentId : undefined,
    label: typeof record.label === 'string' ? record.label : undefined,
    updatedAt: new Date().toISOString(),
  }));
}

function readTab(contentId) {
  if (typeof contentId !== 'string' || contentId.length === 0) return null;
  const raw = storageGet(TAB_PREFIX + contentId);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && typeof parsed.childId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function tabRecord(tab) {
  const params = tab?.navigation?.params;
  if (params !== null && typeof params === 'object' && typeof params.childId === 'string') {
    return {
      childId: params.childId,
      parentId: typeof params.parentId === 'string' ? params.parentId : undefined,
      label: typeof params.label === 'string' ? params.label : undefined,
    };
  }
  return readTab(tab?.contentId);
}

let pendingOpen = null;

function nextLabel(parentId) {
  const threads = readThreads(parentId);
  let next = 1;
  for (const thread of threads) {
    if (Number.isInteger(thread.index) && thread.index >= next) next = thread.index + 1;
  }
  return { index: next, label: `侧边栏 ${next}` };
}

function encodeParentId(parentId) {
  try {
    return btoa(String(parentId))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch {
    return '';
  }
}

/**
 * Child ids carry an internal parent marker so the Host half can find the
 * main Session without adding a service, route, or durable event. The marker
 * is base64url so any Session id shape survives; the visible title never
 * contains it.
 */
function newSessionId(parentId) {
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const encoded = encodeParentId(parentId);
  return encoded.length > 0 ? `session-sb-${encoded}.${uuid}` : `session-${uuid}`;
}

function confirmNewSidebar(parentId) {
  const count = readThreads(parentId).length;
  if (count === 0 || typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(zh.confirmNewSidebar.replace('{count}', String(count)));
}

function useSessionList() {
  const store = ctx.sessions.list;
  return React.useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
  );
}

/** The localStorage history rows for one main Session, kept in sync. */
function useThreadList(parentId) {
  const [threads, setThreads] = React.useState(() => readThreads(parentId));

  React.useEffect(() => {
    const sync = () => setThreads(readThreads(parentId));
    sync();
    const unsubscribe = subscribeThreads(sync);
    const onStorage = (event) => {
      if (event.key === null || event.key === THREADS_PREFIX + parentId) sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, [parentId]);

  return threads;
}

/** Open tab membership across Sessions, used to avoid a duplicate history entry. */
function useOpenSidebarTabs() {
  const source = ctx.sidebarRight?.openTabs;
  const subscribe = React.useCallback(
    (listener) => (typeof source?.subscribe === 'function' ? source.subscribe(listener) : () => {}),
    [source],
  );
  const getSnapshot = React.useCallback(
    () => (typeof source?.getSnapshot === 'function' ? source.getSnapshot() : EMPTY_OPEN_TABS),
    [source],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot);
}

function matchesThread(tab, thread) {
  if (tab === null || typeof tab !== 'object' || tab.kind !== KIND) return false;
  return tab.navigation?.params?.childId === thread.id || readTab(tab.contentId)?.childId === thread.id;
}

function childIdForTab(tab) {
  const direct = tab?.navigation?.params?.childId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const stored = readTab(tab?.contentId);
  return typeof stored?.childId === 'string' ? stored.childId : undefined;
}

/**
 * The right-pane tabs are the source of truth for "open". `tabsIn` includes
 * inactive pages too; `active` is the tab the user is looking at. A chip can
 * exist without a tab (native tab close / refresh race), so deriving the quote
 * target from threads alone would incorrectly create a new sidebar.
 */
function sidebarQuoteState(parentId, threads) {
  const right = ctx.sidebarRight;
  let tabs = [];
  try {
    tabs = typeof right?.tabsIn === 'function' ? right.tabsIn(parentId) : [];
  } catch {
    tabs = [];
  }
  const openIds = [];
  for (const tab of tabs) {
    if (tab?.kind !== KIND) continue;
    const id = childIdForTab(tab);
    if (id !== undefined && !openIds.includes(id)) openIds.push(id);
  }
  let activeId;
  try {
    const active = typeof right?.active === 'function' ? right.active() : undefined;
    if (active?.kind === KIND) {
      const candidate = childIdForTab(active);
      if (candidate !== undefined && openIds.includes(candidate)) activeId = candidate;
    }
  } catch {
    activeId = undefined;
  }
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const visibleOpen = openIds
    .map((id) => byId.get(id))
    .filter((thread) => thread !== undefined)
    .sort((left, right) => (Number(left.index) || 0) - (Number(right.index) || 0));
  const targetId = (activeId !== undefined && byId.has(activeId))
    ? activeId
    : (visibleOpen.length > 0 ? visibleOpen[visibleOpen.length - 1].id : '__new__');
  return { activeId, openIds, targetId };
}

function openThread(parentId, thread) {
  const right = ctx.sidebarRight;
  if (right === undefined) {
    console.error('[sidebar-agent] sidebarRight is unavailable');
    return;
  }
  try {
    if (typeof right.isExpanded === 'function' && !right.isExpanded()) right.toggleExpanded();
    if (typeof right.tabsIn === 'function') {
      const opened = right.tabsIn(parentId).find((tab) => matchesThread(tab, thread));
      if (opened !== undefined) {
        rememberTab(opened.contentId, { childId: thread.id, parentId, label: thread.label });
        right.focus?.(opened.id);
        return;
      }
    }
    const active = typeof right.active === 'function' ? right.active() : undefined;
    if (matchesThread(active, thread)) {
      rememberTab(active.contentId, { childId: thread.id, parentId, label: thread.label });
      return;
    }
    const params = { childId: thread.id, parentId, label: thread.label };
    // `placeTab` calls the type's `title(address)` synchronously. That is the
    // only reliable moment the generated address is visible to this plugin, so
    // the title callback persists the address -> child mapping.
    pendingOpen = { childId: thread.id, parentId, label: thread.label };
    try {
      if (typeof right.openTabIn === 'function') {
        right.openTabIn(parentId, KIND, { params });
        return;
      }
      right.openTab(KIND, { params });
    } finally {
      pendingOpen = null;
    }
  } catch (error) {
    console.error('[sidebar-agent] could not open tab', error);
    throw error;
  }
}

/**
 * Remove only the sidebar entry, never the child Session. The child is a
 * normal Session and remains available in the Session list.
 */
function removeThread(parentId, thread) {
  const right = ctx.sidebarRight;
  const tabs = typeof right?.tabsIn === 'function' ? right.tabsIn(parentId) : [];
  const doomed = tabs.filter(
    (tab) => tab.kind === KIND && (tab.navigation?.params?.childId === thread.id || readTab(tab.contentId)?.childId === thread.id),
  );
  writeThreads(parentId, readThreads(parentId).filter((item) => item.id !== thread.id));
  storageRemove(CHILD_PREFIX + thread.id);
  for (const tab of doomed) {
    try {
      right.closeIn?.(parentId, tab.id);
    } catch (error) {
      console.error('[sidebar-agent] could not close removed tab', error);
    }
  }
  removeTabMaps(thread.id);
}

const creatingParents = new Set();

async function createThread(parentId, parent) {
  if (creatingParents.has(parentId)) return undefined;
  creatingParents.add(parentId);
  try {
    if (!confirmNewSidebar(parentId)) return null;
    const { index, label } = nextLabel(parentId);
    const id = newSessionId(parentId);
    const request = { sessionId: id };
    if (typeof parent.cwd === 'string' && parent.cwd.length > 0) request.cwd = parent.cwd;
    if (typeof parent.preset === 'string' && parent.preset.length > 0) request.agentPreset = parent.preset;
    await ctx.sessions.create(request);
    const thread = { id, label, index, createdAt: new Date().toISOString() };
    addThread(parentId, thread);
    notifyThreads();
    openThread(parentId, thread);
    return thread;
  } catch (error) {
    notifyThreads();
    throw error;
  } finally {
    creatingParents.delete(parentId);
  }
}


/**
 * Read the main Conversation's user questions from its rendered DOM. The
 * sidebar history only stores sidebar metadata; this is the complementary
 * "main-session history" that a follow-up can quote from. We intentionally
 * ignore anything inside a sidebar tab so a child can never quote itself.
 */
function mainChatRootFor(sessionId) {
  if (typeof document === 'undefined') return null;
  const roots = Array.from(document.querySelectorAll('[data-conversation-region="chat"]'))
    .filter((root) => root.closest('[data-sidebar-agent]') === null);
  return roots.find((root) => {
    const holder = root.closest('[data-conversation-session]');
    return holder !== null && holder.getAttribute('data-conversation-session') === sessionId;
  }) ?? roots[0] ?? null;
}

function nodeText(node) {
  const text = typeof node?.innerText === 'string' ? node.innerText : '';
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function clipText(text, limit) {
  const normalized = String(text ?? '').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}\n…（已截断）` : normalized;
}

/**
 * Extract model-visible prose from one message or content-block array. We
 * deliberately drop reasoning and tool payloads: a quote should carry the
 * conversation, not a replay of low-level execution details.
 */
function contentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim().length > 0) parts.push(block.trim());
      continue;
    }
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      if (block.text.trim().length > 0) parts.push(block.text.trim());
    }
  }
  return parts.join('\n').trim();
}

function messageText(message) {
  if (message === null || typeof message !== 'object') return '';
  return contentText(message.content);
}

function addTool(turn, name) {
  if (typeof name !== 'string' || name.length === 0) return;
  const existing = turn.tools.find((tool) => tool.name === name);
  if (existing === undefined) turn.tools.push({ name, count: 1 });
  else existing.count += 1;
}

/**
 * Build a readable, chronological transcript from the loaded Session event
 * window. This is the durable source of truth behind the DOM-based fallback:
 * it sees every loaded user/assistant/tool/compaction event, including
 * assistant prose that the chat DOM may split or virtualize.
 */
function transcriptFromEntries(entries) {
  const turns = [];
  const compaction = [];
  let current = null;
  let turnNumber = 0;
  let maxTurn = 0;
  let eventCount = 0;
  for (const entry of entries) {
    if (entry?.type !== 'event' || entry.event === null || typeof entry.event !== 'object') continue;
    const event = entry.event;
    eventCount += 1;
    if (event.type === 'turn/start') {
      turnNumber = Number(event.data?.turn) || turnNumber;
      maxTurn = Math.max(maxTurn, turnNumber);
      current = null;
      continue;
    }
    if (event.type === 'user/message') {
      // Synthetic injections, goal continuations and compaction replacements
      // are user-role events but not human questions. Only the human source
      // belongs in a quoted main-conversation brief.
      const sourceKind = event.data?.source?.kind;
      if (typeof sourceKind === 'string' && sourceKind !== 'user') continue;
      const text = messageText(event.data);
      if (text.length === 0) continue;
      if (current === null || current.user.length > 0) {
        current = { turn: turnNumber, user: '', answers: [], tools: [] };
        turns.push(current);
      }
      current.user = text;
      continue;
    }
    if (event.type === 'assistant/message') {
      const text = messageText(event.data?.message);
      if (text.length === 0) continue;
      if (current === null) {
        current = { turn: turnNumber, user: '', answers: [], tools: [] };
        turns.push(current);
      }
      if (!current.answers.includes(text)) current.answers.push(text);
      continue;
    }
    if (event.type === 'tool/call') {
      if (current !== null) addTool(current, event.data?.name);
      continue;
    }
    if (event.type === 'compaction/summary') {
      const summary = contentText(event.data?.summary);
      if (summary.length > 0) compaction.push({ turn: turnNumber, summary });
    }
  }
  return { turns, compaction, eventCount, maxTurn };
}

function mainTitleFor(sessionId) {
  try {
    const title = ctx.sessions.list.getSnapshot()?.byId?.[sessionId]?.title;
    return typeof title === 'string' ? title.trim() : '';
  } catch {
    return '';
  }
}

function contextFromDom(sessionId, parentTitle) {
  const rows = readMainQuestions(sessionId);
  const turns = rows
    .slice()
    .reverse()
    .map((row) => ({
      turn: row.turn,
      user: row.text,
      answers: row.answer.length > 0 ? [row.answer] : [],
      tools: [],
    }));
  return {
    source: 'dom',
    title: parentTitle,
    turns,
    questions: rows,
    compaction: [],
    eventCount: 0,
    maxTurn: turns.reduce((max, turn) => Math.max(max, Number(turn.turn) || 0), 0),
    hasMore: false,
    loaded: true,
  };
}

function questionsFromTurns(turns) {
  return turns
    .filter((turn) => turn.user.length > 0)
    .slice(-10)
    .reverse()
    .map((turn) => ({
      turn: turn.turn,
      text: clipText(turn.user, 5000),
      answer: clipText(turn.answers.join('\n\n'), 6000),
      answers: turn.answers,
      tools: turn.tools,
    }));
}

/**
 * Read the main Session's loaded event window, optionally paging one or two
 * older history pages for a richer summary. A missing/closed Session falls
 * back to the rendered DOM so the quote action still works while a session is
 * opening or reconnecting.
 */
async function readMainContext(sessionId, options = {}) {
  const parentTitle = mainTitleFor(sessionId);
  let reference;
  try {
    reference = ctx.sessions.retain(sessionId, { source: 'sidebarChat' });
    const ready = Promise.race([
      reference.ready.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1800)),
    ]);
    await ready;
    if (options.deep === true) {
      const source = reference.binding.eventSource;
      let window = source.getSnapshot();
      for (let page = 0; page < 2 && window.hasMore; page += 1) {
        try {
          await Promise.race([
            reference.binding.session.loadOlder().catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 1800)),
          ]);
        } catch {
          break;
        }
        const next = source.getSnapshot();
        if (next.entries.length === window.entries.length) break;
        window = next;
      }
    }
    const window = reference.binding.eventSource.getSnapshot();
    const parsed = transcriptFromEntries(window.entries);
    return {
      source: 'events',
      title: parentTitle,
      turns: parsed.turns,
      questions: questionsFromTurns(parsed.turns),
      compaction: parsed.compaction,
      eventCount: parsed.eventCount,
      maxTurn: parsed.maxTurn,
      hasMore: window.hasMore === true,
      loaded: true,
    };
  } catch {
    return contextFromDom(sessionId, parentTitle);
  } finally {
    reference?.release();
  }
}

function readMainQuestions(sessionId) {
  const root = mainChatRootFor(sessionId);
  if (root === null) return [];
  const seen = new Set();
  const rows = [];
  for (const node of root.querySelectorAll('[data-chat-flow-kind="user"]')) {
    if (node.closest('[data-sidebar-agent]') !== null) continue;
    const holder = node.closest('[data-chat-turn]') ?? node;
    const turn = Number(node.getAttribute('data-chat-turn') ?? holder.getAttribute('data-chat-turn') ?? 0);
    const contentNodes = Array.from(node.querySelectorAll('[data-slot="conversation.user.text.node"]'));
    const text = clipText(contentNodes.length > 0
      ? contentNodes.map((content) => nodeText(content)).filter(Boolean).join('\n')
      : nodeText(node), 5000);
    if (text.length === 0) continue;
    const key = `${turn}:${text.slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Assistant prose lives in `assistant-step[data-chat-group-part=response]`;
    // reasoning steps are hidden and must never enter the quote.
    const answerNodes = turn > 0
      ? root.querySelectorAll(`[data-chat-turn="${turn}"][data-chat-flow-kind="assistant-step"][data-chat-group-part="response"]`)
      : [];
    const answerParts = [];
    for (const answerNode of answerNodes) {
      if (answerNode.closest('[data-sidebar-agent]') !== null) continue;
      const answer = clipText(nodeText(answerNode), 3200);
      if (answer.length > 0 && !answerParts.includes(answer)) answerParts.push(answer);
    }
    rows.push({ turn, text, answer: clipText(answerParts.join('\n\n'), 3600) });
  }
  return rows.slice(-10).reverse();
}

function turnAnswer(question) {
  const answers = Array.isArray(question?.answers)
    ? question.answers.filter((answer) => typeof answer === 'string' && answer.trim().length > 0)
    : [];
  if (answers.length > 0) return answers.join('\n\n').trim();
  return String(question?.answer ?? '').trim();
}

function oneLine(text, limit = 240) {
  return clipText(String(text ?? '').replace(/\s+/g, ' '), limit);
}

function toolsLine(turn) {
  if (!Array.isArray(turn?.tools) || turn.tools.length === 0) return '';
  return turn.tools.map((tool) => `${tool.name}×${tool.count}`).join('、');
}

function appendTurnDigest(lines, turn, options = {}) {
  const questionLimit = options.questionLimit ?? 900;
  const answerLimit = options.answerLimit ?? 1100;
  const round = Number(turn.turn) > 0 ? `第 ${turn.turn} 轮` : '主会话';
  if (typeof turn.user === 'string' && turn.user.length > 0) {
    lines.push(`- ${round} 我：${clipText(turn.user, questionLimit)}`);
  }
  const answer = Array.isArray(turn.answers) ? turn.answers.join('\n\n').trim() : '';
  if (answer.length > 0) {
    lines.push(`  助手：${clipText(answer, answerLimit)}`);
  }
  const tools = toolsLine(turn);
  if (tools.length > 0) lines.push(`  工具：${tools}`);
}

function buildMainQuestionBlock(question, context, mode) {
  const lines = [
    '以下内容是我从主会话引用过来的上下文，只用于这次侧边栏追问，不是本侧边栏里已经发送的消息。',
    '',
  ];
  const round = Number(question.turn) > 0 ? `（第 ${question.turn} 轮）` : '';
  lines.push(`### 主会话提问${round}`);
  for (const line of String(question.text ?? '').split('\n')) lines.push(`> ${line}`);
  lines.push('');

  const answer = turnAnswer(question);
  if (mode !== 'question' && answer.length > 0) {
    lines.push('### 主会话该轮回答');
    lines.push(clipText(answer, 14000));
    lines.push('');
  } else if (mode !== 'question') {
    lines.push('### 主会话该轮回答');
    lines.push(answer.length > 0 ? answer : '（该轮回答尚未出现在已加载的主会话事件中）');
    lines.push('');
  }

  if (mode === 'full') {
    const turns = Array.isArray(context?.turns) ? context.turns.filter((turn) => turn.user.length > 0) : [];
    let index = turns.findIndex((turn) => turn.turn === question.turn);
    if (index < 0) index = turns.findIndex((turn) => turn.user === question.text);
    lines.push('### 相邻上下文');
    if (index > 0) {
      const previous = turns[index - 1];
      lines.push(`- 上一轮（${previous.turn > 0 ? `第 ${previous.turn} 轮` : '主会话'}）我：${clipText(previous.user, 500)}`);
      const previousAnswer = Array.isArray(previous.answers) ? previous.answers.join('\n\n') : '';
      if (previousAnswer.length > 0) lines.push(`  助手：${clipText(previousAnswer, 700)}`);
    } else {
      lines.push('- 没有已加载的上一轮。');
    }
    if (index >= 0 && index < turns.length - 1) {
      const next = turns[index + 1];
      lines.push(`- 下一轮（${next.turn > 0 ? `第 ${next.turn} 轮` : '主会话'}）我：${clipText(next.user, 500)}`);
      const nextAnswer = Array.isArray(next.answers) ? next.answers.join('\n\n') : '';
      if (nextAnswer.length > 0) lines.push(`  助手：${clipText(nextAnswer, 700)}`);
    }
    lines.push('');

    lines.push('### 主会话脉络（最近 5 轮）');
    const recent = turns.slice(-5);
    for (const turn of recent) appendTurnDigest(lines, turn, { questionLimit: 420, answerLimit: 520 });
    if (recent.length === 0) lines.push('- 暂无已加载的主会话问答。');
    lines.push('');

    lines.push('### 会话信息');
    lines.push(`- 主会话：${String(context?.title ?? '').trim() || '未命名主会话'}`);
    lines.push(`- 引用轮次：${Number(question.turn) > 0 ? question.turn : '当前'}`);
    lines.push(`- 已读取：最近 ${turns.length} 轮${context?.hasMore === true ? '（更早历史未加载）' : ''}`);
    lines.push('- 引用性质：reference-only；以上内容是历史引用，不要把它当成当前侧边栏已经完成的工作。');
    lines.push('');
  } else {
    lines.push('### 会话信息');
    lines.push(`- 主会话：${String(context?.title ?? '').trim() || '未命名主会话'}`);
    lines.push('- 引用性质：reference-only；以上内容是历史引用，不要把它当成当前侧边栏已经完成的工作。');
    lines.push('');
  }

  lines.push('我的追问：');
  lines.push('');
  return clipText(lines.join('\n'), 30000);
}

function buildMainSummaryBlock(context) {
  const turns = Array.isArray(context?.turns) ? context.turns.filter((turn) => turn.user.length > 0) : [];
  const lines = [
    '以下内容是我从主会话同步过来的上下文摘要，只用于这次侧边栏追问，不是本侧边栏里已经发送的消息。',
    '',
    '### 主会话信息',
    `- 主会话：${String(context?.title ?? '').trim() || '未命名主会话'}`,
    `- 已读取：最近 ${turns.length} 轮${context?.hasMore === true ? '（更早历史未加载）' : ''}`,
    `- 事件窗口：${Number(context?.eventCount) || 0} 条事件`,
    '- 生成方式：按主会话事件整理的引用摘要（不是模型重新总结）；包含问题、回答要点、工具动作与已有压缩摘要。',
    '',
  ];

  const compaction = Array.isArray(context?.compaction) ? context.compaction : [];
  if (compaction.length > 0) {
    lines.push('### 已有历史压缩摘要');
    for (const item of compaction) {
      lines.push(clipText(item.summary, 6000));
      lines.push('');
    }
  }

  lines.push('### 主会话脉络（最近 8 轮）');
  const recent = turns.slice(-8);
  for (const turn of recent) appendTurnDigest(lines, turn, { questionLimit: 900, answerLimit: 1200 });
  if (recent.length === 0) {
    lines.push('- 主会话里还没有可读取的问答事件。');
  }
  lines.push('');

  const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const lastAnswer = Array.isArray(last?.answers) ? last.answers.join('\n\n').trim() : '';
  if (lastAnswer.length > 0) {
    lines.push('### 最近一次回答');
    lines.push(clipText(lastAnswer, 10000));
    lines.push('');
  }

  lines.push('### 引用性质');
  lines.push('- reference-only：以上内容是主会话的历史上下文；不要把它当成当前侧边栏已经完成的工作。');
  lines.push('- 如果需要更精确的原文，可以再引用单条提问或直接选中主会话内容。');
  lines.push('');
  return clipText(lines.join('\n'), 36000);
}

/**
 * Selection toolbar: the input affordance and the sidebar are one plugin now.
 * The parser deliberately reads the same DOM anchors as the conversation UI,
 * but rejects selections made inside any composer or any sidebar Agent so a
 * child conversation can never quote itself (or react to a main selection).
 */
function normalizeSelectionText(text) {
  return String(text ?? '')
    .replace(/\u200B/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function selectionElementOf(node) {
  if (!node) return null;
  return node.nodeType === 1 ? node : node.parentElement ?? null;
}

function readMainSelection(scopeSessionId) {
  if (typeof window === 'undefined') return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;
  const startElement = selectionElementOf(range.startContainer);
  const endElement = selectionElementOf(range.endContainer);
  if (!startElement || !endElement) return null;
  const excluded = '[data-sidebar-right-panel], [data-sidebar-agent], [data-composer-card], textarea, input, [contenteditable="true"]';
  if (startElement.closest(excluded) || endElement.closest(excluded)) return null;
  const startNode = startElement.closest('[data-chat-flow-kind]');
  const endNode = endElement.closest('[data-chat-flow-kind]');
  if (!startNode || !endNode || startNode !== endNode) return null;
  if (!startNode.closest('[data-conversation-region="chat"]')) return null;
  const selectionSessionId = startNode.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? '';
  if (scopeSessionId && selectionSessionId && selectionSessionId !== scopeSessionId) return null;
  const flowKind = startNode.getAttribute('data-chat-flow-kind');
  const role = flowKind === 'assistant-step' ? 'assistant' : flowKind;
  if (role !== 'user' && role !== 'assistant' && role !== 'steering') return null;
  const raw = normalizeSelectionText(selection.toString());
  if (raw.length === 0) return null;
  const truncated = raw.length > SELECTION_MAX_CHARS;
  const text = truncated ? raw.slice(0, SELECTION_MAX_CHARS) : raw;
  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  const turn = Number(startNode.getAttribute('data-chat-turn') ?? startNode.closest('[data-chat-turn]')?.getAttribute('data-chat-turn'));
  const nodeKey = startNode.getAttribute('data-chat-node-key') ?? startNode.closest('[data-chat-node-key]')?.getAttribute('data-chat-node-key') ?? '';
  return {
    version: 1,
    surface: 'chat',
    role,
    nodeKey,
    turn: Number.isFinite(turn) ? turn : 0,
    text,
    charCount: text.length,
    truncated,
    capturedAt: Date.now(),
    sessionId: selectionSessionId || scopeSessionId || undefined,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
  };
}

function formatMainQuote(selection) {
  const lines = String(selection.text ?? '').split('\n').map((line) => `> ${line}`);
  if (lines.length > 40) {
    lines.length = 40;
    lines.push('> …');
  }
  const suffix = selection.truncated === true ? ` · ${zh.selectionTruncated}` : '';
  const turn = Number(selection.turn) || 0;
  const origin = `${selectionRoleLabel(selection.role)}${turn > 0 ? ` · 第 ${turn} 轮` : ''}`;
  return `${lines.join('\n')}\n>\n> — ${origin}${suffix}\n\n`;
}

function selectionCopyText(text) {
  // Run the synchronous path first so a real click still has user activation.
  // The async Clipboard API is only a fallback for browsers that have removed
  // `execCommand('copy')`.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  } finally {
    area.remove();
  }
  if (ok) return Promise.resolve();
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('clipboard unavailable'));
}

function clearNativeSelection() {
  try {
    window.getSelection()?.removeAllRanges();
  } catch {
    // Selection cleanup is best effort.
  }
}

function selectionRoleLabel(role) {
  if (role === 'user') return zh.selectionFromUser;
  if (role === 'steering') return zh.selectionFromSteering;
  return zh.selectionFromAssistant;
}

/**
 * Turn a main-conversation selection into a compact reference block. The
 * selected text is the context; surrounding answer/session data is deliberately
 * not copied wholesale, so the sidebar prompt stays predictable and editable.
 */
function buildSelectionBlock(selection, parentTitle) {
  const role = selectionRoleLabel(selection.role);
  const turn = Number(selection.turn) || 0;
  const lines = [
    zh.selectionIntro,
    '',
    `### ${zh.selectionHeading}（${role}${turn > 0 ? ` · 第 ${turn} 轮` : ''}）`,
  ];
  for (const line of String(selection.text ?? '').split('\n')) lines.push(`> ${line}`);
  if (selection.truncated === true) lines.push(`> …（${zh.selectionTruncated}）`);
  lines.push('');
  if (typeof parentTitle === 'string' && parentTitle.trim().length > 0) {
    lines.push(`### ${zh.selectionSource}`);
    lines.push(`- 主会话：${parentTitle.trim()}`);
    lines.push('');
  }
  lines.push(zh.selectionFollowup);
  lines.push('');
  return clipText(lines.join('\n'), 12000);
}

/**
 * Append a selected-text quote to the active/open sidebar, or create one when
 * none is open. This is intentionally draft-only: the user still presses Send.
 */
async function quoteSelectionToSidebar(parentId, parent, selection) {
  const text = String(selection?.text ?? '').trim();
  if (text.length === 0) throw new Error('选区为空');
  const threads = readThreads(parentId);
  const state = sidebarQuoteState(parentId, threads);
  let thread;
  let created = false;
  if (state.targetId === '__new__') {
    thread = await createThread(parentId, parent);
    if (thread === null) return { created: false, cancelled: true };
    if (thread === undefined) throw new Error(zh.selectionCreatePending);
    created = true;
  } else {
    thread = threads.find((item) => item.id === state.targetId);
  }
  if (thread === undefined || thread === null) throw new Error(zh.selectionCreatePending);
  let parentTitle;
  try {
    parentTitle = ctx.sessions.list.getSnapshot()?.byId?.[parentId]?.title;
  } catch {
    parentTitle = undefined;
  }
  await appendToThreadDraft(parentId, thread, buildSelectionBlock({ ...selection, text }, parentTitle));
  return { created, threadId: thread.id, label: thread.label };
}

/**
 * Insert the quote into the target child's real composer draft. This uses the
 * public Session input API rather than touching another tab's DOM, so it works
 * even when the target tab is closed and never sends a message by itself.
 */
async function appendToThreadDraft(parentId, thread, text) {
  const conversation = typeof ctx.get === 'function' ? ctx.get('conversation') : ctx.conversation;
  const initialize = conversation?.input?.requestDraftInitialization;
  if (typeof initialize !== 'function') throw new Error('conversation.input 不可用');
  const reference = ctx.sessions.retain(thread.id, { source: 'sidebarChat' });
  try {
    await reference.ready;
    const result = initialize.call(conversation.input, reference.binding, {
      prompt: text,
      whenDraftExists: 'append',
    });
    if (result === 'blocked') throw new Error('目标侧边栏正在提交，请稍后再试');
  } finally {
    // The target tab may not have mounted yet. Hold the scope briefly so the
    // draft write is not dropped with the last reference; once mounted, the
    // tab's own reference keeps it alive.
    window.setTimeout(() => reference.release(), 1500);
  }
  restoreThread(parentId, thread);
  focusThreadComposer(thread);
}


/** Focus the target child's composer after a quote lands, including an already-open tab. */
function focusThreadComposer(thread) {
  let tries = 0;
  const tick = () => {
    const roots = Array.from(document.querySelectorAll('[data-sidebar-agent]'));
    const root = roots.find((element) => element.getAttribute('data-sidebar-agent') === thread.id);
    const editor = root?.querySelector('[contenteditable="true"]');
    if (editor !== null && editor !== undefined) {
      editor.focus({ preventScroll: true });
      return;
    }
    if (tries++ < 12) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function resolveQuoteThread(parentId, parent, targetId, threads) {
  if (targetId === '__new__') {
    const created = await createThread(parentId, parent);
    if (created === null) return null;
    if (created === undefined) throw new Error(zh.selectionCreatePending);
    return created;
  }
  const thread = threads.find((item) => item.id === targetId);
  if (thread === undefined || thread === null) throw new Error('请选择一个侧边栏');
  return thread;
}

function SidebarAgentQuote({ parentId, threads, cwd, preset, direction = 'up' }) {
  const list = useSessionList();
  const [open, setOpen] = React.useState(false);
  const [questions, setQuestions] = React.useState([]);
  const [mainContext, setMainContext] = React.useState(null);
  const [contextLoading, setContextLoading] = React.useState(false);
  const [targetId, setTargetId] = React.useState('__new__');
  const [mode, setMode] = React.useState('full');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [popStyle, setPopStyle] = React.useState(null);
  const rootRef = React.useRef(null);
  const buttonRef = React.useRef(null);

  const sortedThreads = [...threads].sort((left, right) => (Number(left.index) || 0) - (Number(right.index) || 0));
  const quoteState = sidebarQuoteState(parentId, sortedThreads);

  React.useLayoutEffect(() => {
    if (!open) {
      setPopStyle(null);
      return undefined;
    }
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const margin = 8;
      const width = Math.min(320, window.innerWidth - margin * 2);
      const maxLeft = window.innerWidth - width - margin;
      const railGuard = mainChatRootFor(parentId)?.getBoundingClientRect().left ?? margin;
      const anchorLeft = rect.right - width;
      const left = Math.min(Math.max(anchorLeft, railGuard + 4), maxLeft);
      if (direction === 'down') {
        const top = Math.max(margin, rect.bottom + 6);
        const maxHeight = Math.max(160, Math.min(420, window.innerHeight - top - margin));
        setPopStyle({ position: 'fixed', left, top, right: 'auto', bottom: 'auto', width, maxHeight, zIndex: 83 });
      } else {
        const bottom = Math.max(margin, window.innerHeight - rect.top + 6);
        const maxHeight = Math.max(160, Math.min(420, rect.top - margin));
        setPopStyle({ position: 'fixed', left, bottom, right: 'auto', top: 'auto', width, maxHeight, zIndex: 83 });
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [open, direction, parentId]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    setTargetId((current) => {
      if (current === '__new__') return current;
      return sortedThreads.some((thread) => thread.id === current) ? current : quoteState.targetId;
    });
  }, [open, threads, quoteState.targetId]);

  React.useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setQuestions(readMainQuestions(parentId));
    setContextLoading(true);
    readMainContext(parentId).then((context) => {
      if (cancelled) return;
      setMainContext(context);
      if (context.turns.length > 0) setQuestions(context.questions);
    }).catch((cause) => {
      if (!cancelled) console.error('[sidebar-agent] read main context failed', cause);
    }).finally(() => {
      if (!cancelled) setContextLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, parentId]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setError(null);
    setQuestions(readMainQuestions(parentId));
    setMainContext(null);
    setTargetId(quoteState.targetId);
    setOpen(true);
  };

  const insert = async (question) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await resolveQuoteThread(parentId, { cwd, preset }, targetId, threads);
      if (thread === null) {
        setOpen(false);
        return;
      }
      const context = mainContext ?? await readMainContext(parentId);
      await appendToThreadDraft(parentId, thread, buildMainQuestionBlock(question, context, mode));
      setOpen(false);
    } catch (cause) {
      console.error('[sidebar-agent] quote insert failed', cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const insertSummary = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const thread = await resolveQuoteThread(parentId, { cwd, preset }, targetId, threads);
      if (thread === null) {
        setOpen(false);
        return;
      }
      const context = await readMainContext(parentId, { deep: true });
      const hasQuestions = context.turns.some((turn) => turn.user.length > 0);
      if (!hasQuestions && context.compaction.length === 0) throw new Error(zh.quoteSummaryEmpty);
      await appendToThreadDraft(parentId, thread, buildMainSummaryBlock(context));
      setOpen(false);
    } catch (cause) {
      console.error('[sidebar-agent] summary quote failed', cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const targetThread = sortedThreads.find((thread) => thread.id === targetId);
  const targetHint = targetId === '__new__'
    ? zh.quoteWillCreate
    : quoteState.openIds.includes(targetId)
      ? zh.quoteWillAppendOpen
      : targetThread?.hidden === true
        ? zh.quoteWillRestore
        : zh.quoteWillAppend;
  const summaryTurns = Array.isArray(mainContext?.turns)
    ? mainContext.turns.filter((turn) => turn.user.length > 0).length
    : questions.length;
  const canSummarize = !contextLoading && (summaryTurns > 0 || (mainContext?.compaction?.length ?? 0) > 0);
  const contextHint = contextLoading
    ? zh.quoteReading
    : (mainContext?.hasMore === true ? zh.quoteLoadedMore : zh.quoteLoaded)
      .replace('{turns}', String(summaryTurns || questions.length));
  const scopeHint = mode === 'question'
    ? zh.quoteScopeQuestion
    : mode === 'answer' ? zh.quoteScopeAnswer : zh.quoteScopeFull;

  return React.createElement('span', { className: 'dsh-sa-quote', ref: rootRef },
    React.createElement('button', {
      type: 'button',
      className: 'dsh-sa-quote-btn',
      ref: buttonRef,
      title: zh.quoteTitle,
      'aria-label': zh.quoteTitle,
      'aria-haspopup': 'dialog',
      'aria-expanded': open,
      onClick: toggle,
      'data-sidebar-agent-quote': '',
    },
      React.createElement('span', { className: 'dsh-sa-quote-long' }, zh.quote),
      React.createElement('span', { className: 'dsh-sa-quote-short' }, zh.quoteShort),
    ),
    open ? React.createElement('div', {
      className: `dsh-sa-quote-pop${direction === 'down' ? ' dsh-sa-quote-pop-down' : ''}`,
      role: 'dialog',
      'aria-label': zh.quoteHeader,
      'data-sidebar-agent-quote-pop': '',
      style: popStyle ?? undefined,
    },
      React.createElement('div', { className: 'dsh-sa-quote-head' },
        React.createElement('span', null, zh.quoteHeader),
        React.createElement('span', { className: 'dsh-sa-quote-count' },
          questions.length > 0 ? `${questions.length} 轮` : ''),
      ),
      React.createElement('div', { className: 'dsh-sa-quote-purpose' }, zh.quotePurpose),
      React.createElement('label', { className: 'dsh-sa-quote-target' },
        React.createElement('span', null, zh.quoteTarget),
        React.createElement('select', {
          className: 'dsh-sa-quote-select',
          value: targetId,
          disabled: busy,
          onChange: (event) => setTargetId(event.target.value),
          'data-sidebar-agent-quote-target': '',
        },
          React.createElement('option', { value: '__new__' }, zh.quoteNew),
          ...sortedThreads.map((thread) => {
            const child = list.byId[thread.id];
            const childTitle = typeof child?.title === 'string' ? child.title : '';
            const threadLabel = typeof thread.label === 'string' && thread.label.length > 0 ? thread.label : zh.fallbackChip;
            const suffix = thread.hidden === true
              ? `（${zh.historyClosed}）`
              : quoteState.openIds.includes(thread.id) ? `（${zh.quoteOpen}）` : '';
            return React.createElement('option', { key: thread.id, value: thread.id },
              childTitle.length > 0 ? `${threadLabel} · ${childTitle}${suffix}` : `${threadLabel}${suffix}`);
          }),
        ),
      ),
      React.createElement('div', { className: 'dsh-sa-quote-target-hint', 'data-sidebar-agent-quote-target-hint': '' }, targetHint),
      React.createElement('div', { className: 'dsh-sa-quote-loading', 'data-sidebar-agent-quote-context': '' }, contextHint),
      React.createElement('button', {
        type: 'button',
        className: 'dsh-sa-quote-summary',
        disabled: busy || !canSummarize,
        title: canSummarize ? zh.quoteSummaryDesc : zh.quoteSummaryEmpty,
        onClick: insertSummary,
        'data-sidebar-agent-summary-quote': '',
      },
        React.createElement('span', { className: 'dsh-sa-quote-summary-title' },
          zh.quoteSummary,
          summaryTurns > 0 ? `（${summaryTurns} 轮）` : '',
        ),
        React.createElement('span', { className: 'dsh-sa-quote-summary-desc' },
          contextLoading ? zh.quoteSummaryLoading : zh.quoteSummaryDesc,
        ),
      ),
      React.createElement('div', { className: 'dsh-sa-quote-divider' }, zh.quoteDivider),
      React.createElement('label', { className: 'dsh-sa-quote-target' },
        React.createElement('span', null, zh.quoteModeLabel),
        React.createElement('select', {
          className: 'dsh-sa-quote-select',
          value: mode,
          disabled: busy,
          onChange: (event) => setMode(event.target.value),
          'data-sidebar-agent-quote-mode': '',
        },
          React.createElement('option', { value: 'full' }, zh.quoteModeFull),
          React.createElement('option', { value: 'answer' }, zh.quoteModeAnswer),
          React.createElement('option', { value: 'question' }, zh.quoteModeQuestion),
        ),
      ),
      React.createElement('div', { className: 'dsh-sa-quote-scope' }, scopeHint),
      error !== null ? React.createElement('div', { className: 'dsh-sa-quote-error' }, `${zh.quoteFailed}：${error}`) : null,
      questions.length > 0
        ? React.createElement('div', { className: 'dsh-sa-quote-list' },
            ...questions.map((question) => {
              const hasAnswer = turnAnswer(question).length > 0;
              return React.createElement('button', {
                type: 'button',
                key: `${question.turn}:${question.text.slice(0, 48)}`,
                className: 'dsh-sa-quote-row',
                disabled: busy,
                title: '插入到目标侧边栏的输入框',
                onClick: () => insert(question),
                'data-sidebar-agent-question': String(question.turn),
              },
                React.createElement('span', { className: 'dsh-sa-quote-meta' },
                  question.turn > 0 ? `第 ${question.turn} 轮` : '主会话提问',
                  hasAnswer ? ' · 有回答' : ' · 暂无回答'),
                React.createElement('span', { className: 'dsh-sa-quote-text' }, question.text),
              );
            }),
          )
        : React.createElement('div', { className: 'dsh-sa-quote-empty' },
            contextLoading ? zh.quoteReading : zh.quoteEmpty),
      React.createElement('div', { className: 'dsh-sa-quote-foot' }, zh.quoteHint),
    ) : null,
  );
}

function FixedChatConversationView(props) {
  return React.createElement(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }));
}

function SidebarAgentConversation({ renderFactorySlot }) {
  return renderFactorySlot(
    'conversation.content',
    { variant: 'embedded', phase: 'active', hero: false },
    { slots: { views: FixedChatConversationView } },
  );
}

function SidebarAgentTitle({ useTabInfo }) {
  const { tab } = useTabInfo();
  const record = tabRecord(tab);
  const label = record?.label;
  return React.createElement(
    'span',
    { className: 'dsh-sa-title' },
    typeof label === 'string' && label.length > 0 ? label : zh.fallbackTitle,
  );
}

function SidebarAgentPaneActions({ parentId }) {
  const list = useSessionList();
  const threads = useThreadList(parentId);
  const cwd = list.byId[parentId]?.cwd;
  const preset = list.projectionsBySession?.[parentId]?.values?.agentPreset;

  if (threads.length === 0) return null;
  return React.createElement(
    'div',
    { className: 'dsh-sa-pane-bar', 'data-sidebar-agent-pane-actions': '' },
    React.createElement(SidebarAgentHistory, {
      parentId,
      fixed: true,
      direction: 'down',
      align: 'right',
    }),
    React.createElement(SidebarAgentQuote, {
      parentId,
      threads,
      cwd,
      preset,
      direction: 'down',
    }),
  );
}

/**
 * The merged selection toolbar. It lives in the normal conversation composer
 * dock only so it can use that conversation's InputActions; it renders nothing
 * until the user selects text, so it does not add a visible composer row.
 */
function SidebarAgentSelectionToolbar({ inputActions, sessionId }) {
  const list = useSessionList();
  const [selection, setSelection] = React.useState(null);
  const [toast, setToast] = React.useState(null);
  const toolbarRef = React.useRef(null);
  const rafRef = React.useRef(0);
  const toastTimer = React.useRef(0);
  const embedded = typeof sessionId === 'string' && parentOf(sessionId) !== undefined;
  const cwd = list.byId[sessionId]?.cwd;
  const preset = list.projectionsBySession?.[sessionId]?.values?.agentPreset;

  const showToast = (text) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };

  React.useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  React.useEffect(() => {
    if (typeof sessionId !== 'string' || embedded) {
      setSelection(null);
      return undefined;
    }
    const schedule = () => {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = window.requestAnimationFrame(() => {
        const next = readMainSelection(sessionId);
        setSelection((previous) => {
          if (next === null) return null;
          if (
            previous
            && previous.text === next.text
            && previous.nodeKey === next.nodeKey
            && Math.abs(previous.rect.top - next.rect.top) < 2
            && Math.abs(previous.rect.left - next.rect.left) < 2
          ) {
            return previous;
          }
          return next;
        });
      });
    };
    const onSelectionChange = () => schedule();
    const onPointerUp = (event) => {
      if (event.button !== 0) return;
      if (toolbarRef.current?.contains(event.target)) return;
      schedule();
    };
    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      if (toolbarRef.current?.contains(event.target)) return;
      setSelection(null);
    };
    const onScroll = () => setSelection(null);
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setSelection(null);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(rafRef.current);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [sessionId, embedded]);

  const insertQuote = () => {
    if (!selection || !inputActions) return;
    try {
      const block = formatMainQuote(selection);
      let span = inputActions.captureInsertion();
      let ok = inputActions.insertText(block, span);
      if (!ok) {
        span = inputActions.captureInsertion();
        ok = inputActions.insertText(block, span);
      }
      showToast(ok ? zh.selectInserted : zh.selectInsertFailed);
      if (ok) {
        setSelection(null);
        clearNativeSelection();
      }
    } catch {
      showToast(zh.selectInsertFailed);
    }
  };

  const copy = () => {
    if (!selection) return;
    selectionCopyText(selection.text)
      .then(() => {
        showToast(zh.selectCopied);
        clearNativeSelection();
      })
      .catch(() => showToast(zh.selectCopyFailed));
  };

  const ask = async () => {
    if (!selection) return;
    const payload = {
      version: 1,
      surface: selection.surface,
      role: selection.role,
      nodeKey: selection.nodeKey,
      turn: selection.turn,
      text: selection.text,
      charCount: selection.charCount,
      truncated: selection.truncated,
      capturedAt: selection.capturedAt,
      sessionId: selection.sessionId ?? sessionId,
    };
    try {
      const result = await quoteSelectionToSidebar(sessionId, { cwd, preset }, payload);
      if (result?.cancelled === true) {
        showToast(zh.selectCancelled);
        return;
      }
      setSelection(null);
      clearNativeSelection();
      showToast(result?.created === true ? zh.selectCreated : zh.selectAppended);
    } catch (cause) {
      console.error('[sidebar-agent] selection ask failed', cause);
      showToast(`${zh.selectAskFailed}: ${cause?.message ?? 'unknown'}`);
    }
  };

  if (embedded) return null;
  if (!selection) {
    return toast === null
      ? null
      : React.createElement('div', { className: 'dsh-sa-sel-toast', role: 'status' }, toast);
  }

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const above = selection.rect.bottom + 52 > viewportHeight;
  const left = Math.max(120, Math.min(viewportWidth - 120, selection.rect.left + selection.rect.width / 2));
  const top = above ? Math.max(8, selection.rect.top - 44) : selection.rect.bottom + 8;

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'div',
      {
        ref: toolbarRef,
        className: 'dsh-sa-sel-toolbar',
        style: { left, top },
        role: 'toolbar',
        'aria-label': zh.selectToolbar,
        'data-sidebar-agent-selection': '',
        onMouseDown: (event) => event.preventDefault(),
      },
      React.createElement('button', { type: 'button', className: 'dsh-sa-sel-btn', onClick: copy }, zh.selectCopy),
      React.createElement('span', { className: 'dsh-sa-sel-sep' }),
      React.createElement('button', { type: 'button', className: 'dsh-sa-sel-btn', onClick: insertQuote }, zh.selectQuote),
      React.createElement(
        'button',
        { type: 'button', className: 'dsh-sa-sel-btn dsh-sa-sel-btn-primary', onClick: () => void ask() },
        zh.selectAsk,
      ),
    ),
    toast ? React.createElement('div', { className: 'dsh-sa-sel-toast', role: 'status' }, toast) : null,
  );
}

function SidebarAgentTab({ useTabInfo, SessionProvider, renderSlot }) {
  const { tab } = useTabInfo();
  const record = tabRecord(tab);
  const childId = record?.childId;
  const parentId = record?.parentId;
  const list = useSessionList();
  const rootRef = React.useRef(null);

  React.useEffect(() => {
    const params = tab.navigation?.params;
    if (params !== null && typeof params === 'object' && typeof params.childId === 'string') {
      rememberTab(tab.contentId, {
        childId: params.childId,
        parentId: params.parentId,
        label: params.label,
      });
    }
  }, [tab.contentId, tab.navigation?.params?.childId]);
  const known = childId !== undefined && list.byId[childId] !== undefined;
  const [reference, setReference] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    if (childId === undefined || !known) return undefined;
    const controller = new AbortController();
    let retained;
    try {
      retained = ctx.sessions.retain(childId, { source: 'sidebarChat', signal: controller.signal });
      setError(null);
      setReference(retained);
    } catch (cause) {
      console.error('[sidebar-agent] retain failed', cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    return () => {
      controller.abort();
      retained?.release();
    };
  }, [childId, known]);

  // Opening or switching a sidebar tab should leave the caret in its own
  // composer. Without this, a click on +侧边栏 leaves focus on the button and
  // the next keystrokes go nowhere (or back to the main composer).
  React.useEffect(() => {
    if (reference === null) return undefined;
    let frame = 0;
    let tries = 0;
    const focus = () => {
      const root = rootRef.current;
      if (root === null || root.offsetParent === null) return;
      const editor = root.querySelector('[contenteditable="true"]');
      if (editor === null) {
        if (tries++ < 12) frame = requestAnimationFrame(focus);
        return;
      }
      const active = document.activeElement;
      const outsideEditor = active !== null && active !== root && !root.contains(active)
        && (active.isContentEditable === true || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
      if (outsideEditor) return;
      editor.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(focus);
    return () => cancelAnimationFrame(frame);
  }, [reference]);

  const blank = childId !== undefined && list.byId[childId]?.blank === true;

  if (childId === undefined) {
    return React.createElement('div', { className: 'dsh-sa-notice dsh-sa-error' }, zh.missing);
  }
  if (error !== null) {
    return React.createElement('div', { className: 'dsh-sa-notice dsh-sa-error' }, `${zh.failed}：${error}`);
  }
  if (!known || reference === null) {
    return React.createElement('div', { className: 'dsh-sa-notice' }, zh.connecting);
  }
  return React.createElement(
    'div',
    { ref: rootRef, className: 'dsh-sa-root', 'data-sidebar-agent': childId },
    parentId !== undefined
      ? React.createElement(SidebarAgentPaneActions, { parentId })
      : null,
    blank
      ? React.createElement(
        'div',
        { className: 'dsh-sa-intro' },
        React.createElement('span', { className: 'dsh-sa-intro-name' }, zh.fallbackTitle),
        React.createElement('span', { className: 'dsh-sa-intro-hint' }, zh.independent),
      )
      : null,
    React.createElement(
      SessionProvider,
      { session: reference },
      renderSlot('sidebar.agent.conversation', {}),
    ),
  );
}

function SidebarAgentHistory({ parentId, resolveParentId, compact = false, align = 'right', hideWhenEmpty = false, fixed = false, direction = 'up' }) {
  const list = useSessionList();
  const [open, setOpen] = React.useState(false);
  const [confirmId, setConfirmId] = React.useState(null);
  const [resolvedParent, setResolvedParent] = React.useState(parentId);
  const [threads, setThreads] = React.useState(() => (parentId ? readThreads(parentId) : []));
  const [fixedStyle, setFixedStyle] = React.useState(null);
  const rootRef = React.useRef(null);
  const buttonRef = React.useRef(null);
  const effectiveParent = resolvedParent ?? parentId;

  React.useLayoutEffect(() => {
    if (!open || !fixed) {
      setFixedStyle(null);
      return undefined;
    }
    const update = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const margin = 8;
      const width = Math.min(270, window.innerWidth - margin * 2);
      const preferred = align === 'left' ? rect.right + 6 : rect.left;
      const left = Math.max(margin, Math.min(preferred, window.innerWidth - width - margin));
      if (direction === 'down') {
        const top = Math.max(margin, rect.bottom + 6);
        const maxHeight = Math.max(140, Math.min(360, window.innerHeight - top - margin));
        setFixedStyle({ position: 'fixed', left, top, right: 'auto', bottom: 'auto', width, maxHeight, zIndex: 82 });
      } else {
        const bottom = Math.max(margin, window.innerHeight - rect.top + 6);
        const maxHeight = Math.max(140, Math.min(360, rect.top - 12));
        setFixedStyle({ position: 'fixed', left, bottom, right: 'auto', top: 'auto', width, maxHeight, zIndex: 82 });
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, fixed, align, direction, threads.length]);

  React.useEffect(() => {
    setResolvedParent(parentId);
  }, [parentId]);

  React.useEffect(() => {
    if (effectiveParent === undefined) {
      setThreads([]);
      return undefined;
    }
    const sync = () => setThreads(readThreads(effectiveParent));
    sync();
    const unsubscribe = subscribeThreads(sync);
    const onStorage = (event) => {
      if (event.key === null || event.key === THREADS_PREFIX + effectiveParent) sync();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, [effectiveParent]);

  React.useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  React.useEffect(() => {
    if (confirmId !== null && !threads.some((thread) => thread.id === confirmId)) setConfirmId(null);
  }, [confirmId, threads]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      setConfirmId(null);
      return;
    }
    const next = typeof resolveParentId === 'function' ? resolveParentId() : parentId;
    setConfirmId(null);
    setResolvedParent(next);
    setThreads(next === undefined ? [] : readThreads(next));
    setOpen(true);
  };

  const restore = (thread) => {
    if (effectiveParent === undefined) return;
    setOpen(false);
    setConfirmId(null);
    try {
      restoreThread(effectiveParent, thread);
    } catch (error) {
      console.error('[sidebar-agent] could not restore thread', error);
    }
  };

  if (hideWhenEmpty && threads.length === 0) return null;

  const sorted = [...threads].sort((left, right) => (Number(left.index) || 0) - (Number(right.index) || 0));
  const rows = sorted.map((thread) => {
    const child = list.byId[thread.id];
    const childTitle = typeof child?.title === 'string' ? child.title : '';
    const running = child?.running === true;
    const hidden = thread.hidden === true;
    const label = typeof thread.label === 'string' && thread.label.length > 0 ? thread.label : zh.fallbackChip;
    const confirming = confirmId === thread.id;
    return React.createElement('div', {
      key: thread.id,
      className: `dsh-sa-history-row${confirming ? ' dsh-sa-history-row-confirming' : ''}`,
      role: 'group',
    },
      confirming
        ? React.createElement('div', {
            className: 'dsh-sa-history-confirm',
            role: 'alert',
            title: `${label} · ${zh.historyRemove}`,
          },
            React.createElement('span', { className: 'dsh-sa-history-confirm-text' }, zh.historyRemoveConfirm),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-sa-history-confirm-yes',
              'data-sidebar-agent-history-confirm': '',
              onClick: (event) => {
                event.stopPropagation();
                setConfirmId(null);
                if (effectiveParent !== undefined) removeThread(effectiveParent, thread);
              },
            }, zh.historyRemoveYes),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-sa-history-confirm-no',
              'data-sidebar-agent-history-cancel': '',
              onClick: (event) => {
                event.stopPropagation();
                setConfirmId(null);
              },
            }, zh.historyRemoveNo),
          )
        : React.createElement(React.Fragment, null,
            React.createElement('button', {
              type: 'button',
              role: 'menuitem',
              className: 'dsh-sa-history-main',
              title: childTitle.length > 0 ? `${label} · ${childTitle}` : `${label}（${hidden ? zh.historyClosed : zh.historyOpen}）`,
              onClick: () => restore(thread),
              'data-sidebar-agent-thread': thread.id,
            },
              React.createElement('span', { className: 'dsh-sa-history-copy' },
                React.createElement('span', { className: 'dsh-sa-history-label' }, label),
                childTitle.length > 0 ? React.createElement('span', { className: 'dsh-sa-history-title' }, childTitle) : null,
              ),
              React.createElement('span', { className: 'dsh-sa-history-state' },
                running ? zh.running : hidden ? zh.historyClosed : zh.historyOpen),
            ),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-sa-history-remove',
              title: zh.historyRemove,
              'aria-label': zh.historyRemove,
              'data-sidebar-agent-history-remove': '',
              onClick: (event) => {
                event.stopPropagation();
                setConfirmId(thread.id);
              },
            }, '×'),
          ),
    );
  });

  return React.createElement('span', { className: 'dsh-sa-history', ref: rootRef },
    React.createElement('button', {
      type: 'button',
      className: 'dsh-sa-history-btn',
      ref: buttonRef,
      title: zh.historyTitle,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      onClick: toggle,
      'data-sidebar-agent-history': '',
    },
      React.createElement('span', { 'aria-hidden': 'true' }, '↺'),
      compact ? null : React.createElement('span', { className: 'dsh-sa-history-text' }, zh.history),
    ),
    open ? React.createElement('div', {
      className: `dsh-sa-history-pop${align === 'left' ? ' dsh-sa-history-pop-left' : ''}${direction === 'down' ? ' dsh-sa-history-pop-down' : ''}`,
      role: 'menu',
      'data-sidebar-agent-history-pop': '',
      style: fixedStyle ?? undefined,
    },
      React.createElement('div', { className: 'dsh-sa-history-head' },
        React.createElement('span', null, zh.historyTitle),
        React.createElement('span', { className: 'dsh-sa-history-count' }, `${threads.length}`),
      ),
      rows.length > 0 ? rows : React.createElement('div', { className: 'dsh-sa-history-empty' }, zh.historyEmpty),
    ) : null,
  );
}

function SidebarAgentCreateAction({ sessionId }) {
  const list = useSessionList();
  const origin = list.byId[sessionId]?.origin;
  const cwd = list.byId[sessionId]?.cwd;
  const preset = list.projectionsBySession?.[sessionId]?.values?.agentPreset;
  const threads = useThreadList(sessionId);
  const openTabs = useOpenSidebarTabs();
  const [creating, setCreating] = React.useState(false);
  const hidden = origin === 'subagent' || parentOf(sessionId) !== undefined;

  if (hidden) return null;

  const hasOpenTab = openTabs.some((tab) => tab.sessionId === sessionId && tab.kind === KIND);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await createThread(sessionId, { cwd, preset });
    } catch (error) {
      console.error('[sidebar-agent] create failed', error);
    } finally {
      setCreating(false);
    }
  };

  return React.createElement(
    React.Fragment,
    null,
    !hasOpenTab && threads.length > 0
      ? React.createElement(SidebarAgentHistory, {
          parentId: sessionId,
          fixed: true,
          direction: 'down',
          align: 'right',
        })
      : null,
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-sa-btn',
        title: zh.createTitle,
        disabled: creating,
        onClick: create,
        'data-sidebar-agent-create': '',
      },
      React.createElement('span', { 'aria-hidden': 'true' }, '+'),
      zh.create,
    ),
  );
}

function installStyle() {
  for (const old of document.querySelectorAll(`style[${STYLE_ATTR}]`)) old.remove();
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, '');
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => style.remove();
}

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory(require) {
    React = require('react');

    function tabsFor(context) {
      // `sidebarRightTabs` is provided through `ctx.reflect.provide`, not a
      // Cordis service, so `ctx.get` is the supported lookup. Reading it as a
      // context property would trip the inject guard.
      return typeof context.get === 'function' ? context.get('sidebarRightTabs') : undefined;
    }

    function apply(context) {
      ctx = context;
      try {
        applyInner(context);
      } catch (error) {
        console.error('[sidebar-agent] apply failed', error);
        throw error;
      }
    }

    function applyInner(context) {
      context.effect(() => installStyle(), 'sidebar-agent: styles');

      const tabs = tabsFor(context);
      if (tabs === undefined) {
        console.error('[sidebar-agent] sidebarRightTabs is unavailable; the tab type was not registered');
      } else {
        context.effect(() => tabs.register({
          id: PLUGIN_ID,
          kind: KIND,
          multiple: true,
          title: (address) => {
            if (pendingOpen !== null) {
              const pending = pendingOpen;
              pendingOpen = null;
              rememberTab(address, pending);
              return pending.label ?? zh.fallbackTitle;
            }
            return readTab(address)?.label ?? zh.fallbackTitle;
          },
        }), 'sidebar-agent: tab type');
      }

      context.effect(() => context.slots.inject('sidebar.right.pane.tab', () => context.slots.register({
        name: 'sidebar.right.pane.tab',
        key: PLUGIN_ID,
        children: { 'sidebar.agent.conversation': { kind: 'single', scope: 'session' } },
      }, SidebarAgentTab)), 'sidebar-agent: tab body');

      context.effect(() => context.slots.inject('sidebar.right.pane.tab.title', () => context.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: PLUGIN_ID,
      }, SidebarAgentTitle)), 'sidebar-agent: tab title');

      context.effect(() => context.slots.inject('sidebar.agent.conversation', () => context.slots.register({
        name: 'sidebar.agent.conversation',
      }, SidebarAgentConversation)), 'sidebar-agent: conversation');

      context.effect(() => {
        const right = context.sidebarRight;
        if (typeof right?.registerCloseHandler !== 'function') return undefined;
        return right.registerCloseHandler(KIND, (parentId, tab) => {
          const childId = childIdForTab(tab);
          if (childId === undefined) return;
          updateThread(parentId, childId, { hidden: true, closedAt: new Date().toISOString() });
          removeTabMaps(childId);
        });
      }, 'sidebar-agent: tab close history');

      context.effect(() => context.slots.inject('conversation.session.header.actions', () => context.slots.register({
        name: 'conversation.session.header.actions',
        id: 'sidebar-agent-create',
        order: 15,
      }, SidebarAgentCreateAction)), 'sidebar-agent: header action');

      // The slot is only a session-scoped source of InputActions for the
      // floating toolbar. It renders null until text is selected, so the main
      // composer stays a single row; the toolbar itself is position: fixed.
      context.effect(() => context.slots.inject('conversation.composer.dock', () => context.slots.register({
        name: 'conversation.composer.dock',
        id: 'sidebar-agent-selection',
        order: 20,
      }, SidebarAgentSelectionToolbar)), 'sidebar-agent: selection toolbar');
    }

    return {
      inject: ['sessions', 'slots', 'sidebarRight'],
      apply,
    };
  },
});
})();
