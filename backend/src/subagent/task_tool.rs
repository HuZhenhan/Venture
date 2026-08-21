//! Agent 调度工具（设计稿 §6）：调度入口。
//!
//! spawn_agent / get_agent_output / kill_agent / run_workflow / kill_workflow
//! 注册进 `get_tools_schema()`，经 POST /api/tools/execute 由前端 loop 调用。
//! 工具名与 TodoCreate 等清单工具明确区分，避免模型混淆。

use std::sync::Arc;

use serde_json::{json, Value};

use crate::config::ConfigStore;

use super::coordinator::{CoordinatorHandle, SpawnAck, TaskView, WaitOutcome};
use super::registry::AgentRegistry;
use super::types::{
    new_agent_id, CancelReason, Isolation, SubagentConfig,
    SubagentError, SubagentOwner, SubagentRequest, TaskToolInput,
};

/// 子代理系统门面（挂在 AppState 上）。
pub struct Subagents {
    pub handle: CoordinatorHandle,
    pub registry: Arc<std::sync::RwLock<AgentRegistry>>,
    pub config: Arc<std::sync::RwLock<SubagentConfig>>,
    pub store: Arc<ConfigStore>,
    pub data_dir: std::path::PathBuf,
}

impl Subagents {
    /// 工具执行入口（由 /api/tools/execute 分发）。
    /// 返回 (output, is_error)。
    pub async fn execute_tool(
        &self,
        tool: &str,
        input: &Value,
        ctx: &ToolCallContext,
    ) -> (String, bool) {
        match tool {
            "spawn_agent" => self.execute_spawn_agent(input, ctx).await,
            "get_agent_output" => self.execute_get_agent_output(input).await,
            "kill_agent" => self.execute_kill_agent(input).await,
            "run_workflow" => self.execute_run_workflow(input, ctx).await,
            "kill_workflow" => self.execute_kill_workflow(input).await,
            other => (format!("未知子代理工具：{other}"), true),
        }
    }

    // ─── spawn_agent（§6）─────────────────────────────────────────────────

