//! Skill 系统（规格书：Best of cc-haha × opencode × grok-build）。
//!
//! 模块依赖（§3.2 实现顺序）：
//! 1. loader（无依赖）— SKILL.md 解析校验（§4）
//! 2. discovery（依赖 loader）— 扫描根 / mtime 索引 / 去重仲裁（§6）
//! 3. permission（无依赖）— L1 规则编译与匹配（§9）
//! 4. announce（依赖 discovery 数据）— 可选公告（§7.1）
//! 5. service（门面）— SkillService（§3.1）
//!
//! 集成层：tools.rs 注册 list_skill/load_skill（§8）；main.rs 注册
//! /api/skills/* 路由（含 §10.1 引用内容端点）；chat.rs 注入公告（§7.1）。

pub mod announce;
pub mod discovery;
pub mod loader;
pub mod permission;
pub mod service;
pub mod settings;
pub mod types;

pub use discovery::Platform;
pub use service::SkillService;
#[allow(unused_imports)]
pub use types::{Scope, Skill, SkillInfo, SkillLoadError};
