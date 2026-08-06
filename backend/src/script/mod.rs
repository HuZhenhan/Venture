//! 手机助手 Script DSL 模块（对应 AUTOMATION_DSL_SPEC.md）。
//!
//! - `model`：Script 定义结构（§2 Schema）
//! - `registry`：脚本注册表（JSON 文件存储，内置/用户/分享三级）
//! - `interpreter`：解释器循环（§7 骨架：op 分发、变量、插值、谓词、护栏）
//! - `validate`：静态校验（§12.4 规则）
//! - `native`：call(native) 后端原生函数（复杂计算下沉，§1 原则）
//! - `builtins`：内置脚本（§8 示例）

pub mod builtins;
pub mod engine;
pub mod interpreter;
pub mod model;
pub mod native;
pub mod registry;
pub mod validate;

pub use engine::ScriptEngine;
pub use model::{ScriptDef, ScriptSource};
pub use registry::ScriptRegistry;
