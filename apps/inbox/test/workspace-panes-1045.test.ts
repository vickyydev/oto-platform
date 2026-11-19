// SCRUM-1045 — the workspace's panes, run with the till's hooks harness (no
// DOM), as workspace-filters-1016.test.ts runs it: from 768 px the list and
// the chat stand side by side with the divider between them, the list at its
// default width or the one this browser chose for the layout, clamped to the
// room; on a phone, one pane at a time and no divider.
//
// FICTIONAL TEST DATA: the viewer is "ZZ TEST".
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationList as ListPage, InboxMe } from '@/api/inbox';
import { PaneDivider } from '@/components/PaneDivider';
import { Workspace } from '@/components/Workspace';
import { CHAT_MIN, LIST_MIN, RAIL_WIDTH, listDefault } from '@/lib/panes';
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
const listPage: ListPage = { conversations: [], nextCursor: null, tabCounts: { team: 0, handled: 0 }, access: me.access };

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const all = (tree: ReactNode) => elements(tree);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

let stored: Record<string, string>;
let cleanup: (() => void) | undefined;
function stubWindow(width: number) {
  vi.stubGlobal('window', { location: new URL('https://inbox.example.invalid/'), innerWidth: width,
    history: { state: null, pushState: vi.fn(), replaceState: vi.fn() },
    matchMedia: (q: string) => ({ matches: Number(/\d+/.exec(q)?.[0] ?? 0) <= width, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), setInterval, clearInterval, setTimeout, clearTimeout });
}
async function render(width: number) {
  stubWindow(width);
  const hook = renderHook(Workspace, { me });
  cleanup = hook.unmount;
  await flush();
  const tree = hook.result.current as ReactNode;
  const main = all(tree).find((e) => e.type === 'main')!;
  const section = (label: string) => all(tree).find((e) => e.type === 'section' && e.props['aria-label'] === label)!;
  return {
    divider: all(tree).find((e) => e.type === PaneDivider),
    style: main.props.style as Record<string, string>,
    list: String(section('Conversations').props.className),
    chat: String(section('Conversation').props.className),
  };
}

beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  stored = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored[k] ?? null, setItem: vi.fn((k: string, v: string) => { stored[k] = v; }), removeItem: (k: string) => { delete stored[k]; } });
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  calls.conversations.mockResolvedValue(listPage);
  calls.dashboard.mockResolvedValue(null);
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('SCRUM-1045: the panes in the workspace', () => {
  it('a phone: one pane at a time, the list first, and no divider', async () => {
    const p = await render(390);
    expect(p.divider).toBeUndefined();
    expect(p.style.gridTemplateColumns).toBe('minmax(0,1fr)');
    expect(p.list.split(' ')).toContain('flex');
    expect(p.chat.split(' ')).toContain('hidden');
  });

  it('an upright tablet: the list at 36 % beside the chat, the divider between them', async () => {
    const p = await render(768);
    expect(p.style.gridTemplateColumns).toBe('var(--list-w) minmax(0,1fr)');
    expect(p.style['--list-w']).toBe(`${listDefault(768)}px`);
    expect(768 - listDefault(768)).toBeGreaterThanOrEqual(CHAT_MIN);
    expect(p.divider?.props).toMatchObject({ width: listDefault(768), room: 768, left: 'var(--list-w)', controls: 'inbox-list' });
    expect(p.list.split(' ')).toEqual(expect.arrayContaining(['flex', 'border-r']));
    expect(p.chat.split(' ')).toContain('flex');
  });

  it('a desktop: the views column, then the list and the chat with the divider at the list’s edge', async () => {
    const p = await render(1440);
    const room = 1440 - RAIL_WIDTH;
    expect(p.style.gridTemplateColumns).toBe(`${RAIL_WIDTH}px var(--list-w) minmax(0,1fr)`);
    expect(p.divider?.props).toMatchObject({ width: listDefault(room), room, left: `calc(${RAIL_WIDTH}px + var(--list-w))` });
  });

  it('starts from the width this browser chose for the layout, clamped to the room', async () => {
    stored['oto.inbox.listWidth.tablet'] = '330';
    expect((await render(768)).divider?.props.width).toBe(330);
    cleanup?.();
    stored['oto.inbox.listWidth.tablet'] = '700';
    expect((await render(768)).divider?.props.width).toBe(768 - CHAT_MIN);
    cleanup?.();
    stored['oto.inbox.listWidth.tablet'] = '10';
    expect((await render(768)).divider?.props.width).toBe(LIST_MIN);
    cleanup?.();
    // The desktop's own choice is apart from the tablet's.
    expect((await render(1440)).divider?.props.width).toBe(listDefault(1440 - RAIL_WIDTH));
  });

  it('a committed width is remembered for its layout; a reset forgets it', async () => {
    const p = await render(768);
    const commit = p.divider!.props.onCommit as (w: number | 'default') => void;
    commit(312);
    expect(stored['oto.inbox.listWidth.tablet']).toBe('312');
    commit('default');
    expect(stored['oto.inbox.listWidth.tablet']).toBeUndefined();
  });
});
