mod app_data;
mod config;
mod crypto;
mod error;
mod file_history;
mod provider;
mod chat;
mod skill;
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
    pub(crate) file_history: Arc<file_history::FileHistory>,
    pub(crate) skill_service: Arc<skill::SkillService>,
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
    #[serde(default = "default_output_context_window")]
    output_context_window: u32,
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
    output_context_window: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStreamRequest {
    #[serde(default)]
    provider_id: Option<String>,
    model_id: String,
    messages: Vec<ChatMessage>,
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
    /// 当前对话轮次的消息 ID（用于文件回退系统的 turn 级关联）。
    /// 提供时触发备份流程，不提供时跳过备份（向后兼容）。
    #[serde(default)]
    turn_message_id: Option<String>,
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
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        trace_upstream: body.trace_upstream,
    };
    chat::handle_stream(s.store.clone(), s.http.clone(), req, Some(s.skill_service.clone())).await
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
        s.file_history.as_ref(),
        body.turn_message_id.as_deref(),
        Some(s.skill_service.as_ref()),
    )
    .await?;
    Ok(Json(result))
}

// ─── Skill 系统 API（规格书 §2/§10.1）────────────────────────────────────

/// 管理页列表：skills + shadowed + errors + 平台能力（时机 A：进入页面时增量扫描）
async fn list_skills_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.skill_service.ui_snapshot().await)
}

/// 手动刷新（管理页“刷新”按钮 / Android 下拉刷新）
async fn refresh_skills_handler(State(s): State<AppState>) -> Json<Value> {
    let changed = s.skill_service.discover().await;
    Json(json!({ "changed": changed }))
}

/// 新建 skill（写入全局层）
async fn create_skill_handler(
    State(s): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    let info = s
        .skill_service
        .create_skill(&body)
        .await
        .map_err(AppError::ToolExecutionError)?;
    Ok(Json(json!({ "skill": info })))
}

/// 引用内容端点（§10.1）：返回 SKILL.md 原文（原样，不做变量替换）
async fn skill_content_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Value>, AppError> {
    match s.skill_service.build_reference_injection(&name).await {
        Ok(content) => Ok(Json(json!({ "name": name, "content": content }))),
        Err(candidates) => Err(AppError::ToolExecutionError(format!(
            "ERR_NOT_FOUND: skill「{name}」不存在。候选：{}",
            candidates.join(", ")
        ))),
    }
}

/// 详情页文件树（§2）
async fn skill_files_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Value>, AppError> {
    let tree = s
        .skill_service
        .skill_files(&name)
        .await
        .map_err(AppError::ToolExecutionError)?;
    Ok(Json(json!({ "tree": tree })))
}

#[derive(Debug, Deserialize)]
struct SkillFileQuery {
    path: String,
}

/// 详情页文件树中读取单个资源文件
async fn skill_file_content_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Query(q): Query<SkillFileQuery>,
) -> Result<Json<Value>, AppError> {
    let content = s
        .skill_service
        .skill_file_content(&name, &q.path)
        .await
        .map_err(AppError::ToolExecutionError)?;
    Ok(Json(json!({ "content": content })))
}

#[derive(Debug, Deserialize)]
struct UpdateSkillRequest {
    content: String,
}

/// 更新 SKILL.md 原文（编辑）
async fn update_skill_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<UpdateSkillRequest>,
) -> Result<Json<Value>, AppError> {
    s.skill_service
        .update_skill_content(&name, &body.content)
        .await
        .map_err(AppError::ToolExecutionError)?;
    Ok(Json(json!({ "success": true })))
}

/// 删除 skill（前端已做二次确认）
async fn delete_skill_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Value>, AppError> {
    s.skill_service
        .delete_skill(&name)
        .await
        .map_err(AppError::ToolExecutionError)?;
    Ok(Json(json!({ "success": true })))
}

#[derive(Debug, Deserialize)]
struct SetSkillEnabledRequest {
    enabled: bool,
}

/// 启用/禁用开关
async fn set_skill_enabled_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<SetSkillEnabledRequest>,
) -> Result<Json<Value>, AppError> {
    s.skill_service
        .set_enabled(&name, body.enabled)
        .await
        .map_err(AppError::ToolExecutionError)?;
    Ok(Json(json!({ "success": true })))
}

