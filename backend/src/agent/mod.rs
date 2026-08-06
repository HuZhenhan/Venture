//! 手机助手 Agent 模块（对应 MOBILE_ASSISTANT_SPEC.md 第 6/8 章）。
//!
//! - `schemas`：工具 schema 权威注册表（OpenAI 兼容 function schema）
//! - `native_bridge`：Rust → Kotlin 本地工具桥（127.0.0.1:46307）HTTP 客户端
//! - `router`：tool_router（入参校验 → 分发 → 结构化结果 + 执行轨迹）
//! - `trace`：执行轨迹记录（{tool, args, result, ts, duration_ms}）

pub mod native_bridge;
pub mod router;
pub mod schemas;
pub mod trace;

pub use native_bridge::NativeBridge;
pub use router::AgentRouter;
pub use trace::TraceStore;
