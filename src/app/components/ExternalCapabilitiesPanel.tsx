import React from 'react';
import { AlertTriangle, GitBranch, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  ExternalCapability,
  ExternalCapabilityStatus,
  getExternalCapabilities,
  GitChangedFile,
  GitStatusSnapshot,
} from '../services/toolService';
import { PanelHeader } from './shared/PanelHeader';
import { useLayoutStore } from '../store/useLayoutStore';

const STATUS_LABELS: Record<ExternalCapabilityStatus, string> = {
  available: '可用',
  unavailable: '不可用',
  reserved: '预留',
};

const STATUS_CLASSES: Record<ExternalCapabilityStatus, string> = {
  available: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
  unavailable: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
  reserved: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300',
};

function CapabilityBadge({ status }: { status: ExternalCapabilityStatus }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] ${STATUS_CLASSES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

function CapabilityCard({ capability }: { capability: ExternalCapability }) {
  return (
    <div className="rounded-2xl border border-border bg-background/60 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{capability.label}</span>
        <CapabilityBadge status={capability.status} />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{capability.description}</p>
    </div>
  );
}

function GitFileRow({ file }: { file: GitChangedFile }) {
  return (
    <div className="rounded-xl border border-border bg-background/70 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {file.indexStatus}{file.worktreeStatus}
        </span>
        <span className="text-xs font-medium text-foreground">{file.displayStatus}</span>
      </div>
      <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={file.path}>
        {file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path}
      </div>
    </div>
  );
}

function GitStatusSection({ git }: { git: GitStatusSnapshot }) {
  if (!git.isRepo) {
    return (
      <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        <div className="mb-2 flex items-center gap-2 text-foreground">
          <AlertTriangle size={15} />
          <span className="font-medium">当前目录不是 Git 仓库</span>
        </div>
        <p className="text-xs leading-5">{git.message ?? '未检测到 .git 信息。'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-border bg-background/60 p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <GitBranch size={15} />
          <span>{git.branch ?? '未知分支'}</span>
        </div>
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          {git.root ? <div className="truncate font-mono" title={git.root}>{git.root}</div> : null}
          <div>领先 {git.ahead ?? 0}，落后 {git.behind ?? 0}</div>
        </div>
      </div>

      {git.files.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
          Git 工作区干净，没有待提交文件。
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Git 工作区变更（只读）</div>
          {git.files.map((file) => (
            <GitFileRow key={`${file.indexStatus}:${file.worktreeStatus}:${file.path}:${file.originalPath ?? ''}`} file={file} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ExternalCapabilitiesPanel() {
  const showChatPanel = useLayoutStore((state) => state.showChatPanel);
  const [data, setData] = React.useState<Awaited<ReturnType<typeof getExternalCapabilities>> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getExternalCapabilities());
    } catch (err) {
      setError(err instanceof Error ? err.message : '外部能力检测失败');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col bg-background">
      <PanelHeader
        title="外部能力"
        subtitle="Git status 与预留集成入口"
        icon={<ShieldCheck size={16} />}
        onClose={() => showChatPanel()}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
            aria-label="刷新外部能力状态"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
        }
      />

      <div className="flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </div>
        ) : null}

        {loading && !data ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : data ? (
          <div className="space-y-5">
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <ShieldCheck size={14} />
                <span>能力探测</span>
              </div>
              <div className="grid gap-2">
                {data.capabilities.map((capability) => (
                  <CapabilityCard key={capability.id} capability={capability} />
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Git Review</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  这里展示 Git 工作区状态；`变更审阅` 面板仍只处理 file_history 的 turn 级变更，两者不会混用。
                </p>
              </div>
              <GitStatusSection git={data.git} />
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
