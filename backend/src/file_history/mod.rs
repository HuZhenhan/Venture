//! 文件修改回退系统 — 模块入口与核心类型定义。
//!
//! 三层架构：
//! - **ChangeJournal**（因果层）：append-only 事件流，记录每次文件状态转换
//! - **VersionStore**（状态层）：管理 FileVersion 节点，每个版本可独立重建
//! - **ObjectStore**（编码层）：内容寻址存储（CAS），Phase 1 使用 FullManifest
//!
//! 核心不变量：Journal 中每一条 committed ChangeRecord 连接两个可独立重建的 FileVersion。

pub mod delta;
pub mod gc;
pub mod journal;
pub mod merge;
pub mod object_store;
pub mod rollback;
pub mod saf_proxy;
pub mod version_store;

pub use journal::{ChangeJournal, WalIntent, SyncInReport, SyncOutReport, SyncOutFailure};
pub use merge::{diff3_merge, MergeResult, ConflictInfo, Diff3Chunk};
pub use object_store::{ObjectStore, ObjectId, FullManifest, ChunkRef};
pub use rollback::{
    revert_record, revert_turn, revert_records, revert_after_message, revert_file_all,
    detect_external_edits_local, with_file_lock, try_fast_hunk_revert,
};
pub use saf_proxy::{SafProxy, SafConfig};
pub use version_store::{VersionStore, FileVersion, VersionRepresentation, FileMeta, VersionId};

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::AppError;

// ─── 标识符类型 ───────────────────────────────────────────────────────────

/// ChangeRecord 的唯一标识。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct RecordId(pub String);

impl RecordId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }
}

impl Default for RecordId {
    fn default() -> Self {
        Self::new()
    }
}

/// 一轮对话的标识（对应一条 user message）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct TurnId(pub String);

impl TurnId {
    pub fn external() -> Self {
        Self("__external__".to_string())
    }

    pub fn is_external(&self) -> bool {
        self.0 == "__external__"
    }
}

/// 消息标识（用于消息时间点级回退）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct MessageId(pub String);

impl MessageId {
    pub fn external() -> Self {
        Self("__external__".to_string())
    }
}

// ─── 变更类型 ─────────────────────────────────────────────────────────────

/// 文件变更的种类。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    /// 新建文件
    Create,
    /// 修改文件内容
    Modify,
    /// 删除文件
    Delete,
    /// 重命名文件（path_before ≠ path_after）
    Rename,
}

/// 变更来源。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeSource {
    /// AI 工具执行
    Agent,
    /// 外部编辑（用户在编辑器中手动修改）
    ExternalEdit,
    /// 用户手动操作
    UserManual,
}

// ─── ChangeRecord（因果层核心结构）─────────────────────────────────────────

/// 一条文件变更记录，连接两个 FileVersion。
///
/// 这是 Journal 中的基本单元：每条记录描述一次文件状态转换
/// （pre → post），附带因果上下文（turn_id / message_id）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRecord {
    /// 记录唯一 ID
    pub id: RecordId,
    /// 所属对话轮次 ID
    pub turn_id: TurnId,
    /// 所属消息 ID
    pub message_id: MessageId,
    /// 修改前路径（None 表示文件原本不存在，如 Create）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_before: Option<PathBuf>,
    /// 修改后路径（None 表示文件被删除）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_after: Option<PathBuf>,
    /// 变更种类
    pub kind: ChangeKind,
    /// 变更来源
    pub source: ChangeSource,
    /// 时间戳（Unix 毫秒）
    pub timestamp: u64,
    /// 修改前版本 ID
    pub pre: VersionId,
    /// 修改后版本 ID
    pub post: VersionId,
}

// ─── 备份模式 ─────────────────────────────────────────────────────────────

/// 备份模式。
///
/// - Snapshot：强制全量备份（CC 模式），回退时整文件覆盖
/// - Hunks：行级差分追踪（Grok 模式），支持选择性接受/拒绝 hunk
/// - Auto：根据文件大小、修改频率自动选择策略
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BackupMode {
    Snapshot,
    Hunks,
    Auto,
}

impl Default for BackupMode {
    fn default() -> Self {
        BackupMode::Snapshot
    }
}

// ─── 配置 ─────────────────────────────────────────────────────────────────

