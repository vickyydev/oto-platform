/**
 * The brief's two lists, as intents (PLAN §B.2), and since SCRUM-220 Tom's
 * "Oto Inbox Bot Playbook" (28 Oct 2026), which is the FIRST rule: every
 * playbook row is an intent here, with its destination.
 *
 * The model LABELS the intent; this table, not the model, decides what each
 * intent may do. Every intent maps to exactly one server action. A model that
 * answers a handover intent is overruled by `applyGates` (gate.ts).
 *
 * The playbook's destinations (its "Routing" table), each with its closing
 * line, keyed by destination (`0094_inbox_playbook`):
 *
 *   Birthday & events  `closing_birthday`  route `birthdays`
 *   GM                 `closing_gm`        route `gm`
 *   Branch             `closing_branch`    route `general` (the thread's
 *                                          park's reception)
 *   unclear            `closing_unclear`   the branch when it is known,
 *                                          else the GM (`BY_BRANCH`); the
 *                                          engine sends the unclear line
 *                                          whichever queue it goes to (the
 *                                          plan keeps `handover_general` as
 *                                          its own fallback)
 *
 * Two plans carry a line of their own instead of the destination's: the
 * nanny booking's `closing_booking` (SCRUM-677) and a camp's, the playbook's
 * neutral "not covered" line `closing_unclear` to `birthdays` (SCRUM-676).
 */

import type { InboxCategoryKey } from '@oto/shared';
// A subpath, not the barrel: the inbox imports this file in the browser (`@oto/assistant/intents`).
import { INBOX_AI_ASKED_SLOTS, type InboxAiAskedSlot } from '@oto/shared/inbox-open-question';
import type { AiBranchKey } from './decision';

