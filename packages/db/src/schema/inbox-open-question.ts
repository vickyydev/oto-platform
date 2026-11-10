import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  INBOX_AI_ASKED_SLOTS,
  INBOX_OPEN_QUESTION_ANSWER_MAX,
  INBOX_OPEN_QUESTION_STATES,
  type InboxAiAskedSlot,
  type InboxOpenQuestionState,
} from '@oto/shared';
import { idPk, inbox, timestamps } from './helpers';
import { aiTurn, conversation, message } from './inbox';
import { operator } from './tenancy';

// --- conversation_open_question ----------------------------------------------

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(','));

/**
 * SCRUM-831, THE ASSISTANT'S OPEN QUESTIONS (`0112_inbox_open_question`; the
 * owner, 10 Nov 2026: "the memory is the primary mechanism; the guard is the
 * last net and its firing is counted"). The assistant asked a family "how old
 * will the birthday child be?" twice in one thread after the parent had
 * answered.
 *
 * One row per slot a sent reply asked (`slot`, the vocabulary the assistant's
 * decision declares: `@oto/shared` `INBOX_AI_ASKED_SLOTS`), on the line that
 * asked it. The customer's next message is read as its answer and the row
 * closes: `answered`, with the value read (`answer`) and the line it was read
 * from; or `withdrawn` — the thread went to a person, the asking line never
 * left, or the same slot was asked again. The next turn's prompt names the
 * episode's rows; the repeat guard refuses asking an answered slot again.
 *
 * WHAT IS KEPT. `answer` is a short value the server read — a number, a date,
 * a time, a park, "resident" — held to 40 characters by CHECK; a free answer
 * (a child's name, a package) is never copied here (`answer` null, the words
 * stay in the message, which the erasure and the retention sweep reach). The
 * erasure of a contact nulls the answers on their threads.
 *
 * Expand-only: a new table; nothing existing changes. A release that does not
 * know it never reads it.
 */
export const conversationOpenQuestion = inbox.table(
  'conversation_open_question',
  {
    id: idPk(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => operator.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    slot: text('slot').$type<InboxAiAskedSlot>().notNull(),
    state: text('state').$type<InboxOpenQuestionState>().notNull().default('open'),
    /** The turn whose reply asked it. */
    turnId: uuid('turn_id').notNull(),
    /** The assistant's line that asked it. */
    askedMessageId: uuid('asked_message_id').notNull(),
    askedAt: timestamp('asked_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** The value the customer's reply was read as; null while open, when withdrawn, and for a free answer. */
    answer: text('answer'),
    /** The customer's line read as the answer. */
    answeredMessageId: uuid('answered_message_id'),
    /** When it was answered or withdrawn. */
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps,
  },
  (t) => [
    unique('conversation_open_question_tenant_key').on(t.operatorId, t.id),
    foreignKey({
      columns: [t.operatorId, t.conversationId],
      foreignColumns: [conversation.operatorId, conversation.id],
      name: 'conversation_open_question_conversation_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.turnId],
      foreignColumns: [aiTurn.operatorId, aiTurn.id],
      name: 'conversation_open_question_turn_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.askedMessageId],
      foreignColumns: [message.operatorId, message.id],
      name: 'conversation_open_question_asked_message_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.operatorId, t.answeredMessageId],
      foreignColumns: [message.operatorId, message.id],
      name: 'conversation_open_question_answered_message_fk',
    }).onDelete('restrict'),
    /** One open question per slot per thread: asking it again withdraws the older one first. */
    uniqueIndex('conversation_open_question_open_unique')
      .on(t.conversationId, t.slot)
      .where(sql`state = 'open'`),
    /** The turn's read: a thread's questions of this episode, oldest first. */
    index('conversation_open_question_conversation_idx').on(t.operatorId, t.conversationId, t.askedAt),
    index('conversation_open_question_turn_idx').on(t.operatorId, t.turnId),
    index('conversation_open_question_asked_message_idx').on(t.operatorId, t.askedMessageId),
    index('conversation_open_question_answered_message_idx').on(t.operatorId, t.answeredMessageId),
    check('conversation_open_question_slot_check', sql`${t.slot} in (${inList(INBOX_AI_ASKED_SLOTS)})`),
    check('conversation_open_question_state_check', sql`${t.state} in (${inList(INBOX_OPEN_QUESTION_STATES)})`),
    check(
      'conversation_open_question_answer_check',
      sql`${t.answer} is null or char_length(${t.answer}) between 1 and ${sql.raw(String(INBOX_OPEN_QUESTION_ANSWER_MAX))}`,
    ),
    /** Open: nothing closed. Answered: by a line, when. Withdrawn: when, and no answer. */
    check(
      'conversation_open_question_closed_check',
      sql`(${t.state} = 'open' and ${t.closedAt} is null and ${t.answer} is null and ${t.answeredMessageId} is null)
          or (${t.state} = 'answered' and ${t.closedAt} is not null and ${t.answeredMessageId} is not null)
          or (${t.state} = 'withdrawn' and ${t.closedAt} is not null and ${t.answer} is null and ${t.answeredMessageId} is null)`,
    ),
  ],
);
