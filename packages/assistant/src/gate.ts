/**
 * The server's gates (PLAN §B.3) and the per-episode cap (§D.4 guard 3).
 *
 * `applyGates` turns the model's decision into what the server will do. The
 * model proposes; the intent table and the guards dispose. Every refusal is a
 * reason word and a rule id, never text.
 *
 * A burst can hold several parts (test night 2026-10-21, D1a and W2): the
 * model labels every intent it reads (`intents`, the primary first) and the
 * gate decides PER PART from the table. Every part answerable: one reply
 * that answers each. Some parts hand over: the answerable parts are answered
 * first, then the holding line for the rest (the brochure first when it is a
 * birthday brochure) — unless a part is person-first (a complaint, a refund,
 * an upset message, a request for a person), whose holding line stands
 * alone. Only `other` as the primary (spam, an injection, no question) is
 * silence.
 *
 * SCRUM-220, Tom's playbook (the FIRST rule):
 *   - a child currently in our care, or lost and found, is a SILENT
 *     hand-over to the branch: nothing is said, whatever else was asked;
 *   - a hand-over may carry ONE lead line of the model's own before the
 *     closing line (the complaint's apology, "Good question!"), checked
 *     against no source;
 *   - an answer part that cannot be answered (an event the knowledge does not
 *     hold, an invented discount, a nanny answer framed as "safer") goes to
 *     its fallback hand-over, never to silence;
 *   - another language is answered in English; the one language offer is
 *     checked against the contact's calling code and the episode;
 *   - unclear goes to the branch when it is known, else to the GM.
 *
 * SCRUM-817: in a birthday thread — a Birthdays & Events conversation, or
 * one whose earlier replies were about a party — a message that names a day,
 * a date or a time is the party's. A label of hours, faq, greeting or address
 * on it (with no birthday part beside it) is overruled to `birthday_details`:
 * the model's words, written for a walk-in question, never go, and the
 * Birthday & events team takes it with the birthday manager's closing line.
 * A silent or a person-first part anywhere in the burst keeps its own verdict.
 */

import { mentionsPartyDate, mentionsPartyTime } from '@oto/shared';
import { adviceAfterOpener, adviceAlone, adviceOverruledVerdict, birthdayAdviceOverrule, openerBesideAdvice } from './advice';
import {
  AI_REPLY_LANGUAGES,
  type AiDecision,
  type AiOutcomeReason,
  type AiReplyLanguage,
} from './decision';
import {
  bubbleGuard,
  busyGuard,
  faultGuard,
  framingGuard,
  languageOfferIn,
  latinScriptOnly,
  linkGuard,
  personaGuard,
  traceabilityGuard,
  type GuardResult,
} from './guards';
import {
  BIRTHDAY_DATE_OVERRULED,
  BIRTHDAY_INTENTS,
  BIRTHDAYS_PLAN,
  BY_BRANCH,
  CAP_HANDOVER,
  CARE_SERVICE_INTENTS,
  IDENTITY_SECOND_ASK,
  INTENT_TABLE,
  birthdayThreadOf,
  intentPartsOf,
  resolvePlan,
  type AiGroundingTopic,
  type AiHandoverPlan,
  type AiIntent,
  type AiPlanRef,
  type BirthdayThreadFacts,
} from './intents';
import type { AiBranchKey } from './decision';

/** One source the model may cite: a KB entry or a rendered live fact. */
export interface GroundingSource {
  key: string;
  topic: AiGroundingTopic;
  text: string;
}

/**
 * What the gate knows about the episode so far (A2 counts these from its
 * rows). SCRUM-817: the thread's category and the earlier replies' intents
 * (`BirthdayThreadFacts`) say whether it is a birthday thread; absent, it is not.
 */
