//! subagent-proc：子代理独立进程入口（设计稿 §2 / §8，仅桌面端构建）。
//!
//! `subagent-proc --session <id> --mode subagent --data-dir <dir>`
//! stdin/stdout 走 NDJSON ACP；stderr 由父进程重定向到日志文件。

use std::path::PathBuf;

fn main() {
    // 解析参数
    let mut session_id = String::new();
    let mut data_dir = PathBuf::from(".");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--session" => {
                if let Some(v) = args.next() {
                    session_id = v;
                }
            }
            "--data-dir" => {
                if let Some(v) = args.next() {
                    data_dir = PathBuf::from(v);
                }
            }
            "--mode" => {
                let _ = args.next(); // subagent（当前唯一模式）
            }
            other => {
                eprintln!("subagent-proc: 未知参数 {other}");
                std::process::exit(2);
            }
        }
    }
    if session_id.is_empty() {
        eprintln!("subagent-proc: 缺少 --session 参数");
        std::process::exit(2);
    }

    // tokio 运行时（多线程：LLM 流 + stdio 泵 + 工具执行并行）
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    let code = rt.block_on(venture_backend::subagent::proc_main(session_id, data_dir));
    std::process::exit(code);
}
