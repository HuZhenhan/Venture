export interface HorizontalResizeConfig {
  startEvent: React.MouseEvent;
  initialWidth: number;
  minWidth: number;
  maxWidth: number;
  direction: 'expand-right' | 'expand-left';
  setWidth: (width: number) => void;
  setIsResizing: (isResizing: boolean) => void;
  getActualWidth?: () => number;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

function getNextWidth(config: HorizontalResizeConfig, deltaX: number): number {
  const signedDelta = config.direction === 'expand-right' ? deltaX : -deltaX;
  const desiredWidth = config.initialWidth + signedDelta;
  return Math.max(config.minWidth, Math.min(config.maxWidth, desiredWidth));
}

export function beginHorizontalResize(config: HorizontalResizeConfig): void {
  config.onResizeStart?.();
  config.setIsResizing(true);

  let currentX = config.startEvent.clientX;
  let currentWidth = config.initialWidth;

  const handleMouseMove = (moveEvent: MouseEvent) => {
    const deltaX = moveEvent.clientX - currentX;
    const nextWidth = getNextWidth({ ...config, initialWidth: currentWidth }, deltaX);
    config.setWidth(nextWidth);

    const actualWidth = config.getActualWidth?.();
    if (actualWidth !== undefined) {
      currentWidth = actualWidth;
    } else {
      currentWidth = nextWidth;
    }
    currentX = moveEvent.clientX;
  };

  const handleMouseUp = () => {
    config.setIsResizing(false);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'default';
    config.onResizeEnd?.();
  };

  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
  document.body.style.cursor = 'col-resize';
}