export interface EpisodeState extends BirthdayThreadFacts {
  /** AI answers already sent in this episode. */
  aiAnswers: number;
  /** AI answers sent in the last ten minutes. */
  aiAnswersLast10Min: number;
  /** The identity question was already answered in persona this episode. */
  identityAnswered: boolean;
  /** The thread already has a branch. */
  threadHasBranch: boolean;
  /**
   * SCRUM-220 playbook: the calling code of the contact's phone, digits
   * without the plus (`7`, `66`), when known. Only `7` and `66` may be made
   * the one language offer. Absent: no offer is allowed.
   */
  contactCountryCode?: string | null;
  /** SCRUM-220 playbook: the language offer was already made this episode (an answer verdict's `languageOffer`). */
  languageOffered?: boolean;
}

/**
 * §D.4 guard 3. Raised from 4 / 3 on the test night (2026-10-21, W3): a
 * normal conversation — parking, the children's price, "and for adults?",
 * "what about on Saturday?" — hit the third-answer cap. Eight answers in ten
 * minutes still ends a ping-pong with another auto-responder; the episode
 * total rises with it, since a window of eight behind a total of four would
 * never be reached. The per-operator daily caps and the breaker are unchanged.
 */
export const EPISODE_ANSWER_CAP = 8;
export const EPISODE_WINDOW_CAP = 8;
export const EPISODE_WINDOW_MINUTES = 10;

/**
 * SCRUM-220 playbook: the language offer is made "early on" — in the first
 * or second answer of the episode, never later.
 */
export const LANGUAGE_OFFER_MAX_ANSWERS = 2;

/** The one language offer the playbook allows, by the contact's calling code. */
const OFFER_BY_COUNTRY: Readonly<Record<string, 'ru' | 'th'>> = { '7': 'ru', '66': 'th' };

export type GateVerdict =
  | {
      action: 'answer';
      reason: 'OK';
      /** The primary intent. */
      intent: AiIntent;
      /** Every part the reply covers, the primary first (`other` parts dropped). */
      intents: AiIntent[];
      language: AiReplyLanguage;
      bubbles: string[];
      groundingKeys: string[];
      /** Only the birthday brochure ever sends the brochure. */
      sendBrochure: boolean;
      /** The bubbles carry the branch question (general enquiry, no branch yet). */
      askBranch: boolean;
      branchNamed: AiBranchKey | null;
      /**
       * Hand over after the answer: a `birthday_brochure` or nanny answer, a
       * burst whose other parts hand over (D1a), or a hand-over's lead line
       * (SCRUM-220). The holding line follows the answer; the brochure, when
       * the plan says so, between them.
       */
      thenHandover: AiHandoverPlan | null;
      mayAutoHandle: boolean;
      /**
       * SCRUM-220 playbook: the bubbles make the one language offer (`ru`
       * for a +7 number, `th` for +66). The engine records it, so the next
       * turn's `EpisodeState.languageOffered` refuses a second one.
       */
      languageOffer: 'ru' | 'th' | null;
    }
  | {
      action: 'handover';
      /**
       * Why it is a handover: the table, an overruled answer, the cap, the
       * model's own call, or (SCRUM-817) a birthday thread's date read as the party's.
       */
      reason:
        'OK' | 'OVERRULED_HANDOVER' | 'OVERRULED_BIRTHDAY' | 'MODEL_HANDOVER' | 'IDENTITY_SECOND_ASK' | 'CAP_EPISODE';
      intent: AiIntent;
      intents: AiIntent[];
      language: AiReplyLanguage;
      plan: AiHandoverPlan;
      /**
       * The model's own holding words, already through the persona,
       * traceability and shape guards. A2 sends the verbatim template (G6
       * default) and uses these only where the template's language row still
       * needs translation (§C.5). May be empty.
       */
      holdingBubbles: string[];
      /**
       * Set when the model's own words failed a guard and were dropped: the
       * hand-over still happens (the template, or silence-with-handover), but
       * nothing unchecked rides it. Holds the failing guard's rule word.
       */
      droppedHoldingRule?: string;
      branchNamed: AiBranchKey | null;
    }
  | { action: 'silent'; reason: AiOutcomeReason; rule?: string; intent: AiIntent | null; intents: AiIntent[] }
  | {
      /**
       * SCRUM-220 playbook ("Message sources"): a child currently in our care,
       * or lost and found. Nothing the model wrote is said to the customer
       * (no answer, no lead line, no brochure); the thread is handed to the
       * team the plan routes to. The engine decides from the number's silence
       * policy whether the plan's closing line still goes (the main channels)
       * or nothing does (the branch numbers).
       */
      action: 'silent_handover';
      reason: 'SILENCE_POLICY';
      /** The silent part (`drop_off_care`, `lost_item`), whatever the primary. */
      intent: AiIntent;
      intents: AiIntent[];
      language: AiReplyLanguage;
      /** Where the thread goes; its template is the engine's to send or not. */
      plan: AiHandoverPlan;
      branchNamed: AiBranchKey | null;
    };

