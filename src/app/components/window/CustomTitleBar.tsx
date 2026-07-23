import React, { useEffect, useState } from 'react';

interface CustomTitleBarProps {
  className?: string;
}

const CustomTitleBar: React.FC<CustomTitleBarProps> = ({ className = '' }) => {
  const [isMaximized, setIsMaximized] = useState(false);

  const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  useEffect(() => {
    if (window.desktopShell) {
      window.desktopShell.isMaximized().then(setIsMaximized);
    }
  }, []);

  const handleMinimize = () => {
    window.desktopShell?.minimizeWindow();
  };

  const handleMaximizeToggle = async () => {
    if (window.desktopShell) {
      const maximized = await window.desktopShell.isMaximized();
      if (maximized) {
        window.desktopShell.unmaximizeWindow();
      } else {
        window.desktopShell.maximizeWindow();
      }
      setIsMaximized(!maximized);
    }
  };

  const handleClose = () => {
    window.desktopShell?.closeWindow();
  };

  return (
      <div className={`flex shrink-0 text-foreground ${className}`} style={noDragRegionStyle}>
        <button onClick={handleMinimize} className="flex h-[52px] w-11 items-center justify-center hover:bg-muted/70">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M1.5 6h9" />
          </svg>
        </button>
        <button onClick={handleMaximizeToggle} className="flex h-[52px] w-11 items-center justify-center hover:bg-muted/70">
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <path d="M4.5 4.5v-2h5v5h-2" />
              <rect x="2.5" y="4.5" width="5" height="5" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="2.5" y="2.5" width="7" height="7" />
            </svg>
          )}
        </button>
        <button onClick={handleClose} className="flex h-[52px] w-11 items-center justify-center hover:bg-red-500 hover:text-white">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      </div>
  );
};

export default CustomTitleBar;