    async fn execute_spawn_agent(&self, input: &Value, ctx: &ToolCallContext) -> (String, bool) {
        let parsed: TaskToolInput = match serde_json::from_value(input.clone()) {
            Ok(p) => p,
            Err(e) => return (format!("spawn_agent 参数解析失败：{e}"), true),
        };
        if parsed.prompt.trim().is_empty() {
            return ("spawn_agent 参数错误：prompt 不能为空".into(), true);
        }

        let config = self.config.read().unwrap().clone();

        // 1. 深度检查（§15.1）：主会话深度 0 → 子代理深度 1
        let depth = 1u32;
        if depth > config.max_subagent_depth {
            return (
                format!(
                    "已达到最大子代理深度（{}），无法再派生子代理。请在主会话中直接执行该操作。",
                    config.max_subagent_depth
                ),
                true,
            );
        }

        // 2. 类型校验（§6）：lookup → UnknownAgentType；mode=Primary → NotSubagent
        let definition = {
            let registry = self.registry.read().unwrap();
            match registry.lookup(&parsed.subagent_type) {
                Ok(d) => d.clone(),
                Err(e) => return (e.to_string(), true),
            }
        };

        // 3. 参数校验
        // depth_hint（仅 allow_model_depth_hint=true 时模型可传，§15.2）
        if let Some(hint) = parsed.depth_hint {
            if !config.allow_model_depth_hint {
                return ("depth_hint 未启用（allow_model_depth_hint=false）".into(), true);
            }
            if hint > config.max_subagent_depth {
                return (
                    format!("depth_hint 超过最大深度（{}）", config.max_subagent_depth),
                    true,
                );
            }
        }
        // isolation==worktree 与 cwd 互斥（§12）
        let isolation = parsed.isolation.clone().unwrap_or(Isolation::None);
        if isolation == Isolation::Worktree && parsed.cwd.is_some() {
            return ("isolation=worktree 与 cwd 不能同时指定".into(), true);
        }
        // model 合法性（§6：store.find_model 校验）
        let mut model = parsed
            .model
            .clone()
            .or_else(|| definition.model.clone())
            .or_else(|| parsed.inherited_model.clone());
        if model.is_none() {
            model = self.default_model().await;
        }
        if let Some(m) = &model {
            if self.store.find_model(None, m).await.is_none() {
                return (format!("spawn_agent 参数错误：模型 {m} 不存在或未启用"), true);
            }
        }
        let Some(model_id) = model else {
            return ("spawn_agent 参数错误：无可用的模型（未配置继承模型且无默认模型）".into(), true);
        };

        // 4. 组装 SubagentRequest（服务端注入 agent_id/owner/parent_session，§3.2）
        let task_id = new_agent_id();
        let cwd = match (&parsed.cwd, &ctx.workspace_root) {
            (Some(c), _) => c.clone(),
            (None, Some(root)) => root.clone(),
            (None, None) => std::path::PathBuf::from("."),
        };
        let capability = parsed
            .capability_mode
            .or(definition.capability_mode)
            .unwrap_or_default();

        let req = SubagentRequest {
            task_id: task_id.clone(),
            parent_session: ctx.chat_id.clone(),
            depth,
            agent_definition: definition,
            prompt: parsed.prompt.clone(),
            description: parsed.description.clone(),
            cwd,
            model: Some(model_id),
            capability_mode: capability,
            isolation,
            resume_from: parsed.resume_from.clone(),
            fork_context: None,
            owner: SubagentOwner::Task,
            run_id: None,
            tools_snapshot: super::tools_snapshot::current(),
            mcp_snapshot: json!({}),
            permission: super::types::Ruleset::default(),
            hooks_snapshot: vec![],
            chat_id: ctx.chat_id.clone(),
            turn_message_id: ctx.turn_message_id.clone(),
            max_turns: 40,
            data_dir: self.data_dir.clone(),
        };

        // 5. 准入（§7.2）
        match self.handle.spawn(req).await {
            SpawnAck::Rejected(e) => (e.message, true),
            SpawnAck::Queued => {
                // 排队中：按后台语义处理（排队期间前台等待会阻塞预算，直接告知）
                self.wait_or_background(&task_id, &config, parsed.run_in_background, &parsed.subagent_type)
                    .await
            }
            SpawnAck::Admitted => {
                self.wait_or_background(&task_id, &config, parsed.run_in_background, &parsed.subagent_type)
                    .await
            }
        }
    }

    /// 前台等待/后台分派（§6 分派规则）。
    async fn wait_or_background(
        &self,
        task_id: &str,
        config: &SubagentConfig,
        run_in_background: Option<bool>,
        agent_name: &str,
    ) -> (String, bool) {
        match run_in_background {
            Some(true) => (
                format!(
                    "<agent id=\"{task_id}\" name=\"{agent_name}\" state=\"background\">\n任务已在后台运行。完成后会自动通知你；也可用 get_agent_output 工具查询 {{ \"agent_id\": \"{task_id}\" }}。\n</agent>"
                ),
                false,
            ),
            Some(false) => {
                // 前台等待（无预算，等到底）
                self.wait_foreground(task_id, agent_name).await
            }
            None => {
                // 前台等待 + 预算（默认 600s；超时自动转后台，§6）
                let budget =
                    std::time::Duration::from_millis(config.await_budget_ms);
                match tokio::time::timeout(budget, self.wait_foreground_raw(task_id, agent_name))
                    .await
                {
                    Ok(result) => result,
                    Err(_) => (
                        format!(
                            "<agent id=\"{task_id}\" name=\"{agent_name}\" state=\"background\" reason=\"await_budget_exceeded\">\n任务已超时转入后台继续运行。完成后会自动通知你；也可用 get_agent_output 工具查询 {{ \"agent_id\": \"{task_id}\" }}。\n</agent>"
                        ),
                        false,
                    ),
                }
            }
        }
    }

