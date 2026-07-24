import React, { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { PanelLeftClose, PanelRightClose } from "lucide-react";
import { APPLE_CURVE } from "../constants";

interface SidebarToggleButtonProps {
  isOpen: boolean;
  onClick: () => void;
  side?: "left" | "right";
  className?: string;
}

export function SidebarToggleButton({ isOpen, onClick, side = "left", className = "" }: SidebarToggleButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const Icon = side === "right" ? PanelRightClose : PanelLeftClose;
  const ariaLabel = side === "right" ? (isOpen ? "收起工作区" : "展开工作区") : (isOpen ? "收起侧边栏" : "展开侧边栏");

  // Electron 无边框窗口：直接设置 DOM style 确保 no-drag 生效，绕过 CSS/className 可能不生效的问题
  useEffect(() => {
    if (__IS_ELECTRON__ && buttonRef.current) {
      buttonRef.current.style.webkitAppRegion = 'no-drag';
    }
  }, []);

  return (
    <motion.button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.92 }}
      className={`flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-all hover:bg-muted/50 hover:text-foreground ${className}`}
      aria-label={ariaLabel}
    >
      <motion.div
        animate={{
          rotate: isOpen ? 0 : 180,
          scale: isOpen ? 1 : 0.94,
        }}
        transition={{
          duration: 0.42,
          ease: APPLE_CURVE,
        }}
        className="transform-gpu"
      >
        <Icon className="h-[18px] w-[18px]" />
      </motion.div>
    </motion.button>
  );
}
