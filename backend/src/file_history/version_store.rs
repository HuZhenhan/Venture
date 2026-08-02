//! 版本存储（状态层）。
//!
//! 管理 FileVersion 节点。每个版本记录文件的元数据 + 一种或多种物化表示。
//! Phase 1 仅使用 FullManifest 表示；Phase 2 引入 Delta 编码。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::sync::RwLock;

use crate::error::AppError;

use super::object_store::{FullManifest, ObjectId, ObjectStore};
use super::{now_millis, bytes_to_hex, hex_to_bytes, BackupMode, WriteContext, ThresholdConfig};

/// 版本 ID（十六进制字符串形式，便于文件名和序列化）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct VersionId(pub String);

impl VersionId {
    pub fn new() -> Self {
        Self(uuid::Uuid::new_v4().to_string())
    }

    /// 创建墓碑版本的 ID（文件被删除时的占位版本）。
    pub fn tombstone() -> Self {
        Self("__tombstone__".to_string())
    }

    pub fn is_tombstone(&self) -> bool {
        self.0 == "__tombstone__"
    }
}

impl Default for VersionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for VersionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 文件元数据。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    /// 文件大小（字节）
    pub size: u64,
    /// 最后修改时间（Unix 毫秒）
    pub mtime: u64,
    /// 文件权限/属性（Unix mode 或 Windows attributes）
    #[serde(default)]
    pub mode: u32,
}

impl FileMeta {
    /// 从文件路径读取元数据。
    pub fn from_path(path: &std::path::Path) -> Result<Self, AppError> {
        let meta = std::fs::metadata(path)
            .map_err(|e| AppError::Internal(format!("读取文件元数据失败：{e}")))?;
        let mtime = meta.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            meta.permissions().mode()
        };
        #[cfg(not(unix))]
        let mode = {
            // Windows：简单标记是否只读
            if meta.permissions().readonly() { 0o444 } else { 0o644 }
        };

        Ok(Self {
            size: meta.len(),
            mtime,
            mode,
        })
    }

    /// 墓碑版本的元数据（文件已删除）。
    pub fn tombstone() -> Self {
        Self {
            size: 0,
            mtime: 0,
            mode: 0,
        }
    }
}

/// 版本的物化表示。
///
/// 一个 FileVersion 可以有多种表示（FullManifest + Delta 等），
/// 物化时选择第一个可用的表示。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum VersionRepresentation {
    /// 完整内容，以 chunk manifest 存储（Phase 1 唯一使用的表示）
    FullManifest {
        manifest: ObjectId,
    },
    /// Phase 2: 从 base 通过二进制压缩 patch 重建
    Delta {
        base: VersionId,
        patch: ObjectId,
    },
    /// 文件已删除 / 墓碑版本
    Tombstone,
    /// Phase 2: 仅哈希，不可精确回退，仅审计
    UnrecoverableHashOnly {
        hash: String,
        reason: String,
    },
}

/// 文件版本节点。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    /// 版本唯一 ID
    pub id: VersionId,
    /// 内容哈希（BLAKE3，十六进制字符串）
    pub content_hash: String,
    /// 文件元数据
    pub file_meta: FileMeta,
    /// 物化表示列表
    pub representations: Vec<VersionRepresentation>,
    /// 创建时间戳
    pub created_at: u64,
}

/// 版本存储。
pub struct VersionStore {
    /// 版本元数据存储目录：`.mytool/versions/`
    versions_dir: PathBuf,
    /// 对象存储引用
    object_store: Arc<ObjectStore>,
    /// 内存缓存：VersionId → FileVersion
    cache: RwLock<HashMap<String, FileVersion>>,
    /// Delta 链长度追踪（路径 → 当前链长度，用于锚点机制）
    hunk_chain_lengths: RwLock<HashMap<String, usize>>,
}

impl VersionStore {
    pub fn new(versions_dir: PathBuf, object_store: Arc<ObjectStore>) -> Self {
        Self {
            versions_dir,
            object_store,
            cache: RwLock::new(HashMap::new()),
            hunk_chain_lengths: RwLock::new(HashMap::new()),
        }
    }

