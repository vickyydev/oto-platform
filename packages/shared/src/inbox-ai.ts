import { z } from 'zod';
import { InboxChannelSchema } from './inbox';

/**
 * THE CUSTOMER ASSISTANT'S SETTINGS SHAPES (SCRUM-590, round A3; plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §C the knowledge base, §E the
 * curated learning loop, §D.4 the kill switches).
 *
 * The lists below are the database's CHECK lists (`@oto/db` `KB_TOPICS`,
 * `AI_CONTENT_LANGUAGES`, …), said again here because this package sits
 * below `@oto/db`; `apps/api/test/inbox-ai-kb.test.ts` pins the two to each
 * other. The length and slug rules are the CHECKs' too, so a request the
 * database would refuse is refused here first, in a sentence.
 */

const Uuid = z.string().uuid();
const Iso = z.string();

export const INBOX_AI_MODES = ['off', 'shadow', 'live'] as const;
export type InboxAiMode = (typeof INBOX_AI_MODES)[number];

/** The languages park content is written in. */
export const INBOX_AI_CONTENT_LANGUAGES = ['th', 'en', 'ru'] as const;

export const INBOX_KB_TOPICS = [
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
export const INBOX_KB_STATUSES = ['draft', 'approved', 'archived'] as const;

export const INBOX_AI_EXAMPLE_VERDICTS = ['should_answer', 'should_handover', 'should_stay_silent'] as const;
export const INBOX_AI_EXAMPLE_STATUSES = ['proposed', 'approved', 'rejected'] as const;

/** `kb_entry_key_check`: a dotted slug of at most 80, e.g. `faq.food-outside`. */
export const INBOX_KB_KEY_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
/** `ai_example_intent_check`: one lower-case word. */
export const INBOX_AI_INTENT_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/** The CHECKs count characters (code points); so does this. */
const chars = (min: number, max: number, what: string) =>
  z
    .string()
    .trim()
    .refine((v) => [...v].length >= min && [...v].length <= max, {
      message: `${what} must be ${min} to ${max} characters`,
    });

const KbKey = z
  .string()
  .max(80, 'a key is at most 80 characters')
  .regex(INBOX_KB_KEY_PATTERN, 'a key is a lower-case slug such as faq.food-outside');
const Intent = z.string().regex(INBOX_AI_INTENT_PATTERN, 'an intent is one lower-case word such as ticket_prices');

// --- The knowledge base (inbox:kb:manage) ----------------------------------------------------

export const InboxKbEntrySchema = z.object({
  id: Uuid,
  /** Null: both parks. */
  branchId: Uuid.nullable(),
  topic: z.enum(INBOX_KB_TOPICS),
  key: z.string(),
  language: z.enum(INBOX_AI_CONTENT_LANGUAGES),
  question: z.string(),
  body: z.string(),
  /** Only `approved` entries reach the assistant. */
  status: z.enum(INBOX_KB_STATUSES),
  /** A RU or TH row still holding the English source: not sent; the English row is. */
  needsTranslation: z.boolean(),
  /** The example it was promoted from (§E), if any. */
  sourceExampleId: Uuid.nullable(),
  updatedByAccountId: Uuid.nullable(),
  approvedByAccountId: Uuid.nullable(),
  approvedAt: Iso.nullable(),
  /** The viewer may edit, approve and archive it: `inbox:kb:manage` at its park, or operator-wide for a both-parks entry. */
  canManage: z.boolean(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type InboxKbEntry = z.infer<typeof InboxKbEntrySchema>;

export const InboxKbListQuerySchema = z.object({
  language: z.enum(INBOX_AI_CONTENT_LANGUAGES).optional(),
  topic: z.enum(INBOX_KB_TOPICS).optional(),
  /** Omitted: draft and approved (archived only when asked for). */
  status: z.enum(INBOX_KB_STATUSES).optional(),
});

export const InboxKbListSchema = z.object({ entries: z.array(InboxKbEntrySchema) });

export const InboxKbCreateSchema = z.object({
  /** Caller-named; absent, the platform names it. */
  id: Uuid.optional(),
  /** Null or absent: both parks. */
  branchId: Uuid.nullable().optional(),
  topic: z.enum(INBOX_KB_TOPICS),
  key: KbKey,
  language: z.enum(INBOX_AI_CONTENT_LANGUAGES),
  question: chars(1, 200, 'the question'),
  body: chars(1, 1200, 'the fact'),
  needsTranslation: z.boolean().optional(),
  /** An APPROVED example this entry is promoted from (§E). */
  sourceExampleId: Uuid.nullable().optional(),
});
export type InboxKbCreate = z.infer<typeof InboxKbCreateSchema>;

export const InboxKbPatchSchema = InboxKbCreateSchema.omit({ id: true, sourceExampleId: true })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'name at least one field to change' });
export type InboxKbPatch = z.infer<typeof InboxKbPatchSchema>;

// --- The curated examples (§E) ---------------------------------------------------------------

export const InboxAiExampleSchema = z.object({
  id: Uuid,
  intent: z.string(),
  language: z.enum(INBOX_AI_CONTENT_LANGUAGES),
  /** The customer's question as staff edited it to hold no personal data. */
  customerText: z.string(),
  goodReply: z.string().nullable(),
  verdict: z.enum(INBOX_AI_EXAMPLE_VERDICTS),
  status: z.enum(INBOX_AI_EXAMPLE_STATUSES),
  /** Where it came from — nulled on approval (and an erasure deletes the unapproved ones). */
  sourceMessageId: Uuid.nullable(),
  sourceConversationId: Uuid.nullable(),
  proposedByAccountId: Uuid,
  approvedByAccountId: Uuid.nullable(),
  approvedAt: Iso.nullable(),
  deidentifiedConfirmed: z.boolean(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type InboxAiExample = z.infer<typeof InboxAiExampleSchema>;

export const InboxAiExampleListQuerySchema = z.object({
  /** Omitted: every status. */
  status: z.enum(INBOX_AI_EXAMPLE_STATUSES).optional(),
  intent: Intent.optional(),
  language: z.enum(INBOX_AI_CONTENT_LANGUAGES).optional(),
});

export const InboxAiExampleListSchema = z.object({
  examples: z.array(InboxAiExampleSchema),
  /** The assistant's intents, in its table's order: the editor's intent picker. */
  intents: z.array(z.string()),
});

/**
 * "Correct the assistant" (§E): on an AI line, or on the customer message an
 * `ai_silent` pill answered with silence. The thread's language and intent
 * are read from the assistant's turn for that message (else the thread);
 * `intent` and `language` here override them, and are required when neither
 * names one.
 */
export const InboxAiExampleCreateSchema = z.object({
  /** Caller-named; absent, the platform names it. */
  id: Uuid.optional(),
  messageId: Uuid,
  customerText: chars(1, 500, 'the customer text'),
  goodReply: chars(1, 800, 'the good reply').nullable().optional(),
  verdict: z.enum(INBOX_AI_EXAMPLE_VERDICTS),
  intent: Intent.optional(),
  language: z.enum(INBOX_AI_CONTENT_LANGUAGES).optional(),
});
export type InboxAiExampleCreate = z.infer<typeof InboxAiExampleCreateSchema>;

export const InboxAiExamplePatchSchema = z
  .object({
    customerText: chars(1, 500, 'the customer text'),
    goodReply: chars(1, 800, 'the good reply').nullable(),
    verdict: z.enum(INBOX_AI_EXAMPLE_VERDICTS),
    intent: Intent,
    language: z.enum(INBOX_AI_CONTENT_LANGUAGES),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'name at least one field to change' });
export type InboxAiExamplePatch = z.infer<typeof InboxAiExamplePatchSchema>;

export const InboxAiExampleApproveBodySchema = z.object({
  /** The approver's "this contains no personal data" confirmation. Without `true`, 409 DEIDENTIFICATION_REQUIRED. */
  deidentifiedConfirmed: z.boolean().optional(),
});

export const InboxAiExampleDeletedSchema = z.object({ id: Uuid, deleted: z.literal(true) });

/** The most examples one import may carry. */
export const INBOX_AI_EXAMPLE_IMPORT_MAX = 50;

/**
 * One example loaded from outside the inbox — the park's own chat history,
 * already de-identified by the tool that made it (`scripts/inbox/whatsapp-history.mjs`).
 * Unlike "Correct the assistant" it names no message: intent and language are
 * the caller's to say. It lands PROPOSED, for the queue's review.
 */
export const InboxAiExampleImportItemSchema = z.object({
  /** Caller-named, so a resend is the same example; absent, the platform names it. */
  id: Uuid.optional(),
  customerText: chars(1, 500, 'the customer text'),
  /** Required for should_answer; may be absent for a handover or a silence. */
  goodReply: chars(1, 800, 'the good reply').nullable().optional(),
  verdict: z.enum(INBOX_AI_EXAMPLE_VERDICTS),
  /** One of the assistant's intents (409 INTENT_UNKNOWN otherwise). */
  intent: Intent,
  language: z.enum(INBOX_AI_CONTENT_LANGUAGES),
});
export type InboxAiExampleImportItem = z.infer<typeof InboxAiExampleImportItemSchema>;

export const InboxAiExampleImportSchema = z.object({
  examples: z
    .array(InboxAiExampleImportItemSchema)
    .min(1, 'send at least one example')
    .max(INBOX_AI_EXAMPLE_IMPORT_MAX, `send at most ${INBOX_AI_EXAMPLE_IMPORT_MAX} examples at a time`),
});
export type InboxAiExampleImport = z.infer<typeof InboxAiExampleImportSchema>;

export const InboxAiExampleImportResultSchema = z.object({
  /** Examples written by this request. */
  created: z.number().int().min(0),
  /** Examples whose caller-named id already named this caller's example: nothing written for them. */
  replayed: z.number().int().min(0),
  /** Every example of the request as it now stands, in the request's order. */
  examples: z.array(InboxAiExampleSchema),
});
export type InboxAiExampleImportResult = z.infer<typeof InboxAiExampleImportResultSchema>;

// --- The behaviour rules (SCRUM-696, inbox:kb:manage) ----------------------------------------

/**
 * An operator rule: a plain instruction for one of the assistant's intents
 * (or `any`), and optionally a question it asks first. A rule only ADDS a
 * question or an instruction; the server refuses one that grants a price, a
 * discount, a refund, a date or a booking (400 RULE_UNSAFE). Only approved
 * rules reach the assistant.
 */
export const INBOX_AI_RULE_STATUSES = ['draft', 'approved', 'archived'] as const;
export const INBOX_AI_RULE_SOURCES = ['teach', 'manual'] as const;
export const INBOX_AI_RULE_CONDITIONS = ['always', 'branch_unknown'] as const;
export const INBOX_AI_RULE_ANY = 'any';
export const INBOX_AI_RULE_INSTRUCTION_MAX = 600;
export const INBOX_AI_RULE_QUESTION_MAX = 200;
export const INBOX_AI_RULE_TAUGHT_FROM_MAX = 2000;

export const InboxAiRuleAskFirstSchema = z.object({
  /** `branch_unknown`: only while the customer has not named a park; `always`: once per episode. */
  condition: z.enum(INBOX_AI_RULE_CONDITIONS),
  question: z.object({
    en: chars(1, INBOX_AI_RULE_QUESTION_MAX, 'the question'),
    th: chars(1, INBOX_AI_RULE_QUESTION_MAX, 'the Thai question').optional(),
    ru: chars(1, INBOX_AI_RULE_QUESTION_MAX, 'the Russian question').optional(),
  }),
});
export type InboxAiRuleAskFirst = z.infer<typeof InboxAiRuleAskFirstSchema>;

export const InboxAiRuleSchema = z.object({
  id: Uuid,
  /** One of the assistant's intents, or `any`. */
  intent: z.string(),
  /** Null: both parks. */
  branchId: Uuid.nullable(),
  instruction: z.string(),
  askFirst: z
    .object({
      condition: z.enum(INBOX_AI_RULE_CONDITIONS),
      question: z.object({ en: z.string(), th: z.string().optional(), ru: z.string().optional() }),
    })
    .nullable(),
  /** Only `approved` rules reach the assistant. */
  status: z.enum(INBOX_AI_RULE_STATUSES),
  /** The sentence the person typed in the teach chat, if it came from there. */
  taughtFrom: z.string().nullable(),
  source: z.enum(INBOX_AI_RULE_SOURCES),
  approvedByAccountId: Uuid.nullable(),
  approvedAt: Iso.nullable(),
  updatedByAccountId: Uuid.nullable(),
  /** inbox:kb:manage at its park, or operator-wide for a both-parks rule. */
  canManage: z.boolean(),
  createdAt: Iso,
  updatedAt: Iso,
});
export type InboxAiRule = z.infer<typeof InboxAiRuleSchema>;

export const InboxAiRuleListQuerySchema = z.object({
  /** Omitted: draft and approved. */
  status: z.enum(INBOX_AI_RULE_STATUSES).optional(),
});

export const InboxAiRuleListSchema = z.object({ rules: z.array(InboxAiRuleSchema) });

export const InboxAiRuleCreateSchema = z.object({
  /** Caller-named; absent, the platform names it. */
  id: Uuid.optional(),
  /** Null or absent: both parks. */
  branchId: Uuid.nullable().optional(),
  /** One of the assistant's intents or `any` (409 INTENT_UNKNOWN otherwise). */
  intent: Intent,
  instruction: chars(1, INBOX_AI_RULE_INSTRUCTION_MAX, 'the instruction'),
  askFirst: InboxAiRuleAskFirstSchema.nullable().optional(),
});
export type InboxAiRuleCreate = z.infer<typeof InboxAiRuleCreateSchema>;

export const InboxAiRulePatchSchema = InboxAiRuleCreateSchema.omit({ id: true })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'name at least one field to change' });
export type InboxAiRulePatch = z.infer<typeof InboxAiRulePatchSchema>;

// --- The teach chat (SCRUM-696, inbox:kb:manage operator-wide) -------------------------------

export const INBOX_AI_TEACH_MAX_MESSAGES = 20;
export const INBOX_AI_TEACH_OUTCOMES = ['answer', 'handover', 'silent_handover', 'silent', 'ask_first'] as const;

export const InboxAiTeachMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: chars(1, 2000, 'a message'),
});

export const InboxAiTeachRequestSchema = z.object({
  /** One per open teach chat (the page names it). */
  sessionId: Uuid,
  /** The chat so far, oldest first; the last one is the staff member's. */
  messages: z
    .array(InboxAiTeachMessageSchema)
    .min(1, 'send at least one message')
    .max(INBOX_AI_TEACH_MAX_MESSAGES, `send at most the last ${INBOX_AI_TEACH_MAX_MESSAGES} messages`)
    .refine((m) => m[m.length - 1]?.role === 'user', { message: 'the last message must be yours' }),
});
export type InboxAiTeachRequest = z.infer<typeof InboxAiTeachRequestSchema>;

/** A draft the teach chat saved this turn: approve it under Assistant → Knowledge or Rules. */
export const InboxAiTeachCardSchema = z.object({
  kind: z.enum(['fact', 'rule']),
  id: Uuid,
  title: z.string(),
  status: z.literal('draft'),
});

/** What the assistant would do now with one customer message (decision, gate and ask-first only). */
export const InboxAiTeachDryRunSchema = z.object({
  message: z.string(),
  intent: z.string().nullable(),
  outcome: z.enum(INBOX_AI_TEACH_OUTCOMES),
  bubbles: z.array(z.string()),
  ruleFired: Uuid.nullable(),
});
export type InboxAiTeachDryRun = z.infer<typeof InboxAiTeachDryRunSchema>;

export const InboxAiTeachResponseSchema = z.object({
  reply: z.string(),
  cards: z.array(InboxAiTeachCardSchema),
  dryRun: InboxAiTeachDryRunSchema.nullable(),
});
export type InboxAiTeachResponse = z.infer<typeof InboxAiTeachResponseSchema>;

// --- The controls (§D.4) ---------------------------------------------------------------------

export const InboxAiChannelAccountSchema = z.object({
  id: Uuid,
  channel: InboxChannelSchema,
  provider: z.string(),
  displayName: z.string(),
  /** Null: operator-wide. */
  branchId: Uuid.nullable(),
  status: z.string(),
  canReply: z.boolean(),
  aiMode: z.enum(INBOX_AI_MODES),
});
export type InboxAiChannelAccount = z.infer<typeof InboxAiChannelAccountSchema>;

export const InboxAiChannelAccountListSchema = z.object({ channelAccounts: z.array(InboxAiChannelAccountSchema) });

export const InboxAiModeBodySchema = z.object({ aiMode: z.enum(INBOX_AI_MODES) });

export const InboxAiPauseSchema = z.object({
  conversationId: Uuid,
  aiPaused: z.boolean(),
  aiPausedAt: Iso.nullable(),
  aiPausedByAccountId: Uuid.nullable(),
  /** What the pause stood down: pending or deciding turns cancelled, unsent AI lines withdrawn. Zero on a resume. */
  turnsCancelled: z.number().int().min(0),
  messagesWithdrawn: z.number().int().min(0),
});
export type InboxAiPause = z.infer<typeof InboxAiPauseSchema>;
