//! 子代理持久化（设计稿 §13）。
//!
//! 目录布局：`<data_dir>/subagents/<subagent_id>/`
//! ```text
//! ├── transcript.jsonl      # 每条消息 O(1) 追加
//! ├── meta.json             # spawn 元信息
//! ├── output.json           # SubagentCompletedOutput（完成时写，fsync）
//! └── log/stderr.log        # 进程日志
//! ```

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::{SubagentCompletedOutput, SubagentError};

/// 子代理根目录。
pub fn subagents_root(data_dir: &Path) -> PathBuf {
    data_dir.join("subagents")
}

pub fn subagent_dir(data_dir: &Path, task_id: &str) -> PathBuf {
    subagents_root(data_dir).join(task_id)
}

/// 解析子代理数据目录：优先原 ID；若目录不存在且 ID 带 `agent-` 前缀，
/// 回退尝试去掉前缀的旧目录（兼容重命名前的纯 UUID 数据）。
pub fn resolve_subagent_dir(data_dir: &Path, id: &str) -> PathBuf {
    let direct = subagent_dir(data_dir, id);
    if direct.exists() || !id.starts_with("agent-") {
        return direct;
    }
    let legacy = subagent_dir(data_dir, id.trim_start_matches("agent-"));
    if legacy.exists() {
        legacy
    } else {
        direct
    }
}

// ─── meta.json ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SubagentMeta {
    pub task_id: String,
    #[serde(default)]
    pub agent_type: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub isolation: Option<String>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub parent_session: String,
    #[serde(default)]
    pub chat_id: String,
    #[serde(default)]
    pub depth: u32,
    #[serde(default)]
    pub created_at: u64,
    /// resume 来源（§9.2）
    #[serde(default)]
    pub resume_from: Option<String>,
    /// 完成标记（有 output.json 即完成；此字段冗余便于扫描）
    #[serde(default)]
    pub finished: bool,
}

/// 原子写 JSON 文件（tmp + rename），写后 fsync。
pub fn write_json_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(serde_json::to_string_pretty(value).unwrap_or_default().as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save_meta(data_dir: &Path, meta: &SubagentMeta) -> std::io::Result<()> {
    let path = subagent_dir(data_dir, &meta.task_id).join("meta.json");
    let value = serde_json::to_value(meta).unwrap_or(Value::Null);
    write_json_atomic(&path, &value)
}

pub fn load_meta(data_dir: &Path, task_id: &str) -> Option<SubagentMeta> {
    read_json(&subagent_dir(data_dir, task_id).join("meta.json"))
}

pub fn save_output(data_dir: &Path, task_id: &str, output: &SubagentCompletedOutput) -> std::io::Result<()> {
    let dir = subagent_dir(data_dir, task_id);
    std::fs::create_dir_all(&dir)?;
    let value = serde_json::to_value(output).unwrap_or(Value::Null);
    write_json_atomic(&dir.join("output.json"), &value)
}

pub fn load_output(data_dir: &Path, task_id: &str) -> Option<SubagentCompletedOutput> {
    read_json(&resolve_subagent_dir(data_dir, task_id).join("output.json"))
}

// ─── transcript.jsonl ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEntry {
    /// system | user | assistant | tool | summary | compaction
    pub role: String,
    #[serde(default)]
    pub content: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub ts: u64,
}

/// Transcript 追加器：每条消息立即追加一行并 flush（§13.1）。
pub struct Transcript {
    file: std::fs::File,
    path: PathBuf,
    pub entries: Vec<TranscriptEntry>,
}

impl Transcript {
    pub fn open(data_dir: &Path, task_id: &str) -> std::io::Result<Self> {
        let dir = subagent_dir(data_dir, task_id);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("transcript.jsonl");
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        let entries = Self::load_entries(&path);
        Ok(Self { file, path, entries })
    }

