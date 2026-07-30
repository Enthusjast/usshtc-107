import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.jsx'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,jsx}'],
      reportsDirectory: './coverage/ui',
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        statements: 30,
        branches: 25,
        functions: 20,
        lines: 33,
      },
    },
  },
});
