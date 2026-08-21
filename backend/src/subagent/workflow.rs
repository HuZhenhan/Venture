//! Rhai Workflow 引擎（设计稿 §14）。
//!
//! 动态编排（parallel/pipeline/spawn_agent/complete/pause/budget）+
//! journal 可恢复可回放 + 组共享 TokenBudget + 按 run_id 整组取消。
//!
//! Rhai 引擎为同步执行：运行于独立线程；宿主函数经无界通道桥接到
//! tokio 异步世界（子代理 spawn），阻塞等待结果（§14.2 宿主函数语义）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc as std_mpsc, Arc, Mutex};

use rhai::{Dynamic, Engine, EvalAltResult, Position, Scope};
use serde_json::{json, Value};
use tokio::sync::mpsc as tokio_mpsc;

use super::coordinator::{CoordinatorHandle, SpawnAck, WaitOutcome};
use super::types::{new_agent_id, new_run_id, SubagentOwner, SubagentRequest};

// ─── TokenBudget（§14.4 预算联动）─────────────────────────────────────────

pub struct TokenBudget {
    limit: AtomicU64Holder,
    spent: AtomicU64Holder,
}

// 简单别名（避免直接引入 AtomicU64 类型名冲突的困扰）
type AtomicU64Holder = std::sync::atomic::AtomicU64;

impl TokenBudget {
    pub fn new(limit: u64) -> Self {
        Self {
            limit: AtomicU64Holder::new(limit),
            spent: AtomicU64Holder::new(0),
        }
    }

    pub fn spent(&self) -> u64 {
        self.spent.load(Ordering::SeqCst)
    }

    pub fn remaining(&self) -> u64 {
        self.limit.load(Ordering::SeqCst).saturating_sub(self.spent())
    }

    pub fn limit(&self) -> u64 {
        self.limit.load(Ordering::SeqCst)
    }

    pub fn deduct(&self, tokens: u64) {
        self.spent.fetch_add(tokens, Ordering::SeqCst);
    }

    pub fn exhausted(&self) -> bool {
        self.remaining() == 0
    }
}

// ─── Journal（§14.3）───────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct JournalEntry {
    pub run_id: String,
    pub seq: u64,
    #[serde(default)]
    pub task_id: Option<String>,
    pub prompt_hash: String,
    pub status: String, // completed | failed | paused | error | cancelled
    #[serde(default)]
    pub output: Value,
    #[serde(default)]
    pub retryable: bool,
}

pub struct Journal {
    path: PathBuf,
    pub run_id: String,
    pub next_seq: u64,
    /// 已记录条目（重放复用，§14.3）
    pub entries: Vec<JournalEntry>,
}

impl Journal {
    pub fn open(dir: &std::path::Path, run_id: &str) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("workflow-{run_id}.jsonl"));
        let mut entries = Vec::new();
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                if let Ok(e) = serde_json::from_str::<JournalEntry>(line) {
                    entries.push(e);
                }
            }
        }
        let next_seq = entries
            .iter()
            .filter(|e| e.task_id.is_some())
            .map(|e| e.seq + 1)
            .max()
            .unwrap_or(1);
        Ok(Self {
            path,
            run_id: run_id.to_string(),
            next_seq,
            entries,
        })
    }

    /// 追加 + fsync（§14.3）
    pub fn append(&mut self, entry: JournalEntry) -> std::io::Result<()> {
        use std::io::Write;
        let line = serde_json::to_string(&entry).unwrap_or_default();
        {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
            f.write_all(line.as_bytes())?;
            f.write_all(b"\n")?;
            f.sync_all()?;
        }
        // seq 单调递增（恢复时作为重放水位，§14.3）
        if entry.task_id.is_some() {
            self.next_seq = self.next_seq.max(entry.seq + 1);
        }
        self.entries.push(entry);
        Ok(())
    }

    /// 重放查找：同 seq 的已完成条目（§14.3 恢复流程）。
    /// prompt_hash 不一致 → 视为脚本已修改，不复用（从头执行并告警）。
    pub fn replay(&self, seq: u64, prompt_hash: &str) -> Option<&JournalEntry> {
        let entry = self
            .entries
            .iter()
            .find(|e| e.seq == seq && e.task_id.is_some())?;
        if entry.prompt_hash != prompt_hash {
            tracing::warn!("workflow 脚本已修改（seq={seq} prompt_hash 变化），该步骤将重新执行");
            return None;
        }
        if entry.status == "completed" {
            Some(entry)
        } else {
            None
        }
    }

    /// 封口行（§14.3）
    pub fn seal(&mut self, status: &str) -> std::io::Result<()> {
        self.append(JournalEntry {
            run_id: self.run_id.clone(),
            seq: self.next_seq,
            task_id: None,
            prompt_hash: String::new(),
            status: status.to_string(),
            output: Value::Null,
            retryable: false,
        })
    }
}

fn prompt_hash(prompt: &str, options: &Value) -> String {
    let combined = format!("{prompt}||{options}");
    blake3::hash(combined.as_bytes()).to_hex().to_string()
}

// ─── 宿主函数桥（Rhai 同步世界 ↔ tokio 异步世界）──────────────────────────

/// parallel 批次等待总超时（s）：与前台等待预算一致；超时后已启动的
/// 子代理继续在后台运行，结果由完成事件通知。
const BATCH_WAIT_TIMEOUT_SECS: u64 = 600;

