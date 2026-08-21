//! Agent 注册表（设计稿 §5）：加载链 builtin → project → plugin，同名全量替换。

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use super::types::{
    AgentDefinition, AgentMode, CapabilityMode, Isolation, PermissionEffect, PromptTemplate,
    Rule, Ruleset,
};

#[derive(Debug, Clone, PartialEq)]
pub enum AgentLookupError {
    UnknownAgentType(String),
    NotSubagent(String),
}

impl std::fmt::Display for AgentLookupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AgentLookupError::UnknownAgentType(name) => {
                write!(f, "未知的子代理类型：{name}")
            }
            AgentLookupError::NotSubagent(name) => {
                write!(f, "agent「{name}」不是子代理类型（mode=Primary 不能被 task 工具选中）")
            }
        }
    }
}

#[derive(Default)]
pub struct AgentRegistry {
    /// builtin：编译期内嵌 3 类
    builtin: HashMap<String, AgentDefinition>,
    /// project：工作区 .claude/agents/*.md
    project: HashMap<String, AgentDefinition>,
    /// plugin：数据目录 plugins/*/agents/*.md
    plugin: HashMap<String, AgentDefinition>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        let mut builtin = HashMap::new();
        for def in [
            AgentDefinition::builtin_general_purpose(),
            AgentDefinition::builtin_explore(),
            AgentDefinition::builtin_plan(),
        ] {
            builtin.insert(def.name.clone(), def);
        }
        Self {
            builtin,
            project: HashMap::new(),
            plugin: HashMap::new(),
        }
    }

    /// 扫描项目目录与插件目录（§5 加载链）。非法定义跳过并告警，不阻断。
    pub fn load_from_disk(&mut self, workspace_root: Option<&Path>, data_dir: &Path) {
        if let Some(root) = workspace_root {
            load_dir(&root.join(".claude").join("agents"), &mut self.project);
        }
        // 插件目录：<data_dir>/plugins/*/agents
        let plugins_dir = data_dir.join("plugins");
        if let Ok(entries) = std::fs::read_dir(&plugins_dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    let agents_dir = entry.path().join("agents");
                    if agents_dir.is_dir() {
                        load_dir(&agents_dir, &mut self.plugin);
                    }
                }
            }
        }
    }
}

fn load_dir(dir: &Path, into: &mut HashMap<String, AgentDefinition>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        match parse_agent_md(&content) {
            Ok(Some(def)) => {
                // schema 校验（§5）：name 非空；mode 合法由 serde 保证；
                // 工具名存在性在 build_child_tools 时自然过滤（未知工具名无匹配项）
                if def.name.is_empty() {
                    tracing::warn!("跳过非法 agent 定义（name 为空）：{}", path.display());
                    continue;
                }
                tracing::info!("加载 agent 定义：{} ({})", def.name, path.display());
                into.insert(def.name.clone(), def);
            }
            Ok(None) => {
                tracing::warn!("跳过无 frontmatter 的 agent 文件：{}", path.display());
            }
            Err(e) => {
                tracing::warn!("跳过非法 agent 定义（{e}）：{}", path.display());
            }
        }
    }
}

impl AgentRegistry {
    /// 查找顺序：plugin > project > builtin（§5）。
    pub fn lookup(&self, name: &str) -> Result<&AgentDefinition, AgentLookupError> {
        if let Some(d) = self.plugin.get(name) {
            return self.check_mode(d);
        }
        if let Some(d) = self.project.get(name) {
            return self.check_mode(d);
        }
        if let Some(d) = self.builtin.get(name) {
            return self.check_mode(d);
        }
        Err(AgentLookupError::UnknownAgentType(name.to_string()))
    }

