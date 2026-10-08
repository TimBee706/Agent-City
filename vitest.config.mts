import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Webview components (.tsx) are rendered to static markup in a few unit tests.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
