'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function enumerate(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? enumerate(file)
      : entry.isFile() && ['.js', '.mjs', '.cjs'].includes(path.extname(file)) ? [file] : [];
  });
}
const files = ['electron', 'shared', 'cli'].flatMap(enumerate).sort();
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error || result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
