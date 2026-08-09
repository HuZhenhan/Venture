//! 内置脚本（DSL 规格书 §8 示例，只读，可复制为模板）。
//!
//! 当前无内置脚本：原测试用示例（compare_price / place_order / weather_query）
//! 已移除，避免误导 AI 与用户。后续需要正式内置脚本时在此添加。

use super::model::ScriptDef;

pub fn builtin_scripts() -> Vec<ScriptDef> {
    Vec::new()
}
