import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowLeft, File, Folder, Loader2, X } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { getSkillFileContent, type SkillFileNode } from '../../services/skillService';

interface SkillFilesSheetProps {
  open: boolean;
  skillName: string;
  tree: SkillFileNode | null;
  onClose: () => void;
}

function formatSize(size?: number): string {
  if (size === undefined) return '';
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

function FileTreeNode({
  node,
  path,
  depth,
  onOpenFile,
}: {
  node: SkillFileNode;
  path: string;
  depth: number;
  onOpenFile: (relPath: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(depth < 1);
  const relPath = path ? `${path}/${node.name}` : node.name;
  // 后端数据防御：children 必须是数组（曾出现对象导致 .map 崩溃）
  const childList = Array.isArray(node.children) ? node.children : [];

  if (node.type === 'file') {
    return (
      <button
        type="button"
        onClick={() => onOpenFile(relPath)}
        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
        style={{ paddingLeft: `${10 + depth * 14}px` }}
      >
        <File size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{node.name}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatSize(node.size)}</span>
      </button>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
        style={{ paddingLeft: `${10 + depth * 14}px` }}
      >
        <Folder size={13} className="shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">{node.name}</span>
      </button>
      {expanded &&
        childList.map((child) => (
          <FileTreeNode
            key={`${relPath}/${child.name}`}
            node={child}
            path={relPath}
            depth={depth + 1}
            onOpenFile={onOpenFile}
          />
        ))}
    </div>
  );
}

/** 技能文件底部弹层：目录树 + 文件内容查看 */
export function SkillFilesSheet({ open, skillName, tree, onClose }: SkillFilesSheetProps) {
  const [openFilePath, setOpenFilePath] = React.useState<string | null>(null);
  const [fileContent, setFileContent] = React.useState<string | null>(null);
  const [fileLoading, setFileLoading] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setOpenFilePath(null);
      setFileContent(null);
      setFileError(null);
    }
  }, [open]);

  const handleOpenFile = async (relPath: string) => {
    setOpenFilePath(relPath);
    setFileContent(null);
    setFileError(null);
    setFileLoading(true);
    try {
      setFileContent(await getSkillFileContent(skillName, relPath));
    } catch (err) {
      setFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: APPLE_CURVE }}
            onClick={onClose}
            className="absolute inset-0 z-40 bg-[rgba(28,28,30,0.3)] backdrop-blur-[2px]"
          />
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.35, ease: APPLE_CURVE }}
            className="absolute inset-x-0 bottom-0 z-50 flex max-h-[75%] flex-col rounded-t-[24px] border-t border-border bg-background shadow-[0_-12px_40px_-20px_rgba(0,0,0,0.25)]"
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-border/60">
              <div className="flex items-center gap-2 min-w-0">
                {openFilePath && (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.9 }}
                    transition={{ duration: 0.15, ease: APPLE_CURVE }}
                    onClick={() => setOpenFilePath(null)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                    aria-label="返回文件列表"
                  >
                    <ArrowLeft size={14} />
                  </motion.button>
                )}
                <span className="truncate text-[12px] font-semibold text-foreground">
                  {openFilePath ?? '技能文件'}
                </span>
              </div>
              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                transition={{ duration: 0.15, ease: APPLE_CURVE }}
                onClick={onClose}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
                aria-label="关闭文件面板"
              >
                <X size={14} />
              </motion.button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-3">
              {openFilePath ? (
                fileLoading ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-muted-foreground">
                    <Loader2 size={14} className="animate-spin" />
                    <span className="text-[12px]">加载中…</span>
                  </div>
                ) : fileError ? (
                  <div className="rounded-[14px] bg-red-500/[0.06] border border-red-500/20 px-3.5 py-2.5 text-[11px] text-red-500">
                    {fileError}
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-[14px] bg-muted/50 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-foreground">
                    {fileContent ?? ''}
                  </pre>
                )
              ) : tree ? (
                Array.isArray(tree.children) && tree.children.length > 0 ? (
                  tree.children.map((child) => (
                    <FileTreeNode
                      key={child.name}
                      node={child}
                      path=""
                      depth={0}
                      onOpenFile={(relPath) => void handleOpenFile(relPath)}
                    />
                  ))
                ) : (
                  <div className="py-10 text-center text-[12px] text-muted-foreground">该技能没有附加文件</div>
                )
              ) : (
                <div className="py-10 text-center text-[12px] text-muted-foreground">文件树加载失败</div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
