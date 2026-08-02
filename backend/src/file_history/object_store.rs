//! 内容寻址存储（CAS）。
//!
//! 按 BLAKE3 哈希存储文件内容，同一内容只存一份。
//! Phase 1 使用 FullManifest（chunk manifest）存储整文件内容。
//!
//! 存储路径结构：
//! ```text
//! objects/
//!   ab/cdef0123...    # 按哈希前两位分目录
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::sync::Mutex;

use crate::error::AppError;

use super::{bytes_to_hex, hex_to_bytes};

/// BLAKE3 哈希，32 字节，作为对象 ID。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ObjectId(#[serde(with = "serde_hex")] pub [u8; 32]);

impl ObjectId {
    /// 从内容计算 ObjectId。
    pub fn from_content(content: &[u8]) -> Self {
        Self(*blake3::hash(content).as_bytes())
    }

    /// 转为十六进制字符串。
    pub fn to_hex(&self) -> String {
        bytes_to_hex(&self.0)
    }

    /// 从十六进制字符串解析。
    pub fn from_hex(hex: &str) -> Result<Self, AppError> {
        Ok(Self(hex_to_bytes(hex)?))
    }

    /// 哈希前两字节（用于分目录）。
    fn prefix(&self) -> String {
        format!("{:02x}", self.0[0])
    }
}

impl std::fmt::Display for ObjectId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_hex())
    }
}

/// serde 辅助：将 [u8;32] 序列化为十六进制字符串。
mod serde_hex {
    use serde::{Deserialize, Deserializer, Serializer};
    use super::{bytes_to_hex, hex_to_bytes};

    pub fn serialize<S: Serializer>(bytes: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&bytes_to_hex(bytes))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        hex_to_bytes(&s).map_err(serde::de::Error::custom)
    }
}

/// 整文件的 chunk manifest。Phase 1 以单 chunk 存储整文件内容。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FullManifest {
    /// 文件内容的 chunk 引用列表
    pub chunks: Vec<ChunkRef>,
    /// 文件总大小（字节）
    pub total_size: u64,
}

/// 单个 chunk 引用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkRef {
    /// chunk 内容的 ObjectId
    pub hash: ObjectId,
    /// 在文件中的偏移量
    pub offset: u64,
    /// chunk 大小（字节）
    pub size: u32,
}

/// 内容寻址存储。
pub struct ObjectStore {
    root: PathBuf,
    /// 缓存：ObjectId → 已在磁盘上存在。减少重复 IO。
    exists_cache: Arc<Mutex<std::collections::HashSet<[u8; 32]>>>,
}

impl ObjectStore {
    /// 创建 ObjectStore，root 应为 `.mytool/objects/`。
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            exists_cache: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    /// 返回存储根目录。
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 计算 ObjectId 对应的磁盘路径。
    fn object_path(&self, id: &ObjectId) -> PathBuf {
        self.root.join(id.prefix()).join(id.to_hex())
    }

    /// 存储内容，返回 ObjectId。若内容已存在则跳过写入（CAS 去重）。
    pub async fn store(&self, content: &[u8]) -> Result<ObjectId, AppError> {
        let id = ObjectId::from_content(content);
        let id_bytes = id.0;

        // 快速路径：缓存命中
        {
            let cache = self.exists_cache.lock().await;
            if cache.contains(&id_bytes) {
                return Ok(id);
            }
        }

        let path = self.object_path(&id);

        // 检查文件是否已存在（磁盘上可能已有）
        if !path.exists() {
            // 创建前缀目录
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).await
                    .map_err(|e| AppError::Internal(format!("创建对象目录失败：{e}")))?;
            }

