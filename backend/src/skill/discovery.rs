//! SkillDiscovery：扫描根计算、增量扫描、mtime 索引、去重仲裁（规格书 §6）。
//!
//! 索引与元数据合并存储在同一个 skill-index.json（§12.2 允许合并，
//! 同一 backend 进程内原子读写）。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use super::loader::parse_skill_file;
use super::settings::SkillSettings;
use super::types::{Scope, SkillInfo, SkillLoadError};

/// 扫描递归深度上限（§4.1）
const MAX_WALK_DEPTH: usize = 5;

/// 运行平台（双端差异集中在这里）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// Windows 桌面端：项目层 + 全局层 + compat 目录
    Desktop,
    /// Android：仅全局层（无项目级），zip 导入并入全局层
    Android,
}

impl Platform {
    pub fn has_project_scope(&self) -> bool {
        matches!(self, Platform::Desktop)
    }
    pub fn has_compat_dirs(&self) -> bool {
        matches!(self, Platform::Desktop)
    }
}

/// 一个扫描根。
#[derive(Debug, Clone)]
pub struct ScanRoot {
    pub path: PathBuf,
    pub scope: Scope,
    /// 内置 assets（并入全局层，只读）
    pub bundled: bool,
    /// 外部工具兼容目录（.claude/.agents/.opencode/.grok 的 skills）：
    /// 目录名与 SKILL.md name 允许不一致，以 name 为准（§4.4 放宽校验）
    pub compat: bool,
}

/// mtime 索引条目（§6.3）。info 为解析缓存（skills-meta 合并存储，§12.2）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub mtime: u64,
    pub size: u64,
    pub canonical_name: String,
    /// 解析缓存：mtime+size 未变时直接复用，避免重复解析
    pub info: SkillInfo,
    /// 解析失败标记：保留旧条目防止编辑器非原子写入导致误删（§6.6）
    #[serde(default)]
    pub parse_error: bool,
}

/// 索引文件（skill-index.json；与 §12.2 skills-meta.json 合并存储）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIndexFile {
    #[serde(default = "default_schema")]
    pub schema: u32,
    #[serde(default)]
    pub entries: HashMap<String, IndexEntry>,
    #[serde(default)]
    pub roots_hash: String,
    /// 用户禁用的 canonicalName 集合（enabled 开关持久化）
    #[serde(default)]
    pub disabled: HashSet<String>,
}

fn default_schema() -> u32 {
    1
}

pub fn index_path(skillx_dir: &Path) -> PathBuf {
    skillx_dir.join("skill-index.json")
}

pub fn load_index(skillx_dir: &Path) -> SkillIndexFile {
    let path = index_path(skillx_dir);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_index(skillx_dir: &Path, index: &SkillIndexFile) -> std::io::Result<()> {
    std::fs::create_dir_all(skillx_dir)?;
    let tmp = index_path(skillx_dir).with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(index).unwrap_or_default())?;
    std::fs::rename(&tmp, index_path(skillx_dir))?;
    Ok(())
}

fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((mtime, meta.len()))
}

/// roots 列表哈希：变化 → 全量重扫（§6.3）。
pub fn roots_hash(roots: &[ScanRoot]) -> String {
    let joined = roots
        .iter()
        .map(|r| format!("{}:{}", r.scope as u8, r.path.to_string_lossy()))
        .collect::<Vec<_>>()
        .join("|");
    blake3::hash(joined.as_bytes()).to_hex().to_string()
}

