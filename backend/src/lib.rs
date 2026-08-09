pub mod app_data;
pub mod config;
pub mod crypto;
pub mod error;
pub mod file_history;
pub mod keepalive;
pub mod provider;
pub mod agent;
pub mod chat;
pub mod script;
pub mod skill;
pub mod task_store;
pub mod tools;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::Method,
    routing::{get, patch, post},
    Json, Router,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::info;

use app_data::{AppDataFile, AppDataPatch, AppDataStore, MigrateAppDataRequest};
use config::{ConfigStore, ModelEntry};
use error::AppError;
use provider::ChatMessage;
use task_store::{CreateTaskRequest, Task, TaskStatus, TaskStore, UpdateTaskRequest};

const REQUEST_BODY_LIMIT: usize = 20 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) store: Arc<ConfigStore>,
    pub(crate) app_data: Arc<AppDataStore>,
    pub(crate) http: Arc<Client>,
    pub(crate) task_store: Arc<TaskStore>,
    pub(crate) read_tracker: Arc<tools::ReadTracker>,
    pub(crate) file_history: Arc<file_history::FileHistory>,
    pub(crate) skill_service: Arc<skill::SkillService>,
    pub(crate) agent_router: agent::AgentRouter,
    /// Android 后台保活（任务活动脉冲；桌面端静默降级）
    pub(crate) keepalive: keepalive::KeepAlive,
    /// 悬浮窗授权结果（key: chatId → 待前端消费的队列；取出即删）
    pub(crate) approvals: Arc<Mutex<HashMap<String, Vec<ApprovalResult>>>>,
    startup_nonce: String,
}

/// 悬浮窗授权结果（Kotlin 授权悬浮窗点击后回传，前端轮询消费）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalResult {
    pub message_id: String,
    pub tool_id: String,
    /// approve | always_approve | reject
    pub decision: String,
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
}

