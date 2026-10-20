/**
 * THE CHAT POPUP'S SHELL (SCRUM-591, the chat-popup round): what the floating
 * button and the popup decide, with no DOM in it, so the unit tests drive it
 * in Node. The ask state machine (`ask.ts`) is untouched; this is only how
 * its phases are laid out as a conversation and when the popup is open.
 */
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

/**
 * The one line an empty thread shows. Its examples are the tools this person
 * could use: members and the check-in board are platform tools every asker
 * has; the rota and payslips are the OTO App's, named only when that app is
 * on their launcher.
 */
export function emptyThreadLine(tiles: SuiteApp[]): string {
  const examples = ['members', "today's check-ins"];
  if (tiles.some((t) => t.key === 'oto_app')) examples.push('the rota', 'your payslips');
  return `Ask about ${examples.join(', ')}…`;
}

/** The width at and under which the popup is a full-height sheet. */
export const SHEET_MAX_WIDTH_PX = 480;
