import { and, asc, eq, isNull } from 'drizzle-orm';
import { branch, family, familyGuardian, member, station, type FamilySource } from '@oto/db';
import { newId } from '@oto/shared';
import { errors } from '../lib/errors';
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
 * child a family, and nothing reads one. The read rule and the readers come
 * behind the switch `crm.family_profiles` in step F3.
 *
 * Not `crm.guardian` (`schema/checkin.ts`), which is a collector on one
 * drop-off registration.
 */

/** Where a new child's family came from: the writer that made it. Backfill and link are not writers of a child. */
export type ChildFamilySource = Extract<FamilySource, 'till' | 'sync' | 'booking'>;

/**
 * Who and where, kept on the family and the guardian row a call makes
 * (`created_by_account_id`, `added_by_account_id`, `branch_id`,
 * `station_id`, and their `created_at`). A family is not an audited action of
 * its own in this step: the caller's `child.create` row is the audit of the
 * act, and the plan names no other until a second guardian is added (F4).
 */
export interface FamilyWriteContext {
  /** The signed-in staff member; null for the booking site and a box with no actor. */
  accountId: string | null;
  branchId: string | null;
  stationId: string | null;
}

export interface EnsureFamilyInput {
  operatorId: string;
  /** The member the child is saved under (`child.member_id`), already resolved through any alias. */
  memberId: string;
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
 * ONCE, AND A LOCK ONLY FOR THE FIRST. A member who already has a family is
 * answered from a plain read: nothing archives a family or a guardian row
 * before linking two records (step F5), so a family read is still the
 * member's when the child is written. Only when the read finds none is the
 * member's row locked (FOR NO KEY UPDATE, which a child's own foreign key
 * check does not wait on) and the families read again, so two first children
 * of one member saved at the same moment wait for each other and share one
 * family; under READ COMMITTED the second read sees the family the other
 * committed. A box batch applies all its facts in one transaction, so the
 * lock is held to the end of the batch — which is why it is taken for a
 * member's first family only. A retried request or a replayed box fact finds
 * its child already saved and never reaches here; one that failed rolled this
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

  const found = await liveFamiliesOf(tx, input.operatorId, owner.id);
  if (found.length > 0) return { familyId: found[0]!, created: false, ambiguous: found.length > 1 };

  // None yet: hold the member, then read again before making one.
  await tx.select({ id: member.id }).from(member).where(eq(member.id, owner.id)).for('no key update');
  const live = await liveFamiliesOf(tx, input.operatorId, owner.id);
  if (live.length > 0) return { familyId: live[0]!, created: false, ambiguous: live.length > 1 };

  const familyId = newId();
  const place = await placeOf(tx, input.operatorId, input.context);
  await tx.insert(family).values({
    id: familyId,
    operatorId: input.operatorId,
    source: input.source,
    createdByAccountId: input.context.accountId,
  });
  await tx.insert(familyGuardian).values({
    id: newId(),
    operatorId: input.operatorId,
    familyId,
    memberId: owner.id,
    source: input.source,
    addedByAccountId: input.context.accountId,
    branchId: place.branchId,
    stationId: place.stationId,
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

/** The two columns step F1 added to `crm.child`. */
type ChildFamilyColumn = 'familyId' | 'mergedIntoChildId';

/**
 * A child row as an audit entry stores it, without the two family columns:
 * the `child.update` and `child.archive` rows that keep a whole child row
 * (`before`, `after`) read exactly as they did before families existed, so
 * the audit answer and the Console's audit page do not change while the
 * switch is off. Step F3, which makes the family something people see, is
 * where it would be added to them.
 */
export function childAuditView<T extends object>(row: T): Omit<T, ChildFamilyColumn>;
export function childAuditView<T extends object>(row: T | undefined): Omit<T, ChildFamilyColumn> | undefined;
export function childAuditView<T extends object>(row: T | undefined): Omit<T, ChildFamilyColumn> | undefined {
  if (!row) return row;
  const { familyId: _familyId, mergedIntoChildId: _mergedIntoChildId, ...rest } = row as T &
    Partial<Record<ChildFamilyColumn, unknown>>;
  return rest as Omit<T, ChildFamilyColumn>;
}
