import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-216 review of lane G — migration 0064 read as files: add-only, chained
 * from 0063's snapshot, and placed after 0063 in the journal. Nothing that
 * existed in 0063's snapshot is removed or changed in 0064's, and the SQL
 * names nothing it drops, renames or retypes.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const META = join(MIGRATIONS, 'meta');

interface Snapshot {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, unknown>;
      indexes?: Record<string, unknown>;
      foreignKeys?: Record<string, unknown>;
      checkConstraints?: Record<string, unknown>;
      uniqueConstraints?: Record<string, unknown>;
    }
  >;
}

interface Journal {
  entries: Array<{ idx: number; when: number; tag: string }>;
}

const read = <T>(file: string): T => JSON.parse(readFileSync(join(META, file), 'utf8')) as T;
const s63 = read<Snapshot>('0063_snapshot.json');
const s64 = read<Snapshot>('0064_snapshot.json');
const journal = read<Journal>('_journal.json');
const SQL = readFileSync(join(MIGRATIONS, '0064_analytics_summaries.sql'), 'utf8');

describe('migration 0064 (SCRUM-216 review)', () => {
  it('is journal entry 64, directly after 0063, in both index and time', () => {
    const entries = journal.entries;
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]!.idx, entries[i]!.tag).toBe(entries[i - 1]!.idx + 1);
      expect(entries[i]!.when, entries[i]!.tag).toBeGreaterThan(entries[i - 1]!.when);
    }
    const e63 = entries.find((e) => e.idx === 63);
    const e64 = entries.find((e) => e.idx === 64);
    expect(e63).toMatchObject({ idx: 63, tag: '0063_stock_single_each_pack' });
    expect(e64).toMatchObject({ idx: 64, tag: '0064_analytics_summaries' });
    expect(entries.indexOf(e64!)).toBe(entries.indexOf(e63!) + 1);
  });

  it('chains its snapshot from 0063’s', () => {
    expect(s64.prevId).toBe(s63.id);
    expect(s64.id).not.toBe(s63.id);
  });

  it('keeps every table, column, index, key and check of 0063 exactly as it was', () => {
    const changed: string[] = [];
    for (const [name, before] of Object.entries(s63.tables)) {
      const after = s64.tables[name];
      if (!after) {
        changed.push(`table ${name}`);
        continue;
      }
      for (const part of ['columns', 'indexes', 'foreignKeys', 'uniqueConstraints'] as const) {
        for (const [key, value] of Object.entries(before[part] ?? {})) {
          if (JSON.stringify(after[part]?.[key]) !== JSON.stringify(value)) changed.push(`${name} ${part} ${key}`);
        }
      }
      for (const [key, value] of Object.entries(before.checkConstraints ?? {})) {
        if (JSON.stringify(after.checkConstraints?.[key]) !== JSON.stringify(value)) changed.push(`${name} check ${key}`);
      }
    }
    expect(changed).toEqual([]);
    // What it adds: the analytics tables, and one check on the sale lines.
    const added = Object.keys(s64.tables).filter((t) => !s63.tables[t]);
    expect(added.every((t) => t.startsWith('analytics.'))).toBe(true);
    expect(Object.keys(s64.tables['pos.sale_line']!.checkConstraints ?? {})).toContain('sale_line_revenue_category_check');
  });

  it('drops, renames and retypes nothing', () => {
    const statements = SQL.split('--> statement-breakpoint').map((s) => s.replace(/^\s*--.*$/gm, '').trim());
    const destructive = statements.filter((s) =>
      /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|SCHEMA|TRIGGER|FUNCTION|TYPE)\b|\bRENAME\b|\bALTER\s+COLUMN\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i.test(s),
    );
    expect(destructive).toEqual([]);
    // The one change to an existing table's data: missing revenue categories filled in, under the freeze toggled off and on.
    const updates = statements.filter((s) => /^UPDATE\b/i.test(s));
    expect(updates).toEqual([
      'UPDATE "pos"."sale_line" SET "revenue_category" = "taxable_category" WHERE "revenue_category" IS NULL;',
    ]);
    const disable = statements.findIndex((s) => s.includes('DISABLE TRIGGER "sale_line_freeze"'));
    const update = statements.indexOf(updates[0]!);
    const enable = statements.findIndex((s) => s.includes('ENABLE TRIGGER "sale_line_freeze"'));
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(update).toBe(disable + 1);
    expect(enable).toBe(update + 1);
  });
});
