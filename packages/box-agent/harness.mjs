import { registerHooks } from 'node:module';

/**
 * The minimum test harness for this package.
 *
 * `@oto/box-agent`'s tests run on Node's own runner, with no test framework
 * of its own. The `test` script passes `--experimental-transform-types`, which
 * — unlike the default strip-only mode — also compiles the TypeScript that
 * needs more than erasing (the parameter properties in `@oto/print`), so every
 * module in the package loads, the agent included. The one thing that needs
 * bridging is module specifiers — Node's resolver wants `./store.ts` where
 * TypeScript, the rest of this repository and every editor want `./store`.
 *
 * This appends the extension rather than rewriting the source, so the files a
 * Pi and the api import stay in the repository's ordinary style and nothing
 * about the shipped code exists only to make a test run. Replace the whole
 * file if the package ever moves to `vitest`.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && !/\.[cm]?[jt]sx?$/.test(specifier) && !/\.json$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Not a TypeScript file after all — a directory, or a real extension
        // Node can find on its own. Fall through rather than masking the
        // resolver's own, better, error message.
      }
    }
    return nextResolve(specifier, context);
  },
});
