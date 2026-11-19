// SCRUM-1016 — the workspace's side of the new filters, run with the till's
// hooks harness (no DOM), as workspace-access-993.test.ts runs it: "Hide till
// notices" is on unless this browser turned it off and is remembered; while
// it is on, the list and the day's figures both ask the api to leave the
// notices out; the views column gets the topics' counts from the list read;
// the Filters sheet's button says what the read said; Clear resets the
// sheet's choices and nothing else.
//
// FICTIONAL TEST DATA: the viewer is "ZZ TEST".
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationList as ListPage, ConversationRow, InboxMe } from '@/api/inbox';
import { ConversationList } from '@/components/ConversationList';
import { FiltersDialog } from '@/components/dialogs';
import { Rail } from '@/components/Rail';
import { Workspace } from '@/components/Workspace';
import { EMPTY_FILTERS, type Filters } from '@/lib/query';
import { renderHook } from '../../pos/test/support/hooks';

const calls = vi.hoisted(() => ({ dashboard: vi.fn(), conversations: vi.fn(), reload: vi.fn(async () => undefined) }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...await import('../../pos/test/support/hooks') }));
vi.mock('@/api/inbox', async original => ({ ...await original<typeof import('@/api/inbox')>(), inboxApi: {
  dashboard: calls.dashboard, conversations: calls.conversations,
} }));
vi.mock('@/auth/SessionContext', () => ({ useSession: () => ({ signOut: vi.fn(), reload: calls.reload }) }));
vi.mock('@/lib/theme', async original => ({ ...await original<typeof import('@/lib/theme')>(), useTheme: () => ({ theme: 'light', setTheme: vi.fn() }) }));

const me: InboxMe = { accountId: '018f0000-0000-7000-8000-000000000001', name: 'ZZ TEST viewer', roles: ['owner'], tabs: ['team', 'handled'],
  teams: [], people: [], defaultReceptionBranchId: null, simulator: null, access: { categories: null, channelAccountIds: null, version: 0 },
  capabilities: { writes: true, dashboard: true, assign: false, move: false, reopen: false, templates: false, kb: false, ai: false } };
const row = (i: number): ConversationRow => ({ id: `0192f0a0-1234-7abc-8def-0000000003${String(i).padStart(2, '0')}`, channel: 'whatsapp',
  channelAccountId: '0192f0a0-1234-7abc-8def-0000000000a1', channelAccountName: 'ZZ TEST line', canReply: true,
  contact: { id: `0192f0a0-1234-7abc-8def-0000000004${String(i).padStart(2, '0')}`, channel: 'whatsapp', handle: 'ZZ TEST', displayName: `ZZ TEST ${i}`, phone: null, language: 'en', erased: false },
  category: 'general', intent: null, language: 'en', branchId: null, teamId: null, status: 'active', handledAt: null, handledByKind: null,
  lastMessageAt: '2026-11-19T05:00:00.000Z', lastMessagePreview: 'ZZ TEST', unanswered: true, unread: 0, mine: false, assignments: [],
  createdAt: '2026-11-19T04:00:00.000Z' });
const topicCounts = { birthdays: 1, general: 3, marketing: 0, gm: 0, heldInGeneral: 1 };
const listPage = (over: Partial<ListPage> = {}): ListPage =>
  ({ conversations: [row(1), row(2), row(3)], nextCursor: null, tabCounts: { team: 3, handled: 0 }, topicCounts, access: me.access, ...over });

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const find = (tree: ReactNode, type: unknown) => elements(tree).find((e) => e.type === type)!;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

