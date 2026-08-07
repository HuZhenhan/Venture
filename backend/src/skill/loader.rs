//! SkillLoader：SKILL.md 解析与校验（规格书 §4）。
//!
//! 校验流程（§4.4，顺序执行，任一失败 → 返回 Err，由调用方记录日志并跳过）：
//! 1. 文件 >10MB → ERR_TOO_LARGE
//! 2. 无 frontmatter → ERR_NO_FRONTMATTER
//! 3. YAML 解析失败 → ERR_YAML
//! 4. 逐字段校验 → ERR_*（name 与目录名比对仅 compat 目录外执行）
//! 5. 控制字符 → ERR_CTRL_CHAR

use std::path::Path;

use regex::Regex;
use serde_json::{Map, Value};

use super::types::{Scope, SkillInfo, SkillLoadError};

/// SKILL.md 大小上限 10MB（§4.4）
const MAX_SKILL_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// metadata 字段大小上限 4KB（§4.2）
const MAX_METADATA_BYTES: usize = 4 * 1024;

fn name_regex() -> Regex {
    Regex::new(r"^[a-z0-9]+(-[a-z0-9]+)*$").unwrap()
}
fn version_regex() -> Regex {
    Regex::new(r"^\d+\.\d+\.\d+$").unwrap()
}

/// yaml-rust2 Yaml → serde_json::Value 转换。
fn yaml_to_json(y: &yaml_rust2::Yaml) -> Value {
    use yaml_rust2::Yaml;
    match y {
        Yaml::Real(s) => s
            .parse::<f64>()
            .map(Value::from)
            .unwrap_or_else(|_| Value::String(s.clone())),
        Yaml::Integer(i) => Value::from(*i),
        Yaml::String(s) => Value::String(s.clone()),
        Yaml::Boolean(b) => Value::from(*b),
        Yaml::Array(arr) => Value::Array(arr.iter().map(yaml_to_json).collect()),
        Yaml::Hash(h) => {
            let mut map = Map::new();
            for (k, v) in h.iter() {
                let key = match k {
                    Yaml::String(s) => s.clone(),
                    other => yaml_to_json(other).to_string(),
                };
                map.insert(key, yaml_to_json(v));
            }
            Value::Object(map)
        }
        Yaml::Alias(_) | Yaml::Null | Yaml::BadValue => Value::Null,
    }
}

/// 从 SKILL.md 全文分离 frontmatter 与正文。
/// 返回 (frontmatter_yaml_text, body)。无 frontmatter → None。
fn split_frontmatter(content: &str) -> Option<(String, String)> {
    let mut lines = content.lines();
    let first = lines.next()?;
    if first.trim() != "---" {
        return None;
    }
    let mut fm = String::new();
    let mut rest = String::new();
    let mut in_fm = true;
    for line in lines {
        if in_fm && line.trim() == "---" {
            in_fm = false;
            continue;
        }
        if in_fm {
            fm.push_str(line);
            fm.push('\n');
        } else {
            rest.push_str(line);
            rest.push('\n');
        }
    }
    if in_fm {
        // 未找到闭合 ---
        return None;
    }
    Some((fm, rest))
}

/// 正文首段（description 缺省值来源，§4.2），≤200 字截断。
fn first_paragraph(body: &str) -> String {
    let mut para = String::new();
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            if !para.is_empty() {
                break;
            }
            continue;
        }
        if !para.is_empty() {
            para.push(' ');
        }
        para.push_str(t);
    }
    truncate_chars(&para, 200)
}