            // 原子写入：先写临时文件再 rename
            let tmp = path.with_extension("tmp");
            fs::write(&tmp, content).await
                .map_err(|e| AppError::Internal(format!("写入对象临时文件失败：{e}")))?;
            // rename 在 POSIX 上原子；Windows 上若目标已存在会失败，需先移除
            if path.exists() {
                // 并发写入竞态：另一个线程已写入，删除临时文件即可
                let _ = fs::remove_file(&tmp).await;
            } else {
                fs::rename(&tmp, &path).await
                    .map_err(|e| AppError::Internal(format!("重命名对象文件失败：{e}")))?;
            }
        }

        // 更新缓存
        self.exists_cache.lock().await.insert(id_bytes);

        Ok(id)
    }

    /// 读取对象内容。
    pub async fn get(&self, id: &ObjectId) -> Result<Vec<u8>, AppError> {
        let path = self.object_path(id);
        fs::read(&path).await
            .map_err(|e| AppError::Internal(format!("读取对象 {} 失败：{e}", id.to_hex())))
    }

    /// 将整文件内容以 FullManifest 存储。
    ///
    /// Phase 2：使用 FastCDC 内容定义分块，相同内容产生相同分块，实现 chunk 级去重。
    /// 小文件（< 4KB）使用单 chunk 避免分块开销。
    pub async fn store_chunked(&self, content: &[u8]) -> Result<FullManifest, AppError> {
        let total_size = content.len() as u64;

        // 小文件 → 单 chunk（避免分块开销）
        if content.len() < 4 * 1024 {
            let hash = self.store(content).await?;
            return Ok(FullManifest {
                chunks: vec![ChunkRef {
                    hash,
                    offset: 0,
                    size: content.len() as u32,
                }],
                total_size,
            });
        }

        // 大文件 → FastCDC 分块
        let config = super::delta::FastCdcConfig::default();
        let chunks_data = super::delta::fastcdc_chunk(content, &config);

        let mut chunks = Vec::with_capacity(chunks_data.len());
        let mut offset = 0u64;

        for chunk_data in &chunks_data {
            let hash = self.store(chunk_data).await?;
            chunks.push(ChunkRef {
                hash,
                offset,
                size: chunk_data.len() as u32,
            });
            offset += chunk_data.len() as u64;
        }

        Ok(FullManifest {
            chunks,
            total_size,
        })
    }

    /// 从 FullManifest 重建文件内容。
    pub async fn get_manifest(&self, manifest: &FullManifest) -> Result<Vec<u8>, AppError> {
        let mut content = Vec::with_capacity(manifest.total_size as usize);
        for chunk in &manifest.chunks {
            let data = self.get(&chunk.hash).await?;
            content.extend_from_slice(&data);
        }
        Ok(content)
    }

    /// 计算当前存储目录的总占用空间（字节）。
    pub async fn total_size(&self) -> Result<u64, AppError> {
        let mut total = 0u64;
        let mut stack = vec![self.root.clone()];
        while let Some(dir) = stack.pop() {
            let mut entries = fs::read_dir(&dir).await
                .map_err(|e| AppError::Internal(format!("读取目录失败：{e}")))?;
            while let Some(entry) = entries.next_entry().await
                .map_err(|e| AppError::Internal(format!("读取目录条目失败：{e}")))?
            {
                let path = entry.path();
                let meta = entry.metadata().await
                    .map_err(|e| AppError::Internal(format!("读取元数据失败：{e}")))?;
                if meta.is_file() {
                    total += meta.len();
                } else if meta.is_dir() {
                    stack.push(path);
                }
            }
        }
        Ok(total)
    }

    /// 存储序列化的 manifest JSON，返回其 ObjectId。
    pub async fn store_manifest_json(&self, manifest: &FullManifest) -> Result<ObjectId, AppError> {
        let json = serde_json::to_vec(manifest)
            .map_err(|e| AppError::Internal(format!("序列化 manifest 失败：{e}")))?;
        self.store(&json).await
    }

    /// 读取并反序列化 manifest JSON。
    pub async fn get_manifest_json(&self, id: &ObjectId) -> Result<FullManifest, AppError> {
        let data = self.get(id).await?;
        serde_json::from_slice(&data)
            .map_err(|e| AppError::Internal(format!("反序列化 manifest 失败：{e}")))
    }

    /// 删除指定 session 关联的所有对象。
    ///
    /// 注意：Phase 1 的简化实现——仅按 session 前缀清理 journal，
    /// 对象层面的精确引用计数 GC 留到 Phase 2。
    pub async fn delete_session_objects(&self, _session_id: &str) -> Result<(), AppError> {
        // Phase 1：对象级 GC 暂不实现，依赖配额管理的 LRU session 清理
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_store_and_get() {
        let tmp = TempDir::new().unwrap();
        let store = ObjectStore::new(tmp.path().to_path_buf());

        let content = b"hello world";
        let id = store.store(content).await.unwrap();
        let retrieved = store.get(&id).await.unwrap();
        assert_eq!(retrieved, content);
    }

    #[tokio::test]
    async fn test_store_dedup() {
        let tmp = TempDir::new().unwrap();
        let store = ObjectStore::new(tmp.path().to_path_buf());

        let content = b"duplicate content";
        let id1 = store.store(content).await.unwrap();
        let id2 = store.store(content).await.unwrap();
        assert_eq!(id1, id2);
    }

    #[tokio::test]
    async fn test_store_chunked() {
        let tmp = TempDir::new().unwrap();
        let store = ObjectStore::new(tmp.path().to_path_buf());

        let content = b"chunk test content with more data";
        let manifest = store.store_chunked(content).await.unwrap();
        assert_eq!(manifest.total_size, content.len() as u64);
        assert_eq!(manifest.chunks.len(), 1);

        let retrieved = store.get_manifest(&manifest).await.unwrap();
        assert_eq!(retrieved, content);
    }
}
