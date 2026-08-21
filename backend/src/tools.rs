//! 工具调用执行器。
//!
//! 实现 OpenAI 标准 Tool Call 协议的工具执行端：
//! - 模型通过 `tool_calls` delta 结构化发起工具调用；
//! - 前端解析累积后回调本模块的 `/api/tools/execute` 接口执行；
//! - 执行结果以 `role: "tool"` 消息回传给模型。
//!
//! 支持的工具分两类：
//! - 文件系统工具：`Write` / `Edit` / `Read` / `Glob` / `Grep`
//! - 清单工具：`TodoCreate` / `TodoUpdate` / `TodoList` / `TodoGet`（与子代理 spawn_agent 工具区分）
//!
//! 安全设计：
//! - 路径解析时阻止穿越到工作区根之外（若配置了 workspace_root）；
//! - 输出结果统一做长度截断，避免超大文件撑爆上下文。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::RwLock;
use walkdir::WalkDir;

use crate::error::AppError;
use crate::skill::SkillService;
use crate::file_history::{
    self, ChangeKind, ChangeRecord, ChangeSource, FileHistory, FileMeta, MessageId, RecordId,
    TurnId, VersionId, bytes_to_hex, now_millis,
};
use crate::file_history::rollback::with_file_lock;
use crate::task_store::{CreateTaskRequest, TaskStore, TaskStatus, UpdateTaskRequest};

/// 单次结果中文件内容/搜索命中的字符上限，超出截断。
const MAX_OUTPUT_CHARS: usize = 20_000;
/// Glob/Grep 返回的路径条目上限。
const MAX_RESULT_ENTRIES: usize = 200;
/// Grep 单文件读取的最大字节数，避免读入超大文件。
const MAX_GREP_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// 跟踪每个 chat 会话中已通过 Read 工具读取过的文件路径（规范化后的绝对路径）。
/// 用于 Edit 工具的"读后编辑"强制校验。
pub struct ReadTracker {
    inner: RwLock<HashMap<String, HashSet<String>>>,
}

impl ReadTracker {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(HashMap::new()),
        }
    }

    /// 记录某个文件已被当前会话的 Read 工具读取。
    pub async fn mark_read(&self, chat_id: &str, canonical_path: String) {
        let mut map = self.inner.write().await;
        map.entry(chat_id.to_string())
            .or_default()
            .insert(canonical_path);
    }

    /// 检查某个文件是否已在当前会话被 Read 过。
    pub async fn has_been_read(&self, chat_id: &str, canonical_path: &str) -> bool {
        let map = self.inner.read().await;
        map.get(chat_id)
            .map(|set| set.contains(canonical_path))
            .unwrap_or(false)
    }
}

/// 工具执行结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutput {
    /// 人类可读的结果文本，将作为 `[tool]` 的 `[output]` 回填给模型。
    pub output: String,
    /// 是否为错误结果。
    pub is_error: bool,
    /// 可选的结构化数据（如任务对象），用于前端直接渲染。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured: Option<Value>,
}

impl ToolOutput {
    fn ok(output: String) -> Self {
        Self {
            output,
            is_error: false,
            structured: None,
        }
    }

    fn ok_with(output: String, structured: Value) -> Self {
        Self {
            output,
            is_error: false,
            structured: Some(structured),
        }
    }

    fn err(message: String) -> Self {
        Self {
            output: message,
            is_error: true,
            structured: None,
        }
    }
}

fn truncate(s: String) -> String {
    if s.chars().count() <= MAX_OUTPUT_CHARS {
        return s;
    }
    let cut: String = s.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{cut}\n...(truncated, exceeded {MAX_OUTPUT_CHARS} chars)")
}

/// 规范化路径：相对路径基于 `workspace_root` 解析；返回绝对路径。
/// 当配置了 workspace_root 时，拒绝解析到其之外的路径以避免越权访问。
fn resolve_path(
    raw: &str,
    workspace_root: Option<&Path>,
) -> Result<PathBuf, AppError> {
    let p = Path::new(raw);
    let resolved = if p.is_absolute() {
        p.to_path_buf()
    } else {
        match workspace_root {
            Some(root) => root.join(p),
            None => PathBuf::from(raw),
        }
    };

    if let Some(root) = workspace_root {
        let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let canonical_target = resolved.canonicalize().unwrap_or_else(|_| resolved.clone());
        if !canonical_target.starts_with(&canonical_root) {
            return Err(AppError::ToolExecutionError(format!(
                "路径越权：{} 不在工作区根 {} 之内",
                resolved.display(),
                canonical_root.display()
            )));
        }
    }
    Ok(resolved)
}

/// Android skill 资源 URI（§14 变体 C）：`content://skillx/<name>/<相对路径>`
/// → `<skillx_dir>/skills/<name>/<相对路径>`（skill 内容渲染时展示给模型的形式，
/// 模型据此用 read 工具读取 skill 资源文件）。非该前缀的路径原样返回。
fn resolve_skill_content_uri(raw: &str, skill_service: Option<&SkillService>) -> String {
    if let Some(rest) = raw.strip_prefix("content://skillx/") {
        if let Some(svc) = skill_service {
            let mut parts = rest.splitn(2, '/');
            let name = parts.next().unwrap_or("");
            let rel = parts.next().unwrap_or("");
            return svc
                .skillx_dir()
                .join("skills")
                .join(name)
                .join(rel)
                .to_string_lossy()
                .into_owned();
        }
    }
    raw.to_string()
}

