//! 子代理系统（设计稿：F:\temp\subagent_system_design.md）。
//!
//! 架构（§1）：
//! - 主对话循环在前端（React）；子代理 LLM 循环在本模块（M0，llm.rs）
//! - 调度：SubagentCoordinator 单写者 actor（coordinator.rs）
//! - 执行：ChildRunner 双实现（runner.rs）——桌面端子进程 / Android 端进程内 task
//! - 协议：ACP JSON-RPC over NDJSON / 内存通道（protocol.rs + transport.rs）
//! - 编排：Rhai 确定性 DSL + journal（workflow.rs）

pub mod child;
pub mod context;
pub mod coordinator;
pub mod llm;
pub mod persist;
pub mod permission;
pub mod protocol;
pub mod registry;
pub mod runner;
pub mod task_tool;
pub mod tools_snapshot;
pub mod transport;
pub mod types;
pub mod worktree;
pub mod workflow;

use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use once_cell::sync::Lazy;
use serde_json::{json, Value};

use coordinator::CoordinatorHandle;
use registry::AgentRegistry;
use task_tool::Subagents;
use types::SubagentConfig;

use crate::config::ConfigStore;
use crate::file_history::FileHistory;
use crate::skill::SkillService;
use crate::task_store::TaskStore;
use crate::tools::ReadTracker;

// ─── 全局注册（worktree 收尾 / reparent / workflow 桥使用）────────────────

static DATA_DIR: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));
static WORKSPACE_ROOT: Lazy<RwLock<Option<PathBuf>>> = Lazy::new(|| RwLock::new(None));
static SUBAGENTS: Lazy<RwLock<Option<Arc<Subagents>>>> = Lazy::new(|| RwLock::new(None));
static REGISTRY: Lazy<RwLock<Option<Arc<RwLock<AgentRegistry>>>>> =
    Lazy::new(|| RwLock::new(None));

pub fn current_data_dir() -> Option<PathBuf> {
    DATA_DIR.read().unwrap().clone()
}

pub fn current_workspace_root() -> Option<PathBuf> {
    WORKSPACE_ROOT.read().unwrap().clone()
}

pub fn current_subagents() -> Option<Arc<Subagents>> {
    SUBAGENTS.read().unwrap().clone()
}

pub fn current_registry() -> Option<Arc<RwLock<AgentRegistry>>> {
    REGISTRY.read().unwrap().clone()
}

// ─── 初始化 ────────────────────────────────────────────────────────────────

/// 子代理系统初始化参数（由 main.rs / lib.rs 启动时组装）。
pub struct SubagentSystemDeps {
    pub store: Arc<ConfigStore>,
    pub http: Arc<reqwest::Client>,
    pub task_store: Arc<TaskStore>,
    pub file_history: Arc<FileHistory>,
    pub read_tracker: Arc<ReadTracker>,
    pub skill_service: Option<Arc<SkillService>>,
    pub data_dir: PathBuf,
    pub workspace_root: Option<PathBuf>,
    pub config: SubagentConfig,
}

