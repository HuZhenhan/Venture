import { create } from 'zustand';
import {
  CreateSkillPayload,
  SkillFileNode,
  SkillInfo,
  SkillLoadError,
  SkillPlatformInfo,
  SkillScope,
  SkillSettings,
  SkillSettingsResult,
  createSkill,
  deleteSkill,
  getSkillContent,
  getSkillFiles,
  getSkillSettings,
  listSkills,
  refreshSkills,
  saveSkillSettings,
  setSkillEnabled,
  updateSkillContent,
} from '../services/skillService';

export type SkillStatusFilter = 'all' | 'enabled' | 'disabled';
export type SkillScopeFilter = 'all' | SkillScope;

interface SkillState {
  skills: SkillInfo[];
  shadowed: SkillInfo[];
  errors: SkillLoadError[];
  platform: SkillPlatformInfo | null;
  loading: boolean;
  searchQuery: string;
  searchInDescription: boolean;
  statusFilter: SkillStatusFilter;
  scopeFilter: SkillScopeFilter;
  selectedSkillName: string | null;
  /** 当前选中技能的 SKILL.md 原始全文（详情/编辑用）。 */
  skillContent: string | null;
  fileTree: SkillFileNode | null;
  /** 本次扫描产生的错误是否已被用户忽略（新扫描时重置）。 */
  dismissedErrors: boolean;
  settings: SkillSettingsResult | null;
  settingsLoading: boolean;

  refresh: () => Promise<void>;
  select: (name: string | null) => Promise<void>;
  create: (payload: CreateSkillPayload) => Promise<void>;
  updateContent: (name: string, content: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
  setEnabled: (name: string, enabled: boolean) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: SkillSettings) => Promise<void>;

  setSearchQuery: (query: string) => void;
  setSearchInDescription: (value: boolean) => void;
  setStatusFilter: (filter: SkillStatusFilter) => void;
  setScopeFilter: (filter: SkillScopeFilter) => void;
  dismissErrors: () => void;
}

export const useSkillStore = create<SkillState>((set, get) => ({
  skills: [],
  shadowed: [],
  errors: [],
  platform: null,
  loading: false,
  searchQuery: '',
  searchInDescription: false,
  statusFilter: 'all',
  scopeFilter: 'all',
  selectedSkillName: null,
  skillContent: null,
  fileTree: null,
  dismissedErrors: false,
  settings: null,
  settingsLoading: false,

  refresh: async () => {
    set({ loading: true });
    try {
      const result = await listSkills();
      set({
        skills: result.skills,
        shadowed: result.shadowed,
        errors: result.errors,
        platform: result.platform,
        dismissedErrors: false,
      });
    } catch (error) {
      console.warn('Failed to load skills.', error);
    } finally {
      set({ loading: false });
    }
  },

  select: async (name) => {
    set({ selectedSkillName: name, skillContent: null, fileTree: null });
    if (!name) return;
    try {
      const [content, tree] = await Promise.all([getSkillContent(name), getSkillFiles(name)]);
      // 避免竞态：请求期间用户已切换选中项
      if (get().selectedSkillName !== name) return;
      set({ skillContent: content, fileTree: tree });
    } catch (error) {
      console.warn('Failed to load skill detail.', error);
    }
  },

  create: async (payload) => {
    await createSkill(payload);
    await get().refresh();
  },

  updateContent: async (name, content) => {
    await updateSkillContent(name, content);
    if (get().selectedSkillName === name) {
      set({ skillContent: content });
    }
    await get().refresh();
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
      shadowed: state.shadowed.map((skill) =>
        skill.name === name || skill.canonicalName === name ? { ...skill, enabled } : skill,
      ),
    }));
  },

  loadSettings: async () => {
    set({ settingsLoading: true });
    try {
      const settings = await getSkillSettings();
      set({ settings });
    } catch (error) {
      console.warn('Failed to load skill settings.', error);
    } finally {
      set({ settingsLoading: false });
    }
  },

  saveSettings: async (settings) => {
    await saveSkillSettings(settings);
    await get().loadSettings();
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchInDescription: (value) => set({ searchInDescription: value }),
  setStatusFilter: (filter) => set({ statusFilter: filter }),
  setScopeFilter: (filter) => set({ scopeFilter: filter }),
  dismissErrors: () => set({ dismissedErrors: true }),
}));

export const selectSkills = (state: SkillState) => state.skills;
export const selectShadowedSkills = (state: SkillState) => state.shadowed;
export const selectSkillErrors = (state: SkillState) => state.errors;
export const selectSkillPlatform = (state: SkillState) => state.platform;
export const selectSkillsLoading = (state: SkillState) => state.loading;
export const selectSkillSearchQuery = (state: SkillState) => state.searchQuery;
export const selectSkillSearchInDescription = (state: SkillState) => state.searchInDescription;
export const selectSkillStatusFilter = (state: SkillState) => state.statusFilter;
export const selectSkillScopeFilter = (state: SkillState) => state.scopeFilter;
export const selectSelectedSkillName = (state: SkillState) => state.selectedSkillName;
export const selectSkillContent = (state: SkillState) => state.skillContent;
export const selectSkillFileTree = (state: SkillState) => state.fileTree;
export const selectSkillErrorsDismissed = (state: SkillState) => state.dismissedErrors;
export const selectSkillSettings = (state: SkillState) => state.settings;
export const selectSkillSettingsLoading = (state: SkillState) => state.settingsLoading;
export const selectRefreshSkills = (state: SkillState) => state.refresh;
export const selectSelectSkill = (state: SkillState) => state.select;
export const selectSetSkillEnabled = (state: SkillState) => state.setEnabled;

/** 按当前搜索与筛选条件过滤后的技能列表。 */
export function filterSkills(state: Pick<SkillState, 'skills' | 'searchQuery' | 'searchInDescription' | 'statusFilter' | 'scopeFilter'>): SkillInfo[] {
  const query = state.searchQuery.trim().toLowerCase();
  return state.skills.filter((skill) => {
    if (state.statusFilter === 'enabled' && !skill.enabled) return false;
    if (state.statusFilter === 'disabled' && skill.enabled) return false;
    if (state.scopeFilter !== 'all' && skill.scope !== state.scopeFilter) return false;
    if (!query) return true;
    if (skill.name.toLowerCase().includes(query) || skill.canonicalName.toLowerCase().includes(query)) return true;
    return state.searchInDescription && skill.description.toLowerCase().includes(query);
  });
}

export { refreshSkills as requestSkillRescan };