    async fn wait_foreground(&self, task_id: &str, agent_name: &str) -> (String, bool) {
        self.wait_foreground_raw(task_id, agent_name).await
    }

    async fn wait_foreground_raw(&self, task_id: &str, agent_name: &str) -> (String, bool) {
        match self.handle.wait_completion(task_id).await {
            Some(WaitOutcome::Completed(out)) => {
                (format_task_result(&out, agent_name, "completed"), false)
            }
            Some(WaitOutcome::Failed(err)) => {
                (format_task_error(task_id, agent_name, &err), true)
            }
            Some(WaitOutcome::Cancelled(reason)) => (
                format!(
                    "<agent id=\"{task_id}\" name=\"{agent_name}\" state=\"cancelled\" reason=\"{reason:?}\">\n任务被取消。\n</agent>"
                ),
                true,
            ),
            Some(WaitOutcome::NotFound) | None => {
                (format!("agent {task_id} 状态查询失败（可能不存在）"), true)
            }
        }
    }

    // ─── get_agent_output（§10.2）─────────────────────────────────────────

    async fn execute_get_agent_output(&self, input: &Value) -> (String, bool) {
        let Some(task_id) = input.get("agent_id").and_then(Value::as_str) else {
            return ("get_agent_output 参数错误：agent_id 缺失".into(), true);
        };
        let block = input.get("block").and_then(Value::as_bool).unwrap_or(false);
        let timeout_ms = input
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(60_000)
            .min(300_000); // 上限 300s（§10.2）

        if block {
            match tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                self.handle.wait_completion(task_id),
            )
            .await
            {
                Ok(Some(WaitOutcome::Completed(out))) => {
                    return (format_task_result(&out, "", "completed"), false)
                }
                Ok(Some(WaitOutcome::Failed(err))) => {
                    return (format_task_error(task_id, "", &err), true)
                }
                Ok(Some(WaitOutcome::Cancelled(reason))) => {
                    return (
                        format!("agent {task_id} 已取消（{reason:?}）"),
                        true,
                    )
                }
                Ok(Some(WaitOutcome::NotFound)) | Ok(None) => {
                    return (format!("agent {task_id} 不存在"), true)
                }
                Err(_) => { /* 超时：落到下方状态查询 */ }
            }
        }

        match self.handle.get_output(task_id).await {
            Some(TaskView::Pending) => (json!({ "agent_id": task_id, "state": "pending" }).to_string(), false),
            Some(TaskView::Running { .. }) => {
                (json!({ "agent_id": task_id, "state": "running" }).to_string(), false)
            }
            Some(TaskView::Completed(out)) => (format_task_result(&out, "", "completed"), false),
            Some(TaskView::Failed(err)) => (format_task_error(task_id, "", &err), true),
            Some(TaskView::Cancelled(reason)) => {
                (format!("agent {task_id} 已取消（{reason:?}）"), true)
            }
            None => {
                // completed 表 miss：尝试 output.json（崩溃恢复后查询，§13.2）
                match super::persist::load_output(&self.data_dir, task_id) {
                    Some(out) => (format_task_result(&out, "", "completed"), false),
                    None => (format!("agent {task_id} 不存在或状态未知"), true),
                }
            }
        }
    }

    // ─── kill_agent（§10.2）───────────────────────────────────────────────

    async fn execute_kill_agent(&self, input: &Value) -> (String, bool) {
        let Some(task_id) = input.get("agent_id").and_then(Value::as_str) else {
            return ("kill_agent 参数错误：agent_id 缺失".into(), true);
        };
        self.handle.kill(task_id, CancelReason::UserKill);
        (format!("已发送 kill 请求：{task_id}"), false)
    }

    // ─── run_workflow / kill_workflow（§14）────────────────────────────────

    async fn execute_run_workflow(&self, input: &Value, ctx: &ToolCallContext) -> (String, bool) {
        let Some(script) = input.get("script").and_then(Value::as_str) else {
            return ("run_workflow 参数错误：script 缺失".into(), true);
        };
        let budget_limit = input
            .get("budget_limit")
            .and_then(Value::as_u64)
            .unwrap_or(1_000_000);
        let resume = input.get("resume").and_then(Value::as_str).map(String::from);

        let mut engine = super::workflow::WorkflowEngine::new(
            self.handle.clone(),
            self.data_dir.clone(),
            ctx.chat_id.clone(),
            ctx.turn_message_id.clone(),
            ctx.workspace_root.clone(),
        );
        let result = engine.run(script.to_string(), budget_limit, resume).await;
        match result {
            Ok(output) => (output, false),
            Err(e) => (format!("workflow 执行失败：{e}"), true),
        }
    }

    async fn execute_kill_workflow(&self, input: &Value) -> (String, bool) {
        let Some(run_id) = input.get("run_id").and_then(Value::as_str) else {
            return ("kill_workflow 参数错误：run_id 缺失".into(), true);
        };
        self.handle.kill_group(run_id);
        (format!("已发送整组取消请求：{run_id}"), false)
    }

    /// 默认模型：第一个启用的模型。
    async fn default_model(&self) -> Option<String> {
        let providers = self.store.list_providers().await;
        for p in providers {
            for m in p.models {
                if m.enabled {
                    return Some(m.id);
                }
            }
        }
        None
    }
}

