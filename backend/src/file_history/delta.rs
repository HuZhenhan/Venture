//! Binary delta 编码模块（Phase 2）。
//!
//! 实现 pre → post 的二进制差分编码，用于 VersionRepresentation::Delta。
//! 这是存储层的 delta（目标是可重建和空间节省），不是 UI 展示的行级 hunk。
//!
//! 算法：基于滚动哈希的块匹配
//! 1. 将 pre（base）按固定大小分块，建立 hash → offset 索引
//! 2. 扫描 post，在 pre 中查找匹配块
//! 3. 输出 COPY（从 pre 复制）和 INSERT（新数据）操作序列
//! 4. 用 flate2 压缩操作序列
//!
//! Delta 格式（压缩前）：
//! ```text
//! [OP_COPY:  u8=0][offset: u64 LE][length: u32 LE]
//! [OP_INSERT: u8=1][length: u32 LE][bytes...]
//! [OP_END:   u8=2]
//! ```

use std::collections::HashMap;
use std::io::{Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;

use crate::error::AppError;

/// Delta 操作码。
const OP_COPY: u8 = 0;
const OP_INSERT: u8 = 1;
const OP_END: u8 = 2;

/// 块匹配的最小块大小（字节）。小于此值的匹配不值得 COPY。
const MIN_MATCH: usize = 32;
/// 块匹配的固定分块大小（用于索引 pre）。
const BLOCK_SIZE: usize = 64;
/// 滚动哈希窗口大小。
const HASH_WINDOW: usize = 64;

/// 创建 binary delta：给定 base（pre）和 target（post），返回压缩后的 delta 数据。
///
/// 返回的 delta 可通过 `apply_delta(base, delta)` 重建 post。
pub fn create_delta(base: &[u8], target: &[u8]) -> Result<Vec<u8>, AppError> {
    let ops = compute_diff_ops(base, target);
    let serialized = serialize_ops(&ops);
    compress(&serialized)
}

/// 应用 binary delta：给定 base（pre）和 delta，重建 post。
pub fn apply_delta(base: &[u8], delta_compressed: &[u8]) -> Result<Vec<u8>, AppError> {
    let decompressed = decompress(delta_compressed)?;
    let ops = deserialize_ops(&decompressed)?;
    apply_ops(base, &ops)
}

// ─── 块匹配 diff ──────────────────────────────────────────────────────────

/// Diff 操作：从 base 复制或插入新数据。
enum DiffOp {
    /// 从 base 的 offset 处复制 length 字节
    Copy { offset: u64, length: u32 },
    /// 插入新数据
    Insert(Vec<u8>),
}

/// 计算 diff 操作序列。
///
/// 使用固定大小分块 + 滚动哈希匹配：
/// 1. 将 base 按 BLOCK_SIZE 分块，建立块哈希 → 位置索引
/// 2. 在 target 上滑动 HASH_WINDOW 窗口，查找 base 中的匹配
/// 3. 匹配长度 ≥ MIN_MATCH 时输出 COPY，否则输出 INSERT
fn compute_diff_ops(base: &[u8], target: &[u8]) -> Vec<DiffOp> {
    let mut ops = Vec::new();

    // 特殊情况：base 为空 → 全部 INSERT
    if base.is_empty() {
        if !target.is_empty() {
            ops.push(DiffOp::Insert(target.to_vec()));
        }
        return ops;
    }

    // 建立 base 的块索引：块哈希 → (offset, 该哈希出现的所有 offset)
    let block_index = build_block_index(base);

    let mut target_pos = 0usize;
    let mut pending_insert = Vec::new();

    while target_pos < target.len() {
        // 尝试在当前位置匹配 base 中的块
        if let Some((base_offset, match_len)) = find_best_match(
            base,
            target,
            target_pos,
            &block_index,
        ) {
            // 匹配成功且长度足够
            if match_len >= MIN_MATCH {
                // 先 flush pending insert
                if !pending_insert.is_empty() {
                    ops.push(DiffOp::Insert(std::mem::take(&mut pending_insert)));
                }
                ops.push(DiffOp::Copy {
                    offset: base_offset as u64,
                    length: match_len as u32,
                });
                target_pos += match_len;
                continue;
            }
        }

        // 未找到足够长的匹配 → 收集到 pending insert
        pending_insert.push(target[target_pos]);
        target_pos += 1;
    }

    // flush 最后的 pending insert
    if !pending_insert.is_empty() {
        ops.push(DiffOp::Insert(pending_insert));
    }

    ops
}

/// 构建 base 的块索引：块哈希 → 该块在 base 中的所有起始 offset。
fn build_block_index(base: &[u8]) -> HashMap<u64, Vec<usize>> {
    let mut index: HashMap<u64, Vec<usize>> = HashMap::new();
    if base.len() < BLOCK_SIZE {
        return index;
    }

    let mut pos = 0;
    while pos + BLOCK_SIZE <= base.len() {
        let hash = gear_hash(&base[pos..pos + BLOCK_SIZE]);
        index.entry(hash).or_default().push(pos);
        pos += BLOCK_SIZE;
    }

    index
}

/// 在 target 的 pos 位置查找 base 中的最佳匹配。
///
/// 返回 (base_offset, match_length)。match_length ≥ BLOCK_SIZE。
fn find_best_match(
    base: &[u8],
    target: &[u8],
    pos: usize,
    block_index: &HashMap<u64, Vec<usize>>,
) -> Option<(usize, usize)> {
    if pos + BLOCK_SIZE > target.len() {
        return None;
    }

    // 计算 target 当前位置的块哈希
    let hash = gear_hash(&target[pos..pos + BLOCK_SIZE]);

    // 在 base 中查找相同哈希的块
    let candidates = block_index.get(&hash)?;

    let mut best = None;
    let mut best_len = 0usize;

    for &base_pos in candidates {
        // 验证块确实匹配（防哈希碰撞）
        if base[base_pos..base_pos + BLOCK_SIZE] != target[pos..pos + BLOCK_SIZE] {
            continue;
        }

        // 向前扩展匹配
        let match_len = extend_match(base, target, base_pos, pos);

        if match_len > best_len {
            best_len = match_len;
            best = Some((base_pos, match_len));
        }
    }

    best
}

/// 扩展匹配：从块起始位置向前/向后扩展，找到最长的公共子串。
fn extend_match(base: &[u8], target: &[u8], base_pos: usize, target_pos: usize) -> usize {
    let mut len = BLOCK_SIZE;
    let base_end = base.len();
    let target_end = target.len();

    // 向前扩展
    while base_pos + len < base_end && target_pos + len < target_end && base[base_pos + len] == target[target_pos + len] {
        len += 1;
    }

    len
}

/// Gear 哈希：快速滚动哈希，用于内容定义分块和块匹配。
///
/// 使用预计算的 gear 表，每个字节位置贡献一个 64 位值，
/// 通过移位和异或快速更新哈希值。
fn gear_hash(data: &[u8]) -> u64 {
    let mut hash: u64 = 0;
    for &b in data {
        hash = (hash << 1) ^ GEAR_TABLE[b as usize];
    }
    hash
}

/// Gear 哈希表：256 个随机 64 位值，预计算以加速哈希。
/// 使用固定种子保证可重现性。
static GEAR_TABLE: [u64; 256] = build_gear_table();

const fn build_gear_table() -> [u64; 256] {
    let mut table = [0u64; 256];
    // 使用简单的 LCG 生成伪随机值
    let mut seed: u64 = 0x2545F4914F6CDD1D;
    let mut i = 0;
    while i < 256 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        table[i] = seed;
        i += 1;
    }
    table
}

