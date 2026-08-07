import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, Edit2, Image, Loader2, Minus, Plus, Save, Shield, Trash2, X, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { APIConfig, AIModel } from '../../types';
import type { LegacyLocalDataSummary } from '../../services/appDataService';
import type { SkillPermission, SkillSettings } from '../../services/skillService';
import { useClickOutside } from '../../hooks/useClickOutside';
import { APPLE_CURVE, DURATION } from '../../constants';
import { addProvider, deleteProvider, updateProvider } from '../../services/modelConfigService';
import { useChatStore } from '../../store/useChatStore';
import { useSkillStore } from '../../store/useSkillStore';

interface CustomSelectProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  menuPosition?: 'top' | 'bottom';
}

interface AppleToggleProps {
  checked: boolean;
  onChange: () => void;
  size?: 'sm' | 'md';
}

interface PreferencesPanelProps {
  sendShortcut: boolean;
  autoGenerateConversationTitles: boolean;
  autoGenerateReasoningTitles: boolean;
  debugMode: boolean;
  appearance: string;
  hasPendingChanges: boolean;
  onSendShortcutChange: (value: boolean) => void;
  onAutoGenerateConversationTitlesChange: (value: boolean) => void;
  onAutoGenerateReasoningTitlesChange: (value: boolean) => void;
  onDebugModeChange: (value: boolean) => void;
  onAppearanceChange: (appearance: string) => void;
  onSave: () => void;
}

interface MigrationPanelProps {
  migrationSummary: LegacyLocalDataSummary | null;
  migrationStatus: string | null;
  onMigrateLegacyLocalData: () => void;
}

interface ProviderLibraryPanelProps {
  apiConfigs: APIConfig[];
  expandedConfigId: string | null;
  onExpandedConfigIdChange: (configId: string | null) => void;
}

interface ProviderFormData {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: AIModel[];
  inputContextWindow: number;
}

interface ProviderConfigModalProps {
  isOpen: boolean;
  editingConfig: APIConfig | null;
  onClose: () => void;
}

