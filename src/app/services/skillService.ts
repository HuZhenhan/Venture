import { backendDelete, backendGet, backendPost, backendPut } from './backendClient';

// ─── 技能管理 API ───────────────────────────────────────────────────────────
//
// 路由约定：
//   GET    /api/skills                    — 列出全部技能（自动刷新扫描）
//   POST   /api/skills/refresh            — 手动重扫
//   POST   /api/skills                    — 创建技能
//   GET    /api/skills/:name/content      — 读取 SKILL.md 原始全文
//   GET    /api/skills/:name/files        — 技能目录文件树
//   GET    /api/skills/:name/file?path=   — 读取单个资源文件
//   PUT    /api/skills/:name/file?path=   — 新建/覆盖资源文件
//   DELETE /api/skills/:name/file?path=   — 删除资源文件
//   POST   /api/skills/import-zip         — 导入 zip skill
//   POST   /api/skills/:name/validate     — 本地静态校验/review
//   PUT    /api/skills/:name              — 覆盖写入 SKILL.md
//   DELETE /api/skills/:name              — 删除技能
//   POST   /api/skills/:name/enabled      — 启用/禁用
//   GET    /api/skills/settings           — 读取技能设置
//   PUT    /api/skills/settings           — 保存技能设置

export type SkillScope = 'project' | 'global' | 'plugin' | 'mcp';
export type SkillPermission = 'allow' | 'deny' | 'ask';
export type SkillLifecycleStatus = 'discovered' | 'enabled' | 'disabled' | 'invalid' | 'installing' | 'review_required';

export interface SkillReviewFinding {
  severity: 'low' | 'medium' | 'high';
  code: string;
  message: string;
  path: string | null;
}

export interface SkillReviewReport {
  source: 'local_static_checks';
  summary: string;
  findings: SkillReviewFinding[];
}

export interface SkillValidationResult {
  valid: boolean;
  status: SkillLifecycleStatus;
  review: SkillReviewReport;
}

/** 后端 SkillInfo 结构（camelCase，与后端 serde 对齐）。 */
export interface SkillInfo {
  canonicalName: string;
  name: string;
  description: string;
  whenToUse: string;
  version: string;
  scope: SkillScope;
  location: string;
  active: boolean;
  enabled: boolean;
  lifecycleStatus: SkillLifecycleStatus;
  autoInvocable: boolean;
  userInvocable: boolean;
  paths: string[] | null;
  frontmatter: Record<string, unknown>;
  shadowedBy: string | null;
  bundled: boolean;
  permission: SkillPermission;
  review?: SkillReviewReport;
}

export interface SkillLoadError {
  location: string;
  code: string;
  message: string;
}

export interface SkillPlatformInfo {
  hasProjectScope: boolean;
  os: string;
}

export interface SkillListResult {
  skills: SkillInfo[];
  shadowed: SkillInfo[];
  errors: SkillLoadError[];
  platform: SkillPlatformInfo;
}

export interface SkillFileNode {
  name: string;
  type: 'dir' | 'file';
  children?: SkillFileNode[];
  size?: number;
}

export interface SkillSettings {
  roots: {
    extra: string[];
    disableDefaultUser: boolean;
    managed: string | null;
  };
  compat: {
    claude: boolean;
    agents: boolean;
    opencode: boolean;
    grok: boolean;
    skip: string[];
  };
  permission: {
    skill: Record<string, SkillPermission>;
    defaultMode: string;
  };
  budget: {
    announcementEnabled: boolean;
    announcementPercent: number;
    perEntryChars: number;
    listLimit: number;
    androidMaxTokens: number | null;
    maxInjectBytes: number;
    maxPreloadBytes: number;
  };
  logging: {
    level: string;
  };
}

export interface SkillSettingsResult {
  global: SkillSettings;
  merged: SkillSettings;
  skillxDir: string;
}

export interface CreateSkillPayload {
  name: string;
  description: string;
  whenToUse?: string;
  autoInvocable?: boolean;
  body?: string;
}

export interface SkillImportResult {
  imported: boolean;
  skill: SkillInfo;
  validation: SkillValidationResult;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取 zip 文件失败'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const [, base64 = ''] = result.split(',', 2);
      if (!base64) {
        reject(new Error('zip 文件为空或格式不可读'));
        return;
      }
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

/** 列出全部技能（调用时后端会自动刷新扫描）。 */
export async function listSkills(): Promise<SkillListResult> {
  return backendGet<SkillListResult>('/api/skills');
}

/** 手动触发一次重扫，返回是否有变化。 */
export async function refreshSkills(): Promise<{ changed: boolean }> {
  return backendPost<{ changed: boolean }>('/api/skills/refresh', {});
}

export async function createSkill(payload: CreateSkillPayload): Promise<SkillInfo> {
  const result = await backendPost<{ skill: SkillInfo }>('/api/skills', payload);
  return result.skill;
}

/** 读取 SKILL.md 原始全文（含 frontmatter）。 */
export async function getSkillContent(name: string): Promise<string> {
  const result = await backendGet<{ name: string; content: string }>(
    `/api/skills/${encodeURIComponent(name)}/content`,
  );
  return result.content;
}

/** 获取技能目录的文件树。 */
export async function getSkillFiles(name: string): Promise<SkillFileNode | null> {
  const result = await backendGet<{ tree: SkillFileNode | null }>(
    `/api/skills/${encodeURIComponent(name)}/files`,
  );
  return result.tree;
}

/** 读取技能目录下的单个资源文件。 */
export async function getSkillFile(name: string, path: string): Promise<string> {
  const result = await backendGet<{ content: string }>(
    `/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`,
  );
  return result.content;
}

/** 新建或覆盖技能目录下的资源文件。 */
export async function upsertSkillFile(name: string, path: string, content: string): Promise<void> {
  await backendPut(`/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`, { content });
}

/** 删除技能目录下的资源文件。 */
export async function deleteSkillFile(name: string, path: string): Promise<void> {
  await backendDelete(`/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`);
}

/** 导入 zip skill，并返回后端本地静态校验结果。 */
export async function importSkillZip(file: File): Promise<SkillImportResult> {
  const base64 = await readFileAsBase64(file);
  return backendPost<SkillImportResult>('/api/skills/import-zip', { fileName: file.name, base64 });
}

/** 生成本地静态检查报告。不是 LLM 审计。 */
export async function validateSkill(name: string): Promise<SkillValidationResult> {
  return backendPost<SkillValidationResult>(`/api/skills/${encodeURIComponent(name)}/validate`, {});
}

/** 覆盖写入 SKILL.md 原始内容。 */
export async function updateSkillContent(name: string, content: string): Promise<void> {
  await backendPut(`/api/skills/${encodeURIComponent(name)}`, { content });
}

export async function deleteSkill(name: string): Promise<void> {
  await backendDelete(`/api/skills/${encodeURIComponent(name)}`);
}

export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  await backendPost(`/api/skills/${encodeURIComponent(name)}/enabled`, { enabled });
}

export async function getSkillSettings(): Promise<SkillSettingsResult> {
  return backendGet<SkillSettingsResult>('/api/skills/settings');
}

export async function saveSkillSettings(settings: SkillSettings): Promise<void> {
  await backendPut('/api/skills/settings', settings);
}
