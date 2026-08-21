//! 子代理运行器（设计稿 §7.3）。
//!
//! ChildRunner trait 双实现：
//! - ProcessRunner（桌面端）：`subagent-proc --session <id> --mode subagent --data-dir <dir>`
//!   子进程，stdin/stdout 走 NDJSON ACP，stderr 重定向到 `<session>/log/stderr.log`
//! - InProcessRunner（Android 端 / 桌面端降级）：tokio task + 内存通道承载同一协议；
//!   panic 由通道 EOF 感知（Failed{Killed, retryable}），不拖垮宿主进程（§4 / §17#1）

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::Mutex as AsyncMutex;

use super::child::{run_session, ChildDeps};
use super::coordinator::CoordinatorHandle;
use super::protocol::{AcpFrame, ChildEvent, PermissionRequestParam, SpawnParams, SpawnResultPayload};
use super::transport::{channel_pair, AcpEndpoint, AcpWriter};
use super::types::{
    ErrorKind, SubagentCompletedOutput, SubagentError, SubagentRequest,
};

/// runner 产出的子代理控制句柄。
pub struct SpawnedChild {
    pub writer: AcpWriter,
    /// kill 阶梯（§7.3）：ACP kill → 5s → 强杀
    pub kill: Box<dyn FnOnce() + Send>,
    /// 监视任务：子代理结束时向 coordinator 发送 ChildExit
    pub supervisor: tokio::task::JoinHandle<()>,
}

pub trait ChildRunner: Send + Sync {
    /// 启动子代理；返回控制句柄。失败返回错误消息（SpawnFailed）。
    fn spawn_runner(
        &self,
        handle: CoordinatorHandle,
        req: SubagentRequest,
        worktree_path: Option<String>,
    ) -> Result<SpawnedChild, String>;
}

// ─── 公共：父侧泵 ──────────────────────────────────────────────────────────

/// 父侧泵：发送 spawn 请求 → 消费子侧帧流 → 转发事件/请求到 coordinator →
/// 收到 spawn 响应后派发 ChildExit；通道关闭无响应则视为崩溃（EOF，§17#1）。
fn spawn_parent_pump(
    handle: CoordinatorHandle,
    mut endpoint: AcpEndpoint,
    task_id: String,
    spawn_params: Value,
    hard_kill: Box<dyn FnOnce() + Send>,
) -> SpawnedChild {
    let writer = endpoint.writer();
    endpoint.send(AcpFrame::request(1, "spawn", spawn_params));

    let pump_task_id = task_id.clone();
    let supervisor = tokio::spawn(async move {
        let mut final_result: Option<Result<SubagentCompletedOutput, SubagentError>> = None;

        while let Some(frame) = endpoint.recv().await {
            match frame {
                AcpFrame::Notification { method, params } if method == "event" => {
                    if let Ok(ev) = serde_json::from_value::<ChildEvent>(params) {
                        handle.child_event(&pump_task_id, ev);
                    }
                }
                AcpFrame::Request { id, method, params } => match method.as_str() {
                    "permission_request" => {
                        match serde_json::from_value::<PermissionRequestParam>(params) {
                            Ok(p) => {
                                let mut rx =
                                    handle.permission_requested(&pump_task_id, id.clone(), p);
                                let w = endpoint.writer();
                                tokio::spawn(async move {
                                    match (&mut rx).await {
                                        Ok(resp) => w.send(AcpFrame::response(id, resp)),
                                        Err(_) => w.send(AcpFrame::error_response(
                                            id,
                                            -32000,
                                            "permission channel closed",
                                            None,
                                        )),
                                    }
                                });
                            }
                            Err(e) => {
                                tracing::warn!("权限请求参数解析失败（默认拒绝）：{e}");
                                let w = endpoint.writer();
                                w.send(AcpFrame::response(
                                    id,
                                    json!({ "decision": "deny", "reason": "参数解析失败" }),
                                ));
                            }
                        }
                    }
                    "spawn_reparent" => {
                        let mut rx = handle.spawn_reparent(params);
                        let w = endpoint.writer();
                        tokio::spawn(async move {
                            let resp = (&mut rx)
                                .await
                                .unwrap_or_else(|_| json!({ "error": "coordinator 无响应" }));
                            w.send(AcpFrame::response(id, resp));
                        });
                    }
                    other => {
                        let w = endpoint.writer();
                        w.send(AcpFrame::error_response(
                            id,
                            -32601,
                            &format!("未知方法：{other}"),
                            None,
                        ));
                    }
                },
                AcpFrame::Response { id, result, error } => {
                    if id == Value::from(1u64) {
                        final_result = Some(match error {
                            Some(err) => Err(SubagentError::new(
                                parse_error_kind(err.data.as_ref()),
                                err.message,
                                err.data
                                    .as_ref()
                                    .and_then(|d| d.get("retryable"))
                                    .and_then(Value::as_bool)
                                    .unwrap_or(false),
                            )),
                            None => Ok(completed_from_payload(
                                &pump_task_id,
                                result.unwrap_or(Value::Null),
                            )),
                        });
                        break;
                    }
                }
                _ => {}
            }
        }

        let result = final_result.unwrap_or_else(|| {
            Err(SubagentError::new(
                ErrorKind::Killed,
                "子代理连接断开（EOF/崩溃/被 abort）",
                true,
            ))
        });
        handle.child_exit(&pump_task_id, result);
    });

    // kill 阶梯闭包（§7.3）：ACP kill（优雅）→ 5s → 强杀
    let kill_writer = writer.clone();
    let kill = Box::new(move || {
        let w = kill_writer;
        tokio::spawn(async move {
            w.send(AcpFrame::request(2, "kill", json!({ "reason": "kill" })));
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            hard_kill();
        });
    });

    SpawnedChild {
        writer,
        kill,
        supervisor,
    }
}

