//! 回退引擎。
//!
//! 实现五级回退粒度：
//! 1. 单 Hunk → diff3 对特定区域
//! 2. 单次修改 → revert_record_fast / revert_record_with_merge
//! 3. 文件全部修改 → 逆序回退该文件所有记录
//! 4. Turn 级 → 逆序遍历该 turn 所有记录
//! 5. 消息时间点 → 逆序回退该 message_id 之后所有记录
//!
//! 回退路径选择决策树：
//! 1. 若 current_hash == rec.post_hash → 快路径：直接覆盖 pre 内容
//! 2. 若 current_hash ≠ rec.post_hash → diff3 合并
//!    a. 有相同文件的后续记录 → diff3(base=rec.post, ours=current, theirs=pre)
//!    b. 无后续但有外部编辑 → diff3(base=pre, ours=current, theirs=pre)

use std::path::PathBuf;
use std::sync::Arc;

use tokio::fs;
use tokio::sync::Mutex;

use crate::error::AppError;

use super::merge::{diff3_merge, ConflictInfo};
use super::version_store::{FileMeta, FileVersion, VersionId, VersionStore};
use super::{
    ChangeJournal, ChangeKind, ChangeRecord, ChangeSource, FileHistory, MessageId, RecordId,
    RestoreTurnResult, TurnId, bytes_to_hex, now_millis,
};

/// 文件级锁：防止并发工具执行竞态。
///
/// 同一 turn 内可能并行执行多个 tool call 操作同一文件。
/// 文件级 Mutex 串行化确保备份/写入/记录的原子性。
static FILE_LOCKS: once_cell::sync::Lazy<
    tokio::sync::Mutex<std::collections::HashMap<PathBuf, Arc<Mutex<()>>>>
> = once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(std::collections::HashMap::new()));

/// 获取文件级锁的 guard。
///
/// 接受一个闭包 `f`，在文件锁保护下执行。闭包返回一个 Future。
pub async fn with_file_lock<F, Fut, R>(path: &std::path::Path, f: F) -> Result<R, AppError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<R, AppError>>,
{
    let lock = {
        let mut map = FILE_LOCKS.lock().await;
        map.entry(path.to_path_buf())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    f().await
}

/// 简单回退（快路径）：当前磁盘文件 == rec.post_hash 时直接覆盖。
///
/// - Create → 删除文件
/// - Delete → 恢复文件（写入 pre 内容 + 恢复权限）
/// - Modify → 覆盖为 pre 内容
/// - Rename → 反向 rename
pub async fn revert_record_fast(
    rec: &ChangeRecord,
    history: &FileHistory,
) -> Result<(), AppError> {
    let pre_content = history.version_store.materialize(&rec.pre).await?;
    let pre_version = history.version_store.get(&rec.pre).await?;

    match rec.kind {
        ChangeKind::Create => {
            // 新建的文件 → 回退即删除
            if let Some(ref path) = rec.path_after {
                if path.exists() {
                    fs::remove_file(path).await
                        .map_err(|e| AppError::Internal(format!("删除文件失败：{e}")))?;
                }
            }
        }
        ChangeKind::Delete => {
            // 被删的文件 → 回退即恢复
            if let Some(ref path) = rec.path_before {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).await
                        .map_err(|e| AppError::Internal(format!("创建目录失败：{e}")))?;
                }
                fs::write(path, &pre_content).await
                    .map_err(|e| AppError::Internal(format!("恢复文件失败：{e}")))?;
                restore_file_mode(path, pre_version.file_meta.mode)?;
            }
        }
        ChangeKind::Modify => {
            let path = rec.path_after.as_ref()
                .or(rec.path_before.as_ref())
                .ok_or_else(|| AppError::Internal("Modify 记录缺少路径".into()))?;
            fs::write(path, &pre_content).await
                .map_err(|e| AppError::Internal(format!("写回文件失败：{e}")))?;
            restore_file_mode(path, pre_version.file_meta.mode)?;
        }
        ChangeKind::Rename => {
            if let (Some(ref from), Some(ref to)) = (&rec.path_before, &rec.path_after) {
                if to.exists() {
                    fs::rename(to, from).await
                        .map_err(|e| AppError::Internal(format!("反向 rename 失败：{e}")))?;
                }
            }
        }
    }

    Ok(())
}