    /// 版元数据文件的磁盘路径。
    fn version_path(&self, id: &VersionId) -> PathBuf {
        self.versions_dir.join(format!("{}.json", id.0))
    }

    /// 返回版本存储目录路径（供 GC 模块使用）。
    pub fn versions_dir(&self) -> &std::path::Path {
        &self.versions_dir
    }

    /// 更新已存在的版本（供 GC 锚点压缩使用）。
    pub async fn update_version(&self, version: &FileVersion) -> Result<(), AppError> {
        self.persist_version(version).await?;
        self.cache.write().await.insert(version.id.0.clone(), version.clone());
        Ok(())
    }

    /// 创建一个新版本，存储内容并返回 FileVersion。
    pub async fn create_version(
        &self,
        content: &[u8],
        meta: FileMeta,
    ) -> Result<FileVersion, AppError> {
        let id = VersionId::new();
        let content_hash = bytes_to_hex(&*blake3::hash(content).as_bytes());
        let manifest = self.object_store.store_chunked(content).await?;
        let manifest_id = self.object_store.store_manifest_json(&manifest).await?;

        let version = FileVersion {
            id: id.clone(),
            content_hash,
            file_meta: meta,
            representations: vec![VersionRepresentation::FullManifest {
                manifest: manifest_id,
            }],
            created_at: now_millis(),
        };

        self.persist_version(&version).await?;
        self.cache.write().await.insert(id.0.clone(), version.clone());
        Ok(version)
    }

    /// 创建墓碑版本（文件被删除时使用）。
    pub async fn create_tombstone(&self) -> Result<FileVersion, AppError> {
        let id = VersionId::tombstone();
        let version = FileVersion {
            id: id.clone(),
            content_hash: String::new(),
            file_meta: FileMeta::tombstone(),
            representations: vec![VersionRepresentation::Tombstone],
            created_at: now_millis(),
        };
        // 墓碑版本不持久化到磁盘（它是语义占位符）
        self.cache.write().await.insert(id.0.clone(), version.clone());
        Ok(version)
    }

    /// 确保某个版本存在（若已有相同内容的版本则复用）。
    ///
    /// Phase 1 简化实现：总是创建新版本。Phase 2 可通过 content_hash 去重。
    pub async fn ensure_version(
        &self,
        content: &[u8],
        meta: FileMeta,
    ) -> Result<FileVersion, AppError> {
        self.create_version(content, meta).await
    }

