//! SubagentCoordinator（设计稿 §7）：单写者 actor + mpsc 邮箱。
//!
//! 职责：三表（pending/active/completed）、准入队列、前台等待预算、
//! 取消 / 整组取消、完成缓冲 + SSE 广播、权限转发。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::{broadcast, mpsc, oneshot};

use super::protocol::{ChildEvent, PermissionRequestParam};
use super::types::{
    CancelReason, ErrorKind, SubagentCompletedOutput, SubagentConfig, SubagentError,
    SubagentOwner, SubagentRequest,
};

/// 完成缓冲上限（§7.5）
const COMPLETED_BUFFER_LIMIT: usize = 100;

// ─── 邮箱消息 ──────────────────────────────────────────────────────────────

/// spawn 准入结果
pub enum SpawnAck {
    Admitted,
    Queued,
    Rejected(SubagentError),
}

pub enum WaitOutcome {
    Completed(SubagentCompletedOutput),
    Failed(SubagentError),
    Cancelled(CancelReason),
    /// 任务不存在（可能已完成并清理，或 ID 非法）
    NotFound,
}

pub enum SubagentEvent {
    Spawn {
        req: SubagentRequest,
        reply: oneshot::Sender<SpawnAck>,
    },
    /// 父侧泵转发的子代理事件
    ChildEvent {
        task_id: String,
        event: ChildEvent,
    },
    /// 子代理生命周期结束（成功/失败/取消）
    ChildExit {
        task_id: String,
        result: Result<SubagentCompletedOutput, SubagentError>,
    },
    /// 子代理 → 父侧请求：权限询问
    PermissionRequested {
        task_id: String,
        acp_id: Value,
        params: PermissionRequestParam,
        reply: oneshot::Sender<Value>,
    },
    /// 子代理 → 父侧请求：嵌套 spawn reparent（§15.1）
    SpawnReparent {
        params: Value,
        reply: oneshot::Sender<Value>,
    },
    /// 前台等待注册（§7.4）
    Wait {
        task_id: String,
        reply: oneshot::Sender<WaitOutcome>,
    },
    GetOutput {
        task_id: String,
        reply: oneshot::Sender<Option<TaskView>>,
    },
    Kill {
        task_id: String,
        reason: CancelReason,
    },
    KillGroup {
        run_id: String,
    },
    /// 前端审批决策回填（§11.2）
    PermissionDecision {
        request_id: String,
        decision: String,
        remember: bool,
    },
    /// workflow 引擎登记的预算扣减（§14.4 预算联动）
    BudgetDeduct {
        run_id: String,
        tokens: u64,
    },
    /// 完成缓冲快照（前端断线补齐，§7.5）
    CompletedSnapshot {
        reply: oneshot::Sender<Vec<Value>>,
    },
    CancelAll,
}

/// 对外只读任务视图。
#[derive(Debug, Clone)]
pub enum TaskView {
    Pending,
    Running { started_at_ms: u64 },
    Completed(Box<SubagentCompletedOutput>),
    Failed(Box<SubagentError>),
    Cancelled(CancelReason),
}

impl TaskView {
    pub fn state_label(&self) -> &'static str {
        match self {
            TaskView::Pending => "pending",
            TaskView::Running { .. } => "running",
            TaskView::Completed(_) => "completed",
            TaskView::Failed(_) => "failed",
            TaskView::Cancelled(_) => "cancelled",
        }
    }
}

// ─── 活动子代理句柄 ────────────────────────────────────────────────────────

/// 由 runner 提供的子代理控制句柄（进程 / 进程内双实现）。
pub struct ActiveChild {
    pub task_id: String,
    pub parent_session: String,
    pub chat_id: String,
    pub run_id: Option<String>,
    pub owner: SubagentOwner,
    pub started_at: Instant,
    pub writer: super::transport::AcpWriter,
    pub kill: Box<dyn FnOnce() + Send>,
    pub supervisor: tokio::task::JoinHandle<()>,
}

