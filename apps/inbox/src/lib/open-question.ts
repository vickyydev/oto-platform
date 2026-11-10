import type { InboxAiAskedSlot } from '@oto/shared/inbox-open-question';
import type { ConversationDetail } from '@/api/inbox';

/**
 * SCRUM-831: what the assistant asked the customer, and what it read each
 * reply as — shown under the line that asked, so staff see what the
 * assistant believes ("asked: child's age · answered 8"). The words only;
 * `OpenQuestionLine` draws them.
 */
export type OpenQuestion = NonNullable<ConversationDetail['openQuestions']>[number];

export const SLOT_LABEL: Record<InboxAiAskedSlot, string> = {
  date: 'the date',
  time: 'the time',
  park: 'the park',
  kids_count: 'how many children',
  adults_count: 'how many adults',
  guests_count: 'how many people',
  child_age: "child's age",
  child_name: "child's name",
  package: 'the package',
  residency: 'residency',
  other: 'a question',
};

const PARK_LABEL: Record<string, string> = { central: 'Central Floresta', chalong: 'Robinson Chalong' };
const RESIDENCY_LABEL: Record<string, string> = { resident: 'lives in Thailand', tourist: 'visiting' };

/** The answer as staff read it: a park by its name, residency in words, anything else as the server read it. */
export function answerLabel(q: Pick<OpenQuestion, 'slot' | 'answer'>): string | null {
  if (q.answer === null) return null;
  if (q.slot === 'park') return PARK_LABEL[q.answer] ?? q.answer;
  if (q.slot === 'residency') return RESIDENCY_LABEL[q.answer] ?? q.answer;
  return q.answer;
}

/** "asked: child's age · answered 8", "asked: the date · waiting for the answer", "asked: the park · not answered". */
export function openQuestionText(q: Pick<OpenQuestion, 'slot' | 'state' | 'answer'>): string {
  const asked = `asked: ${SLOT_LABEL[q.slot] ?? q.slot}`;
  if (q.state === 'open') return `${asked} · waiting for the answer`;
  if (q.state === 'withdrawn') return `${asked} · not answered`;
  const answer = answerLabel(q);
  return answer === null ? `${asked} · answered` : `${asked} · answered ${answer}`;
}

/** The thread's questions by the line that asked them, oldest first. */
export function openQuestionsByMessage(questions: readonly OpenQuestion[] | undefined): Map<string, OpenQuestion[]> {
  const out = new Map<string, OpenQuestion[]>();
  for (const q of questions ?? []) out.set(q.askedMessageId, [...(out.get(q.askedMessageId) ?? []), q]);
  return out;
}
