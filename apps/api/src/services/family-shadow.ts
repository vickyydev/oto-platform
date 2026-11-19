import { and, asc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { child, family, familyGuardian, member } from '@oto/db';
import { childOfMember } from './family';
import type { Exec } from './tx';

/**
 * SCRUM-1024 — THE SHADOW COMPARE for the reader switch (plan step R1 in
 * section 3 of `docs/progress/plans/dropoff-beo-20261119/
 * FAMILY_PROFILES_PLAN.md`). Read only; it came with the readers (step F3)
 * and is run after a clean backfill and verify, before a park group's switch
 * `crm.family_profiles` is turned to `read`, and again after.
 *
 * For every member of every park group, archived or not, two sets of
 * children side by side:
 *   - BY MEMBER, the read at `off`: the children first saved under the member
 *     (`child.member_id`), removed ones included;
 *   - THROUGH THE FAMILY, the read at `read`: the children the member holds
 *     through a live guardian row on a live family of the member's own park
 *     group, removed ones included and merged ones not. It is
 *     `childOfMember` in `services/family.ts` at `read`, called as the
 *     readers call it, with the member's own state not asked.
 *
 * Every reader of a member's children asks one of these two conditions and
 * then adds its own (the child not removed, the member not archived) the same
 * way at both settings. So when the two sets are equal for every member,
 * every reader answers the same at `off` and at `read`. Where they differ,
 * each child that differs is put under the kind of difference that explains
 * it (`FAMILY_SHADOW_KINDS`), and each kind lists up to `sample` member ids.
 *
 * The command line is `apps/api/scripts/family-shadow-compare.ts`; the
 * runbook is `FAMILY_BACKFILL_RUNBOOK.md` beside the plan. Ids and counts
 * only, never a name, a phone number or a note.
 */

export const FAMILY_SHADOW_KINDS = [
  {
    key: 'child_without_family',
    label: "the member's own child has no family (the backfill has not reached it)",
  },
  {
    key: 'child_family_not_held',
    label: "the member's own child is in a family the member is not a live guardian of",
  },
  { key: 'child_family_archived', label: "the member's own child is in an archived family" },
  { key: 'child_merged', label: "the member's own child is merged into another child" },
  {
    key: 'child_of_another_member',
    label: 'the member holds, through a family, a child first saved under another member',
  },
] as const;

export type FamilyShadowKind = (typeof FAMILY_SHADOW_KINDS)[number]['key'];

/** One member under one kind: the children of that kind, by id. */
export interface FamilyShadowSample {
  memberId: string;
  operatorId: string;
  childIds: string[];
}

export interface FamilyShadowKindReport {
  key: FamilyShadowKind;
  label: string;
  /** Members with at least one child of this kind. */
  members: number;
  /** Children of this kind, counted once per member they differ for. */
  children: number;
  /** Up to `sample` of those members, in member id order. */
  samples: FamilyShadowSample[];
}

export interface FamilyShadowReport {
  membersCompared: number;
  /** Children first saved under a member, over every member. */
  childrenByMember: number;
  /** Children held through a family, over every member. */
  childrenThroughFamily: number;
  membersWithDifference: number;
  kinds: FamilyShadowKindReport[];
  /** No member differs. */
  ok: boolean;
}

export const FAMILY_SHADOW_DEFAULT_BATCH = 500;
export const FAMILY_SHADOW_DEFAULT_SAMPLE = 20;

/** Compare the two reads for every member, in member id order, `batchSize` members at a time. */
export async function compareFamilyReads(
  exec: Exec,
  opts: { batchSize?: number; sample?: number } = {},
): Promise<FamilyShadowReport> {
  const batchSize = opts.batchSize ?? FAMILY_SHADOW_DEFAULT_BATCH;
  const sample = Math.max(0, Math.floor(opts.sample ?? FAMILY_SHADOW_DEFAULT_SAMPLE));
  const kinds = new Map<FamilyShadowKind, FamilyShadowKindReport>(
    FAMILY_SHADOW_KINDS.map((k) => [k.key, { key: k.key, label: k.label, members: 0, children: 0, samples: [] }]),
  );
  const report: Omit<FamilyShadowReport, 'kinds' | 'ok'> = {
    membersCompared: 0,
    childrenByMember: 0,
    childrenThroughFamily: 0,
    membersWithDifference: 0,
  };

  let after: string | null = null;
  for (;;) {
    const members: Array<{ id: string; operatorId: string }> = await exec
      .select({ id: member.id, operatorId: member.operatorId })
      .from(member)
      .where(after ? gt(member.id, after) : undefined)
      .orderBy(asc(member.id))
      .limit(batchSize);
    if (members.length === 0) break;

    const ownRows = await exec
      .select({
        id: child.id,
        memberId: child.memberId,
        familyId: child.familyId,
        mergedIntoChildId: child.mergedIntoChildId,
      })
      .from(child)
      .where(inArray(child.memberId, members.map((m) => m.id)));
    const ownOf = new Map<string, typeof ownRows>();
    for (const r of ownRows) ownOf.set(r.memberId, [...(ownOf.get(r.memberId) ?? []), r]);

    for (const m of members) {
      const own = ownOf.get(m.id) ?? [];
      const held = new Set(
        (
          await exec
            .select({ id: child.id })
            .from(child)
            .where(childOfMember('read', { operatorId: m.operatorId, memberId: m.id, memberLive: false }))
        ).map((r) => r.id),
      );
      report.membersCompared += 1;
      report.childrenByMember += own.length;
      report.childrenThroughFamily += held.size;

      const ownIds = new Set(own.map((r) => r.id));
      const found = new Map<FamilyShadowKind, string[]>();
      const put = (kind: FamilyShadowKind, childId: string) => found.set(kind, [...(found.get(kind) ?? []), childId]);
      const missing = own.filter((r) => !held.has(r.id));
      if (missing.length > 0) {
        const families = await heldFamiliesOf(exec, m.operatorId, m.id);
        for (const r of missing) {
          if (r.mergedIntoChildId) put('child_merged', r.id);
          else if (!r.familyId) put('child_without_family', r.id);
          else if (families.get(r.familyId) === true) put('child_family_archived', r.id);
          else put('child_family_not_held', r.id);
        }
      }
      for (const id of held) if (!ownIds.has(id)) put('child_of_another_member', id);

      if (found.size > 0) report.membersWithDifference += 1;
      for (const [key, childIds] of found) {
        const k = kinds.get(key)!;
        k.members += 1;
        k.children += childIds.length;
        if (k.samples.length < sample) k.samples.push({ memberId: m.id, operatorId: m.operatorId, childIds: childIds.sort() });
      }
    }
    after = members[members.length - 1]!.id;
  }
  return { ...report, kinds: [...kinds.values()], ok: report.membersWithDifference === 0 };
}

/**
 * The families a member holds a live guardian row on inside its own park
 * group, each with whether the family is archived: only to say which kind a
 * difference is, so it is read only for a member that differs.
 */
async function heldFamiliesOf(exec: Exec, operatorId: string, memberId: string): Promise<Map<string, boolean>> {
  const rows = await exec
    .select({ familyId: familyGuardian.familyId, archivedAt: family.archivedAt })
    .from(familyGuardian)
    .innerJoin(family, and(eq(family.id, familyGuardian.familyId), eq(family.operatorId, familyGuardian.operatorId)))
    .where(
      and(
        eq(familyGuardian.memberId, memberId),
        eq(familyGuardian.operatorId, operatorId),
        isNull(familyGuardian.archivedAt),
      ),
    );
  return new Map(rows.map((r) => [r.familyId, r.archivedAt !== null]));
}
