import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Same shape as apps/console/vite.config.ts and apps/pos/vite.config.ts: the
// game is a static site, and `/booth` is proxied in development to whatever is
// serving the booth API on this machine. Port 25744 follows the POS (25741),
// the launcher (25742) and the console (25743).
//
// No Tailwind here, unlike the other three. The screen is styled entirely by
// src/kiosk.css, lifted from the wheel it replaces: one stylesheet, plain CSS,
// no build-time class generation. See the note at the top of that file.
const port = Number(process.env.BOOTH_PORT ?? 25744);
const boothApiPort = Number(process.env.BOOTH_API_PORT ?? 25745);
const basePath = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,
  plugins: [react()],
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
      // Nothing answers this in development yet — the page runs on its own
      // fake unless VITE_BOOTH_FAKE=0 (see src/booth/client.ts). The proxy is
      // here so that pointing the page at a real booth service is a one-flag
      // change rather than a code change.
      '/booth': {
        target: `http://localhost:${boothApiPort}`,
        changeOrigin: false,
      },
    },
    fs: { strict: true },
  },
  preview: { port, host: '0.0.0.0', allowedHosts: true },
});
