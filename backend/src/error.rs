use thiserror::Error;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

#[derive(Debug, Error)]
pub enum AppError {
    #[allow(dead_code)]
    #[error("BACKEND_NOT_READY")]
    BackendNotReady,
    #[error("PROVIDER_NOT_FOUND")]
    ProviderNotFound,
    #[error("MODEL_NOT_FOUND")]
    ModelNotFound,
    #[error("INVALID_PROVIDER_CONFIG: {0}")]
    InvalidProviderConfig(String),
    #[error("UPSTREAM_AUTH_FAILED")]
    UpstreamAuthFailed,
    #[error("UPSTREAM_RATE_LIMITED")]
    UpstreamRateLimited,
    #[error("UPSTREAM_TIMEOUT")]
    UpstreamTimeout,
    #[error("UPSTREAM_STREAM_ERROR: {0}")]
    UpstreamStreamError(String),
    #[error("CONFIG_DECRYPT_FAILED")]
    ConfigDecryptFailed,
    #[error("CONFIG_WRITE_FAILED: {0}")]
    ConfigWriteFailed(String),
    #[error("INTERNAL_ERROR: {0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::BackendNotReady => "BACKEND_NOT_READY",
            AppError::ProviderNotFound => "PROVIDER_NOT_FOUND",
            AppError::ModelNotFound => "MODEL_NOT_FOUND",
            AppError::InvalidProviderConfig(_) => "INVALID_PROVIDER_CONFIG",
            AppError::UpstreamAuthFailed => "UPSTREAM_AUTH_FAILED",
            AppError::UpstreamRateLimited => "UPSTREAM_RATE_LIMITED",
            AppError::UpstreamTimeout => "UPSTREAM_TIMEOUT",
            AppError::UpstreamStreamError(_) => "UPSTREAM_STREAM_ERROR",
            AppError::ConfigDecryptFailed => "CONFIG_DECRYPT_FAILED",
            AppError::ConfigWriteFailed(_) => "CONFIG_WRITE_FAILED",
            AppError::Internal(_) => "INTERNAL_ERROR",
        }
    }

    pub fn detailed_message(&self) -> String {
        match self {
            AppError::ModelNotFound => "指定的模型 ID 未找到或已禁用。请检查：1) 模型 ID 是否正确 2) 在设置中是否启用了该模型 3) API 供应商是否正确配置".to_string(),
            AppError::ProviderNotFound => "指定的 API 供应商未找到。请在设置中添加或配置 API 供应商。".to_string(),
            AppError::InvalidProviderConfig(msg) => format!("API 供应商配置错误: {}", msg),
            AppError::UpstreamAuthFailed => "API 密钥认证失败。请检查 API 密钥是否正确配置。".to_string(),
            AppError::UpstreamRateLimited => "请求过于频繁，已触发速率限制。请稍后重试。".to_string(),
            AppError::UpstreamTimeout => "请求超时。上游服务响应缓慢，请检查网络连接或稍后重试。".to_string(),
            AppError::UpstreamStreamError(msg) => format!("流处理错误: {}", msg),
            AppError::ConfigDecryptFailed => "配置解密失败。配置文件可能已损坏。".to_string(),
            AppError::ConfigWriteFailed(msg) => format!("配置保存失败: {}", msg),
            AppError::BackendNotReady => "后端服务未就绪。".to_string(),
            AppError::Internal(msg) => format!("内部错误: {}", msg),
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, AppError::UpstreamRateLimited | AppError::UpstreamTimeout)
    }

    pub fn http_status(&self) -> StatusCode {
        match self {
            AppError::ProviderNotFound | AppError::ModelNotFound => StatusCode::NOT_FOUND,
            AppError::InvalidProviderConfig(_) => StatusCode::BAD_REQUEST,
            AppError::UpstreamAuthFailed => StatusCode::UNAUTHORIZED,
            AppError::UpstreamRateLimited => StatusCode::TOO_MANY_REQUESTS,
            AppError::UpstreamTimeout => StatusCode::GATEWAY_TIMEOUT,
            AppError::ConfigDecryptFailed | AppError::ConfigWriteFailed(_) => StatusCode::INTERNAL_SERVER_ERROR,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.http_status();
        let body = json!({
            "error": {
                "code": self.code(),
                "message": self.detailed_message(),
                "retryable": self.retryable()
            }
        });
        (status, Json(body)).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
