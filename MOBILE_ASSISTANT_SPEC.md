# Venture  — 完整实现规格书

> 基于 AutoJs6（github.com/SuperMonster003/AutoJs6）源码深度分析，为 Venture（Tauri v2 Android）设计可落地的手机自动化 Agent。
> 目标：读完本文档即可按模块实施。DSL 部分见配套文档 `AUTOMATION_DSL_SPEC.md`。自动化功能实现建议参考autojs6（网址已经提供）。

---

## 第 1 章 项目概述

### 1.1 目标

把 Venture 扩展为**手机助手**：根据用户自然语言指令完成跨 App 自动化任务。

两类任务形态：

| 形态               | 适用场景                            | 实现方式                                                           |
| ---------------- | ------------------------------- | -------------------------------------------------------------- |
| **预设脚本（Script）** | 机械型通用型任务：淘宝/京东/拼多多比价、微信群发、天气查询等 | 数据驱动 DSL 动作表（见 `AUTOMATION_DSL_SPEC.md`），AI 通过 `run_script` 调用 |
| **AI 自主决策**      | 长尾任务：未预置流程的任意屏幕操作               | LLM 多模态（截图+布局树）→ tool calls 调用基础工具循环                           |

### 1.2 关键设计决策

1. **不需要脚本解析器**：预设脚本用 JSON DSL（数据驱动），AI 自主任务走 tool calls 循环——两条路都不需要autojs那种JS引擎
2. **复杂计算下沉后端**：DSL 中无法表达的逻辑 → `call(native)` 调后端函数
3. **AI 永不直接生成代码执行**：只输出 tool calls 序列，可校验、可中断、可审计
4. **高危操作永远不自动**：例如，高危操作止步于"提交订单"，用户完成支付
5. **布局树压缩**：LLM 上下文有限，`get_layout` 默认返回精简树（带节点编号）

### 1.3 技术栈

| 层    | 技术                                             |
| ---- | ---------------------------------------------- |
| 原生层  | Kotlin（AccessibilityService + 手势引擎）            |
| 桥接层  | Tauri v2 Command（Rust）                         |
| 前端层  | React + TypeScript（`toolService.ts` 注册 schema） |
| AI 层 | 现有 backend 聊天流扩展 function calling 循环           |

---

## 第 2 章 系统架构

### 2.1 分层图

```
┌─────────────────────────────────────────────────────┐
│ LLM（现有 backend 聊天接口 + function calling）         │
│   决策：截图/布局 → 工具选择 → 循环直至任务完成             │
└──────────────┬──────────────────────────────────────┘
               │ tool call JSON / 结果 JSON
┌──────────────▼──────────────────────────────────────┐
│ 前端（React）toolService.ts                          │
│   注册 schema、流式展示执行过程、ask_user 交互面板        │
└──────────────┬──────────────────────────────────────┘
               │ Tauri invoke
┌──────────────▼──────────────────────────────────────┐
│ 桥接层（Rust backend / tauri commands）              │
│   tool_router（入参校验→分发→结构化结果）               │
│   script_interpreter（DSL 执行循环，引用 DSL spec）     │
└──────────────┬──────────────────────────────────────┘
               │ JNI / Android API
┌──────────────▼──────────────────────────────────────┐
│ 原生层（Kotlin）                                      │
│   AccessibilityService（fast root 缓存/事件/状态机）   │
│   LayoutInspector（捕获→NodeInfo 树→JSON）            │
│   ActionAutomator（performAction/dispatchGesture/    │
│                    performGlobalAction）             │
└─────────────────────────────────────────────────────┘
```

### 2.2 一次任务的数据流（时序）

```
用户指令 ──> LLM 首轮 ──> tool_call: run_script("compare_price", {keyword, platform:"淘宝"})
  ──> tool_router ──> script_interpreter ──> ToolRouter(原生) ──> click/get_layout/...
  ──> 结构化结果 {"items":[...], "page_checked":2}
  ──> 返回 LLM ──> LLM 决策下一个 tool_call ──> ... 循环直至完成或 ask_user
```

由于所有的脚本执行被包装为了toolcall中run_script形式调用所以这个时序与原来几乎没有变化

## 第 3 章 无障碍服务层（Kotlin 实现规格）

> 移植 AutoJs6 五层架构。以下每节给出类、关键方法签名与实现要点。（具体实现参考autojs6）

### 3.1 VentureAccessibilityService

