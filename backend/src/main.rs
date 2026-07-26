mod app_data;
mod config;
mod crypto;
mod error;
mod provider;
mod chat;
mod task_store;
mod tools;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
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
use task_store::{CreateTaskRequest, Task, TaskStatus, TaskStore, UpdateTaskRequest};

/// 请求体大小上限（20MB，覆盖多图/大附件场景，超出直接拒绝）
const REQUEST_BODY_LIMIT: usize = 20 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct AppState {
    store: Arc<ConfigStore>,
    app_data: Arc<AppDataStore>,
    pub(crate) http: Arc<Client>,
    pub(crate) task_store: Arc<TaskStore>,
    pub(crate) read_tracker: Arc<tools::ReadTracker>,
    /// 启动时生成的一次性 nonce，供 Electron 主进程校验后端身份
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
    #[serde(default)]
    trace_upstream: bool,
}

// ─── 工具调用请求/响应类型 ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteToolRequest {
    tool: String,
    #[serde(default)]
    input: Value,
    /// 任务工具按 chatId 隔离；文件系统工具可忽略。
    #[serde(default)]
    chat_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskApiRequest {
    chat_id: String,
    subject: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<TaskStatus>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskApiRequest {
    #[serde(default)]
    subject: Option<String>,
    /// None=不动；Some(None)=清空；Some(Some(s))=更新
    #[serde(default)]
    description: Option<Option<String>>,
    #[serde(default)]
    status: Option<TaskStatus>,
}

#[derive(Debug, Deserialize)]
struct TaskQuery {
    chat_id: String,
}

/// 读取工作区根路径（可选）。通过环境变量 VENTURE_WORKSPACE_ROOT 配置。
fn workspace_root() -> Option<PathBuf> {
    std::env::var("VENTURE_WORKSPACE_ROOT").ok().map(PathBuf::from)
}

async fn health(State(s): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "nonce": s.startup_nonce,
        "pid": std::process::id(),
        "startedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
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
        trace_upstream: body.trace_upstream,
    };
    chat::handle_stream(s.store.clone(), s.http.clone(), req).await
}

// ─── 工具调用与任务管理路由处理器 ──────────────────────────────────────────

async fn execute_tool_handler(
    State(s): State<AppState>,
    Json(body): Json<ExecuteToolRequest>,
) -> Result<Json<Value>, AppError> {
    let ws = workspace_root();
    let result = tools::execute_and_serialize(
        &body.tool,
        &body.input,
        &body.chat_id,
        s.task_store.as_ref(),
        ws.as_deref(),
        s.read_tracker.as_ref(),
    )
    .await?;
    Ok(Json(result))
}

async fn list_tasks(
    State(s): State<AppState>,
    Query(q): Query<TaskQuery>,
) -> Json<Value> {
    let tasks = s.task_store.list(&q.chat_id).await;
    Json(json!({ "tasks": tasks }))
}

async fn create_task(
    State(s): State<AppState>,
    Json(body): Json<CreateTaskApiRequest>,
) -> Result<Json<Value>, AppError> {
    let req = CreateTaskRequest {
        subject: body.subject,
        description: body.description,
        status: body.status,
    };
    let task: Task = s.task_store.create(&body.chat_id, req).await?;
    Ok(Json(json!({ "task": task })))
}

async fn get_task_handler(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<TaskQuery>,
) -> Result<Json<Task>, AppError> {
    Ok(Json(s.task_store.get(&q.chat_id, &id).await?))
}

async fn update_task_full(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<TaskQuery>,
    Json(body): Json<UpdateTaskApiRequest>,
) -> Result<Json<Task>, AppError> {
    let req = UpdateTaskRequest {
        subject: body.subject,
        description: body.description,
        status: body.status,
    };
    Ok(Json(s.task_store.update(&q.chat_id, &id, req).await?))
}

fn generate_nonce() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .without_time()
        .init();

    let store = Arc::new(ConfigStore::load().await?);
    let app_data = Arc::new(AppDataStore::load().await?);
    let tasks_dir = config::app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("tasks");
    let task_store = Arc::new(TaskStore::new(tasks_dir));
    let read_tracker = Arc::new(tools::ReadTracker::new());
    // reqwest client 只保留连接层超时；单次请求生命周期由 chat 层设置 request timeout
    let http = Arc::new(
        Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .build()?,
    );

    let startup_nonce = generate_nonce();
    let state = AppState { store, app_data, http, task_store, read_tracker, startup_nonce };

    // CORS：仅允许本地/tauri 来源，且方法/头只允许必需的
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(
            |origin: &axum::http::HeaderValue, _request_parts: &axum::http::request::Parts| {
                if let Ok(orig_str) = origin.to_str() {
                    orig_str.starts_with("http://localhost")
                        || orig_str.starts_with("http://127.0.0.1")
                        || orig_str.starts_with("tauri://")
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
        // 工具调用：执行单个工具并返回结果
        .route("/api/tools/execute", post(execute_tool_handler))
        // 任务管理：CRUD，按 chatId 隔离
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/:id", get(get_task_handler).patch(update_task_full))
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
