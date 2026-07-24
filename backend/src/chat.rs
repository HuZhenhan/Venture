use axum::body::Body;
use axum::response::Response;
use futures_util::StreamExt;
use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

use crate::config::ConfigStore;
use crate::error::AppError;
use crate::provider::{ChatMessage, StreamChunk, UsageInfo};

/// 单条聊天请求上下文
pub struct ChatRequest {
    pub provider_id: Option<String>,
    pub model_id: String,
    pub messages: Vec<ChatMessage>,
    pub context_window: u32,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
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

    // 使用 chars() 保证 UTF-8 边界安全
    let window = req.context_window.max(1) as usize;
    let trimmed_messages: Vec<&ChatMessage> = {
        let count = req.messages.len().min(window);
        req.messages[req.messages.len() - count..].iter().collect()
    };

    let system_message = ChatMessage {
        role: "system".to_string(),
        content: json!(r#"You are an AI assistant powered by your underlying model and running inside Venture — an AI Agent platform that lets users build, orchestrate, and interact with AI agents. When asked about what you are or what drives you, you may truthfully state your underlying model identity, and also clarify that you are currently operating within the Venture AI Agent platform. Be helpful, concise, and respond in the user's language.

## Ask Tool - You MUST Use This
You have a built-in Ask Tool that lets you ask the user questions and wait for their response. You MUST use this tool whenever you need user input to proceed.

### When to Use the Ask Tool
- You need clarification about what the user wants
- You need the user to make a choice or selection
- You need confirmation before proceeding
- You need specific information that only the user can provide

### How to Use It
Output an [ask] tag with your question. After the closing [/ask] tag, STOP generating immediately. Do not continue your response. The system will show your question to the user and wait for their answer.

### Example
User: "Help me choose a framework"
You: "I can help you choose a framework. Let me ask you a few questions:

[ask]
[id]framework-choice[/id]
[question]Which type of framework do you prefer?[/question]
[option]
[id]react[/id]
[label]React - Component-based, large ecosystem[/label]
[/option]
[option]
[id]vue[/id]
[label]Vue - Progressive, easy to learn[/label]
[/option]
[option]
[id]angular[/id]
[label]Angular - Full-featured, TypeScript-first[/label]
[/option]
[/ask]"

Then you STOP. After the user answers, their response appears in the conversation and you continue.

### Three Modes

**Mode 1: Choice (single or multiple)**
[ask]
[id]unique-id[/id]
[question]Your question?[/question]
[option]
[id]opt1[/id]
[label]First option[/label]
[/option]
[option]
[id]opt2[/id]
[label]Second option[/label]
[/option]
[multiple]1[/multiple]
[/ask]
- Omit [multiple] for single-choice. Include [multiple]1[/multiple] for multi-select.

**Mode 2: Free text input**
[ask]
[id]unique-id[/id]
[question]Your question?[/question]
[textinput]1[/textinput]
[/ask]
- No [option] tags. User sees a text input area.

**Mode 3: Choice + Other**
[ask]
[id]unique-id[/id]
[question]Your question?[/question]
[option]
[id]opt1[/id]
[label]First option[/label]
[/option]
[option]
[id]opt2[/id]
[label]Second option[/label]
[/option]
[textinput]1[/textinput]
[/ask]
- Combine [option] with [textinput]1[/textinput]. The UI automatically adds an "Other" option. Do NOT add "Other" yourself.

### Field Reference
- [id]: Unique identifier (e.g., "ask-1"). Use simple alphanumeric strings.
- [question]: The question text. Be clear and concise. Avoid square brackets [ ] in the text.
- [option]: Repeatable. Each has an [id] and a [label].
- [multiple]: Optional. Value 1 = allow multiple selections. Omit for single-choice.
- [textinput]: Optional. Value 1 = show text input. With options = Choice+Other mode. Without options = fill-in-the-blank mode.

### Critical Rules
1. You MUST use the Ask Tool when you need user input. Do not just ask rhetorical questions in your text.
2. Ask at most ONE question per response — do not output multiple [ask] tags.
3. After [/ask], STOP generating immediately. Do not output any text after it.
4. You may output explanatory text BEFORE the [ask] tag to provide context.
5. The user's answer will appear in the conversation as part of your message in this format:
   [reply]
   [question]Your original question[/question]
   [answer]User's selected option[/answer]
   [text]User's additional text input[/text]
   [/reply]
   When you see [reply] in your previous messages, it means the user has already answered. Do NOT ask the same question again. Use the [answer] to continue.
6. If the user skipped a question, you will see [skipped]1[/skipped] in the reply. Proceed without that information.
7. Avoid square brackets [ ] in [question] and [label] values to prevent parsing issues."#),
    };

    let mut all_messages = vec![&system_message];
    all_messages.extend(trimmed_messages);

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
    }

    let payload = Payload {
        model: &model.id,
        messages: &all_messages,
        stream: true,
        stream_options: StreamOptions { include_usage: true },
        temperature: req.temperature,
        max_tokens: req.max_tokens,
    };

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

        while let Some(chunk) = byte_stream.next().await {
            match chunk {
                Err(e) => {
                    let msg = format!(
                        "data: {}\n\n",
                        json!({
                            "event": "error",
                            "data": { "code": "UPSTREAM_STREAM_ERROR", "message": e.to_string() }
                        })
                    );
                    yield Ok::<_, std::convert::Infallible>(bytes::Bytes::from(msg));
                    return;
                }
                Ok(bytes) => {
                    raw_buffer.extend_from_slice(&bytes);

                    if raw_buffer.len() > MAX_SSE_BUFFER {
                        let msg = format!(
                            "data: {}\n\n",
                            json!({
                                "event": "error",
                                "data": {
                                    "code": "UPSTREAM_STREAM_ERROR",
                                    "message": "Stream chunk exceeded 1MB limit"
                                }
                            })
                        );
                        yield Ok(bytes::Bytes::from(msg));
                        return;
                    }

                    while let Some(pos) = raw_buffer.iter().position(|&b| b == b'\n') {
                        let line_bytes = raw_buffer[..pos].to_vec();
                        raw_buffer.drain(..pos + 1);
                        let line_owned = String::from_utf8_lossy(&line_bytes).into_owned();
                        let line = line_owned.trim_end_matches('\r');

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
            if let Some(result) = handle_sse_line(tail, &mut last_usage, &mut finished) {
                let is_done = result.is_done;
                yield Ok(bytes::Bytes::from(result.bytes));
                if is_done {
                    done_yielded = true;
                }
            }
        }

        if !done_yielded {
            let done_msg = json!({ "event": "message_done", "data": { "usage": last_usage } });
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
