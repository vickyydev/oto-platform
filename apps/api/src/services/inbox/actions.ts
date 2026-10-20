import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  account,
  assignment,
  branch,
  conversation,
  inboxEvent,
  roleAssignment,
  rolePermission,
  routingRule,
  team,
  type InboxCategory,
  type InboxTeamKey,
} from '@oto/db';
import { newId, type InboxActionResult, type Permission } from '@oto/shared';
import { audit } from '../audit';
import { hasPermission, type EffectivePermission } from '../permissions';
import { PermissionDeniedError } from '../../plugins/session';
import { errors } from '../../lib/errors';
import { pgErrorOf } from '../../lib/scrub';
import type { Exec, Tx } from '../tx';
import { INBOX_READ, loadVisibleConversation, type InboxViewer } from './read-visibility';
import { pickRule, routeConversation } from './router';
import { handledPatch, reopenAuditBefore, reopenPatch, reopenedPayload } from './status';

/**
 * THE INBOX'S OWNERSHIP AND STATUS ACTIONS (S2-19 I2e, SCRUM-584; plan
 * docs/progress/plans/inbox-build/PLAN.md §3.3 [B], `docs/features/inbox.md`
 * "Ownership and assignment" and "Status"; prototype
 * `imports/oto-asset-manager/artifacts/oto-org-chart/src/WhatsAppDemo.tsx`
 * `setConvAssignee` :1135-1177, `setConvTeam` :1179-1223, `markHandled`,
 * `reopenConv` :1228-1255; IT Brief `Brief.tsx` §8-§9).
 *
 *   - PRIMARY: replace who owns it. CATEGORY FOLLOWS THE PRIMARY: when the new
 *     primary's team is not the conversation's, the conversation moves to that
 *     team (and its category, and — for a reception desk — its branch). The
 *     server refuses with 409 `CATEGORY_MOVE_UNCONFIRMED` until the request
 *     carries `confirmMove: true`: the prototype's "Changing primary owner will
 *     move this conversation to the new department. Continue?", enforced here.
 *     A person in no team (the GM, the coordinator) keeps the category
 *     (:1153). The support places stay ("The current support assignees will
 *     stay", :1712).
 *   - SUPPORT: add to the next free place (two at most), remove by releasing.
 *     Support never changes ownership.
 *   - DIVERT: the routing rule's fixed pair swaps — the backup becomes primary
 *     and the old primary takes the backup's support place (Brief §9). A
 *     second Divert swaps back. A rule with no backup (reception) refuses.
 *   - MOVE: to one of the four destinations; clears every slot, re-routes to
 *     the new team's default primary and — per the IT Brief, which puts the
 *     backup on every chat in the category (`Brief.tsx:400`) — adds the
 *     backup too (the plan's owner-note: the prototype picked a primary only).
 *     A reception destination sets the branch. A `moved_team` event is logged
 *     ("Moved from … → … by …", Brief §8).
 *   - BRANCH: the branch select. Setting a branch confirms it; on a birthday
 *     conversation, the birthday manager who hosts at that branch is then
 *     added as support if a place is free (feature doc "Once a birthday's
 *     branch is confirmed…"; plan §3.1 step 5).
 *   - HANDLED and REOPEN: the reopen writes exactly what the customer's
 *     automatic reopen writes (`status.ts`): `handled_at` and `handled_by_*`
 *     cleared, `reopened_at` set, the assignments kept, the previous values on
 *     the `reopened` event and the audit row.
 *
 * Every action: the conversation loaded inside the caller's operator and
 * checked for visibility (404 when the caller cannot see it), then locked
 * (`FOR UPDATE`) so two managers cannot both take the last support place;
 * the permission checked AT THE CONVERSATION (its branch, its team's
 * department, operator-wide, or the record); one transaction; one audit row
 * of ids; and a slot is never deleted — it is released (`released_at`).
 */

/**
 * A `birthdays` routing rule naming a BRANCH at this priority names the
 * birthday manager who HOSTS at that branch (its primary). It sits below the
 * catch-all (0), so the router — which takes the highest priority that
 * matches, and always has a catch-all — never routes a new conversation by
 * it; only the branch confirmation reads it.
 */
export const HOSTING_RULE_PRIORITY = -10;

const TEAM_OF_CATEGORY: Record<InboxCategory, InboxTeamKey> = {
  birthdays: 'birthdays',
  general: 'reception',
  marketing: 'marketing',
};
const CATEGORY_OF_TEAM: Record<InboxTeamKey, InboxCategory> = {
  birthdays: 'birthdays',
  reception: 'general',
  marketing: 'marketing',
};

