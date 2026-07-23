import React from 'react';
import { motion } from 'motion/react';
import { Zap, ArrowUpRight, ArrowDownRight, Database } from 'lucide-react';
import { APPLE_CURVE } from '../constants';
import { Message } from '../types';
import { useChatStore } from '../store/useChatStore';

interface UsagePanelProps {
  isOpen: boolean;
  width?: number;
}

function getCachedTokens(message: Message): number {
  return message.usage?.prompt_cache_hit_tokens ?? message.usage?.prompt_tokens_details?.cached_tokens ?? 0;
}

function formatTokenCount(value: number): { value: string; suffix: string } {
  const safeValue = Math.max(0, value);
  if (safeValue >= 1_000_000) return { value: (safeValue / 1_000_000).toFixed(1), suffix: 'M' };
  if (safeValue >= 1_000) return { value: (safeValue / 1_000).toFixed(1), suffix: 'K' };
  return { value: String(safeValue), suffix: '' };
}

export const UsagePanel: React.FC<UsagePanelProps> = ({ 
  isOpen, 
  width = 400 
}) => {
  const activeChat = useChatStore((state) => state.getActiveChat());
  const apiConfigs = useChatStore((state) => state.apiConfigs);
  const usageMessages = activeChat?.messages.filter((message) => message.role === 'ai' && message.usage) ?? [];
  const inputTokens = usageMessages.reduce((sum, message) => sum + (message.usage?.prompt_tokens ?? 0), 0);
  const outputTokens = usageMessages.reduce((sum, message) => sum + (message.usage?.completion_tokens ?? 0), 0);
  const totalTokens = usageMessages.reduce(
    (sum, message) => sum + (message.usage?.total_tokens ?? ((message.usage?.prompt_tokens ?? 0) + (message.usage?.completion_tokens ?? 0))),
    0
  );
  const cachedTokens = usageMessages.reduce((sum, message) => sum + getCachedTokens(message), 0);
  const cacheHitRate = inputTokens > 0 ? Math.round((cachedTokens / inputTokens) * 100) : 0;

  const lastUsageMessage = usageMessages.length > 0 ? usageMessages[usageMessages.length - 1] : null;
  const lastPromptTokens = lastUsageMessage?.usage?.prompt_tokens ?? 0;
  const lastOutputTokens = lastUsageMessage?.usage?.completion_tokens ?? 0;
  const lastTotalTokens = lastUsageMessage?.usage?.total_tokens ?? (lastPromptTokens + lastOutputTokens);

  const contextWindowK = apiConfigs.length > 0
    ? Math.max(...apiConfigs.map((c) => c.inputContextWindow ?? 0))
    : 0;
  const contextWindowTokens = contextWindowK * 1000;
  const contextUsageRate = contextWindowTokens > 0 ? Math.min(100, Math.round((lastTotalTokens / contextWindowTokens) * 100)) : 0;

  const totalDisplay = formatTokenCount(totalTokens);
  const inputDisplay = formatTokenCount(inputTokens);
  const outputDisplay = formatTokenCount(outputTokens);
  const cachedDisplay = formatTokenCount(cachedTokens);

  return (
    <motion.div
      initial={false}
      animate={{
        width: isOpen ? width : 0,
      }}
      transition={{ duration: 0.5, ease: APPLE_CURVE }}
      className={`shrink-0 h-full flex flex-col bg-sidebar z-20 overflow-hidden ${isOpen ? "border-l border-border" : "pointer-events-none"}`}
    >
      <div className="flex-1 flex flex-col h-full relative" style={{ width }}>
        {/* Content */}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-5 pb-8 pt-6 space-y-4 relative z-10">
          
          {/* Main Context Card (Bento Big) */}
          <div className="bg-background/80 backdrop-blur-xl rounded-[24px] p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02),0_8px_24px_rgba(0,0,0,0.02)] border border-border relative overflow-hidden group transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.04)]">
            <div className="relative z-10 flex items-start justify-between mb-8">
              <div className="space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em]">
                  <Database size={12} />
                  总上下文
                </div>
                <div className="text-[32px] leading-none font-semibold tracking-tighter text-foreground font-mono mt-2">
                  {totalDisplay.value}<span className="text-[16px] text-muted-foreground ml-0.5 font-medium">{totalDisplay.suffix} tokens</span>
                </div>
              </div>

              {/* Minimalist Ring */}
              <div className="w-14 h-14 relative flex items-center justify-center shrink-0">
                <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                  <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" className="text-black/[0.04]" strokeWidth="3" />
                  <motion.circle 
                    cx="18" cy="18" r="15" 
                    fill="none" 
                    stroke="currentColor" 
                    className="text-foreground"
                    strokeWidth="3" 
                    strokeLinecap="round" 
                    strokeDasharray="94.2" 
                    initial={{ strokeDashoffset: 94.2 }}
                    animate={{ strokeDashoffset: 94.2 * (1 - contextUsageRate / 100) }}
                    transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold font-mono text-foreground">{contextUsageRate}%</span>
              </div>
            </div>

            <div className="relative z-10 grid grid-cols-2 gap-px bg-muted/50 rounded-2xl overflow-hidden p-px">
              <div className="bg-background/90 backdrop-blur-md p-3 space-y-1 rounded-[15px] rounded-r-[4px]">
                <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <ArrowUpRight size={10} /> 输入提示
                </div>
                <div className="text-[14px] font-semibold text-foreground font-mono">{inputDisplay.value}<span className="text-[10px] text-muted-foreground ml-0.5">{inputDisplay.suffix} tokens</span></div>
              </div>
              <div className="bg-background/90 backdrop-blur-md p-3 space-y-1 rounded-[15px] rounded-l-[4px]">
                <div className="flex items-center gap-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <ArrowDownRight size={10} /> 模型生成
                </div>
                <div className="text-[14px] font-semibold text-foreground font-mono">{outputDisplay.value}<span className="text-[10px] text-muted-foreground ml-0.5">{outputDisplay.suffix} tokens</span></div>
              </div>
            </div>
          </div>

          {/* Cache Performance Card (Bento Medium) */}
          <div className="bg-background/80 backdrop-blur-xl rounded-[24px] p-5 shadow-[0_2px_8px_rgba(0,0,0,0.02),0_8px_24px_rgba(0,0,0,0.02)] border border-border relative overflow-hidden transition-shadow duration-500 hover:shadow-[0_8px_32px_rgba(0,0,0,0.04)]">
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-[0.2em] mb-4">
              <Zap size={12} />
              缓存命中
            </div>
            
            <div className="flex items-end justify-between mb-5">
              <div className="text-[24px] leading-none font-semibold tracking-tighter text-foreground font-mono">
                {cacheHitRate}<span className="text-[14px] text-muted-foreground ml-0.5 font-medium">%</span>
              </div>
              <div className="text-[11px] font-medium text-foreground bg-muted/50 px-2 py-1 rounded-md">
                节省了 {cachedDisplay.value}{cachedDisplay.suffix} tokens
              </div>
            </div>

            {/* Minimalist Segmented Bar */}
            <div className="h-1.5 w-full bg-muted/50 rounded-full overflow-hidden flex">
              <motion.div 
                className="h-full bg-[#1C1C1E] rounded-full" 
                initial={{ width: 0 }}
                animate={{ width: `${cacheHitRate}%` }}
                transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
              />
            </div>
          </div>

        </div>
      </div>
    </motion.div>
  );
};