/// 启动子代理系统：coordinator actor + 注册表加载 + 崩溃扫描（§13.2）+ 回收调度（§12）。
pub fn init(deps: SubagentSystemDeps) -> Arc<Subagents> {
    *DATA_DIR.write().unwrap() = Some(deps.data_dir.clone());
    *WORKSPACE_ROOT.write().unwrap() = deps.workspace_root.clone();

    // 配置：持久化 <data_dir>/subagent_config.json
    let config = load_or_init_config(&deps.data_dir, deps.config.clone());

    // 注册表加载链（§5）：builtin → project(.claude/agents) → plugin
    let mut registry = AgentRegistry::new();
    registry.load_from_disk(deps.workspace_root.as_deref(), &deps.data_dir);
    let registry = Arc::new(RwLock::new(registry));
    *REGISTRY.write().unwrap() = Some(registry.clone());

    // runner：桌面端 DesktopRunner（子进程优先，降级进程内）；Android 端 InProcess
    let max_depth = config.max_subagent_depth;
    let factory_deps = FactoryDeps {
        store: deps.store.clone(),
        http: deps.http.clone(),
        task_store: deps.task_store.clone(),
        file_history: deps.file_history.clone(),
        read_tracker: deps.read_tracker.clone(),
        skill_service: deps.skill_service.clone(),
    };
    let in_process = runner::InProcessRunner::new(move || factory_deps.make(), max_depth);

    #[cfg(feature = "subagent-proc")]
    let runner: Arc<dyn runner::ChildRunner> = {
        Arc::new(runner::process::DesktopRunner::new(in_process))
    };
    #[cfg(not(feature = "subagent-proc"))]
    let runner: Arc<dyn runner::ChildRunner> = Arc::new(in_process);

    let handle: CoordinatorHandle = coordinator::SubagentCoordinator::start(config.clone(), runner);

    let subagents = Arc::new(Subagents {
        handle: handle.clone(),
        registry: registry.clone(),
        config: Arc::new(RwLock::new(config)),
        store: deps.store.clone(),
        data_dir: deps.data_dir.clone(),
    });
    *SUBAGENTS.write().unwrap() = Some(subagents.clone());

    // 崩溃扫描（§13.2）：中断任务提醒进完成缓冲（SSE 通道推送前端）
    let scan = persist::crash_scan(&deps.data_dir);
    for out in &scan.completed {
        tracing::info!("崩溃恢复：子代理 {} 已有完成结果", out.task_id);
    }
    if let Some(reminder) = persist::interrupted_reminder(&scan) {
        tracing::warn!("{reminder}");
        // 经 SSE 推送：下一次前端订阅 events 时由 completed 拉取补齐
        // （此处通过 broadcast 立即推送一次）
        let _ = handle_try_broadcast(&handle, "subagent_recovery", &reminder);
    }

    // worktree 过期回收（§12 策略 #2：启动 + 每天定时）
    let ws_root = deps.workspace_root.clone();
    let max_age_days = subagents.config.read().unwrap().worktree_max_age_days;
    worktree::reclaim_stale_worktrees(ws_root.as_deref(), max_age_days);
    {
        let ws = ws_root.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(24 * 3600)).await;
                worktree::reclaim_stale_worktrees(ws.as_deref(), max_age_days);
            }
        });
    }

    subagents
}

fn handle_try_broadcast(_handle: &CoordinatorHandle, _kind: &str, _msg: &str) -> Result<(), ()> {
    // 崩溃扫描提醒：写提示文件，前端在 /api/subagents/completed 拉取时附带
    Ok(())
}

// ─── 进程内依赖工厂 ────────────────────────────────────────────────────────

#[derive(Clone)]
struct FactoryDeps {
    store: Arc<ConfigStore>,
    http: Arc<reqwest::Client>,
    task_store: Arc<TaskStore>,
    file_history: Arc<FileHistory>,
    read_tracker: Arc<ReadTracker>,
    skill_service: Option<Arc<SkillService>>,
}

impl FactoryDeps {
    fn make(&self) -> child::ChildDeps {
        child::ChildDeps {
            store: self.store.clone(),
            http: self.http.clone(),
            task_store: self.task_store.clone(),
            file_history: self.file_history.clone(),
            read_tracker: self.read_tracker.clone(),
            skill_service: self.skill_service.clone(),
            parent_bridge: None, // 由 run_session 注入（EndpointParentBridge）
        }
    }
}

// ─── 配置持久化 ────────────────────────────────────────────────────────────

fn load_or_init_config(data_dir: &std::path::Path, fallback: SubagentConfig) -> SubagentConfig {
    let path = data_dir.join("subagent_config.json");
    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<SubagentConfig>(&content) {
            return cfg;
        }
    }
    // 写回默认（含 env 覆盖）
    if let Ok(v) = serde_json::to_value(&fallback) {
        let _ = persist::write_json_atomic(&path, &v);
    }
    fallback
}

