import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The web app is served by the reasoner server in production (static assets out
 * of `dist/`). In dev it runs on its own port and proxies the read API and MCP
 * bridge to the server, so the browser never needs cross-origin config.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5174,
    // Bind loopback only: the reasoner stack has no authentication layer.
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/mcp': { target: 'http://127.0.0.1:8787', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
