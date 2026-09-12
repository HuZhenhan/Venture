# AI_COLLAB_SPEC

## UI 组件使用强制规范

### 禁止行为（违反即需重构）
1. ❌ **禁止创建 `-1`、`-2` 等后缀文件**
   - 如果组件已存在，直接修改或创建新名称的组件
   - 检测到 Agent 创建后缀文件时立即提醒

2. ❌ **禁止使用品牌/风格命名组件**
   - 错误：`AppleToggle`、`GoogleButton`、`MaterialCard`
   - 正确：`Toggle`、`Button`、`Card`

3. ❌ **禁止使用无意义前缀**
   - 错误：`CustomSelect`、`MyButton`、`NewInput`
   - 正确：`Select`、`Button`、`Input`

4. ❌ **禁止在业务组件中直接使用 `motion.button`**
   - 错误：每次都写 `<motion.button whileTap={{ scale: 0.92 }}>`
   - 正确：使用 `<Button>`、`<IconButton>` 或 `<TapScale>`

5. ❌ **禁止硬编码动画参数**
   - 错误：`whileTap={{ scale: 0.92 }}`、`transition={{ duration: 0.6 }}`
   - 正确：使用 `AnimationPresets.tap`、`EasingPresets.apple`

### 推荐实践
1. ✅ 新建按钮时，优先使用 `<Button>` 组件
2. ✅ 需要图标按钮时，使用 `<IconButton>`
3. ✅ 需要自定义动画时，使用 `<TapScale>`、`<FadeIn>` 等 Wrapper
4. ✅ 组件命名遵循"功能描述"而非"风格描述"

### 组件选择决策树
```
需要可点击的元素？
├─ 纯图标 → IconButton
├─ 文字 + 图标 → Button
├─ 自定义样式的按钮 → TapScale + 自定义 className
└─ 特殊交互（如拖拽） → 手写 motion 组件

需要淡入淡出？
├─ 页面加载时 → FadeIn
├─ 条件渲染时 → ConditionalFade
└─ 复杂序列动画 → 手写 motion 组件

需要开关 → Toggle（原 AppleToggle，已废弃）
需要下拉 → Select（原 CustomSelect，已废弃）
需要徽章 → Badge
```

## 通用组件清单