/// Rhai 引擎线程 → 异步世界的命令。
enum HostCommand {
    /// 串行 spawn_agent：单任务请求-应答。
    SpawnTask {
        prompt: String,
        options: Value,
        reply: std_mpsc::SyncSender<Value>,
    },
    /// parallel 批次：异步桥侧并发执行（最多 max_parallel 在途），
    /// 按 items 顺序收集结果后一次性回传（§14.2 逐项并发执行）。
    BatchSpawn {
        items: Vec<(String, Value)>,
        max_parallel: usize,
        reply: std_mpsc::SyncSender<Vec<Value>>,
    },
}

/// 宿主状态（必须 Send+Sync：register_fn 闭包捕获 Arc<HostState>）。
struct HostState {
    handle: CoordinatorHandle,
    chat_id: String,
    turn_message_id: Option<String>,
    workspace_root: Option<PathBuf>,
    data_dir: PathBuf,
    run_id: String,
    journal: Mutex<Journal>,
    budget: TokenBudget,
    cancelled: Arc<AtomicBool>,
    /// parallel 批次模式：spawn_agent 延迟登记（§14.2 parallel 语义）
    in_parallel: AtomicBool,
    /// parallel 批次收集的 (seq, prompt, options)
    parallel_batch: Mutex<Vec<(u64, String, Value)>>,
    /// parallel 批次并发上限（由 parallel_impl 设置，flush 时读取，§14.2 max_parallel）
    parallel_max: AtomicUsize,
    /// 已完成任务结果（completed_agents()）
    completed: Mutex<Vec<Value>>,
    /// 异步桥发送端
    async_tx: tokio_mpsc::UnboundedSender<HostCommand>,
    /// final output（complete() 设置）
    final_output: Mutex<Option<Value>>,
}

impl HostState {
    fn next_seq(&self) -> u64 {
        let mut journal = self.journal.lock().unwrap();
        let seq = journal.next_seq;
        journal.next_seq += 1;
        seq
    }

    /// journal 重放检查（§14.3）
    fn try_replay(&self, seq: u64, hash: &str) -> Option<Value> {
        let journal = self.journal.lock().unwrap();
        journal.replay(seq, hash).map(|e| e.output.clone())
    }

    /// 阻塞等待异步桥结果（Rhai 线程内调用）。
    fn spawn_and_wait(&self, prompt: String, options: Value) -> Result<Value, String> {
        if self.budget.exhausted() {
            return Err("budget_exhausted".into());
        }
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("workflow_cancelled".into());
        }

        let seq = self.next_seq();
        let hash = prompt_hash(&prompt, &options);

        if self.in_parallel.load(Ordering::SeqCst) {
            // 并行批次：仅登记延迟 spawn（§14.2 parallel 语义）。
            // 重放/预算检查统一在 flush_parallel_batch 完成，
            // 保证结果数组与 items 一一对应（含重放命中与跳过项）。
            self.parallel_batch
                .lock()
                .unwrap()
                .push((seq, prompt, options));
            return Ok(json!({ "deferred": true }));
        }

        // 串行：journal 重放（§14.3）
        if let Some(output) = self.try_replay(seq, &hash) {
            self.completed.lock().unwrap().push(output.clone());
            return Ok(output);
        }

        // 串行：同步等待结果
        let (reply_tx, reply_rx) = std_mpsc::sync_channel::<Value>(1);
        self.async_tx
            .send(HostCommand::SpawnTask {
                prompt: prompt.clone(),
                options: options.clone(),
                reply: reply_tx,
            })
            .map_err(|_| "async bridge closed".to_string())?;
        let result = reply_rx
            .recv_timeout(std::time::Duration::from_secs(600))
            .map_err(|_| "spawn_agent 超时（600s）".to_string())?;
        self.record_result(seq, &hash, &prompt, &options, result.clone());
        Ok(result)
    }

    fn record_result(&self, seq: u64, hash: &str, prompt: &str, options: &Value, result: Value) {
        // 预算扣减（§14.4）：prompt 估算 + 结果 tokens
        let prompt_tokens = (prompt.len() as u64 + options.to_string().len() as u64) / 4;
        let result_tokens = result.to_string().len() as u64 / 4;
        self.budget.deduct(prompt_tokens + result_tokens);

        let failed = result.get("error").is_some()
            || result.get("state").and_then(Value::as_str) == Some("failed");
        let status = if failed { "failed" } else { "completed" };
        let entry = JournalEntry {
            run_id: self.run_id.clone(),
            seq,
            task_id: result
                .get("agent_id")
                .and_then(Value::as_str)
                .map(String::from),
            prompt_hash: hash.to_string(),
            status: status.to_string(),
            output: result.clone(),
            retryable: true,
        };
        if let Err(e) = self.journal.lock().unwrap().append(entry) {
            tracing::warn!("workflow journal 追加失败：{e}");
        }
        if !failed {
            self.completed.lock().unwrap().push(result);
        }
    }

    /// parallel 批次收尾（§14.2 逐项并发执行）：
    /// 1. 逐项做 取消 / 预算 / journal 重放 检查（不占并发槽）；
    /// 2. 未命中项打包为单个 BatchSpawn 命令发给异步桥，
    ///    桥侧并发执行（最多 parallel_max 在途），按序回传；
    /// 3. 按序 record_result（journal 追加顺序与 seq 一致）。
    fn flush_parallel_batch(&self) -> Result<Vec<Value>, String> {
        let batch: Vec<(u64, String, Value)> =
            std::mem::take(&mut *self.parallel_batch.lock().unwrap());
        if batch.is_empty() {
            return Ok(Vec::new());
        }
        let max_parallel = self.parallel_max.load(Ordering::SeqCst).max(1);

        let mut results = Vec::with_capacity(batch.len());
        // 1. 取消 / 预算 / 重放检查
        let mut pending: Vec<(u64, String, Value)> = Vec::new();
        for (seq, prompt, options) in batch {
            if self.cancelled.load(Ordering::SeqCst) {
                return Err("workflow_cancelled".into());
            }
            let hash = prompt_hash(&prompt, &options);
            // journal 重放（resume 场景下批次内已完成步骤直接复用）
            if let Some(output) = self.try_replay(seq, &hash) {
                self.completed.lock().unwrap().push(output.clone());
                results.push(output);
                continue;
            }
            if self.budget.exhausted() {
                results.push(json!({ "error": "budget_exhausted" }));
                continue;
            }
            pending.push((seq, prompt, options));
        }
        if pending.is_empty() {
            return Ok(results);
        }

        // 2. 批量并发发射（一次命令，桥侧并发执行）
        let items: Vec<(String, Value)> = pending
            .iter()
            .map(|(_, p, o)| (p.clone(), o.clone()))
            .collect();
        let (reply_tx, reply_rx) = std_mpsc::sync_channel::<Vec<Value>>(1);
        self.async_tx
            .send(HostCommand::BatchSpawn {
                items,
                max_parallel,
                reply: reply_tx,
            })
            .map_err(|_| "async bridge closed".to_string())?;
        let batch_results = reply_rx
            .recv_timeout(std::time::Duration::from_secs(BATCH_WAIT_TIMEOUT_SECS))
            .map_err(|_| {
                format!(
                    "parallel 批次等待超时（{}s）：已启动的子代理继续在后台运行，完成后会自动通知",
                    BATCH_WAIT_TIMEOUT_SECS
                )
            })?;
        if batch_results.len() != pending.len() {
            return Err(format!(
                "parallel 批次结果数量不符（期望 {}，实际 {}）",
                pending.len(),
                batch_results.len()
            ));
        }

        // 3. 按序记录（顺序与登记一致，journal seq 单调）
        for (i, (seq, prompt, options)) in pending.iter().enumerate() {
            let result = batch_results[i].clone();
            self.record_result(
                *seq,
                &prompt_hash(prompt, options),
                prompt,
                options,
                result.clone(),
            );
            results.push(result);
        }
        Ok(results)
    }
}