// ─── 序列化/反序列化 ──────────────────────────────────────────────────────

/// 将 diff 操作序列序列化为二进制格式。
fn serialize_ops(ops: &[DiffOp]) -> Vec<u8> {
    let mut out = Vec::with_capacity(ops.len() * 16);
    for op in ops {
        match op {
            DiffOp::Copy { offset, length } => {
                out.push(OP_COPY);
                out.extend_from_slice(&offset.to_le_bytes());
                out.extend_from_slice(&length.to_le_bytes());
            }
            DiffOp::Insert(data) => {
                out.push(OP_INSERT);
                out.extend_from_slice(&(data.len() as u32).to_le_bytes());
                out.extend_from_slice(data);
            }
        }
    }
    out.push(OP_END);
    out
}

/// 从二进制格式反序列化 diff 操作序列。
fn deserialize_ops(data: &[u8]) -> Result<Vec<DiffOp>, AppError> {
    let mut ops = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        let op = data[pos];
        pos += 1;
        match op {
            OP_COPY => {
                if pos + 12 > data.len() {
                    return Err(AppError::Internal("delta 反序列化失败：COPY 操作不完整".into()));
                }
                let offset = u64::from_le_bytes(data[pos..pos + 8].try_into().unwrap());
                pos += 8;
                let length = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap());
                pos += 4;
                ops.push(DiffOp::Copy { offset, length });
            }
            OP_INSERT => {
                if pos + 4 > data.len() {
                    return Err(AppError::Internal("delta 反序列化失败：INSERT 操作不完整".into()));
                }
                let length = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
                pos += 4;
                if pos + length > data.len() {
                    return Err(AppError::Internal("delta 反序列化失败：INSERT 数据不完整".into()));
                }
                ops.push(DiffOp::Insert(data[pos..pos + length].to_vec()));
                pos += length;
            }
            OP_END => break,
            _ => return Err(AppError::Internal(format!("delta 反序列化失败：未知操作码 {op}"))),
        }
    }

    Ok(ops)
}

