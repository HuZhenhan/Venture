import { backendGet, backendPost, backendPut, backendDelete } from './backendClient';

// ─── 技能管理 API（SkillX 后端，Android 端无项目级作用域） ───────────────────
//
// 路由约定：
//   GET    /api/skills                  — 技能列表（调用即触发增量扫描）
//   POST   /api/skills/refresh          — 强制刷新（返回 {changed}）
//   POST   /api/skills                  — 新建技能
//   GET    /api/skills/:name/content    — SKILL.md 原文（引用功能用）
//   GET    /api/skills/:name/files      — 技能目录文件树
//   GET    /api/skills/:name/file?path= — 读取技能内单个文件
//   PUT    /api/skills/:name            — 覆盖 SKILL.md（内置技能只读会报错）
//   DELETE /api/skills/:name            — 删除技能
//   POST   /api/skills/:name/enabled    — 启用/禁用
//   GET    /api/skills/settings         — 技能设置（global/merged/skillxDir）
//   PUT    /api/skills/settings         — 保存完整设置 JSON
//   POST   /api/skills/import           — zip 导入（后端做 zipSlip/大小校验）

export type SkillScope = 'global' | 'plugin' | 'mcp';
export type SkillPermission = 'allow' | 'deny' | 'ask';

export interface SkillInfo {
  canonicalName: string;
  name: string;
  description: string;
  whenToUse?: string;
  version?: string;
  scope: SkillScope;
  location: string;
  /** paths 条件激活 */
  active: boolean;
  enabled: boolean;
  autoInvocable: boolean;
  userInvocable: boolean;
  paths: string[];
  frontmatter: Record<string, unknown>;
  shadowedBy?: string | null;
  /** 内置技能只读 */
  bundled: boolean;
  permission: SkillPermission;
}

export interface SkillScanError {
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
  errors: SkillScanError[];
  platform: SkillPlatformInfo;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  whenToUse?: string;
  autoInvocable?: boolean;
  body?: string;
}

export interface SkillFileNode {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  children?: SkillFileNode[];
}

export interface SkillSettings {
  roots: {
    extra: string[];
    disableDefaultUser: boolean;
    managed: string[];
  };
  compat: {
    claude: boolean;
    agents: boolean;
    opencode: boolean;
    grok: boolean;
    skip: boolean;
  };
  permission: {
    skill: Record<string, string>;
    defaultMode: SkillPermission;
  };
  budget: {
    announcementEnabled: boolean;
    announcementPercent: number;
    perEntryChars: number;
    listLimit: number;
    androidMaxTokens: number;
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

/** 拉取技能列表（后端调用时自动做增量扫描） */
export async function listSkills(): Promise<SkillListResult> {
  return backendGet<SkillListResult>('/api/skills');
}

/** 强制刷新技能扫描 */
export async function refreshSkillScan(): Promise<{ changed: boolean }> {
  return backendPost<{ changed: boolean }>('/api/skills/refresh', {});
}

/** 新建技能 */
export async function createSkill(input: CreateSkillInput): Promise<SkillInfo> {
  const result = await backendPost<{ skill: SkillInfo }>('/api/skills', input);
  return result.skill;
}

/** 获取 SKILL.md 原文 */
export async function getSkillContent(name: string): Promise<string> {
  const result = await backendGet<{ name: string; content: string }>(
    `/api/skills/${encodeURIComponent(name)}/content`,
  );
  return result.content;
}

/** 获取技能目录文件树 */
export async function getSkillFiles(name: string): Promise<SkillFileNode> {
  const result = await backendGet<{ tree: SkillFileNode }>(
    `/api/skills/${encodeURIComponent(name)}/files`,
  );
  return result.tree;
}

/** 读取技能内单个文件内容 */
export async function getSkillFileContent(name: string, path: string): Promise<string> {
  const result = await backendGet<{ content: string }>(
    `/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`,
  );
  return result.content;
}

/** 覆盖 SKILL.md（内置技能只读，后端会报错） */
export async function updateSkillContent(name: string, content: string): Promise<void> {
  await backendPut<unknown>(`/api/skills/${encodeURIComponent(name)}`, { content });
}

/** 删除技能 */
export async function deleteSkill(name: string): Promise<void> {
  await backendDelete<unknown>(`/api/skills/${encodeURIComponent(name)}`);
}

/** 启用/禁用技能 */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  await backendPost<unknown>(`/api/skills/${encodeURIComponent(name)}/enabled`, { enabled });
}

/** zip 导入技能（dataBase64 为 zip 文件内容的 base64 编码） */
export async function importSkillZip(dataBase64: string): Promise<{ imported: number; skill: SkillInfo | null }> {
  return backendPost<{ imported: number; skill: SkillInfo | null }>('/api/skills/import', { dataBase64 });
}

/** 获取技能设置 */
export async function getSkillSettings(): Promise<SkillSettingsResult> {
  return backendGet<SkillSettingsResult>('/api/skills/settings');
}

/** 保存技能设置（完整 JSON 覆盖） */
export async function saveSkillSettings(settings: SkillSettings): Promise<void> {
  await backendPut<unknown>('/api/skills/settings', settings);
}