    /// 读取全部条目；崩溃产生的最后一行残缺 JSON 会被忽略（§13.1 崩溃不产生半行语义的读侧兜底）。
    fn load_entries(path: &Path) -> Vec<TranscriptEntry> {
        let Ok(content) = std::fs::read_to_string(path) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(e) = serde_json::from_str::<TranscriptEntry>(line) {
                out.push(e);
            }
        }
        out
    }

    pub fn append(&mut self, entry: TranscriptEntry) {
        if let Ok(line) = serde_json::to_string(&entry) {
            use std::io::Write;
            if self.file.write_all(line.as_bytes()).is_ok() {
                let _ = self.file.write_all(b"\n");
                let _ = self.file.flush();
            }
        }
        self.entries.push(entry);
    }

    /// 压缩留痕（§8：压缩动作本身记入 transcript）。
    pub fn record_compaction(&mut self, removed: usize, added_summary: bool) {
        let entry = TranscriptEntry {
            role: "compaction".into(),
            content: serde_json::json!({
                "removed_entries": removed,
                "summary_added": added_summary,
                "ts_note": "context compacted",
            }),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            ts: now_ms(),
        };
        self.append(entry);
    }

    pub fn flush_and_sync(&mut self) {
        let _ = self.file.flush();
        let _ = self.file.sync_all();
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── 崩溃扫描（§13.2）──────────────────────────────────────────────────────

/// 启动扫描结果：有 output.json → completed；无 → 中断任务（可 resume）。
pub struct CrashScanReport {
    pub completed: Vec<SubagentCompletedOutput>,
    pub interrupted: Vec<SubagentMeta>,
}

pub fn crash_scan(data_dir: &Path) -> CrashScanReport {
    let mut report = CrashScanReport {
        completed: Vec::new(),
        interrupted: Vec::new(),
    };
    let root = subagents_root(data_dir);
    let Ok(entries) = std::fs::read_dir(&root) else {
        return report;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(meta) = read_json::<SubagentMeta>(&dir.join("meta.json")) else {
            continue;
        };
        if let Some(output) = read_json::<SubagentCompletedOutput>(&dir.join("output.json")) {
            report.completed.push(output);
        } else if !meta.finished {
            report.interrupted.push(meta);
        }
    }
    report
}

/// 中断任务的提醒文案（§13.2）。
pub fn interrupted_reminder(report: &CrashScanReport) -> Option<String> {
    if report.interrupted.is_empty() {
        return None;
    }
    let ids: Vec<String> = report
        .interrupted
        .iter()
        .map(|m| m.task_id.clone())
        .collect();
    Some(format!(
        "发现 {} 个中断的子代理任务（如 {}），可用 spawn_agent 工具的 resume_from 参数续跑。",
        report.interrupted.len(),
        ids.join(", ")
    ))
}

// ─── resume 复制（§9.2）────────────────────────────────────────────────────

/// 复制源子代理会话数据（transcript + meta），源会话不被修改。
/// 返回复制后的 transcript 条目；源 token 超限返回 Err(message)。
pub fn copy_session_data(
    data_dir: &Path,
    source_id: &str,
    new_agent_id: &str,
    context_window_tokens: u64,
) -> Result<Vec<TranscriptEntry>, SubagentError> {
    let src_dir = resolve_subagent_dir(data_dir, source_id);
    let transcript_path = src_dir.join("transcript.jsonl");
    if !transcript_path.exists() {
        return Err(SubagentError::new(
            super::types::ErrorKind::SpawnFailed,
            format!("resume_from 源会话不存在：{source_id}"),
            false,
        ));
    }
    let entries = Transcript::load_entries_pub(&transcript_path);
    if entries.is_empty() {
        return Err(SubagentError::new(
            super::types::ErrorKind::SpawnFailed,
            format!("resume_from 源会话 transcript 为空：{source_id}"),
            false,
        ));
    }

    // token 检查（§9.2：> 80% 窗口 → 直接报错，不截断不降级）
    let estimated = estimate_tokens_entries(&entries);
    let limit = context_window_tokens * 8 / 10;
    if estimated > limit {
        return Err(SubagentError::new(
            super::types::ErrorKind::ContextTooLarge,
            format!("源会话过大（{estimated}/{limit} tokens），无法续跑。请改用新开上下文。"),
            false,
        ));
    }

    // 字节级复制 transcript
    let dst_dir = subagent_dir(data_dir, new_agent_id);
    std::fs::create_dir_all(&dst_dir).map_err(|e| {
        SubagentError::new(
            super::types::ErrorKind::Internal,
            format!("创建会话目录失败：{e}"),
            false,
        )
    })?;
    std::fs::copy(&transcript_path, dst_dir.join("transcript.jsonl")).map_err(|e| {
        SubagentError::new(
            super::types::ErrorKind::Internal,
            format!("复制 transcript 失败：{e}"),
            false,
        )
    })?;

    // meta 记录 resume_from
    let mut meta = load_meta(data_dir, source_id).unwrap_or_default();
    meta.task_id = new_agent_id.to_string();
    meta.resume_from = Some(source_id.to_string());
    meta.created_at = now_ms();
    meta.finished = false;
    let _ = save_meta(data_dir, &meta);

    Ok(entries)
}

impl Transcript {
    /// 公开静态读取（resume 用）。
    pub fn load_entries_pub(path: &Path) -> Vec<TranscriptEntry> {
        Self::load_entries(path)
    }
}

/// token 粗估：chars / 4（§9.2，无 tokenizer 时）。
pub fn estimate_tokens_text(s: &str) -> u64 {
    (s.chars().count() as u64) / 4 + 1
}

pub fn estimate_tokens_entries(entries: &[TranscriptEntry]) -> u64 {
    let mut total = 0u64;
    for e in entries {
        if let Some(text) = e.content.as_str() {
            total += estimate_tokens_text(text);
        } else {
            total += estimate_tokens_text(&e.content.to_string());
        }
        if let Some(calls) = &e.tool_calls {
            total += estimate_tokens_text(&calls.to_string());
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::UsageInfo;

    #[test]
    fn transcript_roundtrip_and_partial_line() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        {
            let mut t = Transcript::open(&data_dir, "t1").unwrap();
            t.append(TranscriptEntry {
                role: "user".into(),
                content: Value::String("你好".into()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
                ts: 1,
            });
            t.flush_and_sync();
        }
        // 模拟半行损坏
        let path = subagent_dir(&data_dir, "t1").join("transcript.jsonl");
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            f.write_all(b"{\"role\":\"user\",\"content\":\"partial").unwrap();
        }
        let entries = Transcript::load_entries_pub(&path);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].content, Value::String("你好".into()));
    }

    #[test]
    fn output_persist_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let out = SubagentCompletedOutput {
            task_id: "t2".into(),
            output: "done".into(),
            tool_calls: 3,
            turns: 2,
            duration_ms: 100,
            worktree_path: None,
            resume_from_hint: None,
            usage: UsageInfo {
                prompt_tokens: Some(10),
                completion_tokens: Some(5),
                total_tokens: Some(15),
                prompt_cache_hit_tokens: None,
                prompt_cache_miss_tokens: None,
                prompt_tokens_details: None,
            },
            truncated: false,
        };
        save_output(&data_dir, "t2", &out).unwrap();
        let loaded = load_output(&data_dir, "t2").unwrap();
        assert_eq!(loaded.task_id, "t2");
        assert_eq!(loaded.turns, 2);
    }
}