export const INBOX_ACTION_MESSAGES = {
  moveUnconfirmed: 'Changing primary owner will move this conversation to the new department. Continue?',
  alreadyOn: 'This person already holds a place on this conversation. Remove them from it first.',
  teamAlreadyOn: 'This team already holds a place on this conversation.',
  supportFull: 'Both support places are taken. Remove someone first.',
  divertNoBackup: 'This conversation has no backup to divert to.',
  alreadyInTeam: 'The conversation is already with that team.',
  alreadyHandled: 'This conversation is already handled.',
  notHandled: 'This conversation is not handled.',
  notInboxPerson: 'Not a person who can hold a place in the Inbox.',
  teamNotFound: 'Team not found',
  noReceptionTeam: 'No reception team at that branch.',
  branchNotFound: 'Branch not found',
  supportNotFound: 'Support assignment not found',
} as const;

export interface ActionCtx {
  viewer: InboxViewer;
  effective: EffectivePermission[];
  requestId: string | null;
  now: Date;
}

type ConversationRow = typeof conversation.$inferSelect;
type SlotRow = typeof assignment.$inferSelect;
type TeamRow = typeof team.$inferSelect;

interface Loaded {
  conv: ConversationRow;
  team: TeamRow | null;
  slots: SlotRow[];
}

// --- Loading, permission and the slot primitives ------------------------------------------

async function teamById(tx: Tx, operatorId: string, teamId: string | null): Promise<TeamRow | null> {
  if (!teamId) return null;
  const [t] = await tx
    .select()
    .from(team)
    .where(and(eq(team.operatorId, operatorId), eq(team.id, teamId)))
    .limit(1);
  return t ?? null;
}

async function activeSlots(tx: Tx, operatorId: string, conversationId: string): Promise<SlotRow[]> {
  return tx
    .select()
    .from(assignment)
    .where(
      and(
        eq(assignment.operatorId, operatorId),
        eq(assignment.conversationId, conversationId),
        isNull(assignment.releasedAt),
      ),
    )
    .orderBy(asc(assignment.slotIndex));
}

/** Inside the operator, visible to the caller (else 404), then locked. */
async function loadForAction(tx: Tx, ctx: ActionCtx, conversationId: string): Promise<Loaded> {
  const { operatorId } = ctx.viewer;
  const [locked] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, conversationId)))
    .limit(1)
    .for('update');
  if (!locked) throw errors.notFound('Conversation not found');
  const conv = await loadVisibleConversation(tx, ctx.viewer, conversationId);
  return {
    conv,
    team: await teamById(tx, operatorId, conv.teamId),
    slots: await activeSlots(tx, operatorId, conv.id),
  };
}

/** The permission held at THIS conversation: operator-wide, its branch, its team's department, or the record. */
function holdsAt(ctx: ActionCtx, permission: Permission, l: Loaded): boolean {
  return hasPermission(ctx.effective, permission, {
    operatorId: ctx.viewer.operatorId,
    branchId: l.conv.branchId ?? undefined,
    departmentId: l.team?.departmentId ?? undefined,
    recordId: l.conv.id,
  });
}

function requireAt(ctx: ActionCtx, permission: Permission, l: Loaded): void {
  if (!holdsAt(ctx, permission, l)) throw new PermissionDeniedError(permission);
}

const primaryOf = (slots: SlotRow[]) => slots.find((a) => a.slot === 'primary') ?? null;
const isPrimary = (slots: SlotRow[], accountId: string) => primaryOf(slots)?.accountId === accountId;

function actionEvent(
  ctx: ActionCtx,
  conversationId: string,
  kind: typeof inboxEvent.$inferInsert.kind,
  payload: Record<string, unknown>,
  actor: 'account' | 'system' = 'account',
) {
  return {
    id: newId(),
    operatorId: ctx.viewer.operatorId,
    conversationId,
    kind,
    actorKind: actor,
    actorAccountId: actor === 'account' ? ctx.viewer.accountId : null,
    payload,
    createdAt: ctx.now,
  };
}

const slotIds = (a: SlotRow | NewSlot) => ({
  assignmentId: a.id,
  slot: a.slot,
  slotIndex: a.slotIndex,
  assigneeKind: a.assigneeKind,
  accountId: a.accountId ?? null,
  teamId: a.teamId ?? null,
});

