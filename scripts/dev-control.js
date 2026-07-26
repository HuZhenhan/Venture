#!/usr/bin/env node

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import net from 'net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);
const isWindows = process.platform === 'win32';
const localBin = join(projectRoot, 'node_modules', '.bin');
const env = {
  ...process.env,
  PATH: `${localBin}${delimiter}${process.env.PATH || ''}`,
};

const services = new Map();
let stopping = false;
let desktopStarting = false;

function log(message) {
  process.stdout.write(`[dev-control] ${message}\n`);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function findExistingDevControllers() {
  if (!isWindows) return [];
  const script = [
    'Get-CimInstance Win32_Process',
    `Where-Object { $_.ProcessId -ne ${process.pid} -and $_.Name -eq 'node.exe' -and $_.CommandLine -match '(^|\\s|[\\\\/])scripts[\\\\/]dev-control\\.js(["'']|\\s|$)' }`,
    'Select-Object -ExpandProperty ProcessId',
  ].join(' | ');
  const output = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return [...new Set(
    output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  )];
}

function askYesNo(question) {
  return new Promise((resolve) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    prompt.question(question, (answer) => {
      prompt.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function stopProcessTree(pid) {
  await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
}

async function handleExistingDevControllers() {
  let pids;
  try {
    pids = await findExistingDevControllers();
  } catch (error) {
    log(`failed to detect existing dev processes: ${error.message}`);
    return;
  }

  if (pids.length === 0) return;

  const shouldStop = await askYesNo(`Existing Venture dev process detected (${pids.join(', ')}). Stop it? (y/N) `);
  if (!shouldStop) {
    log('keeping existing dev process and continuing startup');
    return;
  }

  for (const pid of pids) {
    try {
      await stopProcessTree(pid);
      log(`stopped existing dev process tree: pid=${pid}`);
    } catch (error) {
      log(`failed to stop existing dev process pid=${pid}: ${error.message}`);
    }
  }
}

function commandName(name) {
  return isWindows ? `${name}.cmd` : name;
}

function startService(key, label, command, args, options = {}) {
  const existing = services.get(key);
  if (existing && !existing.killed) return existing;

  log(`starting ${label}: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: projectRoot,
    env,
    stdio: options.stdin === 'pipe' ? ['pipe', 'inherit', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    shell: options.shell === true,
    windowsHide: false,
  });

  services.set(key, child);

  child.on('error', (err) => {
    log(`${label} failed to start: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    if (services.get(key) === child) services.delete(key);
    log(`${label} exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    if (key === 'desktop') desktopStarting = false;
    if (!stopping && key !== 'desktop') {
      log(`${label} stopped unexpectedly. Use "restart frontend" or "restart all" after fixing the issue.`);
    }
  });

  return child;
}

function waitForTcp(port, host = '127.0.0.1', timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const socket = net.createConnection({ port, host });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (ok) return resolve(true);
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`timeout waiting for ${host}:${port}`));
          return;
        }
        setTimeout(probe, 300);
      };
      socket.setTimeout(800);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    };
    probe();
  });
}

async function startFrontend() {
  startService('web', 'web frontend', process.execPath, ['scripts/banner.js', 'vite']);
  startService('desktopWeb', 'desktop frontend', process.execPath, ['scripts/banner.js', 'vite', '--mode', 'electron', '--port', '5174']);
}

async function startDesktop() {
  if (desktopStarting || services.has('desktop')) return;
  desktopStarting = true;
  try {
    log('waiting for desktop frontend on 127.0.0.1:5174');
    await waitForTcp(5174);
    const electronCommand = isWindows ? `${commandName('electron')} .` : commandName('electron');
    const electronArgs = isWindows ? [] : ['.'];
    startService('desktop', 'desktop shell', electronCommand, electronArgs, { stdin: 'pipe', shell: isWindows });
  } catch (err) {
    log(`desktop shell start skipped: ${err.message}`);
  } finally {
    desktopStarting = false;
  }
}

function writeDesktopCommand(command) {
  const desktop = services.get('desktop');
  if (!desktop || desktop.killed || !desktop.stdin?.writable) {
    log(`desktop shell is not available for command: ${command}`);
    return false;
  }
  desktop.stdin.write(`${command}\n`);
  return true;
}

function stopService(key) {
  const child = services.get(key);
  if (!child || child.killed) return Promise.resolve();
  services.delete(key);

  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    if (isWindows && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }

    child.kill('SIGTERM');
  });
}

async function restartFrontend() {
  log('restarting frontend services');
  await Promise.all([stopService('web'), stopService('desktopWeb')]);
  await startFrontend();
  try {
    await waitForTcp(5174);
    writeDesktopCommand('reload frontend');
  } catch (err) {
    log(`frontend restarted, but desktop frontend is not ready: ${err.message}`);
  }
}

async function restartBackend() {
  log('restarting backend through desktop shell');
  writeDesktopCommand('restart backend');
}

async function restartAll() {
  log('restarting all dev services');
  await stopService('desktop');
  await Promise.all([stopService('web'), stopService('desktopWeb')]);
  await startFrontend();
  await startDesktop();
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  log('stopping all dev services');
  await Promise.all([stopService('desktop'), stopService('web'), stopService('desktopWeb')]);
  process.exit(0);
}

function printHelp() {
  log('commands: restart frontend | restart backend | restart all | rs fe | rs be | rs all | help | exit');
}

async function handleInput(rawLine) {
  const line = rawLine.trim().toLowerCase();
  if (!line) return;
  if (line === 'help') return printHelp();
  if (line === 'exit' || line === 'quit') return shutdown();
  if (line === 'restart frontend' || line === 'restart front' || line === 'restart fe' || line === 'rs fe') return restartFrontend();
  if (line === 'restart backend' || line === 'restart back' || line === 'restart be' || line === 'rs be') return restartBackend();
  if (line === 'restart all' || line === 'rs all') return restartAll();
  log(`unknown command: ${rawLine}. Type "help" for available commands.`);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await handleExistingDevControllers();
await startFrontend();
await Promise.all([waitForTcp(5173), waitForTcp(5174)]);
void startDesktop();
printHelp();

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  void handleInput(line);
});