/// 回退系统配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryConfig {
    /// 备份模式
    #[serde(default)]
    pub backup_mode: BackupMode,
    /// 路径级策略覆盖（glob → mode）
    #[serde(default)]
    pub path_overrides: Vec<PathOverride>,
    /// 配额设置
    #[serde(default)]
    pub quota: QuotaConfig,
    /// Phase 2 阈值配置
    #[serde(default)]
    pub thresholds: ThresholdConfig,
    /// Phase 2 锚点配置
    #[serde(default)]
    pub anchors: AnchorConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathOverride {
    pub glob_pattern: String,
    pub mode: BackupMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaConfig {
    /// 本地存储最大空间（字节）
    pub max_total_size: u64,
    /// SAF 工作区最大空间（字节）
    pub saf_max_total_size: u64,
    /// 警告阈值（0.0-1.0）
    pub warn_threshold: f64,
}

impl Default for QuotaConfig {
    fn default() -> Self {
        Self {
            max_total_size: 500 * 1024 * 1024,       // 500MB
            saf_max_total_size: 200 * 1024 * 1024,    // 200MB
            warn_threshold: 0.8,
        }
    }
}

/// Phase 2 阈值配置：影响 Auto 模式的存储决策。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThresholdConfig {
    /// 小于此阈值 → 全量备份（成本可忽略）
    pub small_file_threshold: usize,
    /// 大于此阈值 → UnrecoverableHashOnly（不可精确回退）
    pub large_file_threshold: usize,
    /// Delta 压缩后小于 post 的此比例 → 使用 Delta 编码
    pub delta_ratio_threshold: f64,
    /// 同一文件本次会话修改次数达到此值 → 使用 Delta 编码
    pub high_frequency_writes: usize,
    /// 外部编辑历史是否惩罚 Delta（强制使用 FullManifest）
    pub external_edit_penalty: bool,
}

impl Default for ThresholdConfig {
    fn default() -> Self {
        Self {
            small_file_threshold: 256 * 1024,        // 256KB
            large_file_threshold: 50 * 1024 * 1024,  // 50MB
            delta_ratio_threshold: 0.7,
            high_frequency_writes: 3,
            external_edit_penalty: true,
        }
    }
}

/// Phase 2 锚点配置：Delta 链过长时定期插入 FullManifest。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorConfig {
    /// Delta 链最大长度，超过则插入锚点
    pub max_hunk_chain_length: usize,
    /// 自动锚点间隔（分钟）
    pub auto_anchor_interval_minutes: u64,
}

impl Default for AnchorConfig {
    fn default() -> Self {
        Self {
            max_hunk_chain_length: 20,
            auto_anchor_interval_minutes: 10,
        }
    }
}

impl Default for FileHistoryConfig {
    fn default() -> Self {
        Self {
            backup_mode: BackupMode::default(),
            path_overrides: Vec::new(),
            quota: QuotaConfig::default(),
            thresholds: ThresholdConfig::default(),
            anchors: AnchorConfig::default(),
        }
    }
}

impl FileHistoryConfig {
    /// 根据文件路径解析实际生效的备份模式（path 覆盖 > 全局设置）。
    pub fn resolve_mode(&self, path: &std::path::Path) -> BackupMode {
        let path_str = path.to_string_lossy();
        for override_entry in &self.path_overrides {
            if glob::glob(&override_entry.glob_pattern)
                .ok()
                .map(|mut iter| iter.any(|p| p.map(|p| p == path).unwrap_or(false)))
                .unwrap_or(false)
            {
                return override_entry.mode;
            }
        }
        // 简单的 glob 匹配：直接用 glob crate 对路径做匹配
        for override_entry in &self.path_overrides {
            if let Ok(re) = glob_to_regex(&override_entry.glob_pattern) {
                if re.is_match(&*path_str) {
                    return override_entry.mode;
                }
            }
        }
        self.backup_mode
    }
}

/// 简易 glob → 正则转换。
fn glob_to_regex(glob: &str) -> Result<regex::Regex, regex::Error> {
    let mut out = String::new();
    out.push('^');
    let mut chars = glob.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    out.push_str(".*");
                } else {
                    out.push_str("[^/]*");
                }
            }
            '?' => out.push('.'),
            '.' | '+' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('$');
    regex::Regex::new(&out)
}

// ─── 回退结果 ─────────────────────────────────────────────────────────────

/// Turn 级回退结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreTurnResult {
    /// 已恢复的文件路径列表
    pub restored_files: Vec<String>,
    /// 冲突信息列表
    pub conflicts: Vec<ConflictInfo>,
    /// 错误信息列表
    pub errors: Vec<String>,
}

/// 已追踪文件信息（用于外部编辑检测）。
#[derive(Debug, Clone)]
pub struct TrackedFile {
    /// 工作区中的路径
    pub path: PathBuf,
    /// 最后已知版本的 ID
    pub last_known_version: VersionId,
    /// 最后已知版本的 content_hash
    pub last_known_hash: [u8; 32],
}

/// 写入上下文：为 auto_decide() 提供文件的历史修改信息。
///
/// 由 WriteTracker 在运行时维护，每次工具写入时更新。
#[derive(Debug, Clone, Default)]
pub struct WriteContext {
    /// 该文件本次会话的写入次数
    pub write_count: usize,
    /// 该文件最近的外部编辑次数
    pub external_edit_count: usize,
}

/// 写入追踪器：运行时维护每个文件的修改统计信息。
///
/// 用于 auto_decide() 决策树：
/// - write_count_this_session ≥ high_frequency_writes → Delta 编码
/// - recent_external_edits > 0 → FullManifest 兜底
pub struct WriteTracker {
    /// 路径 → WriteContext
    inner: Mutex<HashMap<PathBuf, WriteContext>>,
}

impl WriteTracker {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 记录一次工具写入。
    pub async fn record_write(&self, path: &std::path::Path) {
        let mut map = self.inner.lock().await;
        let ctx = map.entry(path.to_path_buf()).or_default();
        ctx.write_count += 1;
    }

