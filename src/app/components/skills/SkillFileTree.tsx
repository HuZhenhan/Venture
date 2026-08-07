import { useState } from 'react';
import { motion } from 'motion/react';
import { ChevronDown, FileText, Folder } from 'lucide-react';
import { APPLE_CURVE } from '../../constants';
import { SkillFileNode } from '../../services/skillService';

interface SkillFileTreeProps {
  tree: SkillFileNode | null;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

interface TreeNodeProps {
  node: SkillFileNode;
  path: string;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

function formatSize(size?: number): string {
  if (size === undefined) return '';
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}M`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)}K`;
  return `${size}B`;
}

function TreeNode({ node, path, depth, selectedPath, onSelectFile }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth === 0);
  const nodePath = path ? `${path}/${node.name}` : node.name;
  // 后端数据防御：children 必须是数组（曾出现对象导致 .map 崩溃）
  const childList = Array.isArray(node.children) ? node.children : [];

  if (node.type === 'dir') {
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] text-foreground transition-colors hover:bg-muted/50"
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
        >
          <motion.span animate={{ rotate: expanded ? 0 : -90 }} transition={{ duration: 0.2, ease: APPLE_CURVE }} className="shrink-0 text-muted-foreground">
            <ChevronDown size={11} />
          </motion.span>
          <Folder size={12} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && childList.map((child) => (
          <TreeNode
            key={`${nodePath}/${child.name}`}
            node={child}
            path={nodePath}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    );
  }

  const isSelected = selectedPath === nodePath;
  return (
    <button
      type="button"
      onClick={() => onSelectFile(nodePath)}
      className={`flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-[12px] transition-colors ${
        isSelected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      }`}
      style={{ paddingLeft: `${depth * 12 + 22}px` }}
    >
      <FileText size={12} className="shrink-0" />
      <span className="truncate">{node.name}</span>
      {node.size !== undefined && (
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{formatSize(node.size)}</span>
      )}
    </button>
  );
}

export function SkillFileTree({ tree, selectedPath, onSelectFile }: SkillFileTreeProps) {
  if (!tree) {
    return <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">文件树加载中…</div>;
  }

  const children = tree.type === 'dir' && Array.isArray(tree.children) ? tree.children : [];
  if (children.length === 0) {
    return <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">空目录</div>;
  }

  return (
    <div className="space-y-0.5 py-1">
      {children.map((child) => (
        <TreeNode
          key={child.name}
          node={child}
          path=""
          depth={0}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
        />
      ))}
    </div>
  );
}