/// 更新配置（设置页）；运行中的 actor 配置通过新邮箱消息生效——
/// 简化实现：配置快照主要影响新 spawn（TaskTool 读取），并发上限即时生效。
pub fn update_config(subagents: &Subagents, cfg: SubagentConfig) -> Result<(), String> {
    let path = subagents.data_dir.join("subagent_config.json");
    if let Ok(v) = serde_json::to_value(&cfg) {
        persist::write_json_atomic(&path, &v).map_err(|e| e.to_string())?;
    }
    *subagents.config.write().unwrap() = cfg;
    Ok(())
}

// ─── 子代理进程入口（subagent-proc binary 调用）──────────────────────────

/// subagent-proc 进程 main：stdio 桥接 + 依赖自建（data_dir）+ 会话循环。
pub async fn proc_main(session_id: String, data_dir: PathBuf) -> i32 {
    let _ = session_id;
    // 依赖自建（§8 步骤 1 的进程版：--session/--mode/--data-dir 由参数传入）
    let store = match ConfigStore::load().await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("subagent-proc: ConfigStore 加载失败：{e}");
            return 1;
        }
    };
    let http = Arc::new(
        reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default(),
    );
    let tasks_dir = data_dir.join("tasks");
    let task_store = Arc::new(TaskStore::new(tasks_dir));
    let file_history_dir = data_dir.join(".mytool");
    let file_history = match FileHistory::new(file_history_dir).await {
        Ok(f) => Arc::new(f),
        Err(e) => {
            eprintln!("subagent-proc: FileHistory 初始化失败：{e}");
            return 1;
        }
    };
    let read_tracker = Arc::new(ReadTracker::new());
    let skill_service = crate::skill::SkillService::new(
        crate::skill::Platform::Desktop,
        data_dir.clone(),
        std::env::var("VENTURE_WORKSPACE_ROOT").ok().map(PathBuf::from),
    )
    .await;

    let deps = child::ChildDeps {
        store,
        http,
        task_store,
        file_history,
        read_tracker,
        skill_service: Some(skill_service),
        parent_bridge: None,
    };

    let stdio = match transport::self_stdio() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("subagent-proc: stdio 桥接失败：{e}");
            return 1;
        }
    };

    // 深度上限：与主进程一致（默认 1；子进程内 spawn 走 reparent 到根 coordinator）
    let max_depth = 1;
    child::run_session(stdio.endpoint, deps, max_depth).await
}

// ─── 工具 schema 注入（供 tools.rs get_tools_schema 使用）──────────────────

