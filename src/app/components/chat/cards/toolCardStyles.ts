import { cn } from "../../ui/utils";

const shellBase =
  "group flex flex-col overflow-hidden rounded-2xl border transition-[background-color,border-color,box-shadow] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]";

const headerBase =
  "flex items-center gap-2.5 px-4 py-2.5 w-full text-left rounded-xl transition-colors duration-500";

const iconBase =
  "flex items-center justify-center w-5 h-5 rounded-full shrink-0 transition-colors duration-500";

const codeBlockBase =
  "text-[11px] font-mono p-2.5 rounded-lg overflow-x-auto whitespace-pre-wrap break-all border transition-colors duration-500";

const inlineCodeBase =
  "font-mono px-1.5 py-0.5 rounded transition-colors duration-500";

export function getToolCardClasses(isExpanded: boolean) {
  return {
    shell: cn(
      shellBase,
      isExpanded
        ? "bg-card border-border shadow-[0_12px_28px_-24px_rgba(3,2,19,0.22)]"
        : "bg-background border-border shadow-[0_8px_20px_-20px_rgba(3,2,19,0.15)]"
    ),
    header: cn(headerBase, isExpanded ? "bg-transparent" : "hover:bg-muted/40"),
    icon: cn(
      iconBase,
      "bg-muted text-muted-foreground"
    ),
    iconForeground: "text-muted-foreground",
    eyebrow: "text-muted-foreground",
    headerTitle: cn(
      "transition-colors duration-500",
      isExpanded ? "text-muted-foreground" : "text-foreground"
    ),
    title: "text-foreground",
    chevron: "text-muted-foreground",
    badge: cn(
      "text-[10px] px-1.5 py-[0.5px] rounded-full font-medium transition-colors duration-500 border",
      isExpanded ? "bg-primary/5 border-primary/20 text-primary" : "bg-muted/30 border-border/50 text-muted-foreground"
    ),
    hoverItem: "hover:bg-muted/50",
    bodyText: "text-muted-foreground",
    label: "text-muted-foreground",
    link: "text-primary hover:text-primary/80",
    timelineLine: "before:bg-border/70",
    timelineNode: "bg-muted ring-4 ring-background",
    caret: "bg-muted-foreground/45",
    codeBlock: cn(
      codeBlockBase,
      "bg-muted/30 border-border/50 text-muted-foreground"
    ),
    inlineCode: cn(
      inlineCodeBase,
      "bg-muted/50 text-muted-foreground"
    ),
    secondaryButton: cn(
      "px-4 py-1.5 text-[12px] font-medium rounded-lg transition-colors",
      "bg-muted/80 hover:bg-muted text-foreground"
    ),
    primaryButton: cn(
      "px-4 py-1.5 text-[12px] font-medium rounded-lg transition-colors",
      "bg-primary hover:bg-primary/90 text-primary-foreground"
    ),
    dangerButton: cn(
      "px-4 py-1.5 text-[12px] font-medium rounded-lg transition-colors",
      "bg-[#FF3B30] hover:bg-[#FF3B30]/90 text-white shadow-sm"
    ),
  };
}