- `SettingsSidebar` - 系统偏好与 Provider 设置入口 - 通过 `SettingsSidebarProps` 传入开关状态、宽度和 Provider 列表。
- `ProviderConfigModal` - Provider Adapter 配置弹窗 - 输入 `editingConfig` 与开关状态；输出 `providerKind`、`baseUrl`、加密 API key、模型列表和 `ModelCapabilities` 能力声明。
- `McpSettingsPanel` - MCP server 状态与基础配置入口 - 通过 `GET/PUT /api/mcp/servers` 读取状态、编辑 JSON 配置并保存；输入为 `McpServerConfig[]`，输出为 server 状态列表。
- `PreferencesPanel` - 系统偏好、统一存储迁移和权限授权管理面板 - 通过 `migrationSummary`、`migrationStatus`、`approvedToolSignatures` 展示迁移状态与当前会话永久工具授权，并支持逐条/全部撤销。
- `BrowserPanel` - 桌面端内置浏览器面板 - 通过 `isOpen`、`isNativeViewHidden` 控制 Electron 原生 BrowserView 显示；从 preferences 恢复 `browser.currentUrl`、导航可用状态和 `lastOpenedAt`，布局变化以 `BOUNDS_SYNC_DEBOUNCE_MS` 防抖同步 bounds；加载失败、证书错误和被拦截导航通过面板底部错误条反馈；Web 环境显示可恢复占位和默认页回退按钮。
- `BrowserSummaryButton` - 页面文本摘取入口 - 无输入参数；点击后触发本地 DOM 可见文本摘取预览动画，执行期间自动禁用以防重复触发；该能力不调用 LLM，不展示为 AI 总结。
- `BrowserSummaryPanel` - 页面文本摘取结果面板 - 输入 `BrowserSummary` 与 `onClose`；输出按文本块渲染 DOM 摘取结果，并明确标注“不是 AI 总结”。
- `CustomTitleBar` - Electron 桌面端窗口控制按钮组 - 嵌入融合顶栏，只负责最小化、最大化、关闭窗口。
- `RightPanelRail` - 右侧页面入口按钮组 - 保持桌面端右侧竖向 rail 样式，用于聊天、浏览器、用量和设置切换；窄屏时入口同步切换当前单页内容，聊天入口用于恢复已收起的对话区。
- `MainLayout` - 主工作区自适应布局容器 - 根据最近激活视图分配聊天、浏览器、设置和用量面板空间；始终为右 rail 预留宽度，并在原生 BrowserView 不可见时走隐藏路径。
- `ChangeReviewPanel` - 文件历史变更审阅面板 - 通过 `chatId`、`turnId`、`onClose` 打开指定 turn 的 file_history 记录，支持 record diff、整轮回退、部分记录回退、GC 手动触发和 SAF 真实状态展示。
- `RawMessageContent` - 调试态原始消息内容渲染 - 由 `/debug OriginalContent true|false` 控制，直接展示 `Message.content`，跳过 Markdown 与引用 pill 渲染；由 `/debug RawResponse true|false` 控制时展示上游 reasoning/content delta 原文。
- `MessageContentRenderer` - 对话协议内容统一解析与递归渲染 - 新消息优先消费 `Message.content` 中的 `[thinking]`、`[error]`、`[attachment]` 节点，旧消息继续兼容 `Message.reasoning` 与 `segments`。
- `ExternalCapabilitiesPanel` - 外部能力入口与 Git 只读状态面板 - 无输入参数；调用 `getExternalCapabilities()` 展示 Git 工作区 changed files，并将 SFH/Office/语义视觉标注为预留能力。
- `WorkflowCanvas` - 子代理 workflow DAG 运行态画布 - 无输入参数；从 `useSubagentStore.workflowRuns` 读取真实节点/边状态，支持 pending/queued/running/completed/failed/skipped/cancelled 与边错误 reason 展示。
- `SkillPanel` - Skill 列表/详情生命周期入口 - 通过 `refresh/importZip/select/create` 串联 discovery、zip 导入、详情编辑和设置入口；zip 导入后展示本地静态检查摘要。
- `SkillDetailView` - Skill 详情与资源文件管理 - 输入 `startInEdit`；读取选中 Skill、文件树和 review 信息，支持 `SKILL.md` 编辑、资源文件新建/编辑/删除和本地静态校验。
- `SkillCreateDialog` - Skill 创建表单 - 输入 `onClose`；输出 `CreateSkillPayload`，对名称、描述、触发条件进行字段级校验。
- `PermissionSelector` - 权限 Profile 选择器 - 通过旧 `ToolPermissionLevel` 存储兼容映射到统一 `PermissionProfile`；显示 `NoSandbox`，不展示未实现的 WASM/Sandboxie 能力。
- `ToolApprovalCard` - 工具权限审批卡 - 通过 `ToolCall` 展示风险等级、请求原因、影响范围、参数明细，并提供本次/本会话/永久/拒绝操作。
- `SubagentPermissionBanner` - 子代理权限审批横幅 - 通过 `buildPermissionRequestCopy({ actor: 'subagent', toolName, reason, timeoutSeconds })` 与工具审批卡共享审批文案结构，并展示后端 SSE 附带的风险等级和影响范围。

## 对话内容协议

- 权威持久化字段：`Message.content`，正文、模型 API 实际返回的 reasoning、错误和附件均以原始标签字符串保存；`Message.rawResponse` 仅保存本次模型输出的未归一化 delta，用于调试，不参与模型上下文。
- 标签格式：`[thinking]...[/thinking]`、`[error][code]...[/code][message]...[/message][/error]`、`[attachment]...[/attachment]`；标签允许嵌套。
- `src/app/utils/messageContentProtocol.ts`：负责白名单解析、嵌套节点序列化、流式未闭合标签容错、错误/附件字段编解码和旧 blocks 运行时适配。
- `src/app/store/chatState.ts`：reasoning delta 经 `appendThinkingContent` 写入 `[thinking]` 节点，正文 delta 经 `appendVisibleContent` 写入普通文本；`Message.reasoning` 不再作为新消息写入目标。
- `segments` 仅保留旧消息渲染兼容和工具调用回传边界；新消息的 reasoning/正文展示以 `Message.content` 协议为准，不以 `segments` 作为渲染权威。
- `blocks` 仅保留尚未纳入协议的交互卡片，并作为旧消息适配来源；新消息不再用 blocks 承载 thinking、error、attachment。
- `Message.usage` 仅承载后端从上游真实返回的 usage/cache 字段，包括 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`prompt_tokens_details.cached_tokens` 和 `completion_tokens_details.reasoning_tokens`；上游未返回时不得伪造。
- 后端事件仍是传输帧，不作为第二种持久化格式；进入前端状态后必须归一化到 `Message.content`。
- 限制：前端只显示模型 API 实际返回的 reasoning；供应商未返回的内部推理无法恢复。

## 设计规范

