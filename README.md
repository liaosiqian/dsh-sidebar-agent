# Sidebar Agent

在 DSH Web 主会话下挂载**独立的侧边栏 Agent**。每个侧边栏 Agent 都是一个正常的 DSH Session，但只显示在右侧栏标签页里；它不会把消息、工具结果或结算通知写进主会话。

侧边栏第一次收到提问时，Host 会自动把主会话的最近上下文作为一条独立的注入消息放进该轮请求；之后主会话有新增内容时，再按增量同步。用户不需要手动复制主会话历史。

## 为什么不是 subagent

DSH 内置 subagent 在本地激活被释放后，下一次 follow-up 会以 `delivery: 'parent'` 冷恢复，并向主会话追加 `subagent-settled`。这正是本插件要避免的污染。因此这里创建的是**普通 Session**：

- 没有 `parentAgent`，Host 不会向主会话追加结算消息；
- 保留完整 Session Controller API，直接复用官方 `conversation.content` 嵌入式会话；
- 因此自带完整 composer：模型选择、权限模式、计划模式、附件、停止、排队/steer、工具调用展示、follow-up。

代价是子会话是一个真实 Session：首轮之后会出现在 Session 列表里（通常在 workspace 下或 Ungrouped）。本插件与主会话的父子关系编码在子会话 id 里（`session-sb-<base64url(parentId)>.<uuid>`），Host 侧据此读取主会话事件；它不是 DSH 的 `parentAgent`，所以不会触发子代理结算或回写主会话。客户端 localStorage 只负责标签和历史入口。

## 功能

- **多标签**：每个侧边栏 Agent 一个右侧栏标签，支持同时打开多个；标签可关闭，关闭后可从主会话输入框上方的快捷 chip 重新打开。
- **自动主会话上下文**：侧边栏的第一条提问会自动带上一份主会话上下文包（标题、最近 6 轮用户提问/助手回答要点、工具动作、最近 2 条压缩摘要，最多 24000 字符）；如果这条提问来自选区引用，会优先带上选中内容所属轮次附近的对话，再补最近轮次。它是一条独立的注入上下文消息，位于你的提问之前，不会混进提问正文；侧边栏自己的对话日志仍只属于它自己。之后每次提问只同步上次位置之后的新事件（增量，最多 16000 字符），不会反复塞入完整历史。
- **新增确认**：当前主会话已经有侧边栏时，再点 `+ 侧边栏`（或从选区提问触发新建）会先提示已有数量和“仍要新增吗？”；取消就保持原样，不会创建空会话。
- **历史恢复**：dock / 左下角入口的 `历史` 会列出该主会话下创建过的全部侧边栏（含已关闭的）；chip 上的 `×` 只是关闭并收进历史，不会删除会话，点历史里的条目即可恢复标签和原对话。
- **从主会话引用上下文**：dock 里的 `引用主会话` 会读取主会话已加载的 Session 事件（用户提问、助手回答、工具调用、压缩摘要），而不是只扫 DOM。弹层顶部可以一键 `引用主会话总结`（最近多轮脉络 + 关键回答 + 工具动作 + 已有压缩摘要），也可以选择单条提问，并按 `问题 + 完整回答 + 上下文` / `问题 + 完整回答` / `仅问题` 三种范围插入。默认追加到**当前打开的侧边栏**；没有打开的侧边栏时才新建。下拉框仍可手动选择其他已有侧边栏或 `+ 新建侧边栏`。插入目标是侧边栏 composer 的**草稿**，不会自动发送，也不会在主会话里留下任何消息。侧边栏是独立 Session，不会自动合并主会话；自动上下文只提供最近/增量参考，手动引用用于精确指定要带过去的轮次。
- **主会话总结**：总结由本地事件整理，不额外调用模型；包含主会话标题、最近轮次、每轮问题与回答要点、工具动作、最后一次回答和已有的 `compaction/summary`。如果打开了较早的侧边栏历史，会额外加载最多两页主会话旧消息；仍可能少于完整历史，草稿里会注明“更早历史未加载”。
- **选中文本提问（与 ask-selection 联动）**：安装 `ask-selection` 后，在主会话消息里选中文字，浮条里的 `在侧边栏中提问` 会通过客户端桥接调用本插件。默认把选中原文追加到**当前打开的侧边栏**草稿；没有打开的侧边栏才新建。不会自动发送，也不会另开一个只读的 ask-selection 标签；新侧边栏仍进入本插件的历史记录。手动新建侧边栏仍用 dock 的 `+ 侧边栏`。
- **历史移除**：历史弹层每行右侧的 `×` 会先展开“移除这条历史入口？”确认；确认后才把该侧边栏从当前主会话的历史映射中移除（并关闭对应标签），但**不删除子 Session**；适合清理入口，不适合删除对话内容。
- **独立模型**：子会话的模型选择是 per-session 的。子会话有明确选择后，主会话改模型不会影响它；子会话改模型也不会改主会话。
- **权限独立**：权限模式、计划模式、附件、停止/排队都走标准 composer，作用域是当前子会话。
- **刷新恢复**：右侧栏标签的地址（`contentId`）会被记住，并通过 localStorage 映射回子会话；刷新后标签、标题、对话都能恢复。
- **入口**：
  - 主会话标题旁的 `+ 侧边栏`；
  - 主会话输入框下方/上方的 `+ 侧边栏` 与已创建 chip（chip 条在窄屏可横向滚动，操作按钮固定在右侧）；
  - 左侧栏底部的 `+ 侧边栏` 和 `历史`：New Session 页也可用；新建会挂到当前空白主会话（没有主会话时先建一个），历史可恢复之前关闭的侧边栏。左下角历史弹层使用固定定位，避免被窄侧栏的 `overflow:hidden` 裁切。
