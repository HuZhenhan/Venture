//! DSL 解释器（规格书 §7 骨架）。
//!
//! - 核心循环：op 分发，与基础工具层解耦（ToolCaller trait）
//! - 同一个 run_steps 递归进入子 steps，天然支持嵌套控制流
//! - 谓词求值器独立（eval_condition，纯函数语义，无副作用）
//! - 护栏：全局超时（timeout_sec）+ 步数上限（max_steps）+ call 深度限制

use super::model::ScriptDef;
use super::native;
use futures_util::future::BoxFuture;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const MAX_CALL_DEPTH: usize = 3;
const DEFAULT_RETRY_ATTEMPTS: usize = 3;
const RETRY_INTERVAL_MS: u64 = 500;

/// 基础工具层抽象（Script 解释器与无障碍实现解耦，规格书 §7 ToolCall trait）
pub trait ToolCaller: Send + Sync {
    fn call<'a>(&'a self, tool: &'a str, args: Value) -> BoxFuture<'a, Value>;
}

#[derive(Debug)]
pub struct ScriptError(pub String);

impl std::fmt::Display for ScriptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

fn err<T>(msg: impl Into<String>) -> Result<T, ScriptError> {
    Err(ScriptError(msg.into()))
}

/// 子脚本调用器（call 分发到其他 Script 或 native 函数）
pub trait ScriptCaller: Send + Sync {
    fn run_sub_script<'a>(
        &'a self,
        name: &'a str,
        params: Value,
        depth: usize,
    ) -> BoxFuture<'a, Result<Value, String>>;
}

pub struct Interpreter<'a> {
    vars: HashMap<String, Value>,
    result: Map<String, Value>,
    steps_executed: usize,
    max_steps: usize,
    deadline: Instant,
    tools: &'a dyn ToolCaller,
    caller: &'a dyn ScriptCaller,
    call_depth: usize,
}

enum Flow {
    Continue,
    Return,
}

pub struct RunOutcome {
    pub status: String,
    pub result: Value,
    pub duration_ms: u64,
    pub steps_executed: usize,
    pub last_error: Option<String>,
}

impl<'a> Interpreter<'a> {
    pub fn new(
        script: &ScriptDef,
        params: Value,
        tools: &'a dyn ToolCaller,
        caller: &'a dyn ScriptCaller,
        call_depth: usize,
    ) -> Self {
        let mut vars = HashMap::new();
        vars.insert("params".to_string(), params);
        vars.insert("screen".to_string(), json!({}));
        vars.insert("loop".to_string(), json!({}));
        Self {
            vars,
            result: Map::new(),
            steps_executed: 0,
            max_steps: script.max_steps,
            deadline: Instant::now() + Duration::from_secs(script.timeout_sec),
            tools,
            caller,
            call_depth,
        }
    }

    pub async fn execute(mut self, steps: &[Value]) -> RunOutcome {
        let start = Instant::now();
        let outcome = run_steps(steps, &mut self).await;
        let (status, last_error) = match outcome {
            Ok(_) => ("ok".to_string(), None),
            Err(e) => ("error".to_string(), Some(e.0)),
        };
        RunOutcome {
            status,
            result: Value::Object(self.result.clone()),
            duration_ms: start.elapsed().as_millis() as u64,
            steps_executed: self.steps_executed,
            last_error,
        }
    }

    fn check_deadline(&self) -> Result<(), ScriptError> {
        if Instant::now() > self.deadline {
            return err("脚本全局超时（timeout_sec）");
        }
        Ok(())
    }

    // ── 插值（§3：任意字符串参数支持 {{var}}，派发前替换） ──────────────

    fn lookup_var(&self, path: &str) -> Option<Value> {
        let mut parts = path.split('.');
        let root = parts.next()?;
        let mut cur = if root == "result" {
            Value::Object(self.result.clone())
        } else {
            self.vars.get(root)?.clone()
        };
        for part in parts {
            cur = cur.get(part)?.clone();
        }
        Some(cur)
    }