/// 计算扫描根（§6.1）。顺序即优先级（先收集的层优先级更高）。
pub fn compute_roots(
    platform: Platform,
    skillx_dir: &Path,
    workspace: Option<&Path>,
    settings: &SkillSettings,
) -> Vec<ScanRoot> {
    let mut roots: Vec<ScanRoot> = Vec::new();

    // ── 项目层（scope=0，仅桌面端）：cwd → git root 逐层 ──
    if platform.has_project_scope() {
        let start = workspace
            .map(|p| p.to_path_buf())
            .or_else(|| std::env::current_dir().ok());
        if let Some(start) = start {
            for dir in chain_to_git_root(&start) {
                push_root(&mut roots, dir.join(".skillx/skills"), Scope::Project, false, false);
                if platform.has_compat_dirs() {
                    let c = &settings.compat;
                    if c.claude {
                        push_root(&mut roots, dir.join(".claude/skills"), Scope::Project, false, true);
                    }
                    if c.agents {
                        push_root(&mut roots, dir.join(".agents/skills"), Scope::Project, false, true);
                    }
                    if c.opencode {
                        push_root(&mut roots, dir.join(".opencode/skills"), Scope::Project, false, true);
                    }
                    if c.grok {
                        push_root(&mut roots, dir.join(".grok/skills"), Scope::Project, false, true);
                    }
                }
            }
        }
    }

    // ── 全局层（scope=1）──
    if !settings.roots.disable_default_user {
        push_root(&mut roots, skillx_dir.join("skills"), Scope::Global, false, false);
    }
    // 用户主目录下的外部工具兼容目录（全局层，始终扫描，不依赖 workspace/cwd）。
    // Android 无用户主目录概念（home_dir 为 None）自动跳过，保持自有格式兼容不变。
    #[allow(deprecated)]
    if let Some(home) = std::env::home_dir() {
        let c = &settings.compat;
        if c.claude {
            push_root(&mut roots, home.join(".claude/skills"), Scope::Global, false, true);
        }
        if c.agents {
            push_root(&mut roots, home.join(".agents/skills"), Scope::Global, false, true);
        }
        if c.opencode {
            push_root(&mut roots, home.join(".opencode/skills"), Scope::Global, false, true);
        }
        if c.grok {
            push_root(&mut roots, home.join(".grok/skills"), Scope::Global, false, true);
        }
    }
    if platform.has_project_scope() {
        // managed 策略目录（仅 Win，§5）
        if let Some(managed) = &settings.roots.managed {
            push_root(&mut roots, PathBuf::from(managed), Scope::Global, false, false);
        }
    }
    for extra in &settings.roots.extra {
        push_root(&mut roots, PathBuf::from(extra), Scope::Global, false, false);
    }

    // 插件层（scope=2）：保留接口，当前无数据源（§10.3）
    // mcp 层（scope=3）：保留接口，未启用（§10.4）

    roots
}

/// cwd 向上至 git root 的目录链（含两端；无 .git 时仅返回起点）。
fn chain_to_git_root(start: &Path) -> Vec<PathBuf> {
    let mut chain = vec![start.to_path_buf()];
    let mut cur = start;
    while let Some(parent) = cur.parent() {
        if cur.join(".git").exists() {
            break;
        }
        chain.push(parent.to_path_buf());
        cur = parent;
    }
    chain
}

fn push_root(roots: &mut Vec<ScanRoot>, path: PathBuf, scope: Scope, bundled: bool, compat: bool) {
    if path.is_dir() && !roots.iter().any(|r| r.path == path) {
        roots.push(ScanRoot { path, scope, bundled, compat });
    }
}

/// 扫描结果。
#[derive(Debug, Default)]
pub struct ScanOutcome {
    /// canonicalName → SkillInfo（去重仲裁后）
    pub skills: HashMap<String, SkillInfo>,
    /// 被跨层遮蔽的 skill（UI 显示“被 xx 遮蔽”角标）
    pub shadowed: Vec<SkillInfo>,
    /// 最近一次扫描的解析错误（§4.4 / §2 错误卡片数据源）
    pub errors: Vec<SkillLoadError>,
    /// 变更的 canonicalName 列表
    pub changed: Vec<String>,
}

