//! 上下文策略引擎（设计稿 §9）。
//!
//! 优先级：resume_from > fork_context > 空上下文（默认）。

use std::path::Path;

use serde_json::{json, Value};

use crate::provider::ChatMessage;

use super::child::ChildDeps;
use super::persist::copy_session_data;
use super::protocol::SpawnParams;
use super::registry::render_template_prompt;
use super::types::{SubagentError, ToolSpec};

/// fork 逐字保留轮次上限（§9.3）
pub const MAX_VERBATIM_TURNS: usize = 10;

/// 构建初始消息序列（不含 system prompt——由 LLM 循环注入）。
/// 返回 (messages, context_window_tokens)。
pub async fn build_initial_messages(
    deps: &ChildDeps,
    spawn: &SpawnParams,
    _tools: &[ToolSpec],
) -> Result<(Vec<ChatMessage>, u64), SubagentError> {
    let context_window = resolve_context_window(deps, spawn);

    // 9.2 resume_from：复制源 transcript，从最后一条助手消息继续
    if let Some(source_id) = &spawn.resume_from {
        let entries = copy_session_data(
            Path::new(&spawn.data_dir),
            source_id,
            &spawn.task_id,
            context_window,
        )?;
        let mut messages: Vec<ChatMessage> = Vec::new();
        for e in &entries {
            if e.role == "system" || e.role == "compaction" {
                continue; // system 由本次循环重新注入
            }
            if e.role == "summary" {
                messages.push(ChatMessage {
                    role: "system".into(),
                    content: json!(format!("[前期会话摘要]\n{}", content_str(&e.content))),
                    reasoning_content: None,
                    tool_calls: None,
                    tool_call_id: None,
                });
                continue;
            }
            messages.push(entry_to_message(e));
        }
        // 追加新任务 prompt 作为继续指令
        messages.push(ChatMessage {
            role: "user".into(),
            content: json!(format!(
                "[续跑指令] 之前的任务被中断。现在继续：\n{}",
                spawn.prompt
            )),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        });
        return Ok((messages, context_window));
    }

    // 9.3 fork_context（仅内部 spawner）：摘要 + 逐字轮次作为前缀
    let prefix = spawn
        .fork_context
        .as_ref()
        .map(|f| format!("<background_context>\n{f}\n</background_context>\n\n"))
        .unwrap_or_default();

    // 9.1 空上下文（默认）
    let user_content = format!("{prefix}{}", spawn.prompt);
    Ok((
        vec![ChatMessage {
            role: "user".into(),
            content: json!(user_content),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        }],
        context_window,
    ))
}

/// system prompt 渲染（§9.1 顺序）：
/// 类型模板（含工具说明）→ 定义 prompt 覆盖 → skills 预载 → 深度提示 → AGENTS.md。
pub async fn render_system_prompt(
    spawn: &SpawnParams,
    tools: &[ToolSpec],
    _deps: &ChildDeps,
) -> String {
    let def = &spawn.agent_definition;

    // 1. 类型模板（含工具说明）
    let tools_value = json!(
        tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description }))
            .collect::<Vec<_>>()
    );
    let mut prompt = render_template_prompt(&def.prompt_template, &tools_value);

    // 2. 定义中的 prompt 覆盖（追加；模板作为基础人格保留）
    if let Some(extra) = &def.prompt {
        prompt.push_str("\n\n");
        prompt.push_str(extra);
    }

    // 3. skills 预载（仅桌面端且定义声明）
    if let Some(skills) = &def.skills {
        if let Some(svc) = _deps.skill_service.as_ref() {
            for name in skills {
                match svc.build_reference_injection(name).await {
                    Ok(content) => {
                        prompt.push_str(&format!("\n\n<skill_content-{name}>\n{content}\n</skill_content-{name}>"));
                    }
                    Err(_) => {
                        tracing::warn!("子代理 skill 预载失败：{name}");
                    }
                }
            }
        }
    }

    // 4. 深度提示（仅 allow_model_depth_hint=true 时；模板统一处理，§15.2）
    // 深度提示由父侧决定是否启用；此处仅当 spawn.depth < max 时可提示可嵌套
    // （子代理内的 task 工具剥除逻辑已在 build_child_tools 完成，
    //  提示词注入由 coordinator 在 allow_model_depth_hint=true 时追加）。

    // 5. AGENTS.md（仅 omit_claude_md=false）
    if !def.omit_claude_md {
        let agents_md = Path::new(&spawn.cwd).join("AGENTS.md");
        if let Ok(content) = tokio::fs::read_to_string(&agents_md).await {
            let trimmed: String = content.chars().take(20_000).collect();
            prompt.push_str("\n\n## Project Instructions (AGENTS.md)\n");
            prompt.push_str(&trimmed);
        }
    }

    // 子代理硬约束
    prompt.push_str(
        "\n\n## Subagent Constraints\n\
         - You are a subagent: your context is isolated; do not ask the user questions directly (AskUserQuestion is unavailable).\n\
         - Execute tools strictly one at a time, in order.\n\
         - When the task is complete, output your final report as plain text.",
    );

    prompt
}

