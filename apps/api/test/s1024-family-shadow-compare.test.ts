import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, TransactionRollbackError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { backfillFamilies, child, family, familyGuardian, member, operator, schema, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { newId } from '@oto/shared';
import { ensureFamilyFor } from '../src/services/family';
import { compareFamilyReads, FAMILY_SHADOW_KINDS, type FamilyShadowKind, type FamilyShadowReport } from '../src/services/family-shadow';
import type { Tx } from '../src/services/tx';

/**
 * SCRUM-1024 — family profiles: the shadow compare for the reader switch
 * (plan step R1, with the readers of step F3; `docs/progress/plans/
 * dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md` §3 and the runbook
 * `FAMILY_BACKFILL_RUNBOOK.md`), against a real database. ZZ TEST data only.
 *
 * For every member of every operator, archived or not: the children first
 * saved under the member beside the children the member holds through its
 * families, removed children on both sides.
 *
 * Pinned: before the backfill it reports every member with a child that has
 * no family yet, archived members included, and nothing for a member a writer
 * already gave a family; after the backfill it reports no difference; a
 * hand-made difference of each kind is found and put under its kind, on every
 * member it touches; a guardian row naming another operator's member is not a
 * difference, because the fence keeps that member from the family; the
 * command line exits 1 on a difference and 0 on none, prints ids and counts
 * only, and holds to --sample.
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

async function familyOf(exec: Db | Tx, memberId: string): Promise<string> {
  const [row] = await exec.select({ familyId: familyGuardian.familyId }).from(familyGuardian).where(eq(familyGuardian.memberId, memberId));
  return row!.familyId;
}

/** The compare with a change planted, inside a transaction that is rolled back. */
async function compareWith(plant: (tx: Tx) => Promise<void>, opts: { sample?: number } = {}): Promise<FamilyShadowReport> {
  const out: { report?: FamilyShadowReport } = {};
  try {
    await db.transaction(async (tx) => {
      await plant(tx);
      out.report = await compareFamilyReads(tx, { batchSize: 2, ...opts });
      tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  return out.report!;
}

/** Each kind that has members: its members, each with its children of that kind. */
function byKind(report: FamilyShadowReport): Partial<Record<FamilyShadowKind, Record<string, string[]>>> {
  const out: Partial<Record<FamilyShadowKind, Record<string, string[]>>> = {};
  for (const k of report.kinds) {
    if (k.members === 0) continue;
    expect(k.samples).toHaveLength(k.members);
    out[k.key] = Object.fromEntries(k.samples.map((s) => [s.memberId, s.childIds]));
  }
  return out;
}

function runCompare(args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [TSX, join('scripts', 'family-shadow-compare.ts'), ...args], {
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
  it('lists its kinds of difference, each with a label', () => {
    expect(FAMILY_SHADOW_KINDS.map((k) => k.key)).toEqual([
      'child_without_family',
      'child_family_not_held',
      'child_family_archived',
      'child_merged',
      'child_of_another_member',
    ]);
  });

  it('before the backfill, reports each member with a child that has no family yet, archived members and removed children included', async () => {
    const report = await compareFamilyReads(db, { batchSize: 2 });
    expect(report.membersCompared).toBe(6);
    // Every child first saved under a member, removed ones and an archived member's included.
    expect(report.childrenByMember).toBe(8);
    expect(report.childrenThroughFamily).toBe(1);
    expect(report.membersWithDifference).toBe(4);
    expect(report.ok).toBe(false);
    expect(byKind(report)).toEqual({
      child_without_family: {
        [m.one]: [c.one],
        [m.many]: [c.many1, c.many2, c.manyArchived].sort(),
        [m.archived]: [c.archived],
        [m.b]: [c.b1, c.b2].sort(),
      },
    });
    const kind = report.kinds.find((k) => k.key === 'child_without_family')!;
    expect(kind.children).toBe(7);
    expect(kind.samples.find((s) => s.memberId === m.b)!.operatorId).toBe(opB);
  });

  it('after the backfill, the two reads agree for every member', async () => {
    const backfill = await backfillFamilies(db, { apply: true });
    expect(backfill.failure).toBeNull();
    expect(backfill.finished).toBe(true);
    const report = await compareFamilyReads(db, { batchSize: 2 });
    expect(report).toMatchObject({ ok: true, membersCompared: 6, childrenByMember: 8, childrenThroughFamily: 8, membersWithDifference: 0 });
    expect(report.kinds.every((k) => k.members === 0 && k.children === 0 && k.samples.length === 0)).toBe(true);
  });

  it('a second live guardian on a family: the children it gives, under "a child first saved under another member"', async () => {
    const report = await compareWith(async (tx) => {
      await tx.insert(familyGuardian).values({ id: newId(), operatorId: opA, familyId: await familyOf(tx, m.one), memberId: m.none, source: 'link' });
    });
    expect(byKind(report)).toEqual({ child_of_another_member: { [m.none]: [c.one] } });
    expect(report.membersWithDifference).toBe(1);
  });

  it('a child moved into another member\'s family, and a guardian row taken off: "not a live guardian of"', async () => {
    const report = await compareWith(async (tx) => {
      await tx.update(child).set({ familyId: await familyOf(tx, m.one) }).where(eq(child.id, c.many1));
      await tx.update(familyGuardian).set({ archivedAt: new Date() }).where(eq(familyGuardian.memberId, m.writer));
    });
    expect(byKind(report)).toEqual({
      child_family_not_held: { [m.many]: [c.many1], [m.writer]: [c.writer] },
      child_of_another_member: { [m.one]: [c.many1] },
    });
  });

  it('an archived family and a merged child, each under its kind', async () => {
    const report = await compareWith(async (tx) => {
      await tx.update(family).set({ archivedAt: new Date() }).where(eq(family.id, await familyOf(tx, m.b)));
      await tx.update(child).set({ mergedIntoChildId: c.many1, archivedAt: new Date() }).where(eq(child.id, c.many2));
    });
    expect(byKind(report)).toEqual({
      child_family_archived: { [m.b]: [c.b1, c.b2].sort() },
      child_merged: { [m.many]: [c.many2] },
    });
  });

  it('a child given to another operator\'s family: a difference on both members; a row naming another operator\'s member is none', async () => {
    const moved = await compareWith(async (tx) => {
      await tx.update(child).set({ familyId: await familyOf(tx, m.b) }).where(eq(child.id, c.one));
    });
    expect(byKind(moved)).toEqual({
      child_family_not_held: { [m.one]: [c.one] },
      child_of_another_member: { [m.b]: [c.one] },
    });
    // A guardian row in operator A's family naming operator B's member: B's member is read inside B, so it
    // holds nothing of A's family (verify check 4 counts the row itself).
    const fenced = await compareWith(async (tx) => {
      await tx.insert(familyGuardian).values({ id: newId(), operatorId: opA, familyId: await familyOf(tx, m.one), memberId: m.b, source: 'link' });
    });
    expect(fenced.ok).toBe(true);
  });

  it('holds to the sample size, and counts every member beyond it', async () => {
    // Three more parents on one family, the archived member among them (the compare does not ask a member's state).
    const plant = async (tx: Tx) => {
      const familyId = await familyOf(tx, m.one);
      for (const memberId of [m.none, m.many, m.archived]) {
        await tx.insert(familyGuardian).values({ id: newId(), operatorId: opA, familyId, memberId, source: 'link' });
      }
    };
    expect(byKind(await compareWith(plant))).toEqual({
      child_of_another_member: { [m.none]: [c.one], [m.many]: [c.one], [m.archived]: [c.one] },
    });
    const capped = (await compareWith(plant, { sample: 2 })).kinds.find((k) => k.key === 'child_of_another_member')!;
    expect(capped).toMatchObject({ members: 3, children: 3 });
    expect(capped.samples).toHaveLength(2);
  });

  it('the command line exits 1 on a difference and 0 on none, with ids and counts only', { timeout: 180_000 }, async () => {
    const plantedId = newId();
    await db
      .insert(familyGuardian)
      .values({ id: plantedId, operatorId: opA, familyId: await familyOf(db, m.one), memberId: m.none, source: 'link' });
    try {
      const differs = runCompare();
      expect(differs.code, differs.out).toBe(1);
      expect(differs.out).toContain('members with a difference 1');
      expect(differs.out).toContain('5. the member holds, through a family, a child first saved under another member: 1 members, 1 children');
      expect(differs.out).toContain(`member ${m.none} (operator ${opA}): children ${c.one}`);
      expect(differs.out).toContain('1. the member\'s own child has no family (the backfill has not reached it): 0 members, 0 children');
      expect(differs.out).toContain('DIFFERENCES: see the runbook before going on');
      expect(differs.out).not.toMatch(/ZZ TEST|\+66\d/);
      const quiet = runCompare(['--sample', '0']);
      expect(quiet.code, quiet.out).toBe(1);
      expect(quiet.out).not.toContain(`member ${m.none}`);
      const refused = runCompare(['--apply']);
      expect(refused.code, refused.out).toBe(1);
      expect(refused.out).toContain('refused: unknown argument "--apply"');
    } finally {
      await db.delete(familyGuardian).where(eq(familyGuardian.id, plantedId));
    }
    const clean = runCompare();
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).toContain('members compared 6; children by member_id 8; children through the family 8; members with a difference 0');
    expect(clean.out).toContain('NO DIFFERENCE');
    expect(clean.out).not.toMatch(/ZZ TEST|\+66\d/);
    // The command line is read only: the families and guardian rows are as the backfill left them.
    expect(await db.select().from(family)).toHaveLength(5);
    expect(await db.select().from(familyGuardian).where(and(eq(familyGuardian.memberId, m.none)))).toEqual([]);
  });
});
