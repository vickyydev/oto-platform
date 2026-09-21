import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'path';

// Ported from the prototype's config, with platform defaults so
// `pnpm dev` needs no manual env (CLAUDE.md §5 SCRUM-9 done-criteria):
// POS on POS_PORT (25741), /api proxied to the Fastify server.
const port = Number(process.env.POS_PORT ?? process.env.PORT ?? 25741);
const apiPort = Number(process.env.API_PORT ?? 3001);
const basePath = process.env.BASE_PATH ?? '/';

/** Extensions worth holding for an offline load; everything else is left alone. */
const PRECACHE_EXTENSIONS = ['.js', '.css', '.woff2', '.woff', '.png', '.svg'];

/**
 * Files copied verbatim from `public/` that the shell needs offline.
 *
 * Named rather than globbed, and checked against the directory before they go
 * in the list: `install` fails whole if one entry 404s, and a service worker
 * that never installs is worse than one file missing. `opengraph.jpg` and
 * `robots.txt` are deliberately absent — nothing on a counter reads either.
 */
const PUBLIC_PRECACHE = ['favicon.svg', 'manifest.webmanifest'];

/**
 * Emits `sw.js` beside the build with the real hashed filenames written into
 * it (apps/pos/pwa/service-worker.js is the source, and explains the caching
 * rules and the update protocol).
 *
 * WHY BY HAND rather than vite-plugin-pwa or Workbox: the whole job is one
 * precache list and one lifecycle message, the list has to be picked from the
 * bundle anyway, and a generated worker would still need reading line by line
 * to answer the only question that matters here — what this thing keeps on an
 * iPad that can be carried out of a mall. Thirty lines of plugin is cheaper to
 * audit than a dependency and a config.
 */
function otoServiceWorker(base: string): Plugin {
  const root = path.resolve(import.meta.dirname);
  const source = path.join(root, 'pwa', 'service-worker.js');
  const publicDir = path.join(root, 'public');

  return {
    name: 'oto-pos-service-worker',
    apply: 'build',
    // After Vite's own `vite:build-html`, which emits `index.html` in its
    // `generateBundle` — without this the shell's own HTML is not in the
    // bundle yet when this runs, and the precache list comes out without the
    // one file every offline load starts from.
    enforce: 'post',
    generateBundle(_options, bundle) {
      const template = fs.readFileSync(source, 'utf8');
      const digest = createHash('sha256');
      digest.update(template);

      const urls: string[] = [];
      const add = (fileName: string, bytes: Uint8Array | string) => {
        urls.push(base + fileName);
        digest.update(fileName);
        digest.update(typeof bytes === 'string' ? bytes : Buffer.from(bytes));
      };

      for (const fileName of Object.keys(bundle).sort()) {
        if (fileName === 'sw.js' || fileName.endsWith('.map')) continue;
        const entry = bundle[fileName];
        if (!entry) continue;
        const keep =
          fileName === 'index.html' || PRECACHE_EXTENSIONS.some((ext) => fileName.endsWith(ext));
        if (!keep) continue;
        add(fileName, entry.type === 'chunk' ? entry.code : (entry.source as Uint8Array | string));
      }

      for (const fileName of PUBLIC_PRECACHE) {
        const onDisk = path.join(publicDir, fileName);
        if (!fs.existsSync(onDisk)) continue;
        add(fileName, fs.readFileSync(onDisk));
      }

      // The build id is a digest of exactly what was precached, so a rebuild
      // that changed nothing produces the same worker and no till is disturbed
      // — and a one-character change to any precached file produces a
      // different one, which is what a waiting worker is triggered by.
      const buildId = digest.digest('hex').slice(0, 16);

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        // Replacer FUNCTIONS, not strings: `$&` and `$1` in a replacement
        // string are substitution patterns, and a hashed filename is not
        // something to bet on never containing a `$`.
        source: template
          .replace('__BUILD_ID__', () => buildId)
          .replace('__BASE__', () => base)
          .replace('__PRECACHE__', () => JSON.stringify(urls)),
      });
    },
  };
}

export default defineConfig({
  base: basePath,
  plugins: [react(), tailwindcss(), otoServiceWorker(basePath)],
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
