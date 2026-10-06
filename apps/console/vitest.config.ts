import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The Console's unit runner (SCRUM-256), in the till's shape
 * (`apps/pos/vitest.config.ts`).
 *
 * A file of its own rather than a `test` block in `vite.config.ts`, so nothing
 * here reaches the Console's build, its dev server or the `vite preview` the
 * end-to-end set runs against: no React or Tailwind plugin, no `/api` proxy.
 * The one thing shared is the `@/` alias, which the modules under test reach
 * their neighbours through.
 *
 * NODE, NOT A BROWSER. What is under test is arithmetic and words — the
 * booth's odds and money (`src/components/booth/odds.ts`), what a publish
 * would commit to (`publishPlan.ts`) and the voucher-type form's model
 * (`voucherTypes.ts`) — and none of it touches the DOM. The pages are the
 * end-to-end set's (`e2e/`, Playwright), which this runner does not collect.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