- **打开即输入**：新建或切换侧边栏标签后，焦点会自动进入该标签的 composer；空白标签顶部会显示“独立会话，不会写入主会话”，避免误以为消息发到了主会话。
- **关闭入口**：chip 上的 `×` 关闭对应标签并把入口收进 `历史`，**不会删除子会话**；恢复后仍是原来的对话。子会话本身也仍可在 Session 列表里找到。历史条目右侧的 `×` 会先要求确认，确认后才移除历史映射，同样保留子 Session。
- **运行提示**：dock 会显示当前运行中的侧边栏数量（软提示，不硬性阻止）。

## 结构

```text
sidebar-agent/
├── package.json          # DSH bundle + client 声明
├── cordis.patch.yml      # 插入 sidebar-agent 条目
├── index.js              # Host 侧：主会话上下文初始包 + 增量注入
├── client.js             # 全部 UI / 会话编排
├── locale/{zh,en}.json
├── icon.svg
└── README.md
```

关键实现：

- 子会话 id：`session-sb-<base64url(parentSessionId)>.<uuid>`，Host 的 `parentOf()` 从中解出主会话；旧的无标记侧边栏不会被自动注入。
- 自动上下文：Host 监听 `agent/pre-step`，只在每轮第一步、且该步包含真实人类消息时执行。首次读取主会话事件并生成初始包；之后只取 `seq > 上次同步位置` 的事件生成增量包。注入消息的 `source.kind` 是 `sidebar-agent`，不会追加到主会话，也不会触发主会话运行。注入消息的 `source.sections` 里带一个 `sidebar-agent-sync` 同步位置；Host 模块重载后可从侧边栏自己的日志里恢复该位置，避免重复注入整包历史。
- 注入位置：独立上下文消息插在人类提问之前，因此不会把大段上下文写进用户消息正文；侧边栏当前嵌入式视图不会把注入正文当普通提问展示。
- 上下文读取：优先 `ctx.sessions.get(parentId).snapshotEvents()`；主会话未激活时回退 `sessionQuery.readSession(parentId)`。所有格式化和截断都在 Host 完成，客户端不参与。
- 入口类型：主会话标题/composer 走 `conversation.session.header.actions` 与 `conversation.composer.dock`；全局入口走 `sidebar.footer.action`，在 New Session 页也会显示。
- 标签类型：`ctx.sidebarRightTabs.register({ id, kind: 'sidebaragent', multiple: true, title })`。
- 打开标签：`ctx.sidebarRight.openTabIn(parentSessionId, 'sidebaragent', { params: { childId, parentId, label } })`。
- 标签体：`useTabInfo()` 取 `contentId` / `navigation.params`，`ctx.sessions.retain(childId)` 后套 `SessionProvider`，渲染 `sidebar.agent.conversation`。
- 会话体：`renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, ...)`，内部固定渲染 `conversation.session` 的 `chat` 视图，避免主会话的 `conversation.session.header` 重复出现。
- 标签恢复：dock 布局刷新后只保留 `contentId`，所以打开标签时通过标签类型的 `title(address)` 回调把 `address -> { childId, parentId, label }` 写进 localStorage；刷新后标签体与标题从该映射恢复。
- 引用上下文：`ctx.sessions.retain(parentId, { source: 'sidebarChat' })` 读取 `eventSource.getSnapshot()`，按 `turn/start`、`user/message`、`assistant/message`、`tool/call`、`compaction/summary` 重建轮次；只有 `source.kind === 'user'` 的 user 事件算人类提问，合成注入/压缩替换不会混入。DOM 扫描只作为 Session 尚未 ready 时的 fallback。总结按钮会调用 `loadOlder()` 最多两页旧历史。
- 历史弹层：主会话 dock 内用 absolute 定位；左侧栏 footer 入口传入 `fixed`，用触发按钮的 `getBoundingClientRect()` 计算 fixed 坐标，绕过 `.sidebarCol { overflow:hidden }` 的裁切。
- 选区桥接：主会话 dock 注册 `window.__DSH_SIDEBAR_AGENT_BRIDGE__`；`ask-selection` 的浮条优先调用 `quoteSelection(payload)`。桥接内部复用 `createThread` + `appendToThreadDraft`，走正常 Session composer，不创建额外只读线程。

