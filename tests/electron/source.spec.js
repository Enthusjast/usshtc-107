'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { launch, cleanup, rpc, envelope, scope, waitState, unusedPort, invalidSender, screenshot,
  assertNoExternal, exitNormally, navigate } = require('./helpers.cjs');

async function control(context, patch) {
  await context.application.evaluate(({ app }, patch) => { Object.assign(app.__acceptance, patch); }, patch);
}
async function login(context, trigger) {
  const opened = context.application.waitForEvent('window');
  await trigger();
  const auth = await opened;
  await expect(auth.getByRole('heading', { name: 'Test-only CAS' })).toBeVisible();
  expect(await auth.evaluate(() => typeof window.electronAPI)).toBe('undefined');
  const prefs = await context.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .find((window) => window.webContents.getURL() === 'https://id.ustc.edu.cn/cas/login').webContents.getLastWebPreferences());
  expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  await auth.getByRole('button', { name: 'Complete fixture sign-in' }).click();
  await waitState(context.page, { loginStatus: 'success', cookieValid: true, proxyStatus: 'started', operation: null });
}
async function skipSetup(context) {
  await expect(context.page.getByRole('heading', { level: 1, name: 'First-time setup' })).toBeVisible();
  await context.page.getByRole('button', { name: 'Skip for now', exact: true }).click();
  await expect(context.page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeFocused();
}
async function echoSsh(context, text) {
  await context.application.evaluate(async ({ app }, text) => {
    const channel = app.__acceptance.sshChannel;
    const expected = Buffer.from(text), received = Buffer.alloc(expected.length);
    await new Promise((resolve, reject) => {
      let offset = 0;
      const finish = (error) => {
        clearTimeout(timer); channel.removeListener('data', data); channel.removeListener('error', fail);
        if (error) reject(error); else resolve();
      };
      const fail = (error) => finish(error);
      const data = (chunk) => {
        if (chunk.length > received.length - offset) { finish(new Error('Unexpected SSH echo bytes')); return; }
        chunk.copy(received, offset); offset += chunk.length;
        if (offset === received.length) finish(received.equals(expected) ? null : new Error('SSH/WSS UTF8 echo differs'));
      };
      const timer = setTimeout(() => finish(new Error('Source SSH echo deadline exceeded')), 5000);
      channel.on('data', data); channel.on('error', fail); channel.write(expected);
    });
  }, text);
}
async function sshConnection(context, open) {
  await context.application.evaluate(async ({ app }, { open, identityModule }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath());
    const control = app.__acceptance;
    if (!open) { control.sshClient?.end(); control.sshClient = null; return; }
    const crypto = load('node:crypto'), path = load('node:path');
    const { Client } = load('ssh2');
    const { getSsh2ClientIdentity } = load(identityModule);
    const runtime = control.runtime.getController().getSnapshot();
    const identity = getSsh2ClientIdentity({ sshDirectory: path.join(control.root, 'home/.ssh') });
    const root = JSON.parse(load('node:fs').readFileSync(path.join(control.root, 'userData/settings.json')));
    const client = new Client(); control.sshClient = client;
    client.on('error', () => {});
    await new Promise((resolve, reject) => {
      client.once('ready', resolve); client.once('error', reject);
      client.connect({ host: '127.0.0.1', port: runtime.runningConfig.port, username: 'fixture',
        privateKey: identity.privateKey, readyTimeout: 5000,
        hostVerifier: (wire) => `SHA256:${crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}` === root.keys.hostFingerprint,
      });
    });
    await new Promise((resolve, reject) => client.shell({ term: 'xterm', cols: 80, rows: 24 }, (error, channel) => {
      if (error) { reject(error); return; }
      control.sshChannel = channel;
      channel.on('error', () => {});
      resolve();
    }));
  }, { open, identityModule: path.resolve(__dirname, '../../electron/ssh-key-service.js') });
  if (open) await echoSsh(context, 'fixture-ssh 中文🙂');
}
async function savePort(context, port) {
  await context.page.locator('#setting-port').fill(String(port));
  await context.page.getByRole('button', { name: 'Save Settings', exact: true }).click();
  await expect.poll(() => rpc(context.page, 'getStatus')).toMatchObject({ operation: null, desiredConfig: { port } });
  await expect(context.page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
}

test('real source wizard: skip/resume/back, private CAS, explicit SSH config, TLS/SSH verified finish and redacted exports', async ({}, testInfo) => {
  let context;
  try {
    context = await launch(testInfo);
    const { page, application, root } = context;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await skipSetup(context);
    await page.getByRole('button', { name: 'Resume setup', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'First-time setup' })).toBeFocused();
    await login(context, () => page.getByRole('button', { name: 'Login', exact: true }).click());
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('#setup-step-heading')).toHaveText('Review SSH config');
    await expect(page.locator('#setup-step-heading')).toBeFocused();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#setup-step-heading')).toHaveText('Log in');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Skip for now', exact: true }).click();
    const progress = await rpc(page, 'getProfiles');
    expect(progress.profiles[0].onboarding).toEqual({ status: 'dismissed', step: 'config' });
    await page.getByRole('button', { name: 'Resume setup', exact: true }).click();
    await expect(page.locator('#setup-step-heading')).toHaveText('Review SSH config');
    const configPath = path.join(root, 'home/.ssh/config');
    expect(fs.existsSync(configPath)).toBe(false);
    await page.getByRole('button', { name: 'Preview saved SSH config', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Generate ~/.ssh/config', exact: true })).toBeEnabled();
    expect(fs.existsSync(configPath)).toBe(false); // Preview is genuinely read-only.
    const unmanaged = Buffer.from('# fixture personal config\r\nHost personal\r\n  Port 2222');
    fs.writeFileSync(configPath, unmanaged, { mode: 0o600 });
    await page.getByRole('button', { name: 'Generate ~/.ssh/config', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('changed');
    expect(fs.readFileSync(configPath)).toEqual(unmanaged);
    await page.getByRole('button', { name: 'Generate ~/.ssh/config', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
    expect(fs.readFileSync(configPath).subarray(-unmanaged.length)).toEqual(unmanaged);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('Host *');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.locator('#setup-step-heading')).toHaveText('Start the proxy');
    await rpc(page, 'stopProxy', await scope(page));
    await waitState(page, { proxyStatus: 'stopped', operation: null });
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await waitState(page, { proxyStatus: 'started', operation: null });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Finish setup', exact: true })).toBeDisabled();
    await control(context, { holdDns: true });
    await page.getByRole('button', { name: 'Run diagnostics', exact: true }).click();
    await expect.poll(async () => {
      const result = await rpc(page, 'getDiagnostics', await scope(page));
      return result?.checks.some((check) => check.id === 'dns' && check.status === 'running');
    }).toBe(true);
    for (const name of ['Back', 'Skip for now', 'Finish setup']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    await expect(page.locator('#active-profile')).toBeDisabled();
    await page.locator('aside').getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'First-time setup' })).toBeVisible();
    await application.evaluate(({ app }) => app.__acceptance.releaseDns());
    await expect(page.getByRole('button', { name: 'Finish setup', exact: true })).toBeEnabled();
    const proof = await rpc(page, 'getDiagnostics', await scope(page));
    expect(proof.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'local-listener', status: 'passed', code: 'LOCAL_SSH_OK', mode: 'ssh-auth' }),
      expect.objectContaining({ id: 'tls', status: 'passed', code: 'TLS_OK' }),
      expect.objectContaining({ id: 'wss', status: 'passed', code: 'WSS_SHELL_READY' }),
      expect.objectContaining({ id: 'token', status: 'passed', code: 'TOKEN_OK' }),
      expect.objectContaining({ id: 'setup', status: 'passed', code: 'SETUP_OK' }),
      expect.objectContaining({ id: 'remote-command', status: 'passed', code: 'REMOTE_COMMAND_OK' }),
    ]));
    await screenshot(context, 'source-verified-wizard');
    await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeFocused();
    expect((await rpc(page, 'getProfiles')).profiles[0].onboarding.status).toBe('completed');
    const auth = await application.evaluate(({ app }) => ({ visits: app.__acceptance.authVisits, cookies: app.__acceptance.upgradeCookies }));
    expect(auth.visits).toEqual(expect.arrayContaining(['https://id.ustc.edu.cn/cas/login', 'https://107.ustc.edu.cn/shell/training/11.11.10.202']));
    expect(auth.cookies).toContain('SCOW_USER=fixture-A');
    expect(fs.readFileSync(path.join(root, 'home/.ssh/usshtc107_ed25519'), 'utf8')).toContain('BEGIN PRIVATE KEY');
    await application.evaluate(({ app }) => app.__acceptance.emitLogs(520));
    const logs = await rpc(page, 'getLogs');
    expect(logs).toHaveLength(500);
    expect(logs[0].message).toContain('fixture-log-20');
    expect(JSON.stringify(logs)).not.toMatch(/fixture-secret-(?:cookie|token|password|ticket)/);
    await navigate(page, 'Logs');
    await page.locator('#log-filter-query').fill('FIXTURE-LOG-519');
    await expect(page.locator('.log-entry')).toHaveCount(1);
    await page.getByRole('button', { name: 'Copy matches', exact: true }).click();
    const copied = await application.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toMatch(/\d{4}-\d\d-\d\dT.*INFO.*fixture-log-519/i);
    expect(copied).not.toContain('fixture-secret');
    await control(context, { nextExport: 'matching.json' });
    await page.getByRole('button', { name: 'Export matches', exact: true }).click();
    await expect(page.getByText('Matching logs exported', { exact: true })).toBeVisible();
    expect(JSON.parse(fs.readFileSync(path.join(root, 'exports/matching.json')))).toHaveLength(1);
    await control(context, { nextExport: 'diagnostics.json' });
    await page.getByRole('button', { name: 'Export diagnostic package', exact: true }).click();
    await expect(page.getByText('Diagnostic package exported', { exact: true })).toBeVisible();
    const exported = fs.readFileSync(path.join(root, 'exports/diagnostics.json'), 'utf8');
    expect(JSON.parse(exported).logs).toHaveLength(500); // Not just the active one-row UI filter.
    expect(exported).not.toMatch(/fixture-secret|BEGIN .*PRIVATE KEY|ssoUsername|ssoPassword|savedCookieEncrypted/);
    expect(exported).not.toContain(path.join(root, 'home'));
    const cancelled = await rpc(page, 'exportDiagnostics', await scope(page));
    expect(cancelled).toEqual({ cancelled: true });
    expect(fs.readdirSync(path.join(root, 'exports')).sort()).toEqual(['diagnostics.json', 'matching.json']);
    await invalidSender(context);
    await assertNoExternal(context);
    await exitNormally(context);
  } finally { await cleanup(context); }
});

