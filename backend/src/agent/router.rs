//! tool_router（规格书 6.6：入参校验 → 分发 → 结构化结果 + 执行轨迹）。
//!
//! 分发规则：
//! - 原生工具（NATIVE_TOOLS）→ Kotlin 本地桥
//! - 脚本工具（SCRIPT_TOOLS）→ ScriptEngine / ScriptRegistry
//! - report_progress → 仅记录轨迹（前端流式展示，不中断循环）

use super::native_bridge::NativeBridge;
use super::schemas;
use super::trace::TraceStore;
use crate::script::model::{ScriptDef, ScriptSource};
use crate::script::ScriptEngine;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone)]
pub struct AgentRouter {
    pub bridge: NativeBridge,
    pub trace: Arc<TraceStore>,
    pub engine: ScriptEngine,
}

impl AgentRouter {
    pub fn new(bridge: NativeBridge, trace: Arc<TraceStore>, engine: ScriptEngine) -> Self {
        Self { bridge, trace, engine }
    }

    /// 通用工具调用入口（POST /api/agent/tool）
    pub async fn execute(&self, tool: &str, args: &Value, chat_id: &str) -> Value {
        let start = Instant::now();

        // 入参校验（必须字段缺失 → 明确错误，LLM 可自我纠正重调）
        if let Err(e) = schemas::validate_args(tool, args) {
            return json!({
                "ok": false,
                "error": { "code": "invalid_args", "message": e }
            });
        }

        let result = if schemas::NATIVE_TOOLS.contains(&tool) {
            self.bridge.call_tool(tool, args).await
        } else if schemas::SCRIPT_TOOLS.contains(&tool) {
            self.execute_script_tool(tool, args, chat_id).await
        } else if tool == "report_progress" {
            // 前端流式展示，不中断循环（规格书 6.4）
            json!({ "ok": true, "message": args["message"].as_str().unwrap_or_default() })
        } else {
            json!({
                "ok": false,
                "error": { "code": "unknown_tool", "message": format!("未知工具: {tool}") }
            })
        };

        self.trace.record(
            chat_id,
            tool,
            args.clone(),
            result.clone(),
            start.elapsed().as_millis() as u64,
        );
        result
    }

    async fn execute_script_tool(&self, tool: &str, args: &Value, chat_id: &str) -> Value {
        match tool {
            "run_script" => {
                let name = args["script_name"].as_str().unwrap_or_default();
                if name.is_empty() {
                    return json!({
                        "ok": false,
                        "error": { "code": "invalid_args", "message": "缺少必需参数: script_name" }
                    });
                }
                let params = args.get("params").cloned().unwrap_or(json!({}));
                let confirmed = args["confirmed"].as_bool().unwrap_or(false);
                let outcome = self
                    .engine
                    .run_script(name, params, chat_id, confirmed, 0)
                    .await;
                // run_script 契约包一层 ok（needs_confirmation 也属正常分支）
                let mut wrapped = outcome;
                wrapped["ok"] = json!(true);
                wrapped
            }
            "list_scripts" => {
                let scripts = self.engine.registry.list().await;
                json!({ "ok": true, "scripts": scripts })
            }
            "create_script" => {
                let mut script_value = args.clone();
                script_value["source"] = json!("user");
                let script: ScriptDef = match serde_json::from_value(script_value) {
                    Ok(s) => s,
                    Err(e) => {
                        return json!({
                            "ok": false,
                            "error": { "code": "bad_script", "message": format!("脚本结构解析失败: {e}") }
                        })
                    }
                };
                let report = self.engine.validate(&script).await;
                if !report.valid {
                    return json!({
                        "ok": false,
                        "error": { "code": "validation_failed", "message": "脚本静态校验失败" },
                        "report": report.to_json()
                    });
                }
                match self.engine.registry.upsert(script).await {
                    Ok(()) => json!({ "ok": true, "registered": true }),
                    Err(e) => json!({
                        "ok": false,
                        "error": { "code": "register_failed", "message": e }
                    }),
                }
            }
            "validate_script" => {
                let script: ScriptDef = match serde_json::from_value(args["script"].clone()) {
                    Ok(s) => s,
                    Err(e) => {
                        return json!({
                            "ok": false,
                            "error": { "code": "bad_script", "message": format!("脚本结构解析失败: {e}") }
                        })
                    }
                };
                let report = self.engine.validate(&script).await;
                json!({ "ok": true, "report": report.to_json() })
            }
            _ => json!({
                "ok": false,
                "error": { "code": "unknown_tool", "message": format!("未知脚本工具: {tool}") }
            }),
        }
    }

    /// 注册脚本（路由层共用：PUT /import）。source 由调用方指定。
    pub async fn register_script(&self, mut script: ScriptDef, source: ScriptSource) -> Value {
        script.source = source;
        if source == ScriptSource::Shared {
            // 分享导入的脚本：默认 risky + 禁用（§12.4）
            script.risky = true;
            script.enabled = false;
        }
        let report = self.engine.validate(&script).await;
        if !report.valid {
            return json!({
                "ok": false,
                "error": { "code": "validation_failed", "message": "脚本静态校验失败" },
                "report": report.to_json()
            });
        }
        match self.engine.registry.upsert(script).await {
            Ok(()) => json!({ "ok": true, "report": report.to_json() }),
            Err(e) => json!({
                "ok": false,
                "error": { "code": "register_failed", "message": e }
            }),
        }
    }
}