/// 复杂回退：当前磁盘已被后续修改时，使用 diff3 三方合并。
///
/// - 有后续记录 → diff3(base=rec.post, ours=current, theirs=pre)
/// - 无后续但有外部编辑 → diff3(base=pre, ours=current, theirs=pre)
pub async fn revert_record_with_merge(
    rec: &ChangeRecord,
    subsequent_records: &[ChangeRecord],
    history: &FileHistory,
) -> Result<super::merge::MergeResult, AppError> {
    let path = rec.path_after.as_ref()
        .or(rec.path_before.as_ref())
        .ok_or_else(|| AppError::Internal("记录缺少路径".into()))?;

    let current = fs::read(path).await
        .map_err(|e| AppError::Internal(format!("读取当前文件失败：{e}")))?;

    let pre_content = history.version_store.materialize(&rec.pre).await?;

    let (base_content, result) = if !subsequent_records.is_empty() {
        // 有后续记录 → 以 rec.post 为 base 做 diff3
        let post_content = history.version_store.materialize(&rec.post).await?;
        let mut result = diff3_merge(&post_content, &current, &pre_content)?;
        // 填充冲突信息中的文件路径和记录 ID
        for c in &mut result.conflicts {
            c.file_path = path.to_string_lossy().into_owned();
            c.record_id = rec.id.0.clone();
        }
        (post_content, result)
    } else {
        // 没有后续记录，但 hash 不匹配 → 有外部编辑
        let mut result = diff3_merge(&pre_content, &current, &pre_content)?;
        for c in &mut result.conflicts {
            c.file_path = path.to_string_lossy().into_owned();
            c.record_id = rec.id.0.clone();
        }
        (pre_content, result)
    };

    // 写入合并后的内容（即使有冲突也写入，冲突标记已在内容中）
    if rec.kind != ChangeKind::Create || !result.content.is_empty() {
        fs::write(path, &result.content).await
            .map_err(|e| AppError::Internal(format!("写入合并结果失败：{e}")))?;
    } else if rec.kind == ChangeKind::Create && result.content.is_empty() {
        // Create 回退后文件为空 → 删除
        if path.exists() {
            let _ = fs::remove_file(path).await;
        }
    }

    // 恢复文件权限
    let pre_version = history.version_store.get(&rec.pre).await?;
    restore_file_mode(path, pre_version.file_meta.mode)?;

    // 避免 unused warning
    let _ = base_content;

    Ok(result)
}

/// 恢复文件权限/属性。
fn restore_file_mode(path: &std::path::Path, mode: u32) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.exists() {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
                .map_err(|e| AppError::Internal(format!("恢复文件权限失败：{e}")))?;
        }
    }
    #[cfg(not(unix))]
    {
        // Windows：mode 不可直接映射，跳过
        let _ = (path, mode);
    }
    Ok(())
}

/// 回退单条记录（自动选择快路径或合并路径）。
pub async fn revert_record(
    rec: &ChangeRecord,
    history: &FileHistory,
) -> Result<Vec<ConflictInfo>, AppError> {
    let path = rec.path_after.as_ref()
        .or(rec.path_before.as_ref());

    // 获取当前文件 hash
    let current_hash = match path {
        Some(p) if p.exists() => {
            let content = fs::read(p).await
                .map_err(|e| AppError::Internal(format!("读取文件失败：{e}")))?;
            bytes_to_hex(&*blake3::hash(&content).as_bytes())
        }
        _ => String::new(), // 文件不存在
    };

    // 获取 post 版本的 hash
    let post_version = history.version_store.get(&rec.post).await?;
    let post_hash = &post_version.content_hash;

    if current_hash == *post_hash {
        // 快路径
        revert_record_fast(rec, history).await?;
        Ok(Vec::new())
    } else {
        // 合并路径
        let subsequent = if let Some(p) = path {
            history.journal.get_subsequent_records_for_file(&rec.turn_id, &rec.id).await?
        } else {
            Vec::new()
        };
        let result = revert_record_with_merge(rec, &subsequent, history).await?;
        Ok(result.conflicts)
    }
}

