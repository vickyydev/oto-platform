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

/**
 * The `/api` proxy, one definition for the dev server and for `vite preview`.
 * The preview server serves what `vite build` wrote, which is how the Console's
 * end-to-end set runs against the built bundle (`CONSOLE_E2E_BUILT=1`,
 * SCRUM-422); without the same proxy there, every `/api` call the built app
 * makes would land on the static server as a 404 instead of reaching the api.
 */
const apiProxy = {
  '/api': {
    target: `http://localhost:${apiPort}`,
    changeOrigin: false,
    rewrite: (p: string) => p.replace(/^\/api/, ''),
  },
};

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
    rollupOptions: {
      output: {
        /**
         * Third-party code in chunks of its own (SCRUM-422). In one chunk with
         * the app, every build tripped Rollup's 500 kB warning, and every
         * change to a page re-downloaded React and the phone-number metadata
         * with it. React and its renderer go together, the rest of
         * node_modules in one more; the app's own code, workspace packages
         * included, stays in the entry. No splitting by route: the Console is
         * one small app and its sections are not loaded lazily.
         */
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          return /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)
            ? 'react'
            : 'vendor';
        },
      },
    },
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: apiProxy,
    fs: { strict: true },
  },
  // `strictPort` as on the dev server: the e2e harness hands this a port it
  // has just probed free, and a preview that slid to the next one would leave
  // Playwright waiting on the wrong port until its timeout instead of failing.
  preview: { port, strictPort: true, host: '0.0.0.0', allowedHosts: true, proxy: apiProxy },
});
