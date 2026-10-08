import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * SCRUM-505 — serves the header measurement page (`index.html` beside this)
 * with the till's own React and Tailwind set-up and its `@/` alias, and the
 * three contexts the header reads pointed at `contexts.ts`. Everything else
 * the page draws is the till's source as it stands.
 *
 * Its own config, not `vite.config.ts`: that one listens on the till's fixed
 * port (a dev server already running there would collide), proxies `/api` and
 * builds a service worker, none of which a measurement wants.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const posRoot = path.resolve(here, '../../..');
const contexts = path.join(here, 'contexts.ts');

export interface HarnessServer {
  /** The measurement page's address, without a query string. */
  url: string;
  close: () => Promise<void>;
}

export async function startHeaderHarness(): Promise<HarnessServer> {
  const server: ViteDevServer = await createServer({
    configFile: false,
    root: posRoot,
    // Its own pre-bundle cache, so a run never rewrites the dev server's.
    cacheDir: path.join(posRoot, 'node_modules/.vite-header-harness'),
    logLevel: 'error',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: /^@\/auth\/OperatorContext$/, replacement: contexts },
        { find: /^@\/branch\/BranchContext$/, replacement: contexts },
        { find: /^@\/station\/StationContext$/, replacement: contexts },
        { find: '@', replacement: path.join(posRoot, 'src') },
      ],
      dedupe: ['react', 'react-dom'],
    },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    optimizeDeps: { entries: [path.join(here, 'index.html')] },
  });
  await server.listen();
  const address = server.httpServer?.address() as AddressInfo | null;
  if (!address) throw new Error('the header measurement server did not start');
  return {
    url: `http://127.0.0.1:${address.port}/test/support/header-harness/index.html`,
    close: () => server.close(),
  };
}