/// Turn 级回退：逆序遍历该 turn 的所有记录，逐条回退。
pub async fn revert_turn(
    turn_id: &TurnId,
    history: &FileHistory,
) -> Result<RestoreTurnResult, AppError> {
    let records = history.journal.get_records_by_turn(turn_id).await?;
    let mut restored = Vec::new();
    let mut all_conflicts = Vec::new();
    let mut errors = Vec::new();

    // 逆序遍历
    for rec in records.iter().rev() {
        let path = rec.path_after.as_ref()
            .or(rec.path_before.as_ref())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        match revert_record(rec, history).await {
            Ok(conflicts) => {
                if !path.is_empty() {
                    restored.push(path);
                }
                all_conflicts.extend(conflicts);
            }
            Err(e) => {
                errors.push(format!("回退记录 {} 失败：{}", rec.id.0, e.detailed_message()));
            }
        }
    }

    Ok(RestoreTurnResult {
        restored_files: restored,
        conflicts: all_conflicts,
        errors,
    })
}

/// 选择性回退：回退指定的记录列表。
pub async fn revert_records(
    record_ids: &[RecordId],
    history: &FileHistory,
) -> Result<RestoreTurnResult, AppError> {
    let mut restored = Vec::new();
    let mut all_conflicts = Vec::new();
    let mut errors = Vec::new();

    for rid in record_ids {
        // 在所有 turn 中查找该记录
        // Phase 1 简化：遍历所有 session 查找
        let record = find_record_by_id(rid, history).await?;

        match record {
            Some(rec) => {
                let path = rec.path_after.as_ref()
                    .or(rec.path_before.as_ref())
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();

                match revert_record(&rec, history).await {
                    Ok(conflicts) => {
                        if !path.is_empty() {
                            restored.push(path);
                        }
                        all_conflicts.extend(conflicts);
                    }
                    Err(e) => {
                        errors.push(format!("回退记录 {} 失败：{}", rec.id.0, e.detailed_message()));
                    }
                }
            }
            None => {
                errors.push(format!("记录 {} 未找到", rid.0));
            }
        }
    }

    Ok(RestoreTurnResult {
        restored_files: restored,
        conflicts: all_conflicts,
        errors,
    })
}

/// 消息时间点级回退：回退该 message_id 之后的所有记录。
pub async fn revert_after_message(
    message_id: &MessageId,
    history: &FileHistory,
) -> Result<RestoreTurnResult, AppError> {
    let records = history.journal.get_records_after_message(message_id).await?;
    let mut restored = Vec::new();
    let mut all_conflicts = Vec::new();
    let mut errors = Vec::new();

    // 逆序遍历
    for rec in records.iter().rev() {
        let path = rec.path_after.as_ref()
            .or(rec.path_before.as_ref())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        match revert_record(rec, history).await {
            Ok(conflicts) => {
                if !path.is_empty() {
                    restored.push(path);
                }
                all_conflicts.extend(conflicts);
            }
            Err(e) => {
                errors.push(format!("回退记录 {} 失败：{}", rec.id.0, e.detailed_message()));
            }
        }
    }

    Ok(RestoreTurnResult {
        restored_files: restored,
        conflicts: all_conflicts,
        errors,
    })
}

/// 文件级回退：逆序回退该文件的所有记录。
pub async fn revert_file_all(
    path: &str,
    history: &FileHistory,
) -> Result<RestoreTurnResult, AppError> {
    let records = history.journal.get_records_for_path(path).await?;
    let mut restored = Vec::new();
    let mut all_conflicts = Vec::new();
    let mut errors = Vec::new();

    // 逆序遍历
    for rec in records.iter().rev() {
        match revert_record(rec, history).await {
            Ok(conflicts) => {
                restored.push(path.to_string());
                all_conflicts.extend(conflicts);
            }
            Err(e) => {
                errors.push(format!("回退记录 {} 失败：{}", rec.id.0, e.detailed_message()));
            }
        }
    }

    Ok(RestoreTurnResult {
        restored_files: restored,
        conflicts: all_conflicts,
        errors,
    })
}

