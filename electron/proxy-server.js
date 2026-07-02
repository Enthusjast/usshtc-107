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
    this.port = options.port || 2222;
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

  _bridgeSshToWss(channel, client, clientStr) {
    console.log(`[proxy] Bridging for ${clientStr}`);

    const ws = new WebSocket(this.wssUrl, {
      headers: {
        Cookie: this.cookie,
        Origin: PLATFORM.origin,
      },
      rejectUnauthorized: false,
      handshakeTimeout: WSS_HANDSHAKE_TIMEOUT,
    });

    const self = this;
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
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch (_) {}
      channel.removeAllListeners();
      try { if (!channel.closed) channel.close(); } catch (_) {}
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
        }
      }
    });

    ws.on('pong', () => {
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    });

    // SSH channel → WebSocket
    ws.on('open', () => {
      startPingPong();
      channel.on('data', (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buildClientMessage(data));
          // Track bytes
          session.bytesSent += data.length;
          self._totalBytesSent += data.length;
          self.emit('traffic', { sessionId, direction: 'sent', bytes: data.length });

          // Only treat 0x04 as Ctrl+D when it's a lone byte (not embedded in binary/escape data)
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
      });
    });

    ws.on('unexpected-response', (_req, res) => {
      console.error(`[proxy] WSS ${res.statusCode} for ${clientStr}`);
      if (res.statusCode === 401 || res.statusCode === 403) {
        self.emit('auth-error', { statusCode: res.statusCode, clientStr });
      }
      cleanup();
    });

    ws.on('error', (err) => {
      console.error(`[proxy] WSS error for ${clientStr}:`, err.message);
      cleanup();
    });

    ws.on('close', (code) => {
      console.log(`[proxy] WSS closed for ${clientStr}: code=${code}`);
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

    client.on('authentication', (ctx) => {
      ctx.accept();
    });

    client.on('ready', () => {
      console.log('[proxy] SSH client authenticated');

      client.on('session', (acceptSession) => {
        const session = acceptSession();

        session.on('pty', (acceptPty, _rejectPty, info) => {
          console.log(`[proxy] PTY: ${info.term} ${info.cols}x${info.rows}`);
          if (acceptPty) acceptPty();
        });

        session.on('shell', (acceptShell) => {
          const channel = acceptShell();
          const addr = (client._sock && `${client._sock.remoteAddress}:${client._sock.remotePort}`) || 'unknown';
          this._bridgeSshToWss(channel, client, addr);
        });

        session.on('exec', (_acceptExec, rejectExec) => {
          rejectExec();
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
      this._clients.delete(client);
      this.emit('connection', this._clients.size);
    });

    client.on('error', (err) => {
      console.error('[proxy] SSH client error:', err.message);
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
