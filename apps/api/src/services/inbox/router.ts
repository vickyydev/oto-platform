import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  account,
  assignment,
  inboxEvent,
  conversation,
  routingRule,
  team,
  type InboxCategory,
  type InboxTeamKey,
} from '@oto/db';
import { newId } from '@oto/shared';
import type { Exec } from '../tx';

/**
 * DEFAULT ROUTING (S2-19 I2d, SCRUM-583; plan §3.1, `docs/features/inbox.md`
 * "Ownership and assignment").
 *
 * Runs once, on a NEW conversation, inside the transaction that created it:
 *
 *  1. CLASSIFY — done by the caller (the ingest): the simulator's hint when
 *     there is one; else, since SCRUM-830, what the FIRST MESSAGE says
 *     (`@oto/assistant` `firstMessageCategory`: a birthday, a party, a camp
 *     or a school group → birthdays; a refund or a complaint → gm); else the
 *     channel account's `default_category`. The decision rides the `routed`
 *     pill as `source` (`hint` / `message` / `default`) with the cue's key —
 *     never the text — so the inbox can say "from the message". The branch
 *     is THE CHANNEL ACCOUNT'S FIRST (a park's own number belongs to that
 *     park — I1's note: a general conversation with no branch matches no
 *     reception rule), then the hint's.
 *  2. PICK THE RULE — the highest-priority active `routing_rule` for the
 *     category whose language and branch match, where null means any. On a
 *     tie the more specific rule wins (a named language, a named branch).
 *  3. ASSIGN — the rule's primary (a person, or the team itself: the
 *     reception phone, or a rule nobody has named a person on yet), reason
 *     `auto`; and when the rule has `auto_add_backup` and a backup, the
 *     backup AS SUPPORT FROM THE FIRST MESSAGE (IT Brief: fixed pairs).
 *  4. RECORD — `last_routed_at`, the conversation's team, and the `routed`
 *     and `assigned` pills. Ids only; never a body.
 *
 * NOTHING IS EVER UNOWNED. Every team has a catch-all rule (platform-sync).
 * When even that does not match — a branchless general conversation, say,
 * where every reception rule names a branch — the category's own team is
 * the primary: the one at the conversation's branch, or the first by the
 * operator's sort order. That fallback is recorded on the `routed` pill.
 *
 * Manual-only people (the GM, the entertainment coordinator) are never
 * picked here, because routing only ever picks the people a rule names.
 *
 * THE GENERAL INBOX (SCRUM-789, `placement.ts`): a general conversation the
 * assistant is answering is HELD instead (`hold`): no rule is picked, nobody
 * is seated and the conversation has no team; only `last_routed_at` and a
 * `routed` pill (`held: 'general'`) are written. "Nothing is ever unowned"
 * then reads: the assistant holds it, and the moment it stops — or the thread
 * turns into the park's own work — the routing above is made (`placed`, the
 * pill says why), exactly as it would have been on the first message.
 */

/** The team that owns each category (IT Brief). General is reception, per branch. */
const TEAM_OF_CATEGORY: Record<InboxCategory, InboxTeamKey> = {
  birthdays: 'birthdays',
  general: 'reception',
  marketing: 'marketing',
  gm: 'gm',
};

export interface RouteInput {
  operatorId: string;
  conversationId: string;
  category: InboxCategory;
  language: string;
  branchId: string | null;
  /** When the routing happened: the message that opened the thread. */
  at: Date;
  /**
   * A re-route (I2e, move-team): only this team's rules, and this team when
   * none matches; the rows carry `reason` and who asked. Absent on a new
   * conversation, which is routed by the system with reason `auto`.
   *
   * `by: 'ai'` (SCRUM-590, rails change R3) is the assistant re-routing a
   * thread whose category it read differently and that no person has touched:
   * the rows say `assigned_by_kind 'ai'` with no account, and the pills name
   * the assistant as the actor. Absent `by` is a person, as before.
   */
  reroute?: RerouteBy;
  /**
   * SCRUM-830: how a NEW conversation's category was decided — the
   * simulator's hint, the first message's words (with the cue's key and the
   * reading's language, never the text), or the channel account's default.
   * Recorded on the `routed` pill; absent on a re-route.
   */
  decided?: CategoryDecision;
  /**
   * SCRUM-789: hold a general conversation in the General inbox — no team,
   * nobody seated. Only on a new `general` conversation; ignored otherwise.
   */
  hold?: boolean;
  /**
   * SCRUM-789: this is a held conversation being seated at its park now, and
   * why. Recorded on the `routed` pill.
   */
  placed?: PlacementReason;
}

