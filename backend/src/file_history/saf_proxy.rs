//! SAF（Storage Access Framework）代理层。
//!
//! SAF 工作区不能直接作为工具操作目标——写入无原子性、mtime 不可靠、无法 rename。
//! 解决方案：工具永远操作私有目录中的副本，SAF 原始路径仅在显式同步时读写。
//!
//! ```text
//! 私有目录（POSIX，完全可靠）
//! <app_private>/work_copy/         ← 工具实际读写对象
//! <app_private>/.mytool/           ← 备份系统
//!     │
//!     │ 双向同步（显式触发）
//!     ▼
//! SAF 外部存储（不可靠）
//!   src/main.rs                    ← 用户的外部工作区
//! ```
//!
//! 注意：在桌面环境中 SAF 模式不激活，此模块仅提供结构支持。
//! Android 环境下通过 Tauri 插件桥接到 SAF API。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::sync::RwLock;

use crate::error::AppError;

use super::version_store::{FileMeta, VersionId, VersionStore};
use super::{
    ChangeJournal, ChangeKind, ChangeRecord, ChangeSource, FileHistory, MessageId, RecordId,
    TurnId, bytes_to_hex, now_millis,
};

/// SAF 代理配置。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SafConfig {
    /// 是否启用 SAF 模式
    pub enabled: bool,
    /// SAF 工作区根 URI
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saf_root_uri: Option<String>,
    /// 私有目录中的 work_copy 路径
    pub work_copy_dir: PathBuf,
}

impl Default for SafConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            saf_root_uri: None,
            work_copy_dir: PathBuf::from("work_copy"),
        }
    }
}

/// 已追踪文件的 SAF 状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackedFileSaf {
    /// 工作区相对路径
    pub workspace_path: String,
    /// SAF URI
    pub saf_uri: String,
    /// 私有目录中的本地副本路径
    pub local_path: PathBuf,
    /// 最后已知版本 ID
    pub last_known_version: VersionId,
    /// 是否有未同步的本地修改
    pub sync_dirty: bool,
}

/// SAF 代理。
pub struct SafProxy {
    config: SafConfig,
    /// 已追踪文件列表
    tracked_files: RwLock<HashMap<String, TrackedFileSaf>>,
}

impl SafProxy {
    pub fn new(config: SafConfig) -> Self {
        Self {
            config,
            tracked_files: RwLock::new(HashMap::new()),
        }
    }

    /// 是否启用 SAF 模式。
    pub fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    /// 将工作区路径映射到私有目录中的副本路径。
    pub fn map_to_local_copy(&self, workspace_path: &Path) -> PathBuf {
        let rel = workspace_path
            .strip_prefix(&self.config.work_copy_dir)
            .unwrap_or(workspace_path);
        self.config.work_copy_dir.join(rel)
    }

    /// 注册一个追踪文件。
    pub async fn track_file(
        &self,
        workspace_path: &str,
        saf_uri: &str,
        local_path: PathBuf,
        last_known_version: VersionId,
    ) {
        let mut files = self.tracked_files.write().await;
        files.insert(
            workspace_path.to_string(),
            TrackedFileSaf {
                workspace_path: workspace_path.to_string(),
                saf_uri: saf_uri.to_string(),
                local_path,
                last_known_version,
                sync_dirty: false,
            },
        );
    }

    /// 标记文件为 dirty（有本地修改未同步到 SAF）。
    pub async fn mark_dirty(&self, workspace_path: &str) {
        let mut files = self.tracked_files.write().await;
        if let Some(f) = files.get_mut(workspace_path) {
            f.sync_dirty = true;
        }
    }

    /// 获取所有 dirty 文件列表。
    pub async fn dirty_files(&self) -> Vec<String> {
        let files = self.tracked_files.read().await;
        files
            .values()
            .filter(|f| f.sync_dirty)
            .map(|f| f.workspace_path.clone())
            .collect()
    }

    /// 获取所有追踪文件列表。
    pub async fn tracked_files_list(&self) -> Vec<TrackedFileSaf> {
        let files = self.tracked_files.read().await;
        files.values().cloned().collect()
    }