/// 工具入口。根据工具名分发到对应实现。
///
/// - `tool`: 工具名（大小写敏感，需与协议定义一致）
/// - `input`: 模型生成的 JSON 参数
/// - `chat_id`: 当前会话 ID，用于任务工具隔离
/// - `task_store`: 任务存储
/// - `workspace_root`: 工作区根路径（可选），用于相对路径解析与越权校验
/// - `file_history`: 文件回退系统（可选），用于 Write/Edit 的备份与回退
/// - `turn_message_id`: 当前轮次的消息 ID（可选），提供时触发备份流程
pub async fn execute_tool(
    tool: &str,
    input: &Value,
    chat_id: &str,
    task_store: &TaskStore,
    workspace_root: Option<&Path>,
    read_tracker: &ReadTracker,
    file_history: Option<&FileHistory>,
    turn_message_id: Option<&str>,
    skill_service: Option<&SkillService>,
) -> Result<ToolOutput, AppError> {
    // 记录被访问路径（§11.2：paths 条件激活的输入之一）
    if let Some(svc) = skill_service {
        if matches!(tool, "Read" | "Write" | "Edit") {
            if let Some(p) = input.get("file_path").and_then(Value::as_str) {
                let p = resolve_skill_content_uri(p, Some(svc));
                let resolved = resolve_path(&p, workspace_root)
                    .map(|r| r.to_string_lossy().into_owned())
                    .unwrap_or_else(|_| p.to_string());
                svc.record_access(&resolved).await;
            }
        }
    }
    match tool {
        "Write" => execute_write(input, workspace_root, file_history, turn_message_id).await,
        "Edit" => execute_edit(input, workspace_root, chat_id, read_tracker, file_history, turn_message_id).await,
        "Read" => execute_read(input, workspace_root, chat_id, read_tracker, skill_service).await,
        "Glob" => execute_glob(input, workspace_root).await,
        "Grep" => execute_grep(input, workspace_root).await,
        "AskUserQuestion" => execute_ask_user_question(input).await,
        "TodoCreate" => execute_todo_create(input, chat_id, task_store).await,
        "TodoUpdate" => execute_todo_update(input, chat_id, task_store).await,
        "TodoList" => execute_todo_list(input, chat_id, task_store).await,
        "TodoGet" => execute_todo_get(input, chat_id, task_store).await,
        "list_skill" => execute_list_skill(input, skill_service).await,
        "load_skill" => execute_load_skill(input, skill_service).await,
        other => Err(AppError::ToolExecutionError(format!(
            "未知工具：{other}"
        ))),
    }
}

// ─── Skill 工具（规格书 §8）──────────────────────────────────────────────

/// list_skill：模型自主发现技能（§8.1）。
async fn execute_list_skill(
    input: &Value,
    skill_service: Option<&SkillService>,
) -> Result<ToolOutput, AppError> {
    let Some(svc) = skill_service else {
        return Ok(ToolOutput::err("skill 服务不可用".into()));
    };
    let filter = input.get("filter").and_then(Value::as_str);
    let r = svc.tool_list_skill(filter).await;
    Ok(ToolOutput {
        output: r.output,
        is_error: r.is_error,
        structured: Some(r.structured),
    })
}

/// load_skill：加载技能完整指令（§8.2 状态机）。
async fn execute_load_skill(
    input: &Value,
    skill_service: Option<&SkillService>,
) -> Result<ToolOutput, AppError> {
    let Some(svc) = skill_service else {
        return Ok(ToolOutput::err("skill 服务不可用".into()));
    };
    let name = input
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("name 参数缺失".into()))?;
    let user_decision = input.get("userDecision").and_then(Value::as_str);
    let r = svc.tool_load_skill(name, user_decision).await;
    Ok(ToolOutput {
        output: r.output,
        is_error: r.is_error,
        structured: Some(r.structured),
    })
}

// ─── 文件系统工具 ─────────────────────────────────────────────────────────

/// Write：写入/创建文件。自动创建父目录。
///
/// 集成文件回退系统：
/// - 写入前：读取原文件内容（若存在）创建 pre 版本备份
/// - 写入后：读取新内容创建 post 版本，append ChangeRecord 到 Journal
/// - 若 turn_message_id 为 None → 跳过备份（向后兼容）
async fn execute_write(
    input: &Value,
    workspace_root: Option<&Path>,
    file_history: Option<&FileHistory>,
    turn_message_id: Option<&str>,
) -> Result<ToolOutput, AppError> {
    let file_path = input
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("file_path 参数缺失".into()))?;
    let content = input
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("content 参数缺失".into()))?;

    let resolved = resolve_path(file_path, workspace_root)?;

    // 若提供了 file_history 和 turn_message_id，执行备份流程
    if let (Some(history), Some(turn_msg_id)) = (file_history, turn_message_id) {
        return with_file_lock(&resolved, || async {
            execute_write_with_backup(&resolved, content, history, turn_msg_id).await
        }).await;
    }

    // 无备份模式：直接写入
    if let Some(parent) = resolved.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::ToolExecutionError(format!("创建目录失败：{e}")))?;
        }
    }

    let bytes = content.len();
    tokio::fs::write(&resolved, content)
        .await
        .map_err(|e| AppError::ToolExecutionError(format!("写入文件失败：{e}")))?;

    Ok(ToolOutput::ok(format!(
        "已写入 {bytes} 字节到 {}",
        resolved.display()
    )))
}

