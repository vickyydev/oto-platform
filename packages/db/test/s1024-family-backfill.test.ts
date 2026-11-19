import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql, TransactionRollbackError } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { newId } from '@oto/shared';
import { schema, type Db } from '../src/index';
import * as s from '../src/schema/index';
import {
  backfillFamilies,
  FAMILY_BACKFILL_REQUEST_ID,
  FamilyBackfillRefused,
  type FamilyBackfillBatch,
  type FamilyBackfillCounts,
} from '../src/family-backfill';
import { verifyFamilies, type FamilyVerifyKey, type FamilyVerifyReport } from '../src/family-verify';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-1024 — family profiles, plan step F2: the backfill and its checks
 * (`docs/progress/plans/dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md` §3, B1
 * and V1; the runbook `FAMILY_BACKFILL_RUNBOOK.md` beside it), against a real
 * database built from the committed migrations. ZZ TEST data only.
 *
 * Pinned:
 *   - a dry run reads what the backfill would do and writes nothing;
 *   - every member with a child without a family (one child, several,
 *     archived members, archived children, a member merged by alias) gets one
 *     family and one guardian row, of their own operator; a member with no
 *     children gets nothing; a child already in a family is not touched; a
 *     member who already has their own family (made by a writer since F1)
 *     has their older children put in it, and no second family is made;
 *   - one `family.backfill` audit row per batch and operator, with its range
 *     and counts; `child.updated_at` is left as it was;
 *   - a second run writes nothing at all;
 *   - the four checks are zero after, and each counts its own deliberate fault;
 *   - a batch that fails rolls back alone, and the next run completes it;
 *   - a member or child a till holds is skipped without waiting and done by
 *     the next run; --max-batches stops and names where to resume;
 *   - a member in several families, or in a family with another guardian, is
 *     left untouched for a person;
 *   - the command lines print ids and counts, never a name or a number.
 */

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX = join(PKG, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let db: Db;
let url: string;
let close: () => Promise<void>;
let opA: string;
let opB: string;

let phoneSeq = 0;
/** A ZZ TEST mobile number nothing else in this file uses. */
const nextPhone = () => `+6665102${String((phoneSeq += 1)).padStart(4, '0')}`;

async function newMember(operatorId: string, label: string, extra: Partial<typeof s.member.$inferInsert> = {}) {
  const id = newId();
  await db.insert(s.member).values({ id, operatorId, phone: nextPhone(), nickname: `ZZ TEST 1024 ${label}`, ...extra });
  return id;
}

async function newChild(memberId: string, label: string, extra: Partial<typeof s.child.$inferInsert> = {}) {
  const id = newId();
  await db.insert(s.child).values({ id, memberId, name: `ZZ TEST 1024 child ${label}`, ...extra });
  return id;
}

/** A family as a writer since F1 makes it: the member as its one live guardian. */
async function writerFamily(operatorId: string, memberId: string, source: 'till' | 'sync' | 'booking' = 'till') {
  const id = newId();
  await db.insert(s.family).values({ id, operatorId, source });
  await db.insert(s.familyGuardian).values({ id: newId(), operatorId, familyId: id, memberId, source });
  return id;
}

async function liveGuardianFamilies(memberId: string): Promise<string[]> {
  const rows = await db
    .select({ familyId: s.familyGuardian.familyId })
    .from(s.familyGuardian)
    .where(and(eq(s.familyGuardian.memberId, memberId), isNull(s.familyGuardian.archivedAt)));
  return rows.map((r) => r.familyId);
}

async function familyOfChild(childId: string): Promise<string | null> {
  const [row] = await db.select({ familyId: s.child.familyId }).from(s.child).where(eq(s.child.id, childId));
  return row!.familyId;
}

async function count(table: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`));
  return r.rows[0]!.n;
}

/** Every row's transaction id: a row a statement rewrote has a new one. */
async function versions(table: string): Promise<Map<string, string>> {
  const r = await db.execute<{ id: string; v: string }>(sql.raw(`select id::text, xmin::text as v from ${table}`));
  return new Map(r.rows.map((row) => [row.id, row.v]));
}

async function backfillAudit() {
  return db
    .select()
    .from(s.auditLog)
    .where(eq(s.auditLog.action, 'family.backfill'))
    .orderBy(s.auditLog.createdAt, s.auditLog.id);
}

function runScript(script: string, args: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [TSX, join('scripts', script), ...args], {
      cwd: PKG,
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

/** The command lines print no name and no number from the data. */
function expectNoPersonalData(out: string): void {
  expect(out).not.toMatch(/ZZ TEST/);
  expect(out).not.toMatch(/\+66\d/);
}

const counts = (c: FamilyBackfillCounts): FamilyBackfillCounts => ({
  members: c.members,
  familiesCreated: c.familiesCreated,
  familiesReused: c.familiesReused,
  guardiansCreated: c.guardiansCreated,
  childrenSet: c.childrenSet,
  needsHand: c.needsHand,
  busy: c.busy,
});

const byKey = (r: FamilyVerifyReport): Record<FamilyVerifyKey, number> =>
  Object.fromEntries(r.checks.map((c) => [c.key, c.count])) as Record<FamilyVerifyKey, number>;

const ZERO = {
  children_without_family: 0,
  families_without_guardian: 0,
  children_not_own_guardian: 0,
  operator_mismatch: 0,
};

/** The four checks with a fault planted, inside a transaction that is rolled back. */
async function verifyWithFault(plant: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<void>) {
  const out: { report?: FamilyVerifyReport } = {};
  try {
    await db.transaction(async (tx) => {
      await plant(tx);
      out.report = await verifyFamilies(tx);
      tx.rollback();
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  return out.report!;
}

// The main cast. Operator A:
const m = { one: '', many: '', archived: '', alias: '', none: '', done: '', mixed: '', b: '', bNone: '' };
const c = {
  one: '',
  many1: '',
  many2: '',
  manyArchived: '',
  archived1: '',
  archived2: '',
  alias1: '',
  alias2: '',
  done: '',
  mixedOld: '',
  mixedNew: '',
  b1: '',
  b2: '',
};
const f = { done: '', mixed: '' };
const aliasIds: string[] = [];

beforeAll(async () => {
  const created = await createTestDatabase();
  url = created.url;
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  db = drizzle(pool, { schema }) as Db;
  close = async () => {
    await pool.end();
    await created.drop();
  };

  opA = newId();
  opB = newId();
  await db.insert(s.operator).values([
    { id: opA, name: 'ZZ TEST 1024 backfill A' },
    { id: opB, name: 'ZZ TEST 1024 backfill B' },
  ]);

  m.one = await newMember(opA, 'one child');
  c.one = await newChild(m.one, 'one');

  m.many = await newMember(opA, 'several children');
  c.many1 = await newChild(m.many, 'many 1');
  c.many2 = await newChild(m.many, 'many 2');
  c.manyArchived = await newChild(m.many, 'many archived', { archivedAt: new Date('2026-10-01T00:00:00Z') });

  m.archived = await newMember(opA, 'archived member', { archivedAt: new Date('2026-09-01T00:00:00Z') });
  c.archived1 = await newChild(m.archived, 'archived 1');
  c.archived2 = await newChild(m.archived, 'archived 2');

  // A member two counters signed up offline: the second id was merged into
  // this one at sync and kept as an alias, and its children landed here.
  m.alias = await newMember(opA, 'merged by alias', { childrenReviewSince: new Date('2026-11-01T00:00:00Z') });
  for (let i = 0; i < 2; i += 1) {
    const aliasId = newId();
    aliasIds.push(aliasId);
    await db.insert(s.memberAlias).values({ aliasMemberId: aliasId, operatorId: opA, memberId: m.alias });
  }
  c.alias1 = await newChild(m.alias, 'alias 1');
  c.alias2 = await newChild(m.alias, 'alias 2');

  m.none = await newMember(opA, 'no children');

  // A member whose child a writer saved since F1: already in a family.
  m.done = await newMember(opA, 'already in a family');
  f.done = await writerFamily(opA, m.done);
  c.done = await newChild(m.done, 'done', { familyId: f.done });

  // A member with a child from before (no family) and one saved since (in
  // the family a writer made for them).
  m.mixed = await newMember(opA, 'old and new children');
  c.mixedOld = await newChild(m.mixed, 'mixed old');
  f.mixed = await writerFamily(opA, m.mixed);
  c.mixedNew = await newChild(m.mixed, 'mixed new', { familyId: f.mixed });

  // Operator B.
  m.b = await newMember(opB, 'second operator');
  c.b1 = await newChild(m.b, 'b 1');
  c.b2 = await newChild(m.b, 'b 2');
  m.bNone = await newMember(opB, 'second operator, no children');
}, 300_000);

afterAll(async () => {
  try {
    await close?.();
  } finally {
    await stopTestServer();
  }
});

/** What the backfill does with the main cast, per operator and in total. */
const EXPECTED_A: FamilyBackfillCounts = {
  members: 5, // one, many, archived, alias, mixed
  familiesCreated: 4,
  familiesReused: 1, // mixed
  guardiansCreated: 4,
  childrenSet: 9, // one; many x3; archived x2; alias x2; mixedOld
  needsHand: 0,
  busy: 0,
};
const EXPECTED_B: FamilyBackfillCounts = {
  members: 1,
  familiesCreated: 1,
  familiesReused: 0,
  guardiansCreated: 1,
  childrenSet: 2,
  needsHand: 0,
  busy: 0,
};
const EXPECTED_TOTAL: FamilyBackfillCounts = {
  members: 6,
  familiesCreated: 5,
  familiesReused: 1,
  guardiansCreated: 5,
  childrenSet: 11,
  needsHand: 0,
  busy: 0,
};

let childStampsBefore: Map<string, string>;

describe('SCRUM-1024 family backfill and checks', () => {
  it('a dry run counts what the backfill would do and writes nothing', { timeout: 60_000 }, async () => {
    const before = {
      family: await count('crm.family'),
      guardian: await count('crm.family_guardian'),
      audit: await count('core.audit_log'),
      children: await versions('crm.child'),
    };
    const seen: FamilyBackfillBatch[] = [];
    const report = await backfillFamilies(db, { apply: false, onBatch: (b) => seen.push(b) });
    expect(report.applied).toBe(false);
    expect(report.failure).toBeNull();
    expect(report.finished).toBe(true);
    expect(counts(report.totals)).toEqual(EXPECTED_TOTAL);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.afterMemberId).toBeNull();
    expect(seen[0]!.durationMs).toBe(0);

    const cli = runScript('family-backfill.ts');
    expect(cli.code, cli.out).toBe(0);
    expect(cli.out).toContain('DRY RUN, nothing written');
    expect(cli.out).toContain(
      'totals: members 6, families made 5, families reused 1, guardian rows made 5, children given a family 11, needs a hand 0, busy 0',
    );
    expectNoPersonalData(cli.out);

    expect(await count('crm.family')).toBe(before.family);
    expect(await count('crm.family_guardian')).toBe(before.guardian);
    expect(await count('core.audit_log')).toBe(before.audit);
    expect(await versions('crm.child')).toEqual(before.children);

    // Before the backfill the checks are not zero, and the command line says so.
    const checks = runScript('family-verify.ts');
    expect(checks.code, checks.out).toBe(1);
    expect(checks.out).toContain('1. children with no family: 11');
    expect(checks.out).toContain('NOT ZERO');
    expectNoPersonalData(checks.out);
  });

  it('gives every member with a child without a family one family of their own, and touches nothing else', async () => {
    const stamps = await db.select({ id: s.child.id, updatedAt: s.child.updatedAt }).from(s.child);
    childStampsBefore = new Map(stamps.map((r) => [r.id, r.updatedAt.toISOString()]));
    const untouched = await versions('crm.child');
    const familiesBefore = await versions('crm.family');

    const report = await backfillFamilies(db, { apply: true });
    expect(report.failure).toBeNull();
    expect(report.finished).toBe(true);
    expect(report.batches).toBe(1);
    expect(counts(report.totals)).toEqual(EXPECTED_TOTAL);

    // One family, one guardian row, the member's own, for each member who had
    // a child without a family; their children in it, archived ones too.
    const made: Array<[string, string[], string]> = [
      [m.one, [c.one], opA],
      [m.many, [c.many1, c.many2, c.manyArchived], opA],
      [m.archived, [c.archived1, c.archived2], opA],
      [m.alias, [c.alias1, c.alias2], opA],
      [m.b, [c.b1, c.b2], opB],
    ];
    for (const [memberId, kids, operatorId] of made) {
      const families = await liveGuardianFamilies(memberId);
      expect(families, memberId).toHaveLength(1);
      const [fam] = await db.select().from(s.family).where(eq(s.family.id, families[0]!));
      expect(fam).toMatchObject({ operatorId, source: 'backfill', createdByAccountId: null, archivedAt: null });
      const guardians = await db.select().from(s.familyGuardian).where(eq(s.familyGuardian.familyId, fam!.id));
      expect(guardians).toHaveLength(1);
      expect(guardians[0]).toMatchObject({
        memberId,
        operatorId,
        source: 'backfill',
        addedByAccountId: null,
        branchId: null,
        stationId: null,
        archivedAt: null,
      });
      for (const kid of kids) expect(await familyOfChild(kid), kid).toBe(fam!.id);
    }

    // No member, no family: the one with no children, and the merged ids.
    expect(await liveGuardianFamilies(m.none)).toEqual([]);
    expect(await liveGuardianFamilies(m.bNone)).toEqual([]);
    expect(
      await db.select().from(s.familyGuardian).where(inArray(s.familyGuardian.memberId, aliasIds)),
    ).toEqual([]);

    // A child already in a family is not touched, and neither is its family.
    const after = await versions('crm.child');
    expect(after.get(c.done)).toBe(untouched.get(c.done));
    expect(after.get(c.mixedNew)).toBe(untouched.get(c.mixedNew));
    expect(await familyOfChild(c.done)).toBe(f.done);
    const familiesAfter = await versions('crm.family');
    for (const [id, v] of familiesBefore) expect(familiesAfter.get(id), id).toBe(v);

    // The member a writer already gave a family keeps that one family, and
    // their older child joins it: no second family.
    expect(await liveGuardianFamilies(m.mixed)).toEqual([f.mixed]);
    expect(await familyOfChild(c.mixedOld)).toBe(f.mixed);
    expect(await liveGuardianFamilies(m.done)).toEqual([f.done]);

    // Never two members in one family.
    const shared = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from (
        select family_id from crm.family_guardian where archived_at is null group by family_id having count(*) > 1) x`);
    expect(shared.rows[0]!.n).toBe(0);

    // The family is not an edit of the child: updated_at stays as it was.
    const stampsAfter = await db.select({ id: s.child.id, updatedAt: s.child.updatedAt }).from(s.child);
    for (const r of stampsAfter) expect(r.updatedAt.toISOString(), r.id).toBe(childStampsBefore.get(r.id));

    // One audit row per batch and operator, each with its own counts and the
    // batch's member id range; no actor, no name, no number.
    const rows = await backfillAudit();
    expect(rows).toHaveLength(2);
    const ofA = rows.find((r) => r.operatorId === opA)!;
    const ofB = rows.find((r) => r.operatorId === opB)!;
    for (const row of [ofA, ofB]) {
      expect(row).toMatchObject({
        actorAccountId: null,
        requestId: FAMILY_BACKFILL_REQUEST_ID,
        origin: 'job',
        entityType: 'family_backfill_batch',
        branchId: null,
      });
      expect(row.entityId).toBe(rows[0]!.entityId);
      expect(row.after).toMatchObject({
        runId: report.runId,
        batch: 1,
        afterMemberId: null,
        lastMemberId: report.lastMemberId,
      });
      expect(JSON.stringify(row.after)).not.toMatch(/ZZ TEST|\+66/);
    }
    expect(counts(ofA.after as FamilyBackfillCounts)).toEqual(EXPECTED_A);
    expect(counts(ofB.after as FamilyBackfillCounts)).toEqual(EXPECTED_B);
  });

  it('the four checks are zero after the backfill', { timeout: 60_000 }, async () => {
    const report = await verifyFamilies(db);
    expect(report.ok).toBe(true);
    expect(byKey(report)).toEqual(ZERO);
    const cli = runScript('family-verify.ts');
    expect(cli.code, cli.out).toBe(0);
    expect(cli.out).toContain('ALL ZERO');
    expect(cli.out.match(/: 0$/gm)).toHaveLength(4);
    expectNoPersonalData(cli.out);
  });

  it('a second run writes nothing at all', async () => {
    const before = {
      child: await versions('crm.child'),
      family: await versions('crm.family'),
      guardian: await versions('crm.family_guardian'),
      audit: await count('core.audit_log'),
    };
    const dry = await backfillFamilies(db, { apply: false });
    expect(counts(dry.totals)).toEqual({ ...EXPECTED_TOTAL, members: 0, familiesCreated: 0, familiesReused: 0, guardiansCreated: 0, childrenSet: 0 });
    const report = await backfillFamilies(db, { apply: true });
    expect(report.failure).toBeNull();
    expect(report.finished).toBe(true);
    expect(report.batches).toBe(0);
    expect(report.totals.members).toBe(0);
    expect(await versions('crm.child')).toEqual(before.child);
    expect(await versions('crm.family')).toEqual(before.family);
    expect(await versions('crm.family_guardian')).toEqual(before.guardian);
    expect(await count('core.audit_log')).toBe(before.audit);
  });

  it('each check counts its own kind of deliberate fault', async () => {
    const [oneFamily] = await liveGuardianFamilies(m.one);
    const [bFamily] = await liveGuardianFamilies(m.b);

    // 1. A child saved with no family.
    let r = await verifyWithFault(async (tx) => {
      await tx.insert(s.child).values({ id: newId(), memberId: m.one, name: 'ZZ TEST 1024 child no family' });
    });
    expect(byKey(r)).toEqual({ ...ZERO, children_without_family: 1 });
    expect(r.ok).toBe(false);
    expect(r.checks[0]!.samples).toHaveLength(1);
    expect(r.checks[0]!.samples[0]).toMatch(/^crm\.child [0-9a-f-]{36}$/);

    // 2. A live family with no live guardian; an archived one is not counted.
    r = await verifyWithFault(async (tx) => {
      await tx.insert(s.family).values({ id: newId(), operatorId: opA, source: 'till' });
      await tx
        .insert(s.family)
        .values({ id: newId(), operatorId: opA, source: 'link', archivedAt: new Date('2026-11-18T00:00:00Z') });
    });
    expect(byKey(r)).toEqual({ ...ZERO, families_without_guardian: 1 });

    // 3. A second live guardian on a child's family.
    r = await verifyWithFault(async (tx) => {
      await tx
        .insert(s.familyGuardian)
        .values({ id: newId(), operatorId: opA, familyId: oneFamily!, memberId: m.none, source: 'link' });
    });
    expect(byKey(r)).toEqual({ ...ZERO, children_not_own_guardian: 1 });

    // 3, the other way: the child's own member's guardian row archived.
    r = await verifyWithFault(async (tx) => {
      await tx
        .update(s.familyGuardian)
        .set({ archivedAt: new Date('2026-11-18T00:00:00Z') })
        .where(eq(s.familyGuardian.familyId, oneFamily!));
    });
    expect(byKey(r)).toEqual({ ...ZERO, families_without_guardian: 1, children_not_own_guardian: 1 });

    // 4. A guardian row of operator A naming operator B's member.
    r = await verifyWithFault(async (tx) => {
      await tx
        .insert(s.familyGuardian)
        .values({ id: newId(), operatorId: opA, familyId: oneFamily!, memberId: m.bNone, source: 'link' });
    });
    expect(byKey(r)).toEqual({ ...ZERO, children_not_own_guardian: 1, operator_mismatch: 1 });
    expect(r.checks[3]!.samples[0]).toMatch(/^crm\.family_guardian /);

    // 4. A child of operator A put in operator B's family.
    r = await verifyWithFault(async (tx) => {
      await tx.update(s.child).set({ familyId: bFamily! }).where(eq(s.child.id, c.one));
    });
    expect(byKey(r)).toEqual({ ...ZERO, children_not_own_guardian: 1, operator_mismatch: 1 });
    expect(r.checks[3]!.samples).toEqual([`crm.child ${c.one}`]);

    // Every fault was rolled back.
    expect((await verifyFamilies(db)).ok).toBe(true);
  });

  it('a batch that fails rolls back alone, and the next run completes it', { timeout: 60_000 }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await newMember(opA, `failure ${i}`);
      await newChild(id, `failure ${i}`);
      ids.push(id);
    }
    ids.sort();
    // The second batch of two holds ids[2] and ids[3]; giving ids[3]'s child
    // a family fails, as a database fault would.
    await db.execute(sql.raw(`
      create function crm.zz_test_1024_fault() returns trigger language plpgsql as $$
      begin
        if new.member_id = '${ids[3]}' and new.family_id is not null then
          raise exception 'ZZ TEST planted failure';
        end if;
        return new;
      end $$`));
    await db.execute(
      sql.raw(`create trigger zz_test_1024_fault before update on crm.child
        for each row execute function crm.zz_test_1024_fault()`),
    );
    const auditBefore = (await backfillAudit()).length;
    const familiesBefore = await count('crm.family');

    const failed = await backfillFamilies(db, { apply: true, batchSize: 2 });
    expect(failed.failure).toMatchObject({ batch: 2, afterMemberId: ids[1] });
    expect(failed.failure!.message).toContain('ZZ TEST planted failure');
    expect(failed.batches).toBe(1);
    expect(failed.finished).toBe(false);
    expect(failed.lastMemberId).toBe(ids[1]);
    expect(counts(failed.totals)).toMatchObject({ members: 2, familiesCreated: 2, childrenSet: 2 });

    // Batch 1 is committed; batch 2 left nothing behind, not even for the
    // member whose child did not fail; batch 3 never ran.
    expect(await liveGuardianFamilies(ids[0]!)).toHaveLength(1);
    expect(await liveGuardianFamilies(ids[1]!)).toHaveLength(1);
    for (const id of ids.slice(2)) expect(await liveGuardianFamilies(id), id).toEqual([]);
    expect(await count('crm.family')).toBe(familiesBefore + 2);
    expect((await backfillAudit()).length).toBe(auditBefore + 1);

    await db.execute(sql.raw(`drop trigger zz_test_1024_fault on crm.child`));
    await db.execute(sql.raw(`drop function crm.zz_test_1024_fault()`));

    // Resumed after the last member it finished, one batch at a time.
    const one = await backfillFamilies(db, { apply: true, batchSize: 2, startAfter: failed.lastMemberId, maxBatches: 1 });
    expect(one.failure).toBeNull();
    expect(one.batches).toBe(1);
    expect(one.finished).toBe(false);
    expect(one.lastMemberId).toBe(ids[3]);
    const rest = await backfillFamilies(db, { apply: true, batchSize: 2 });
    expect(rest.failure).toBeNull();
    expect(rest.finished).toBe(true);
    expect(counts(rest.totals)).toMatchObject({ members: 1, familiesCreated: 1, childrenSet: 1 });
    for (const id of ids) expect(await liveGuardianFamilies(id), id).toHaveLength(1);
    expect((await verifyFamilies(db)).ok).toBe(true);
  });

  it('a member or child a till holds is skipped without waiting, and the next run does it', async () => {
    const lockedMember = await newMember(opA, 'busy member');
    const lockedMembersChild = await newChild(lockedMember, 'busy member');
    const partly = await newMember(opA, 'one child busy');
    const heldChild = await newChild(partly, 'held');
    const freeChild = await newChild(partly, 'free');

    // A till's transaction holding the member row and one child row, as an
    // edit at the counter does while it runs.
    const till = new pg.Client({ connectionString: url, application_name: 'oto-test-1024-till' });
    await till.connect();
    let first: Awaited<ReturnType<typeof backfillFamilies>> | null = null;
    try {
      await till.query('begin');
      await till.query('select id from crm.member where id = $1 for no key update', [lockedMember]);
      await till.query('select id from crm.child where id = $1 for no key update', [heldChild]);
      const started = Date.now();
      first = await backfillFamilies(db, { apply: true });
      expect(Date.now() - started, 'the batch never waits for the lock_timeout').toBeLessThan(4_000);
    } finally {
      await till.query('rollback').catch(() => undefined);
      await till.end();
    }
    expect(first!.failure).toBeNull();
    expect(first!.busyMemberIds.sort()).toEqual([lockedMember, partly].sort());
    expect(counts(first!.totals)).toMatchObject({ members: 2, busy: 2, familiesCreated: 1, childrenSet: 1 });
    expect(await liveGuardianFamilies(lockedMember)).toEqual([]);
    expect(await familyOfChild(lockedMembersChild)).toBeNull();
    const [partlyFamily] = await liveGuardianFamilies(partly);
    expect(await familyOfChild(freeChild)).toBe(partlyFamily);
    expect(await familyOfChild(heldChild)).toBeNull();

    const second = await backfillFamilies(db, { apply: true });
    expect(second.failure).toBeNull();
    expect(second.busyMemberIds).toEqual([]);
    expect(counts(second.totals)).toMatchObject({ members: 2, familiesCreated: 1, familiesReused: 1, childrenSet: 2 });
    expect(await liveGuardianFamilies(partly)).toEqual([partlyFamily]);
    expect(await familyOfChild(heldChild)).toBe(partlyFamily);
    expect(await liveGuardianFamilies(lockedMember)).toHaveLength(1);
    expect((await verifyFamilies(db)).ok).toBe(true);
  });

  it('refuses arguments out of range before reading anything', async () => {
    await expect(backfillFamilies(db, { apply: true, batchSize: 0 })).rejects.toBeInstanceOf(FamilyBackfillRefused);
    await expect(backfillFamilies(db, { apply: true, batchSize: 2001 })).rejects.toBeInstanceOf(FamilyBackfillRefused);
    await expect(backfillFamilies(db, { apply: true, batchSize: 1.5 })).rejects.toBeInstanceOf(FamilyBackfillRefused);
    await expect(backfillFamilies(db, { apply: true, startAfter: 'not-a-uuid' })).rejects.toBeInstanceOf(
      FamilyBackfillRefused,
    );
    await expect(backfillFamilies(db, { apply: true, maxBatches: 0 })).rejects.toBeInstanceOf(FamilyBackfillRefused);
  });

  it('a member in several families, or in a family with another guardian, is left for a person', async () => {
    // Neither can happen before a second parent can be added (step F4); if
    // one ever does, the backfill does not guess.
    const shared = await newMember(opA, 'shared family');
    const other = await newMember(opA, 'other parent');
    const sharedFamily = await writerFamily(opA, shared);
    await db
      .insert(s.familyGuardian)
      .values({ id: newId(), operatorId: opA, familyId: sharedFamily, memberId: other, source: 'link' });
    const sharedChild = await newChild(shared, 'shared old');

    const two = await newMember(opA, 'two families');
    await writerFamily(opA, two);
    await writerFamily(opA, two, 'booking');
    const twoChild = await newChild(two, 'two old');

    const before = {
      family: await count('crm.family'),
      guardian: await count('crm.family_guardian'),
      audit: await count('core.audit_log'),
    };
    const report = await backfillFamilies(db, { apply: true });
    expect(report.failure).toBeNull();
    expect(report.finished).toBe(true);
    expect(counts(report.totals)).toMatchObject({ members: 2, needsHand: 2, familiesCreated: 0, childrenSet: 0 });
    expect(report.needsHandMemberIds.sort()).toEqual([shared, two].sort());
    expect(await familyOfChild(sharedChild)).toBeNull();
    expect(await familyOfChild(twoChild)).toBeNull();
    expect(await count('crm.family')).toBe(before.family);
    expect(await count('crm.family_guardian')).toBe(before.guardian);
    expect(await count('core.audit_log')).toBe(before.audit);

    // The checks show it, and the command line exits non-zero and lists them.
    expect(byKey(await verifyFamilies(db)).children_without_family).toBe(2);
    const cli = runScript('family-backfill.ts', ['--batch-size', '50']);
    expect(cli.code, cli.out).toBe(1);
    expect(cli.out).toContain('members left for a person');
    expect(cli.out).toContain(shared);
    expect(cli.out).toContain(two);
    expectNoPersonalData(cli.out);
    expect(runScript('family-backfill.ts', ['--batch-sise', '50']).out).toContain('refused: unknown argument');
  }, 60_000);
});
