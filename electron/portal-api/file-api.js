'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const path = require('node:path');

function invalid() { return Object.assign(new Error('TRANSFER_METADATA'), { code: 'TRANSFER_METADATA' }); }
function text(value) {
  if (typeof value !== 'string' || !value.length || /[\u0000-\u001f\u007f]/.test(value)) throw invalid();
  return value;
}
function absolutePath(value) {
  const result = text(value);
  if (!result.startsWith('/') || path.posix.normalize(result) !== result) throw invalid();
  return result;
}
function fileKind(item) {
  if (!item || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0xffffffff) return 'other';
  const type = item.mode & 0o170000;
  if (type === 0o120000) return 'link';
  if (type === 0o100000 && item.type === 'FILE') return 'file';
  if (type === 0o040000 && item.type === 'DIR') return 'dir';
  return 'other';
}
function fileInfo(item) {
  if (!item || typeof item.name !== 'string' || !item.name.length || item.name === '.' || item.name === '..'
      || /[\\/\u0000-\u001f\u007f]/.test(item.name) || !['FILE', 'DIR'].includes(item.type)
      || typeof item.mtime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(item.mtime)
      || !Number.isFinite(Date.parse(item.mtime)) || !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0xffffffff
      || !Number.isSafeInteger(item.size) || item.size < 0) throw invalid();
  // The SSH backend labels links FILE; only matching POSIX kind bits prove an
  // ordinary file/directory. Missing bits and inconsistent enums fail closed.
  return { name: item.name, type: item.type, kind: fileKind(item), mtime: item.mtime, mode: item.mode, size: item.size };
}
function options(input) {
  const { signal, scope, assertCurrent, timeoutMs, maxBytes } = input;
  return { signal, scope, assertCurrent, timeoutMs, maxBytes };
}
function createFileApi({ client }) {
  if (!client) throw new TypeError('A portal API client is required');
  const query = input => ({ cluster: text(input.cluster), path: text(input.path) });
  const post = (endpoint, input, body) => client.empty(endpoint, {
    ...options(input), method: 'POST', body, expectedStatus: [204],
  });
  return {
    download(input) {
      return client.stream('/api/file/download', { ...options(input), query: { ...query(input), download: true }, expectedStatus: [200] });
    },
    async upload(input) {
      const { source, size, chunk = false, originPath = '' } = input;
      if (!source || typeof source[Symbol.asyncIterator] !== 'function' || !Number.isSafeInteger(size) || size < 0
          || typeof chunk !== 'boolean' || typeof originPath !== 'string') throw invalid();
      const boundary = `usshtc107-${crypto.randomBytes(24).toString('hex')}`;
      // A fixed, ASCII-only part filename avoids embedding any local path in HTTP.
      const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Readable.from((async function* () {
        let bytes = 0;
        try {
          yield prefix;
          for await (const block of source) {
            const bytesBlock = Buffer.isBuffer(block) ? block : Buffer.from(block);
            bytes += bytesBlock.length;
            if (bytes > size) throw invalid();
            yield bytesBlock;
          }
          if (bytes !== size) throw invalid();
          yield suffix;
        } finally { source.destroy?.(); }
      })());
      try {
        return await client.empty('/api/file/upload', {
          ...options(input), method: 'POST', expectedStatus: [204],
          // The shared client uses URLSearchParams: originPath must not be raw-interpolated.
          query: { ...query(input), chunk, originPath }, body,
          headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(prefix.length + size + suffix.length) },
        });
      } finally { body.destroy(); source.destroy?.(); }
    },
    async initMultipartUpload(input) {
      const result = await client.json('/api/file/initMultipartUpload', {
        ...options(input), method: 'POST', expectedStatus: [200],
        body: { ...query(input), name: text(input.name) },
      });
      if (!result || typeof result.tempFileDir !== 'string' || !result.tempFileDir.startsWith('/')
          || !Number.isSafeInteger(result.chunkSizeByte) || result.chunkSizeByte < 1 || !Array.isArray(result.filesInfo)) throw invalid();
      return { tempFileDir: result.tempFileDir, chunkSizeByte: result.chunkSizeByte, filesInfo: result.filesInfo };
    },
    mergeFileChunks(input) {
      if (!Number.isSafeInteger(input.sizeByte) || input.sizeByte < 0) throw invalid();
      return post('/api/file/mergeFileChunks', input, { ...query(input), name: text(input.name), sizeByte: input.sizeByte });
    },
    async fileExist(input) {
      const result = await client.json('/api/file/fileExist', { ...options(input), query: query(input), expectedStatus: [200] });
      if (!result || typeof result.result !== 'boolean') throw invalid();
      return result.result;
    },
    async getFileType(input) {
      const result = await client.json('/api/file/getFileType', { ...options(input), query: query(input), expectedStatus: [200] });
      if (!result || !['file', 'dir'].includes(result.type)) throw invalid();
      return result.type;
    },
    async list(input) {
      const result = await client.json('/api/file/list', {
        ...options(input), query: { ...query(input), updateAccessTime: false }, expectedStatus: [200],
      });
      if (!result || !Array.isArray(result.items)) throw invalid();
      const names = new Set();
      return result.items.map(item => {
        const info = fileInfo(item);
        if (names.has(info.name)) throw invalid();
        names.add(info.name);
        return info;
      });
    },
    async getHome(input) {
      const result = await client.json('/api/file/getHome', {
        ...options(input), query: { cluster: text(input.cluster) }, expectedStatus: [200],
      });
      if (!result) throw invalid();
      return absolutePath(result.path);
    },
    mkdir(input) {
      return post('/api/file/mkdir', input, query(input));
    },
    move(input) {
      return client.empty('/api/file/move', { ...options(input), method: 'PATCH', expectedStatus: [204],
        body: { cluster: text(input.cluster), fromPath: text(input.fromPath), toPath: text(input.toPath) } });
    },
  };
}
module.exports = { createFileApi, fileKind };
