import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built into dist-web/, served by server/server.ts under a strict CSP (no inline script, no inline style).
// `npm run dev:web` serves the page from Vite for hot reload and proxies /api to a running `cohorte ui`:
//   COHORTE_UI_PORT=<port> npm run dev:web   — the proxy rewrites Origin so the server's Origin check passes.
const port = process.env.COHORTE_UI_PORT;
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist-web', emptyOutDir: true, sourcemap: false, target: 'es2022', cssCodeSplit: false },
  server: port ? { proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true, configure: (p) => p.on('proxyReq', (r) => r.setHeader('Origin', `http://127.0.0.1:${port}`)) } } } : {},
});
