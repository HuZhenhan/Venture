//! 子代理 LLM 循环（设计稿 §8 / M0）。
//!
//! 与前端驱动的主对话循环完全独立：Rust 侧自主消费上游 SSE，
//! 完成消息累积 / tool_call 收集 / 结果回填 / compaction / max_turns。
//! 复用 `ConfigStore.find_model` 与 provider 类型（§18.1 #6）。

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::config::ConfigStore;
use crate::provider::{
    ChatMessage, StreamChunk, ToolDefinition, ToolCall, ToolCallFunction, UsageInfo,
};
use reqwest::Client;

use super::persist::{estimate_tokens_text, Transcript, TranscriptEntry};
use super::protocol::ChildEvent;
use super::types::SubagentError;

/// 压缩参数（§8）。
const PRUNE_THRESHOLD_RATIO: f64 = 0.8;
const PRUNE_PROTECT_TOKENS: u64 = 40_000;
const PRUNE_MINIMUM_TOKENS: u64 = 20_000;
/// 每次上游调用建连+首字节超时。
const UPSTREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_RETRIES: u32 = 2;

/// 工具执行器抽象：child.rs 提供带权限判定与 ACP 转发的实现。
pub trait SubToolExecutor: Send {
    fn execute<'a>(
        &'a mut self,
        name: &'a str,
        input: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = (String, bool)> + Send + 'a>>;
}

/// LLM 循环产物。
pub struct LoopOutcome {
    pub output: String,
    pub tool_calls: u32,
    pub turns: u32,
    pub usage: UsageInfo,
    pub truncated: bool,
    pub worktree_path: Option<std::path::PathBuf>,
    pub resume_from_hint: Option<String>,
}

pub struct LoopParams {
    pub provider_id: Option<String>,
    pub model_id: String,
    pub temperature: Option<f32>,
    pub system_prompt: String,
    /// 初始消息（不含 system；resume 时为源 transcript 重建后的消息序列）
    pub initial_messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub max_turns: u32,
    /// token 窗口（用于 compaction）
    pub context_window_tokens: u64,
}

/// 事件下沉（发 ACP 事件给父侧）。
pub trait EventSink: Send {
    fn emit(&mut self, ev: ChildEvent);
}