/** Release slots (never delete) and write their `released` pills. */
async function releaseSlots(tx: Tx, ctx: ActionCtx, conversationId: string, rows: SlotRow[], why: string): Promise<void> {
  if (rows.length === 0) return;
  await tx
    .update(assignment)
    .set({ releasedAt: ctx.now, updatedAt: ctx.now })
    .where(
      and(
        eq(assignment.operatorId, ctx.viewer.operatorId),
        inArray(
          assignment.id,
          rows.map((r) => r.id),
        ),
        isNull(assignment.releasedAt),
      ),
    );
  await tx.insert(inboxEvent).values(rows.map((r) => actionEvent(ctx, conversationId, 'released', { ...slotIds(r), reason: why })));
}

interface NewSlot {
  id: string;
  slot: 'primary' | 'support';
  slotIndex: number;
  assigneeKind: 'account' | 'team';
  accountId: string | null;
  teamId: string | null;
  reason: 'manual' | 'divert' | 'auto';
}

/** Insert slots and their `assigned` pills. A unique violation is a clean 409, never a 500. */
async function seatSlots(
  tx: Tx,
  ctx: ActionCtx,
  conversationId: string,
  slots: NewSlot[],
  by: 'account' | 'system' = 'account',
): Promise<void> {
  if (slots.length === 0) return;
  try {
    await tx.insert(assignment).values(
      slots.map((a) => ({
        id: a.id,
        operatorId: ctx.viewer.operatorId,
        conversationId,
        slot: a.slot,
        slotIndex: a.slotIndex,
        assigneeKind: a.assigneeKind,
        accountId: a.accountId,
        teamId: a.teamId,
        assignedByKind: by,
        assignedByAccountId: by === 'account' ? ctx.viewer.accountId : null,
        reason: a.reason,
        assignedAt: ctx.now,
      })),
    );
  } catch (err) {
    const pg = pgErrorOf(err);
    if (pg?.code === '23505') {
      if (pg.constraint === 'assignment_active_account_unique') {
        throw errors.conflict('ALREADY_ON_CONVERSATION', INBOX_ACTION_MESSAGES.alreadyOn);
      }
      if (pg.constraint === 'assignment_active_team_unique') {
        throw errors.conflict('ALREADY_ON_CONVERSATION', INBOX_ACTION_MESSAGES.teamAlreadyOn);
      }
      if (pg.constraint === 'assignment_active_slot_unique') {
        throw errors.conflict('SUPPORT_FULL', INBOX_ACTION_MESSAGES.supportFull);
      }
    }
    throw err;
  }
  await tx
    .insert(inboxEvent)
    .values(slots.map((a) => actionEvent(ctx, conversationId, 'assigned', { ...slotIds(a), reason: a.reason }, by)));
}

/** The one-seat rule (:1142), said before the insert so the answer names it. */
function refuseIfSeated(slots: SlotRow[], who: { kind: 'account' | 'team'; id: string }): void {
  const seated = slots.some((a) => (who.kind === 'account' ? a.accountId === who.id : a.teamId === who.id));
  if (seated) {
    throw errors.conflict(
      'ALREADY_ON_CONVERSATION',
      who.kind === 'account' ? INBOX_ACTION_MESSAGES.alreadyOn : INBOX_ACTION_MESSAGES.teamAlreadyOn,
    );
  }
}

function freeSupportIndex(slots: SlotRow[]): 1 | 2 | null {
  const taken = new Set(slots.filter((a) => a.slot === 'support').map((a) => a.slotIndex));
  if (!taken.has(1)) return 1;
  if (!taken.has(2)) return 2;
  return null;
}

/**
 * Who can hold a place: an active account of the operator that reads the
 * Inbox somewhere (as `GET /inbox/me` lists them), with the teams it is in
 * (its department-scoped grants on a team's department), in team order.
 */
async function inboxPerson(tx: Tx, operatorId: string, accountId: string): Promise<{ teams: TeamRow[] } | null> {
  const grants = await tx
    .select({ scopeType: roleAssignment.scopeType, scopeId: roleAssignment.scopeId })
    .from(roleAssignment)
    .innerJoin(rolePermission, eq(rolePermission.roleId, roleAssignment.roleId))
    .innerJoin(account, eq(account.id, roleAssignment.accountId))
    .where(
      and(
        eq(roleAssignment.accountId, accountId),
        eq(rolePermission.permission, INBOX_READ),
        eq(account.operatorId, operatorId),
        eq(account.status, 'active'),
      ),
    );
  const inOperator = grants.filter((g) => g.scopeType !== 'operator' || g.scopeId === null || g.scopeId === operatorId);
  if (inOperator.length === 0) return null;
  const departments = new Set(inOperator.filter((g) => g.scopeType === 'department').map((g) => g.scopeId!));
  const teams =
    departments.size === 0
      ? []
      : await tx
          .select()
          .from(team)
          .where(and(eq(team.operatorId, operatorId), inArray(team.departmentId, [...departments])))
          .orderBy(asc(team.sortOrder), asc(team.name));
  return { teams };
}

