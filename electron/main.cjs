const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app, BrowserWindow, BrowserView, shell, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const readline = require('node:readline');
const { runBrowserSummaryPreview } = require('./browser-summary-preview.cjs');

const DEV_SERVER_URL = 'http://127.0.0.1:5174';
const BACKEND_PORT = Number(process.env.VENTURE_BACKEND_PORT) || 49527;
const BACKEND_BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const BACKEND_STOP_GRACE_MS = 3000;

let backendProcess = null;
let backendReady = false;
let backendNonce = null;
let backendPid = null;
let backendStartedAt = null;
let logStream = null;
let latestStream = null;
let logFilePath = null;
let logStreamsClosed = false;
let ipcRegistered = false;
let mainWindowRef = null;
let browserViewRef = null;
let browserVisible = false;
let backendRestartPromise = null;

const BROWSER_DEFAULT_URL = 'https://www.bing.com';

function getLogsDir() {
  if (app.isPackaged) {
    return path.join(app.getPath('userData'), 'logs');
  }
  return path.join(__dirname, '..', 'logs');
}

function initLogger() {
  try {
    const logDir = getLogsDir();
    fs.mkdirSync(logDir, { recursive: true });

    const now = new Date();
    const tzOffset = now.getTimezoneOffset() * 60000;
    const localISO = new Date(now.getTime() - tzOffset).toISOString();
    const dateStr = localISO.slice(0, 10);
    const timeStr = localISO.slice(11, 19).replace(/:/g, '-');
    logFilePath = path.join(logDir, `venture-${dateStr}_${timeStr}.log`);
    const latestPath = path.join(logDir, 'latest.log');

    logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
    try { latestStream = fs.createWriteStream(latestPath, { flags: 'w' }); } catch (_) {}

    const origLog = console.log.bind(console);
    const origWarn = console.warn.bind(console);
    const origError = console.error.bind(console);

    const stamp = () => {
      const now = new Date();
      const tzOffset = now.getTimezoneOffset() * 60000;
      return new Date(now.getTime() - tzOffset).toISOString().slice(0, -1);
    };

    const writeLine = (line) => {
      if (logStreamsClosed) return;
      try {
        if (logStream && !logStream.destroyed) logStream.write(line);
      } catch (_) {}
      try {
        if (latestStream && !latestStream.destroyed) latestStream.write(line);
      } catch (_) {}
    };

    const formatArgs = (args) => args.map(x => (x instanceof Error ? x.stack : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ');

    console.log = (...a) => {
      writeLine(`[${stamp()}] [INFO]  ${formatArgs(a)}\n`);
      origLog(...a);
    };
    console.warn = (...a) => {
      writeLine(`[${stamp()}] [WARN]  ${formatArgs(a)}\n`);
      origWarn(...a);
    };
    console.error = (...a) => {
      writeLine(`[${stamp()}] [ERROR] ${formatArgs(a)}\n`);
      origError(...a);
    };

    const sep = '='.repeat(72);
    console.log(sep);
    console.log('Venture GUI  —  Session Start');
    console.log(sep);
    console.log(`[logger]  log file      : ${logFilePath}`);
    console.log(`[logger]  latest.log    : ${latestPath}`);
    console.log(sep);
    console.log(`[env]  app version      : ${app.getVersion()}`);
    console.log(`[env]  electron         : ${process.versions.electron}`);
    console.log(`[env]  node             : ${process.versions.node}`);
    console.log(`[env]  chrome           : ${process.versions.chrome}`);
    console.log(`[env]  v8               : ${process.versions.v8}`);
    console.log(`[env]  packaged         : ${app.isPackaged}`);
    console.log(`[env]  exe path         : ${app.getPath('exe')}`);
    console.log(`[env]  app path         : ${app.getAppPath()}`);
    console.log(`[env]  userData         : ${app.getPath('userData')}`);
    console.log(`[env]  resourcesPath    : ${process.resourcesPath}`);
    console.log(`[env]  cwd              : ${process.cwd()}`);
    console.log(`[env]  __dirname        : ${__dirname}`);
    console.log(sep);
    console.log(`[sys]  platform         : ${process.platform}  (${os.type()} ${os.release()})`);
    console.log(`[sys]  arch             : ${process.arch}  /  os.arch=${os.arch()}`);
    console.log(`[sys]  hostname         : ${os.hostname()}`);
    console.log(`[sys]  cpu model        : ${os.cpus()[0]?.model ?? 'unknown'}  x${os.cpus().length}`);
    console.log(`[sys]  total memory     : ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
    console.log(`[sys]  free memory      : ${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`);
    console.log(`[sys]  uptime           : ${Math.floor(os.uptime() / 60)} min`);
    console.log(`[sys]  locale           : ${app.getLocale()}`);
    console.log(sep);
    console.log(`[net]  backend port     : ${BACKEND_PORT}`);
    console.log(`[net]  backend base url : ${BACKEND_BASE_URL}`);
    console.log(`[net]  dev server url   : ${DEV_SERVER_URL}`);
    console.log(sep);

    cleanOldLogs(logDir);
  } catch (err) {
    process.stderr.write(`[main] logger init failed: ${err.message}\n`);
  }
}

function cleanOldLogs(logDir, keepDays = 7) {
  try {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    fs.readdir(logDir, (err, files) => {
      if (err) return;
      files.forEach(f => {
        if (f === 'latest.log') return;
        const full = path.join(logDir, f);
        fs.stat(full, (err, stat) => {
          if (err) return;
          if (stat.mtimeMs < cutoff) {
            fs.unlink(full, err => {
              if (!err) process.stdout.write(`[logger] removed old log: ${f}\n`);
            });
          }
        });
      });
    });
  } catch (_) {}
}

function getBackendExePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'venture-backend.exe');
  }
  const gnuPath = path.join(__dirname, '..', 'backend', 'target', 'x86_64-pc-windows-gnu', 'debug', 'venture-backend.exe');
  const msvcPath = path.join(__dirname, '..', 'backend', 'target', 'debug', 'venture-backend.exe');
  if (fs.existsSync(gnuPath)) return gnuPath;
  return msvcPath;
}

function getWebEntryPath() {
  if (app.isPackaged) {
    const p = path.join(app.getAppPath(), 'dist', 'web', 'index.html');
    console.log(`[main] web entry (packaged): ${p}, exists=${fs.existsSync(p)}`);
    return p;
  }
  return null;
}

function tcpProbe(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host });
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      resolve({ ok, err });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, new Error('timeout')));
    sock.once('error', (err) => finish(false, err));
  });
}

function fetchHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_BASE_URL}/health`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, err: new Error(`status=${res.statusCode}`) });
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > 8 * 1024) {
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const json = JSON.parse(body);
          resolve({ ok: true, data: json });
        } catch (err) {
          resolve({ ok: false, err });
        }
      });
      res.on('error', (err) => resolve({ ok: false, err }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (err) => resolve({ ok: false, err }));
  });
}