/// 带备份的 Write 执行流程。
async fn execute_write_with_backup(
    resolved: &Path,
    content: &str,
    history: &FileHistory,
    turn_message_id: &str,
) -> Result<ToolOutput, AppError> {
    let content_bytes = content.as_bytes();

    // 1. 读取原文件内容（若存在）
    let (pre_content, file_existed, pre_meta) = match tokio::fs::read(resolved).await {
        Ok(data) => {
            let meta = FileMeta::from_path(resolved).unwrap_or_else(|_| FileMeta::tombstone());
            (Some(data), true, meta)
        }
        Err(_) => (None, false, FileMeta::tombstone()),
    };

    // 2. 创建 pre 版本
    let pre_version = if file_existed {
        let pre_data = pre_content.as_ref().unwrap();
        history.version_store.create_version(pre_data, pre_meta.clone()).await?
    } else {
        history.version_store.create_tombstone().await?
    };

    let pre_hash = bytes_to_hex(&*blake3::hash(&pre_content.as_deref().unwrap_or(&[])).as_bytes());
    let post_hash = bytes_to_hex(&*blake3::hash(content_bytes).as_bytes());

    // 3. 写入 WAL intent
    let record_id = RecordId::new();
    let turn_id = TurnId(turn_message_id.to_string());
    let message_id = MessageId(turn_message_id.to_string());
    let kind = if file_existed { ChangeKind::Modify } else { ChangeKind::Create };

    let wal_intent = file_history::WalIntent {
        record_id: record_id.clone(),
        turn_id: turn_id.clone(),
        message_id: message_id.clone(),
        path: resolved.to_path_buf(),
        kind: kind.clone(),
        source: ChangeSource::Agent,
        pre_hash: pre_hash.clone(),
        post_hash: post_hash.clone(),
        pre_version_id: pre_version.id.clone(),
        post_version_id: None,
        timestamp: now_millis(),
        conflicted: false,
    };
    history.journal.write_wal_intent(&wal_intent).await?;

    // 4. 执行实际文件写入
    if let Some(parent) = resolved.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| AppError::ToolExecutionError(format!("创建目录失败：{e}")))?;
        }
    }
    tokio::fs::write(resolved, content)
        .await
        .map_err(|e| AppError::ToolExecutionError(format!("写入文件失败：{e}")))?;

    // 5. 创建 post 版本（Phase 2: 自适应存储决策 + 锚点检查）
    let post_meta = FileMeta::from_path(resolved).unwrap_or_else(|_| FileMeta::tombstone());
    let config = history.config().await;
    let mode = config.resolve_mode(resolved);
    let ctx = history.write_tracker.get_context(resolved).await;
    let pre_data = pre_content.as_deref().unwrap_or(&[]);

    let post_version = history.version_store.create_version_with_anchor_check(
        &resolved.to_string_lossy(),
        &pre_version.id,
        pre_data,
        content_bytes,
        post_meta,
        &ctx,
        mode,
        &config.thresholds,
        config.anchors.max_hunk_chain_length,
    ).await?;

    // 记录写入（供 auto_decide 决策树使用）
    history.write_tracker.record_write(resolved).await;

    // 6. 若 pre 与 post 内容相同 → 跳过，不产生 ChangeRecord
    if pre_hash == post_hash {
        history.journal.delete_wal_intent(&record_id).await?;
        return Ok(ToolOutput::ok(format!(
            "文件内容未变化：{}",
            resolved.display()
        )));
    }

    // 7. append ChangeRecord
    let record = ChangeRecord {
        id: record_id.clone(),
        turn_id: turn_id.clone(),
        message_id: message_id.clone(),
        path_before: if file_existed { Some(resolved.to_path_buf()) } else { None },
        path_after: Some(resolved.to_path_buf()),
        kind: kind.clone(),
        source: ChangeSource::Agent,
        timestamp: now_millis(),
        pre: pre_version.id,
        post: post_version.id,
    };
    history.journal.append(record).await?;

    // 8. 删除 WAL intent
    history.journal.delete_wal_intent(&record_id).await?;

    let bytes = content_bytes.len();
    Ok(ToolOutput::ok(format!(
        "已写入 {bytes} 字节到 {}（已备份，可回退）",
        resolved.display()
    )))
}

