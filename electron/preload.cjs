const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  isDesktop: true,
  platform: process.platform,
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  unmaximizeWindow: () => ipcRenderer.send('unmaximize-window'),
  isMaximized: () => ipcRenderer.invoke('is-maximized'),
  closeWindow: () => ipcRenderer.send('close-window'),
  getBackendInfo: () => ipcRenderer.invoke('get-backend-info'),
  browserOpen: (payload) => ipcRenderer.invoke('browser-open', payload),
  browserNavigate: (url) => ipcRenderer.invoke('browser-navigate', url),
  browserSetBounds: (bounds) => ipcRenderer.send('browser-set-bounds', bounds),
  browserHide: () => ipcRenderer.send('browser-hide'),
  browserClose: () => ipcRenderer.send('browser-close'),
  browserBack: () => ipcRenderer.send('browser-back'),
  browserForward: () => ipcRenderer.send('browser-forward'),
  browserReload: () => ipcRenderer.send('browser-reload'),
  browserSummarizePreview: () => ipcRenderer.invoke('browser-summarize-preview'),
  onBrowserState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('browser-state', listener);
    return () => ipcRenderer.removeListener('browser-state', listener);
  },
});