async function actionResult(tx: Tx, ctx: ActionCtx, conversationId: string, moved: boolean): Promise<InboxActionResult> {
  const [c] = await tx
    .select()
    .from(conversation)
    .where(and(eq(conversation.operatorId, ctx.viewer.operatorId), eq(conversation.id, conversationId)))
    .limit(1);
  const slots = await activeSlots(tx, ctx.viewer.operatorId, conversationId);
  return {
    conversation: {
      id: c!.id,
      status: c!.status,
      category: c!.category,
      teamId: c!.teamId,
      branchId: c!.branchId,
      handledAt: c!.handledAt?.toISOString() ?? null,
      handledByKind: c!.handledByKind,
      handledByAccountId: c!.handledByAccountId,
      reopenedAt: c!.reopenedAt?.toISOString() ?? null,
    },
    assignments: slots.map((a) => ({ ...slotIds(a), reason: a.reason, assignedAt: a.assignedAt.toISOString() })),
    moved,
  };
}

function auditAction(
  tx: Tx,
  ctx: ActionCtx,
  conv: ConversationRow,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
) {
  return audit.record(tx, {
    actorAccountId: ctx.viewer.accountId,
    action,
    entityType: 'inbox.conversation',
    entityId: conv.id,
    operatorId: ctx.viewer.operatorId,
    branchId: conv.branchId,
    requestId: ctx.requestId,
    before,
    after,
  });
}

const slotSummary = (slots: SlotRow[]) =>
  slots.map((a) => ({ id: a.id, slotIndex: a.slotIndex, accountId: a.accountId, teamId: a.teamId }));

// --- PRIMARY: assign or replace, category follows ----------------------------------------------

export interface SetPrimaryInput {
  conversationId: string;
  assignee: { kind: 'account' | 'team'; id: string };
  confirmMove?: boolean;
}

export async function setPrimary(tx: Tx, ctx: ActionCtx, input: SetPrimaryInput): Promise<InboxActionResult> {
  const l = await loadForAction(tx, ctx, input.conversationId);
  // A manager, or the primary handing it on.
  if (!holdsAt(ctx, 'inbox:conversation:assign', l) && !isPrimary(l.slots, ctx.viewer.accountId)) {
    throw new PermissionDeniedError('inbox:conversation:assign');
  }
  const { operatorId } = ctx.viewer;

  // Where the new primary sits: their team, if it is not the conversation's.
  let dest: TeamRow | null = null;
  if (input.assignee.kind === 'account') {
    const person = await inboxPerson(tx, operatorId, input.assignee.id);
    if (!person) throw errors.badRequest(INBOX_ACTION_MESSAGES.notInboxPerson);
    if (person.teams.length > 0 && !person.teams.some((t) => t.id === l.conv.teamId)) {
      // In several teams: the one of the conversation's category first, then team order.
      const kind = TEAM_OF_CATEGORY[l.conv.category];
      dest = person.teams.find((t) => t.key === kind) ?? person.teams[0]!;
    }
    // In no team (the GM, the coordinator): the category stays (:1153).
  } else {
    const t = await teamById(tx, operatorId, input.assignee.id);
    if (!t) throw errors.notFound(INBOX_ACTION_MESSAGES.teamNotFound);
    if (t.id !== l.conv.teamId) dest = t;
  }

  refuseIfSeated(l.slots, input.assignee);

  if (dest && input.confirmMove !== true) {
    throw errors.conflict('CATEGORY_MOVE_UNCONFIRMED', INBOX_ACTION_MESSAGES.moveUnconfirmed, {
      fromCategory: l.conv.category,
      toCategory: CATEGORY_OF_TEAM[dest.key],
      fromTeamId: l.conv.teamId,
      toTeamId: dest.id,
      toTeamName: dest.name,
      toBranchId: dest.key === 'reception' ? dest.branchId : l.conv.branchId,
    });
  }

  const old = primaryOf(l.slots);
  if (old) await releaseSlots(tx, ctx, l.conv.id, [old], 'replaced');
  const made: NewSlot = {
    id: newId(),
    slot: 'primary',
    slotIndex: 0,
    assigneeKind: input.assignee.kind,
    accountId: input.assignee.kind === 'account' ? input.assignee.id : null,
    teamId: input.assignee.kind === 'team' ? input.assignee.id : null,
    reason: 'manual',
  };
  await seatSlots(tx, ctx, l.conv.id, [made]);

  let after: Pick<ConversationRow, 'category' | 'teamId' | 'branchId'> = l.conv;
  if (dest) {
    after = {
      category: CATEGORY_OF_TEAM[dest.key],
      teamId: dest.id,
      branchId: dest.key === 'reception' ? dest.branchId : l.conv.branchId,
    };
    await tx
      .update(conversation)
      .set({ ...after, updatedAt: ctx.now })
      .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, l.conv.id)));
    // The "Auto-moved … (follows primary owner)" pill.
    await tx.insert(inboxEvent).values(
      actionEvent(ctx, l.conv.id, 'moved_team', {
        followsPrimary: true,
        fromTeamId: l.conv.teamId,
        toTeamId: dest.id,
        fromTeamName: l.team?.name ?? null,
        toTeamName: dest.name,
        fromCategory: l.conv.category,
        toCategory: after.category,
        fromBranchId: l.conv.branchId,
        toBranchId: after.branchId,
      }),
    );
  }

  await auditAction(
    tx,
    ctx,
    l.conv,
    'inbox.conversation.primary',
    {
      primary: old ? slotSummary([old])[0] : null,
      category: l.conv.category,
      teamId: l.conv.teamId,
      branchId: l.conv.branchId,
    },
    {
      primary: { id: made.id, slotIndex: 0, accountId: made.accountId, teamId: made.teamId },
      category: after.category,
      teamId: after.teamId,
      branchId: after.branchId,
      moved: Boolean(dest),
      confirmMove: input.confirmMove === true,
    },
  );
  return actionResult(tx, ctx, l.conv.id, Boolean(dest));
}

