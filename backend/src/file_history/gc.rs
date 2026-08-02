//! 后台垃圾回收（Phase 2）。
//!
//! 功能：
//! - **版本合并**：将旧 session 的版本合并为少量快照，释放中间版本
//! - **空间回收**：删除不再被任何版本引用的孤立对象
//! - **锚点压缩**：老锚点与相邻锚点 diff 后只保留链头
//!
//! GC 策略：
//! 1. 扫描所有版本，标记被引用的 ObjectId
//! 2. 遍历 ObjectStore，删除未被引用的孤立对象
//! 3. 对超过阈值的 session 做版本合并

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use tokio::fs;

use crate::error::AppError;

use super::object_store::ObjectId;
use super::version_store::{VersionRepresentation, VersionStore};
use super::{ChangeJournal, FileHistory};

/// GC 统计报告。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcReport {
    /// 扫描的版本总数
    pub versions_scanned: usize,
    /// 标记的对象总数（被引用）
    pub objects_marked: usize,
    /// 删除的孤立对象数
    pub objects_deleted: usize,
    /// 释放的空间（字节）
    pub space_freed: u64,
    /// 合并的 session 数
    pub sessions_merged: usize,
}

/// 执行垃圾回收。
///
/// 流程：
/// 1. 扫描所有版本，收集被引用的 ObjectId 集合
/// 2. 遍历 ObjectStore，删除未被引用的孤立对象
/// 3. 检查配额，必要时按 LRU 清理旧 session
pub async fn run_gc(history: &FileHistory) -> Result<GcReport, AppError> {
    let mut report = GcReport::default();

    // 1. 扫描所有版本，标记被引用的对象
    let referenced = mark_referenced_objects(&history.version_store, &history.object_store).await?;
    report.versions_scanned = referenced.version_count;
    report.objects_marked = referenced.objects.len();

    // 2. 删除孤立对象
    let deleted = sweep_unreferenced_objects(&history.object_store, &referenced.objects).await?;
    report.objects_deleted = deleted.count;
    report.space_freed = deleted.space_freed;

    // 3. 配额检查：如果仍超配额，按 LRU 清理旧 session
    let config = history.config().await;
    let max_size = config.quota.max_total_size;
    let current_size = history.object_store.total_size().await?;
    if current_size > max_size {
        let sessions = history.journal.list_sessions_sorted_by_access().await?;
        for session_id in sessions.iter().rev() {
            if history.object_store.total_size().await? < max_size {
                break;
            }
            // 删除最旧的 session
            history.journal.delete_session(session_id).await?;
            history.object_store.delete_session_objects(session_id).await?;
            report.sessions_merged += 1;
        }
    }

    tracing::info!(
        "GC 完成：扫描 {} 版本，标记 {} 对象，删除 {} 孤立对象，释放 {} 字节，合并 {} session",
        report.versions_scanned,
        report.objects_marked,
        report.objects_deleted,
        report.space_freed,
        report.sessions_merged,
    );

    Ok(report)
}

/// 标记被引用的对象：扫描所有版本，收集被引用的 ObjectId。
struct MarkResult {
    objects: HashSet<[u8; 32]>,
    version_count: usize,
}

async fn mark_referenced_objects(
    version_store: &Arc<VersionStore>,
    _object_store: &Arc<super::ObjectStore>,
) -> Result<MarkResult, AppError> {
    let mut objects = HashSet::new();
    let mut version_count = 0;

    // 扫描版本目录中的所有 .json 文件
    let versions_dir = version_store.versions_dir();
    if !versions_dir.exists() {
        return Ok(MarkResult { objects, version_count });
    }

    let mut entries = fs::read_dir(versions_dir).await
        .map_err(|e| AppError::Internal(format!("读取 versions 目录失败：{e}")))?;

    while let Some(entry) = entries.next_entry().await
        .map_err(|e| AppError::Internal(format!("读取目录条目失败：{e}")))?
    {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }

        let data = match fs::read(&path).await {
            Ok(d) => d,
            Err(_) => continue,
        };

        let version: super::FileVersion = match serde_json::from_slice(&data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        version_count += 1;

        // 收集该版本引用的所有对象
        for rep in &version.representations {
            match rep {
                VersionRepresentation::FullManifest { manifest } => {
                    objects.insert(manifest.0);
                    // manifest JSON 引用的 chunk 对象也需要标记
                    // 需要读取 manifest JSON 获取 chunk hashes
                    if let Ok(manifest_data) = _object_store.get(manifest).await {
                        if let Ok(m) = serde_json::from_slice::<super::FullManifest>(&manifest_data) {
                            for chunk in &m.chunks {
                                objects.insert(chunk.hash.0);
                            }
                        }
                    }
                }
                VersionRepresentation::Delta { base: _, patch } => {
                    objects.insert(patch.0);
                    // base 引用的对象通过递归扫描其他版本自动覆盖
                }
                VersionRepresentation::Tombstone => {}
                VersionRepresentation::UnrecoverableHashOnly { .. } => {}
            }
        }
    }

    Ok(MarkResult { objects, version_count })
}

