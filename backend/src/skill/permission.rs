//! PermissionEngine：skill 级权限（规格书 §9）。
//!
//! 只管辖“skill 能否被加载/引用”；skill 加载后模型的工具调用权限由宿主
//! 自有权限策略统一管辖，与本系统无关。
//!
//! ask 持久化（§9.1）：用户选择“始终允许/始终拒绝”直接写入 settings.json
//! 的 permission 字段；不设独立权限记忆文件。

use super::settings::PermissionSettings;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Allow,
    Deny,
    Ask,
}

impl Permission {
    pub fn as_str(&self) -> &'static str {
        match self {
            Permission::Allow => "allow",
            Permission::Deny => "deny",
            Permission::Ask => "ask",
        }
    }
}

#[derive(Debug, Clone)]
struct Rule {
    pattern: String,
    prefix: bool,
    value: Permission,
}

fn parse_value(v: &str) -> Permission {
    match v {
        "allow" => Permission::Allow,
        "deny" => Permission::Deny,
        _ => Permission::Ask,
    }
}

/// 编译后的规则集（§9.2）：按模式长度降序，最长匹配优先。
#[derive(Debug, Clone)]
pub struct PermissionEngine {
    rules: Vec<Rule>,
    default_mode: Permission,
}

impl PermissionEngine {
    pub fn compile(settings: &PermissionSettings) -> Self {
        let mut rules: Vec<Rule> = settings
            .skill
            .iter()
            .map(|(p, v)| Rule {
                pattern: p.trim_end_matches('*').to_string(),
                prefix: p.ends_with('*'),
                value: parse_value(v),
            })
            .collect();
        rules.sort_by(|a, b| b.pattern.len().cmp(&a.pattern.len()));
        Self {
            rules,
            default_mode: parse_value(&settings.default_mode),
        }
    }

    /// L1 检查（§9.2 checkSkillAccess）。
    pub fn check(&self, canonical_name: &str) -> Permission {
        for r in &self.rules {
            let hit = if r.prefix {
                canonical_name.starts_with(&r.pattern)
            } else {
                canonical_name == r.pattern
            };
            if hit {
                return r.value;
            }
        }
        self.default_mode
    }
}