// ─── SSE 广播事件 ──────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SseEvent {
    pub kind: &'static str,
    pub chat_id: String,
    pub task_id: String,
    pub payload: Value,
}

// ─── Coordinator ───────────────────────────────────────────────────────────

pub struct SubagentCoordinator {
    /// actor 自身邮箱 tx（内部任务回填消息用）
    internal_tx: mpsc::UnboundedSender<SubagentEvent>,
    rx: mpsc::UnboundedReceiver<SubagentEvent>,
    /// 准入队列（FIFO）
    pending: VecDeque<SubagentRequest>,
    /// 运行中（含 deadline 语义由各处维护）
    active: HashMap<String, ActiveChild>,
    /// 终态表（completed/failed/cancelled），容量受控
    finished: HashMap<String, TaskView>,
    /// 完成事件缓冲（自动唤醒用，§7.5）
    completed_events: VecDeque<Value>,
    /// 前台等待者
    waiters: HashMap<String, Vec<oneshot::Sender<WaitOutcome>>>,
    /// 待决权限请求：request_id → (task_id, acp_id, deadline, reply)
    permission_pending: HashMap<String, PendingPermission>,
    config: SubagentConfig,
    /// 每会话运行中计数（准入用）
    per_session_active: HashMap<String, usize>,
    sse: broadcast::Sender<SseEvent>,
    /// runner：由平台决定 Process / InProcess
    runner: Arc<dyn super::runner::ChildRunner>,
}

struct PendingPermission {
    task_id: String,
    acp_id: Value,
    reply: Option<oneshot::Sender<Value>>,
}

/// 对外句柄：克隆分发（TaskTool / HTTP / SSE 转发共用）。
#[derive(Clone)]
pub struct CoordinatorHandle {
    tx: mpsc::UnboundedSender<SubagentEvent>,
    sse: broadcast::Sender<SseEvent>,
}

impl CoordinatorHandle {
    pub async fn spawn(&self, req: SubagentRequest) -> SpawnAck {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(SubagentEvent::Spawn { req, reply: tx })
            .is_err()
        {
            return SpawnAck::Rejected(SubagentError::new(
                ErrorKind::Internal,
                "coordinator 已停止",
                false,
            ));
        }
        rx.await.unwrap_or(SpawnAck::Rejected(SubagentError::new(
            ErrorKind::Internal,
            "coordinator 无响应",
            false,
        )))
    }

    pub fn child_event(&self, task_id: &str, event: ChildEvent) {
        let _ = self.tx.send(SubagentEvent::ChildEvent {
            task_id: task_id.to_string(),
            event,
        });
    }

    pub fn child_exit(
        &self,
        task_id: &str,
        result: Result<SubagentCompletedOutput, SubagentError>,
    ) {
        let _ = self.tx.send(SubagentEvent::ChildExit {
            task_id: task_id.to_string(),
            result,
        });
    }