    /// sync-in：从 SAF 拉取变更到本地副本。
    ///
    /// 通过 hash 比对检测外部编辑（不依赖不可靠的 mtime）。
    /// 检测到的外部编辑作为 ChangeRecord 追加到 Journal。
    pub async fn sync_in_from_saf(
        &self,
        history: &FileHistory,
    ) -> Result<super::SyncInReport, AppError> {
        let mut report = super::SyncInReport::default();
        let tracked = self.tracked_files_list().await;

        for file in &tracked {
            // 通过 SAF 读取（桌面环境下回退到直接读文件）
            let saf_content = self.read_via_saf(&file.saf_uri).await?;
            let saf_hash = bytes_to_hex(&*blake3::hash(&saf_content).as_bytes());

            let local_content = match fs::read(&file.local_path).await {
                Ok(data) => data,
                Err(_) => {
                    // 本地副本不存在（首次 sync-in），直接写入
                    if let Some(parent) = file.local_path.parent() {
                        fs::create_dir_all(parent).await
                            .map_err(|e| AppError::Internal(format!("创建目录失败：{e}")))?;
                    }
                    fs::write(&file.local_path, &saf_content).await
                        .map_err(|e| AppError::Internal(format!("写入本地副本失败：{e}")))?;
                    continue;
                }
            };
            let local_hash = bytes_to_hex(&*blake3::hash(&local_content).as_bytes());

            if saf_hash == local_hash {
                continue; // 未变
            }

            // SAF 上的文件发生了外部修改
            let pre_version_id = file.last_known_version.clone();

            // 创建 post 版本
            let post_meta = FileMeta::from_path(&file.local_path)
                .unwrap_or_else(|_| FileMeta::tombstone());
            let post_version = history.version_store.create_version(&saf_content, post_meta).await?;

            // 追加 ChangeRecord 到 Journal
            let post_version_id = post_version.id.clone();
            let record = ChangeRecord {
                id: RecordId::new(),
                turn_id: TurnId::external(),
                message_id: MessageId::external(),
                path_before: Some(PathBuf::from(&file.workspace_path)),
                path_after: Some(PathBuf::from(&file.workspace_path)),
                kind: ChangeKind::Modify,
                source: ChangeSource::ExternalEdit,
                timestamp: now_millis(),
                pre: pre_version_id,
                post: post_version_id,
            };
            history.journal.append(record).await?;

            // 更新本地副本
            fs::write(&file.local_path, &saf_content).await
                .map_err(|e| AppError::Internal(format!("更新本地副本失败：{e}")))?;

            // 更新追踪状态
            {
                let mut files = self.tracked_files.write().await;
                if let Some(f) = files.get_mut(&file.workspace_path) {
                    f.last_known_version = post_version.id;
                }
            }

            report.external_edits.push(file.workspace_path.clone());
        }

        Ok(report)
    }

    /// sync-out：将本地副本推送到 SAF。
    ///
    /// SAF 不支持原子写入，策略：写入 → 验证 hash → 失败则标记 dirty。
    pub async fn sync_out_to_saf(
        &self,
        _history: &FileHistory,
    ) -> Result<super::SyncOutReport, AppError> {
        let mut report = super::SyncOutReport::default();
        let tracked = self.tracked_files_list().await;

        for file in &tracked {
            if !file.sync_dirty {
                continue;
            }

            let content = match fs::read(&file.local_path).await {
                Ok(data) => data,
                Err(e) => {
                    report.failures.push(super::SyncOutFailure {
                        path: file.workspace_path.clone(),
                        reason: format!("读取本地副本失败：{e}"),
                        recoverable: false,
                    });
                    continue;
                }
            };

            let expected_hash = bytes_to_hex(&*blake3::hash(&content).as_bytes());

            // 尝试写入 SAF
            match self.write_via_saf(&file.saf_uri, &content).await {
                Ok(_) => {
                    // 验证
                    match self.read_via_saf(&file.saf_uri).await {
                        Ok(remote_content) => {
                            let remote_hash = bytes_to_hex(&*blake3::hash(&remote_content).as_bytes());
                            if remote_hash != expected_hash {
                                report.failures.push(super::SyncOutFailure {
                                    path: file.workspace_path.clone(),
                                    reason: "hash mismatch after SAF write".into(),
                                    recoverable: true,
                                });
                            } else {
                                // 同步成功，清除 dirty 标记
                                {
                                    let mut files = self.tracked_files.write().await;
                                    if let Some(f) = files.get_mut(&file.workspace_path) {
                                        f.sync_dirty = false;
                                    }
                                }
                                report.synced.push(file.workspace_path.clone());
                            }
                        }
                        Err(e) => {
                            report.failures.push(super::SyncOutFailure {
                                path: file.workspace_path.clone(),
                                reason: format!("验证读取失败：{e}"),
                                recoverable: true,
                            });
                        }
                    }
                }
                Err(e) => {
                    report.failures.push(super::SyncOutFailure {
                        path: file.workspace_path.clone(),
                        reason: format!("写入 SAF 失败：{e}"),
                        recoverable: true,
                    });
                }
            }
        }

        Ok(report)
    }

    /// 通过 SAF 读取文件内容。
    ///
    /// 桌面环境：直接从 URI 路径读取。
    /// Android 环境：通过 Tauri SAF 插件桥接（待实现）。
    async fn read_via_saf(&self, uri: &str) -> Result<Vec<u8>, AppError> {
        // 桌面回退：URI 即文件路径
        let path = uri.strip_prefix("file://").unwrap_or(uri);
        fs::read(path).await
            .map_err(|e| AppError::Internal(format!("SAF 读取失败：{e}")))
    }

    /// 通过 SAF 写入文件内容。
    async fn write_via_saf(&self, uri: &str, content: &[u8]) -> Result<(), AppError> {
        // 桌面回退：URI 即文件路径
        let path = uri.strip_prefix("file://").unwrap_or(uri);
        fs::write(path, content).await
            .map_err(|e| AppError::Internal(format!("SAF 写入失败：{e}")))
    }
}
