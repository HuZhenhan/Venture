//! 执行轨迹记录（规格书 6.6 / §9 脚本审计）。
//!
//! 每次 tool 调用记录 {tool, args, result, ts, duration_ms}，供前端执行轨迹回看。
//! 内存环形缓冲（上限 500 条），按 chat_id 过滤。

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone)]
pub struct TraceEntry {
    pub chat_id: String,
    pub tool: String,
    pub args: Value,
    pub result: Value,
    pub ts: u64,
    pub duration_ms: u64,
}

pub struct TraceStore {
    entries: Mutex<VecDeque<TraceEntry>>,
}

impl TraceStore {
    pub fn new() -> Self {
        Self { entries: Mutex::new(VecDeque::new()) }
    }

    pub fn record(&self, chat_id: &str, tool: &str, args: Value, result: Value, duration_ms: u64) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let entry = TraceEntry {
            chat_id: chat_id.to_string(),
            tool: tool.to_string(),
            args,
            result,
            ts,
            duration_ms,
        };
        let mut guard = self.entries.lock().unwrap();
        if guard.len() >= MAX_ENTRIES {
            guard.pop_front();
        }
        guard.push_back(entry);
    }

    /// 查询轨迹（chat_id 为空时返回全部）
    pub fn list(&self, chat_id: Option<&str>, limit: usize) -> Vec<Value> {
        let guard = self.entries.lock().unwrap();
        guard
            .iter()
            .rev()
            .filter(|e| chat_id.map(|c| c == e.chat_id).unwrap_or(true))
            .take(limit)
            .map(|e| {
                json!({
                    "chat_id": e.chat_id,
                    "tool": e.tool,
                    "args": e.args,
                    "result": e.result,
                    "ts": e.ts,
                    "duration_ms": e.duration_ms,
                })
            })
            .collect()
    }
}

impl Default for TraceStore {
    fn default() -> Self {
        Self::new()
    }
}