/// Edit：精确替换文件中的文本。要求 old_string 在文件中唯一，除非 replace_all=true。
///
/// 强制校验：必须先通过 Read 工具读取过文件内容，否则拒绝编辑。
/// 这样确保模型手中持有最新文件内容，old_string 能准确匹配。
///
/// 集成文件回退系统：备份原内容 → 执行替换 → 记录 ChangeRecord
async fn execute_edit(
    input: &Value,
    workspace_root: Option<&Path>,
    chat_id: &str,
    read_tracker: &ReadTracker,
    file_history: Option<&FileHistory>,
    turn_message_id: Option<&str>,
) -> Result<ToolOutput, AppError> {
    let file_path = input
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("file_path 参数缺失".into()))?;
    let old_string = input
        .get("old_string")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("old_string 参数缺失".into()))?;
    let new_string = input
        .get("new_string")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("new_string 参数缺失".into()))?;
    let replace_all = input
        .get("replace_all")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if old_string.is_empty() {
        return Ok(ToolOutput::err("old_string 不能为空".into()));
    }
    if old_string == new_string {
        return Ok(ToolOutput::err("old_string 与 new_string 不能相同".into()));
    }

    let resolved = resolve_path(file_path, workspace_root)?;

    // 强制校验：必须先 Read 此文件，再 Edit。使用规范化路径做键避免路径写法差异。
    let canonical = resolved
        .canonicalize()
        .unwrap_or_else(|_| resolved.clone());
    if !read_tracker.has_been_read(chat_id, &canonical.to_string_lossy()).await {
        return Ok(ToolOutput::err(format!(
            "必须先 Read 此文件再 Edit。请先使用 Read 工具读取 {} 的当前内容，确保 old_string 准确匹配。",
            resolved.display()
        )));
    }

    // 若提供了 file_history 和 turn_message_id，执行备份流程
    if let (Some(history), Some(turn_msg_id)) = (file_history, turn_message_id) {
        return with_file_lock(&resolved, || async {
            execute_edit_with_backup(
                &resolved,
                old_string,
                new_string,
                replace_all,
                history,
                turn_msg_id,
            )
            .await
        })
        .await;
    }

    // 无备份模式：直接编辑
    let original = tokio::fs::read_to_string(&resolved)
        .await
        .map_err(|e| AppError::ToolExecutionError(format!("读取文件失败：{e}")))?;

    let count = original.matches(old_string).count();
    if count == 0 {
        return Ok(ToolOutput::err(format!(
            "未在 {} 中找到匹配文本",
            resolved.display()
        )));
    }
    if count > 1 && !replace_all {
        return Ok(ToolOutput::err(format!(
            "在 {} 中匹配到 {count} 处，但 replace_all=false。请提供更长上下文以唯一定位，或设置 replace_all=true",
            resolved.display()
        )));
    }

    let updated = if replace_all {
        original.replace(old_string, new_string)
    } else {
        original.replacen(old_string, new_string, 1)
    };

    tokio::fs::write(&resolved, &updated)
        .await
        .map_err(|e| AppError::ToolExecutionError(format!("写回文件失败：{e}")))?;

    Ok(ToolOutput::ok(format!(
        "已编辑 {}：替换 {count} 处",
        resolved.display()
    )))
}

/// 带备份的 Edit 执行流程。
async fn execute_edit_with_backup(
    resolved: &Path,
    old_string: &str,
    new_string: &str,
    replace_all: bool,
    history: &FileHistory,
    turn_message_id: &str,
) -> Result<ToolOutput, AppError> {
    // 1. 读取原文件内容
    let original = tokio::fs::read_to_string(resolved)
        .await
        .map_err(|e| AppError::ToolExecutionError(format!("读取文件失败：{e}")))?;

    // 2. 匹配校验
    let count = original.matches(old_string).count();
    if count == 0 {
        return Ok(ToolOutput::err(format!(
            "未在 {} 中找到匹配文本",
            resolved.display()
        )));
    }
    if count > 1 && !replace_all {
        return Ok(ToolOutput::err(format!(
            "在 {} 中匹配到 {count} 处，但 replace_all=false。请提供更长上下文以唯一定位，或设置 replace_all=true",
            resolved.display()
        )));
    }

    let updated = if replace_all {
        original.replace(old_string, new_string)
    } else {
        original.replacen(old_string, new_string, 1)
    };

    let original_bytes = original.as_bytes();
    let updated_bytes = updated.as_bytes();

    // 3. 创建 pre 版本
    let pre_meta = FileMeta::from_path(resolved).unwrap_or_else(|_| FileMeta::tombstone());
    let pre_version = history.version_store.create_version(original_bytes, pre_meta.clone()).await?;

    let pre_hash = bytes_to_hex(&*blake3::hash(original_bytes).as_bytes());
    let post_hash = bytes_to_hex(&*blake3::hash(updated_bytes).as_bytes());

    // 4. 写入 WAL intent
    let record_id = RecordId::new();
    let turn_id = TurnId(turn_message_id.to_string());
    let message_id = MessageId(turn_message_id.to_string());

    let wal_intent = file_history::WalIntent {
        record_id: record_id.clone(),
        turn_id: turn_id.clone(),
        message_id: message_id.clone(),
        path: resolved.to_path_buf(),
        kind: ChangeKind::Modify,
        source: ChangeSource::Agent,
        pre_hash: pre_hash.clone(),
        post_hash: post_hash.clone(),
        pre_version_id: pre_version.id.clone(),
        post_version_id: None,
        timestamp: now_millis(),
        conflicted: false,
    };
    history.journal.write_wal_intent(&wal_intent).await?;

    // 5. 执行实际文件写入
    tokio::fs::write(resolved, &updated)
        .await
        .map_err(|e| AppError::ToolExecutionError(format!("写回文件失败：{e}")))?;

    // 6. 创建 post 版本（Phase 2: 自适应存储决策 + 锚点检查）
    let post_meta = FileMeta::from_path(resolved).unwrap_or_else(|_| FileMeta::tombstone());
    let config = history.config().await;
    let mode = config.resolve_mode(resolved);
    let ctx = history.write_tracker.get_context(resolved).await;

    let post_version = history.version_store.create_version_with_anchor_check(
        &resolved.to_string_lossy(),
        &pre_version.id,
        original_bytes,
        updated_bytes,
        post_meta,
        &ctx,
        mode,
        &config.thresholds,
        config.anchors.max_hunk_chain_length,
    ).await?;

    // 记录写入（供 auto_decide 决策树使用）
    history.write_tracker.record_write(resolved).await;

    // 7. 若内容未变化 → 跳过
    if pre_hash == post_hash {
        history.journal.delete_wal_intent(&record_id).await?;
        return Ok(ToolOutput::ok(format!("文件内容未变化：{}", resolved.display())));
    }

    // 8. append ChangeRecord
    let record = ChangeRecord {
        id: record_id.clone(),
        turn_id: turn_id.clone(),
        message_id: message_id.clone(),
        path_before: Some(resolved.to_path_buf()),
        path_after: Some(resolved.to_path_buf()),
        kind: ChangeKind::Modify,
        source: ChangeSource::Agent,
        timestamp: now_millis(),
        pre: pre_version.id,
        post: post_version.id,
    };
    history.journal.append(record).await?;

    // 9. 删除 WAL intent
    history.journal.delete_wal_intent(&record_id).await?;

    Ok(ToolOutput::ok(format!(
        "已编辑 {}：替换 {count} 处（已备份，可回退）",
        resolved.display()
    )))
}

