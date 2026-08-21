//! 工具快照（设计稿 §4 快照注入 / §11.3）。
//!
//! spawn 时一次性注入 tools_snapshot（工具清单：name/description/input_schema/kind）。
//! 快照是值的拷贝，子代理运行期间父会话增删工具不影响已 spawn 的子代理。

use once_cell::sync::Lazy;

use super::types::{ToolKind, ToolSpec};

/// 当前父会话工具快照（含全部注册工具）。
/// Venture 当前无 MCP 与 --tools 命令行限制；快照 = get_tools_schema 全集。
pub fn current() -> Vec<ToolSpec> {
    static SNAPSHOT: Lazy<Vec<ToolSpec>> = Lazy::new(|| {
        crate::tools::get_tools_schema()
            .into_iter()
            .map(|t| ToolSpec {
                name: t.function.name.clone(),
                description: t.function.description.clone(),
                input_schema: t.function.parameters.clone(),
                kind: ToolKind::of(&t.function.name),
            })
            .collect()
    });
    SNAPSHOT.clone()
}

/// 供测试与 schema 校验：工具名集合。
pub fn tool_names() -> Vec<String> {
    current().iter().map(|t| t.name.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_core_tools() {
        let names = tool_names();
        assert!(names.contains(&"Read".to_string()));
        assert!(names.contains(&"Write".to_string()));
        assert!(names.contains(&"spawn_agent".to_string()));
        assert!(names.contains(&"get_agent_output".to_string()));
    }

    #[test]
    fn kind_classification() {
        let snap = current();
        let find = |n: &str| snap.iter().find(|t| t.name == n).unwrap().kind;
        assert_eq!(find("Read"), ToolKind::ReadOnly);
        assert_eq!(find("Write"), ToolKind::Write);
        assert_eq!(find("spawn_agent"), ToolKind::Scheduler);
    }

    #[test]
    fn snapshot_is_value_copy() {
        // 值拷贝语义：clone 后修改不影响原快照
        let mut a = current();
        let b = a.clone();
        a.clear();
        assert!(!b.is_empty());
    }
}
