//! ACP 消息协议（设计稿 §4）。
//!
//! JSON-RPC 2.0 over NDJSON（桌面端 stdio）/ 内存通道（Android 端）。
//! 协议与传输解耦：本文件只定义消息结构，传输见 `transport.rs`。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::{
    AgentDefinition, CapabilityMode, Hook, Isolation, Ruleset, SubagentOwner, ToolSpec,
};

/// 单帧大小上限（§4 帧限制）。
pub const ACP_FRAME_LIMIT: usize = 1024 * 1024;

// ─── 帧结构 ────────────────────────────────────────────────────────────────

/// 一条 ACP 消息（一行 NDJSON / 一个通道消息）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AcpFrame {
    /// 请求（带 id，期待响应）
    Request {
        id: Value,
        method: String,
        #[serde(default)]
        params: Value,
    },
    /// 响应（与请求 id 配对）
    Response {
        id: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<AcpErrorPayload>,
    },
    /// 事件 / 通知（无 id，不配对）
    Notification { method: String, #[serde(default)] params: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcpErrorPayload {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl AcpFrame {
    pub fn notification(method: &str, params: Value) -> Self {
        AcpFrame::Notification {
            method: method.into(),
            params,
        }
    }

    pub fn request(id: u64, method: &str, params: Value) -> Self {
        AcpFrame::Request {
            id: Value::from(id),
            method: method.into(),
            params,
        }
    }

    /// 子代理侧请求 id 加 "c-" 前缀，避免与父侧数值 id 冲突。
    pub fn child_request(id: u64, method: &str, params: Value) -> Self {
        AcpFrame::Request {
            id: Value::from(format!("c-{id}")),
            method: method.into(),
            params,
        }
    }

    pub fn response(id: Value, result: Value) -> Self {
        AcpFrame::Response {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error_response(id: Value, code: i64, message: &str, data: Option<Value>) -> Self {
        AcpFrame::Response {
            id,
            result: None,
            error: Some(AcpErrorPayload {
                code,
                message: message.into(),
                data,
            }),
        }
    }

    /// 序列化为单行 NDJSON；超限返回 None（§4 帧限制）。
    pub fn to_line(&self) -> Option<String> {
        let s = serde_json::to_string(self).ok()?;
        if s.len() > ACP_FRAME_LIMIT {
            return None;
        }
        Some(s)
    }

    pub fn from_line(line: &str) -> Option<Self> {
        let s = line.trim();
        if s.is_empty() || s.len() > ACP_FRAME_LIMIT {
            return None;
        }
        serde_json::from_str(s).ok()
    }
}

// ─── spawn 请求参数（§4 主 → 子）───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnParams {
    pub agent_definition: AgentDefinition,
    pub prompt: String,
    #[serde(default)]
    pub description: String,
    pub cwd: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub capability_mode: Option<CapabilityMode>,
    #[serde(default)]
    pub isolation: Option<Isolation>,
    #[serde(default)]
    pub permission: Ruleset,
    pub tools_snapshot: Vec<ToolSpec>,
    #[serde(default)]
    pub mcp_snapshot: Value,
    #[serde(default)]
    pub hooks_snapshot: Vec<Hook>,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// 已计算好的深度（子代理记录并用于嵌套判断）
    #[serde(default)]
    pub depth: u32,
    #[serde(default)]
    pub resume_from: Option<String>,
    #[serde(default)]
    pub fork_context: Option<String>,
    #[serde(default)]
    pub owner: SubagentOwner,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub task_id: String,
    #[serde(default)]
    pub parent_session: String,
    // Venture 适配（§6 / §18.2）：
    #[serde(default)]
    pub chat_id: String,
    #[serde(default)]
    pub turn_message_id: Option<String>,
    #[serde(default)]
    pub data_dir: String,
}

// ─── 子代理事件（§4 事件类型枚举）──────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", content = "content")]
pub enum ChildEvent {
    TokenDelta {
        text: String,
    },
    ToolUse {
        name: String,
        input: Value,
    },
    ToolResult {
        name: String,
        output: String,
        is_error: bool,
    },
    StateChange {
        state: String,
    },
    /// 权限请求转发（Ask 效果，§11.2）
    PermissionRequest {
        tool: String,
        input: Value,
        request_id: String,
    },
    Progress {
        message: String,
    },
}

impl ChildEvent {
    pub fn to_params(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// 事件流封装（子 → 主 notification method = "event"）。
pub fn event_notification(ev: &ChildEvent) -> AcpFrame {
    AcpFrame::notification("event", ev.to_params())
}

// ─── 完成结果（§4 子 → 主 spawn 响应）──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SpawnResultPayload {
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub turns: u32,
    #[serde(default)]
    pub tool_calls: u32,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub usage: Value,
    #[serde(default)]
    pub worktree_path: Option<String>,
    #[serde(default)]
    pub resume_from_hint: Option<String>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequestParam {
    pub tool: String,
    pub input: Value,
    /// 子代理侧可不带（coordinator 自行生成完整 request_id）
    #[serde(default)]
    pub request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionResponsePayload {
    pub request_id: String,
    /// allow | deny
    pub decision: String,
    #[serde(default)]
    pub reason: Option<String>,
    /// always_approve 时子代理将该工具加入 Allow 规则
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KillParams {
    #[serde(default)]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip() {
        let f = AcpFrame::request(1, "spawn", serde_json::json!({"prompt": "hi"}));
        let line = f.to_line().unwrap();
        let back = AcpFrame::from_line(&line).unwrap();
        match (&f, &back) {
            (AcpFrame::Request { id: a, method: ma, .. }, AcpFrame::Request { id: b, method: mb, .. }) => {
                assert_eq!(a, b);
                assert_eq!(ma, mb);
            }
            _ => panic!("roundtrip mismatch"),
        }
    }

    #[test]
    fn event_notification_roundtrip() {
        let ev = ChildEvent::TokenDelta { text: "你好".into() };
        let f = event_notification(&ev);
        let line = f.to_line().unwrap();
        let back = AcpFrame::from_line(&line).unwrap();
        match back {
            AcpFrame::Notification { method, params } => {
                assert_eq!(method, "event");
                assert_eq!(params["type"], "token_delta");
                assert_eq!(params["content"]["text"], "你好");
            }
            _ => panic!("not notification"),
        }
    }
}
