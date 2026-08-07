//! SkillAnnouncer：可选公告构建（规格书 §7.1，默认关闭）。

use super::loader::truncate_chars;
use super::settings::BudgetSettings;
use super::types::SkillInfo;

/// XML 属性值转义（§8.3：仅标签属性值做 XML 转义）。
pub fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// 构建公告文本（§7.1 预算算法）。
/// `context_tokens`：当前模型上下文窗口 token 数。
/// `is_android`：Android 端优先使用 androidMaxTokens 覆盖。
/// 返回空串表示不注入。
pub fn build_announcement(
    infos: &[SkillInfo],
    context_tokens: u32,
    budget: &BudgetSettings,
    is_android: bool,
) -> String {
    if !budget.announcement_enabled {
        return String::new();
    }
    let budget_chars = if is_android {
        budget
            .android_max_tokens
            .map(|t| (t as usize) * 4) // token→字符粗估
            .unwrap_or_else(|| (context_tokens as f64 * budget.announcement_percent) as usize)
    } else {
        (context_tokens as f64 * budget.announcement_percent) as usize
    };

    // 排序：scope 升序（项目 > 全局 > 插件 > mcp）→ name 升序
    let mut rest: Vec<&SkillInfo> = infos.iter().collect();
    rest.sort_by(|a, b| {
        a.scope
            .cmp(&b.scope)
            .then_with(|| a.canonical_name.cmp(&b.canonical_name))
    });

    let mut out = String::new();
    for s in rest {
        let line = format!(
            "<skill name=\"{}\" description=\"{}\" when-to-use=\"{}\"/>",
            escape_xml_attr(&s.canonical_name),
            escape_xml_attr(&truncate_chars(&s.description, budget.per_entry_chars)),
            escape_xml_attr(&truncate_chars(&s.when_to_use, 50)),
        );
        if out.len() + line.len() + 1 > budget_chars {
            break;
        }
        out.push_str(&line);
        out.push('\n');
    }
    if out.is_empty() {
        return String::new();
    }
    format!(
        "<system-reminder>\nThe following skills are available for use with the load_skill tool:\n<available_skills>\n{out}</available_skills>\n</system-reminder>"
    )
}