/// Read：读取文件内容并带行号返回。支持 offset/limit 分段读取大文件。
///
/// 对齐 cc-haha / Claude Code 的 Read 工具语义：
/// - offset：起始行号（1-based），缺省从头开始；
/// - limit：最多返回的行数，缺省读全部（受 MAX_OUTPUT_CHARS 截断保护）；
/// - 输出格式 `  N\t<内容>`，行号右对齐到最大行号宽度；
/// - 二进制文件（含 NUL 字节）返回提示而非乱码。
async fn execute_read(
    input: &Value,
    workspace_root: Option<&Path>,
    chat_id: &str,
    read_tracker: &ReadTracker,
    skill_service: Option<&SkillService>,
) -> Result<ToolOutput, AppError> {
    let file_path = input
        .get("file_path")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("file_path 参数缺失".into()))?;
    // offset 1-based；缺省 1（从头）。非法值（<1）回退为 1。
    let offset = input
        .get("offset")
        .and_then(Value::as_u64)
        .map(|v| v.max(1) as usize)
        .unwrap_or(1);
    // limit：最多读取的行数。缺省无限制（由 MAX_OUTPUT_CHARS 兜底截断）。
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| v as usize);

    // Android skill 资源 URI（content://skillx/...）→ 真实文件路径
    let file_path = resolve_skill_content_uri(file_path, skill_service);
    let resolved = resolve_path(&file_path, workspace_root)?;

    let bytes = tokio::fs::read(&resolved)
        .await
        .map_err(|e| AppError::ToolExecutionError(format!("读取文件失败：{e}")))?;

    // 记录读取痕迹：使用规范化路径作为键，确保 Edit 校验不受路径写法差异影响
    let canonical = resolved
        .canonicalize()
        .unwrap_or_else(|_| resolved.clone());
    read_tracker
        .mark_read(chat_id, canonical.to_string_lossy().into_owned())
        .await;

    // 二进制检测：含 NUL 字节视为二进制，避免输出乱码
    if bytes.contains(&0u8) {
        return Ok(ToolOutput::err(format!(
            "{} 是二进制文件，无法以文本形式读取",
            resolved.display()
        )));
    }

    // 转 String：UTF-8 失败则用 lossy 兜底（极少见，但保证不崩）
    let content = String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    let lines: Vec<&str> = content.split('\n').collect();
    let total_lines = lines.len();

    // 计算实际返回范围（1-based 闭区间）
    let start = offset.min(total_lines.max(1));
    let end = match limit {
        Some(l) => (start.saturating_add(l).saturating_sub(1)).min(total_lines),
        None => total_lines,
    };

    // 行号右对齐宽度
    let max_line_no = end;
    let width = max_line_no.to_string().len().max(1);

    let mut out = String::new();
    for idx in start..=end {
        // split('\n') 已按行切分；去掉每行末尾的 '\r'（CRLF 兼容）
        let mut line = lines[idx - 1];
        if line.ends_with('\r') {
            line = &line[..line.len() - 1];
        }
        // 格式：右对齐行号 + 制表符 + 内容
        out.push_str(&format!("{:>width$}\t{}\n", idx, line, width = width));
    }

    // 截断保护由 execute_and_serialize 统一处理；这里附加元信息
    let header = format!(
        "文件：{}（共 {total_lines} 行，显示 {start}-{end}）\n",
        resolved.display()
    );

    Ok(ToolOutput::ok_with(
        format!("{header}{out}"),
        json!({
            "filePath": resolved.to_string_lossy(),
            "totalLines": total_lines,
            "startLine": start,
            "endLine": end,
            "offset": offset,
            "limit": limit,
        }),
    ))
}

/// Glob：按文件模式匹配搜索。支持 `**/*.rs` 等标准 glob 模式。
async fn execute_glob(
    input: &Value,
    workspace_root: Option<&Path>,
) -> Result<ToolOutput, AppError> {
    let pattern = input
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("pattern 参数缺失".into()))?;
    let path = input.get("path").and_then(Value::as_str);

    let base = match path {
        Some(p) => resolve_path(p, workspace_root)?,
        None => match workspace_root {
            Some(root) => root.to_path_buf(),
            None => PathBuf::from("."),
        },
    };

    // 相对 base 的 glob：先 join 再用 glob crate 解析
    let full_pattern = if Path::new(pattern).is_absolute() {
        pattern.to_string()
    } else {
        base.join(pattern).to_string_lossy().into_owned()
    };

    let mut matches: Vec<String> = Vec::new();
    for entry in glob::glob(&full_pattern).map_err(|e| {
        AppError::ToolExecutionError(format!("无效的 glob 模式：{e}"))
    })? {
        match entry {
            Ok(p) => {
                if matches.len() >= MAX_RESULT_ENTRIES {
                    break;
                }
                matches.push(p.to_string_lossy().into_owned());
            }
            Err(e) => {
                tracing::warn!("glob 遍历条目失败：{e}");
            }
        }
    }

    let truncated = matches.len() >= MAX_RESULT_ENTRIES;
    let summary = if matches.is_empty() {
        "未匹配到任何文件".to_string()
    } else {
        let mut s = matches.join("\n");
        if truncated {
            s.push_str(&format!("\n...(已截断，仅显示前 {MAX_RESULT_ENTRIES} 条)"));
        }
        s
    };

    Ok(ToolOutput::ok_with(
        summary,
        json!({ "matches": matches, "truncated": truncated }),
    ))
}

