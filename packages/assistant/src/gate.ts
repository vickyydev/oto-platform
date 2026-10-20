/**
 * The server's gates (PLAN §B.3) and the per-episode cap (§D.4 guard 3).
 *
 * `applyGates` turns the model's decision into what the server will do. The
 * model proposes; the intent table and the guards dispose. Every refusal is a
 * reason word and a rule id, never text.
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

/** §D.4 guard 3. */
export const EPISODE_ANSWER_CAP = 4;
export const EPISODE_WINDOW_CAP = 3;
export const EPISODE_WINDOW_MINUTES = 10;

export type GateVerdict =
  | {
      action: 'answer';
      reason: 'OK';
      intent: AiIntent;
      language: AiReplyLanguage;
      bubbles: string[];
      groundingKeys: string[];
      /** Only birthday intents ever send the brochure. */
      sendBrochure: boolean;
      /** The bubbles carry the branch question (general enquiry, no branch yet). */
      askBranch: boolean;
      branchNamed: AiBranchKey | null;
      /** Hand over after the answer (birthday_brochure). */
      thenHandover: AiHandoverPlan | null;
      mayAutoHandle: boolean;
    }
  | {
      action: 'handover';
      /** Why it is a handover: the table, an overruled answer, the cap, or the model's own call. */
      reason:
        'OK' | 'OVERRULED_HANDOVER' | 'MODEL_HANDOVER' | 'IDENTITY_SECOND_ASK' | 'CAP_EPISODE';
      intent: AiIntent;
      language: AiReplyLanguage;
      plan: AiHandoverPlan;
      /**
       * The model's own holding words, already through the persona,
       * traceability and shape guards. A2 sends the verbatim template (G6
       * default) and uses these only where the template's language row still
       * needs translation (§C.5). May be empty.
       */
      holdingBubbles: string[];
      branchNamed: AiBranchKey | null;
    }
  | { action: 'silent'; reason: AiOutcomeReason; rule?: string; intent: AiIntent | null };

export interface GateInput {
  decision: AiDecision;
  /** Every source the prompt offered, by key (from `buildPrompt`). */
  grounding: ReadonlyMap<string, GroundingSource>;
  episode: EpisodeState;
}

const silent = (reason: AiOutcomeReason, intent: AiIntent | null, rule?: string): GateVerdict =>
  rule === undefined
    ? { action: 'silent', reason, intent }
    : { action: 'silent', reason, intent, rule };

function isReplyLanguage(lang: string): lang is AiReplyLanguage {
  return (AI_REPLY_LANGUAGES as readonly string[]).includes(lang);
}

/** Gates 3, 5 (on the bubbles alone), 6 and 7 for a handover's holding words. */
function handover(
  d: AiDecision,
  language: AiReplyLanguage,
  plan: AiHandoverPlan,
  reason: Extract<GateVerdict, { action: 'handover' }>['reason'],
): GateVerdict {
  const bubbles = d.bubbles;
  const shape = bubbleGuard(bubbles, 0);
  if (!shape.ok) return silent(shape.reason, d.intent, shape.rule);
  const persona = personaGuard(bubbles);
  if (!persona.ok) return silent(persona.reason, d.intent, persona.rule);
  // A holding line cites nothing, so any number, date or promise word in it
  // is ungrounded: "we'll refund you" can never ride a handover.
  const trace = traceabilityGuard(bubbles, []);
  if (!trace.ok) return silent(trace.reason, d.intent, trace.rule);
  return {
    action: 'handover',
    reason,
    intent: d.intent,
    language,
    plan,
    holdingBubbles: [...bubbles],
    branchNamed: d.branchNamed,
  };
}

export function episodeCapReached(episode: EpisodeState): boolean {
  return (
    episode.aiAnswers >= EPISODE_ANSWER_CAP || episode.aiAnswersLast10Min >= EPISODE_WINDOW_CAP
  );
}

export function applyGates({ decision: d, grounding, episode }: GateInput): GateVerdict {
  const rule = INTENT_TABLE[d.intent];

  // `other` is silence whatever the model says.
  if (rule.action === 'silent') return silent('INTENT_SILENT', d.intent);

  // Gate 3: only th, en, ru are ever answered or held (G8).
  if (!isReplyLanguage(d.language)) return silent('LANGUAGE', d.intent);
  const language = d.language;

  // A handover intent is a handover, whatever action the model chose: the
  // server overrules an `answer`, and a model `silent` still hands over,
  // because handing over is the safe direction (§B.3).
  if (rule.action === 'handover') {
    return handover(d, language, rule.plan, d.action === 'answer' ? 'OVERRULED_HANDOVER' : 'OK');
  }

  // From here the intent's action is `answer`.
  if (d.intent === 'identity_question' && episode.identityAnswered) {
    return handover(d, language, IDENTITY_SECOND_ASK, 'IDENTITY_SECOND_ASK');
  }
  if (d.action === 'silent') return silent('MODEL_SILENT', d.intent);
  // The model wants a person on an answerable intent: honour it (safe direction).
  if (d.action === 'handover') return handover(d, language, CAP_HANDOVER, 'MODEL_HANDOVER');

  // Gate 2: sure.
  if (d.certainty !== 'sure') return silent('UNSURE', d.intent);

  // §D.4 guard 3: the episode cap turns a would-be answer into a handover.
  if (episodeCapReached(episode))
    return handover({ ...d, bubbles: [] }, language, CAP_HANDOVER, 'CAP_EPISODE');

  // Gate 4: a factual intent cites at least one known key of its own topic.
  const cited: GroundingSource[] = [];
  for (const key of d.grounding) {
    const source = grounding.get(key);
    if (!source) return silent('GROUNDING_UNKNOWN', d.intent);
    cited.push(source);
  }
  if (rule.groundingTopics !== null) {
    if (cited.length === 0) return silent('GROUNDING_MISSING', d.intent);
    const topics = rule.groundingTopics;
    if (!cited.some((s) => topics.includes(s.topic))) return silent('GROUNDING_TOPIC', d.intent);
  }

  // Gate 7, then 6, then 5.
  const shape = bubbleGuard(d.bubbles, 1);
  if (!shape.ok) return silent(shape.reason, d.intent, shape.rule);
  const persona = personaGuard(d.bubbles);
  if (!persona.ok) return silent(persona.reason, d.intent, persona.rule);
  const trace = traceabilityGuard(
    d.bubbles,
    cited.map((s) => s.text),
  );
  if (!trace.ok) return silent(trace.reason, d.intent, trace.rule);

  return {
    action: 'answer',
    reason: 'OK',
    intent: d.intent,
    language,
    bubbles: [...d.bubbles],
    groundingKeys: cited.map((s) => s.key),
    sendBrochure: rule.thenHandover?.brochure ?? false,
    askBranch:
      d.askBranch && rule.general && !episode.threadHasBranch && !BIRTHDAY_INTENTS.has(d.intent),
    branchNamed: d.branchNamed,
    thenHandover: rule.thenHandover,
    mayAutoHandle: rule.mayAutoHandle,
  };
}