// --- SUPPORT: add and remove ------------------------------------------------------------------

export async function addSupport(
  tx: Tx,
  ctx: ActionCtx,
  input: { conversationId: string; accountId: string },
): Promise<InboxActionResult> {
  const l = await loadForAction(tx, ctx, input.conversationId);
  requireAt(ctx, 'inbox:conversation:assign', l);
  if (!(await inboxPerson(tx, ctx.viewer.operatorId, input.accountId))) {
    throw errors.badRequest(INBOX_ACTION_MESSAGES.notInboxPerson);
  }
  refuseIfSeated(l.slots, { kind: 'account', id: input.accountId });
  const index = freeSupportIndex(l.slots);
  if (index === null) throw errors.conflict('SUPPORT_FULL', INBOX_ACTION_MESSAGES.supportFull);
  const made: NewSlot = {
    id: newId(),
    slot: 'support',
    slotIndex: index,
    assigneeKind: 'account',
    accountId: input.accountId,
    teamId: null,
    reason: 'manual',
  };
  await seatSlots(tx, ctx, l.conv.id, [made]);
  await auditAction(tx, ctx, l.conv, 'inbox.conversation.support_add', null, {
    support: { id: made.id, slotIndex: index, accountId: input.accountId },
  });
  return actionResult(tx, ctx, l.conv.id, false);
}

export async function removeSupport(
  tx: Tx,
  ctx: ActionCtx,
  input: { conversationId: string; assignmentId: string },
): Promise<InboxActionResult> {
  const l = await loadForAction(tx, ctx, input.conversationId);
  requireAt(ctx, 'inbox:conversation:assign', l);
  const row = l.slots.find((a) => a.id === input.assignmentId && a.slot === 'support');
  if (!row) throw errors.notFound(INBOX_ACTION_MESSAGES.supportNotFound);
  await releaseSlots(tx, ctx, l.conv.id, [row], 'removed');
  await auditAction(tx, ctx, l.conv, 'inbox.conversation.support_remove', { support: slotSummary([row])[0] }, {
    released: row.id,
  });
  return actionResult(tx, ctx, l.conv.id, false);
}

// --- DIVERT: the fixed pair swaps -------------------------------------------------------------

