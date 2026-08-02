//! 变更日志（因果层）。
//!
//! append-only JSONL 事件流，记录每次文件状态转换。
//! 支持 WAL（预写日志）保证崩溃恢复一致性。
//!
//! 存储结构：
//! ```text
//! journal/
//!   session-{id}.jsonl     # append-only 事件流
//!   wal/
//!     intent-{uuid}.json   # 预写日志
//! ```

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::error::AppError;

use super::version_store::{FileVersion, VersionId, VersionStore};
use super::{
    ChangeKind, ChangeRecord, ChangeSource, MessageId, RecordId, TurnId, bytes_to_hex,
    now_millis,
};

/// WAL 预写日志条目。
///
/// 在文件操作执行前写入，操作完成后删除。
/// 崩溃恢复时扫描 WAL 目录，根据文件当前状态决定补写记录或回滚。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalIntent {
    pub record_id: RecordId,
    pub turn_id: TurnId,
    pub message_id: MessageId,
    pub path: PathBuf,
    pub kind: ChangeKind,
    pub source: ChangeSource,
    pub pre_hash: String,
    pub post_hash: String,
    pub pre_version_id: VersionId,
    pub post_version_id: Option<VersionId>,
    pub timestamp: u64,
    pub conflicted: bool,
}

impl WalIntent {
    /// WAL 文件路径。
    fn wal_path(wal_dir: &Path, record_id: &RecordId) -> PathBuf {
        wal_dir.join(format!("intent-{}.json", record_id.0))
    }
}

/// SAF sync-in 报告。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncInReport {
    /// 检测到的外部编辑路径列表
    pub external_edits: Vec<String>,
    /// 检测到的外部删除路径列表
    pub external_deletes: Vec<String>,
}

/// SAF sync-out 报告。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutReport {
    /// 成功同步的文件路径
    pub synced: Vec<String>,
    /// 同步失败的文件
    pub failures: Vec<SyncOutFailure>,
}

/// sync-out 单个失败项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutFailure {
    pub path: String,
    pub reason: String,
    pub recoverable: bool,
}

/// 变更日志。
pub struct ChangeJournal {
    /// journal 目录（含 session 文件和 wal 子目录）
    journal_dir: PathBuf,
    /// WAL 目录
    wal_dir: PathBuf,
    /// 文件写入互斥锁（保证 append 操作的原子性）
    write_lock: Mutex<()>,
    /// 内存索引：turn_id → 该 turn 下的记录列表
    turn_index: Mutex<HashMap<String, Vec<ChangeRecord>>>,
    /// 内存索引：path → 该文件的所有记录列表（按时间排序）
    path_index: Mutex<HashMap<String, Vec<ChangeRecord>>>,
    /// 已加载的 session 文件列表
    loaded_sessions: Mutex<bool>,
}

impl ChangeJournal {
    pub fn new(journal_dir: PathBuf, wal_dir: PathBuf) -> Self {
        Self {
            journal_dir,
            wal_dir,
            write_lock: Mutex::new(()),
            turn_index: Mutex::new(HashMap::new()),
            path_index: Mutex::new(HashMap::new()),
            loaded_sessions: Mutex::new(false),
        }
    }

    /// session 文件路径。
    fn session_path(&self, turn_id: &TurnId) -> PathBuf {
        // 外部编辑使用固定 session 文件
        let session_id = if turn_id.is_external() {
            "external".to_string()
        } else {
            turn_id.0.clone()
        };
        self.journal_dir.join(format!("session-{}.jsonl", session_id))
    }

    /// 确保 session 索引已从磁盘加载。
    async fn ensure_loaded(&self) -> Result<(), AppError> {
        let mut loaded = self.loaded_sessions.lock().await;
        if *loaded {
            return Ok(());
        }

        // 读取所有 session 文件，重建内存索引
        let mut entries = fs::read_dir(&self.journal_dir).await
            .map_err(|e| AppError::Internal(format!("读取 journal 目录失败：{e}")))?;

        while let Some(entry) = entries.next_entry().await
            .map_err(|e| AppError::Internal(format!("读取目录条目失败：{e}")))?
        {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                self.load_session_file(&path).await?;
            }
        }

