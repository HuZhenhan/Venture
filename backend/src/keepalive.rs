//! Android 后台保活客户端：任务活动时向 Kotlin ToolServer 上报 pulse。
//!
//! 语义（与 Kotlin VentureKeepAliveService 配合）：
//! - pulse = 幂等启动前台服务 + 续期心跳（Kotlin ensureStarted：已运行则仅续期）
//! - 停止时机由 Kotlin 侧空闲超时（IDLE_TIMEOUT_MS=90s 无 pulse 自动停）处理，
//!   避免跨 HTTP 请求的引用计数复杂度（Agent 任务 = 多次 chat/stream + 工具调用）
//! - 桥不可达（桌面端、未安装 Android 包）时失败后冷却禁用，冷却结束自动恢复，
//!   避免永久静默（曾导致 Android 上悬浮窗/保活永不生效）

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_BRIDGE_URL: &str = "http://127.0.0.1:46307";
const PULSE_TIMEOUT: Duration = Duration::from_millis(800);
/// 失败后冷却时长：冷却期间静默跳过请求，结束自动恢复（桥恢复可用时无需重启应用）
const DISABLE_COOLDOWN: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct KeepAlive {
    client: reqwest::Client,
    url: String,
    overlay_url: String,
    approval_url: String,
    disabled: Arc<AtomicBool>,
}

impl KeepAlive {
    /// base_url 复用原生桥地址（同端口 46307）。
    pub fn new(base_url: &str) -> Self {
        let url = format!("{}/keepalive", base_url);
        let overlay_url = format!("{}/overlay", base_url);
        let approval_url = format!("{}/approval", base_url);
        let client = reqwest::Client::builder()
            .connect_timeout(PULSE_TIMEOUT)
            .timeout(PULSE_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            url,
            overlay_url,
            approval_url,
            disabled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn from_env() -> Self {
        let base_url = std::env::var("VENTURE_NATIVE_BRIDGE_URL")
            .unwrap_or_else(|_| DEFAULT_BRIDGE_URL.to_string());
        Self::new(&base_url)
    }

    /// 任务活动信号：启动/续期前台服务。连接失败后冷却禁用，冷却结束自动恢复。
    pub async fn pulse(&self, text: &str) {
        self.post(&self.url, json!({ "action": "pulse", "text": text })).await;
    }

    /// AI 活动悬浮窗（规格书 6.4）：thinking 动画 / streaming 回复文本 / tool 分类 / hide。
    /// 与 pulse 共用禁用标志（同一通道）。
    /// 悬浮窗仅 Android 存在：桌面端无原生桥与悬浮窗，直接不发，避免无谓的失败请求。
    pub async fn overlay(&self, action: &str, text: &str) {
        if cfg!(not(target_os = "android")) {
            return;
        }
        self.post(&self.overlay_url, json!({ "action": action, "text": text })).await;
    }

    /// 授权悬浮窗：show 显示授权卡片（payload 含 chatId/messageId/toolId/toolName 等），
    /// hide 收起。仅 Android 存在，桌面端直接不发。
    pub async fn approval(&self, action: &str, payload: Value) {
        if cfg!(not(target_os = "android")) {
            return;
        }
        self.post(&self.approval_url, json!({ "action": action, "payload": payload }))
            .await;
    }

    async fn post(&self, url: &str, body: Value) {
        if self.disabled.load(Ordering::Relaxed) {
            return;
        }
        match self.client.post(url).json(&body).send().await {
            Ok(_) => {}
            Err(_) => {
                // 进入冷却：静默跳过请求（避免桌面端/桥未就绪时反复失败），
                // 冷却结束自动恢复——桥恢复可用（如 ToolServer 重启、权限授权）后无需重启应用
                self.disabled.store(true, Ordering::Relaxed);
                let disabled = self.disabled.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(DISABLE_COOLDOWN).await;
                    disabled.store(false, Ordering::Relaxed);
                });
            }
        }
    }
}

impl Default for KeepAlive {
    fn default() -> Self {
        Self::from_env()
    }
}
