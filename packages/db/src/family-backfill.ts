import { and, asc, inArray, isNull, sql } from 'drizzle-orm';
import { newId } from '@oto/shared';
import type { Db } from './index';
import { auditLog, child, family, familyGuardian, member } from './schema/index';

/**
 * SCRUM-1024 — THE FAMILY BACKFILL (plan step F2, "B1" in section 3 of
 * `docs/progress/plans/dropoff-beo-20261119/FAMILY_PROFILES_PLAN.md`).
 *
 * Every child saved since step F1 is given a family by the writer that saves
 * it (`ensureFamilyFor` in `apps/api/src/services/family.ts`). This gives one
 * to every child saved before: for each member, archived or not, who has a
 * child without a family, the member's family (made here, source `backfill`,
 * with the member as its one guardian) and then `family_id` on that member's
 * children. The command line is `scripts/family-backfill.ts`; the runbook is
 * `FAMILY_BACKFILL_RUNBOOK.md` beside the plan.
 *
 * THE MEMBER'S OWN FAMILY FIRST. The writers are live before this runs, so a
 * member who added a child since F1 already has a family. Their older
 * children go into that family, as a new child of theirs would, and no second
 * family is made: the member's one live family is reused when its only live
 * guardian is that member. A member in several families, or in a family that
 * holds another guardian, is left untouched and listed for a person ("needs a
 * hand"); before plan step F4 neither can happen.
 *
 * NEVER TWO MEMBERS IN ONE FAMILY. A family made here holds exactly one
 * guardian row, the member's own; a child is only ever put in its own
 * member's family. A child that already has a family is never touched
 * (`family_id is null` is in every statement that writes one).
 *
 * BATCHED BY MEMBER ID, ONE TRANSACTION PER BATCH. A batch takes its members
 * in id order with FOR NO KEY UPDATE SKIP LOCKED, the lock the writers take
 * before they read a member's families, so a till adding a first child at the
 * same moment waits for the batch and then finds the family it made (or the
 * batch skips that member and the next run takes it). Then the members'
 * children without a family, with the same lock and SKIP LOCKED: a child a
 * till is editing at that moment is left for the next run. The batch never
 * waits for a till's row lock, so it cannot be one side of a deadlock, and a
 * till waits at most for one batch to commit. `child.updated_at` is left as
 * it was: the family is not an edit of the child's details.
 *
 * RE-RUNNABLE. A batch that fails rolls back alone and the run stops at it;
 * running again starts from the first member who still has a child without a
 * family, so a committed batch is never repeated and a second run over a
 * finished database writes nothing (no audit row either).
 *
 * AUDIT. One `family.backfill` row per batch and operator that wrote
 * something: the batch's member id range and its counts. Ids and counts only:
 * no name, no phone, no care note is read or printed.
 */

/** The `request_id` on every audit row this writes, so a run is findable. */
export const FAMILY_BACKFILL_REQUEST_ID = 'script:family-backfill';
export const FAMILY_BACKFILL_DEFAULT_BATCH = 200;
export const FAMILY_BACKFILL_MAX_BATCH = 2000;

/** The longest a batch waits for any lock it does not skip, before it fails and the run stops. */
const BATCH_LOCK_TIMEOUT = '5s';

type Exec = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface FamilyBackfillOptions {
  /** Write. Without it the run is a dry run: the same reads and counts, and nothing written. */
  apply: boolean;
  /** Members per batch and transaction (1 to FAMILY_BACKFILL_MAX_BATCH). */
  batchSize?: number;
  /** Start after this member id (resume); every member up to it is left as it is. */
  startAfter?: string | null;
  /** Stop after this many batches; the report names where to resume. */
  maxBatches?: number | null;
  /** Called after each batch is committed (or read, in a dry run): the command line prints it. */
  onBatch?: (batch: FamilyBackfillBatch) => void;
}

