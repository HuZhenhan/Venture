# Android 自动化 DSL 语法详解（AI 参考文档 v1）

> 本文件是 `android-automation` 技能的配套语法手册，供 LLM 在创建 / 修改 / 校验自动化脚本时逐节查阅。
> 脚本 = 纯 JSON 动作表（无编程语言、无语法解析）。执行入口统一为 `run_script(script_name, params)`。
> AI 只负责：传参数 → 接收结构化结果 → 决策。不参与中间屏幕操作。

---

## 脚本编写要点

- 每个页面操作前有 `wait_for_*`（8-15s 超时）；循环有 `max_attempts`

- 数据用 `read_nodes` + `for_each` + `extract`（正则清洗）逐项读取，`emit` 结构化输出。

- 输入优先 `paste`（微信/QQ 场景）；应用启动用 `launch_app`（包名含 `.`，应用名模糊匹配）。
  
  创建
  
- `create_script` 提交脚本，若返回校验错误（定位到具体 op/字段），**根据错误修正后重试**，不要跳过校验。
- 脚本内涉及下单/提交/删除/转账等动作 → 标 `risky: true`（执行前强制用户确认）。
  
  验证
  
- 创建成功后实际 `run_script` 跑一遍（可让用户确认执行过程），核对 `result` 与预期；不对则修正脚本或退回基础工具路线。

## 1. 脚本定义 Schema（顶层结构）

```json
{
  "name": "compare_price",
  "description": "在指定电商平台搜索商品，提取各家店铺的价格/标题/型号",
  "version": 1,
  "required_permissions": ["accessibility"],
  "risky": false,
  "timeout_sec": 180,
  "params": [
    { "name": "keyword", "type": "string", "required": true, "description": "商品名称" },
    { "name": "platform", "type": "enum", "values": ["淘宝", "京东", "拼多多"], "default": "淘宝" }
  ],
  "result_schema": {
    "type": "object",
    "properties": {
      "items": { "type": "array", "items": { "type": "object" } },
      "page_checked": { "type": "integer" }
    }
  },
  "steps": [ /* §3 动作表 */ ]
}
```

字段说明：

| 字段                     | 必填  | 说明                                                |
| ---------------------- | --- | ------------------------------------------------- |
| `name`                 | ✓   | 脚本名，`run_script` 引用                               |
| `description`          | ✓   | 给 AI/用户的用途说明                                      |
| `version`              |     | 正整数                                               |
| `required_permissions` |     | 当前仅 `["accessibility"]`                           |
| `risky`                |     | `true` = 高危（执行前强制用户确认；**支付/转账永远不自动**）             |
| `timeout_sec`          |     | 全局超时，默认 180                                       |
| `params`               |     | 参数声明（类型：string/integer/number/boolean/enum/array） |
| `result_schema`        |     | 告知 LLM 结果结构，便于解析                                  |
| `steps`                | ✓   | 动作表数组，见下                                          |

---

## 2. 变量系统与插值

- 变量容器 `vars: Map<String, Any>` 随脚本生命周期存在。
- **插值**：任意字符串参数支持 `{{var_name}}`，执行前由解释器替换。
- **内置变量**：
  - `{{params.xxx}}` —— 脚本入参
  - `{{result}}` —— 结果收集器
  - `{{screen}}` —— 屏幕尺寸 `{width, height}`
- **写入变量**：`read_node` / `read_nodes` / `get_layout` / `extract` 的 `save_to` 字段；`set` 原语。
- 插值未定义变量 → 空字符串（静态校验会先拦截）。

---

## 3. 动作原语全集（steps 数组元素）

每个 step 结构：

```json
{ "op": "op_name", "args": { ... }, "on_fail": { "strategy": "abort" }, "save_to": "var" }
```

### 3.1 感知原语

| op                   | args                                                          | 说明                           |
| -------------------- | ------------------------------------------------------------- | ---------------------------- |
| `wait`               | `ms`                                                          | 固定等待                         |
| `wait_for_node`      | `selector`, `timeout_ms`                                      | 轮询布局直到节点出现                   |
| `wait_for_text`      | `text`, `timeout_ms`                                          | 轮询直到文本出现（页面加载完成信号）           |
| `wait_for_app`       | `pkg` 或 `app_name`, `timeout_ms`                              | 等待前台应用切换（识别规则同 `launch_app`） |
| `get_layout`         | `mode: "full"\|"brief"`, `save_to`                            | 布局树（自动节点编号），存变量              |
| `get_node`           | `selector`, `save_to`                                         | 单节点完整属性                      |
| `read_node`          | `selector`, `fields: ["text","desc","bounds",...]`, `save_to` | 读节点属性到变量                     |
| `read_nodes`         | `selector`, `fields`, `save_to`, `limit?`                     | 批量读取（列表场景核心）                 |
| `read_clipboard`     | `save_to`                                                     | 剪贴板文本                        |
| `get_foreground_app` | `save_to`                                                     | 前台包名                         |
| `screenshot`         | `save_to?`                                                    | 截图（存路径，供 OCR/上报）             |