test('real source saved/running settings, clipboard/restart confirmations, scoped credentials, theme/language/navigation and exit', async ({}, testInfo) => {
  let context;
  try {
    context = await launch(testInfo);
    const { page, application, root, port } = context;
    await skipSetup(context);
    await control(context, { confirmResponse: 0 });
    await navigate(page, 'Settings');
    await page.locator('#setting-ssoUsername').fill('fixture-account-A');
    await page.locator('#setting-ssoPassword').fill('fixture-password-A');
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect(page.locator('#setting-ssoPassword')).toHaveValue('');
    expect(await rpc(page, 'getSsoCredentials', await scope(page))).toMatchObject({ profileId: 'default', username: 'fixture-account-A', hasPassword: true, storageAvailable: true });
    await navigate(page, 'Dashboard');
    await login(context, () => page.getByRole('button', { name: 'Login', exact: true }).click());
    const newPort = await unusedPort();
    await navigate(page, 'Settings');
    await savePort(context, newPort);
    let state = await rpc(page, 'getStatus');
    expect(state).toMatchObject({ needsRestart: true, desiredConfig: { port: newPort }, runningConfig: { port } });
    const stalePreview = await rpc(page, 'previewSshConfig', await scope(page));
    await savePort(context, port);
    expect((await rpc(page, 'getStatus')).needsRestart).toBe(false);
    expect(await envelope(page, 'generateSshConfig', { scope: await scope(page), sourceHash: stalePreview.sourceHash, configHash: stalePreview.configHash }))
      .toEqual({ ok: false, error: { code: 'SSH_CONFIG_CHANGED' } });
    await savePort(context, newPort);
    await navigate(page, 'Dashboard');
    await expect(page.locator('.code-block').filter({ hasText: 'ssh -o' })).toContainText(`-p ${port} `);
    await page.getByRole('button', { name: 'Copy command', exact: true }).click();
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain(`-p ${port} `);
    await sshConnection(context, true);
    await waitState(page, { connectionCount: 1 });
    await navigate(page, 'Settings');
    await page.locator('#setting-cluster').fill('unsaved-cluster');
    await control(context, { confirmResponse: 1 });
    await page.getByRole('button', { name: 'Restart and apply', exact: true }).click();
    await waitState(page, { operation: null, connectionCount: 1, proxyStatus: 'started' });
    await expect(page.locator('#setting-cluster')).toHaveValue('unsaved-cluster');
    expect((await rpc(page, 'getStatus')).runningConfig.port).toBe(port);
    const confirmation = await application.evaluate(({ app }) => app.__acceptance.confirmations.at(-1));
    expect(confirmation).toMatchObject({ defaultId: 1, cancelId: 1 });
    expect(confirmation.detail).toContain('Unsaved');
    expect(confirmation.detail).toContain('1 active');
    await control(context, { confirmResponse: 0 });
    await page.getByRole('button', { name: 'Restart and apply', exact: true }).click();
    state = await waitState(page, { operation: null, proxyStatus: 'started', connectionCount: 0 });
    expect(state).toMatchObject({ needsRestart: false, runningConfig: { port: newPort } });
    await expect(page.locator('#setting-cluster')).toHaveValue('training');
    await sshConnection(context, true); // New port really accepts the same generated identity.
    await sshConnection(context, false);
    await waitState(page, { connectionCount: 0 });
    const oldListener = await application.evaluate(async ({ app }, oldPort) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath());
      return new Promise((resolve) => { const socket = load('node:net').connect({ host: '127.0.0.1', port: oldPort });
        socket.once('connect', () => { socket.destroy(); resolve('open'); }); socket.once('error', (error) => resolve(error.code)); });
    }, port);
    expect(oldListener).toBe('ECONNREFUSED');
    await page.locator('#setting-cluster').fill('dirty-navigation');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('aside').getByRole('button', { name: 'Logs', exact: true }).click();
    await expect(page.locator('#setting-cluster')).toHaveValue('dirty-navigation');
    page.once('dialog', (dialog) => dialog.accept());
    await navigate(page, 'Dashboard');
    await sshConnection(context, true);
    const a = await scope(page);
    const bPort = await unusedPort();
    await rpc(page, 'createProfile', { scope: a, name: 'Fixture B', settings: { port: bPort, autoConnect: false } });
    const b = (await rpc(page, 'getProfiles')).profiles.find((profile) => profile.name === 'Fixture B');
    await page.reload();
    await expect(page.locator('#active-profile option').filter({ hasText: 'Fixture B' })).toHaveCount(1);
    await waitState(page, { proxyStatus: 'started', connectionCount: 1, cookieValid: true, operation: null });
    await echoSsh(context, 'after renderer reload 中文🙂');
    await page.locator('#active-profile').selectOption(b.id);
    await waitState(page, { profileId: b.id, proxyStatus: 'stopped', cookieValid: false, operation: null });
    await page.getByRole('button', { name: 'Skip for now', exact: true }).click();
    expect(await rpc(page, 'getSsoCredentials', await scope(page))).toMatchObject({ profileId: b.id, username: '', hasPassword: false });
    expect(await envelope(page, 'saveSettings', { scope: a, patch: { port: bPort } })).toEqual({ ok: false, error: { code: 'PROFILE_CHANGED' } });
    await navigate(page, 'Settings');
    await expect(page.locator('#setting-ssoPassword')).toHaveValue('');
    await page.locator('#setting-ssoUsername').fill('fixture-account-B');
    await page.locator('#setting-ssoPassword').fill('fixture-password-B');
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect(page.locator('#setting-ssoPassword')).toHaveValue('');
    await navigate(page, 'Dashboard');
    await login(context, () => page.getByRole('button', { name: 'Login', exact: true }).click());
    await rpc(page, 'startDiagnostics', await scope(page));
    expect(await application.evaluate(({ app }) => app.__acceptance.upgradeCookies.at(-1))).toBe('SCOW_USER=fixture-B');
    await page.locator('#active-profile').selectOption('default');
    await waitState(page, { profileId: 'default', proxyStatus: 'stopped', cookieValid: true, operation: null });
    expect(await rpc(page, 'getSsoCredentials', await scope(page))).toMatchObject({ username: 'fixture-account-A', hasPassword: true });
    expect((await rpc(page, 'getSettings', await scope(page))).port).toBe(newPort);
    const disk = fs.readFileSync(path.join(root, 'userData/settings.json'), 'utf8');
    expect(disk).not.toMatch(/fixture-password-[AB]|SCOW_USER=fixture-[AB]/);
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: '切换到中文', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '仪表盘', exact: true })).toBeVisible();
    await screenshot(context, 'source-light-chinese');
    await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
    await navigate(page, 'Sessions');
    await navigate(page, 'Diagnostics');
    await navigate(page, 'Settings');
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(960, 640); });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await screenshot(context, 'source-dark-settings-960');
    await page.setViewportSize({ width: 375, height: 720 });
    await page.locator('.topbar').getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Application navigation' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page.locator('.topbar').getByRole('button', { name: 'Toggle sidebar', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await screenshot(context, 'source-reduced-motion-375');
    await invalidSender(context);
    await exitNormally(context);
  } finally { await cleanup(context); }
});

