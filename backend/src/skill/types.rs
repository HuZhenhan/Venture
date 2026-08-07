//! Skill 系统核心数据类型（规格书 §1/§3.1）。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 作用域（规格书 §1 作用域表）。数值越小优先级越高。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// 项目级（仅桌面端）
    Project = 0,
    /// 全局级（个人 + managed 策略 + extra + 内置只读）
    Global = 1,
    /// 插件级（保留接口，当前无数据源）
    Plugin = 2,
    /// MCP 级（保留接口，未启用）
    Mcp = 3,
}

impl Scope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Scope::Project => "project",
            Scope::Global => "global",
            Scope::Plugin => "plugin",
            Scope::Mcp => "mcp",
        }
    }

    /// UI 展示用中文标签
    pub fn label(&self) -> &'static str {
        match self {
            Scope::Project => "项目",
            Scope::Global => "全局",
            Scope::Plugin => "插件",
            Scope::Mcp => "mcp",
        }
    }
}

fn default_version() -> String {
    "0.0.1".to_string()
}
fn default_true() -> bool {
    true
}

/// Skill 元信息（规格书 §3.1 SkillInfo）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// 唯一名（含命名空间 / 冲突递增后缀）
    pub canonical_name: String,
    /// 原始 frontmatter name
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub when_to_use: String,
    #[serde(default = "default_version")]
    pub version: String,
    pub scope: Scope,
    /// SKILL.md 绝对路径
    pub location: String,
    /// paths 条件激活（惰性计算，不落库）
    #[serde(default)]
    pub active: bool,
    /// 用户是否启用
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// AI 自主调用开关（§4.2）
    #[serde(default)]
    pub auto_invocable: bool,
    /// 是否注册为用户可“引用”（§4.2）
    #[serde(default = "default_true")]
    pub user_invocable: bool,
    /// paths 条件激活 globs（§11）
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    /// 透出的完整 frontmatter（含未知字段）
    #[serde(default)]
    pub frontmatter: Map<String, Value>,
    /// 跨层遮蔽标记：被哪个更高优先级 scope 遮蔽（仅 UI 角标用）
    #[serde(default)]
    pub shadowed_by: Option<String>,
    /// 内置只读（Android assets 并入全局层）
    #[serde(default)]
    pub bundled: bool,
}

/// 完整 Skill（含正文）。
#[derive(Debug, Clone)]
pub struct Skill {
    pub info: SkillInfo,
    /// 模板变量未展开的正文
    pub body: String,
}

/// 解析/加载错误（规格书 §13），不抛出，记录后在管理页展示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLoadError {
    pub location: String,
    /// ERR_* 错误码（§13）
    pub code: String,
    pub message: String,
}

impl SkillLoadError {
    pub fn new(location: impl Into<String>, code: &str, message: impl Into<String>) -> Self {
        Self {
            location: location.into(),
            code: code.to_string(),
            message: message.into(),
        }
    }
}
