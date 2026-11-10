import { z } from 'zod';

/**
 * SCRUM-831 — THE ASSISTANT'S OPEN QUESTIONS (owner, 10 Nov 2026: "the memory
 * is the primary mechanism; the guard is the last net and its firing is
 * counted"). The assistant asked a family "how old will the birthday child
 * be?" twice in one thread after the parent had answered. Now, when a reply
 * asks the customer something, the reply names WHAT it asked (a slot), the
 * server records it on the conversation, and the customer's next message is
 * read as its answer.
 *
 * One vocabulary for the assistant package (`@oto/assistant`
 * `AI_ASKED_SLOTS`), the table's CHECK (`inbox.conversation_open_question`)
 * and the inbox, which shows staff what the assistant believes ("asked: the
 * child's age · answered 8").
 */

/** What a reply's question asks for. `other` is a question the memory does not track. */
export const INBOX_AI_ASKED_SLOTS = [
  'date',
  'time',
  'park',
  'kids_count',
  'adults_count',
  'guests_count',
  'child_age',
  'child_name',
  'package',
  'residency',
  'other',
] as const;
export type InboxAiAskedSlot = (typeof INBOX_AI_ASKED_SLOTS)[number];

/**
 * An asked question's standing: still `open`; `answered` (the customer's
 * reply was read as its answer); or `withdrawn` (the thread went to a person,
 * the line that asked it never left, or the same slot was asked again).
 */
export const INBOX_OPEN_QUESTION_STATES = ['open', 'answered', 'withdrawn'] as const;
export type InboxOpenQuestionState = (typeof INBOX_OPEN_QUESTION_STATES)[number];

/** The longest answer kept: a number, a date, a time, a park, a short list of ages — never a name or a sentence. */
export const INBOX_OPEN_QUESTION_ANSWER_MAX = 40;

/**
 * One question the assistant asked on a thread, as the inbox reads it: the
 * line that asked it, and what the customer's reply was read as. `answer` is
 * null for a free answer the server does not keep (a child's name, a
 * package) and while the question is open.
 */
export const InboxOpenQuestionSchema = z.object({
  id: z.string().uuid(),
  slot: z.enum(INBOX_AI_ASKED_SLOTS),
  state: z.enum(INBOX_OPEN_QUESTION_STATES),
  /** The assistant's line that asked it. */
  askedMessageId: z.string().uuid(),
  askedAt: z.string(),
  answer: z.string().max(INBOX_OPEN_QUESTION_ANSWER_MAX).nullable(),
  /** The customer's line read as the answer. */
  answeredMessageId: z.string().uuid().nullable(),
  closedAt: z.string().nullable(),
});
export type InboxOpenQuestion = z.infer<typeof InboxOpenQuestionSchema>;