fn completed_from_payload(task_id: &str, result: Value) -> SubagentCompletedOutput {
    let payload: SpawnResultPayload =
        serde_json::from_value(result).unwrap_or_default();
    SubagentCompletedOutput {
        task_id: task_id.to_string(),
        output: payload.output,
        tool_calls: payload.tool_calls,
        turns: payload.turns,
        duration_ms: payload.duration_ms,
        worktree_path: payload.worktree_path.map(PathBuf::from),
        resume_from_hint: payload.resume_from_hint,
        usage: serde_json::from_value(payload.usage).unwrap_or_default(),
        truncated: payload.truncated,
    }
}

fn parse_error_kind(data: Option<&Value>) -> ErrorKind {
    match data.and_then(|d| d.get("kind")).and_then(Value::as_str) {
        Some("ContextTooLarge") => ErrorKind::ContextTooLarge,
        Some("Timeout") => ErrorKind::Timeout,
        Some("Killed") => ErrorKind::Killed,
        Some("DepthExceeded") => ErrorKind::DepthExceeded,
        _ => ErrorKind::Internal,
    }
}

/// 由 SubagentRequest 组装 ACP spawn 参数。
pub fn request_to_spawn_params(req: &SubagentRequest, worktree_path: Option<String>) -> Value {
    let p = SpawnParams {
        agent_definition: req.agent_definition.clone(),
        prompt: req.prompt.clone(),
        description: req.description.clone(),
        cwd: req.cwd.to_string_lossy().into_owned(),
        model: req.model.clone(),
        capability_mode: Some(req.capability_mode),
        isolation: Some(req.isolation.clone()),
        permission: req.permission.clone(),
        tools_snapshot: req.tools_snapshot.clone(),
        mcp_snapshot: req.mcp_snapshot.clone(),
        hooks_snapshot: req.hooks_snapshot.clone(),
        worktree_path,
        max_turns: Some(req.max_turns),
        depth: req.depth,
        resume_from: req.resume_from.clone(),
        fork_context: req.fork_context.clone(),
        owner: req.owner.clone(),
        run_id: req.run_id.clone(),
        task_id: req.task_id.clone(),
        parent_session: req.parent_session.clone(),
        chat_id: req.chat_id.clone(),
        turn_message_id: req.turn_message_id.clone(),
        data_dir: req.data_dir.to_string_lossy().into_owned(),
    };
    serde_json::to_value(p).unwrap_or(Value::Null)
}

// ─── InProcessRunner（Android 端 / 桌面端降级）─────────────────────────────

/// 进程内依赖工厂：每次 spawn 生成一份子代理依赖集（共享宿主 Arc）。
pub type DepsFactory = Arc<dyn Fn() -> ChildDeps + Send + Sync>;

pub struct InProcessRunner {
    pub factory: DepsFactory,
    pub max_depth: u32,
}

impl InProcessRunner {
    pub fn new(factory: impl Fn() -> ChildDeps + Send + Sync + 'static, max_depth: u32) -> Self {
        Self {
            factory: Arc::new(factory),
            max_depth,
        }
    }
}

