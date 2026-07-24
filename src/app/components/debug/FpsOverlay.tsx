import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useLayoutStore } from '../../store/useLayoutStore';

const MAX_FPS_HISTORY = 100; // Number of FPS values to keep in history

// Simple clamp function, can be moved to a utility file if needed
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// Helper to format bytes to a human-readable string
function formatBytes(bytes: number, decimals = 2) {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function FpsOverlay() {
  const showFpsOverlay = useLayoutStore((state) => state.showFpsOverlay);
  const [fps, setFps] = useState(0);
  const [minRecordedFps, setMinRecordedFps] = useState(0);
  const [fpsHistory, setFpsHistory] = useState<number[]>([]);
  const [memoryUsage, setMemoryUsage] = useState<{ used: string; total: string } | null>(null);
  const lastFrameTimeRef = useRef(performance.now());
  const animationFrameIdRef = useRef<number | null>(null);

  const updateFpsAndMemory = useCallback(() => {
    const now = performance.now();
    const deltaTime = now - lastFrameTimeRef.current;
    lastFrameTimeRef.current = now;
    const currentFps = 1000 / deltaTime;

    setFps(Math.round(currentFps));
    setFpsHistory((prevHistory) => {
      const newHistory = [...prevHistory, currentFps];
      if (newHistory.length > MAX_FPS_HISTORY) {
        const slicedHistory = newHistory.slice(newHistory.length - MAX_FPS_HISTORY);
        setMinRecordedFps(Math.round(Math.min(...slicedHistory)));
        return slicedHistory;
      }
      setMinRecordedFps(Math.round(Math.min(...newHistory)));
      return newHistory;
    });

    // Update memory usage if available
    if (performance.memory) {
      setMemoryUsage({
        used: formatBytes(performance.memory.usedJSHeapSize),
        total: formatBytes(performance.memory.totalJSHeapSize),
      });
    }

    animationFrameIdRef.current = requestAnimationFrame(updateFpsAndMemory);
  }, []);

  useEffect(() => {
    if (showFpsOverlay) {
      lastFrameTimeRef.current = performance.now();
      animationFrameIdRef.current = requestAnimationFrame(updateFpsAndMemory);
    } else {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
        animationFrameIdRef.current = null;
      }
      setFps(0);
      setMinRecordedFps(0);
      setFpsHistory([]);
      setMemoryUsage(null);
    }
    return () => {
      if (animationFrameIdRef.current) {
        cancelAnimationFrame(animationFrameIdRef.current);
      }
    };
  }, [showFpsOverlay, updateFpsAndMemory]);

  if (!showFpsOverlay) {
    return null;
  }

  // Simple visualization using SVG
  const maxFpsValue = 60;
  const minFpsValue = 0;
  const height = 50;
  const width = 200;
  const points = fpsHistory
    .map((f, i) => {
      const x = (i / (MAX_FPS_HISTORY - 1)) * width;
      const y = height - ((clamp(f, minFpsValue, maxFpsValue) - minFpsValue) / (maxFpsValue - minFpsValue)) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      zIndex: 9999,
      background: 'rgba(0,0,0,0.7)',
      color: 'white',
      padding: '5px 10px',
      fontFamily: 'monospace',
      fontSize: '12px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      borderRadius: '0 0 8px 0',
    }}>
      <div>FPS: {fps} (Min: {minRecordedFps})</div>
      {memoryUsage && (
        <div>Mem: {memoryUsage.used} / {memoryUsage.total}</div>
      )}
      <svg width={width} height={height} style={{ background: 'rgba(255,255,255,0.1)', marginTop: '5px' }}>
        <polyline
          fill="none"
          stroke="#00ff00"
          strokeWidth="1"
          points={points}
        />
        {/* Reference lines */}
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.3)" strokeDasharray="2" />
        <text x="5" y="15" fill="white" fontSize="8">{maxFpsValue}</text>
        <text x="5" y={height - 5} fill="white" fontSize="8">{minFpsValue}</text>
      </svg>
    </div>
  );
}

