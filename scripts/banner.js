#!/usr/bin/env node

import { spawn } from 'child_process';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);
const isWindows = process.platform === 'win32';
const localBin = join(projectRoot, 'node_modules', '.bin');

function showBanner() {
  const banner = String.raw`
                   ___           ___                       ___           ___           ___     
      ___         /  /\         /__/\          ___        /__/\         /  /\         /  /\    
     /__/\       /  /:/_        \  \:\        /  /\       \  \:\       /  /::\       /  /:/_   
     \  \:\     /  /:/ /\        \  \:\      /  /:/        \  \:\     /  /:/\:\     /  /:/ /\  
      \  \:\   /  /:/ /:/_   _____\__\:\    /  /:/     ___  \  \:\   /  /:/~/:/    /  /:/ /:/_ 
  ___  \__\:\ /__/:/ /:/ /\ /__/::::::::\  /  /::\    /__/\  \__\:\ /__/:/ /:/___ /__/:/ /:/ /\
 /__/\ |  |:| \  \:\/:/ /:/ \  \:\~~\~~\/ /__/:/\:\   \  \:\ /  /:/ \  \:\/:::::/ \  \:\/:/ /:/
 \  \:\|  |:|  \  \::/ /:/   \  \:\  ~~~  \__\/  \:\   \  \:\  /:/   \  \::/~~~~   \  \::/ /:/ 
  \  \:\__|:|   \  \:\/:/     \  \:\           \  \:\   \  \:\/:/     \  \:\        \  \:\/:/  
   \__\::::/     \  \::/       \  \:\           \__\/    \  \::/       \  \:\        \  \::/   
       ~~~~       \__\/         \__\/                     \__\/         \__\/         \__\/    
`;
  
  console.log(banner.split('\n').map(line => '\x1b[32m' + line + '\x1b[0m').join('\n'));
}

showBanner();

const args = process.argv.slice(2);
const command = args[0];
const commandArgs = args.slice(1);

if (!command) {
  console.log('Usage: node scripts/banner.js <command> [args...]');
  process.exit(0);
}

const env = {
  ...process.env,
  PATH: `${localBin}${delimiter}${process.env.PATH || ''}`
};

const child = spawn(isWindows ? process.env.ComSpec || 'cmd.exe' : command, isWindows ? ['/d', '/c', command, ...commandArgs] : commandArgs, {
  stdio: 'inherit',
  cwd: projectRoot,
  env
});

child.on('error', (err) => {
  console.error('Failed to start command:', err);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