/// 运行子代理 LLM 循环直到完成 / max_turns / 错误。
pub async fn run_loop(
    store: &ConfigStore,
    http: &Client,
    params: LoopParams,
    executor: &mut dyn SubToolExecutor,
    sink: &mut dyn EventSink,
    transcript: &mut Transcript,
) -> Result<LoopOutcome, SubagentError> {
    let (provider, _model) = store
        .find_model(params.provider_id.as_deref(), &params.model_id)
        .await
        .ok_or_else(|| SubagentError::new(
            super::types::ErrorKind::Internal,
            format!("子代理模型未找到：{}", params.model_id),
            false,
        ))?;
    if provider.api_key.is_empty() {
        return Err(SubagentError::new(
            super::types::ErrorKind::Internal,
            "子代理模型对应 provider 未配置 api_key",
            false,
        ));
    }

    let endpoint = format!("{}/chat/completions", provider.base_url.trim_end_matches('/'));

    let system_message = ChatMessage {
        role: "system".into(),
        content: json!(params.system_prompt),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    };
    transcript.append(TranscriptEntry {
        role: "system".into(),
        content: json!(params.system_prompt),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
        ts: super::persist::now_ms(),
    });

    let mut messages: Vec<ChatMessage> = vec![system_message];
    messages.extend(params.initial_messages.clone());
    for m in &params.initial_messages {
        transcript.append(to_entry(m));
    }

    let mut total_usage = UsageInfo {
        prompt_tokens: None,
        completion_tokens: None,
        total_tokens: None,
        prompt_cache_hit_tokens: None,
        prompt_cache_miss_tokens: None,
        prompt_tokens_details: None,
    };
    let mut tool_call_count: u32 = 0;
    let mut turns: u32 = 0;
    let _started = Instant::now();
    let tools = params.tools.clone();
    let tools_ref: &[ToolDefinition] = &tools;

    loop {
        if turns >= params.max_turns {
            // max_turns 硬上限（§3.1）：强制结束，输出当前进展 + truncated
            let last_content = messages
                .iter()
                .rev()
                .find_map(|m| {
                    if m.role == "assistant" {
                        m.content.as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .unwrap_or_default();
            let note = format!(
                "\n\n[子代理达到最大轮次上限（{} 轮），任务被截断。以上为当前进展。]",
                params.max_turns
            );
            return Ok(LoopOutcome {
                output: format!("{last_content}{note}"),
                tool_calls: tool_call_count,
                turns,
                usage: total_usage,
                truncated: true,
                worktree_path: None,
                resume_from_hint: None,
            });
        }
        turns += 1;
        sink.emit(ChildEvent::StateChange {
            state: "running".into(),
        });

        // 上游流式调用（复用 chat.rs 的重试/超时策略）
        let assistant = match call_upstream(
            http,
            &endpoint,
            &provider.api_key,
            &params.model_id,
            &messages,
            params.temperature,
            tools_ref,
            sink,
        )
        .await
        {
            Ok(a) => a,
            Err(e) => return Err(e),
        };

        // usage 累计（每次调用取回的 usage 相加）
        if let Some(u) = &assistant.usage {
            total_usage = UsageInfo {
                prompt_tokens: Some(total_usage.prompt_tokens.unwrap_or(0) + u.prompt_tokens.unwrap_or(0)),
                completion_tokens: Some(
                    total_usage.completion_tokens.unwrap_or(0) + u.completion_tokens.unwrap_or(0),
                ),
                total_tokens: Some(total_usage.total_tokens.unwrap_or(0) + u.total_tokens.unwrap_or(0)),
                prompt_cache_hit_tokens: u.prompt_cache_hit_tokens.clone().or(total_usage.prompt_cache_hit_tokens.clone()),
                prompt_cache_miss_tokens: u
                    .prompt_cache_miss_tokens
                    .clone()
                    .or(total_usage.prompt_cache_miss_tokens.clone()),
                prompt_tokens_details: u.prompt_tokens_details.clone().or(total_usage.prompt_tokens_details.clone()),
            };
        }

        // 追加助手消息（transcript + 内存）
        messages.push(assistant.message.clone());
        transcript.append(to_entry(&assistant.message));

        let has_calls = assistant
            .message
            .tool_calls
            .as_ref()
            .map(|c| !c.is_empty())
            .unwrap_or(false);

        if !has_calls {
            // 完成：提取最终文本
            sink.emit(ChildEvent::StateChange {
                state: "completing".into(),
            });
            let output = assistant
                .message
                .content
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| assistant.message.content.to_string());
            return Ok(LoopOutcome {
                output,
                tool_calls: tool_call_count,
                turns,
                usage: total_usage,
                truncated: false,
                worktree_path: None,
                resume_from_hint: None,
            });
        }

        // 工具调用：顺序执行（§18 工具调用顺序执行约束）
        let calls = assistant.message.tool_calls.clone().unwrap_or_default();
        for call in &calls {
            tool_call_count += 1;
            sink.emit(ChildEvent::ToolUse {
                name: call.function.name.clone(),
                input: serde_json::from_str::<Value>(&call.function.arguments)
                    .unwrap_or(Value::Null),
            });
            let (output, is_error) = executor.execute(&call.function.name, {
                serde_json::from_str::<Value>(&call.function.arguments).unwrap_or(Value::Null)
            }).await;
            sink.emit(ChildEvent::ToolResult {
                name: call.function.name.clone(),
                output: output.clone(),
                is_error,
            });
            let tool_msg = ChatMessage {
                role: "tool".into(),
                content: json!(output),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: Some(call.id.clone()),
            };
            messages.push(tool_msg.clone());
            transcript.append(to_entry(&tool_msg));
        }

        // compaction 检查（§8）
        if let Err(e) = maybe_compact(store, http, &params, &mut messages, transcript).await {
            tracing::warn!("子代理上下文压缩失败（忽略，继续运行）：{e}");
        }
    }
}

// ─── 上游调用与 SSE 消费 ────────────────────────────────────────────────────

struct AssistantAccum {
    message: ChatMessage,
    usage: Option<UsageInfo>,
}

async fn call_upstream(
    http: &Client,
    endpoint: &str,
    api_key: &str,
    model_id: &str,
    messages: &[ChatMessage],
    temperature: Option<f32>,
    tools: &[ToolDefinition],
    sink: &mut dyn EventSink,
) -> Result<AssistantAccum, SubagentError> {
    #[derive(serde::Serialize)]
    struct StreamOptions {
        include_usage: bool,
    }
    #[derive(serde::Serialize)]
    struct Payload<'a> {
        model: &'a str,
        messages: &'a [ChatMessage],
        stream: bool,
        stream_options: StreamOptions,
        #[serde(skip_serializing_if = "Option::is_none")]
        temperature: Option<f32>,
        tools: &'a [ToolDefinition],
    }

    let payload = Payload {
        model: model_id,
        messages,
        stream: true,
        stream_options: StreamOptions { include_usage: true },
        temperature,
        tools,
    };

    let mut attempt: u32 = 0;
    let resp = loop {
        let result = tokio::time::timeout(
            UPSTREAM_CONNECT_TIMEOUT,
            http.post(endpoint).bearer_auth(api_key).json(&payload).send(),
        )
        .await;
        match result {
            Ok(Ok(resp)) => break resp,
            Ok(Err(e)) => {
                tracing::warn!("子代理上游请求失败：{e}");
                if attempt < MAX_RETRIES {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
                    continue;
                }
                return Err(SubagentError::new(
                    super::types::ErrorKind::Internal,
                    format!("上游请求失败：{e}"),
                    e.is_timeout() || e.is_connect(),
                ));
            }
            Err(_) => {
                if attempt < MAX_RETRIES {
                    attempt += 1;
                    continue;
                }
                return Err(SubagentError::new(
                    super::types::ErrorKind::Timeout,
                    "上游建连超时（60s）",
                    true,
                ));
            }
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let cut: String = body.chars().take(512).collect();
        return Err(SubagentError::new(
            super::types::ErrorKind::Internal,
            format!("上游错误 HTTP {status}：{cut}"),
            status.as_u16() == 429 || status.is_server_error(),
        ));
    }

    // SSE 消费：content / reasoning / tool_calls delta / usage
    let mut byte_stream = resp.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut tool_acc: BTreeMap<u32, (String, String, String)> = BTreeMap::new(); // index → (id, name, args)
    let mut usage: Option<UsageInfo> = None;
    let mut finished = false;

    'outer: while let Some(chunk) = byte_stream.next().await {
        let bytes = chunk.map_err(|e| {
            SubagentError::new(
                super::types::ErrorKind::Internal,
                format!("上游流读取失败：{e}"),
                true,
            )
        })?;
        buffer.extend_from_slice(&bytes);
        if buffer.len() > 1024 * 1024 {
            return Err(SubagentError::new(
                super::types::ErrorKind::Internal,
                "上游 SSE 缓冲超限（1MB）",
                false,
            ));
        }
        while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes = buffer[..pos].to_vec();
            buffer.drain(..pos + 1);
            let line = String::from_utf8_lossy(&line_bytes).trim_end_matches('\r').to_string();
            if line.is_empty() {
                continue;
            }
            if line == "data: [DONE]" {
                finished = true;
                break 'outer;
            }
            let Some(json_str) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(json_str) else {
                continue;
            };
            if let Some(u) = value.get("usage").filter(|v| !v.is_null()) {
                if let Ok(parsed) = serde_json::from_value::<UsageInfo>(u.clone()) {
                    usage = Some(parsed);
                }
            }
            let Ok(chunk) = serde_json::from_value::<StreamChunk>(value) else {
                continue;
            };
            for choice in &chunk.choices {
                if let Some(rc) = &choice.delta.reasoning_content {
                    if !rc.is_empty() {
                        reasoning.push_str(rc);
                    }
                }
                if let Some(c) = &choice.delta.content {
                    if !c.is_empty() {
                        content.push_str(c);
                        sink.emit(ChildEvent::TokenDelta { text: c.clone() });
                    }
                }
                if let Some(tcs) = &choice.delta.tool_calls {
                    for tc in tcs {
                        let idx = tc.index.unwrap_or(0);
                        let entry = tool_acc.entry(idx).or_insert_with(|| (String::new(), String::new(), String::new()));
                        if let Some(id) = &tc.id {
                            entry.0 = id.clone();
                        }
                        if let Some(f) = &tc.function {
                            if let Some(n) = &f.name {
                                if !n.is_empty() {
                                    entry.1 = n.clone();
                                }
                            }
                            if let Some(a) = &f.arguments {
                                entry.2.push_str(a);
                            }
                        }
                    }
                }
                if let Some(fr) = &choice.finish_reason {
                    if !fr.is_empty() && fr != "null" && fr.to_lowercase() != "none" {
                        finished = true;
                    }
                }
            }
        }
    }
    let _ = finished;

    let mut tool_calls = Vec::new();
    for (_idx, (id, name, args)) in tool_acc {
        if name.is_empty() {
            continue;
        }
        tool_calls.push(ToolCall {
            id,
            call_type: "function".into(),
            function: ToolCallFunction { name, arguments: args },
        });
    }

    let message = ChatMessage {
        role: "assistant".into(),
        content: if content.is_empty() { json!("") } else { json!(content) },
        reasoning_content: if reasoning.is_empty() { None } else { Some(reasoning) },
        tool_calls: if tool_calls.is_empty() { None } else { Some(tool_calls) },
        tool_call_id: None,
    };

    Ok(AssistantAccum { message, usage })
}

