import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The till's unit runner (SCRUM-408).
 *
 * A file of its own rather than a `test` block in `vite.config.ts`, so nothing
 * here reaches the till's build or its dev server: no React or Tailwind plugin,
 * no service worker, no `/api` proxy. The one thing shared is the `@/` alias,
 * because every library under test reaches its neighbours through it.
 *
 * NODE, NOT A BROWSER. The libraries under test (`test/*.test.ts`) need no DOM.
 * What they touch that Node lacks — `document`'s visibility, `EventSource`,
 * `fetch`, `window`'s timers — each test stubs for itself, and the React hooks
 * they are written as run on `test/support/hooks.ts` rather than a renderer. A
 * library that genuinely needs a DOM would bring jsdom with it; none of these
 * does.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // A stubbed `document`, `fetch` or `EventSource` is put back after every
    // test, so one test's screen never leaks into the next.
    unstubGlobals: true,
  },
});
