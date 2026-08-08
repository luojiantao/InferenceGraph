import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
      'tests/contract/**/*.test.ts',
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/e2e/**'],
    environment: 'node',
    restoreMocks: true,
    sequence: {
      shuffle: false,
    },
  },
});