fn default_input_context_window() -> u32 {
    128
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProviderRequest {
    name: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    models: Option<Vec<ModelEntry>>,
    input_context_window: Option<u32>,
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
    // Android 保活：AI 生成期间保持进程存活（失败静默降级）
    s.keepalive.pulse("AI 生成中…").await;
    // AI 活动悬浮窗：生成开始 → 思考动画（流式输出与结束在 chat.rs 内挂钩）
    s.keepalive.overlay("thinking", "").await;
    let req = chat::ChatRequest {
        provider_id: body.provider_id,
        model_id: body.model_id,
        messages: body.messages,
        context_window: body.context_window,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        trace_upstream: body.trace_upstream,
    };
    chat::handle_stream(
        s.store.clone(),
        s.http.clone(),
        req,
        Some(s.skill_service.clone()),
        s.keepalive.clone(),
    )
    .await
}

// ─── 悬浮窗授权（Android 后台场景） ────────────────────────────────────────
//
// 工具权限询问（needs_approval）时前端调用 notify 请求 Kotlin 在屏幕下方显示
// 授权悬浮窗（应用在前台时 Kotlin 侧不显示，由应用内授权卡片处理）；
// 用户点击悬浮窗按钮 → Kotlin 回传 result → 前端轮询 results 消费（取出即删）。

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalNotifyRequest {
    chat_id: String,
    message_id: String,
    tool_id: String,
    tool_name: String,
    #[serde(default)]
    input: Value,
    #[serde(default)]
    description: Option<String>,
}

/// 前端：请求显示授权悬浮窗（转发给 Kotlin 桥；前台时 Kotlin 侧不显示）
async fn approval_notify_handler(
    State(s): State<AppState>,
    Json(body): Json<ApprovalNotifyRequest>,
) -> Json<Value> {
    s.keepalive
        .approval(
            "show",
            json!({
                "chatId": body.chat_id,
                "messageId": body.message_id,
                "toolId": body.tool_id,
                "toolName": body.tool_name,
                "input": body.input,
                "description": body.description,
            }),
        )
        .await;
    Json(json!({ "ok": true }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalResultRequest {
    chat_id: String,
    message_id: String,
    tool_id: String,
    /// approve | always_approve | reject
    decision: String,
}

/// Kotlin 悬浮窗：用户点击授权按钮后回传结果
async fn approval_result_handler(
    State(s): State<AppState>,
    Json(body): Json<ApprovalResultRequest>,
) -> Json<Value> {
    if !matches!(body.decision.as_str(), "approve" | "always_approve" | "reject") {
        return Json(json!({ "ok": false, "error": "unknown decision" }));
    }
    let mut map = s.approvals.lock().await;
    map.entry(body.chat_id.clone()).or_default().push(ApprovalResult {
        message_id: body.message_id,
        tool_id: body.tool_id,
        decision: body.decision,
    });
    Json(json!({ "ok": true }))
}

/// 前端：轮询消费授权结果（取出即删，避免重复处理）
async fn approval_results_handler(
    State(s): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let chat_id = params.get("chatId").cloned().unwrap_or_default();
    let results = {
        let mut map = s.approvals.lock().await;
        map.remove(&chat_id).unwrap_or_default()
    };
    Json(json!({ "results": results }))
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

/// Android 专属：导入 zip 技能包（base64 编码传输）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportSkillRequest {
    data_base64: String,
}

async fn import_skill_handler(
    State(s): State<AppState>,
    Json(body): Json<ImportSkillRequest>,
) -> Result<Json<Value>, AppError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&body.data_base64)
        .map_err(|e| AppError::ToolExecutionError(format!("base64 解码失败：{e}")))?;
    let result = s
        .skill_service
        .import_zip(&bytes)
        .await
        .map_err(AppError::ToolExecutionError)?;
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

// ─── 手机助手 Agent 路由处理器（规格书 8.1） ─────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentToolRequest {
    tool: String,
    #[serde(default)]
    args: Value,
    #[serde(default)]
    chat_id: String,
}

/// 自动化工具 → 悬浮窗分类文案（规格书 6.4 展示语义）
fn overlay_text_for_tool(tool: &str) -> &'static str {
    match tool {
        // 布局获取相关
        "get_layout" | "get_node" | "find_node" | "wait_for_node" | "wait_for_text"
        | "wait_for_app" | "get_windows" | "screenshot" => "AI 正在分析布局",
        // 屏幕操作相关
        "click" | "long_click" | "press" | "swipe" | "gesture" | "node_action"
        | "input_text" | "paste" | "key_event" | "global_action" | "set_clipboard"
        | "launch_app" | "open_url" | "scroll" => "AI 正在操控屏幕",
        // 脚本运行 / 制作
        "run_script" => "AI 正在使用脚本",
        "create_script" | "update_script" | "validate_script" | "delete_script"
        | "import_script" => "AI 正在定制脚本",
        _ => "AI 正在使用工具",
    }
}

async fn agent_tool_handler(
    State(s): State<AppState>,
    Json(body): Json<AgentToolRequest>,
) -> Json<Value> {
    // Android 保活：自动化工具调用期间保持进程存活（失败静默降级）
    s.keepalive.pulse("自动化工具执行中…").await;
    // AI 活动悬浮窗：按工具分类展示当前动作
    s.keepalive.overlay("tool", overlay_text_for_tool(&body.tool)).await;
    Json(s.agent_router.execute(&body.tool, &body.args, &body.chat_id).await)
}

async fn agent_tool_schemas_handler() -> Json<Value> {
    Json(json!({ "tools": agent::schemas::all_tool_schemas() }))
}

#[derive(Debug, Deserialize)]
struct TraceQuery {
    #[serde(default)]
    chat_id: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

async fn agent_trace_handler(
    State(s): State<AppState>,
    Query(q): Query<TraceQuery>,
) -> Json<Value> {
    let entries = s
        .agent_router
        .trace
        .list(q.chat_id.as_deref(), q.limit.unwrap_or(100));
    Json(json!({ "trace": entries }))
}

async fn agent_health_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.agent_router.bridge.health().await)
}

async fn agent_permission_state_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.agent_router.bridge.call_tool("__permission_state__", &json!({})).await)
}

async fn agent_permission_open_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.agent_router.bridge.call_tool("__open_accessibility_settings__", &json!({})).await)
}

// ─── 后台保活引导 API（Android；桌面端桥不可达返回错误） ───────────────────

async fn keepalive_status_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.agent_router.bridge.call_tool("__battery_exempt__", &json!({})).await)
}

async fn keepalive_request_exempt_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.agent_router.bridge.call_tool("__request_battery_exempt__", &json!({})).await)
}

async fn keepalive_open_settings_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.agent_router.bridge.call_tool("__open_battery_settings__", &json!({})).await)
}

