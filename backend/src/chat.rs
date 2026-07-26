use axum::body::Body;
use axum::response::Response;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

use crate::config::ConfigStore;
use crate::error::AppError;
use crate::provider::{ChatMessage, StreamChunk, ToolDefinition, UsageInfo};
use crate::tools::get_tools_schema;

/// 单条聊天请求上下文
pub struct ChatRequest {
    pub provider_id: Option<String>,
    pub model_id: String,
    pub messages: Vec<ChatMessage>,
    pub context_window: u32,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub trace_upstream: bool,
}

const MAX_UPSTREAM_ERROR_BODY: usize = 512;
const MAX_SSE_BUFFER: usize = 1024 * 1024;

/// 上游异常 body 长度限制 & 敏感字段过滤（简单收敛，避免密钥/HTML 泄漏）
fn sanitize_upstream_body(status: reqwest::StatusCode, body: &str) -> String {
    let trimmed = body.trim();
    let sanitized = if trimmed.len() > MAX_UPSTREAM_ERROR_BODY {
        let cut: String = trimmed.chars().take(MAX_UPSTREAM_ERROR_BODY).collect();
        format!("{cut}...(truncated)")
    } else {
        trimmed.to_string()
    };
    // 若为 HTML 页面（如反向代理错误），直接返回状态码即可
    if sanitized.starts_with("<!DOCTYPE") || sanitized.starts_with("<html") {
        format!("HTTP {} (upstream returned HTML page)", status)
    } else {
        format!("HTTP {}: {}", status, sanitized)
    }
}

/// 把 finish_reason 规范化：兼容真正的 null / 字符串 "null" / 空串
fn is_stream_finished(finish_reason: Option<&str>) -> bool {
    match finish_reason {
        Some(r) => !r.is_empty() && r != "null" && r.to_lowercase() != "none",
        None => false,
    }
}

struct SseLineResult {
    bytes: Vec<u8>,
    is_done: bool,
}

/// 处理单个 SSE 数据行；返回要输出的 bytes 及是否为终止帧
fn handle_sse_line(
    line: &str,
    last_usage: &mut Option<UsageInfo>,
    finished: &mut bool,
) -> Option<SseLineResult> {
    if line.is_empty() {
        return None;
    }
    if line == "data: [DONE]" {
        let msg = json!({ "event": "message_done", "data": { "usage": last_usage } });
        *finished = true;
        return Some(SseLineResult {
            bytes: format!("data: {msg}\n\n").into_bytes(),
            is_done: true,
        });
    }

    let json_str = line.strip_prefix("data: ")?;
    if json_str.is_empty() {
        return None;
    }

    // 强类型解析可能因 usage-only chunk（choices 为空）而失败，
    // 因此先用 Value 兜底提取 usage
    let value: serde_json::Value = serde_json::from_str(json_str).ok()?;

    if let Some(usage_val) = value.get("usage") {
        if !usage_val.is_null() {
            if let Ok(u) = serde_json::from_value::<UsageInfo>(usage_val.clone()) {
                *last_usage = Some(u);
            }
        }
    }

    let chunk: StreamChunk = serde_json::from_value(value).ok()?;
    if *finished {
        return None;
    }

    let mut out = Vec::new();
    for choice in &chunk.choices {
        if let Some(rc) = &choice.delta.reasoning_content {
            if !rc.is_empty() {
                let evt = json!({ "event": "reasoning_delta", "data": { "delta": rc } });
                out.extend_from_slice(format!("data: {evt}\n\n").as_bytes());
            }
        }
        if let Some(c) = &choice.delta.content {
            if !c.is_empty() {
                let evt = json!({ "event": "content_delta", "data": { "delta": c } });
                out.extend_from_slice(format!("data: {evt}\n\n").as_bytes());
            }
        }
        // 处理 tool_calls delta：透传为 tool_call_start / tool_call_delta 事件
        if let Some(tool_calls) = &choice.delta.tool_calls {
            for tc in tool_calls {
                if let (Some(index), Some(id), Some(func)) =
                    (tc.index, &tc.id, &tc.function)
                {
                    let name = func.name.as_deref().unwrap_or("");
                    let evt = json!({
                        "event": "tool_call_start",
                        "data": { "index": index, "id": id, "name": name }
                    });
                    out.extend_from_slice(format!("data: {evt}\n\n").as_bytes());
                } else if let Some(index) = tc.index {
                    if let Some(func) = &tc.function {
                        if let Some(args) = &func.arguments {
                            if !args.is_empty() {
                                let evt = json!({
                                    "event": "tool_call_delta",
                                    "data": { "index": index, "arguments": args }
                                });
                                out.extend_from_slice(format!("data: {evt}\n\n").as_bytes());
                            }
                        }
                    }
                }
            }
        }
        if is_stream_finished(choice.finish_reason.as_deref()) {
            *finished = true;
        }
    }

    if out.is_empty() {
        None
    } else {
        Some(SseLineResult { bytes: out, is_done: false })
    }
}