/**
 * Who a Divert would make primary, or null when it would answer
 * `DIVERT_NO_BACKUP`: the routing rule's fixed pair at this conversation —
 * the backup when the primary is anyone else, the rule's primary when the
 * backup already holds it (a second Divert swaps back) — and only an active
 * account. ONE reading for the action below and for the conversation detail
 * (`divertTo`), so the shell shows Divert exactly when the press would work.
 */
export async function divertTarget(
  db: Exec,
  operatorId: string,
  conv: Pick<ConversationRow, 'category' | 'teamId' | 'language' | 'branchId'>,
  primaryAccountId: string | null,
): Promise<{ ruleId: string | null; target: string | null }> {
  const rules = await db
    .select()
    .from(routingRule)
    .where(
      and(
        eq(routingRule.operatorId, operatorId),
        eq(routingRule.category, conv.category),
        eq(routingRule.active, true),
        isNull(routingRule.archivedAt),
        ...(conv.teamId ? [eq(routingRule.teamId, conv.teamId)] : []),
      ),
    );
  const rule = pickRule(rules, {
    category: conv.category,
    language: conv.language ?? 'en',
    branchId: conv.branchId,
  });
  const ruleBackup = rule?.backupAccountId ?? null;
  const rulePrimary = rule?.primaryKind === 'account' ? rule.primaryAccountId : null;
  const counterpart = primaryAccountId && primaryAccountId === ruleBackup ? rulePrimary : ruleBackup;
  let target: string | null = null;
  if (counterpart && counterpart !== primaryAccountId) {
    const [live] = await db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.id, counterpart), eq(account.operatorId, operatorId), eq(account.status, 'active')))
      .limit(1);
    target = live?.id ?? null;
  }
  return { ruleId: rule?.id ?? null, target };
}

export async function divert(tx: Tx, ctx: ActionCtx, input: { conversationId: string }): Promise<InboxActionResult> {
  const l = await loadForAction(tx, ctx, input.conversationId);
  // The primary taps it; a manager can do it on their behalf (Brief §9).
  if (!isPrimary(l.slots, ctx.viewer.accountId) && !holdsAt(ctx, 'inbox:conversation:assign', l)) {
    throw new PermissionDeniedError('inbox:conversation:assign');
  }
  const primary = primaryOf(l.slots);
  const { ruleId, target } = await divertTarget(tx, ctx.viewer.operatorId, l.conv, primary?.accountId ?? null);
  if (!target) throw errors.conflict('DIVERT_NO_BACKUP', INBOX_ACTION_MESSAGES.divertNoBackup);

  const targetSupport = l.slots.find((a) => a.slot === 'support' && a.accountId === target) ?? null;
  const releasing = [primary, targetSupport].filter((r): r is SlotRow => r !== null);
  await releaseSlots(tx, ctx, l.conv.id, releasing, 'divert');
  const remaining = l.slots.filter((a) => !releasing.includes(a));
  const newPrimary: NewSlot = {
    id: newId(),
    slot: 'primary',
    slotIndex: 0,
    assigneeKind: 'account',
    accountId: target,
    teamId: null,
    reason: 'divert',
  };
  const seats: NewSlot[] = [newPrimary];
  // The old primary takes the backup's place (or the next free one). A team
  // primary is not a person and does not sit in a support place.
  let oldTo: number | null = null;
  if (primary?.assigneeKind === 'account' && primary.accountId) {
    oldTo = targetSupport?.slotIndex ?? freeSupportIndex(remaining);
    if (oldTo !== null) {
      seats.push({
        id: newId(),
        slot: 'support',
        slotIndex: oldTo,
        assigneeKind: 'account',
        accountId: primary.accountId,
        teamId: null,
        reason: 'divert',
      });
    }
  }
  await seatSlots(tx, ctx, l.conv.id, seats);
  await tx.insert(inboxEvent).values(
    actionEvent(ctx, l.conv.id, 'diverted', {
      ruleId,
      fromAccountId: primary?.accountId ?? null,
      fromTeamId: primary?.teamId ?? null,
      toAccountId: target,
      primaryAssignmentId: newPrimary.id,
      oldPrimarySupportIndex: oldTo,
    }),
  );
  await auditAction(
    tx,
    ctx,
    l.conv,
    'inbox.conversation.divert',
    { slots: slotSummary(l.slots) },
    { ruleId, primaryAccountId: target, oldPrimarySupportIndex: oldTo },
  );
  return actionResult(tx, ctx, l.conv.id, false);
}

// --- MOVE: another team, re-routed -------------------------------------------------------------

export type MoveDest = { kind: 'birthdays' } | { kind: 'marketing' } | { kind: 'reception'; branchId: string };

