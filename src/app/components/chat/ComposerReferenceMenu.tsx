import { ComponentType, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Globe,
  MessageSquareText,
  Search,
  X,
} from "lucide-react";
import { useChatStore } from "../../store/useChatStore";
import { ComposerReference, ComposerReferenceKind } from "../../types";

interface ComposerReferenceMenuProps {
  onClose: () => void;
  onSelect: (reference: ComposerReference) => void;
}

interface ReferenceCategory {
  id: ComposerReferenceKind;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
}

interface ReferenceOption {
  id: string;
  label: string;
  detail?: string;
  description?: string;
  buildReference: () => ComposerReference;
}

const CATEGORIES: ReferenceCategory[] = [
  { id: "chat", label: "Past Chats", icon: MessageSquareText },
  { id: "web", label: "Web", icon: Globe },
];

function createReference(
  kind: Exclude<ComposerReferenceKind, "code">,
  label: string,
  detail?: string,
  extras?: Partial<ComposerReference>,
): ComposerReference {
  return {
    id: crypto.randomUUID(),
    kind,
    label,
    detail,
    ...extras,
  } as ComposerReference;
}

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

export function ComposerReferenceMenu({
  onClose,
  onSelect,
}: ComposerReferenceMenuProps) {
  const chats = useChatStore((state) => state.chats);
  const [activeCategory, setActiveCategory] = useState<ComposerReferenceKind>("chat");
  const [query, setQuery] = useState("");

  const loweredQuery = query.trim().toLowerCase();

  const options = useMemo<ReferenceOption[]>(() => {






    if (activeCategory === "chat") {
      return chats
        .filter((chat) => !loweredQuery || chat.title.toLowerCase().includes(loweredQuery))
        .map((chat) => ({
          id: chat.id,
          label: chat.title,
          detail: `${chat.messages.length} 条消息`,
          description: "历史对话",
          buildReference: () => createReference("chat", chat.title, "历史对话", { chatId: chat.id }),
        }));
    }







    if (activeCategory === "web") {
      if (!query.trim()) {
        return [];
      }

      const url = normalizeUrl(query);
      return [{
        id: `web:${url}`,
        label: query.trim(),
        detail: url,
        description: "网页链接",
        buildReference: () => createReference("web", query.trim(), url, { url }),
      }];
    }

    return [];
  }, [activeCategory, chats, loweredQuery, query]);

  const activeCategoryMeta = CATEGORIES.find((category) => category.id === activeCategory) ?? CATEGORIES[0];
  const ActiveCategoryIcon = activeCategoryMeta.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="absolute bottom-full left-0 right-0 z-[120] mb-3 flex h-[min(360px,calc(100vh-164px))] flex-col overflow-hidden rounded-[22px] border border-border bg-background shadow-[0_28px_70px_-36px_rgba(15,23,42,0.38),0_20px_32px_-24px_rgba(15,23,42,0.28)] min-[480px]:flex-row"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex shrink-0 flex-col border-b border-border/70 bg-muted/20 p-2 min-[480px]:w-[52px] min-[480px]:border-b-0 min-[480px]:border-r sm:w-[200px]">
        <div className="hidden px-3 py-2 text-[11px] font-semibold tracking-tight text-muted-foreground sm:block">
          引用来源
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1 min-[480px]:flex-col min-[480px]:overflow-visible min-[480px]:pb-0">
          {CATEGORIES.map((category) => {
            const Icon = category.icon;
            const isActive = category.id === activeCategory;

            return (
              <button
                key={category.id}
                type="button"
                onClick={() => setActiveCategory(category.id)}
                className={`flex shrink-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium transition-colors min-[480px]:justify-center sm:justify-start sm:px-3 ${
                  isActive
                    ? "bg-background text-foreground shadow-[0_10px_24px_-18px_rgba(15,23,42,0.35)]"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
                }`}
                title={category.label}
              >
                <Icon size={15} className={isActive ? "text-[#0A84FF]" : ""} />
                <span className="hidden sm:inline">{category.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-border/70 px-3 py-3 sm:px-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
              <ActiveCategoryIcon size={15} className="text-[#0A84FF]" />
              <span>{activeCategoryMeta.label}</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="关闭引用面板"
            >
              <X size={13} />
            </button>
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
            <Search size={14} className="text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={activeCategory === "web" ? "输入网址或域名..." : "搜索或输入引用内容..."}
              className="w-full border-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>

        <div className="flex-1 overflow-y-auto p-2 sm:p-2">
          {options.length > 0 ? (
            <div className="space-y-1">
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onSelect(option.buildReference());
                    onClose();
                  }}
                  className="flex w-full items-start gap-3 rounded-2xl px-2.5 py-2.5 text-left transition-colors hover:bg-muted/50 sm:px-3"
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground">
                    <ActiveCategoryIcon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {option.label}
                    </span>
                    {option.detail ? (
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {option.detail}
                      </span>
                    ) : null}
                    {option.description ? (
                      <span className="mt-1 block text-[11px] text-muted-foreground/90">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-8 text-center">
              <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl bg-muted/50 text-muted-foreground">
                <ActiveCategoryIcon size={18} />
              </div>
              <p className="text-[13px] font-medium text-foreground">
                这里还没有可直接引用的内容
              </p>
              <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
                {activeCategory === "web"
                  ? "输入关键字后即可创建一个引用标签。"
                  : "换一个分类，或者输入关键字继续筛选。"}
              </p>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