test('real source profile options preserve paths and keep remote session features explicitly opt-in', async ({}, testInfo) => {
  let context;
  try {
    context = await launch(testInfo);
    const { page } = context;
    await skipSetup(context);
    await navigate(page, 'Settings');
    await expect(page.locator('#setting-path')).toHaveValue('');
    await expect(page.locator('#setting-startupCommand')).not.toBeChecked();
    await expect(page.locator('#setting-healthProbeEnabled')).not.toBeChecked();
    await expect(page.locator('#setting-validateTokenPeriodically')).not.toBeChecked();
    await page.locator('#setting-host').fill('0.0.0.0');
    await expect(page.locator('#setting-host-warning')).toBeVisible();
    await page.locator('#setting-host-warning').scrollIntoViewIfNeeded();
    await screenshot(context, 'source-nonloopback-warning');
    await page.locator('#setting-host').fill('127.0.0.1');
    await expect(page.locator('#setting-host-warning')).toHaveCount(0);
    await page.locator('#setting-path').fill('/tmp/project with space');
    await page.locator('label[for="setting-startupCommand"]').click();
    await page.locator('label[for="setting-healthProbeEnabled"]').click();
    await page.locator('label[for="setting-validateTokenPeriodically"]').click();
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    expect(await rpc(page, 'getSettings', await scope(page))).toMatchObject({ path: '/tmp/project with space',
      startupCommand: 'tmux new -A -s usshtc', healthProbeEnabled: true, validateTokenPeriodically: true });
    await page.locator('#setting-startupCommand').scrollIntoViewIfNeeded();
    await screenshot(context, 'source-opt-in-remote-features');
    await navigate(page, 'Dashboard');
    await login(context, () => page.getByRole('button', { name: 'Login', exact: true }).click());
    await expect.poll(() => rpc(page, 'getStatus'), { timeout: 75_000 }).toMatchObject({ remoteStatus: 'reachable', errorCode: null });
    await screenshot(context, 'source-real-read-only-health');
    await navigate(page, 'Settings');
    await expect(page.locator('#setting-path')).toHaveValue('/tmp/project with space');
    await expect(page.locator('#setting-startupCommand')).toBeChecked();
    await expect(page.locator('#setting-healthProbeEnabled')).toBeChecked();
    await expect(page.locator('#setting-validateTokenPeriodically')).toBeChecked();
    await page.locator('label[for="setting-validateTokenPeriodically"]').click();
    await page.locator('label[for="setting-startupCommand"]').click();
    await page.locator('label[for="setting-healthProbeEnabled"]').click();
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    expect(await rpc(page, 'getSettings', await scope(page))).toMatchObject({ startupCommand: '', healthProbeEnabled: false, validateTokenPeriodically: false });
    await exitNormally(context);
  } finally { await cleanup(context); }
});