export interface GateInput {
  decision: AiDecision;
  /** Every source the prompt offered, by key (from `buildPrompt`). */
  grounding: ReadonlyMap<string, GroundingSource>;
  episode: EpisodeState;
  /**
   * SCRUM-817: the customer's open lines this turn answers (its burst), as
   * written. Read only for the birthday thread's date rule; absent, it never fires.
   */
  openLines?: readonly string[];
}

/** The rule word an overruled birthday date records (the turn's audit `gate`, the hand-over pill's `rule`). */
export const BIRTHDAY_DATE_RULE = 'birthday_date';

/**
 * SCRUM-817: the lines name a day, a date or a time, in Thai, English or
 * Russian — read by the same reader as the inbox's Book Date (SCRUM-814,
 * `@oto/shared` chat-dates): a date or a weekday ("в субботу", "Saturday",
 * "เสาร์นี้"), or a clock time ("в 2 часа дня", "2 pm", "บ่ายสอง").
 */
export function namesPartyDayOrTime(lines: readonly string[]): boolean {
  return lines.some((t) => mentionsPartyDate(t) || mentionsPartyTime(t));
}

/**
 * A part the party never outranks: a silent hand-over (a child in our care,
 * lost and found) or a person-first hand-over (a complaint, a refund, an
 * upset message, a request for a person), whose holding line stands alone.
 */
function outranksTheParty(intent: AiIntent): boolean {
  const rule = INTENT_TABLE[intent];
  return rule.action === 'silent_handover' || (rule.action === 'handover' && !rule.answerAlongside);
}

/**
 * SCRUM-817: the decision the gate reads instead of the model's, or null to
 * read the model's. In a birthday thread (`birthdayThreadOf`), a burst that
 * names a day, a date or a time, labelled hours, faq, greeting or address
 * with no birthday part beside it, is the party's: those labels become
 * `birthday_details`. Its words were written for a walk-in question, so none
 * go, and the decision is a hand-over. A burst the model already read as a
 * birthday one keeps its labels: the date is that part's. A burst with a
 * silent or a person-first part, wherever it sits, keeps the model's
 * verdict. Any other thread is never touched.
 */
export function birthdayDateOverrule(input: GateInput): AiDecision | null {
  const d = input.decision;
  if (birthdayThreadOf(input.episode) === null) return null;
  const labelled = intentPartsOf(d);
  if (labelled.some((i) => BIRTHDAY_INTENTS.has(i))) return null;
  // A silent hand-over or a person-first part, wherever it sits: the model's
  // verdict stands. The gate's own rules already keep the other parts'
  // answers off such a reply (at most one guard-checked lead line rides, the
  // complaint's apology) and keep its route.
  if (labelled.some(outranksTheParty)) return null;
  if (!labelled.some((i) => BIRTHDAY_DATE_OVERRULED.has(i))) return null;
  if (!namesPartyDayOrTime(input.openLines ?? [])) return null;
  const parts: AiIntent[] = [];
  for (const i of labelled) {
    const part: AiIntent = BIRTHDAY_DATE_OVERRULED.has(i) ? 'birthday_details' : i;
    if (!parts.includes(part)) parts.push(part);
  }
  return { ...d, intent: parts[0]!, intents: parts, action: 'handover', bubbles: [], sendBrochure: false, askBranch: false };
}

const isBirthdaysPlan = (p: AiHandoverPlan) =>
  p.templateKey === BIRTHDAYS_PLAN.templateKey && p.route === BIRTHDAYS_PLAN.route && p.brochure === BIRTHDAYS_PLAN.brochure;