/**
 * Why a held general conversation was seated at its park (SCRUM-789):
 *   `local`           its topic is the park's own work, or the assistant
 *                     handed it to the branch desk;
 *   `assistant_away`  no assistant turn answers it (off, shadow, closed,
 *                     paused, a person acted, a turn that ended unanswered).
 */
export type PlacementReason = 'local' | 'assistant_away';

export type CategoryDecision =
  | { source: 'hint' }
  | { source: 'default' }
  /** `cueLanguage`: the reading's language — the line's script (Thai, Cyrillic), else the cue's. */
  | { source: 'message'; cue: string; cueLanguage: string };

export type RerouteBy =
  | { teamId: string; reason: 'move'; by?: 'account'; actorAccountId: string }
  | { teamId: string; reason: 'move'; by: 'ai' };

export interface RoutedAssignment {
  id: string;
  slot: 'primary' | 'support';
  slotIndex: number;
  assigneeKind: 'account' | 'team';
  accountId: string | null;
  teamId: string | null;
}

export interface RouteResult {
  ruleId: string | null;
  /** Null only for a conversation held in the General inbox (SCRUM-789). */
  teamId: string | null;
  fallback: boolean;
  assignments: RoutedAssignment[];
}

export class NoRouteError extends Error {
  readonly code = 'INBOX_NO_ROUTE';
  constructor(category: string) {
    super(`the operator has no inbox team for the ${category} category — run platform-sync`);
    this.name = 'NoRouteError';
  }
}

type Rule = typeof routingRule.$inferSelect;

/** Highest priority first; on a tie the rule naming more (language, branch); then the oldest. */
function better(a: Rule, b: Rule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const spec = (r: Rule) => (r.language !== null ? 1 : 0) + (r.branchId !== null ? 1 : 0);
  if (spec(a) !== spec(b)) return spec(b) - spec(a);
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  return t !== 0 ? t : a.id.localeCompare(b.id);
}

/** The rule that routes this conversation, or null when none matches. Pure, for the checks. */
export function pickRule(
  rules: readonly Rule[],
  q: { category: InboxCategory; language: string; branchId: string | null },
): Rule | null {
  const lang = q.language.toLowerCase();
  const matching = rules.filter(
    (r) =>
      r.active &&
      r.archivedAt === null &&
      r.category === q.category &&
      (r.language === null || r.language.toLowerCase() === lang) &&
      (r.branchId === null || r.branchId === q.branchId),
  );
  return matching.sort(better)[0] ?? null;
}