test('real source official APIs: explicit credential-safe desktop/app actions and native binary transfers without SSH', async ({}, testInfo) => {
  let context;
  try {
    context = await launch(testInfo);
    const { page, application, root } = context;
    await skipSetup(context);
    await login(context, () => page.getByRole('button', { name: 'Login', exact: true }).click());
    const setups = await application.evaluate(({ app }) => app.__acceptance.portalCalls.filter(path => path === '/api/setup').length);
    await sshConnection(context, true);
    await echoSsh(context, 'no additional portal setup per SSH channel');
    await sshConnection(context, false);
    await waitState(page, { connectionCount: 0 });
    expect(await application.evaluate(({ app }) => app.__acceptance.portalCalls.filter(path => path === '/api/setup').length)).toBe(setups);
    await rpc(page, 'stopProxy', await scope(page));
    await waitState(page, { proxyStatus: 'stopped', operation: null, cookieValid: true });
    await navigate(page, 'Desktops & apps', 'Remote desktops and applications');
    await expect(page.getByRole('heading', { name: 'Fixture desktop', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fixture app session', exact: true })).toBeVisible();
    expect(await application.evaluate(({ app }) => app.__acceptance.portalLaunches)).toBe(0);
    await page.getByRole('button', { name: 'Open in browser — Fixture desktop', exact: true }).click();
    await expect.poll(() => application.evaluate(({ app }) => app.__acceptance.openedLinks.length)).toBe(1);
    expect(await application.evaluate(({ app }) => {
      const link = new URL(app.__acceptance.openedLinks[0]);
      return { origin: link.origin, path: link.pathname, secretPresent: link.searchParams.get('password') === 'fixture-vnc-private' };
    })).toEqual({ origin: 'https://107.ustc.edu.cn', path: '/vnc/vnc.html', secretPresent: true });
    await page.getByRole('button', { name: 'Open in browser — Fixture app session', exact: true }).click();
    await expect.poll(() => application.evaluate(({ app }) => app.__acceptance.openedLinks.length)).toBe(2);
    await page.getByRole('button', { name: 'Copy connection link — Fixture desktop', exact: true }).click();
    await expect.poll(() => application.evaluate(({ clipboard }) => {
      const link = new URL(clipboard.readText());
      return link.pathname === '/vnc/vnc.html' && link.searchParams.has('password');
    })).toBe(true);
    await expect(page.locator('body')).not.toContainText('fixture-vnc-private');
    await expect(page.locator('body')).not.toContainText('fixture-app-private');
    await screenshot(context, 'source-official-remote-sessions');
    const bytes = crypto.randomBytes(1536 * 1024);
    fs.writeFileSync(path.join(root, 'exports', 'native-upload.bin'), bytes, { mode: 0o600 });
    await navigate(page, 'File transfers');
    await page.locator('#transfer-remote-path').fill('/remote/native-api.bin');
    await control(context, { nextUpload: 'native-upload.bin' });
    await page.getByRole('button', { name: 'Upload a file…', exact: true }).click();
    await expect.poll(async () => (await rpc(page, 'listTransfers', { scope: await scope(page) })).items.map(item => item.status)).toEqual(['completed']);
    expect(await application.evaluate(({ app }) => app.__acceptance.portal.files.get('/remote/native-api.bin').length)).toBe(bytes.length);
    await control(context, { nextExport: 'native-download.bin' });
    await page.getByRole('button', { name: 'Download a file…', exact: true }).click();
    await expect.poll(async () => (await rpc(page, 'listTransfers', { scope: await scope(page) })).items.map(item => item.status)).toEqual(['completed', 'completed']);
    expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'exports', 'native-download.bin'))).digest('hex'))
      .toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    await expect(page.getByRole('progressbar', { name: 'Transfer progress — native-api.bin' })).toHaveAttribute('value', '100');
    await screenshot(context, 'source-official-api-transfers');
    await application.evaluate(({ app }) => {
      app.__acceptance.portal.dirs.add('/outside');
      app.__acceptance.portal.files.set('/outside/private.bin', Buffer.from('fixture-private-file-body'));
      app.__acceptance.portal.symlinks.set('/remote/outside-link', '/outside/private.bin');
    });
    await page.locator('#transfer-remote-path').fill('/remote/outside-link');
    await control(context, { nextExport: 'must-not-be-downloaded.bin' });
    await page.getByRole('button', { name: 'Download a file…', exact: true }).click();
    await expect.poll(async () => (await rpc(page, 'listTransfers', { scope: await scope(page) })).items.at(-1))
      .toMatchObject({ filename: 'outside-link', status: 'failed', errorCode: 'TRANSFER_UNSAFE_TYPE' });
    const unsafeRow = page.locator('article').filter({ has: page.getByRole('heading', { name: 'outside-link', exact: true }) });
    await expect(unsafeRow.getByRole('alert')).toBeVisible();
    await expect(unsafeRow.getByRole('alert')).not.toContainText('TRANSFER_UNSAFE_TYPE');
    await expect(page.locator('body')).not.toContainText('fixture-private-file-body');
    expect(fs.existsSync(path.join(root, 'exports', 'must-not-be-downloaded.bin'))).toBe(false);
    expect(await application.evaluate(({ app }) => app.__acceptance.portal.requests.some(request =>
      request.pathname === '/api/file/download' && ['/outside/private.bin', '/remote/outside-link'].includes(request.query.path)))).toBe(false);
    await screenshot(context, 'source-refused-remote-symlink');
    const safeItems = await rpc(page, 'listTransfers', { scope: await scope(page) });
    expect(JSON.stringify(safeItems)).not.toMatch(/SCOW_USER|fixture-token|\/exports\/|fixture-vnc-private|fixture-app-private/);
    await control(context, { nextExport: 'portal-safe.json' });
    await rpc(page, 'exportDiagnostics', await scope(page));
    expect(fs.readFileSync(path.join(root, 'exports', 'portal-safe.json'), 'utf8')).not.toMatch(/fixture-vnc-private|fixture-app-private|credential=/);
    await assertNoExternal(context);
    await exitNormally(context);
  } finally { await cleanup(context); }
});