fn to_entry(m: &ChatMessage) -> TranscriptEntry {
    TranscriptEntry {
        role: m.role.clone(),
        content: m.content.clone(),
        reasoning_content: m.reasoning_content.clone(),
        tool_calls: m.tool_calls.as_ref().map(|c| serde_json::to_value(c).unwrap_or(Value::Null)),
        tool_call_id: m.tool_call_id.clone(),
        ts: super::persist::now_ms(),
    }
}

// ─── compaction（§8）───────────────────────────────────────────────────────

async fn maybe_compact(
    store: &ConfigStore,
    http: &Client,
    params: &LoopParams,
    messages: &mut Vec<ChatMessage>,
    transcript: &mut Transcript,
) -> Result<(), String> {
    let estimated = estimate_tokens_messages(messages);
    let threshold = (params.context_window_tokens as f64 * PRUNE_THRESHOLD_RATIO) as u64;
    if estimated <= threshold {
        return Ok(());
    }

    // 保留 system + 摘要 + 最近 PRUNE_PROTECT_TOKENS 的逐字消息
    let system = messages.first().cloned();
    let body: Vec<ChatMessage> = messages.iter().skip(1).cloned().collect();

    // 从尾部往前保留 verbatim
    let mut keep: Vec<ChatMessage> = Vec::new();
    let mut kept_tokens = 0u64;
    let mut split_idx = body.len();
    for (i, m) in body.iter().rev().enumerate() {
        let t = estimate_tokens_message(m);
        if kept_tokens + t > PRUNE_PROTECT_TOKENS && !keep.is_empty() {
            split_idx = body.len() - i;
            break;
        }
        kept_tokens += t;
        keep.push(m.clone());
    }
    if split_idx >= body.len() {
        // 全部保留也不超保护窗口（理论上到不了这里，因为 estimated > threshold）
        return Ok(());
    }
    let old = &body[..split_idx];
    let recent: Vec<ChatMessage> = body[split_idx..].to_vec();
    let removed = old.len();

    // 早于该点的消息由 LLM 生成摘要
    let summary = summarize(store, http, params, old).await?;

    let mut next = Vec::new();
    if let Some(sys) = &system {
        next.push(sys.clone());
    }
    next.push(ChatMessage {
        role: "summary".into(),
        content: json!(summary),
        reasoning_content: None,
        tool_calls: None,
        tool_call_id: None,
    });
    next.extend(recent);

    // 若摘要后仍 > PRUNE_MINIMUM，从最早的消息继续丢弃直到满足（§8）
    while estimate_tokens_messages(&next) > PRUNE_MINIMUM_TOKENS && next.len() > 2 {
        let before = next.len();
        // 丢弃 summary 之后最早的一条非 system 消息
        next.remove(1);
        let _ = before;
    }

    let added_summary = true;
    *messages = next;
    transcript.record_compaction(removed, added_summary);
    Ok(())
}

