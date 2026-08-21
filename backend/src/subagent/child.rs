//! 子代理会话主逻辑（设计稿 §8 / §11 / §9）。
//!
//! 桌面端运行于 subagent-proc 独立进程，Android 端运行于宿主进程内
//! tokio task —— 两端共用本文件的 `run_session`（仅 transport 不同）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};
use tokio::sync::{oneshot, Notify};

use crate::config::ConfigStore;
use crate::file_history::FileHistory;
use crate::provider::ToolDefinition;
use crate::skill::SkillService;
use crate::task_store::TaskStore;
use crate::tools::{self, ReadTracker};
use reqwest::Client;

use super::context::{build_initial_messages, render_system_prompt};
use super::llm::{run_loop, EventSink, LoopParams, SubToolExecutor};
use super::permission::assemble_child_ruleset;
use super::persist::{now_ms, save_meta, save_output, SubagentMeta, Transcript};
use super::protocol::{event_notification, AcpFrame, ChildEvent, SpawnParams, SpawnResultPayload};
use super::transport::{AcpEndpoint, AcpWriter};
use super::types::{
    CapabilityMode, ErrorKind, PermissionEffect, Rule, Ruleset, SubagentCompletedOutput,
    SubagentError, SubagentOwner, ToolKind, ToolSpec,
};

/// 子代理依赖集：进程内共享 Arc；子进程模式下由 data_dir 重新构造。
pub struct ChildDeps {
    pub store: Arc<ConfigStore>,
    pub http: Arc<Client>,
    pub task_store: Arc<TaskStore>,
    pub file_history: Arc<FileHistory>,
    pub read_tracker: Arc<ReadTracker>,
    pub skill_service: Option<Arc<SkillService>>,
    /// 子代理侧对父 coordinator 的请求通道（权限询问 / 嵌套 reparent）；
    /// None 时 Ask 一律拒绝（无审批通道）。
    pub parent_bridge: Option<Arc<dyn ParentBridge>>,
}

/// 父侧桥：子代理发出的 ACP 请求经此转发（进程内直连 mailbox / 子进程走 stdio 由父泵处理）。
pub trait ParentBridge: Send + Sync {
    /// 权限询问：返回 (decision: allow|deny, remember: bool)
    fn permission_request<'a>(
        &'a self,
        tool: &'a str,
        input: &'a Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = (String, bool)> + Send + 'a>,
    >;

    /// 嵌套 spawn（reparent 到根 coordinator，§15.1）：返回 spawn 结果 JSON
    fn spawn_reparent<'a>(
        &'a self,
        params: &'a Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>>;
}

// ─── 工具集构建（§11.1）───────────────────────────────────────────────────

/// 过滤顺序不可交换：白名单 → 黑名单 → capability → 深度 → owner（§11.1）。
pub fn build_child_tools(
    definition_tools: Option<&Vec<String>>,
    disallowed: &[String],
    capability_mode: CapabilityMode,
    snapshot: &[ToolSpec],
    depth: u32,
    max_depth: u32,
    owner_is_workflow: bool,
) -> Vec<ToolSpec> {
    let mut tools: Vec<ToolSpec> = snapshot.to_vec();
    if let Some(allow) = definition_tools {
        let allow_lower: Vec<String> = allow.iter().map(|s| s.to_lowercase()).collect();
        tools.retain(|t| allow_lower.contains(&t.name.to_lowercase()));
    }
    if !disallowed.is_empty() {
        let dis_lower: Vec<String> = disallowed.iter().map(|s| s.to_lowercase()).collect();
        tools.retain(|t| !dis_lower.contains(&t.name.to_lowercase()));
    }
    tools.retain(|t| t.kind.fits(capability_mode));
    // 深度 == max_subagent_depth 时剥除 spawn_agent 工具（防无限递归）
    if depth >= max_depth {
        tools.retain(|t| t.name.to_lowercase() != "spawn_agent");
    }
    // Workflow 子代理：剥除调度类工具（complete/pause 由引擎注入）
    if owner_is_workflow {
        tools.retain(|t| !matches!(t.kind, ToolKind::Scheduler));
    }
    tools
}

// ─── 事件下沉 ──────────────────────────────────────────────────────────────

#[derive(Clone)]
struct AcpEventSink {
    writer: AcpWriter,
}

impl EventSink for AcpEventSink {
    fn emit(&mut self, ev: ChildEvent) {
        self.writer.send(event_notification(&ev));
    }
}

