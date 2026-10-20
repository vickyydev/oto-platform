/**
 * The brief's two lists, as intents (PLAN §B.2).
 *
 * The model LABELS the intent; this table, not the model, decides what each
 * intent may do. Every intent maps to exactly one server action. A model that
 * answers a handover intent is overruled by `applyGates` (gate.ts).
 */

import type { InboxCategoryKey } from '@oto/shared';

export const AI_INTENTS = [
  'greeting',
  'hours',
  'address',
  'directions_parking',
  'ticket_prices',
  'age_rules',
  'socks',
  'about_oto',
  'faq',
  'birthday_brochure',
  'thanks_closing',
  'birthday_party',
  'events_groups',
  'discount_negotiation',
  'custom_request',
  'complaint_onsite',
  'complaint_online',
  'influencer_marketing',
  'nanny_booking',
  'lost_item',
  'special_tickets',
  'human_requested',
  'identity_question',
  'emotional_or_unclear',
  'other',
] as const;
export type AiIntent = (typeof AI_INTENTS)[number];

/** The server's three actions. */
export const AI_ACTIONS = ['answer', 'handover', 'silent'] as const;
export type AiAction = (typeof AI_ACTIONS)[number];

/**
 * The holding-line templates a handover may use. The six existing
 * `INBOX_TEMPLATE_KEYS` handover keys plus `handover_general`, which migration
 * `0080_inbox_ai` adds (rails change R1). Kept here as a literal list because
 * this package has no database dependency; A2 maps it onto the db's key type.
 */
export const AI_HOLDING_TEMPLATE_KEYS = [
  'handover_birthday',
  'handover_events',
  'handover_complaint_online',
  'handover_complaint_onsite',
  'handover_lost_found',
  'handover_marketing',
  'handover_general',
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
  /** Send the birthday brochure before the holding line (only birthday intents). */
  brochure: boolean;
}

/** The most parts one burst is read as (test night 2026-10-21, D1a). */
export const MAX_INTENTS = 4;

export type AiIntentRule =
  | {
      action: 'answer';
      /**
       * Topics of which at least one cited grounding key must be. `null` for
       * a non-factual answer (greeting, closing, identity), which needs no
       * grounding but still passes the traceability guard.
       */
      groundingTopics: readonly AiGroundingTopic[] | null;
      /** A general enquiry: may carry the branch question when the thread has no branch. */
      general: boolean;
      /** The answer is followed by a handover (birthday_brochure). */
      thenHandover: AiHandoverPlan | null;
      /** The thread may be auto-handled after this answer (G4). */
      mayAutoHandle: boolean;
    }
  | {
      action: 'handover';
      plan: AiHandoverPlan;
      /**
       * In a burst with several parts (test night 2026-10-21, D1a), the
       * answerable parts are answered first and this holding line follows.
       * False for the person-first intents — a complaint, an upset message, a
       * request for a person — whose holding line stands alone (§B.4: "a
       * complaint gets the holding line only").
       */
      answerAlongside: boolean;
    }
  | { action: 'silent' };

const answer = (
  groundingTopics: readonly AiGroundingTopic[] | null,
  extra: Partial<{ general: boolean; thenHandover: AiHandoverPlan; mayAutoHandle: boolean }> = {},
): AiIntentRule => ({
  action: 'answer',
  groundingTopics,
  general: extra.general ?? false,
  thenHandover: extra.thenHandover ?? null,
  mayAutoHandle: extra.mayAutoHandle ?? false,
});

const handover = (
  templateKey: AiHoldingTemplateKey,
  route: AiRoute,
  brochure = false,
  answerAlongside = true,
): AiIntentRule => ({
  action: 'handover',
  plan: { templateKey, route, brochure },
  answerAlongside,
});

/** A hand-over whose holding line stands alone, whatever else the burst asked. */
const alone = (templateKey: AiHoldingTemplateKey, route: AiRoute): AiIntentRule =>
  handover(templateKey, route, false, false);

/** PLAN §B.2, row for row. */
export const INTENT_TABLE: Readonly<Record<AiIntent, AiIntentRule>> = {
  greeting: answer(null),
  hours: answer(['hours', 'hours_note'], { general: true }),
  address: answer(['address', 'address_note'], { general: true }),
  directions_parking: answer(['address', 'address_note', 'directions', 'parking'], {
    general: true,
  }),
  ticket_prices: answer(['prices'], { general: true }),
  age_rules: answer(['age_rules'], { general: true }),
  socks: answer(['socks'], { general: true }),
  about_oto: answer(['about_oto'], { general: true }),
  faq: answer(['faq'], { general: true }),
  birthday_brochure: answer(null, {
    thenHandover: { templateKey: 'handover_birthday', route: 'birthdays', brochure: true },
  }),
  thanks_closing: answer(null, { mayAutoHandle: true }),
  birthday_party: handover('handover_birthday', 'birthdays', true),
  events_groups: handover('handover_events', 'birthdays'),
  discount_negotiation: handover('handover_general', 'keep'),
  custom_request: handover('handover_general', 'keep'),
  complaint_onsite: alone('handover_complaint_onsite', 'general'),
  complaint_online: alone('handover_complaint_online', 'marketing'),
  influencer_marketing: handover('handover_marketing', 'marketing'),
  nanny_booking: handover('handover_general', 'general'),
  lost_item: handover('handover_lost_found', 'general'),
  special_tickets: handover('handover_events', 'birthdays'),
  human_requested: alone('handover_general', 'keep'),
  // Answered in persona the first time; a second ask in the episode is a
  // handover (§B.4). The gate reads `episode.identityAnswered` for that.
  identity_question: answer(null),
  emotional_or_unclear: alone('handover_general', 'keep'),
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

/** Intents whose answer is a birthday one: the branch is never asked first (`inbox.md:76-79`). */
export const BIRTHDAY_INTENTS: ReadonlySet<AiIntent> = new Set<AiIntent>([
  'birthday_brochure',
  'birthday_party',
]);
