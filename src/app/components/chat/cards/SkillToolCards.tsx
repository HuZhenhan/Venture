import { CircleAlert, Loader2, ScrollText } from 'lucide-react';
import { SkillCall, ToolCall } from '../../../types';
import { ExpandableCard, StatusHeader } from './ExpandableCard';
import { SkillCard } from './SkillCard';
import { getToolCardClasses } from './toolCardStyles';
import { formatInput } from './ToolCallCard';

/** list_skill / load_skill 工具卡片（结构化数据来自后端 structured 字段） */

export function isSkillToolCall(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === 'list_skill' || normalized === 'load_skill';
}

interface ListSkillStructured {
  count?: number;
  filter?: string;
  total?: number;
}

interface LoadSkillStructured {
  name?: string;
  source?: string;
  location?: string;
  description?: string;
  truncated?: boolean;
  status?: string;
  code?: string;
}

function ListSkillCard({ tool }: { tool: ToolCall }) {
  const structured = (tool.structured ?? {}) as ListSkillStructured;
  const styles = getToolCardClasses(false);
  const isRunning = tool.status === 'running' || tool.status === 'pending';
  const isError = tool.status === 'failed';

  const count = structured.count ?? 0;
  const statusKey = isRunning ? 'running' : isError ? 'failed' : 'completed';

  const icon = isRunning ? (
    <Loader2 size={12} className="animate-spin text-muted-foreground" />
  ) : isError ? (
    <CircleAlert size={12} className="text-destructive" />
  ) : (
    <ScrollText size={12} className="text-muted-foreground" />
  );

  return (
    <ExpandableCard
      icon={icon}
      header={
        <StatusHeader statusKey={statusKey}>
          <span className={`${styles.eyebrow} font-normal whitespace-nowrap`}>
            {isRunning ? '正在发现技能' : isError ? '技能发现失败' : `发现 ${count} 个技能`}
          </span>
          {structured.filter ? (
            <span className={`truncate ${styles.headerTitle}`}>过滤：{structured.filter}</span>
          ) : null}
        </StatusHeader>
      }
    >
      <div className="px-11 pb-5 pt-1">
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span>命中 {count} 个</span>
            {typeof structured.total === 'number' && <span>共 {structured.total} 个</span>}
          </div>
          {tool.output ? <pre className={styles.codeBlock}>{tool.output}</pre> : null}
        </div>
      </div>
    </ExpandableCard>
  );
}

function toSkillCall(tool: ToolCall): SkillCall {
  const structured = (tool.structured ?? {}) as LoadSkillStructured;
  const input = (tool.input ?? {}) as Record<string, unknown>;

  const isRunning = tool.status === 'running' || tool.status === 'pending';
  const isError = tool.status === 'failed' || (!isRunning && typeof structured.code === 'string');

  const outputParts: string[] = [];
  if (structured.description) {
    outputParts.push(structured.description + (structured.truncated ? '（内容已截断）' : ''));
  }
  if (structured.location) outputParts.push(`位置：${structured.location}`);
  if (structured.code) outputParts.push(`错误 [${structured.code}]`);
  if (outputParts.length === 0 && tool.output) outputParts.push(tool.output);

  return {
    id: tool.id,
    name: structured.name ?? (typeof input.name === 'string' ? input.name : tool.name),
    status: isRunning ? 'running' : isError ? 'failed' : 'completed',
    params: formatInput(tool.input) || undefined,
    output: outputParts.join('\n') || undefined,
  };
}

export function SkillToolCard({ tool }: { tool: ToolCall }) {
  if (tool.name.toLowerCase() === 'list_skill') {
    return <ListSkillCard tool={tool} />;
  }
  return <SkillCard skill={toSkillCall(tool)} />;
}
