import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // The vendored pdf and qr libraries are the same files the browser loads.
    testTimeout: 30_000,
  },
});
