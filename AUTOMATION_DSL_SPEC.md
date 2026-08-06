# 手机助手自动化 Script 脚本 DSL 方案（v1）

> 定位：把"复杂屏幕操作"封装为**参数化、可复用、结果结构化**的自动化单元（Script）。
> AI Agent 把 Script当作一个工具调用——只传参数、收结果，不参与中间屏幕操作。
> 原则：数据驱动（JSON 动作表）、无语法解析、有界控制流、复杂计算下沉后端函数。

---

## 1. 总体架构

```
LLM (function calling)
  └─ run_script(script_name, params)          ← 唯一入口，注册为 Tool
       └─ Script Registry                    ← 脚本注册表（JSON 文件存储）
            └─ Script Interpreter            ← 解释器循环（op 分发）
                 └─ 基础工具层              ← click / swipe / get_layout / screenshot ...
                      └─ 结果收集器          ← emit/extract → 结构化 JSON 返回 LLM
```

**AI 的调用契约**：

```json
// 调用
run_script("compare_price", { "keyword": "iPhone 15 Pro", "platform": "淘宝" })

// 返回
{
  "status": "ok",
  "result": {
    "items": [
      { "shop": "XX数码旗舰店", "title": "Apple iPhone 15 Pro 256G", "model": "256G 蓝色", "price": 6899.0 },
      { "shop": "YY专营店", "title": "iPhone15 Pro 国行 全新未激活", "model": "256G", "price": 6750.0 }
    ],
    "page_checked": 3
  },
  "duration_ms": 45230,
  "steps_executed": 87,
  "last_error": null
}
```

---

## 2. Script 定义结构（Schema）

```json
{
  "name": "compare_price",
  "description": "在指定电商平台搜索商品，提取各家店铺的价格/标题/型号",
  "version": 1,
  "required_permissions": ["accessibility"],
  "risky": false,                          // true = 执行前必须 用户同意（参考toolcall的用户同意）
  "timeout_sec": 180,
  "params": [
    { "name": "keyword", "type": "string", "required": true, "description": "商品名称" },
    { "name": "platform", "type": "enum", "values": ["淘宝", "京东", "拼多多"], "default": "淘宝" }
  ],
  "result_schema": {                        // 告知 LLM 如何解析结果
    "type": "object",
    "properties": {
      "items": { "type": "array", "items": { "type": "object" } },
      "page_checked": { "type": "integer" }
    }
  },
  "steps": [ /* §4 动作表 */ ]
}
```

---

## 3. 变量系统

- 变量容器 `vars: Map<String, Any>`，随脚本生命周期存在
- **插值**：任意字符串参数支持 `{{var_name}}`，解释器在派发前替换
- 内置变量：`{{params.xxx}}`（入参）、`{{result}}`（结果收集器）、`{{screen}}`（屏幕尺寸）
- 从感知结果存入：`read_node` 的 `save_to`、`extract` 的 `save_to`

---

## 4. 动作原语全集

### 4.1 感知原语

| op                   | 参数                                                  | 说明                    |
| -------------------- | --------------------------------------------------- | --------------------- |
| `wait`               | `ms`                                                | 固定等待                  |
| `wait_for_node`      | `selector, timeout_ms`                              | 轮询布局直到节点出现            |
| `wait_for_text`      | `text, timeout_ms`                                  | 轮询直到指定文本出现（页面加载完成的信号） |
| `wait_for_app`       | `pkg \| app_name, timeout_ms`                       | 等待前台切换（支持包名或应用名，识别规则同 `launch_app`） |
| `get_layout`         | `mode: full\|brief, save_to`                        | 布局树（自动节点编号），存变量       |
| `get_node`           | `selector, save_to`                                 | 单节点完整属性               |
| `read_node`          | `selector, fields: [text,desc,bounds,...], save_to` | 读节点属性到变量              |
| `read_nodes`         | `selector, fields, save_to, limit?`                 | 批量读取（列表场景核心）          |
| `read_clipboard`     | `save_to`                                           | 剪贴板文本                 |
| `get_foreground_app` | `save_to`                                           | 前台包名                  |
| `screenshot`         | `save_to?`                                          | 截图（存路径，供 OCR/上报）      |

