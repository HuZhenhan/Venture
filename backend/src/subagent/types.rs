//! 子代理系统核心数据类型（设计稿 §3）。

use std::collections::HashSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provider::UsageInfo;

// ─── SubagentId / SessionId ──────────────────────────────────────────────

pub type SubagentId = String;
pub type SessionId = String;
pub type WorkflowRunId = String;

/// 新子代理 ID：`agent-<uuid7>`。前缀 `agent-` 与清单（todo）的数字 ID 区分，
/// 避免模型混淆两种 ID（§3.2 注入规则）。
pub fn new_agent_id() -> SubagentId {
    format!("agent-{}", uuid7())
}

/// 新 workflow run ID：纯 UUIDv7（run 不属于子代理，不带 agent- 前缀）。
pub fn new_run_id() -> WorkflowRunId {
    uuid7()
}

/// 手工构造 UUIDv7（不引入 uuid crate v7 feature）。
fn uuid7() -> String {
    use rand::RngCore;
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut rand_bytes = [0u8; 10];
    rand::rngs::OsRng.fill_bytes(&mut rand_bytes);

    let mut b = [0u8; 16];
    // 48-bit big-endian 毫秒时间戳
    b[0] = (ms >> 40) as u8;
    b[1] = (ms >> 32) as u8;
    b[2] = (ms >> 24) as u8;
    b[3] = (ms >> 16) as u8;
    b[4] = (ms >> 8) as u8;
    b[5] = ms as u8;
    // version 7
    b[6] = 0x70 | (rand_bytes[0] & 0x0F);
    // variant
    b[7] = 0x80 | (rand_bytes[1] & 0x3F);
    b[8..16].copy_from_slice(&rand_bytes[2..10]);

    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}

// ─── AgentDefinition（§3.1）────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    #[default]
    Primary,
    Subagent,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityMode {
    /// 只读：read/glob/grep（websearch/webfetch 为保留接口）
    ReadOnly,
    /// + edit/write
    ReadWrite,
    /// + bash（保留接口）
    Execute,
    /// 全部（含调度类工具）
    #[default]
    All,
}