```kotlin
class VentureAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile var instance: VentureAccessibilityService? = null; private set
        @Volatile var hasOperationalState = false   // 收到首个事件后才为 true
        private val LOCK = ReentrantLock()
        private val ENABLED = LOCK.newCondition()    // 服务连接
        private val OPERATIONAL = LOCK.newCondition()// 首个事件
        const val DEFAULT_TIMEOUT = 2000L

        fun waitForStarted(timeout: Long = DEFAULT_TIMEOUT): Boolean
        fun waitForOperational(timeout: Long = DEFAULT_TIMEOUT): Boolean
        fun stop()  // instance?.disableSelf()
    }

    @Volatile var fastRootInActiveWindow: AccessibilityNodeInfo? = null

    override fun onServiceConnected() {
        instance = this
        // 建议设置 serviceInfo.flags |= FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        //   （布局分析更完整，代价：节点树更大，与 brief 压缩配合）
        ENABLED.signalAll()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        instance = this
        if (!hasOperationalState) { hasOperationalState = true; OPERATIONAL.signalAll() }
        // fast root 缓存：窗口切换/焦点变化时顺手缓存
        if (event.eventType == TYPE_WINDOW_STATE_CHANGED || event.eventType == TYPE_VIEW_FOCUSED) {
            runCatching { rootInActiveWindow }.getOrNull()?.let { fastRootInActiveWindow = it }
        }
        // 事件回调分发（注册表 eventType -> callbacks），供 wait_for_text 等轮询复用
    }

    override fun getRootInActiveWindow(): AccessibilityNodeInfo? =
        runCatching { super.getRootInActiveWindow() }.getOrNull()  // 系统 Binder 调用可能抛异常
}
```

**AndroidManifest 配置**：

```xml
<service android:name=".accessibility.VentureAccessibilityService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
    android:exported="false">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService"/>
    </intent-filter>
    <meta-data android:name="android.accessibilityservice"
        android:resource="@xml/accessibility_service_config"/>
</service>
```

```xml
<!-- res/xml/accessibility_service_config.xml -->
<accessibility-service
    android:accessibilityEventTypes="typeWindowStateChanged|typeWindowContentChanged|typeViewFocused|typeViewClicked"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:notificationTimeout="100"
    android:canRetrieveWindowContent="true"
    android:canPerformGestures="true"
    android:accessibilityFlags="flagDefault|flagIncludeNotImportantViews|flagReportViewIds"/>
```

**要点**：

- `canRetrieveWindowContent` + `canPerformGestures` 是布局获取与手势的最低要求
- `FLAG_INCLUDE_NOT_IMPORTANT_VIEWS` 换取更完整树（腾讯系部分节点依赖它）
- 服务未启用时引导用户到系统设置（`Settings.ACTION_ACCESSIBILITY_SETTINGS`）

### 3.2 AccessibilityBridge（模式与窗口过滤）

```kotlin
class AccessibilityBridge {
    enum class Mode { NORMAL, FAST }   // FAST = 读 fastRootInActiveWindow 缓存
    var windowFilter: ((AccessibilityWindowInfo) -> Boolean)? = null

    fun getRootInActiveWindow(): AccessibilityNodeInfo?  // FAST→缓存；NORMAL→实时
    fun windowRoots(): List<AccessibilityNodeInfo>       // 全窗口根（过滤后），多窗口操作用
    fun getService(): VentureAccessibilityService?
}
```

### 3.3 LayoutInspector（捕获入口）

```kotlin
class LayoutInspector(private val context: Context) {
    @Volatile var capture: Capture? = null; private set
    private val executor = Executors.newSingleThreadExecutor()

    fun captureCurrentWindow(): Boolean {
        val service = VentureAccessibilityService.instance ?: return false
        clearAccessibilityCache()            // 关键：强制系统刷新节点缓存
        val root = service.fastRootInActiveWindow ?: service.getRootInActiveWindow() ?: return false
        executor.execute {
            val windows = service.windows.map { WindowInfo.create(context, it) }
            capture = Capture(windows, NodeInfo.capture(context, root))
            listeners.forEach { it.onCaptureAvailable(capture!!, context) }
        }
        return true
    }

    private fun clearAccessibilityCache() {
        // API 33+: service.clearCache()；低版本: 反射 AccessibilityInteractionClient.clearCache()
    }
}
```

**为什么必须 clearCache**：系统对无障碍节点有缓存，布局变化后不刷新会拿到旧帧（坐标/文本过期）。

### 3.4 NodeInfo 序列化

```kotlin
class NodeInfo(
    val boundsInParent: Rect, val boundsInScreen: Rect,
    val packageName: String?, val simpleId: String?, val fullId: String?,
    val idHex: String?, val desc: String?, val text: String?,
    val className: String?, val center: Point,
    val clickable: Boolean, val longClickable: Boolean, val scrollable: Boolean,
    val checked: Boolean, val enabled: Boolean, val editable: Boolean,
    val focusable: Boolean, val selected: Boolean, val visibleToUser: Boolean,
    val depth: Int, val indexInParent: Int, val childCount: Int,
    val row: Int, val column: Int, val rowSpan: Int, val columnSpan: Int,
    val actionNames: List<String>,   // 关键：setText/paste 能力检测依据
    val children: List<NodeInfo>,
) {
    companion object {
        // DFS 递归：0.until(childCount).mapNotNull { child(it) } -> 子树
        fun capture(context: Context, root: AccessibilityNodeInfo): NodeInfo
        // idHex: resources.getIdentifier(fullId, null, null) -> "0x..."
        //   resources 按包名缓存 HashMap<String, Resources>
    }
}
```

