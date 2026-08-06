//! 内置脚本（DSL 规格书 §8 示例，只读，可复制为模板）。

use super::model::{ScriptDef, ScriptSource};

/// 比价脚本（§8.1 核心演示）
const COMPARE_PRICE: &str = r##"{
  "name": "compare_price",
  "description": "在指定电商平台搜索商品，提取各家店铺的价格/标题/店铺",
  "version": 1,
  "required_permissions": ["accessibility"],
  "risky": false,
  "timeout_sec": 180,
  "params": [
    { "name": "keyword", "type": "string", "required": true, "description": "商品名称" },
    { "name": "platform", "type": "enum", "values": ["淘宝", "京东", "拼多多"], "default": "淘宝" },
    { "name": "max_items", "type": "integer", "default": 5 }
  ],
  "result_schema": {
    "type": "object",
    "properties": {
      "items": { "type": "array", "items": { "type": "object" } },
      "page_checked": { "type": "integer" }
    }
  },
  "steps": [
    { "op": "set", "var": "items", "value": [] },

    { "op": "launch_app", "args": { "app_name": "{{params.platform}}" } },
    { "op": "wait_for_app", "args": { "pkg": "{{params.platform}}", "timeout_ms": 8000 } },
    { "op": "wait_for_node", "args": { "selector": { "desc": "搜索" }, "timeout_ms": 8000 },
      "on_fail": { "strategy": "skip" } },

    { "op": "if", "condition": { "node_exists": { "text": "登录" } },
      "then": [ { "op": "emit", "key": "warning", "value": "需要用户登录" },
                { "op": "return" } ] },

    { "op": "click", "args": { "selector": { "desc": "搜索" } } },
    { "op": "input_text", "args": { "text": "{{params.keyword}}" } },
    { "op": "key_event", "args": { "key": "enter" } },
    { "op": "wait_for_text", "args": { "text": "{{params.keyword}}", "timeout_ms": 10000 } },

    { "op": "repeat_until",
      "condition": { "node_exists": { "text": "没有更多" } },
      "max_attempts": 3,
      "steps": [
        { "op": "read_nodes",
          "args": { "selector": { "clickable": true }, "fields": ["text", "bounds"],
                    "limit": "{{params.max_items}}" },
          "save_to": "list" },
        { "op": "for_each", "var": "item", "items": "{{list}}", "steps": [
            { "op": "extract", "args": { "selector": { "scope": "{{item}}", "className": "价格" },
                                         "field": "text", "regex": "¥?([\\d.]+)", "save_to": "price" },
              "on_fail": { "strategy": "skip" } },
            { "op": "extract", "args": { "selector": { "scope": "{{item}}", "className": "标题" },
                                         "field": "text", "save_to": "title" },
              "on_fail": { "strategy": "skip" } },
            { "op": "extract", "args": { "selector": { "scope": "{{item}}", "className": "店铺" },
                                         "field": "text", "save_to": "shop" },
              "on_fail": { "strategy": "skip" } },
            { "op": "emit", "key": "item",
              "value": { "price": "{{price}}", "title": "{{title}}", "shop": "{{shop}}" } }
        ] },
        { "op": "swipe", "args": { "x1": 540, "y1": 1600, "x2": 540, "y2": 400, "duration_ms": 300 } }
      ] },

    { "op": "set", "var": "page_checked", "value": "{{loop.attempts}}" },
    { "op": "emit", "key": "page_checked", "value": "{{page_checked}}" },
    { "op": "return" }
  ]
}"##;

/// 下单脚本（§8.2 高危示例：risky，止步提交订单，支付永远不自动）
const PLACE_ORDER: &str = r##"{
  "name": "place_order",
  "description": "打开商品链接，选择规格并提交订单（高危：止步于提交订单，支付由用户完成）",
  "version": 1,
  "required_permissions": ["accessibility"],
  "risky": true,
  "timeout_sec": 180,
  "params": [
    { "name": "item_url", "type": "string", "required": true, "description": "商品链接或深链" },
    { "name": "model", "type": "string", "description": "规格，如 256G 蓝色" }
  ],
  "result_schema": {
    "type": "object",
    "properties": { "order_status": { "type": "string" } }
  },
  "steps": [
    { "op": "open_url", "args": { "url": "{{params.item_url}}" } },
    { "op": "wait_for_node", "args": { "selector": { "text": "加入购物车" }, "timeout_ms": 15000 } },
    { "op": "if", "condition": { "not": { "is_empty": "{{params.model}}" } },
      "then": [
        { "op": "click", "args": { "selector": { "text": "选择规格" } },
          "on_fail": { "strategy": "skip" } },
        { "op": "wait_for_node", "args": { "selector": { "text": "{{params.model}}" }, "timeout_ms": 8000 } },
        { "op": "click", "args": { "selector": { "text": "{{params.model}}" } } },
        { "op": "click", "args": { "selector": { "text": "确认" } } }
      ] },
    { "op": "click", "args": { "selector": { "text": "立即购买" } } },
    { "op": "wait_for_text", "args": { "text": "提交订单", "timeout_ms": 10000 } },
    { "op": "click", "args": { "selector": { "text": "提交订单" } } },
    { "op": "emit", "key": "order_status", "value": "提交成功，等待用户支付" }
  ]
}"##;

/// 天气查询（轻量演示脚本）
const WEATHER_QUERY: &str = r##"{
  "name": "weather_query",
  "description": "通过浏览器搜索查询指定城市天气，返回搜索结果摘要",
  "version": 1,
  "required_permissions": ["accessibility"],
  "risky": false,
  "timeout_sec": 60,
  "params": [
    { "name": "city", "type": "string", "required": true, "description": "城市名称" }
  ],
  "result_schema": {
    "type": "object",
    "properties": { "summary": { "type": "string" } }
  },
  "steps": [
    { "op": "open_url", "args": { "url": "https://www.baidu.com/s?wd={{params.city}}天气" } },
    { "op": "wait", "args": { "ms": 3000 } },
    { "op": "get_layout", "args": { "mode": "brief" }, "save_to": "layout" },
    { "op": "emit", "key": "summary", "value": "已打开{{params.city}}天气搜索页，布局见 layout 变量" },
    { "op": "return" }
  ]
}"##;

pub fn builtin_scripts() -> Vec<ScriptDef> {
    [COMPARE_PRICE, PLACE_ORDER, WEATHER_QUERY]
        .iter()
        .filter_map(|raw| {
            serde_json::from_str::<ScriptDef>(raw).ok().map(|mut s| {
                s.source = ScriptSource::Builtin;
                s
            })
        })
        .collect()
}