### 3.2 操作原语

| op              | args                                                     | 说明                                                                         |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `click`         | `selector` 或 `{x, y}`                                    | 节点点击或坐标点击（二选一）                                                             |
| `long_click`    | 同上                                                       | 长按（500ms）                                                                  |
| `press`         | `x, y, duration_ms`                                      | 自定义按压                                                                      |
| `swipe`         | `x1,y1,x2,y2,duration_ms`                                | 滑动                                                                         |
| `gesture`       | `points[]`, `duration_ms`                                | 手势                                                                         |
| `node_action`   | `selector`, `action`                                     | performAction 族（click/longClick/setText/scroll/expand/collapse/dismiss...） |
| `input_text`    | `text`                                                   | 输入（优先节点 setText，失效回退逐字/粘贴）                                                 |
| `paste`         | `selector?`, `text?`                                     | 粘贴（微信/QQ 场景首选；传 text 先写剪贴板）                                                |
| `key_event`     | `key: back\|home\|enter\|del\|tab...`                    | 按键                                                                         |
| `global_action` | `back/home/recents/notifications/quickSettings`          | 系统全局动作                                                                     |
| `set_clipboard` | `text`                                                   | 写剪贴板                                                                       |
| `launch_app`    | `app_name` 或 `pkg`                                       | 启动应用。**双模式识别：入参含 `.` 视为包名，否则按应用名模糊匹配**；不依赖映射表，目标软件可未知                      |
| `open_url`      | `url`（含 URL scheme 深链）                                   | 打开链接/深链（tbopen://、weixin:// 等）                                             |
| `scroll`        | `selector?`, `direction: up\|down\|left\|right`, `times` | 滚动                                                                         |

### 3.3 控制原语（有界控制流）

| op             | args                                             | 语义                              |
| -------------- | ------------------------------------------------ | ------------------------------- |
| `set`          | `var`, `value`                                   | 赋值（value 支持插值）                  |
| `if`           | `condition`, `then: [steps]`, `else?: [steps]`   | 条件分支                            |
| `repeat`       | `times`, `steps`                                 | 定次循环                            |
| `for_each`     | `var`, `items`（插值数组）, `steps`                    | 遍历（群发场景核心）                      |
| `repeat_until` | `condition`, `steps`, `max_attempts`, `on_fail?` | 条件循环（**必须给 max_attempts 防死循环**） |
| `retry`        | `attempts`, `interval_ms`, `steps`               | 失败重试块                           |
| `call`         | `script_name`, `params?`, `save_to?`             | 调用其他 Script（禁止递归自调用）            |
| `emit`         | `key`, `value`                                   | 写入结构化结果集（**结果收集核心，LLM 靠它拿到数据**） |
| `extract`      | `selector`, `field`, `regex?`, `save_to`         | 读取并用正则清洗（如 "¥12.99" → 12.99）    |
| `return`       | `value?`                                         | 提前结束并返回                         |

### 3.4 on_fail 异常语义（每个 step 可选）

- `"abort"`（默认）：失败即终止，返回已收集的部分结果
- `"retry"`：按 `retry_attempts` 重试
- `"skip"`：失败跳过继续

---

## 4. 谓词（条件表达式，用于 if / repeat_until 的 condition）

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

谓词是纯函数求值，无副作用。

---

## 5. 选择器 Schema

```json
{ "text": "搜索", "desc": null, "id": null, "className": null,
  "clickable": null, "scrollable": null, "index": null,
  "scope": "root" }
```

- `scope` 可指向变量中的子树（如 `read_nodes` 保存的列表容器），避免全树搜索。
- 匹配基于布局树 JSON 属性；无 text 时退化为坐标匹配。
- 选择器唯一性：优先用「文本/描述 精确匹配 + 关键容器 scope」，避免泛化选择器点错。

---

## 6. 编写规范（LLM 生成脚本的检查清单）

### 必须遵守