### 4.2 操作原语

| op              | 参数                                              | 说明                                                                         |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| `click`         | `selector \| {x, y}`                            | 节点点击或坐标点击（二选一）                                                             |
| `long_click`    | 同上                                              | 长按                                                                         |
| `press`         | `x, y, duration_ms`                             | 自定义按压                                                                      |
| `swipe`         | `x1,y1,x2,y2,duration_ms`                       | 滑动                                                                         |
| `gesture`       | `points[], duration_ms`                         | 手势                                                                         |
| `node_action`   | `selector, action`                              | performAction 族（click/longClick/setText/scroll/expand/collapse/dismiss...） |
| `input_text`    | `text`                                          | 输入（优先节点 setText，失效回退逐字）                                                    |
| `paste`         | `selector?, text?`                              | 粘贴（text 传入时先写剪贴板），微信/QQ 场景首选                                               |
| `key_event`     | `key: back\|home\|enter\|del\|tab...`           | 按键                                                                         |
| `global_action` | `back/home/recents/notifications/quickSettings` | 系统全局动作                                                                     |
| `set_clipboard` | `text`                                          | 写剪贴板                                                                       |
| `launch_app`    | `app_name \| pkg`                               | 启动应用（自动识别双模式：入参含 `.` 视为包名，否则按名称模糊匹配；不依赖映射表，目标软件可未知）           |
| `open_url`      | `url`（含 URL scheme 深链）                          | 打开链接/深链                                                                    |
| `scroll`        | `selector?, direction, times`                   | 滚动                                                                         |

### 4.3 控制原语（有界控制流）

| op             | 参数                                         | 语义                         |
| -------------- | ------------------------------------------ | -------------------------- |
| `set`          | `var, value`                               | 赋值（value 支持 `{{}}` 插值）     |
| `if`           | `condition, then: [steps], else?: [steps]` | 条件分支                       |
| `repeat`       | `times, steps`                             | 定次循环                       |
| `for_each`     | `var, items（插值数组）, steps`                  | 遍历（群发场景核心）                 |
| `repeat_until` | `condition, steps, max_attempts, on_fail?` | 条件循环（防死循环上限）               |
| `retry`        | `attempts, interval_ms, steps`             | 失败重试块                      |
| `call`         | `script_name, params?, save_to?`           | 调用其他 Script/ 后端原生函数        |
| `emit`         | `key, value`                               | 写入结构化结果集                   |
| `extract`      | `selector, field, regex?, save_to`         | 读取并用正则清洗（"¥12.99" → 12.99） |
| `return`       | `value?`                                   | 提前结束并返回                    |

### 4.4 异常语义

- 每个 op 可带 `on_fail: "abort" | "retry" | "skip"`（默认 abort，retry 需配 `retry_attempts`）
- 脚本级：`timeout_sec` 全局超时；`max_steps` 步数上限（防死循环兜底）
- 高危 Script（`risky: true`）执行前强制 `AskUserQuestion` 确认，支付永远不自动

---

## 5. 谓词（条件表达式）

```json
{ "node_exists": { "text": "下一页" } }
{ "text_matches": { "text": "已下单", "regex": true } }
{ "app_is_foreground": "com.jingdong.app.mall" }
{ "less_than": ["{{min_price}}", 7000] }
{ "greater_than": ["{{price}}", "{{min_price}}"] }
{ "equals": ["{{status}}", "success"] }
{ "contains": ["{{title}}", "iPhone"] }
{ "is_empty": "{{items}}" }
{ "and": [ {c1}, {c2} ] }
{ "or":  [ {c1}, {c2} ] }
{ "not": {c} }
```

谓词求值器：纯函数求值，无副作用，不产生语法——每个谓词是解释器里的一个分发分支。

---

## 6. 选择器 Schema

```json
{ "text": "搜索", "desc": null, "id": null, "className": null,
  "clickable": null, "scrollable": null, "index": null,
  "scope": "root" }
```

- `scope` 可指向变量中的子树（如 `read_nodes` 保存的列表容器），避免全树搜索
- 匹配基于布局树 JSON 的属性，无 text 时退化为坐标匹配（`bounds` 命中）

