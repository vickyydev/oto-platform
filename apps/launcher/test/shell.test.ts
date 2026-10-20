// The chat popup's shell (SCRUM-591, the chat-popup round): open or closed
// after each event, the thread's order, and the empty thread's one line.
// Pure; no DOM.
import { describe, expect, it } from 'vitest';
import type { Permission } from '@oto/shared/permissions';
import type { AskView } from '@/api/assistant';
import type { AskPhase } from '@/assistant/ask';
import {
  EMPTY_THREAD_NEUTRAL_LINE,
  emptyThreadLine,
  shellReducer,
  threadItemKey,
  threadOf,
} from '@/assistant/shell';
import type { SuiteApp } from '@/suite/apps';

function view(over: Partial<AskView> = {}): AskView {
  const base = {
    id: '01928f6e-0000-7000-8000-000000000001',
    state: 'answered' as const,
    reason: null,
    question: 'q',
    answer: 'a',
    links: [],
    refusals: [],
    toolCalls: [],
    feedback: null,
    correction: null,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:01.000Z',
    // The api's additive mark (the test-night round), set here so the fixture
    // typechecks whether or not the api's description carries it yet.
    smallTalk: false,
  };
  return { ...base, ...over };
}

const app = (key: SuiteApp['key']): SuiteApp => ({
  key,
  name: key,
  purpose: '',
  icon: (() => null) as unknown as SuiteApp['icon'],
  permission: `app:${key}:access` as SuiteApp['permission'],
  milestone: '',
  arriving: '',
});

describe('open or closed', () => {
  it('opens, toggles, and closes on Esc or the close control', () => {
    expect(shellReducer(false, 'open')).toBe(true);
    expect(shellReducer(false, 'toggle')).toBe(true);
    expect(shellReducer(true, 'toggle')).toBe(false);
    expect(shellReducer(true, 'escape')).toBe(false);
    expect(shellReducer(true, 'close')).toBe(false);
  });

  it('never closes on a click outside: a typed question must not be lost', () => {
    expect(shellReducer(true, 'outside-click')).toBe(true);
    expect(shellReducer(false, 'outside-click')).toBe(false);
  });
});

describe('the thread', () => {
  const older = view({ id: '01928f6e-0000-7000-8000-00000000000a', question: 'older', createdAt: '2026-10-20T08:00:00.000Z' });
  const newer = view({ id: '01928f6e-0000-7000-8000-00000000000b', question: 'newer', createdAt: '2026-10-20T09:00:00.000Z' });

  it('is oldest at the top and newest at the bottom, whatever order the list came in', () => {
    const items = threadOf([newer, older], { kind: 'idle' }, '');
    expect(items.map((i) => (i.kind === 'ask' ? i.ask.question : i.question))).toEqual(['older', 'newer']);
  });

  it('puts the question in flight last, as a pending item, with when it was sent', () => {
    const phase: AskPhase = { kind: 'sending', id: 'x', question: 'now?', };
    const items = threadOf([newer, older], phase, '2026-10-20T10:00:00.000Z');
    expect(items).toHaveLength(3);
    expect(items[2]).toMatchObject({ kind: 'pending', id: 'x', question: 'now?', sentAt: '2026-10-20T10:00:00.000Z' });
    expect(threadItemKey(items[2]!)).toBe('pending:x');
  });

  it('keeps a question that could not be sent in the thread, with its phase', () => {
    const phase: AskPhase = { kind: 'unreachable', id: 'x', question: 'now?', line: 'no' };
    const items = threadOf([], phase, '');
    expect(items).toEqual([{ kind: 'pending', id: 'x', question: 'now?', sentAt: '', phase }]);
  });

  it('shows a finished ask from its row even before the list has it, once', () => {
    const done = view({ id: '01928f6e-0000-7000-8000-00000000000c', question: 'done', createdAt: '2026-10-20T11:00:00.000Z' });
    const items = threadOf([older], { kind: 'done', ask: done, replayed: false }, '');
    expect(items.map((i) => (i.kind === 'ask' ? i.ask.question : i.question))).toEqual(['older', 'done']);
    const again = threadOf([done, older], { kind: 'done', ask: done, replayed: false }, '');
    expect(again).toHaveLength(2);
  });
});

describe('the empty thread (the test-night round, W8)', () => {
  const nothing = () => false;
  const everything = () => true;
  const only =
    (...held: Permission[]) =>
    (p: Permission) =>
      held.includes(p);

  it('names only the unanswered queue for someone with the Inbox alone', () => {
    const hana = only('assistant:ask:use', 'app:inbox:access', 'inbox:conversation:read');
    expect(emptyThreadLine(hana, [app('inbox')])).toBe('Ask about the unanswered queue…');
  });

  it('names four examples, in order, for a manager with everything: the rota and payslips do not fit', () => {
    expect(emptyThreadLine(everything, [app('console'), app('oto_app'), app('inbox')])).toBe(
      "Ask about members, today's check-ins, the unanswered queue, recent activity…",
    );
  });

  it("names the OTO App's rota and payslips by its tile on the launcher, not by a permission", () => {
    expect(emptyThreadLine(nothing, [app('oto_app')])).toBe('Ask about the rota, your payslips…');
    expect(emptyThreadLine(only('pos:member:read', 'pos:checkin:read'), [app('oto_app')])).toBe(
      "Ask about members, today's check-ins, the rota, your payslips…",
    );
  });

  it('names each example only for its own permission, whatever other tiles are there', () => {
    expect(emptyThreadLine(only('admin:audit:read'), [app('console'), app('pos')])).toBe('Ask about recent activity…');
    expect(emptyThreadLine(only('pos:checkin:read'), [app('pos')])).toBe("Ask about today's check-ins…");
  });

  it('falls back to the neutral line when none of the examples is true of this person', () => {
    expect(emptyThreadLine(nothing, [])).toBe(EMPTY_THREAD_NEUTRAL_LINE);
    expect(emptyThreadLine(only('assistant:ask:use', 'app:console:access'), [app('console')])).toBe(
      EMPTY_THREAD_NEUTRAL_LINE,
    );
    expect(EMPTY_THREAD_NEUTRAL_LINE).toBe('Ask a question about your work; I answer from what your access can see.');
  });
});
