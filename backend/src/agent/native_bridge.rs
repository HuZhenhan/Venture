//! 原生桥客户端：Rust 后端 → Kotlin ToolServer（127.0.0.1:46307）。
//!
//! 项目无 Tauri command 基础设施，原生层通过 loopback HTTP 暴露工具，
//! 与"前端 → 后端"的 HTTP 通道保持同一风格。

use serde_json::{json, Value};
use std::time::Duration;

const DEFAULT_BRIDGE_URL: &str = "http://127.0.0.1:46307";

#[derive(Clone)]
pub struct NativeBridge {
    client: reqwest::Client,
    base_url: String,
}

impl NativeBridge {
    pub fn new() -> Self {
        let base_url = std::env::var("VENTURE_NATIVE_BRIDGE_URL")
            .unwrap_or_else(|_| DEFAULT_BRIDGE_URL.to_string());
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(130)) // 对齐手势同步等待上限 128s
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self { client, base_url }
    }

    /// 调用原生工具。返回结构化 JSON；桥不可达时返回桥错误而非 panic。
    pub async fn call_tool(&self, tool: &str, args: &Value) -> Value {
        let url = format!("{}/tool", self.base_url);
        let body = json!({ "tool": tool, "args": args });
        match self.client.post(&url).json(&body).send().await {
            Ok(resp) => match resp.json::<Value>().await {
                Ok(v) => v,
                Err(e) => json!({
                    "ok": false,
                    "error": { "code": "bridge_bad_response", "message": format!("原生桥响应解析失败: {e}") }
                }),
            },
            Err(e) => json!({
                "ok": false,
                "error": {
                    "code": "bridge_unavailable",
                    "message": format!("原生桥不可达（无障碍服务或未在 Android 端运行）: {e}")
                }
            }),
        }
    }

    /// 原生桥健康检查
    pub async fn health(&self) -> Value {
        let url = format!("{}/health", self.base_url);
        match self.client.get(&url).send().await {
            Ok(resp) => resp.json::<Value>().await.unwrap_or_else(|_| {
                json!({ "ok": false, "error": { "code": "bridge_bad_response", "message": "健康检查响应解析失败" } })
            }),
            Err(e) => json!({
                "ok": false,
                "error": { "code": "bridge_unavailable", "message": format!("原生桥不可达: {e}") }
            }),
        }
    }
}

impl Default for NativeBridge {
    fn default() -> Self {
        Self::new()
    }
}