/// 读取 skill settings（设置页）
async fn get_skill_settings_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.skill_service.get_settings().await)
}

/// 覆盖写全局 skill settings（设置页保存）
async fn update_skill_settings_handler(
    State(s): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, AppError> {
    s.skill_service
        .update_global_settings(body)
        .await
        .map_err(AppError::ToolExecutionError)?;
    Ok(Json(json!({ "success": true })))
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

// ─── 文件回退系统 API 路由处理器 ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreTurnRequest {
    chat_id: String,
    turn_id: String,
}

async fn restore_turn_handler(
    State(s): State<AppState>,
    Json(body): Json<RestoreTurnRequest>,
) -> Result<Json<Value>, AppError> {
    let turn_id = file_history::TurnId(body.turn_id);
    let result = file_history::rollback::revert_turn(&turn_id, s.file_history.as_ref()).await?;
    Ok(Json(serde_json::to_value(&result).unwrap_or_default()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreRecordsRequest {
    record_ids: Vec<String>,
}

async fn restore_records_handler(
    State(s): State<AppState>,
    Json(body): Json<RestoreRecordsRequest>,
) -> Result<Json<Value>, AppError> {
    let ids: Vec<file_history::RecordId> = body.record_ids.into_iter().map(file_history::RecordId).collect();
    let result = file_history::rollback::revert_records(&ids, s.file_history.as_ref()).await?;
    Ok(Json(serde_json::to_value(&result).unwrap_or_default()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesQuery {
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

async fn get_changes_handler(
    State(s): State<AppState>,
    Query(q): Query<ChangesQuery>,
) -> Result<Json<Value>, AppError> {
    let journal = &s.file_history.journal;
    let records = if let Some(turn_id) = &q.turn_id {
        journal.get_records_by_turn(&file_history::TurnId(turn_id.clone())).await?
    } else if let Some(path) = &q.path {
        journal.get_records_for_path(path).await?
    } else {
        Vec::new()
    };
    let summaries: Vec<Value> = records.iter().map(|r| serde_json::to_value(r).unwrap_or_default()).collect();
    Ok(Json(json!({ "changes": summaries })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetBackupModeRequest {
    mode: String,
    #[serde(default)]
    path_pattern: Option<String>,
}

async fn set_backup_mode_handler(
    State(s): State<AppState>,
    Json(body): Json<SetBackupModeRequest>,
) -> Result<Json<Value>, AppError> {
    let mode = match body.mode.as_str() {
        "snapshot" => file_history::BackupMode::Snapshot,
        "hunks" => file_history::BackupMode::Hunks,
        "auto" => file_history::BackupMode::Auto,
        other => return Err(AppError::ToolExecutionError(format!("未知的备份模式：{other}"))),
    };
    let mut config = s.file_history.config().await;
    if let Some(pattern) = body.path_pattern {
        config.path_overrides.push(file_history::PathOverride { glob_pattern: pattern, mode });
    } else {
        config.backup_mode = mode;
    }
    s.file_history.set_config(config).await;
    Ok(Json(json!({ "success": true })))
}

async fn get_backup_status_handler(
    State(s): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let config = s.file_history.config().await;
    let total_size = s.file_history.object_store.total_size().await?;
    let sessions = s.file_history.journal.list_sessions_sorted_by_access().await?;
    Ok(Json(json!({
        "mode": config.backup_mode,
        "pathOverrides": config.path_overrides,
        "quota": { "maxTotalSize": config.quota.max_total_size, "safMaxTotalSize": config.quota.saf_max_total_size, "warnThreshold": config.quota.warn_threshold },
        "totalSize": total_size,
        "sessionCount": sessions.len(),
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteBackupsQuery {
    #[serde(default)]
    chat_id: Option<String>,
}

async fn delete_backups_handler(
    State(s): State<AppState>,
    Query(q): Query<DeleteBackupsQuery>,
) -> Result<Json<Value>, AppError> {
    if let Some(chat_id) = &q.chat_id {
        s.file_history.journal.delete_session(chat_id).await?;
        s.file_history.object_store.delete_session_objects(chat_id).await?;
    }
    Ok(Json(json!({ "success": true })))
}

async fn sync_in_handler(State(s): State<AppState>) -> Result<Json<Value>, AppError> {
    let saf_guard = s.file_history.saf_proxy.lock().await;
    if let Some(proxy) = saf_guard.as_ref() {
        let report = proxy.sync_in_from_saf(s.file_history.as_ref()).await?;
        Ok(Json(serde_json::to_value(&report).unwrap_or_default()))
    } else {
        Ok(Json(json!({ "externalEdits": [], "externalDeletes": [] })))
    }
}

async fn sync_out_handler(State(s): State<AppState>) -> Result<Json<Value>, AppError> {
    let saf_guard = s.file_history.saf_proxy.lock().await;
    if let Some(proxy) = saf_guard.as_ref() {
        let report = proxy.sync_out_to_saf(s.file_history.as_ref()).await?;
        Ok(Json(serde_json::to_value(&report).unwrap_or_default()))
    } else {
        Ok(Json(json!({ "synced": [], "failures": [] })))
    }
}

async fn sync_status_handler(State(s): State<AppState>) -> Result<Json<Value>, AppError> {
    let saf_guard = s.file_history.saf_proxy.lock().await;
    if let Some(proxy) = saf_guard.as_ref() {
        let dirty = proxy.dirty_files().await;
        let tracked = proxy.tracked_files_list().await;
        Ok(Json(json!({ "enabled": proxy.is_enabled(), "dirtyCount": dirty.len(), "dirtyFiles": dirty, "trackedCount": tracked.len() })))
    } else {
        Ok(Json(json!({ "enabled": false, "dirtyCount": 0, "dirtyFiles": [], "trackedCount": 0 })))
    }
}

async fn run_gc_handler(State(s): State<AppState>) -> Result<Json<Value>, AppError> {
    let report = file_history::gc::run_gc(s.file_history.as_ref()).await?;
    Ok(Json(serde_json::to_value(&report).unwrap_or_default()))
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
    let file_history_dir = config::app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".mytool");
    let task_store = Arc::new(TaskStore::new(tasks_dir));
    let read_tracker = Arc::new(tools::ReadTracker::new());
    let file_history = Arc::new(file_history::FileHistory::new(file_history_dir).await?);

    // 启动时执行 WAL 崩溃恢复
    if let Err(e) = file_history.recover_from_wal().await {
        tracing::warn!("WAL 恢复失败（非致命，继续启动）：{e}");
    }

    // reqwest client 只保留连接层超时；单次请求生命周期由 chat 层设置 request timeout
    let http = Arc::new(
        Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .build()?,
    );

    let startup_nonce = generate_nonce();

    // Skill 系统（规格书 §3.1）：桌面端含项目层扫描
    let skill_service = skill::SkillService::new(
        skill::Platform::Desktop,
        config::app_data_dir().unwrap_or_else(|_| PathBuf::from(".")),
        workspace_root(),
    )
    .await;

    let state = AppState { store, app_data, http, task_store, read_tracker, file_history, skill_service, startup_nonce };

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
        // 文件回退系统：Turn 级回退 / 选择性回退 / 变更查询 / 模式管理 / SAF 同步 / GC
        .route("/api/files/restore-turn", post(restore_turn_handler))
        .route("/api/files/restore-records", post(restore_records_handler))
        .route("/api/files/changes", get(get_changes_handler))
        .route("/api/files/backup-mode", post(set_backup_mode_handler))
        .route("/api/files/backup-status", get(get_backup_status_handler))
        .route("/api/files/backups", axum::routing::delete(delete_backups_handler))
        .route("/api/files/sync-in", post(sync_in_handler))
        .route("/api/files/sync-out", post(sync_out_handler))
        .route("/api/files/sync-status", get(sync_status_handler))
        .route("/api/files/gc", post(run_gc_handler))
        // Skill 系统（规格书 §2/§10.1）：管理 CRUD / 引用内容 / 文件树 / settings
        .route("/api/skills", get(list_skills_handler).post(create_skill_handler))
        .route("/api/skills/refresh", post(refresh_skills_handler))
        .route("/api/skills/settings", get(get_skill_settings_handler).put(update_skill_settings_handler))
        .route("/api/skills/:name/content", get(skill_content_handler))
        .route("/api/skills/:name/files", get(skill_files_handler))
        .route("/api/skills/:name/file", get(skill_file_content_handler))
        .route("/api/skills/:name/enabled", post(set_skill_enabled_handler))
        .route(
            "/api/skills/:name",
            axum::routing::put(update_skill_handler).delete(delete_skill_handler),
        )
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