/// Grep：搜索文件内容（正则）。返回匹配的 file:line:match。
async fn execute_grep(
    input: &Value,
    workspace_root: Option<&Path>,
) -> Result<ToolOutput, AppError> {
    let pattern = input
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("pattern 参数缺失".into()))?;
    let path = input.get("path").and_then(Value::as_str);
    let glob_filter = input.get("glob").and_then(Value::as_str);
    let case_insensitive = input
        .get("case_insensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let base = match path {
        Some(p) => resolve_path(p, workspace_root)?,
        None => match workspace_root {
            Some(root) => root.to_path_buf(),
            None => PathBuf::from("."),
        },
    };

    let mut pattern_builder = regex::RegexBuilder::new(pattern);
    pattern_builder.case_insensitive(case_insensitive);
    let re = pattern_builder
        .build()
        .map_err(|e| AppError::ToolExecutionError(format!("无效的正则：{e}")))?;

    let glob_re = match glob_filter {
        Some(g) => Some(
            Regex::new(&glob_to_regex(g))
                .map_err(|e| AppError::ToolExecutionError(format!("无效的 glob 过滤：{e}")))?,
        ),
        None => None,
    };

    let mut hits: Vec<String> = Vec::new();
    let mut total_matches = 0usize;

    for entry in WalkDir::new(&base)
        .into_iter()
        .filter_entry(|e| {
            // 跳过隐藏目录与常见忽略目录
            let file_type = e.file_type();
            if file_type.is_dir() {
                let name = e.file_name().to_string_lossy();
                if name.starts_with('.') || name == "node_modules" || name == "target" {
                    return false;
                }
            }
            true
        })
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }

        // glob 过滤
        if let Some(gre) = &glob_re {
            let name = entry.file_name().to_string_lossy();
            if !gre.is_match(&name) {
                continue;
            }
        }

        // 体积守卫：跳过超大文件
        if let Ok(meta) = entry.metadata() {
            if meta.len() > MAX_GREP_FILE_BYTES {
                continue;
            }
        }

        let path_str = entry.path().to_string_lossy();
        let content = match std::fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue, // 二进制或无法读取，跳过
        };

        for (i, line) in content.lines().enumerate() {
            if re.is_match(line) {
                total_matches += 1;
                if hits.len() < MAX_RESULT_ENTRIES {
                    // 截断过长的行
                    let display_line = if line.len() > 300 {
                        format!("{}...", &line[..300])
                    } else {
                        line.to_string()
                    };
                    hits.push(format!("{}:{}: {}", path_str, i + 1, display_line));
                }
            }
        }
    }

    let truncated = hits.len() >= MAX_RESULT_ENTRIES;
    let summary = if hits.is_empty() {
        "未匹配到任何内容".to_string()
    } else {
        let mut s = format!("共 {total_matches} 处匹配：\n{}", hits.join("\n"));
        if truncated {
            s.push_str(&format!("\n...(已截断，仅显示前 {MAX_RESULT_ENTRIES} 条)"));
        }
        s
    };

    Ok(ToolOutput::ok_with(
        summary,
        json!({ "matches": total_matches, "truncated": truncated }),
    ))
}

/// 简易 glob → 正则转换。仅处理 `*`、`?`、`**` 常见情形，足够文件名过滤。
fn glob_to_regex(glob: &str) -> String {
    let mut out = String::new();
    out.push('^');
    let mut chars = glob.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    out.push_str(".*");
                } else {
                    out.push_str("[^/]*");
                }
            }
            '?' => out.push('.'),
            '.' | '+' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('$');
    out
}

// ─── 用户交互工具 ─────────────────────────────────────────────────────────

/// AskUserQuestion：前端拦截该工具，不会真正调用此后端 handler。
/// 若因前端未拦截而落到此后端，返回 needsUserInput 标记让前端兜底处理。
async fn execute_ask_user_question(input: &Value) -> Result<ToolOutput, AppError> {
    let id = input
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let question = input
        .get("question")
        .and_then(Value::as_str)
        .unwrap_or("");

    Ok(ToolOutput::ok_with(
        format!("AskUserQuestion [{id}]: {question}"),
        json!({ "needsUserInput": true, "askId": id, "question": question }),
    ))
}

// ─── 清单（todo）工具 ─────────────────────────────────────────────────────

async fn execute_todo_create(
    input: &Value,
    chat_id: &str,
    task_store: &TaskStore,
) -> Result<ToolOutput, AppError> {
    let subject = input
        .get("subject")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("subject 参数缺失".into()))?;
    let description = input.get("description").and_then(Value::as_str);
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .and_then(parse_status);

    let req = CreateTaskRequest {
        subject: subject.to_string(),
        description: description.map(String::from),
        status,
    };
    let todo = task_store.create(chat_id, req).await?;
    Ok(ToolOutput::ok_with(
        format!("已创建清单项 #{}: {}", todo.id, todo.subject),
        json!({ "todo": todo }),
    ))
}

