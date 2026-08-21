//! ACP 传输层（设计稿 §4 / §2）。
//!
//! 协议与传输解耦：`AcpEndpoint` 提供对偶通道；桌面端 stdio 泵负责
//! 在进程管道与通道之间搬运帧，Android 端直接使用内存通道。

use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Child;
use tokio::sync::mpsc;

use super::protocol::AcpFrame;

/// ACP 端点：一端持有发送与接收通道，与对端构成全双工链路。
pub struct AcpEndpoint {
    tx: mpsc::UnboundedSender<AcpFrame>,
    rx: mpsc::UnboundedReceiver<AcpFrame>,
}

impl AcpEndpoint {
    pub fn send(&self, frame: AcpFrame) {
        // 无界通道：发送失败说明对端已关闭，静默丢弃（EOF 由接收侧感知）
        let _ = self.tx.send(frame);
    }

    pub async fn recv(&mut self) -> Option<AcpFrame> {
        self.rx.recv().await
    }

    pub fn try_recv(&mut self) -> Option<AcpFrame> {
        self.rx.try_recv().ok()
    }

    /// 生成只写句柄（事件下沉 / 子侧请求共用同一发送通道）。
    pub fn writer(&self) -> AcpWriter {
        AcpWriter { tx: self.tx.clone() }
    }

    pub fn close(&self) {
        self.tx.closed(); // 丢弃句柄并不能显式关闭，靠 drop
    }
}

/// 只写句柄：克隆成本低，供多个任务并发发送帧。
#[derive(Clone)]
pub struct AcpWriter {
    tx: mpsc::UnboundedSender<AcpFrame>,
}

impl AcpWriter {
    pub fn send(&self, frame: AcpFrame) {
        let _ = self.tx.send(frame);
    }
}

/// 创建一对内存通道端点：(parent, child)。
pub fn channel_pair() -> (AcpEndpoint, AcpEndpoint) {
    let (a_tx, a_rx) = mpsc::unbounded_channel();
    let (b_tx, b_rx) = mpsc::unbounded_channel();
    (
        AcpEndpoint { tx: a_tx, rx: b_rx },
        AcpEndpoint { tx: b_tx, rx: a_rx },
    )
}

// ─── stdio 泵（桌面端子进程）───────────────────────────────────────────────

/// 进程侧 stdio 泵句柄：把子进程 stdin/stdout 与 AcpEndpoint 双向桥接。
pub struct StdioPump {
    child: Child,
    _writer: tokio::task::JoinHandle<()>,
    _reader: tokio::task::JoinHandle<()>,
    writer_tx: mpsc::UnboundedSender<AcpFrame>,
}

impl StdioPump {
    /// 桥接子进程 stdio；返回父侧端点与泵句柄。
    /// parent.tx 发出的帧 → write_pump → 子进程 stdin；
    /// 子进程 stdout → read_pump → parent.rx。
    pub fn attach(
        mut child: Child,
    ) -> std::io::Result<(AcpEndpoint, StdioPump)> {
        let stdin = child.stdin.take().expect("child stdin piped");
        let stdout = child.stdout.take().expect("child stdout piped");

        let (writer_tx, writer_rx) = mpsc::unbounded_channel::<AcpFrame>();
        let (reader_out_tx, reader_out_rx) = mpsc::unbounded_channel::<AcpFrame>();

        let parent = AcpEndpoint {
            tx: writer_tx.clone(),
            rx: reader_out_rx,
        };

        // stdout → 父侧 rx
        let reader = tokio::spawn(read_pump(stdout, reader_out_tx));
        // 父侧 tx → stdin
        let writer = tokio::spawn(write_pump(stdin, writer_rx));

        Ok((
            parent,
            StdioPump {
                child,
                _writer: writer,
                _reader: reader,
                writer_tx,
            },
        ))
    }

    /// 强杀进程（kill 阶梯的最后一级，§7.3）。
    pub async fn hard_kill(&mut self) {
        let _ = self.child.kill().await;
    }

    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

async fn read_pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    r: R,
    out: mpsc::UnboundedSender<AcpFrame>,
) {
    let mut reader = BufReader::new(r);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // EOF
            Ok(_) => {
                if let Some(frame) = AcpFrame::from_line(&line) {
                    if out.send(frame).is_err() {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
}

async fn write_pump<W: tokio::io::AsyncWrite + Unpin + Send + 'static>(
    mut w: W,
    mut rx: mpsc::UnboundedReceiver<AcpFrame>,
) {
    while let Some(frame) = rx.recv().await {
        let Some(line) = frame.to_line() else {
            continue; // 超限帧丢弃（§4）
        };
        if w.write_all(line.as_bytes()).await.is_err() {
            break;
        }
        if w.write_all(b"\n").await.is_err() {
            break;
        }
        let _ = w.flush().await;
    }
    let _ = w.shutdown().await;
}

/// 子代理进程侧入口：把自身 stdin/stdout 桥接为 AcpEndpoint（返回端点 + 保活泵）。
pub struct SelfStdio {
    pub endpoint: AcpEndpoint,
    _pumps: Arc<()>,
}

pub fn self_stdio() -> std::io::Result<SelfStdio> {
    let (self_tx, self_rx) = mpsc::unbounded_channel::<AcpFrame>(); // 进程内收（stdin 进来的帧）
    let (out_tx, out_rx) = mpsc::unbounded_channel::<AcpFrame>(); // 进程内发（要写 stdout 的帧）

    let endpoint = AcpEndpoint {
        tx: out_tx,
        rx: self_rx,
    };

    tokio::spawn(read_pump(tokio::io::stdin(), self_tx));
    tokio::spawn(write_pump(tokio::io::stdout(), out_rx));

    Ok(SelfStdio {
        endpoint,
        _pumps: Arc::new(()),
    })
}