fn estimate_tokens_message(m: &ChatMessage) -> u64 {
    let mut total = 0u64;
    if let Some(s) = m.content.as_str() {
        total += estimate_tokens_text(s);
    } else {
        total += estimate_tokens_text(&m.content.to_string());
    }
    if let Some(rc) = &m.reasoning_content {
        total += estimate_tokens_text(rc);
    }
    if let Some(calls) = &m.tool_calls {
        total += estimate_tokens_text(&serde_json::to_string(calls).unwrap_or_default());
    }
    total
}

fn estimate_tokens_messages(messages: &[ChatMessage]) -> u64 {
    messages.iter().map(estimate_tokens_message).sum()
}

/// 压缩摘要：由 LLM 生成一段 summary（无工具调用）。
async fn summarize(
    store: &ConfigStore,
    http: &Client,
    params: &LoopParams,
    old: &[ChatMessage],
) -> Result<String, String> {
    let (provider, _model) = store
        .find_model(params.provider_id.as_deref(), &params.model_id)
        .await
        .ok_or("模型未找到")?;
    let endpoint = format!("{}/chat/completions", provider.base_url.trim_end_matches('/'));

    let mut dump = String::new();
    for m in old {
        dump.push_str(&format!("[{}]", m.role));
        if let Some(s) = m.content.as_str() {
            dump.push_str(s);
        }
        dump.push('\n');
    }
    // 摘要输入也做截断保护（最长 60k 字符）
    let dump: String = dump.chars().take(60_000).collect();

    #[derive(serde::Serialize)]
    struct Payload {
        model: String,
        messages: Vec<ChatMessage>,
        stream: bool,
    }
    let payload = Payload {
        model: params.model_id.clone(),
        messages: vec![
            ChatMessage {
                role: "system".into(),
                content: json!("你是会话压缩器。把以下对话历史压缩成一段简洁的中文摘要，保留：任务目标、已完成的工作（含文件路径与关键结论）、未完成的步骤、重要的工具结果。直接输出摘要正文。"),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".into(),
                content: json!(dump),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            },
        ],
        stream: false,
    };

    let resp = tokio::time::timeout(
        Duration::from_secs(60),
        http.post(&endpoint)
            .bearer_auth(&provider.api_key)
            .json(&payload)
            .send(),
    )
    .await
    .map_err(|_| "摘要请求超时".to_string())?
    .map_err(|e| format!("摘要请求失败：{e}"))?;

    if !resp.status().is_success() {
        return Err(format!("摘要请求 HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("摘要响应解析失败：{e}"))?;
    let text = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("（摘要生成失败，早前历史已省略）")
        .to_string();
        Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_estimation() {
        assert!(estimate_tokens_text("abcd") >= 1);
        let entries = vec![TranscriptEntry {
            role: "user".into(),
            content: Value::String("x".repeat(400)),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
            ts: 0,
        }];
        assert!(crate::subagent::persist::estimate_tokens_entries(&entries) >= 100);
    }
}
