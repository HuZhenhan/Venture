import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Bug,
  ChevronDown,
  ChevronRight,
  Download,
  PanelRightClose,
  PanelRightOpen,
  Trash2,
} from "lucide-react";
import { useChatStore } from "../../store/useChatStore";
import { APPLE_CURVE } from "../../constants";

type TraceMode = "frontend" | "upstream";

/**
 * TraceView —— API 追踪的只读叠加面板。
 *
 * 设计要点：
 * - 追踪面板是叠加层，不替代正常聊天界面，MessageList 和 ChatInput 继续可用。
 * - 用户在正常聊天界面发消息，追踪面板自动记录当前 chat 的请求/响应。
 * - 只要 tracedChatId === activeChatId（当前 chat 被追踪），面板就显示。
 * - 关闭面板 = 停止追踪（clearTraceRecords 会同时清空 tracedChatId 和记录）。
 * - 面板可折叠为窄条，折叠后仍显示记录数量徽标，点击展开恢复。
 * - 支持两个模式切换：前端→后端 / 后端→供应商。
 */
export const TraceView: React.FC = () => {
  const traceRecords = useChatStore((s) => s.traceRecords);
  const clearTraceRecords = useChatStore((s) => s.clearTraceRecords);
  const clearTraceRecordsOnly = useChatStore((s) => s.clearTraceRecordsOnly);

  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [traceMode, setTraceMode] = useState<TraceMode>("frontend");
  const prevCountRef = useRef(traceRecords.length);

  // Auto-select the latest record when new ones arrive
  useEffect(() => {
    if (traceRecords.length > prevCountRef.current && traceRecords.length > 0) {
      const latest = traceRecords[traceRecords.length - 1];
      setSelectedRecordId(latest.id);
      setExpandedSections((prev) => ({
        ...prev,
        [`req-${latest.id}`]: true,
        [`res-${latest.id}`]: true,
        [`up-req-${latest.id}`]: true,
        [`up-res-${latest.id}`]: true,
      }));
      setCollapsed(false);
    }
    prevCountRef.current = traceRecords.length;
  }, [traceRecords]);

  const selectedRecord = traceRecords.find((r) => r.id === selectedRecordId) ?? null;

  const handleClose = () => {
    clearTraceRecords();
  };

  const handleClearRecords = () => {
    clearTraceRecordsOnly();
    setSelectedRecordId(null);
  };

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const formatJson = (data: unknown): string => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };

  /** 导出当前选中记录（按当前模式：前端→后端 / 后端→供应商）。 */
  const handleExport = () => {
    if (!selectedRecord) return;
    const exportingUpstream = traceMode === "upstream" && hasUpstream;
    const data = {
      traceMode: exportingUpstream ? "upstream" : "frontend",
      timestamp: new Date(selectedRecord.timestamp).toISOString(),
      request: exportingUpstream
        ? selectedRecord.upstream!.request
        : selectedRecord.request,
      response: exportingUpstream
        ? selectedRecord.upstream!.response
        : selectedRecord.response,
    };
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `venture-trace-${exportingUpstream ? "upstream" : "frontend"}-${selectedRecord.timestamp}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("导出 trace 失败", err);
    }
  };

  // ─── 折叠态：窄条徽标 ───
  if (collapsed) {
    return (
      <div className="h-full flex flex-col items-center py-3 px-2 border-l border-border bg-background/80 backdrop-blur-xl">
        <button
          onClick={() => setCollapsed(false)}
          className="flex items-center justify-center w-9 h-9 rounded-xl text-amber-500 hover:bg-amber-500/10 transition-all"
          title="展开追踪面板"
        >
          <PanelRightOpen size={18} strokeWidth={2} />
        </button>
        <div className="mt-3 flex flex-col items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-amber-500/10 text-amber-600 text-[11px] font-bold">
            {traceRecords.length}
          </div>
          <div className="w-px flex-1 bg-border/50" />
        </div>
        <button
          onClick={handleClose}
          className="mt-auto flex items-center justify-center w-9 h-9 rounded-xl text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-all"
          title="关闭追踪"
        >
          <PanelRightClose size={18} strokeWidth={2} />
        </button>
      </div>
    );
  }

  // ─── 判断上游数据是否可用 ───
  const hasUpstream = selectedRecord?.upstream != null;
  const activeRequest = traceMode === "upstream" && hasUpstream
    ? selectedRecord!.upstream!.request
    : selectedRecord?.request;
  const activeResponse = traceMode === "upstream" && hasUpstream
    ? selectedRecord!.upstream!.response
    : selectedRecord?.response;
  const activeEventCount = traceMode === "upstream" && hasUpstream
    ? selectedRecord!.upstream!.response.rawEvents.length
    : selectedRecord?.response.rawEvents.length;

  return (
    <div className="h-full w-[420px] flex flex-col border-l border-border bg-background/95 backdrop-blur-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Bug size={14} className="text-amber-500 shrink-0" />

          {/* Mode Switch */}
          <div className="flex items-center rounded-lg bg-muted/50 p-0.5">
            <button
              onClick={() => setTraceMode("frontend")}
              className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all ${
                traceMode === "frontend"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              前端→后端
            </button>
            <button
              onClick={() => setTraceMode("upstream")}
              className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-all ${
                traceMode === "upstream"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              后端→供应商
            </button>
          </div>

          {traceRecords.length > 0 && (
            <span className="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-amber-500/10 text-amber-600 text-[10px] font-bold shrink-0">
              {traceRecords.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {selectedRecord && (
            <button
              onClick={handleExport}
              className="flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-all"
              title="导出当前记录（按当前模式）"
            >
              <Download size={13} strokeWidth={2} />
            </button>
          )}
          {traceRecords.length > 0 && (
            <button
              onClick={() => {
                if (confirm("确定清空所有追踪记录？追踪将继续保持开启。")) {
                  handleClearRecords();
                }
              }}
              className="flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-all"
              title="清空记录"
            >
              <Trash2 size={13} strokeWidth={2} />
            </button>
          )}
          <button
            onClick={() => setCollapsed(true)}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-all"
            title="折叠面板"
          >
            <PanelRightClose size={14} strokeWidth={2} />
          </button>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-all"
            title="关闭追踪"
          >
            <ChevronRight size={16} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Content */}
      {traceRecords.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-6">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: APPLE_CURVE }}
            className="flex flex-col items-center gap-3 text-center"
          >
            <Bug size={28} className="text-muted-foreground/40" />
            <p className="text-[13px] text-muted-foreground font-medium">
              等待 API 请求...
            </p>
            <p className="text-[11px] text-muted-foreground/60 max-w-[240px] leading-relaxed">
              在左侧聊天界面发送消息后将自动记录请求和响应
            </p>
          </motion.div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Record List */}
          <div className="w-[150px] border-r border-border overflow-y-auto custom-scrollbar shrink-0">
            <div className="p-2">
              <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground px-2 mb-1.5">
                请求记录
              </p>
              <div className="space-y-1">
                {traceRecords.map((record, index) => (
                  <button
                    key={record.id}
                    onClick={() => setSelectedRecordId(record.id)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg transition-all ${
                      selectedRecordId === record.id
                        ? "bg-muted/80 text-foreground"
                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        selectedRecordId === record.id ? "bg-amber-500" : "bg-muted-foreground/30"
                      }`} />
                      <span className="text-[11px] font-medium">
                        #{index + 1}
                      </span>
                      {record.upstream && (
                        <span className="w-1 h-1 rounded-full bg-blue-500/60 shrink-0" title="含上游数据" />
                      )}
                    </div>
                    <p className="text-[9px] text-muted-foreground mt-0.5 ml-3">
                      {new Date(record.timestamp).toLocaleTimeString("zh-CN")}
                    </p>
                    <p className="text-[9px] text-muted-foreground/60 ml-3 truncate">
                      {record.response.rawEvents.length} 事件
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right: Detail View */}
          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {selectedRecord ? (
              <div className="p-3 space-y-3">
                {/* === 前端→后端 模式 === */}
                {traceMode === "frontend" && (
                  <>
                    {/* Request Section */}
                    <div className="rounded-xl border border-border bg-background/50 overflow-hidden">
                      <button
                        onClick={() => toggleSection(`req-${selectedRecord.id}`)}
                        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 text-[9px] font-bold">
                            REQUEST
                          </span>
                          <span className="text-[12px] font-semibold text-foreground">
                            前端→后端
                          </span>
                        </div>
                        {expandedSections[`req-${selectedRecord.id}`] !== false ? (
                          <ChevronDown size={12} className="text-muted-foreground" />
                        ) : (
                          <ChevronRight size={12} className="text-muted-foreground" />
                        )}
                      </button>
                      <AnimatePresence initial={false}>
                        {(expandedSections[`req-${selectedRecord.id}`] !== false) && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: APPLE_CURVE }}
                            className="overflow-hidden"
                          >
                            <div className="border-t border-border">
                              <div className="p-2 space-y-1.5">
                                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                  <span className="font-bold uppercase tracking-wider">URL</span>
                                  <span className="font-mono truncate">{activeRequest?.url}</span>
                                </div>
                                <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                  <span className="font-bold uppercase tracking-wider">Method</span>
                                  <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 text-[9px] font-bold">
                                    {activeRequest?.method}
                                  </span>
                                </div>
                              </div>
                              <div className="border-t border-border px-3 py-2">
                                <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground mb-1.5">
                                  Request Body
                                </p>
                                <pre className="text-[10px] font-mono text-foreground/80 bg-muted/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto custom-scrollbar">
                                  {formatJson(activeRequest?.body)}
                                </pre>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>

                    {/* Response Section */}
                    <div className="rounded-xl border border-border bg-background/50 overflow-hidden">
                      <button
                        onClick={() => toggleSection(`res-${selectedRecord.id}`)}
                        className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors"
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 text-[9px] font-bold">
                            RESPONSE
                          </span>
                          <span className="text-[12px] font-semibold text-foreground">
                            后端→前端
                          </span>
                          <span className="text-[10px] text-muted-foreground ml-1">
                            ({activeEventCount ?? 0})
                          </span>
                        </div>
                        {expandedSections[`res-${selectedRecord.id}`] !== false ? (
                          <ChevronDown size={12} className="text-muted-foreground" />
                        ) : (
                          <ChevronRight size={12} className="text-muted-foreground" />
                        )}
                      </button>
                      <AnimatePresence initial={false}>
                        {(expandedSections[`res-${selectedRecord.id}`] !== false) && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: APPLE_CURVE }}
                            className="overflow-hidden"
                          >
                            <div className="border-t border-border">
                              <div className="px-3 py-2">
                                <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground mb-1.5">
                                  SSE Events
                                </p>
                                <div className="space-y-1.5">
                                  {selectedRecord.response.rawEvents.map((event, idx) => (
                                    <div key={idx} className="rounded-lg bg-muted/30 p-2">
                                      <div className="flex items-center gap-1.5 mb-1">
                                        <span className="text-[9px] text-muted-foreground font-mono">
                                          #{idx + 1}
                                        </span>
                                        {typeof event === "object" && event !== null && "event" in event && (
                                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                                            (event as Record<string, unknown>).event === "error"
                                              ? "bg-red-500/10 text-red-500"
                                              : (event as Record<string, unknown>).event === "message_done"
                                              ? "bg-green-500/10 text-green-600"
                                              : "bg-muted-foreground/10 text-muted-foreground"
                                          }`}>
                                            {(event as Record<string, unknown>).event as string}
                                          </span>
                                        )}
                                      </div>
                                      <pre className="text-[10px] font-mono text-foreground/70 overflow-x-auto whitespace-pre-wrap break-all max-h-[150px] overflow-y-auto custom-scrollbar">
                                        {formatJson(event)}
                                      </pre>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </>
                )}

                {/* === 后端→供应商 模式 === */}
                {traceMode === "upstream" && (
                  hasUpstream ? (
                    <>
                      {/* Upstream Request */}
                      <div className="rounded-xl border border-border bg-background/50 overflow-hidden">
                        <button
                          onClick={() => toggleSection(`up-req-${selectedRecord.id}`)}
                          className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors"
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 text-[9px] font-bold">
                              REQUEST
                            </span>
                            <span className="text-[12px] font-semibold text-foreground">
                              后端→供应商
                            </span>
                          </div>
                          {expandedSections[`up-req-${selectedRecord.id}`] !== false ? (
                            <ChevronDown size={12} className="text-muted-foreground" />
                          ) : (
                            <ChevronRight size={12} className="text-muted-foreground" />
                          )}
                        </button>
                        <AnimatePresence initial={false}>
                          {(expandedSections[`up-req-${selectedRecord.id}`] !== false) && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: APPLE_CURVE }}
                              className="overflow-hidden"
                            >
                              <div className="border-t border-border">
                                <div className="p-2 space-y-1.5">
                                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                    <span className="font-bold uppercase tracking-wider">URL</span>
                                    <span className="font-mono truncate">{activeRequest?.url}</span>
                                  </div>
                                  <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                    <span className="font-bold uppercase tracking-wider">Method</span>
                                    <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 text-[9px] font-bold">
                                      {activeRequest?.method}
                                    </span>
                                  </div>
                                </div>
                                <div className="border-t border-border px-3 py-2">
                                  <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground mb-1.5">
                                    Request Body
                                  </p>
                                  <pre className="text-[10px] font-mono text-foreground/80 bg-muted/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-[300px] overflow-y-auto custom-scrollbar">
                                    {formatJson(activeRequest?.body)}
                                  </pre>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      {/* Upstream Response */}
                      <div className="rounded-xl border border-border bg-background/50 overflow-hidden">
                        <button
                          onClick={() => toggleSection(`up-res-${selectedRecord.id}`)}
                          className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors"
                        >
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 text-[9px] font-bold">
                              RESPONSE
                            </span>
                            <span className="text-[12px] font-semibold text-foreground">
                              供应商→后端
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-1">
                              ({activeEventCount ?? 0})
                            </span>
                          </div>
                          {expandedSections[`up-res-${selectedRecord.id}`] !== false ? (
                            <ChevronDown size={12} className="text-muted-foreground" />
                          ) : (
                            <ChevronRight size={12} className="text-muted-foreground" />
                          )}
                        </button>
                        <AnimatePresence initial={false}>
                          {(expandedSections[`up-res-${selectedRecord.id}`] !== false) && (
                            <motion.div
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: "auto", opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              transition={{ duration: 0.2, ease: APPLE_CURVE }}
                              className="overflow-hidden"
                            >
                              <div className="border-t border-border">
                                <div className="px-3 py-2">
                                  <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-muted-foreground mb-1.5">
                                    上游 SSE 原始事件
                                  </p>
                                  <div className="space-y-1.5">
                                    {activeResponse?.rawEvents.map((event, idx) => (
                                      <div key={idx} className="rounded-lg bg-muted/30 p-2">
                                        <div className="flex items-center gap-1.5 mb-1">
                                          <span className="text-[9px] text-muted-foreground font-mono">
                                            #{idx + 1}
                                          </span>
                                          {typeof event === "object" && event !== null && "choices" in event && (
                                            <span className="px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 text-[9px] font-bold">
                                              chunk
                                            </span>
                                          )}
                                          {event === "[DONE]" && (
                                            <span className="px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 text-[9px] font-bold">
                                              DONE
                                            </span>
                                          )}
                                        </div>
                                        <pre className="text-[10px] font-mono text-foreground/70 overflow-x-auto whitespace-pre-wrap break-all max-h-[150px] overflow-y-auto custom-scrollbar">
                                          {formatJson(event)}
                                        </pre>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center h-full p-6">
                      <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.5, ease: APPLE_CURVE }}
                        className="flex flex-col items-center gap-3 text-center"
                      >
                        <p className="text-[13px] text-muted-foreground font-medium">
                          等待上游数据...
                        </p>
                        <p className="text-[11px] text-muted-foreground/60 max-w-[240px] leading-relaxed">
                          当前选中的记录尚未包含后端→供应商的追踪数据。切换到新的追踪记录或检查后端是否支持上游追踪。
                        </p>
                      </motion.div>
                    </div>
                  )
                )}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center h-full p-6">
                <p className="text-[12px] text-muted-foreground text-center">
                  选择左侧的记录查看详情
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