    /// 记录一次外部编辑。
    pub async fn record_external_edit(&self, path: &std::path::Path) {
        let mut map = self.inner.lock().await;
        let ctx = map.entry(path.to_path_buf()).or_default();
        ctx.external_edit_count += 1;
    }

    /// 获取某文件的写入上下文。
    pub async fn get_context(&self, path: &std::path::Path) -> WriteContext {
        let map = self.inner.lock().await;
        map.get(path).cloned().unwrap_or_default()
    }

    /// 获取某文件本次会话的写入次数。
    pub async fn write_count_this_session(&self, path: &std::path::Path) -> usize {
        self.get_context(path).await.write_count
    }

    /// 获取某文件最近的外部编辑次数。
    pub async fn recent_external_edits(&self, path: &std::path::Path) -> usize {
        self.get_context(path).await.external_edit_count
    }

    /// 重置某文件的统计（新会话开始时调用）。
    pub async fn reset_file(&self, path: &std::path::Path) {
        let mut map = self.inner.lock().await;
        map.remove(path);
    }

    /// 清空所有统计。
    pub async fn clear(&self) {
        self.inner.lock().await.clear();
    }
}

impl Default for WriteTracker {
    fn default() -> Self {
        Self::new()
    }
}

// ─── FileHistory：组合入口 ────────────────────────────────────────────────

/// 文件回退系统的组合入口，持有 Journal / VersionStore / ObjectStore 的引用。
///
/// 所有操作通过此结构协调，确保三层一致性。
pub struct FileHistory {
    pub journal: Arc<ChangeJournal>,
    pub version_store: Arc<VersionStore>,
    pub object_store: Arc<ObjectStore>,
    /// 配置（运行时可修改）
    config: Arc<Mutex<FileHistoryConfig>>,
    /// SAF 代理（若工作区为 SAF 模式则激活）
    pub saf_proxy: Arc<Mutex<Option<SafProxy>>>,
    /// 写入追踪器（Phase 2：为 auto_decide 提供决策上下文）
    pub write_tracker: Arc<WriteTracker>,
}

impl FileHistory {
    /// 创建新的 FileHistory 实例，初始化所有存储目录。
    pub async fn new(base_dir: PathBuf) -> Result<Self, AppError> {
        let objects_dir = base_dir.join("objects");
        let versions_dir = base_dir.join("versions");
        let journal_dir = base_dir.join("journal");
        let wal_dir = journal_dir.join("wal");

        tokio::fs::create_dir_all(&objects_dir).await
            .map_err(|e| AppError::Internal(format!("创建 objects 目录失败：{e}")))?;
        tokio::fs::create_dir_all(&versions_dir).await
            .map_err(|e| AppError::Internal(format!("创建 versions 目录失败：{e}")))?;
        tokio::fs::create_dir_all(&wal_dir).await
            .map_err(|e| AppError::Internal(format!("创建 wal 目录失败：{e}")))?;

        let object_store = Arc::new(ObjectStore::new(objects_dir));
        let version_store = Arc::new(VersionStore::new(versions_dir, object_store.clone()));
        let journal = Arc::new(ChangeJournal::new(journal_dir, wal_dir));
        let config = Arc::new(Mutex::new(FileHistoryConfig::default()));
        let saf_proxy = Arc::new(Mutex::new(None));
        let write_tracker = Arc::new(WriteTracker::new());

        Ok(Self {
            journal,
            version_store,
            object_store,
            config,
            saf_proxy,
            write_tracker,
        })
    }

    /// 获取配置快照。
    pub async fn config(&self) -> FileHistoryConfig {
        self.config.lock().await.clone()
    }

    /// 更新配置。
    pub async fn set_config(&self, new_config: FileHistoryConfig) {
        *self.config.lock().await = new_config;
    }

    /// 设置备份模式（全局）。
    pub async fn set_backup_mode(&self, mode: BackupMode) {
        let mut cfg = self.config.lock().await;
        cfg.backup_mode = mode;
    }

    /// 启动时执行 WAL 崩溃恢复。
    pub async fn recover_from_wal(&self) -> Result<(), AppError> {
        self.journal.recover_from_wal(&self.version_store).await
    }

    /// 计算内容的 BLAKE3 哈希。
    pub fn hash_content(content: &[u8]) -> [u8; 32] {
        *blake3::hash(content).as_bytes()
    }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────

/// 获取当前 Unix 时间戳（毫秒）。
pub fn now_millis() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 将字节数组转为十六进制字符串。
pub fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 将十六进制字符串转为字节数组。
pub fn hex_to_bytes(hex: &str) -> Result<[u8; 32], AppError> {
    if hex.len() != 64 {
        return Err(AppError::Internal(format!("无效的哈希长度：{}（期望 64）", hex.len())));
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let hi = hex_val(chunk[0])?;
        let lo = hex_val(chunk[1])?;
        out[i] = (hi << 4) | lo;
    }
    Ok(out)
}

fn hex_val(c: u8) -> Result<u8, AppError> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(AppError::Internal(format!("无效的十六进制字符：{}", c as char))),
    }
}