impl CapabilityMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().replace('-', "_").as_str() {
            "read_only" | "readonly" => Some(CapabilityMode::ReadOnly),
            "read_write" | "readwrite" => Some(CapabilityMode::ReadWrite),
            "execute" => Some(CapabilityMode::Execute),
            "all" => Some(CapabilityMode::All),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            CapabilityMode::ReadOnly => "read_only",
            CapabilityMode::ReadWrite => "read_write",
            CapabilityMode::Execute => "execute",
            CapabilityMode::All => "all",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PromptTemplate {
    #[default]
    GeneralPurpose,
    Explore,
    Plan,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Isolation {
    #[default]
    None,
    Worktree,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentDefinition {
    /// 唯一标识
    pub name: String,
    /// 供主模型理解用途
    pub description: String,
    /// 类型专属 system prompt（模板）
    #[serde(default)]
    pub prompt: Option<String>,
    /// GENERAL_PURPOSE / EXPLORE / PLAN / 自定义
    #[serde(default = "default_prompt_template")]
    pub prompt_template: PromptTemplate,
    /// Primary | Subagent | All
    #[serde(default = "default_agent_mode")]
    pub mode: AgentMode,
    /// 允许工具白名单（None = 继承父集）
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// 强制禁用的工具（优先级高于 tools 白名单）
    #[serde(default)]
    pub disallowed_tools: Vec<String>,
    /// None = 继承父模型（inherit 语义）
    #[serde(default)]
    pub model: Option<String>,
    /// ReadOnly | ReadWrite | Execute | All
    #[serde(default)]
    pub capability_mode: Option<CapabilityMode>,
    /// 三态规则（allow/ask/deny），优先级最高
    #[serde(default)]
    pub permission: Option<Ruleset>,
    /// 强制前后台
    #[serde(default)]
    pub background: Option<bool>,
    #[serde(default)]
    pub isolation: Option<Isolation>,
    /// true = 不加载 AGENTS.md（省 token）
    #[serde(default)]
    pub omit_claude_md: bool,
    /// 子代理最大轮次（防失控）
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// low/high/max
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    /// 追加 MCP server（快照绑定；当前项目无 MCP，保留字段）
    #[serde(default)]
    pub mcp_servers: Option<Vec<String>>,
    /// 子代理钩子（保留字段）
    #[serde(default)]
    pub hooks: Option<Vec<Hook>>,
    /// 预载 skill
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    /// 不向主模型暴露（内部 agent）
    #[serde(default)]
    pub hidden: bool,
}

fn default_prompt_template() -> PromptTemplate {
    PromptTemplate::GeneralPurpose
}

fn default_agent_mode() -> AgentMode {
    AgentMode::Subagent
}

impl AgentDefinition {
    pub fn builtin_general_purpose() -> Self {
        AgentDefinition {
            name: "general-purpose".into(),
            description: "通用子代理：拥有完整工具集（读写编辑与调度），可执行多步骤研究、编码与文件修改任务。".into(),
            prompt: None,
            prompt_template: PromptTemplate::GeneralPurpose,
            mode: AgentMode::Subagent,
            tools: None,
            disallowed_tools: vec![],
            model: None,
            capability_mode: Some(CapabilityMode::All),
            // 显式声明 spawn_agent 允许（§11.2 默认规则“除非定义中显式声明了允许”），
            // 使嵌套 spawn 走 §15.1 的 reparent 策略可用
            permission: Some(Ruleset::new(vec![Rule {
                pattern: "spawn_agent".into(),
                effect: PermissionEffect::Allow,
            }])),
            background: None,
            isolation: None,
            omit_claude_md: false,
            max_turns: Some(40),
            effort: None,
            temperature: None,
            mcp_servers: None,
            hooks: None,
            skills: None,
            hidden: false,
        }
    }

    pub fn builtin_explore() -> Self {
        AgentDefinition {
            name: "explore".into(),
            description: "只读探索子代理：用于代码检索、定位与摘要，不能修改任何文件。适合大规模搜索与上下文收集。".into(),
            prompt: None,
            prompt_template: PromptTemplate::Explore,
            mode: AgentMode::Subagent,
            tools: None,
            disallowed_tools: vec![],
            model: None,
            capability_mode: Some(CapabilityMode::ReadOnly),
            permission: None,
            background: None,
            isolation: None,
            omit_claude_md: true,
            max_turns: Some(25),
            effort: Some("low".into()),
            temperature: None,
            mcp_servers: None,
            hooks: None,
            skills: None,
            hidden: false,
        }
    }

    pub fn builtin_plan() -> Self {
        AgentDefinition {
            name: "plan".into(),
            description: "只读规划子代理：分析代码库并产出结构化执行计划，供主代理执行。不能修改任何文件。".into(),
            prompt: None,
            prompt_template: PromptTemplate::Plan,
            mode: AgentMode::Subagent,
            tools: None,
            disallowed_tools: vec![],
            model: None,
            capability_mode: Some(CapabilityMode::ReadOnly),
            permission: None,
            background: None,
            isolation: None,
            omit_claude_md: false,
            max_turns: Some(25),
            effort: None,
            temperature: None,
            mcp_servers: None,
            hooks: None,
            skills: None,
            hidden: false,
        }
    }
}

// ─── 权限（§11.2）──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionEffect {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rule {
    /// 工具名 glob 模式（如 "spawn_agent" / "write" / "*"）
    pub pattern: String,
    pub effect: PermissionEffect,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Ruleset {
    #[serde(default)]
    pub rules: Vec<Rule>,
}

impl Ruleset {
    pub fn new(rules: Vec<Rule>) -> Self {
        Self { rules }
    }

    /// 追加规则；同 pattern 的后加入项覆盖先加入项（§11.2 组装顺序语义）。
    pub fn append(&mut self, rule: Rule) {
        self.rules.retain(|r| r.pattern != rule.pattern);
        self.rules.push(rule);
    }

    /// 判定：遍历全部规则，取「最后一个匹配该工具的规则」的效果；无匹配 → Ask。
    pub fn decide(&self, tool: &str) -> PermissionEffect {
        let lower = tool.to_lowercase();
        let mut decision = PermissionEffect::Ask;
        for rule in &self.rules {
            if glob_match(&rule.pattern.to_lowercase(), &lower) {
                decision = rule.effect.clone();
            }
        }
        decision
    }
}

/// 简易 glob 匹配（支持 * 与精确名；大小写不敏感在调用侧处理）。
pub fn glob_match(pattern: &str, text: &str) -> bool {
    // 仅支持 * 通配的朴素匹配
    fn inner(p: &[char], t: &[char]) -> bool {
        if p.is_empty() {
            return t.is_empty();
        }
        if p[0] == '*' {
            // 匹配任意长度（含空）
            for i in 0..=t.len() {
                if inner(&p[1..], &t[i..]) {
                    return true;
                }
            }
            return false;
        }
        if t.is_empty() {
            return false;
        }
        if p[0] == '?' || p[0] == t[0] {
            inner(&p[1..], &t[1..])
        } else {
            false
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    inner(&p, &t)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hook {
    pub event: String,
    pub command: String,
}

// ─── TaskToolInput（§3.2）──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TaskToolInput {
    pub prompt: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_subagent_type")]
    pub subagent_type: String,
    /// None = 前台预算降级；Some(true) 后台；Some(false) 前台等到底
    #[serde(default)]
    pub run_in_background: Option<bool>,
    #[serde(default)]
    pub capability_mode: Option<CapabilityMode>,
    #[serde(default)]
    pub isolation: Option<Isolation>,
    /// 复制源 transcript 续跑
    #[serde(default)]
    pub resume_from: Option<SubagentId>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub model: Option<String>,
    /// 仅 allow_model_depth_hint=true 时暴露
    #[serde(default)]
    pub depth_hint: Option<u32>,
    // 以下字段服务端注入，模型不可见：
    #[serde(default)]
    pub task_id: Option<SubagentId>,
    #[serde(default)]
    pub parent_session: Option<SessionId>,
    #[serde(default)]
    pub owner: Option<SubagentOwner>,
    /// 内部注入：继承的模型（来自当前会话，模型不可见）
    #[serde(default)]
    pub inherited_model: Option<String>,
}

fn default_subagent_type() -> String {
    "general-purpose".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SubagentOwner {
    #[default]
    Task,
    Workflow,
}

// ─── 状态机（§3.3）─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SubagentState {
    Pending,
    Running {
        started_at_ms: u64,
        deadline_ms: Option<u64>,
    },
    Completed {
        output: SubagentCompletedOutput,
    },
    Failed {
        error: SubagentError,
    },
    Cancelled {
        reason: CancelReason,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    UserKill,
    WorkflowCancelled,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentCompletedOutput {
    pub task_id: SubagentId,
    /// 提取后的文本结果
    pub output: String,
    pub tool_calls: u32,
    pub turns: u32,
    pub duration_ms: u64,
    /// 有改动则保留
    #[serde(default)]
    pub worktree_path: Option<PathBuf>,
    /// 推荐续跑入口
    #[serde(default)]
    pub resume_from_hint: Option<SubagentId>,
    pub usage: UsageInfo,
    /// max_turns 用尽仍未完成时为 true
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    SpawnFailed,
    Timeout,
    Killed,
    Protocol,
    ContextTooLarge,
    DepthExceeded,
    UnknownAgentType,
    NotSubagent,
    BudgetExhausted,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentError {
    pub kind: ErrorKind,
    pub message: String,
    pub retryable: bool,
}

impl SubagentError {
    pub fn new(kind: ErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            kind,
            message: message.into(),
            retryable,
        }
    }
}

// ─── 调度请求（§3.4）───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SubagentRequest {
    pub task_id: SubagentId,
    pub parent_session: SessionId,
    /// 已由调用链计算好
    pub depth: u32,
    pub agent_definition: AgentDefinition,
    pub prompt: String,
    pub description: String,
    pub cwd: PathBuf,
    pub model: Option<String>,
    pub capability_mode: CapabilityMode,
    pub isolation: Isolation,
    pub resume_from: Option<SubagentId>,
    /// fork_context 摘要前缀（仅内部 spawner；§9.3）
    pub fork_context: Option<String>,
    pub owner: SubagentOwner,
    /// owner == Workflow 时必有
    pub run_id: Option<WorkflowRunId>,
    /// 父会话工具快照（含 MCP；本项目 = get_tools_schema 快照）
    pub tools_snapshot: Vec<ToolSpec>,
    /// MCP 快照（当前项目无 MCP，恒空对象）
    pub mcp_snapshot: Value,
    pub permission: Ruleset,
    pub hooks_snapshot: Vec<Hook>,
    // Venture 适配（§18.2）：
    pub chat_id: String,
    pub turn_message_id: Option<String>,
    pub max_turns: u32,
    /// 数据目录（子代理 transcript 落盘根）
    pub data_dir: PathBuf,
}

/// ACP 工具快照元素（§4 快照注入）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub kind: ToolKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    ReadOnly,
    Write,
    Execute,
    Scheduler,
    General,
}

impl ToolKind {
    /// 工具名 → 分类（与 capability_mode 过滤矩阵对应，§11.1）。
    pub fn of(name: &str) -> ToolKind {
        match name.to_lowercase().as_str() {
            "read" | "glob" | "grep" | "websearch" | "webfetch" => ToolKind::ReadOnly,
            "write" | "edit" => ToolKind::Write,
            "bash" => ToolKind::Execute,
            "spawn_agent" | "get_agent_output" | "kill_agent" | "run_workflow" | "kill_workflow" => {
                ToolKind::Scheduler
            }
            _ => ToolKind::General,
        }
    }

    pub fn fits(self, mode: CapabilityMode) -> bool {
        match mode {
            CapabilityMode::ReadOnly => matches!(self, ToolKind::ReadOnly),
            CapabilityMode::ReadWrite => {
                matches!(self, ToolKind::ReadOnly | ToolKind::Write)
            }
            CapabilityMode::Execute => matches!(
                self,
                ToolKind::ReadOnly | ToolKind::Write | ToolKind::Execute
            ),
            CapabilityMode::All => true,
        }
    }
}

/// 是否调度类工具（Workflow 子代理剥除，§11.1）。
pub fn is_scheduler_tool(name: &str) -> bool {
    matches!(ToolKind::of(name), ToolKind::Scheduler)
}

// ─── 配置（§15）────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentConfig {
    pub max_subagent_depth: u32,
    pub allow_model_depth_hint: bool,
    /// 每 chat 并发上限（§7.2）
    pub subagents_max_concurrent: usize,
    /// 准入队列上限
    pub subagents_queue_limit: usize,
    /// 前台等待预算 ms（§6，环境变量 SUBAGENT_AWAIT_BUDGET_MS 可改）
    pub await_budget_ms: u64,
    /// 权限请求超时 ms（§11.2 默认 30s）
    pub permission_timeout_ms: u64,
    /// 深度超限策略：deny | reparent（§15.1）
    pub depth_policy: String,
    /// worktree 过期回收天数（§12）
    pub worktree_max_age_days: u64,
}

impl Default for SubagentConfig {
    fn default() -> Self {
        Self {
            max_subagent_depth: 1,
            allow_model_depth_hint: false,
            subagents_max_concurrent: 8,
            subagents_queue_limit: 100,
            await_budget_ms: std::env::var("SUBAGENT_AWAIT_BUDGET_MS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(600_000),
            permission_timeout_ms: 30_000,
            depth_policy: "deny".into(),
            worktree_max_age_days: 30,
        }
    }
}

/// 允许的子代理类型白名单（None = 全允许，§5 is_allowed）
pub type AllowedTypes = Option<HashSet<String>>;