export interface FamilyBackfillCounts {
  /** Members read who had at least one child without a family. */
  members: number;
  /** Families made, each with its one guardian row. */
  familiesCreated: number;
  /** Members whose one family (made by a writer since F1) took their older children. */
  familiesReused: number;
  guardiansCreated: number;
  /** Children given a family. */
  childrenSet: number;
  /** Members left untouched for a person: in several families, or in a family with another guardian. */
  needsHand: number;
  /** Members (or some of their children) a till held at that moment, left for the next run. */
  busy: number;
}

export interface FamilyBackfillBatch extends FamilyBackfillCounts {
  /** 1 for the first batch of this run. */
  batch: number;
  /** The batch covers member ids after this one (null: from the first) ... */
  afterMemberId: string | null;
  /** ... up to and including this one. */
  lastMemberId: string;
  /** How long the batch's transaction held its locks, in milliseconds (0 in a dry run). */
  durationMs: number;
  needsHandMemberIds: string[];
  busyMemberIds: string[];
}

export interface FamilyBackfillReport {
  applied: boolean;
  runId: string;
  batchSize: number;
  startAfter: string | null;
  /** Batches committed (or read, in a dry run). */
  batches: number;
  totals: FamilyBackfillCounts;
  needsHandMemberIds: string[];
  busyMemberIds: string[];
  /** The last member id of the last batch that completed: `--start-after` this resumes the run. */
  lastMemberId: string | null;
  /** No member after `lastMemberId` had a child without a family when the run stopped. */
  finished: boolean;
  /** The batch that failed and rolled back, which stopped the run. */
  failure: { batch: number; afterMemberId: string | null; message: string } | null;
}

/** Refused before anything is read: an argument out of range. */
export class FamilyBackfillRefused extends Error {}

const zeroCounts = (): FamilyBackfillCounts => ({
  members: 0,
  familiesCreated: 0,
  familiesReused: 0,
  guardiansCreated: 0,
  childrenSet: 0,
  needsHand: 0,
  busy: 0,
});

