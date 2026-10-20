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
 * birthday) — unless a part is person-first (a complaint, an upset message,
 * a request for a person), whose holding line stands alone. Only `other` as
 * the primary (spam, an injection, no question) is silence.
 */

import {
  AI_REPLY_LANGUAGES,
  type AiDecision,
  type AiOutcomeReason,
  type AiReplyLanguage,
} from './decision';
import { bubbleGuard, personaGuard, traceabilityGuard } from './guards';
import {
  BIRTHDAY_INTENTS,
  CAP_HANDOVER,
  IDENTITY_SECOND_ASK,
  INTENT_TABLE,
  intentPartsOf,
  type AiGroundingTopic,
  type AiHandoverPlan,
  type AiIntent,
} from './intents';
import type { AiBranchKey } from './decision';

/** One source the model may cite: a KB entry or a rendered live fact. */
export interface GroundingSource {
  key: string;
  topic: AiGroundingTopic;
  text: string;
}

/** What the gate knows about the episode so far (A2 counts these from its rows). */
export interface EpisodeState {
  /** AI answers already sent in this episode. */
  aiAnswers: number;
  /** AI answers sent in the last ten minutes. */
  aiAnswersLast10Min: number;
  /** The identity question was already answered in persona this episode. */
  identityAnswered: boolean;
  /** The thread already has a branch. */
  threadHasBranch: boolean;
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
      /** Only birthday intents ever send the brochure. */
      sendBrochure: boolean;
      /** The bubbles carry the branch question (general enquiry, no branch yet). */
      askBranch: boolean;
      branchNamed: AiBranchKey | null;
      /**
       * Hand over after the answer: a `birthday_brochure` answer, or a burst
       * whose other parts hand over (D1a). The holding line follows the
       * answer; the brochure, when the plan says so, between them.
       */
      thenHandover: AiHandoverPlan | null;
      mayAutoHandle: boolean;
    }
  | {
      action: 'handover';
      /** Why it is a handover: the table, an overruled answer, the cap, or the model's own call. */
      reason:
        'OK' | 'OVERRULED_HANDOVER' | 'MODEL_HANDOVER' | 'IDENTITY_SECOND_ASK' | 'CAP_EPISODE';
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
       * Set when the model's own holding words failed a guard and were dropped:
       * the hand-over still happens (the template, or silence-with-handover),
       * but nothing unchecked rides it. Holds the failing guard's rule word.
       */
      droppedHoldingRule?: string;
      branchNamed: AiBranchKey | null;
    }
  | { action: 'silent'; reason: AiOutcomeReason; rule?: string; intent: AiIntent | null; intents: AiIntent[] };

export interface GateInput {
  decision: AiDecision;
  /** Every source the prompt offered, by key (from `buildPrompt`). */
  grounding: ReadonlyMap<string, GroundingSource>;
  episode: EpisodeState;
}

function isReplyLanguage(lang: string): lang is AiReplyLanguage {
  return (AI_REPLY_LANGUAGES as readonly string[]).includes(lang);
}

/** Gates 3, 5 (on the bubbles alone), 6 and 7 for a handover's holding words. */
function handover(
  d: AiDecision,
  intents: AiIntent[],
  language: AiReplyLanguage,
  plan: AiHandoverPlan,
  reason: Extract<GateVerdict, { action: 'handover' }>['reason'],
): GateVerdict {
  // A failing guard must never cancel the hand-over itself: a customer who
  // needs a person still gets one, and the thread still re-routes. The model's
  // words are simply dropped, so nothing unchecked rides the hand-over - the
  // template (or a silent hand-over, where no template is ready) takes their
  // place. A holding line cites nothing, so any number, date or promise word
  // in it is ungrounded: "we'll refund you" can never ride a handover.
  const bubbles = d.bubbles;
  const shape = bubbleGuard(bubbles, 0);
  const persona = shape.ok ? personaGuard(bubbles) : shape;
  const trace = persona.ok ? traceabilityGuard(bubbles, []) : persona;
  const failed = !shape.ok ? shape : !persona.ok ? persona : !trace.ok ? trace : null;
  return {
    action: 'handover',
    reason,
    intent: intents[0]!,
    intents,
    language,
    plan,
    holdingBubbles: failed ? [] : [...bubbles],
    ...(failed ? { droppedHoldingRule: failed.rule } : {}),
    branchNamed: d.branchNamed,
  };
}

export function episodeCapReached(episode: EpisodeState): boolean {
  return (
    episode.aiAnswers >= EPISODE_ANSWER_CAP || episode.aiAnswersLast10Min >= EPISODE_WINDOW_CAP
  );
}

