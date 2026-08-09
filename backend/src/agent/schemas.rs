//! 工具 schema 权威注册表（规格书第 6 章 Tool Call 全集 + 6.5 脚本类 + §12.2 用户脚本工具）。
//!
//! Rust 侧维护权威 schema（serde_json::Value），供 schema 同步与入参校验。
//! 格式：OpenAI 兼容 function schema（{ "type": "function", "function": {...} }）。

use serde_json::{json, Value};

use crate::provider::{FunctionDefinition, ToolDefinition};

/// 需要转发到原生桥（Kotlin）的工具名集合
pub const NATIVE_TOOLS: &[&str] = &[
    "screenshot",
    "get_layout",
    "get_node",
    "find_node",
    "get_foreground_app",
    "get_screen_info",
    "read_clipboard",
    "get_windows",
    "click",
    "long_click",
    "press",
    "swipe",
    "gesture",
    "node_action",
    "input_text",
    "paste",
    "key_event",
    "global_action",
    "set_clipboard",
    "launch_app",
    "open_url",
    "scroll",
    "wait_for_node",
    "wait_for_text",
    "wait_for_app",
    "sleep",
    "stop_app",
];

/// 脚本类工具（由 script 模块处理）
pub const SCRIPT_TOOLS: &[&str] = &["run_script", "list_scripts", "create_script", "validate_script"];

