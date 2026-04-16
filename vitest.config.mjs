// @ts-check
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['chrome-extension/tests/**/*.test.js'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['chrome-extension/**/*.js'],
      exclude: ['chrome-extension/tests/**'],
    },
  },
});