**JSON 输出格式（布局树协议）**：

```json
{
  "id": 0, "text": "", "desc": "搜索", "class": "android.widget.EditText",
  "bounds": [210, 120, 870, 200], "center": [540, 160],
  "clickable": true, "scrollable": false, "depth": 3,
  "actions": ["ACTION_CLICK", "ACTION_SET_TEXT", "ACTION_PASTE"],
  "children": []
}
```

### 3.5 布局树压缩算法（brief 模式）

给 LLM 的树压缩，防止上下文爆炸：

```
输入: full 树（可达数千节点）
步骤:
1. 裁剪：仅保留满足任一条件的节点
   - text/desc 非空
   - clickable 或 scrollable 或 checkable
   - 有 id（fullId 非空）
   - depth <= 6（可配置）
2. 编号：按 DFS 顺序对保留节点重新编号（id 字段）
3. 上限：节点数 > 200 时按"有 text/desc > 可交互 > id > 深度小"优先级截断，
   并在根节点附带 "truncated": true 标记
输出: 压缩树 + "notice": "坐标与 actions 为准，text 可能为空（自绘控件）"
```

**节点编号是 VLM 对齐的关键**：截图给 LLM 看、编号树给坐标，LLM 输出"点击节点 42"，执行器查表转坐标。（布局压缩是可选模式后文会提到获取布局的几种模式）

### 3.6 Capture / WindowInfo

```kotlin
class Capture(val windows: List<WindowInfo>, val root: NodeInfo)
class WindowInfo(val root: NodeInfo?, val title: CharSequence?, val order: Int /*layer+1*/, val type: Int)
// type 本地化：TYPE_APPLICATION/INPUT_METHOD/SYSTEM/ACCESSIBILITY_OVERLAY/SPLIT_SCREEN_DIVIDER/...
```

### 3.7 节点回收与快照

- 布局树 JSON 生成后立即 `recycle()` 原节点（`AccessibilityNodeInfoAllocator` 思路：统一代理 getChild/getParent，防 use-after-recycle）
- **AI 拿到的是坐标快照**，执行 `click` 时在目标节点上重新走一次"取根→匹配"；纯坐标点击不受影响
- 滚动场景：坐标快照过期 → 执行前用 `wait_for_node` 重新获取

---

## 第 4 章 操作执行层（Kotlin 实现规格）

### 4.1 节点操作 ActionExecutor（performAction 分发）

统一入口：

```kotlin
class ActionExecutor(private val bridge: AccessibilityBridge) {
    // 返回是否成功。所有调用 try-catch(IllegalStateException) → false
    fun perform(nodeId/selector: NodeMatch, action: String, args: Bundle = Bundle()): Boolean
}
```

**支持的 action 全集（名称 → AccessibilityNodeInfoCompat 常量 → 参数）**：

| action                                     | 常量                             | Bundle 参数                                     |
| ------------------------------------------ | ------------------------------ | --------------------------------------------- |
| click                                      | ACTION_CLICK                   | —                                             |
| longClick                                  | ACTION_LONG_CLICK              | —                                             |
| pressAndHold                               | ACTION_PRESS_AND_HOLD          | —                                             |
| contextClick                               | ACTION_CONTEXT_CLICK           | —                                             |
| dragStart/dragDrop/dragCancel              | API 32+                        | —                                             |
| scrollForward/Backward                     | ACTION_SCROLL_FORWARD/BACKWARD | —                                             |
| scrollUp/Down/Left/Right                   | 对应扩展常量                         | —                                             |
| pageUp/Down/Left/Right                     | 对应常量                           | —                                             |
| scrollTo                                   | ACTION_SCROLL_TO_POSITION      | `ACTION_ARGUMENT_ROW_INT/COLUMN_INT`          |
| setText                                    | ACTION_SET_TEXT                | `ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE`       |
| setSelection                               | ACTION_SET_SELECTION           | `ACTION_ARGUMENT_SELECTION_START_INT/END_INT` |
| copy/cut/paste                             | 对应常量                           | —                                             |
| focus/clearFocus                           | 对应常量                           | —                                             |
| select/clearSelection                      | 对应常量                           | —                                             |
| accessibilityFocus/clearAccessibilityFocus | 对应常量                           | —                                             |
| expand/collapse                            | 对应常量                           | —                                             |
| dismiss                                    | ACTION_DISMISS                 | —                                             |
| show                                       | ACTION_SHOW_ON_SCREEN          | —                                             |
| setProgress                                | ACTION_SET_PROGRESS            | `ACTION_ARGUMENT_PROGRESS_VALUE`              |
| moveWindow                                 | ACTION_MOVE_WINDOW             | `ACTION_ARGUMENT_MOVE_WINDOW_X/Y`             |
| imeEnter                                   | ACTION_IME_ENTER               | —                                             |
| show/hideTooltip                           | 对应常量                           | —                                             |

