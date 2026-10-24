const crypto = require('crypto');
const net = require('net');
const os = require('node:os');
const path = require('node:path');
const { ensureProxyHostKey } = require('./ssh-key-service');
const { Server: SSHServer, utils: sshUtils } = require('ssh2');
const { WebSocket } = require('ws');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { quotePosix, buildExecBootstrap, createExecParser } = require('./exec-codec');
const { validateCookie } = require('./credential-store');
const { buildWssUrl, buildWssOptions } = require('./wss-connection');
const {
  WSS_HANDSHAKE_TIMEOUT,
  REMOTE_READY_TIMEOUT,
  PING_INTERVAL,
  PING_TIMEOUT,
  SSH_HANDSHAKE_TIMEOUT,
  SSH_SOCKET_IDLE_TIMEOUT,
  PROXY_SHUTDOWN_TIMEOUT,
  EXEC_TIMEOUT,
  WS_BACKPRESSURE_POLL_MS,
  MAX_TCP_CONNECTIONS,
  MAX_PROXY_SESSIONS,
  MAX_WSS_PAYLOAD_BYTES,
  MAX_PENDING_BYTES,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_EXEC_PRELUDE_BYTES,
  MAX_QUEUED_OUTPUT_BYTES,
  MAX_WS_BUFFERED_BYTES,
} = require('./constants');

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const EXEC_WRITE_CHUNK_BYTES = 64 * 1024;

function parseServerMessage(raw) {
  try {
    const msg = JSON.parse(raw.toString('utf-8'));
    switch (msg.$case) {
      case 'exit': {
        const candidate = msg.exit?.code;
        const exitCode = Number.isInteger(candidate) && candidate >= 0 && candidate <= 255
          ? candidate
          : null;
        return { type: 'session_ended', exitCode };
      }
      case 'data': {
        const payload = msg.data?.data;
        return typeof payload === 'string'
          ? { type: 'data', payload }
          : { type: 'unknown' };
      }
      default:
        return { type: 'unknown' };
    }
  } catch {
    return { type: 'unknown' };
  }
}

function buildClientMessage(text) {
  return JSON.stringify({ $case: 'data', data: { data: text } });
}

