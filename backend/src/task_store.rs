//! 任务管理存储模块。
//!
//! 提供持久化的任务 CRUD 能力，支撑 TaskCreate / TaskUpdate / TaskList / TaskGet
//! 四个工具调用。任务以会话维度隔离：每个 chat 拥有独立的任务列表。
//!
//! 持久化设计：
//! - 每个 task 存储为独立的 JSON 文件：`<tasks_dir>/<chat_id>/<task_id>.json`
//! - 写操作采用 write-through 策略：先更新内存，再同步写磁盘（tmp + rename 原子写入）
//! - 读操作纯内存：仅在首次访问某 chat 的桶时从磁盘惰性加载
//! - 启动时无需扫描全部 chat，零额外启动开销
//!
//! 并发设计：
//! - 使用 `Arc<RwLock<...>>` 实现多读者并发安全；
//! - 任务 ID 为自增整数字符串，重启后从磁盘恢复最大 ID 继续递增，避免 ID 复用；
//! - 任务状态遵循 `pending → in_progress → completed | failed` 的生命周期。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::error::AppError;

/// 任务状态。沿用 cc-haha / Claude Code 的四态生命周期。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

impl Default for TaskStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// 单个任务条目。字段对齐前端 `Task` 接口与 cc-haha 的语义。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// 自增数字 ID（字符串形式，便于协议序列化）。
    pub id: String,
    /// 简短标题。
    pub subject: String,
    /// 可选的详细描述。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 当前状态。
    pub status: TaskStatus,
    /// 创建时间（Unix 秒）。
    pub created_at: u64,
    /// 最近更新时间（Unix 秒）。
    pub updated_at: u64,
}

/// 任务创建请求体。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub subject: String,
    #[serde(default)]
    pub description: Option<String>,
    /// 可选初始状态；缺省为 Pending。
    #[serde(default)]
    pub status: Option<TaskStatus>,
}

/// 任务更新请求体。所有字段可选，仅更新提供的字段。
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskRequest {
    #[serde(default)]
    pub subject: Option<String>,
    #[serde(default)]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
}

/// 单个会话的任务存储（内存层）。同一 chat 内的任务共享一个实例。
struct ChatTaskState {
    tasks: HashMap<String, Task>,
    next_id: AtomicU64,
}

impl ChatTaskState {
    fn empty() -> Self {
        Self {
            tasks: HashMap::new(),
            next_id: AtomicU64::new(1),
        }
    }

    fn allocate_id(&self) -> String {
        self.next_id.fetch_add(1, Ordering::Relaxed).to_string()
    }

    /// 从已有任务集合构建，自动推断下一个可用 ID。
    fn from_tasks(tasks: HashMap<String, Task>) -> Self {
        let max_id = tasks
            .keys()
            .filter_map(|k| k.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        Self {
            tasks,
            next_id: AtomicU64::new(max_id + 1),
        }
    }
}

/// 全局任务存储。按 chatId 分桶隔离，内存为主、磁盘为备份。
#[derive(Clone)]
pub struct TaskStore {
    chats: Arc<RwLock<HashMap<String, Arc<RwLock<ChatTaskState>>>>>,
    /// 持久化根目录：`<app_data>/tasks/`
    tasks_dir: PathBuf,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ─── 磁盘 I/O 辅助 ───────────────────────────────────────────────────────────

impl TaskStore {
    /// chat 对应的子目录路径。
    fn chat_dir(&self, chat_id: &str) -> PathBuf {
        self.tasks_dir.join(chat_id)
    }

    /// 单个 task JSON 文件的路径。
    fn task_path(&self, chat_id: &str, task_id: &str) -> PathBuf {
        self.chat_dir(chat_id).join(format!("{task_id}.json"))
    }

    /// 从磁盘加载指定 chat 的全部任务，返回填充好的内存状态。
    async fn load_chat_tasks(&self, chat_id: &str) -> ChatTaskState {
        let dir = self.chat_dir(chat_id);
        if !dir.is_dir() {
            return ChatTaskState::empty();
        }

        let mut tasks: HashMap<String, Task> = HashMap::new();

        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("无法读取任务目录 {}: {e}", dir.display());
                return ChatTaskState::empty();
            }
        };

        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }

            match tokio::fs::read_to_string(&path).await {
                Ok(content) => match serde_json::from_str::<Task>(&content) {
                    Ok(task) => {
                        tasks.insert(task.id.clone(), task);
                    }
                    Err(e) => {
                        tracing::warn!("跳过损坏的任务文件 {}: {e}", path.display());
                    }
                },
                Err(e) => {
                    tracing::warn!("无法读取任务文件 {}: {e}", path.display());
                }
            }
        }

        if tasks.is_empty() {
            ChatTaskState::empty()
        } else {
            let count = tasks.len();
            let state = ChatTaskState::from_tasks(tasks);
            tracing::info!("从磁盘加载 chat={chat_id} 的 {count} 个任务，next_id={}",
                state.next_id.load(Ordering::Relaxed));
            state
        }
    }

    /// 将单个 task 写入磁盘。使用 tmp + rename 保证原子性。
    async fn save_task_to_disk(&self, chat_id: &str, task: &Task) {
        let dir = self.chat_dir(chat_id);
        if let Err(e) = tokio::fs::create_dir_all(&dir).await {
            tracing::error!("无法创建任务目录 {}: {e}", dir.display());
            return;
        }

        let path = self.task_path(chat_id, &task.id);
        let content = match serde_json::to_string_pretty(task) {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("无法序列化任务 {}: {e}", task.id);
                return;
            }
        };

        // 原子写入：先写临时文件，再 rename 覆盖目标
        let tmp_path = path.with_extension("tmp");
        if let Err(e) = tokio::fs::write(&tmp_path, &content).await {
            tracing::error!("写入任务文件失败 {}: {e}", tmp_path.display());
            return;
        }
        if let Err(e) = tokio::fs::rename(&tmp_path, &path).await {
            tracing::error!(
                "rename 任务文件失败 {} -> {}: {e}",
                tmp_path.display(),
                path.display()
            );
            let _ = tokio::fs::remove_file(&tmp_path).await;
        }
    }

    /// 从磁盘删除单个 task 文件。
    async fn delete_task_from_disk(&self, chat_id: &str, task_id: &str) {
        let path = self.task_path(chat_id, task_id);
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => tracing::warn!("删除任务文件失败 {}: {e}", path.display()),
        }
    }
}

