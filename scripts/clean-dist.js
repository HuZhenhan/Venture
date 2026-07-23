import * as fs from 'node:fs';
import path from 'node:path';

const distPath = path.join(process.cwd(), 'dist');

if (fs.existsSync(distPath)) {
  for (const entry of fs.readdirSync(distPath)) {
    if (/^desktop\d*$/.test(entry) || entry === 'win-unpacked') {
      try {
        fs.rmSync(path.join(distPath, entry), { recursive: true, force: true });
        console.log(`cleaned: dist/${entry}`);
      } catch (err) {
        console.warn(`failed to clean dist/${entry}:`, err.message);
      }
    }
  }
}

process.exit(0);