/** One part of the burst, as the table reads it for this episode. */
type Part =
  | { intent: AiIntent; kind: 'answer'; rule: Extract<AiIntentRule, { action: 'answer' }> }
  | { intent: AiIntent; kind: 'handover'; plan: AiHandoverPlan; answerAlongside: boolean; secondAsk: boolean };
type AiIntentRule = (typeof INTENT_TABLE)[AiIntent];

function partOf(intent: AiIntent, episode: EpisodeState): Part | null {
  const rule = INTENT_TABLE[intent];
  if (rule.action === 'silent') return null;
  if (rule.action === 'handover') {
    return { intent, kind: 'handover', plan: rule.plan, answerAlongside: rule.answerAlongside, secondAsk: false };
  }
  // §B.4: the identity question is answered in persona once; a second ask is a handover.
  if (intent === 'identity_question' && episode.identityAnswered) {
    return { intent, kind: 'handover', plan: IDENTITY_SECOND_ASK, answerAlongside: true, secondAsk: true };
  }
  return { intent, kind: 'answer', rule };
}

export function applyGates({ decision: d, grounding, episode }: GateInput): GateVerdict {
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

  // Gate 3: only th, en, ru are ever answered or held (G8).
  if (!isReplyLanguage(d.language)) return silent('LANGUAGE');
  const language = d.language;

  const answers = parts.filter((p): p is Extract<Part, { kind: 'answer' }> => p.kind === 'answer');
  const handovers = parts.filter((p): p is Extract<Part, { kind: 'handover' }> => p.kind === 'handover');
  const lead = handovers[0] ?? null;

  // Every part hands over: a handover whatever action the model chose — the
  // server overrules an `answer`, and a model `silent` still hands over,
  // because handing over is the safe direction (§B.3).
  if (answers.length === 0 && lead) {
    const reason = lead.secondAsk ? 'IDENTITY_SECOND_ASK' : d.action === 'answer' ? 'OVERRULED_HANDOVER' : 'OK';
    return handover(d, intents, language, lead.plan, reason);
  }

  // A person-first part (a complaint, an upset message, a request for a
  // person): the holding line stands alone, and the model's bubbles — answers
  // to the other parts — never ride it.
  const alone = handovers.find((h) => !h.answerAlongside);
  if (alone) {
    return handover({ ...d, bubbles: [] }, intents, language, alone.plan, d.action === 'answer' ? 'OVERRULED_HANDOVER' : 'OK');
  }

  // From here at least one part is answerable, and any hand-over part is
  // answered alongside.
  if (d.action === 'silent') return silent('MODEL_SILENT');
  // The model wants a person: honour it (safe direction), with the hand-over
  // part's own plan when the burst has one.
  if (d.action === 'handover') {
    return lead
      ? handover(d, intents, language, lead.plan, 'OK')
      : handover(d, intents, language, CAP_HANDOVER, 'MODEL_HANDOVER');
  }

  // Gate 2: sure.
  if (d.certainty !== 'sure') return silent('UNSURE');

  // §D.4 guard 3: the episode cap turns a would-be answer into a handover.
  if (episodeCapReached(episode)) {
    return handover({ ...d, bubbles: [] }, intents, language, lead?.plan ?? CAP_HANDOVER, 'CAP_EPISODE');
  }

  // Gate 4: every cited key is one the prompt offered, and each factual part
  // cites at least one key of its own topic.
  const cited: GroundingSource[] = [];
  for (const key of d.grounding) {
    const source = grounding.get(key);
    if (!source) return silent('GROUNDING_UNKNOWN');
    cited.push(source);
  }
  for (const part of answers) {
    const topics = part.rule.groundingTopics;
    if (topics === null) continue;
    if (cited.length === 0) return silent('GROUNDING_MISSING');
    if (!cited.some((s) => topics.includes(s.topic))) return silent('GROUNDING_TOPIC');
  }

  // Gate 7, then 6, then 5, over the whole reply.
  const shape = bubbleGuard(d.bubbles, 1);
  if (!shape.ok) return silent(shape.reason, shape.rule);
  const persona = personaGuard(d.bubbles);
  if (!persona.ok) return silent(persona.reason, persona.rule);
  const trace = traceabilityGuard(
    d.bubbles,
    cited.map((s) => s.text),
  );
  if (!trace.ok) return silent(trace.reason, trace.rule);

  // The hand-over after the answer: the burst's hand-over part, else the
  // answer's own (birthday_brochure).
  const thenHandover: AiHandoverPlan | null =
    lead?.plan ?? answers.find((p) => p.rule.thenHandover !== null)?.rule.thenHandover ?? null;
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
  };
}
