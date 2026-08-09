import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ScrollText,
  Plus,
  Upload,
  CircleDot,
  Store,
  Trash2,
  Download,
  Pencil,
  ShieldAlert,
  Play,
  RefreshCw,
  Accessibility,
  ChevronDown,
  FileJson,
  BatteryCharging,
  MonitorPlay,
  X,
} from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { useAgentStore } from '../../store/agentState';
import {
  deleteScript,
  exportScriptText,
  getAccessibilityPermission,
  getKeepAliveStatus,
  getOverlayPermission,
  importScript,
  openAccessibilitySettings,
  openBatterySettings,
  openOverlaySettings,
  requestBatteryExempt,
  runScript,
  setScriptEnabled,
  type AccessibilityPermissionState,
  type KeepAliveStatus,
  type OverlayPermissionState,
  type ScriptSummary,
} from '../../services/agentService';

/**
 * 脚本管理面板（DSL 规格书 §12.1）。
 *
 * - 脚本列表：来源标记（内置/用户/分享）、risky 徽标、执行次数、启用/禁用
 * - 管理操作：编辑（工作台，保留接口）、删除、导出、试运行
 * - 顶部操作：新建（工作台，保留接口）、导入（已实现）、录制（保留接口）、脚本市场（保留接口）
 * - 无障碍权限引导横幅（规格书 8.3 三态检测 + 跳转设置）
 */

interface ScriptPanelProps {
  width?: number;
}

const SOURCE_LABELS: Record<ScriptSummary['source'], string> = {
  builtin: '内置',
  user: '用户',
  shared: '分享',
};

const SOURCE_STYLES: Record<ScriptSummary['source'], string> = {
  builtin: 'bg-blue-500/10 text-blue-500',
  user: 'bg-emerald-500/10 text-emerald-500',
  shared: 'bg-amber-500/10 text-amber-500',
};