// ─── AI 活动悬浮窗权限 API（Android） ─────────────────────────────────────

async fn overlay_permission_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.agent_router.bridge.call_tool("__overlay_permission__", &json!({})).await)
}

async fn overlay_open_settings_handler(State(s): State<AppState>) -> Json<Value> {
    Json(s.agent_router.bridge.call_tool("__open_overlay_settings__", &json!({})).await)
}

/// 前端主动关闭悬浮窗（停止按钮/异常中断时调用）：
/// SSE 流被客户端断开时 axum 取消流、尾帧 hide 不会执行，悬浮窗状态会残留，
/// 导致切后台时错误恢复显示。由前端在停止时显式通知后端发 hide。
async fn overlay_hide_handler(State(s): State<AppState>) -> Json<Value> {
    s.keepalive.overlay("hide", "").await;
    Json(json!({ "ok": true }))
}

// ─── 脚本注册表路由（规格书 8.1 / DSL §12） ──────────────────────────────

async fn list_scripts_handler(State(s): State<AppState>) -> Json<Value> {
    Json(json!({ "scripts": s.agent_router.engine.registry.list().await }))
}

async fn get_script_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
) -> Result<Json<Value>, AppError> {
    match s.agent_router.engine.registry.get(&name).await {
        Some(script) => Ok(Json(json!({ "script": script }))),
        None => Err(AppError::ToolExecutionError(format!("脚本不存在: {name}"))),
    }
}

async fn upsert_script_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(mut body): Json<script::ScriptDef>,
) -> Json<Value> {
    body.name = name;
    Json(s.agent_router.register_script(body, script::ScriptSource::User).await)
}

async fn import_script_handler(
    State(s): State<AppState>,
    Json(body): Json<script::ScriptDef>,
) -> Json<Value> {
    Json(s.agent_router.register_script(body, script::ScriptSource::Shared).await)
}

async fn delete_script_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
) -> Json<Value> {
    match s.agent_router.engine.registry.delete(&name).await {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({
            "ok": false,
            "error": { "code": "delete_failed", "message": e }
        })),
    }
}

#[derive(Debug, Deserialize)]
struct SetEnabledRequest {
    enabled: bool,
}

