//! call(native) 后端原生函数（DSL 规格书 §1：复杂计算下沉后端函数）。
//!
//! DSL 不引入脚本语言——任何"在 DSL 里写会变形的逻辑"一律下沉到这里。
//! 每个函数：入参 Value（对象），返回 Result<Value, String>。

use serde_json::Value;

/// 支持的原生函数名（validate/create_script 白名单提示用）
pub const NATIVE_FUNCTIONS: &[&str] = &[
    "native.regex_extract",
    "native.regex_replace",
    "native.min_by",
    "native.max_by",
    "native.sort_by",
    "native.sum",
    "native.count",
    "native.json_parse",
    "native.join",
    "native.filter_contains",
];

pub fn call_native(name: &str, params: &Value) -> Result<Value, String> {
    match name {
        "native.regex_extract" => {
            let text = params["text"].as_str().unwrap_or_default();
            let pattern = params["pattern"]
                .as_str()
                .ok_or("regex_extract 缺少 pattern")?;
            let group = params["group"].as_u64().unwrap_or(1) as usize;
            let re = regex::Regex::new(pattern).map_err(|e| format!("正则非法: {e}"))?;
            let cap = re
                .captures(text)
                .ok_or_else(|| format!("未匹配: {pattern}"))?;
            Ok(Value::String(
                cap.get(group).map(|m| m.as_str().to_string()).unwrap_or_default(),
            ))
        }
        "native.regex_replace" => {
            let text = params["text"].as_str().unwrap_or_default();
            let pattern = params["pattern"].as_str().ok_or("regex_replace 缺少 pattern")?;
            let replacement = params["replacement"].as_str().unwrap_or_default();
            let re = regex::Regex::new(pattern).map_err(|e| format!("正则非法: {e}"))?;
            Ok(Value::String(re.replace_all(text, replacement).to_string()))
        }
        "native.min_by" | "native.max_by" => {
            let items = params["items"].as_array().ok_or("缺少 items 数组")?;
            let field = params["field"].as_str().ok_or("缺少 field")?;
            let pick_max = name == "native.max_by";
            let mut best: Option<&Value> = None;
            let mut best_val = if pick_max { f64::MIN } else { f64::MAX };
            for item in items {
                let v = numeric_field(item, field);
                if let Some(v) = v {
                    let better = if pick_max { v > best_val } else { v < best_val };
                    if better {
                        best_val = v;
                        best = Some(item);
                    }
                }
            }
            Ok(best.cloned().unwrap_or(Value::Null))
        }
        "native.sort_by" => {
            let items = params["items"].as_array().ok_or("缺少 items 数组")?;
            let field = params["field"].as_str().ok_or("缺少 field")?;
            let desc = params["order"].as_str() == Some("desc");
            let mut sorted: Vec<Value> = items.clone();
            sorted.sort_by(|a, b| {
                let va = numeric_field(a, field).unwrap_or(f64::MAX);
                let vb = numeric_field(b, field).unwrap_or(f64::MAX);
                let ord = va.partial_cmp(&vb).unwrap_or(std::cmp::Ordering::Equal);
                if desc { ord.reverse() } else { ord }
            });
            Ok(Value::Array(sorted))
        }
        "native.sum" => {
            let items = params["items"].as_array().ok_or("缺少 items 数组")?;
            let field = params["field"].as_str();
            let sum: f64 = items
                .iter()
                .map(|i| match field {
                    Some(f) => numeric_field(i, f).unwrap_or(0.0),
                    None => i.as_f64().unwrap_or(0.0),
                })
                .sum();
            Ok(serde_json::json!(sum))
        }
        "native.count" => {
            let n = params["items"].as_array().map(|a| a.len()).unwrap_or(0);
            Ok(serde_json::json!(n))
        }
        "native.json_parse" => {
            let text = params["text"].as_str().ok_or("json_parse 缺少 text")?;
            serde_json::from_str(text).map_err(|e| format!("JSON 解析失败: {e}"))
        }
        "native.join" => {
            let items = params["items"].as_array().ok_or("缺少 items 数组")?;
            let sep = params["separator"].as_str().unwrap_or(", ");
            let parts: Vec<String> = items
                .iter()
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect();
            Ok(Value::String(parts.join(sep)))
        }
        "native.filter_contains" => {
            let items = params["items"].as_array().ok_or("缺少 items 数组")?;
            let field = params["field"].as_str().ok_or("缺少 field")?;
            let keyword = params["keyword"].as_str().unwrap_or_default();
            let filtered: Vec<Value> = items
                .iter()
                .filter(|i| i[field].as_str().map(|s| s.contains(keyword)).unwrap_or(false))
                .cloned()
                .collect();
            Ok(Value::Array(filtered))
        }
        _ => Err(format!("未知原生函数: {name}（支持: {}）", NATIVE_FUNCTIONS.join(", "))),
    }
}

fn numeric_field(item: &Value, field: &str) -> Option<f64> {
    match &item[field] {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().trim_start_matches('¥').parse::<f64>().ok(),
        _ => None,
    }
}
