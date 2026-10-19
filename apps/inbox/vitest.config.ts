import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The Inbox's unit runner, in the Console's shape (`apps/console/vitest.config.ts`):
 * a file of its own so nothing here reaches the build or the dev server, and
 * Node rather than a browser — what is under test is the shell's words and
 * arithmetic (`src/lib/view.ts`: the labels, the time stamps, the timeline's
 * system pills, the write switch), none of which touches the DOM.
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