// ─── CRUD API ─────────────────────────────────────────────────────────────────

impl TaskStore {
    /// 创建 TaskStore 实例。
    ///
    /// `tasks_dir` 为持久化根目录，通常为 `<app_data>/tasks`。
    /// 目录会在首次写入时自动创建。
    pub fn new(tasks_dir: PathBuf) -> Self {
        Self {
            chats: Arc::new(RwLock::new(HashMap::new())),
            tasks_dir,
        }
    }

    /// 获取（或惰性创建/加载）指定会话的任务桶。
    ///
    /// - 桶已存在于内存 → 直接返回（读锁 O(1)）；
    /// - 桶不存在 → 尝试从磁盘加载，无磁盘数据则创建空桶。
    async fn bucket(&self, chat_id: &str) -> Arc<RwLock<ChatTaskState>> {
        // 读锁优先：大多数情况下桶已在内存中
        if let Some(b) = self.chats.read().await.get(chat_id) {
            return b.clone();
        }
        // 双检：升写锁前再确认一次
        let mut chats = self.chats.write().await;
        if let Some(b) = chats.get(chat_id) {
            return b.clone();
        }
        // 惰性加载：优先从磁盘恢复，无数据则空桶
        let bucket = Arc::new(RwLock::new(self.load_chat_tasks(chat_id).await));
        chats.insert(chat_id.to_string(), bucket.clone());
        bucket
    }

    /// 创建任务。内存写入后同步持久化到磁盘。
    pub async fn create(&self, chat_id: &str, req: CreateTaskRequest) -> Result<Task, AppError> {
        if req.subject.trim().is_empty() {
            return Err(AppError::ToolExecutionError("subject 不能为空".to_string()));
        }
        let bucket = self.bucket(chat_id).await;
        let mut state = bucket.write().await;
        let id = state.allocate_id();
        let now = now_secs();
        let task = Task {
            id,
            subject: req.subject,
            description: req.description,
            status: req.status.unwrap_or_default(),
            created_at: now,
            updated_at: now,
        };
        state.tasks.insert(task.id.clone(), task.clone());
        // drop 写锁后再写磁盘，避免阻塞其他读请求
        drop(state);
        self.save_task_to_disk(chat_id, &task).await;
        Ok(task)
    }

    /// 获取单个任务。
    pub async fn get(&self, chat_id: &str, task_id: &str) -> Result<Task, AppError> {
        let bucket = self.bucket(chat_id).await;
        let state = bucket.read().await;
        state
            .tasks
            .get(task_id)
            .cloned()
            .ok_or(AppError::TaskNotFound)
    }

    /// 列出指定会话下的全部任务，按 ID 升序返回。
    pub async fn list(&self, chat_id: &str) -> Vec<Task> {
        let bucket = self.bucket(chat_id).await;
        let state = bucket.read().await;
        let mut tasks: Vec<Task> = state.tasks.values().cloned().collect();
        tasks.sort_by(|a, b| a.id.cmp(&b.id));
        tasks
    }

    /// 更新任务。仅更新请求中提供的字段，内存修改后同步持久化。
    pub async fn update(
        &self,
        chat_id: &str,
        task_id: &str,
        req: UpdateTaskRequest,
    ) -> Result<Task, AppError> {
        let bucket = self.bucket(chat_id).await;
        let mut state = bucket.write().await;
        let task = state
            .tasks
            .get_mut(task_id)
            .ok_or(AppError::TaskNotFound)?;

        if let Some(subject) = req.subject {
            if subject.trim().is_empty() {
                return Err(AppError::ToolExecutionError(
                    "subject 不能为空".to_string(),
                ));
            }
            task.subject = subject;
        }
        if let Some(description) = req.description {
            task.description = description;
        }
        if let Some(status) = req.status {
            task.status = status;
        }
        task.updated_at = now_secs();
        let result = task.clone();
        // drop 写锁后再写磁盘
        drop(state);
        self.save_task_to_disk(chat_id, &result).await;
        Ok(result)
    }

    /// 清空指定会话下的所有任务（内存 + 磁盘）。
    #[allow(dead_code)]
    pub async fn clear(&self, chat_id: &str) {
        let bucket = self.bucket(chat_id).await;
        let mut state = bucket.write().await;
        let ids: Vec<String> = state.tasks.keys().cloned().collect();
        state.tasks.clear();
        state.next_id.store(1, Ordering::Relaxed);
        drop(state);

        for id in &ids {
            self.delete_task_from_disk(chat_id, id).await;
        }
        // 尝试删除空目录
        let dir = self.chat_dir(chat_id);
        let _ = tokio::fs::remove_dir(&dir).await;
    }
}

impl Default for TaskStore {
    fn default() -> Self {
        Self::new(PathBuf::from("."))
    }
}
