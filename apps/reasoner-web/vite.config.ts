import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The web app is served by the reasoner server in production (static assets out
 * of `dist/`). In dev it runs on its own port and proxies the read API and MCP
 * bridge to the server, so the browser never needs cross-origin config.
 */
export default defineConfig(({ mode }) => {
  // Keep the dev proxy aligned with the server default while still allowing a
  // caller to select an alternate local port.
  const serverTarget = `http://127.0.0.1:${loadEnv(mode, '.', '').REASONER_SERVER_PORT ?? '8791'}`;

  return {
    plugins: [react()],
    build: { outDir: 'dist', sourcemap: true },
    server: {
      port: 5174,
      // Bind loopback only: the reasoner stack has no authentication layer.
      host: '127.0.0.1',
      proxy: {
        '/api': { target: serverTarget, changeOrigin: true },
        '/mcp': { target: serverTarget, changeOrigin: true },
        '/health': { target: serverTarget, changeOrigin: true },
      },
    },
  };
});
