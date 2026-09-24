#!/usr/bin/env node
/**
 * `oto-box` inside the repository (SCRUM-223).
 *
 * The runner a Raspberry Pi runs is the bundle `dist/oto-box/oto-box.mjs`,
 * built by `pnpm --filter @oto/box-agent build:runner` and shipped in the
 * release tarball, which has its own `bin`. This file is only what the
 * workspace links as `oto-box`: it runs that bundle when it has been built and
 * says how to build it when it has not, so a fresh checkout never carries a
 * link to a file that does not exist.
 */
import { existsSync } from 'node:fs';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';

const built = fileURLToPath(new URL('../dist/oto-box/oto-box.mjs', import.meta.url));
if (!existsSync(built)) {
  process.stderr.write('oto-box is not built yet: run "pnpm --filter @oto/box-agent build:runner" first.\n');
  process.exit(1);
}
// The bundle runs itself when it is the program; say that it is.
process.argv[1] = built;
await import(pathToFileURL(built).href);
