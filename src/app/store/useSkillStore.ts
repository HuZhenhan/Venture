import { create } from 'zustand';
import {
  createSkill,
  deleteSkill,
  getSkillContent,
  getSkillFiles,
  getSkillSettings,
  importSkillZip,
  listSkills,
  saveSkillSettings,
  setSkillEnabled,
  updateSkillContent,
  type CreateSkillInput,
  type SkillFileNode,
  type SkillInfo,
  type SkillScanError,
  type SkillScope,
  type SkillSettings,
} from '../services/skillService';

export type SkillStatusFilter = 'all' | 'enabled' | 'disabled';
export type SkillScopeFilter = 'all' | SkillScope;

/**
 * 技能管理状态（SkillPanel / 设置页 skills 标签 / 引用菜单共用）：
 * - 技能列表缓存（含被遮蔽列表与扫描错误）
 * - 搜索/过滤条件
 * - 详情页选中的技能（SKILL.md 原文 + 文件树）
 * - 技能设置（完整 JSON，保存时整体覆盖）
 */
interface SkillState {
  skills: SkillInfo[];
  shadowed: SkillInfo[];
  errors: SkillScanError[];
  loading: boolean;
  loadError: string | null;
  searchQuery: string;
  searchInDescription: boolean;
  statusFilter: SkillStatusFilter;
  scopeFilter: SkillScopeFilter;
  selectedSkillName: string | null;
  skillContent: string | null;
  skillContentLoading: boolean;
  fileTree: SkillFileNode | null;
  settings: SkillSettings | null;
  skillxDir: string | null;
  settingsLoading: boolean;
  settingsSaving: boolean;
  settingsError: string | null;

  refresh: () => Promise<void>;
  create: (input: CreateSkillInput) => Promise<void>;
  updateContent: (name: string, content: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  setEnabled: (name: string, enabled: boolean) => Promise<void>;
  importZip: (dataBase64: string) => Promise<void>;
  selectSkill: (name: string | null) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: SkillSettings) => Promise<void>;
  setSearchQuery: (query: string) => void;
  setSearchInDescription: (value: boolean) => void;
  setStatusFilter: (filter: SkillStatusFilter) => void;
  setScopeFilter: (filter: SkillScopeFilter) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  shadowed: [],
  errors: [],
  loading: false,
  loadError: null,
  searchQuery: '',
  searchInDescription: false,
  statusFilter: 'all',
  scopeFilter: 'all',
  selectedSkillName: null,
  skillContent: null,
  skillContentLoading: false,
  fileTree: null,
  settings: null,
  skillxDir: null,
  settingsLoading: false,
  settingsSaving: false,
  settingsError: null,

  refresh: async () => {
    set({ loading: true, loadError: null });
    try {
      const result = await listSkills();
      set({
        skills: result.skills,
        shadowed: result.shadowed,
        errors: result.errors,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, loadError: errorMessage(err) });
    }
  },

  create: async (input) => {
    await createSkill(input);
    await get().refresh();
  },

  updateContent: async (name, content) => {
    await updateSkillContent(name, content);
    set({ skillContent: content });
  },

  remove: async (name) => {
    await deleteSkill(name);
    if (get().selectedSkillName === name) {
      set({ selectedSkillName: null, skillContent: null, fileTree: null });
    }
    await get().refresh();
  },

  setEnabled: async (name, enabled) => {
    await setSkillEnabled(name, enabled);
    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.name === name || skill.canonicalName === name ? { ...skill, enabled } : skill,
      ),
    }));
  },

  importZip: async (dataBase64) => {
    await importSkillZip(dataBase64);
    await get().refresh();
  },

  selectSkill: async (name) => {
    if (!name) {
      set({ selectedSkillName: null, skillContent: null, fileTree: null });
      return;
    }
    set({ selectedSkillName: name, skillContent: null, fileTree: null, skillContentLoading: true });
    try {
      const [content, tree] = await Promise.all([
        getSkillContent(name).catch(() => null),
        getSkillFiles(name).catch(() => null),
      ]);
      // 期间用户可能已返回列表，避免覆盖
      if (get().selectedSkillName !== name) return;
      set({ skillContent: content, fileTree: tree, skillContentLoading: false });
    } catch {
      if (get().selectedSkillName !== name) return;
      set({ skillContentLoading: false });
    }
  },

  loadSettings: async () => {
    set({ settingsLoading: true, settingsError: null });
    try {
      const result = await getSkillSettings();
      set({ settings: result.merged, skillxDir: result.skillxDir, settingsLoading: false });
    } catch (err) {
      set({ settingsLoading: false, settingsError: errorMessage(err) });
    }
  },

  saveSettings: async (settings) => {
    set({ settingsSaving: true, settingsError: null });
    try {
      await saveSkillSettings(settings);
      set({ settings, settingsSaving: false });
    } catch (err) {
      set({ settingsSaving: false, settingsError: errorMessage(err) });
      throw err;
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchInDescription: (value) => set({ searchInDescription: value }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),
  setScopeFilter: (filter) => set({ scopeFilter: filter }),
}));