let stored: Record<string, string>;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  stored = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored[k] ?? null, setItem: vi.fn((k: string, v: string) => { stored[k] = v; }) });
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  vi.stubGlobal('window', { location: new URL('https://inbox.example.invalid/'),
    history: { state: null, pushState: vi.fn(), replaceState: vi.fn() },
    matchMedia: () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), setInterval, clearInterval, setTimeout, clearTimeout });
  calls.conversations.mockResolvedValue(listPage());
  calls.dashboard.mockResolvedValue(null);
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SCRUM-1016: "Hide till notices" in the workspace', () => {
  it('is on by default: the list and the figures both ask for the threads that can take a reply', async () => {
    const hook = renderHook(Workspace, { me }); cleanup = hook.unmount; await flush();
    expect(calls.conversations.mock.calls[0]![0]).toMatchObject({ tab: 'team', replyable: 'true' });
    expect(calls.dashboard).toHaveBeenLastCalledWith({ replyable: 'true' });
    expect((find(hook.result.current, ConversationList).props.filters as Filters).hideNotices).toBe(true);
  });

  it('is remembered per browser: turned off, both reads show the notices, and the choice is stored', async () => {
    stored['oto.hideTillNotices'] = '0';
    const hook = renderHook(Workspace, { me }); cleanup = hook.unmount; await flush();
    expect(calls.conversations.mock.calls[0]![0]).not.toHaveProperty('replyable');
    expect(calls.dashboard).toHaveBeenLastCalledWith({});
    // Turned back on from the sheet: both are read again with it, and the browser keeps it.
    (find(hook.result.current, FiltersDialog).props.onChange as (p: Partial<Filters>) => void)({ hideNotices: true });
    await flush();
    expect(calls.conversations.mock.calls.at(-1)![0]).toMatchObject({ replyable: 'true' });
    expect(calls.dashboard).toHaveBeenLastCalledWith({ replyable: 'true' });
    expect(stored['oto.hideTillNotices']).toBe('1');
  });

  it('turned on with a notices-only number chosen under Channel, lets the number go rather than show an empty list', async () => {
    // SCRUM-1016 (review): Channel offered "Check-in notices (WhatsApp)" with
    // the switch on, and the list it asked for (that number, replyable only)
    // was always empty, with no reason said.
    stored['oto.hideTillNotices'] = '0';
    const NOTICES = '0192f0a0-1234-7abc-8def-0000000000b9';
    const notice: ConversationRow = { ...row(9), channelAccountId: NOTICES, channelAccountName: 'ZZ TEST check-in notices', canReply: false };
    calls.conversations.mockResolvedValue(listPage({ conversations: [row(1), notice] }));
    const hook = renderHook(Workspace, { me }); cleanup = hook.unmount; await flush();
    // The number is learned with what it can do.
    expect(find(hook.result.current, Rail).props.sources).toContainEqual({ id: NOTICES, channel: 'whatsapp', name: 'ZZ TEST check-in notices', canReply: false });
    const change = find(hook.result.current, FiltersDialog).props.onChange as (p: Partial<Filters>) => void;
    change({ channelAccountId: NOTICES });
    await flush();
    expect(calls.conversations.mock.calls.at(-1)![0]).toMatchObject({ channelAccountId: NOTICES });
    change({ hideNotices: true });
    await flush();
    expect((find(hook.result.current, ConversationList).props.filters as Filters)).toMatchObject({ hideNotices: true, channelAccountId: '' });
    expect(calls.conversations.mock.calls.at(-1)![0]).toMatchObject({ replyable: 'true' });
    expect(calls.conversations.mock.calls.at(-1)![0]).not.toHaveProperty('channelAccountId');
    // A number that can reply stays chosen when the switch goes on.
    change({ hideNotices: false });
    change({ channelAccountId: row(1).channelAccountId });
    change({ hideNotices: true });
    await flush();
    expect((find(hook.result.current, ConversationList).props.filters as Filters).channelAccountId).toBe(row(1).channelAccountId);
  });

  it('a storage that refuses reads as on', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('ZZ TEST blocked'); }, setItem: () => { throw new Error('ZZ TEST blocked'); } });
    const hook = renderHook(Workspace, { me }); cleanup = hook.unmount; await flush();
    expect(calls.conversations.mock.calls[0]![0]).toMatchObject({ replyable: 'true' });
  });
});

describe('SCRUM-1016: the list read feeds the views column and the sheet', () => {
  it('hands the topics’ counts to the views column and says the read’s count on the sheet’s button', async () => {
    const hook = renderHook(Workspace, { me }); cleanup = hook.unmount; await flush();
    expect(find(hook.result.current, Rail).props.topicCounts).toEqual(topicCounts);
    expect(find(hook.result.current, FiltersDialog).props.showLabel).toBe('Show 3 conversations');
    // A filter chosen: while the read is out the button names no number, then the new one.
    let answer!: (p: ListPage) => void;
    calls.conversations.mockReturnValueOnce(new Promise<ListPage>((yes) => { answer = yes; }));
    (find(hook.result.current, FiltersDialog).props.onChange as (p: Partial<Filters>) => void)({ category: 'birthdays' });
    await flush();
    expect(find(hook.result.current, FiltersDialog).props.showLabel).toBe('Show conversations');
    answer(listPage({ conversations: [row(4)], nextCursor: 'ZZ-cursor' }));
    await flush();
    expect(find(hook.result.current, FiltersDialog).props.showLabel).toBe('Show 1+ conversations');
  });

  it('Clear puts the sheet’s choices back, the notices hidden again, and keeps the quick filters, search and archive', async () => {
    stored['oto.hideTillNotices'] = '0';
    const hook = renderHook(Workspace, { me }); cleanup = hook.unmount; await flush();
    const change = find(hook.result.current, FiltersDialog).props.onChange as (p: Partial<Filters>) => void;
    change({ category: 'gm', branchId: '00000000-0000-7000-8000-00000000000c', language: 'th', unread: true, unanswered: true, archiveRange: '7d' });
    await flush();
    (find(hook.result.current, FiltersDialog).props.onClear as () => void)();
    await flush();
    expect(find(hook.result.current, ConversationList).props.filters).toEqual({
      ...EMPTY_FILTERS, unread: true, unanswered: true, archiveRange: '7d', hideNotices: true,
    });
  });
});