// ─── 引擎 ──────────────────────────────────────────────────────────────────

pub struct WorkflowEngine {
    handle: CoordinatorHandle,
    data_dir: PathBuf,
    chat_id: String,
    turn_message_id: Option<String>,
    workspace_root: Option<PathBuf>,
}

impl WorkflowEngine {
    pub fn new(
        handle: CoordinatorHandle,
        data_dir: PathBuf,
        chat_id: String,
        turn_message_id: Option<String>,
        workspace_root: Option<PathBuf>,
    ) -> Self {
        Self {
            handle,
            data_dir,
            chat_id,
            turn_message_id,
            workspace_root,
        }
    }

    /// 运行 workflow 脚本。resume = Some(run_id) 时从该 run 的 journal 续跑（§14.3）。
    pub async fn run(
        &mut self,
        script: String,
        budget_limit: u64,
        resume: Option<String>,
    ) -> Result<String, String> {
        let run_id = resume.unwrap_or_else(new_run_id);
        let journal_dir = self.data_dir.join("subagents");
        let journal = Journal::open(&journal_dir, &run_id)
            .map_err(|e| format!("journal 打开失败：{e}"))?;

        let cancelled = Arc::new(AtomicBool::new(false));
        let budget = TokenBudget::new(budget_limit);
        let (async_tx, mut async_rx) = tokio_mpsc::unbounded_channel::<HostCommand>();

        let handle = self.handle.clone();
        let chat_id = self.chat_id.clone();
        let turn_message_id = self.turn_message_id.clone();
        let workspace_root = self.workspace_root.clone();
        let data_dir = self.data_dir.clone();
        let run_id_clone = run_id.clone();
        let cancel_flag = cancelled.clone();
        let script_clone = script.clone();

        // Rhai 引擎线程（同步世界）
        let engine_thread = std::thread::spawn(move || {
            let state = Arc::new(HostState {
                handle: handle.clone(),
                chat_id,
                turn_message_id,
                workspace_root,
                data_dir,
                run_id: run_id_clone,
                journal: Mutex::new(journal),
                budget,
                cancelled: cancel_flag,
                in_parallel: AtomicBool::new(false),
                parallel_batch: Mutex::new(Vec::new()),
                parallel_max: AtomicUsize::new(8),
                completed: Mutex::new(Vec::new()),
                async_tx,
                final_output: Mutex::new(None),
            });
            run_rhai_script(&state, &script_clone)
        });

        // 异步桥：HostCommand → 子代理 spawn（§14.2 spawn_agent 内部）
        let bridge_handle = self.handle.clone();
        let bridge_chat = self.chat_id.clone();
        let bridge_turn = self.turn_message_id.clone();
        let bridge_ws = self.workspace_root.clone();
        let bridge_data = self.data_dir.clone();
        let bridge_run = run_id.clone();
        let bridge_cancel = cancelled.clone();
        let bridge = tokio::spawn(async move {
            while let Some(cmd) = async_rx.recv().await {
                match cmd {
                    HostCommand::SpawnTask {
                        prompt,
                        options,
                        reply,
                    } => {
                        let result = spawn_workflow_task(
                            &bridge_handle,
                            &prompt,
                            &options,
                            &bridge_chat,
                            bridge_turn.clone(),
                            bridge_ws.clone(),
                            bridge_data.clone(),
                            &bridge_run,
                            bridge_cancel.clone(),
                        )
                        .await;
                        let _ = reply.send(result);
                    }
                    HostCommand::BatchSpawn {
                        items,
                        max_parallel,
                        reply,
                    } => {
                        // 真实并发（§14.2）：run_batch_concurrent 内 Semaphore 限流，
                        // 全部完成后按 items 顺序回传结果数组。
                        // 每份桥参数在分支内克隆一份（while 循环可多次收到 BatchSpawn）。
                        let bh = bridge_handle.clone();
                        let bc = bridge_chat.clone();
                        let bt = bridge_turn.clone();
                        let bw = bridge_ws.clone();
                        let bd = bridge_data.clone();
                        let br = bridge_run.clone();
                        let bcn = bridge_cancel.clone();
                        let results = run_batch_concurrent(
                            items,
                            max_parallel,
                            move |prompt, options| {
                                // 闭包被 clone 后共享捕获，调用时再克隆进 'static 任务
                                let bh = bh.clone();
                                let bc = bc.clone();
                                let bt = bt.clone();
                                let bw = bw.clone();
                                let bd = bd.clone();
                                let br = br.clone();
                                let bcn = bcn.clone();
                                async move {
                                    spawn_workflow_task(
                                        &bh,
                                        &prompt,
                                        &options,
                                        &bc,
                                        bt,
                                        bw,
                                        bd,
                                        &br,
                                        bcn,
                                    )
                                    .await
                                }
                            },
                        )
                        .await;
                        let _ = reply.send(results);
                    }
                }
            }
        });

        let outcome = engine_thread
            .join()
            .map_err(|_| "workflow 引擎线程崩溃".to_string())?;
        bridge.abort();
        let _ = bridge.await;

        // journal 封口（§14.3）
        {
            let journal = Journal::open(&self.data_dir.join("subagents"), &run_id)
                .map_err(|e| format!("journal 重开失败：{e}"))?;
            let mut journal = journal;
            let status = match &outcome {
                Ok(_) => "completed",
                Err(e) if e == "paused" => "paused",
                Err(e) if e == "workflow_cancelled" => "cancelled",
                Err(_) => "error",
            };
            let _ = journal.seal(status);
        }

        match outcome {
            Ok(value) => Ok(serde_json::to_string_pretty(&value).unwrap_or_default()),
            Err(e) if e == "paused" => Ok(
                "workflow 已暂停（pause()）。journal 已保存，可用 run_workflow 的 resume 参数续跑。"
                    .to_string(),
            ),
            Err(e) => Err(e),
        }
    }
}

