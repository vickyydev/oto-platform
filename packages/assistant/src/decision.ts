/**
 * The one structured answer a turn's model call returns (PLAN §B.1).
 *
 * Written against `zod/v4` because the SDK's structured-output helper
 * (`betaZodOutputFormat`) converts a v4 schema to the JSON schema the API
 * constrains decoding with. The workspace's `zod@3.25` ships `zod/v4`.
 */

import { z } from 'zod/v4';
import { AI_INTENTS } from './intents';

/** Languages the model may report. Anything but th/en/ru is silence (gate 3, G8). */
export const AI_LANGUAGES = ['th', 'en', 'ru', 'other'] as const;
export type AiLanguage = (typeof AI_LANGUAGES)[number];
export const AI_REPLY_LANGUAGES = ['th', 'en', 'ru'] as const;
export type AiReplyLanguage = (typeof AI_REPLY_LANGUAGES)[number];

/** The branches the customer can name (the brief's two parks). */
export const AI_BRANCH_KEYS = ['central', 'chalong'] as const;
export type AiBranchKey = (typeof AI_BRANCH_KEYS)[number];

/**
 * The model's own reason, a word for the audit and never prose (§B.1). The
 * server's outcome reasons are `AI_OUTCOME_REASONS` below.
 */
export const AI_REASON_CODES = [
  'CLEAR_INTENT',
  'FACT_IN_KB',
  'FACT_MISSING',
  'NEEDS_PERSON',
  'OUT_OF_SCOPE',
  'UNCLEAR',
  'MIXED_INTENTS',
  'NO_TEXT',
  'LANGUAGE_UNSUPPORTED',
  'GREETING_ONLY',
  'CLOSING',
] as const;
export type AiReasonCode = (typeof AI_REASON_CODES)[number];

/** Hard bounds on bubbles (§B.1 schema, gate 7). */
export const MAX_BUBBLES = 3;
export const MAX_BUBBLE_CHARS = 400;
/** Gate 7's total-length bound: three full bubbles would be a wall of text. */
export const MAX_TOTAL_CHARS = 900;
export const MAX_GROUNDING_KEYS = 8;

export const AiDecisionSchema = z.object({
  language: z.enum(AI_LANGUAGES),
  intent: z.enum(AI_INTENTS),
  certainty: z.enum(['sure', 'unsure']),
  action: z.enum(['answer', 'handover', 'silent']),
  /** KB entry keys and catalog facts the answer rests on. Required for a factual answer. */
  grounding: z.array(z.string()).max(MAX_GROUNDING_KEYS),
  /** 1–3 short chat bubbles, in the customer's language. Empty for silent. */
  bubbles: z.array(z.string().min(1).max(MAX_BUBBLE_CHARS)).max(MAX_BUBBLES),
  sendBrochure: z.boolean(),
  /** Set when the customer named a park in this burst. */
  branchNamed: z.enum(AI_BRANCH_KEYS).nullable(),
  askBranch: z.boolean(),
  reason: z.enum(AI_REASON_CODES),
});
export type AiDecision = z.infer<typeof AiDecisionSchema>;

/**
 * Every word a turn can end with: the gates' words, the provider's failure
 * words and the caps. A turn row's `reason` column holds one of these (or a
 * model reason), never prose (§D.1).
 */
export const AI_OUTCOME_REASONS = [
  'OK',
  // gates (§B.3)
  'INTENT_SILENT',
  'MODEL_SILENT',
  'MODEL_HANDOVER',
  'UNSURE',
  'LANGUAGE',
  'GROUNDING_MISSING',
  'GROUNDING_UNKNOWN',
  'GROUNDING_TOPIC',
  'GUARD_NUMBER',
  'GUARD_DATE',
  'GUARD_PROMISE',
  'GUARD_PERSONA',
  'GUARD_BUBBLES',
  'GUARD_SHAPE',
  'OVERRULED_HANDOVER',
  'IDENTITY_SECOND_ASK',
  'CAP_EPISODE',
  // the prompt (§C.4)
  'KB_TOO_LARGE',
  // the provider (§B.1)
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'REFUSAL',
  'MALFORMED',
  'MAX_TOKENS',
  // decided by the engine (A2), listed so the vocabulary is one list
  'CAP_DAILY',
  'CIRCUIT_OPEN',
] as const;
export type AiOutcomeReason = (typeof AI_OUTCOME_REASONS)[number];
