'use strict';

const MAX_CHUNK = 64 * 1024;

function codecError(code) {
  return Object.assign(new Error(code), { code });
}
function validateNonce(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw codecError('EXEC_SETUP_FAILED');
}
function quotePosix(text) {
  if (typeof text !== 'string' || text.includes('\0')) throw codecError('EXEC_SETUP_FAILED');
  return `'${text.replace(/'/g, "'\\''")}'`;
}
function buildExecBootstrap(nonce) {
  validateNonce(nonce);
  return [
    'stty -echo -onlcr -icanon min 1 time 0 || exit 126',
    'command -v base64 >/dev/null 2>&1 || exit 126',
    `printf '\\036USSHTC_${nonce}:READY\\037'`,
    'IFS= read -r __b64 || exit 126',
    '__cmd=$(printf \'%s\' "$__b64" | base64 -d && printf \'.\') || exit 126',
    '__cmd=${__cmd%.}',
    `printf '\\036USSHTC_${nonce}:START\\037'`,
    `{ sh -c "$__cmd" </dev/null 2>&1; __rc=$?; printf '\\036USSHTC_${nonce}:END:%s\\037' "$__rc"; } | base64`,
  ].join('\n');
}

function createExecParser({
  nonce, onReady = () => {}, onStart = () => {}, onOutput = () => {}, onComplete = () => {},
  maxPreludeBytes = 1024 * 1024, maxOutputBytes = 8 * 1024 * 1024,
  maxEncodedBytes = 2 * maxOutputBytes + 64 * 1024,
}) {
  validateNonce(nonce);
  const ready = `\x1eUSSHTC_${nonce}:READY\x1f`;
  const start = `\x1eUSSHTC_${nonce}:START\x1f`;
  const endPrefix = Buffer.from(`\x1eUSSHTC_${nonce}:END:`, 'ascii');
  let state = 'PRELUDE';
  let preludeCarry = '';
  let preludeBytes = 0;
  let encodedBytes = 0;
  let outputBytes = 0;
  let base64Carry = '';
  let padded = false;
  let decodedCarry = Buffer.alloc(0);
  let completeCode = null;
  let failed = null;

  function fail(code) {
    failed = codecError(code);
    throw failed;
  }
  function emit(bytes) {
    if (!bytes.length) return;
    if (outputBytes + bytes.length > maxOutputBytes) fail('EXEC_OUTPUT_LIMIT');
    outputBytes += bytes.length;
    onOutput(bytes);
  }
  function decodeOutput(bytes) {
    const data = decodedCarry.length ? Buffer.concat([decodedCarry, bytes]) : bytes;
    const marker = data.indexOf(endPrefix);
    if (marker !== -1) {
      emit(data.subarray(0, marker));
      const suffix = data.subarray(marker + endPrefix.length);
      const terminator = suffix.indexOf(0x1f);
      if (terminator === -1) {
        if (suffix.length > 3 || !/^\d{0,3}$/.test(suffix.toString('latin1'))) fail('EXEC_FRAMING_FAILED');
        decodedCarry = Buffer.from(data.subarray(marker));
        return;
      }
      const codeText = suffix.subarray(0, terminator).toString('latin1');
      if (!/^(?:0|[1-9]\d{0,2})$/.test(codeText) || Number(codeText) > 255 || terminator !== suffix.length - 1) {
        fail('EXEC_FRAMING_FAILED');
      }
      completeCode = Number(codeText);
      decodedCarry = Buffer.alloc(0);
      return;
    }
    let keep = Math.min(endPrefix.length - 1, data.length);
    while (keep && !data.subarray(data.length - keep).equals(endPrefix.subarray(0, keep))) keep--;
    emit(data.subarray(0, data.length - keep));
    decodedCarry = keep ? Buffer.from(data.subarray(data.length - keep)) : Buffer.alloc(0);
  }
  function consumeBase64(text) {
    encodedBytes += text.length;
    if (encodedBytes > maxEncodedBytes) fail('EXEC_OUTPUT_LIMIT');
    if (/[^A-Za-z0-9+/=\r\n]/.test(text)) fail('EXEC_FRAMING_FAILED');
    const compact = text.replace(/[\r\n]/g, '');
    if (!compact.length) return;
    if (padded || completeCode !== null) fail('EXEC_FRAMING_FAILED');
    const data = base64Carry + compact;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail('EXEC_FRAMING_FAILED');
    const length = data.length - data.length % 4;
    base64Carry = data.slice(length);
    if (!length) return;
    const groups = data.slice(0, length);
    const padding = groups.indexOf('=');
    if (padding !== -1) {
      if (base64Carry.length || padding < groups.length - 2) fail('EXEC_FRAMING_FAILED');
      padded = true;
    }
    const decoded = Buffer.from(groups, 'base64');
    // Node's decoder tolerates invalid low padding bits; wire framing does not.
    if (padding !== -1 && decoded.toString('base64') !== groups) fail('EXEC_FRAMING_FAILED');
    decodeOutput(decoded);
  }
  function consume(text) {
    if (state === 'COMPLETE') {
      if (/[^\r\n]/.test(text)) fail('EXEC_FRAMING_FAILED');
      return;
    }
    if (state === 'PRELUDE' || state === 'READY') {
      const marker = state === 'PRELUDE' ? ready : start;
      const data = preludeCarry + text;
      const index = data.indexOf(marker);
      if (index === -1) {
        let keep = Math.min(marker.length - 1, data.length);
        while (keep && !data.endsWith(marker.slice(0, keep))) keep--;
        const discarded = data.length - keep;
        preludeBytes += Buffer.byteLength(data.slice(0, discarded));
        if (preludeBytes > maxPreludeBytes) fail('EXEC_OUTPUT_LIMIT');
        preludeCarry = data.slice(discarded);
        return;
      }
      preludeBytes += Buffer.byteLength(data.slice(0, index));
      if (preludeBytes > maxPreludeBytes) fail('EXEC_OUTPUT_LIMIT');
      preludeCarry = '';
      if (state === 'PRELUDE') {
        state = 'READY';
        onReady();
      } else {
        state = 'START';
        onStart();
        state = 'BASE64_OUTPUT';
      }
      consume(data.slice(index + marker.length));
      return;
    }
    consumeBase64(text);
  }
  function write(text) {
    if (failed) throw failed;
    if (typeof text !== 'string') fail('EXEC_FRAMING_FAILED');
    for (let offset = 0; offset < text.length; offset += MAX_CHUNK) consume(text.slice(offset, offset + MAX_CHUNK));
    if (completeCode !== null && state !== 'COMPLETE') {
      if (base64Carry.length) fail('EXEC_FRAMING_FAILED');
      state = 'COMPLETE';
      onComplete(completeCode);
    }
  }
  function end() {
    if (failed) throw failed;
    if (state === 'COMPLETE') return;
    fail(state === 'PRELUDE' ? 'EXEC_SETUP_FAILED' : 'EXEC_FRAMING_FAILED');
  }
  return { write, end, get state() { return state; }, get outputBytes() { return outputBytes; } };
}

module.exports = { quotePosix, buildExecBootstrap, createExecParser };