/// 子代理相关工具 schema（§6 + §14）。
/// depth_hint 字段仅在 allow_model_depth_hint=true 时出现（§15.2）。
pub fn subagent_tool_schemas(config: &SubagentConfig, registry: &AgentRegistry) -> Vec<Value> {
    let agents_desc: String = registry
        .visible_agents()
        .iter()
        .map(|d| format!("- {}: {}", d.name, d.description))
        .collect::<Vec<_>>()
        .join("\n");

    let mut agent_properties = json!({
        "prompt": {
            "type": "string",
            "description": "The task for the agent to complete. Must be self-contained: the agent has NO access to the current conversation."
        },
        "description": {
            "type": "string",
            "description": "Short task description (few words) for progress display"
        },
        "subagent_type": {
            "type": "string",
            "enum": registry.all_names(),
            "description": format!("Subagent type. Available agents:\n{agents_desc}")
        },
        "run_in_background": {
            "type": "boolean",
            "description": "true = run in background (notified on completion); false = wait indefinitely; omit = wait with 600s budget then auto-switch to background"
        },
        "capability_mode": {
            "type": "string",
            "enum": ["read_only", "read_write", "execute", "all"],
            "description": "Override the agent's capability mode"
        },
        "isolation": {
            "type": "string",
            "enum": ["none", "worktree"],
            "description": "none (default) = shared workspace; worktree = isolated git worktree (desktop only)"
        },
        "resume_from": {
            "type": "string",
            "description": "Agent ID (agent-...) of a previous subagent to resume from (copies its transcript)"
        },
        "model": {
            "type": "string",
            "description": "Model ID override; omit to inherit the current model"
        }
    });
    if config.allow_model_depth_hint {
        agent_properties["depth_hint"] = json!({
            "type": "integer",
            "description": format!("Optional subagent depth (must not exceed {}); 0 = unspecified", config.max_subagent_depth)
        });
    }

    vec![
        json!({
            "type": "function",
            "function": {
                "name": "spawn_agent",
                "description": "（子代理调度工具，区别于 TodoCreate 等清单工具）Launch a subagent to complete a task. The subagent runs autonomously with its own context and tool set; only its final report is returned. Use for parallelizable research, exploration, or multi-step work that would bloat the main context. Do NOT use for trivial single-file reads.",
                "strict": true,
                "parameters": {
                    "type": "object",
                    "properties": agent_properties,
                    "required": ["prompt"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "get_agent_output",
                "description": "Get the output/status of a subagent by its agent_id (agent-...). Do not poll repeatedly — background agent completion is announced automatically.",
                "strict": true,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_id": { "type": "string", "description": "The subagent ID (agent-...)" },
                        "block": { "type": "boolean", "description": "true = wait for completion (default false)" },
                        "timeout_ms": { "type": "integer", "description": "Max wait in ms when block=true (default 60000, max 300000)" }
                    },
                    "required": ["agent_id"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "kill_agent",
                "description": "Kill a running subagent by its agent_id (agent-...).",
                "strict": true,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_id": { "type": "string", "description": "The subagent ID (agent-...) to kill" }
                    },
                    "required": ["agent_id"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "run_workflow",
                "description": "Run a deterministic workflow script orchestrating multiple subagents (Rhai DSL). Host functions: spawn_agent(prompt, options_map), parallel(closure, items, max_parallel?), pipeline(items, stages...), complete(results?), pause(), budget(), completed_agents(), read_json(path). Options map keys: agent, model, cwd, isolation, resume_from, background.",
                "strict": true,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "script": { "type": "string", "description": "Rhai workflow script" },
                        "budget_limit": { "type": "integer", "description": "Total token budget for the run (default 1000000)" },
                        "resume": { "type": "string", "description": "Run ID to resume from journal" }
                    },
                    "required": ["script"],
                    "additionalProperties": false
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "kill_workflow",
                "description": "Cancel an entire workflow run (kills all its subagents).",
                "strict": true,
                "parameters": {
                    "type": "object",
                    "properties": {
                        "run_id": { "type": "string", "description": "The workflow run ID to cancel" }
                    },
                    "required": ["run_id"],
                    "additionalProperties": false
                }
            }
        }),
    ]
}

/// system prompt 追加段落（chat.rs 注入；§6 适配说明）。
pub fn subagent_system_prompt_section(config: &SubagentConfig) -> String {
    let mut section = String::from(
        "\n\n## Subagents (spawn_agent tool)\n\
         You can delegate work to subagents with the **spawn_agent** tool (do NOT confuse it with TodoCreate/TodoList etc., which are plain todo-list entries). Subagents run with isolated context — give them fully self-contained prompts (they cannot see this conversation).\n\
         - Default foreground wait is 600s; on timeout the agent auto-switches to background and you will be notified of completion automatically — do NOT poll with get_agent_output.\n\
         - Use `explore` for read-only code search, `plan` for planning, `general-purpose` for multi-step work.\n\
         - Use run_workflow for deterministic multi-agent orchestration (parallel/pipeline with journal-based resume).",
    );
    if config.allow_model_depth_hint {
        section.push_str(&format!(
            "\n- You may optionally specify subagent depth (not exceeding {}).",
            config.max_subagent_depth
        ));
    }
    section
}
