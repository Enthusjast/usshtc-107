const crypto = require('crypto');
const net = require('net');
const { Server: SSHServer, utils: sshUtils } = require('ssh2');
const { WebSocket } = require('ws');
const { EventEmitter } = require('events');
const { validateCookie } = require('./credential-store');
const {
  PLATFORM,
  AUTH_CLOSE_CODES,
  WSS_HANDSHAKE_TIMEOUT,
  PING_INTERVAL,
  PING_TIMEOUT,
  CTRL_D_DRAIN_MS,
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
  MAX_WS_BUFFERED_BYTES,
} = require('./constants');

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const EXEC_ERROR_EXIT_CODE = 1;
const EXEC_TIMEOUT_EXIT_CODE = 124;
const EXEC_OUTPUT_LIMIT_EXIT_CODE = 125;
const EXEC_DISCONNECTED_EXIT_CODE = 255;
const EXEC_WRITE_CHUNK_BYTES = 64 * 1024;

function parseServerMessage(raw) {
  try {
    const msg = JSON.parse(raw.toString('utf-8'));
    switch (msg.$case) {
      case 'exit':
      case 'close':
      case 'logout': {
        const candidate = msg.exitCode ?? msg.code ?? msg.exit?.code;
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
    return { type: 'raw_text', payload: raw.toString('utf-8') };
  }
}

function buildClientMessage(buf) {
  return JSON.stringify({ $case: 'data', data: { data: buf.toString('utf-8') } });
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

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

let sessionIdCounter = 0;

class Session {
  constructor(id, remoteAddress) {
    this.id = id;
    this.remoteAddress = remoteAddress;
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
    this.wssUrl = options.wssUrl;

    if (!this.wssUrl) {
      const params = new URLSearchParams({
        cluster: options.cluster || 'training',
        loginNode: options.loginNode || '11.11.10.202',
        path: '',
        cols: options.cols || '80',
        rows: options.rows || '24',
        useRoot: options.useRoot ? 'true' : 'false',
      });
      this.wssUrl = `${PLATFORM.wssBase}?${params.toString()}`;
    }

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

    this.wssHandshakeTimeoutMs = positiveInteger(
      options.wssHandshakeTimeoutMs,
      WSS_HANDSHAKE_TIMEOUT
    );
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
    this.execInitialDelayMs = nonNegativeInteger(options.execInitialDelayMs, 1000);
    this.pingIntervalMs = positiveInteger(options.pingIntervalMs, PING_INTERVAL);
    this.pingTimeoutMs = positiveInteger(options.pingTimeoutMs, PING_TIMEOUT);
    this.ctrlDDrainMs = nonNegativeInteger(options.ctrlDDrainMs, CTRL_D_DRAIN_MS);
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

  static _ensureHostKey() {
    if (!ProxyServer._hostKey) {
      const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      });
      ProxyServer._hostKey = privateKey;
    }
    return ProxyServer._hostKey;
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
    const wsOptions = {
      headers: {
        Cookie: this.cookie,
        Origin: PLATFORM.origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
          + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      rejectUnauthorized: true,
      handshakeTimeout: this.wssHandshakeTimeoutMs,
      maxPayload: this.maxWssPayloadBytes,
    };
    if (this.tlsCa !== undefined && this.tlsCa !== null) wsOptions.ca = this.tlsCa;
    return wsOptions;
  }

  _createWebSocket() {
    return this._webSocketFactory(this.wssUrl, this._webSocketOptions());
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

  _isAuthCloseCode(code) {
    return AUTH_CLOSE_CODES.has(Number(code));
  }

  _openSession(remoteAddress, close) {
    const session = new Session(++sessionIdCounter, remoteAddress);
    session._close = close;
    this._sessions.set(session.id, session);
    this.emit('session-open', this._sessionSnapshot(session));
    this._emitStats();
    return session;
  }

  _closeSessionRecord(session) {
    if (!session || !this._sessions.has(session.id)) return;
    this._sessions.delete(session.id);
    this.emit('session-close', { sessionId: session.id });
    this._emitStats();
  }

  _bridgeExecToWss(channel, _client, clientStr, command) {
    const self = this;
    const commandText = typeof command === 'string' ? command : '';
    if (Buffer.byteLength(commandText, 'utf-8') > this.maxPendingBytes) {
      try { channel.exit(EXEC_OUTPUT_LIMIT_EXIT_CODE); } catch (_) {}
      try { channel.end(); } catch (_) {}
      return;
    }

    let ws;
    try {
      ws = this._createWebSocket();
    } catch (err) {
      this.emit('proxy-log', 'error', 'wss', `WSS setup failed: ${err.message}`);
      try { channel.exit(EXEC_ERROR_EXIT_CODE); } catch (_) {}
      try { channel.end(); } catch (_) {}
      return;
    }

    const timers = new Set();
    const doneId = crypto.randomBytes(12).toString('hex');
    const doneCommand = `echo DONE_${doneId} $?`;
    const donePattern = new RegExp(`DONE_${doneId}\\s+(\\d{1,3})\\r?\\n`);
    let outputText = '';
    let outputBytes = 0;
    let closed = false;
    let done = false;
    let drainListener = null;
    let drainTimeout = null;
    let session;

    function cleanOutput() {
      const doneCommandIndex = outputText.indexOf(doneCommand);
      const doneOutputMatch = outputText.match(donePattern);
      const doneOutputIndex = doneOutputMatch?.index ?? -1;
      let cutoff = outputText.length;
      if (doneCommandIndex >= 0) cutoff = Math.min(cutoff, doneCommandIndex);
      if (doneOutputIndex >= 0) cutoff = Math.min(cutoff, doneOutputIndex);

      let stripped = outputText.slice(0, cutoff);
      stripped = stripped.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
      stripped = stripped.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
      stripped = stripped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

      const commandWithNewline = `${commandText}\r\n`;
      const commandIndex = stripped.lastIndexOf(commandWithNewline);
      if (commandIndex >= 0) {
        stripped = stripped.slice(commandIndex + commandWithNewline.length);
      }
      stripped = stripped.replace(/[\w.\-]+@[\w.\-]+:[\w./~\- ]*[$#]\s*$/, '');
      return stripped.replace(/^\s+/, '').replace(/\s+$/, '');
    }

    function detachChannelListeners() {
      channel.removeListener('close', onChannelClose);
      channel.removeListener('end', onChannelEnd);
      if (drainListener) {
        channel.removeListener('drain', drainListener);
        drainListener = null;
      }
      if (drainTimeout) {
        clearTimeout(drainTimeout);
        drainTimeout = null;
      }
    }

    function cleanup() {
      if (closed) return;
      closed = true;
      self._clearTimers(timers);
      detachChannelListeners();
      self._closeSessionRecord(session);
      self._closeWebSocket(ws);
      try { if (!channel.closed) channel.close(); } catch (_) {}
    }

    function writeOutputAndClose(text, exitCode) {
      const output = text ? Buffer.from(`${text}\n`) : Buffer.alloc(0);
      let offset = 0;

      function finishChannel() {
        if (closed) return;
        try { if (!channel.closed) channel.exit(exitCode); } catch (_) {}
        try { if (!channel.closed) channel.end(); } catch (_) {}
        self._schedule(timers, cleanup, 250);
      }

      function writeNext() {
        if (closed) return;
        while (offset < output.length) {
          const end = Math.min(offset + EXEC_WRITE_CHUNK_BYTES, output.length);
          const chunk = output.subarray(offset, end);
          offset = end;
          let writable = true;
          try { writable = channel.write(chunk); } catch (_) { cleanup(); return; }
          if (!writable) {
            drainListener = () => {
              drainListener = null;
              if (drainTimeout) {
                clearTimeout(drainTimeout);
                drainTimeout = null;
              }
              writeNext();
            };
            channel.once('drain', drainListener);
            drainTimeout = setTimeout(cleanup, self.shutdownTimeoutMs);
            return;
          }
        }
        finishChannel();
      }

      writeNext();
    }

    function finishExec(exitCode) {
      if (done || closed) return;
      done = true;
      self._clearTimers(timers);
      self._closeWebSocket(ws);
      const normalizedExitCode = Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255
        ? exitCode
        : EXEC_ERROR_EXIT_CODE;
      self.emit('proxy-log', 'info', 'wss', `Exec completed with exit code ${normalizedExitCode}`);
      writeOutputAndClose(cleanOutput(), normalizedExitCode);
    }

    function onChannelClose() { cleanup(); }
    function onChannelEnd() { cleanup(); }

    session = this._openSession(`${clientStr} [exec]`, () => {
      if (!done && !closed) {
        done = true;
        try { if (!channel.closed) channel.exit(EXEC_DISCONNECTED_EXIT_CODE); } catch (_) {}
      }
      cleanup();
    });

    this.emit('proxy-log', 'info', 'wss', 'Connecting exec session');

    ws.on('message', (data) => {
      if (done || closed) return;
      const result = parseServerMessage(data);
      if (result.type === 'session_ended') {
        finishExec(result.exitCode ?? EXEC_ERROR_EXIT_CODE);
        return;
      }
      if (result.type !== 'data' || !result.payload) return;

      const payloadBytes = Buffer.byteLength(result.payload, 'utf-8');
      if (outputBytes + payloadBytes > self.maxExecOutputBytes) {
        self.emit('proxy-log', 'warn', 'wss', 'Exec output limit exceeded');
        finishExec(EXEC_OUTPUT_LIMIT_EXIT_CODE);
        return;
      }
      outputBytes += payloadBytes;
      outputText += result.payload;
      session.bytesReceived += payloadBytes;
      self._totalBytesReceived += payloadBytes;
      self.emit('traffic', { sessionId: session.id, direction: 'received', bytes: payloadBytes });

      const doneMatch = outputText.match(donePattern);
      if (doneMatch) {
        const parsedExitCode = Number.parseInt(doneMatch[1], 10);
        finishExec(parsedExitCode <= 255 ? parsedExitCode : EXEC_ERROR_EXIT_CODE);
      }
    });

    ws.on('open', () => {
      if (closed || done) return;
      self.emit('proxy-log', 'info', 'wss', 'WSS connected for exec session');
      self._schedule(timers, () => finishExec(EXEC_TIMEOUT_EXIT_CODE), self.execTimeoutMs);
      self._schedule(timers, () => {
        if (closed || done || ws.readyState !== WS_OPEN) return;
        const commandBuffer = Buffer.from(`${commandText}\n`, 'utf-8');
        const markerBuffer = Buffer.from(`${doneCommand}\n`, 'utf-8');
        const onSendError = (err) => { if (err) finishExec(EXEC_ERROR_EXIT_CODE); };
        try {
          ws.send(buildClientMessage(commandBuffer), onSendError);
          ws.send(buildClientMessage(markerBuffer), onSendError);
          session.bytesSent += commandBuffer.length;
          self._totalBytesSent += commandBuffer.length;
          self.emit('traffic', {
            sessionId: session.id,
            direction: 'sent',
            bytes: commandBuffer.length,
          });
        } catch (_) {
          finishExec(EXEC_ERROR_EXIT_CODE);
        }
      }, self.execInitialDelayMs);
    });

    ws.on('unexpected-response', (_req, res) => {
      if (closed || done) return;
      self.emit('proxy-log', 'error', 'wss', `WSS HTTP ${res.statusCode} for exec session`);
      res.resume?.();
      if (res.statusCode === 401 || res.statusCode === 403) {
        self.emit('auth-error', { statusCode: res.statusCode, clientStr });
      }
      finishExec(EXEC_ERROR_EXIT_CODE);
    });

    ws.on('error', (err) => {
      if (closed || done) return;
      self.emit('proxy-log', 'error', 'wss', `WSS exec error: ${err.message}`);
      finishExec(EXEC_ERROR_EXIT_CODE);
    });

    ws.on('close', (code) => {
      if (closed || done) return;
      if (self._isAuthCloseCode(code)) {
        self.emit('auth-error', { statusCode: code, clientStr });
      }
      finishExec(EXEC_ERROR_EXIT_CODE);
    });

    channel.on('close', onChannelClose);
    channel.on('end', onChannelEnd);
  }

  _bridgeSshToWss(channel, _client, clientStr) {
    const self = this;
    let ws;
    try {
      ws = this._createWebSocket();
    } catch (err) {
      this.emit('proxy-log', 'error', 'wss', `WSS setup failed: ${err.message}`);
      try { channel.exit(EXEC_ERROR_EXIT_CODE); } catch (_) {}
      try { channel.close(); } catch (_) {}
      return;
    }

    const timers = new Set();
    let pingTimer = null;
    let pongTimer = null;
    let ctrlDTimer = null;
    let backpressureTimer = null;
    let backpressureDeadlineTimer = null;
    let channelDrainListener = null;
    let closed = false;
    let wssReady = false;
    let channelPaused = false;
    let pendingBytes = 0;
    const pendingData = [];
    let session;

    function pauseChannel() {
      if (channelPaused) return;
      channelPaused = true;
      try { channel.pause?.(); } catch (_) {}
    }

    function resumeChannel() {
      if (!channelPaused || closed) return;
      channelPaused = false;
      try { channel.resume?.(); } catch (_) {}
    }

    function stopTimers() {
      self._clearTimers(timers);
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      if (ctrlDTimer) { clearTimeout(ctrlDTimer); ctrlDTimer = null; }
      if (backpressureTimer) { clearTimeout(backpressureTimer); backpressureTimer = null; }
      if (backpressureDeadlineTimer) {
        clearTimeout(backpressureDeadlineTimer);
        backpressureDeadlineTimer = null;
      }
    }

    function detachChannelListeners() {
      channel.removeListener('data', onChannelData);
      channel.removeListener('close', onChannelClose);
      channel.removeListener('end', onChannelEnd);
      if (channelDrainListener) {
        channel.removeListener('drain', channelDrainListener);
        channelDrainListener = null;
      }
    }

    function cleanup(exitCode = 0) {
      if (closed) return;
      closed = true;
      stopTimers();
      detachChannelListeners();
      pendingData.length = 0;
      pendingBytes = 0;
      self._closeSessionRecord(session);
      self._closeWebSocket(ws);
      try {
        if (!channel.closed) {
          channel.exit(exitCode);
          channel.close();
        }
      } catch (_) {}
    }

    session = this._openSession(clientStr, () => cleanup(EXEC_DISCONNECTED_EXIT_CODE));
    this.emit('proxy-log', 'info', 'wss', 'Connecting interactive session');

    function startPingPong() {
      pingTimer = setInterval(() => {
        if (closed || ws.readyState !== WS_OPEN) return;
        if (pongTimer) clearTimeout(pongTimer);
        try { ws.ping(); } catch (_) { cleanup(EXEC_ERROR_EXIT_CODE); return; }
        pongTimer = setTimeout(() => {
          pongTimer = null;
          if (!closed) {
            try { ws.terminate(); } catch (_) {}
          }
        }, self.pingTimeoutMs);
        pongTimer.unref?.();
      }, self.pingIntervalMs);
      pingTimer.unref?.();
    }

    function scheduleBackpressureFlush() {
      if (backpressureTimer || closed) return;
      if (!backpressureDeadlineTimer) {
        backpressureDeadlineTimer = setTimeout(() => {
          backpressureDeadlineTimer = null;
          if (!closed) cleanup(EXEC_ERROR_EXIT_CODE);
        }, self.wssHandshakeTimeoutMs);
        backpressureDeadlineTimer.unref?.();
      }
      backpressureTimer = setTimeout(() => {
        backpressureTimer = null;
        flushPending();
      }, self.backpressurePollMs);
      backpressureTimer.unref?.();
    }

    function sendBuffer(buf) {
      if (closed || ws.readyState !== WS_OPEN) return false;
      let message;
      try { message = buildClientMessage(buf); } catch (_) { cleanup(EXEC_ERROR_EXIT_CODE); return false; }
      const messageBytes = Buffer.byteLength(message);
      if (messageBytes > self.maxWsBufferedBytes) {
        self.emit('proxy-log', 'warn', 'wss', 'SSH input frame exceeds WSS buffer limit');
        cleanup(EXEC_ERROR_EXIT_CODE);
        return false;
      }
      if ((ws.bufferedAmount || 0) + messageBytes > self.maxWsBufferedBytes) {
        return false;
      }
      try {
        ws.send(message, (err) => { if (err && !closed) cleanup(EXEC_ERROR_EXIT_CODE); });
      } catch (_) {
        cleanup(EXEC_ERROR_EXIT_CODE);
        return false;
      }
      session.bytesSent += buf.length;
      self._totalBytesSent += buf.length;
      self.emit('traffic', { sessionId: session.id, direction: 'sent', bytes: buf.length });
      return true;
    }

    function flushPending() {
      if (closed || !wssReady || ws.readyState !== WS_OPEN) return;
      while (pendingData.length > 0) {
        const next = pendingData[0];
        if (!sendBuffer(next)) {
          pauseChannel();
          scheduleBackpressureFlush();
          return;
        }
        pendingData.shift();
        pendingBytes -= next.length;
      }
      if (backpressureDeadlineTimer) {
        clearTimeout(backpressureDeadlineTimer);
        backpressureDeadlineTimer = null;
      }
      resumeChannel();
    }

    function enqueueData(data) {
      const buf = Buffer.from(data);
      if (pendingBytes + buf.length > self.maxPendingBytes) {
        self.emit('proxy-log', 'warn', 'wss', 'SSH input buffer limit exceeded');
        cleanup(EXEC_ERROR_EXIT_CODE);
        return false;
      }
      pendingData.push(buf);
      pendingBytes += buf.length;
      return true;
    }

    function onChannelData(data) {
      if (closed || !enqueueData(data)) return;
      if (!wssReady) pauseChannel();
      flushPending();

      if (!closed && data.length === 1 && data[0] === 0x04) {
        if (ctrlDTimer) clearTimeout(ctrlDTimer);
        ctrlDTimer = setTimeout(() => {
          ctrlDTimer = null;
          if (!closed && ws.readyState === WS_OPEN) {
            try { ws.close(1000); } catch (_) {}
          }
        }, self.ctrlDDrainMs);
        ctrlDTimer.unref?.();
      }
    }

    function onChannelClose() { cleanup(0); }
    function onChannelEnd() { cleanup(0); }

    ws.on('message', (data) => {
      if (closed) return;
      const result = parseServerMessage(data);
      if (result.type === 'session_ended') {
        cleanup(result.exitCode ?? 0);
        return;
      }
      if ((result.type !== 'data' && result.type !== 'raw_text') || !result.payload) return;

      const buf = Buffer.from(result.payload);
      if (channel.closed) return;
      let writable = true;
      try { writable = channel.write(buf); } catch (_) { cleanup(EXEC_ERROR_EXIT_CODE); return; }
      session.bytesReceived += buf.length;
      self._totalBytesReceived += buf.length;
      self.emit('traffic', { sessionId: session.id, direction: 'received', bytes: buf.length });

      if (!writable && !channelDrainListener) {
        try { ws.pause?.(); } catch (_) {}
        channelDrainListener = () => {
          channelDrainListener = null;
          if (!closed) {
            try { ws.resume?.(); } catch (_) {}
          }
        };
        channel.once('drain', channelDrainListener);
      }
    });

    ws.on('pong', () => {
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    });

    ws.on('open', () => {
      if (closed) return;
      self.emit('proxy-log', 'info', 'wss', 'WSS connected for interactive session');
      wssReady = true;
      startPingPong();
      flushPending();
    });

    ws.on('unexpected-response', (_req, res) => {
      if (closed) return;
      self.emit('proxy-log', 'error', 'wss', `WSS HTTP ${res.statusCode} for interactive session`);
      res.resume?.();
      if (res.statusCode === 401 || res.statusCode === 403) {
        self.emit('auth-error', { statusCode: res.statusCode, clientStr });
      }
      cleanup(EXEC_ERROR_EXIT_CODE);
    });

    ws.on('error', (err) => {
      if (closed) return;
      self.emit('proxy-log', 'error', 'wss', `WSS interactive error: ${err.message}`);
      cleanup(EXEC_ERROR_EXIT_CODE);
    });

    ws.on('close', (code) => {
      if (closed) return;
      if (self._isAuthCloseCode(code)) {
        self.emit('auth-error', { statusCode: code, clientStr });
      }
      cleanup(code === 1000 ? 0 : EXEC_ERROR_EXIT_CODE);
    });

    channel.on('data', onChannelData);
    channel.on('close', onChannelClose);
    channel.on('end', onChannelEnd);
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
        if (this._sshChannels.size >= this.maxSessions) {
          rejectSession?.();
          return;
        }

        const sshSession = acceptSession();
        let bridgeStarted = false;
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

        sshSession.on('pty', (acceptPty) => {
          this.emit('proxy-log', 'info', 'ssh', 'PTY requested');
          acceptPty?.();
        });

        sshSession.on('shell', (acceptShell, rejectShell) => {
          if (bridgeStarted || this._sessions.size >= this.maxSessions) {
            rejectShell?.();
            return;
          }
          bridgeStarted = true;
          const channel = acceptShell();
          this._bridgeSshToWss(channel, client, addr);
        });

        sshSession.on('exec', (acceptExec, rejectExec, info) => {
          if (bridgeStarted || this._sessions.size >= this.maxSessions) {
            rejectExec?.();
            return;
          }
          bridgeStarted = true;
          const channel = acceptExec();
          this._bridgeExecToWss(channel, client, addr, info.command);
        });

        sshSession.on('env', (acceptEnv) => acceptEnv?.());
        sshSession.on('window-change', (accept) => accept?.());
      });
    });

    client.on('close', () => {
      for (const cleanup of [...clientChannelCleanups.values()]) cleanup();
      this._clients.delete(client);
      this.emit('connection', this._clients.size);
      this.emit('proxy-log', 'info', 'ssh', `Client disconnected: ${addr}`);
    });

    client.on('error', (err) => {
      this.emit('proxy-log', 'error', 'ssh', `Client error: ${err.message}`);
    });
  }

  _trackTcpSocket(socket) {
    if (this._sockets.size >= this.maxConnections) {
      socket.destroy();
      return false;
    }

    const meta = { handshakeTimer: null, onTimeout: null };
    this._sockets.set(socket, meta);

    const cleanup = () => {
      if (meta.handshakeTimer) clearTimeout(meta.handshakeTimer);
      if (meta.onTimeout) socket.removeListener('timeout', meta.onTimeout);
      this._sockets.delete(socket);
    };
    socket.once('close', cleanup);
    socket.once('error', () => {});

    meta.handshakeTimer = setTimeout(() => {
      meta.handshakeTimer = null;
      socket.destroy();
    }, this.sshHandshakeTimeoutMs);
    meta.handshakeTimer.unref?.();

    meta.onTimeout = () => socket.destroy();
    socket.setTimeout?.(this.socketIdleTimeoutMs);
    socket.on('timeout', meta.onTimeout);
    socket.setNoDelay?.(true);
    return true;
  }

  _handleTcpSocket(socket) {
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
    session._close();
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
      const hostKey = this._hostKey || ProxyServer._ensureHostKey();
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
            this.emit('started', { host: this.host, port: this.port });
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

  stop() {
    this._cancelPendingStart();
    if (this._stopPromise) return this._stopPromise;

    const wasActive = this._started || this._starting || !!this._server || !!this._startPromise;
    if (!wasActive) return Promise.resolve();

    const operation = this._enqueueLifecycle(() => this._doStop(wasActive));
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

  async _doStop(emitStopped) {
    this._stopping = true;
    this._started = false;
    this._startTime = null;
    try {
      for (const session of Array.from(this._sessions.values())) {
        try { session._close?.(); } catch (_) {}
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