async function waitForBackend(retries = 40, delayMs = 300) {
  for (let n = 0; n < retries; n += 1) {
    if (backendProcess === null) {
      console.warn('[backend] process exited early, aborting wait');
      return false;
    }
    const probe = await tcpProbe(BACKEND_PORT);
    if (probe.ok) {
      const health = await fetchHealth();
      if (health.ok && health.data && typeof health.data === 'object') {
        const { pid, nonce } = health.data;
        if (backendProcess && pid && pid !== backendProcess.pid) {
          console.error(`[backend] health pid mismatch: expected=${backendProcess.pid} got=${pid} — port may be hijacked`);
          return false;
        }
        if (!nonce || typeof nonce !== 'string') {
          console.warn('[backend] health missing nonce, continuing but marking unauthenticated');
        }
        backendNonce = nonce ?? null;
        backendPid = pid ?? backendProcess?.pid ?? null;
        backendStartedAt = health.data.startedAt ?? null;
        console.log(`[backend] ready — pid=${backendPid} nonce=${backendNonce ? backendNonce.slice(0, 8) + '...' : 'n/a'}`);
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.warn('[backend] not ready after all retries');
  return false;
}

function startBackend() {
  const exePath = getBackendExePath();
  console.log(`[backend] exe path : ${exePath}`);
  console.log(`[backend] exists   : ${fs.existsSync(exePath)}`);

  if (!fs.existsSync(exePath)) {
    console.error(`[backend] FATAL — exe not found at: ${exePath}`);
    console.error('[backend] searched paths:');
    console.error(`  (packaged) ${path.join(process.resourcesPath ?? '', 'venture-backend.exe')}`);
    console.error(`  (gnu)      ${path.join(__dirname, '..', 'backend', 'target', 'x86_64-pc-windows-gnu', 'debug', 'venture-backend.exe')}`);
    console.error(`  (msvc)     ${path.join(__dirname, '..', 'backend', 'target', 'debug', 'venture-backend.exe')}`);
    return;
  }

  try {
    const env = { ...process.env, VENTURE_BACKEND_PORT: String(BACKEND_PORT) };
    backendProcess = spawn(exePath, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    console.log(`[backend] spawned — pid=${backendProcess.pid}`);

    backendProcess.stdout.on('data', (d) => {
      d.toString().split('\n').forEach(line => {
        line = line.trim();
        if (line) console.log(`[backend:stdout] ${line}`);
      });
    });
    backendProcess.stderr.on('data', (d) => {
      d.toString().split('\n').forEach(line => {
        line = line.trim();
        if (line) console.warn(`[backend:stderr] ${line}`);
      });
    });
    backendProcess.on('error', (err) => {
      console.error(`[backend] process error: ${err.message}`);
    });
    backendProcess.on('exit', (code, signal) => {
      console.log(`[backend] exited — code=${code ?? 'null'}  signal=${signal ?? 'null'}`);
      backendProcess = null;
      backendReady = false;
      backendNonce = null;
      backendPid = null;
      backendStartedAt = null;
    });
  } catch (err) {
    console.error(`[backend] spawn failed: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

async function stopBackend() {
  const proc = backendProcess;
  if (!proc) return;
  const pid = proc.pid;
  try {
    console.log(`[backend] stopping pid=${pid}`);
  } catch (_) {}

  const exited = new Promise((resolve) => {
    proc.once('exit', () => resolve(true));
  });

  try {
    proc.kill('SIGTERM');
  } catch (err) {
    try { console.warn(`[backend] SIGTERM failed: ${err.message}`); } catch (_) {}
  }

  const timedOut = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(false), BACKEND_STOP_GRACE_MS)),
  ]);

  if (!timedOut) {
    try { console.warn(`[backend] grace period exceeded, forcing SIGKILL pid=${pid}`); } catch (_) {}
    try {
      proc.kill('SIGKILL');
    } catch (err) {
      try { console.warn(`[backend] SIGKILL failed: ${err.message}`); } catch (_) {}
    }
    if (process.platform === 'win32' && pid) {
      try {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch (_) {}
    }
  }

  backendProcess = null;
  backendReady = false;
  backendNonce = null;
  backendPid = null;
  backendStartedAt = null;
}

async function restartBackendForDev() {
  if (app.isPackaged) {
    console.warn('[dev-control] restart backend ignored in packaged mode');
    return;
  }
  if (backendRestartPromise) {
    console.log('[dev-control] backend restart already in progress');
    return backendRestartPromise;
  }

  backendRestartPromise = (async () => {
    console.log('[dev-control] restarting backend');
    await stopBackend();
    startBackend();
    backendReady = await waitForBackend();
    if (backendReady) {
      console.log('[dev-control] backend restarted successfully');
    } else {
      console.warn('[dev-control] backend restart finished but health check failed');
    }
  })().finally(() => {
    backendRestartPromise = null;
  });

  return backendRestartPromise;
}

function reloadFrontendForDev() {
  if (app.isPackaged) {
    console.warn('[dev-control] reload frontend ignored in packaged mode');
    return;
  }
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    console.log('[dev-control] creating window for reloaded frontend');
    createMainWindow();
    return;
  }
  console.log('[dev-control] reloading frontend');
  mainWindowRef.webContents.reloadIgnoringCache();
}

function handleDevControlLine(rawLine) {
  const line = String(rawLine ?? '').trim().toLowerCase();
  if (!line) return;
  if (line === 'restart backend') {
    void restartBackendForDev();
    return;
  }
  if (line === 'reload frontend') {
    reloadFrontendForDev();
    return;
  }
  console.warn(`[dev-control] unknown command: ${rawLine}`);
}

function setupDevControlInput() {
  if (app.isPackaged || !process.stdin.readable) return;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', handleDevControlLine);
  rl.on('error', (err) => {
    console.warn(`[dev-control] stdin error: ${err.message}`);
  });
  console.log('[dev-control] stdin ready');
}

function safeOpenExternal(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096) {
    console.warn(`[window] rejected external open: invalid url`);
    return false;
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    console.warn(`[window] rejected external open: parse failed — ${err.message}`);
    return false;
  }
  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    console.warn(`[window] rejected external open: protocol=${parsed.protocol}`);
    return false;
  }
  console.log(`[window] open-external: ${parsed.href}`);
  shell.openExternal(parsed.href).catch((err) => {
    console.warn(`[window] shell.openExternal failed: ${err.message}`);
  });
  return true;
}

function normalizeBrowserUrl(input) {
  const value = String(input || '').trim();
  if (!value) return BROWSER_DEFAULT_URL;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.includes('.') && !value.includes(' ')) return `https://${value}`;
  return `https://www.bing.com/search?q=${encodeURIComponent(value)}`;
}

function getBrowserWebContents() {
  return browserViewRef?.webContents ?? null;
}

function sendBrowserState(extra = {}) {
  const wc = getBrowserWebContents();
  if (!mainWindowRef || !wc || mainWindowRef.isDestroyed()) return;
  try {
    mainWindowRef.webContents.send('browser-state', {
      url: wc.getURL() || BROWSER_DEFAULT_URL,
      title: wc.getTitle() || '',
      canGoBack: wc.canGoBack(),
      canGoForward: wc.canGoForward(),
      isLoading: wc.isLoading(),
      visible: browserVisible,
      ...extra,
    });
  } catch (err) {
    console.warn(`[browser] send state failed: ${err.message}`);
  }
}

function ensureBrowserView() {
  if (!mainWindowRef || mainWindowRef.isDestroyed()) {
    throw new Error('main window is not available');
  }
  if (browserViewRef && !browserViewRef.webContents.isDestroyed()) {
    return browserViewRef;
  }

  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      javascript: true,
    },
  });

  browserViewRef = view;
  mainWindowRef.addBrowserView(view);
  view.setAutoResize({ width: false, height: false, horizontal: false, vertical: false });

  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    try {
      wc.loadURL(normalizeBrowserUrl(url));
    } catch (err) {
      console.warn(`[browser] open in-place failed: ${err.message}`);
      safeOpenExternal(url);
    }
    return { action: 'deny' };
  });
  wc.on('did-start-loading', () => sendBrowserState({ isLoading: true }));
  wc.on('did-stop-loading', () => sendBrowserState({ isLoading: false }));
  wc.on('did-navigate', (_event, url) => sendBrowserState({ url }));
  wc.on('did-navigate-in-page', (_event, url) => sendBrowserState({ url }));
  wc.on('page-title-updated', (_event, title) => sendBrowserState({ title }));
  wc.on('did-fail-load', (_event, code, desc, url) => {
    console.warn(`[browser] page load failed code=${code} desc="${desc}" url=${url}`);
    sendBrowserState({ isLoading: false, error: desc, url });
  });

  console.log('[browser] BrowserView created');
  return view;
}

function detachBrowserView() {
  if (!mainWindowRef || !browserViewRef) return;
  try {
    mainWindowRef.removeBrowserView(browserViewRef);
  } catch (_) {}
  try {
    browserViewRef.webContents.destroy();
  } catch (_) {}
  browserViewRef = null;
  browserVisible = false;
}

function setBrowserBounds(bounds) {
  if (!browserViewRef) return;
  const visible = bounds?.visible !== false;
  browserVisible = visible;
  const next = visible
    ? {
        x: Math.max(0, Math.round(Number(bounds?.x) || 0)),
        y: Math.max(0, Math.round(Number(bounds?.y) || 0)),
        width: Math.max(0, Math.round(Number(bounds?.width) || 0)),
        height: Math.max(0, Math.round(Number(bounds?.height) || 0)),
      }
    : { x: 0, y: 0, width: 0, height: 0 };
  try {
    browserViewRef.setBounds(next);
    if (visible) mainWindowRef?.setTopBrowserView(browserViewRef);
  } catch (err) {
    console.warn(`[browser] set bounds failed: ${err.message}`);
  }
}

function registerIpcHandlers() {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.on('minimize-window', () => {
    try { mainWindowRef?.minimize(); } catch (_) {}
  });
  ipcMain.on('maximize-window', () => {
    try { mainWindowRef?.maximize(); } catch (_) {}
  });
  ipcMain.on('unmaximize-window', () => {
    try { mainWindowRef?.unmaximize(); } catch (_) {}
  });
  ipcMain.handle('is-maximized', () => {
    try { return mainWindowRef?.isMaximized() ?? false; } catch (_) { return false; }
  });
  ipcMain.on('close-window', () => {
    try { mainWindowRef?.close(); } catch (_) {}
  });

  ipcMain.handle('get-backend-info', () => ({
    baseUrl: BACKEND_BASE_URL,
    ready: backendReady,
    port: BACKEND_PORT,
    nonce: backendNonce,
    pid: backendPid,
    startedAt: backendStartedAt,
  }));

  ipcMain.handle('browser-open', async (_event, payload = {}) => {
    const view = ensureBrowserView();
    setBrowserBounds({ ...payload.bounds, visible: true });
    const target = normalizeBrowserUrl(payload.url || view.webContents.getURL() || BROWSER_DEFAULT_URL);
    if (view.webContents.getURL() !== target) {
      await view.webContents.loadURL(target);
    }
    sendBrowserState({ visible: true, url: view.webContents.getURL() || target });
    return true;
  });

  ipcMain.handle('browser-navigate', async (_event, url) => {
    const view = ensureBrowserView();
    const target = normalizeBrowserUrl(url);
    await view.webContents.loadURL(target);
    sendBrowserState({ url: target, visible: browserVisible });
    return true;
  });

  ipcMain.on('browser-set-bounds', (_event, bounds) => {
    if (!browserViewRef && bounds?.visible === false) return;
    ensureBrowserView();
    setBrowserBounds(bounds);
    sendBrowserState();
  });

  ipcMain.on('browser-hide', () => {
    setBrowserBounds({ visible: false });
    sendBrowserState({ visible: false });
  });

  ipcMain.on('browser-close', () => {
    detachBrowserView();
    sendBrowserState({ visible: false });
  });

  ipcMain.on('browser-back', () => {
    const wc = getBrowserWebContents();
    if (wc?.canGoBack()) wc.goBack();
  });

  ipcMain.on('browser-forward', () => {
    const wc = getBrowserWebContents();
    if (wc?.canGoForward()) wc.goForward();
  });

  ipcMain.on('browser-reload', () => {
    const wc = getBrowserWebContents();
    if (wc) wc.reload();
  });

  ipcMain.handle('browser-summarize-preview', async () => {
    const wc = getBrowserWebContents();
    if (!wc) throw new Error('当前没有可用的浏览器页面');
    let result;
    try {
      result = await runBrowserSummaryPreview(wc);
    } catch (err) {
      result = { success: false, chunks: [], error: (err && err.message) ? err.message : String(err) };
    }
    const success = !!(result && result.success);
    const url = (() => {
      try { return wc.getURL() || ''; } catch (_) { return ''; }
    })();
    return {
      id: 'sum-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
      url,
      timestamp: Date.now(),
      chunks: (result && Array.isArray(result.chunks)) ? result.chunks : [],
      status: success ? 'completed' : 'failed',
      error: success ? undefined : (result && result.error) || '摘取失败',
    };
  });
}

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1540,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d12',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      webviewTag: false,
    },
  });

  mainWindowRef = mainWindow;
  mainWindow.on('closed', () => {
    detachBrowserView();
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  mainWindow.once('ready-to-show', () => {
    console.log('[window] ready-to-show — displaying');
    mainWindow.show();
  });

  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => {
    console.error(`[window] page load FAILED — code=${code}  desc="${desc}"  url=${url}`);
    if (!app.isPackaged) {
      console.error(`[window] hint: is the dev server running on ${DEV_SERVER_URL} ?`);
    } else {
      const entry = getWebEntryPath();
      console.error(`[window] hint: packaged entry exists=${fs.existsSync(entry ?? '')}`);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[window] page loaded successfully');
  });

  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error(`[window] renderer process gone — reason=${details.reason}  exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[window] renderer became UNRESPONSIVE');
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('[window] renderer responsive again');
  });

  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level < 2) return;
    const lvlMap = ['LOG', 'WARN', 'ERROR', 'DEBUG'];
    const lvl = lvlMap[level] ?? 'LOG';
    const src = sourceId ? ` (${path.basename(sourceId)}:${line})` : '';
    if (level === 2) {
      console.error(`[renderer:${lvl}]${src} ${message}`);
    } else if (level === 1) {
      console.warn(`[renderer:${lvl}]${src} ${message}`);
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    safeOpenExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const currentUrl = mainWindow.webContents.getURL();
      const currentParsed = currentUrl ? new URL(currentUrl) : null;
      const sameOrigin = currentParsed && parsed.origin === currentParsed.origin;
      if (!sameOrigin) {
        event.preventDefault();
        safeOpenExternal(url);
      }
    } catch (_) {
      event.preventDefault();
    }
  });

  if (app.isPackaged) {
    const entryFile = getWebEntryPath();
    console.log(`[window] loading file: ${entryFile}`);
    mainWindow.loadFile(entryFile);
    return;
  }

  console.log(`[window] loading dev url: ${DEV_SERVER_URL}`);
  mainWindow.loadURL(DEV_SERVER_URL);
}

process.on('uncaughtException', (err) => {
  const write = typeof console.error === 'function' ? console.error.bind(console) : (s) => process.stderr.write(s + '\n');
  write(`[process] uncaughtException: ${err.message}`);
  if (err.stack) write(err.stack);
});

process.on('unhandledRejection', (reason) => {
  const write = typeof console.error === 'function' ? console.error.bind(console) : (s) => process.stderr.write(s + '\n');
  const msg = reason instanceof Error ? reason.message : String(reason);
  write(`[process] unhandledRejection: ${msg}`);
  if (reason instanceof Error && reason.stack) write(reason.stack);
});

app.whenReady().then(async () => {
  initLogger();
  console.log('[main] app ready');
  setupDevControlInput();

  registerIpcHandlers();

  console.log('[main] starting backend...');
  startBackend();

  console.log('[main] waiting for backend...');
  backendReady = await waitForBackend();

  if (!backendReady) {
    console.warn('[main] backend not ready — continuing anyway (UI will handle reconnect)');
  } else {
    console.log('[main] backend ready ✓');
  }

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  console.log('[main] all windows closed');
  if (!app.isPackaged) {
    console.log('[main] dev mode keeps Electron alive after all windows closed');
    return;
  }
  await stopBackend();
  if (logStream && !logStream.destroyed) {
    console.log('[main] closing log streams');
    logStream.end();
  }
  if (latestStream && !latestStream.destroyed) latestStream.end();
  logStreamsClosed = true;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (backendProcess) {
    event.preventDefault();
    try { console.log('[main] before-quit — awaiting backend shutdown'); } catch (_) {}
    await stopBackend();
    app.quit();
  }
});
