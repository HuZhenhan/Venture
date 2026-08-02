//! diff3 三方合并算法。
//!
//! 基于 patience diff 的 diff3 实现，用于回退时处理文件已被后续修改的情况。
//!
//! 核心约定：
//! - `base` = 分叉点（rec.post，即本记录修改后、后续修改开始前的状态）
//! - `ours` = 当前工作区（包含后续修改，我们要保留的）
//! - `theirs` = 回退目标（rec.pre，R1 被撤销后的状态）
//!
//! 合并规则：
//! - 只有 ours 改了的区域 → 保留 ours（后续修改，不冲突）
//! - 只有 theirs 改了的区域 → 采用 theirs（撤销 R1 引入的改动）
//! - 两边都改了 → 冲突，输出冲突标记
//! - 都没改 → 保留 base

use serde::{Deserialize, Serialize};
use similar::{Algorithm, DiffTag, TextDiff};

/// diff3 合并的 chunk 类型。
#[derive(Debug, Clone)]
pub enum Diff3Chunk {
    /// 三方都相同的区域
    Stable {
        lines: Vec<String>,
    },
    /// 只有 ours 改了（保留 ours）
    OursOnly {
        lines: Vec<String>,
    },
    /// 只有 theirs 改了（采用 theirs）
    TheirsOnly {
        lines: Vec<String>,
    },
    /// 两边都改了（冲突）
    Conflict {
        ours_lines: Vec<String>,
        theirs_lines: Vec<String>,
        base_lines: Vec<String>,
        hunk_index: usize,
    },
}

/// 合并结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// 合并后的文件内容
    pub content: Vec<u8>,
    /// 冲突信息列表
    pub conflicts: Vec<ConflictInfo>,
}

/// 冲突信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    /// 冲突所在文件路径
    pub file_path: String,
    /// 关联的 ChangeRecord ID
    pub record_id: String,
    /// 冲突描述
    pub description: String,
}

/// 将字节数组按行分割（保留行内容，不含换行符）。
fn split_lines(data: &[u8]) -> Vec<String> {
    let s = String::from_utf8_lossy(data);
    s.lines().map(|l| l.to_string()).collect()
}

/// 将行列表合并为字节数组（每行后加 \n）。
fn join_lines(lines: &[String]) -> Vec<u8> {
    let mut result = String::new();
    for line in lines {
        result.push_str(line);
        result.push('\n');
    }
    result.into_bytes()
}

/// 使用 patience diff 计算两个文本序列的差异。
///
/// 返回差异操作列表，每个操作包含 tag 和对应的行。
struct DiffOps {
    /// (tag, base_lines, other_lines)
    ops: Vec<(DiffTag, Vec<String>, Vec<String>)>,
}

fn compute_diff(base: &[String], other: &[String]) -> DiffOps {
    // similar 的 diff_lines 接受 &str，需要将 Vec<String> 拼回字符串
    let base_text = base.join("\n");
    let other_text = other.join("\n");

    let diff = TextDiff::configure()
        .algorithm(Algorithm::Patience)
        .diff_lines(&base_text, &other_text);

    let mut ops = Vec::new();
    for group in diff.grouped_ops(3) {
        for op in group {
            let tag = op.tag();
            let base_lines: Vec<String> = op
                .old_range()
                .clone()
                .map(|i| base.get(i).cloned().unwrap_or_default())
                .collect();
            let other_lines: Vec<String> = op
                .new_range()
                .clone()
                .map(|i| other.get(i).cloned().unwrap_or_default())
                .collect();
            ops.push((tag, base_lines, other_lines));
        }
    }

    DiffOps { ops }
}

