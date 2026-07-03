const crypto = require('crypto');
const net = require('net');
const { Server: SSHServer } = require('ssh2');
const { WebSocket } = require('ws');
const { EventEmitter } = require('events');
const {
  PLATFORM,
  AUTH_CLOSE_CODES,
  WSS_HANDSHAKE_TIMEOUT,
  PING_INTERVAL,
  PING_TIMEOUT,
  CTRL_D_DRAIN_MS,
} = require('./constants');

// ---- JSON Protocol ----

function parseServerMessage(raw) {
  try {
    const msg = JSON.parse(raw.toString('utf-8'));
    switch (msg.$case) {
      case 'exit':
      case 'close':
      case 'logout':
        return { type: 'session_ended' };
      case 'data':
        return { type: 'data', payload: msg.data?.data ?? '' };
      default:
        return { type: 'unknown' };
    }
  } catch {
    return { type: 'raw_text', payload: raw.toString('utf-8') };
  }
}

function buildClientMessage(buf) {
  const text = buf.toString('utf-8');
  return JSON.stringify({ $case: 'data', data: { data: text } });
}

// ---- Session tracking ----

let _sessionIdCounter = 0;

class Session {
  constructor(id, remoteAddress) {
    this.id = id;
    this.remoteAddress = remoteAddress;
    this.connectedAt = Date.now();
    this.bytesSent = 0;      // SSH → WSS
    this.bytesReceived = 0;  // WSS → SSH
    this._sshClient = null;  // stored for targeted disconnect
  }
}

// ---- ProxyServer ----

class ProxyServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 3000;
    this.host = options.host || '127.0.0.1';
    this.cookie = options.cookie || '';
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

    this._server = null;
    this._sshServer = null;
    this._started = false;
    this._clients = new Set();

    // Session & stats tracking
    this._sessions = new Map();        // sessionId → Session
    this._startTime = null;
    this._totalBytesSent = 0;
    this._totalBytesReceived = 0;
  }

  // Host key generated once per module load (not per instance) to avoid
  // SSH "HOST KEY CHANGED" warnings across proxy restarts.
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

  /**
   * Bridge an exec request to WSS.
   * Strategy: send command + echo marker, detect marker in output to know
   * command is done, then send exit-status and close channel.
   */
  _bridgeExecToWss(channel, client, clientStr, command) {
    const self = this;
    const sessionId = ++_sessionIdCounter;
    const session = new Session(sessionId, `${clientStr} [exec]`);
    session._sshClient = client;
    this._sessions.set(sessionId, session);
    this.emit('session-open', this._sessionSnapshot(session));
    this._emitStats();

    // Unique done-marker — sent as a separate echo command after the user command.
    // Uses a unique string that will NEVER appear in the user command's echo.
    const DONE_ID = `D${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    // done-pattern to search for in output: "DONE_<id> <digits>\r?\n"
    const DONE_RE = new RegExp(`DONE_${DONE_ID}\\s+(\\d+)\\r?\\n`);

    self.emit('proxy-log', 'info', 'wss', `Connecting (exec): ${this.wssUrl}`);
    self.emit('proxy-log', 'info', 'wss', `Exec command: ${command} (doneId=${DONE_ID})`);

    const ws = new WebSocket(this.wssUrl, {
      headers: {
        Cookie: this.cookie,
        Origin: PLATFORM.origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      rejectUnauthorized: false,
      handshakeTimeout: WSS_HANDSHAKE_TIMEOUT,
    });

    let closed = false;
    let commandSent = false;
    let done = false;
    let outputMessages = [];  // individual messages for extraction
    let safetyTimer = null;

    function safeCleanup() {
      if (closed) return;
      closed = true;
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
      if (self._sessions.has(sessionId)) {
        self._sessions.delete(sessionId);
        self.emit('session-close', { sessionId });
        self._emitStats();
      }
      ws.removeAllListeners();
      channel.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.close(1000); } catch (_) {}
      }
      try { if (!channel.closed) channel.close(); } catch (_) {}
      try { client.end(); } catch (_) {}
    }

    function finishExec(exitCode) {
      if (done) return;
      done = true;

      try {
        self.emit('proxy-log', 'info', 'wss', `Exec finishing: exitCode=${exitCode}, ${outputMessages.length} msgs`);

        // Combine messages EXCEPT done-marker related ones.
        // Find the first message containing the done-marker command text
        // and exclude it and everything after it.
        const doneCmdText = `echo DONE_${DONE_ID}`;
        let cutoffIdx = outputMessages.length;
        for (let i = 0; i < outputMessages.length; i++) {
          if (outputMessages[i].includes(doneCmdText) || outputMessages[i].includes(`DONE_${DONE_ID}`)) {
            cutoffIdx = i;
            break;
          }
        }
        const outputText = outputMessages.slice(0, cutoffIdx).join('');
        self.emit('proxy-log', 'info', 'wss', `Cutoff at msg #${cutoffIdx}, combined ${outputText.length} chars`);

        // Strip ANSI
        let stripped = outputText.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
        stripped = stripped.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
        stripped = stripped.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

        self.emit('proxy-log', 'info', 'wss', `Output msgs combined (${stripped.length}): ${JSON.stringify(stripped).slice(0, 120)}`);

        // Find the LAST command echo with \r\n — this is the terminal echo,
        // right before the actual output.
        const cmdWithNl = command + '\r\n';
        const cmdIdx = stripped.lastIndexOf(cmdWithNl);
        self.emit('proxy-log', 'info', 'wss', `lastIndexOf cmdWithNl at ${cmdIdx}`);

        let cleanOutput = '';
        if (cmdIdx !== -1) {
          cleanOutput = stripped.substring(cmdIdx + cmdWithNl.length);
        } else {
          cleanOutput = stripped;
        }
        // Strip trailing prompt pattern: user@host:path$ or user@host:path#
        // Path can contain: word chars, dots, /, ~, -, spaces
        cleanOutput = cleanOutput.replace(/[\w.\-]+@[\w.\-]+:[\w.\/~\- ]*[\$#]\s*$/, '');
        cleanOutput = cleanOutput.replace(/^\s+/, '').replace(/\s+$/, '');

        self.emit('proxy-log', 'info', 'wss', `Exec output: ${JSON.stringify(cleanOutput).slice(0, 100)}`);

        if (!channel.closed) {
          if (cleanOutput) channel.write(Buffer.from(cleanOutput + '\n'));
          channel.exit(exitCode);
          channel.end();
        }
      } catch (err) {
        self.emit('proxy-log', 'error', 'wss', `finishExec error: ${err.message}`);
      } finally {
        setTimeout(safeCleanup, 1000);
      }
    }

    ws.on('message', (data) => {
      if (done) return;
      outputCount++;
      try {
        const raw = data.toString('utf-8');
        const msg = JSON.parse(raw);
        if (msg.$case === 'exit' || msg.$case === 'close' || msg.$case === 'logout') {
          self.emit('proxy-log', 'info', 'wss', `Exec: session ended (${msg.$case})`);
          finishExec(0);
          return;
        }
        if (msg.$case === 'data' && msg.data?.data) {
          const text = msg.data.data;
          // Log first few messages for debugging
          if (outputCount <= 8) {
            self.emit('proxy-log', 'info', 'wss', `Exec recv msg #${outputCount}: ${JSON.stringify(text).slice(0, 120)}`);
          }

          session.bytesReceived += text.length;
          self._totalBytesReceived += text.length;

          // Store message individually
          outputMessages.push(text);

          // Check if this message contains the done-marker output.
          // Pattern: "DONE_<id> <exitcode>" — $? is expanded to digit by shell.
          if (commandSent) {
            const donePattern = new RegExp(`DONE_${DONE_ID}\\s+(\\d+)`);
            const doneMatch = text.match(donePattern);
            if (doneMatch) {
              const exitCode = parseInt(doneMatch[1], 10) || 0;
              self.emit('proxy-log', 'info', 'wss', `Done in msg #${outputCount}, exitCode=${exitCode}`);
              finishExec(exitCode);
              return;
            }
          }
        }
      } catch (_) {}
    });

    // Track WSS output for debugging
    let outputCount = 0;

    ws.on('open', () => {
      self.emit('proxy-log', 'info', 'wss', `WSS connected (exec): ${clientStr}`);
      self.emit('proxy-log', 'info', 'wss', `Waiting 1s for shell init...`);
      setTimeout(() => {
        // Step 1: Send user command
        ws.send(JSON.stringify({ $case: 'data', data: { data: command + '\n' } }));
        commandSent = true;
        self.emit('proxy-log', 'info', 'wss', `Command sent: ${command}`);

        // Step 2: After command executes, send marker as separate command
        setTimeout(() => {
          if (!done && ws.readyState === WebSocket.OPEN) {
            const doneCmd = `echo DONE_${DONE_ID} $?`;
            ws.send(JSON.stringify({ $case: 'data', data: { data: doneCmd + '\n' } }));
            self.emit('proxy-log', 'info', 'wss', `Done marker sent: ${doneCmd}`);
          }
        }, 2000);
      }, 1000);

      // Safety timeout
      safetyTimer = setTimeout(() => {
        if (!done) {
          self.emit('proxy-log', 'warn', 'wss', `Exec safety timeout (60s): ${command}`);
          finishExec(0);
        }
      }, 60000);
    });

    ws.on('unexpected-response', (_req, res) => {
      self.emit('proxy-log', 'error', 'wss', `WSS HTTP ${res.statusCode} (exec)`);
      if (res.statusCode === 401 || res.statusCode === 403) {
        self.emit('auth-error', { statusCode: res.statusCode, clientStr });
      }
      finishExec(1);
    });

    ws.on('error', (err) => {
      self.emit('proxy-log', 'error', 'wss', `WSS error (exec): ${err.message}`);
      finishExec(1);
    });

    ws.on('close', (code) => {
      self.emit('proxy-log', 'info', 'wss', `WSS closed (exec): code=${code}`);
      if (AUTH_CLOSE_CODES.has(code)) {
        self.emit('auth-error', { statusCode: code, clientStr });
      }
      finishExec(1);
    });

    channel.on('close', () => safeCleanup());
    channel.on('end', () => safeCleanup());
  }

  _bridgeSshToWss(channel, client, clientStr) {
    const self = this;
    console.log(`[proxy] Bridging for ${clientStr}`);
    console.log(`[proxy] WSS URL: ${this.wssUrl}`);
    console.log(`[proxy] Cookie: ${this.cookie?.slice(0, 80) || '(empty)'}...`);
    self.emit('proxy-log', 'info', 'wss', `Connecting: ${this.wssUrl}`);
    self.emit('proxy-log', 'info', 'wss', `Cookie: ${this.cookie?.slice(0, 80) || '(empty)'}`);


    if (!this.cookie || this.cookie.length === 0) {
      const msg = 'No cookie available — WSS will likely fail (401)';
      console.error(`[proxy] ${msg}`);
      self.emit('proxy-log', 'error', 'wss', msg);
    }

    const ws = new WebSocket(this.wssUrl, {
      headers: {
        Cookie: this.cookie,
        Origin: PLATFORM.origin,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      rejectUnauthorized: false,
      handshakeTimeout: WSS_HANDSHAKE_TIMEOUT,
    });

    let closed = false;
    let pingTimer = null;
    let pongTimer = null;
    let drainTimer = null;

    // Create session record with client reference for targeted disconnect
    const sessionId = ++_sessionIdCounter;
    const session = new Session(sessionId, clientStr);
    session._sshClient = client;
    this._sessions.set(sessionId, session);
    this.emit('session-open', this._sessionSnapshot(session));
    this._emitStats();

    function startPingPong() {
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
          pongTimer = setTimeout(() => {
            console.log(`[proxy] Pong timeout for ${clientStr}`);
            if (!closed) ws.terminate();
          }, PING_TIMEOUT);
        }
      }, PING_INTERVAL);
    }

    function stopTimers() {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
      if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
    }

    function cleanup() {
      if (closed) return;
      closed = true;
      stopTimers();

      // Track traffic before cleanup
      if (self._sessions.has(sessionId)) {
        self._sessions.delete(sessionId);
        self.emit('session-close', { sessionId });
        self._emitStats();
      }

      // Clean up all listeners to prevent leaks
      ws.removeAllListeners();
      channel.removeAllListeners();

      // Close WSS safely — skip entirely if still connecting to avoid
      // ws library throwing async errors that bypass try-catch.
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.close(1000); } catch (_) {}
      }
      // If still CONNECTING, just let the socket timeout naturally.
      // Do NOT call ws._socket.destroy() or ws.terminate() — both
      // throw uncatchable async errors during CONNECTING state.

      // Send exit-status before closing channel so SSH client knows the session ended
      try {
        if (!channel.closed) {
          channel.exit(0);
          channel.close();
        }
      } catch (_) {}
      try { client.end(); } catch (_) {}
    }

    // WebSocket → SSH channel
    ws.on('message', (data) => {
      const result = parseServerMessage(data);
      if (result.type === 'session_ended') {
        console.log(`[proxy] Session ended for ${clientStr}`);
        cleanup();
        return;
      }
      if ((result.type === 'data' || result.type === 'raw_text') && result.payload) {
        if (!channel.closed) {
          const buf = Buffer.from(result.payload);
          channel.write(buf);
          // Track bytes
          session.bytesReceived += buf.length;
          self._totalBytesReceived += buf.length;
          self.emit('traffic', { sessionId, direction: 'received', bytes: buf.length });

          // Detect shell exit: "logout" followed by end of stream
          // When user types `exit`, the shell sends `logout` then the WSS should close.
          // If WSS doesn't close within 2s, force cleanup to unblock the SSH client.
          if (/\blogout\b/.test(result.payload)) {
            self.emit('proxy-log', 'info', 'wss', `Detected 'logout' for ${clientStr}`);
            if (!closed) {
              setTimeout(() => {
                if (!closed && ws.readyState === WebSocket.OPEN) {
                  self.emit('proxy-log', 'info', 'wss', `Closing WSS after logout for ${clientStr}`);
                  ws.close(1000);
                }
              }, 2000);
            }
          }
        }
      }
    });

    ws.on('pong', () => {
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    });

    // SSH channel → WebSocket
    // Register data handler immediately (not inside ws.on('open')) so exec
    // commands that arrive before WSS connects are not lost.
    let wssReady = false;
    const pendingData = [];

    function sendToWss(data) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buildClientMessage(data));
        session.bytesSent += data.length;
        self._totalBytesSent += data.length;
        self.emit('traffic', { sessionId, direction: 'sent', bytes: data.length });

        // Only treat 0x04 as Ctrl+D when it's a lone byte
        if (!closed && data.length === 1 && data[0] === 0x04) {
          console.log(`[proxy] Ctrl+D detected for ${clientStr}`);
          if (drainTimer) clearTimeout(drainTimer);
          drainTimer = setTimeout(() => {
            if (!closed && ws.readyState === WebSocket.OPEN) {
              console.log(`[proxy] Proactively closing WSS for ${clientStr}`);
              ws.close(1000);
            }
          }, CTRL_D_DRAIN_MS);
        }
      }
    }

    channel.on('data', (data) => {
      if (wssReady) {
        sendToWss(data);
      } else {
        pendingData.push(data);
      }
    });

    ws.on('open', () => {
      const msg = `WSS connected for ${clientStr}`;
      console.log(`[proxy] ${msg}`);
      self.emit('proxy-log', 'info', 'wss', msg);
      wssReady = true;
      startPingPong();
      // Flush any data that arrived before WSS was ready (e.g. exec command)
      for (const buf of pendingData) {
        sendToWss(buf);
      }
      pendingData.length = 0;
    });

    ws.on('unexpected-response', (_req, res) => {
      const msg = `WSS HTTP ${res.statusCode} for ${clientStr}`;
      console.error(`[proxy] ${msg}`);
      self.emit('proxy-log', 'error', 'wss', msg);
      // Log response headers for debugging
      console.error(`[proxy] WSS response headers:`, JSON.stringify(res.headers));
      self.emit('proxy-log', 'debug', 'wss', `Response headers: ${JSON.stringify(res.headers)}`);
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => {
        if (body) {
          console.error(`[proxy] WSS response body: ${body.slice(0, 500)}`);
          self.emit('proxy-log', 'error', 'wss', `Response body: ${body.slice(0, 300)}`);
        }
      });
      if (res.statusCode === 401 || res.statusCode === 403) {
        self.emit('auth-error', { statusCode: res.statusCode, clientStr });
      }
      cleanup();
    });

    ws.on('error', (err) => {
      const msg = `WSS error for ${clientStr}: ${err.message}`;
      console.error(`[proxy] ${msg}`);
      self.emit('proxy-log', 'error', 'wss', msg);
      cleanup();
    });

    ws.on('close', (code, reason) => {
      const msg = `WSS closed for ${clientStr}: code=${code} reason=${reason?.toString() || 'none'}`;
      console.log(`[proxy] ${msg}`);
      self.emit('proxy-log', 'info', 'wss', msg);
      if (AUTH_CLOSE_CODES.has(code)) {
        self.emit('auth-error', { statusCode: code, clientStr });
      }
      cleanup();
    });

    channel.on('close', () => {
      console.log(`[proxy] SSH channel closed for ${clientStr}`);
      cleanup();
    });

    channel.on('end', () => cleanup());
  }

  _onSshClient(client) {
    this._clients.add(client);
    this.emit('connection', this._clients.size);
    const addr = (client._sock && `${client._sock.remoteAddress}:${client._sock.remotePort}`) || 'unknown';
    console.log(`[proxy] SSH client connected: ${addr}`);
    this.emit('proxy-log', 'info', 'ssh', `Client connected: ${addr}`);

    client.on('authentication', (ctx) => {
      console.log(`[proxy] SSH auth: ${ctx.method} accepted`);
      this.emit('proxy-log', 'info', 'ssh', `Auth (${ctx.method}) accepted`);
      ctx.accept();
    });

    client.on('ready', () => {
      console.log(`[proxy] SSH client ready: ${addr}`);
      this.emit('proxy-log', 'info', 'ssh', `Client ready: ${addr}`);

      client.on('session', (acceptSession) => {
        const session = acceptSession();
        console.log(`[proxy] SSH session opened: ${addr}`);
        this.emit('proxy-log', 'info', 'ssh', `Session opened: ${addr}`);

        session.on('pty', (acceptPty, _rejectPty, info) => {
          console.log(`[proxy] PTY: ${info.term} ${info.cols}x${info.rows}`);
          this.emit('proxy-log', 'info', 'ssh', `PTY: ${info.term} ${info.cols}x${info.rows}`);
          if (acceptPty) acceptPty();
        });

        session.on('shell', (acceptShell) => {
          console.log(`[proxy] Shell requested: ${addr}`);
          this.emit('proxy-log', 'info', 'ssh', `Shell requested: ${addr} — starting WSS bridge`);
          const channel = acceptShell();
          this._bridgeSshToWss(channel, client, addr);
        });

        session.on('exec', (acceptExec, _rejectExec, info) => {
          console.log(`[proxy] Exec: ${info.command}`);
          this.emit('proxy-log', 'info', 'ssh', `Exec: ${info.command}`);
          const channel = acceptExec();
          this._bridgeExecToWss(channel, client, addr, info.command);
        });

        session.on('env', (acceptEnv) => {
          if (acceptEnv) acceptEnv();
        });

        session.on('window-change', (accept) => {
          if (accept) accept();
        });
      });
    });

    client.on('close', () => {
      console.log(`[proxy] SSH client disconnected: ${addr}`);
      this.emit('proxy-log', 'info', 'ssh', `Client disconnected: ${addr}`);
      this._clients.delete(client);
      this.emit('connection', this._clients.size);
    });

    client.on('error', (err) => {
      console.error(`[proxy] SSH client error: ${err.message}`);
      this.emit('proxy-log', 'error', 'ssh', `Client error: ${err.message}`);
    });
  }

  // ---- Session management ----

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
    const sessions = [];
    for (const s of this._sessions.values()) {
      sessions.push(this._sessionSnapshot(s));
    }
    return sessions;
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
    if (!session) return false;

    // Target only the specific session's SSH client
    if (session._sshClient) {
      try { session._sshClient.end(); } catch (_) {}
    }
    return true;
  }

  // ---- Start / Stop ----

  start() {
    // Prevent concurrent starts — _started is set async in listen callback
    if (this._started || this._starting) return Promise.resolve();
    this._starting = true;

    return new Promise((resolve, reject) => {
      if (this._started) { this._starting = false; return resolve(); }

      const hostKey = ProxyServer._ensureHostKey();

      this._sshServer = new SSHServer(
        { hostKeys: [hostKey] },
        (client) => this._onSshClient(client)
      );

      this._server = net.createServer({ allowHalfOpen: false }, (socket) => {
        try {
          this._sshServer.injectSocket(socket);
        } catch (e) {
          console.error('[proxy] injectSocket failed:', e.message);
          socket.destroy();
        }
      });

      this._server.on('error', (err) => {
        console.error('[proxy] TCP server error:', err.message);
        if (err.code === 'EADDRINUSE')
          console.error(`[proxy] Port ${this.port} in use: lsof -i :${this.port}`);
        this.emit('error', err);
        if (!this._started) { this._starting = false; reject(err); }
      });

      // Reject if server closes before listening (e.g. stop() called during start)
      this._server.once('close', () => {
        if (!this._started) { this._starting = false; reject(new Error('Server closed before listening')); }
      });

      this._server.listen(this.port, this.host, () => {
        this._started = true;
        this._starting = false;
        this._startTime = Date.now();
        this._server.removeAllListeners('close'); // clean up the guard
        console.log(`[proxy] Listening on ${this.host}:${this.port}`);
        this.emit('started', { host: this.host, port: this.port });
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this._started) return resolve();

      for (const client of this._clients) {
        try { client.end(); } catch (_) {}
      }
      this._clients.clear();
      // Emit session-close for each active session BEFORE clearing the map
      for (const sessionId of this._sessions.keys()) {
        this.emit('session-close', { sessionId });
      }
      this._sessions.clear();
      this._startTime = null;
      this._totalBytesSent = 0;
      this._totalBytesReceived = 0;

      if (this._server) {
        this._server.close(() => {
          this._started = false;
          this._sshServer = null;
          console.log('[proxy] Server stopped');
          this.emit('stopped');
          resolve();
        });
      } else {
        this._started = false;
        this.emit('stopped');
        resolve();
      }
    });
  }

  updateCookie(cookieString) {
    this.cookie = cookieString;
    console.log('[proxy] Cookie updated');
  }
}

module.exports = { ProxyServer };