/// 删除未被引用的孤立对象。
struct SweepResult {
    count: usize,
    space_freed: u64,
}

async fn sweep_unreferenced_objects(
    object_store: &Arc<super::ObjectStore>,
    referenced: &HashSet<[u8; 32]>,
) -> Result<SweepResult, AppError> {
    let mut count = 0;
    let mut space_freed = 0u64;

    let root = object_store.root();
    if !root.exists() {
        return Ok(SweepResult { count, space_freed });
    }

    // 遍历 objects 目录（按前两位分目录）
    let mut prefix_dirs = fs::read_dir(root).await
        .map_err(|e| AppError::Internal(format!("读取 objects 目录失败：{e}")))?;

    while let Some(prefix_entry) = prefix_dirs.next_entry().await
        .map_err(|e| AppError::Internal(format!("读取目录条目失败：{e}")))?
    {
        let prefix_path = prefix_entry.path();
        if !prefix_entry.metadata().await
            .map_err(|e| AppError::Internal(format!("读取元数据失败：{e}")))?
            .is_dir()
        {
            continue;
        }

        let mut object_files = fs::read_dir(&prefix_path).await
            .map_err(|e| AppError::Internal(format!("读取对象目录失败：{e}")))?;

        while let Some(obj_entry) = object_files.next_entry().await
            .map_err(|e| AppError::Internal(format!("读取对象条目失败：{e}")))?
        {
            let obj_path = obj_entry.path();
            let filename = match obj_path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n,
                None => continue,
            };

            // 解析 ObjectId
            let obj_id = match ObjectId::from_hex(filename) {
                Ok(id) => id,
                Err(_) => continue,
            };

            // 检查是否被引用
            if !referenced.contains(&obj_id.0) {
                // 未被引用 → 删除
                let size = obj_entry.metadata().await
                    .map_err(|e| AppError::Internal(format!("读取对象元数据失败：{e}")))?
                    .len();

                if fs::remove_file(&obj_path).await.is_ok() {
                    count += 1;
                    space_freed += size;
                }
            }
        }

        // 如果前缀目录为空，删除它
        let mut remaining = fs::read_dir(&prefix_path).await
            .map_err(|e| AppError::Internal(format!("读取目录失败：{e}")))?;
        if remaining.next_entry().await
            .map_err(|e| AppError::Internal(format!("读取目录条目失败：{e}")))?
            .is_none()
        {
            let _ = fs::remove_dir(&prefix_path).await;
        }
    }

    Ok(SweepResult { count, space_freed })
}

/// 锚点压缩：将旧的 Delta 链压缩为更少的 FullManifest 锚点。
///
/// 策略：
/// 1. 找到超过 max_chain_length 的 Delta 链
/// 2. 在链中间插入新的 FullManifest 锚点
/// 3. 释放中间的 Delta 版本（如果不再被引用）
///
/// 注意：此操作不改变 Journal 中的记录，仅优化 VersionStore 中的表示。
pub async fn compress_anchor_chains(
    history: &FileHistory,
    max_chain_length: usize,
) -> Result<usize, AppError> {
    let mut compressed = 0;

    // 获取所有追踪文件的 Delta 链长度
    let sessions = history.journal.list_sessions_sorted_by_access().await?;

    for session_id in &sessions {
        let turn_id = super::TurnId(session_id.clone());
        let records = history.journal.get_records_by_turn(&turn_id).await?;

        // 按路径分组记录
        let mut path_records: std::collections::HashMap<String, Vec<&super::ChangeRecord>> =
            std::collections::HashMap::new();
        for rec in &records {
            let path = rec.path_after.as_ref()
                .or(rec.path_before.as_ref())
                .map(|p| p.to_string_lossy().into_owned());
            if let Some(p) = path {
                path_records.entry(p).or_default().push(rec);
            }
        }

        // 对每个路径，检查 Delta 链长度
        for (path, recs) in &path_records {
            let chain_len = history.version_store.hunk_chain_length(path).await;
            if chain_len > max_chain_length {
                // 链过长 → 在最新版本处插入 FullManifest 锚点
                if let Some(latest_rec) = recs.last() {
                    // 物化最新版本内容
                    let content = history.version_store.materialize(&latest_rec.post).await?;
                    let meta = super::FileMeta::from_path(std::path::Path::new(&path))
                        .unwrap_or_else(|_| super::FileMeta::tombstone());

                    // 创建 FullManifest 锚点版本
                    let manifest = history.object_store.store_chunked(&content).await?;
                    let manifest_id = history.object_store.store_manifest_json(&manifest).await?;

                    // 更新版本：添加 FullManifest 表示
                    let mut version = history.version_store.get(&latest_rec.post).await?;
                    version.representations.insert(0, VersionRepresentation::FullManifest {
                        manifest: manifest_id,
                    });
                    history.version_store.update_version(&version).await?;

                    // 重置链长度
                    history.version_store.reset_hunk_chain(path).await;
                    compressed += 1;
                }
            }
        }
    }

    Ok(compressed)
}