// ─── 父侧请求链路（子代理 → 父 coordinator）──────────────────────────────

/// 响应等待表：request_id → oneshot。
type PendingReplies = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

#[derive(Clone)]
struct EndpointParentBridge {
    writer: AcpWriter,
    pending: PendingReplies,
    cancel: Arc<Notify>,
    next_id: Arc<std::sync::atomic::AtomicU64>,
}

impl EndpointParentBridge {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id_num = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let id = format!("c-{id_num}");
        let (tx, rx) = oneshot::channel::<Value>();
        {
            let mut map = self.pending.lock().unwrap();
            map.insert(id.clone(), tx);
        }
        self.writer.send(AcpFrame::Request {
            id: Value::String(id.clone()),
            method: method.to_string(),
            params,
        });
        match tokio::time::timeout(
            std::time::Duration::from_secs(120),
            rx,
        )
        .await
        {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err("父侧通道已关闭".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err("父侧请求超时".into())
            }
        }
    }
}

impl ParentBridge for EndpointParentBridge {
    fn permission_request<'a>(
        &'a self,
        tool: &'a str,
        input: &'a Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = (String, bool)> + Send + 'a>,
    > {
        Box::pin(async move {
            let request_id = format!(
                "perm-{}",
                self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            );
            match self
                .request(
                    "permission_request",
                    json!({ "tool": tool, "input": input, "request_id": request_id }),
                )
                .await
            {
                Ok(resp) => {
                    let decision = resp["decision"].as_str().unwrap_or("deny").to_string();
                    let remember = resp["remember"].as_bool().unwrap_or(false);
                    (decision, remember)
                }
                Err(_) => ("deny".to_string(), false),
            }
        })
    }

    fn spawn_reparent<'a>(
        &'a self,
        params: &'a Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Value, String>> + Send + 'a>,
    > {
        Box::pin(async move { self.request("spawn_reparent", params.clone()).await })
    }
}

// ─── 工具执行器（权限判定 + ACP 转发 + 常规执行）──────────────────────────

struct ChildToolExecutor<'a> {
    deps: &'a ChildDeps,
    ruleset: Ruleset,
    spawn: &'a SpawnParams,
    allowed_tools: Vec<String>,
    depth: u32,
    max_depth: u32,
    can_spawn_children: bool,
}

impl<'a> SubToolExecutor for ChildToolExecutor<'a> {
    fn execute<'b>(
        &'b mut self,
        name: &'b str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = (String, bool)> + Send + 'b>> {
        Box::pin(async move {
            let lower = name.to_lowercase();
            if !self.allowed_tools.contains(&lower) {
                return (
                    format!("无权限：工具「{name}」不在当前子代理的可用工具集中。"),
                    true,
                );
            }

            match self.ruleset.decide(name) {
                PermissionEffect::Deny => {
                    return (format!("无权限：工具「{name}」被权限规则拒绝。"), true)
                }
                PermissionEffect::Ask => {
                    let Some(bridge) = self.deps.parent_bridge.as_ref() else {
                        return (
                            format!("无权限：工具「{name}」需要确认，但审批通道不可用。"),
                            true,
                        );
                    };
                    let request_input = input.clone();
                    let tool_name = name.to_string();
                    let (decision, remember) =
                        bridge.permission_request(&tool_name, &request_input).await;
                    if decision != "allow" {
                        return (
                            format!("无权限：用户拒绝了子代理对「{name}」的使用请求。"),
                            true,
                        );
                    }
                    if remember {
                        // always_approve：本子代理生命周期内加入 Allow 规则
                        self.ruleset.append(Rule {
                            pattern: lower.clone(),
                            effect: PermissionEffect::Allow,
                        });
                    }
                }
                PermissionEffect::Allow => {}
            }

            if lower == "spawn_agent" {
                // 嵌套 spawn：深度判断 + reparent（§15.1）
                if !self.can_spawn_children {
                    return (
                        "无权限：当前子代理不允许派生子代理（spawn_agent 工具被禁用）。".into(),
                        true,
                    );
                }
                if self.depth >= self.max_depth {
                    return (
                        format!(
                            "已达到最大子代理深度（{}），无法再派生子代理。请在当前上下文中直接执行该操作。",
                            self.max_depth
                        ),
                        true,
                    );
                }
                let Some(bridge) = self.deps.parent_bridge.as_ref() else {
                    return ("嵌套 spawn 通道不可用。".into(), true);
                };
                let mut params = json!({
                    "prompt": input.get("prompt").cloned().unwrap_or(Value::Null),
                    "subagent_type": input.get("subagent_type").and_then(Value::as_str).unwrap_or("general-purpose"),
                    "description": input.get("description").and_then(Value::as_str).unwrap_or(""),
                    "resume_from": input.get("resume_from"),
                    "run_in_background": input.get("run_in_background"),
                    "original_depth": self.depth,
                    "parent_chat_id": self.spawn.chat_id,
                    "turn_message_id": self.spawn.turn_message_id,
                });
                if let Some(m) = input.get("model").and_then(Value::as_str) {
                    params["model"] = json!(m);
                }
                match bridge.spawn_reparent(&params).await {
                    Ok(result) => {
                        (serde_json::to_string(&result).unwrap_or_default(), false)
                    }
                    Err(e) => (format!("嵌套子代理失败：{e}"), true),
                }
            } else {
                // 常规工具：复用主循环工具执行（含 file_history 备份，§18.2 #1）
                match tools::execute_tool(
                    name,
                    &input,
                    &self.spawn.chat_id,
                    self.deps.task_store.as_ref(),
                    Some(Path::new(&self.spawn.cwd)),
                    self.deps.read_tracker.as_ref(),
                    Some(self.deps.file_history.as_ref()),
                    self.spawn.turn_message_id.as_deref(),
                    self.deps.skill_service.as_deref(),
                )
                .await
                {
                    Ok(out) => (out.output, out.is_error),
                    Err(e) => (e.to_string(), true),
                }
            }
        })
    }
}

