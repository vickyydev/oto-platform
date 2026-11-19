import { and, asc, eq, exists, isNull, sql, type SQL } from 'drizzle-orm';
import {
  branch,
  child,
  family,
  familyGuardian,
  FAMILY_PROFILES_KEY,
  member,
  station,
  type FamilyProfilesMode,
  type FamilySource,
} from '@oto/db';
import { newId } from '@oto/shared';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { effectiveFlag } from './suite-flags';
import type { Exec, Tx } from './tx';

/**
 * SCRUM-1024 — FAMILY PROFILES: several parents or guardians for the same
 * children (plan `docs/progress/plans/dropoff-beo-20261119/
 * FAMILY_PROFILES_PLAN.md`, sections 2.2 and 3, step F1).
 *
 * A child belongs to one FAMILY (`crm.child.family_id`); a family's parents
 * and guardians are members holding a live `crm.family_guardian` row on it.
 * `crm.child.member_id` keeps its meaning, "first saved under", and is still
 * what every reader uses: in this step every writer of a child gives the new
 * child a family, and nothing reads one. The readers move behind the switch
 * `crm.family_profiles` in step F3.
 *
 * Not `crm.guardian` (`schema/checkin.ts`), which is a collector on one
 * drop-off registration.
 */

/** Where a new child's family came from: the writer that made it. Backfill and link are not writers of a child. */
export type ChildFamilySource = Extract<FamilySource, 'till' | 'sync' | 'booking'>;

/** Who and where, for the guardian row and the audit entry of a family this call makes. */
export interface FamilyWriteContext {
  /** The signed-in staff member; null for the booking site and a box with no actor. */
  accountId: string | null;
  branchId: string | null;
  stationId: string | null;
  requestId?: string | null;
  actionId?: string | null;
  /** The box fact being applied, for a family a sync makes. */
  sourceEventId?: string | null;
  /** The audit row's origin, as the caller's own child.create row has it (`booking_site`). */
  origin?: string | null;
}

export interface EnsureFamilyInput {
  operatorId: string;
  /** The member the child is saved under (`child.member_id`), already resolved through any alias. */
  memberId: string;
  /** The child about to be written, named on the audit row of a family made for it. */
  childId: string;
  /**
   * A family the request names. The member must hold a live guardian row on
   * it. No writer names one yet: the counter's choice of family arrives with
   * adding a second parent (plan step F4).
   */
  familyId?: string | null;
  source: ChildFamilySource;
  context: FamilyWriteContext;
}

export interface EnsuredFamily {
  familyId: string;
  /** True when this call made the family (and its one guardian row). */
  created: boolean;
  /**
   * The member is a live guardian of more than one family and none was named,
   * so the oldest was taken. The plan raises the member's review flag here;
   * that is left to the step that lets a member hold a second family (F4),
   * because until then this cannot happen.
   */
  ambiguous: boolean;
}

/**
 * The family a NEW child of `memberId` goes to, made if there is none —
 * inside the caller's transaction, before the child row is written (its
 * `family_id` references the family).
 *
 * The rule (plan §2.2): the family the request names; otherwise the member's
 * only live family; if the member is a guardian in several, the oldest live
 * one; if the member has none yet, a new family (source as given) with that
 * member as its one guardian.
 *
 * ONCE. The member's row is locked (FOR NO KEY UPDATE, which a child's own
 * foreign key check does not wait on) before the families are read, so two
 * first children of one member saved at the same moment wait for each other
 * and share one family. A retried request or a replayed box fact finds its
 * child already saved and never reaches here; one that failed rolled this
 * back with it.
 *
 * TENANCY. The member must be the operator's (archived or not: a box may
 * still add a child under a member archived since, as it could before). A
 * named family must be the operator's, live, and hold the member as a live
 * guardian. Families are read through the operator on both the family and the
 * guardian row, so another operator's family is never found.
 */
export async function ensureFamilyFor(tx: Tx, input: EnsureFamilyInput): Promise<EnsuredFamily> {
  const [owner] = await tx
    .select({ id: member.id, operatorId: member.operatorId })
    .from(member)
    .where(eq(member.id, input.memberId))
    .for('no key update')
    .limit(1);
  if (!owner || owner.operatorId !== input.operatorId) throw errors.notFound('Member not found');

  if (input.familyId) {
    const [named] = await tx
      .select({ id: family.id })
      .from(family)
      .innerJoin(
        familyGuardian,
        and(
          eq(familyGuardian.familyId, family.id),
          eq(familyGuardian.operatorId, family.operatorId),
          eq(familyGuardian.memberId, owner.id),
          isNull(familyGuardian.archivedAt),
        ),
      )
      .where(and(eq(family.id, input.familyId), eq(family.operatorId, input.operatorId), isNull(family.archivedAt)))
      .limit(1);
    // The same words for a family that does not exist, is another operator's,
    // or does not hold this member: the answer never says which.
    if (!named) throw errors.notFound('Family not found');
    return { familyId: named.id, created: false, ambiguous: false };
  }

  const live = await liveFamiliesOf(tx, input.operatorId, owner.id);
  if (live.length > 0) return { familyId: live[0]!, created: false, ambiguous: live.length > 1 };

  const familyId = newId();
  const guardianId = newId();
  const place = await placeOf(tx, input.operatorId, input.context);
  await tx.insert(family).values({
    id: familyId,
    operatorId: input.operatorId,
    source: input.source,
    createdByAccountId: input.context.accountId,
  });
  await tx.insert(familyGuardian).values({
    id: guardianId,
    operatorId: input.operatorId,
    familyId,
    memberId: owner.id,
    source: input.source,
    addedByAccountId: input.context.accountId,
    branchId: place.branchId,
    stationId: place.stationId,
  });
  // One row for the family and its first guardian: who, where, when, and
  // the child it was made for. Further guardians are `family_guardian.add`
  // (plan §4.1), written by the step that adds them.
  await audit.record(tx, {
    actorAccountId: input.context.accountId,
    operatorId: input.operatorId,
    branchId: place.branchId,
    action: 'family.create',
    entityType: 'family',
    entityId: familyId,
    after: {
      source: input.source,
      memberId: owner.id,
      guardianId,
      childId: input.childId,
      stationId: place.stationId,
    },
    requestId: input.context.requestId ?? null,
    actionId: input.context.actionId ?? null,
    sourceEventId: input.context.sourceEventId ?? null,
    ...(input.context.origin ? { origin: input.context.origin } : {}),
  });
  return { familyId, created: true, ambiguous: false };
}

