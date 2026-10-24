'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function enumerate(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? enumerate(file) : entry.isFile() && entry.name.endsWith('.test.js') ? [file] : [];
  });
}

const files = enumerate('tests').sort();
const child = spawn(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
child.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
