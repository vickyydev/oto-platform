import {
  BY_BRANCH,
  INTENT_TABLE,
  resolvePlan,
  type AiHandoverPlan,
  type AiIntent,
  type AiPlanRef,
} from '@oto/assistant';
import type { InboxCategory, InboxTemplateKey } from '@oto/db';

/**
 * WHERE A HAND-OVER GOES, AND WHAT IT SAYS ON THE WAY (SCRUM-220, Tom's Inbox
 * Bot Playbook of 28 Oct 2026 — the first rule for the customer assistant).
 *
 * The intent table (`@oto/assistant` INTENT_TABLE) carries the playbook's
 * destinations itself since the assistant lane: complaints, refunds,
 * collaborations, jobs and photography route to `gm` with `closing_gm`;
 * birthdays to `birthdays` with `closing_birthday`; the branch desk to
 * `general` with `closing_branch`, a nanny booking naming Central Floresta
 * (`plan.branch`); and unclear is `BY_BRANCH`, which the gate resolves to the
 * thread's park when it is known, else the GM. The engine applies the same
 * rules once more here, by the intent that owns the hand-over, against the
 * branch the thread ENDS with (a park the customer named in this burst):
 *
 *   - an online complaint and an influencer go to the GM queue, not Marketing;
 *   - an unclear or emotional message stays with the thread's park when the
 *     thread has one, and goes to the GM when it has none.
 *
 * Any other intent's table route is honoured as it is.
 *
 * THE CLOSING LINE IS KEYED BY DESTINATION, not by topic: the birthday
 * manager, the general manager, or the branch will be with the customer
 * shortly. A destination with no line of its own (Marketing), or whose line
 * is missing or still untranslated in the customer's language, falls back to
 * the plan's own template and then to the team-neutral `handover_general`
 * (`ai-engine.ts`) — never to a line that names another team.
 *
 * THE NUMBER'S SILENCE POLICY (`inbox.channel_account.silence_policy`): the
 * intents on which a park's own number says nothing to the customer — the
 * branch desk's drop-off, nanny and lost-and-found — and hands the thread to
 * the team in silence. Silent only when EVERY hand-over part of the burst is
 * on the list: a part that needs a person's voice (a complaint beside a lost
 * item) keeps the line, the safe direction. A silenced hand-over says
 * NOTHING — no answer, no lead line, no closing line, no brochure — as the
 * playbook's silent matters do ("whatever else was asked"): the nanny the
 * assistant would answer on another number is the branch desk's on its own.
 */

/** A playbook destination: a category, or the thread's park when it has one and the GM when not. */
export type PlaybookRoute = InboxCategory | 'branch_or_gm';

/** The playbook's routes where they differ from the intent table's own. */
export const PLAYBOOK_ROUTE: Readonly<Partial<Record<AiIntent, PlaybookRoute>>> = {
  complaint_online: 'gm',
  influencer_marketing: 'gm',
  emotional_or_unclear: 'branch_or_gm',
};

/** The closing line of each destination; null where the playbook names none. */
export const CLOSING_KEY_OF: Readonly<Record<InboxCategory, InboxTemplateKey | null>> = {
  birthdays: 'closing_birthday',
  gm: 'closing_gm',
  general: 'closing_branch',
  marketing: null,
};

const samePlan = (a: AiHandoverPlan, b: AiHandoverPlan): boolean =>
  a.templateKey === b.templateKey && a.route === b.route && a.brochure === b.brochure && a.branch === b.branch;

/** A table plan matches the verdict's plan as the gate resolved it (`BY_BRANCH` either way). */
const planMatches = (ref: AiPlanRef | null, plan: AiHandoverPlan): boolean =>
  ref !== null && (samePlan(resolvePlan(ref, true), plan) || samePlan(resolvePlan(ref, false), plan));

/**
 * The intent whose hand-over this plan is: the first part of the burst whose
 * table rule hands over with it — a hand-over, a silent hand-over, an answer
 * that then hands over, or an answer's fallback when it could not be given.
 * Null for a plan no part owns — the episode cap's, a second identity
 * question's, the model's own call for a person — which keeps the plan's route.
 */
export function planOwner(intents: readonly AiIntent[], plan: AiHandoverPlan): AiIntent | null {
  for (const intent of intents) {
    const rule = INTENT_TABLE[intent];
    if ((rule.action === 'handover' || rule.action === 'silent_handover') && planMatches(rule.plan, plan)) return intent;
    if (rule.action === 'answer' && (planMatches(rule.thenHandover, plan) || planMatches(rule.fallback?.plan ?? null, plan))) return intent;
  }
  return null;
}

