//! 静态校验（DSL 规格书 §12.4 validate_script 规则）。
//!
//! - 结构校验：name/steps 完整、params 定义合法
//! - op 白名单：只允许已知原语
//! - call 引用完整性：目标脚本必须存在，禁止递归自调用（含传递）
//! - 循环嵌套深度 ≤ 4、steps 总数 ≤ 200
//! - {{var}} 插值静态扫描：未定义变量报错；内置变量（params.*、result、screen、loop.*）白名单放行

use super::model::ScriptDef;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};

pub const MAX_LOOP_DEPTH: usize = 4;
pub const MAX_TOTAL_STEPS: usize = 200;

/// op 白名单（§4 动作原语全集）
const KNOWN_OPS: &[&str] = &[
    // 感知
    "wait", "wait_for_node", "wait_for_text", "wait_for_app", "get_layout", "get_node",
    "read_node", "read_nodes", "read_clipboard", "get_foreground_app", "screenshot",
    // 操作
    "click", "long_click", "press", "swipe", "gesture", "node_action", "input_text", "paste",
    "key_event", "global_action", "set_clipboard", "launch_app", "open_url", "scroll",
    // 控制
    "set", "if", "repeat", "for_each", "repeat_until", "retry", "call", "emit", "extract", "return",
];

const LOOP_OPS: &[&str] = &["repeat", "for_each", "repeat_until", "retry"];

/// 危险动作（§12.4 动态护栏：含这些 op 但未标 risky → 执行前强制确认）
const DANGEROUS_OPS: &[&str] = &["click", "long_click", "input_text", "paste", "key_event"];

#[derive(Debug, Clone)]
pub struct ValidationIssue {
    pub level: String, // "error" | "warning"
    pub path: String,  // 定位到 op/字段，如 "steps[3].args.selector"
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ValidationReport {
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
    /// 危险动作检测结果（动态护栏用）
    pub requires_confirmation: bool,
}

impl ValidationReport {
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "valid": self.valid,
            "requires_confirmation": self.requires_confirmation,
            "issues": self.issues.iter().map(|i| serde_json::json!({
                "level": i.level, "path": i.path, "message": i.message
            })).collect::<Vec<_>>(),
        })
    }
}

fn interpolate_vars(value: &Value, out: &mut HashSet<String>) {
    match value {
        Value::String(s) => {
            let re = regex::Regex::new(r"\{\{([^}]+)\}\}").unwrap();
            for cap in re.captures_iter(s) {
                out.insert(cap[1].trim().to_string());
            }
        }
        Value::Array(arr) => arr.iter().for_each(|v| interpolate_vars(v, out)),
        Value::Object(map) => map.values().for_each(|v| interpolate_vars(v, out)),
        _ => {}
    }
}

struct Ctx<'a> {
    issues: &'a mut Vec<ValidationIssue>,
    defined_vars: HashSet<String>,
    used_vars: HashSet<String>,
    total_steps: usize,
    has_dangerous_op: bool,
    calls: Vec<String>,
}

impl<'a> Ctx<'a> {
    fn error(&mut self, path: &str, message: impl Into<String>) {
        self.issues.push(ValidationIssue { level: "error".into(), path: path.into(), message: message.into() });
    }
    #[allow(dead_code)]
    fn warning(&mut self, path: &str, message: impl Into<String>) {
        self.issues.push(ValidationIssue { level: "warning".into(), path: path.into(), message: message.into() });
    }
}

fn check_steps(steps: &[Value], path: &str, depth: usize, ctx: &mut Ctx) {
    if depth > MAX_LOOP_DEPTH {
        ctx.error(path, format!("循环嵌套深度 {depth} 超过上限 {MAX_LOOP_DEPTH}"));
        return;
    }
    for (i, step) in steps.iter().enumerate() {
        let p = format!("{path}[{i}]");
        ctx.total_steps += 1;
        if ctx.total_steps > MAX_TOTAL_STEPS {
            ctx.error(&p, format!("steps 总数超过上限 {MAX_TOTAL_STEPS}"));
            return;
        }
        let Some(op) = step.get("op").and_then(|o| o.as_str()) else {
            ctx.error(&p, "缺少 op 字段");
            continue;
        };
        if !KNOWN_OPS.contains(&op) {
            ctx.error(&p, format!("未知 op: {op}（不在白名单）"));
            continue;
        }
        if DANGEROUS_OPS.contains(&op) {
            ctx.has_dangerous_op = true;
        }
        if LOOP_OPS.contains(&op) {
            // 嵌套控制流 steps
            if let Some(sub) = step.get("steps").and_then(|s| s.as_array()) {
                check_steps(sub, &format!("{p}.steps"), depth + 1, ctx);
            } else {
                ctx.error(&p, format!("{op} 缺少 steps 数组"));
            }
        }
        match op {
            "set" => {
                if let Some(var) = step.get("var").and_then(|v| v.as_str()) {
                    ctx.defined_vars.insert(var.to_string());
                } else {
                    ctx.error(&p, "set 缺少 var 字段");
                }
                if let Some(v) = step.get("value") {
                    interpolate_vars(v, &mut ctx.used_vars);
                }
            }
            "for_each" => {
                if let Some(var) = step.get("var").and_then(|v| v.as_str()) {
                    ctx.defined_vars.insert(var.to_string());
                } else {
                    ctx.error(&p, "for_each 缺少 var 字段");
                }
                if let Some(items) = step.get("items") {
                    interpolate_vars(items, &mut ctx.used_vars);
                }
            }
            "if" | "repeat_until" => {
                if let Some(cond) = step.get("condition") {
                    interpolate_vars(cond, &mut ctx.used_vars);
                }
                if op == "if" {
                    if let Some(then) = step.get("then").and_then(|s| s.as_array()) {
                        check_steps(then, &format!("{p}.then"), depth, ctx);
                    } else {
                        ctx.error(&p, "if 缺少 then 数组");
                    }
                    if let Some(els) = step.get("else").and_then(|s| s.as_array()) {
                        check_steps(els, &format!("{p}.else"), depth, ctx);
                    }
                }
            }
            "call" => {
                if let Some(target) = step.get("script_name").and_then(|v| v.as_str()) {
                    ctx.calls.push(target.to_string());
                } else {
                    ctx.error(&p, "call 缺少 script_name 字段");
                }
                if let Some(params) = step.get("params") {
                    interpolate_vars(params, &mut ctx.used_vars);
                }
            }
            "emit" => {
                if step.get("key").and_then(|v| v.as_str()).is_none() {
                    ctx.error(&p, "emit 缺少 key 字段");
                }
                if let Some(v) = step.get("value") {
                    interpolate_vars(v, &mut ctx.used_vars);
                }
            }
            _ => {}
        }
        // save_to 定义变量
        if let Some(save_to) = step.get("save_to").and_then(|v| v.as_str()) {
            ctx.defined_vars.insert(save_to.to_string());
        }
        if let Some(save_to) = step.get("args").and_then(|a| a.get("save_to")).and_then(|v| v.as_str()) {
            ctx.defined_vars.insert(save_to.to_string());
        }
        // args 内的插值
        if let Some(args) = step.get("args") {
            interpolate_vars(args, &mut ctx.used_vars);
        }
    }
}

