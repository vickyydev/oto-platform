import { inArray, sql } from 'drizzle-orm';
import { branchSourceSwitch } from '@oto/db';
import {
  DEFAULT_BRANCH_SOURCE,
  newId,
  type AnalyticsSource,
  type AnalyticsSourcePreference,
  type BranchSource,
  type BranchSourceBody,
} from '@oto/shared';
import { audit } from './audit';
import type { Exec, Tx } from './tx';

/**
 * S2-15b (SCRUM-216) round 6 — WHICH SOURCE A BRANCH REPORTS (plan
 * docs/progress/plans/analytics/PLAN.md §5, §7; read by S2-18).
 *
 * One `analytics.branch_source_switch` row per branch, unique: the source the
 * summary serves for it (`oto_pos`, the platform's own rolled-up days; or
 * `pisell` / `papaya`, that legacy system's frozen days) and Radar's
 * preference (`oto_pos`, `legacy`, `both`). A branch with no row reports
 * `oto_pos`, preferred `oto_pos` — every branch did before this round.
 *
 * WRITTEN BY PEOPLE, one at a time. A switch is configuration, not a figure:
 * it is the one analytics table the api writes rather than the jobs process.
 * Every change records who made it and when (`switched_at`, `actor_account_id`)
 * and an audit row with the switch before and after, in one transaction. A
 * request that asks for what the branch already has changes nothing and
 * records nothing.
 */

export interface StoredBranchSource {
  source: AnalyticsSource;
  preference: AnalyticsSourcePreference;
  switchedAt: Date | null;
  actorAccountId: string | null;
}

const NEVER_SWITCHED: StoredBranchSource = { ...DEFAULT_BRANCH_SOURCE, switchedAt: null, actorAccountId: null };

/** Each branch's switch; a branch with no row reports `oto_pos`. */
export async function branchSourcesOf(db: Exec, branchIds: readonly string[]): Promise<Map<string, StoredBranchSource>> {
  const out = new Map<string, StoredBranchSource>(branchIds.map((id) => [id, NEVER_SWITCHED]));
  if (branchIds.length === 0) return out;
  const rows = await db
    .select({
      branchId: branchSourceSwitch.branchId,
      source: branchSourceSwitch.source,
      preference: branchSourceSwitch.preference,
      switchedAt: branchSourceSwitch.switchedAt,
      actorAccountId: branchSourceSwitch.actorAccountId,
    })
    .from(branchSourceSwitch)
    .where(inArray(branchSourceSwitch.branchId, [...branchIds]));
  for (const row of rows) {
    out.set(row.branchId, {
      source: row.source,
      preference: row.preference as AnalyticsSourcePreference,
      switchedAt: row.switchedAt,
      actorAccountId: row.actorAccountId,
    });
  }
  return out;
}

/** A branch's switch as the routes answer it. */
export function branchSourceView(branch: { id: string; name: string }, stored: StoredBranchSource): BranchSource {
  return {
    branchId: branch.id,
    name: branch.name,
    source: stored.source,
    preference: stored.preference,
    switchedAt: stored.switchedAt?.toISOString() ?? null,
    actorAccountId: stored.actorAccountId,
  };
}

/** The audit's picture of a switch: what it serves and who set it when. */
function auditShape(s: StoredBranchSource) {
  return {
    source: s.source,
    preference: s.preference,
    switchedAt: s.switchedAt?.toISOString() ?? null,
    actorAccountId: s.actorAccountId,
  };
}

/**
 * Switch one branch, inside the caller's transaction. Serialised per branch,
 * so two people switching at once are applied one after the other and each
 * audit row's "before" is what the other left. Answers the switch as it now
 * stands and whether this call changed it.
 */
export async function switchBranchSource(
  tx: Tx,
  input: {
    operatorId: string;
    branchId: string;
    body: BranchSourceBody;
    actorAccountId: string;
    requestId?: string;
    now: Date;
  },
): Promise<{ changed: boolean; stored: StoredBranchSource }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('analytics.branch_source_switch'), hashtext(${input.branchId}))`,
  );
  const before = (await branchSourcesOf(tx, [input.branchId])).get(input.branchId) ?? NEVER_SWITCHED;
  if (before.source === input.body.source && before.preference === input.body.preference) {
    return { changed: false, stored: before };
  }
  const after: StoredBranchSource = {
    source: input.body.source,
    preference: input.body.preference,
    switchedAt: input.now,
    actorAccountId: input.actorAccountId,
  };
  await tx
    .insert(branchSourceSwitch)
    .values({
      id: newId(),
      operatorId: input.operatorId,
      branchId: input.branchId,
      source: after.source,
      preference: after.preference,
      switchedAt: input.now,
      actorAccountId: input.actorAccountId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: branchSourceSwitch.branchId,
      set: {
        source: after.source,
        preference: after.preference,
        switchedAt: input.now,
        actorAccountId: input.actorAccountId,
        updatedAt: input.now,
      },
    });
  await audit.record(tx, {
    actorAccountId: input.actorAccountId,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'analytics.branch_source.switch',
    entityType: 'branch_source_switch',
    entityId: input.branchId,
    before: auditShape(before),
    after: auditShape(after),
    requestId: input.requestId ?? null,
  });
  return { changed: true, stored: after };
}