/// 应用 diff 操作序列，从 base 重建 target。
fn apply_ops(base: &[u8], ops: &[DiffOp]) -> Result<Vec<u8>, AppError> {
    let mut result = Vec::new();
    for op in ops {
        match op {
            DiffOp::Copy { offset, length } => {
                let offset = *offset as usize;
                let length = *length as usize;
                if offset + length > base.len() {
                    return Err(AppError::Internal(format!(
                        "delta 应用失败：COPY 越界（offset={}, length={}, base_len={}）",
                        offset, length, base.len()
                    )));
                }
                result.extend_from_slice(&base[offset..offset + length]);
            }
            DiffOp::Insert(data) => {
                result.extend_from_slice(data);
            }
        }
    }
    Ok(result)
}

// ─── 压缩/解压 ────────────────────────────────────────────────────────────

/// 用 gzip 压缩数据。
fn compress(data: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data)
        .map_err(|e| AppError::Internal(format!("delta 压缩失败：{e}")))?;
    encoder.finish()
        .map_err(|e| AppError::Internal(format!("delta 压缩完成失败：{e}")))
}

/// 用 gzip 解压数据。
fn decompress(data: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut decoder = GzDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out)
        .map_err(|e| AppError::Internal(format!("delta 解压失败：{e}")))?;
    Ok(out)
}

// ─── FastCDC 内容定义分块 ──────────────────────────────────────────────────

/// FastCDC 分块参数。
pub struct FastCdcConfig {
    /// 最小 chunk 大小
    pub min_size: usize,
    /// 平均 chunk 大小（决定切分概率）
    pub avg_size: usize,
    /// 最大 chunk 大小
    pub max_size: usize,
}

impl Default for FastCdcConfig {
    fn default() -> Self {
        Self {
            min_size: 4 * 1024,       // 4KB
            avg_size: 16 * 1024,      // 16KB
            max_size: 64 * 1024,      // 64KB
        }
    }
}

/// 使用 FastCDC 算法将内容分块。
///
/// FastCDC 使用 Gear 滚动哈希和动态掩码：
/// - 在 min_size 之前不切分
/// - 在 min_size ~ max_size 之间，当哈希满足掩码条件时切分
/// - 达到 max_size 时强制切分
///
/// 相同内容产生相同分块，便于 CAS 去重。
pub fn fastcdc_chunk(data: &[u8], config: &FastCdcConfig) -> Vec<Vec<u8>> {
    let mut chunks = Vec::new();
    if data.is_empty() {
        return chunks;
    }

    let mut start = 0usize;
    while start < data.len() {
        let end = find_chunk_boundary(data, start, config);
        chunks.push(data[start..end].to_vec());
        start = end;
    }

    chunks
}

/// 找到从 start 开始的下一个 chunk 边界。
fn find_chunk_boundary(data: &[u8], start: usize, config: &FastCdcConfig) -> usize {
    let len = data.len();
    let min_end = (start + config.min_size).min(len);
    let max_end = (start + config.max_size).min(len);

    // 在 min_size 之前不切分
    if min_end >= len {
        return len;
    }

    // 计算掩码（基于 avg_size 的对数）
    let mask = avg_to_mask(config.avg_size);

    let mut hash: u64 = 0;
    let mut pos = start;

    // 在 min_size ~ max_size 之间寻找切分点
    while pos < max_end {
        hash = (hash << 1) ^ GEAR_TABLE[data[pos] as usize];
        pos += 1;

        if pos >= min_end && (hash & mask) == 0 {
            return pos;
        }
    }

    // 达到 max_size → 强制切分
    max_end
}

