'use strict';

// Source-acceptance only: never imported by the production entry or packaged app.
// POSIX keeps the real PTY. Windows executes the same bootstrap in Git Bash over
// pipes, explicitly modeling only its exact terminal-setup request (pipes neither
// echo input nor translate output). Command decoding/execution/framing stay real.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { quotePosix, buildExecBootstrap } = require('../../electron/exec-codec');

function findGitBash(env = process.env, exists = fs.existsSync) {
  const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter(Boolean)
    .map((directory) => path.win32.join(directory, 'Git'));
  if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  for (const root of [...new Set(roots)]) {
    for (const directory of ['bin', 'usr\\bin']) {
      const candidate = path.win32.join(root, directory, 'bash.exe');
      if (exists(candidate)) return candidate;
    }
  }
  throw new Error('Windows source acceptance requires Git Bash');
}

function createRemoteExecPeer({ onData, onError, onClose,
  mode = process.platform === 'win32' ? 'pipe' : 'pty', shellPath,
  timeoutMs = 15000 } = {}) {
  let child = null;
  let lines = null;
  let timer = null;
  let stopped = false;

  function kill() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    lines?.close();
    child?.stdin.end();
    child?.kill();
  }
  function fail() {
    if (stopped) return;
    kill();
    onError?.(new Error('Source fixture remote interpreter failed'));
  }
  function start(input) {
    const nonce = input.match(/USSHTC_([a-f0-9]{64}):READY/)?.[1];
    if (!nonce || input !== `exec sh -c ${quotePosix(buildExecBootstrap(nonce))}\n`) {
      fail();
      return;
    }
    try {
      if (mode === 'pty') {
        child = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, 'pty-peer.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
      } else if (mode === 'pipe') {
        const shell = shellPath || (process.platform === 'win32' ? findGitBash() : '/bin/bash');
        const terminalModel = "stty() { [ \"$*\" = '-echo -onlcr -icanon min 1 time 0' ]; };\n";
        const env = { ...process.env };
        if (process.platform === 'win32') {
          const bin = path.win32.dirname(shell);
          const root = path.win32.resolve(bin, path.win32.basename(path.win32.dirname(bin)).toLowerCase() === 'usr' ? '../..' : '..');
          const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
          env[pathKey] = [path.win32.join(root, 'usr', 'bin'), path.win32.join(root, 'bin'), env[pathKey] || ''].join(';');
        }
        child = spawn(shell, ['--noprofile', '--norc', '-c', terminalModel + buildExecBootstrap(nonce)], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env,
        });
      } else {
        fail();
        return;
      }
      child.on('error', fail);
      child.stdin.on('error', fail);
      child.stderr.resume();
      child.on('close', () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timer);
        lines?.close();
        onClose?.();
      });
      if (mode === 'pty') {
        lines = readline.createInterface({ input: child.stdout });
        lines.on('line', (line) => {
          if (stopped) return;
          try { onData?.(JSON.parse(line).data); } catch (_) { fail(); }
        });
        child.stdin.write(`${JSON.stringify({ input })}\n`);
      } else {
        child.stdout.on('data', (bytes) => { if (!stopped) onData?.(bytes.toString('utf8')); });
      }
      timer = setTimeout(fail, timeoutMs);
    } catch (_) { fail(); }
  }

  return {
    write(input) {
      if (stopped) return;
      if (!child) start(input);
      else child.stdin.write(mode === 'pty' ? `${JSON.stringify({ input })}\n` : input);
    },
    kill,
  };
}

module.exports = { createRemoteExecPeer, findGitBash };