/// 在 Rhai 线程中执行脚本：宿主函数注册 + sentinel 错误捕获。
fn run_rhai_script(state: &Arc<HostState>, script: &str) -> Result<Value, String> {
    let mut engine = Engine::new();

    // 先编译（parallel/pipeline 闭包调用需要 AST）
    let ast = engine
        .compile(script)
        .map_err(|e| format!("脚本编译失败：{e}"))?;
    let ast = Arc::new(ast);

    // ── spawn_agent(prompt, options_map) ──（§14.2）
    // options 参数用 Dynamic 宽容解析：Rhai 中 `#{}` 才是 map 字面量，
    // 模型生成的脚本常写 `{}`（空块/unit）——统一视为空 options。
    {
        let state = state.clone();
        engine.register_fn(
            "spawn_agent",
            move |prompt: &str, options: Dynamic| -> Result<Dynamic, Box<EvalAltResult>> {
                let options_value = if options.is_unit() {
                    json!({})
                } else {
                    rhai_to_json(&options)
                };
                match state.spawn_and_wait(prompt.to_string(), options_value) {
                    Ok(v) => Ok(json_to_rhai(&v)),
                    Err(e) => Err(runtime_err(&e)),
                }
            },
        );
    }

    // ── parallel(closure, items, max_parallel?) ──（§14.2）
    // 闭包通过 `NativeCallContext` 首参访问引擎（Rhai 1.25 官方机制；
    // 不能注册带 `&Engine` 首参的闭包——会被注册为方法，自由函数调用报
    // "Function not found"）。FnPtr 调用用 `call_within_context`（无需 AST）。
    {
        let state = state.clone();
        engine.register_fn(
            "parallel",
            move |ctx: rhai::NativeCallContext, closure: rhai::FnPtr, items: rhai::Array| {
                parallel_impl(state.clone(), &ctx, closure, items, 8)
            },
        );
    }
    {
        let state = state.clone();
        engine.register_fn(
            "parallel",
            move |ctx: rhai::NativeCallContext,
                  closure: rhai::FnPtr,
                  items: rhai::Array,
                  max_p: i64| {
                parallel_impl(
                    state.clone(),
                    &ctx,
                    closure,
                    items,
                    max_p.clamp(1, 16) as usize,
                )
            },
        );
    }

    // ── pipeline(items, stage1, stage2, ...) ──（§14.2）
    {
        let state = state.clone();
        engine.register_fn(
            "pipeline",
            move |ctx: rhai::NativeCallContext, items: rhai::Array, stages: rhai::Array| {
                pipeline_impl(state.clone(), &ctx, items, stages)
            },
        );
    }

    // ── complete(results?) ──（§14.2）
    {
        let state = state.clone();
        engine.register_fn("complete", move || -> Result<Dynamic, Box<EvalAltResult>> {
            let results = state.completed.lock().unwrap().clone();
            *state.final_output.lock().unwrap() = Some(Value::Array(results));
            Err(runtime_err("__COMPLETE__"))
        });
    }
    {
        let state = state.clone();
        engine.register_fn(
            "complete",
            move |results: Dynamic| -> Result<Dynamic, Box<EvalAltResult>> {
                *state.final_output.lock().unwrap() = Some(rhai_to_json(&results));
                Err(runtime_err("__COMPLETE__"))
            },
        );
    }

    // ── pause() ──（§14.2）
    {
        engine.register_fn("pause", move || -> Result<Dynamic, Box<EvalAltResult>> {
            Err(runtime_err("__PAUSED__"))
        });
    }

    // ── budget() ──（§14.2）
    {
        let state = state.clone();
        engine.register_fn("budget", move || {
            let mut m = rhai::Map::new();
            m.insert("spent".into(), Dynamic::from(state.budget.spent() as i64));
            m.insert(
                "remaining".into(),
                Dynamic::from(state.budget.remaining() as i64),
            );
            m.insert("limit".into(), Dynamic::from(state.budget.limit() as i64));
            Dynamic::from(m)
        });
    }

    // ── completed_agents() ──（§14.2）
    {
        let state = state.clone();
        engine.register_fn("completed_agents", move || {
            let results = state.completed.lock().unwrap().clone();
            json_to_rhai(&Value::Array(results))
        });
    }

    // ── read_json(path) ──（§14.2 示例脚本）
    {
        engine.register_fn(
            "read_json",
            move |path: &str| -> Result<Dynamic, Box<EvalAltResult>> {
                match std::fs::read_to_string(path)
                    .ok()
                    .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                {
                    Some(v) => Ok(json_to_rhai(&v)),
                    None => Err(runtime_err(&format!("read_json 失败：{path}"))),
                }
            },
        );
    }

    let mut scope = Scope::new();
    match engine.eval_ast_with_scope::<Dynamic>(&mut scope, &ast) {
        Ok(v) => Ok(rhai_to_json(&v)),
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("__COMPLETE__") {
                let final_out = state.final_output.lock().unwrap().clone();
                return Ok(final_out.unwrap_or(Value::Null));
            }
            if msg.contains("__PAUSED__") {
                return Err("paused".to_string());
            }
            if msg.contains("workflow_cancelled") {
                return Err("workflow_cancelled".to_string());
            }
            if msg.contains("budget_exhausted") {
                return Err(
                    "budget_exhausted：预算已耗尽，可捕获该错误后调用 complete() 提前收尾"
                        .to_string(),
                );
            }
            Err(format!("脚本错误：{msg}"))
        }
    }
}

