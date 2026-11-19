import { and, asc, gt, inArray, isNull } from 'drizzle-orm';
import { child, member } from '@oto/db';
import { childrenSeenBy } from './family';
import type { Exec } from './tx';

/**
 * SCRUM-1024 — THE SHADOW COMPARE for the reader switch (plan step R1 in
 * section 3 of `docs/progress/plans/dropoff-beo-20261119/
 * FAMILY_PROFILES_PLAN.md`). Read only; written with the backfill (step F2)
 * and run before and after the readers move to the family (step F3).
 *
 * For every member, archived or not, two sets of children side by side:
 *   - BY MEMBER, today's read: what the counter's lookup gives
 *     (`memberWithChildren` in `routes/members.ts`), a live member's live
 *     children by `child.member_id`, and nothing for an archived member;
 *   - THROUGH THE FAMILY, the read the readers switch to: `childrenSeenBy`
 *     in `services/family.ts`, called as it is, for the member's own operator.
 * Every member whose two sets differ is reported with the children only one
 * side gives. While every family has one guardian, its member, the two
 * answers are the same, so after a clean backfill there is no difference.
 *
 * The command line is `apps/api/scripts/family-shadow-compare.ts`; the
 * runbook is `FAMILY_BACKFILL_RUNBOOK.md` beside the plan. Ids only.
 */

export interface FamilyShadowDifference {
  memberId: string;
  operatorId: string;
  memberLive: boolean;
  /** Children today's read gives this member and the family read does not. */
  onlyByMember: string[];
  /** Children the family read gives this member and today's read does not. */
  onlyThroughFamily: string[];
}

export interface FamilyShadowReport {
  membersCompared: number;
  /** Children counted by today's read, over every member. */
  childrenByMember: number;
  /** Children counted through the family, over every member. */
  childrenThroughFamily: number;
  differences: FamilyShadowDifference[];
}

export const FAMILY_SHADOW_DEFAULT_BATCH = 500;

/** Compare the two reads for every member, in member id order, `batchSize` members at a time. */
export async function compareFamilyReads(
  exec: Exec,
  opts: { batchSize?: number; onDifference?: (d: FamilyShadowDifference) => void } = {},
): Promise<FamilyShadowReport> {
  const batchSize = opts.batchSize ?? FAMILY_SHADOW_DEFAULT_BATCH;
  const report: FamilyShadowReport = { membersCompared: 0, childrenByMember: 0, childrenThroughFamily: 0, differences: [] };
  let after: string | null = null;
  for (;;) {
    const members: Array<{ id: string; operatorId: string; archivedAt: Date | null }> = await exec
      .select({ id: member.id, operatorId: member.operatorId, archivedAt: member.archivedAt })
      .from(member)
      .where(after ? gt(member.id, after) : undefined)
      .orderBy(asc(member.id))
      .limit(batchSize);
    if (members.length === 0) break;

    const liveIds = members.filter((m) => m.archivedAt === null).map((m) => m.id);
    const byMember = new Map<string, Set<string>>();
    if (liveIds.length) {
      const rows = await exec
        .select({ id: child.id, memberId: child.memberId })
        .from(child)
        .where(and(inArray(child.memberId, liveIds), isNull(child.archivedAt)));
      for (const r of rows) byMember.set(r.memberId, (byMember.get(r.memberId) ?? new Set()).add(r.id));
    }

    for (const m of members) {
      const old = byMember.get(m.id) ?? new Set<string>();
      const seen = new Set(
        (await childrenSeenBy(exec, { operatorId: m.operatorId, memberId: m.id })).map((c) => c.id),
      );
      report.membersCompared += 1;
      report.childrenByMember += old.size;
      report.childrenThroughFamily += seen.size;
      const onlyByMember = [...old].filter((id) => !seen.has(id)).sort();
      const onlyThroughFamily = [...seen].filter((id) => !old.has(id)).sort();
      if (onlyByMember.length || onlyThroughFamily.length) {
        const d: FamilyShadowDifference = {
          memberId: m.id,
          operatorId: m.operatorId,
          memberLive: m.archivedAt === null,
          onlyByMember,
          onlyThroughFamily,
        };
        report.differences.push(d);
        opts.onDifference?.(d);
      }
    }
    after = members[members.length - 1]!.id;
  }
  return report;
}