- 主色值：沿用 Tailwind/CSS 变量 `primary`、`background`、`foreground`、`border`。
- 辅助色值：设置卡片使用 `bg-background/50`、禁用按钮使用 `bg-muted/60`。
- 字体大小：设置标题 `13px`，说明文字 `11px`，迁移按钮 `12px`。
- 元素间距：设置区块 `space-y-4`，迁移卡片内边距 `p-4`，按钮圆角 `rounded-2xl`。
- 按钮样式：可用状态使用 `border bg-background hover:bg-muted/50`，禁用状态使用 `cursor-not-allowed bg-muted/60 text-muted-foreground`。
- 桌面融合顶栏：左侧栏延伸至窗口顶部，`Venture AI` 作为品牌标题；对话标题、模式切换和窗口按钮统一放入 `52px` 顶栏，右侧页面入口保持原右侧竖向 rail，窗口按钮悬停使用 `hover:bg-muted/70`。
- 普通助手 Markdown 文本：通过 `MarkdownContent` 的 `className="ml-[8px]"` 增加 `8px` 左偏移；用户消息、思考链和其他卡片保持原位置。
- 浏览器面板错误反馈：加载/证书/拦截错误使用底部浮层 `border-destructive/30 bg-background/95 text-destructive`，Web 环境占位使用 `rounded-2xl border bg-muted/20 p-5` 并提供恢复默认页操作。
- 权限 Profile：选择器标题使用“权限 Profile”，默认展示 `NoSandbox`；`ProcessIsolationReserved` / `WasmReserved` 仅作为后端 seam，未实现时必须返回 unsupported，不在 UI 宣称可用。

## 项目架构

- `scripts/dev-control.js`：开发态进程编排入口，接管 `npm run dev`，管理 Web Vite、桌面 Vite、Electron 桌面壳，并支持命令行交互重启。
- `electron/main.cjs`：Electron 主进程、桌面窗口生命周期、后端子进程生命周期；开发态关闭全部窗口时保持 Electron 和后端进程存活。
- `electron/browser-summary-preview.cjs`：BrowserView DOM 可见文本摘取脚本，只做本地文本分块和扫描动画，不调用 chat/provider 或 LLM 总结。
- `backend/src/app_data.rs`：统一应用数据文件存储，路径为 Windows `%APPDATA%/Venture/app-data.json`。
- `backend/src/config.rs`：Provider 加密配置存储，路径迁移到 `%APPDATA%/Venture/config.enc`，启动时增量合并旧本地目录配置。
- `backend/src/provider_adapter.rs`：模型 Provider Adapter seam，按 `ProviderKind` 隔离 OpenAI-compatible、DeepSeek 和未来供应商的请求构造、流式响应解析、能力声明与配置校验。
- `backend/src/session/mod.rs`：主会话事件存储，按 `%APPDATA%/Venture/sessions/<chat_id>/events.jsonl` 追加 event-sourced JSONL，并保留 `ResumeSessionRequest`、`ForkSessionRequest`、`RewindSessionRequest` 类型。
- `backend/src/external_capabilities.rs`：外部能力探测模块；首期只读执行 `git rev-parse` 与 `git status --porcelain=v1 -b`，不包含 commit/reset/checkout 等写操作。
- `backend/src/mcp/`：最小 MCP registry runtime，包含 `config`、`registry`、`liveness`、`schema` 子模块；当前只做配置、状态探测和工具 schema 占位映射，不执行 MCP 工具调用。
- `backend/src/subagent/coordinator.rs`：子代理 actor、并发准入队列、SSE 事件广播、crash scan 恢复终态注入和取消终态保护。
- `backend/src/subagent/workflow.rs`：Rhai workflow 执行器，运行于独立线程，通过 tokio bridge 调度子代理并推送 `workflow_dag` 运行态投影。
- `backend/src/subagent/worktree.rs`：worktree 隔离创建/清理；桌面端创建失败显式失败，避免静默落回共享目录造成误导状态。
- `src/app/services/appDataService.ts`：前端统一存储 API、旧 localStorage 读取和迁移服务。
- `src/app/services/sessionService.ts`：前端 session debug/恢复数据读取服务，按 `chatId` 拉取后端主会话事件流。
- `src/app/store/useChatStore.ts`：聊天和 activeChat 后端优先持久化，失败时才回退 localStorage；`approvedToolCalls` 保存当前会话永久工具授权，`sessionApprovedToolCalls` 保存运行期会话授权且不落盘。
- `src/app/store/useSubagentStore.ts`：子代理 SSE 状态、权限请求、完成缓冲和 workflow DAG 投影状态。
- `src/app/store/usePreferencesStore.ts`：偏好设置后端优先持久化。
- `src/app/store/useThemeStore.ts`：主题后端优先持久化。
- `backend/src/file_history/*`：文件历史能力核心，提供 ChangeJournal、VersionStore、rollback、GC 与 SAF proxy；前端审阅与回退必须通过这些 API，不绕过 file_history 直接改文件。
- `src/app/components/ChangeReviewPanel.tsx`：右侧 overlay 变更审阅入口，通过右 rail 或 `/changes [turn_id]` 本地命令打开。
- `backend/src/tool_registry.rs`：内置工具注册表定义层，集中维护工具 schema、风险等级、权限策略、executor 类型与 file_history 审计影响；schema 生成只读取定义，不触发工具执行。
- `backend/src/tools.rs`：工具执行适配层，先解析 registry 定义，再分发到已迁移工具 executor 或 legacy adapter；Write/Edit 的 ChangeRecord 仍只在实际写入成功后提交。
- `backend/src/permission_profile.rs`：统一权限 Profile、权限主体/对象、sandbox seam 和本地 `%APPDATA%/Venture/permission-audit.jsonl` 审计记录；工具执行前统一判定 `readFiles/writeFiles/executeCommands/networkAccess/mcpAccess/skillAccess/subagentAccess`。
- `src/app/services/toolService.ts`：工具执行 API 与工具 registry 元数据缓存，提供 `/api/tools/schema` 前端消费类型。
- `src/app/sdk`：本地 REST/SSE 的最小 TypeScript SDK，导出 `VentureClient`、DTO 类型和 `VentureApiError`，供前端 service、CLI/RPC 适配层渐进复用。
- `scripts/venture-jsonl.mjs`：最小 Node JSONL CLI，逐行读取 `{ id, method, params }` 并转发到本地 REST API。
- `docs/api-harness.md`：REST/SSE 盘点、CLI JSONL 协议和 JSON-RPC 渐进路线文档。