/**
 * The playbook's unclear line (owner ruling, 28 Oct 2026): its routing row is
 * "Unclear or not covered", and that hand-over says "Thanks for your message!
 * A team member will be with you shortly." whichever queue it goes to — the
 * park's when it is known, else the GM's. It wins over the destination's
 * line for that row only: an unclear or emotional message, a request the
 * knowledge does not cover, and the model handing over on its own. The
 * discount pusher goes the same way but is the deals path, and keeps the
 * destination's line.
 */
export const UNCLEAR_CLOSING_KEY = 'closing_unclear' satisfies InboxTemplateKey;

/** The intents of the playbook's "Unclear or not covered" row. */
const UNCLEAR_ROW: ReadonlySet<AiIntent> = new Set<AiIntent>(['emotional_or_unclear', 'custom_request']);

/**
 * The hand-over is the "Unclear or not covered" row's: its plan is the
 * `BY_BRANCH` one, and an unclear or not-covered part is in the burst, or the
 * model handed over on its own (`byModel`: the gate's `MODEL_HANDOVER`, no
 * part of the burst owning a hand-over).
 */
export function isUnclearHandover(intents: readonly AiIntent[], plan: AiHandoverPlan, byModel: boolean): boolean {
  return planMatches(BY_BRANCH, plan) && (byModel || intents.some((i) => UNCLEAR_ROW.has(i)));
}

/**
 * The gate's reasons for WITHHOLDING a reply the model wrote (SCRUM-671, item
 * D, owner ruling 28 Oct: a customer never gets pure silence on a main
 * channel): its grounding refused, a guard tripped, or the model was unsure
 * of its answer — the customer asked and would get nothing. The model CHOOSING
 * silence (a "thanks, bye" needs no reply), spam, a provider failure (the
 * thread stays visibly unanswered for staff) and the caps are not on the list.
 */
export const WITHHELD_REPLY_REASONS: ReadonlySet<string> = new Set([
  'UNSURE',
  'GROUNDING_MISSING',
  'GROUNDING_UNKNOWN',
  'GROUNDING_TOPIC',
  'GUARD_NUMBER',
  'GUARD_DATE',
  'GUARD_PROMISE',
  'GUARD_PERSONA',
  'GUARD_BUBBLES',
  'GUARD_SHAPE',
  'GUARD_BUSY',
  'GUARD_LINK',
  'GUARD_FAULT',
  'GUARD_FRAMING',
  'GUARD_LANGUAGE',
  'GUARD_PARK',
  'LANGUAGE',
]);

/**
 * The category the thread is handed to: the playbook's route for the owning
 * intent, else the plan's; `keep` is the thread's own category. `branchKnown`
 * is whether the thread has a park (or this turn gave it one).
 */
export function destinationOf(
  owner: AiIntent | null,
  plan: AiHandoverPlan,
  thread: { category: InboxCategory; branchKnown: boolean },
): InboxCategory {
  const route = (owner ? PLAYBOOK_ROUTE[owner] : undefined) ?? plan.route;
  if (route === 'keep') return thread.category;
  if (route === 'branch_or_gm') return thread.branchKnown ? 'general' : 'gm';
  return route;
}

/**
 * A number's silent intents, read defensively from the jsonb: a list of
 * words, or null when the number has no policy (or one of the wrong shape —
 * the CHECK holds the shape, this holds the words).
 */
export function silentIntentsOf(policy: unknown): ReadonlySet<string> | null {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null;
  const list = (policy as { silentIntents?: unknown }).silentIntents;
  if (!Array.isArray(list)) return null;
  return new Set(list.filter((x): x is string => typeof x === 'string'));
}

/**
 * Whether the number's policy silences this hand-over: every hand-over part
 * of the burst (the plan's owner among them) is on the list. A burst with no
 * hand-over part of its own (the cap, the model's call) is judged by its
 * primary intent.
 */
export function silencedBy(
  silent: ReadonlySet<string> | null,
  intents: readonly AiIntent[],
  owner: AiIntent | null,
  primary: AiIntent,
): boolean {
  if (!silent || silent.size === 0) return false;
  const parts = intents.filter((i) => {
    const action = INTENT_TABLE[i].action;
    return action === 'handover' || action === 'silent_handover';
  });
  if (owner && !parts.includes(owner)) parts.push(owner);
  const judged = parts.length > 0 ? parts : [primary];
  return judged.every((i) => silent.has(i));
}