/// fork 摘要继承（§9.3）：近期轮次逐字 + 早期轮次摘要。
/// 仅内部 spawner（workflow / harness）使用；模型不可触发。
pub fn normalize_forked_context(
    parent: &[ChatMessage],
    summary: &str,
    max_verbatim: usize,
) -> String {
    // 「轮」= 用户+助手消息对；从尾部往前取 max_verbatim 轮的逐字内容
    let mut verbatim: Vec<&ChatMessage> = Vec::new();
    let mut user_count = 0usize;
    for m in parent.iter().rev() {
        if m.role == "user" {
            user_count += 1;
            if user_count > max_verbatim {
                // 该轮超出配额：连同本轮已入栈的助手消息一并丢弃
                if verbatim.last().map(|m| m.role == "assistant").unwrap_or(false) {
                    verbatim.pop();
                }
                break;
            }
        }
        verbatim.push(m);
    }
    verbatim.reverse();

    let mut out = String::new();
    out.push_str("[前期会话摘要]\n");
    out.push_str(summary);
    out.push_str("\n\n[近期对话（逐字）]\n");
    for m in verbatim {
        let content = m
            .content
            .as_str()
            .map(String::from)
            .unwrap_or_else(|| m.content.to_string());
        let text: String = content.chars().take(4_000).collect();
        out.push_str(&format!("[{}]: {}\n", m.role, text));
    }
    out
}

// ─── 辅助 ──────────────────────────────────────────────────────────────────

fn content_str(v: &Value) -> String {
    v.as_str()
        .map(String::from)
        .unwrap_or_else(|| v.to_string())
}

fn entry_to_message(e: &super::persist::TranscriptEntry) -> ChatMessage {
    ChatMessage {
        role: if e.role == "summary" { "system".into() } else { e.role.clone() },
        content: e.content.clone(),
        reasoning_content: e.reasoning_content.clone(),
        tool_calls: e
            .tool_calls
            .as_ref()
            .and_then(|v| serde_json::from_value::<Vec<crate::provider::ToolCall>>(v.clone()).ok()),
        tool_call_id: e.tool_call_id.clone(),
    }
}

/// 解析 token 窗口：模型/供应商 input_context_window（单位 k）→ tokens。
fn resolve_context_window(deps: &ChildDeps, spawn: &SpawnParams) -> u64 {
    let _ = deps;
    // 默认 128k（与 chat.rs 的估算一致）；后续可从模型配置精确解析
    let base: u64 = 128 * 1024;
    let _ = spawn;
    base
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::ChatMessage;

    fn msg(role: &str, content: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: json!(content),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        }
    }

    #[test]
    fn fork_context_keeps_recent_verbatim() {
        let parent: Vec<ChatMessage> = (0..30)
            .map(|i| {
                if i % 2 == 0 {
                    msg("user", &format!("u{i}"))
                } else {
                    msg("assistant", &format!("a{i}"))
                }
            })
            .collect();
        let out = normalize_forked_context(&parent, "早期摘要", 3);
        // 3 轮 = 6 条消息逐字
        assert!(out.contains("a29"));
        assert!(out.contains("u24"));
        assert!(!out.contains("a23"));
        assert!(out.contains("[前期会话摘要]"));
    }

    #[test]
    fn template_render_contains_tools() {
        let tools = json!([{ "name": "Read", "description": "read file" }]);
        let s = render_template_prompt(&super::super::types::PromptTemplate::Explore, &tools);
        assert!(s.contains("read-only"));
        assert!(s.contains("Read"));
    }
}
