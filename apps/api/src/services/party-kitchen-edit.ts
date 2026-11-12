import { eq } from 'drizzle-orm';
import { account, employee, type Db } from '@oto/db';
import {
  PARTY_KITCHEN_EDIT_PERMISSION,
  type PartyDetailWithSlipsAnswer,
  type PartyKitchenChange,
  type PartyKitchenChoicesAnswer,
  type PartyKitchenEditAnswer,
  type PartyKitchenEditBody,
  type PartyKitchenPlan,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { DIRECTORY_NOT_CONFIGURED, type DirectoryOutcome } from './otoapp-directory';
import { branchClockOf, getParty, partyOf, stationAt, type PartyDeps } from './parties';
import { markTillMenu, readPartyPlan } from './party-plan';
import { partySlipsView } from './party-slips';
import { grantCovers, resolveEffectivePermissions } from './permissions';
import type { ActorContext } from './sale';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * SCRUM-907 — A MANAGER CHANGES A PARTY'S KITCHEN PLAN ON THE TILL, AND THE
 * BEO IS CHANGED (the owner's decision 7 of 12 November).
 *
 * The OTO App owns the kitchen plan, so nothing of it is kept here: the
 * changes go to the app's directory (`POST /api/directory/events/:id/
 * kitchen-plan`, the tenant-bound key this platform already writes a party's
 * edits with), which writes them through the BEO's own Save and records "changed
 * on the till by …" in the BEO's activity; then the party is read again from
 * the app's view, so the answer is what the BEO now holds, and the slips follow
 * by the change detection of SCRUM-861 as for any BEO change.
 *
 *   - the app said yes: one audit row here (the lines before and after, the
 *     changes, who and where), and the party as the BEO now holds it;
 *   - the app said no: its words, as a 4xx, and nothing written here;
 *   - nothing answered: a 502 saying the plan may or may not have changed and
 *     that Save again is safe — the edit's id makes a second send one write
 *     there — and nothing written here, so the replay store keeps nothing.
 */

/** The party page's whole read: the party, its plan, its kitchen plan and its slips (`GET /parties/:id`). */
export async function partyDetailWithPlan(
  db: Exec,
  q: { operatorId: string; branchId: string; partyId: string; date?: string; now: Date },
): Promise<PartyDetailWithSlipsAnswer> {
  const answer = await getParty(db, q);
  const read = await readPartyPlan(db, { branchId: q.branchId, eventId: answer.event.id });
  // SCRUM-906: the whole kitchen plan, each line marked with whether the till sells it.
  const kitchenPlan = read.kitchen ? await markTillMenu(db, q.operatorId, read.kitchen) : null;
  const plan =
    read.plan && kitchenPlan ? { ...read.plan, setMenu: kitchenPlan.setMenu, barItems: kitchenPlan.barItems } : read.plan;
  const slips = kitchenPlan
    ? await partySlipsView(db, { operatorId: q.operatorId, branchId: q.branchId, eventId: answer.event.id, plan: kitchenPlan })
    : null;
  return { ...answer, plan, planStatus: read.status, kitchenPlan, slips };
}

/** How a role is named in the BEO's activity: the most senior one that carries the permission at the park. */
const ROLE_WORDS: Record<string, string> = {
  platform_admin: 'Platform admin',
  operator_admin: 'Admin',
  branch_manager: 'Manager',
};
const SENIORITY = ['platform_admin', 'operator_admin', 'branch_manager'];

/** Who changed it, as the BEO's activity names them: the person's name and the role that lets them. */
export async function kitchenEditorOf(
  db: Db,
  q: { accountId: string; operatorId: string; branchId: string },
): Promise<{ name: string; role: string }> {
  const [row] = await db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.id, q.accountId))
    .limit(1);
  const name = row?.nickname?.trim() || row?.name?.trim() || 'A till user';
  const roles = (await resolveEffectivePermissions(db, q.accountId))
    .filter((g) => g.permission === PARTY_KITCHEN_EDIT_PERMISSION && grantCovers(g, { operatorId: q.operatorId, branchId: q.branchId }))
    .map((g) => g.roleName);
  const senior = SENIORITY.find((r) => roles.includes(r)) ?? roles[0] ?? null;
  return { name, role: senior ? (ROLE_WORDS[senior] ?? senior) : 'Manager' };
}

/** The lines a change touches, as the plan read before or after holds them: what the audit row keeps. */
function touchedLines(kitchen: PartyKitchenPlan | null, changes: readonly PartyKitchenChange[]) {
  const ids = new Set(
    changes.flatMap((c) => (c.op === 'set' || c.op === 'remove' ? [c.lineId] : c.op === 'add' ? [`till_${c.id}`] : c.op === 'choose' && c.lineId ? [c.lineId] : [])),
  );
  const groups = new Set(changes.flatMap((c) => (c.op === 'choose' ? [c.choiceGroup] : [])));
  const pick = <L extends { lineId?: string | undefined; name: string; qty: number | null; note?: string | null | undefined }>(l: L) => ({
    lineId: l.lineId ?? null,
    name: l.name,
    qty: l.qty,
    note: l.note ?? null,
  });
  return {
    food: (kitchen?.setMenu ?? [])
      .filter((l) => (l.lineId && ids.has(l.lineId)) || (l.choiceGroup && groups.has(l.choiceGroup)))
      .map((l) => ({ ...pick(l), chosenOption: l.chosenOption })),
    bar: (kitchen?.barItems ?? []).filter((l) => l.lineId && ids.has(l.lineId)).map(pick),
    ...(changes.some((c) => c.op === 'cake') ? { cake: kitchen?.cake ?? null } : {}),
  };
}

/** The app's refusal, or its silence, in the till's words. Never a 2xx. */
function refusalOf(outcome: Extract<DirectoryOutcome<unknown>, { ok: false }>): AppError {
  if (outcome.code === DIRECTORY_NOT_CONFIGURED) {
    return new AppError(
      503,
      'OTOAPP_DIRECTORY_NOT_CONFIGURED',
      'This till cannot write to the OTO App yet, so the kitchen plan was not changed. Change it in the BEO.',
    );
  }
  if (outcome.status === null || outcome.status >= 500 || outcome.retryable) {
    return new AppError(
      502,
      'OTOAPP_NOT_ANSWERED',
      'The OTO App did not answer, so the kitchen plan may not have changed yet. Press Save again: it is never written twice.',
      { code: outcome.code },
    );
  }
  if (outcome.status === 404) {
    return new AppError(404, 'PARTY_NOT_IN_OTO_APP', 'The OTO App does not know this party any more, so nothing was changed.');
  }
  // The app's own words: what it would not change and why.
  return new AppError(409, outcome.code, `The OTO App did not change the kitchen plan: ${outcome.message}`);
}

/** `PUT /parties/:id/kitchen-plan` — the changes written to the BEO, then the party as the BEO now holds it. */
export async function editPartyKitchenPlan(
  deps: PartyDeps,
  ctx: OpContext,
  actor: ActorContext,
  partyId: string,
  body: PartyKitchenEditBody,
  now: Date = new Date(),
): Promise<PartyKitchenEditAnswer> {
  const db = deps.db;
  const clock = await branchClockOf(db, actor.operatorId, body.branchId);
  await actor.assertBranchAllowed?.(clock.id);
  const event = await partyOf(db, clock.id, partyId);
  if (event.archived) throw errors.conflict('EVENT_ARCHIVED', 'This party has been archived in the OTO App');
  const at = await stationAt(db, actor.operatorId, clock.id, body.stationId);
  const before = await readPartyPlan(db, { branchId: clock.id, eventId: event.id });
  const by = await kitchenEditorOf(db, { accountId: actor.accountId, operatorId: actor.operatorId, branchId: clock.id });

  const outcome = deps.directory.editKitchenPlan
    ? await deps.directory.editKitchenPlan(event.id, { id: body.editId, editedAt: now.toISOString(), by, changes: body.changes })
    : ({
        ok: false,
        status: null,
        code: DIRECTORY_NOT_CONFIGURED,
        message: 'This deployment cannot write the kitchen plan to the OTO App',
        retryable: true,
      } as const);
  if (!outcome.ok) {
    deps.log?.warn({ eventId: event.id, editId: body.editId, status: outcome.status, code: outcome.code }, 'the OTO App did not take a kitchen plan edit');
    throw refusalOf(outcome);
  }

  // Read again from the OTO App: the answer is what the BEO now holds.
  const detail = await partyDetailWithPlan(db, { operatorId: actor.operatorId, branchId: clock.id, partyId: event.id, now });
  await withTx(db, ctx, 'party.kitchen_update', async (tx) => {
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId: clock.id,
      action: 'party.kitchen_update',
      entityType: 'party',
      entityId: event.id,
      actionId: body.actionId ?? null,
      requestId: actor.requestId,
      before: touchedLines(before.kitchen, body.changes),
      after: {
        ...touchedLines(detail.kitchenPlan ?? null, body.changes),
        editId: body.editId,
        changes: body.changes,
        replayed: outcome.body.replayed,
        by,
        stationId: at?.id ?? null,
      },
    });
    return undefined;
  });
  return { ...detail, kitchenEdit: { id: body.editId, replayed: outcome.body.replayed } };
}

/** `GET /parties/:id/kitchen-plan/choices` — the set menu's choice groups, from the BEO's template. */
export async function partyKitchenChoices(
  deps: PartyDeps,
  actor: ActorContext,
  partyId: string,
  branchId: string,
): Promise<PartyKitchenChoicesAnswer> {
  const clock = await branchClockOf(deps.db, actor.operatorId, branchId);
  await actor.assertBranchAllowed?.(clock.id);
  const event = await partyOf(deps.db, clock.id, partyId);
  if (!deps.directory.kitchenPlanChoices) {
    return { status: 'unavailable', message: 'This till cannot read the set menu from the OTO App yet.', groups: [] };
  }
  const outcome = await deps.directory.kitchenPlanChoices(event.id);
  if (!outcome.ok) {
    return {
      status: 'unavailable',
      message:
        outcome.code === DIRECTORY_NOT_CONFIGURED
          ? 'This till cannot read the set menu from the OTO App yet.'
          : outcome.status === 404
            ? 'The OTO App does not know this party any more.'
            : 'The OTO App did not answer, so the set menu choices cannot be changed here now.',
      groups: [],
    };
  }
  return { status: 'ok', message: null, groups: outcome.body.setMenu?.groups ?? [] };
}