## localStorage 键

| 键 | 值 |
| --- | --- |
| `dsh.sidebar-agent.v1:<parentSessionId>` | `[{ id, label, index, createdAt, hidden?, closedAt? }]` |
| `dsh.sidebar-agent.child.v1:<childSessionId>` | 父会话 id（用于在子会话里隐藏入口） |
| `dsh.sidebar-agent.tab.v1:<contentId>` | `{ childId, parentId, label, updatedAt }`（刷新恢复） |

这些键只在浏览器本地，不进入 Session 日志；换浏览器/清 localStorage 后，已有标签会失去与子会话的映射。

## 安装 / 更新

### 从 GitHub 安装

在 DSH 的 **Plugins / 插件** 页面点 **Add plugin / 添加插件**，填入：

```text
https://github.com/liaosiqian/dsh-sidebar-agent.git
```

需要固定版本时使用 tag：

```text
https://github.com/liaosiqian/dsh-sidebar-agent.git#v0.1.0
```

也可以让 Agent 执行：

```text
plugin_manager
action: install_bundle
target: https://github.com/liaosiqian/dsh-sidebar-agent.git
```

安装后刷新页面。若结果是 `restart-required`，重启 DSH。只改 `client.js` 时刷新页面即可；改 `index.js`（Host 侧）后还需要在 Plugin Manager 里禁用再启用该插件，或重启 DSH，让 Host 模块重新加载。

> 本仓库只包含 `sidebar-agent`。如果还需要“选中文字 → 在侧边栏中提问”，请另外安装 `ask-selection`；两个插件装在同一个 profile 即可。

### 本地开发

在插件目录执行 `plugin_manager install_bundle`，或从 Plugins 页面选择本地目录。本地路径安装通常会创建 `link:` 依赖，移动或删除源目录后需要重新安装。

### 更新

修改代码并推送新 tag 后，在 Plugins 页面先移除旧版本，再安装新 tag；侧边栏的 localStorage 键和子 Session 日志不会因为插件更新而删除。

## 已知限制

- 子会话首轮后出现在 Session 列表，不属于主会话的消息流。
- 自动上下文只对带 `session-sb-` 标记的新侧边栏生效；升级前创建、id 里没有父会话标记的旧侧边栏不会自动注入。可以新建侧边栏继续问，旧对话仍可正常使用。
- 创建时继承父会话的 `agentPreset`（工具集）；创建后不能在该标签内切换 preset，只能换模型/权限/计划。
- 标签与历史入口的映射只在当前浏览器 localStorage；换浏览器打开同一 Session 不会自动恢复侧边栏 chip，但子会话本身仍在 Session 列表里。
- 关闭 chip 不删除子会话，避免误删对话；历史条目右侧的 `×` 只移除历史映射，也不删除子会话。真正删除对话需要到 Session 列表操作。
- `引用主会话` 引用的是主会话里的**整条用户提问**或**事件摘要**，不是任意选中片段；选中片段请用 `ask-selection` 的浮条，并确认 sidebar-agent 已安装，才会进入当前侧边栏。
- 选区提问目前以**引用文本块**插入草稿，不是附件 chip；草稿只带选中原文，但 Host 会优先补上选中内容所属轮次附近的主会话对话，再补最近轮次；如果无法解析所属轮次，则回退最近 6 轮。需要精确控制时仍可用 `引用主会话`。
- 选区提问默认复用打开的侧边栏；浮条本身没有“新建侧边栏”按钮，需要新侧边栏时先用 dock 的 `+ 侧边栏` 打开一个再选。
- 引用范围由弹层里的下拉框控制；`问题 + 完整回答 + 上下文` 会插入整条提问、该轮回答、相邻轮次和最近 5 轮脉络，`问题 + 完整回答` 只插入前两项，`仅问题` 只插入问题。超长内容会截断，并在草稿里标注 `reference-only`。
- 总结来自本地事件整理，不是模型再总结；事件窗口只包含当前已加载的历史。总结按钮会最多加载两页旧历史，但很长的会话仍可能显示“更早历史未加载”。已有压缩摘要会一并带入，不会重复展开被压缩掉的原文。
- 引用默认追加到当前打开的侧边栏；没有打开的侧边栏才新建。引用到已关闭的侧边栏时会自动重新打开标签；如果目标侧边栏正在提交，会提示稍后再试，不会强行插入。
- New Session 页没有主会话 composer 的 dock，侧边栏历史从左侧栏底部的 `历史` 进入；关闭标签后可从那里恢复。
- 历史记录只存在当前浏览器的 localStorage；换浏览器或清 localStorage 后，标签与历史的映射会丢失，但子 Session 仍在 Session 列表里。