function PermissionBanner() {
  const [state, setState] = React.useState<AccessibilityPermissionState | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setState(await getAccessibilityPermission());
    } catch {
      setState(null);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // 桥不可达（非 Android / 后端未启动）时不显示横幅
  if (!state || !state.ok) return null;
  if (state.granted && state.connected && state.operational) return null;

  const steps = [
    { label: '已授权', done: state.granted === true },
    { label: '已连接', done: state.connected === true },
    { label: '可操作', done: state.operational === true },
  ];

  return (
    <div className="bg-amber-500/[0.06] border border-amber-500/20 rounded-[20px] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-amber-500/10 text-amber-500">
          <Accessibility size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-foreground">需要开启无障碍服务</div>
          <div className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            手机助手需要无障碍权限来读取屏幕布局并执行自动化操作
          </div>
          <div className="flex items-center gap-2 mt-2.5">
            {steps.map((s, i) => (
              <React.Fragment key={s.label}>
                {i > 0 && <div className="h-px w-3 bg-border" />}
                <div className={`flex items-center gap-1 text-[10px] font-medium ${s.done ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                  <CircleDot size={10} className={s.done ? 'fill-emerald-500/20' : ''} />
                  {s.label}
                </div>
              </React.Fragment>
            ))}
          </div>
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            transition={{ duration: 0.15, ease: APPLE_CURVE }}
            onClick={() => void openAccessibilitySettings().then(refresh)}
            className="mt-3 rounded-full bg-amber-500 px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-sm"
          >
            去开启
          </motion.button>
        </div>
      </div>
    </div>
  );
}

/**
 * 权限卡片通用逻辑：已授权 → 简化显示（无说明文字）+ 右侧 × 关闭；
 * 权限重新缺失后再授权会再次显示（× 隐藏仅当次生效）。
 */
function usePermissionCard<T extends { ok?: boolean }>(
  poll: () => Promise<T>,
  isGranted: (s: T) => boolean,
) {
  const [status, setStatus] = React.useState<T | null>(null);
  const [hidden, setHidden] = React.useState(false);
  const prevGranted = React.useRef<boolean | undefined>(undefined);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await poll());
    } catch {
      setStatus(null);
    }
  }, [poll]);

  React.useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // 权限从缺失 → 已授权：重置 × 隐藏（前一次关闭失效）
  React.useEffect(() => {
    if (!status || !status.ok) return;
    const granted = isGranted(status);
    if (prevGranted.current === false && granted) setHidden(false);
    prevGranted.current = granted;
  }, [status, isGranted]);

  const visible = !!status && status.ok === true && !hidden;
  return {
    status,
    visible,
    granted: status ? isGranted(status) : false,
    hide: () => setHidden(true),
    refresh,
  };
}

/** 已授权简化状态行（绿卡 + ×） */
function GrantedRow({ icon, title, onClose }: { icon: React.ReactNode; title: string; onClose: () => void }) {
  return (
    <div className="relative bg-emerald-500/[0.06] border border-emerald-500/20 rounded-[20px] py-2.5 pl-3.5 pr-10">
      <div className="flex items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] bg-emerald-500/10 text-emerald-500">
          {icon}
        </div>
        <div className="text-[12px] font-semibold text-foreground">{title}</div>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="关闭此提示"
        className="absolute right-2.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/**
 * 后台保活引导（电池优化白名单）。
 * - 桥不可达（非 Android / 后端未启动）时不显示
 * - 已豁免 → 简化状态行（+ × 关闭）
 * - 未豁免 → 引导卡：一键豁免 / 打开设置（国产 ROM 还需手动允许自启动）
 */
function KeepAliveBanner() {
  const { visible, granted, hide, refresh } = usePermissionCard<KeepAliveStatus>(
    getKeepAliveStatus,
    (s) => s.exempt === true,
  );

  if (!visible) return null;

  if (granted) {
    return <GrantedRow icon={<BatteryCharging size={15} />} title="后台保活已优化" onClose={hide} />;
  }

  return (
    <div className="bg-amber-500/[0.06] border border-amber-500/20 rounded-[20px] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-amber-500/10 text-amber-500">
          <BatteryCharging size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-foreground">开启后台保活</div>
          <div className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            任务进行中退到后台时，免电池优化可显著降低被系统清理的概率（华为/小米等系统还需在应用管理中允许"自启动/后台运行"）。
          </div>
          <div className="flex items-center gap-2 mt-3">
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={{ duration: 0.15, ease: APPLE_CURVE }}
              onClick={() => void requestBatteryExempt().then(refresh)}
              className="rounded-full bg-amber-500 px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-sm"
            >
              一键豁免
            </motion.button>
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={{ duration: 0.15, ease: APPLE_CURVE }}
              onClick={() => void openBatterySettings().then(refresh)}
              className="rounded-full border border-border px-3.5 py-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              手动设置
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * AI 活动悬浮窗权限引导。
 * - 未授权 → 引导卡（去开启悬浮窗权限）
 * - 已授权 → 简化状态行（+ × 关闭）
 */
function OverlayBanner() {
  const { visible, granted, hide, refresh } = usePermissionCard<OverlayPermissionState>(
    getOverlayPermission,
    (s) => s.granted === true,
  );

  if (!visible) return null;

  if (granted) {
    return <GrantedRow icon={<MonitorPlay size={15} />} title="AI 活动悬浮窗已开启" onClose={hide} />;
  }

  return (
    <div className="bg-amber-500/[0.06] border border-amber-500/20 rounded-[20px] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px] bg-amber-500/10 text-amber-500">
          <MonitorPlay size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-foreground">开启 AI 活动悬浮窗</div>
          <div className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
            在屏幕上部实时显示 AI 正在做什么（思考动画 / 回复内容 / 工具操作），无需打开应用即可了解任务进度。
          </div>
          <div className="flex items-center gap-2 mt-3">
            <motion.button
              type="button"
              whileTap={{ scale: 0.96 }}
              transition={{ duration: 0.15, ease: APPLE_CURVE }}
              onClick={() => void openOverlaySettings().then(refresh)}
              className="rounded-full bg-amber-500 px-3.5 py-1.5 text-[11px] font-semibold text-white shadow-sm"
            >
              去开启
            </motion.button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScriptCard({
  script,
  onChanged,
}: {
  script: ScriptSummary;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [runResult, setRunResult] = React.useState<string | null>(null);
  const isBuiltin = script.source === 'builtin';

  const doAction = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  const handleToggleEnabled = () =>
    doAction(async () => {
      await setScriptEnabled(script.name, !script.enabled);
      onChanged();
    });

  const handleDelete = () =>
    doAction(async () => {
      if (!window.confirm(`确定删除脚本「${script.name}」吗？`)) return;
      const result = await deleteScript(script.name);
      if (!result.ok) {
        window.alert(result.error?.message ?? '删除失败');
      }
      onChanged();
    });

  const handleExport = () =>
    doAction(async () => {
      const text = await exportScriptText(script.name);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${script.name}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const handleTestRun = () =>
    doAction(async () => {
      setRunResult(null);
      const outcome = await runScript(script.name, {}, false);
      if (outcome.status === 'needs_confirmation') {
        setRunResult('该脚本需要用户确认后运行（在对话中由 AI 调用时会向你确认）');
      } else if (outcome.status === 'ok') {
        setRunResult(`运行成功（${outcome.steps_executed} 步 / ${(outcome.duration_ms / 1000).toFixed(1)}s）`);
      } else {
        setRunResult(outcome.last_error ?? `状态：${outcome.status}`);
      }
    });

  const params = (script.params_schema?.properties ?? {}) as Record<string, { description?: string }>;
  const requiredParams = (script.params_schema?.required ?? []) as string[];

  return (
    <div className="bg-background/80 backdrop-blur-xl rounded-[20px] border border-border overflow-hidden transition-shadow duration-300 hover:shadow-[0_4px_16px_rgba(0,0,0,0.04)]">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-4"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[13px] font-semibold text-foreground truncate">{script.name}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${SOURCE_STYLES[script.source]}`}>
                {SOURCE_LABELS[script.source]}
              </span>
              {script.risky && (
                <span className="flex items-center gap-0.5 rounded-full bg-red-500/10 px-1.5 py-0.5 text-[9px] font-bold text-red-500">
                  <ShieldAlert size={9} />
                  高危
                </span>
              )}
              {!script.enabled && (
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-bold text-muted-foreground">
                  已禁用
                </span>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
              {script.description || '（无描述）'}
            </div>
          </div>
          <motion.span
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.3, ease: APPLE_CURVE }}
            className="mt-1 text-muted-foreground shrink-0"
          >
            <ChevronDown size={15} />
          </motion.span>
        </div>
        <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground">
          <span>执行 {script.run_count} 次</span>
          {Object.keys(params).length > 0 && <span>{Object.keys(params).length} 个参数</span>}
        </div>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: APPLE_CURVE }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-4 pt-1 border-t border-border/60">
              {Object.keys(params).length > 0 && (
                <div className="mt-2 space-y-1">
                  <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.15em]">参数</div>
                  {Object.entries(params).map(([name, schema]) => (
                    <div key={name} className="flex items-baseline gap-1.5 text-[11px]">
                      <code className="text-foreground font-mono">{name}</code>
                      {requiredParams.includes(name) && <span className="text-red-400">*</span>}
                      {schema.description && (
                        <span className="text-muted-foreground truncate">— {schema.description}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {runResult && (
                <div className="mt-3 rounded-[14px] bg-muted/60 px-3 py-2 text-[11px] text-foreground leading-relaxed">
                  {runResult}
                </div>
              )}

              <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                <PanelButton icon={Play} label="试运行" onClick={handleTestRun} disabled={busy || !script.enabled} />
                <PanelButton
                  icon={Pencil}
                  label="编辑"
                  onClick={() => window.alert('脚本工作台编辑功能将在后续版本开放（接口已预留）')}
                  disabled={busy}
                />
                <PanelButton icon={Download} label="导出" onClick={handleExport} disabled={busy} />
                {!isBuiltin && (
                  <>
                    <PanelButton
                      icon={script.enabled ? CircleDot : Play}
                      label={script.enabled ? '禁用' : '启用'}
                      onClick={handleToggleEnabled}
                      disabled={busy}
                    />
                    <PanelButton icon={Trash2} label="删除" onClick={handleDelete} disabled={busy} danger />
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PanelButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  danger,
}: {
  icon: typeof Play;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      transition={{ duration: 0.15, ease: APPLE_CURVE }}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors ${
        danger
          ? 'border-red-500/20 text-red-500 hover:bg-red-500/10'
          : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground'
      } ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
    >
      <Icon size={11} />
      {label}
    </motion.button>
  );
}

export function ScriptPanel({ width = 400 }: ScriptPanelProps) {
  const scripts = useAgentStore((s) => s.scripts);
  const loading = useAgentStore((s) => s.scriptsLoading);
  const error = useAgentStore((s) => s.scriptsError);
  const refreshScripts = useAgentStore((s) => s.refreshScripts);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [importError, setImportError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void refreshScripts();
  }, [refreshScripts]);

  const handleImportFile = async (file: File) => {
    setImportError(null);
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const result = await importScript(json);
      if (!result.ok) {
        const issue = result.report?.issues?.find((i) => i.level === 'error');
        setImportError(issue ? `${issue.path}: ${issue.message}` : (result.error?.message ?? '导入失败'));
        return;
      }
      await refreshScripts();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : '导入失败：文件不是有效的脚本 JSON');
    }
  };

  return (
    <div className="shrink-0 h-full flex flex-col bg-sidebar z-20 overflow-hidden border-l border-border">
      <div className="flex-1 flex flex-col h-full relative" style={{ width }}>
        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 pb-8 pt-6 space-y-4 relative z-10">
          {/* 标题栏 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em]">
              <ScrollText size={12} />
              自动化脚本
            </div>
            <motion.button
              type="button"
              whileTap={{ scale: 0.9 }}
              transition={{ duration: 0.15, ease: APPLE_CURVE }}
              onClick={() => void refreshScripts()}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
              aria-label="刷新脚本列表"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </motion.button>
          </div>

          {/* 无障碍权限引导（规格书 8.3） */}
          <PermissionBanner />

          {/* 后台保活引导（电池优化白名单） */}
          <KeepAliveBanner />

          {/* AI 活动悬浮窗权限引导 */}
          <OverlayBanner />

          {/* 顶部操作：新建 / 导入 / 录制 / 脚本市场 */}
          <div className="grid grid-cols-4 gap-2">
            <TopAction
              icon={Plus}
              label="新建"
              onClick={() => window.alert('脚本工作台（新建/编辑）将在后续版本开放，接口已预留。当前可在对话中让 AI 用自然语言生成脚本。')}
            />
            <TopAction icon={Upload} label="导入" onClick={() => fileInputRef.current?.click()} />
            <TopAction
              icon={CircleDot}
              label="录制"
              onClick={() => window.alert('操作录制器为二期功能（接口已预留）')}
            />
            <TopAction
              icon={Store}
              label="市场"
              onClick={() => window.alert('脚本市场将在后续版本开放（接口已预留）')}
            />
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportFile(file);
              e.target.value = '';
            }}
          />

          {importError && (
            <div className="rounded-[16px] bg-red-500/[0.06] border border-red-500/20 px-3.5 py-2.5 text-[11px] text-red-500 leading-relaxed">
              导入失败：{importError}
            </div>
          )}

          {error && (
            <div className="rounded-[16px] bg-red-500/[0.06] border border-red-500/20 px-3.5 py-2.5 text-[11px] text-red-500">
              {error}
            </div>
          )}

          {/* 脚本列表 */}
          <div className="space-y-2.5">
            {scripts.map((script) => (
              <ScriptCard key={script.name} script={script} onChanged={() => void refreshScripts()} />
            ))}
            {!loading && scripts.length === 0 && !error && (
              <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                <FileJson size={28} strokeWidth={1.5} />
                <div className="text-[12px]">暂无脚本，导入或在对话中让 AI 生成</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TopAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Plus;
  label: string;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.94 }}
      transition={{ duration: 0.15, ease: APPLE_CURVE }}
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 rounded-[18px] border border-border bg-background/80 backdrop-blur-xl py-3 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
    >
      <Icon size={16} />
      <span className="text-[10px] font-medium">{label}</span>
    </motion.button>
  );
}