    fn check_mode<'a>(
        &self,
        def: &'a AgentDefinition,
    ) -> Result<&'a AgentDefinition, AgentLookupError> {
        if def.mode == AgentMode::Primary {
            return Err(AgentLookupError::NotSubagent(def.name.clone()));
        }
        Ok(def)
    }

    /// 门控：allowed_subagent_types 白名单（None = 全允许）。
    pub fn is_allowed(&self, name: &str, allowed: Option<&std::collections::HashSet<String>>) -> bool {
        match allowed {
            None => true,
            Some(set) => set.contains(name),
        }
    }

    /// 供 task 工具描述注入：非 hidden 的 agent 列表。
    pub fn visible_agents(&self) -> Vec<&AgentDefinition> {
        let mut out = Vec::new();
        for map in [&self.plugin, &self.project, &self.builtin] {
            for def in map.values() {
                if !def.hidden && !out.iter().any(|d: &&AgentDefinition| d.name == def.name) {
                    out.push(def);
                }
            }
        }
        out
    }

    pub fn all_names(&self) -> Vec<String> {
        self.visible_agents().into_iter().map(|d| d.name.clone()).collect()
    }
}

/// 解析 agent 定义 markdown：frontmatter（yaml）+ 正文 prompt。
/// 返回 Ok(None) 表示没有 frontmatter。
pub fn parse_agent_md(content: &str) -> anyhow::Result<Option<AgentDefinition>> {
    let trimmed = content.trim_start();
    let Some(rest) = trimmed.strip_prefix("---") else {
        return Ok(None);
    };
    let Some(end) = rest.find("\n---") else {
        return Ok(None);
    };
    let frontmatter = &rest[..end];
    let body = rest[end + 4..].trim();

    let docs = yaml_rust2::YamlLoader::load_from_str(frontmatter)?;
    let Some(doc) = docs.first() else {
        return Ok(None);
    };
    let Some(map) = doc.as_hash() else {
        return Ok(None);
    };

    let get = |key: &str| -> Option<&str> {
        map.get(&yaml_rust2::Yaml::String(key.to_string()))
            .and_then(|v| v.as_str())
    };
    let get_vec = |key: &str| -> Option<Vec<String>> {
        map.get(&yaml_rust2::Yaml::String(key.to_string()))
            .and_then(|v| v.as_vec())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.as_str().map(String::from))
                    .collect()
            })
    };

    let name = get("name").unwrap_or_default().to_string();
    if name.is_empty() {
        anyhow::bail!("name 字段缺失");
    }

    let prompt_template = match get("prompt_template").unwrap_or("custom") {
        "general_purpose" | "general-purpose" => PromptTemplate::GeneralPurpose,
        "explore" => PromptTemplate::Explore,
        "plan" => PromptTemplate::Plan,
        _ => {
            // 内置类型的模板继承：与内置同名时沿用其模板
            match name.as_str() {
                "general-purpose" => PromptTemplate::GeneralPurpose,
                "explore" => PromptTemplate::Explore,
                "plan" => PromptTemplate::Plan,
                _ => PromptTemplate::Custom,
            }
        }
    };

    let mode = match get("mode").unwrap_or("subagent") {
        "primary" => AgentMode::Primary,
        "all" => AgentMode::All,
        _ => AgentMode::Subagent,
    };

    let capability_mode = get("capability_mode").and_then(CapabilityMode::parse);
    let isolation = match get("isolation").unwrap_or("none") {
        "worktree" => Some(Isolation::Worktree),
        _ => None,
    };

    // permission：三态规则 map（{tool: allow|ask|deny}）
    let permission = map
        .get(&yaml_rust2::Yaml::String("permission".into()))
        .and_then(|v| v.as_hash())
        .map(|h| {
            let mut rs = Ruleset::default();
            for (k, v) in h {
                let Some(pattern) = k.as_str() else { continue };
                let Some(effect_str) = v.as_str() else { continue };
                let effect = match effect_str {
                    "allow" => PermissionEffect::Allow,
                    "deny" => PermissionEffect::Deny,
                    _ => PermissionEffect::Ask,
                };
                rs.append(Rule {
                    pattern: pattern.to_string(),
                    effect,
                });
            }
            rs
        });

    let mut def = AgentDefinition {
        name,
        description: get("description").unwrap_or_default().to_string(),
        prompt: if body.is_empty() { None } else { Some(body.to_string()) },
        prompt_template,
        mode,
        tools: get_vec("tools"),
        disallowed_tools: get_vec("disallowed_tools").unwrap_or_default(),
        model: get("model").map(String::from),
        capability_mode,
        permission,
        background: get("background").and_then(|v| v.parse().ok()),
        isolation,
        omit_claude_md: get("omit_claude_md").and_then(|v| v.parse().ok()).unwrap_or(false),
        max_turns: get("max_turns").and_then(|v| v.parse().ok()),
        effort: get("effort").map(String::from),
        temperature: get("temperature").and_then(|v| {
            v.parse::<f32>().ok().or_else(|| v.parse::<f64>().ok().map(|f| f as f32))
        }),
        mcp_servers: get_vec("mcp_servers"),
        hooks: None,
        skills: get_vec("skills"),
        hidden: get("hidden").and_then(|v| v.parse().ok()).unwrap_or(false),
    };
    // description 缺省回退到正文首行
    if def.description.is_empty() {
        def.description = body.lines().next().unwrap_or_default().chars().take(80).collect();
    }
    Ok(Some(def))
}

