import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ASSISTANT_ASK_STATES,
  ASSISTANT_CORRECTION_MAX,
  ASSISTANT_FEEDBACK,
  ASSISTANT_LINKS_MAX,
  ASSISTANT_QUESTION_MAX,
  ASSISTANT_STORED_ANSWER_MAX,
  ASSISTANT_TOOL_SYSTEMS,
  type AssistantAskState,
  type AssistantFeedback,
  type AssistantRefusal,
  type AssistantToolSystem,
} from '@oto/shared';
import { assistant, idPk, timestamps } from './helpers';
import { account, branch, operator } from './tenancy';

// --- The internal assistant's ask-log (schema `assistant`) -------------------
//
// SCRUM-591 (Inbox AI Phase 3, round I1, lane b; plan
// docs/progress/plans/internal-assistant-build/PLAN.md §D.3, §E.1).
// Migration `0081_assistant`, which writes no row.
//
// WHAT IT IS, HONESTLY (§D.3). Each row holds a question a person asked and
// the answer they were shown, which quotes what they were entitled to see
// when they asked: personal data about the asker and about whoever they asked
// about. So:
//   - The asker reads their own rows; only `assistant:log:review` reads
//     anyone else's, and every such read is audited (round I2).
//   - Every row carries `purge_after`; `job:assistant.purge` deletes rows past
//     it and their tool calls go with them (`ON DELETE CASCADE`). This is not
//     `core.audit_log`, which is never swept, and holds no audit.
//   - TEXT LIVES ONLY HERE (§E.1). `question`, `answer`, `correction` and the
//     refusal lines are the only free text; every other text column is an
//     enum or one word by CHECK, and a tool call stores no response body.
//
// THE TENANT FENCE, as the inbox's: `operator_id` on both tables, a real key
// to `core.operator`, and a tool call reaches its ask by the COMPOSITE key
// `(operator_id, ask_id) → ask(operator_id, id)`.
//
// `session_id` is SOFT (no foreign key): a session row is deleted on sign-out
// and the ask outlives it. The account, the branch and the operator are hard
// keys.

/** `'a','b'` for a CHECK, from one of the shared lists, so the list is said once. */
const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(','));

/**
 * The one-word shapes (`@oto/shared` ASSISTANT_REASON_WORD and friends, pinned
 * to these by `test/assistant-i1b.test.ts`).
 */
const REASON_WORD = sql.raw(`'^[A-Z][A-Z0-9_]{0,47}$'`);
const VERSION_WORD = sql.raw(`'^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$'`);
const TOOL_NAME = sql.raw(`'^[a-z][a-z0-9_]{0,31}(\\.[a-z][a-z0-9_]{0,31}){1,3}$'`);
/** A route TEMPLATE: GET only, no query string — the write-actions gate, in the database too. */
const ROUTE_TEMPLATE = sql.raw(`'^GET /[A-Za-z0-9_:./-]{0,199}$'`);
const ERROR_CODE = sql.raw(`'^[A-Za-z][A-Za-z0-9_.-]{0,63}$'`);

/** A resolved link as stored: the key and the parameters the server checked. */
export interface AssistantStoredLink {
  key: string;
  params: Record<string, string>;
}

// --- ask -----------------------------------------------------------------------

/**
 * One question, asked on the launcher (`POST /assistant/asks`, round I2).
 *
 * `id` is client-named and the ask route's `Idempotency-Key`: the row is
 * written first, in `asking`, before any model call, so a retry finds it
 * (§D.1). It ends in one of the plan's six final states with a one-word
 * `reason` where the state needs one (`PROVIDER_TIMEOUT`, `TOOL_CAP`,
 * `GUARD_NUMBER`, …).
 */