1. **每个页面操作前都有等待**：`launch_app` → `wait_for_app` → `wait_for_node/wait_for_text`（超时 8-15s），再点击。禁止无等待直接点击。
2. **循环必有上限**：`repeat_until` 必须配 `max_attempts`（如翻页 3 次）；步骤总数 ≤ 200。
3. **登录态/风控检测前置**：开局先 `if node_exists 登录` → `emit warning` + `return`，交还用户处理，不要硬闯。
4. **结果用 `emit` 结构化输出**：列表数据用 `read_nodes` + `for_each` + `extract` 逐项清洗后 `emit`；数值用 `regex` 去货币符号/空格。
5. **高危动作（下单/提交/删除/转账类）**：脚本标 `risky: true`，止步于「提交订单」，支付永远由用户完成。
6. **参数类型明确**：enum 参数给 `values`；默认值给 `default`。
7. **翻页场景**：`repeat_until` 的 condition 用 `node_exists("没有更多")` 等终止信号，不要无限刷。
8. **输入优先 paste**：微信/QQ 场景 setText 常失败，脚本层优先 `paste`。

### 典型骨架（模板）

```json
{
  "name": "example",
  "description": "...",
  "params": [ { "name": "keyword", "type": "string", "required": true } ],
  "timeout_sec": 180,
  "steps": [
    { "op": "set", "var": "items", "value": [] },
    { "op": "launch_app", "args": { "app_name": "{{params.platform}}" } },
    { "op": "wait_for_app", "args": { "pkg": "{{params.platform}}", "timeout_ms": 8000 } },
    { "op": "wait_for_node", "args": { "selector": { "desc": "搜索" }, "timeout_ms": 8000 }, "on_fail": { "strategy": "skip" } },
    { "op": "if", "condition": { "node_exists": { "text": "登录" } },
      "then": [ { "op": "emit", "key": "warning", "value": "需要用户登录" }, { "op": "return" } ] },
    { "op": "click", "args": { "selector": { "desc": "搜索" } } },
    { "op": "input_text", "args": { "text": "{{params.keyword}}" } },
    { "op": "key_event", "args": { "key": "enter" } },
    { "op": "wait_for_text", "args": { "text": "{{params.keyword}}", "timeout_ms": 10000 } },
    { "op": "repeat_until",
      "condition": { "node_exists": { "text": "没有更多" } },
      "max_attempts": 3,
      "steps": [
        { "op": "read_nodes", "args": { "selector": { "className": "商品条目" }, "fields": ["text", "bounds"], "limit": 5 }, "save_to": "list" },
        { "op": "for_each", "var": "item", "items": "{{list}}", "steps": [
          { "op": "extract", "args": { "selector": { "scope": "{{item}}", "className": "价格" }, "field": "text", "regex": "¥?([\\d.]+)" }, "save_to": "price" },
          { "op": "extract", "args": { "selector": { "scope": "{{item}}", "className": "标题" }, "field": "text" }, "save_to": "title" },
          { "op": "emit", "key": "item", "value": { "price": "{{price}}", "title": "{{title}}" } }
        ] },
        { "op": "swipe", "args": { "x1": 540, "y1": 1600, "x2": 540, "y2": 400, "duration_ms": 300 } }
      ] },
    { "op": "return" }
  ]
}
```

---

## 7. 静态校验规则（create_script 时后端自动执行，LLM 应先自查）

- JSON schema 校验（字段类型完整）
- op 白名单：只允许本手册 §3 已知原语
- `call` 引用完整性：目标脚本必须存在，禁止递归自调用
- 循环嵌套深度 ≤ 4，steps 总数 ≤ 200
- `{{var}}` 插值静态扫描：未定义变量报错；内置变量（params.*、result、screen）白名单放行
- 校验失败返回具体错误（定位到 op/字段），**LLM 自我修正后重试**

---

## 8. 失败与恢复策略

| 失败类型        | 策略                                            |
| ----------- | --------------------------------------------- |
| 单步失败（节点找不到） | 默认 abort；可配 retry / skip                      |
| 登录态/风控页     | Script 内检测 → `emit warning` + `return`，交还用户处理 |
| 全局超时 / 步数超限 | 解释器强制终止，返回 `status: "error"` + 已收集的部分结果       |
| 结果不合理       | 换参数重跑，或改用基础工具逐步操作（长尾兜底）                       |
| 高危操作        | `risky` 标记 + 执行前强制用户确认；**支付永远不自动**            |

---

## 9. 错误示例（禁止模式）

```json
// ❌ 无等待直接点击（页面未加载完必然失败）
{ "op": "click", "args": { "selector": { "text": "搜索" } } }

// ❌ repeat_until 无 max_attempts（死循环）
{ "op": "repeat_until", "condition": { "node_exists": { "text": "xxx" } }, "steps": [...] }

// ❌ 直接执行支付/转账类动作（永远不允许）
{ "op": "click", "args": { "selector": { "text": "确认支付" } } }
```

## 10.其它说明

运行脚本前最好保证应用在初始状态（即主界面，避免先前操作干扰脚本）  （可手动提醒用户关闭、或在root权限下使用stop_app或反复多次点击返回键）

脚本任务运行完毕后可选择使本应用回到前台以方便用户
