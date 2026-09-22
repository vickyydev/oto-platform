import {
  mapCoreBranchIntoApp,
  readAppBranchMapping,
  reconcileAppBranches,
  renameAppBranchForCore,
  type AppBranchMapResult,
  type AppBranchMappingView,
  type AppBranchReconcileReport,
} from '@oto/db';
import { audit } from './audit';
import type { BranchReach } from './access-control';
import type { Exec } from './tx';

/**
 * SCRUM-268 — the platform's branches and the OTO App's, kept in step.
 *
 * The two systems carry two branch lists with the same real names, their own
 * ids, and — until this — nothing joining them: `otoapp.branches.core_branch_id`
 * was put there to do it and was written by nothing in the repository. So
 * renaming a park on the platform did not rename it in the app, a branch opened
 * here never appeared there, and every person provisioned from the launcher
 * landed in no app branch at all.
 *
 * **The decisions, taken and not reopened** (the mechanism and the longer form
 * of each are in `packages/db/src/schema/otoapp.ts`):
 *
 *  1. The PLATFORM's branch is the record. The app row's name follows it on
 *     create and on rename; `core_sync_status` / `core_synced_at` /
 *     `core_sync_error` say when that last happened and why it did not.
 *  2. Head Office is an app-only row — it trades nowhere, it has no platform
 *     branch, and the mapping leaves it alone: never archived, never errored,
 *     `APP_ONLY` and nothing else.
 *  3. Provisioning seats a person in the mapped app branch of the platform
 *     branch they work at (`oto-app-users.ts`).
 *  4. Rows that already exist on both sides are reconciled once, by trimmed
 *     case-folded name, and by id ever after.
 *
 * **Why this file exists on top of the engine.** The engine is in `@oto/db`
 * because `packages/db/src/seed` has to run the same reconciliation and cannot
 * import from the api. What belongs here is what the api owns: the audit row
 * for every write, the reach filter on the read, and the error envelope.
 *
 * **Why a failure to map never fails the branch.** Opening a park, or renaming
 * one, must not depend on another application being installed, anchored or
 * unambiguous. Every refusal below travels back as a reason on the answer and
 * on the audit row — visible on the Console's Branches page — rather than as a
 * 500 in front of somebody who was opening a park.
 */

export interface AppBranchAuditContext {
  actorAccountId: string | null;
  operatorId: string;
  requestId?: string | null;
}

/**
 * Give a newly created branch its row in the OTO App.
 *
 * Called inside the branch's own transaction: the branch, its audit row and the
 * app row commit together, so there is no window in which the park exists here
 * and not there.
 */
export async function syncNewBranchToApp(
  tx: Exec,
  ctx: AppBranchAuditContext,
  input: { branchId: string; name: string; address: string | null; timezone: string },
): Promise<AppBranchMapResult> {
  const result = await mapCoreBranchIntoApp(tx, { operatorId: ctx.operatorId, ...input });
  if (result.appBranchId) {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId,
      operatorId: ctx.operatorId,
      branchId: input.branchId,
      action: 'branch.oto_app_map',
      entityType: 'otoapp_branch',
      entityId: result.appBranchId,
      after: {
        coreBranchId: input.branchId,
        appBranchName: result.appBranchName,
        mappedBy: result.mappedBy,
      },
      requestId: ctx.requestId,
    });
  }
  return result;
}

/**
 * Follow a rename into the app, by id.
 *
 * Only when the name actually changed: a PATCH that sets the timezone must not
 * stamp `core_synced_at` on a row nothing happened to, or the column stops
 * answering "when did these two last agree".
 */
export async function syncBranchRenameToApp(
  tx: Exec,
  ctx: AppBranchAuditContext,
  input: { branchId: string; name: string },
): Promise<{ appBranchId: string; appBranchName: string } | null> {
  const renamed = await renameAppBranchForCore(tx, input);
  if (renamed) {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId,
      operatorId: ctx.operatorId,
      branchId: input.branchId,
      action: 'branch.oto_app_rename',
      entityType: 'otoapp_branch',
      entityId: renamed.appBranchId,
      after: { coreBranchId: input.branchId, appBranchName: renamed.appBranchName },
      requestId: ctx.requestId,
    });
  }
  return renamed;
}

/**
 * The one-off sweep over everything that exists already.
 *
 * One audit row per mapping or creation — those are writes into another
 * system's table and each deserves its own line — plus one summary row for the
 * run itself, which is what says a run happened at all on the day it changed
 * nothing.
 */
export async function reconcileBranchesWithApp(
  tx: Exec,
  ctx: AppBranchAuditContext,
): Promise<AppBranchReconcileReport> {
  const report = await reconcileAppBranches(tx, { operatorId: ctx.operatorId });
  for (const row of report.matchedByName) {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId,
      operatorId: ctx.operatorId,
      branchId: row.branchId,
      action: 'branch.oto_app_map',
      entityType: 'otoapp_branch',
      entityId: row.appBranchId,
      after: { coreBranchId: row.branchId, appBranchName: row.appBranchName, mappedBy: 'name' },
      requestId: ctx.requestId,
    });
  }
  for (const row of report.created) {
    await audit.record(tx, {
      actorAccountId: ctx.actorAccountId,
      operatorId: ctx.operatorId,
      branchId: row.branchId,
      action: 'branch.oto_app_map',
      entityType: 'otoapp_branch',
      entityId: row.appBranchId,
      after: { coreBranchId: row.branchId, appBranchName: row.branchName, mappedBy: 'created' },
      requestId: ctx.requestId,
    });
  }
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId,
    operatorId: ctx.operatorId,
    action: 'branch.oto_app_reconcile',
    entityType: 'operator',
    entityId: ctx.operatorId,
    after: report,
    requestId: ctx.requestId,
  });
  return report;
}

/**
 * The mapping as a page shows it, cut to the branches this caller holds.
 *
 * The reach matters here and is easy to miss: `admin:branch:read` is held
 * branch-scoped by every manager, and a no-target guard passes them on their
 * own session branch (`plugins/session.ts`). Handing back the whole operator's
 * mapping would put the other park's name — and its app row's name — on a
 * screen that `GET /branches` is careful to keep it off.
 *
 * The app-only rows are operator-wide by nature: Head Office belongs to no
 * branch, so there is no branch to hold it against, and only a caller who
 * reaches every branch is shown them.
 */
export async function branchAppMappingForReach(
  db: Exec,
  operatorId: string,
  reach: BranchReach,
): Promise<AppBranchMappingView> {
  const view = await readAppBranchMapping(db, operatorId);
  if (reach.kind === 'operator') return view;
  const held = new Set(reach.branchIds);
  return {
    installed: view.installed,
    branches: view.branches.filter((b) => held.has(b.branchId)),
    appOnly: [],
  };
}