export function CustomSelect({
  value,
  options,
  onChange,
  menuPosition = 'bottom',
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setIsOpen(false), isOpen);

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <span>{value}</span>
        <ChevronDown size={12} className={`transition-transform duration-300 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: menuPosition === 'top' ? 4 : -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: menuPosition === 'top' ? 4 : -4 }}
            transition={{ duration: DURATION.card, ease: APPLE_CURVE }}
            className={`absolute right-0 z-[9999] w-32 overflow-hidden rounded-xl border border-border bg-background/95 p-1 shadow-lg backdrop-blur-2xl ${
              menuPosition === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'
            }`}
          >
            {options.map((option) => (
              <button
                key={option}
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] text-foreground transition-colors hover:bg-muted/50"
              >
                <span>{option}</span>
                {value === option ? <Check size={12} className="text-foreground" /> : null}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function AppleToggle({ checked, onChange, size = 'md' }: AppleToggleProps) {
  const isSmall = size === 'sm';

  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
      className={`
        relative flex cursor-pointer items-center rounded-full transition-colors duration-500 ease-[0.32,0.72,0,1]
        ${checked ? 'bg-primary' : 'bg-switch-background/40'}
        ${isSmall ? 'h-[18px] w-8' : 'h-[24px] w-[42px]'}
      `}
    >
      <motion.div
        animate={{ x: checked ? (isSmall ? 16 : 20) : 2 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30, mass: 0.8 }}
        className={`${isSmall ? 'h-3.5 w-3.5' : 'h-5 w-5'} rounded-full bg-background shadow-sm`}
      />
    </button>
  );
}

export function PreferencesPanel({
  sendShortcut,
  autoGenerateConversationTitles,
  autoGenerateReasoningTitles,
  debugMode,
  appearance,
  hasPendingChanges,
  onSendShortcutChange,
  onAutoGenerateConversationTitlesChange,
  onAutoGenerateReasoningTitlesChange,
  onDebugModeChange,
  onAppearanceChange,
  onSave,
}: PreferencesPanelProps) {
  return (
    <div className="px-5 pt-5 pb-4 space-y-4 relative z-10 w-full shrink-0">
      <div className="space-y-3">
        <div className="divide-y divide-border rounded-2xl border border-border bg-background/50">
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="space-y-0.5">
              <p className="text-[13px] font-semibold text-foreground">发送快捷键</p>
              <p className="text-[11px] text-muted-foreground">使用 Enter 或 Cmd+Enter 发送</p>
            </div>
            <AppleToggle checked={sendShortcut} onChange={() => onSendShortcutChange(!sendShortcut)} />
          </div>
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="space-y-0.5 pr-4">
              <p className="text-[13px] font-semibold text-foreground">对话标题生成</p>
              <p className="text-[11px] text-muted-foreground">首轮回复完成后自动生成会话标题</p>
            </div>
            <AppleToggle
              checked={autoGenerateConversationTitles}
              onChange={() => onAutoGenerateConversationTitlesChange(!autoGenerateConversationTitles)}
            />
          </div>
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="space-y-0.5 pr-4">
              <p className="text-[13px] font-semibold text-foreground">思考标题生成</p>
              <p className="text-[11px] text-muted-foreground">思考内容完成后自动生成卡片标题</p>
            </div>
            <AppleToggle
              checked={autoGenerateReasoningTitles}
              onChange={() => onAutoGenerateReasoningTitlesChange(!autoGenerateReasoningTitles)}
            />
          </div>
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="space-y-0.5">
              <p className="text-[13px] font-semibold text-foreground">外观模式</p>
              <p className="text-[11px] text-muted-foreground">设置深色或浅色主题</p>
            </div>
            <CustomSelect
              value={appearance}
              options={['跟随系统', '浅色模式', '深色模式']}
              onChange={onAppearanceChange}
              menuPosition="top"
            />
          </div>
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="space-y-0.5 pr-4">
              <p className="text-[13px] font-semibold text-foreground">调试模式</p>
              <p className="text-[11px] text-muted-foreground">开启后在对话列表右键菜单显示「追踪」选项</p>
            </div>
            <AppleToggle
              checked={debugMode}
              onChange={() => onDebugModeChange(!debugMode)}
            />
          </div>
        </div>
      </div>

      <button
        onClick={onSave}
        disabled={!hasPendingChanges}
        className={`relative z-0 flex w-full items-center justify-center gap-2.5 rounded-2xl py-4 text-[13px] font-bold transition-all ${
          hasPendingChanges
            ? 'border border-border bg-background text-foreground shadow-sm hover:bg-muted/50 active:scale-[0.98]'
            : 'cursor-not-allowed border border-border bg-muted/60 text-muted-foreground'
        }`}
      >
        <Save size={16} />
        {hasPendingChanges ? '保存配置更改' : '配置已保存'}
      </button>
    </div>
  );
}

export function MigrationPanel({
  migrationSummary,
  migrationStatus,
  onMigrateLegacyLocalData,
}: MigrationPanelProps) {
  return (
    <div className="px-5 pt-5 pb-4 space-y-4 relative z-10 w-full shrink-0">
      <div className="rounded-2xl border border-border bg-background/50 p-4">
        <div className="space-y-1">
          <p className="text-[13px] font-semibold text-foreground">统一存储迁移</p>
          <p className="text-[11px] leading-5 text-muted-foreground">
            将当前入口的旧 localStorage 迁移到 AppData\\Roaming\\Venture。聊天增量合并，设置覆盖。
          </p>
          {migrationSummary ? (
            <p className="text-[11px] leading-5 text-muted-foreground">
              来源：{migrationSummary.origin}，会话 {migrationSummary.chatCount} 个
            </p>
          ) : (
            <p className="text-[11px] leading-5 text-muted-foreground">当前入口未检测到旧 localStorage 数据</p>
          )}
          {migrationStatus ? <p className="text-[11px] leading-5 text-foreground">{migrationStatus}</p> : null}
        </div>
        <button
          onClick={onMigrateLegacyLocalData}
          disabled={!migrationSummary}
          className={`mt-3 flex w-full items-center justify-center gap-2.5 rounded-2xl py-3 text-[12px] font-bold transition-all ${
            migrationSummary
              ? 'border border-border bg-background text-foreground shadow-sm hover:bg-muted/50 active:scale-[0.98]'
              : 'cursor-not-allowed border border-border bg-muted/60 text-muted-foreground'
          }`}
        >
          迁移当前入口数据
        </button>
      </div>
    </div>
  );
}

export function ProviderLibraryPanel({
  apiConfigs,
  expandedConfigId,
  onExpandedConfigIdChange,
}: ProviderLibraryPanelProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingConfig, setEditingConfig] = useState<APIConfig | null>(null);
  const [pendingDeleteConfig, setPendingDeleteConfig] = useState<APIConfig | null>(null);
  const { loadApiConfigs, setApiConfigs } = useChatStore();

  const handleOpenAddModal = () => {
    setEditingConfig(null);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (config: APIConfig) => {
    setEditingConfig(config);
    setIsModalOpen(true);
  };

  const handleDeleteConfig = async (id: string) => {
    try {
      await deleteProvider(id);
      await loadApiConfigs();
    } catch {
      setApiConfigs((prev) => prev.filter((c) => c.id !== id));
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDeleteConfig) return;
    const id = pendingDeleteConfig.id;
    setPendingDeleteConfig(null);
    await handleDeleteConfig(id);
  };

  const handleToggleModel = async (configId: string, modelId: string) => {
    const config = apiConfigs.find((c) => c.id === configId);
    if (!config) return;
    const updatedModels = config.models.map((m) =>
      m.id === modelId ? { ...m, enabled: !m.enabled } : m
    );
    try {
      await updateProvider(configId, { models: updatedModels });
      setApiConfigs((prev) =>
        prev.map((c) => (c.id === configId ? { ...c, models: updatedModels } : c))
      );
    } catch {
    }
  };

  return (
    <>
      <div className="w-full shrink-0 space-y-6 px-4 py-5 animate-in fade-in slide-in-from-bottom-2 duration-500 custom-scrollbar overflow-y-auto">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.25em] text-muted-foreground">API 核心供应商</h3>
            <button
              onClick={handleOpenAddModal}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-bold text-primary-foreground shadow-sm shadow-black/10 transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              <Plus size={12} />
              添加
            </button>
          </div>

          <div className="space-y-4">
            {apiConfigs.map((config) => {
              const isExpanded = expandedConfigId === config.id;

              return (
                <div
                  key={config.id}
                  className="group relative"
                >
                  <div className="group flex flex-col rounded-2xl border border-border bg-background/60 p-3.5 transition-all duration-300 hover:bg-background hover:shadow-xl">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/50 shadow-inner">
                          <Shield size={17} className="text-muted-foreground" />
                        </div>
                        <div className="min-w-0 flex-col">
                          <span className="truncate text-[14px] font-bold tracking-tight text-foreground">{config.name}</span>
                          <div className="mt-0.5 flex items-center gap-2">
                            <div className="flex items-center gap-1">
                              <Zap size={10} className="fill-green-500 text-green-500" />
                              <span className="font-mono text-[10px] font-bold text-muted-foreground">
                                {config.hasApiKey ? 'KEY ✓' : 'NO KEY'}
                              </span>
                            </div>
                            <span className="text-[10px] font-light text-muted-foreground">|</span>
                            <span className="text-[10px] font-bold text-muted-foreground opacity-70">
                              {config.models.filter((m) => m.enabled).length}/{config.models.length} 个模型
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          onClick={() => handleOpenEditModal(config)}
                          className="rounded-lg p-1.5 text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDeleteConfig(config);
                          }}
                          className="rounded-lg p-1.5 text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 size={14} />
                        </button>
                        <button
                          onClick={() => onExpandedConfigIdChange(isExpanded ? null : config.id)}
                          className="cursor-pointer rounded-lg p-1.5 text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground"
                        >
                          <ChevronDown size={14} className={`transition-transform duration-500 ${isExpanded ? 'rotate-180' : ''}`} />
                        </button>
                        <div className={`ml-1 h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.4)] ${config.hasApiKey ? 'bg-green-500' : 'bg-yellow-500'}`} />
                      </div>
                    </div>

                    <div className={`overflow-hidden transition-all duration-300 ease-[0.25,0.46,0.45,0.94] ${isExpanded ? 'mt-3 max-h-[400px] pb-2 opacity-100' : 'max-h-0 opacity-0'}`}>
                      <div className="space-y-1 border-t border-border pt-3">
                        {config.models.length === 0 && (
                          <p className="px-3 py-2 text-[12px] text-muted-foreground">暂无模型，请编辑供应商添加模型</p>
                        )}
                        {config.models.map((model) => (
                          <div key={model.id} className="group/model flex items-center justify-between rounded-xl px-3 py-2 transition-colors hover:bg-muted/50">
                            <div className="min-w-0 flex-1">
                              <span className={`block truncate text-[12px] ${model.enabled ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                                {model.name}
                              </span>
                              <span className="font-mono text-[10px] text-muted-foreground">{model.id}</span>
                              {model.supportsMultimodal ? (
                                <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">
                                  <Image size={10} />
                                  Vision
                                </span>
                              ) : null}
                            </div>
                            <AppleToggle
                              size="sm"
                              checked={model.enabled}
                              onChange={() => handleToggleModel(config.id, model.id)}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}

            {apiConfigs.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border p-6 text-center">
                <p className="text-[13px] text-muted-foreground">还没有配置任何供应商</p>
                <p className="mt-1 text-[11px] text-muted-foreground">点击上方「添加」按钮添加第一个供应商</p>
              </div>
            )}
          </div>
        </section>
      </div>

      <ProviderConfigModal
        isOpen={isModalOpen}
        editingConfig={editingConfig}
        onClose={() => setIsModalOpen(false)}
      />

      {/* 删除供应商确认弹窗 */}
      <AnimatePresence>
        {pendingDeleteConfig ? (
          <div className="fixed inset-0 z-[999] flex items-center justify-center p-6">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setPendingDeleteConfig(null)}
              className="absolute inset-0 bg-black/40 backdrop-blur-md"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 30 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 30 }}
              transition={{ type: 'spring', stiffness: 350, damping: 30, mass: 0.8 }}
              className="relative w-full max-w-sm transform-gpu rounded-[32px] border border-border bg-background p-7 shadow-2xl"
            >
              <div className="space-y-1.5">
                <h3 className="text-[19px] font-bold tracking-tight text-foreground">删除供应商</h3>
                <p className="text-[13px] leading-5 text-muted-foreground">
                  确定删除供应商「{pendingDeleteConfig.name}」吗？此操作不可撤销。
                </p>
              </div>
              <div className="flex gap-3 pt-7">
                <button
                  onClick={() => setPendingDeleteConfig(null)}
                  className="flex-1 rounded-[24px] border border-border py-3 text-[13px] font-bold text-foreground transition-all hover:bg-muted/50 active:scale-[0.98]"
                >
                  取消
                </button>
                <button
                  onClick={handleConfirmDelete}
                  className="flex-1 rounded-[24px] bg-[#d65a54] py-3 text-[13px] font-bold text-white transition-all hover:bg-[#d65a54]/90 active:scale-[0.98]"
                >
                  删除
                </button>
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

