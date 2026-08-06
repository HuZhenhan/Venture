//! Script 引擎门面：把解释器、注册表、原生桥、执行轨迹组装起来。
//!
//! run_script 契约（DSL 规格书 §1）：
//!   调用 run_script(name, params) → { status, result, duration_ms, steps_executed, last_error }
//!   高危/危险动作/分享脚本未确认时 → { status: "needs_confirmation", ... }

use super::interpreter::{Interpreter, ScriptCaller, ToolCaller};
use super::model::{ScriptDef, ScriptSource};
use super::registry::ScriptRegistry;
use super::validate;
use crate::agent::native_bridge::NativeBridge;
use crate::agent::trace::TraceStore;
use futures_util::future::BoxFuture;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone)]
pub struct ScriptEngine {
    pub registry: Arc<ScriptRegistry>,
    bridge: NativeBridge,
    trace: Arc<TraceStore>,
}

impl ScriptEngine {
    pub fn new(registry: Arc<ScriptRegistry>, bridge: NativeBridge, trace: Arc<TraceStore>) -> Self {
        Self { registry, bridge, trace }
    }

    /// 危险动作检测（§12.4 动态护栏：含 click/input_text/paste/key_event 但未标 risky）
    fn contains_dangerous_ops(steps: &[Value]) -> bool {
        const DANGEROUS: &[&str] = &["click", "long_click", "input_text", "paste", "key_event"];
        steps.iter().any(|step| {
            let op = step["op"].as_str().unwrap_or_default();
            if DANGEROUS.contains(&op) {
                return true;
            }
            ["steps", "then", "else"].iter().any(|k| {
                step[k].as_array().map(|sub| Self::contains_dangerous_ops(sub)).unwrap_or(false)
            })
        })
    }

    /// 应用参数定义：必填校验 + 默认值填充
    fn apply_params(script: &ScriptDef, params: &Value) -> Result<Value, String> {
        let mut merged = Map::new();
        let input = params.as_object();
        for p in &script.params {
            let provided = input.and_then(|m| m.get(&p.name)).cloned();
            match (provided, &p.default, p.required) {
                (Some(v), _, _) => {
                    merged.insert(p.name.clone(), v);
                }
                (None, Some(d), _) => {
                    merged.insert(p.name.clone(), d.clone());
                }
                (None, None, true) => return Err(format!("缺少必需参数: {}", p.name)),
                (None, None, false) => {}
            }
        }
        // 未声明的额外参数也透传（宽容策略）
        if let Some(m) = input {
            for (k, v) in m {
                merged.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
        Ok(Value::Object(merged))
    }

    /// 运行脚本（主入口，run_script tool 与 /run 路由共用）
    pub async fn run_script(
        &self,
        name: &str,
        params: Value,
        chat_id: &str,
        confirmed: bool,
        call_depth: usize,
    ) -> Value {
        let start = Instant::now();
        let Some(script) = self.registry.get(name).await else {
            return json!({
                "status": "not_found",
                "result": null,
                "duration_ms": 0,
                "steps_executed": 0,
                "last_error": format!("脚本不存在: {name}"),
            });
        };

        if !script.enabled {
            return json!({
                "status": "disabled",
                "result": null,
                "duration_ms": 0,
                "steps_executed": 0,
                "last_error": format!("脚本已禁用: {name}"),
            });
        }

        // 护栏（§9 / §12.4）：
        // 1. risky 脚本 → 强制确认
        // 2. 分享导入脚本 → 逐次确认
        // 3. 含危险动作但未标 risky → 强制确认
        let needs_confirmation = !confirmed
            && (script.risky
                || script.source == ScriptSource::Shared
                || Self::contains_dangerous_ops(&script.steps));
        if needs_confirmation {
            let reason = if script.risky {
                "高危脚本（risky）需要用户确认后执行"
            } else if script.source == ScriptSource::Shared {
                "分享导入的脚本需要逐次确认后执行"
            } else {
                "脚本含危险动作（click/input_text/paste/key_event），需要用户确认后执行"
            };
            return json!({
                "status": "needs_confirmation",
                "result": null,
                "duration_ms": 0,
                "steps_executed": 0,
                "last_error": null,
                "confirmation": {
                    "script": name,
                    "reason": reason,
                    "risky": script.risky,
                },
            });
        }

        let merged_params = match Self::apply_params(&script, &params) {
            Ok(p) => p,
            Err(e) => {
                return json!({
                    "status": "error",
                    "result": null,
                    "duration_ms": 0,
                    "steps_executed": 0,
                    "last_error": e,
                })
            }
        };

        let engine = self.clone();
        let chat_id_owned = chat_id.to_string();
        let tools = EngineToolCaller { engine: engine.clone(), chat_id: chat_id_owned.clone() };
        let caller = EngineScriptCaller { engine, chat_id: chat_id_owned };

        let interpreter = Interpreter::new(&script, merged_params, &tools, &caller, call_depth);
        let outcome = interpreter.execute(&script.steps).await;

        self.registry.increment_run_count(name).await;
        let duration_ms = start.elapsed().as_millis() as u64;

        json!({
            "status": outcome.status,
            "result": outcome.result,
            "duration_ms": duration_ms,
            "steps_executed": outcome.steps_executed,
            "last_error": outcome.last_error,
        })
    }

    /// 静态校验（validate_script / create_script / 导入共用）
    pub async fn validate(&self, script: &ScriptDef) -> validate::ValidationReport {
        let known: std::collections::HashSet<String> = self
            .registry
            .list()
            .await
            .into_iter()
            .map(|s| s.name)
            .collect();
        validate::validate_script(script, &known)
    }
}

/// 基础工具层实现：转发到原生桥 + 记录执行轨迹
struct EngineToolCaller {
    engine: ScriptEngine,
    chat_id: String,
}

impl ToolCaller for EngineToolCaller {
    fn call<'a>(&'a self, tool: &'a str, args: Value) -> BoxFuture<'a, Value> {
        Box::pin(async move {
            let start = Instant::now();
            let result = self.engine.bridge.call_tool(tool, &args).await;
            self.engine.trace.record(
                &self.chat_id,
                tool,
                args,
                result.clone(),
                start.elapsed().as_millis() as u64,
            );
            result
        })
    }
}

/// 子脚本调用器（call 原语）
struct EngineScriptCaller {
    engine: ScriptEngine,
    chat_id: String,
}

impl ScriptCaller for EngineScriptCaller {
    fn run_sub_script<'a>(
        &'a self,
        name: &'a str,
        params: Value,
        depth: usize,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let result = self
                .engine
                .run_script(name, params, &self.chat_id, true, depth)
                .await;
            if result["status"].as_str() == Some("ok") {
                Ok(result["result"].clone())
            } else {
                Err(result["last_error"].as_str().unwrap_or("子脚本执行失败").to_string())
            }
        })
    }
}

use serde_json::Map;
