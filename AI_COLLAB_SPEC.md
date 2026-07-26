# AI_COLLAB_SPEC

## 通用组件清单
- `SettingsSidebar` - 系统偏好与 Provider 设置入口 - 通过 `SettingsSidebarProps` 传入开关状态、宽度和 Provider 列表。
- `PreferencesPanel` - 系统偏好和统一存储迁移面板 - 通过 `migrationSummary`、`migrationStatus`、`onMigrateLegacyLocalData` 展示并触发旧 localStorage 迁移。
- `BrowserPanel` - 桌面端内置浏览器面板 - 通过 `isOpen`、`onClose`、`isNativeViewHidden` 控制 Electron 原生 BrowserView 显示；收起时立即隐藏原生网页，展开动画结束后显示“正在恢复浏览器...”并延迟挂载 BrowserView；工具栏摘要按钮通过本地 IPC 在网页内展示一次性核心信息摘取预览动画。
- `BrowserSummaryButton` - 浏览器摘要预览入口 - 无输入参数；点击后触发约 4 秒的本地扫描动画，执行期间自动禁用以防重复触发。
- `CustomTitleBar` - Electron 桌面端窗口控制按钮组 - 嵌入融合顶栏，只负责最小化、最大化、关闭窗口。
- `RightPanelRail` - 右侧页面入口按钮组 - 保持桌面端右侧竖向 rail 样式，用于聊天、浏览器、用量和设置切换；窄屏时入口同步切换当前单页内容，聊天入口用于恢复已收起的对话区。
- `MainLayout` - 主工作区自适应布局容器 - 根据最近激活视图分配聊天、浏览器、设置和用量面板空间；始终为右 rail 预留宽度，并在原生 BrowserView 不可见时走隐藏路径。
- `RawMessageContent` - 调试态原始消息内容渲染 - 由 `/debug OriginalContent true|false` 控制，直接展示 `Message.content`，跳过 Markdown 与引用 pill 渲染；由 `/debug RawResponse true|false` 控制时展示上游 reasoning/content delta 原文。
- `MessageContentRenderer` - 对话协议内容统一解析与递归渲染 - 消费 `Message.content` 中的 `[thinking]`、`[error]`、`[attachment]` 节点，复用思考卡、错误卡和附件引用卡。

## 对话内容协议
- 权威持久化字段：`Message.content`，正文、模型 API 实际返回的 reasoning、错误和附件均以原始标签字符串保存；`Message.rawResponse` 仅保存本次模型输出的未归一化 delta，用于调试，不参与模型上下文。
- 标签格式：`[thinking]...[/thinking]`、`[error][code]...[/code][message]...[/message][/error]`、`[attachment]...[/attachment]`；标签允许嵌套。
- `src/app/utils/messageContentProtocol.ts`：负责白名单解析、嵌套节点序列化、流式未闭合标签容错、错误/附件字段编解码和旧 blocks 运行时适配。
- `src/app/store/chatState.ts`：只更新 `Message.content`；reasoning delta、正文 delta 和错误均沿同一内容流写入。
- `blocks` 仅保留尚未纳入协议的交互卡片，并作为旧消息适配来源；新消息不再用 blocks 承载 thinking、error、attachment。
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

## 项目架构
- `scripts/dev-control.js`：开发态进程编排入口，接管 `npm run dev`，管理 Web Vite、桌面 Vite、Electron 桌面壳，并支持命令行交互重启。
- `electron/main.cjs`：Electron 主进程、桌面窗口生命周期、后端子进程生命周期；开发态关闭全部窗口时保持 Electron 和后端进程存活。
- `backend/src/app_data.rs`：统一应用数据文件存储，路径为 Windows `%APPDATA%/Venture/app-data.json`。
- `backend/src/config.rs`：Provider 加密配置存储，路径迁移到 `%APPDATA%/Venture/config.enc`，启动时增量合并旧本地目录配置。
- `src/app/services/appDataService.ts`：前端统一存储 API、旧 localStorage 读取和迁移服务。
- `src/app/store/useChatStore.ts`：聊天和 activeChat 后端优先持久化，失败时才回退 localStorage。
- `src/app/store/usePreferencesStore.ts`：偏好设置后端优先持久化。
- `src/app/store/useThemeStore.ts`：主题后端优先持久化。