**执行前置检查**：`node.actionNames()` 不含该 action → 直接返回失败（进 retry/skip 逻辑），避免无效 Binder 调用。

### 4.2 全局手势 GestureExecutor（dispatchGesture）

```kotlin
class GestureExecutor(
    private val serviceProvider: () -> AccessibilityService,
    private val screenMetrics: ScreenMetrics?,   // 脚本坐标系缩放
) {
    fun click(x: Int, y: Int): Boolean        // 单点手势, 时长 = TapTimeout(100ms)*1.25 = 125ms
    fun longClick(x: Int, y: Int): Boolean    // 时长 = LongPressTimeout(400ms)*1.25 = 500ms
    fun press(x: Int, y: Int, duration: Int): Boolean
    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Long): Boolean
    fun gesture(start: Long, duration: Long, points: List<Pair<Int,Int>>): Boolean
    fun gestures(strokes: List<StrokeDescription>): Boolean  // 多指
}
```

**实现要点**：

1. 坐标先过 `screenMetrics.scaleX/Y`（脚本虚拟分辨率 → 真实像素），无 metrics 则直用
2. 构造 `Path`：首点 `moveTo`，其余 `lineTo`
3. `GestureDescription.Builder().addStroke(...).build()`
4. `service.dispatchGesture(desc, callback, handler)` —— **异步 API，同步封装**：
   - 主线程环境：`VolatileDispose<Boolean>().blockedGet(128_000)`，`onCompleted → true` / `onCancelled → false`
   - 无 Handler 环境：`Looper.prepare()` + `loop()` + 回调 `quit()`
5. 负坐标抛异常（防坐标换算错误）
6. dispatch 失败（服务未运行）→ 抛"无障碍服务未运行"

### 4.3 系统全局动作 GlobalActionExecutor

```kotlin
fun back() / home() / recents() / notifications() / quickSettings() / powerDialog()
    = service.performGlobalAction(GLOBAL_ACTION_*)

// API 28+ 动作（lockScreen/takeScreenshot 等）：低版本 try-catch 也尝试执行
```

### 4.4 文本输入体系 TextInputHandler（核心决策树）

```
输入 text 到目标节点：
1. 若 target 为空 → 先取当前聚焦节点，或失败返回
2. click 聚焦 + wait(300ms)（paste 必须，setText 建议）
3. actionNames 含 ACTION_SET_TEXT → setText(text)
4. 否则 actionNames 含 ACTION_PASTE → set_clipboard(text) + paste()
5. 否则 → 自绘控件：坐标聚焦 + 逐字注入（见 4.4.1）
```

**为什么 paste 优于 setText**：

- setText 是"无障碍专用注入"，应用可做来源检测（微信/QQ 常见失败）
- paste 走用户真实"长按→粘贴"同一管线，应用无法区分
- 微信/QQ 场景：setText 失败时 paste 基本成功
- 注意：禁止的层次在"节点不暴露 action"时（actionList 无 SET_TEXT 也无 PASTE），两者都失败 → 走 5

**4.4.1 逐字注入兜底**（自绘控件场景）：

```
方案 A（root）：injectKeyEvent 逐字符（仅 ASCII 可靠，中文不可靠）
方案 B（无障碍+IME）：点击聚焦 → 调 InputMethodManager 触发输入法 → 通过
    accessibility 无法直接发中文按键 → 实际用"剪贴板+长按菜单粘贴"：
    long_click(输入框中心) → wait → 布局树 find_node("粘贴") → click
方案 C（最终兜底）：放弃输入，ai提示用户手动输入
```

### 4.5 launch_app / open_url

```kotlin
fun launchApp(nameOrPkg: String): Boolean {
    // 自动识别双模式：入参含 "." → 视为包名（getLaunchIntentForPackage）
    //   否则 → 视为应用名（queryIntentActivities 名称模糊匹配）
    // 不用固定映射表：要操作的目标软件可能是未知的
    // startActivity(intent.addFlags(FLAG_ACTIVITY_NEW_TASK))
}

fun openUrl(url: String): Boolean {
    // URL scheme 深链：tbopen:// / openapp.jdmobile:// / weixin:// 直接跳转
    // 普通 https → Intent(ACTION_VIEW, Uri.parse(url))
}
```

### 4.6 key_event 按键注入