async fn execute_todo_update(
    input: &Value,
    chat_id: &str,
    task_store: &TaskStore,
) -> Result<ToolOutput, AppError> {
    let todo_id = input
        .get("todoId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("todoId 参数缺失".into()))?;
    let subject = input.get("subject").and_then(Value::as_str);
    let description = if input.get("description").is_some() {
        Some(input.get("description").and_then(Value::as_str).map(String::from))
    } else {
        None
    };
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .and_then(parse_status);

    let req = UpdateTaskRequest {
        subject: subject.map(String::from),
        description,
        status,
    };
    let todo = task_store.update(chat_id, todo_id, req).await?;
    Ok(ToolOutput::ok_with(
        format!("已更新清单项 #{}", todo.id),
        json!({ "todo": todo }),
    ))
}

async fn execute_todo_list(
    _input: &Value,
    chat_id: &str,
    task_store: &TaskStore,
) -> Result<ToolOutput, AppError> {
    let tasks = task_store.list(chat_id).await;
    let summary = if tasks.is_empty() {
        "当前会话暂无清单项".to_string()
    } else {
        let mut s = String::new();
        for t in &tasks {
            s.push_str(&format!("- #{} [{}] {}\n", t.id, status_label(&t.status), t.subject));
        }
        s
    };
    Ok(ToolOutput::ok_with(summary, json!({ "todos": tasks })))
}

async fn execute_todo_get(
    input: &Value,
    chat_id: &str,
    task_store: &TaskStore,
) -> Result<ToolOutput, AppError> {
    let todo_id = input
        .get("todoId")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::ToolExecutionError("todoId 参数缺失".into()))?;
    let task = task_store.get(chat_id, todo_id).await?;
    Ok(ToolOutput::ok_with(
        format!(
            "清单项 #{} [{}] {}\n{}",
            task.id,
            status_label(&task.status),
            task.subject,
            task.description.as_deref().unwrap_or("")
        ),
        json!({ "todo": task }),
    ))
}

fn parse_status(s: &str) -> Option<TaskStatus> {
    match s.to_lowercase().as_str() {
        "pending" => Some(TaskStatus::Pending),
        "in_progress" | "inprogress" | "running" => Some(TaskStatus::InProgress),
        "completed" | "done" => Some(TaskStatus::Completed),
        "failed" | "error" => Some(TaskStatus::Failed),
        _ => None,
    }
}

fn status_label(s: &TaskStatus) -> &'static str {
    match s {
        TaskStatus::Pending => "待处理",
        TaskStatus::InProgress => "进行中",
        TaskStatus::Completed => "已完成",
        TaskStatus::Failed => "失败",
    }
}

/// 供路由层调用的便捷包装：执行工具并把结果序列化为 JSON。
pub async fn execute_and_serialize(
    tool: &str,
    input: &Value,
    chat_id: &str,
    task_store: &TaskStore,
    workspace_root: Option<&Path>,
    read_tracker: &ReadTracker,
    file_history: &FileHistory,
    turn_message_id: Option<&str>,
    skill_service: Option<&SkillService>,
) -> Result<Value, AppError> {
    let result = execute_tool(tool, input, chat_id, task_store, workspace_root, read_tracker, Some(file_history), turn_message_id, skill_service).await?;
    let output = truncate(result.output);
    Ok(json!({
        "output": output,
        "isError": result.is_error,
        "structured": result.structured,
    }))
}

// ─── OpenAI Tools Schema 生成 ───────────────────────────────────────────────

use crate::provider::ToolDefinition;