function addCounts(into: FamilyBackfillCounts, from: FamilyBackfillCounts): void {
  for (const k of Object.keys(into) as Array<keyof FamilyBackfillCounts>) into[k] += from[k];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ScannedMember {
  id: string;
  operatorId: string;
}

/**
 * The next members, in id order after `after`, who have at least one child
 * without a family (archived members and archived children included: every
 * child is to have a family before the column can be made NOT NULL).
 * Driven from `crm.child`, so a run over a finished database reads only the
 * index entries of children that still have none.
 */
async function nextMembers(exec: Exec, after: string | null, limit: number): Promise<ScannedMember[]> {
  const r = await exec.execute<{ id: string; operator_id: string }>(sql`
    select m.id, m.operator_id
      from (select distinct c.member_id
              from crm.child c
             where c.family_id is null
               ${after ? sql`and c.member_id > ${after}::uuid` : sql``}
             order by c.member_id
             limit ${limit}) p
      join crm.member m on m.id = p.member_id
     order by m.id`);
  return r.rows.map((row) => ({ id: row.id, operatorId: row.operator_id }));
}

type MemberPlan =
  | { kind: 'create'; memberId: string; operatorId: string }
  | { kind: 'reuse'; memberId: string; operatorId: string; familyId: string }
  | { kind: 'needs_hand'; memberId: string; operatorId: string };

/**
 * Where each member's children without a family go, by the writers' rule
 * (plan section 2.2) narrowed to one guardian: no live family yet, a new one;
 * one live family whose only live guardian is the member, that one; anything
 * else, a person decides. A family is counted only when it, the guardian row
 * and the member are all the member's own operator's.
 */
async function planMembers(exec: Exec, members: ScannedMember[]): Promise<MemberPlan[]> {
  if (members.length === 0) return [];
  const r = await exec.execute<{ member_id: string; family_id: string; others: number }>(sql`
    select g.member_id, g.family_id,
           (select count(*) from crm.family_guardian o
             where o.family_id = g.family_id and o.archived_at is null and o.member_id <> g.member_id)::int as others
      from crm.family_guardian g
      join crm.family f on f.id = g.family_id and f.operator_id = g.operator_id
      join crm.member m on m.id = g.member_id and m.operator_id = g.operator_id
     where g.member_id = any(${sql.param(members.map((m) => m.id))}::uuid[])
       and g.archived_at is null
       and f.archived_at is null
     order by g.member_id, f.created_at, f.id`);
  const families = new Map<string, Array<{ familyId: string; others: number }>>();
  for (const row of r.rows) {
    families.set(row.member_id, [...(families.get(row.member_id) ?? []), { familyId: row.family_id, others: row.others }]);
  }
  return members.map((m): MemberPlan => {
    const live = families.get(m.id) ?? [];
    if (live.length === 0) return { kind: 'create', memberId: m.id, operatorId: m.operatorId };
    if (live.length === 1 && live[0]!.others === 0) {
      return { kind: 'reuse', memberId: m.id, operatorId: m.operatorId, familyId: live[0]!.familyId };
    }
    return { kind: 'needs_hand', memberId: m.id, operatorId: m.operatorId };
  });
}

/** Familyless children per member, by an unlocked read. */
async function familylessCounts(exec: Exec, memberIds: string[]): Promise<Map<string, number>> {
  if (memberIds.length === 0) return new Map();
  const r = await exec.execute<{ member_id: string; n: number }>(sql`
    select member_id, count(*)::int as n
      from crm.child
     where member_id = any(${sql.param(memberIds)}::uuid[]) and family_id is null
     group by member_id`);
  return new Map(r.rows.map((row) => [row.member_id, row.n]));
}

interface BatchFrame {
  runId: string;
  batch: number;
  afterMemberId: string | null;
  lastMemberId: string;
}

/** A dry-run batch: the reads an applied batch makes, without its locks, and nothing written. */
async function readBatch(db: Db, scanned: ScannedMember[], frame: BatchFrame): Promise<FamilyBackfillBatch> {
  const counts = await familylessCounts(db, scanned.map((m) => m.id));
  const withChildren = scanned.filter((m) => (counts.get(m.id) ?? 0) > 0);
  const plans = await planMembers(db, withChildren);
  const out: FamilyBackfillBatch = {
    ...zeroCounts(),
    ...frame,
    durationMs: 0,
    needsHandMemberIds: [],
    busyMemberIds: [],
  };
  out.members = scanned.length;
  for (const p of plans) {
    if (p.kind === 'needs_hand') {
      out.needsHand += 1;
      out.needsHandMemberIds.push(p.memberId);
      continue;
    }
    if (p.kind === 'create') {
      out.familiesCreated += 1;
      out.guardiansCreated += 1;
    } else {
      out.familiesReused += 1;
    }
    out.childrenSet += counts.get(p.memberId) ?? 0;
  }
  return out;
}

/** An applied batch: one transaction, committed whole or rolled back whole. */
async function writeBatch(db: Db, scanned: ScannedMember[], frame: BatchFrame): Promise<FamilyBackfillBatch> {
  const started = Date.now();
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${BATCH_LOCK_TIMEOUT}'`));
    // The members first, in id order, as the writers lock them; one a till
    // holds right now is skipped and taken by the next run.
    const locked = await tx
      .select({ id: member.id, operatorId: member.operatorId })
      .from(member)
      .where(inArray(member.id, scanned.map((m) => m.id)))
      .orderBy(asc(member.id))
      .for('no key update', { skipLocked: true });
    const lockedIds = new Set(locked.map((m) => m.id));
    const busy = new Set(scanned.filter((m) => !lockedIds.has(m.id)).map((m) => m.id));

    const children = locked.length
      ? await tx
          .select({ id: child.id, memberId: child.memberId })
          .from(child)
          .where(and(inArray(child.memberId, [...lockedIds]), isNull(child.familyId)))
          .orderBy(asc(child.id))
          .for('no key update', { skipLocked: true })
      : [];
    // A child a till holds is left out of this batch, and its member counted
    // busy so the summary says to run again; the rest of that member's
    // children are done now, into the same family the next run will reuse.
    const all = await familylessCounts(tx, [...lockedIds]);
    const lockedPerMember = new Map<string, number>();
    for (const c of children) lockedPerMember.set(c.memberId, (lockedPerMember.get(c.memberId) ?? 0) + 1);
    for (const [memberId, n] of all) if ((lockedPerMember.get(memberId) ?? 0) < n) busy.add(memberId);

    const working = locked.filter((m) => (lockedPerMember.get(m.id) ?? 0) > 0);
    const plans = await planMembers(tx, working);

    const perOperator = new Map<string, FamilyBackfillCounts>();
    const countsOf = (operatorId: string) => {
      const existing = perOperator.get(operatorId);
      if (existing) return existing;
      const fresh = zeroCounts();
      perOperator.set(operatorId, fresh);
      return fresh;
    };
    for (const m of scanned) {
      countsOf(m.operatorId).members += 1;
      if (busy.has(m.id)) countsOf(m.operatorId).busy += 1;
    }

    const target = new Map<string, string>();
    const made: Array<{ familyId: string; guardianId: string; memberId: string; operatorId: string }> = [];
    const needsHand: string[] = [];
    for (const p of plans) {
      const c = countsOf(p.operatorId);
      if (p.kind === 'needs_hand') {
        c.needsHand += 1;
        needsHand.push(p.memberId);
      } else if (p.kind === 'reuse') {
        c.familiesReused += 1;
        target.set(p.memberId, p.familyId);
      } else {
        const familyId = newId();
        made.push({ familyId, guardianId: newId(), memberId: p.memberId, operatorId: p.operatorId });
        c.familiesCreated += 1;
        c.guardiansCreated += 1;
        target.set(p.memberId, familyId);
      }
    }
    if (made.length) {
      await tx
        .insert(family)
        .values(made.map((f) => ({ id: f.familyId, operatorId: f.operatorId, source: 'backfill' as const })));
      await tx.insert(familyGuardian).values(
        made.map((f) => ({
          id: f.guardianId,
          operatorId: f.operatorId,
          familyId: f.familyId,
          memberId: f.memberId,
          source: 'backfill' as const,
        })),
      );
    }

    const pairs = children.filter((c) => target.has(c.memberId));
    if (pairs.length) {
      const updated = await tx.execute(sql`
        update crm.child c
           set family_id = v.family_id
          from unnest(${sql.param(pairs.map((p) => p.id))}::uuid[],
                      ${sql.param(pairs.map((p) => target.get(p.memberId)!))}::uuid[]) as v(child_id, family_id)
         where c.id = v.child_id and c.family_id is null`);
      // Every one of these rows is locked by this transaction and had no
      // family a moment ago: anything else is a fault, and the batch rolls back.
      if (updated.rowCount !== pairs.length) {
        throw new Error(`expected to give ${pairs.length} children a family, the database changed ${updated.rowCount}`);
      }
      for (const p of pairs) {
        const operatorId = locked.find((m) => m.id === p.memberId)!.operatorId;
        countsOf(operatorId).childrenSet += 1;
      }
    }

    // One row per operator that this batch wrote for; a batch that wrote
    // nothing writes no audit row, so a second run over a finished database
    // leaves the log as it was.
    const batchEntityId = newId();
    for (const [operatorId, c] of perOperator) {
      if (c.familiesCreated + c.familiesReused + c.childrenSet === 0) continue;
      await tx.insert(auditLog).values({
        id: newId(),
        operatorId,
        actorAccountId: null,
        requestId: FAMILY_BACKFILL_REQUEST_ID,
        origin: 'job',
        action: 'family.backfill',
        entityType: 'family_backfill_batch',
        entityId: batchEntityId,
        after: {
          runId: frame.runId,
          batch: frame.batch,
          afterMemberId: frame.afterMemberId,
          lastMemberId: frame.lastMemberId,
          ...c,
        },
      });
    }

    const totals = zeroCounts();
    for (const c of perOperator.values()) addCounts(totals, c);
    return { totals, needsHand, busy: [...busy] };
  });
  return {
    ...result.totals,
    ...frame,
    durationMs: Date.now() - started,
    needsHandMemberIds: result.needsHand,
    busyMemberIds: result.busy,
  };
}