```kotlin
fun keyEvent(key: String): Boolean {
    // back/home/enter/del/tab/volumeUp/volumeDown...
    // 实现：service.dispatchKeyEvent(KeyEvent(...)) —— 无障碍服务可注入按键
    // 或系统级：performGlobalAction(GLOBAL_ACTION_BACK/HOME) 等
}
```

### 4.7 截图 ScreenshotHandler

```kotlin
fun captureScreen(callback: (Bitmap?) -> Unit) {
    // 仅 API 30+：service.takeScreenshot(DEFAULT_DISPLAY, mainExecutor, callback)
    //   onSuccess: hardwareBuffer.copy(ARGB_8888) 后 recycle()（HARDWARE 位图不可读像素）
    //   onFailure(ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT): 50ms 后重试
    //   onFailure(其他): 回调 null → 上层走 OCR 降级或 ask_user
}
```

**OCR 对接**（text 为空场景兜底）：截图 → 裁剪目标区域（bounds）→ 本地 OCR 引擎（如 PaddleOCR onnx）或云端 OCR。( ocr对接只保留接口我后续添加)

---

## 第 5 章 感知与坐标

### 5.1 坐标数据模型

- 单位：屏幕物理像素（px）
- 所有 bounds 为屏幕绝对坐标：`[left, top, right, bottom]`，center = `[(l+r)/2, (t+b)/2]`
- 坐标与截图直接对应：截图裁剪 `bounds` 区域 → 该控件画面

### 5.2 准确性边界与补偿

| 场景                    | 风险              | 补偿                            |
| --------------------- | --------------- | ----------------------------- |
| 标准控件（Button/TextView） | 坐标像素级准确         | 直接使用                          |
| 页面滚动                  | 快照过期            | 执行前重新 capture / wait_for_node |
| 节点缓存                  | 旧帧              | capture 前 clearCache          |
| WebView/自绘/游戏         | 节点缺失或 bounds 占位 | 截图 + VLM/OCR 定位               |
| ScreenMetrics 缩放      | 坐标系不一致          | 手势层统一缩放                       |

### 5.3 text 为空问题处理策略（腾讯系等对自动化有对抗策略的情况）

```
1. 布局树中节点存在但 text 空：
   - 检查 desc/contentDescription → 用之
   - 检查 actionNames 是否含 SET_TEXT/PASTE → 决定输入路径（4.4）
2. 节点缺失（importantForAccessibility="no"）：
   - 已开启 FLAG_INCLUDE_NOT_IMPORTANT_VIEWS 仍缺 → 视觉方案
3. 自绘文本（Canvas 绘制，无解）：
   - bounds 区域截图 → OCR / VLM 识别文字
   - 语义定位：VLM 从截图识别"哪块是价格/哪块是标题"→ 返回中心坐标 → click
```

---

## 第 6 章 Tool Call 全集（LLM function calling schema）

> 全部注册为 OpenAI 兼容 function schema（现有 backend 聊天流扩展）。以下给出每个 tool 的完整 schema 与实现映射。

### 6.1 感知类

**`screenshot`**

```json
{
  "name": "screenshot",
  "description": "截取当前屏幕。用于多模态视觉分析。返回图片路径（PNG）",
  "parameters": { "type": "object", "properties": {}, "required": [] }
}
```

返回：`{ "image_path": "/data/venture/screenshots/xxx.png", "size": [1080, 2400] }`

**`get_layout`**

```json
{
  "name": "get_layout",
  "description": "获取当前屏幕布局树（节点含坐标/文本/actions）。mode=brief 为压缩版；full 为完整树（可能很大）；subagent 为 AI 调用一个子代理，子代理收到完整布局树后按需提取，返回「自然语言描述 + 精简布局层次表 + 坐标列表」（不要求纯 JSON，兼容 LLM 输出不稳定性；subagent 模式仅保留接口，由我后续具体实现）",
  "parameters": {
    "type": "object",
    "properties": {
      "mode": { "type": "string", "enum": ["brief", "full","subagent"], "default": "brief" }
    }
  }
}
```

返回：`{ "truncated": false, "windows": [ { "type": "application", "order": 1 } ], "root": <NodeInfo JSON> }`

**`get_node`**

```json
{
  "name": "get_node",
  "description": "获取单个节点的完整属性（含所有布尔状态与 actions 列表）",
  "parameters": {
    "type": "object",
    "properties": {
      "node_id": { "type": "integer", "description": "get_layout 返回的节点编号" }
    }, "required": ["node_id"]
  }
}
```

**`find_node`**

```json
{
  "name": "find_node",
  "description": "按条件查找节点，返回匹配列表（含 node_id/坐标/文本）",
  "parameters": {
    "type": "object",
    "properties": {
      "text": { "type": "string" }, "desc": { "type": "string" },
      "id": { "type": "string" }, "className": { "type": "string" },
      "limit": { "type": "integer", "default": 10 }
    }, "required": []
  }
}
```