## 工具函数 / 常量

- `restartBackendForDev` - 开发态重启后端进程 - 参数：无 - 返回后端重启 Promise，串行防止重复重启。
- `reloadFrontendForDev` - 开发态重载桌面前端 - 参数：无 - 返回值：无；无窗口时会重新创建桌面窗口。
- `scripts/dev-control.js` 交互命令 - 开发态进程控制 - 参数：`restart frontend` / `restart backend` / `restart all` 或 `rs fe` / `rs be` / `rs all` - 返回命令行执行日志。
- `handleExistingDevControllers` - Windows 开发进程单实例预检 - 参数：无 - 返回 Promise；启动服务前检测其他 `scripts/dev-control.js`（兼容空格后的相对脚本路径），英文询问后仅在输入 `y` 时使用 `taskkill /T /F` 结束旧进程树，其他输入保留旧进程并继续启动。
- `selectActiveWorkspaceView` - 读取当前主工作区视图 - 参数：`LayoutState` - 返回 `WorkspaceView`，供主布局和面板状态机统一判断活动页面。
- `selectResponsiveLayout` - 计算自适应主布局 - 参数：布局打开状态、最近激活视图和 viewport 宽度 - 返回聊天/浏览器/设置/用量的有效宽度、参与布局状态和单页宽度；计算时固定扣除 `RIGHT_RAIL_WIDTH`。
- `BROWSER_PANEL_WIDTH` / `MIN_BROWSER_WIDTH` / `MIN_SETTINGS_WIDTH` / `COLLAPSED_CHAT_WIDTH` - 自适应面板宽度边界 - 值：`500` / `360` / `320` / `0` - 用途：保证 rail 入口打开后对应内容有可用尺寸，并支持窄屏单页收起聊天。
- `DEFAULT_BROWSER_PREFERENCES` - 浏览器偏好默认值 - 值：`currentUrl=https://www.bing.com`、`canGoBack=false`、`canGoForward=false`、`lastOpenedAt=null` - 用途：复用 app-data preferences 恢复 BrowserPanel 状态。
- `BOUNDS_SYNC_DEBOUNCE_MS` - BrowserView bounds 同步防抖时间 - 值：`80` - 用途：降低布局动画或 resize 时频繁 `browser-set-bounds` 导致的闪烁。
- `selectResponsiveLayout` - 计算自适应主布局 - 参数：布局打开状态、最近激活视图和 viewport 宽度 - 返回聊天/浏览器/设置/用量的有效宽度、参与布局状态和单页宽度；计算时固定扣除 `RIGHT_RAIL_WIDTH`。
- `BROWSER_PANEL_WIDTH` / `MIN_BROWSER_WIDTH` / `MIN_SETTINGS_WIDTH` / `COLLAPSED_CHAT_WIDTH` - 自适应面板宽度边界 - 值：`500` / `360` / `320` / `0` - 用途：保证 rail 入口打开后对应内容有可用尺寸，并支持窄屏单页收起聊天。
- `selectResponsiveLayout` - 计算自适应主布局 - 参数：布局打开状态、最近激活视图和 viewport 宽度 - 返回聊天/浏览器/设置/用量的有效宽度、参与布局状态和单页宽度；计算时固定扣除 `RIGHT_RAIL_WIDTH`。
- `BROWSER_PANEL_WIDTH` / `MIN_BROWSER_WIDTH` / `MIN_SETTINGS_WIDTH` / `COLLAPSED_CHAT_WIDTH` - 自适应面板宽度边界 - 值：`500` / `360` / `320` / `0` - 用途：保证 rail 入口打开后对应内容有可用尺寸，并支持窄屏单页收起聊天。
- `selectResponsiveLayout` - 计算自适应主布局 - 参数：布局打开状态、最近激活视图和 viewport 宽度 - 返回聊天/浏览器/设置/用量的有效宽度、参与布局状态和单页宽度；计算时固定扣除 `RIGHT_RAIL_WIDTH`。
- `BROWSER_PANEL_WIDTH` / `MIN_BROWSER_WIDTH` / `MIN_SETTINGS_WIDTH` / `COLLAPSED_CHAT_WIDTH` - 自适应面板宽度边界 - 值：`500` / `360` / `320` / `0` - 用途：保证 rail 入口打开后对应内容有可用尺寸，并支持窄屏单页收起聊天。
- `app_data::app_data_dir` - 统一数据目录 - 参数：无 - 返回 `%APPDATA%/Venture`，非 Windows 环境回退到 `ProjectDirs::data_dir()`。
- `AppDataStore::patch` - 增量更新统一应用数据 - 参数：`AppDataPatch` - 返回更新后的 `AppDataFile`。
- `AppDataStore::migrate` - 迁移来源数据 - 参数：`MigrateAppDataRequest` - 返回合并后的 `AppDataFile`；聊天按 `id` 增量合并，设置覆盖。
- `readLegacyLocalData` - 读取当前 origin 旧 localStorage - 参数：无 - 返回 `AppDataPatch`。
- `migrateLegacyLocalData` - 将当前 origin 旧数据提交给后端迁移 - 参数：无 - 返回统一存储中的 `AppData`。
- `resolveEnabledModelSelection` - 生成前解析可用模型 - 参数：`apiConfigs`、可选 `modelId` - 返回匹配的启用 Provider/模型；未传模型时回退第一个启用模型。
- `DEFAULT_CHAT_TEMPERATURE` - 主聊天默认采样温度 - 值：`0.8` - 用途：避免同一上下文重新生成时过度确定性。
- `parseRequestErrorDetails` - 解析旧版请求错误详情文本 - 参数：`content` - 返回请求错误详情对象或 `null`，仅用于旧 blocks 兼容。
- `parseMessageContent` - 解析统一消息标签 - 参数：`content` - 返回可递归遍历的 `MessageContentNode[]`，对未闭合流式标签保留临时节点；失配闭合标签丢弃，防止内部协议标记泄漏到正文。
- `appDataBackendUnavailable` - app-data 后端 404 熔断状态 - 值：当前页面生命周期内的布尔状态 - 用途：后端缺少路由时切换 localStorage，避免重复请求和控制台刷屏。
- `adaptLegacyMessageContent` - 旧消息运行时适配 - 参数：`Message` - 返回统一标签字符串，不改写历史存储。
- `appendThinkingContent` / `appendVisibleContent` - 流式内容增量归一化 - 参数：当前 `content`、delta - 返回追加后的统一标签内容；清洗上游重复输出的内部协议标签，避免 `[thinking]` 等标记泄漏到普通正文。
- `scripts/validate-message-content-protocol.mjs` - 消息内容协议最小验证 - 参数：无 - 返回命令行断言结果；覆盖 thinking 追加、正文 delta 标签清洗、旧失配闭合标签丢弃。
- `buildChatMessageContentFromProtocol` - 从统一消息内容构建模型请求 - 参数：`content`、`modelSupportsMultimodal` - 返回文本或多模态消息 parts。
- `parseDebugCommand` - 解析对话输入调试命令 - 参数：`input` - 返回 `{ module, enabled }` 或 `null`；支持 `/debug OriginalContent true|false`、`/debug RawResponse true|false`、`/debug OccupancyMonitor true|false`，并兼容 `ture/flase`。
- `/changes [turn_id]` 本地命令 - 打开文件变更审阅 - 参数：可选 turn/user message ID - 返回值：无；未传 turn 时使用当前会话最近一条用户消息作为 turn。
- `adapter_for_kind` - 选择后端 Provider adapter - 参数：`ProviderKind` - 返回 `ChatProviderAdapter`；默认 `openai_compatible`，显式支持 `deepseek`。
- `ChatProviderAdapter::build_request` - 构造上游聊天请求 - 参数：`ProviderRequestContext` - 返回 `{ endpoint, body }`，OpenAI-compatible 保持 `${baseUrl}/chat/completions` 与 `stream_options.include_usage` 行为。
- `ChatProviderAdapter::parse_stream_line` - 解析上游 SSE 行 - 参数：单行 SSE 与 `ProviderStreamState` - 返回 Venture 内部 `ProviderStreamChunk`；DeepSeek adapter 隔离 `reasoning_content`、usage 与错误字段处理。
- `resolveModelCapabilities` - 读取模型能力声明 - 参数：`AIModel`、可选 Provider 上下文 - 返回 `{ supportsReasoning, supportsTools, supportsMultimodal, contextWindow }`，兼容旧 `supportsMultimodal` 字段。
- `PROVIDER_KIND_OPTIONS` / `PROVIDER_KIND_LABELS` - Provider 类型 UI 常量 - 值：`openai_compatible`、`deepseek` - 用途：设置页 Provider 类型选择与展示。
- `toolCallAccumulator` - 前端工具调用增量合并器 - 参数：流式 `tool_call_start` / `tool_call_delta` 事件 - 返回完整 `ToolCall`；缺失工具名、缺失调用 ID 或非法 JSON 参数时阻止执行并生成明确失败信息。
- `VentureClient` - 本地 API SDK 客户端 - 参数：`{ baseUrl, fetchImpl? }` - 返回封装后的 `health`、Provider、chat stream、tool execute、file changes、skill list 方法。
- `VentureApiError` - SDK 统一错误类型 - 参数：`{ status, code, message, trace? }` - 返回携带 HTTP 状态、业务错误码、可读消息和追踪上下文的 Error 实例。
- `scripts/venture-jsonl.mjs` CLI - 本地 JSONL harness - 参数：stdin JSONL `{ id, method, params }`、环境变量 `VENTURE_API_BASE_URL` - 返回 stdout JSONL `{ id, ok, result? | error? }`。
- `resolve_resource_path` - Skill 资源路径安全解析 - 参数：Skill 目录、相对路径、是否必须存在 - 返回目录内安全路径；拒绝绝对路径、`..`、超长路径和直接写入 `SKILL.md`。
- `static_review_for_info` - Skill 本地静态检查 - 参数：`SkillInfo` - 返回 `SkillReviewReport`；检查权限风险、缺失 frontmatter、资源大小和潜在危险命令，明确不代表 LLM 审计。
- `ExternalCapability` - 外部能力状态类型 - 参数：`id` 为 `git/sfh/office/vision/browser`，`status` 为 `available/unavailable/reserved` - 返回值：用于 UI 清晰区分可用能力、不可用能力和占位入口。
- `getExternalCapabilities` - 读取外部能力探测结果 - 参数：无 - 返回 `{ workspaceRoot?, capabilities, git }`；Git 列表仅表示工作区状态，不等同于 file_history turn 级变更审阅。
- `mcp::registry::tool_specs` - 生成 MCP 外部工具快照 - 参数：`ConfigStore` - 返回 `ToolSpec[]`；所有 MCP 工具默认 `requiresApproval=true`，未实现真实调用时返回占位 schema。
- `mcp::liveness::probe_config` - 计算 MCP server 状态 - 参数：`McpServerConfig` - 返回 `disabled/configured/offline/error` 等状态；stdio 只做配置探测，HTTP/SSE 明确标记为未连接。
- `CoordinatorHandle::crash_recovered` - 注入启动崩溃扫描结果 - 参数：`CrashScanReport` - 返回值：无；将未完成任务标记为可恢复 failed 并进入 SSE/完成缓冲。
- `CoordinatorHandle::workflow_dag_event` - 推送 workflow DAG 增量事件 - 参数：`chat_id`、`run_id`、`payload` - 返回值：无；payload 包含 `nodes` 和 `edges`。
- `workflow::cancel_run` - 记录 workflow 取消标记 - 参数：`run_id` - 返回值：无；阻止同一 run 后续继续 spawn 子代理。
- `PermissionProfile` - 统一权限配置 - 参数字段：`readFiles/writeFiles/executeCommands/networkAccess/mcpAccess/skillAccess/subagentAccess/sandbox` - 返回：后端执行前按能力维度判定 `allow/ask/deny/audit_only`。
- `getPermissionProfileForLevel` - 旧权限等级兼容映射 - 参数：`ToolPermissionLevel` - 返回 `PermissionProfile`；默认 `general` 对写入、命令、网络、MCP、Skill、子代理均需确认，`auto_review` 对低风险读和 Skill 使用 `audit_only`。
- `buildPermissionRequestCopy` - 权限请求统一文案 - 参数：`actor`、`toolName`、可选 `reason/timeoutSeconds` - 返回标题、描述、参数标签和超时提示。
- `riskLevelForTool` / `impactSummaryForTool` - 权限审批 UI 元数据推断 - 参数：工具名、工具输入、可选后端元数据 - 返回低/中/高风险与影响范围文本。
- `SandboxSeam` - 沙箱能力 seam - 值：`NoSandbox` / `ProcessIsolationReserved` / `WasmReserved` - 用途：未实现隔离能力后端统一拒绝，UI 不声明可用。
- `SessionStore::append` - 追加主会话事件 - 参数：`chat_id`、`turn_id`、`SessionEventKind` - 返回落盘后的 `SessionEvent`，写入 JSONL。
- `SessionStore::list_events` - 读取主会话事件流 - 参数：`chat_id` - 返回按 JSONL 顺序解析的 `SessionEvent[]`。
- `events_from_venture_sse_bytes` - 从 Venture 内部 SSE 帧提取会话事件 - 参数：SSE bytes、可选助手消息 ID - 返回 delta、tool call start 或失败事件。
- `getSessionEvents` - 读取会话 debug/恢复事件 - 参数：`chatId` - 返回后端 `SessionEvent[]`。

