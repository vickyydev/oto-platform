/**
 * Regenerate `test/fixtures/`.
 *
 * Run after a deliberate change to a template or the renderer, then read the
 * diff — a fixture that moved by one dot is usually a metric change worth
 * understanding, and a fixture that moved by a hundred is a mistake.
 *
 *   node --experimental-transform-types scripts/write-fixtures.ts
 *   pnpm --filter @oto/print fixtures
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { allFixtures } from '../test/render-fixture';

const dir = fileURLToPath(new URL('../test/fixtures/', import.meta.url));
mkdirSync(dir, { recursive: true });

let bytes = 0;
for (const fixture of allFixtures()) {
  writeFileSync(`${dir}${fixture.key}.bin`, fixture.job.bytes);
  writeFileSync(`${dir}${fixture.key}.png`, fixture.png);
  writeFileSync(`${dir}${fixture.key}.layout.json`, fixture.layout);
  bytes += fixture.job.bytes.length;
  const overflow = fixture.job.overflow.length ? `  [${fixture.job.overflow.length} overflow]` : '';
  process.stdout.write(
    `${fixture.key.padEnd(28)} ${String(fixture.job.bitmap.width).padStart(4)}x` +
      `${String(fixture.job.bitmap.height).padStart(5)} dots  ` +
      `${String(fixture.job.bytes.length).padStart(7)} bytes${overflow}\n`,
  );
}
process.stdout.write(`\n${bytes} bytes of device data across all fixtures\n`);