fn runtime_err(msg: &str) -> Box<EvalAltResult> {
    Box::new(EvalAltResult::ErrorRuntime(
        Dynamic::from(msg.to_string()),
        Position::NONE,
    ))
}

/// 调用闭包并容错参数个数：Rhai 的 FnPtr 调用要求参数精确匹配，
/// 0 参闭包（`|| {...}`）被 1 参调用会走名字查找并报 `anon$... not found`
/// （未执行闭包体）。此时按 0 参重试一次；其他错误原样传播。
fn call_closure_flexible(
    ctx: &rhai::NativeCallContext,
    closure: &rhai::FnPtr,
    arg: Dynamic,
) -> Result<Dynamic, Box<EvalAltResult>> {
    match closure.call_within_context::<Dynamic>(ctx, (arg.clone(),)) {
        Ok(v) => Ok(v),
        Err(e) if is_closure_arity_error(&e) => {
            // 0 参闭包：重试为 0 参调用（1 参调用未执行闭包体，无副作用重复）
            closure.call_within_context::<Dynamic>(ctx, ())
        }
        Err(e) => Err(e),
    }
}

fn is_closure_arity_error(e: &EvalAltResult) -> bool {
    matches!(
        e,
        EvalAltResult::ErrorFunctionNotFound(name, _) if name.starts_with("anon$")
    )
}

#[allow(clippy::too_many_arguments)]
fn parallel_impl(
    state: Arc<HostState>,
    ctx: &rhai::NativeCallContext,
    closure: rhai::FnPtr,
    items: rhai::Array,
    max_parallel: usize,
) -> Result<Dynamic, Box<EvalAltResult>> {
    // max_parallel 真正生效：并发上限存入 HostState，flush 时由桥侧 Semaphore 限流
    // （单次调用上限 16 由 register 侧 clamp；缺省 8 由 register 侧 3 参重载提供）
    state
        .parallel_max
        .store(max_parallel.clamp(1, 16), Ordering::SeqCst);

    // 逐个执行 closure；记录每个 item 是否产生了 spawn_agent 登记：
    // - 未登记 → 该项计为跳过（§14.2），结果数组以 {skipped:true} 占位（与 items 一一对应）
    // - 多次登记 → 告警并只保留第一个（防闭包滥用导致结果错位）
    let mut skip_flags: Vec<bool> = Vec::with_capacity(items.len());
    state.in_parallel.store(true, Ordering::SeqCst);
    let result = (|| -> Result<(), Box<EvalAltResult>> {
        for item in &items {
            let before = state.parallel_batch.lock().unwrap().len();
            call_closure_flexible(ctx, &closure, item.clone())?;
            let after = state.parallel_batch.lock().unwrap().len();
            let spawned = after.saturating_sub(before);
            skip_flags.push(spawned == 0);
            if spawned > 1 {
                tracing::warn!(
                    "parallel closure 对单个 item 触发了 {spawned} 次 spawn_agent，仅保留第一个"
                );
                state.parallel_batch.lock().unwrap().truncate(before + 1);
            }
        }
        Ok(())
    })();
    state.in_parallel.store(false, Ordering::SeqCst);
    result?;

    // 收尾：批次内真实并发执行（flush 内部），返回结果数组
    let batch_results = state
        .flush_parallel_batch()
        .map_err(|e| runtime_err(&e))?;
    // 跳过项插入占位，保持与 items 一一对应（§14.2 顺序一致）
    let mut out = Vec::with_capacity(items.len());
    let mut it = batch_results.into_iter();
    for (i, _item) in items.iter().enumerate() {
        if skip_flags.get(i).copied().unwrap_or(false) {
            out.push(json!({ "skipped": true }));
        } else {
            out.push(it.next().unwrap_or(json!({ "error": "missing result" })));
        }
    }
    Ok(json_to_rhai(&Value::Array(out)))
}