---

## 7. 解释器骨架

```rust
// 核心循环：op 分发，与基础工具层解耦
struct Interpreter {
    vars: HashMap<String, Value>,
    result: Value::Object,
    steps_executed: usize,
    deadline: Instant,           // timeout_sec
}

fn run(steps: &[Step], ctx: &mut Interpreter) -> Result<Value, ScriptError> {
    for step in steps {
        ctx.check_deadline()?;                 // 全局超时
        ctx.steps_executed += 1;
        if ctx.steps_executed > MAX_STEPS { bail!("step limit exceeded") }

        let outcome = match step.op.as_str() {
            "set"          => exec_set(step, ctx),
            "if"           => exec_if(step, ctx, run),
            "repeat"       => exec_repeat(step, ctx, run),
            "for_each"     => exec_for_each(step, ctx, run),
            "repeat_until" => exec_repeat_until(step, ctx, run),
            "retry"        => exec_retry(step, ctx, run),
            "call"         => exec_call(step, ctx),
            "emit"         => exec_emit(step, ctx),
            "extract"      => exec_extract(step, ctx),
            "return"       => return ctx.result.clone(),   // 提前结束
            _ => dispatch_basic(step, ctx),                // 感知/操作原语 → 基础工具层
        };

        match (outcome, step.on_fail.as_str()) {
            (Ok(_), _) => continue,
            (Err(e), "retry") => exec_retry_for_step(step, ctx, e)?,
            (Err(_), "skip")  => continue,
            (Err(e), _)       => return Err(e),
        }
    }
    Ok(ctx.result.clone())
}

// 插值：所有字符串参数在派发前替换 {{var}}
fn interpolate(s: &str, ctx: &Interpreter) -> String {
    PARAM_REGEX.replace_all(s, |c: &Captures| {
        ctx.vars.get(&c[1]).map(|v| v.to_string()).unwrap_or_default()
    }).to_string()
}
```

要点：

- **同一个 `run` 递归进入子 steps**，天然支持嵌套控制流
- 谓词求值器独立模块（`fn eval(condition, ctx) -> bool`）
- `dispatch_basic` 把感知/操作原语映射到基础工具层（click/swipe/get_layout/...），两边只依赖一个 `ToolCall` trait，Script解释器与无障碍实现解耦

---

## 8. 典型 Script 示例

### 8.1 compare_price（比价 —— 核心演示）

```json
{
  "name": "compare_price",
  "params": [
    { "name": "keyword", "type": "string", "required": true },
    { "name": "platform", "type": "enum", "values": ["淘宝", "京东", "拼多多"] },
    { "name": "max_items", "type": "integer", "default": 5 }
  ],
  "timeout_sec": 180,
  "steps": [
    { "op": "set", "var": "items", "value": [] },

    { "op": "launch_app", "args": { "app_name": "{{params.platform}}" } },          // 中文名 → 名称匹配
    { "op": "wait_for_app", "args": { "pkg": "{{params.platform}}", "timeout_ms": 8000 } },  // 应用名同样可识别
    { "op": "wait_for_node", "args": { "selector": { "desc": "搜索" }, "timeout_ms": 8000 },
      "on_fail": { "strategy": "skip" } },                       // 没搜索框 → 跳过（可能已登录态异常）

    { "op": "if", "condition": { "node_exists": { "text": "登录" } },
      "then": [ { "op": "emit", "key": "warning", "value": "需要用户登录" },
                { "op": "return" } ] },                          // 登录态问题交还 AI/用户

    { "op": "click", "args": { "selector": { "desc": "搜索" } } },
    { "op": "input_text", "args": { "text": "{{params.keyword}}" } },
    { "op": "key_event", "args": { "key": "enter" } },
    { "op": "wait_for_text", "args": { "text": "{{params.keyword}}", "timeout_ms": 10000 } },

    { "op": "repeat_until",
      "condition": { "node_exists": { "text": "没有更多" } },
      "max_attempts": 3,        // 翻页上限（最多 3 页），由解释器计数，无需算术插值
      "steps": [
        { "op": "read_nodes",
          "args": { "selector": { "className": "商品条目" }, "fields": ["text", "bounds"],
                    "limit": "{{params.max_items}}" },
          "save_to": "list" },
        { "op": "for_each", "var": "item", "items": "{{list}}", "steps": [
            { "op": "extract", "args": { "selector": { "scope": "{{item}}", "className": "价格" },
                                         "field": "text", "regex": "¥?([\\d.]+)", "save_to": "price" } },
            { "op": "extract", "args": { "selector": { "scope": "{{item}}", "className": "标题" },
                                         "field": "text", "save_to": "title" } },
            { "op": "extract", "args": { "selector": { "scope": "{{item}}", "className": "店铺" },
                                         "field": "text", "save_to": "shop" } },
            { "op": "emit", "key": "item",
              "value": { "price": "{{price}}", "title": "{{title}}", "shop": "{{shop}}" } }
        ] },
        { "op": "swipe", "args": { "x1": 540, "y1": 1600, "x2": 540, "y2": 400, "duration_ms": 300 } }
      ] },

    { "op": "return" }
  ]
}
```