/// 工具调用上下文（由 HTTP 层组装）。
pub struct ToolCallContext {
    pub chat_id: String,
    pub turn_message_id: Option<String>,
    pub workspace_root: Option<std::path::PathBuf>,
    /// 继承模型（当前会话模型，模型不可见；§18.1 #6）
    pub inherited_model: Option<String>,
}

// ─── 结果格式化（§10.1 / §6）───────────────────────────────────────────────

fn format_task_result(
    out: &super::types::SubagentCompletedOutput,
    agent: &str,
    state: &str,
) -> String {
    // output 超长（> 32KB）截断（§10.1）
    let output: String = if out.output.chars().count() > 32_768 {
        let cut: String = out.output.chars().take(32_768).collect();
        format!("{cut}\n...（截断，完整输出见 output.json）")
    } else {
        out.output.clone()
    };
    let (in_tok, out_tok) = (
        out.usage.prompt_tokens.unwrap_or(0),
        out.usage.completion_tokens.unwrap_or(0),
    );
    let worktree_note = out
        .worktree_path
        .as_ref()
        .map(|p| format!("\n[子代理在 {} 留下了改动，请检查或提交]", p.display()))
        .unwrap_or_default();
    let truncated_note = if out.truncated {
        "\n[注意：任务达到最大轮次被截断]"
    } else {
        ""
    };
    format!(
        "<agent id=\"{}\" name=\"{agent}\" state=\"{state}\" turns=\"{}\" duration_ms=\"{}\" tool_calls=\"{}\" input_tokens=\"{in_tok}\" output_tokens=\"{out_tok}\">\n  <result>{output}</result>\n</agent>{worktree_note}{truncated_note}",
        out.task_id, out.turns, out.duration_ms, out.tool_calls
    )
}

fn format_task_error(task_id: &str, agent: &str, err: &SubagentError) -> String {
    format!(
        "<agent id=\"{task_id}\" name=\"{agent}\" state=\"failed\" kind=\"{:?}\" retryable=\"{}\">\n  <error>{}</error>\n</agent>",
        err.kind, err.retryable, err.message
    )
}

// ─── 嵌套 reparent（§15.1）────────────────────────────────────────────────