fn pipeline_impl(
    _state: Arc<HostState>,
    ctx: &rhai::NativeCallContext,
    items: rhai::Array,
    stages: rhai::Array,
) -> Result<Dynamic, Box<EvalAltResult>> {
    let stage_ptrs: Vec<rhai::FnPtr> = stages
        .into_iter()
        .filter_map(|s| s.try_cast::<rhai::FnPtr>())
        .collect();

    // 每项依次过每个阶段；任何阶段失败 → 该项标记失败，跳过其后续阶段（§14.2）
    let mut results = Vec::new();
    for item in &items {
        let mut current = item.clone();
        let mut failed = None;
        for stage in &stage_ptrs {
            match call_closure_flexible(ctx, stage, current.clone()) {
                Ok(next) => current = next,
                Err(e) => {
                    failed = Some(e.to_string());
                    break;
                }
            }
        }
        match failed {
            Some(msg) => results.push(json!({ "error": msg, "failed": true })),
            None => results.push(rhai_to_json(&current)),
        }
    }
    Ok(json_to_rhai(&Value::Array(results)))
}

// ─── JSON ↔ Rhai 转换 ──────────────────────────────────────────────────────

fn rhai_map_to_json(map: &rhai::Map) -> Value {
    let mut out = serde_json::Map::new();
    for (k, v) in map {
        out.insert(k.to_string(), rhai_to_json(v));
    }
    Value::Object(out)
}

fn rhai_to_json(v: &Dynamic) -> Value {
    if v.is_unit() {
        return Value::Null;
    }
    if let Some(b) = v.clone().try_cast::<bool>() {
        return Value::Bool(b);
    }
    if let Some(i) = v.clone().try_cast::<i64>() {
        return json!(i);
    }
    if let Some(f) = v.clone().try_cast::<f64>() {
        return json!(f);
    }
    if let Some(s) = v.clone().try_cast::<String>() {
        return Value::String(s);
    }
    if let Some(arr) = v.clone().try_cast::<rhai::Array>() {
        return Value::Array(arr.iter().map(rhai_to_json).collect());
    }
    if let Some(map) = v.clone().try_cast::<rhai::Map>() {
        return rhai_map_to_json(&map);
    }
    Value::String(v.to_string())
}

