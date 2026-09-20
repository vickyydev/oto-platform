import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Same shape as apps/launcher/vite.config.ts and apps/pos/vite.config.ts: /api
// is proxied to the Fastify server in development and rewritten to it by Render
// in staging, which is what keeps the session cookie same-origin on this app's
// own origin. Port 25743 follows the POS (25741) and the launcher (25742).
const port = Number(process.env.CONSOLE_PORT ?? 25743);
const apiPort = Number(process.env.API_PORT ?? 3001);
const basePath = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
    fs: { strict: true },
  },
  preview: { port, host: '0.0.0.0', allowedHosts: true },
});
