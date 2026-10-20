import { z } from 'zod';
import {
  ASSISTANT_ASK_STATES,
  ASSISTANT_CORRECTION_MAX,
  ASSISTANT_FEEDBACK,
  ASSISTANT_QUESTION_MAX,
  ASSISTANT_TOOL_SYSTEMS,
} from './assistant-tools';
import { SUITE_SCREEN_APPS } from './suite-screens';

/**
 * THE ASK-LOG'S WIRE SHAPES (SCRUM-591, round I2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §D.1, §D.3, §D.4).
 *
 * What `/assistant/*` takes and answers, shared with the launcher's ask panel
 * (round I3a). The rules behind them live in `apps/api/src/services/assistant`.
 *
 *   POST  /assistant/asks                    ask (the id is the caller's)
 *   GET   /assistant/asks                    my questions, newest first
 *   GET   /assistant/asks/{id}               one of mine (a reviewer: anyone's, audited)
 *   PATCH /assistant/asks/{id}/feedback      good | wrong + correction, mine only
 *   GET   /assistant/review/asks             the reviewer's list (assistant:log:review, audited)
 *
 * TEXT IS ONLY HERE AND IN THE ASK ROW (§E.1). The question, the answer and
 * the correction travel to the asker (and to a reviewer, whose read is
 * audited); no audit row, ops row, log line or replay-store body carries them.
 * The feedback answer is text-free for that reason.
 */

const Uuid = z.string().uuid();
const Iso = z.string();

export const AssistantAskCreateSchema = z
  .object({
    /** Client-named (house id rule): a resend of the same id is answered from the ask's own row. */
    id: Uuid,
    question: z.string().trim().min(1).max(ASSISTANT_QUESTION_MAX),
  })
  .strict();
export type AssistantAskCreate = z.infer<typeof AssistantAskCreateSchema>;

/** A link the server resolved and the asker may open: the launcher renders it as a button. */
export const AssistantAskLinkSchema = z.object({
  key: z.string(),
  app: z.enum(SUITE_SCREEN_APPS),
  /** Relative to the app's own origin, built by the server from checked parameters. */
  path: z.string(),
  shows: z.string(),
});
export type AssistantAskLink = z.infer<typeof AssistantAskLinkSchema>;

/** A route's own refusal, verbatim (§D.4), and the line the panel shows under the answer. */
export const AssistantAskRefusalSchema = z.object({
  tool: z.string(),
  system: z.enum(ASSISTANT_TOOL_SYSTEMS),
  status: z.number().int(),
  code: z.string().nullable(),
  message: z.string(),
  /** "Platform: You hold pos:checkin:read, but not at Robinson Chalong". Never the model's words. */
  line: z.string(),
});
export type AssistantAskRefusalView = z.infer<typeof AssistantAskRefusalSchema>;

/** One tool call, as numbers: no arguments and no body reach the panel's list. */
export const AssistantAskToolCallSchema = z.object({
  seq: z.number().int(),
  tool: z.string(),
  system: z.enum(ASSISTANT_TOOL_SYSTEMS),
  status: z.number().int().nullable(),
  code: z.string().nullable(),
  rows: z.number().int().nullable(),
  truncated: z.boolean(),
});

export const AssistantAskViewSchema = z.object({
  id: Uuid,
  /** `asking` only while the ask is running; the rest are final. */
  state: z.enum(ASSISTANT_ASK_STATES),
  /** One word: `TOOL_CAP`, `GUARD_NUMBER`, `CAP_PERSON`, `PROVIDER_TIMEOUT`… Null when answered. */
  reason: z.string().nullable(),
  question: z.string(),
  /** As shown: the model's checked prose, or the server's fixed line. */
  answer: z.string().nullable(),
  links: z.array(AssistantAskLinkSchema),
  refusals: z.array(AssistantAskRefusalSchema),
  toolCalls: z.array(AssistantAskToolCallSchema),
  feedback: z.enum(ASSISTANT_FEEDBACK).nullable(),
  correction: z.string().nullable(),
  /**
   * The model's own word that the message was social (thanks, hello) and no
   * tool was needed (test night 2026-10-21, S10): the launcher hides
   * Good/Wrong on it. False on every server-written line.
   */
  smallTalk: z.boolean(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type AssistantAskView = z.infer<typeof AssistantAskViewSchema>;

export const ASSISTANT_ASK_PAGE_DEFAULT = 20;
export const ASSISTANT_ASK_PAGE_MAX = 50;

export const AssistantAskListQuerySchema = z.object({
  /** From a previous page's `nextCursor`. */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(ASSISTANT_ASK_PAGE_MAX).default(ASSISTANT_ASK_PAGE_DEFAULT),
});
export type AssistantAskListQuery = z.infer<typeof AssistantAskListQuerySchema>;

export const AssistantAskListSchema = z.object({
  asks: z.array(AssistantAskViewSchema),
  nextCursor: z.string().nullable(),
});
export type AssistantAskList = z.infer<typeof AssistantAskListSchema>;

export const AssistantAskFeedbackSchema = z
  .object({
    feedback: z.enum(ASSISTANT_FEEDBACK),
    /** What was wrong (spec §4): only with `wrong`. */
    correction: z.string().trim().min(1).max(ASSISTANT_CORRECTION_MAX).optional(),
  })
  .strict()
  .refine((b) => b.correction === undefined || b.feedback === 'wrong', {
    message: 'A correction goes with "wrong" only',
    path: ['correction'],
  });
export type AssistantAskFeedback = z.infer<typeof AssistantAskFeedbackSchema>;

/** The feedback answer: text-free, because a mutating route's answer may be kept for replay. */
export const AssistantAskFeedbackResultSchema = z.object({
  id: Uuid,
  feedback: z.enum(ASSISTANT_FEEDBACK),
  hasCorrection: z.boolean(),
  updatedAt: Iso,
});
export type AssistantAskFeedbackResult = z.infer<typeof AssistantAskFeedbackResultSchema>;

export const AssistantReviewQuerySchema = AssistantAskListQuerySchema.extend({
  feedback: z.enum(ASSISTANT_FEEDBACK).optional(),
  accountId: Uuid.optional(),
  state: z.enum(ASSISTANT_ASK_STATES).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});
export type AssistantReviewQuery = z.infer<typeof AssistantReviewQuerySchema>;

export const AssistantReviewAskSchema = AssistantAskViewSchema.extend({
  accountId: Uuid,
  branchId: Uuid.nullable(),
  model: z.string().nullable(),
  personaVersion: z.string().nullable(),
});
export type AssistantReviewAsk = z.infer<typeof AssistantReviewAskSchema>;

export const AssistantReviewListSchema = z.object({
  asks: z.array(AssistantReviewAskSchema),
  nextCursor: z.string().nullable(),
});
export type AssistantReviewList = z.infer<typeof AssistantReviewListSchema>;
