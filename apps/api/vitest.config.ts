import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000, // first run may initialise an embedded Postgres
    fileParallelism: false,
  },
});