## 标准化 API

- `GET /api/health` - SDK/CLI 健康检查 - 参数：无 - 返回 `{ status: "ok", version, nonce, pid, startedAt }`；状态：已实现。
- `GET /health` - 旧健康检查兼容路径 - 参数：无 - 返回同 `/api/health`；状态：已实现，保留给旧调用方。
- `GET /api/providers` - Provider 列表 - 参数：无 - 返回 `{ providers: VentureProvider[] }`，包含 `providerKind`、`models[].capabilities` 和兼容字段 `supportsMultimodal`；状态：已实现，已由 `modelConfigService` 通过 SDK 复用。
- `POST /api/providers` - 新增 Provider - 参数：`{ name, providerKind?, baseUrl, apiKey, models, inputContextWindow }`，`providerKind` 缺省为 `openai_compatible` - 返回 `{ provider }`；状态：已实现。
- `PATCH /api/providers/:id` - 更新 Provider - 参数：`{ name?, providerKind?, baseUrl?, apiKey?, models?, inputContextWindow? }`；`apiKey` 缺省不更新，空串清除 - 返回 `{ provider }`；状态：已实现。
- `DELETE /api/providers/:id` - 删除 Provider - 参数：路径 `id` - 返回 `{ success: true }`；状态：已实现。
- `POST /api/chat/stream` - 聊天 SSE 流 - 参数：`{ chatId?, turnMessageId?, assistantMessageId?, providerId?, modelId, messages, temperature?, maxTokens?, traceUpstream? }` - 经 `ChatProviderAdapter` 转换上游请求并返回统一 SSE `StreamEvent`；状态：已实现，携带 ID 时追加主会话事件。
- `GET /api/sessions/:chat_id/events` - 读取主会话事件流 - 参数：路径 `chat_id` - 返回 `{ events: SessionEvent[] }`；事件枚举采用 `event.type` tagged enum。
- `POST /api/tools/execute` - 执行工具并做后端权限兜底 - 参数：`{ tool, input, chatId, turnMessageId?, modelId?, permissionProfile, approvalGranted, toolCallId?, approvalScope?, userChoice? }` - 返回 `{ output, isError, structured? }`；权限拒绝时 `structured.permission.reason` 给出明确原因，SDK/JSONL CLI 已封装。
- `GET /api/permissions/audit` - 读取权限审计记录 - 参数：可选 `limit` - 返回 `{ records }`；记录来源为本地 `%APPDATA%/Venture/permission-audit.jsonl`。
- `POST /api/permissions/audit` - 记录未执行的权限决策 - 参数：`{ tool, input, chatId?, turnMessageId?, toolCallId?, permissionProfile, approvalScope?, userChoice }` - 返回 `{ success: true }`；用于用户拒绝或前端自动拒绝等不进入工具执行器的场景。
- `GET /api/files/changes` - 查询文件变更 - 参数：Query `{ turnId?, path? }` - 返回 `{ changes: ChangeRecordSummary[] }`；状态：已实现，SDK/JSONL CLI 已封装。
- `GET /api/skills` - Skill 列表 - 参数：无 - 返回 `{ skills, shadowed, errors, platform }`；每个 skill 携带 `lifecycleStatus`、权限和本地静态 `review`；状态：已实现，SDK/JSONL CLI 已封装。
- `POST /api/skills/import-zip` - 导入 zip Skill - 参数：`{ fileName, base64 }` - 返回 `{ imported, skill, validation }`；拒绝 zip slip、超大文件、缺失 `SKILL.md` 和重复 Skill。
- `POST /api/skills/:name/validate` - 本地静态校验 Skill - 参数：路径参数 `name` - 返回 `{ valid, status, review }`，仅代表静态检查，不伪装为模型审查。
- `GET /api/skills/:name/file?path=` - 读取资源文件 - 参数：Skill 名和相对资源路径 - 返回 `{ content }`；路径必须位于 Skill 目录内。
- `PUT /api/skills/:name/file?path=` - 新建或覆盖资源文件 - 参数：`{ content }` - 返回 `{ success }`；拒绝越权路径、目录路径、超大文件和直接写入 `SKILL.md`。
- `DELETE /api/skills/:name/file?path=` - 删除资源文件 - 参数：Skill 名和相对资源路径 - 返回 `{ success }`；只删除 Skill 目录内的普通资源文件。
- `GET /api/mcp/servers` - 读取 MCP server 配置和状态 - 参数：无 - 返回 `{ servers: [{ config, liveness, tools }] }`；状态：已实现，stdio 只配置探测，HTTP/SSE 不声明已连接。
- `PUT /api/mcp/servers` - 覆盖保存 MCP server 配置 - 参数：`{ servers: [{ id, name, transport, command?, url?, env, enabled, permissionScope }] }` - 返回 `{ servers }`；状态：已实现，`permissionScope` 仅允许 `ask/deny`。
- `POST /api/rpc` - JSON-RPC 单入口 - 参数：JSON-RPC 2.0 request - 返回 JSON-RPC 2.0 response；状态：预留，当前仅见 `docs/api-harness.md` 设计，不声明为完整实现。
- `GET /api/app-data` - 读取统一应用数据 - 参数：无 - 返回 `{ chats, activeChatId, preferences, theme, updatedAt }`。
- `PUT /api/app-data` - 覆盖统一应用数据 - 参数：完整 `AppDataFile` - 返回更新后的完整数据。
- `PATCH /api/app-data` - 增量更新统一应用数据 - 参数：`chats?`、`activeChatId?`、`preferences?`、`theme?` - 返回更新后的完整数据。
- `POST /api/app-data/migrate` - 执行旧数据迁移 - 参数：`{ source: AppDataPatch }` - 返回合并后的完整数据。
- `GET /api/subagents/events` - 子代理运行时 SSE - 参数：无 - 返回 `subagent_state`、`subagent_completed`、`subagent_failed`、`subagent_recovery`、`workflow_dag` 等事件。
- `GET /api/subagents/completed` - 拉取并消费完成/恢复缓冲 - 参数：无 - 返回 `{ completed: SubagentCompletionSummary[] }`，恢复项可包含 `recoverable`、`runId`、`owner`。
- `GET /api/files/changes` - 查询 file_history 变更记录 - 参数：`turnId?` 或 `path?` - 返回 `{ changes: ChangeRecord[] }`；ChangeRecord 使用 `pathBefore/pathAfter`，前端归一化为展示路径。
- `GET /api/files/diff` - 查询单条变更只读 diff - 参数：`recordId` - 返回 `{ id, file, summary, additions, deletions, lines }`，供 `DiffPreview` 展示。
- `POST /api/files/restore-turn` - 整轮回退 - 参数：`{ chatId, turnId }` - 返回 `{ restoredFiles, conflicts, errors }`；操作前必须二次确认。
- `POST /api/files/restore-records` - 部分记录回退 - 参数：`{ recordIds }` - 返回 `{ restoredFiles, conflicts, errors }`；仅回退用户显式拒绝的记录。
- `GET /api/files/backup-status` / `POST /api/files/gc` / `GET /api/files/sync-status` - 文件历史状态、手动 GC 与 SAF 状态 - SAF 未启用时必须展示“未启用/仅预留”，GC 不默认静默删除历史。
- `GET /api/tools/schema` - 读取内置工具注册表元数据 - 参数：无 - 返回 `{ tools: [{ name, description, parameters, riskLevel, permission, audit }] }`；只读取静态定义，不执行工具。
- `GET /api/external-capabilities` - 读取外部能力状态 - 参数：无 - 返回 `{ workspaceRoot?, capabilities, git }`；Git 为只读 status 快照，Office/语义视觉首期仅返回 reserved 占位说明。

## 迁移规则

- 聊天记录：按 `chat.id` 增量合并；同 ID 时保留迁移来源版本。
- API Key / Provider：启动时从旧加密配置增量合并；同 Provider 补齐缺失 API Key 和模型，不删除现有项。
- 其他设置：迁移时用所选来源覆盖统一存储中的偏好和主题。