export async function routeConversation(tx: Exec, input: RouteInput): Promise<RouteResult> {
  if (input.hold && input.category === 'general' && !input.reroute) return holdInGeneral(tx, input);
  const rules = await tx
    .select()
    .from(routingRule)
    .where(
      and(
        eq(routingRule.operatorId, input.operatorId),
        eq(routingRule.category, input.category),
        eq(routingRule.active, true),
        isNull(routingRule.archivedAt),
        ...(input.reroute ? [eq(routingRule.teamId, input.reroute.teamId)] : []),
      ),
    );
  const rule = pickRule(rules, input);

  let teamId: string;
  let fallback = false;
  if (rule) {
    teamId = rule.teamId;
  } else if (input.reroute) {
    teamId = input.reroute.teamId;
    fallback = true;
  } else {
    const candidates = await tx
      .select({ id: team.id, branchId: team.branchId })
      .from(team)
      .where(and(eq(team.operatorId, input.operatorId), eq(team.key, TEAM_OF_CATEGORY[input.category])))
      .orderBy(asc(team.sortOrder), asc(team.createdAt));
    const chosen = candidates.find((t) => t.branchId === input.branchId) ?? candidates[0];
    if (!chosen) throw new NoRouteError(input.category);
    teamId = chosen.id;
    fallback = true;
  }

  // A named person who can no longer sign in is not an owner: the rule's
  // team takes the primary instead, and the backup is still added.
  const named = [rule?.primaryKind === 'account' ? rule.primaryAccountId : null, rule?.backupAccountId ?? null].filter(
    (id): id is string => id !== null,
  );
  const active = new Set(
    named.length === 0
      ? []
      : (
          await tx
            .select({ id: account.id })
            .from(account)
            .where(
              and(
                inArray(account.id, named),
                eq(account.operatorId, input.operatorId),
                eq(account.status, 'active'),
              ),
            )
        ).map((a) => a.id),
  );

  const primaryAccountId =
    rule?.primaryKind === 'account' && rule.primaryAccountId && active.has(rule.primaryAccountId)
      ? rule.primaryAccountId
      : null;
  const assignments: RoutedAssignment[] = [
    primaryAccountId
      ? { id: newId(), slot: 'primary', slotIndex: 0, assigneeKind: 'account', accountId: primaryAccountId, teamId: null }
      : { id: newId(), slot: 'primary', slotIndex: 0, assigneeKind: 'team', accountId: null, teamId },
  ];
  const backup = rule?.backupAccountId ?? null;
  if (rule?.autoAddBackup && backup && backup !== primaryAccountId && active.has(backup)) {
    assignments.push({
      id: newId(),
      slot: 'support',
      slotIndex: 1,
      assigneeKind: 'account',
      accountId: backup,
      teamId: null,
    });
  }

  const byAi = input.reroute?.by === 'ai';
  const actorAccountId = input.reroute && input.reroute.by !== 'ai' ? input.reroute.actorAccountId : null;
  await tx.insert(assignment).values(
    assignments.map((a) => ({
      id: a.id,
      operatorId: input.operatorId,
      conversationId: input.conversationId,
      slot: a.slot,
      slotIndex: a.slotIndex,
      assigneeKind: a.assigneeKind,
      accountId: a.accountId,
      teamId: a.teamId,
      assignedByKind: byAi ? ('ai' as const) : input.reroute ? ('account' as const) : ('system' as const),
      assignedByAccountId: actorAccountId,
      reason: input.reroute?.reason ?? ('auto' as const),
      assignedAt: input.at,
    })),
  );

  await tx
    .update(conversation)
    .set({ teamId, lastRoutedAt: input.at, updatedAt: new Date() })
    .where(and(eq(conversation.operatorId, input.operatorId), eq(conversation.id, input.conversationId)));

  await tx.insert(inboxEvent).values([
    {
      id: newId(),
      operatorId: input.operatorId,
      conversationId: input.conversationId,
      kind: 'routed' as const,
      actorKind: byAi ? ('ai' as const) : ('system' as const),
      payload: {
        ruleId: rule?.id ?? null,
        teamId,
        category: input.category,
        language: input.language,
        branchId: input.branchId,
        fallback,
        // SCRUM-830: the pill says "from the message" when the first message decided.
        ...(input.decided ? { source: input.decided.source } : {}),
        ...(input.decided?.source === 'message' ? { cue: input.decided.cue, cueLanguage: input.decided.cueLanguage } : {}),
        // SCRUM-789: a held general conversation seated at its park, and why.
        ...(input.placed ? { placed: input.placed } : {}),
      },
      createdAt: input.at,
    },
    ...assignments.map((a) => ({
      id: newId(),
      operatorId: input.operatorId,
      conversationId: input.conversationId,
      kind: 'assigned' as const,
      actorKind: byAi ? ('ai' as const) : ('system' as const),
      payload: {
        assignmentId: a.id,
        slot: a.slot,
        assigneeKind: a.assigneeKind,
        accountId: a.accountId,
        teamId: a.teamId,
        reason: input.reroute?.reason ?? 'auto',
      },
      createdAt: input.at,
    })),
  ]);

  return { ruleId: rule?.id ?? null, teamId, fallback, assignments };
}

/**
 * SCRUM-789: the General inbox. The routing decision is recorded — the time
 * and a `routed` pill — and nothing else: no team, no rule, nobody seated.
 */
async function holdInGeneral(tx: Exec, input: RouteInput): Promise<RouteResult> {
  await tx
    .update(conversation)
    .set({ teamId: null, lastRoutedAt: input.at, updatedAt: new Date() })
    .where(and(eq(conversation.operatorId, input.operatorId), eq(conversation.id, input.conversationId)));
  await tx.insert(inboxEvent).values({
    id: newId(),
    operatorId: input.operatorId,
    conversationId: input.conversationId,
    kind: 'routed' as const,
    actorKind: 'system' as const,
    payload: {
      ruleId: null,
      teamId: null,
      held: 'general',
      category: input.category,
      language: input.language,
      branchId: input.branchId,
      fallback: false,
      ...(input.decided ? { source: input.decided.source } : {}),
    },
    createdAt: input.at,
  });
  return { ruleId: null, teamId: null, fallback: false, assignments: [] };
}