### 8.2 place_order（下单 —— 高危示例）

```json
{
  "name": "place_order",
  "risky": true,
  "params": [
    { "name": "item_url", "type": "string", "required": true },
    { "name": "model", "type": "string", "description": "规格，如 256G 蓝色" }
  ],
  "steps": [
    { "op": "open_url", "args": { "url": "{{params.item_url}}" } },
    { "op": "wait_for_node", "args": { "selector": { "text": "加入购物车" }, "timeout_ms": 15000 } },
    { "op": "click", "args": { "selector": { "text": "选择规格" } } },
    { "op": "wait_for_node", "args": { "selector": { "text": "{{params.model}}" }, "timeout_ms": 8000 } },
    { "op": "click", "args": { "selector": { "text": "{{params.model}}" } } },
    { "op": "click", "args": { "selector": { "text": "确认" } } },
    { "op": "click", "args": { "selector": { "text": "立即购买" } } },
    { "op": "wait_for_text", "args": { "text": "提交订单", "timeout_ms": 10000 } },
    { "op": "click", "args": { "selector": { "text": "提交订单" } } },
    { "op": "emit", "key": "order_status", "value": "提交成功，等待用户支付" }
  ]
}
```

> `risky: true` → 解释器执行前强制走 `AskUserQuestion` 确认；**支付步骤永远不自动执行**，脚本止步于"提交订单"，支付由用户完成。

---

## 9. AI 编排示例（比价全流程）

```
用户: 帮我买 iPhone 15 Pro 256G，找最便宜的

AI:  [调用 run_script("compare_price", {keyword:"iPhone 15 Pro 256G", platform:"淘宝"})]
     ← { items: [{shop, price, title}...], page_checked: 2 }
AI:  [调用 run_script("compare_price", {keyword:"iPhone 15 Pro 256G", platform:"京东"})]
     ← { items: [...] }
AI:  [调用 run_script("compare_price", {keyword:"iPhone 15 Pro 256G", platform:"拼多多"})]
     ← { items: [...] }
AI:  汇总三家最低价，推荐最低的店铺
     [调用 run_script("place_order", {item_url, model:"256G"})]
     ← { order_status: "提交成功，等待用户支付" }
AI:  告知用户已提交订单，请完成支付
```

AI 的职责只剩：**传参 → 比较结构化结果 → 决策**。屏幕操作细节全部在 Script 内，AI 不再需要逐步截图/点击，出错面大幅缩小。

---

## 10. 失败与恢复策略

| 失败类型               | 策略                                                 |
| ------------------ | -------------------------------------------------- |
| 单步失败（节点找不到）        | 默认 `abort`；可配 `retry`（重试 N 次）或 `skip`              |
| 登录态/风控页            | Script 内检测 → `emit warning` + `return`，交还 AI 让用户处理 |
| 全局超时 / 步数超限        | 解释器强制终止，返回 `status: "error"` + 已收集的部分结果            |
| AI 判断 Script 结果不合理 | AI 可以换参数重跑，或改用基础 tool 逐步操作（长尾兜底）                   |
| 高危操作               | `risky` 标记 + 强制 `AskUserQuestion`（已实现的 tool）      |

