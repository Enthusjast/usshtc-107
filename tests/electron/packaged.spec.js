'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { launch, cleanup, rpc, scope, waitState, unusedPort, invalidSender, screenshot, exitNormally, navigate } = require('./helpers.cjs');

test('actual native package: isolated sandboxed UI/IPC/config/preferences, physical distribution update mode and coordinated exit', async ({}, testInfo) => {
  let context;
  try {
    context = await launch(testInfo, { packaged: true });
    const { application, page, root, executable } = context;
    await expect(page.getByRole('heading', { level: 1, name: 'First-time setup' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeFocused();
    expect((await rpc(page, 'getStatus')).cookieValid).toBe(false);
    const distribution = await application.evaluate(({ app }, executable) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath());
      const fs = load('original-fs'), path = load('node:path');
      let packageType = '';
      try { packageType = fs.readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim(); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const archive = app.getAppPath();
      return { archive, physicalArchive: fs.statSync(archive).isFile(),
        updateConfig: fs.statSync(path.join(process.resourcesPath, 'app-update.yml')).isFile(),
        packageType, appImage: process.env.APPIMAGE || null, appDir: process.env.APPDIR || null,
        executable: process.execPath, arch: process.arch,
        requestedImage: executable.endsWith('.AppImage'),
      };
    }, executable);
    expect(distribution.physicalArchive).toBe(true);
    expect(distribution.updateConfig).toBe(true);
    const update = await rpc(page, 'getUpdateState');
    // The caller identifies an extracted installed distribution independently;
    // do not duplicate the product's unpacked-path detection in this oracle.
    const expectedMode = process.env.APP_EXPECTED_UPDATE_MODE || (executable.endsWith('.AppImage') ? 'in-app' : 'unsupported');
    if (!['unsupported', 'manual', 'in-app'].includes(expectedMode)) throw new Error('Invalid expected update mode');
    if (distribution.requestedImage) {
      expect(process.platform).toBe('linux');
      expect(distribution.packageType).not.toBe('deb');
      expect(distribution.appImage).toBe(fs.realpathSync(executable));
      expect(distribution.appDir).toBe(path.dirname(distribution.executable));
    } else {
      expect(distribution.appImage).toBeNull();
      if (expectedMode === 'manual') expect(distribution.packageType).toBe('deb');
    }
    expect(update).toMatchObject({ phase: 'idle', installMode: expectedMode, availableVersion: null, progress: null, errorCode: null });
    await navigate(page, 'Desktops & apps', 'Remote desktops and applications');
    await expect(page.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
    await expect(page.getByText('No existing desktops in this cluster. Create desktops in the portal.', { exact: true })).toHaveCount(0);
    await navigate(page, 'File transfers');
    await expect(page.getByRole('button', { name: 'Sign in again', exact: true })).toBeVisible();
    expect((await rpc(page, 'getStatus')).cookieValid).toBe(false);
    await screenshot(context, 'packaged-api-auth-boundaries');
    await navigate(page, 'Settings');
    await expect(page.locator('#setting-port')).toHaveValue(String(context.port));
    const nextPort = await unusedPort();
    await page.locator('#setting-port').fill(String(nextPort));
    await page.getByRole('button', { name: 'Save Settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeDisabled();
    expect((await rpc(page, 'getSettings', await scope(page))).port).toBe(nextPort);
    expect(await rpc(page, 'getStatus')).toMatchObject({ proxyStatus: 'stopped', runningConfig: null, needsRestart: false, desiredConfig: { port: nextPort } });
    const configFile = path.join(root, 'home/.ssh/config');
    await page.getByRole('button', { name: 'Preview saved SSH config', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Generate ~/.ssh/config', exact: true })).toBeEnabled();
    expect(fs.existsSync(configFile)).toBe(false);
    await expect(page.getByLabel('Managed SSH config block preview')).toContainText(`Port ${nextPort}`);
    await page.getByRole('button', { name: 'Generate ~/.ssh/config', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Generate ~/.ssh/config', exact: true })).toBeDisabled();
    expect(fs.readFileSync(configFile, 'utf8')).toContain(`Port ${nextPort}`);
    await page.getByRole('button', { name: '切换到中文', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await screenshot(context, 'packaged-light-settings');
    await navigate(page, 'Dashboard');
    await expect(page.locator('.code-block').filter({ hasText: 'ssh -o' })).toContainText(`-p ${nextPort} `);
    await page.getByRole('button', { name: 'Copy command', exact: true }).click();
    expect(await application.evaluate(({ clipboard }) => clipboard.readText())).toContain(`-p ${nextPort} `);
    await navigate(page, 'Sessions');
    await navigate(page, 'Logs');
    await expect(page.getByRole('log', { name: 'Logs' })).toBeVisible();
    await navigate(page, 'Diagnostics');
    // Do not run diagnostics/login/update checks in production packages. All
    // automatic preferences remain false and the test-side network guard is on.
    await navigate(page, 'Settings');
    await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 640));
    await screenshot(context, 'packaged-dark-settings-960');
    await invalidSender(context);
    const settings = await rpc(page, 'getSettings', await scope(page));
    expect(settings).toMatchObject({ autoConnect: false, autoCheckUpdates: false, launchAtLogin: false });
    await waitState(page, { proxyStatus: 'stopped', cookieValid: false, operation: null });
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect((await rpc(page, 'getUpdateState')).checkedAt).toBeNull();
    await exitNormally(context);
  } finally { await cleanup(context); }
});