pub fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// 解析并校验单个 SKILL.md（§4.4）。
/// 成功返回 (SkillInfo, body)；失败返回 SkillLoadError（调用方记录并跳过）。
/// `allow_name_mismatch`：compat 目录（.claude/.agents/.opencode/.grok 的 skills）为
/// true，跳过 name 与目录名比对，以 frontmatter 的 name 为准。
pub fn parse_skill_file(
    path: &Path,
    scope: Scope,
    bundled: bool,
    allow_name_mismatch: bool,
) -> Result<(SkillInfo, String), SkillLoadError> {
    let loc = path.to_string_lossy().replace('\\', "/");

    // 1. 大小检查
    let meta = std::fs::metadata(path)
        .map_err(|e| SkillLoadError::new(&loc, "ERR_IO", format!("读取文件失败：{e}")))?;
    if meta.len() > MAX_SKILL_FILE_BYTES {
        return Err(SkillLoadError::new(&loc, "ERR_TOO_LARGE", "SKILL.md 超过 10MB"));
    }

    let raw = std::fs::read(path)
        .map_err(|e| SkillLoadError::new(&loc, "ERR_IO", format!("读取文件失败：{e}")))?;
    let content = String::from_utf8_lossy(&raw).into_owned();

    // 5. 控制字符检查（除 \n \t \r 外 <0x20；\r 为 CRLF 兼容放行）
    if content.chars().any(|c| (c as u32) < 0x20 && c != '\n' && c != '\t' && c != '\r') {
        return Err(SkillLoadError::new(&loc, "ERR_CTRL_CHAR", "正文含非法控制字符"));
    }

    // 2. frontmatter 分离
    let Some((fm_text, body)) = split_frontmatter(&content) else {
        return Err(SkillLoadError::new(&loc, "ERR_NO_FRONTMATTER", "缺少 YAML frontmatter"));
    };

    // 3. YAML 解析
    let docs = yaml_rust2::YamlLoader::load_from_str(&fm_text)
        .map_err(|e| SkillLoadError::new(&loc, "ERR_YAML", format!("frontmatter YAML 语法错误：{e}")))?;
    let fm_value = docs
        .first()
        .map(yaml_to_json)
        .unwrap_or(Value::Null);
    let Value::Object(fm) = fm_value else {
        return Err(SkillLoadError::new(&loc, "ERR_YAML", "frontmatter 必须是键值映射"));
    };

    // 4. 逐字段校验（§4.2 / §4.3）
    let dir_name = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();

    let name = fm
        .get("name")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| dir_name.clone());
    if name.len() > 64 || !name_regex().is_match(&name) {
        return Err(SkillLoadError::new(
            &loc,
            "ERR_NAME_FORMAT",
            format!("name「{name}」不符合 ^[a-z0-9]+(-[a-z0-9]+)*$ 或超长"),
        ));
    }
    if !allow_name_mismatch && name != dir_name {
        return Err(SkillLoadError::new(
            &loc,
            "ERR_NAME_MISMATCH",
            format!("name「{name}」与目录名「{dir_name}」不一致"),
        ));
    }

    let description = fm
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| first_paragraph(&body));
    if description.chars().count() > 500 {
        return Err(SkillLoadError::new(&loc, "ERR_DESC_TOO_LONG", "description 超过 500 字符"));
    }

    let when_to_use = fm
        .get("when-to-use")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if when_to_use.chars().count() > 100 {
        return Err(SkillLoadError::new(&loc, "ERR_VALIDATION", "when-to-use 超过 100 字符"));
    }

    let version = fm
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.0.1")
        .to_string();
    if !version_regex().is_match(&version) {
        return Err(SkillLoadError::new(
            &loc,
            "ERR_VERSION",
            format!("version「{version}」不是合法 semver"),
        ));
    }

    let auto_invocable = fm
        .get("auto-invocable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if auto_invocable && when_to_use.is_empty() {
        return Err(SkillLoadError::new(
            &loc,
            "ERR_VALIDATION",
            "auto-invocable=true 时 when-to-use 必填",
        ));
    }

    let user_invocable = fm
        .get("user-invocable")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let paths: Option<Vec<String>> = fm.get("paths").and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    });
    if let Some(ps) = &paths {
        if ps.len() > 50 || ps.iter().any(|p| p.len() > 256) {
            return Err(SkillLoadError::new(&loc, "ERR_VALIDATION", "paths 超出条目/长度限制"));
        }
    }

    if let Some(meta_v) = fm.get("metadata") {
        if serde_json::to_string(meta_v).map(|s| s.len()).unwrap_or(0) > MAX_METADATA_BYTES {
            return Err(SkillLoadError::new(&loc, "ERR_VALIDATION", "metadata 超过 4KB"));
        }
    }

    let info = SkillInfo {
        canonical_name: name.clone(),
        name,
        description,
        when_to_use,
        version,
        scope,
        location: loc,
        active: true,
        enabled: true,
        auto_invocable,
        user_invocable,
        paths,
        frontmatter: fm,
        shadowed_by: None,
        bundled,
    };

    Ok((info, body))
}

/// 从原始文件内容中仅拆出正文（resolve 快速路径用；假定已通过校验）。
pub fn extract_body(content: &str) -> String {
    split_frontmatter(content)
        .map(|(_, body)| body)
        .unwrap_or_else(|| content.to_string())
}