export const AI_INTENTS = [
  'greeting',
  'hours',
  'address',
  'directions_parking',
  'ticket_prices',
  // SCRUM-220 playbook: a price objection is ANSWERED (the value line and a
  // deal from the knowledge); only a customer who still pushes is handed over.
  'discount_negotiation',
  'discount_insist',
  'age_rules',
  'socks',
  'about_oto',
  'faq',
  'thanks_closing',
  'identity_question',
  // Birthdays: the open and ONE combined question first, the closing line
  // once the basics are in (owner D1, 2026-10-28). Cakes go to the same desk.
  'birthday_party',
  'birthday_details',
  'birthday_cake',
  'birthday_brochure',
  // SCRUM-823 (owner, 10 Nov): advice, a recommendation or a choice in a
  // birthday conversation goes to a person at once; the opener stays
  // `birthday_party`.
  'birthday_advice',
  'special_event',
  // SCRUM-676 (real-chat replay, 2 Nov): a kids' camp is its own matter, not a
  // birthday or a group: handed to the Birthday & events team with a neutral
  // line, never the group deal.
  'camps',
  // The Golden Ticket: answered first; wanting to buy goes to the events team.
  'special_tickets',
  'special_tickets_buy',
  'events_groups',
  'nanny_booking',
  // Drop-off: the SERVICE is answered; a child CURRENTLY in our care is a
  // silent hand-over to the branch ("Message sources").
  'drop_off_service',
  'drop_off_care',
  'lost_item',
  'complaint_onsite',
  'complaint_online',
  'refund_request',
  'influencer_marketing',
  'job_request',
  'photography_question',
  'custom_request',
  'human_requested',
  'emotional_or_unclear',
  'other',
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

/**
 * The server's four actions. `silent_handover` (SCRUM-220 playbook): nothing
 * is said to the customer and the thread goes to the plan's team; the engine
 * decides from the number's policy whether the plan's line still goes.
 */
export const AI_ACTIONS = ['answer', 'handover', 'silent_handover', 'silent'] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

/**
 * The holding-line templates a handover may use. The six existing
 * `INBOX_TEMPLATE_KEYS` handover keys, `handover_general` (migration
 * `0080_inbox_ai`, rails change R1), and the playbook's closing lines
 * (`0094_inbox_playbook`): three keyed by destination, and the unclear
 * line the engine sends for an unclear or emotional hand-over (and, as its
 * plan's own line, for a camp: SCRUM-676); and one plan's own line,
 * `closing_booking` (SCRUM-677). Kept here as
 * a literal list because this package has no database dependency; the
 * engine reads the template rows by this key.
 */
export const AI_HOLDING_TEMPLATE_KEYS = [
  'handover_birthday',
  'handover_events',
  'handover_complaint_online',
  'handover_complaint_onsite',
  'handover_lost_found',
  'handover_marketing',
  'handover_general',
  'closing_birthday',
  'closing_gm',
  'closing_branch',
  'closing_unclear',
  'closing_booking',
] as const;
export type AiHoldingTemplateKey = (typeof AI_HOLDING_TEMPLATE_KEYS)[number];

/**
 * Grounding topics. `hours`, `address` and `prices` are live platform facts
 * (§C.3); the rest are `inbox.kb_entry.topic` values (§C.1).
 */
export const AI_GROUNDING_TOPICS = [
  'hours',
  'address',
  'prices',
  'about_oto',
  'hours_note',
  'address_note',
  'directions',
  'parking',
  'age_rules',
  'socks',
  'prices_note',
  'faq',
] as const;
export type AiGroundingTopic = (typeof AI_GROUNDING_TOPICS)[number];

/** The KB topics (`inbox.kb_entry.topic` CHECK list, §C.1). */
export const AI_KB_TOPICS = [
  'about_oto',
  'hours_note',
  'address_note',
  'directions',
  'parking',
  'age_rules',
  'socks',
  'prices_note',
  'faq',
] as const satisfies readonly AiGroundingTopic[];
export type AiKbTopic = (typeof AI_KB_TOPICS)[number];

/**
 * Where a handover sends the thread: a category's team, or `keep` (stay with
 * the team that already owns it). Re-routing itself is A2's (rails R3), and
 * only when no person has touched the routing.
 */
export type AiRoute = InboxCategoryKey | 'keep';

export interface AiHandoverPlan {
  templateKey: AiHoldingTemplateKey;
  route: AiRoute;
  /** Send the birthday brochure before the holding line (only `birthday_brochure`). */
  brochure: boolean;
  /**
   * SCRUM-220 playbook: the park this destination belongs to whatever the
   * thread's own (nanny bookings go to Central Floresta, the only park with
   * the service). Absent: the thread's park. The engine reads it when it
   * resolves the branch team.
   */
  branch?: AiBranchKey;
}

/** The playbook's Birthday & events destination. */
export const BIRTHDAYS_PLAN: AiHandoverPlan = { templateKey: 'closing_birthday', route: 'birthdays', brochure: false };
/** The playbook's GM destination: complaints, refunds, collaborations, jobs, photography. */
export const GM_PLAN: AiHandoverPlan = { templateKey: 'closing_gm', route: 'gm', brochure: false };
/** The playbook's Branch destination: the thread's park's reception. */
export const BRANCH_PLAN: AiHandoverPlan = { templateKey: 'closing_branch', route: 'general', brochure: false };
/**
 * SCRUM-676: a camp goes to the Birthday & events team with the playbook's
 * "Unclear or not covered" line (`closing_unclear`: "Thanks for your
 * message! A team member will be with you shortly."), which the playbook
 * words, which is translated in Thai and Russian, and which promises nothing:
 * no birthday manager, no group deal, and not the events line's "tailored
 * proposal". The engine sends it as the plan's own line, ahead of the
 * destination's (`ai-destination.ts` `PLAN_CLOSING_KEYS`).
 */
export const CAMPS_PLAN: AiHandoverPlan = { templateKey: 'closing_unclear', route: 'birthdays', brochure: false };
/** Nanny bookings go to the Central inbox (the only park with the service). */
export const CENTRAL_PLAN: AiHandoverPlan = { ...BRANCH_PLAN, branch: 'central' };
/**
 * SCRUM-677: after a nanny ANSWER, Central's desk takes the booking, and the
 * closing says so — its own line, not the branch's "shortly". A nanny
 * question the model hands over unanswered keeps `CENTRAL_PLAN`: no booking
 * was discussed. The engine sends a plan's own line only when the thread
 * goes where the plan sends it (`ai-destination.ts` `closingKeysOf`).
 */
export const NANNY_BOOKING_PLAN: AiHandoverPlan = { ...CENTRAL_PLAN, templateKey: 'closing_booking' };
/** Unclear or not covered, the branch known: "Thanks for your message! A team member will be with you shortly." */
export const UNCLEAR_BRANCH_PLAN: AiHandoverPlan = { templateKey: 'handover_general', route: 'general', brochure: false };
/** Unclear or not covered, the branch unknown: the same line, to the GM. */
export const UNCLEAR_GM_PLAN: AiHandoverPlan = { templateKey: 'handover_general', route: 'gm', brochure: false };

/**
 * A plan the gate resolves per turn: the playbook's "branch if known,
 * otherwise GM". The branch is known when the thread has one or the
 * customer named a park in this burst.
 */
export const BY_BRANCH = 'by_branch' as const;
export type AiPlanRef = AiHandoverPlan | typeof BY_BRANCH;

export function resolvePlan(ref: AiPlanRef, branchKnown: boolean): AiHandoverPlan {
  if (ref !== BY_BRANCH) return ref;
  return branchKnown ? UNCLEAR_BRANCH_PLAN : UNCLEAR_GM_PLAN;
}

/** The most parts one burst is read as (test night 2026-10-21, D1a). */
export const MAX_INTENTS = 4;

export type AiIntentRule =
  | {
      action: 'answer';
      /**
       * Topics of which at least one cited grounding key must be. `null` for
       * a non-factual answer (greeting, closing, identity, the birthday
       * question), which needs no grounding but still passes the
       * traceability guard.
       */
      groundingTopics: readonly AiGroundingTopic[] | null;
      /** A general enquiry: may carry the branch question when the thread has no branch. */
      general: boolean;
      /** The answer is followed by a handover (birthday_brochure, nanny_booking). */
      thenHandover: AiPlanRef | null;
      /** The thread may be auto-handled after this answer (G4). */
      mayAutoHandle: boolean;
      /**
       * SCRUM-220 playbook: where the part goes when it cannot be answered —
       * the model hands it over (an event the knowledge does not hold, a
       * Golden Ticket the customer wants to buy), or its answer fails the
       * grounding or a guard. Handing over is the safe direction, so such a
       * part is never silence. `lead`: the model's one short line may go
       * before the closing line (see the handover arm).
       */
      fallback: { plan: AiPlanRef; lead: boolean } | null;
    }
  | {
      action: 'handover';
      plan: AiPlanRef;
      /**
       * In a burst with several parts (test night 2026-10-21, D1a), the
       * answerable parts are answered first and this holding line follows.
       * False for the person-first intents — a complaint, a refund, an upset
       * message, a request for a person, and since SCRUM-823 a birthday
       * family asking for advice — whose holding line stands alone.
       */
      answerAlongside: boolean;
      /**
       * SCRUM-220 playbook: the model's ONE short line may go before the
       * closing line — the complaint's sincere apology, "We're always looking
       * for great people!", "Good question!", the school-group welcome,
       * "Amazing!". It cites nothing, so it is checked against no source: no
       * number, date, link or promise word, no busy word, no admission of
       * fault. A line that fails is dropped and the closing line goes alone.
       */
      lead: boolean;
    }
  | {
      /**
       * SCRUM-220 playbook ("Message sources"): nothing is said to the
       * customer, whatever else the burst asked; the thread goes to the plan.
       */
      action: 'silent_handover';
      plan: AiHandoverPlan;
    }
  | { action: 'silent' };

const answer = (
  groundingTopics: readonly AiGroundingTopic[] | null,
  extra: Partial<{
    general: boolean;
    thenHandover: AiPlanRef;
    mayAutoHandle: boolean;
    fallback: { plan: AiPlanRef; lead: boolean };
  }> = {},
): AiIntentRule => ({
  action: 'answer',
  groundingTopics,
  general: extra.general ?? false,
  thenHandover: extra.thenHandover ?? null,
  mayAutoHandle: extra.mayAutoHandle ?? false,
  fallback: extra.fallback ?? null,
});

const handover = (plan: AiPlanRef, opts: Partial<{ answerAlongside: boolean; lead: boolean }> = {}): AiIntentRule => ({
  action: 'handover',
  plan,
  answerAlongside: opts.answerAlongside ?? true,
  lead: opts.lead ?? false,
});

/** A hand-over whose holding line stands alone, whatever else the burst asked. */
const alone = (plan: AiPlanRef, lead = false): AiIntentRule => handover(plan, { answerAlongside: false, lead });

const silentHandover = (plan: AiHandoverPlan): AiIntentRule => ({ action: 'silent_handover', plan });

/** What a price, a deal, the Golden Ticket or an event may rest on. */
const PRICE_TOPICS = ['prices', 'prices_note'] as const satisfies readonly AiGroundingTopic[];
const SERVICE_TOPICS = ['faq', 'age_rules', 'prices_note'] as const satisfies readonly AiGroundingTopic[];

/** PLAN §B.2, row for row, with the playbook's rows (SCRUM-220). */
export const INTENT_TABLE: Readonly<Record<AiIntent, AiIntentRule>> = {
  greeting: answer(null),
  hours: answer(['hours', 'hours_note'], { general: true }),
  address: answer(['address', 'address_note'], { general: true }),
  directions_parking: answer(['address', 'address_note', 'directions', 'parking'], {
    general: true,
  }),
  // The playbook: any price a cited source states (tourist, Thai, resident).
  ticket_prices: answer(PRICE_TOPICS, { general: true }),
  // "That's expensive": the value line and a deal; an ungrounded answer (an
  // invented discount) is overruled into the unclear hand-over.
  discount_negotiation: answer([...PRICE_TOPICS, 'faq', 'about_oto'], { fallback: { plan: BY_BRANCH, lead: false } }),
  discount_insist: handover(BY_BRANCH),
  age_rules: answer(['age_rules'], { general: true }),
  socks: answer(['socks'], { general: true }),
  about_oto: answer(['about_oto'], { general: true }),
  // SCRUM-676: a price note grounds a faq part too. The playbook files what a
  // ticket or a deal includes there (parent tickets and Food & Play spent as
  // food credit, the Dinner Promo), and customers ask it as a food question:
  // a reply citing the Food & Play note was refused as GROUNDING_TOPIC. The
  // other topics keep their own intents; a live fact never grounds a faq.
  faq: answer(['faq', 'prices_note'], { general: true }),
  thanks_closing: answer(null, { mayAutoHandle: true }),
  // Answered in persona the first time; a second ask in the episode is a
  // handover (§B.4). The gate reads `episode.identityAnswered` for that.
  identity_question: answer(null),
  // The open and the ONE combined question (dates, headcount, branch).
  birthday_party: answer(null),
  birthday_details: handover(BIRTHDAYS_PLAN),
  birthday_cake: handover(BIRTHDAYS_PLAN),
  birthday_brochure: answer(null, {
    thenHandover: { templateKey: 'handover_birthday', route: 'birthdays', brochure: true },
  }),
  // SCRUM-823: which park is better for us, what do you suggest, which
  // package would you recommend, can we…, is it possible to… — anything beyond
  // the brochure's facts. The birthday manager advises: the closing line
  // alone, whatever else the burst asked, and the manager is notified.
  birthday_advice: alone(BIRTHDAYS_PLAN),
  // Loaded: sold right away (description and booking link). Not loaded: the
  // closing line and the Birthday & events inbox.
  special_event: answer(['faq', 'about_oto', 'prices_note'], { fallback: { plan: BIRTHDAYS_PLAN, lead: false } }),
  // SCRUM-676: a camp is handed over, never answered. The knowledge holds no
  // camp, and the gate cannot tell a camp fact from any other entry an answer
  // cites, so an answer row would let "yes, camp today" or a deal through on
  // any citation. As a hand-over the gate overrules every camp answer, and the
  // burst's other parts are still answered first (D1a). No lead line: the
  // closing line goes alone (the model's checked words only where no closing
  // template is usable in the language, as on every hand-over).
  camps: handover(CAMPS_PLAN),
  special_tickets: answer([...PRICE_TOPICS, 'faq', 'about_oto'], { fallback: { plan: BIRTHDAYS_PLAN, lead: true } }),
  special_tickets_buy: handover(BIRTHDAYS_PLAN, { lead: true }),
  events_groups: handover(BIRTHDAYS_PLAN, { lead: true }),
  // The facts, then Central takes the booking.
  nanny_booking: answer(SERVICE_TOPICS, { thenHandover: NANNY_BOOKING_PLAN, fallback: { plan: CENTRAL_PLAN, lead: false } }),
  drop_off_service: answer(SERVICE_TOPICS, { general: true }),
  drop_off_care: silentHandover(BRANCH_PLAN),
  lost_item: silentHandover(BRANCH_PLAN),
  complaint_onsite: alone(GM_PLAN, true),
  complaint_online: alone(GM_PLAN, true),
  // Never yes or no: the closing line alone.
  refund_request: alone(GM_PLAN),
  influencer_marketing: handover(GM_PLAN),
  job_request: handover(GM_PLAN, { lead: true }),
  photography_question: handover(GM_PLAN, { lead: true }),
  custom_request: handover(BY_BRANCH),
  human_requested: alone({ templateKey: 'handover_general', route: 'keep', brochure: false }),
  emotional_or_unclear: alone(BY_BRANCH),
  other: { action: 'silent' },
};

/**
 * The parts of a decision, the primary first and no intent twice (test night
 * 2026-10-21, D1a). `intent` is the primary; `intents` lists every part the
 * model read in the open messages, its first entry the primary again. A
 * decision recorded before `intents` existed reads as its one intent.
 */
export function intentPartsOf(d: { intent: AiIntent; intents?: readonly AiIntent[] | undefined }): AiIntent[] {
  const out: AiIntent[] = [];
  for (const part of [d.intent, ...(d.intents ?? [])]) {
    if (out.length === MAX_INTENTS) break;
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

/** The handover an answered identity question becomes on its second ask (§B.4). */
export const IDENTITY_SECOND_ASK: AiHandoverPlan = {
  templateKey: 'handover_general',
  route: 'keep',
  brochure: false,
};

/** The handover the episode caps force (§D.4 guard 3). */
export const CAP_HANDOVER: AiHandoverPlan = {
  templateKey: 'handover_general',
  route: 'keep',
  brochure: false,
};

/**
 * Intents whose answer is a birthday one: the generic park question is never
 * added (`inbox.md:76-79`) — the playbook's birthday question asks the
 * branch itself, beside the dates and the headcount.
 */
export const BIRTHDAY_INTENTS: ReadonlySet<AiIntent> = new Set<AiIntent>([
  'birthday_brochure',
  'birthday_party',
  'birthday_details',
  'birthday_cake',
  'birthday_advice',
]);

/**
 * SCRUM-817 (staging, 10 Nov): in a Birthdays & Events conversation the
 * family wrote "Можно в субботу в 2 часа дня?" and the model read it as a
 * walk-in question — "бронировать не нужно" and the opening hours. In a
 * birthday thread a day, a date or a time is the party's. These are the
 * labels that take such a message out of the birthday flow; the gate
 * overrules them to `birthday_details` (gate.ts `applyGates`).
 */
export const BIRTHDAY_DATE_OVERRULED: ReadonlySet<AiIntent> = new Set<AiIntent>(['hours', 'faq', 'greeting', 'address']);

/** What makes a thread a birthday one (SCRUM-817): its category, or the episode's earlier replies. */
export interface BirthdayThreadFacts {
  /** The thread's inbox category; `birthdays` is a Birthdays & Events conversation. */
  threadCategory?: InboxCategoryKey | null;
  /** Every intent this episode's earlier replies were labelled with. */
  earlierIntents?: readonly AiIntent[];
}

/**
 * SCRUM-817: the thread is a birthday one — a Birthdays & Events
 * conversation (`category`), or one whose earlier replies this episode were
 * about a birthday party (`earlier`); null for any other thread.
 */
export function birthdayThreadOf(t: BirthdayThreadFacts): 'category' | 'earlier' | null {
  if (t.threadCategory === 'birthdays') return 'category';
  return (t.earlierIntents ?? []).some((i) => BIRTHDAY_INTENTS.has(i)) ? 'earlier' : null;
}

/** Parts whose answer is checked for the "safer" framing (the playbook: the whole park is safe). */
export const CARE_SERVICE_INTENTS: ReadonlySet<AiIntent> = new Set<AiIntent>(['nanny_booking', 'drop_off_service']);

/**
 * SCRUM-696: the intents an operator rule's ask-first question never
 * interrupts; the engine ignores the question for them (the instruction still
 * reaches the prompt). The person-first kinds (a complaint, a refund, a
 * request for a person, an upset or unclear message), a child currently in
 * our care, the birthday flow (which asks its own one combined question), and
 * the small talk and spam.
 */
export const ASK_FIRST_IGNORED_INTENTS: readonly AiIntent[] = [
  'complaint_onsite',
  'complaint_online',
  'refund_request',
  'human_requested',
  'emotional_or_unclear',
  'drop_off_care',
  'birthday_party',
  'birthday_details',
  'birthday_cake',
  'birthday_brochure',
  'birthday_advice',
  'greeting',
  'thanks_closing',
  'identity_question',
  'other',
];

// ---------------------------------------------------------------------------
// SCRUM-831: the slots a reply may ask the customer
// ---------------------------------------------------------------------------

/**
 * SCRUM-831 (owner, 10 Nov: "the memory is the primary mechanism; the guard
 * is the last net"): what a reply's question asks the customer for. The model
 * names it in its decision (`askedSlots`), the server records it as the
 * conversation's open question, and the customer's next message is read as
 * its answer. `other` is a question the memory does not track. One list with
 * the table's CHECK and the inbox (`@oto/shared` `INBOX_AI_ASKED_SLOTS`).
 */
export const AI_ASKED_SLOTS = INBOX_AI_ASKED_SLOTS;
export type AiAskedSlot = InboxAiAskedSlot;

/** The most slots one reply asks: the playbook's combined birthday question asks three (dates, headcount, branch). */
export const MAX_ASKED_SLOTS = 4;

/**
 * SCRUM-831: the slots each intent's flow in the playbook may ask, from its
 * rows (`PLAYBOOK_LINES`, `PRICING_RULE`, the park question):
 *
 *   - the birthday open asks dates, roughly how many people and which branch,
 *     as ONE question; the party packages' age bands make the child's age
 *     matter there too;
 *   - the price conversation asks the branch and residency together;
 *   - a general enquiry may ask which park when the thread has none;
 *   - the drop-off service's and the nanny's age rules, the Golden Ticket's
 *     "what is included by age" and the age rules themselves are the places
 *     the child's age changes the answer; the nanny booking asks the day and
 *     the time.
 *
 * The CHILD'S AGE is asked only where a turn's intent lists it here
 * (`AGE_SLOT_INTENTS`): never as a reflex (`repeatGuard`, kind `not_needed`).
 */
export const INTENT_SLOTS: Readonly<Record<AiIntent, readonly AiAskedSlot[]>> = {
  greeting: [],
  hours: ['park'],
  address: ['park'],
  directions_parking: ['park'],
  ticket_prices: ['park', 'residency'],
  discount_negotiation: [],
  discount_insist: [],
  age_rules: ['park', 'child_age'],
  socks: ['park'],
  about_oto: ['park'],
  faq: ['park'],
  thanks_closing: [],
  identity_question: [],
  birthday_party: ['date', 'guests_count', 'kids_count', 'adults_count', 'park', 'child_age'],
  birthday_details: [],
  birthday_cake: [],
  birthday_brochure: ['child_age'],
  // SCRUM-823: an advice hand-over asks nothing; a person takes the choice.
  birthday_advice: [],
  special_event: [],
  camps: [],
  special_tickets: ['child_age'],
  special_tickets_buy: [],
  events_groups: [],
  nanny_booking: ['child_age', 'date', 'time'],
  drop_off_service: ['child_age', 'park'],
  drop_off_care: [],
  lost_item: [],
  complaint_onsite: [],
  complaint_online: [],
  refund_request: [],
  influencer_marketing: [],
  job_request: [],
  photography_question: [],
  custom_request: [],
  human_requested: [],
  emotional_or_unclear: [],
  other: [],
};

/** SCRUM-831: the intents whose answer the child's age changes (the drop-off and nanny age rules, the party packages' age bands, the Golden Ticket by age, the age rules). */
export const AGE_SLOT_INTENTS: ReadonlySet<AiIntent> = new Set<AiIntent>(
  AI_INTENTS.filter((i) => INTENT_SLOTS[i].includes('child_age')),
);

// ---------------------------------------------------------------------------
// SCRUM-832: the answers that depend on the park
// ---------------------------------------------------------------------------

/**
 * SCRUM-832 (owner, 10 Nov 2026: "How to find you guys?" got both parks'
 * locations and then "which park?"): the intents whose answer can depend on
 * the park — where a park is, how to find it inside the mall and where to
 * park, and the opening hours. In a general thread with no park, a reply to
 * one of them is the park question alone (compose.ts `parkFirst`), but only
 * where the knowledge says the parks' answers DIFFER: the topics the reply
 * cites are compared park by park (`parksDiffer`). Both parks open 10:00 to
 * 20:00 and both malls park free today, so "what time do you open?" and "is
 * there parking?" are answered at once, while "how do we find you?" is not.
 */
export const PARK_FIRST_INTENTS: ReadonlySet<AiIntent> = new Set<AiIntent>(['address', 'directions_parking', 'hours']);

/**
 * The flows that ask the park inside their own one question, which the
 * park-first question never replaces (the playbook first): the price
 * conversation's branch-and-residency question, asked before the prices
 * (`PRICING_RULE`), and the birthday's combined question (dates, roughly how
 * many people, which branch).
 */
export const OWN_PARK_QUESTION_INTENTS: ReadonlySet<AiIntent> = new Set<AiIntent>(['ticket_prices', ...BIRTHDAY_INTENTS]);