/**
 * The park and till a guardian row names, kept only when they are the
 * operator's own: a session working in another park group (an administrator
 * who switched) may carry a branch of its home one, and a row of this
 * operator never points into another. A station is kept only with its branch.
 */
async function placeOf(
  tx: Tx,
  operatorId: string,
  context: FamilyWriteContext,
): Promise<{ branchId: string | null; stationId: string | null }> {
  if (!context.branchId) return { branchId: null, stationId: null };
  const [row] = await tx
    .select({ branchId: branch.id, stationId: station.id })
    .from(branch)
    .leftJoin(
      station,
      and(
        eq(station.id, context.stationId ?? NO_ID),
        eq(station.branchId, branch.id),
        eq(station.operatorId, operatorId),
      ),
    )
    .where(and(eq(branch.id, context.branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  return { branchId: row?.branchId ?? null, stationId: row?.stationId ?? null };
}

/** A uuid no row holds, for a join on an absent id. */
const NO_ID = '00000000-0000-0000-0000-000000000000';

/** The live families a member is a live guardian of, oldest first. */
export async function liveFamiliesOf(exec: Exec, operatorId: string, memberId: string): Promise<string[]> {
  const rows = await exec
    .select({ id: family.id })
    .from(familyGuardian)
    .innerJoin(
      family,
      and(eq(family.id, familyGuardian.familyId), eq(family.operatorId, familyGuardian.operatorId)),
    )
    .where(
      and(
        eq(familyGuardian.memberId, memberId),
        eq(familyGuardian.operatorId, operatorId),
        isNull(familyGuardian.archivedAt),
        isNull(family.archivedAt),
      ),
    )
    .orderBy(asc(family.createdAt), asc(family.id));
  return rows.map((r) => r.id);
}

// --- The read rule ------------------------------------------------------------
//
// Written now and called from nowhere yet: step F3 switches every reader of
// `child.member_id` (plan §1.2) to it behind the `crm.family_profiles` switch,
// at `read` and `on`; at `off` they keep `child.member_id`.

/**
 * The plan's one rule, as a condition on `crm.child` rows: a member sees a
 * child when the member is live, holds a live guardian row in the child's
 * family, and the child is live and not merged into another. The family must
 * be live too, and the family, the guardian row and the member all of one
 * operator — the fence the rule stands on.
 */
export function seenThroughFamily(operatorId: string, memberId: string): SQL {
  return and(
    isNull(child.archivedAt),
    isNull(child.mergedIntoChildId),
    exists(
      sql`(select 1 from ${familyGuardian}
            join ${family} on ${family.id} = ${familyGuardian.familyId} and ${family.operatorId} = ${familyGuardian.operatorId}
            join ${member} on ${member.id} = ${familyGuardian.memberId} and ${member.operatorId} = ${familyGuardian.operatorId}
           where ${familyGuardian.familyId} = ${child.familyId}
             and ${familyGuardian.memberId} = ${memberId}
             and ${familyGuardian.operatorId} = ${operatorId}
             and ${familyGuardian.archivedAt} is null
             and ${family.archivedAt} is null
             and ${member.archivedAt} is null)`,
    ),
  )!;
}

/** The children a member sees through their families (the rule above), in the order they were saved. */
export async function childrenSeenBy(
  exec: Exec,
  scope: { operatorId: string; memberId: string },
): Promise<Array<typeof child.$inferSelect>> {
  return exec
    .select()
    .from(child)
    .where(seenThroughFamily(scope.operatorId, scope.memberId))
    .orderBy(asc(child.createdAt), asc(child.id));
}

/** Whether a member sees one child through a family (the rule above). */
export async function memberSeesChild(
  exec: Exec,
  scope: { operatorId: string; memberId: string; childId: string },
): Promise<boolean> {
  const [row] = await exec
    .select({ id: child.id })
    .from(child)
    .where(and(eq(child.id, scope.childId), seenThroughFamily(scope.operatorId, scope.memberId)))
    .limit(1);
  return Boolean(row);
}

// --- The switch -----------------------------------------------------------------

/**
 * What `crm.family_profiles` says for an operator: `off` (the default, and
 * the only value until its readers exist — the catalogue lists it as not yet
 * supported, so nothing can set it), `read` or `on`. Read only by its tests in
 * this step; step F3's readers ask it which way to read a member's children.
 */
export async function familyProfilesMode(exec: Exec, operatorId: string, now = new Date()): Promise<FamilyProfilesMode> {
  const resolved = await effectiveFlag(exec, FAMILY_PROFILES_KEY, { operatorId, branchId: null, stationId: null }, now);
  return resolved.value as FamilyProfilesMode;
}