/** The message of a failed batch: the error's own words and SQLSTATE, never a row's values. */
function failureText(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown; cause?: unknown };
  const cause = e?.cause as { message?: unknown; code?: unknown } | undefined;
  const message = typeof cause?.message === 'string' ? cause.message : typeof e?.message === 'string' ? e.message : String(err);
  const code = typeof cause?.code === 'string' ? cause.code : typeof e?.code === 'string' ? e.code : null;
  return code ? `${message} [${code}]` : message;
}

/**
 * Give every child saved before families existed a family (see the header).
 * Without `apply` it is a dry run: the same reads, the same counts, nothing
 * written. A failed batch is rolled back, recorded in `failure`, and stops
 * the run; the report's `lastMemberId` is where the next run may resume.
 */
export async function backfillFamilies(db: Db, opts: FamilyBackfillOptions): Promise<FamilyBackfillReport> {
  const batchSize = opts.batchSize ?? FAMILY_BACKFILL_DEFAULT_BATCH;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > FAMILY_BACKFILL_MAX_BATCH) {
    throw new FamilyBackfillRefused(`the batch size must be a whole number from 1 to ${FAMILY_BACKFILL_MAX_BATCH}`);
  }
  const startAfter = opts.startAfter ?? null;
  if (startAfter !== null && !UUID.test(startAfter)) {
    throw new FamilyBackfillRefused('the member id to start after must be a uuid');
  }
  const maxBatches = opts.maxBatches ?? null;
  if (maxBatches !== null && (!Number.isInteger(maxBatches) || maxBatches < 1)) {
    throw new FamilyBackfillRefused('the number of batches must be a whole number of at least 1');
  }

  const report: FamilyBackfillReport = {
    applied: opts.apply,
    runId: newId(),
    batchSize,
    startAfter,
    batches: 0,
    totals: zeroCounts(),
    needsHandMemberIds: [],
    busyMemberIds: [],
    lastMemberId: startAfter,
    finished: false,
    failure: null,
  };

  for (;;) {
    if (maxBatches !== null && report.batches >= maxBatches) {
      report.finished = (await nextMembers(db, report.lastMemberId, 1)).length === 0;
      break;
    }
    const scanned = await nextMembers(db, report.lastMemberId, batchSize);
    if (scanned.length === 0) {
      report.finished = true;
      break;
    }
    const frame: BatchFrame = {
      runId: report.runId,
      batch: report.batches + 1,
      afterMemberId: report.lastMemberId,
      lastMemberId: scanned[scanned.length - 1]!.id,
    };
    let batch: FamilyBackfillBatch;
    try {
      batch = opts.apply ? await writeBatch(db, scanned, frame) : await readBatch(db, scanned, frame);
    } catch (err) {
      report.failure = { batch: frame.batch, afterMemberId: frame.afterMemberId, message: failureText(err) };
      break;
    }
    report.batches += 1;
    addCounts(report.totals, batch);
    report.needsHandMemberIds.push(...batch.needsHandMemberIds);
    report.busyMemberIds.push(...batch.busyMemberIds);
    report.lastMemberId = batch.lastMemberId;
    opts.onBatch?.(batch);
  }
  return report;
}
