import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Raster suites share the runner with database and box tests. Keep their
    // CPU-heavy files sequential so worker result reporting stays responsive.
    fileParallelism: false,
    /**
     * Thirty seconds, where vitest's default is five.
     *
     * This package's work is rasterising: shaping glyphs from bundled fonts
     * and filling a bitmap a dot at a time. A 200-line receipt at 576 dots is
     * a quarter of a megabyte of raster, and it takes about a second on a
     * developer's machine — which is *correct behaviour being measured*, not
     * a test doing something wasteful. A GitHub runner is several times
     * slower than that, and `grows with the content rather than being
     * clipped` duly timed out at 5,000 ms on CI while passing in 1,021 ms
     * locally: a red build that says nothing about the code.
     *
     * The budget is per test and generous on purpose. It is not there to let
     * a slow test pass — a genuine hang still fails, six times over — it is
     * there so the threshold is about *hanging* rather than about how fast
     * the machine of the day happens to be.
     */
    testTimeout: 30_000,
  },
});
