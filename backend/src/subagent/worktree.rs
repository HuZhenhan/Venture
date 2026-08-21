//! Worktree 隔离（设计稿 §12）：可选、默认关闭。
//!
//! 桌面端启用（git worktree）；Android 端强制回退共享工作区（空实现，
//! 不告警刷屏，§12 适配说明）。`isolation=worktree` 与 `cwd` 互斥校验在
//! task 工具参数层完成。

use std::path::{Path, PathBuf};

use super::types::{Isolation, SubagentRequest};

/// worktree 基础目录（默认 <主仓库>/.claude/worktrees/，§12）
fn worktree_base(cwd: &Path) -> PathBuf {
    cwd.join(".claude").join("worktrees")
}

/// 创建 worktree：`isolation: Worktree` 时在 worktree_base 下创建
/// `subagent-{task_id}`；git 不可用/失败 → 回退共享工作区（None）。
/// Android 端编译为空实现（§12 强制回退）。
pub fn maybe_create_worktree(req: &SubagentRequest) -> Option<String> {
    if req.isolation != Isolation::Worktree {
        return None;
    }
    create_worktree_impl(req)
}

#[cfg(not(target_os = "android"))]
fn create_worktree_impl(req: &SubagentRequest) -> Option<String> {
    let cwd = &req.cwd;
    // git 可用性探测
    if !cwd.join(".git").exists() {
        tracing::info!("worktree 跳过：{} 不是 git 仓库，回退共享工作区", cwd.display());
        return None;
    }
    let base = worktree_base(cwd);
    let wt_path = base.join(format!("subagent-{}", req.task_id));
    if let Err(e) = std::fs::create_dir_all(&base) {
        tracing::warn!("worktree 创建失败（回退共享工作区）：{e}");
        return None;
    }
    // git worktree add <path>（基于 HEAD；失败降级共享工作区）
    let output = std::process::Command::new("git")
        .arg("worktree")
        .arg("add")
        .arg(&wt_path)
        .arg("HEAD")
        .current_dir(cwd)
        .output();
    match output {
        Ok(out) if out.status.success() => {
            tracing::info!("worktree 已创建：{}", wt_path.display());
            Some(wt_path.to_string_lossy().into_owned())
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            tracing::warn!("git worktree add 失败（回退共享工作区）：{stderr}");
            // 清理可能产生的残留目录
            let _ = std::fs::remove_dir_all(&wt_path);
            let _ = std::process::Command::new("git")
                .arg("worktree")
                .arg("prune")
                .current_dir(cwd)
                .output();
            None
        }
        Err(e) => {
            tracing::warn!("git 不可用（回退共享工作区）：{e}");
            None
        }
    }
}

#[cfg(target_os = "android")]
fn create_worktree_impl(_req: &SubagentRequest) -> Option<String> {
    // Android：无 git、SAF 沙箱——任何 worktree 请求直接回退共享工作区，
    // 不产生 warning（预期行为而非失败，§12 生命周期策略 #6）
    None
}

/// 收尾（§12 生命周期策略 #1）：无改动 → 删除；有改动 → 保留。
/// 返回 kept=true 表示 worktree 有改动被保留；无 worktree 的任务返回 Ok(false)。
pub fn finalize_worktree(task_id: &str) -> Result<bool, String> {
    finalize_impl(task_id)
}

#[cfg(not(target_os = "android"))]
fn finalize_impl(task_id: &str) -> Result<bool, String> {
    let data_dir = match crate::subagent::current_data_dir() {
        Some(d) => d,
        None => return Ok(false),
    };
    let meta = match super::persist::load_meta(&data_dir, task_id) {
        Some(m) => m,
        None => return Ok(false),
    };
    let Some(wt_path) = meta.worktree_path else {
        return Ok(false);
    };
    let wt = PathBuf::from(&wt_path);
    if !wt.exists() {
        return Ok(false);
    }

    // 改动检测：git status --porcelain（§12）
    let output = std::process::Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(&wt)
        .output()
        .map_err(|e| format!("git status 执行失败：{e}"))?;
    let status = String::from_utf8_lossy(&output.stdout);
    // 默认布局 <repo>/.claude/worktrees/subagent-* → repo = 上溯三级
    let repo_root = wt
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| wt.clone());

    if status.trim().is_empty() {
        // 无改动 → 直接删除（连带 git worktree prune）
        let _ = std::process::Command::new("git")
            .arg("worktree")
            .arg("remove")
            .arg("--force")
            .arg(&wt)
            .current_dir(&repo_root)
            .output();
        let _ = std::fs::remove_dir_all(&wt);
        let _ = std::process::Command::new("git")
            .arg("worktree")
            .arg("prune")
            .current_dir(&repo_root)
            .output();
        tracing::info!("worktree 无改动，已回收：{wt_path}");
        Ok(false)
    } else {
        // 有改动 → 保留（路径已在 output.worktree_path 中带出，提示主模型检查/提交）
        tracing::info!("worktree 有改动，保留：{wt_path}");
        Ok(true)
    }
}

#[cfg(target_os = "android")]
fn finalize_impl(_task_id: &str) -> Result<bool, String> {
    Ok(false)
}

/// 过期回收（§12 策略 #2）：扫描 worktree_base 下 subagent-* 目录，
/// mtime 超过 max_age_days → 删除 + git worktree prune。
/// 主进程启动 + 每天定时调用（mod.rs 负责调度）。
pub fn reclaim_stale_worktrees(workspace_root: Option<&Path>, max_age_days: u64) {
    #[cfg(target_os = "android")]
    {
        let _ = (workspace_root, max_age_days);
    }
    #[cfg(not(target_os = "android"))]
    {
        let Some(root) = workspace_root else { return };
        let base = worktree_base(root);
        let Ok(entries) = std::fs::read_dir(&base) else {
            return;
        };
        let cutoff = std::time::SystemTime::now()
            - std::time::Duration::from_secs(max_age_days * 24 * 3600);
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !name.starts_with("subagent-") || !path.is_dir() {
                continue;
            }
            // 目录内最新文件修改时间
            let newest = newest_mtime(&path);
            if newest < cutoff {
                tracing::info!("回收过期 worktree：{}", path.display());
                let _ = std::process::Command::new("git")
                    .arg("worktree")
                    .arg("remove")
                    .arg("--force")
                    .arg(&path)
                    .current_dir(root)
                    .output();
                let _ = std::fs::remove_dir_all(&path);
            }
        }
        let _ = std::process::Command::new("git")
            .arg("worktree")
            .arg("prune")
            .current_dir(root)
            .output();
    }
}

#[cfg(not(target_os = "android"))]
fn newest_mtime(dir: &Path) -> std::time::SystemTime {
    let mut newest = std::time::SystemTime::UNIX_EPOCH;
    if let Ok(meta) = std::fs::metadata(dir) {
        if let Ok(t) = meta.modified() {
            newest = t;
        }
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(t) = entry.metadata().and_then(|m| m.modified()) {
                if t > newest {
                    newest = t;
                }
            }
        }
    }
    newest
}