// ─── 会话入口 ──────────────────────────────────────────────────────────────

/// 运行一个完整子代理会话：接收 spawn 请求 → LLM 循环 → 返回结果帧 → 退出。
/// 返回进程退出码语义（0=完成，1=异常；进程内模式仅用于日志）。
pub async fn run_session(
    mut endpoint: AcpEndpoint,
    deps: ChildDeps,
    max_depth: u32,
) -> i32 {
    let started = Instant::now();

    // 1. 等待 spawn 请求（30s 协议超时，§4）
    let spawn_frame = tokio::select! {
        f = endpoint.recv() => f,
        _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
            tracing::error!("subagent session: spawn 请求超时");
            return 1;
        }
    };
    let Some(AcpFrame::Request { id, params, .. }) = spawn_frame else {
        tracing::error!("subagent session: 首帧不是 spawn 请求");
        return 1;
    };
    let Ok(spawn) = serde_json::from_value::<SpawnParams>(params.clone()) else {
        endpoint.send(AcpFrame::error_response(
            id,
            -32000,
            "spawn 参数解析失败",
            None,
        ));
        return 1;
    };

    let task_id = spawn.task_id.clone();
    let writer = endpoint.writer();
    writer.send(event_notification(&ChildEvent::StateChange {
        state: "pending".into(),
    }));

    // 2. meta.json（§13.1）
    let data_dir = Path::new(&spawn.data_dir);
    let meta = SubagentMeta {
        task_id: task_id.clone(),
        agent_type: spawn.agent_definition.name.clone(),
        model: spawn.model.clone(),
        isolation: spawn.isolation.as_ref().map(|i| format!("{i:?}")),
        worktree_path: spawn.worktree_path.clone(),
        owner: match spawn.owner {
            SubagentOwner::Task => "agent".to_string(),
            SubagentOwner::Workflow => "workflow".to_string(),
        },
        parent_session: spawn.parent_session.clone(),
        chat_id: spawn.chat_id.clone(),
        depth: spawn.depth,
        created_at: now_ms(),
        resume_from: spawn.resume_from.clone(),
        finished: false,
    };
    if let Err(e) = save_meta(data_dir, &meta) {
        tracing::warn!("子代理 meta 写入失败（继续运行）：{e}");
    }

    // 3. transcript
    let mut transcript = match Transcript::open(data_dir, &task_id) {
        Ok(t) => t,
        Err(e) => {
            endpoint.send(AcpFrame::error_response(
                id,
                -32000,
                &format!("transcript 打开失败：{e}"),
                Some(json!({ "retryable": false })),
            ));
            return 1;
        }
    };

    // 4. 工具集（§11.1）
    let capability = spawn
        .capability_mode
        .or(spawn.agent_definition.capability_mode)
        .unwrap_or_default();
    let owner_is_workflow = spawn.owner == SubagentOwner::Workflow;
    let child_tools = build_child_tools(
        spawn.agent_definition.tools.as_ref(),
        &spawn.agent_definition.disallowed_tools,
        capability,
        &spawn.tools_snapshot,
        spawn.depth,
        max_depth,
        owner_is_workflow,
    );
    let allowed_tools: Vec<String> =
        child_tools.iter().map(|t| t.name.to_lowercase()).collect();
    let tools_schema: Vec<ToolDefinition> = child_tools
        .iter()
        .map(|t| ToolDefinition {
            tool_type: "function".into(),
            function: crate::provider::FunctionDefinition {
                name: t.name.clone(),
                description: t.description.clone(),
                strict: Some(true),
                parameters: t.input_schema.clone(),
            },
        })
        .collect();

    // 5. 权限规则（§11.2；bypass_permissions 对子代理强制无效）
    let ruleset = assemble_child_ruleset(&spawn.permission, &spawn.agent_definition);

    // 6. 上下文（§9：resume_from > fork_context > 空上下文）
    let (initial_messages, context_window_tokens) =
        match build_initial_messages(&deps, &spawn, &child_tools).await {
            Ok(m) => m,
            Err(e) => {
                endpoint.send(AcpFrame::error_response(
                    id,
                    -32000,
                    &e.message,
                    Some(json!({ "retryable": e.retryable, "kind": format!("{:?}", e.kind) })),
                ));
                return 1;
            }
        };

    // 7. system prompt（§9.1 渲染顺序）
    let system_prompt = render_system_prompt(&spawn, &child_tools, &deps).await;

    // 8. 会话链路：writer 发帧；router 任务消费 endpoint.rx
    let pending: PendingReplies = Arc::new(Mutex::new(HashMap::new()));
    let cancel = Arc::new(Notify::new());
    let bridge: Arc<dyn ParentBridge> = Arc::new(EndpointParentBridge {
        writer: writer.clone(),
        pending: pending.clone(),
        cancel: cancel.clone(),
        next_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
    });

    // router：分发父侧响应（配对子代理发起的请求）与 kill 请求
    let router = tokio::spawn(session_router(endpoint, pending, cancel.clone()));

    writer.send(event_notification(&ChildEvent::StateChange {
        state: "running".into(),
    }));

    let mut deps = deps;
    deps.parent_bridge = Some(bridge);

    let mut executor = ChildToolExecutor {
        deps: &deps,
        ruleset,
        spawn: &spawn,
        allowed_tools,
        depth: spawn.depth,
        max_depth,
        can_spawn_children: child_tools.iter().any(|t| t.name == "spawn_agent"),
    };
    let mut sink = AcpEventSink {
        writer: writer.clone(),
    };

    let loop_params = LoopParams {
        provider_id: None,
        model_id: spawn.model.clone().unwrap_or_default(),
        temperature: spawn.agent_definition.temperature,
        system_prompt,
        initial_messages,
        tools: tools_schema,
        max_turns: spawn.max_turns.unwrap_or(40),
        context_window_tokens,
    };

    let result = tokio::select! {
        res = run_loop(
            deps.store.as_ref(),
            deps.http.as_ref(),
            loop_params,
            &mut executor,
            &mut sink,
            &mut transcript,
        ) => res,
        _ = cancel.notified() => Err(SubagentError::new(
            ErrorKind::Killed,
            "子代理被取消（kill）",
            true,
        )),
    };

    router.abort();
    let _ = router.await;

    match result {
        Ok(outcome) => {
            // worktree 有改动 → coordinator 侧 finalize 处理；此处带出路径
            let payload = SpawnResultPayload {
                output: outcome.output,
                turns: outcome.turns,
                tool_calls: outcome.tool_calls,
                duration_ms: started.elapsed().as_millis() as u64,
                usage: serde_json::to_value(&outcome.usage).unwrap_or(Value::Null),
                worktree_path: spawn.worktree_path.clone(),
                resume_from_hint: Some(task_id.clone()),
                truncated: outcome.truncated,
            };
            transcript.flush_and_sync();

            // output.json 落盘（§13.1）+ meta 收尾
            let completed = SubagentCompletedOutput {
                task_id: task_id.clone(),
                output: payload.output.clone(),
                tool_calls: payload.tool_calls,
                turns: payload.turns,
                duration_ms: payload.duration_ms,
                worktree_path: payload.worktree_path.clone().map(path_buf_from),
                resume_from_hint: payload.resume_from_hint.clone(),
                usage: outcome.usage,
                truncated: payload.truncated,
            };
            if let Err(e) = save_output(data_dir, &task_id, &completed) {
                tracing::warn!("子代理 output.json 写入失败：{e}");
            }
            if let Some(mut m) = super::persist::load_meta(data_dir, &task_id) {
                m.finished = true;
                let _ = save_meta(data_dir, &m);
            }

            writer.send(AcpFrame::response(
                id,
                serde_json::to_value(&payload).unwrap_or(Value::Null),
            ));
            0
        }
        Err(err) => {
            transcript.flush_and_sync();
            writer.send(AcpFrame::error_response(
                id,
                -32000,
                &err.message,
                Some(json!({ "retryable": err.retryable, "kind": format!("{:?}", err.kind) })),
            ));
            1
        }
    }
}

