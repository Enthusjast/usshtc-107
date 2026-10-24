'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_RESERVED_BYTES = 2 * 1024 ** 3;
const MAX_FILE_BYTES = 1024 ** 3;
const FREE_SPACE_MARGIN = 64 * 1024 ** 2;
const PREFIX = '.usshtc107-scp-';
const OWNED_NAME = /^\.usshtc107-scp-([1-9][0-9]*)-[A-Za-z0-9]{6}$/u;
let reservedBytes = 0;

function failure(code) { return Object.assign(new Error(code), { code }); }
function sameOwner(stat) { return typeof process.getuid !== 'function' || stat.uid === process.getuid(); }
function deadProcess(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
async function absentOkay(operation) {
  try { return await operation(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function onlyOwnedChildren(directory) {
  let count = 0;
  for await (const child of await fs.opendir(directory)) {
    if (++count > 2 || !['owner.json', 'payload'].includes(child.name) || !child.isFile()) return false;
  }
  return true;
}

// Only our private, marked, dead-process directories are candidates. Never use
// recursive removal: an unfamiliar child makes the entire directory ineligible.
async function scavenge(directory) {
  // Node cannot prove POSIX ownership/modes on Windows. Trust the caller's
  // user-data root for live files, but never scavenge unverifiable old entries.
  if (process.platform === 'win32') return;
  let iterator;
  try { iterator = await fs.opendir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let inspected = 0;
  let removed = 0;
  try {
    for await (const entry of iterator) {
      if (++inspected > 128 || removed >= 16) break;
      const match = OWNED_NAME.exec(entry.name);
      if (!match || !entry.isDirectory()) continue;
      const candidate = path.join(directory, entry.name);
      try {
        const stat = await fs.lstat(candidate);
        if (!stat.isDirectory() || !sameOwner(stat) || (stat.mode & 0o777) !== 0o700) continue;
        const marker = path.join(candidate, 'owner.json');
        const markerStat = await fs.lstat(marker);
        if (!markerStat.isFile() || !sameOwner(markerStat) || (markerStat.mode & 0o777) !== 0o600 || markerStat.size > 1024) continue;
        const owner = JSON.parse(await fs.readFile(marker, 'utf8'));
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || owner.version !== 1 || owner.pid !== pid
            || !/^[a-f0-9]{32}$/u.test(owner.token) || !Number.isSafeInteger(owner.createdAt)
            || owner.createdAt > Date.now() || !deadProcess(pid)) continue;
        if (!(await onlyOwnedChildren(candidate))) continue;
        const payload = path.join(candidate, 'payload');
        const payloadStat = await absentOkay(() => fs.lstat(payload));
        if (payloadStat && (!payloadStat.isFile() || !sameOwner(payloadStat)
            || (payloadStat.mode & 0o777) !== 0o600 || payloadStat.size > MAX_FILE_BYTES)) continue;
        if (!deadProcess(pid)) continue;
        await absentOkay(() => fs.unlink(payload));
        await fs.unlink(marker);
        await fs.rmdir(candidate);
        removed += 1;
      } catch { /* Unknown, changed, inaccessible, or concurrently scavenged: leave it alone. */ }
    }
  } finally { await iterator.close().catch(() => {}); }
}

async function allocateTempFile({ directory, size, check = () => {} }) {
  if (typeof directory !== 'string' || !directory || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
    throw failure('SCP_TEMP_LIMIT');
  }
  const rootDirectory = path.resolve(directory);
  check();
  if (reservedBytes + size > MAX_RESERVED_BYTES) throw failure('SCP_TEMP_LIMIT');
  reservedBytes += size;
  let privateDirectory;
  let handle;
  let released = false;
  let cleaned;
  const release = () => {
    if (!released) { released = true; reservedBytes -= size; }
  };
  const temporary = {
    path: null,
    get handle() { return handle; },
    async closeHandle() {
      if (handle) { const current = handle; handle = null; await current.close(); }
    },
    cleanup() {
      if (!cleaned) cleaned = (async () => {
        let closeError;
        try { await temporary.closeHandle(); } catch (error) { closeError = error; }
        if (!privateDirectory) { release(); if (closeError) throw closeError; return; }
        await absentOkay(() => fs.unlink(path.join(privateDirectory, 'payload')));
        release();
        await absentOkay(() => fs.unlink(path.join(privateDirectory, 'owner.json')));
        await absentOkay(() => fs.rmdir(privateDirectory));
        if (closeError) throw closeError;
      })();
      return cleaned;
    },
  };
  try {
    await fs.mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    const root = await fs.lstat(rootDirectory);
    if (root.isSymbolicLink() || !root.isDirectory() || !sameOwner(root)
        || (process.platform !== 'win32' && (root.mode & 0o777) !== 0o700)) throw failure('SCP_TEMP_UNSAFE');
    check();
    await scavenge(rootDirectory);
    check();
    const stat = await fs.statfs(rootDirectory, { bigint: true });
    const available = stat.bavail * stat.bsize;
    if (available < BigInt(reservedBytes) + BigInt(FREE_SPACE_MARGIN)) throw failure('SCP_TEMP_SPACE');
    check();
    privateDirectory = await fs.mkdtemp(path.join(rootDirectory, `${PREFIX}${process.pid}-`));
    await fs.chmod(privateDirectory, 0o700);
    await fs.writeFile(path.join(privateDirectory, 'owner.json'), JSON.stringify({ version: 1, pid: process.pid,
      token: crypto.randomBytes(16).toString('hex'), createdAt: Date.now() }), { flag: 'wx', mode: 0o600 });
    temporary.path = path.join(privateDirectory, 'payload');
    handle = await fs.open(temporary.path, 'wx', 0o600);
    check();
    return temporary;
  } catch (error) {
    await temporary.cleanup();
    throw error;
  }
}

module.exports = { allocateTempFile, MAX_RESERVED_BYTES, FREE_SPACE_MARGIN };
