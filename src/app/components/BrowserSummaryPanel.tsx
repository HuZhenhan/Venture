import React from 'react';
import { X } from 'lucide-react';
import { type BrowserSummary, type BrowserSummaryChunk } from '../types';

interface BrowserSummaryPanelProps {
  summary: BrowserSummary | null;
  onClose: () => void;
}

const ChunkRenderer: React.FC<{ chunk: BrowserSummaryChunk }> = ({ chunk }) => {
  const baseClasses = 'px-4 py-2 mb-3 rounded-md';

  switch (chunk.type) {
    case 'heading':
      const headingLevel = chunk.level || 2;
      const headingClasses = {
        1: 'text-2xl font-bold',
        2: 'text-xl font-bold',
        3: 'text-lg font-bold',
        4: 'text-base font-bold',
        5: 'text-sm font-bold',
        6: 'text-xs font-bold',
      };
      return (
        <div className={`${baseClasses} bg-primary/5 border-l-4 border-primary`}>
          <div className={headingClasses[headingLevel as keyof typeof headingClasses]}>
            {chunk.content}
          </div>
        </div>
      );

    case 'code':
      return (
        <div className={`${baseClasses} bg-muted/50 border border-border font-mono text-xs`}>
          <pre className='whitespace-pre-wrap break-words overflow-x-auto'>
            <code>{chunk.content}</code>
          </pre>
        </div>
      );

    case 'quote':
      return (
        <div className={`${baseClasses} bg-muted/30 border-l-4 border-muted-foreground italic`}>
          {chunk.content}
        </div>
      );

    case 'list':
      return (
        <div className={`${baseClasses} bg-muted/20 pl-6`}>
          <ul className='list-disc space-y-1'>
            {chunk.content.split('\n').filter(Boolean).map((item, idx) => (
              <li key={idx} className='text-sm'>
                {item}
              </li>
            ))}
          </ul>
        </div>
      );

    default:
      return (
        <div className={`${baseClasses} text-sm leading-relaxed text-foreground/90`}>
          {chunk.content}
        </div>
      );
  }
};

export const BrowserSummaryPanel: React.FC<BrowserSummaryPanelProps> = ({
  summary,
  onClose,
}) => {
  if (!summary) return null;

  return (
    <div className='flex flex-col h-full bg-background border-l border-border overflow-hidden'>
      <div className='flex items-center justify-between shrink-0 border-b border-border px-4 py-3'>
        <div className='flex flex-col gap-1'>
          <h3 className='text-sm font-semibold text-foreground'>网页摘要</h3>
          <p className='text-xs text-muted-foreground truncate'>{summary.url}</p>
        </div>
        <button
          onClick={onClose}
          className='flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground'
          aria-label='关闭摘要面板'
        >
          <X size={16} />
        </button>
      </div>

      <div className='flex-1 overflow-y-auto p-4'>
        {summary.status === 'failed' ? (
          <div className='rounded-lg border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive'>
            {summary.error || '摘取失败'}
          </div>
        ) : (
          <div className='space-y-1'>
            {summary.chunks.length === 0 ? (
              <div className='text-xs text-muted-foreground text-center py-8'>
                未找到可摘取的内容
              </div>
            ) : (
              summary.chunks.map((chunk) => (
                <ChunkRenderer key={chunk.id} chunk={chunk} />
              ))
            )}
          </div>
        )}
      </div>

      <div className='shrink-0 border-t border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground'>
        {summary.chunks.length} 个内容块 · {new Date(summary.timestamp).toLocaleTimeString()}
      </div>
    </div>
  );
};