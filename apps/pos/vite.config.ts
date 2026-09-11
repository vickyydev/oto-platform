import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Ported from the prototype's config, with platform defaults so
// `pnpm dev` needs no manual env (CLAUDE.md §5 SCRUM-9 done-criteria):
// POS on POS_PORT (25741), /api proxied to the Fastify server.
const port = Number(process.env.POS_PORT ?? process.env.PORT ?? 25741);
const apiPort = Number(process.env.API_PORT ?? 3001);
const basePath = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(import.meta.dirname, '..', '..', '..', 'attached_assets'),
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