/// diff3 三方合并。
///
/// 输入：
/// - `base`：分叉点
/// - `ours`：当前状态（要保留的修改）
/// - `theirs`：回退目标
///
/// 输出：合并后的内容和冲突列表。
pub fn diff3_merge(base: &[u8], ours: &[u8], theirs: &[u8]) -> Result<MergeResult, crate::error::AppError> {
    let base_lines = split_lines(base);
    let ours_lines = split_lines(ours);
    let theirs_lines = split_lines(theirs);

    // 计算 base → ours 和 base → theirs 的差异
    let diff_ours = compute_diff(&base_lines, &ours_lines);
    let diff_theirs = compute_diff(&base_lines, &theirs_lines);

    // 对齐两个 diff，生成 diff3 chunks
    let chunks = align_diff3_chunks(&base_lines, &diff_ours, &diff_theirs);

    // 逐 chunk 合并
    let mut result_lines = Vec::new();
    let mut conflicts = Vec::new();
    let mut hunk_index = 0;

    for chunk in &chunks {
        match chunk {
            Diff3Chunk::Stable { lines } => {
                result_lines.extend(lines.iter().cloned());
            }
            Diff3Chunk::OursOnly { lines } => {
                // 只有 ours 改了 → 保留（后续修改）
                result_lines.extend(lines.iter().cloned());
            }
            Diff3Chunk::TheirsOnly { lines } => {
                // 只有 theirs 改了 → 采用 theirs（撤销 R1 的改动）
                result_lines.extend(lines.iter().cloned());
            }
            Diff3Chunk::Conflict {
                ours_lines: o_lines,
                theirs_lines: t_lines,
                base_lines: b_lines,
                hunk_index: idx,
            } => {
                hunk_index = *idx;
                // 输出冲突标记（类似 git merge conflict）
                result_lines.push("<<<<<<< current (保留后续修改)".to_string());
                result_lines.extend(o_lines.iter().cloned());
                result_lines.push("=======".to_string());
                result_lines.extend(t_lines.iter().cloned());
                result_lines.push(format!(">>>>>>> revert (撤销目标) #{}", hunk_index));

                conflicts.push(ConflictInfo {
                    file_path: String::new(), // 由调用方填充
                    record_id: String::new(), // 由调用方填充
                    description: format!(
                        "R1 引入的改动与后续修改在第 {} 个区域冲突（base {} 行 → ours {} 行 / theirs {} 行）",
                        hunk_index,
                        b_lines.len(),
                        o_lines.len(),
                        t_lines.len()
                    ),
                });
            }
        }
    }

    Ok(MergeResult {
        content: join_lines(&result_lines),
        conflicts,
    })
}