---

## 11. 边界与不做清单

**不做**：不引入脚本语言（JS/Lua）——任何"在 DSL 里写会变形的逻辑"一律 `call(native)` 下沉后端函数。

---

## 12. 用户自定义脚本（User Scripts）

> 数据驱动设计带来的红利：DSL 是纯 JSON → 用户无需编程技能，**LLM 可以直接生成/修改脚本**。

### 12.1 三种创作入口

- 需右侧栏新增脚本管理入口，进入该界面后显示脚本列表，另有新建（`工作台编辑`）、导入、录制、脚本市场（仅保留接口暂不实现）按钮，各个脚本可管理（编辑（`工作台编辑`）、删除、导出、启用\禁用），并保持ui风格不变且美观。

| 入口                                                  | 描述                                                                         | 注释                      |
| --------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------- |
| **自然语言生成**（推荐首选）                                    | 用户说"写个脚本：打开淘宝搜索 XX 翻 3 页取价格"。流程：① AI 先手动实操一遍验证可行性 → ② 基于亲自操作的经验生成 DSL JSON → ③ `create_script` 自动校验语法/结构 → ④ 真实运行一遍，核对结果与预期是否有差异 → 注册 | 写好的脚本自动添加到脚本列表实现注册      |
| **工作台编辑**                                           | 前端脚本工作台：JSON 编辑器（schema 校验、错误定位行号）+ 参数表单自动生成（按 `params` 定义渲染）              | 暂不实现编辑功能仅保留接口，但是实现脚本导入。 |
| **录制器**（二期，参考 AutoJs6 AccessibilityActionConverter） | 用户手动操作一遍，监听无障碍事件流（VIEW_CLICKED/TEXT_CHANGED/SCROLLED + 手势坐标）→ 自动生成 DSL 动作表 | 该功能只保留接口暂不实现            |

### 12.2 新增 Tool（AI 侧）

```json
// create_script: { name, description, params, steps(由 LLM 生成), risky? }
//   → 内部集成静态校验（§12.4 规则），失败返回具体错误（定位到 op/字段），LLM 自我修正重试
// update_script: { name, patch }   → 修改现有脚本（暂不实现）
// validate_script: { script }      → 静态校验报告（不注册），独立校验与导入时复用
// run_script: 已有
// list_scripts: 已有（自动包含用户脚本，返回时标记 source: "builtin"|"user"）
```

### 12.3 前端脚本工作台（保留接口暂不实现）

- 脚本列表页：来源标记（内置/用户）、risky 徽标、执行次数
- 编辑器：JSON schema 校验 + 错误行号定位 + `params` 自动生成表单预览
- 试运行：逐步骤高亮执行轨迹（复用执行轨迹记录），可中途停止
- 导入/导出：脚本为单个 JSON 文件，可直接分享

### 12.4 校验与安全（validate_script 规则）

**静态校验**：

- JSON schema 校验（结构/字段类型，`params`/`result_schema`/`steps` 完整）
- op 白名单：只允许已知原语
- `call` 引用完整性：目标脚本必须存在，且禁止递归自调用
- 循环嵌套深度 ≤ 4、steps 总数 ≤ 200（防失控）
- 静态扫描 `{{var}}` 插值：未定义变量报错；内置变量（params.*、result、screen）白名单放行

**动态护栏**（执行时）：

- 全局超时 + 步数上限（第 4.4 节机制，对用户脚本同样生效）
- 危险动作检测：脚本含 `click`/`input_text`/`paste`/`key_event` 但未标记 `risky` → 执行前强制 `AskUserQuestion`
- 分享导入的脚本：默认 `risky: true`（关闭状态），用户手动确认后才可运行

### 12.5 脚本分级

| 级别  | 来源            | 权限                  |
| --- | ------------- | ------------------- |
| 内置  | 随应用发布         | 只读（不可编辑，可复制为模板）     |
| 用户  | 自然语言生成/工作台/录制 | 可编辑、可删除、可导出         |
| 分享  | 导入的外部 JSON    | 默认 risky 关闭，运行前逐次确认 |
