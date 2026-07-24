use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
}

#[derive(Debug, Deserialize)]
pub struct StreamDelta {
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StreamChoice {
    #[serde(default)]
    pub delta: StreamDelta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

impl Default for StreamDelta {
    fn default() -> Self {
        Self {
            content: None,
            reasoning_content: None,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct StreamChunk {
    #[serde(default)]
    pub choices: Vec<StreamChoice>,
    #[serde(default)]
    #[allow(dead_code)]
    pub usage: Option<UsageInfo>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct UsageInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_hit_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_cache_miss_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct PromptTokensDetails {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<u32>,
}