/// 对齐两个 diff（base→ours 和 base→theirs），生成 diff3 chunk 列表。
///
/// 核心算法：以 base 为参照系，遍历两个 diff 操作流，
/// 在 base 的相同位置对齐 ours 和 theirs 的改动。
fn align_diff3_chunks(
    base: &[String],
    diff_ours: &DiffOps,
    diff_theirs: &DiffOps,
) -> Vec<Diff3Chunk> {
    let mut chunks = Vec::new();

    // 将 diff 操作转换为按 base 位置索引的改动映射
    // 每个映射条目：(base_start, base_end, replacement_lines)
    let ours_changes = diff_to_changes(diff_ours);
    let theirs_changes = diff_to_changes(diff_theirs);

    // 遍历 base 行，对齐两个改动流
    let mut base_pos = 0usize;
    let mut ours_idx = 0usize;
    let mut theirs_idx = 0usize;
    let mut hunk_counter = 0usize;

    while base_pos < base.len() || ours_idx < ours_changes.len() || theirs_idx < theirs_changes.len() {
        // 找到下一个 ours 改动的位置
        let next_ours = ours_changes.get(ours_idx);
        let next_theirs = theirs_changes.get(theirs_idx);

        // 确定下一个改动的位置
        let next_ours_start = next_ours.map(|c| c.base_start).unwrap_or(usize::MAX);
        let next_theirs_start = next_theirs.map(|c| c.base_start).unwrap_or(usize::MAX);

        // 如果两边都没有改动了，收集剩余的 stable 行
        if next_ours.is_none() && next_theirs.is_none() {
            if base_pos < base.len() {
                let stable_lines = base[base_pos..].to_vec();
                chunks.push(Diff3Chunk::Stable {
                    lines: stable_lines,
                });
            }
            break;
        }

        // 确定最近的改动位置
        let next_change_pos = next_ours_start.min(next_theirs_start);

        // 收集到下一个改动前的 stable 行
        if base_pos < next_change_pos && base_pos < base.len() {
            let end = next_change_pos.min(base.len());
            let stable_lines = base[base_pos..end].to_vec();
            if !stable_lines.is_empty() {
                chunks.push(Diff3Chunk::Stable {
                    lines: stable_lines,
                });
            }
            base_pos = end;
        }

        // 处理插入操作（base_start == base_pos，即在当前位置之前插入）
        // 先处理在 base_pos 处的插入
        let ours_insert = next_ours.filter(|c| c.base_start == base_pos && c.is_insert);
        let theirs_insert = next_theirs.filter(|c| c.base_start == base_pos && c.is_insert);

        if ours_insert.is_some() || theirs_insert.is_some() {
            let o_lines = ours_insert.map(|c| c.replacement.clone()).unwrap_or_default();
            let t_lines = theirs_insert.map(|c| c.replacement.clone()).unwrap_or_default();

            if ours_insert.is_some() && theirs_insert.is_some() {
                // 两边都插入了
                if o_lines == t_lines {
                    // 相同插入 → stable
                    chunks.push(Diff3Chunk::Stable { lines: o_lines });
                } else {
                    // 不同插入 → 冲突
                    hunk_counter += 1;
                    chunks.push(Diff3Chunk::Conflict {
                        ours_lines: o_lines,
                        theirs_lines: t_lines,
                        base_lines: Vec::new(),
                        hunk_index: hunk_counter,
                    });
                }
            } else if ours_insert.is_some() {
                chunks.push(Diff3Chunk::OursOnly { lines: o_lines });
            } else {
                chunks.push(Diff3Chunk::TheirsOnly { lines: t_lines });
            }

            if ours_insert.is_some() {
                ours_idx += 1;
            }
            if theirs_insert.is_some() {
                theirs_idx += 1;
            }
        }

        // 处理替换/删除操作
        let ours_replace = ours_changes.get(ours_idx).filter(|c| !c.is_insert && c.base_start == base_pos);
        let theirs_replace = theirs_changes.get(theirs_idx).filter(|c| !c.is_insert && c.base_start == base_pos);

        if ours_replace.is_some() || theirs_replace.is_some() {
            let o_change = ours_replace;
            let t_change = theirs_replace;

            let o_end = o_change.map(|c| c.base_end).unwrap_or(base_pos);
            let t_end = t_change.map(|c| c.base_end).unwrap_or(base_pos);

            // 计算重叠区域
            let change_end = o_end.max(t_end);
            let b_lines = base[base_pos..change_end.min(base.len())].to_vec();

            let o_lines = o_change.map(|c| c.replacement.clone()).unwrap_or_else(|| {
                // ours 没改这一段 → 用 base 内容
                b_lines.clone()
            });
            let t_lines = t_change.map(|c| c.replacement.clone()).unwrap_or_else(|| {
                // theirs 没改这一段 → 用 base 内容
                b_lines.clone()
            });

            if o_change.is_some() && t_change.is_some() {
                // 两边都改了
                if o_lines == t_lines {
                    // 相同改动 → 不是冲突
                    chunks.push(Diff3Chunk::Stable { lines: o_lines });
                } else {
                    hunk_counter += 1;
                    chunks.push(Diff3Chunk::Conflict {
                        ours_lines: o_lines,
                        theirs_lines: t_lines,
                        base_lines: b_lines,
                        hunk_index: hunk_counter,
                    });
                }
            } else if o_change.is_some() {
                // 只有 ours 改了
                chunks.push(Diff3Chunk::OursOnly { lines: o_lines });
            } else {
                // 只有 theirs 改了
                chunks.push(Diff3Chunk::TheirsOnly { lines: t_lines });
            }

            base_pos = change_end;
            if o_change.is_some() {
                ours_idx += 1;
            }
            if t_change.is_some() {
                theirs_idx += 1;
            }
        } else if base_pos < base.len() {
            // 没有改动在当前位置，前进一行
            base_pos += 1;
        } else {
            // 防止无限循环
            break;
        }
    }

    // 处理尾部插入（base 之后追加的内容）
    let tail_ours = ours_changes.get(ours_idx).filter(|c| c.is_insert);
    let tail_theirs = theirs_changes.get(theirs_idx).filter(|c| c.is_insert);
    if tail_ours.is_some() || tail_theirs.is_some() {
        let o_lines = tail_ours.map(|c| c.replacement.clone()).unwrap_or_default();
        let t_lines = tail_theirs.map(|c| c.replacement.clone()).unwrap_or_default();

        if tail_ours.is_some() && tail_theirs.is_some() {
            if o_lines == t_lines {
                chunks.push(Diff3Chunk::Stable { lines: o_lines });
            } else {
                hunk_counter += 1;
                chunks.push(Diff3Chunk::Conflict {
                    ours_lines: o_lines,
                    theirs_lines: t_lines,
                    base_lines: Vec::new(),
                    hunk_index: hunk_counter,
                });
            }
        } else if tail_ours.is_some() {
            chunks.push(Diff3Chunk::OursOnly { lines: o_lines });
        } else {
            chunks.push(Diff3Chunk::TheirsOnly { lines: t_lines });
        }
    }

    chunks
}