返回：`{ "matches": [ { "node_id": 42, "text": "搜索", "bounds": [...], "center": [...] } ] }`

**`get_foreground_app`**

```json
{ "name": "get_foreground_app", "parameters": { "type": "object", "properties": {}, "required": [] } }
```

返回：`{ "package_name": "com.tencent.mm", "app_name": "微信" }`（无障碍不可用时降级 UsageStats）

**`get_screen_info`**

```json
{ "name": "get_screen_info", "parameters": { "type": "object", "properties": {}, "required": [] } }
```

返回：`{ "width": 1080, "height": 2400, "dpi": 420, "density": 2.625 }`

**`read_clipboard`**

```json
{ "name": "read_clipboard", "parameters": { "type": "object", "properties": {}, "required": [] } }
```

返回：`{ "text": "..." }`（读取后不清理，由脚本决定）

**`get_windows`**

```json
{ "name": "get_windows", "parameters": { "type": "object", "properties": {}, "required": [] } }
```

返回：`{ "windows": [ { "type": "application", "title": "微信", "order": 1 }, ... ] }`

### 6.2 操作类

**`click`**

```json
{
  "name": "click",
  "description": "点击。优先 node_id（布局树编号）；或坐标 x,y",
  "parameters": {
    "type": "object",
    "properties": {
      "node_id": { "type": "integer" },
      "x": { "type": "integer" }, "y": { "type": "integer" }
    }, "required": []
  }
}
```

实现：node_id 存在 → 按快照坐标 click（或节点 performAction CLICK，若 actions 含 ACTION_CLICK）；否则坐标手势 125ms。返回：`{ "ok": true, "used": "node"|"coordinate" }`

**`long_click`** / **`press`** / **`swipe`** / **`gesture`**

```json
// long_click: 同 click 结构（500ms）
// press: { x, y, duration_ms }
// swipe: { x1, y1, x2, y2, duration_ms }
// gesture: { points: [[x,y],...], duration_ms, start_ms? }
```

**`node_action`**

```json
{
  "name": "node_action",
  "description": "对节点执行无障碍动作（见 action 枚举）。文本输入请优先用 input_text/paste",
  "parameters": {
    "type": "object",
    "properties": {
      "node_id": { "type": "integer", "required": true },
      "action": { "type": "string", "enum": ["click","longClick","scrollForward","scrollBackward",
          "scrollUp","scrollDown","scrollLeft","scrollRight","setText","setSelection","copy","cut",
          "paste","focus","clearFocus","select","clearSelection","expand","collapse","dismiss",
          "show","setProgress","moveWindow","imeEnter","pressAndHold","contextClick"] },
      "text": { "type": "string", "description": "setText 时必填" },
      "args": { "type": "object", "description": "其他动作参数" }
    }, "required": ["node_id", "action"]
  }
}
```

**`input_text`**

```json
{
  "name": "input_text",
  "description": "向当前聚焦的输入框输入文本（自动决策 setText→paste→长按菜单）",
  "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }
}
```

返回：`{ "ok": true, "method": "paste"|"setText"|"menu_paste"|"failed" }`

**`paste`**

```json
{
  "name": "paste",
  "description": "向指定节点粘贴剪贴板内容（传 text 时先写剪贴板再粘贴）。微信/QQ 输入首选",
  "parameters": { "type": "object", "properties": { "node_id": { "type": "integer" }, "text": { "type": "string" } }, "required": [] }
}
```

**`key_event`**

```json
{ "name": "key_event", "parameters": { "type": "object",
  "properties": { "key": { "type": "string", "enum": ["back","home","enter","del","tab","volumeUp","volumeDown","recent","menu"] } },
  "required": ["key"] } }
```

**`global_action`**

```json
{ "name": "global_action", "parameters": { "type": "object",
  "properties": { "action": { "type": "string", "enum": ["back","home","recents","notifications","quickSettings","powerDialog","splitScreen","lockScreen"] } },
  "required": ["action"] } }
```

**`set_clipboard`**

```json
{ "name": "set_clipboard", "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] } }
```

**`launch_app`**

```json
{ "name": "launch_app", "description": "启动应用（自动识别双模式：入参含 . 视为包名，否则按应用名模糊匹配；不依赖映射表）",
  "parameters": { "type": "object", "properties": { "app": { "type": "string" } }, "required": ["app"] } }
```

**`open_url`**

```json
{ "name": "open_url", "description": "打开链接或深链（tbopen://、openapp.jdmobile://、weixin:// 等直达）",
  "parameters": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"] } }
```

**`scroll`**