## 工具函数 / 常量
- `restartBackendForDev` - 开发态重启后端进程 - 参数：无 - 返回后端重启 Promise，串行防止重复重启。
- `reloadFrontendForDev` - 开发态重载桌面前端 - 参数：无 - 返回值：无；无窗口时会重新创建桌面窗口。
- `scripts/dev-control.js` 交互命令 - 开发态进程控制 - 参数：`restart frontend` / `restart backend` / `restart all` 或 `rs fe` / `rs be` / `rs all` - 返回命令行执行日志。
- `handleExistingDevControllers` - Windows 开发进程单实例预检 - 参数：无 - 返回 Promise；启动服务前检测其他 `scripts/dev-control.js`（兼容空格后的相对脚本路径），英文询问后仅在输入 `y` 时使用 `taskkill /T /F` 结束旧进程树，其他输入保留旧进程并继续启动。
- `selectActiveWorkspaceView` - 读取当前主工作区视图 - 参数：`LayoutState` - 返回 `WorkspaceView`，供主布局和面板状态机统一判断活动页面。
- `selectResponsiveLayout` - 计算自适应主布局 - 参数：布局打开状态、最近激活视图和 viewport 宽度 - 返回聊天/浏览器/设置/用量的有效宽度、参与布局状态和单页宽度；计算时固定扣除 `RIGHT_RAIL_WIDTH`。
- `BROWSER_PANEL_WIDTH` / `MIN_BROWSER_WIDTH` / `MIN_SETTINGS_WIDTH` / `COLLAPSED_CHAT_WIDTH` - 自适应面板宽度边界 - 值：`500` / `360` / `320` / `0` - 用途：保证 rail 入口打开后对应内容有可用尺寸，并支持窄屏单页收起聊天。
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
- `appendThinkingContent` / `appendVisibleContent` - 流式内容增量归一化 - 参数：当前 `content`、delta - 返回追加后的统一标签内容；thinking 标签清洗保留在此边界，避免上游模型重复输出协议标记。
- `buildChatMessageContentFromProtocol` - 从统一消息内容构建模型请求 - 参数：`content`、`modelSupportsMultimodal` - 返回文本或多模态消息 parts。
- `parseDebugCommand` - 解析对话输入调试命令 - 参数：`input` - 返回 `{ module, enabled }` 或 `null`；支持 `/debug OriginalContent true|false`、`/debug RawResponse true|false`、`/debug OccupancyMonitor true|false`，并兼容 `ture/flase`。

## 标准化 API
- `GET /api/app-data` - 读取统一应用数据 - 参数：无 - 返回 `{ chats, activeChatId, preferences, theme, updatedAt }`。
- `PUT /api/app-data` - 覆盖统一应用数据 - 参数：完整 `AppDataFile` - 返回更新后的完整数据。
- `PATCH /api/app-data` - 增量更新统一应用数据 - 参数：`chats?`、`activeChatId?`、`preferences?`、`theme?` - 返回更新后的完整数据。
- `POST /api/app-data/migrate` - 执行旧数据迁移 - 参数：`{ source: AppDataPatch }` - 返回合并后的完整数据。

## 迁移规则
- 聊天记录：按 `chat.id` 增量合并；同 ID 时保留迁移来源版本。
- API Key / Provider：启动时从旧加密配置增量合并；同 Provider 补齐缺失 API Key 和模型，不删除现有项。
- 其他设置：迁移时用所选来源覆盖统一存储中的偏好和主题。