/// 将 diff 操作流转换为按 base 位置的改动列表。
struct Change {
    /// base 中的起始位置
    base_start: usize,
    /// base 中的结束位置（不含）
    base_end: usize,
    /// 替换后的行
    replacement: Vec<String>,
    /// 是否为纯插入（base_start == base_end）
    is_insert: bool,
}

fn diff_to_changes(diff: &DiffOps) -> Vec<Change> {
    let mut changes = Vec::new();
    let mut base_pos = 0usize;

    for (tag, base_lines, other_lines) in &diff.ops {
        match tag {
            DiffTag::Equal => {
                base_pos += base_lines.len();
            }
            DiffTag::Delete => {
                // base 有这些行，other 没有 → 删除
                changes.push(Change {
                    base_start: base_pos,
                    base_end: base_pos + base_lines.len(),
                    replacement: Vec::new(),
                    is_insert: false,
                });
                base_pos += base_lines.len();
            }
            DiffTag::Insert => {
                // other 有新行，base 没有 → 插入
                changes.push(Change {
                    base_start: base_pos,
                    base_end: base_pos,
                    replacement: other_lines.clone(),
                    is_insert: true,
                });
            }
            DiffTag::Replace => {
                // base 的行被替换为 other 的行
                changes.push(Change {
                    base_start: base_pos,
                    base_end: base_pos + base_lines.len(),
                    replacement: other_lines.clone(),
                    is_insert: false,
                });
                base_pos += base_lines.len();
            }
        }
    }

    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_diff3_no_conflict() {
        // base: line1\nline2\nline3
        // ours: line1\nMODIFIED\nline3  (改了 line2)
        // theirs: line1\nline2\nline3   (没改)
        let base = b"line1\nline2\nline3\n";
        let ours = b"line1\nMODIFIED\nline3\n";
        let theirs = b"line1\nline2\nline3\n";

        let result = diff3_merge(base, ours, theirs).unwrap();
        // theirs 没改，ours 改了 line2 → 保留 ours 的修改
        let content = String::from_utf8(result.content).unwrap();
        assert!(content.contains("MODIFIED"));
        assert!(result.conflicts.is_empty());
    }

    #[test]
    fn test_diff3_conflict() {
        // base: line1\nline2\nline3
        // ours: line1\nOURS\nline3    (改了 line2 为 OURS)
        // theirs: line1\nTHEIRS\nline3 (改了 line2 为 THEIRS)
        let base = b"line1\nline2\nline3\n";
        let ours = b"line1\nOURS\nline3\n";
        let theirs = b"line1\nTHEIRS\nline3\n";

        let result = diff3_merge(base, ours, theirs).unwrap();
        let content = String::from_utf8(result.content).unwrap();
        assert!(content.contains("<<<<<<<"));
        assert!(content.contains("OURS"));
        assert!(content.contains("======="));
        assert!(content.contains("THEIRS"));
        assert!(content.contains(">>>>>>>"));
        assert!(!result.conflicts.is_empty());
    }

    #[test]
    fn test_diff3_independent_changes() {
        // base: line1\nline2\nline3
        // ours: line1\nline2\nline3\nADDED_OURS  (在末尾添加)
        // theirs: MODIFIED_THEIRS\nline2\nline3  (改了 line1)
        // 两个改动在不同区域 → 不冲突
        let base = b"line1\nline2\nline3\n";
        let ours = b"line1\nline2\nline3\nADDED_OURS\n";
        let theirs = b"MODIFIED_THEIRS\nline2\nline3\n";

        let result = diff3_merge(base, ours, theirs).unwrap();
        let content = String::from_utf8(result.content).unwrap();
        assert!(content.contains("MODIFIED_THEIRS"));
        assert!(content.contains("ADDED_OURS"));
        assert!(result.conflicts.is_empty());
    }
}
