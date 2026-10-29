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
import {
  closedForNow,
  directEntryUrl,
  findApp,
  launcherTiles,
  tileAction,
  type LauncherTile,
  type RegistryTile,
  type SuiteApp,
} from '@/suite/apps';

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

// SCRUM-643 — the launcher reads the suite registry (planner ruling Q24): the
// registry orders, hides and closes tiles, but never adds one or widens a gate.
describe('the registry on the tiles (SCRUM-643)', () => {
  const holds =
    (...held: Permission[]) =>
    (p: Permission) =>
      held.includes(p);
  const row = (key: RegistryTile['key'], over: Partial<RegistryTile> = {}): RegistryTile => ({
    key, sortOrder: 0, state: 'open', maintenance: null, ...over,
  });
  const later = '2026-10-27T12:00:00.000Z';

  it('keeps every existing gate: a registry row never adds a tile the person has no grant for', () => {
    const tiles = launcherTiles(holds('app:pos:access'), [row('pos'), row('console'), row('inbox')]);
    expect(tiles.map((t) => t.app.key)).toEqual(['pos']);
  });

  it('the Lucky Wheel opens its demonstration wheel with no hand-off (SCRUM-694)', () => {
    const booth = findApp('booth')!;
    expect(directEntryUrl({ ...booth, origin: 'https://booth.example' })).toBe('https://booth.example/#fake');
    const pos = findApp('pos')!;
    expect(directEntryUrl({ ...pos, origin: 'https://pos.example' })).toBeNull();
    // No address on this build: nothing to open.
    expect(directEntryUrl({ ...booth, origin: undefined })).toBeNull();
  });

  it('keeps the booth behind its second permission whatever the registry says', () => {
    expect(launcherTiles(holds('app:booth:access'), [row('booth')]).map((t) => t.app.key)).toEqual([]);
    expect(launcherTiles(holds('app:booth:access', 'admin:booth:read'), [row('booth')]).map((t) => t.app.key)).toEqual(['booth']);
  });

  it('orders by the registry, hides a hidden app, and keeps static identity', () => {
    const has = holds('app:pos:access', 'app:console:access', 'app:inbox:access');
    const tiles = launcherTiles(has, [row('pos', { sortOrder: 30 }), row('console', { sortOrder: 10, state: 'hidden' }), row('inbox', { sortOrder: 20 })]);
    expect(tiles.map((t) => t.app.key)).toEqual(['inbox', 'pos']);
    expect(tiles[0]!.app.name).toBe('Inbox');
    expect(typeof tiles[0]!.app.icon).not.toBe('undefined');
  });

  it('without a registry the tiles stand exactly as before it existed', () => {
    const has = holds('app:pos:access', 'app:console:access');
    expect(launcherTiles(has, null).map((t) => [t.app.key, t.state])).toEqual([['pos', 'open'], ['console', 'open']]);
  });

  it('shows maintenance with its message, and a maintenance tile opens nothing', () => {
    const [tile] = launcherTiles(holds('app:inbox:access'), [row('inbox', { state: 'maintenance', maintenance: { message: 'Back at noon', expiresAt: later } })]);
    expect(tile).toMatchObject({ state: 'maintenance', maintenance: { message: 'Back at noon' } });
    expect(tileAction(tile!, Date.parse(later) - 1)).toBe('none');
  });

  it('refuses a stale maintenance tile: once its window has passed it reads the registry again instead of acting', () => {
    const tile: LauncherTile = { app: { ...app('inbox'), origin: 'https://inbox.example' }, state: 'maintenance',
      maintenance: { message: 'Back at noon', expiresAt: later } };
    expect(tileAction(tile, Date.parse(later))).toBe('refresh');
  });

  it('opens only an open, deployed app; coming soon goes to its page', () => {
    const live = { ...app('pos'), origin: 'https://pos.example' };
    expect(tileAction({ app: live, state: 'open', maintenance: null })).toBe('open');
    expect(tileAction({ app: live, state: 'coming_soon', maintenance: null })).toBe('soon');
    expect(tileAction({ app: app('pos'), state: 'open', maintenance: null })).toBe('soon');
  });

  it('treats the hand-off refusals of a closed app as closed, and nothing else', () => {
    expect(closedForNow('APP_IN_MAINTENANCE')).toBe(true);
    expect(closedForNow('APP_SIGN_IN_BLOCKED')).toBe(true);
    expect(closedForNow('HANDOFF_REJECTED')).toBe(false);
    expect(closedForNow(undefined)).toBe(false);
  });
});