    /// 持久化版本元数据到磁盘。
    async fn persist_version(&self, version: &FileVersion) -> Result<(), AppError> {
        let path = self.version_path(&version.id);
        let json = serde_json::to_vec_pretty(version)
            .map_err(|e| AppError::Internal(format!("序列化版本失败：{e}")))?;

        // 原子写入
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, &json).await
            .map_err(|e| AppError::Internal(format!("写入版本文件失败：{e}")))?;
        fs::rename(&tmp, &path).await
            .map_err(|e| AppError::Internal(format!("重命名版本文件失败：{e}")))?;
        Ok(())
    }

    /// 获取版本（优先从缓存读取，回退到磁盘）。
    pub async fn get(&self, id: &VersionId) -> Result<FileVersion, AppError> {
        // 墓碑版本特殊处理
        if id.is_tombstone() {
            return self.create_tombstone().await;
        }

        // 缓存
        {
            let cache = self.cache.read().await;
            if let Some(v) = cache.get(&id.0) {
                return Ok(v.clone());
            }
        }

        // 磁盘
        let path = self.version_path(id);
        let data = fs::read(&path).await
            .map_err(|e| AppError::Internal(format!("读取版本 {} 失败：{e}", id.0)))?;
        let version: FileVersion = serde_json::from_slice(&data)
            .map_err(|e| AppError::Internal(format!("反序列化版本失败：{e}")))?;

        self.cache.write().await.insert(id.0.clone(), version.clone());
        Ok(version)
    }

    /// 物化版本：将版本内容重建为字节数组。
    ///
    /// 递归处理 Delta 链（Phase 2），Phase 1 仅处理 FullManifest。
    /// 使用 Box::pin 处理递归 async fn。
    pub fn materialize<'a>(
        &'a self,
        id: &'a VersionId,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, AppError>> + Send + 'a>> {
        Box::pin(async move {
            let version = self.get(id).await?;

            for rep in &version.representations {
                match rep {
                    VersionRepresentation::FullManifest { manifest } => {
                        let m = self.object_store.get_manifest_json(manifest).await?;
                        return self.object_store.get_manifest(&m).await;
                    }
                    VersionRepresentation::Tombstone => {
                        return Err(AppError::Internal(
                            "无法物化墓碑版本（文件已被删除）".to_string()
                        ));
                    }
                    VersionRepresentation::Delta { base, patch } => {
                        // Phase 2: 递归物化 base，然后 apply binary delta patch
                        let base_content = self.materialize(base).await?;
                        let patch_data = self.object_store.get(patch).await?;
                        let reconstructed = super::delta::apply_delta(&base_content, &patch_data)?;
                        return Ok(reconstructed);
                    }
                    VersionRepresentation::UnrecoverableHashOnly { hash, reason } => {
                        return Err(AppError::Internal(format!(
                            "版本不可恢复（hash={}, reason={}）", hash, reason
                        )));
                    }
                }
            }

            Err(AppError::Internal(format!(
                "版本 {} 没有可用的物化表示", id.0
            )))
        })
    }

    /// 获取版本的 content_hash（字节数组形式）。
    pub async fn get_content_hash(&self, id: &VersionId) -> Result<[u8; 32], AppError> {
        let version = self.get(id).await?;
        hex_to_bytes(&version.content_hash)
    }

    /// 检查两个版本的内容是否相同（通过 content_hash）。
    pub async fn content_equals(&self, a: &VersionId, b: &VersionId) -> Result<bool, AppError> {
        let va = self.get(a).await?;
        let vb = self.get(b).await?;
        Ok(va.content_hash == vb.content_hash)
    }

    // ─── Phase 2: 自适应存储决策 ──────────────────────────────────────────

    /// 创建带指定表示的版本。
    ///
    /// 用于 choose_representation 决策后创建版本。
    pub async fn create_version_with_representation(
        &self,
        content: &[u8],
        meta: FileMeta,
        representation: VersionRepresentation,
    ) -> Result<FileVersion, AppError> {
        let id = VersionId::new();
        let content_hash = bytes_to_hex(&*blake3::hash(content).as_bytes());

        let version = FileVersion {
            id: id.clone(),
            content_hash,
            file_meta: meta,
            representations: vec![representation],
            created_at: now_millis(),
        };

        self.persist_version(&version).await?;
        self.cache.write().await.insert(id.0.clone(), version.clone());
        Ok(version)
    }

    /// 创建 Delta 版本：从 base 版本通过 binary delta 重建 target。
    ///
    /// 存储 base 的 VersionId + 压缩后的 delta patch。
    pub async fn create_delta_version(
        &self,
        base_id: &VersionId,
        base_content: &[u8],
        target_content: &[u8],
        target_meta: FileMeta,
    ) -> Result<FileVersion, AppError> {
        // 创建 binary delta
        let delta_data = super::delta::create_delta(base_content, target_content)?;
        // 存储 delta patch 到 ObjectStore
        let patch_id = self.object_store.store(&delta_data).await?;

        let representation = VersionRepresentation::Delta {
            base: base_id.clone(),
            patch: patch_id,
        };

        self.create_version_with_representation(target_content, target_meta, representation).await
    }

    /// 根据备份模式、文件特征和写入上下文选择版本表示策略。
    ///
    /// `base_id`：pre 版本的 ID，用于 Delta 表示的 base 引用。
    pub async fn choose_representation(
        &self,
        path: &std::path::Path,
        base_id: &VersionId,
        pre_content: &[u8],
        post_content: &[u8],
        ctx: &WriteContext,
        mode: BackupMode,
        thresholds: &ThresholdConfig,
    ) -> Result<VersionRepresentation, AppError> {
        match mode {
            BackupMode::Snapshot => {
                let manifest = self.object_store.store_chunked(post_content).await?;
                let manifest_id = self.object_store.store_manifest_json(&manifest).await?;
                Ok(VersionRepresentation::FullManifest { manifest: manifest_id })
            }
            BackupMode::Hunks => {
                self.adaptive_encode(base_id, pre_content, post_content, thresholds.delta_ratio_threshold).await
            }
            BackupMode::Auto => {
                self.auto_decide(path, base_id, pre_content, post_content, ctx, thresholds).await
            }
        }
    }

    /// 自适应 Delta 编码：根据压缩率决定使用 Delta 还是 FullManifest。
    pub async fn adaptive_encode(
        &self,
        base_id: &VersionId,
        pre_content: &[u8],
        post_content: &[u8],
        delta_ratio_threshold: f64,
    ) -> Result<VersionRepresentation, AppError> {
        if super::delta::is_binary(post_content) {
            let manifest = self.object_store.store_chunked(post_content).await?;
            let manifest_id = self.object_store.store_manifest_json(&manifest).await?;
            return Ok(VersionRepresentation::FullManifest { manifest: manifest_id });
        }

        let delta_data = super::delta::create_delta(pre_content, post_content)?;
        let delta_ratio = delta_data.len() as f64 / post_content.len().max(1) as f64;

        if delta_ratio < delta_ratio_threshold {
            let patch_id = self.object_store.store(&delta_data).await?;
            Ok(VersionRepresentation::Delta { base: base_id.clone(), patch: patch_id })
        } else {
            let manifest = self.object_store.store_chunked(post_content).await?;
            let manifest_id = self.object_store.store_manifest_json(&manifest).await?;
            Ok(VersionRepresentation::FullManifest { manifest: manifest_id })
        }
    }

    /// Auto 模式决策树。
    pub async fn auto_decide(
        &self,
        path: &std::path::Path,
        base_id: &VersionId,
        pre_content: &[u8],
        post_content: &[u8],
        ctx: &WriteContext,
        thresholds: &ThresholdConfig,
    ) -> Result<VersionRepresentation, AppError> {
        let post_len = post_content.len();

        if super::delta::is_binary(post_content) || post_len < thresholds.small_file_threshold {
            let manifest = self.object_store.store_chunked(post_content).await?;
            let manifest_id = self.object_store.store_manifest_json(&manifest).await?;
            return Ok(VersionRepresentation::FullManifest { manifest: manifest_id });
        }

        if post_len > thresholds.large_file_threshold {
            return Ok(VersionRepresentation::UnrecoverableHashOnly {
                hash: bytes_to_hex(&*blake3::hash(post_content).as_bytes()),
                reason: format!("file size {} exceeds threshold", post_len),
            });
        }

        if thresholds.external_edit_penalty && ctx.external_edit_count > 0 {
            let manifest = self.object_store.store_chunked(post_content).await?;
            let manifest_id = self.object_store.store_manifest_json(&manifest).await?;
            return Ok(VersionRepresentation::FullManifest { manifest: manifest_id });
        }

        self.adaptive_encode(base_id, pre_content, post_content, thresholds.delta_ratio_threshold).await
    }

    // ─── Phase 2: 锚点机制 ────────────────────────────────────────────────

    /// 获取某文件的 Delta 链长度。
    pub async fn hunk_chain_length(&self, path: &str) -> usize {
        let map = self.hunk_chain_lengths.read().await;
        *map.get(path).unwrap_or(&0)
    }

    /// 递增 Delta 链长度（创建 Delta 版本后调用）。
    pub async fn increment_hunk_chain(&self, path: &str) {
        let mut map = self.hunk_chain_lengths.write().await;
        let count = map.entry(path.to_string()).or_insert(0);
        *count += 1;
    }

    /// 重置 Delta 链长度（插入 FullManifest 锚点后调用）。
    pub async fn reset_hunk_chain(&self, path: &str) {
        let mut map = self.hunk_chain_lengths.write().await;
        map.insert(path.to_string(), 0);
    }

    /// 检查是否需要插入锚点（Delta 链超限）。
    pub async fn needs_anchor(&self, path: &str, max_chain_length: usize) -> bool {
        self.hunk_chain_length(path).await >= max_chain_length
    }

    /// 创建带锚点检查的版本。
    ///
    /// 如果 Delta 链超限，强制创建 FullManifest 锚点并重置链长度。
    /// 否则使用 choose_representation 决策的表示。
    pub async fn create_version_with_anchor_check(
        &self,
        path: &str,
        base_id: &VersionId,
        pre_content: &[u8],
        post_content: &[u8],
        meta: FileMeta,
        ctx: &WriteContext,
        mode: BackupMode,
        thresholds: &ThresholdConfig,
        max_chain_length: usize,
    ) -> Result<FileVersion, AppError> {
        // 检查是否需要锚点
        if self.needs_anchor(path, max_chain_length).await {
            // 强制 FullManifest 锚点
            let manifest = self.object_store.store_chunked(post_content).await?;
            let manifest_id = self.object_store.store_manifest_json(&manifest).await?;
            let version = self.create_version_with_representation(
                post_content, meta,
                VersionRepresentation::FullManifest { manifest: manifest_id },
            ).await?;
            self.reset_hunk_chain(path).await;
            Ok(version)
        } else {
            // 使用决策树选择表示
            let representation = self.choose_representation(
                std::path::Path::new(path), base_id, pre_content, post_content, ctx, mode, thresholds,
            ).await?;

            // 如果是 Delta 表示，递增链长度
            let is_delta = matches!(representation, VersionRepresentation::Delta { .. });
            let version = self.create_version_with_representation(
                post_content, meta, representation,
            ).await?;

            if is_delta {
                self.increment_hunk_chain(path).await;
            } else {
                // FullManifest → 重置链长度（它本身就是一个锚点）
                self.reset_hunk_chain(path).await;
            }

            Ok(version)
        }
    }

    /// 物化版本（带锚点优化）：跳至最近锚点正向重放。
    ///
    /// 优化路径：如果 Delta 链过长，从最近的 FullManifest 锚点开始正向重放，
    /// 避免从链头逆序 apply 大量 delta。
    pub fn materialize_with_chain<'a>(
        &'a self,
        id: &'a VersionId,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<u8>, AppError>> + Send + 'a>> {
        Box::pin(async move {
            // Phase 2 简化实现：直接使用 materialize（递归处理 Delta 链）
            // 优化版本会在 Delta 链中缓存锚点版本的物化结果
            self.materialize(id).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_create_and_materialize() {
        let tmp = TempDir::new().unwrap();
        let objects_dir = tmp.path().join("objects");
        let versions_dir = tmp.path().join("versions");
        tokio::fs::create_dir_all(&objects_dir).await.unwrap();
        tokio::fs::create_dir_all(&versions_dir).await.unwrap();

        let obj_store = Arc::new(ObjectStore::new(objects_dir));
        let ver_store = VersionStore::new(versions_dir, obj_store);

        let content = b"test file content";
        let meta = FileMeta {
            size: content.len() as u64,
            mtime: 1234567890,
            mode: 0o644,
        };

        let version = ver_store.create_version(content, meta).await.unwrap();
        let retrieved = ver_store.materialize(&version.id).await.unwrap();
        assert_eq!(retrieved, content);
    }

    #[tokio::test]
    async fn test_tombstone() {
        let tmp = TempDir::new().unwrap();
        let obj_store = Arc::new(ObjectStore::new(tmp.path().join("objects")));
        let ver_store = VersionStore::new(tmp.path().join("versions"), obj_store);

        let tombstone = ver_store.create_tombstone().await.unwrap();
        assert!(tombstone.id.is_tombstone());

        let result = ver_store.materialize(&tombstone.id).await;
        assert!(result.is_err());
    }
}