function extractEd25519RawKey(data) {
  if (!Buffer.isBuffer(data)) return null;
  if (data.length === 32) return data;

  let offset = 0;
  const readField = () => {
    if (offset + 4 > data.length) return null;
    const length = data.readUInt32BE(offset);
    offset += 4;
    if (length > data.length - offset) return null;
    const field = data.subarray(offset, offset + length);
    offset += length;
    return field;
  };

  const algorithm = readField();
  const key = readField();
  if (!algorithm || !key || offset !== data.length) return null;
  if (algorithm.toString('ascii') !== 'ssh-ed25519' || key.length !== 32) return null;
  return key;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Size the actual JSON wire representation, without splitting surrogate pairs.
function nextDataFrame(text, offset, maxBytes) {
  let bytes = Buffer.byteLength(buildClientMessage(''));
  let end = offset;
  while (end < text.length) {
    const point = text.codePointAt(end);
    const width = point > 0xffff ? 2 : 1;
    const char = text.slice(end, end + width);
    const cost = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (bytes + cost > maxBytes) break;
    bytes += cost;
    end += width;
  }
  if (end === offset) throw new Error('WSS frame limit is too small');
  return { message: buildClientMessage(text.slice(offset, end)), end, bytes };
}

let sessionIdCounter = 0;

class Session {
  constructor(id, remoteAddress, kind) {
    this.id = id;
    this.remoteAddress = remoteAddress;
    this.kind = kind;
    this.connectedAt = Date.now();
    this.bytesSent = 0;
    this.bytesReceived = 0;
    this._close = null;
  }
}

class ProxyServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port ?? 3000;
    this.host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1';
    this.cookie = validateCookie(options.cookie === undefined ? '' : options.cookie);
    this._acceptingConnections = options.acceptingConnections !== false;
    this.wssUrl = buildWssUrl(options);

    this.tlsCa = options.tlsCa ?? options.ca;
    this.authorizedKey = Buffer.isBuffer(options.authorizedKey)
      ? Buffer.from(options.authorizedKey)
      : null;
    this._authorizedKeyBlob = null;
    this._parsedPubKey = null;
    this._authConfigValid = false;

    this._net = options.netModule || net;
    this._SSHServer = options.SSHServerClass || SSHServer;
    this._parseKey = options.parseKey || sshUtils.parseKey;
    this._webSocketFactory = options.webSocketFactory
      || ((url, wsOptions) => new WebSocket(url, wsOptions));
    this._hostKey = options.hostKey || null;
    const configHome = process.platform === 'win32'
      ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
          ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config'));
    this._hostKeyPath = options.hostKeyPath || path.join(configHome, 'usshtc107', 'proxy_host_ed25519');

    this.wssHandshakeTimeoutMs = positiveInteger(
      options.wssHandshakeTimeoutMs,
      WSS_HANDSHAKE_TIMEOUT
    );
    this.remoteReadyTimeoutMs = positiveInteger(options.remoteReadyTimeoutMs, REMOTE_READY_TIMEOUT);
    this.eofDrainTimeoutMs = positiveInteger(options.eofDrainTimeoutMs, 5000);
    this.eofQuietMs = Math.min(positiveInteger(options.eofQuietMs, 250), this.eofDrainTimeoutMs);
    this.sshHandshakeTimeoutMs = positiveInteger(
      options.sshHandshakeTimeoutMs,
      SSH_HANDSHAKE_TIMEOUT
    );
    this.socketIdleTimeoutMs = positiveInteger(
      options.socketIdleTimeoutMs,
      SSH_SOCKET_IDLE_TIMEOUT
    );
    this.shutdownTimeoutMs = positiveInteger(
      options.shutdownTimeoutMs,
      PROXY_SHUTDOWN_TIMEOUT
    );
    this.execTimeoutMs = positiveInteger(options.execTimeoutMs, EXEC_TIMEOUT);
    this.pingIntervalMs = positiveInteger(options.pingIntervalMs, PING_INTERVAL);
    this.pingTimeoutMs = positiveInteger(options.pingTimeoutMs, PING_TIMEOUT);
    this.backpressurePollMs = positiveInteger(
      options.backpressurePollMs,
      WS_BACKPRESSURE_POLL_MS
    );

    this.maxConnections = positiveInteger(options.maxConnections, MAX_TCP_CONNECTIONS);
    this.maxSessions = positiveInteger(options.maxSessions, MAX_PROXY_SESSIONS);
    this.maxWssPayloadBytes = positiveInteger(
      options.maxWssPayloadBytes,
      MAX_WSS_PAYLOAD_BYTES
    );
    this.maxPendingBytes = positiveInteger(options.maxPendingBytes, MAX_PENDING_BYTES);
    this.maxExecOutputBytes = positiveInteger(
      options.maxExecOutputBytes,
      MAX_EXEC_OUTPUT_BYTES
    );
    this.maxExecPreludeBytes = positiveInteger(options.maxExecPreludeBytes, MAX_EXEC_PRELUDE_BYTES);
    this.maxExecEncodedBytes = positiveInteger(
      options.maxExecEncodedBytes, 2 * this.maxExecOutputBytes + 64 * 1024
    );
    this.maxQueuedOutputBytes = positiveInteger(options.maxQueuedOutputBytes, MAX_QUEUED_OUTPUT_BYTES);
    this.cols = positiveInteger(options.cols, 80);
    this.rows = positiveInteger(options.rows, 24);
    this.maxWsBufferedBytes = positiveInteger(
      options.maxWsBufferedBytes,
      MAX_WS_BUFFERED_BYTES
    );

    if (options.authorizedKeyOpenSSH) {
      try {
        const parsed = this._parseKey(options.authorizedKeyOpenSSH);
        const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
        const publicBlob = typeof candidate?.getPublicSSH === 'function'
          ? candidate.getPublicSSH()
          : null;
        const parsedRawKey = extractEd25519RawKey(publicBlob);
        const keyMatches = this.authorizedKey?.length === 32
          && parsedRawKey?.length === this.authorizedKey.length
          && crypto.timingSafeEqual(parsedRawKey, this.authorizedKey);
        if (!(candidate instanceof Error)
            && candidate?.type === 'ssh-ed25519'
            && typeof candidate.verify === 'function'
            && keyMatches) {
          this._parsedPubKey = candidate;
          this._authorizedKeyBlob = Buffer.from(publicBlob);
        }
      } catch (_) {
        this._parsedPubKey = null;
        this._authorizedKeyBlob = null;
      }
    }
    this._authConfigValid = this.authorizedKey?.length === 32
      && !!this._parsedPubKey
      && !!this._authorizedKeyBlob;

    this._server = null;
    this._sshServer = null;
    this._started = false;
    this._starting = false;
    this._stopping = false;
    this._clients = new Set();
    this._sockets = new Map();
    this._sshChannels = new Set();
    this._sessions = new Map();

    this._startTime = null;
    this._totalBytesSent = 0;
    this._totalBytesReceived = 0;

    this._lifecycle = Promise.resolve();
    this._startPromise = null;
    this._stopPromise = null;
    this._startRequest = null;
    this._listenAbortController = null;
  }

  _enqueueLifecycle(operation) {
    const result = this._lifecycle.then(operation, operation);
    this._lifecycle = result.catch(() => {});
    return result;
  }

  _emitError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  _schedule(timerSet, fn, delay) {
    const timer = setTimeout(() => {
      timerSet.delete(timer);
      fn();
    }, delay);
    timer.unref?.();
    timerSet.add(timer);
    return timer;
  }

  _clearTimers(timerSet) {
    for (const timer of timerSet) clearTimeout(timer);
    timerSet.clear();
  }

  _webSocketOptions() {
    return buildWssOptions({
      cookie: this.cookie,
      tlsCa: this.tlsCa,
      handshakeTimeoutMs: this.wssHandshakeTimeoutMs,
      maxPayload: this.maxWssPayloadBytes,
    });
  }

  _createWebSocket({ cols = this.cols, rows = this.rows } = {}) {
    const url = new URL(this.wssUrl);
    url.searchParams.set('cols', String(cols));
    url.searchParams.set('rows', String(rows));
    return this._webSocketFactory(url.toString(), this._webSocketOptions());
  }

  _closeWebSocket(ws) {
    if (!ws) return;
    if (ws.readyState === WS_CONNECTING) {
      // terminate() aborts the HTTP/TLS handshake. Keep an error listener until
      // the close event so the asynchronous abort error cannot become unhandled.
      ws.once?.('error', () => {});
      try {
        ws.terminate();
      } catch (_) {
        try { ws.close(); } catch (_) {}
      }
      return;
    }
    if (ws.readyState === WS_OPEN) {
      try { ws.close(1000); } catch (_) {}
    }
  }

  _openSession(remoteAddress, close, kind = 'shell') {
    const session = new Session(++sessionIdCounter, remoteAddress, kind);
    session._close = close;
    this._sessions.set(session.id, session);
    this.emit('session-open', this._sessionSnapshot(session));
    this._emitStats();
    return session;
  }

  _closeSessionRecord(session, { exitCode = null, reason = 'interrupted' } = {}) {
    if (!session || this._sessions.get(session.id) !== session || session._finalized) return;
    session._finalized = true;
    const snapshot = this._sessionSnapshot(session);
    // Deliver the last counters while this exact session is still owned. Listeners
    // must use this snapshot, not reconstruct it after the record has disappeared.
    this.emit('session-close', { sessionId: session.id, session: snapshot,
      endedAt: Date.now(), exitCode, reason });
    this._sessions.delete(session.id);
    this._emitStats();
  }

  _bridgeExecToWss(channel, clientStr, command, ptyState) {
    return this._bridgeChannel(channel, clientStr, ptyState, command);
  }

  _bridgeSshToWss(channel, clientStr, ptyState) {
    return this._bridgeChannel(channel, clientStr, ptyState);
  }

  _bridgeChannel(channel, clientStr, ptyState = { cols: this.cols, rows: this.rows }, command) {
    const self = this;
    const exec = command !== undefined;
    const commandText = typeof command === 'string' ? command : '';
    function rejectEarly(code, diagnostic) {
      try { channel.stderr?.write(diagnostic); } catch (_) {}
      try { channel.exit(code); } catch (_) {}
      try { channel.end(); } catch (_) {}
      return { resize() {} };
    }
    if (exec && commandText.includes('\0')) return rejectEarly(1, 'Exec command contains NUL.\n');
    if (exec && Buffer.byteLength(commandText) > this.maxPendingBytes) {
      return rejectEarly(125, 'Exec input limit exceeded.\n');
    }
    let ws;
    try { ws = this._createWebSocket(ptyState); } catch (_) {
      return rejectEarly(1, 'WSS setup failed.\n');
    }
    const initialSize = { cols: ptyState.cols, rows: ptyState.rows };
    const timers = new Set();
    const decoder = exec ? null : new StringDecoder('utf8');
    const pending = [];
    const output = [];
    let pendingBytes = 0;
    let outputBytes = 0;
    let closed = false;
    let finished = false;
    let finishCode = null;
    let finishReason = 'interrupted';
    let ready = false;
    let remoteReady = false;
    let firstDataTimer = null;
    let inputEnded = false;
    let disconnectSent = false;
    let eofDraining = false;
    let eofDisconnectDue = false;
    let eofQuietTimer = null;
    let eofDeadline = null;
    let pendingResize = null;
    let pollTimer = null;
    let sendDeadline = null;
    let drainDeadline = null;
    let waitingDrain = false;
    let channelPaused = false;
    let pingTimer = null;
    let pongTimer = null;
    let execTimer = null;
    let session;
    let parser;
    function cancel(timer) {
      if (timer) { clearTimeout(timer); timers.delete(timer); }
    }
    function pauseInput() {
      if (channelPaused || exec) return;
      channelPaused = true;
      channel.pause?.();
    }
    function resumeInput() {
      if (!channelPaused || closed || inputEnded) return;
      channelPaused = false;
      channel.resume?.();
    }
    function account(direction, bytes) {
      if (!bytes) return;
      if (direction === 'sent') {
        session.bytesSent += bytes;
        self._totalBytesSent += bytes;
      } else {
        session.bytesReceived += bytes;
        self._totalBytesReceived += bytes;
      }
      self.emit('traffic', { sessionId: session.id, direction, bytes });
    }
    function cleanup() {
      if (closed) return;
      closed = true;
      self._clearTimers(timers);
      clearInterval(pingTimer);
      channel.removeListener('data', onInput);
      channel.removeListener('end', onInputEnd);
      channel.removeListener('close', cleanup);
      channel.removeListener('drain', onDrain);
      pending.length = 0;
      output.length = 0;
      self._closeSessionRecord(session, { exitCode: finishCode,
        reason: finishCode === null ? (ptyState.closeReason?.() || finishReason) : finishReason });
      self._closeWebSocket(ws);
    }
    function closeChannel() {
      if (closed) return;
      cleanup();
      try { channel.close(); } catch (_) {}
    }
    function flushOutput() {
      if (closed || waitingDrain || finished) return;
      while (output.length) {
        const chunk = output.shift();
        outputBytes -= chunk.length;
        let writable;
        try { writable = channel.write(chunk); } catch (_) { closeChannel(); return; }
        if (!writable) {
          waitingDrain = true;
          try { ws.pause?.(); } catch (_) {}
          channel.once('drain', onDrain);
          drainDeadline = self._schedule(timers, () => {
            finishCode = 125;
            finishReason = 'timeout';
            try { channel.exit(125); channel.end(); } catch (_) {}
            closeChannel();
          }, self.shutdownTimeoutMs);
          return;
        }
      }
      if (finishCode !== null) {
        finished = true;
        self._closeSessionRecord(session, { exitCode: finishCode, reason: finishReason });
        try { channel.exit(finishCode); channel.end(); } catch (_) { closeChannel(); return; }
        // end() drains SSH output; force-close only if the peer never closes.
        self._schedule(timers, closeChannel, self.shutdownTimeoutMs);
      }
    }
    function onDrain() {
      waitingDrain = false;
      cancel(drainDeadline);
      drainDeadline = null;
      flushOutput();
      if (!closed && !finished && finishCode === null) {
        try { ws.resume?.(); } catch (_) {}
      }
    }
    function complete(code, diagnostic, reason = 'completed') {
      if (closed || finishCode !== null) return;
      finishCode = code;
      finishReason = reason;
      cancel(execTimer);
      cancel(firstDataTimer);
      cancel(eofQuietTimer);
      cancel(eofDeadline);
      cancel(sendDeadline);
      cancel(pollTimer);
      clearInterval(pingTimer);
      cancel(pongTimer);
      pending.length = 0;
      pendingBytes = 0;
      if (diagnostic) { try { channel.stderr?.write(diagnostic); } catch (_) {} }
      self._closeWebSocket(ws);
      flushOutput();
    }
    function queueOutput(buffer) {
      if (closed || finishCode !== null) return;
      if (outputBytes + buffer.length > self.maxQueuedOutputBytes) {
        complete(125, 'Output queue limit exceeded.\n', 'output_limit');
        return;
      }
      account('received', buffer.length);
      for (let offset = 0; offset < buffer.length; offset += EXEC_WRITE_CHUNK_BYTES) {
        output.push(buffer.subarray(offset, offset + EXEC_WRITE_CHUNK_BYTES));
      }
      outputBytes += buffer.length;
      flushOutput();
    }
    function enqueue(text, rawBytes = 0) {
      if (text) pending.push({ text, offset: 0, rawBytes });
    }
    function scheduleFlush() {
      if (pollTimer || closed || finishCode !== null) return;
      if (!sendDeadline) sendDeadline = self._schedule(timers, () => {
        complete(exec ? 125 : 1, 'WSS input stalled.\n', 'timeout');
      }, self.wssHandshakeTimeoutMs);
      pollTimer = self._schedule(timers, () => { pollTimer = null; flushInput(); }, self.backpressurePollMs);
    }
    function send(message, bytes) {
      if ((ws.bufferedAmount || 0) + bytes > self.maxWsBufferedBytes) return false;
      try { ws.send(message, (error) => { if (error) complete(255, undefined, 'network_error'); }); }
      catch (_) { complete(255, undefined, 'network_error'); return false; }
      return !closed && finishCode === null;
    }
    function requestEofDisconnect() {
      if (closed || finishCode !== null || disconnectSent) return;
      cancel(eofQuietTimer);
      cancel(eofDeadline);
      eofDisconnectDue = true;
      flushInput();
    }
    function resetEofQuiet() {
      cancel(eofQuietTimer);
      eofQuietTimer = self._schedule(timers, requestEofDisconnect, self.eofQuietMs);
    }
    function flushInput() {
      if (closed || finishCode !== null || !ready || !remoteReady || ws.readyState !== WS_OPEN) return;
      while (pending.length) {
        const item = pending[0];
        let frame;
        try {
          frame = item.frame || nextDataFrame(item.text, item.offset, Math.min(self.maxWsBufferedBytes, EXEC_WRITE_CHUNK_BYTES));
          item.frame = frame;
        } catch (_) { complete(1, 'WSS frame limit is too small.\n', 'interrupted'); return; }
        if (!send(frame.message, frame.bytes)) { pauseInput(); scheduleFlush(); return; }
        item.frame = null;
        item.offset = frame.end;
        if (item.offset === item.text.length) {
          pending.shift();
          pendingBytes -= item.rawBytes;
          account('sent', item.rawBytes);
        }
      }
      if (pendingResize) {
        const message = JSON.stringify({ $case: 'resize', resize: pendingResize });
        const bytes = Buffer.byteLength(message);
        if (bytes > self.maxWsBufferedBytes) { complete(1, undefined, 'interrupted'); return; }
        if (!send(message, bytes)) { scheduleFlush(); return; }
        pendingResize = null;
      }
      cancel(sendDeadline);
      sendDeadline = null;
      resumeInput();
      if (!exec && inputEnded && !disconnectSent) {
        if (!eofDraining) {
          eofDraining = true;
          eofDeadline = self._schedule(timers, requestEofDisconnect, self.eofDrainTimeoutMs);
          resetEofQuiet();
        }
        if (!eofDisconnectDue) return;
        const message = JSON.stringify({ $case: 'disconnect' });
        const bytes = Buffer.byteLength(message);
        if (bytes > self.maxWsBufferedBytes) { complete(1, undefined, 'interrupted'); return; }
        if (!send(message, bytes)) { scheduleFlush(); return; }
        disconnectSent = true;
        self._schedule(timers, () => complete(0, undefined, 'user_disconnect'), self.shutdownTimeoutMs);
      }
    }
    function onInput(data) {
      if (closed || finishCode !== null || !data.length) return;
      if (exec) { complete(1, 'Exec stdin is not supported.\n', 'interrupted'); return; }
      if (inputEnded) return;
      if (pendingBytes + data.length > self.maxPendingBytes) {
        complete(1, 'SSH input limit exceeded.\n', 'interrupted');
        return;
      }
      const oldCarry = decoder.lastNeed ? decoder.lastTotal - decoder.lastNeed : 0;
      pendingBytes += data.length;
      const text = decoder.write(data);
      const carry = decoder.lastNeed ? decoder.lastTotal - decoder.lastNeed : 0;
      enqueue(text, data.length + oldCarry - carry);
      if (!ready || !remoteReady) pauseInput();
      flushInput();
    }
    function onInputEnd() {
      if (inputEnded || closed) return;
      inputEnded = true;
      if (exec) return; // SSH EOF is not command cancellation.
      const carry = decoder.lastNeed ? decoder.lastTotal - decoder.lastNeed : 0;
      enqueue(decoder.end(), carry);
      flushInput();
    }
    session = this._openSession(clientStr, (reason = 'user_disconnect') => complete(255, undefined, reason),
      exec ? 'exec' : 'shell');
    if (exec) {
      const nonce = crypto.randomBytes(32).toString('hex');
      parser = createExecParser({
        nonce,
        maxPreludeBytes: this.maxExecPreludeBytes,
        maxOutputBytes: this.maxExecOutputBytes,
        maxEncodedBytes: this.maxExecEncodedBytes,
        onReady() {
          if (closed || finishCode !== null) return;
          const bytes = Buffer.byteLength(commandText);
          pendingBytes += bytes;
          enqueue(`${Buffer.from(commandText, 'utf8').toString('base64')}\n`, bytes);
          flushInput();
        },
        onOutput: queueOutput,
        onComplete: complete,
      });
      enqueue(`exec sh -c ${quotePosix(buildExecBootstrap(nonce))}\n`);
    }
    ws.on('open', () => {
      if (closed || finishCode !== null) return;
      ready = true;
      // Upgrade succeeds even for silent, invalid-token portal sessions. Only a
      // terminal data frame opens the input gate; silence cannot revoke a cookie.
      firstDataTimer = self._schedule(timers, () => {
        self.emit('remote-not-ready', { code: 'REMOTE_READY_TIMEOUT', sessionId: session.id });
        complete(255, 'REMOTE_READY_TIMEOUT: Remote shell did not become ready; verify the connection or log in again.\n', 'remote_not_ready');
      }, self.remoteReadyTimeoutMs);
      if (ptyState.cols !== initialSize.cols || ptyState.rows !== initialSize.rows) {
        pendingResize = { cols: ptyState.cols, rows: ptyState.rows };
      }
      if (exec) execTimer = self._schedule(timers, () => complete(124, undefined, 'timeout'), self.execTimeoutMs);
      else {
        pingTimer = setInterval(() => {
          if (closed || finishCode !== null || ws.readyState !== WS_OPEN) return;
          cancel(pongTimer);
          try { ws.ping(); } catch (_) { complete(255, undefined, 'network_error'); return; }
          pongTimer = self._schedule(timers, () => {
            try { ws.terminate(); } catch (_) {}
            complete(255, undefined, 'timeout');
          }, self.pingTimeoutMs);
        }, self.pingIntervalMs);
        pingTimer.unref?.();
      }
      flushInput();
    });
    ws.on('pong', () => { cancel(pongTimer); pongTimer = null; });
    ws.on('message', (data) => {
      if (closed || finishCode !== null) return;
      const result = parseServerMessage(data);
      if (result.type === 'session_ended') {
        const setupFailed = exec && result.exitCode === 126 && parser.state === 'PRELUDE';
        complete(exec ? (setupFailed ? 1 : (result.exitCode > 0 ? result.exitCode : 255)) : (result.exitCode ?? 0),
          undefined, exec && (setupFailed || !result.exitCode) ? 'interrupted' : 'completed');
        return;
      }
      if (result.type !== 'data') return;
      if (!remoteReady) {
        remoteReady = true;
        cancel(firstDataTimer);
        firstDataTimer = null;
        self.emit('remote-ready', { sessionId: session.id });
        flushInput();
      }
      if (exec) {
        try { parser.write(result.payload); } catch (error) {
          const limited = error?.code === 'EXEC_OUTPUT_LIMIT';
          complete(limited ? 125 : 1, 'Exec protocol failed.\n', limited ? 'output_limit' : 'interrupted');
        }
      } else {
        queueOutput(Buffer.from(result.payload, 'utf8'));
        if (result.payload && eofDraining && !eofDisconnectDue && !disconnectSent && finishCode === null) resetEofQuiet();
      }
    });
    ws.on('unexpected-response', (_request, response) => {
      if (closed || finishCode !== null) return;
      response.resume?.();
      if (response.statusCode === 401 || response.statusCode === 403) {
        self.emit('auth-error', { statusCode: response.statusCode, clientStr });
      }
      complete(exec ? 255 : 1, undefined,
        response.statusCode === 401 || response.statusCode === 403 ? 'auth_error' : 'network_error');
    });
    ws.on('error', () => complete(255, undefined, 'network_error'));
    ws.on('close', () => {
      if (!closed && finishCode === null) complete(255, undefined, 'network_error');
    });
    channel.on('data', onInput);
    channel.on('end', onInputEnd);
    channel.on('close', cleanup);
    return {
      resize(cols, rows) {
        if (closed || finishCode !== null) return;
        ptyState.cols = cols;
        ptyState.rows = rows;
        pendingResize = { cols, rows };
        // One latest-size record per tick, including while WSS is blocked.
        if (ready && remoteReady) scheduleFlush();
      },
    };
  }

  _rawClientKey(ctx) {
    if (ctx.key?.algo !== 'ssh-ed25519') return null;
    return extractEd25519RawKey(ctx.key.data);
  }

  _verifyClientSignature(ctx) {
    if (!Buffer.isBuffer(ctx.blob) || !Buffer.isBuffer(ctx.signature)) return false;
    const verify = (signature) => (
      this._parsedPubKey.verify(ctx.blob, signature, ctx.hashAlgo) === true
    );

    try {
      if (verify(ctx.signature)) return true;
      if (ctx.signature.length <= 64) return false;

      const algorithmLength = ctx.signature.readUInt32BE(0);
      const algorithmEnd = 4 + algorithmLength;
      if (algorithmEnd + 4 > ctx.signature.length) return false;
      const algorithm = ctx.signature.subarray(4, algorithmEnd).toString('ascii');
      if (algorithm !== 'ssh-ed25519') return false;
      const signatureLengthOffset = 4 + algorithmLength;
      const signatureLength = ctx.signature.readUInt32BE(signatureLengthOffset);
      const signatureStart = signatureLengthOffset + 4;
      const signatureEnd = signatureStart + signatureLength;
      if (signatureLength !== 64 || signatureEnd !== ctx.signature.length) return false;
      return verify(ctx.signature.subarray(signatureStart, signatureEnd));
    } catch (_) {
      return false;
    }
  }

  _markSshHandshakeComplete(socket) {
    const meta = socket && this._sockets.get(socket);
    if (!meta?.handshakeTimer) return;
    clearTimeout(meta.handshakeTimer);
    meta.handshakeTimer = null;
  }

  _onSshClient(client) {
    this._clients.add(client);
    const clientChannels = new Set();
    const clientChannelCleanups = new Map();
    const socketState = this._sockets.get(client._sock);
    this.emit('connection', this._clients.size);
    const addr = (client._sock && `${client._sock.remoteAddress}:${client._sock.remotePort}`)
      || 'unknown';
    this.emit('proxy-log', 'info', 'ssh', `Client connected: ${addr}`);

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') {
        ctx.reject(['publickey']);
        return;
      }
      if (!this._authConfigValid) {
        ctx.reject();
        return;
      }

      const clientKey = this._rawClientKey(ctx);
      if (!clientKey || clientKey.length !== this.authorizedKey.length
          || !crypto.timingSafeEqual(clientKey, this.authorizedKey)) {
        ctx.reject();
        return;
      }

      if (!ctx.signature) {
        ctx.accept();
        return;
      }
      if (this._verifyClientSignature(ctx)) {
        this.emit('proxy-log', 'info', 'ssh', 'Public key authentication accepted');
        ctx.accept();
      } else {
        ctx.reject();
      }
    });

    client.on('ready', () => {
      this._markSshHandshakeComplete(client._sock);
      this.emit('proxy-log', 'info', 'ssh', `Client ready: ${addr}`);

      client.on('session', (acceptSession, rejectSession) => {
        if (!this._acceptingConnections || this._sshChannels.size >= this.maxSessions) {
          rejectSession?.();
          return;
        }

        const sshSession = acceptSession();
        let bridgeStarted = false;
        let bridgeHandle = null;
        const ptyState = { requested: false, cols: this.cols, rows: this.rows,
          closeReason: () => socketState?.reason || 'interrupted' };
        const updateSize = (info) => {
          if (!info || !Number.isInteger(info.cols) || !Number.isInteger(info.rows)
              || info.cols < 0 || info.cols > 500 || info.rows < 0 || info.rows > 200) return false;
          if (info.cols) ptyState.cols = info.cols;
          if (info.rows) ptyState.rows = info.rows;
          return true;
        };
        this._sshChannels.add(sshSession);
        clientChannels.add(sshSession);
        const removeSshChannel = () => {
          this._sshChannels.delete(sshSession);
          clientChannels.delete(sshSession);
          clientChannelCleanups.delete(sshSession);
          sshSession.removeListener('close', removeSshChannel);
          sshSession.removeListener('error', removeSshChannel);
        };
        clientChannelCleanups.set(sshSession, removeSshChannel);
        sshSession.once('close', removeSshChannel);
        sshSession.once('error', removeSshChannel);

        sshSession.on('pty', (acceptPty, rejectPty, info) => {
          if (bridgeStarted || ptyState.requested || !updateSize(info)) {
            rejectPty?.();
            return;
          }
          ptyState.requested = true;
          acceptPty?.();
        });

        sshSession.on('shell', (acceptShell, rejectShell) => {
          if (bridgeStarted || this._sessions.size >= this.maxSessions) {
            rejectShell?.();
            return;
          }
          bridgeStarted = true;
          const channel = acceptShell();
          bridgeHandle = this._bridgeSshToWss(channel, addr, ptyState);
        });

        sshSession.on('exec', (acceptExec, rejectExec, info) => {
          if (bridgeStarted || this._sessions.size >= this.maxSessions || typeof info?.command !== 'string') {
            rejectExec?.();
            return;
          }
          bridgeStarted = true;
          const channel = acceptExec();
          bridgeHandle = this._bridgeExecToWss(channel, addr, info.command, ptyState);
        });

        sshSession.on('env', (acceptEnv) => acceptEnv?.());
        sshSession.on('window-change', (acceptResize, rejectResize, info) => {
          if (!ptyState.requested || !updateSize(info)) { rejectResize?.(); return; }
          bridgeHandle?.resize(ptyState.cols, ptyState.rows);
          acceptResize?.();
        });
      });
    });

    client.on('close', () => {
      for (const cleanup of [...clientChannelCleanups.values()]) cleanup();
      this._clients.delete(client);
      this.emit('connection', this._clients.size);
      this.emit('proxy-log', 'info', 'ssh', `Client disconnected: ${addr}`);
    });

    client.on('error', (err) => {
      if (socketState && !socketState.reason) socketState.reason = 'network_error';
      this.emit('proxy-log', 'error', 'ssh', `Client error: ${err.message}`);
    });
  }

  _trackTcpSocket(socket) {
    if (this._sockets.size >= this.maxConnections) {
      socket.destroy();
      return false;
    }

    const meta = { handshakeTimer: null, onTimeout: null, reason: null };
    this._sockets.set(socket, meta);

    const cleanup = () => {
      if (meta.handshakeTimer) clearTimeout(meta.handshakeTimer);
      if (meta.onTimeout) socket.removeListener('timeout', meta.onTimeout);
      this._sockets.delete(socket);
    };
    socket.once('close', cleanup);
    socket.once('error', () => { if (!meta.reason) meta.reason = 'network_error'; });

    meta.handshakeTimer = setTimeout(() => {
      meta.handshakeTimer = null;
      meta.reason = 'timeout';
      socket.destroy();
    }, this.sshHandshakeTimeoutMs);
    meta.handshakeTimer.unref?.();

    meta.onTimeout = () => { meta.reason = 'timeout'; socket.destroy(); };
    socket.setTimeout?.(this.socketIdleTimeoutMs);
    socket.on('timeout', meta.onTimeout);
    socket.setNoDelay?.(true);
    return true;
  }

  setAcceptingConnections(accepting) {
    this._acceptingConnections = accepting === true;
  }

  _handleTcpSocket(socket) {
    if (!this._acceptingConnections) {
      socket.destroy();
      return;
    }
    if (!this._trackTcpSocket(socket)) return;
    try {
      this._sshServer.injectSocket(socket);
    } catch (err) {
      this.emit('proxy-log', 'error', 'proxy', `SSH socket setup failed: ${err.message}`);
      socket.destroy();
    }
  }

  _sessionSnapshot(session) {
    return {
      id: session.id,
      kind: session.kind,
      remoteAddress: session.remoteAddress,
      connectedAt: session.connectedAt,
      bytesSent: session.bytesSent,
      bytesReceived: session.bytesReceived,
    };
  }

  _emitStats() {
    this.emit('stats', this.getStats());
  }

  getSessions() {
    return Array.from(this._sessions.values(), (session) => this._sessionSnapshot(session));
  }

  getStats() {
    return {
      uptimeMs: this._startTime ? Date.now() - this._startTime : 0,
      totalBytesSent: this._totalBytesSent,
      totalBytesReceived: this._totalBytesReceived,
      sessionCount: this._sessions.size,
      sessions: this.getSessions(),
    };
  }

  disconnectSession(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session || typeof session._close !== 'function') return false;
    session._close('user_disconnect');
    return true;
  }

  _cancelPendingStart() {
    if (this._startRequest) this._startRequest.cancelled = true;
    try { this._listenAbortController?.abort(); } catch (_) {}
    if (this._server && !this._started) {
      try { this._server.close(() => {}); } catch (_) {}
    }
  }

  start() {
    if (this._started && !this._stopPromise) return Promise.resolve(true);
    if (this._startPromise && !this._startRequest?.cancelled) return this._startPromise;

    const request = { cancelled: false };
    const pendingStop = this._stopPromise;
    this._startRequest = request;
    const operation = this._enqueueLifecycle(async () => {
      if (pendingStop) await pendingStop;
      return this._doStart(request);
    });
    const result = operation.finally(() => {
      if (this._startRequest === request) this._startRequest = null;
      if (this._startPromise === result) this._startPromise = null;
    });
    this._startPromise = result;
    return result;
  }

  async _doStart(request) {
    if (request.cancelled) return false;
    if (this._started) return true;
    if (this._server || this._sshServer) {
      const error = new Error('Previous proxy server has not stopped cleanly');
      error.code = 'ERR_PROXY_SERVER_NOT_STOPPED';
      this.emit('proxy-log', 'error', 'proxy', error.message);
      this._emitError(error);
      throw error;
    }
    this._starting = true;

    if (!this._authConfigValid) {
      this._starting = false;
      const error = new Error('Authorized SSH key is unavailable or invalid');
      this.emit('proxy-log', 'error', 'ssh', error.message);
      this._emitError(error);
      throw error;
    }

    let sshServer;
    let server;
    try {
      const hostKey = this._hostKey || ensureProxyHostKey(this._hostKeyPath);
      sshServer = new this._SSHServer(
        { hostKeys: [hostKey] },
        (client) => this._onSshClient(client)
      );
      sshServer.on?.('error', (err) => this._emitError(err));
      sshServer.maxConnections = this.maxConnections;
      server = this._net.createServer(
        { allowHalfOpen: false },
        (socket) => this._handleTcpSocket(socket)
      );
    } catch (err) {
      this._starting = false;
      this._emitError(err);
      throw err;
    }
    this._sshServer = sshServer;
    this._server = server;
    this._listenAbortController = new AbortController();

    let listening = false;
    try {
      listening = await new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };

        server.on('error', (err) => {
          if (this._started) {
            this._emitError(err);
            return;
          }
          if (request.cancelled || err.name === 'AbortError' || err.code === 'ABORT_ERR') {
            settle(resolve, false);
            return;
          }
          this._emitError(err);
          settle(reject, err);
        });

        server.once('close', () => {
          if (this._server === server) this._started = false;
          if (!settled) {
            if (request.cancelled) settle(resolve, false);
            else settle(reject, new Error('Server closed before listening'));
          }
        });

        try {
          server.listen({
            port: this.port,
            host: this.host,
            signal: this._listenAbortController.signal,
          }, () => {
            if (request.cancelled) {
              try { server.close(() => {}); } catch (_) {}
              return;
            }
            this._started = true;
            this._startTime = Date.now();
            const address = server.address?.();
            this.emit('started', {
              host: address?.address || this.host,
              port: address?.port ?? this.port,
            });
            settle(resolve, true);
          });
        } catch (err) {
          this._emitError(err);
          settle(reject, err);
        }
      });
    } catch (err) {
      await this._closeTcpServer(server);
      if (this._server === server) this._server = null;
      if (this._sshServer === sshServer) this._sshServer = null;
      throw err;
    } finally {
      this._starting = false;
      this._listenAbortController = null;
    }

    if (!listening) {
      await this._closeTcpServer(server);
      if (this._server === server) this._server = null;
      if (this._sshServer === sshServer) this._sshServer = null;
    }
    return listening;
  }

  stop(reason = 'proxy_stop') {
    this._cancelPendingStart();
    if (this._stopPromise) return this._stopPromise;

    const wasActive = this._started || this._starting || !!this._server || !!this._startPromise || this._sessions.size > 0;
    if (!wasActive) return Promise.resolve();

    const operation = this._enqueueLifecycle(() => this._doStop(wasActive, reason));
    const result = operation.finally(() => {
      if (this._stopPromise === result) this._stopPromise = null;
    });
    this._stopPromise = result;
    return result;
  }

  async _closeTcpServer(server) {
    if (!server) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      let timeout;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        server.removeListener('close', onClose);
        if (error) reject(error);
        else resolve();
      };
      const onClose = () => settle();

      server.once('close', onClose);
      try {
        server.close((error) => {
          if (error?.code === 'ERR_SERVER_NOT_RUNNING') settle();
          else settle(error);
        });
      } catch (err) {
        if (err.code === 'ERR_SERVER_NOT_RUNNING') settle();
        else settle(err);
      }
      if (!settled) {
        timeout = setTimeout(() => {
          if (settled) return;
          const error = new Error(
            `TCP server did not close within ${this.shutdownTimeoutMs}ms`
          );
          error.code = 'ERR_PROXY_SERVER_CLOSE_TIMEOUT';

          settled = true;
          server.removeListener('close', onClose);
          try { server.closeAllConnections?.(); } catch (_) {}
          for (const socket of this._sockets.keys()) {
            try { socket.destroy(); } catch (_) {}
          }
          this._emitError(error);
          reject(error);
        }, this.shutdownTimeoutMs);
      }
    });
  }

  async _doStop(emitStopped, reason) {
    this._stopping = true;
    this._started = false;
    this._startTime = null;
    try {
      const sessionReason = reason === 'app_exit' || reason === 'fatal' ? 'app_exit'
        : reason === 'auth_error' ? 'auth_error' : 'proxy_stop';
      for (const session of Array.from(this._sessions.values())) {
        try { session._close?.(sessionReason); } catch (_) {}
        // A stalled SSH reader may defer bridge completion. Stop still owns and
        // finalizes its last counters before stopped, including a failed stop.
        this._closeSessionRecord(session, { exitCode: null, reason: sessionReason });
      }
      for (const client of this._clients) {
        try { client.end(); } catch (_) {}
      }
      this._clients.clear();
      for (const socket of this._sockets.keys()) {
        try { socket.destroy(); } catch (_) {}
      }

      const server = this._server;
      await this._closeTcpServer(server);

      this._sessions.clear();
      this._sockets.clear();
      this._sshChannels.clear();
      this._server = null;
      this._sshServer = null;
      this._totalBytesSent = 0;
      this._totalBytesReceived = 0;
      if (emitStopped) this.emit('stopped');
    } finally {
      this._stopping = false;
    }
  }

  updateCookie(cookieString) {
    this.cookie = validateCookie(cookieString);
  }
}

module.exports = { ProxyServer };