/**
 * The server's verdict on the model's decision. SCRUM-817 first: a birthday
 * thread's date the model read as a walk-in question is decided as the
 * party's (`birthdayDateOverrule`), and the Birthday & events hand-over it
 * becomes says why (`OVERRULED_BIRTHDAY`, rule `birthday_date`). A part that
 * outranks it keeps its own verdict wherever it sits in the burst: a child in
 * our care or lost and found (the silent hand-over), and a person-first part
 * (a complaint with its one apology, a refund, an upset message, a request
 * for a person), which goes to its own team as it would in any thread.
 */
export function applyGates(input: GateInput): GateVerdict {
  const overruled = birthdayDateOverrule(input);
  // SCRUM-823: then an advice question the model labelled details or faq in a
  // birthday thread is `birthday_advice` (advice.ts): beside the opener, the
  // opener is answered and the birthday manager's line follows; otherwise it
  // is handed over alone. A guard on the opener's words never makes it silence.
  const advice = birthdayAdviceOverrule(overruled === null ? input : { ...input, decision: overruled });
  const read = advice ?? overruled ?? input.decision;
  const opener = openerBesideAdvice(read);
  if (opener !== null) {
    return (
      adviceAfterOpener(gate({ ...input, decision: opener }), intentPartsOf(read)) ??
      adviceOverruledVerdict(gate({ ...input, decision: adviceAlone({ ...read, intent: 'birthday_advice' }) }))
    );
  }
  if (advice !== null) return adviceOverruledVerdict(gate({ ...input, decision: advice }));
  if (overruled === null) return gate(input);
  const v = gate({ ...input, decision: overruled });
  if (v.action !== 'handover' || !isBirthdaysPlan(v.plan)) return v;
  return { ...v, reason: 'OVERRULED_BIRTHDAY', holdingBubbles: [], droppedHoldingRule: BIRTHDAY_DATE_RULE };
}

function isReplyLanguage(lang: string): lang is AiReplyLanguage {
  return (AI_REPLY_LANGUAGES as readonly string[]).includes(lang);
}

export type Failed = { reason: AiOutcomeReason; rule: string };

const fail = (r: GuardResult<AiOutcomeReason>): Failed | null => (r.ok ? null : { reason: r.reason, rule: r.rule });

/**
 * The words that ride a hand-over — the holding words and a lead line — cite
 * nothing, so every check runs against no source: any number, date, link,
 * promise or busy word is ungrounded, and none may admit fault. "We'll
 * refund you" can never ride a hand-over. Under language `other` they must be
 * English. Gates 3, 5, 6 and 7 for words with no grounding.
 */
export function holdingFailure(bubbles: readonly string[], min: number, english: boolean): Failed | null {
  return (
    fail(bubbleGuard(bubbles, min)) ??
    fail(personaGuard(bubbles)) ??
    fail(traceabilityGuard(bubbles, [])) ??
    fail(busyGuard(bubbles, [])) ??
    fail(linkGuard(bubbles, [])) ??
    fail(faultGuard(bubbles)) ??
    (english && !latinScriptOnly(bubbles) ? { reason: 'LANGUAGE', rule: 'not_english' } : null)
  );
}

/**
 * A price source kept for a park other than `named` (SCRUM-669): another
 * park's live price fact (`fact.prices.<park>`), or a price note filed for
 * that park (`<key>@<park>`).
 */
function priceSourceOfOtherPark(s: GroundingSource, named: AiBranchKey): boolean {
  const fact = /^fact\.prices\.(.+)$/.exec(s.key);
  if (fact) return fact[1] !== named;
  if (s.topic !== 'prices' && s.topic !== 'prices_note') return false;
  const at = s.key.lastIndexOf('@');
  return at !== -1 && s.key.slice(at + 1) !== named;
}

export function episodeCapReached(episode: EpisodeState): boolean {
  return (
    episode.aiAnswers >= EPISODE_ANSWER_CAP || episode.aiAnswersLast10Min >= EPISODE_WINDOW_CAP
  );
}

