/**
 * THE CHAT POPUP'S SHELL (SCRUM-591, the chat-popup round): what the floating
 * button and the popup decide, with no DOM in it, so the unit tests drive it
 * in Node. The ask state machine (`ask.ts`) is untouched; this is only how
 * its phases are laid out as a conversation and when the popup is open.
 */
import type { Permission } from '@oto/shared/permissions';
import type { AskView } from '@/api/assistant';
import type { SuiteApp } from '@/suite/apps';
import { mergeAsks, type AskPhase } from './ask';

export type ShellEvent = 'open' | 'close' | 'toggle' | 'escape' | 'outside-click';

/**
 * Open or closed after an event. Esc and the close control close it; the
 * button toggles it; a click outside never closes it, because a stray click
 * must not lose a typed question.
 */
export function shellReducer(open: boolean, event: ShellEvent): boolean {
  switch (event) {
    case 'open':
      return true;
    case 'close':
    case 'escape':
      return false;
    case 'toggle':
      return !open;
    case 'outside-click':
      return open;
  }
}

/** A phase that has a question but no ask row to show yet: in flight, or not sent. */
export type PendingPhase = Exclude<AskPhase, { kind: 'idle' } | { kind: 'done' }>;

export type ThreadItem =
  | { kind: 'ask'; ask: AskView }
  | { kind: 'pending'; id: string; question: string; sentAt: string; phase: PendingPhase };

/**
 * The conversation, oldest at the top and newest at the bottom: the person's
 * asks (the api pages them newest first) and, last, the question in flight or
 * the one that could not be sent, which is not an ask row yet. A finished ask
 * is shown from its row even before the list has it.
 */
export function threadOf(asks: AskView[], phase: AskPhase, sentAt: string): ThreadItem[] {
  const rows = mergeAsks(asks, phase.kind === 'done' ? [phase.ask] : []);
  const items: ThreadItem[] = rows.reverse().map((ask) => ({ kind: 'ask', ask }));
  if (phase.kind !== 'idle' && phase.kind !== 'done') {
    items.push({ kind: 'pending', id: phase.id, question: phase.question, sentAt, phase });
  }
  return items;
}

/** A stable key for one item of the thread. */
export function threadItemKey(item: ThreadItem): string {
  return item.kind === 'ask' ? item.ask.id : `pending:${item.id}`;
}

/** One example and what makes it true of a person: a permission held, or a tile on their launcher. */
type EmptyThreadExample =
  { example: string; permission: Permission } | { example: string; tile: SuiteApp['key'] };

/**
 * The examples an empty thread may name, in the order they are offered, each
 * with what makes it true of this person: the platform tools by the
 * permission that reads them (the same `has` the tiles are drawn by), the
 * OTO App's by its tile being on their launcher.
 */
const EMPTY_THREAD_EXAMPLES: readonly EmptyThreadExample[] = [
  { example: 'members', permission: 'pos:member:read' },
  { example: "today's check-ins", permission: 'pos:checkin:read' },
  { example: 'the unanswered queue', permission: 'inbox:conversation:read' },
  { example: 'recent activity', permission: 'admin:audit:read' },
  { example: 'the rota', tile: 'oto_app' },
  { example: 'your payslips', tile: 'oto_app' },
];

/** How many examples the line names at most. */
export const EMPTY_THREAD_EXAMPLES_MAX = 4;

/** The line for a person none of the examples is true of. */
export const EMPTY_THREAD_NEUTRAL_LINE =
  'Ask a question about your work; I answer from what your access can see.';

/**
 * The one line an empty thread shows (the test-night round, W8). Its examples
 * are only things this person can actually ask about — someone with the Inbox
 * alone is not told to ask about members or payslips — taken in the order of
 * `EMPTY_THREAD_EXAMPLES`, at most four. When none applies, the neutral line.
 */
export function emptyThreadLine(
  has: (permission: Permission) => boolean,
  tiles: SuiteApp[],
): string {
  const examples = EMPTY_THREAD_EXAMPLES.filter((e) =>
    'permission' in e ? has(e.permission) : tiles.some((t) => t.key === e.tile),
  )
    .slice(0, EMPTY_THREAD_EXAMPLES_MAX)
    .map((e) => e.example);
  if (examples.length === 0) return EMPTY_THREAD_NEUTRAL_LINE;
  return `Ask about ${examples.join(', ')}…`;
}

/** The width at and under which the popup is a full-height sheet. */
export const SHEET_MAX_WIDTH_PX = 480;