    fn interpolate(&self, value: &Value) -> Value {
        match value {
            Value::String(s) => self.interpolate_str(s),
            Value::Array(arr) => Value::Array(arr.iter().map(|v| self.interpolate(v)).collect()),
            Value::Object(map) => Value::Object(
                map.iter().map(|(k, v)| (k.clone(), self.interpolate(v))).collect(),
            ),
            other => other.clone(),
        }
    }

    fn interpolate_str(&self, s: &str) -> Value {
        let re = regex::Regex::new(r"\{\{([^}]+)\}\}").unwrap();
        // 整串即单个占位符 → 返回原始值（for_each items 数组等场景）
        if let Some(cap) = re.captures(s) {
            if cap[0].len() == s.len() {
                return self.lookup_var(cap[1].trim()).unwrap_or(Value::Null);
            }
        }
        let replaced = re.replace_all(s, |caps: &regex::Captures| {
            let path = caps[1].trim();
            match self.lookup_var(path) {
                Some(Value::String(v)) => v,
                Some(Value::Null) | None => String::new(),
                Some(other) => other.to_string(),
            }
        });
        Value::String(replaced.to_string())
    }

    // ── 谓词求值器（§5：纯函数语义） ──────────────────────────────────

    async fn eval_condition(&mut self, cond: &Value) -> Result<bool, ScriptError> {
        let Some(map) = cond.as_object() else {
            return err("condition 必须是对象");
        };
        if map.len() != 1 {
            return err("condition 必须恰好一个谓词键");
        }
        let (kind, body) = map.iter().next().unwrap();
        match kind.as_str() {
            "node_exists" => {
                let selector = self.interpolate(body);
                let mut args = Map::new();
                if let Some(obj) = selector.as_object() {
                    for (k, v) in obj {
                        if k != "scope" && k != "index" {
                            args.insert(k.clone(), v.clone());
                        }
                    }
                }
                args.insert("limit".to_string(), json!(1));
                let res = self.tools.call("find_node", Value::Object(args)).await;
                Ok(res["ok"].as_bool().unwrap_or(false)
                    && res["matches"].as_array().map(|m| !m.is_empty()).unwrap_or(false))
            }
            "text_matches" => {
                let text = body["text"].as_str().unwrap_or_default();
                let interpolated = self.interpolate_str(text);
                let text = interpolated.as_str().unwrap_or_default();
                let is_regex = body["regex"].as_bool().unwrap_or(false);
                if is_regex {
                    // 正则模式：取 brief 布局全量文本逐一匹配
                    let layout = self
                        .tools
                        .call("get_layout", json!({ "mode": "brief" }))
                        .await;
                    if !layout["ok"].as_bool().unwrap_or(false) {
                        return Ok(false);
                    }
                    let re = regex::Regex::new(text).map_err(|e| ScriptError(format!("谓词正则非法: {e}")))?;
                    let mut texts = Vec::new();
                    collect_texts(&layout["root"], &mut texts);
                    Ok(texts.iter().any(|t| re.is_match(t)))
                } else {
                    let res = self
                        .tools
                        .call("find_node", json!({ "text": text, "limit": 1 }))
                        .await;
                    Ok(res["ok"].as_bool().unwrap_or(false)
                        && res["matches"].as_array().map(|m| !m.is_empty()).unwrap_or(false))
                }
            }
            "app_is_foreground" => {
                let target = self.interpolate_str(body.as_str().unwrap_or_default());
                let res = self.tools.call("get_foreground_app", json!({})).await;
                let fg = res["package_name"].as_str().unwrap_or_default();
                let name = res["app_name"].as_str().unwrap_or_default();
                let target = target.as_str().unwrap_or_default();
                Ok(fg == target || name == target)
            }
            "less_than" | "greater_than" | "equals" | "contains" => {
                let Some(pair) = body.as_array() else {
                    return err(format!("{kind} 谓词参数必须是二元数组"));
                };
                if pair.len() != 2 {
                    return err(format!("{kind} 谓词参数必须是二元数组"));
                }
                let a = self.interpolate(&pair[0]);
                let b = self.interpolate(&pair[1]);
                match kind.as_str() {
                    "less_than" => compare_num(&a, &b, |x, y| x < y),
                    "greater_than" => compare_num(&a, &b, |x, y| x > y),
                    "equals" => Ok(value_equals(&a, &b)),
                    "contains" => {
                        let hay = value_to_string(&a);
                        let needle = value_to_string(&b);
                        Ok(hay.contains(&needle))
                    }
                    _ => unreachable!(),
                }
            }
            "is_empty" => {
                let v = self.interpolate(body);
                Ok(match &v {
                    Value::Null => true,
                    Value::String(s) => s.is_empty(),
                    Value::Array(a) => a.is_empty(),
                    Value::Object(o) => o.is_empty(),
                    _ => false,
                })
            }
            "and" => {
                let Some(list) = body.as_array() else {
                    return err("and 谓词参数必须是数组");
                };
                for c in list {
                    if !Box::pin(self.eval_condition(c)).await? {
                        return Ok(false);
                    }
                }
                Ok(true)
            }
            "or" => {
                let Some(list) = body.as_array() else {
                    return err("or 谓词参数必须是数组");
                };
                for c in list {
                    if Box::pin(self.eval_condition(c)).await? {
                        return Ok(true);
                    }
                }
                Ok(false)
            }
            "not" => Ok(!Box::pin(self.eval_condition(body)).await?),
            other => err(format!("未知谓词: {other}")),
        }
    }