/** One part of the burst, as the table reads it for this episode. */
type Part =
  | { intent: AiIntent; kind: 'answer'; rule: Extract<AiIntentRule, { action: 'answer' }> }
  | {
      intent: AiIntent;
      kind: 'handover';
      plan: AiPlanRef;
      answerAlongside: boolean;
      lead: boolean;
      secondAsk: boolean;
    }
  | { intent: AiIntent; kind: 'silent_handover'; plan: AiHandoverPlan };
type AiIntentRule = (typeof INTENT_TABLE)[AiIntent];

function partOf(intent: AiIntent, episode: EpisodeState): Part | null {
  const rule = INTENT_TABLE[intent];
  if (rule.action === 'silent') return null;
  if (rule.action === 'silent_handover') return { intent, kind: 'silent_handover', plan: rule.plan };
  if (rule.action === 'handover') {
    return {
      intent,
      kind: 'handover',
      plan: rule.plan,
      answerAlongside: rule.answerAlongside,
      lead: rule.lead,
      secondAsk: false,
    };
  }
  // §B.4: the identity question is answered in persona once; a second ask is a handover.
  if (intent === 'identity_question' && episode.identityAnswered) {
    return {
      intent,
      kind: 'handover',
      plan: IDENTITY_SECOND_ASK,
      answerAlongside: true,
      lead: false,
      secondAsk: true,
    };
  }
  return { intent, kind: 'answer', rule };
}

