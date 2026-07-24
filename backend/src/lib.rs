pub mod app_data;
pub mod config;
pub mod crypto;
pub mod error;
pub mod provider;
pub mod chat;

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::Method,
    routing::{get, patch, post},
    Json, Router,
};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::info;

use app_data::{AppDataFile, AppDataPatch, AppDataStore, MigrateAppDataRequest};
use config::{ConfigStore, ModelEntry};
use error::AppError;
use provider::ChatMessage;

const REQUEST_BODY_LIMIT: usize = 20 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) store: Arc<ConfigStore>,
    pub(crate) app_data: Arc<AppDataStore>,
    pub(crate) http: Arc<Client>,
    startup_nonce: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddProviderRequest {
    name: String,
    base_url: String,
    api_key: String,
    models: Vec<ModelEntry>,
    #[serde(default = "default_input_context_window")]
    input_context_window: u32,
    #[serde(default = "default_output_context_window")]
    output_context_window: u32,
}

fn default_input_context_window() -> u32 {
    20
}

fn default_output_context_window() -> u32 {
    4096
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProviderRequest {
    name: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    models: Option<Vec<ModelEntry>>,
    input_context_window: Option<u32>,
    output_context_window: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamRequest {
    #[serde(default)]
    provider_id: Option<String>,
    model_id: String,
    messages: Vec<ChatMessage>,
    #[serde(default = "default_input_context_window")]
    context_window: u32,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
}

async fn health(State(s): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "nonce": s.startup_nonce,
        "pid": std::process::id(),
        "startedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    }))
}

async fn list_providers(State(s): State<AppState>) -> Json<Value> {
    let providers = s.store.list_providers().await;
    Json(json!({ "providers": providers }))
}

async fn get_app_data(State(s): State<AppState>) -> Json<AppDataFile> {
    Json(s.app_data.get().await)
}

async fn replace_app_data(
    State(s): State<AppState>,
    Json(body): Json<AppDataFile>,
) -> Result<Json<AppDataFile>, AppError> {
    Ok(Json(s.app_data.replace(body).await?))
}

async fn patch_app_data(
    State(s): State<AppState>,
    Json(body): Json<AppDataPatch>,
) -> Result<Json<AppDataFile>, AppError> {
    Ok(Json(s.app_data.patch(body).await?))
}

async fn migrate_app_data(
    State(s): State<AppState>,
    Json(body): Json<MigrateAppDataRequest>,
) -> Result<Json<AppDataFile>, AppError> {
    Ok(Json(s.app_data.migrate(body).await?))
}

async fn add_provider(
    State(s): State<AppState>,
    Json(body): Json<AddProviderRequest>,
) -> Result<Json<Value>, AppError> {
    let p = s.store.add_provider(
        body.name,
        body.base_url,
        body.api_key,
        body.models,
        body.input_context_window,
        body.output_context_window,
    ).await?;
    Ok(Json(json!({ "provider": p })))
}

async fn update_provider(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateProviderRequest>,
) -> Result<Json<Value>, AppError> {
    let p = s.store.update_provider(
        &id,
        body.name,
        body.base_url,
        body.api_key,
        body.models,
        body.input_context_window,
        body.output_context_window,
    ).await?;
    Ok(Json(json!({ "provider": p })))
}

async fn remove_provider(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    s.store.delete_provider(&id).await?;
    Ok(Json(json!({ "success": true })))
}

async fn chat_stream(
    State(s): State<AppState>,
    Json(body): Json<ChatStreamRequest>,
) -> Result<axum::response::Response, AppError> {
    let req = chat::ChatRequest {
        provider_id: body.provider_id,
        model_id: body.model_id,
        messages: body.messages,
        context_window: body.context_window,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
    };
    chat::handle_stream(s.store.clone(), s.http.clone(), req).await
}

fn generate_nonce() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 启动 venture-backend HTTP 服务。
///
/// `data_dir` — 可选的数据目录覆盖。当 `None` 时使用默认路径
/// （Windows: %APPDATA%/Venture，其他平台: ProjectDirs）。
/// Tauri 集成时应传入 `app.path().app_data_dir()`。
pub async fn run_server(data_dir: Option<PathBuf>) -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .without_time()
        .try_init()
        .ok();

    let store = Arc::new(ConfigStore::load(data_dir.clone()).await?);
    let app_data = Arc::new(AppDataStore::load(data_dir).await?);
    let http = Arc::new(
        Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .build()?,
    );

    let startup_nonce = generate_nonce();
    let state = AppState { store, app_data, http, startup_nonce };

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(
            |origin: &axum::http::HeaderValue, _request_parts: &axum::http::request::Parts| {
                if let Ok(orig_str) = origin.to_str() {
                    orig_str.starts_with("http://localhost")
                        || orig_str.starts_with("http://127.0.0.1")
                        || orig_str.starts_with("tauri://")
                        || orig_str.starts_with("https://tauri.localhost")
                        || orig_str.starts_with("file://")
                } else {
                    false
                }
            },
        ))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::CONTENT_TYPE,
            axum::http::header::AUTHORIZATION,
            axum::http::header::ACCEPT,
        ]);

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/providers", get(list_providers).post(add_provider))
        .route("/api/app-data", get(get_app_data).put(replace_app_data).patch(patch_app_data))
        .route("/api/app-data/migrate", post(migrate_app_data))
        .route(
            "/api/providers/:id",
            patch(update_provider).delete(remove_provider),
        )
        .route("/api/chat/stream", post(chat_stream))
        .layer(DefaultBodyLimit::max(REQUEST_BODY_LIMIT))
        .layer(cors)
        .with_state(state);

    let port = std::env::var("VENTURE_BACKEND_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(49527);

    let addr = format!("127.0.0.1:{port}");
    info!("venture-backend listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