export const ask = assistant.table(
  'ask',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    accountId: uuid('account_id')
      .notNull()
      .references(() => account.id, { onDelete: 'restrict' }),
    /** The session asked from. SOFT: sessions are deleted on sign-out. */
    sessionId: uuid('session_id'),
    /** The session's seat at ask time; null for a session with no seat. */
    branchId: uuid('branch_id').references(() => branch.id, { onDelete: 'restrict' }),
    question: text('question').notNull(),
    /** As shown to the asker, after the guards. Null until it ends. */
    answer: text('answer'),
    /** Resolved link keys and their checked parameters, ≤ 3. */
    links: jsonb('links').$type<AssistantStoredLink[]>().notNull().default(sql`'[]'::jsonb`),
    /** The routes' own refusal sentences, verbatim (§D.4). */
    refusals: jsonb('refusals').$type<AssistantRefusal[]>().notNull().default(sql`'[]'::jsonb`),
    state: text('state').$type<AssistantAskState>().notNull().default('asking'),
    reason: text('reason'),
    model: text('model'),
    personaVersion: text('persona_version'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    /** Wall time of the whole ask, asked to answered. */
    latencyMs: integer('latency_ms'),
    feedback: text('feedback').$type<AssistantFeedback>(),
    /** The asker's correction (spec §4): the learning loop's input, never weights. */
    correction: text('correction'),
    /** When `job:assistant.purge` deletes the row: asked + retention (G4, 90 days). */
    purgeAfter: timestamp('purge_after', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now() + interval '90 days'`),
    ...timestamps,
  },
  (t) => [
    /** The target of `tool_call`'s composite key: the tenant fence. */
    unique('ask_tenant_key').on(t.operatorId, t.id),
    /** "My questions", newest first, and the person's daily cap. */
    index('ask_account_created_idx').on(t.accountId, t.createdAt),
    /** The operator's daily ask and token caps, and the reviewer's list. */
    index('ask_operator_created_idx').on(t.operatorId, t.createdAt),
    index('ask_branch_idx').on(t.branchId),
    /** The purge's sweep. */
    index('ask_purge_after_idx').on(t.purgeAfter),
    /** The reviewer's correction list (§D.3): only rows with a verdict. */
    index('ask_feedback_idx')
      .on(t.operatorId, t.feedback, t.createdAt)
      .where(sql`feedback is not null`),
    check('ask_state_check', sql`${t.state} in (${inList(ASSISTANT_ASK_STATES)})`),
    check('ask_reason_check', sql`${t.reason} is null or ${t.reason} ~ ${REASON_WORD}`),
    check(
      'ask_version_words_check',
      sql`(${t.model} is null or ${t.model} ~ ${VERSION_WORD})
          and (${t.personaVersion} is null or ${t.personaVersion} ~ ${VERSION_WORD})`,
    ),
    check(
      'ask_length_check',
      sql`char_length(${t.question}) between 1 and ${sql.raw(String(ASSISTANT_QUESTION_MAX))}
          and (${t.answer} is null or char_length(${t.answer}) <= ${sql.raw(String(ASSISTANT_STORED_ANSWER_MAX))})
          and (${t.correction} is null or char_length(${t.correction}) between 1 and ${sql.raw(String(ASSISTANT_CORRECTION_MAX))})`,
    ),
    check(
      'ask_shapes_check',
      sql`jsonb_typeof(${t.links}) = 'array' and jsonb_array_length(${t.links}) <= ${sql.raw(String(ASSISTANT_LINKS_MAX))}
          and jsonb_typeof(${t.refusals}) = 'array'`,
    ),
    check('ask_feedback_check', sql`${t.feedback} is null or ${t.feedback} in (${inList(ASSISTANT_FEEDBACK)})`),
    /** A correction says what was wrong: only on a `wrong` verdict. */
    check('ask_correction_check', sql`${t.correction} is null or coalesce(${t.feedback} = 'wrong', false)`),
    /** An ask still in flight has no answer and no verdict. */
    check(
      'ask_asking_check',
      sql`${t.state} <> 'asking' or (${t.answer} is null and ${t.feedback} is null)`,
    ),
    check(
      'ask_counts_check',
      sql`(${t.inputTokens} is null or ${t.inputTokens} >= 0)
          and (${t.outputTokens} is null or ${t.outputTokens} >= 0)
          and (${t.cacheReadTokens} is null or ${t.cacheReadTokens} >= 0)
          and (${t.latencyMs} is null or ${t.latencyMs} >= 0)`,
    ),
  ],
);

// --- tool_call -------------------------------------------------------------------

/**
 * One tool call made for an ask, as the asker (§B.2, §B.3): which tool, the
 * route TEMPLATE it called, the validated arguments, and what came back as
 * numbers — status, error code, rows, bytes, truncated, time. NO RESPONSE
 * BODY: the answer is the record of what was shown, and a body would be a
 * second copy of the data that outlives the screen's fence (§D.3).
 *
 * `seq` orders the calls within an ask, from 1. `status` and `code` are null
 * when no request was made (arguments refused, the cap reached first).
 */
export const toolCall = assistant.table(
  'tool_call',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    askId: uuid('ask_id').notNull(),
    seq: integer('seq').notNull(),
    tool: text('tool').notNull(),
    system: text('system').$type<AssistantToolSystem>().notNull(),
    /** `GET /members/lookup`: the template, never the URL with its values. */
    route: text('route').notNull(),
    /**
     * The validated input: personal data of the ask-log's tier, purged with
     * the ask. It may carry up to 200 characters of the question itself
     * (`members.search.q` is free text the model copies from the ask), so no
     * view shows it and no audit row carries it (§E.1).
     */
    args: jsonb('args').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: integer('status'),
    code: text('code'),
    rows: integer('rows'),
    bytes: integer('bytes'),
    truncated: boolean('truncated').notNull().default(false),
    latencyMs: integer('latency_ms'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.operatorId, t.askId],
      foreignColumns: [ask.operatorId, ask.id],
      name: 'tool_call_ask_fk',
    }).onDelete('cascade'),
    unique('tool_call_seq_unique').on(t.askId, t.seq),
    index('tool_call_ask_fk_idx').on(t.operatorId, t.askId),
    check('tool_call_tool_check', sql`${t.tool} ~ ${TOOL_NAME}`),
    check('tool_call_system_check', sql`${t.system} in (${inList(ASSISTANT_TOOL_SYSTEMS)})`),
    check('tool_call_route_check', sql`${t.route} ~ ${ROUTE_TEMPLATE}`),
    check('tool_call_code_check', sql`${t.code} is null or ${t.code} ~ ${ERROR_CODE}`),
    check('tool_call_args_check', sql`jsonb_typeof(${t.args}) = 'object'`),
    check(
      'tool_call_counts_check',
      sql`${t.seq} >= 1
          and (${t.status} is null or ${t.status} between 100 and 599)
          and (${t.rows} is null or ${t.rows} >= 0)
          and (${t.bytes} is null or ${t.bytes} >= 0)
          and (${t.latencyMs} is null or ${t.latencyMs} >= 0)`,
    ),
  ],
);