pub async fn handle_stream(
    store: Arc<ConfigStore>,
    http: Arc<Client>,
    req: ChatRequest,
) -> Result<Response, AppError> {
    let (provider, model) = store
        .find_model(req.provider_id.as_deref(), &req.model_id)
        .await
        .ok_or(AppError::ModelNotFound)?;

    if provider.api_key.is_empty() {
        return Err(AppError::InvalidProviderConfig(
            "api_key is not configured for this provider".into(),
        ));
    }

    // 所有消息保持原样，不做截断
    let all_messages_refs: Vec<&ChatMessage> = req.messages.iter().collect();

    let system_message = ChatMessage {
        role: "system".to_string(),
        content: json!(r#"You are an AI assistant powered by your underlying model and running inside Venture — an AI Agent platform that lets users build, orchestrate, and interact with AI agents. When asked about what you are or what drives you, you may truthfully state your underlying model identity, and also clarify that you are currently operating within the Venture AI Agent platform. Be helpful, concise, and respond in the user's language.

## AskUserQuestion Tool — You MUST Use This
You have an **AskUserQuestion** tool available as a standard function call. When you call it, the system will present the question to the user and wait for their response. You MUST use this tool whenever you need user input to proceed.

### When to Use It
- You need clarification about what the user wants
- You need the user to make a choice or selection
- You need confirmation before proceeding
- You need specific information that only the user can provide

### Three Modes

**Mode 1: Choice (single or multiple)**
Call AskUserQuestion with `options` set to an array of choices. Set `allowMultiple: true` for multi-select. Omit for single-choice.

**Mode 2: Free text input (fill-in-the-blank)**
Call AskUserQuestion with `requiresText: true` and NO `options` array.

**Mode 3: Choice + "Other"**
Call AskUserQuestion with BOTH `options` and `requiresText: true`. The UI automatically adds an "Other" option — do NOT add it yourself.

### Critical Rules
1. You MUST call AskUserQuestion when you need user input. Do not just ask rhetorical questions.
2. Call it at most ONCE per response — do not make multiple AskUserQuestion calls.
3. After calling AskUserQuestion, STOP generating — do not output more tool calls or text.
4. You may output explanatory text BEFORE the tool call to provide context.
5. The user's answer will come back as a standard tool result (role: "tool" message). Read the tool result and continue.
6. If the user skipped, the result will indicate "[skipped]". Proceed without that information.
7. Avoid square brackets [ ] in `question` and `label` values.

## Tool Use
You have access to file system and task management tools through the standard function calling interface. Use them whenever you need to perform an action rather than just describing it.

### Available Tools
- **AskUserQuestion** — Ask the user a question (choice, text input, or both)
- **Read** — Read a file's contents with line numbers
- **Write** — Write or create a file
- **Edit** — Precisely replace text in a file
- **Glob** — Find files by glob pattern
- **Grep** — Search file contents with regex
- **TaskCreate** — Create a new task
- **TaskUpdate** — Update an existing task
- **TaskList** — List all tasks
- **TaskGet** — Get a single task's details

### Critical Tool Rules
1. When calling tools, end your response after the tool call — the system will execute them and give you the result.
2. Before using **Edit**, use **Read** first to obtain the exact text to replace.
3. Prefer tools over describing what you would do — actually perform the action.
4. When a task requires multiple tool calls, invoke them one at a time, waiting for each result before proceeding.
5. Use tools proactively — don't ask the user for permission to read or search files."#),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    };

    let mut all_messages = vec![&system_message];
    all_messages.extend(all_messages_refs);

    let endpoint = format!(
        "{}/chat/completions",
        provider.base_url.trim_end_matches('/')
    );

    // 使用 struct + skip_serializing_if，避免 null 字段传入上游
    #[derive(serde::Serialize)]
    struct StreamOptions {
        include_usage: bool,
    }
    #[derive(serde::Serialize)]
    struct Payload<'a> {
        model: &'a str,
        messages: &'a [&'a ChatMessage],
        stream: bool,
        stream_options: StreamOptions,
        #[serde(skip_serializing_if = "Option::is_none")]
        temperature: Option<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_tokens: Option<u32>,
        tools: &'a [ToolDefinition],
    }

    let tools_schema = get_tools_schema();
    let payload = Payload {
        model: &model.id,
        messages: &all_messages,
        stream: true,
        stream_options: StreamOptions { include_usage: true },
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        tools: &tools_schema,
    };

    // 上游追踪：序列化发给供应商的完整请求体
    let upstream_trace_body: Option<serde_json::Value> = if req.trace_upstream {
        serde_json::to_value(&payload).ok()
    } else {
        None
    };
    let upstream_trace_enabled = req.trace_upstream;
    let upstream_endpoint = endpoint.clone();

    // 单个请求级别的超时（作用于建连+首字节返回，不限制流总时长）
    let upstream_resp = http
        .post(&endpoint)
        .bearer_auth(&provider.api_key)
        .json(&payload)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                AppError::UpstreamTimeout
            } else if e.is_connect() {
                AppError::UpstreamStreamError(format!("connection failed: {e}"))
            } else {
                AppError::UpstreamStreamError(e.to_string())
            }
        })?;

    let status = upstream_resp.status();
    if status == 401 || status == 403 {
        return Err(AppError::UpstreamAuthFailed);
    }
    if status == 429 {
        return Err(AppError::UpstreamRateLimited);
    }
    if !status.is_success() {
        let body = upstream_resp.text().await.unwrap_or_default();
        return Err(AppError::UpstreamStreamError(sanitize_upstream_body(status, &body)));
    }

    let mut byte_stream = upstream_resp.bytes_stream();

    let sse_stream = async_stream::stream! {
        let mut raw_buffer: Vec<u8> = Vec::new();
        let mut last_usage: Option<UsageInfo> = None;
        let mut finished = false;
        let mut done_yielded = false;
        let mut upstream_trace_events: Vec<serde_json::Value> = Vec::new();

        // 构建上游 trace 数据的辅助闭包
        let build_upstream_trace = |events: &Vec<serde_json::Value>| -> serde_json::Value {
            json!({
                "request": {
                    "url": &upstream_endpoint,
                    "method": "POST",
                    "headers": { "Content-Type": "application/json" },
                    "body": upstream_trace_body,
                },
                "events": events,
            })
        };

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Err(e) => {
                    let mut err_data = json!({
                        "code": "UPSTREAM_STREAM_ERROR",
                        "message": e.to_string()
                    });
                    if upstream_trace_enabled {
                        err_data["upstream_trace"] = build_upstream_trace(&upstream_trace_events);
                    }
                    let msg = format!(
                        "data: {}\n\n",
                        json!({ "event": "error", "data": err_data })
                    );
                    yield Ok::<_, std::convert::Infallible>(bytes::Bytes::from(msg));
                    return;
                }
                Ok(bytes) => {
                    raw_buffer.extend_from_slice(&bytes);

                    if raw_buffer.len() > MAX_SSE_BUFFER {
                        let mut err_data = json!({
                            "code": "UPSTREAM_STREAM_ERROR",
                            "message": "Stream chunk exceeded 1MB limit"
                        });
                        if upstream_trace_enabled {
                            err_data["upstream_trace"] = build_upstream_trace(&upstream_trace_events);
                        }
                        let msg = format!(
                            "data: {}\n\n",
                            json!({ "event": "error", "data": err_data })
                        );
                        yield Ok(bytes::Bytes::from(msg));
                        return;
                    }

                    while let Some(pos) = raw_buffer.iter().position(|&b| b == b'\n') {
                        let line_bytes = raw_buffer[..pos].to_vec();
                        raw_buffer.drain(..pos + 1);
                        let line_owned = String::from_utf8_lossy(&line_bytes).into_owned();
                        let line = line_owned.trim_end_matches('\r');

                        // 检测上游 SSE 的 [DONE] 终止标记（在 handle_sse_line 之前，以便注入 upstream_trace）
                        if line == "data: [DONE]" {
                            let mut data = json!({ "usage": last_usage });
                            if upstream_trace_enabled {
                                upstream_trace_events.push(json!("[DONE]"));
                                data["upstream_trace"] = build_upstream_trace(&upstream_trace_events);
                            }
                            let done_msg = json!({ "event": "message_done", "data": data });
                            yield Ok(bytes::Bytes::from(format!("data: {done_msg}\n\n")));
                            return;
                        }

                        // 缓冲上游原始事件（用于追踪展示）
                        if upstream_trace_enabled {
                            if let Some(json_str) = line.strip_prefix("data: ") {
                                if !json_str.is_empty() {
                                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) {
                                        upstream_trace_events.push(val);
                                    }
                                }
                            }
                        }

                        if let Some(result) = handle_sse_line(line, &mut last_usage, &mut finished) {
                            let is_done = result.is_done;
                            yield Ok(bytes::Bytes::from(result.bytes));
                            if is_done {
                                done_yielded = true;
                                return;
                            }
                        }
                    }
                }
            }
        }

        // 尾帧 flush：处理没有换行结尾的最后一行
        if !raw_buffer.is_empty() {
            let tail_owned = String::from_utf8_lossy(&raw_buffer).into_owned();
            let tail = tail_owned.trim_end_matches('\r');
            if tail == "data: [DONE]" {
                let mut data = json!({ "usage": last_usage });
                if upstream_trace_enabled {
                    upstream_trace_events.push(json!("[DONE]"));
                    data["upstream_trace"] = build_upstream_trace(&upstream_trace_events);
                }
                let done_msg = json!({ "event": "message_done", "data": data });
                yield Ok(bytes::Bytes::from(format!("data: {done_msg}\n\n")));
                done_yielded = true;
            } else if let Some(result) = handle_sse_line(tail, &mut last_usage, &mut finished) {
                let is_done = result.is_done;
                yield Ok(bytes::Bytes::from(result.bytes));
                if is_done {
                    done_yielded = true;
                }
            }
        }

        if !done_yielded {
            let mut data = json!({ "usage": last_usage });
            if upstream_trace_enabled {
                data["upstream_trace"] = build_upstream_trace(&upstream_trace_events);
            }
            let done_msg = json!({ "event": "message_done", "data": data });
            yield Ok(bytes::Bytes::from(format!("data: {done_msg}\n\n")));
        }
    };

    let body = Body::from_stream(sse_stream);
    let response = Response::builder()
        .status(200)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("X-Accel-Buffering", "no")
        .body(body)
        .unwrap();

    Ok(response)
}