    pub fn permission_requested(
        &self,
        task_id: &str,
        acp_id: Value,
        params: PermissionRequestParam,
    ) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let _ = self.tx.send(SubagentEvent::PermissionRequested {
            task_id: task_id.to_string(),
            acp_id,
            params,
            reply: tx,
        });
        rx
    }

    pub fn spawn_reparent(&self, params: Value) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        let _ = self.tx.send(SubagentEvent::SpawnReparent { params, reply: tx });
        rx
    }

    pub async fn wait_completion(&self, task_id: &str) -> Option<WaitOutcome> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(SubagentEvent::Wait {
                task_id: task_id.to_string(),
                reply: tx,
            })
            .ok()?;
        rx.await.ok()
    }

    pub async fn get_output(&self, task_id: &str) -> Option<TaskView> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(SubagentEvent::GetOutput {
                task_id: task_id.to_string(),
                reply: tx,
            })
            .ok()?;
        rx.await.ok().flatten()
    }

    pub fn kill(&self, task_id: &str, reason: CancelReason) {
        let _ = self.tx.send(SubagentEvent::Kill {
            task_id: task_id.to_string(),
            reason,
        });
    }

    pub fn kill_group(&self, run_id: &str) {
        let _ = self.tx.send(SubagentEvent::KillGroup {
            run_id: run_id.to_string(),
        });
    }

    pub fn permission_decision(&self, request_id: &str, decision: &str, remember: bool) {
        let _ = self.tx.send(SubagentEvent::PermissionDecision {
            request_id: request_id.to_string(),
            decision: decision.to_string(),
            remember,
        });
    }

    pub fn budget_deduct(&self, run_id: &str, tokens: u64) {
        let _ = self.tx.send(SubagentEvent::BudgetDeduct {
            run_id: run_id.to_string(),
            tokens,
        });
    }

    pub fn cancel_all(&self) {
        let _ = self.tx.send(SubagentEvent::CancelAll);
    }

    /// SSE 订阅（HTTP 层桥接为 axum SSE 流）。
    pub fn subscribe(&self) -> broadcast::Receiver<SseEvent> {
        self.sse.subscribe()
    }

    /// 拉取完成缓冲（SSE 断线补齐，§7.5）。
    pub async fn completed_snapshot(&self) -> Vec<Value> {
        let (tx, rx) = oneshot::channel();
        if self
            .tx
            .send(SubagentEvent::CompletedSnapshot { reply: tx })
            .is_err()
        {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    /// 测试用哑句柄（无 actor 后端；仅用于不需要真实调度的单元测试）。
    #[cfg(test)]
    pub(crate) fn dummy() -> Self {
        let (tx, _rx) = mpsc::unbounded_channel();
        let (sse_tx, _) = broadcast::channel(8);
        Self { tx, sse: sse_tx }
    }
}

impl SubagentCoordinator {
    /// 启动 actor；返回对外句柄。
    pub fn start(
        config: SubagentConfig,
        runner: Arc<dyn super::runner::ChildRunner>,
    ) -> CoordinatorHandle {
        let (tx, rx) = mpsc::unbounded_channel();
        let (sse_tx, _) = broadcast::channel(256);
        let handle = CoordinatorHandle {
            tx: tx.clone(),
            sse: sse_tx.clone(),
        };
        let actor = Self {
            internal_tx: tx,
            rx,
            pending: VecDeque::new(),
            active: HashMap::new(),
            finished: HashMap::new(),
            completed_events: VecDeque::new(),
            waiters: HashMap::new(),
            permission_pending: HashMap::new(),
            config,
            per_session_active: HashMap::new(),
            sse: sse_tx,
            runner,
        };
        tokio::spawn(actor.run());
        handle
    }

    async fn run(mut self) {
        while let Some(ev) = self.rx.recv().await {
            match ev {
                SubagentEvent::Spawn { req, reply } => {
                    let ack = self.handle_spawn(req).await;
                    let _ = reply.send(ack);
                }
                SubagentEvent::ChildEvent { task_id, event } => {
                    self.handle_child_event(task_id, event);
                }
                SubagentEvent::ChildExit { task_id, result } => {
                    self.handle_child_exit(task_id, result);
                }
                SubagentEvent::PermissionRequested {
                    task_id,
                    acp_id,
                    params,
                    reply,
                } => {
                    self.handle_permission_requested(task_id, acp_id, params, reply);
                }
                SubagentEvent::SpawnReparent { params, reply } => {
                    self.handle_spawn_reparent(params, reply);
                }
                SubagentEvent::Wait { task_id, reply } => {
                    self.waiters.entry(task_id).or_default().push(reply);
                }
                SubagentEvent::GetOutput { task_id, reply } => {
                    let view = self.view(&task_id);
                    let _ = reply.send(view);
                }
                SubagentEvent::Kill { task_id, reason } => {
                    self.handle_kill(task_id, reason);
                }
                SubagentEvent::KillGroup { run_id } => {
                    self.handle_kill_group(&run_id);
                }
                SubagentEvent::PermissionDecision {
                    request_id,
                    decision,
                    remember,
                } => {
                    self.handle_permission_decision(&request_id, &decision, remember);
                }
                SubagentEvent::BudgetDeduct { run_id: _, tokens: _ } => {
                    // 预算账本由 workflow::TokenBudget 自持（原子计数），此处仅透传日志
                    tracing::debug!("workflow 预算扣减消息（账本在引擎侧）");
                }
                SubagentEvent::CompletedSnapshot { reply } => {
                    // 拉取即消费（§7.5：注入后从缓冲移除；断线期间事件在此补齐）
                    let snapshot: Vec<Value> = self.completed_events.drain(..).collect();
                    let _ = reply.send(snapshot);
                }
                SubagentEvent::CancelAll => {
                    self.handle_cancel_all();
                }
            }
        }
    }

    // ─── 准入（§7.2）───────────────────────────────────────────────────────

    async fn handle_spawn(&mut self, req: SubagentRequest) -> SpawnAck {
        // workflow 拥有者绕过限额（§14.4）
        let is_workflow = req.owner == SubagentOwner::Workflow;
        let session_active = self.per_session_active.get(&req.parent_session).copied().unwrap_or(0);

        if !is_workflow && session_active >= self.config.subagents_max_concurrent {
            if self.pending.len() >= self.config.subagents_queue_limit {
                return SpawnAck::Rejected(SubagentError::new(
                    ErrorKind::Internal,
                    format!(
                        "并发子代理已达上限（{}），队列已满（{}），请稍后再试或先等待部分子代理完成",
                        self.config.subagents_max_concurrent,
                        self.config.subagents_queue_limit
                    ),
                    false,
                ));
            }
            self.pending.push_back(req);
            return SpawnAck::Queued;
        }
        self.do_spawn(req).await;
        SpawnAck::Admitted
    }

    /// 队首补位（任一 active 完成时调用，§7.2）
    fn refill_from_queue(&mut self) {
        loop {
            if self.pending.is_empty() {
                return;
            }
            // FIFO 首个可准入请求
            let idx = {
                let mut found = None;
                for (i, req) in self.pending.iter().enumerate() {
                    if req.owner == SubagentOwner::Workflow {
                        found = Some(i);
                        break;
                    }
                    let active = self
                        .per_session_active
                        .get(&req.parent_session)
                        .copied()
                        .unwrap_or(0);
                    if active < self.config.subagents_max_concurrent {
                        found = Some(i);
                        break;
                    }
                }
                found
            };
            let Some(idx) = idx else { return };
            let req = self.pending.remove(idx).unwrap();
            self.do_spawn_boxed(req);
        }
    }

    async fn do_spawn(&mut self, req: SubagentRequest) {
        self.do_spawn_boxed(req);
    }

    fn do_spawn_boxed(&mut self, req: SubagentRequest) {
        let task_id = req.task_id.clone();
        let chat_id = req.chat_id.clone();
        let parent_session = req.parent_session.clone();
        let owner = req.owner.clone();
        let run_id = req.run_id.clone();

        // 同 task_id 重复 spawn（重试语义，§17#12）：旧实例仍在运行先 Kill
        if let Some(old) = self.active.remove(&task_id) {
            tracing::warn!("task_id {task_id} 重复 spawn：先杀旧实例");
            (old.kill)();
            old.supervisor.abort();
        }

        // worktree（桌面端；Android 强制回退共享工作区，§12）
        let worktree_path = super::worktree::maybe_create_worktree(&req);

        match self
            .runner
            .clone()
            .spawn_runner(self.handle_clone_internal(), req, worktree_path)
        {
            Ok(child) => {
                *self.per_session_active.entry(parent_session.clone()).or_insert(0) += 1;
                self.active.insert(
                    task_id.clone(),
                    ActiveChild {
                        task_id: task_id.clone(),
                        parent_session,
                        chat_id: chat_id.clone(),
                        run_id,
                        owner,
                        started_at: Instant::now(),
                        writer: child.writer,
                        kill: child.kill,
                        supervisor: child.supervisor,
                    },
                );
                self.broadcast_sse(
                    "subagent_state",
                    &chat_id,
                    &task_id,
                    json!({ "state": "running" }),
                );
            }
            Err(e) => {
                // SpawnFailed：直接置 Failed 并通知等待者
                let err = SubagentError::new(ErrorKind::SpawnFailed, e, true);
                self.finish_task(task_id.clone(), chat_id.clone(), Err(err));
            }
        }
    }

    // ─── 子代理事件 / 退出 ────────────────────────────────────────────────

    fn handle_child_event(&mut self, task_id: String, event: ChildEvent) {
        // tool_use 事件流式转发（UI 计数）；token_delta 默认不广播（避免 SSE 洪泛）
        let Some(child) = self.active.get(&task_id) else {
            return;
        };
        let chat_id = child.chat_id.clone();
        match &event {
            ChildEvent::ToolUse { name, .. } => {
                self.broadcast_sse(
                    "subagent_progress",
                    &chat_id,
                    &task_id,
                    json!({ "tool": name }),
                );
            }
            ChildEvent::StateChange { state } => {
                self.broadcast_sse(
                    "subagent_state",
                    &chat_id,
                    &task_id,
                    json!({ "state": state }),
                );
            }
            _ => {}
        }
    }

    fn handle_child_exit(
        &mut self,
        task_id: String,
        result: Result<SubagentCompletedOutput, SubagentError>,
    ) {
        let mut chat_id = String::new();
        if let Some(child) = self.active.remove(&task_id) {
            chat_id = child.chat_id.clone();
            if let Some(count) = self.per_session_active.get_mut(&child.parent_session) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    self.per_session_active.remove(&child.parent_session);
                }
            }
        }
        // worktree 收尾（§12 生命周期策略）：有改动保留、无改动删除；
        // 已删除的 worktree 从结果中清空路径
        let mut result = result;
        match super::worktree::finalize_worktree(&task_id) {
            Ok(true) => { /* 保留：路径已在 output 中 */ }
            Ok(false) => {
                if let Ok(out) = result.as_mut() {
                    out.worktree_path = None;
                }
            }
            Err(e) => tracing::warn!("worktree 收尾失败（不阻断）：{e}"),
        }
        self.finish_task(task_id, chat_id, result);
        // 队首补位
        self.refill_from_queue();
    }

    /// 终态落表 + 完成缓冲 + SSE + 唤醒等待者（§7.5）。
    fn finish_task(
        &mut self,
        task_id: String,
        chat_id: String,
        result: Result<SubagentCompletedOutput, SubagentError>,
    ) {
        match &result {
            Ok(out) => {
                // 完成事件缓冲（上限 100，满则丢最旧）
                self.completed_events.push_back(json!({
                    "taskId": task_id,
                    "chatId": chat_id,
                    "state": "completed",
                    "summary": summarize_output(out),
                }));
                if self.completed_events.len() > COMPLETED_BUFFER_LIMIT {
                    self.completed_events.pop_front();
                }
                self.broadcast_sse(
                    "subagent_completed",
                    &chat_id,
                    &task_id,
                    json!({
                        "state": "completed",
                        "output": out.output,
                        "turns": out.turns,
                        "toolCalls": out.tool_calls,
                        "durationMs": out.duration_ms,
                        "truncated": out.truncated,
                    }),
                );
                let view = TaskView::Completed(Box::new(out.clone()));
                self.finished.insert(task_id.clone(), view);
                self.notify_waiters(&task_id, WaitOutcome::Completed(out.clone()));
            }
            Err(err) => {
                self.broadcast_sse(
                    "subagent_failed",
                    &chat_id,
                    &task_id,
                    json!({
                        "state": "failed",
                        "error": err.message,
                        "kind": format!("{:?}", err.kind),
                        "retryable": err.retryable,
                    }),
                );
                let view = TaskView::Failed(Box::new(err.clone()));
                self.finished.insert(task_id.clone(), view);
                self.notify_waiters(&task_id, WaitOutcome::Failed(err.clone()));
            }
        }
        // 终态表容量控制（保留最近 500 条）
        if self.finished.len() > 500 {
            if let Some(oldest) = self.finished.keys().next().cloned() {
                self.finished.remove(&oldest);
            }
        }
    }

    fn notify_waiters(&mut self, task_id: &str, outcome: WaitOutcome) {
        if let Some(waiters) = self.waiters.remove(task_id) {
            for w in waiters {
                let _ = w.send(match &outcome {
                    WaitOutcome::Completed(o) => WaitOutcome::Completed(o.clone()),
                    WaitOutcome::Failed(e) => WaitOutcome::Failed(e.clone()),
                    WaitOutcome::Cancelled(r) => WaitOutcome::Cancelled(r.clone()),
                    WaitOutcome::NotFound => WaitOutcome::NotFound,
                });
            }
        }
    }

    // ─── 权限转发（§11.2）─────────────────────────────────────────────────

    fn handle_permission_requested(
        &mut self,
        task_id: String,
        acp_id: Value,
        params: PermissionRequestParam,
        reply: oneshot::Sender<Value>,
    ) {
        let request_id = format!("{}-{}", task_id, params.request_id);
        let chat_id = self
            .active
            .get(&task_id)
            .map(|c| c.chat_id.clone())
            .unwrap_or_default();

        tracing::info!(
            "子代理权限询问：task={task_id} tool={} request_id={request_id}",
            params.tool
        );

        // 广播给前端审批 UI（§11.2 适配：决策方为前端）
        self.broadcast_sse(
            "subagent_permission_request",
            &chat_id,
            &task_id,
            json!({
                "requestId": request_id,
                "tool": params.tool,
                "input": params.input,
            }),
        );

        self.permission_pending.insert(
            request_id.clone(),
            PendingPermission {
                task_id,
                acp_id,
                reply: Some(reply),
            },
        );

        // 超时兜底（30s 默认拒绝，§11.2 / §17#11）
        let handle = self.handle_clone_internal();
        let timeout_ms = self.config.permission_timeout_ms;
        let rid = request_id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
            handle.permission_decision(&rid, "deny", false);
        });
    }

    fn handle_permission_decision(&mut self, request_id: &str, decision: &str, remember: bool) {
        let Some(mut pending) = self.permission_pending.remove(request_id) else {
            return;
        };
        let allowed = decision == "allow";
        let reply = pending.reply.take();
        if let Some(reply) = reply {
            let payload = json!({
                "request_id": request_id,
                "decision": if allowed { "allow" } else { "deny" },
                "reason": if allowed { Value::Null } else { json!("用户拒绝或超时") },
                "remember": remember,
            });
            let _ = reply.send(payload);
        }
        // 决策结果广播（前端横幅关闭）
        let chat_id = self
            .active
            .get(&pending.task_id)
            .map(|c| c.chat_id.clone())
            .unwrap_or_default();
        self.broadcast_sse(
            "subagent_permission_resolved",
            &chat_id,
            &pending.task_id,
            json!({ "requestId": request_id, "decision": decision }),
        );
    }

    // ─── 嵌套 reparent（§15.1）────────────────────────────────────────────

    fn handle_spawn_reparent(&mut self, params: Value, reply: oneshot::Sender<Value>) {
        // reparent：parent_session 记录为根会话，深度按 0+1 计算
        tokio::spawn(async move {
            let result = super::task_tool::spawn_reparent_from_params(&params).await;
            let _ = reply.send(result);
        });
    }

    // ─── 取消（§7.6）──────────────────────────────────────────────────────

    fn handle_kill(&mut self, task_id: String, reason: CancelReason) {
        if let Some(child) = self.active.remove(&task_id) {
            let chat_id = child.chat_id.clone();
            // 优雅 kill：ACP kill 请求 → 5s → 强杀（runner kill 闭包含阶梯逻辑）
            (child.kill)();
            child.supervisor.abort();
            if let Some(count) = self.per_session_active.get_mut(&child.parent_session) {
                *count = count.saturating_sub(1);
            }
            let _ = super::worktree::finalize_worktree(&task_id);
            self.broadcast_sse(
                "subagent_state",
                &chat_id,
                &task_id,
                json!({ "state": "cancelled", "reason": format!("{reason:?}") }),
            );
            self.finished
                .insert(task_id.clone(), TaskView::Cancelled(reason.clone()));
            self.notify_waiters(&task_id, WaitOutcome::Cancelled(reason));
        } else {
            // pending 队列中清理
            if let Some(pos) = self.pending.iter().position(|r| r.task_id == task_id) {
                self.pending.remove(pos);
                self.finished
                    .insert(task_id.clone(), TaskView::Cancelled(reason.clone()));
                self.notify_waiters(&task_id, WaitOutcome::Cancelled(reason));
            } else if let Some(view) = self.finished.get(&task_id).cloned() {
                // 已终态：原样返回
                self.notify_waiters(
                    &task_id,
                    match view {
                        TaskView::Completed(o) => WaitOutcome::Completed(*o),
                        TaskView::Failed(e) => WaitOutcome::Failed(*e),
                        TaskView::Cancelled(r) => WaitOutcome::Cancelled(r),
                        _ => WaitOutcome::NotFound,
                    },
                );
            }
        }
    }

    fn handle_kill_group(&mut self, run_id: &str) {
        // active：杀掉所有 owner==Workflow && run_id 匹配
        let targets: Vec<String> = self
            .active
            .iter()
            .filter(|(_, c)| c.owner == SubagentOwner::Workflow && c.run_id.as_deref() == Some(run_id))
            .map(|(id, _)| id.clone())
            .collect();
        for id in targets {
            self.handle_kill(id, CancelReason::WorkflowCancelled);
        }
        // pending：清空同 run_id 请求
        self.pending
            .retain(|r| !(r.owner == SubagentOwner::Workflow && r.run_id.as_deref() == Some(run_id)));
    }

    fn handle_cancel_all(&mut self) {
        let ids: Vec<String> = self.active.keys().cloned().collect();
        for id in ids {
            self.handle_kill(id, CancelReason::Shutdown);
        }
        self.pending.clear();
    }

    // ─── 查询 ─────────────────────────────────────────────────────────────

    fn view(&self, task_id: &str) -> Option<TaskView> {
        if let Some(view) = self.finished.get(task_id) {
            return Some(view.clone());
        }
        if self.active.contains_key(task_id) {
            return Some(TaskView::Running {
                started_at_ms: super::persist::now_ms(),
            });
        }
        if self.pending.iter().any(|r| r.task_id == task_id) {
            return Some(TaskView::Pending);
        }
        None
    }

    fn broadcast_sse(&self, kind: &'static str, chat_id: &str, task_id: &str, payload: Value) {
        let _ = self.sse.send(SseEvent {
            kind,
            chat_id: chat_id.to_string(),
            task_id: task_id.to_string(),
            payload,
        });
    }

    fn handle_clone_internal(&self) -> CoordinatorHandle {
        CoordinatorHandle {
            tx: self.internal_tx.clone(),
            sse: self.sse.clone(),
        }
    }
}

impl ActiveChild {
    // chat_id 直接存字段
}

fn summarize_output(out: &SubagentCompletedOutput) -> String {
    let text: String = out
        .output
        .chars()
        .take(200)
        .collect();
    format!("共 {} 轮，耗时 {}ms。摘要：{}", out.turns, out.duration_ms, text)
}