/// 全量增量扫描（§6.2/§6.3/§6.6 时机 A/B）：
/// 遍历全部扫描根，mtime+size 无变化的条目直接复用索引缓存，仅重解析变更/新增项。
pub fn scan(
    platform: Platform,
    skillx_dir: &Path,
    workspace: Option<&Path>,
    settings: &SkillSettings,
    index: &mut SkillIndexFile,
) -> ScanOutcome {
    let roots = compute_roots(platform, skillx_dir, workspace, settings);
    let new_hash = roots_hash(&roots);
    let roots_changed = new_hash != index.roots_hash;

    let mut parsed: Vec<SkillInfo> = Vec::new();
    let mut errors: Vec<SkillLoadError> = Vec::new();
    let mut changed: Vec<String> = Vec::new();
    let mut new_entries: HashMap<String, IndexEntry> = HashMap::new();
    let mut seen_locations: HashSet<String> = HashSet::new();

    for root in &roots {
        for entry in WalkDir::new(&root.path)
            .max_depth(MAX_WALK_DEPTH)
            .into_iter()
            .filter_entry(|e| e.file_name() != ".git")
            .filter_map(|e| e.ok())
        {
            if entry.file_name() != "SKILL.md" || !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let loc = path.to_string_lossy().replace('\\', "/");
            seen_locations.insert(loc.clone());

            let Some((mtime, size)) = file_stamp(path) else {
                continue;
            };

            // 增量：mtime+size 相同且 roots 未变 → 复用缓存
            if !roots_changed {
                if let Some(old) = index.entries.get(&loc) {
                    if old.mtime == mtime && old.size == size && !old.parse_error {
                        let mut info = old.info.clone();
                        info.scope = root.scope;
                        info.bundled = root.bundled;
                        parsed.push(info.clone());
                        new_entries.insert(
                            loc,
                            IndexEntry {
                                mtime,
                                size,
                                canonical_name: old.canonical_name.clone(),
                                info,
                                parse_error: false,
                            },
                        );
                        continue;
                    }
                }
            }

            match parse_skill_file(path, root.scope, root.bundled, root.compat) {
                Ok((info, _body)) => {
                                    changed.push(info.name.clone());
                    new_entries.insert(
                        loc,
                        IndexEntry {
                            mtime,
                            size,
                            canonical_name: info.canonical_name.clone(),
                            info: info.clone(),
                            parse_error: false,
                        },
                    );
                    parsed.push(info);
                }
                Err(e) => {
                    // 兼容黑名单优先级 > 作用域（§6.5）在 parse 成功后判断，
                    // 解析失败直接记录错误
                    errors.push(e.clone());
                    // 保留旧索引条目并标记 parse_error（§6.6）；
                    // 占位条目（空 name）不参与列表，仅用于索引占位
                    if let Some(old) = index.entries.get(&e.location) {
                        let mut kept = old.clone();
                        kept.parse_error = true;
                        if !kept.info.name.is_empty() {
                            parsed.push(kept.info.clone());
                        }
                        new_entries.insert(e.location.clone(), kept);
                    } else {
                        new_entries.insert(
                            e.location.clone(),
                            IndexEntry {
                                mtime,
                                size,
                                canonical_name: String::new(),
                                info: placeholder_info(&e.location, root.scope),
                                parse_error: true,
                            },
                        );
                    }
                }
            }
        }
    }

    // 兼容黑名单（§6.5）：skill.compatibility 命中 compat.skip → 跳过
    let skip = &settings.compat.skip;
    if !skip.is_empty() {
        parsed.retain(|info| {
            let compat_hit = info
                .frontmatter
                .get("compatibility")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .any(|c| skip.iter().any(|s| s == c))
                })
                .unwrap_or(false);
            !compat_hit
        });
    }

    let (skills, shadowed) = dedupe(parsed);

    index.entries = new_entries;
    index.roots_hash = new_hash;
    // 清理 disabled 中已不存在的名字
    index.disabled.retain(|n| skills.contains_key(n));

    ScanOutcome {
        skills,
        shadowed,
        errors,
        changed,
    }
}

fn placeholder_info(location: &str, scope: Scope) -> SkillInfo {
    SkillInfo {
        canonical_name: String::new(),
        name: String::new(),
        description: String::new(),
        when_to_use: String::new(),
        version: "0.0.1".into(),
        scope,
        location: location.into(),
        active: false,
        enabled: false,
        auto_invocable: false,
        user_invocable: false,
        paths: None,
        frontmatter: Default::default(),
        shadowed_by: None,
        bundled: false,
    }
}

/// 去重仲裁（§6.4 完整算法）：
/// - realpath 去 symlink（同一文件被多根发现 → 跳过）
/// - 同 scope 冲突 → canonicalName 递增后缀重命名
/// - 跨层遮蔽 → scope 数值小者胜出，败者进 shadowed 列表
fn dedupe(mut sorted: Vec<SkillInfo>) -> (HashMap<String, SkillInfo>, Vec<SkillInfo>) {
    sorted.sort_by_key(|s| s.scope);
    let mut by_identity: HashSet<String> = HashSet::new();
    let mut by_name: HashMap<String, SkillInfo> = HashMap::new();
    let mut shadowed: Vec<SkillInfo> = Vec::new();

    for mut s in sorted {
        let id = std::fs::canonicalize(&s.location)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| s.location.clone());
        if !by_identity.insert(id) {
            continue;
        }
        match by_name.get(&s.name) {
            None => {
                s.canonical_name = s.name.clone();
                by_name.insert(s.name.clone(), s);
            }
            Some(exist) if exist.scope == s.scope => {
                // 同 scope 冲突：递增后缀
                let mut n = 2;
                let mut new_name = format!("{}-{}", s.name, n);
                while by_name.contains_key(&new_name) {
                    n += 1;
                    new_name = format!("{}-{}", s.name, n);
                }
                tracing::warn!("skill rename: {} → {} ({})", s.name, new_name, s.location);
                s.canonical_name = new_name.clone();
                by_name.insert(new_name, s);
            }
            Some(exist) => {
                // 跨层遮蔽：scope 数值小者胜出
                tracing::warn!(
                    "skill shadowed: {} by scope {:?} < {:?}",
                    s.name,
                    exist.scope,
                    s.scope
                );
                s.shadowed_by = Some(exist.scope.label().to_string());
                shadowed.push(s);
            }
        }
    }

    (by_name, shadowed)
}