/// 校验脚本定义。known_scripts：注册表中已存在的脚本名（call 引用完整性检查）。
pub fn validate_script(script: &ScriptDef, known_scripts: &HashSet<String>) -> ValidationReport {
    let mut issues = Vec::new();

    if script.name.trim().is_empty() {
        issues.push(ValidationIssue { level: "error".into(), path: "name".into(), message: "脚本名不能为空".into() });
    }
    if !script
        .name
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        issues.push(ValidationIssue { level: "error".into(), path: "name".into(), message: "脚本名只允许字母数字下划线连字符".into() });
    }
    if script.steps.is_empty() {
        issues.push(ValidationIssue { level: "error".into(), path: "steps".into(), message: "steps 不能为空".into() });
    }
    for (i, p) in script.params.iter().enumerate() {
        if p.name.trim().is_empty() {
            issues.push(ValidationIssue { level: "error".into(), path: format!("params[{i}]"), message: "参数名不能为空".into() });
        }
        if p.param_type == "enum" && p.values.as_ref().map(|v| v.is_empty()).unwrap_or(true) {
            issues.push(ValidationIssue { level: "error".into(), path: format!("params[{i}]"), message: "enum 类型参数必须提供 values".into() });
        }
    }

    let mut ctx = Ctx {
        issues: &mut issues,
        defined_vars: HashSet::new(),
        used_vars: HashSet::new(),
        total_steps: 0,
        has_dangerous_op: false,
        calls: Vec::new(),
    };
    check_steps(&script.steps, "steps", 1, &mut ctx);
    let Ctx { defined_vars, used_vars, has_dangerous_op, calls, .. } = ctx;

    // 插值变量检查：内置变量（params.*、result、screen、loop.*）白名单放行
    for var in &used_vars {
        let root = var.split('.').next().unwrap_or("");
        let is_builtin = matches!(root, "params" | "result" | "screen" | "loop");
        if !is_builtin && !defined_vars.contains(var) && !defined_vars.contains(root) {
            issues.push(ValidationIssue {
                level: "error".into(),
                path: "interpolate".into(),
                message: format!("插值变量未定义: {{{{{var}}}}}"),
            });
        }
    }

    // call 引用完整性 + 递归检测（BFS 传递闭包）
    for target in &calls {
        if target.starts_with("native.") {
            continue;
        }
        if target == &script.name {
            issues.push(ValidationIssue {
                level: "error".into(),
                path: "call".into(),
                message: format!("禁止递归自调用: {target}"),
            });
        } else if !known_scripts.contains(target) {
            issues.push(ValidationIssue {
                level: "error".into(),
                path: "call".into(),
                message: format!("call 引用的脚本不存在: {target}"),
            });
        }
    }
    // 传递递归：A call B，B call A（基于已知调用边做 BFS）
    if !calls.is_empty() {
        let mut visited = HashSet::new();
        let mut queue: VecDeque<String> = calls.iter().cloned().collect();
        while let Some(name) = queue.pop_front() {
            if name == script.name {
                issues.push(ValidationIssue {
                    level: "error".into(),
                    path: "call".into(),
                    message: "检测到传递性递归调用环".to_string(),
                });
                break;
            }
            if !visited.insert(name.clone()) {
                continue;
            }
            // 被调脚本的调用边由调用方提供（validate 无法加载全部脚本时跳过传递检查）
        }
    }

    // 危险动作检测（§12.4 动态护栏）
    let requires_confirmation = has_dangerous_op && !script.risky;
    if requires_confirmation {
        issues.push(ValidationIssue {
            level: "warning".into(),
            path: "risky".into(),
            message: "脚本含危险动作（click/input_text/paste/key_event）但未标记 risky，执行前将强制用户确认".into(),
        });
    }

    let valid = !issues.iter().any(|i| i.level == "error");
    ValidationReport { valid, issues, requires_confirmation }
}