async fn set_script_enabled_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<SetEnabledRequest>,
) -> Json<Value> {
    match s.agent_router.engine.registry.set_enabled(&name, body.enabled).await {
        Ok(()) => Json(json!({ "ok": true })),
        Err(e) => Json(json!({
            "ok": false,
            "error": { "code": "update_failed", "message": e }
        })),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunScriptRequest {
    #[serde(default)]
    params: Value,
    #[serde(default)]
    confirmed: bool,
    #[serde(default)]
    chat_id: String,
}

async fn run_script_handler(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(body): Json<RunScriptRequest>,
) -> Json<Value> {
    // Android 保活：脚本执行期间保持进程存活（失败静默降级）
    s.keepalive.pulse(&format!("执行脚本 {name}…")).await;
    // AI 活动悬浮窗：脚本运行展示，结束后移除（规格书 6.4）
    s.keepalive.overlay("tool", "AI 正在使用脚本").await;
    let result = s
        .agent_router
        .engine
        .run_script(&name, body.params, &body.chat_id, body.confirmed, 0)
        .await;
    s.keepalive.overlay("hide", "").await;
    Json(result)
}

async fn validate_script_handler(
    State(s): State<AppState>,
    Json(body): Json<script::ScriptDef>,
) -> Json<Value> {
    let report = s.agent_router.engine.validate(&body).await;
    Json(json!({ "ok": true, "report": report.to_json() }))
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
    chat_id: Option<String>,
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
    let mut records: Vec<file_history::ChangeRecord> = Vec::new();

    if let Some(turn_id) = &q.turn_id {
        records = journal.get_records_by_turn(&file_history::TurnId(turn_id.clone())).await?;
    } else if let Some(path) = &q.path {
        records = journal.get_records_for_path(path).await?;
    }

    // 转换为前端友好的 summary 格式
    let summaries: Vec<Value> = records.iter().map(|r| {
        serde_json::to_value(r).unwrap_or_default()
    }).collect();

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
        config.path_overrides.push(file_history::PathOverride {
            glob_pattern: pattern,
            mode,
        });
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
        "quota": {
            "maxTotalSize": config.quota.max_total_size,
            "safMaxTotalSize": config.quota.saf_max_total_size,
            "warnThreshold": config.quota.warn_threshold,
        },
        "totalSize": total_size,
        "sessionCount": sessions.len(),
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteBackupsRequest {
    #[serde(default)]
    chat_id: Option<String>,
    #[serde(default)]
    older_than: Option<u64>,
}

async fn delete_backups_handler(
    State(s): State<AppState>,
    Query(q): Query<DeleteBackupsRequest>,
) -> Result<Json<Value>, AppError> {
    // Phase 1 简化实现：按 chat_id / session 删除
    if let Some(chat_id) = &q.chat_id {
        s.file_history.journal.delete_session(chat_id).await?;
        s.file_history.object_store.delete_session_objects(chat_id).await?;
    }
    Ok(Json(json!({ "success": true })))
}

async fn sync_in_handler(
    State(s): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let saf_guard = s.file_history.saf_proxy.lock().await;
    if let Some(proxy) = saf_guard.as_ref() {
        let report = proxy.sync_in_from_saf(s.file_history.as_ref()).await?;
        Ok(Json(serde_json::to_value(&report).unwrap_or_default()))
    } else {
        Ok(Json(json!({ "externalEdits": [], "externalDeletes": [] })))
    }
}

async fn sync_out_handler(
    State(s): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let saf_guard = s.file_history.saf_proxy.lock().await;
    if let Some(proxy) = saf_guard.as_ref() {
        let report = proxy.sync_out_to_saf(s.file_history.as_ref()).await?;
        Ok(Json(serde_json::to_value(&report).unwrap_or_default()))
    } else {
        Ok(Json(json!({ "synced": [], "failures": [] })))
    }
}

async fn sync_status_handler(
    State(s): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let saf_guard = s.file_history.saf_proxy.lock().await;
    if let Some(proxy) = saf_guard.as_ref() {
        let dirty = proxy.dirty_files().await;
        let tracked = proxy.tracked_files_list().await;
        Ok(Json(json!({
            "enabled": proxy.is_enabled(),
            "dirtyCount": dirty.len(),
            "dirtyFiles": dirty,
            "trackedCount": tracked.len(),
        })))
    } else {
        Ok(Json(json!({
            "enabled": false,
            "dirtyCount": 0,
            "dirtyFiles": [],
            "trackedCount": 0,
        })))
    }
}

async fn run_gc_handler(
    State(s): State<AppState>,
) -> Result<Json<Value>, AppError> {
    let report = file_history::gc::run_gc(s.file_history.as_ref()).await?;
    Ok(Json(serde_json::to_value(&report).unwrap_or_default()))
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

    let tasks_dir = config::app_data_dir(data_dir.as_ref())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("tasks");
    let file_history_dir = config::app_data_dir(data_dir.as_ref())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".mytool");
    let store = Arc::new(ConfigStore::load(data_dir.clone()).await?);
    let app_data = Arc::new(AppDataStore::load(data_dir.clone()).await?);
    let task_store = Arc::new(TaskStore::new(tasks_dir));
    let read_tracker = Arc::new(tools::ReadTracker::new());
    let file_history = Arc::new(
        file_history::FileHistory::new(file_history_dir).await?
    );

    // 启动优化：WAL 崩溃恢复移到后台异步执行，不阻塞 HTTP 监听
    // （恢复期间新写入记录与恢复项 record_id 不同，并发安全；失败非致命）
    {
        let fh = file_history.clone();
        tokio::spawn(async move {
            if let Err(e) = fh.recover_from_wal().await {
                tracing::warn!("WAL 恢复失败（非致命，继续启动）：{e}");
            }
        });
    }

    // Skill 系统（规格书 §3.1）：Android 端仅全局层扫描，无项目层/兼容目录
    let skill_service = skill::SkillService::new(
        skill::Platform::Android,
        config::app_data_dir(data_dir.as_ref()).unwrap_or_else(|_| PathBuf::from(".")),
        workspace_root(),
    )
    .await;

    // 启动优化：内置技能安装 + 首次技能扫描移到后台异步执行，
    // 不阻塞 HTTP 监听（skill 服务本身已就绪，扫描完成前 list 返回空列表）。
    {
        let svc = skill_service.clone();
        tokio::spawn(async move {
            svc.install_builtin_skills().await;
            let changed = svc.discover().await;
            tracing::info!("skill initial scan done: {} changed", changed.len());
        });
    }

    let http = Arc::new(
        Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .pool_idle_timeout(std::time::Duration::from_secs(60))
            .build()?,
    );

    let startup_nonce = generate_nonce();

    // 手机助手：原生桥 + 执行轨迹 + 脚本引擎（规格书 8.1）
    let scripts_dir = config::app_data_dir(data_dir.as_ref())
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("scripts");
    let script_registry = Arc::new(script::ScriptRegistry::load(scripts_dir).await?);
    let native_bridge = agent::NativeBridge::new();
    let trace_store = Arc::new(agent::TraceStore::new());
    let script_engine = script::ScriptEngine::new(
        script_registry,
        native_bridge.clone(),
        trace_store.clone(),
    );
    let agent_router = agent::AgentRouter::new(native_bridge, trace_store, script_engine);

    // 后台保活客户端（复用原生桥 base_url；桌面端无桥时自动禁用）
    let keepalive = keepalive::KeepAlive::from_env();

    let state = AppState { store, app_data, http, task_store, read_tracker, file_history, skill_service, agent_router, keepalive, approvals: Arc::new(Mutex::new(HashMap::new())), startup_nonce };

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(
            |origin: &axum::http::HeaderValue, _request_parts: &axum::http::request::Parts| {
                if let Ok(orig_str) = origin.to_str() {
                    orig_str.starts_with("http://localhost")
                        || orig_str.starts_with("http://127.0.0.1")
                        || orig_str.starts_with("tauri://")
                        || orig_str.starts_with("http://tauri.localhost")
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
        // 工具调用：执行单个工具并返回结果
        .route("/api/tools/execute", post(execute_tool_handler))
        // 任务管理：CRUD，按 chatId 隔离
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/:id", get(get_task_handler).patch(update_task_full))
        // 文件回退系统：Turn 级回退 / 选择性回退 / 变更查询 / 模式管理 / SAF 同步
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
        // 手机助手 Agent（规格书 8.1）：通用工具调用 / schema 同步 / 执行轨迹 / 桥健康 / 权限引导
        .route("/api/agent/tool", post(agent_tool_handler))
        .route("/api/agent/tool-schemas", get(agent_tool_schemas_handler))
        .route("/api/agent/trace", get(agent_trace_handler))
        .route("/api/agent/health", get(agent_health_handler))
        .route("/api/agent/permission", get(agent_permission_state_handler))
        .route("/api/agent/permission/open", post(agent_permission_open_handler))
        // 后台保活引导（电池优化白名单）
        .route("/api/agent/keepalive/status", get(keepalive_status_handler))
        .route("/api/agent/keepalive/request-exempt", post(keepalive_request_exempt_handler))
        .route("/api/agent/keepalive/open-settings", post(keepalive_open_settings_handler))
        // AI 活动悬浮窗权限
        .route("/api/agent/overlay/permission", get(overlay_permission_handler))
        .route("/api/agent/overlay/open-settings", post(overlay_open_settings_handler))
        .route("/api/agent/overlay/hide", post(overlay_hide_handler))
        // 脚本注册表 CRUD + 运行 + 校验 + 导入（DSL §12）
        .route("/api/agent/scripts", get(list_scripts_handler))
        .route("/api/agent/scripts/validate", post(validate_script_handler))
        .route("/api/agent/scripts/import", post(import_script_handler))
        .route(
            "/api/agent/scripts/:name",
            get(get_script_handler).put(upsert_script_handler).delete(delete_script_handler),
        )
        .route("/api/agent/scripts/:name/enabled", post(set_script_enabled_handler))
        .route("/api/agent/scripts/:name/run", post(run_script_handler))
        // Skill 系统（规格书 §2/§10.1）：管理 / 引用 / 设置 / Android 导入
        .route("/api/skills", get(list_skills_handler).post(create_skill_handler))
        .route("/api/skills/refresh", post(refresh_skills_handler))
        .route("/api/approval/notify", post(approval_notify_handler))
        .route("/api/approval/result", post(approval_result_handler))
        .route("/api/approval/results", get(approval_results_handler))
        .route("/api/skills/settings", get(get_skill_settings_handler).put(update_skill_settings_handler))
        .route("/api/skills/import", post(import_skill_handler))
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