```json
{ "name": "scroll", "description": "滚动。node_id 指定可滚动容器，否则在屏幕内滑动",
  "parameters": { "type": "object",
    "properties": { "direction": { "type": "string", "enum": ["up","down","left","right"] },
      "node_id": { "type": "integer" }, "times": { "type": "integer", "default": 1 } },
    "required": ["direction"] } }
```

### 6.3 控制类（轮询/等待）

```json
wait_for_node: { selector: {...}, timeout_ms: 10000 }   → { "ok": true, "node_id": 42 }
wait_for_text: { text: "已下单", timeout_ms: 10000 }     → { "ok": true, "node_id": 42 }
wait_for_app:  { package_name: "com.tencent.mm", timeout_ms: 8000 } → { "ok": true }
sleep:         { ms: 500 }
```

**轮询实现**：`wait_for_text` = 每 500ms 调 `find_node` 直到命中或超时；`wait_for_node` 同（可按 selector）。所有 wait 超时返回 `{ "ok": false, "reason": "timeout" }`。

### 6.4 确认类（护栏）

```json
// AskUserQuestion（已实现，即现有 tool call 的 AskUserQuestion）
//   { question, options? } → 挂起 agent 循环，用户选择后恢复 → 返回 { answer }

// report_progress: { message: "正在搜索淘宝..." }
//   → 前端流式展示，不中断循环；使用一个小悬浮窗展示
```

### 6.5 脚本类

```json
run_script: { script_name: "compare_price", params: { keyword: "iPhone 15 Pro", platform: "淘宝" } }
//   → 执行 DSL（见 AUTOMATION_DSL_SPEC.md），返回 { status, result, duration_ms, steps_executed, last_error }
list_scripts: {} → { scripts: [ { name, description, params_schema } ] }
```

### 6.6 执行器（tool_router）要点

- 入参校验：必须字段缺失 → 返回明确错误（LLM 可自我纠正重调）
- 全部返回**结构化 JSON**，失败时带 `error: { code, message }` 而非异常文本
- 每次 tool 调用记录 `{ tool, args, result, ts, duration_ms }` → 前端执行轨迹

---

## 第 7 章 Script DSL 与 AI 编排

详见 `AUTOMATION_DSL_SPEC.md`（完整 schema/原语/谓词/解释器骨架/示例脚本）。核心决策：

1. **入口统一**：`run_script(script_name, params)`，AI 只传参收结果，不参与中间屏幕操作
2. **DSL 覆盖边界**：线性流程 + 有界控制流（if/repeat/for_each/repeat_until/retry/call/emit/extract/return）
3. **复杂逻辑溢出**：`call(native)` 调后端函数（正则、API 请求、计算）
4. **平台参数使用中文值**：`platform: "淘宝"|"京东"|"拼多多"`（launch_app 名称匹配）
5. **AI 编排示例**（比价）：依次 `run_script("compare_price", {keyword, platform:"淘宝"})` → 京东 → 拼多多 → 比较 result.items → `run_script("place_order", ...)`（risky，止步提交订单）

### 7.1 参考：AutoJs6 布局分析→自动生成代码机制（已分析，供参考）

AutoJs6 在布局分析中选中节点后，会生成可复制的选择器+操作代码。机制如下（本项目不直接采用，而是用 LLM tool call 替代"生成 JS 代码"，但**选择器唯一性验证思想复用**）：

**流程**：选中节点 → `CodeGenerateDialog`（三组选项）→ `CodeGenerator.generateCode()` → 复制

| 选项组         | 选项                                                   | 说明           |
| ----------- | ---------------------------------------------------- | ------------ |
| Options（复选） | id/text/desc 选择器                                     | 生成时是否允许使用该属性 |
| Select（单选）  | findOne / untilFind / waitFor / exists               | 查找方式         |
| Action（单选）  | click/longClick/setText/scrollForward/scrollBackward | 操作后缀         |

**选择器生成算法（UiSelectorGenerator）**：

1. 属性优先级链：`id → className → text → desc → scrollable → clickable → selected → checkable → checked → longClickable → depth`，命中即停
2. **唯一性实测验证**：每加一个条件就在已捕获的静态节点树（`ReadOnlyUiObject` 包装 NodeInfo）上执行 `findAndReturnList(root, limit)`：
   - `FIND_ONE` 模式：`limit=2`，恰好 1 个命中才接受（确保选择器能唯一定位）
   - `UNTIL_FIND` 模式：`limit=1`，非空即接受
3. 全部条件失败 → 递归回退（最多各 2 层）：向子节点生成拼 `.parent()`；向父节点生成拼 `child(index)`
4. 集合控件（`rowCount>0 || columnCount>0` 祖先）→ 生成 `children().forEach(...)` 批量代码

**对本项目的复用点**：