test('real source REST rejection and setup failure gate new listeners without removing stored credentials', async ({}, testInfo) => {
  let context;
  try {
    context = await launch(testInfo);
    const { page } = context;
    await skipSetup(context);
    await login(context, () => page.getByRole('button', { name: 'Login', exact: true }).click());
    await rpc(page, 'stopProxy', await scope(page));
    await control(context, { apiReject: true });
    expect(await envelope(page, 'startProxy', await scope(page))).toEqual({ ok: false, error: { code: 'AUTH_REQUIRED' } });
    await waitState(page, { proxyStatus: 'stopped', cookieValid: true, loginStatus: 'success', remoteStatus: 'auth_required', operation: null });
    await control(context, { apiReject: false, apiSetupFailed: true });
    expect(await envelope(page, 'startProxy', await scope(page))).toEqual({ ok: false, error: { code: 'PORTAL_NETWORK' } });
    await waitState(page, { proxyStatus: 'stopped', cookieValid: true, loginStatus: 'success', operation: null });
    await control(context, { apiSetupFailed: false });
    await rpc(page, 'startProxy', await scope(page));
    await waitState(page, { proxyStatus: 'started', cookieValid: true, operation: null });
    await exitNormally(context);
  } finally { await cleanup(context); }
});

test('real source SCP profile limits save, require restart, and remain accessible in both languages', async ({}, testInfo) => {
  let context;
  try {
    context = await launch(testInfo);
    const { page } = context;
    await skipSetup(context);
    await control(context, { confirmResponse: 0 });
    await navigate(page, 'Settings');
    await expect(page.getByLabel('Legacy SCP maximum file size (bytes)', { exact: true })).toHaveValue('1073741824');
    await expect(page.getByLabel('Legacy SCP: refuse existing remote files', { exact: true })).not.toBeChecked();
    await page.locator('#setting-scpMaxFileBytes').fill('2097152');
    await page.locator('label[for="setting-scpNoOverwrite"]').click();
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    await navigate(page, 'Dashboard');
    await login(context, () => page.getByRole('button', { name: 'Login', exact: true }).click());
    await navigate(page, 'Settings');
    await page.locator('#setting-scpMaxFileBytes').fill('1048576');
    await page.locator('#setting-scpNoOverwrite').focus();
    await page.locator('#setting-scpNoOverwrite').press('Space');
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await waitState(page, { needsRestart: true, runningConfig: { scpMaxFileBytes: 2097152, scpNoOverwrite: true },
      desiredConfig: { scpMaxFileBytes: 1048576, scpNoOverwrite: false } });
    await page.getByRole('button', { name: 'Restart and apply', exact: true }).click();
    await waitState(page, { operation: null, needsRestart: false, proxyStatus: 'started',
      runningConfig: { scpMaxFileBytes: 1048576, scpNoOverwrite: false } });
    await page.getByRole('button', { name: '切换到中文', exact: true }).click();
    await expect(page.getByLabel('传统 SCP 单文件大小上限（字节）', { exact: true })).toHaveValue('1048576');
    await page.locator('#scp-settings-heading').scrollIntoViewIfNeeded();
    await screenshot(context, 'source-scp-profile-settings');
    await exitNormally(context);
  } finally { await cleanup(context); }
});
