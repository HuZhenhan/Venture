import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ZoomIn, ZoomOut, Move } from 'lucide-react';
import { APPLE_CURVE, DURATION } from '../constants';

interface WorkflowNode {
  id: string;
  type: 'start' | 'llm' | 'search' | 'code' | 'condition' | 'end';
  title: string;
  subtitle?: string;
  x: number;
  y: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

const NODE_W = 160;
const NODE_H = 64;
const COL_GAP = 220;
const ROW_GAP = 160;
const START_X = 60;
const CENTER_Y = 220;

const MOCK_NODES: WorkflowNode[] = [
  { id: 'start', type: 'start', title: '开始', subtitle: '工作流入口', x: START_X, y: CENTER_Y, status: 'completed' },
  { id: 'search', type: 'search', title: '网页搜索', subtitle: '检索相关信息', x: START_X + COL_GAP, y: CENTER_Y - ROW_GAP / 2, status: 'completed' },
  { id: 'code-search', type: 'code', title: '代码检索', subtitle: '搜索代码库', x: START_X + COL_GAP, y: CENTER_Y + ROW_GAP / 2, status: 'completed' },
  { id: 'llm-process', type: 'llm', title: 'AI 处理', subtitle: '大模型推理', x: START_X + COL_GAP * 2, y: CENTER_Y, status: 'running' },
  { id: 'condition', type: 'condition', title: '条件判断', subtitle: '结果验证', x: START_X + COL_GAP * 3, y: CENTER_Y, status: 'pending' },
  { id: 'end', type: 'end', title: '结束', subtitle: '输出结果', x: START_X + COL_GAP * 4, y: CENTER_Y, status: 'pending' },
];

const MOCK_EDGES: WorkflowEdge[] = [
  { id: 'e1', source: 'start', target: 'search' },
  { id: 'e2', source: 'start', target: 'code-search' },
  { id: 'e3', source: 'search', target: 'llm-process' },
  { id: 'e4', source: 'code-search', target: 'llm-process' },
  { id: 'e5', source: 'llm-process', target: 'condition' },
  { id: 'e6', source: 'condition', target: 'end' },
];

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;
const WHEEL_ZOOM_FACTOR = 0.0015;

function getNodeStyle(type: WorkflowNode['type'], status: WorkflowNode['status']) {
  const typeIcons: Record<WorkflowNode['type'], string> = {
    start: '▶',
    end: '■',
    llm: '✦',
    search: '⌕',
    code: '</>',
    condition: '◇',
  };

  const statusStyles = {
    completed: {
      bg: 'color-mix(in srgb, var(--muted) 45%, var(--background))',
      border: 'color-mix(in srgb, var(--muted-foreground) 30%, transparent)',
      borderWidth: 1,
      iconBg: 'transparent',
      iconColor: 'var(--muted-foreground)',
      textColor: 'var(--muted-foreground)',
      subtitleColor: 'color-mix(in srgb, var(--muted-foreground) 65%, transparent)',
      checkColor: 'var(--muted-foreground)',
    },
    running: {
      bg: 'var(--background)',
      border: 'var(--foreground)',
      borderWidth: 1,
      iconBg: 'var(--foreground)',
      iconColor: 'var(--background)',
      textColor: 'var(--foreground)',
      subtitleColor: 'var(--muted-foreground)',
      checkColor: 'var(--foreground)',
    },
    failed: {
      bg: 'var(--muted)',
      border: 'var(--muted-foreground)',
      borderWidth: 1,
      iconBg: 'var(--muted-foreground)',
      iconColor: 'var(--background)',
      textColor: 'var(--muted-foreground)',
      subtitleColor: 'var(--muted-foreground)',
      checkColor: 'var(--muted-foreground)',
    },
    pending: {
      bg: 'var(--background)',
      border: 'var(--border)',
      borderWidth: 1,
      iconBg: 'var(--muted)',
      iconColor: 'var(--muted-foreground)',
      textColor: 'var(--muted-foreground)',
      subtitleColor: 'var(--muted-foreground)',
      checkColor: 'var(--muted-foreground)',
    },
  };

  const s = statusStyles[status];
  return { ...s, icon: typeIcons[type] };
}

function getEdgeStyle(sourceStatus: WorkflowNode['status'], targetStatus: WorkflowNode['status']) {
  const bothCompleted = sourceStatus === 'completed' && targetStatus === 'completed';
  const isActive = sourceStatus === 'completed' && targetStatus === 'running';

  if (isActive) {
    return { stroke: 'var(--foreground)', width: 1.5, opacity: 1, active: true };
  }
  if (bothCompleted || sourceStatus === 'completed') {
    return { stroke: 'var(--muted-foreground)', width: 1, opacity: 0.4, active: false };
  }
  return { stroke: 'var(--border)', width: 1, opacity: 1, active: false };
}

export const WorkflowCanvas = React.memo(function WorkflowCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.8);
  const [offset, setOffset] = useState({ x: 20, y: 20 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [offsetStart, setOffsetStart] = useState({ x: 0, y: 0 });
  // 触摸双指缩放状态
  const pinchRef = useRef<{ prevDist: number; prevZoom: number; prevOffsetX: number; prevOffsetY: number } | null>(null);

  const nodes = MOCK_NODES;
  const edges = MOCK_EDGES;

  const nodeMap = useMemo(() => {
    const map = new Map<string, WorkflowNode>();
    nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [nodes]);

  // Precompute scaled node positions for both SVG and HTML
  const scaledNodes = useMemo(() => {
    return nodes.map((n) => ({
      ...n,
      sx: n.x * zoom + offset.x,
      sy: n.y * zoom + offset.y,
      sw: NODE_W * zoom,
      sh: NODE_H * zoom,
    }));
  }, [nodes, zoom, offset]);

  const scaledNodeMap = useMemo(() => {
    const map = new Map<string, typeof scaledNodes[0]>();
    scaledNodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [scaledNodes]);

  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoom(0.8);
    setOffset({ x: 20, y: 20 });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY });
      setOffsetStart({ x: offset.x, y: offset.y });
    },
    [offset]
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isPanning) return;
      setOffset({
        x: offsetStart.x + (e.clientX - panStart.x),
        y: offsetStart.y + (e.clientY - panStart.y),
      });
    },
    [isPanning, panStart, offsetStart]
  );

  const handleMouseUp = useCallback(() => setIsPanning(false), []);

  useEffect(() => {
    if (isPanning) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isPanning, handleMouseMove, handleMouseUp]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * WHEEL_ZOOM_FACTOR;
      const newZoom = Math.min(Math.max(zoom + delta, MIN_ZOOM), MAX_ZOOM);

      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const ratio = newZoom / zoom;
        setZoom(newZoom);
        setOffset({ x: mx - (mx - offset.x) * ratio, y: my - (my - offset.y) * ratio });
      } else {
        setZoom(newZoom);
      }
    },
    [zoom, offset]
  );

  // ── 触摸事件（移动端单指拖拽 + 双指缩放）─────────────────────────
  // 使用 ref 跟踪最新值，避免 touchmove 高速事件中闭包捕获到过时的 state

  const zoomRef = useRef(zoom);
  const offsetRef = useRef(offset);
  useEffect(() => { zoomRef.current = zoom; }, [zoom]);
  useEffect(() => { offsetRef.current = offset; }, [offset]);

  const getTouchDistance = (touches: React.TouchList) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button')) return;

      if (e.touches.length === 1) {
        const t = e.touches[0];
        setIsPanning(true);
        setPanStart({ x: t.clientX, y: t.clientY });
        setOffsetStart({ x: offsetRef.current.x, y: offsetRef.current.y });
        pinchRef.current = null;
      } else if (e.touches.length === 2) {
        // 双指缩放：记录上一帧的 dist/zoom/offset，后续增量递推
        setIsPanning(false);
        const dist = getTouchDistance(e.touches);
        pinchRef.current = {
          dist: 0,  // 占位，handleTouchMove 首次会按 ratio=1 计算
          zoom: zoomRef.current,
          cx: 0,
          cy: 0,
          prevDist: dist,
          prevZoom: zoomRef.current,
          prevOffsetX: offsetRef.current.x,
          prevOffsetY: offsetRef.current.y,
        };
      }
    },
    []  // 只依赖 ref，无需 state 依赖
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 1 && isPanning) {
        const t = e.touches[0];
        setOffset({
          x: offsetStart.x + (t.clientX - panStart.x),
          y: offsetStart.y + (t.clientY - panStart.y),
        });
      } else if (e.touches.length === 2 && pinchRef.current) {
        const p = pinchRef.current;
        const dist = getTouchDistance(e.touches);
        const scale = dist / p.prevDist;  // 相对上一帧的缩放比
        const newZoom = Math.min(Math.max(p.prevZoom * scale, MIN_ZOOM), MAX_ZOOM);

        // 以当前两指中点为缩放中心
        const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;

        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const mx = cx - rect.left;
          const my = cy - rect.top;
          const zoomRatio = newZoom / p.prevZoom;  // 相对上一帧的 zoom 比
          const newOffsetX = mx - (mx - p.prevOffsetX) * zoomRatio;
          const newOffsetY = my - (my - p.prevOffsetY) * zoomRatio;

          // 更新 ref 供下一帧使用（绕过 React state 异步更新延迟）
          p.prevDist = dist;
          p.prevZoom = newZoom;
          p.prevOffsetX = newOffsetX;
          p.prevOffsetY = newOffsetY;

          setZoom(newZoom);
          setOffset({ x: newOffsetX, y: newOffsetY });
        } else {
          p.prevDist = dist;
          p.prevZoom = newZoom;
          setZoom(newZoom);
        }
      }
    },
    [isPanning, panStart, offsetStart]
  );

  const handleTouchEnd = useCallback(() => {
    setIsPanning(false);
    pinchRef.current = null;
  }, []);

  const zoomPercentage = Math.round(zoom * 100);
  const arrowSize = Math.max(4, 7 * zoom);

  return (
    <section
      ref={containerRef}
      aria-label="工作流画布"
      className="relative h-full w-full overflow-hidden bg-background select-none"
      style={{ cursor: isPanning ? 'grabbing' : 'grab', touchAction: 'none' }}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Grid background */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in srgb, var(--border) 35%, transparent) 1px, transparent 1px)',
          backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          backgroundPosition: `${offset.x}px ${offset.y}px`,
        }}
      />

      {/* Edges: straight lines with manual arrowheads, all in screen coordinates */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none"
        style={{ overflow: 'visible' }}
      >
        {edges.map((edge) => {
          const src = scaledNodeMap.get(edge.source);
          const tgt = scaledNodeMap.get(edge.target);
          if (!src || !tgt) return null;

          const sx = src.sx + src.sw;
          const sy = src.sy + src.sh / 2;
          const tx = tgt.sx;
          const ty = tgt.sy + tgt.sh / 2;

          const es = getEdgeStyle(src.status, tgt.status);

          // Compute arrowhead triangle
          const angle = Math.atan2(ty - sy, tx - sx);
          const ax = tx - arrowSize * Math.cos(angle);
          const ay = ty - arrowSize * Math.sin(angle);
          const a1x = ax + arrowSize * 0.5 * Math.cos(angle + Math.PI / 2);
          const a1y = ay + arrowSize * 0.5 * Math.sin(angle + Math.PI / 2);
          const a2x = ax - arrowSize * 0.5 * Math.cos(angle + Math.PI / 2);
          const a2y = ay - arrowSize * 0.5 * Math.sin(angle + Math.PI / 2);

          const lineEndX = tx - arrowSize * 0.8 * Math.cos(angle);
          const lineEndY = ty - arrowSize * 0.8 * Math.sin(angle);

          return (
            <g key={edge.id}>
              <line
                x1={sx}
                y1={sy}
                x2={lineEndX}
                y2={lineEndY}
                stroke={es.stroke}
                strokeWidth={es.width}
                strokeLinecap="round"
                opacity={es.opacity}
              />
              <polygon
                points={`${tx},${ty} ${a1x},${a1y} ${a2x},${a2y}`}
                fill={es.stroke}
                opacity={es.opacity}
              />
              {es.active && (
                <circle r={Math.max(2, 3 * zoom)} fill="var(--foreground)">
                  <animateMotion
                    dur="2s"
                    repeatCount="indefinite"
                    path={`M ${sx} ${sy} L ${lineEndX} ${lineEndY}`}
                    begin="0s"
                  />
                </circle>
              )}
            </g>
          );
        })}
      </svg>

      {/* Nodes: computed screen coordinates, text always sharp */}
      {scaledNodes.map((node) => {
        const style = getNodeStyle(node.type, node.status);
        const isRunning = node.status === 'running';
        const isCompleted = node.status === 'completed';
        const radius = Math.max(2, 8 * zoom);

        return (
          <motion.div
            key={node.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: DURATION.normal, ease: APPLE_CURVE, delay: 0.04 }}
            className="absolute"
            style={{ left: node.sx, top: node.sy, width: node.sw, height: node.sh }}
          >
            <div
              className="w-full h-full flex items-center relative overflow-hidden"
              style={{
                borderRadius: radius,
                backgroundColor: style.bg,
                borderWidth: style.borderWidth,
                borderColor: style.border,
                borderStyle: 'solid',
                padding: `0 ${12 * zoom}px`,
              }}
            >
              {isRunning && (
                <div
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    borderRadius: radius,
                    background:
                      'linear-gradient(90deg, transparent, color-mix(in srgb, var(--foreground) 5%, transparent), transparent)',
                    animation: 'shimmer 2.4s ease-in-out infinite',
                  }}
                />
              )}

              <div
                className="flex items-center relative z-10 w-full"
                style={{ gap: 10 * zoom }}
              >
                <div
                  className="flex items-center justify-center font-semibold shrink-0"
                  style={{
                    width: 28 * zoom,
                    height: 28 * zoom,
                    borderRadius: Math.max(2, radius * 0.7),
                    fontSize: 12 * zoom,
                    backgroundColor: style.iconBg,
                    color: style.iconColor,
                  }}
                >
                  {style.icon}
                </div>

                <div className="flex flex-col min-w-0 flex-1">
                  <span
                    className="font-medium truncate"
                    style={{ color: style.textColor, fontSize: 14 * zoom, lineHeight: 1.3 }}
                  >
                    {node.title}
                  </span>
                  {node.subtitle && (
                    <span
                      className="truncate"
                      style={{ color: style.subtitleColor, fontSize: 12 * zoom, lineHeight: 1.3 }}
                    >
                      {node.subtitle}
                    </span>
                  )}
                </div>

                {isCompleted && (
                  <svg
                    width={14 * zoom}
                    height={14 * zoom}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={style.checkColor}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="shrink-0"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}

                {isRunning && (
                  <div
                    className="rounded-full bg-foreground animate-pulse shrink-0"
                    style={{ width: 8 * zoom, height: 8 * zoom }}
                  />
                )}
              </div>
            </div>
          </motion.div>
        );
      })}

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 z-10">
        <div className="flex items-center gap-0.5 rounded-xl border border-border bg-background/80 backdrop-blur-md p-1 shadow-lg">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleZoomOut}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="缩小"
          >
            <ZoomOut size={16} strokeWidth={1.5} />
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleResetZoom}
            className="h-8 px-2 rounded-lg flex items-center justify-center text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors min-w-[48px]"
            aria-label="重置缩放"
          >
            {zoomPercentage}%
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={handleZoomIn}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="放大"
          >
            <ZoomIn size={16} strokeWidth={1.5} />
          </motion.button>
        </div>
      </div>

      {/* Pan indicator */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: isPanning ? 1 : 0 }}
        transition={{ duration: DURATION.micro }}
        className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-full bg-background/80 backdrop-blur-md border border-border text-xs text-muted-foreground pointer-events-none z-10"
      >
        <Move size={12} />
        <span>拖拽移动视图</span>
      </motion.div>

      <style>{`
        @keyframes shimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
      `}</style>
    </section>
  );
});