/// 在所有记录中查找指定 ID 的记录。
async fn find_record_by_id(
    rid: &RecordId,
    history: &FileHistory,
) -> Result<Option<ChangeRecord>, AppError> {
    // Phase 1 简化实现：遍历 path_index
    // 更高效的实现需要额外的 record_id → record 索引
    let path_index = history.journal.get_records_for_path("").await?; // 这个返回空
    let _ = path_index;

    // 遍历所有 session
    let sessions = history.journal.list_sessions_sorted_by_access().await?;
    for session_id in &sessions {
        let turn_id = TurnId(session_id.clone());
        let records = history.journal.get_records_by_turn(&turn_id).await?;
        for rec in &records {
            if rec.id == *rid {
                return Ok(Some(rec.clone()));
            }
        }
    }

    Ok(None)
}

// ─── 外部编辑检测 ─────────────────────────────────────────────────────────

/// 检测本地存储工作区的外部编辑。
///
/// 每次工具执行前调用：对所有已追踪文件做 hash 比对，
/// 检测文件是否被外部修改或删除。
pub async fn detect_external_edits_local(
    tracked: &[super::TrackedFile],
    history: &FileHistory,
) -> Result<Vec<ChangeRecord>, AppError> {
    let mut edits = Vec::new();

    for file in tracked {
        let content = match fs::read(&file.path).await {
            Ok(data) => data,
            Err(_) => {
                // 文件被外部删除
                let post_version = history.version_store.create_tombstone().await?;
                edits.push(ChangeRecord {
                    id: RecordId::new(),
                    turn_id: TurnId::external(),
                    message_id: MessageId::external(),
                    path_before: Some(file.path.clone()),
                    path_after: None,
                    kind: ChangeKind::Delete,
                    source: ChangeSource::ExternalEdit,
                    timestamp: now_millis(),
                    pre: file.last_known_version.clone(),
                    post: post_version.id,
                });
                continue;
            }
        };

        let hash = bytes_to_hex(&*blake3::hash(&content).as_bytes());

        // hash 比对——比 mtime 预检更可靠且避免 TOCTOU
        let last_hash = bytes_to_hex(&file.last_known_hash);
        if hash == last_hash {
            continue; // 未变
        }

        // 确认外部编辑
        let post_meta = FileMeta::from_path(&file.path)
            .unwrap_or_else(|_| FileMeta::tombstone());
        let post_version = history.version_store.create_version(&content, post_meta).await?;

        edits.push(ChangeRecord {
            id: RecordId::new(),
            turn_id: TurnId::external(),
            message_id: MessageId::external(),
            path_before: Some(file.path.clone()),
            path_after: Some(file.path.clone()),
            kind: ChangeKind::Modify,
            source: ChangeSource::ExternalEdit,
            timestamp: now_millis(),
            pre: file.last_known_version.clone(),
            post: post_version.id,
        });
    }

    // append 到 Journal
    for edit in &edits {
        history.journal.append(edit.clone()).await?;
    }

    Ok(edits)
}

/// 尝试快速 hunk 回退（性能缓存路径）。
///
/// 如果 hunk 上下文在 current 中精确匹配 → 快速 reverse apply。
/// 不匹配时返回 None，调用方应 fallback 到完整 diff3。
pub fn try_fast_hunk_revert(
    current: &[u8],
    old_text: &str,
    new_text: &str,
) -> Option<Vec<u8>> {
    let current_str = String::from_utf8_lossy(current);

    // 尝试在 current 中精确找到 new_text 的位置
    let pos = current_str.find(new_text)?;
    let result = format!("{}{}{}", &current_str[..pos], old_text, &current_str[pos + new_text.len()..]);
    Some(result.into_bytes())
}