function gate({ decision: d, grounding, episode }: GateInput): GateVerdict {
  const labelled = intentPartsOf(d);
  const primary = labelled[0]!;
  const silent = (reason: AiOutcomeReason, rule?: string): GateVerdict =>
    rule === undefined
      ? { action: 'silent', reason, intent: primary, intents: labelled }
      : { action: 'silent', reason, intent: primary, intents: labelled, rule };

  // `other` as the primary is silence whatever the model says (spam, an
  // injection, no question). An `other` beside real parts is dropped.
  if (INTENT_TABLE[primary].action === 'silent') return silent('INTENT_SILENT');
  const parts = labelled.map((i) => partOf(i, episode)).filter((p): p is Part => p !== null);
  const intents = parts.map((p) => p.intent);

  // Gate 3, since SCRUM-220 (the playbook's "Languages"): th, en and ru are
  // answered in their own language; any other language is answered in
  // ENGLISH, never left in silence.
  const english = !isReplyLanguage(d.language);
  const language: AiReplyLanguage = isReplyLanguage(d.language) ? d.language : 'en';
  const branchKnown = episode.threadHasBranch || d.branchNamed !== null;
  const plan = (ref: AiPlanRef) => resolvePlan(ref, branchKnown);

  // The playbook's silent hand-over: a child in our care, or lost and found.
  // Nothing the model wrote reaches the customer, whatever else was asked —
  // only staff on the floor can answer it. `intent` names the part that made
  // it silent (what a number's silence policy is keyed by); `intents` keeps
  // every part the burst held.
  const quiet = parts.find((p): p is Extract<Part, { kind: 'silent_handover' }> => p.kind === 'silent_handover');
  if (quiet) {
    return {
      action: 'silent_handover',
      reason: 'SILENCE_POLICY',
      intent: quiet.intent,
      intents,
      language,
      plan: quiet.plan,
      branchNamed: d.branchNamed,
    };
  }

  /** A hand-over; the model's words ride only as checked holding words. */
  const handover = (
    words: readonly string[],
    to: AiHandoverPlan,
    reason: Extract<GateVerdict, { action: 'handover' }>['reason'],
    dropped?: string,
  ): GateVerdict => {
    // A failing guard must never cancel the hand-over itself: a customer who
    // needs a person still gets one, and the thread still re-routes. The
    // model's words are simply dropped, so nothing unchecked rides the
    // hand-over — the template (or a silent hand-over, where no template is
    // ready) takes their place.
    const droppedRule = dropped ?? holdingFailure(words, 0, english)?.rule;
    return {
      action: 'handover',
      reason,
      intent: primary,
      intents,
      language,
      plan: to,
      holdingBubbles: droppedRule === undefined ? [...words] : [],
      ...(droppedRule === undefined ? {} : { droppedHoldingRule: droppedRule }),
      branchNamed: d.branchNamed,
    };
  };

  /**
   * A hand-over's lead line (SCRUM-220 playbook): exactly one bubble of the
   * model's own, checked against no source, then the closing line. Null when
   * there is none or it fails a guard: the closing line then goes alone.
   */
  const leadLine = (to: AiHandoverPlan): GateVerdict | null => {
    if (d.bubbles.length !== 1) return null;
    if (holdingFailure(d.bubbles, 1, english)) return null;
    return {
      action: 'answer',
      reason: 'OK',
      intent: primary,
      intents,
      language,
      bubbles: [...d.bubbles],
      groundingKeys: [],
      sendBrochure: to.brochure,
      askBranch: false,
      branchNamed: d.branchNamed,
      thenHandover: to,
      mayAutoHandle: false,
      languageOffer: null,
    };
  };

  const answers = parts.filter((p): p is Extract<Part, { kind: 'answer' }> => p.kind === 'answer');
  const handovers = parts.filter((p): p is Extract<Part, { kind: 'handover' }> => p.kind === 'handover');
  const lead = handovers[0] ?? null;

  // Every part hands over: a handover whatever action the model chose — the
  // server overrules an `answer`, and a model `silent` still hands over,
  // because handing over is the safe direction (§B.3). A lead line, when the
  // part has one and the model wrote it, goes first.
  if (answers.length === 0 && lead) {
    const to = plan(lead.plan);
    const withLead = lead.lead ? leadLine(to) : null;
    if (withLead) return withLead;
    const reason = lead.secondAsk ? 'IDENTITY_SECOND_ASK' : d.action === 'answer' ? 'OVERRULED_HANDOVER' : 'OK';
    return handover(d.bubbles, to, reason);
  }

  // A person-first part (a complaint, a refund, an upset message, a request
  // for a person): the holding line stands alone, and the model's bubbles —
  // answers to the other parts — never ride it. Only a complaint's one
  // apology may go first.
  const alone = handovers.find((h) => !h.answerAlongside);
  if (alone) {
    const to = plan(alone.plan);
    const withLead = alone.lead ? leadLine(to) : null;
    if (withLead) return withLead;
    return handover([], to, d.action === 'answer' ? 'OVERRULED_HANDOVER' : 'OK');
  }

  // From here at least one part is answerable, and any hand-over part is
  // answered alongside. A part with a fallback (an event, the Golden Ticket,
  // a price objection, a nanny question) goes there when it cannot be
  // answered — never to silence.
  const fallback = answers.find((p) => p.rule.fallback !== null)?.rule.fallback ?? null;
  const overruled = (failed: Failed): GateVerdict | null =>
    fallback ? handover([], plan(fallback.plan), 'OVERRULED_HANDOVER', failed.rule) : null;

  if (d.action === 'silent') return silent('MODEL_SILENT');
  // The model wants a person: honour it (safe direction), with the hand-over
  // part's own plan when the burst has one, else the answer part's fallback
  // (with its lead line, "Amazing!", when it has one), else the unclear one.
  if (d.action === 'handover') {
    if (lead) return handover(d.bubbles, plan(lead.plan), 'OK');
    if (fallback) {
      const to = plan(fallback.plan);
      return (fallback.lead ? leadLine(to) : null) ?? handover(d.bubbles, to, 'OK');
    }
    return handover(d.bubbles, plan(BY_BRANCH), 'MODEL_HANDOVER');
  }

  // Gate 2: sure.
  if (d.certainty !== 'sure') return silent('UNSURE');

  // §D.4 guard 3: the episode cap turns a would-be answer into a handover.
  if (episodeCapReached(episode)) {
    return handover([], lead ? plan(lead.plan) : CAP_HANDOVER, 'CAP_EPISODE');
  }

  // Gate 4: every cited key is one the prompt offered, and each factual part
  // cites at least one key of its own topic.
  const cited: GroundingSource[] = [];
  for (const key of d.grounding) {
    const source = grounding.get(key);
    if (!source) return overruled({ reason: 'GROUNDING_UNKNOWN', rule: 'grounding' }) ?? silent('GROUNDING_UNKNOWN');
    cited.push(source);
  }
  for (const part of answers) {
    const topics = part.rule.groundingTopics;
    if (topics === null) continue;
    if (cited.length === 0) return overruled({ reason: 'GROUNDING_MISSING', rule: 'grounding' }) ?? silent('GROUNDING_MISSING');
    if (!cited.some((s) => topics.includes(s.topic))) {
      return overruled({ reason: 'GROUNDING_TOPIC', rule: 'grounding' }) ?? silent('GROUNDING_TOPIC');
    }
  }

  // SCRUM-669: the customer named one park, so the reply's prices are that
  // park's. The number guard cannot see a park mismatch (Central's 690 is a
  // grounded number), so a cited price source of ANOTHER park — its live
  // price fact, or a price note kept for it — refuses the reply.
  const named = d.branchNamed;
  if (named !== null && cited.some((s) => priceSourceOfOtherPark(s, named))) {
    return overruled({ reason: 'GUARD_PARK', rule: 'park' }) ?? silent('GUARD_PARK', 'park');
  }

  // Gate 7, then 6, then 5, over the whole reply; then the playbook's own
  // guards: never busy, only cited links, the care services never "safer",
  // English for another language, and the one language offer.
  const texts = cited.map((s) => s.text);
  const failed =
    fail(bubbleGuard(d.bubbles, 1)) ??
    fail(personaGuard(d.bubbles)) ??
    fail(traceabilityGuard(d.bubbles, texts)) ??
    fail(busyGuard(d.bubbles, texts)) ??
    fail(linkGuard(d.bubbles, texts)) ??
    (intents.some((i) => CARE_SERVICE_INTENTS.has(i)) ? fail(framingGuard(d.bubbles)) : null) ??
    (english && !latinScriptOnly(d.bubbles) ? { reason: 'LANGUAGE' as const, rule: 'not_english' } : null);
  if (failed) return overruled(failed) ?? silent(failed.reason, failed.rule);

  const offer = languageOfferIn(d.bubbles);
  if (offer !== null) {
    const allowed =
      offer !== 'menu' &&
      d.language === 'en' &&
      episode.contactCountryCode != null &&
      OFFER_BY_COUNTRY[episode.contactCountryCode] === offer &&
      episode.languageOffered !== true &&
      episode.aiAnswers < LANGUAGE_OFFER_MAX_ANSWERS;
    if (!allowed) return overruled({ reason: 'GUARD_LANGUAGE', rule: 'language_menu' }) ?? silent('GUARD_LANGUAGE', 'language_menu');
  }

  // The hand-over after the answer: the burst's hand-over part, else the
  // answer's own (birthday_brochure, nanny_booking).
  const thenRef: AiPlanRef | null = lead?.plan ?? answers.find((p) => p.rule.thenHandover !== null)?.rule.thenHandover ?? null;
  const thenHandover = thenRef === null ? null : plan(thenRef);
  const birthday = intents.some((i) => BIRTHDAY_INTENTS.has(i));
  return {
    action: 'answer',
    reason: 'OK',
    intent: primary,
    intents,
    language,
    bubbles: [...d.bubbles],
    groundingKeys: cited.map((s) => s.key),
    sendBrochure: thenHandover?.brochure ?? false,
    // The park question only on a general enquiry with no branch, never
    // beside a birthday, and never when a colleague is about to take over.
    askBranch:
      d.askBranch &&
      answers.some((p) => p.rule.general) &&
      !episode.threadHasBranch &&
      !birthday &&
      thenHandover === null,
    branchNamed: d.branchNamed,
    thenHandover,
    mayAutoHandle: thenHandover === null && answers.every((p) => p.rule.mayAutoHandle),
    languageOffer: offer === 'ru' || offer === 'th' ? offer : null,
  };
}