    // ── 基础原语 → 工具层映射（§4.1/4.2 dispatch_basic） ──────────────

    /// 选择器 → node_id 解析（click/node_action/paste/scroll 共用）
    async fn resolve_selector(&mut self, selector: &Value) -> Result<Option<i64>, ScriptError> {
        let mut args = Map::new();
        if let Some(obj) = selector.as_object() {
            for (k, v) in obj {
                if k != "scope" {
                    args.insert(k.clone(), v.clone());
                }
            }
        }
        args.insert("limit".to_string(), json!(1));
        let res = self.tools.call("find_node", Value::Object(args)).await;
        if !res["ok"].as_bool().unwrap_or(false) {
            let msg = res["error"]["message"].as_str().unwrap_or("find_node 失败");
            return err(format!("节点未找到: {msg}"));
        }
        let matches = res["matches"].as_array().cloned().unwrap_or_default();
        match matches.first() {
            Some(m) => Ok(m["node_id"].as_i64()),
            None => err("节点未找到（选择器无匹配）"),
        }
    }

    async fn dispatch_basic(&mut self, op: &str, args: Value, save_to: Option<&str>) -> Result<(), ScriptError> {
        match op {
            "wait" => {
                let ms = args["ms"].as_u64().unwrap_or(500);
                self.tools.call("sleep", json!({ "ms": ms })).await;
            }
            "wait_for_node" | "wait_for_text" | "wait_for_app" => {
                let res = self.tools.call(op, args.clone()).await;
                if !res["ok"].as_bool().unwrap_or(false) {
                    let msg = res["error"]["message"].as_str().unwrap_or("等待超时");
                    return err(msg);
                }
                if let Some(var) = save_to {
                    self.vars.insert(var.to_string(), res);
                }
            }
            "get_layout" => {
                let res = self.tools.call("get_layout", args).await;
                check_ok(&res, "get_layout")?;
                if let Some(var) = save_to {
                    self.vars.insert(var.to_string(), res["root"].clone());
                }
            }
            "get_node" | "read_node" => {
                let selector = args["selector"].clone();
                let node_id = self.resolve_selector(&selector).await?;
                if let Value::Object(mut find_args) = args.clone() {
                    if let Some(obj) = selector.as_object() {
                        for (k, v) in obj {
                            if k != "scope" {
                                find_args.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    find_args.insert("limit".to_string(), json!(1));
                    let res = self.tools.call("find_node", Value::Object(find_args)).await;
                    check_ok(&res, "find_node")?;
                    let first = res["matches"].as_array().and_then(|m| m.first()).cloned().unwrap_or(Value::Null);
                    let picked = if op == "read_node" {
                        pick_fields(&first, &args["fields"])
                    } else {
                        first
                    };
                    let _ = node_id;
                    if let Some(var) = save_to {
                        self.vars.insert(var.to_string(), picked);
                    }
                }
            }
            "read_nodes" => {
                let selector = args["selector"].clone();
                let mut find_args = Map::new();
                if let Some(obj) = selector.as_object() {
                    for (k, v) in obj {
                        if k != "scope" {
                            find_args.insert(k.clone(), v.clone());
                        }
                    }
                }
                let limit = args["limit"].as_u64().unwrap_or(10);
                find_args.insert("limit".to_string(), json!(limit));
                let res = self.tools.call("find_node", Value::Object(find_args)).await;
                check_ok(&res, "read_nodes")?;
                let matches = res["matches"].as_array().cloned().unwrap_or_default();
                let fields = &args["fields"];
                let picked: Vec<Value> = matches.iter().map(|m| pick_fields(m, fields)).collect();
                if let Some(var) = save_to {
                    self.vars.insert(var.to_string(), Value::Array(picked));
                }
            }
            "read_clipboard" => {
                let res = self.tools.call("read_clipboard", json!({})).await;
                check_ok(&res, "read_clipboard")?;
                if let Some(var) = save_to {
                    self.vars.insert(var.to_string(), res["text"].clone());
                }
            }
            "get_foreground_app" => {
                let res = self.tools.call("get_foreground_app", json!({})).await;
                check_ok(&res, "get_foreground_app")?;
                if let Some(var) = save_to {
                    self.vars.insert(var.to_string(), res);
                }
            }
            "screenshot" => {
                let res = self.tools.call("screenshot", json!({})).await;
                check_ok(&res, "screenshot")?;
                if let Some(var) = save_to {
                    self.vars.insert(var.to_string(), res["image_path"].clone());
                }
            }
            "click" | "long_click" => {
                let tool_args = if let Some(selector) = args.get("selector") {
                    let node_id = self.resolve_selector(selector).await?;
                    match node_id {
                        Some(id) if id >= 0 => json!({ "node_id": id }),
                        _ => return err("节点无法定位（无有效 node_id）"),
                    }
                } else {
                    json!({ "x": args["x"], "y": args["y"] })
                };
                let res = self.tools.call(op, tool_args).await;
                check_ok(&res, op)?;
            }
            "press" | "swipe" | "gesture" | "input_text" | "key_event" | "global_action"
            | "set_clipboard" | "open_url" => {
                let res = self.tools.call(op, args).await;
                check_ok(&res, op)?;
            }
            "launch_app" => {
                let app = args["app_name"].as_str().or_else(|| args["pkg"].as_str()).unwrap_or_default();
                if app.is_empty() {
                    return err("launch_app 缺少 app_name 或 pkg");
                }
                let res = self.tools.call("launch_app", json!({ "app": app })).await;
                check_ok(&res, "launch_app")?;
                if let Some(var) = save_to {
                    self.vars.insert(var.to_string(), res.clone());
                }
            }
            "node_action" => {
                let selector = args["selector"].clone();
                let node_id = self
                    .resolve_selector(&selector)
                    .await?
                    .ok_or_else(|| ScriptError("节点无有效 node_id".into()))?;
                let action = args["action"].as_str().unwrap_or_default();
                let res = self
                    .tools
                    .call("node_action", json!({ "node_id": node_id, "action": action, "text": args["text"], "args": args["action_args"] }))
                    .await;
                check_ok(&res, "node_action")?;
            }
            "paste" => {
                let mut tool_args = Map::new();
                if let Some(selector) = args.get("selector") {
                    if let Some(id) = self.resolve_selector(selector).await? {
                        tool_args.insert("node_id".to_string(), json!(id));
                    }
                }
                if let Some(text) = args.get("text") {
                    tool_args.insert("text".to_string(), text.clone());
                }
                let res = self.tools.call("paste", Value::Object(tool_args)).await;
                check_ok(&res, "paste")?;
            }
            "scroll" => {
                let mut tool_args = Map::new();
                tool_args.insert("direction".to_string(), args["direction"].clone());
                tool_args.insert("times".to_string(), args.get("times").cloned().unwrap_or(json!(1)));
                if let Some(selector) = args.get("selector") {
                    if let Some(id) = self.resolve_selector(selector).await? {
                        tool_args.insert("node_id".to_string(), json!(id));
                    }
                }
                let res = self.tools.call("scroll", Value::Object(tool_args)).await;
                check_ok(&res, "scroll")?;
            }
            other => return err(format!("未知基础原语: {other}")),
        }
        Ok(())
    }
}

fn check_ok(res: &Value, op: &str) -> Result<(), ScriptError> {
    if res["ok"].as_bool().unwrap_or(false) {
        Ok(())
    } else {
        let msg = res["error"]["message"].as_str().unwrap_or("执行失败");
        err(format!("{op} 失败: {msg}"))
    }
}

fn pick_fields(node: &Value, fields: &Value) -> Value {
    let Some(list) = fields.as_array() else {
        return node.clone();
    };
    let mut out = Map::new();
    for f in list {
        if let Some(name) = f.as_str() {
            out.insert(name.to_string(), node[name].clone());
        }
    }
    Value::Object(out)
}

fn collect_texts(node: &Value, out: &mut Vec<String>) {
    if let Some(t) = node["text"].as_str() {
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
    if let Some(d) = node["desc"].as_str() {
        if !d.is_empty() {
            out.push(d.to_string());
        }
    }
    if let Some(children) = node["children"].as_array() {
        for c in children {
            collect_texts(c, out);
        }
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_start_matches('¥').parse::<f64>().ok(),
        _ => None,
    }
}

fn compare_num(a: &Value, b: &Value, cmp: impl Fn(f64, f64) -> bool) -> Result<bool, ScriptError> {
    match (as_f64(a), as_f64(b)) {
        (Some(x), Some(y)) => Ok(cmp(x, y)),
        _ => Ok(cmp(
            value_to_string(a).len() as f64,
            value_to_string(b).len() as f64,
        )),
    }
}

fn value_equals(a: &Value, b: &Value) -> bool {
    if a == b {
        return true;
    }
    match (as_f64(a), as_f64(b)) {
        (Some(x), Some(y)) => (x - y).abs() < f64::EPSILON,
        _ => value_to_string(a) == value_to_string(b),
    }
}

// ── 核心循环（§7 run：op 分发 + on_fail 语义 + 护栏） ──────────────────
//
// 生命周期说明：steps 与 ctx 共用调用点的推断区域 's（而非 Interpreter 自身的 'i），
// 递归调用点用 &mut *ctx 再借用，使每次递归的借用区域局限于当次 await，
// 避免 E0499/E0502（递归 async + BoxFuture 的标准写法）。

fn run_steps<'s, 'i>(
    steps: &'s [Value],
    ctx: &'s mut Interpreter<'i>,
) -> BoxFuture<'s, Result<Flow, ScriptError>> {
    Box::pin(async move {
        for (idx, step) in steps.iter().enumerate() {
            ctx.check_deadline()?;
            ctx.steps_executed += 1;
            if ctx.steps_executed > ctx.max_steps {
                return err("步数超限（max_steps 防死循环兜底）");
            }

            let op = step["op"].as_str().unwrap_or_default();
            if op.is_empty() {
                return err(format!("steps[{idx}] 缺少 op 字段"));
            }

            let outcome: Result<Flow, ScriptError> = match op {
                "set" => {
                    let var = step["var"].as_str().unwrap_or_default().to_string();
                    if var.is_empty() {
                        err("set 缺少 var 字段")
                    } else {
                        let value = ctx.interpolate(&step["value"]);
                        ctx.vars.insert(var, value);
                        Ok(Flow::Continue)
                    }
                }
                "if" => {
                    let cond = step["condition"].clone();
                    let taken = ctx.eval_condition(&cond).await?;
                    let branch = if taken {
                        step["then"].as_array()
                    } else {
                        step["else"].as_array()
                    };
                    if let Some(branch_steps) = branch {
                        match run_steps(branch_steps, &mut *ctx).await? {
                            Flow::Return => return Ok(Flow::Return),
                            Flow::Continue => {}
                        }
                    }
                    Ok(Flow::Continue)
                }
                "repeat" => {
                    let times_val = ctx.interpolate(&step["times"]);
                    let times = times_val.as_u64().unwrap_or(1);
                    let sub = step["steps"].as_array().cloned().unwrap_or_default();
                    for _ in 0..times {
                        match run_steps(&sub, &mut *ctx).await? {
                            Flow::Return => return Ok(Flow::Return),
                            Flow::Continue => {}
                        }
                    }
                    Ok(Flow::Continue)
                }
                "for_each" => {
                    let var = step["var"].as_str().unwrap_or_default().to_string();
                    let items = ctx.interpolate(&step["items"]);
                    let list = items.as_array().cloned().unwrap_or_default();
                    let sub = step["steps"].as_array().cloned().unwrap_or_default();
                    for item in list {
                        ctx.vars.insert(var.clone(), item);
                        match run_steps(&sub, &mut *ctx).await? {
                            Flow::Return => return Ok(Flow::Return),
                            Flow::Continue => {}
                        }
                    }
                    Ok(Flow::Continue)
                }
                "repeat_until" => {
                    let cond = step["condition"].clone();
                    let max_attempts = step["max_attempts"].as_u64().unwrap_or(3);
                    let sub = step["steps"].as_array().cloned().unwrap_or_default();
                    let mut attempts = 0u64;
                    let mut met = ctx.eval_condition(&cond).await?;
                    while !met && attempts < max_attempts {
                        attempts += 1;
                        match run_steps(&sub, &mut *ctx).await? {
                            Flow::Return => return Ok(Flow::Return),
                            Flow::Continue => {}
                        }
                        met = ctx.eval_condition(&cond).await?;
                    }
                    // 循环计数暴露给脚本（如 compare_price 的 page_checked）
                    ctx.vars.insert("loop".to_string(), json!({ "attempts": attempts }));
                    if !met {
                        err(format!("repeat_until 达到上限（{max_attempts} 次）条件仍未满足"))
                    } else {
                        Ok(Flow::Continue)
                    }
                }
                "retry" => {
                    let attempts = step["attempts"].as_u64().unwrap_or(DEFAULT_RETRY_ATTEMPTS as u64);
                    let interval = step["interval_ms"].as_u64().unwrap_or(RETRY_INTERVAL_MS);
                    let sub = step["steps"].as_array().cloned().unwrap_or_default();
                    let mut last_err = None;
                    let mut succeeded = false;
                    for _ in 0..attempts {
                        match run_steps(&sub, &mut *ctx).await {
                            Ok(Flow::Continue) => {
                                succeeded = true;
                                break;
                            }
                            Ok(Flow::Return) => return Ok(Flow::Return),
                            Err(e) => {
                                last_err = Some(e);
                                tokio::time::sleep(Duration::from_millis(interval)).await;
                            }
                        }
                    }
                    if succeeded {
                        Ok(Flow::Continue)
                    } else {
                        err(format!(
                            "retry 块 {attempts} 次均失败: {}",
                            last_err.map(|e| e.0).unwrap_or_default()
                        ))
                    }
                }
                "call" => {
                    let name = step["script_name"].as_str().unwrap_or_default();
                    if name.is_empty() {
                        err("call 缺少 script_name 字段")
                    } else {
                        let params = ctx.interpolate(&step["params"]);
                        let value = if name.starts_with("native.") {
                            native::call_native(name, &params).map_err(ScriptError)?
                        } else {
                            if ctx.call_depth >= MAX_CALL_DEPTH {
                                return err(format!("call 嵌套深度超过上限 {MAX_CALL_DEPTH}"));
                            }
                            ctx.caller
                                .run_sub_script(name, params, ctx.call_depth + 1)
                                .await
                                .map_err(ScriptError)?
                        };
                        if let Some(save_to) = step["save_to"].as_str() {
                            ctx.vars.insert(save_to.to_string(), value);
                        }
                        Ok(Flow::Continue)
                    }
                }
                "emit" => {
                    let key = step["key"].as_str().unwrap_or_default().to_string();
                    if key.is_empty() {
                        err("emit 缺少 key 字段")
                    } else {
                        let value = ctx.interpolate(&step["value"]);
                        // 约定：key == "item" → 追加到 result.items 数组（比价等列表场景）
                        if key == "item" {
                            let items = ctx
                                .result
                                .entry("items".to_string())
                                .or_insert_with(|| Value::Array(Vec::new()));
                            if let Value::Array(arr) = items {
                                arr.push(value);
                            }
                        } else {
                            ctx.result.insert(key, value);
                        }
                        Ok(Flow::Continue)
                    }
                }
                "extract" => {
                    let args = ctx.interpolate(&step["args"]);
                    let selector = args["selector"].clone();
                    let field = args["field"].as_str().unwrap_or("text");
                    let mut find_args = Map::new();
                    if let Some(obj) = selector.as_object() {
                        for (k, v) in obj {
                            if k != "scope" {
                                find_args.insert(k.clone(), v.clone());
                            }
                        }
                    }
                    find_args.insert("limit".to_string(), json!(1));
                    let res = ctx.tools.call("find_node", Value::Object(find_args)).await;
                    check_ok(&res, "extract.find_node")?;
                    let first = res["matches"].as_array().and_then(|m| m.first()).cloned();
                    let raw = first
                        .as_ref()
                        .map(|m| value_to_string(&m[field]))
                        .unwrap_or_default();
                    let extracted = if let Some(pattern) = args["regex"].as_str() {
                        let re = regex::Regex::new(pattern)
                            .map_err(|e| ScriptError(format!("extract 正则非法: {e}")))?;
                        re.captures(&raw)
                            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                            .unwrap_or(raw.clone())
                    } else {
                        raw
                    };
                    // 数字字符串自动转数值（"12.99" → 12.99，便于 less_than 比较）
                    let value: Value = extracted
                        .parse::<f64>()
                        .ok()
                        .filter(|_| extracted.chars().any(|c| c.is_ascii_digit()))
                        .map(|n| json!(n))
                        .unwrap_or(Value::String(extracted));
                    let save_to = args["save_to"].as_str().or_else(|| step["save_to"].as_str());
                    match save_to {
                        Some(var) => {
                            ctx.vars.insert(var.to_string(), value);
                            Ok(Flow::Continue)
                        }
                        None => err("extract 缺少 save_to"),
                    }
                }
                "return" => {
                    let value = ctx.interpolate(&step["value"]);
                    if let Value::Object(map) = value {
                        for (k, v) in map {
                            ctx.result.insert(k, v);
                        }
                    }
                    Ok(Flow::Return)
                }
                _ => {
                    // 感知/操作原语 → 基础工具层（规格书 §7 dispatch_basic）
                    let args = ctx.interpolate(&step["args"]);
                    let save_to = step["save_to"].as_str().map(|s| s.to_string());
                    ctx.dispatch_basic(op, args, save_to.as_deref()).await?;
                    Ok(Flow::Continue)
                }
            };

            // on_fail 语义（§4.4：abort 默认 / retry 需配 retry_attempts / skip）
            match outcome {
                Ok(Flow::Continue) => continue,
                Ok(Flow::Return) => return Ok(Flow::Return),
                Err(e) => {
                    let (strategy, retry_attempts) = parse_on_fail(step);
                    match strategy.as_str() {
                        "skip" => continue,
                        "retry" => {
                            let mut last = e;
                            let mut ok = false;
                            for _ in 0..retry_attempts {
                                tokio::time::sleep(Duration::from_millis(RETRY_INTERVAL_MS)).await;
                                // 重试仅对基础原语有意义（控制流重试请用 retry 块）
                                let args = ctx.interpolate(&step["args"]);
                                let save_to = step["save_to"].as_str().map(|s| s.to_string());
                                match ctx.dispatch_basic(op, args, save_to.as_deref()).await {
                                    Ok(()) => {
                                        ok = true;
                                        break;
                                    }
                                    Err(e2) => last = e2,
                                }
                            }
                            if !ok {
                                return Err(last);
                            }
                        }
                        _ => return Err(e),
                    }
                }
            }
        }
        Ok(Flow::Continue)
    })
}

fn parse_on_fail(step: &Value) -> (String, usize) {
    match &step["on_fail"] {
        Value::String(s) => (s.clone(), DEFAULT_RETRY_ATTEMPTS),
        Value::Object(map) => {
            let strategy = map["strategy"].as_str().unwrap_or("abort").to_string();
            let attempts = map["retry_attempts"].as_u64().unwrap_or(DEFAULT_RETRY_ATTEMPTS as u64) as usize;
            (strategy, attempts)
        }
        _ => ("abort".to_string(), 0),
    }
}