export function ProviderConfigModal({
  isOpen,
  editingConfig,
  onClose,
}: ProviderConfigModalProps) {
  const { loadApiConfigs } = useChatStore();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const emptyForm: ProviderFormData = {
    name: '',
    baseUrl: '',
    apiKey: '',
    models: [{ id: '', name: '', enabled: true, supportsMultimodal: false }],
    inputContextWindow: 128,
  };

  const [formData, setFormData] = useState<ProviderFormData>(emptyForm);

  const resetForm = (config: APIConfig | null) => {
    if (config) {
      setFormData({
        name: config.name,
        baseUrl: config.baseUrl,
        apiKey: '',
        models: config.models.length > 0
          ? config.models.map((model) => ({ ...model, supportsMultimodal: model.supportsMultimodal ?? false }))
          : [{ id: '', name: '', enabled: true, supportsMultimodal: false }],
        inputContextWindow: config.inputContextWindow,
      });
    } else {
      setFormData(emptyForm);
    }
    setSaveError(null);
  };

  const handleOpen = () => resetForm(editingConfig);

  const addModelRow = () => {
    setFormData((prev) => ({
      ...prev,
      models: [...prev.models, { id: '', name: '', enabled: true, supportsMultimodal: false }],
    }));
  };

  const removeModelRow = (idx: number) => {
    setFormData((prev) => ({
      ...prev,
      models: prev.models.filter((_, i) => i !== idx),
    }));
  };

  const updateModelRow = (idx: number, field: keyof AIModel, value: string | boolean) => {
    setFormData((prev) => ({
      ...prev,
      models: prev.models.map((m, i) => (i === idx ? { ...m, [field]: value } : m)),
    }));
  };

  const handleSave = async () => {
    if (!formData.name.trim() || !formData.baseUrl.trim()) {
      setSaveError('供应商名称和 Base URL 为必填项');
      return;
    }
    const validModels = formData.models.filter((m) => m.id.trim());
    if (validModels.length === 0) {
      setSaveError('请至少添加一个模型 ID');
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      if (editingConfig) {
        await updateProvider(editingConfig.id, {
          name: formData.name.trim(),
          baseUrl: formData.baseUrl.trim(),
          apiKey: formData.apiKey.trim() || undefined,
          models: validModels.map((m) => ({
            id: m.id.trim(),
            name: m.name.trim() || m.id.trim(),
            enabled: m.enabled,
            supportsMultimodal: m.supportsMultimodal ?? false,
          })),
          inputContextWindow: formData.inputContextWindow,
        });
      } else {
        await addProvider({
          name: formData.name.trim(),
          baseUrl: formData.baseUrl.trim(),
          apiKey: formData.apiKey.trim(),
          models: validModels.map((m) => ({
            id: m.id.trim(),
            name: m.name.trim() || m.id.trim(),
            enabled: m.enabled,
            supportsMultimodal: m.supportsMultimodal ?? false,
          })),
          inputContextWindow: formData.inputContextWindow,
        });
      }
      await loadApiConfigs();
      onClose();
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : '保存失败，请检查后端是否运行');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence onExitComplete={handleOpen}>
      {isOpen ? (
        <div className="fixed inset-0 z-[999] flex items-center justify-center p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/40 backdrop-blur-md"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 30 }}
            transition={{ type: 'spring', stiffness: 350, damping: 30, mass: 0.8 }}
            onAnimationStart={handleOpen}
            className="relative w-full max-w-lg transform-gpu overflow-y-auto overflow-x-hidden rounded-[40px] border border-border bg-background p-10 shadow-2xl max-h-[90vh] custom-scrollbar"
          >
            <div className="flex items-center justify-between mb-8">
              <div className="space-y-1">
                <h3 className="text-2xl font-bold tracking-tight text-foreground">
                  {editingConfig ? '编辑供应商' : '添加供应商'}
                </h3>
                <p className="text-[13px] font-medium text-muted-foreground">配置 OpenAI-compatible API 接入</p>
              </div>
              <button onClick={onClose} className="rounded-full p-3 text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground">
                <X size={24} />
              </button>
            </div>

            <div className="space-y-6">
              <div className="space-y-3">
                <label className="ml-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">供应商名称</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                  placeholder="例如: DeepSeek, OpenAI, 本地 Ollama"
                  className="w-full rounded-[24px] border-none bg-input-background px-6 py-4 text-[15px] font-medium outline-none transition-all placeholder:text-muted-foreground focus:ring-4 focus:ring-primary/5"
                />
              </div>

              <div className="space-y-3">
                <label className="ml-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Base URL</label>
                <input
                  type="text"
                  value={formData.baseUrl}
                  onChange={(e) => setFormData((p) => ({ ...p, baseUrl: e.target.value }))}
                  placeholder="https://api.deepseek.com/v1"
                  className="w-full rounded-[24px] border-none bg-input-background px-6 py-4 text-[15px] font-medium outline-none transition-all placeholder:text-muted-foreground focus:ring-4 focus:ring-primary/5"
                />
              </div>

              <div className="space-y-3">
                <label className="ml-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                  API KEY {editingConfig && '（留空则不更新）'}
                </label>
                <input
                  type="password"
                  value={formData.apiKey}
                  onChange={(e) => setFormData((p) => ({ ...p, apiKey: e.target.value }))}
                  placeholder={editingConfig ? (editingConfig.hasApiKey ? `已保存：${editingConfig.apiKeyPreview}` : '输入新 Key') : 'sk-••••••••••••••••'}
                  className="w-full rounded-[24px] border-none bg-input-background px-6 py-4 text-[15px] font-medium outline-none transition-all placeholder:text-muted-foreground focus:ring-4 focus:ring-primary/5"
                />
                <p className="ml-1 text-[11px] text-muted-foreground">API Key 加密存储，不会在前端明文暴露</p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="ml-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">模型列表</label>
                  <button
                    type="button"
                    onClick={addModelRow}
                    className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-primary hover:bg-primary/10 transition-colors"
                  >
                    <Plus size={11} />
                    添加模型
                  </button>
                </div>
                <div className="space-y-2">
                  {formData.models.map((model, idx) => (
                    <div key={idx} className="rounded-2xl bg-input-background px-4 py-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">模型 {idx + 1}</span>
                        <button
                          type="button"
                          onClick={() => removeModelRow(idx)}
                          className="rounded-lg p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                          disabled={formData.models.length === 1}
                        >
                          <Minus size={12} />
                        </button>
                      </div>
                      <input
                        type="text"
                        value={model.id}
                        onChange={(e) => updateModelRow(idx, 'id', e.target.value)}
                        placeholder="模型 ID（必填），例如 deepseek-chat"
                        className="w-full rounded-xl border-none bg-background/50 px-3 py-2 text-[13px] font-medium outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/10"
                      />
                      <input
                        type="text"
                        value={model.name}
                        onChange={(e) => updateModelRow(idx, 'name', e.target.value)}
                        placeholder="显示名（可选，留空则使用 ID）"
                        className="w-full rounded-xl border-none bg-background/50 px-3 py-2 text-[13px] font-medium outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/10"
                      />
                      <div className="flex items-center justify-between rounded-xl bg-background/40 px-3 py-2">
                        <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
                          <Image size={13} className="text-muted-foreground" />
                          <span>支持多模态图片</span>
                        </div>
                        <AppleToggle
                          size="sm"
                          checked={model.supportsMultimodal ?? false}
                          onChange={() => updateModelRow(idx, 'supportsMultimodal', !(model.supportsMultimodal ?? false))}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <label className="ml-1 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">上下文配置</label>
                <div className="space-y-1.5">
                    <span className="ml-1 text-[11px] text-muted-foreground">输入上下文（K tokens）</span>
                    <input
                      type="number"
                      min={1}
                      value={formData.inputContextWindow || ''}
                      onChange={(e) => setFormData((p) => ({ ...p, inputContextWindow: parseInt(e.target.value) || 0 }))}
                      className="w-full rounded-[20px] border-none bg-input-background px-4 py-3 text-[15px] font-medium outline-none transition-all focus:ring-4 focus:ring-primary/5"
                    />
                  </div>
              </div>

              {saveError && (
                <div className="rounded-2xl bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
                  {saveError}
                </div>
              )}
            </div>

            <div className="flex gap-4 pt-8">
              <button
                onClick={onClose}
                className="flex-1 rounded-[24px] py-4 text-[15px] font-bold text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground"
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 flex items-center justify-center gap-2 rounded-[24px] bg-primary py-4 text-[15px] font-bold text-primary-foreground shadow-xl transition-all hover:shadow-2xl active:scale-[0.98] disabled:opacity-60"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : null}
                {saving ? '保存中...' : '确认保存'}
              </button>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

const PERMISSION_LABELS: Record<SkillPermission, string> = {
  allow: '允许',
  ask: '询问',
  deny: '拒绝',
};

const BUDGET_FIELDS: Array<{ key: Exclude<keyof SkillSettings['budget'], 'announcementEnabled'>; label: string; hint: string }> = [
  { key: 'announcementPercent', label: '公告占用百分比', hint: '技能公告占上下文预算的百分比' },
  { key: 'perEntryChars', label: '单条最大字符', hint: '列表中每个技能条目的最大字符数' },
  { key: 'listLimit', label: '列表条数上限', hint: '技能公告最多列出的技能数量' },
  { key: 'androidMaxTokens', label: '安卓最大 Token', hint: '安卓端注入技能内容的最大 token 数' },
  { key: 'maxInjectBytes', label: '最大注入字节', hint: '注入技能内容的最大字节数' },
  { key: 'maxPreloadBytes', label: '最大预载字节', hint: '预载技能内容的最大字节数' },
];

/** 技能设置面板（设置页 skills 标签）：根目录 / 权限规则 / 注入预算 */
export function SkillSettingsPanel() {
  const settings = useSkillStore((s) => s.settings);
  const skillxDir = useSkillStore((s) => s.skillxDir);
  const settingsLoading = useSkillStore((s) => s.settingsLoading);
  const settingsSaving = useSkillStore((s) => s.settingsSaving);
  const settingsError = useSkillStore((s) => s.settingsError);
  const loadSettings = useSkillStore((s) => s.loadSettings);
  const saveSettings = useSkillStore((s) => s.saveSettings);

  const [draft, setDraft] = useState<SkillSettings | null>(null);
  const [newRoot, setNewRoot] = useState('');
  const [newPattern, setNewPattern] = useState('');
  const [newPatternMode, setNewPatternMode] = useState<SkillPermission>('allow');

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  if (settingsLoading && !draft) {
    return (
      <div className="px-5 pt-5 pb-4 relative z-10 w-full shrink-0">
        <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-[12px]">加载技能设置…</span>
        </div>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="px-5 pt-5 pb-4 relative z-10 w-full shrink-0">
        <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.06] p-4 text-[12px] text-red-500">
          {settingsError ?? '技能设置加载失败'}
        </div>
      </div>
    );
  }

  const updateDraft = (updater: (prev: SkillSettings) => SkillSettings) => {
    setDraft((prev) => (prev ? updater(prev) : prev));
  };

  const permissionEntries = Object.entries(draft.permission.skill);
  const permissionOptions = Object.values(PERMISSION_LABELS);
  const resolvePermissionLabel = (label: string): SkillPermission | undefined =>
    (Object.keys(PERMISSION_LABELS) as SkillPermission[]).find(
      (key) => PERMISSION_LABELS[key] === label,
    );

  return (
    <div className="px-5 pt-5 pb-4 space-y-4 relative z-10 w-full shrink-0">
      {skillxDir && (
        <p className="text-[11px] text-muted-foreground font-mono break-all">技能目录：{skillxDir}</p>
      )}

      {/* 额外扫描根目录 */}
      <div className="rounded-2xl border border-border bg-background/50 p-4 space-y-2.5">
        <div className="space-y-0.5">
          <p className="text-[13px] font-semibold text-foreground">额外扫描根目录</p>
          <p className="text-[11px] text-muted-foreground">除默认目录外，额外扫描技能的位置</p>
        </div>
        {draft.roots.extra.map((root, index) => (
          <div key={`${root}-${index}`} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground">
              {root}
            </span>
            <button
              type="button"
              onClick={() =>
                updateDraft((prev) => ({
                  ...prev,
                  roots: { ...prev.roots, extra: prev.roots.extra.filter((_, i) => i !== index) },
                }))
              }
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
              aria-label="删除该目录"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
            placeholder="/path/to/skills"
            className="min-w-0 flex-1 rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground outline-none focus:border-foreground/30"
          />
          <button
            type="button"
            onClick={() => {
              const value = newRoot.trim();
              if (!value) return;
              updateDraft((prev) => ({ ...prev, roots: { ...prev.roots, extra: [...prev.roots.extra, value] } }));
              setNewRoot('');
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            aria-label="添加目录"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* 权限规则 */}
      <div className="rounded-2xl border border-border bg-background/50 p-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <p className="text-[13px] font-semibold text-foreground">权限规则</p>
            <p className="text-[11px] text-muted-foreground">按技能名模式匹配，控制调用权限</p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">默认</span>
            <CustomSelect
              value={PERMISSION_LABELS[draft.permission.defaultMode]}
              options={permissionOptions}
              onChange={(label) => {
                const mode = resolvePermissionLabel(label);
                if (mode) {
                  updateDraft((prev) => ({
                    ...prev,
                    permission: { ...prev.permission, defaultMode: mode },
                  }));
                }
              }}
            />
          </div>
        </div>
        {permissionEntries.map(([pattern, mode]) => (
          <div key={pattern} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground">
              {pattern}
            </span>
            <CustomSelect
              value={PERMISSION_LABELS[mode as SkillPermission] ?? mode}
              options={permissionOptions}
              onChange={(label) => {
                const nextMode = resolvePermissionLabel(label);
                if (nextMode) {
                  updateDraft((prev) => ({
                    ...prev,
                    permission: {
                      ...prev.permission,
                      skill: { ...prev.permission.skill, [pattern]: nextMode },
                    },
                  }));
                }
              }}
            />
            <button
              type="button"
              onClick={() =>
                updateDraft((prev) => {
                  const skill = { ...prev.permission.skill };
                  delete skill[pattern];
                  return { ...prev, permission: { ...prev.permission, skill } };
                })
              }
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-500"
              aria-label="删除该规则"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            placeholder="技能名模式，如 web-*"
            className="min-w-0 flex-1 rounded-xl border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] text-foreground outline-none focus:border-foreground/30"
          />
          <CustomSelect
            value={PERMISSION_LABELS[newPatternMode]}
            options={permissionOptions}
            onChange={(label) => {
              const mode = resolvePermissionLabel(label);
              if (mode) setNewPatternMode(mode);
            }}
          />
          <button
            type="button"
            onClick={() => {
              const value = newPattern.trim();
              if (!value) return;
              updateDraft((prev) => ({
                ...prev,
                permission: {
                  ...prev.permission,
                  skill: { ...prev.permission.skill, [value]: newPatternMode },
                },
              }));
              setNewPattern('');
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            aria-label="添加规则"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* 注入预算 */}
      <div className="rounded-2xl border border-border bg-background/50 p-4 space-y-2.5">
        <div className="space-y-0.5">
          <p className="text-[13px] font-semibold text-foreground">注入预算</p>
          <p className="text-[11px] text-muted-foreground">控制技能公告与内容注入的大小上限</p>
        </div>
        <div className="flex items-center justify-between">
          <div className="space-y-0.5 pr-4">
            <p className="text-[12px] font-medium text-foreground">技能公告</p>
            <p className="text-[11px] text-muted-foreground">在对话中向模型公告可用技能列表</p>
          </div>
          <AppleToggle
            checked={draft.budget.announcementEnabled}
            onChange={() =>
              updateDraft((prev) => ({
                ...prev,
                budget: { ...prev.budget, announcementEnabled: !prev.budget.announcementEnabled },
              }))
            }
            size="sm"
          />
        </div>
        {BUDGET_FIELDS.map((field) => (
          <div key={field.key} className="flex items-center justify-between gap-3">
            <div className="space-y-0.5 min-w-0">
              <p className="text-[12px] font-medium text-foreground">{field.label}</p>
              <p className="text-[11px] text-muted-foreground truncate">{field.hint}</p>
            </div>
            <input
              type="number"
              value={draft.budget[field.key]}
              onChange={(e) => {
                const value = Number(e.target.value);
                if (Number.isNaN(value)) return;
                updateDraft((prev) => ({
                  ...prev,
                  budget: { ...prev.budget, [field.key]: value },
                }));
              }}
              className="w-24 shrink-0 rounded-xl border border-border bg-muted/40 px-3 py-2 text-right font-mono text-[11px] text-foreground outline-none focus:border-foreground/30"
            />
          </div>
        ))}
      </div>

      {settingsError && (
        <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-[12px] text-red-500">
          {settingsError}
        </div>
      )}

      <button
        onClick={() => void saveSettings(draft).catch(() => undefined)}
        disabled={settingsSaving}
        className="relative z-0 flex w-full items-center justify-center gap-2.5 rounded-2xl border border-border bg-background py-4 text-[13px] font-bold text-foreground shadow-sm transition-all hover:bg-muted/50 active:scale-[0.98] disabled:opacity-60"
      >
        {settingsSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
        {settingsSaving ? '保存中...' : '保存技能设置'}
      </button>
    </div>
  );
}