/// 生成 OpenAI 兼容的 tools 数组。
/// 返回的 `Vec<ToolDefinition>` 可直接塞入 `POST /chat/completions` 的 `tools` 字段。
pub fn get_tools_schema() -> Vec<ToolDefinition> {
    let mut tools = vec![
        // ── 文件系统工具 ──
        file_tool(
            "Read",
            "Read a file's contents with line numbers. Use before editing to see current contents.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute or relative path to the file"
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Starting line number (1-based). Default: 1"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of lines to read. Default: all lines"
                    }
                },
                "required": ["file_path"],
                "additionalProperties": false
            }),
        ),
        file_tool(
            "Write",
            "Write or create a file. Automatically creates parent directories.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute or relative path to the file"
                    },
                    "content": {
                        "type": "string",
                        "description": "The full content to write to the file"
                    }
                },
                "required": ["file_path", "content"],
                "additionalProperties": false
            }),
        ),
        file_tool(
            "Edit",
            "Precisely replace text in a file. Requires exact old_string match. Use Read first to get current content.",
            json!({
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute or relative path to the file"
                    },
                    "old_string": {
                        "type": "string",
                        "description": "Exact text to find and replace"
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Replacement text"
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace all occurrences (default: false)"
                    }
                },
                "required": ["file_path", "old_string", "new_string"],
                "additionalProperties": false
            }),
        ),
        file_tool(
            "Glob",
            "Find files matching a glob pattern (e.g., **/*.rs).",
            json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern to match files (e.g., src/**/*.ts)"
                    },
                    "path": {
                        "type": "string",
                        "description": "Base directory for the search. Default: workspace root"
                    }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
        file_tool(
            "Grep",
            "Search file contents using a regular expression.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression to search for"
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search in. Default: workspace root"
                    },
                    "glob": {
                        "type": "string",
                        "description": "File name filter (e.g., *.rs)"
                    },
                    "case_insensitive": {
                        "type": "boolean",
                        "description": "Case-insensitive matching (default: false)"
                    }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
        // ── 用户交互工具 ──
        task_tool(
            "AskUserQuestion",
            "Ask the user a question and wait for their response. Output STOPS after this call — the system will present the question to the user and wait. Use this whenever you need clarification, choices, or user input to proceed. Supports three modes: choice (with options array), fill-in-the-blank (with requiresText only), or choice+other (with both options and requiresText).",
            json!({
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Unique identifier for this question (e.g., 'q1')"
                    },
                    "question": {
                        "type": "string",
                        "description": "The question text to present to the user"
                    },
                    "options": {
                        "type": "array",
                        "description": "Preset choices (omit for text-only mode)",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string", "description": "Option identifier" },
                                "label": { "type": "string", "description": "Display text" }
                            },
                            "required": ["id", "label"],
                            "additionalProperties": false
                        }
                    },
                    "allowMultiple": {
                        "type": "boolean",
                        "description": "Allow multiple selections (default: false)"
                    },
                    "requiresText": {
                        "type": "boolean",
                        "description": "Show text input alongside or instead of options (default: false)"
                    }
                },
                "required": ["id", "question"],
                "additionalProperties": false
            }),
        ),
        // ── 清单（todo）工具：todo 是普通待办记录，与 spawn_agent（子代理）无关 ──
        task_tool(
            "TodoCreate",
            "（待办清单工具，区别于 spawn_agent 子代理工具）Create a new todo entry in the todo list.",
            json!({
                "type": "object",
                "properties": {
                    "subject": {
                        "type": "string",
                        "description": "Brief todo title"
                    },
                    "description": {
                        "type": "string",
                        "description": "Detailed todo description"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed", "failed"],
                        "description": "Initial todo status"
                    }
                },
                "required": ["subject"],
                "additionalProperties": false
            }),
        ),
        task_tool(
            "TodoUpdate",
            "Update an existing todo entry's status, subject, or description.",
            json!({
                "type": "object",
                "properties": {
                    "todoId": {
                        "type": "string",
                        "description": "The todo ID to update"
                    },
                    "status": {
                        "type": "string",
                        "enum": ["pending", "in_progress", "completed", "failed"],
                        "description": "New todo status"
                    },
                    "subject": {
                        "type": "string",
                        "description": "New todo subject"
                    },
                    "description": {
                        "type": "string",
                        "description": "New todo description"
                    }
                },
                "required": ["todoId"],
                "additionalProperties": false
            }),
        ),
        task_tool(
            "TodoList",
            "List all todo entries in the current conversation.",
            json!({
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            }),
        ),
        task_tool(
            "TodoGet",
            "Get details of a single todo entry by its ID.",
            json!({
                "type": "object",
                "properties": {
                    "todoId": {
                        "type": "string",
                        "description": "The todo ID to retrieve"
                    }
                },
                "required": ["todoId"],
                "additionalProperties": false
            }),
        ),
        // ── Skill 工具（规格书 §8）──
        task_tool(
            "list_skill",
            "List available skills that match the optional filter. Then use load_skill to load a skill's full instructions before acting on it.",
            json!({
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Optional keyword; matched against skill name, description and when-to-use"
                    }
                },
                "required": [],
                "additionalProperties": false
            }),
        ),
        task_tool(
            "load_skill",
            "Load the full instructions of a skill listed by list_skill. The skill content will be injected into the conversation. If the result is PERMISSION_ASK, call AskUserQuestion first, then retry with userDecision.",
            json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The name of the skill from list_skill output"
                    },
                    "userDecision": {
                        "type": "string",
                        "enum": ["allow", "deny", "always_allow", "always_deny"],
                        "description": "Only after a PERMISSION_ASK response and the user's AskUserQuestion answer: pass their decision here"
                    }
                },
                "required": ["name"],
                "additionalProperties": false
            }),
        ),
    ];

    // 子代理调度类工具（设计稿 §6：spawn_agent / get_agent_output / kill_agent /
    // run_workflow / kill_workflow），schema 由 subagent 模块生成
    // （depth_hint 是否暴露由 allow_model_depth_hint 决定，§15.2）
    if let Some(subagents) = crate::subagent::current_subagents() {
        let config = subagents.config.read().unwrap().clone();
        let registry = subagents.registry.read().unwrap();
        for schema in crate::subagent::subagent_tool_schemas(&config, &registry) {
            tools.push(schema_value_to_tool_def(&schema));
        }
    } else {
        // 子代理系统未初始化（如单元测试）：注入默认配置的 schema，保证工具可用性声明完整
        let default_config = crate::subagent::types::SubagentConfig::default();
        let registry = crate::subagent::registry::AgentRegistry::new();
        for schema in crate::subagent::subagent_tool_schemas(&default_config, &registry) {
            tools.push(schema_value_to_tool_def(&schema));
        }
    }

    tools
}

/// subagent 模块产出的 JSON schema → ToolDefinition（结构化构造，避免反序列化）。
fn schema_value_to_tool_def(schema: &Value) -> ToolDefinition {
    ToolDefinition {
        tool_type: "function".into(),
        function: crate::provider::FunctionDefinition {
            name: schema["function"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            description: schema["function"]["description"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            strict: Some(true),
            parameters: schema["function"]["parameters"].clone(),
        },
    }
}

fn file_tool(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        tool_type: "function".into(),
        function: crate::provider::FunctionDefinition {
            name: name.into(),
            description: description.into(),
            strict: Some(true),
            parameters,
        },
    }
}

fn task_tool(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        tool_type: "function".into(),
        function: crate::provider::FunctionDefinition {
            name: name.into(),
            description: description.into(),
            strict: Some(true),
            parameters,
        },
    }
}
