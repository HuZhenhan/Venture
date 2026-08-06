//! Script 定义结构（DSL 规格书 §2 Schema + §12.5 分级）。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScriptSource {
    /// 随应用发布，只读
    Builtin,
    /// 自然语言生成/工作台/录制，可编辑可删除
    User,
    /// 导入的外部 JSON，默认 risky 且禁用
    Shared,
}

impl Default for ScriptSource {
    fn default() -> Self {
        ScriptSource::User
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParamDef {
    pub name: String,
    #[serde(rename = "type", default = "default_param_type")]
    pub param_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub values: Option<Vec<String>>,
    #[serde(default)]
    pub default: Option<Value>,
}

fn default_param_type() -> String {
    "string".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptDef {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub required_permissions: Vec<String>,
    /// true = 执行前必须用户同意（规格书 §4.4 / §9）
    #[serde(default)]
    pub risky: bool,
    #[serde(default = "default_timeout")]
    pub timeout_sec: u64,
    /// 步数上限（防死循环兜底，规格书附录 B：1000）
    #[serde(default = "default_max_steps")]
    pub max_steps: usize,
    #[serde(default)]
    pub params: Vec<ParamDef>,
    #[serde(default)]
    pub result_schema: Option<Value>,
    /// 动作表：异构结构（set/if/repeat/click...），按 op 动态解析
    pub steps: Vec<Value>,
    #[serde(default)]
    pub source: ScriptSource,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub run_count: u64,
}

fn default_version() -> u32 {
    1
}
fn default_timeout() -> u64 {
    180
}
fn default_max_steps() -> usize {
    1000
}
fn default_enabled() -> bool {
    true
}

/// 列表展示用的摘要（list_scripts 返回）
#[derive(Debug, Clone, Serialize)]
pub struct ScriptSummary {
    pub name: String,
    pub description: String,
    pub risky: bool,
    pub enabled: bool,
    pub source: ScriptSource,
    pub run_count: u64,
    pub params_schema: Value,
    pub result_schema: Option<Value>,
}

impl From<&ScriptDef> for ScriptSummary {
    fn from(s: &ScriptDef) -> Self {
        let params_schema = serde_json::json!({
            "type": "object",
            "properties": s.params.iter().map(|p| {
                let mut prop = serde_json::json!({ "type": p.param_type });
                if let Some(d) = &p.description { prop["description"] = serde_json::json!(d); }
                if let Some(v) = &p.values { prop["enum"] = serde_json::json!(v); }
                if let Some(d) = &p.default { prop["default"] = d.clone(); }
                (p.name.clone(), prop)
            }).collect::<serde_json::Map<String, Value>>(),
            "required": s.params.iter().filter(|p| p.required).map(|p| p.name.clone()).collect::<Vec<_>>(),
        });
        ScriptSummary {
            name: s.name.clone(),
            description: s.description.clone(),
            risky: s.risky,
            enabled: s.enabled,
            source: s.source,
            run_count: s.run_count,
            params_schema,
            result_schema: s.result_schema.clone(),
        }
    }
}