/// 将平均 chunk 大小转换为掩码。
///
/// mask = 2^ceil(log2(avg_size)) - 1
/// 这样哈希值满足条件的概率约为 1/avg_size。
fn avg_to_mask(avg_size: usize) -> u64 {
    let mut bits = 0;
    let mut s = avg_size;
    while s > 1 {
        s >>= 1;
        bits += 1;
    }
    (1u64 << bits) - 1
}

// ─── 判断是否为二进制文件 ──────────────────────────────────────────────────

/// 检测内容是否为二进制（含 NUL 字节）。
pub fn is_binary(data: &[u8]) -> bool {
    data.contains(&0u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_delta_roundtrip_text() {
        let base = b"hello world\nthis is a test\nline three\nline four\nline five\n";
        let target = b"hello world\nthis is MODIFIED\nline three\nline four\nline five\nnew line at end\n";

        let delta = create_delta(base, target).unwrap();
        let reconstructed = apply_delta(base, &delta).unwrap();

        assert_eq!(reconstructed, target);
    }

    #[test]
    fn test_delta_roundtrip_binary() {
        let base: Vec<u8> = (0..1000).map(|i| (i % 256) as u8).collect();
        let mut target = base.clone();
        // 修改中间一段
        for i in 500..510 {
            target[i] = 0xFF;
        }
        // 追加数据
        target.extend_from_slice(&[1, 2, 3, 4, 5]);

        let delta = create_delta(&base, &target).unwrap();
        let reconstructed = apply_delta(&base, &delta).unwrap();

        assert_eq!(reconstructed, target);
    }

    #[test]
    fn test_delta_empty_base() {
        let target = b"completely new content";
        let delta = create_delta(b"", target).unwrap();
        let reconstructed = apply_delta(b"", &delta).unwrap();
        assert_eq!(reconstructed, target);
    }

    #[test]
    fn test_delta_empty_target() {
        let base = b"some content that will be removed";
        let delta = create_delta(base, b"").unwrap();
        let reconstructed = apply_delta(base, &delta).unwrap();
        assert_eq!(reconstructed, b"");
    }

    #[test]
    fn test_delta_compression_ratio() {
        // 大文件，小改动 → delta 应远小于全量
        let base: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let mut target = base.clone();
        target[50_000] = 0xFF;

        let delta = create_delta(&base, &target).unwrap();
        // delta 应远小于 target 的大小
        assert!(
            delta.len() < target.len() / 2,
            "delta ({}) should be much smaller than target ({})",
            delta.len(),
            target.len()
        );
    }

    #[test]
    fn test_fastcdc_chunk() {
        let config = FastCdcConfig::default();
        let data: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let chunks = fastcdc_chunk(&data, &config);

        assert!(!chunks.is_empty());
        let total: usize = chunks.iter().map(|c| c.len()).sum();
        assert_eq!(total, data.len());

        // 每个 chunk 应在 min_size ~ max_size 范围内（最后一个可能更小）
        for (i, chunk) in chunks.iter().enumerate() {
            if i < chunks.len() - 1 {
                assert!(chunk.len() >= config.min_size, "chunk {} too small: {}", i, chunk.len());
                assert!(chunk.len() <= config.max_size, "chunk {} too large: {}", i, chunk.len());
            }
        }
    }

    #[test]
    fn test_fastcdc_deterministic() {
        let config = FastCdcConfig::default();
        let data: Vec<u8> = (0..50_000).map(|i| (i % 256) as u8).collect();
        let chunks1 = fastcdc_chunk(&data, &config);
        let chunks2 = fastcdc_chunk(&data, &config);

        assert_eq!(chunks1.len(), chunks2.len());
        for (a, b) in chunks1.iter().zip(chunks2.iter()) {
            assert_eq!(a, b);
        }
    }

    #[test]
    fn test_is_binary() {
        assert!(!is_binary(b"hello world\n"));
        assert!(is_binary(b"hello\x00world"));
    }
}