/// 全部 agent 工具的 OpenAI function schema 列表
pub fn all_tool_schemas() -> Vec<Value> {
    let mut tools = Vec::new();
    let mut push = |name: &str, description: &str, parameters: Value| {
        tools.push(json!({
            "type": "function",
            "function": { "name": name, "description": description, "parameters": parameters }
        }));
    };
    let empty_obj = || json!({ "type": "object", "properties": {}, "required": [] });

    // ── 感知类（6.1） ──────────────────────────────────────────────
    push("screenshot", "截取当前屏幕。用于多模态视觉分析。返回图片路径（PNG）", empty_obj());
    push("get_layout", "获取当前屏幕布局。mode=brief（默认）为行式 DSL 文本（text 字段，含 id/role/desc/坐标/fid/state/scroll 方向，省 token），附 rev 版本号（页面是否变化对比 rev）；full 为完整 JSON 树（可能很大）；subagent 为子代理提取模式（仅保留接口）。动作类工具（click/node_action/scroll/paste 等）可携带 rev 校验页面未变", json!({
        "type": "object",
        "properties": { "mode": { "type": "string", "enum": ["brief", "full", "subagent"], "default": "brief" } },
        "required": []
    }));
    push("get_node", "获取单个节点的完整属性（含所有布尔状态与 actions 列表）", json!({
        "type": "object",
        "properties": { "node_id": { "type": "integer", "description": "get_layout 返回的节点编号" } },
        "required": ["node_id"]
    }));
    push("find_node", "按条件查找节点，返回匹配列表（含 node_id/坐标/文本）", json!({
        "type": "object",
        "properties": {
            "text": { "type": "string" }, "desc": { "type": "string" },
            "id": { "type": "string" }, "className": { "type": "string" },
            "limit": { "type": "integer", "default": 10 }
        },
        "required": []
    }));
    push("get_foreground_app", "获取当前前台应用（包名与应用名）", empty_obj());
    push("get_screen_info", "获取屏幕信息（宽高/dpi/density）", empty_obj());
    push("read_clipboard", "读取剪贴板文本（读取后不清理）", empty_obj());
    push("get_windows", "获取当前窗口列表（类型/标题/层级）", empty_obj());

    // ── 操作类（6.2） ──────────────────────────────────────────────
    let click_params = || json!({
        "type": "object",
        "properties": {
            "node_id": { "type": "integer", "description": "get_layout 返回的节点编号（优先）" },
            "x": { "type": "integer" }, "y": { "type": "integer" },
            "rev": { "type": "string", "description": "可选：最近一次 get_layout 返回的 rev；不匹配则拒绝执行并提示重新观察" }
        },
        "required": []
    });
    push("click", "点击。优先 node_id（布局树编号）；或坐标 x,y", click_params());
    push("long_click", "长按。参数同 click（500ms）", click_params());
    push("press", "自定义按压", json!({
        "type": "object",
        "properties": { "x": { "type": "integer" }, "y": { "type": "integer" }, "duration_ms": { "type": "integer" } },
        "required": ["x", "y"]
    }));
    push("swipe", "滑动", json!({
        "type": "object",
        "properties": {
            "x1": { "type": "integer" }, "y1": { "type": "integer" },
            "x2": { "type": "integer" }, "y2": { "type": "integer" },
            "duration_ms": { "type": "integer" }
        },
        "required": ["x1", "y1", "x2", "y2"]
    }));
    push("gesture", "任意折线手势", json!({
        "type": "object",
        "properties": {
            "points": { "type": "array", "items": { "type": "array", "items": { "type": "integer" } } },
            "duration_ms": { "type": "integer" }, "start_ms": { "type": "integer" }
        },
        "required": ["points", "duration_ms"]
    }));
    push("node_action", "对节点执行无障碍动作。文本输入请优先用 input_text/paste", json!({
        "type": "object",
        "properties": {
            "node_id": { "type": "integer" },
            "action": { "type": "string", "enum": ["click","longClick","scrollForward","scrollBackward",
                "scrollUp","scrollDown","scrollLeft","scrollRight","setText","setSelection","copy","cut",
                "paste","focus","clearFocus","select","clearSelection","expand","collapse","dismiss",
                "show","setProgress","moveWindow","imeEnter","pressAndHold","contextClick"] },
            "text": { "type": "string", "description": "setText 时必填" },
            "args": { "type": "object", "description": "其他动作参数" },
            "rev": { "type": "string", "description": "可选：最近一次 get_layout 返回的 rev；不匹配则拒绝执行" }
        },
        "required": ["node_id", "action"]
    }));
    push("input_text", "向当前聚焦的输入框输入文本（自动决策 setText→paste→长按菜单）", json!({
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"]
    }));
    push("paste", "向指定节点粘贴剪贴板内容（传 text 时先写剪贴板再粘贴）。微信/QQ 输入首选", json!({
        "type": "object",
        "properties": {
            "node_id": { "type": "integer" }, "text": { "type": "string" },
            "rev": { "type": "string", "description": "可选：最近一次 get_layout 返回的 rev；不匹配则拒绝执行" }
        },
        "required": []
    }));
    push("key_event", "按键注入", json!({
        "type": "object",
        "properties": { "key": { "type": "string", "enum": ["back","home","enter","del","tab","volumeUp","volumeDown","recent","menu"] } },
        "required": ["key"]
    }));
    push("global_action", "系统全局动作", json!({
        "type": "object",
        "properties": { "action": { "type": "string", "enum": ["back","home","recents","notifications","quickSettings","powerDialog","splitScreen","lockScreen"] } },
        "required": ["action"]
    }));
    push("set_clipboard", "写剪贴板", json!({
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"]
    }));
    push("launch_app", "启动应用（自动识别双模式：入参含 . 视为包名，否则按应用名模糊匹配；不依赖映射表）", json!({
        "type": "object",
        "properties": { "app": { "type": "string" } },
        "required": ["app"]
    }));
    push("open_url", "打开链接或深链（tbopen://、openapp.jdmobile://、weixin:// 等直达）", json!({
        "type": "object",
        "properties": { "url": { "type": "string" } },
        "required": ["url"]
    }));
    push("scroll", "滚动。node_id 指定可滚动容器，否则在屏幕内滑动", json!({
        "type": "object",
        "properties": {
            "direction": { "type": "string", "enum": ["up","down","left","right"] },
            "node_id": { "type": "integer" },
            "times": { "type": "integer", "default": 1 },
            "rev": { "type": "string", "description": "可选：最近一次 get_layout 返回的 rev；不匹配则拒绝执行" }
        },
        "required": ["direction"]
    }));

    // ── 控制类（6.3） ──────────────────────────────────────────────
    push("wait_for_node", "轮询布局直到节点出现（500ms 间隔）", json!({
        "type": "object",
        "properties": {
            "selector": { "type": "object", "description": "选择器 {text?,desc?,id?,className?...}" },
            "timeout_ms": { "type": "integer", "default": 10000 }
        },
        "required": ["selector"]
    }));
    push("wait_for_text", "轮询直到指定文本出现（页面加载完成的信号）", json!({
        "type": "object",
        "properties": {
            "text": { "type": "string" },
            "timeout_ms": { "type": "integer", "default": 10000 }
        },
        "required": ["text"]
    }));
    push("stop_app", "停止指定应用（结束其进程）。用于 Run_script 执行前清理干扰软件（弹窗/抢占前台的第三方应用）。参数 package_name 为应用包名（如 com.tencent.mm）。仅支持 root 路径（am force-stop）；设备未 root 时返回 root_required 错误，此时需提示用户手动关闭目标应用后再继续", json!({
        "type": "object",
        "properties": { "package_name": { "type": "string", "description": "要停止的应用包名" } },
        "required": ["package_name"]
    }));
    push("wait_for_app", "等待前台切换到指定应用（支持包名或应用名）", json!({
        "type": "object",
        "properties": {
            "package_name": { "type": "string" }, "app_name": { "type": "string" },
            "timeout_ms": { "type": "integer", "default": 8000 }
        },
        "required": []
    }));
    push("sleep", "固定等待", json!({
        "type": "object",
        "properties": { "ms": { "type": "integer" } },
        "required": ["ms"]
    }));

    // ── 确认类（6.4） ──────────────────────────────────────────────
    push("report_progress", "向前端报告执行进度（悬浮提示展示，不中断循环）", json!({
        "type": "object",
        "properties": { "message": { "type": "string" } },
        "required": ["message"]
    }));

    // ── 脚本类（6.5 / §12.2） ──────────────────────────────────────
    push("run_script", "运行预设自动化脚本（DSL）。AI 只传参收结构化结果，不参与中间屏幕操作", json!({
        "type": "object",
        "properties": {
            "script_name": { "type": "string" },
            "params": { "type": "object" },
            "confirmed": { "type": "boolean", "description": "高危脚本用户确认后置 true" }
        },
        "required": ["script_name"]
    }));
    push("list_scripts", "列出全部可用脚本（含参数说明与来源标记）", empty_obj());
    push("create_script", "创建新的自动化脚本（LLM 生成 DSL JSON，自动静态校验，失败返回具体错误定位）", json!({
        "type": "object",
        "properties": {
            "name": { "type": "string" },
            "description": { "type": "string" },
            "params": { "type": "array" },
            "steps": { "type": "array" },
            "risky": { "type": "boolean" },
            "timeout_sec": { "type": "integer" },
            "result_schema": { "type": "object" }
        },
        "required": ["name", "steps"]
    }));
    push("validate_script", "静态校验脚本（不注册），返回校验报告", json!({
        "type": "object",
        "properties": { "script": { "type": "object" } },
        "required": ["script"]
    }));

    tools
}