/// 子代理发起的嵌套 spawn：请求直接交根 coordinator（深度按新父链计算）。
/// 由 coordinator 的 SpawnReparent 消息处理调用。
pub async fn spawn_reparent_from_params(params: &Value) -> Value {
    let subagents = match crate::subagent::current_subagents() {
        Some(s) => s,
        None => return json!({ "error": "子代理系统未初始化" }),
    };

    let prompt = params.get("prompt").and_then(Value::as_str).unwrap_or("");
    if prompt.is_empty() {
        return json!({ "error": "prompt 不能为空" });
    }
    let subagent_type = params
        .get("subagent_type")
        .and_then(Value::as_str)
        .unwrap_or("general-purpose");

    let definition = {
        let registry = subagents.registry.read().unwrap();
        match registry.lookup(subagent_type) {
            Ok(d) => d.clone(),
            Err(e) => return json!({ "error": e.to_string() }),
        }
    };

    let config = subagents.config.read().unwrap().clone();
    // reparent：parent_session = 根会话，深度 = 0 + 1（§15.1）
    let depth = 1u32;
    if config.depth_policy != "reparent" && depth > config.max_subagent_depth {
        return json!({ "error": format!("已达到最大子代理深度（{}）", config.max_subagent_depth) });
    }

    let chat_id = params
        .get("parent_chat_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let turn_message_id = params
        .get("turn_message_id")
        .and_then(Value::as_str)
        .map(String::from);
    let mut model = params
        .get("model")
        .and_then(Value::as_str)
        .map(String::from);
    if model.is_none() {
        model = subagents.default_model().await;
    }

    let task_id = new_agent_id();
    let capability = definition.capability_mode.unwrap_or_default();
    let req = SubagentRequest {
        task_id: task_id.clone(),
        parent_session: chat_id.clone(),
        depth,
        agent_definition: definition,
        prompt: prompt.to_string(),
        description: params
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        cwd: ctx_cwd(),
        model,
        capability_mode: capability,
        isolation: Isolation::None,
        resume_from: params
            .get("resume_from")
            .and_then(Value::as_str)
            .map(String::from),
        fork_context: None,
        owner: SubagentOwner::Task,
        run_id: None,
        tools_snapshot: super::tools_snapshot::current(),
        mcp_snapshot: json!({}),
        permission: super::types::Ruleset::default(),
        hooks_snapshot: vec![],
        chat_id,
        turn_message_id,
        max_turns: 40,
        data_dir: subagents.data_dir.clone(),
    };

    match subagents.handle.spawn(req).await {
        SpawnAck::Rejected(e) => json!({ "error": e.message }),
        _ => {
            // reparent 阻塞等待结果（保持依赖顺序，§15.1 第 4 点）
            match subagents.handle.wait_completion(&task_id).await {
                Some(WaitOutcome::Completed(out)) => json!({
                    "task_id": out.task_id,
                    "state": "completed",
                    "output": out.output,
                    "turns": out.turns,
                }),
                Some(WaitOutcome::Failed(e)) => {
                    json!({ "task_id": task_id, "state": "failed", "error": e.message })
                }
                Some(WaitOutcome::Cancelled(r)) => {
                    json!({ "task_id": task_id, "state": "cancelled", "reason": format!("{r:?}") })
                }
                _ => json!({ "task_id": task_id, "state": "unknown" }),
            }
        }
    }
}

fn ctx_cwd() -> std::path::PathBuf {
    crate::subagent::current_workspace_root()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_format_truncates() {
        let out = super::super::types::SubagentCompletedOutput {
            task_id: "t".into(),
            output: "x".repeat(40_000),
            tool_calls: 1,
            turns: 1,
            duration_ms: 10,
            worktree_path: None,
            resume_from_hint: None,
            usage: crate::provider::UsageInfo {
                prompt_tokens: Some(1),
                completion_tokens: Some(2),
                total_tokens: Some(3),
                prompt_cache_hit_tokens: None,
                prompt_cache_miss_tokens: None,
                prompt_tokens_details: None,
            },
            truncated: false,
        };
        let s = format_task_result(&out, "explore", "completed");
        assert!(s.contains("截断"));
        assert!(s.contains("<agent id=\"t\""));
    }
}
