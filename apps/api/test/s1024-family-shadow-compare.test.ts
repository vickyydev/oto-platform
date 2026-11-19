import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, TransactionRollbackError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { backfillFamilies, child, family, familyGuardian, member, operator, schema, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { newId } from '@oto/shared';
import { ensureFamilyFor } from '../src/services/family';
import { compareFamilyReads, type FamilyShadowReport } from '../src/services/family-shadow';
import type { Tx } from '../src/services/tx';

/**
 * SCRUM-1024 — family profiles: the shadow compare for the reader switch
 * (plan step R1, with the readers of step F3; `docs/progress/plans/
 * dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md` §3 and the runbook
 * `FAMILY_BACKFILL_RUNBOOK.md`), against a real database. ZZ TEST data only.
 *
 * Pinned: before the backfill it reports every member whose children have no
 * family yet, and nothing for a member a writer already gave a family or for
 * an archived member; after the backfill it reports no difference; a second
 * live guardian on a family and a child moved to another member's family are
 * each reported, on both members they touch; the command line exits 1 on a
 * difference and 0 on none, and prints ids and counts only.
 */

const API = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(API, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let db: Db;
let url: string;
let close: () => Promise<void>;
const opA = newId();
const opB = newId();

const m = { one: '', many: '', archived: '', none: '', writer: '', b: '' };
const c = { one: '', many1: '', many2: '', manyArchived: '', archived: '', writer: '', b1: '', b2: '' };

let phoneSeq = 0;
const nextPhone = () => `+6665103${String((phoneSeq += 1)).padStart(4, '0')}`;

async function newMember(operatorId: string, label: string, archivedAt: Date | null = null) {
  const id = newId();
  await db.insert(member).values({ id, operatorId, phone: nextPhone(), nickname: `ZZ TEST 1024 ${label}`, archivedAt });
  return id;
}

async function newChild(memberId: string, label: string, extra: Partial<typeof child.$inferInsert> = {}) {
  const id = newId();
  await db.insert(child).values({ id, memberId, name: `ZZ TEST 1024 child ${label}`, ...extra });
  return id;
}

async function familyOf(memberId: string): Promise<string> {
  const [row] = await db.select({ familyId: familyGuardian.familyId }).from(familyGuardian).where(eq(familyGuardian.memberId, memberId));
  return row!.familyId;
}

/** The compare with a change planted, inside a transaction that is rolled back. */
async function compareWith(plant: (tx: Tx) => Promise<void>): Promise<FamilyShadowReport> {
  const out: { report?: FamilyShadowReport } = {};
  try {
    await db.transaction(async (tx) => {
      await plant(tx);
      out.report = await compareFamilyReads(tx, { batchSize: 2 });
      tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  return out.report!;
}

function runCompare(): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [TSX, join('scripts', 'family-shadow-compare.ts')], {
      cwd: API,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

beforeAll(async () => {
  const created = await createTestDatabase();
  url = created.url;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  db = drizzle(pool, { schema }) as Db;
  close = async () => {
    await pool.end();
    await created.drop();
  };
  await db.insert(operator).values([
    { id: opA, name: 'ZZ TEST 1024 shadow A' },
    { id: opB, name: 'ZZ TEST 1024 shadow B' },
  ]);

  m.one = await newMember(opA, 'one child');
  c.one = await newChild(m.one, 'one');
  m.many = await newMember(opA, 'several children');
  c.many1 = await newChild(m.many, 'many 1');
  c.many2 = await newChild(m.many, 'many 2');
  c.manyArchived = await newChild(m.many, 'many archived', { archivedAt: new Date('2026-10-01T00:00:00Z') });
  m.archived = await newMember(opA, 'archived', new Date('2026-09-01T00:00:00Z'));
  c.archived = await newChild(m.archived, 'archived member');
  m.none = await newMember(opA, 'no children');

  // A member whose child was saved since F1, through the writers' own rule.
  m.writer = await newMember(opA, 'saved since families');
  c.writer = newId();
  await db.transaction(async (tx) => {
    const fam = await ensureFamilyFor(tx, {
      operatorId: opA,
      memberId: m.writer,
      source: 'till',
      context: { accountId: null, branchId: null, stationId: null },
    });
    await tx.insert(child).values({ id: c.writer, memberId: m.writer, familyId: fam.familyId, name: 'ZZ TEST 1024 child writer' });
  });

  m.b = await newMember(opB, 'second operator');
  c.b1 = await newChild(m.b, 'b 1');
  c.b2 = await newChild(m.b, 'b 2');
}, 300_000);

afterAll(async () => {
  try {
    await close?.();
  } finally {
    await stopTestServer();
  }
});

describe('SCRUM-1024 family shadow compare', () => {
  it('before the backfill, reports each live member whose children have no family yet', async () => {
    const report = await compareFamilyReads(db, { batchSize: 2 });
    expect(report.membersCompared).toBe(6);
    // Today's read: the live children of live members.
    expect(report.childrenByMember).toBe(6);
    expect(report.childrenThroughFamily).toBe(1);
    const byMember = new Map(report.differences.map((d) => [d.memberId, d]));
    expect([...byMember.keys()].sort()).toEqual([m.one, m.many, m.b].sort());
    expect(byMember.get(m.many)).toEqual({
      memberId: m.many,
      operatorId: opA,
      memberLive: true,
      onlyByMember: [c.many1, c.many2].sort(),
      onlyThroughFamily: [],
    });
    expect(byMember.get(m.b)!.operatorId).toBe(opB);
  });

  it('after the backfill, the two reads agree for every member', async () => {
    const backfill = await backfillFamilies(db, { apply: true });
    expect(backfill.failure).toBeNull();
    expect(backfill.finished).toBe(true);
    const report = await compareFamilyReads(db, { batchSize: 2 });
    expect(report.differences).toEqual([]);
    expect(report.membersCompared).toBe(6);
    expect(report.childrenByMember).toBe(6);
    expect(report.childrenThroughFamily).toBe(6);
  });

  it('reports a second live guardian on a family, on the member it gives children to', async () => {
    const report = await compareWith(async (tx) => {
      await tx
        .insert(familyGuardian)
        .values({ id: newId(), operatorId: opA, familyId: await familyOf(m.one), memberId: m.none, source: 'link' });
    });
    expect(report.differences).toEqual([
      { memberId: m.none, operatorId: opA, memberLive: true, onlyByMember: [], onlyThroughFamily: [c.one] },
    ]);
  });

  it('reports a child moved into the family of another member, on both members', async () => {
    const report = await compareWith(async (tx) => {
      await tx.update(child).set({ familyId: await familyOf(m.one) }).where(eq(child.id, c.many1));
    });
    const byMember = new Map(report.differences.map((d) => [d.memberId, d]));
    expect(byMember.size).toBe(2);
    expect(byMember.get(m.many)).toMatchObject({ onlyByMember: [c.many1], onlyThroughFamily: [] });
    expect(byMember.get(m.one)).toMatchObject({ onlyByMember: [], onlyThroughFamily: [c.many1] });
  });

  it('the command line exits 1 on a difference and 0 on none, with ids and counts only', { timeout: 180_000 }, async () => {
    const plantedId = newId();
    await db
      .insert(familyGuardian)
      .values({ id: plantedId, operatorId: opA, familyId: await familyOf(m.one), memberId: m.none, source: 'link' });
    try {
      const differs = runCompare();
      expect(differs.code, differs.out).toBe(1);
      expect(differs.out).toContain(`member ${m.none} (operator ${opA}, live)`);
      expect(differs.out).toContain(`only through the family [${c.one}]`);
      expect(differs.out).toContain('members with a difference 1');
      expect(differs.out).not.toMatch(/ZZ TEST|\+66\d/);
    } finally {
      await db.delete(familyGuardian).where(eq(familyGuardian.id, plantedId));
    }
    const clean = runCompare();
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).toContain('members compared 6; children by member_id 6; children through the family 6');
    expect(clean.out).toContain('NO DIFFERENCE');
    expect(clean.out).not.toMatch(/ZZ TEST|\+66\d/);
    // The command line is read only: the families are as the backfill left them.
    expect(await db.select().from(family)).toHaveLength(5);
  });
});
