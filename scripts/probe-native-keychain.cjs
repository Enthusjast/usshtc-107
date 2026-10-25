'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { redactLogMessage } = require('../electron/log-redaction');
if (process.platform !== 'darwin' || process.env.CI !== 'true') throw new Error('Native CI only');
for (const isolated of [false, true]) {
  for (const name of ['login.keychain-db', 'acceptance.keychain-db']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-keychain-probe-'));
    const home = path.join(root, 'home');
    const directory = path.join(home, 'Library/Keychains');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keychain = path.join(directory, name);
    const password = randomBytes(32).toString('hex');
    const env = isolated ? { ...process.env, HOME: home } : process.env;
    for (const args of [
      ['create-keychain', '-p', password, keychain],
      ['set-keychain-settings', '-lut', '21600', keychain],
      ['unlock-keychain', '-p', password, keychain],
      ['show-keychain-info', keychain],
      ['delete-keychain', keychain],
    ]) {
      const result = spawnSync('/usr/bin/security', args, { env, encoding: 'utf8', timeout: 10000 });
      console.log(JSON.stringify({ isolated, name, command: args[0], status: result.status,
        stderr: redactLogMessage((result.stderr || '').replaceAll(password, '[REDACTED]')) }));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
