/**
 * Write a Drizzle snapshot for the current schema without the CLI's
 * interactive rename prompts (S2-01b).
 *
 * `drizzle-kit generate` cannot run here: moving every table into a named
 * schema at once makes it ask, table by table, whether each is a rename or a
 * create + drop — and it refuses to guess without a TTY. It would also emit
 * DROP/CREATE, which would throw away the data the migration exists to keep.
 * So the SQL for that migration is hand-written (`ALTER TABLE … SET SCHEMA`)
 * and this script produces the matching snapshot, which is what later
 * `generate` runs diff against.
 *
 * Usage: pnpm --filter @oto/db exec tsx scripts/snapshot.ts <tag>
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDrizzleJson } from 'drizzle-kit/api';
import * as schema from '../src/schema/index';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const META = join(PKG, 'migrations', 'meta');

const tag = process.argv[2];
if (!tag || !/^\d{4}_[a-z0-9_]+$/.test(tag)) {
  throw new Error('Usage: tsx scripts/snapshot.ts <0005_some_tag>');
}
const idx = Number(tag.slice(0, 4));

const journalPath = join(META, '_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

const previous = readdirSync(META)
  .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
  .sort()
  .at(-1);
if (!previous) throw new Error('No previous snapshot found');
const prev = JSON.parse(readFileSync(join(META, previous), 'utf8')) as { id: string };

const snapshot = generateDrizzleJson(
  schema as Record<string, unknown>,
  prev.id,
  ['core', 'crm', 'pos', 'promo', 'booth', 'analytics', 'edge'],
);

writeFileSync(join(META, `${tag.slice(0, 4)}_snapshot.json`), JSON.stringify(snapshot, null, 2));

if (!journal.entries.some((e) => e.idx === idx)) {
  journal.entries.push({
    idx,
    version: journal.entries.at(-1)?.version ?? '7',
    // Sortable and stable: the migration index, not the clock.
    when: (journal.entries.at(-1)?.when ?? 0) + 1000,
    tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
}

console.log(`snapshot ${tag.slice(0, 4)}_snapshot.json written (prevId ${prev.id})`);
