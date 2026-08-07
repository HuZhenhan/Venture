import { SkillInfo, SkillScope } from '../../services/skillService';

export const SCOPE_META: Record<SkillScope, { label: string; className: string }> = {
  project: { label: '项目', className: 'bg-[#0a84ff]/10 text-[#0a84ff]' },
  global: { label: '全局', className: 'bg-[#af52de]/10 text-[#af52de]' },
  plugin: { label: '插件', className: 'bg-[#ff9f0a]/10 text-[#ff9f0a]' },
  mcp: { label: 'MCP', className: 'bg-[#30d158]/10 text-[#30d158]' },
};

export function ScopeBadge({ scope }: { scope: SkillScope }) {
  const meta = SCOPE_META[scope] ?? { label: scope, className: 'bg-muted/60 text-muted-foreground' };
  return (
    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${meta.className}`}>
      {meta.label}
    </span>
  );
}

/** 技能状态徽章：未激活 / 已禁用 / 权限拒绝 / 被遮蔽。 */
export function StatusBadges({ skill }: { skill: SkillInfo }) {
  return (
    <>
      {!skill.active && (
        <span className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
          未激活
        </span>
      )}
      {!skill.enabled && (
        <span className="shrink-0 rounded-md bg-[#8e8e93]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#8e8e93]">
          已禁用
        </span>
      )}
      {skill.permission === 'deny' && (
        <span className="shrink-0 rounded-md bg-[#d65a54]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#d65a54]">
          权限拒绝
        </span>
      )}
      {skill.shadowedBy && (
        <span
          className="shrink-0 truncate rounded-md bg-[#ff9f0a]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[#ff9f0a]"
          title={`被 ${skill.shadowedBy} 遮蔽`}
        >
          被 {skill.shadowedBy} 遮蔽
        </span>
      )}
    </>
  );
}

/** 去除 SKILL.md 顶部的 YAML frontmatter，仅保留 markdown 正文。 */
export function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return normalized;
  const after = normalized.slice(end + 4);
  return after.replace(/^(\s*\n|\s*---\n)/, '').replace(/^\n+/, '');
}
