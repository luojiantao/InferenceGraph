import { defineConfig, devices } from '@playwright/test';

const webPort = Number(process.env.REASONER_WEB_PORT ?? 4173);
const serverPort = Number(process.env.REASONER_SERVER_PORT ?? 8791);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      // Bound to loopback only; the reasoner endpoints carry no authentication.
      command: `pnpm --filter @reasoner/server start`,
      port: serverPort,
      reuseExistingServer: !process.env.CI,
      env: {
        REASONER_HOST: '127.0.0.1',
        REASONER_PORT: String(serverPort),
        REASONER_DATA_DIR: './data/e2e',
      },
    },
    {
      command: `pnpm --filter @reasoner/web preview --port ${webPort} --host 127.0.0.1 --strictPort`,
      port: webPort,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
