//! Skill 系统 settings 配置（规格书 §5）。
//!
//! 加载顺序：默认值 → 全局级 → 项目级（深合并，数组整体覆盖）。
//! permission 合并规则见 §9.1（deny 优先，项目级不可放宽全局 deny）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootsSettings {
    /// [Win] 追加发现根（并入全局层）
    #[serde(default)]
    pub extra: Vec<String>,
    #[serde(default)]
    pub disable_default_user: bool,
    /// [Win] 组织策略目录（并入全局层）
    #[serde(default)]
    pub managed: Option<String>,
}

impl Default for RootsSettings {
    fn default() -> Self {
        Self {
            extra: Vec::new(),
            disable_default_user: false,
            managed: None,
        }
    }
}

/// [Win 专用] 兼容目录开关（§5 compat）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatSettings {
    #[serde(default = "default_true")]
    pub claude: bool,
    #[serde(default = "default_true")]
    pub agents: bool,
    #[serde(default = "default_true")]
    pub opencode: bool,
    #[serde(default)]
    pub grok: bool,
    /// 兼容黑名单：skill 的 compatibility 字段命中即跳过（§6.5）
    #[serde(default)]
    pub skip: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl Default for CompatSettings {
    fn default() -> Self {
        Self {
            claude: true,
            agents: true,
            opencode: true,
            grok: false,
            skip: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSettings {
    /// skill 名通配符 → allow/deny/ask
    #[serde(default)]
    pub skill: BTreeMap<String, String>,
    /// allow|deny|ask，缺省 ask
    #[serde(default = "default_mode")]
    pub default_mode: String,
}

fn default_mode() -> String {
    "ask".to_string()
}

impl Default for PermissionSettings {
    fn default() -> Self {
        Self {
            skill: BTreeMap::new(),
            default_mode: default_mode(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetSettings {
    /// 公告默认关闭（§7.1）
    #[serde(default)]
    pub announcement_enabled: bool,
    #[serde(default = "default_announcement_percent")]
    pub announcement_percent: f64,
    #[serde(default = "default_per_entry_chars")]
    pub per_entry_chars: usize,
    /// list_skill 单次返回上限
    #[serde(default = "default_list_limit")]
    pub list_limit: usize,
    /// [Android] 覆盖 percent
    #[serde(default)]
    pub android_max_tokens: Option<u32>,
    /// load_skill 单次注入正文上限（§8.2）
    #[serde(default = "default_max_inject_bytes")]
    pub max_inject_bytes: usize,
    /// agent 预加载总字节上限（§10.2）
    #[serde(default = "default_max_preload_bytes")]
    pub max_preload_bytes: usize,
}

fn default_announcement_percent() -> f64 {
    0.01
}
fn default_per_entry_chars() -> usize {
    250
}
fn default_list_limit() -> usize {
    100
}
fn default_max_inject_bytes() -> usize {
    32768
}
fn default_max_preload_bytes() -> usize {
    65536
}

impl Default for BudgetSettings {
    fn default() -> Self {
        Self {
            announcement_enabled: false,
            announcement_percent: default_announcement_percent(),
            per_entry_chars: default_per_entry_chars(),
            list_limit: default_list_limit(),
            android_max_tokens: None,
            max_inject_bytes: default_max_inject_bytes(),
            max_preload_bytes: default_max_preload_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoggingSettings {
    #[serde(default = "default_log_level")]
    pub level: String,
}

fn default_log_level() -> String {
    "info".to_string()
}

impl Default for LoggingSettings {
    fn default() -> Self {
        Self {
            level: default_log_level(),
        }
    }
}

/// Skill 系统完整 settings（§5 示例结构）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSettings {
    #[serde(default)]
    pub roots: RootsSettings,
    #[serde(default)]
    pub compat: CompatSettings,
    #[serde(default)]
    pub permission: PermissionSettings,
    #[serde(default)]
    pub budget: BudgetSettings,
    #[serde(default)]
    pub logging: LoggingSettings,
}

/// 从磁盘加载单个 settings.json；不存在/解析失败 → None。
pub fn load_settings_file(path: &Path) -> Option<SkillSettings> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<SkillSettings>(&text) {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("skill settings 解析失败 {}：{e}", path.display());
            None
        }
    }
}

/// 合并全局 + 项目 settings（深合并，数组整体覆盖；§5）。
/// permission 合并：取并集，deny 优先（§9.1，项目级无法放宽全局 deny）。
pub fn merge_settings(global: SkillSettings, project: Option<SkillSettings>) -> SkillSettings {
    let Some(proj) = project else { return global };

    // permission：并集，deny > ask > allow
    let proj_default = proj.permission.default_mode.clone();
    let global_default = global.permission.default_mode.clone();
    let mut skill_rules = global.permission.skill.clone();
    for (pattern, value) in proj.permission.skill.iter() {
        skill_rules
            .entry(pattern.clone())
            .and_modify(|existing| {
                *existing = merge_perm_value(existing, value).to_string();
            })
            .or_insert_with(|| value.clone());
    }
    let default_mode = if proj_default != default_mode() {
        proj_default
    } else {
        global_default
    };

    // 其余字段：项目级非默认值覆盖（数组整体覆盖语义近似为“项目级显式配置即覆盖”）
    let proj_json = serde_json::to_value(&proj).unwrap_or(json!({}));
    let mut merged = global;
    if proj_json.pointer("/roots/extra").is_some() {
        merged.roots.extra = proj.roots.extra;
    }
    if proj.roots.disable_default_user {
        merged.roots.disable_default_user = true;
    }
    if proj.roots.managed.is_some() {
        merged.roots.managed = proj.roots.managed;
    }
    merged.compat = proj.compat;
    merged.permission = PermissionSettings {
        skill: skill_rules,
        default_mode,
    };
    merged.budget = proj.budget;
    merged.logging = proj.logging;
    merged
}

fn perm_rank(v: &str) -> u8 {
    match v {
        "deny" => 2,
        "ask" => 1,
        _ => 0,
    }
}

fn merge_perm_value<'a>(a: &'a str, b: &'a str) -> &'a str {
    if perm_rank(a) >= perm_rank(b) {
        a
    } else {
        b
    }
}

/// 原子写 settings.json。
pub fn save_settings_file(path: &Path, settings: &SkillSettings) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut v = serde_json::to_value(settings).unwrap_or(json!({}));
    if let Value::Object(ref mut map) = v {
        map.insert(
            "$schema".to_string(),
            Value::String("https://skillx.dev/schemas/settings.json".to_string()),
        );
        map.insert("version".to_string(), Value::from(1));
    }
    let tmp: PathBuf = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap_or_default())?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}
