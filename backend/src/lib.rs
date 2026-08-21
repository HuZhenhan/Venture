//! venture-backend 库入口。
//!
//! 桌面端主程序（src/main.rs）与子代理进程（src/bin/subagent_proc.rs）
//! 共享同一组模块；子代理系统位于 `subagent` 模块（设计稿 §2）。

pub mod app_data;
pub mod chat;
pub mod config;
pub mod crypto;
pub mod error;
pub mod file_history;
pub mod provider;
pub mod skill;
pub mod subagent;
pub mod task_store;
pub mod tools;