export async function moveTeam(
  tx: Tx,
  ctx: ActionCtx,
  input: { conversationId: string; dest: MoveDest },
): Promise<InboxActionResult> {
  const l = await loadForAction(tx, ctx, input.conversationId);
  requireAt(ctx, 'inbox:conversation:move', l);
  const { operatorId } = ctx.viewer;

  const [dest] = await tx
    .select()
    .from(team)
    .where(
      and(
        eq(team.operatorId, operatorId),
        eq(team.key, input.dest.kind),
        input.dest.kind === 'reception' ? eq(team.branchId, input.dest.branchId) : isNull(team.branchId),
      ),
    )
    .limit(1);
  if (!dest) {
    throw input.dest.kind === 'reception'
      ? errors.notFound(INBOX_ACTION_MESSAGES.noReceptionTeam)
      : errors.notFound(INBOX_ACTION_MESSAGES.teamNotFound);
  }
  if (dest.id === l.conv.teamId) throw errors.conflict('ALREADY_IN_TEAM', INBOX_ACTION_MESSAGES.alreadyInTeam);

  const category = CATEGORY_OF_TEAM[dest.key];
  const branchId = dest.key === 'reception' ? dest.branchId : l.conv.branchId;

  // Every slot goes: the support places are cleared, and the primary is
  // whoever the new team's rule names.
  await releaseSlots(tx, ctx, l.conv.id, l.slots, 'move');
  await tx
    .update(conversation)
    .set({ category, teamId: dest.id, branchId, updatedAt: ctx.now })
    .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, l.conv.id)));
  await tx.insert(inboxEvent).values(
    actionEvent(ctx, l.conv.id, 'moved_team', {
      followsPrimary: false,
      fromTeamId: l.conv.teamId,
      toTeamId: dest.id,
      fromTeamName: l.team?.name ?? null,
      toTeamName: dest.name,
      fromCategory: l.conv.category,
      toCategory: category,
      fromBranchId: l.conv.branchId,
      toBranchId: branchId,
    }),
  );
  const routed = await routeConversation(tx, {
    operatorId,
    conversationId: l.conv.id,
    category,
    language: l.conv.language ?? 'en',
    branchId,
    at: ctx.now,
    reroute: { teamId: dest.id, reason: 'move', actorAccountId: ctx.viewer.accountId },
  });

  await auditAction(
    tx,
    ctx,
    l.conv,
    'inbox.conversation.move',
    { teamId: l.conv.teamId, category: l.conv.category, branchId: l.conv.branchId, slots: slotSummary(l.slots) },
    {
      teamId: dest.id,
      category,
      branchId,
      ruleId: routed.ruleId,
      fallback: routed.fallback,
      slots: routed.assignments.map((a) => ({ id: a.id, slotIndex: a.slotIndex, accountId: a.accountId, teamId: a.teamId })),
    },
  );
  return actionResult(tx, ctx, l.conv.id, true);
}

// --- BRANCH: set and confirm; the birthday host joins ------------------------------------------

