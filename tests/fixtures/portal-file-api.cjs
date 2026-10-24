'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { createPortalApiClient } = require('../../electron/portal-api/client');
const { createFileApi } = require('../../electron/portal-api/file-api');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function portalFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usshtc-file-api-'));
  const local = path.join(root, 'local');
  const remote = path.join(root, 'remote');
  await Promise.all([fs.mkdir(local), fs.mkdir(remote)]);
  const [tlsCa, key] = await Promise.all([
    fs.readFile(path.join(__dirname, 'loopback-test-only-cert.pem')),
    fs.readFile(path.join(__dirname, 'loopback-test-only-key.pem')),
  ]);
  const files = new Map();
  const dirs = new Set(['/', '.', '/remote', '/tmp']);
  const symlinks = new Map();
  const metadata = new Map();
  const home = options.home ?? '/remote';
  dirs.add(home);
  function resolveTarget(value) {
    let resolved = path.posix.resolve(home, value);
    for (let count = 0; count < 40; count += 1) {
      const parts = resolved.split('/');
      let replaced = false;
      for (let index = 1; index < parts.length; index += 1) {
        const candidate = parts.slice(0, index + 1).join('/');
        if (!symlinks.has(candidate)) continue;
        resolved = path.posix.resolve(path.posix.dirname(candidate), symlinks.get(candidate), ...parts.slice(index + 1));
        replaced = true;
        break;
      }
      if (!replaced) return resolved;
    }
    return null;
  }
  function listed(name, type, size, mode) {
    return { name: path.posix.basename(name), type, mtime: '2026-01-01T00:00:00.000Z', mode, size,
      ...metadata.get(name) };
  }
  const requests = [];
  const errors = [];
  const initializations = [];
  const sockets = new Set();
  const downloads = new Map();
  const chunkSizeByte = options.chunkSizeByte ?? 1024 * 1024;
  let fixture;
  function json(response, status, body) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }
  async function receive(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      assert.ok(length <= 70 * 1024 * 1024, 'fixture request is bounded');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, length);
  }
  function multipart(request, bytes) {
    const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(request.headers['content-type'] || '');
    assert.ok(boundary, 'upload must have a multipart boundary');
    const marker = boundary[1] || boundary[2];
    const prefix = Buffer.from(`--${marker}\r\n`);
    const suffix = Buffer.from(`\r\n--${marker}--\r\n`);
    assert.ok(bytes.subarray(0, prefix.length).equals(prefix));
    assert.ok(bytes.subarray(-suffix.length).equals(suffix));
    const headerEnd = bytes.indexOf('\r\n\r\n');
    assert.ok(headerEnd > 0);
    const headers = bytes.subarray(prefix.length, headerEnd).toString('utf8');
    assert.match(headers, /content-disposition: form-data; name="file"; filename="[^"\r\n]+"/i);
    const body = bytes.subarray(headerEnd + 4, bytes.length - suffix.length);
    assert.equal(body.includes(Buffer.from(`\r\n--${marker}\r\n`)), false, 'one binary part, no protocol text fields');
    assert.equal(Number(request.headers['content-length']), bytes.length);
    return Buffer.from(body);
  }
  const server = https.createServer({ key, cert: tlsCa }, (request, response) => {
    void (async () => {
      const url = new URL(request.url, 'https://fixture.invalid');
      const record = { number: requests.length + 1, method: request.method, pathname: url.pathname,
        query: Object.fromEntries(url.searchParams), rawUrl: request.url, headers: { ...request.headers } };
      requests.push(record);
      const ctx = { ...record, request, response, record, fixture };
      await options.beforeRequest?.(ctx);
      if (response.destroyed || response.writableEnded) return;
      assert.equal(request.headers.cookie, `SCOW_USER=${options.token || 'fixture-token'}`);
      if (record.number > (options.authAfterRequest ?? Infinity)) return json(response, 401, null);
      if (options.permission === true || (typeof options.permission === 'function' && options.permission(ctx))) {
        return json(response, 403, { code: url.pathname === '/api/file/list' ? 'NOT_ACCESSIBLE' : 'PERMISSION_DENIED' });
      }
      if (!url.pathname.startsWith('/api/file/')) return json(response, 404, { code: 'NOT_EXISTS' });
      const operation = url.pathname.slice('/api/file/'.length);
      const rawTarget = url.searchParams.get('path');
      const target = rawTarget === null ? null : resolveTarget(rawTarget);
      if (request.method === 'POST' || request.method === 'PATCH') {
        const bytes = await receive(request);
        record.body = operation === 'upload' ? multipart(request, bytes) : JSON.parse(bytes.toString('utf8'));
      }
      if (operation === 'fileExist') {
        assert.equal(request.method, 'GET');
        json(response, 200, { result: files.has(target) || dirs.has(target) });
      } else if (operation === 'getFileType') {
        assert.equal(request.method, 'GET');
        if (!dirs.has(target) && !files.has(target)) return json(response, 400, { code: 'INVALID_PATH' });
        json(response, 200, { type: dirs.has(target) ? 'dir' : 'file' });
      } else if (operation === 'list') {
        assert.equal(request.method, 'GET');
        assert.notEqual(url.searchParams.get('updateAccessTime'), 'true');
        if (!dirs.has(target) && !files.has(target)) return json(response, 403, { code: 'NOT_ACCESSIBLE' });
        if (!dirs.has(target)) return json(response, 412, { code: 'DIRECTORY_NOT_FOUND' });
        const items = [];
        for (const [name, bytes] of files) if (path.posix.dirname(name) === target) {
          items.push(listed(name, 'FILE', bytes.length, 0o100600));
        }
        for (const name of dirs) if (name !== target && path.posix.dirname(name) === target) {
          items.push(listed(name, 'DIR', 0, 0o040700));
        }
        // The pinned SSH backend labels non-directories FILE, preserving lstat mode.
        for (const [name, link] of symlinks) if (path.posix.dirname(name) === target) {
          items.push(listed(name, 'FILE', Buffer.byteLength(link), 0o120777));
        }
        json(response, 200, { items });
      } else if (operation === 'getHome') {
        assert.equal(request.method, 'GET');
        assert.deepEqual(Object.keys(record.query), ['cluster']);
        json(response, 200, { path: home });
      } else if (operation === 'mkdir') {
        assert.equal(request.method, 'POST');
        assert.deepEqual(Object.keys(record.body).sort(), ['cluster', 'path']);
        assert.equal(typeof record.body.cluster, 'string');
        assert.equal(typeof record.body.path, 'string');
        const name = path.posix.resolve(home, record.body.path);
        if (files.has(name) || dirs.has(name) || symlinks.has(name)) return json(response, 409, { code: 'ALREADY_EXISTS' });
        const parent = resolveTarget(path.posix.dirname(name));
        // The SSH route calls one sftpMkdir, never mkdir -p or recursive creation.
        if (!dirs.has(parent)) return json(response, 500, null);
        dirs.add(path.posix.join(parent, path.posix.basename(name)));
        response.writeHead(204);
        response.end();
      } else if (operation === 'download') {
        assert.equal(request.method, 'GET');
        const occurrence = (downloads.get(target) || 0) + 1;
        downloads.set(target, occurrence);
        ctx.occurrence = occurrence;
        await options.beforeDownload?.(ctx);
        if (!files.has(target)) return json(response, 404, { code: 'NOT_EXISTS' });
        const bytes = Buffer.from(files.get(target));
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
        const drop = options.dropDownloadAt === occurrence || (typeof options.dropDownloadAt === 'function' && options.dropDownloadAt(ctx));
        if (drop) {
          response.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
          response.destroy();
        } else if (options.slowMs) {
          let offset = 0;
          let timer;
          const send = () => {
            if (response.destroyed) return;
            if (offset === bytes.length) { response.end(); return; }
            const end = Math.min(bytes.length, offset + (options.streamChunkBytes || 16 * 1024));
            response.write(bytes.subarray(offset, end));
            offset = end;
            timer = setTimeout(send, options.slowMs);
          };
          response.once('close', () => clearTimeout(timer));
          timer = setTimeout(send, options.slowMs);
        } else response.end(bytes);
      } else if (operation === 'initMultipartUpload') {
        assert.equal(request.method, 'POST');
        if (options.init501) return json(response, 501, { code: 'UNIMPLEMENTED' });
        assert.deepEqual(Object.keys(record.body).sort(), ['cluster', 'name', 'path']);
        const tempFileDir = `/tmp/scow-${crypto.randomUUID()}`;
        const init = { ...record.body, tempFileDir, target: path.posix.join(record.body.path, record.body.name), chunks: new Map() };
        initializations.push(init);
        dirs.add(tempFileDir);
        json(response, 200, { tempFileDir, chunkSizeByte, filesInfo: options.filesInfo || [] });
      } else if (operation === 'upload') {
        assert.equal(request.method, 'POST');
        assert.ok(['true', 'false'].includes(url.searchParams.get('chunk')));
        assert.ok(url.searchParams.has('originPath'));
        if (url.searchParams.get('chunk') === 'true') {
          const init = initializations.find(item => path.posix.dirname(target) === item.tempFileDir);
          assert.ok(init, 'chunk must use returned temporary directory');
          assert.equal(url.searchParams.get('originPath'), init.target, 'originPath must survive URL encoding intact');
          const match = /^([a-f0-9]{64})_([1-9]\d*)\.scowuploadtemp$/.exec(path.posix.basename(target));
          assert.ok(match, 'chunk name uses lowercase SHA-256 and a one-based index');
          assert.equal(match[1], sha256(record.body));
          const index = Number(match[2]);
          assert.equal(index, init.chunks.size + 1, 'chunks are sequential, never reused or retried');
          assert.ok(record.body.length <= chunkSizeByte, 'server chunk size is authoritative');
          init.chunks.set(index, { path: target, bytes: record.body });
        } else assert.equal(url.searchParams.get('originPath'), '');
        files.set(target, record.body);
        await options.afterUpload?.(ctx);
        response.writeHead(204);
        response.end();
      } else if (operation === 'mergeFileChunks') {
        assert.equal(request.method, 'POST');
        const body = record.body;
        assert.deepEqual(Object.keys(body).sort(), ['cluster', 'name', 'path', 'sizeByte']);
        const init = initializations.find(item => item.target === path.posix.join(body.path, body.name));
        assert.ok(init);
        const blocks = [...init.chunks.values()].map(item => item.bytes);
        assert.equal(blocks.length, Math.ceil(body.sizeByte / chunkSizeByte));
        for (const block of blocks.slice(0, -1)) assert.equal(block.length, chunkSizeByte);
        const bytes = Buffer.concat(blocks);
        assert.equal(body.sizeByte, bytes.length, 'merge sizeByte is original total bytes');
        files.set(init.target, bytes);
        response.writeHead(204);
        response.end();
      } else if (operation === 'move') {
        assert.equal(request.method, 'PATCH');
        const { fromPath, toPath } = record.body;
        assert.deepEqual(Object.keys(record.body).sort(), ['cluster', 'fromPath', 'toPath']);
        assert.ok(files.has(fromPath));
        // Pinned SSH uses ordinary SFTP rename, not posix-rename@openssh.com.
        // Overwrite is an explicit simulated-backend capability, never the default.
        if (dirs.has(toPath) || ((files.has(toPath) || symlinks.has(toPath)) && options.moveOverwrite !== true)) {
          return json(response, 415, { code: 'RENAME_FAILED', error: 'Destination already exists' });
        }
        symlinks.delete(toPath);
        files.set(toPath, files.get(fromPath));
        files.delete(fromPath);
        response.writeHead(204);
        response.end();
      } else assert.fail(`unexpected official file operation ${operation}`);
      await options.afterRequest?.(ctx);
    })().catch(error => {
      if (error.code === 'ECONNRESET' || error.code === 'ERR_STREAM_PREMATURE_CLOSE' || request.aborted) return;
      errors.push(error);
      if (!response.headersSent) json(response, 500, { code: 'FIXTURE_ASSERTION' });
      else response.destroy();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `https://127.0.0.1:${server.address().port}`;
  const client = createPortalApiClient({ baseUrl, tlsCa, cookie: `SCOW_USER=${options.token || 'fixture-token'}` });
  const api = createFileApi({ client });
  fixture = { root, local, remote, baseUrl, tlsCa, client, api, files, dirs, symlinks, metadata, home,
    requests, errors, initializations, downloads, server };
  t.after(async () => {
    client.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, [], 'fixture protocol assertions');
  });
  return fixture;
}

module.exports = { portalFixture, sha256 };
