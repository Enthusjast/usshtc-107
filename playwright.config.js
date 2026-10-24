'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/electron',
  outputDir: './test-results',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: 'source', testMatch: '**/source.spec.js' },
    { name: 'packaged', testMatch: '**/packaged.spec.js' },
  ],
});