fn json_to_rhai(v: &Value) -> Dynamic {
    match v {
        Value::Null => Dynamic::UNIT,
        Value::Bool(b) => Dynamic::from(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Dynamic::from(i)
            } else {
                Dynamic::from(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => Dynamic::from(s.clone()),
        Value::Array(arr) => Dynamic::from(
            arr.iter()
                .map(json_to_rhai)
                .collect::<Vec<Dynamic>>(),
        ),
        Value::Object(map) => {
            let mut m = rhai::Map::new();
            for (k, val) in map {
                m.insert(k.as_str().into(), json_to_rhai(val));
            }
            Dynamic::from(m)
        }
    }
}

// ─── 异步侧：批次并发执行 + spawn_workflow_task（§14.2）────────────────────

/// 并发执行一批 spawn 请求（§14.2 逐项并发执行）：
/// Semaphore 限流最多 `max_parallel` 在途；全部完成后按 items 顺序返回结果数组。
/// 桥与单元测试共用（测试注入假 spawn 函数）。
async fn run_batch_concurrent<F, Fut>(
    items: Vec<(String, Value)>,
    max_parallel: usize,
    spawn: F,
) -> Vec<Value>
where
    F: Fn(String, Value) -> Fut + Clone + Send + Sync + 'static,
    Fut: std::future::Future<Output = Value> + Send + 'static,
{
    let sem = Arc::new(tokio::sync::Semaphore::new(max_parallel.max(1)));
    let mut handles = Vec::with_capacity(items.len());
    for (prompt, options) in items {
        let permit = match sem.clone().acquire_owned().await {
            Ok(p) => p,
            Err(_) => break, // 信号量已关闭（本函数持有 Arc，不会发生）
        };
        // 每个任务持有闭包的一份克隆（'static，互不借用）
        let spawn = spawn.clone();
        let h = tokio::spawn(async move {
            let _permit = permit;
            spawn(prompt, options).await
        });
        handles.push(h);
    }
    let mut results = Vec::with_capacity(handles.len());
    for h in handles {
        results.push(h.await.unwrap_or_else(|_| {
            json!({ "error": "workflow task panicked" })
        }));
    }
    results
}

// ─── 异步侧：spawn_workflow_task（§14.2 SubagentRequest{owner: Workflow}）──

#[allow(clippy::too_many_arguments)]
async fn spawn_workflow_task(
    handle: &CoordinatorHandle,
    prompt: &str,
    options: &Value,
    chat_id: &str,
    turn_message_id: Option<String>,
    workspace_root: Option<PathBuf>,
    data_dir: PathBuf,
    run_id: &str,
    cancelled: Arc<AtomicBool>,
) -> Value {
    if cancelled.load(Ordering::SeqCst) {
        return json!({ "error": "workflow_cancelled" });
    }

    let agent_name = options
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or("general-purpose");
    let definition = {
        let registry = match crate::subagent::current_registry() {
            Some(r) => r,
            None => return json!({ "error": "registry 未初始化" }),
        };
        let registry = registry.read().unwrap();
        match registry.lookup(agent_name) {
            Ok(d) => d.clone(),
            Err(e) => return json!({ "error": e.to_string() }),
        }
    };

    let task_id = new_agent_id();
    let req = SubagentRequest {
        task_id: task_id.clone(),
        parent_session: chat_id.to_string(),
        depth: 1,
        agent_definition: definition,
        prompt: prompt.to_string(),
        description: format!("workflow-{run_id}"),
        cwd: workspace_root.clone().unwrap_or_else(|| PathBuf::from(".")),
        model: options.get("model").and_then(Value::as_str).map(String::from),
        capability_mode: options
            .get("capability_mode")
            .and_then(Value::as_str)
            .and_then(super::types::CapabilityMode::parse)
            .unwrap_or_default(),
        isolation: super::types::Isolation::None,
        resume_from: options
            .get("resume_from")
            .and_then(Value::as_str)
            .map(String::from),
        fork_context: None,
        owner: SubagentOwner::Workflow,
        run_id: Some(run_id.to_string()),
        tools_snapshot: super::tools_snapshot::current(),
        mcp_snapshot: json!({}),
        permission: super::types::Ruleset::default(),
        hooks_snapshot: vec![],
        chat_id: chat_id.to_string(),
        turn_message_id,
        max_turns: 40,
        data_dir,
    };

    match handle.spawn(req).await {
        SpawnAck::Rejected(e) => json!({ "error": e.message }),
        _ => match handle.wait_completion(&task_id).await {
            Some(WaitOutcome::Completed(out)) => json!({
                "agent_id": out.task_id,
                "state": "completed",
                "output": out.output,
                "turns": out.turns,
                "tool_calls": out.tool_calls,
                "usage": {
                    "input_tokens": out.usage.prompt_tokens,
                    "output_tokens": out.usage.completion_tokens,
                },
            }),
            Some(WaitOutcome::Failed(e)) => {
                json!({ "agent_id": task_id, "state": "failed", "error": e.message })
            }
            Some(WaitOutcome::Cancelled(r)) => {
                json!({ "agent_id": task_id, "state": "cancelled", "reason": format!("{r:?}") })
            }
            _ => json!({ "agent_id": task_id, "state": "unknown" }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::mpsc as tokio_mpsc;

    /// 测试桥：响应 BatchSpawn，按序回传简单结果。
    fn spawn_test_bridge(
        mut async_rx: tokio_mpsc::UnboundedReceiver<HostCommand>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            while let Some(cmd) = async_rx.recv().await {
                if let HostCommand::BatchSpawn {
                    items,
                    max_parallel,
                    reply,
                } = cmd
                {
                    let results = run_batch_concurrent(items, max_parallel, |prompt, _| async move {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                        json!({ "agent_id": prompt, "state": "completed", "output": prompt })
                    })
                    .await;
                    let _ = reply.send(results);
                }
            }
        })
    }

    /// 构造测试用 HostState（哑 handle + 空 journal + 大预算），
    /// 返回 (state, 通道接收端) 供测试桥消费。
    fn test_host_state(
        data_dir: &std::path::Path,
        run_id: &str,
        batch: Vec<(u64, String, Value)>,
    ) -> (Arc<HostState>, tokio_mpsc::UnboundedReceiver<HostCommand>) {
        let journal = Journal::open(data_dir, run_id).unwrap();
        let (async_tx, async_rx) = tokio_mpsc::unbounded_channel::<HostCommand>();
        let state = Arc::new(HostState {
            handle: super::super::coordinator::CoordinatorHandle::dummy(),
            chat_id: "chat".into(),
            turn_message_id: None,
            workspace_root: None,
            data_dir: data_dir.to_path_buf(),
            run_id: run_id.into(),
            journal: Mutex::new(journal),
            budget: TokenBudget::new(1_000_000),
            cancelled: Arc::new(AtomicBool::new(false)),
            in_parallel: AtomicBool::new(false),
            parallel_batch: Mutex::new(batch),
            parallel_max: AtomicUsize::new(2),
            completed: Mutex::new(Vec::new()),
            async_tx,
            final_output: Mutex::new(None),
        });
        (state, async_rx)
    }

    #[tokio::test]
    async fn batch_concurrent_respects_limit_and_order() {
        // 10 个任务，max_parallel=3：并发峰值必须达到 3 且不超过 3，
        // 结果顺序与 items 一致（真实并发 + 限流，§14.2）。
        let started = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let items: Vec<(String, Value)> = (0..10)
            .map(|i| (format!("task{i}"), json!({})))
            .collect();
        let started_c = started.clone();
        let peak_c = peak.clone();
        let results = run_batch_concurrent(items, 3, move |prompt, _| {
            let started = started_c.clone();
            let peak = peak_c.clone();
            async move {
                let now = started.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                started.fetch_sub(1, Ordering::SeqCst);
                json!({ "agent_id": format!("t-{prompt}") })
            }
        })
        .await;
        assert_eq!(results.len(), 10);
        assert_eq!(results[0]["agent_id"], "t-task0");
        assert_eq!(results[9]["agent_id"], "t-task9");
        let p = peak.load(Ordering::SeqCst);
        assert!(p >= 3, "并发峰值应达到 max_parallel=3，实际 {p}");
        assert!(p <= 3, "并发峰值不应超过 max_parallel=3，实际 {p}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn flush_parallel_batch_orders_and_records() {
        // 3 项批次经测试桥并发执行：结果顺序、journal seq、completed 汇总正确。
        let dir = tempfile::tempdir().unwrap();
        let (state, async_rx) = test_host_state(
            dir.path(),
            "run-flush",
            vec![
                (1, "p1".into(), json!({ "a": 1 })),
                (2, "p2".into(), json!({ "a": 2 })),
                (3, "p3".into(), json!({ "a": 3 })),
            ],
        );
        let bridge = spawn_test_bridge(async_rx);

        let results = state.flush_parallel_batch().unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0]["output"], "p1");
        assert_eq!(results[1]["output"], "p2");
        assert_eq!(results[2]["output"], "p3");

        let entries = state.journal.lock().unwrap().entries.clone();
        let task_entries: Vec<&JournalEntry> = entries
            .iter()
            .filter(|e| e.task_id.is_some())
            .collect();
        assert_eq!(task_entries.len(), 3, "journal 应记录 3 条任务结果");
        assert_eq!(task_entries[0].seq, 1);
        assert_eq!(task_entries[2].seq, 3);
        assert_eq!(state.completed.lock().unwrap().len(), 3);
        bridge.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn parallel_skipped_and_mixed_items_aligned() {
        // 空闭包（不调 spawn_agent）→ 全部 {skipped:true} 占位；
        // 条件闭包 → 跳过的项占位，spawn 的项有结果，数组与 items 一一对应。
        let dir = tempfile::tempdir().unwrap();
        let (async_tx, async_rx) = tokio_mpsc::unbounded_channel::<HostCommand>();
        let journal = Journal::open(dir.path(), "run-skip").unwrap();
        let state = Arc::new(HostState {
            handle: super::super::coordinator::CoordinatorHandle::dummy(),
            chat_id: "chat".into(),
            turn_message_id: None,
            workspace_root: None,
            data_dir: dir.path().to_path_buf(),
            run_id: "run-skip".into(),
            journal: Mutex::new(journal),
            budget: TokenBudget::new(1_000_000),
            cancelled: Arc::new(AtomicBool::new(false)),
            in_parallel: AtomicBool::new(false),
            parallel_batch: Mutex::new(Vec::new()),
            parallel_max: AtomicUsize::new(8),
            completed: Mutex::new(Vec::new()),
            async_tx: async_tx.clone(),
            final_output: Mutex::new(None),
        });
        let bridge = spawn_test_bridge(async_rx);

        // 全部跳过
        let out = run_rhai_script(&state, "parallel(|| { 1 }, [10, 20, 30])").unwrap();
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert!(
            arr.iter().all(|v| v["skipped"] == json!(true)),
            "空闭包应全部标记 skipped：{arr:?}"
        );

        // 条件 spawn：x > 15 的项 spawn，其余跳过
        // 注意：Rhai 中 map 字面量是 `#{}`；`{}` 是空块(unit)，spawn_agent 宽容处理为空 options
        let out2 = run_rhai_script(
            &state,
            "parallel(|x| { if x > 15 { spawn_agent(\"t\" + x, #{}); } }, [10, 20, 30])",
        )
        .unwrap();
        let arr2 = out2.as_array().unwrap();
        assert_eq!(arr2.len(), 3, "结果数组必须与 items 一一对应：{arr2:?}");
        assert_eq!(arr2[0]["skipped"], json!(true), "10 未 spawn 应跳过");
        assert_eq!(arr2[1]["agent_id"], "t20");
        assert_eq!(arr2[2]["agent_id"], "t30");
        assert!(arr2[1]["skipped"].is_null());

        bridge.abort();
    }

    #[test]
    fn budget_deduct_and_exhaust() {
        let b = TokenBudget::new(100);
        b.deduct(60);
        assert_eq!(b.remaining(), 40);
        assert!(!b.exhausted());
        b.deduct(60);
        assert!(b.exhausted());
        assert_eq!(b.remaining(), 0);
    }

    #[test]
    fn journal_replay_and_hash_change() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = Journal::open(dir.path(), "run-test").unwrap();
        j.append(JournalEntry {
            run_id: "run-test".into(),
            seq: 1,
            task_id: Some("t1".into()),
            prompt_hash: "hash-a".into(),
            status: "completed".into(),
            output: json!({ "ok": true }),
            retryable: false,
        })
        .unwrap();
        assert_eq!(j.next_seq, 2);
        let hit = j.replay(1, "hash-a").unwrap();
        assert_eq!(hit.output["ok"], json!(true));
        assert!(j.replay(1, "hash-b").is_none());
    }

    #[test]
    fn journal_seal_writes_status() {
        let dir = tempfile::tempdir().unwrap();
        let mut j = Journal::open(dir.path(), "run-seal").unwrap();
        j.seal("paused").unwrap();
        let reloaded = Journal::open(dir.path(), "run-seal").unwrap();
        assert!(reloaded.entries.iter().any(|e| e.status == "paused"));
    }

    #[test]
    fn prompt_hash_stable_and_sensitive() {
        let a = prompt_hash("p", &json!({"agent": "explore"}));
        let b = prompt_hash("p", &json!({"agent": "explore"}));
        let c = prompt_hash("p2", &json!({"agent": "explore"}));
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn json_rhai_roundtrip() {
        let v = json!({ "a": 1, "b": "x", "c": [1, 2], "d": true, "e": null });
        let d = json_to_rhai(&v);
        let back = rhai_to_json(&d);
        assert_eq!(back["a"], json!(1));
        assert_eq!(back["b"], json!("x"));
        assert_eq!(back["c"], json!([1, 2]));
        assert_eq!(back["d"], json!(true));
        assert!(back["e"].is_null());
    }
}