- `find_node`/`wait_for_*` 的 selector 语义可直接复用该优先级链设计
- 唯一性验证思想用于 `click(node_id)` 前的"节点是否仍唯一"检查（布局变化后防止点错）
- DSL 的 `wait_for_text` 谓词复用"验证即搜索"（limit=1 实测）思路

---

## 第 8 章 后端与前端集成

### 8.1 Rust backend 扩展

- 新增路由（沿用现有 Axum 风格）：
  - `POST /api/agent/tool` —— 通用工具调用（前端/后端 agent 循环都走这里）
  - `GET /api/agent/scripts` / `PUT /api/agent/scripts/{name}` —— 脚本注册表 CRUD（JSON 文件存储于 app_data 目录）
  - `POST /api/agent/scripts/{name}/run` —— 同步运行脚本（或走 tool 通道）
- 聊天流扩展：`chatStreamService` 对应后端增加 function calling 循环（tool_call 消息帧 → 执行 → tool_result 帧送回模型）
- 工具 schema 注册表：Rust 侧维护权威 schema（serde_json::Value），供 schema 同步与校验

### 8.2 前端扩展

- `toolService.ts`：新增 `executeAgentTool(name, args)`（经 Tauri invoke 或后端 API 二选一；Android 端走 Tauri command）
- 新增 `agentState.ts` store：执行轨迹（tool 调用列表、状态、耗时）、ask_user 待处理队列
- 交互：chat 流中渲染 tool 调用卡片（图标+参数摘要+结果摘要）、ask_user 确认面板（按钮式）、执行轨迹可折叠

### 8.3 权限引导

- 首次使用自动跳转无障碍设置页 + 检测状态（`hasService`/`hasInstance`/`hasOperationalState` 三态展示）
- 高危 script 独立授权开关（设置页）：`risky` 脚本默认关闭，用户手动开启

---

## 第 9 章 安全与合规

| 项    | 规则                                                |
| ---- | ------------------------------------------------- |
| 高危操作 | `risky: true` 脚本 + 执行前 `AskUserQuestion`；**支付/转账永远不自动**  |
| 自身保护 | 目标包名 == Venture 自身包名时拒绝执行破坏性动作                    |
| 剪贴板  | `read_clipboard` 结果仅进入 agent 上下文，不落盘              |
| 截图   | 截图仅用于当次会话视觉分析，任务结束清理                              |
| 脚本审计 | 所有脚本执行记录轨迹（tools/时间/结果），前端可回看                     |
| 风控   | 登录态/滑块验证 → 脚本 `emit warning` + `AskUserQuestion` 让用户手动通过 |

---

## 附录 A：AutoJs6 参考源码索引

| 文件                         | 路径（SuperMonster003/AutoJs6）                                                      | 本项目对应         |
| -------------------------- | -------------------------------------------------------------------------------- | ------------- |
| AccessibilityService.kt    | `app/src/main/java/org/autojs/autojs/core/accessibility/AccessibilityService.kt` | 3.1           |
| AccessibilityBridge.java   | 同上目录                                                                             | 3.2           |
| LayoutInspector.kt         | 同上目录                                                                             | 3.3           |
| NodeInfo.kt                | 同上目录                                                                             | 3.4           |
| WindowInfo.kt / Capture.kt | 同上目录                                                                             | 3.6           |
| AccessibilityTool.kt       | 同上目录（clearCache 分叉逻辑）                                                            | 3.3           |
| LayoutInspectService.kt    | 同上目录（FLAG_INCLUDE_NOT_IMPORTANT_VIEWS）                                           | 3.1           |
| UiObject.kt                | `core/automator/UiObject.kt`                                                     | 坐标 API        |
| UiObjectActions.kt         | `core/automator/UiObjectActions.kt`                                              | 4.1 action 全集 |
| GlobalActionAutomator.kt   | `core/automator/GlobalActionAutomator.kt`                                        | 4.2/4.3       |
| SimpleActionAutomator.kt   | `core/accessibility/SimpleActionAutomator.kt`                                    | 4.4 决策        |
| UiSelectorGenerator.kt     | `codegeneration/UiSelectorGenerator.kt`                                          | 选择器生成         |
| CodeGenerator.java         | `codegeneration/CodeGenerator.java`                                              | 代码生成（仅参考）     |

## 附录 B：核心常量速查

| 常量                      | 值         | 用途             |
| ----------------------- | --------- | -------------- |
| TapTimeout × 1.25       | 125ms     | click 手势时长     |
| LongPressTimeout × 1.25 | 500ms     | longClick 手势时长 |
| 手势同步等待超时                | 128_000ms | blockedGet 上限  |
| wait 轮询间隔               | 500ms     | wait_for_* 轮询  |
| 布局树 brief 节点上限          | 200       | 压缩截断           |
| 脚本全局超时默认                | 180s      | timeout_sec    |
| 脚本步数上限                  | 1000      | max_steps 兜底   |
