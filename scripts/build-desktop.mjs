import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

const arg = process.argv[2];
const buildMode = arg === 'portable' ? 'portable' : arg === 'installer' ? 'installer' : 'dir';
const outputRoot = path.join(process.cwd(), 'dist');

fs.mkdirSync(outputRoot, { recursive: true });

const electronDist = path.join('node_modules', 'electron', 'dist');
const builderArgs = [
  'electron-builder',
  `--config.directories.output="${outputRoot}"`,
  `--config.electronDist="${electronDist}"`,
];

if (buildMode === 'portable') {
  builderArgs.push('--win', 'portable');
} else if (buildMode === 'installer') {
  builderArgs.push('--win', 'nsis');
} else {
  builderArgs.push('--dir');
}

console.log(`\n▶ build mode : ${buildMode}`);
console.log(`▶ output     : ${outputRoot}\n`);

const child = spawn('npx', builderArgs, { stdio: 'inherit', shell: true });

child.on('exit', (code) => {
  if (code === 0 && buildMode === 'dir') {
    const src = path.join(outputRoot, 'win-unpacked');
    if (fs.existsSync(src)) {
      try {
        fs.cpSync(src, outputRoot, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
      } catch (err) {
        console.error(`Failed to flatten win-unpacked: ${err.message}`);
        process.exit(1);
      }
    }
  }
  process.exit(code ?? 1);
});