        *loaded = true;
        Ok(())
    }

    /// 加载单个 session 文件到内存索引。
    async fn load_session_file(&self, path: &Path) -> Result<(), AppError> {
        let content = fs::read_to_string(path).await
            .map_err(|e| AppError::Internal(format!("读取 session 文件失败：{e}")))?;

        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<ChangeRecord>(line) {
                Ok(record) => {
                    self.add_to_index(record).await;
                }
                Err(e) => {
                    tracing::warn!("跳过无法解析的 journal 行：{e}");
                }
            }
        }
        Ok(())
    }

    /// 将记录添加到内存索引。
    async fn add_to_index(&self, record: ChangeRecord) {
        let turn_key = record.turn_id.0.clone();
        self.turn_index.lock().await
            .entry(turn_key)
            .or_default()
            .push(record.clone());

        let path_key = record.path_after
            .as_ref()
            .or(record.path_before.as_ref())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();

        if !path_key.is_empty() {
            self.path_index.lock().await
                .entry(path_key)
                .or_default()
                .push(record);
        }
    }

    /// 写入 WAL intent（文件操作执行前调用）。
    pub async fn write_wal_intent(&self, intent: &WalIntent) -> Result<(), AppError> {
        let path = WalIntent::wal_path(&self.wal_dir, &intent.record_id);
        let json = serde_json::to_vec_pretty(intent)
            .map_err(|e| AppError::Internal(format!("序列化 WAL intent 失败：{e}")))?;

        // 原子写入
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, &json).await
            .map_err(|e| AppError::Internal(format!("写入 WAL 临时文件失败：{e}")))?;
        fs::rename(&tmp, &path).await
            .map_err(|e| AppError::Internal(format!("重命名 WAL 文件失败：{e}")))?;

        // fsync 确保持久化
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .await
            .map_err(|e| AppError::Internal(format!("打开 WAL 文件失败：{e}")))?;
        file.sync_all().await
            .map_err(|e| AppError::Internal(format!("fsync WAL 失败：{e}")))?;
        drop(file);

        Ok(())
    }

    /// 删除 WAL intent（操作成功完成后调用）。
    pub async fn delete_wal_intent(&self, record_id: &RecordId) -> Result<(), AppError> {
        let path = WalIntent::wal_path(&self.wal_dir, record_id);
        if path.exists() {
            fs::remove_file(&path).await
                .map_err(|e| AppError::Internal(format!("删除 WAL intent 失败：{e}")))?;
        }
        Ok(())
    }

    /// 追加 ChangeRecord 到 Journal（操作成功后调用）。
    pub async fn append(&self, record: ChangeRecord) -> Result<(), AppError> {
        let _guard = self.write_lock.lock().await;

        let session_path = self.session_path(&record.turn_id);
        let json = serde_json::to_string(&record)
            .map_err(|e| AppError::Internal(format!("序列化 ChangeRecord 失败：{e}")))?;

        // append 到 session 文件
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&session_path)
            .await
            .map_err(|e| AppError::Internal(format!("打开 session 文件失败：{e}")))?;

        file.write_all(json.as_bytes()).await
            .map_err(|e| AppError::Internal(format!("写入 session 文件失败：{e}")))?;
        file.write_all(b"\n").await
            .map_err(|e| AppError::Internal(format!("写入换行符失败：{e}")))?;
        file.sync_all().await
            .map_err(|e| AppError::Internal(format!("fsync session 文件失败：{e}")))?;
        drop(file);

        // 更新内存索引
        self.add_to_index(record).await;

        Ok(())
    }

    /// 检查某条记录是否已存在于 Journal（WAL 恢复时用）。
    pub async fn has_record(&self, record_id: &RecordId) -> Result<bool, AppError> {
        self.ensure_loaded().await?;
        let turn_index = self.turn_index.lock().await;
        for records in turn_index.values() {
            if records.iter().any(|r| r.id == *record_id) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// 获取某 turn 的所有记录。
    pub async fn get_records_by_turn(&self, turn_id: &TurnId) -> Result<Vec<ChangeRecord>, AppError> {
        self.ensure_loaded().await?;
        let turn_index = self.turn_index.lock().await;
        Ok(turn_index.get(&turn_id.0).cloned().unwrap_or_default())
    }

    /// 获取某文件的所有记录（按时间排序）。
    pub async fn get_records_for_path(&self, path: &str) -> Result<Vec<ChangeRecord>, AppError> {
        self.ensure_loaded().await?;
        let path_index = self.path_index.lock().await;
        Ok(path_index.get(path).cloned().unwrap_or_default())
    }

    /// 获取某 turn 之后、同一文件的所有后续记录。
    ///
    /// 用于回退时判断是否有后续修改需要 diff3 合并。
    pub async fn get_subsequent_records_for_file(
        &self,
        turn_id: &TurnId,
        record_id: &RecordId,
    ) -> Result<Vec<ChangeRecord>, AppError> {
        self.ensure_loaded().await?;

        // 找到目标记录的路径
        let turn_records = self.get_records_by_turn(turn_id).await?;
        let target = turn_records.iter().find(|r| r.id == *record_id);
        let target_path = match target {
            Some(r) => r.path_after
                .as_ref()
                .or(r.path_before.as_ref())
                .map(|p| p.to_string_lossy().into_owned()),
            None => return Ok(Vec::new()),
        };

        let path = match target_path {
            Some(p) => p,
            None => return Ok(Vec::new()),
        };

        // 获取该路径的所有记录
        let all_path_records = self.get_records_for_path(&path).await?;

        // 找到目标记录在路径记录列表中的位置，返回其后所有记录
        let pos = all_path_records.iter().position(|r| r.id == *record_id);
        match pos {
            Some(p) => Ok(all_path_records[p + 1..].to_vec()),
            None => Ok(Vec::new()),
        }
    }

    /// 获取某 message_id 之后的所有记录（消息时间点级回退）。
    pub async fn get_records_after_message(
        &self,
        message_id: &MessageId,
    ) -> Result<Vec<ChangeRecord>, AppError> {
        self.ensure_loaded().await?;

        let turn_index = self.turn_index.lock().await;
        let mut all_records: Vec<ChangeRecord> = Vec::new();
        for records in turn_index.values() {
            all_records.extend(records.iter().cloned());
        }
        all_records.sort_by_key(|r| r.timestamp);

        // 找到目标消息的时间点，返回其后的所有记录
        let target_time = all_records.iter()
            .find(|r| r.message_id == *message_id)
            .map(|r| r.timestamp);

        match target_time {
            Some(t) => Ok(all_records.into_iter().filter(|r| r.timestamp > t).collect()),
            None => Ok(Vec::new()),
        }
    }

    /// 列出所有 session（按最后访问时间排序）。
    pub async fn list_sessions_sorted_by_access(&self) -> Result<Vec<String>, AppError> {
        self.ensure_loaded().await?;
        let turn_index = self.turn_index.lock().await;
        let mut sessions: Vec<(String, u64)> = turn_index
            .iter()
            .map(|(k, records)| {
                let last_ts = records.last().map(|r| r.timestamp).unwrap_or(0);
                (k.clone(), last_ts)
            })
            .collect();
        sessions.sort_by(|a, b| b.1.cmp(&a.1)); // 最近的在前
        Ok(sessions.into_iter().map(|(k, _)| k).collect())
    }

    /// 删除某个 session 的所有记录（配额管理用）。
    pub async fn delete_session(&self, session_id: &str) -> Result<(), AppError> {
        let session_path = self.journal_dir.join(format!("session-{}.jsonl", session_id));
        if session_path.exists() {
            fs::remove_file(&session_path).await
                .map_err(|e| AppError::Internal(format!("删除 session 文件失败：{e}")))?;
        }
        self.turn_index.lock().await.remove(session_id);
        // 从 path_index 中也移除该 session 的记录
        let mut path_index = self.path_index.lock().await;
        for records in path_index.values_mut() {
            records.retain(|r| r.turn_id.0 != session_id);
        }
        Ok(())
    }

    /// 扫描 WAL 目录，返回所有未完成的 intent。
    async fn scan_wal_dir(&self) -> Result<Vec<(WalIntent, PathBuf)>, AppError> {
        let mut intents = Vec::new();
        let mut entries = fs::read_dir(&self.wal_dir).await
            .map_err(|e| AppError::Internal(format!("读取 WAL 目录失败：{e}")))?;

        while let Some(entry) = entries.next_entry().await
            .map_err(|e| AppError::Internal(format!("读取 WAL 条目失败：{e}")))?
        {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let data = fs::read(&path).await
                .map_err(|e| AppError::Internal(format!("读取 WAL 文件失败：{e}")))?;
            match serde_json::from_slice::<WalIntent>(&data) {
                Ok(intent) => intents.push((intent, path)),
                Err(e) => {
                    tracing::warn!("跳过无法解析的 WAL 文件 {:?}：{e}", path);
                }
            }
        }

        Ok(intents)
    }

    /// 崩溃恢复：扫描 WAL 目录，根据文件当前状态决定补写记录或回滚。
    pub async fn recover_from_wal(
        &self,
        version_store: &Arc<VersionStore>,
    ) -> Result<(), AppError> {
        let intents = self.scan_wal_dir().await?;

        for (intent, wal_path) in intents {
            // 若对应的 ChangeRecord 已存在于 Journal → 已提交，忽略
            if self.has_record(&intent.record_id).await? {
                let _ = fs::remove_file(&wal_path).await;
                continue;
            }

            // 未提交 → 校验当前文件状态
            let current = match fs::read(&intent.path).await {
                Ok(data) => data,
                Err(_) => {
                    // 文件不存在 → 操作可能是 Create 且未执行，或 Delete 已执行
                    if intent.kind == ChangeKind::Delete {
                        // Delete 已执行但未记录 → 补写记录
                        let pre_v = version_store.get(&intent.pre_version_id).await.ok();
                        let post_v = version_store.create_tombstone().await?;

                        if let Some(pre_v) = pre_v {
                            let record = ChangeRecord {
                                id: intent.record_id.clone(),
                                turn_id: intent.turn_id.clone(),
                                message_id: intent.message_id.clone(),
                                path_before: Some(intent.path.clone()),
                                path_after: None,
                                kind: ChangeKind::Delete,
                                source: intent.source.clone(),
                                timestamp: intent.timestamp,
                                pre: pre_v.id,
                                post: post_v.id,
                            };
                            let _ = self.append(record).await;
                        }
                    } else {
                        // Create/Modify 未执行 → 回滚（删除 WAL）
                        tracing::info!("WAL 恢复：操作未执行，回滚 {:?}", intent.path);
                    }
                    let _ = fs::remove_file(&wal_path).await;
                    continue;
                }
            };

            let current_hash = bytes_to_hex(&*blake3::hash(&current).as_bytes());

            if current_hash == intent.pre_hash {
                // 文件仍是修改前的状态 → 操作未执行，直接回滚
                tracing::info!("WAL 恢复：文件未变更，回滚 intent {:?}", intent.record_id);
                let _ = fs::remove_file(&wal_path).await;
            } else if current_hash == intent.post_hash {
                // 文件已是修改后的状态 → 操作已执行但未记录
                // 补写 ChangeRecord
                let pre_v = version_store.get(&intent.pre_version_id).await.ok();
                if let Some(pre_v) = pre_v {
                    let post_meta = super::version_store::FileMeta::from_path(&intent.path)
                        .unwrap_or_else(|_| super::version_store::FileMeta::tombstone());
                    let post_v = version_store.create_version(&current, post_meta).await?;

                    let path_after = match intent.kind {
                        ChangeKind::Delete => None,
                        _ => Some(intent.path.clone()),
                    };

                    let record = ChangeRecord {
                        id: intent.record_id.clone(),
                        turn_id: intent.turn_id.clone(),
                        message_id: intent.message_id.clone(),
                        path_before: Some(intent.path.clone()),
                        path_after,
                        kind: intent.kind.clone(),
                        source: intent.source.clone(),
                        timestamp: intent.timestamp,
                        pre: pre_v.id,
                        post: post_v.id,
                    };
                    let _ = self.append(record).await;
                }
                let _ = fs::remove_file(&wal_path).await;
            } else {
                // 都不匹配 → 可能部分写入或外部修改，标记需人工处理
                tracing::error!(
                    "WAL 恢复冲突：{:?}（文件状态既不匹配 pre 也不匹配 post）",
                    intent.record_id
                );
                // 标记 conflicted 并保留 WAL 文件
                let mut conflicted_intent = intent;
                conflicted_intent.conflicted = true;
                let json = serde_json::to_vec_pretty(&conflicted_intent)
                    .unwrap_or_default();
                let _ = fs::write(&wal_path, &json).await;
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::version_store::FileMeta;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_append_and_query() {
        let tmp = TempDir::new().unwrap();
        let journal_dir = tmp.path().join("journal");
        let wal_dir = journal_dir.join("wal");
        tokio::fs::create_dir_all(&journal_dir).await.unwrap();
        tokio::fs::create_dir_all(&wal_dir).await.unwrap();

        let journal = ChangeJournal::new(journal_dir, wal_dir);

        // 创建两个版本
        let objects_dir = tmp.path().join("objects");
        let versions_dir = tmp.path().join("versions");
        tokio::fs::create_dir_all(&objects_dir).await.unwrap();
        tokio::fs::create_dir_all(&versions_dir).await.unwrap();
        let obj_store = Arc::new(crate::file_history::ObjectStore::new(objects_dir));
        let ver_store = Arc::new(crate::file_history::VersionStore::new(versions_dir, obj_store));

        let pre_v = ver_store.create_version(b"old", FileMeta { size: 3, mtime: 0, mode: 0 }).await.unwrap();
        let post_v = ver_store.create_version(b"new", FileMeta { size: 3, mtime: 0, mode: 0 }).await.unwrap();

        let record = ChangeRecord {
            id: RecordId::new(),
            turn_id: TurnId("turn1".into()),
            message_id: MessageId("msg1".into()),
            path_before: Some(PathBuf::from("/test/file.rs")),
            path_after: Some(PathBuf::from("/test/file.rs")),
            kind: ChangeKind::Modify,
            source: ChangeSource::Agent,
            timestamp: now_millis(),
            pre: pre_v.id,
            post: post_v.id,
        };

        journal.append(record.clone()).await.unwrap();

        let records = journal.get_records_by_turn(&TurnId("turn1".into())).await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, record.id);
    }
}
