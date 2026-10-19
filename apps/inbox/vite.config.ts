import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Same shape as apps/console/vite.config.ts: /api is proxied to the Fastify
// server in development and rewritten to it by Render in staging, which is
// what keeps the session cookie same-origin on this app's own origin. Port
// 25746 follows the POS (25741), the launcher (25742), the console (25743)
// and the booth (25744, its box api on 25745).
const port = Number(process.env.INBOX_PORT ?? 25746);
const apiPort = Number(process.env.API_PORT ?? 3001);
const basePath = process.env.BASE_PATH ?? '/';

/** The `/api` proxy, one definition for the dev server and for `vite preview`. */
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
        // Third-party code in chunks of its own, as the Console splits it
        // (SCRUM-422): React and its renderer together, the rest of
        // node_modules in one more, the app's own code in the entry.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          return /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id) ? 'react' : 'vendor';
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
  preview: { port, strictPort: true, host: '0.0.0.0', allowedHosts: true, proxy: apiProxy },
});