/// 单个工具的 schema（入参校验用）
pub fn tool_schema(name: &str) -> Option<Value> {
    all_tool_schemas()
        .into_iter()
        .find(|t| t["function"]["name"].as_str() == Some(name))
}

/// 以 ToolDefinition 形式返回（chat.rs 注入模型 tools 字段用）
pub fn all_tool_definitions() -> Vec<ToolDefinition> {
    all_tool_schemas()
        .into_iter()
        .filter_map(|v| {
            let f = &v["function"];
            Some(ToolDefinition {
                tool_type: "function".to_string(),
                function: FunctionDefinition {
                    name: f["name"].as_str()?.to_string(),
                    description: f["description"].as_str().unwrap_or_default().to_string(),
                    strict: None,
                    parameters: f["parameters"].clone(),
                },
            })
        })
        .collect()
}

/// 轻量入参校验：仅检查 required 字段存在（类型纠偏交给 LLM 自我纠正）
pub fn validate_args(name: &str, args: &Value) -> Result<(), String> {
    let Some(schema) = tool_schema(name) else {
        return Err(format!("未知工具: {name}"));
    };
    let required = schema["function"]["parameters"]["required"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for field in required {
        let key = field.as_str().unwrap_or_default();
        if args.get(key).is_none() || args.get(key) == Some(&Value::Null) {
            return Err(format!("缺少必需参数: {key}"));
        }
    }
    Ok(())
}
