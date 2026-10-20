import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The launcher's unit runner (SCRUM-591, round I3a), in the Console's and the
 * Inbox's shape (`apps/inbox/vitest.config.ts`): a file of its own so nothing
 * here reaches the build or the dev server, and Node rather than a browser.
 * What is under test is the ask panel's state machine (`src/assistant/*`) and
 * what its components say, rendered to markup with react-dom/server.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