impl ChildRunner for InProcessRunner {
    fn spawn_runner(
        &self,
        handle: CoordinatorHandle,
        req: SubagentRequest,
        worktree_path: Option<String>,
    ) -> Result<SpawnedChild, String> {
        let make_deps = self.factory.clone();
        let task_id = req.task_id.clone();
        let max_depth = self.max_depth;
        let spawn_params = request_to_spawn_params(&req, worktree_path);

        let (parent_end, child_end) = channel_pair();

        // 子代理 task（宿主进程内；panic 不拖垮宿主）
        let child_task = tokio::spawn(async move {
            let deps = make_deps();
            let code = run_session(child_end, deps, max_depth).await;
            if code != 0 {
                tracing::warn!("子代理 task 异常退出（code={code}）：{task_id}");
            }
        });

        // 强杀 = abort（等价 SIGKILL，§7.3 Android 端；无 SIGTERM 阶梯）
        let kill_handle = Arc::new(AsyncMutex::new(Some(child_task)));
        let hard_kill: Box<dyn FnOnce() + Send> = {
            let kh = kill_handle;
            Box::new(move || {
                let kh = kh;
                tokio::spawn(async move {
                    if let Some(task) = kh.lock().await.take() {
                        task.abort();
                    }
                });
            })
        };

        Ok(spawn_parent_pump(
            handle,
            parent_end,
            req.task_id.clone(),
            spawn_params,
            hard_kill,
        ))
    }
}

// ─── ProcessRunner（桌面端，feature = "subagent-proc"）────────────────────

#[cfg(feature = "subagent-proc")]
pub mod process {
    use super::*;

    /// 桌面端运行器：优先子进程；二进制缺失/启动失败时降级进程内（warning）。
    pub struct DesktopRunner {
        pub fallback: InProcessRunner,
        pub binary_path: Mutex<Option<PathBuf>>,
    }

    impl DesktopRunner {
        pub fn new(fallback: InProcessRunner) -> Self {
            Self {
                fallback,
                binary_path: Mutex::new(None),
            }
        }

        fn resolve_binary(&self) -> Option<PathBuf> {
            if let Some(p) = self.binary_path.lock().unwrap().clone() {
                return Some(p);
            }
            // 环境变量优先
            if let Ok(p) = std::env::var("VENTURE_SUBAGENT_PROC") {
                let path = PathBuf::from(p);
                if path.exists() {
                    *self.binary_path.lock().unwrap() = Some(path.clone());
                    return Some(path);
                }
            }
            // 与当前可执行文件同目录
            let exe = std::env::current_exe().ok()?;
            let dir = exe.parent()?;
            let name = if cfg!(windows) { "subagent-proc.exe" } else { "subagent-proc" };
            let path = dir.join(name);
            if path.exists() {
                *self.binary_path.lock().unwrap() = Some(path.clone());
                return Some(path);
            }
            None
        }
    }

    impl ChildRunner for DesktopRunner {
        fn spawn_runner(
            &self,
            handle: CoordinatorHandle,
            req: SubagentRequest,
            worktree_path: Option<String>,
        ) -> Result<SpawnedChild, String> {
            let Some(binary) = self.resolve_binary() else {
                tracing::warn!(
                    "subagent-proc 二进制未找到，降级为进程内子代理（隔离级别：task 级）"
                );
                return self.fallback.spawn_runner(handle, req, worktree_path);
            };

            let task_id = req.task_id.clone();
            let spawn_params = request_to_spawn_params(&req, worktree_path);

            // stderr → <data_dir>/subagents/<id>/log/stderr.log（§7.3）
            let stderr_path = req
                .data_dir
                .join("subagents")
                .join(&req.task_id)
                .join("log")
                .join("stderr.log");
            let _ = std::fs::create_dir_all(stderr_path.parent().unwrap_or(&req.data_dir));
            let stderr_file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&stderr_path)
                .ok();

            let mut command = tokio::process::Command::new(&binary);
            command
                .arg("--session")
                .arg(&req.task_id)
                .arg("--mode")
                .arg("subagent")
                .arg("--data-dir")
                .arg(&req.data_dir)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(if let Some(file) = stderr_file {
                    std::process::Stdio::from(file)
                } else {
                    std::process::Stdio::null()
                });
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
            }

            let child = command
                .spawn()
                .map_err(|e| format!("subagent-proc 启动失败：{e}"))?;

            let (endpoint, pump) = super::super::transport::StdioPump::attach(child)
                .map_err(|e| format!("stdio 泵建立失败：{e}"))?;

            // 强杀 = StdioPump::hard_kill（Windows TerminateProcess / Unix SIGKILL）
            let pump_arc = Arc::new(AsyncMutex::new(pump));
            let hard_kill: Box<dyn FnOnce() + Send> = {
                let pa = pump_arc;
                Box::new(move || {
                    let pa = pa;
                    tokio::spawn(async move {
                        if let Ok(mut pump) = pa.try_lock() {
                            pump.hard_kill().await;
                        }
                    });
                })
            };

            tracing::info!("子代理进程已启动：{task_id}（binary={}）", binary.display());
            Ok(spawn_parent_pump(
                handle,
                endpoint,
                req.task_id.clone(),
                spawn_params,
                hard_kill,
            ))
        }
    }
}
