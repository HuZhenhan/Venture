interface FloatingPositionOptions {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function resolveFloatingPosition({
  x,
  y,
  width,
  height,
}: FloatingPositionOptions): { left: number; top: number } {
  return {
    left: Math.min(x, window.innerWidth - width),
    top: Math.min(y, window.innerHeight - height),
  };
}
