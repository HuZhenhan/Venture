//! 权限规则（设计稿 §11.2）。
//!
//! 三态 Ruleset：allow / ask / deny。
//! 硬性安全默认：`bypass_permissions` 对子代理强制无效（§11.2 末段）。

use super::types::{
    AgentDefinition, ErrorKind, PermissionEffect, Rule, Ruleset, SubagentError,
};

/// 子代理权限规则组装（§11.2 顺序，后者覆盖前者同 pattern）：
/// 1. 父 session 的 deny 规则 + external_directory 规则（整体复制）
/// 2. definition.permission 声明的规则
/// 3. 默认规则：TodoCreate/TodoUpdate/TodoList/TodoGet（todo 类）deny、spawn_agent deny、
///    AskUserQuestion deny（子代理无交互 UI）——除非定义显式声明了允许
pub fn assemble_child_ruleset(parent: &Ruleset, definition: &AgentDefinition) -> Ruleset {
    let mut rs = Ruleset::default();

    // 1. 父规则整体复制（deny 优先复制全部，保留 allow/ask）
    for rule in &parent.rules {
        rs.append(rule.clone());
    }

    // 2. 定义声明
    if let Some(def_rules) = &definition.permission {
        for rule in &def_rules.rules {
            rs.append(rule.clone());
        }
    }

    // 3. 默认规则（显式声明过的会被前面 append 覆盖——append 保留最后一条，
    //    因此这里先检查是否已显式声明）
    let declared = |pattern: &str| {
        parent.rules.iter().any(|r| r.pattern == pattern)
            || definition
                .permission
                .as_ref()
                .map(|p| p.rules.iter().any(|r| r.pattern == pattern))
                .unwrap_or(false)
    };
    for pattern in ["spawn_agent", "AskUserQuestion", "TodoCreate", "TodoUpdate", "TodoList", "TodoGet"] {
        if !declared(pattern) {
            rs.append(Rule {
                pattern: pattern.to_string(),
                effect: PermissionEffect::Deny,
            });
        }
    }

    rs
}

/// bypass_permissions 对子代理强制无效：本函数恒返回 false，
/// 保留调用点以对应设计稿的硬性安全默认。
pub fn bypass_effective_for_subagent(_session_bypass: bool) -> bool {
    false
}

/// 权限校验错误（工具调用被拒）
pub fn permission_denied_error(tool: &str) -> SubagentError {
    SubagentError::new(
        ErrorKind::Internal,
        format!("工具「{tool}」被权限规则拒绝"),
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assemble_default_denies() {
        let def = AgentDefinition::builtin_explore();
        let rs = assemble_child_ruleset(&Ruleset::default(), &def);
        assert_eq!(rs.decide("spawn_agent"), PermissionEffect::Deny);
        assert_eq!(rs.decide("AskUserQuestion"), PermissionEffect::Deny);
        assert_eq!(rs.decide("TodoCreate"), PermissionEffect::Deny);
        // 未声明工具默认 Ask
        assert_eq!(rs.decide("Read"), PermissionEffect::Ask);
    }

    #[test]
    fn definition_overrides_default() {
        let mut def = AgentDefinition::builtin_general_purpose();
        def.permission = Some(Ruleset::new(vec![Rule {
            pattern: "spawn_agent".into(),
            effect: PermissionEffect::Allow,
        }]));
        let rs = assemble_child_ruleset(&Ruleset::default(), &def);
        assert_eq!(rs.decide("spawn_agent"), PermissionEffect::Allow);
    }

    #[test]
    fn parent_deny_inherited() {
        let parent = Ruleset::new(vec![Rule {
            pattern: "Write".into(),
            effect: PermissionEffect::Deny,
        }]);
        let def = AgentDefinition::builtin_general_purpose();
        let rs = assemble_child_ruleset(&parent, &def);
        assert_eq!(rs.decide("Write"), PermissionEffect::Deny);
    }

    #[test]
    fn bypass_never_effective() {
        assert!(!bypass_effective_for_subagent(true));
    }
}