/// 路由任务：消费父侧来的帧。
/// - Response(id) → 配对 pending（子代理发起的请求）
/// - Request(kill) → 触发 cancel
async fn session_router(
    mut endpoint: AcpEndpoint,
    pending: PendingReplies,
    cancel: Arc<Notify>,
) {
    while let Some(frame) = endpoint.recv().await {
        match frame {
            AcpFrame::Response { id, result, error } => {
                let key = match &id {
                    Value::String(s) => s.clone(),
                    v => v.to_string(),
                };
                let sender = pending.lock().unwrap().remove(&key);
                if let Some(tx) = sender {
                    let value = if let Some(err) = error {
                        json!({ "__error": err })
                    } else {
                        result.unwrap_or(Value::Null)
                    };
                    let _ = tx.send(value);
                }
            }
            AcpFrame::Request { id, method, .. } if method == "kill" => {
                endpoint.send(AcpFrame::response(id, json!({ "killed": true })));
                cancel.notify_waiters();
                // 优雅收尾机会：LLM 循环被 select 取消，transcript 已逐条落盘
                return;
            }
            _ => {
                // 忽略其他帧（事件 / 未知请求）
            }
        }
    }
}

fn path_buf_from(s: String) -> std::path::PathBuf {
    std::path::PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subagent::types::{Isolation, ToolSpec};

    fn spec(name: &str, kind: ToolKind) -> ToolSpec {
        ToolSpec {
            name: name.into(),
            description: String::new(),
            input_schema: json!({}),
            kind,
        }
    }

    #[test]
    fn build_child_tools_filter_order() {
        // 快照：Read/Write/Edit/spawn_agent/Glob
        let snapshot = vec![
            spec("Read", ToolKind::ReadOnly),
            spec("Write", ToolKind::Write),
            spec("Edit", ToolKind::Write),
            spec("Glob", ToolKind::ReadOnly),
            spec("spawn_agent", ToolKind::Scheduler),
            spec("TodoCreate", ToolKind::General),
        ];
        // 白名单含全部；黑名单禁 Edit；capability=ReadWrite；depth=1=max
        let out = build_child_tools(
            Some(&vec![
                "Read".into(),
                "Write".into(),
                "Edit".into(),
                "Glob".into(),
                "spawn_agent".into(),
                "TodoCreate".into(),
            ]),
            &["Edit".to_string()],
            CapabilityMode::ReadWrite,
            &snapshot,
            1,
            1,
            false,
        );
        let names: Vec<String> = out.iter().map(|t| t.name.clone()).collect();
        // Edit 被黑名单剥除；spawn_agent 被深度剥除；TodoCreate 不满足 ReadWrite
        assert_eq!(names, vec!["Read".to_string(), "Write".to_string(), "Glob".to_string()]);
    }

    #[test]
    fn build_child_tools_workflow_strips_scheduler() {
        let snapshot = vec![
            spec("Read", ToolKind::ReadOnly),
            spec("spawn_agent", ToolKind::Scheduler),
            spec("run_workflow", ToolKind::Scheduler),
        ];
        let out = build_child_tools(None, &[], CapabilityMode::All, &snapshot, 0, 1, true);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Read");
    }

    #[test]
    fn build_child_tools_isolation_field_unused() {
        // Isolation 序列化健全性
        let v = serde_json::to_value(Isolation::Worktree).unwrap();
        assert_eq!(v, json!("worktree"));
    }
}