/// 内置 3 类 prompt 模板（§9.1 渲染顺序第一段）。
pub fn render_template_prompt(template: &PromptTemplate, tools: &Value) -> String {
    let tool_list = serde_json::to_string_pretty(tools).unwrap_or_default();
    match template {
        PromptTemplate::GeneralPurpose => format!(
            r#"You are a general-purpose subagent operating inside Venture. You have your own conversation context and tool set. Complete the task described by the user prompt, using tools as needed.

## Rules
1. Work autonomously until the task is done; report a concise final result.
2. Use tools one at a time and wait for each result before proceeding.
3. Read files before editing them. Keep edits minimal and precise.
4. Your final message is your report — make it self-contained and actionable for the caller.
5. Available tools:
{tool_list}"#
        ),
        PromptTemplate::Explore => format!(
            r#"You are a read-only exploration subagent. You MUST NOT modify any files. Your job is to search, read, and summarize code or documents relevant to the task.

## Rules
1. Use Glob/Grep/Read to locate relevant code, then read enough of it to answer precisely.
2. Report file paths with line numbers for every claim.
3. Be exhaustive but concise: the caller only sees your final message.
4. Available tools:
{tool_list}"#
        ),
        PromptTemplate::Plan => format!(
            r#"You are a read-only planning subagent. Analyze the codebase and produce a structured, step-by-step execution plan for the requested task. You MUST NOT modify any files.

## Rules
1. Investigate the relevant code first (Glob/Grep/Read); ground the plan in real file paths.
2. Output a numbered plan: each step with goal, files touched, and risks.
3. Flag uncertainties and assumptions explicitly.
4. Available tools:
{tool_list}"#
        ),
        PromptTemplate::Custom => format!(
            r#"You are a subagent operating inside Venture. Complete the task described by the user prompt.

Available tools:
{tool_list}"#
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_lookup_order() {
        let reg = AgentRegistry::new();
        assert!(reg.lookup("general-purpose").is_ok());
        assert!(reg.lookup("explore").is_ok());
        assert!(reg.lookup("plan").is_ok());
        assert!(matches!(
            reg.lookup("nope"),
            Err(AgentLookupError::UnknownAgentType(_))
        ));
    }

    #[test]
    fn parse_agent_md_full() {
        let md = r#"---
name: reviewer
description: 代码审查
capability_mode: read_only
tools:
  - Read
  - Grep
permission:
  spawn_agent: deny
---
你是审查员。"#;
        let def = parse_agent_md(md).unwrap().unwrap();
        assert_eq!(def.name, "reviewer");
        assert_eq!(def.capability_mode, Some(CapabilityMode::ReadOnly));
        assert_eq!(def.tools, Some(vec!["Read".into(), "Grep".into()]));
        assert!(def.prompt.is_some());
        let rs = def.permission.unwrap();
        assert_eq!(rs.decide("spawn_agent"), PermissionEffect::Deny);
    }
}