export async function setBranch(
  tx: Tx,
  ctx: ActionCtx,
  input: { conversationId: string; branchId: string | null },
): Promise<InboxActionResult & { hostAdded: boolean }> {
  const l = await loadForAction(tx, ctx, input.conversationId);
  requireAt(ctx, 'inbox:conversation:assign', l);
  const { operatorId } = ctx.viewer;
  if (input.branchId !== null) {
    const [b] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.id, input.branchId), eq(branch.operatorId, operatorId), isNull(branch.archivedAt)))
      .limit(1);
    if (!b) throw errors.notFound(INBOX_ACTION_MESSAGES.branchNotFound);
  }

  const changed = input.branchId !== l.conv.branchId;
  if (changed) {
    await tx
      .update(conversation)
      .set({ branchId: input.branchId, updatedAt: ctx.now })
      .where(and(eq(conversation.operatorId, operatorId), eq(conversation.id, l.conv.id)));
    await tx
      .insert(inboxEvent)
      .values(actionEvent(ctx, l.conv.id, 'branch_set', { fromBranchId: l.conv.branchId, toBranchId: input.branchId }));
  }

  // The birthday step: the manager who hosts at the confirmed branch joins as
  // support, when a place is free and they are not on it already.
  let host: NewSlot | null = null;
  let hostSkipped: string | null = null;
  if (l.conv.category === 'birthdays' && input.branchId !== null) {
    const [rule] = await tx
      .select()
      .from(routingRule)
      .where(
        and(
          eq(routingRule.operatorId, operatorId),
          eq(routingRule.category, 'birthdays'),
          eq(routingRule.branchId, input.branchId),
          eq(routingRule.priority, HOSTING_RULE_PRIORITY),
          eq(routingRule.primaryKind, 'account'),
          eq(routingRule.active, true),
          isNull(routingRule.archivedAt),
        ),
      )
      .orderBy(asc(routingRule.createdAt))
      .limit(1);
    const hostId = rule?.primaryAccountId ?? null;
    const live = hostId
      ? (
          await tx
            .select({ id: account.id })
            .from(account)
            .where(and(eq(account.id, hostId), eq(account.operatorId, operatorId), eq(account.status, 'active')))
            .limit(1)
        )[0]
      : undefined;
    if (!live) hostSkipped = hostId ? 'host_inactive' : 'no_host';
    else if (l.slots.some((a) => a.accountId === live.id)) hostSkipped = 'already_on';
    else {
      const index = freeSupportIndex(l.slots);
      if (index === null) hostSkipped = 'support_full';
      else {
        host = {
          id: newId(),
          slot: 'support',
          slotIndex: index,
          assigneeKind: 'account',
          accountId: live.id,
          teamId: null,
          reason: 'auto',
        };
        await seatSlots(tx, ctx, l.conv.id, [host], 'system');
      }
    }
  }

  await auditAction(
    tx,
    ctx,
    l.conv,
    'inbox.conversation.branch',
    { branchId: l.conv.branchId },
    {
      branchId: input.branchId,
      changed,
      host: host ? { id: host.id, slotIndex: host.slotIndex, accountId: host.accountId } : null,
      hostSkipped,
    },
  );
  return { ...(await actionResult(tx, ctx, l.conv.id, false)), hostAdded: host !== null };
}

// --- HANDLED and REOPEN ------------------------------------------------------------------------

export async function markHandled(tx: Tx, ctx: ActionCtx, input: { conversationId: string }): Promise<InboxActionResult> {
  const l = await loadForAction(tx, ctx, input.conversationId);
  // On the conversation (primary or support), or in its team (feature doc:
  // support "can read, reply and mark handled").
  const onIt = l.slots.some((a) => a.accountId === ctx.viewer.accountId);
  if (!onIt && !holdsAt(ctx, 'inbox:conversation:handle', l)) {
    throw new PermissionDeniedError('inbox:conversation:handle');
  }
  if (l.conv.status === 'handled') throw errors.conflict('ALREADY_HANDLED', INBOX_ACTION_MESSAGES.alreadyHandled);
  const patch = handledPatch(ctx.viewer.accountId, ctx.now);
  await tx
    .update(conversation)
    .set(patch)
    .where(and(eq(conversation.operatorId, ctx.viewer.operatorId), eq(conversation.id, l.conv.id)));
  await tx.insert(inboxEvent).values(actionEvent(ctx, l.conv.id, 'handled', { handledByKind: 'account' }));
  await auditAction(
    tx,
    ctx,
    l.conv,
    'inbox.conversation.handle',
    { status: 'active' },
    { status: 'handled', handledAt: ctx.now.toISOString(), handledByKind: 'account', handledByAccountId: ctx.viewer.accountId },
  );
  return actionResult(tx, ctx, l.conv.id, false);
}

export async function reopenConversation(
  tx: Tx,
  ctx: ActionCtx,
  input: { conversationId: string },
): Promise<InboxActionResult> {
  const l = await loadForAction(tx, ctx, input.conversationId);
  requireAt(ctx, 'inbox:conversation:reopen', l);
  if (l.conv.status !== 'handled') throw errors.conflict('NOT_HANDLED', INBOX_ACTION_MESSAGES.notHandled);
  // Exactly the columns the customer's automatic reopen writes (`status.ts`).
  await tx
    .update(conversation)
    .set(reopenPatch(ctx.now, ctx.now))
    .where(and(eq(conversation.operatorId, ctx.viewer.operatorId), eq(conversation.id, l.conv.id)));
  await tx.insert(inboxEvent).values(actionEvent(ctx, l.conv.id, 'reopened', reopenedPayload(l.conv, false)));
  await auditAction(tx, ctx, l.conv, 'inbox.conversation.reopen', reopenAuditBefore(l.conv), {
    status: 'active',
    reopenedAt: ctx.now.toISOString(),
    by: 'account',
  });
  return actionResult(tx, ctx, l.conv.id, false);
}

