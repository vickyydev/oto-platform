// @vitest-environment jsdom
//
// SCRUM-1016 — the list and its filters as approved (Main.dc.html,
// Filters.dc.html, Desktop.dc.html): one control for each thing at every
// width — the scope switch (Mine, Team, Handled), the "Needs reply" figure,
// the Unread quick filter, and Topic, Park, Channel and Language in the
// phone's Filters sheet or the desktop's views column — with "Hide till
// notices", the removable pills, the Handled tab's own choices, and the row
// with its one badge. Markup read with react-dom/server; presses driven in a
// DOM.
//
// FICTIONAL TEST DATA: every name is "ZZ TEST" or a demo park.
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationList as ListPage, ConversationRow, Dashboard as DashboardData, InboxMe } from '@/api/inbox';
import { AppBar } from '@/components/AppBar';
import { ConversationList, TILL_NOTICE_LABEL } from '@/components/ConversationList';
import { FiltersDialog, showConversationsLabel } from '@/components/dialogs';
import { Rail, ScopeTabs } from '@/components/Rail';
import { StatsRow } from '@/components/StatsRow';
import { EMPTY_FILTERS, type Filters } from '@/lib/query';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000e1';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const LINE = '0192f0a0-1234-7abc-8def-0000000000a1';

const me: InboxMe = {
  accountId: '018f0000-0000-7000-8000-000000000001',
  name: 'ZZ TEST agent',
  roles: ['events'],
  tabs: ['mine', 'team', 'handled'],
  teams: [
    { id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: true },
    { id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false },
  ],
  people: [],
  defaultReceptionBranchId: CENTRAL,
  simulator: null,
  testLines: [{ id: LINE, channel: 'whatsapp', displayName: 'ZZ TEST line', branchId: null, startOver: false }],
  capabilities: { writes: true, dashboard: true, assign: false, move: false, reopen: false, templates: false, kb: false, ai: false },
};
const data: DashboardData = {
  scope: 'team', newToday: 3, unanswered: 15, handledToday: 7, active: 18, averageFirstResponseSeconds: 273, population: 'active',
  byCategory: { birthdays: 9, general: 5, marketing: 3, gm: 1 }, day: '2026-11-19', beosThisWeek: 1, weekStart: '2026-11-16',
};
let n = 0;
function row(over: Partial<ConversationRow> = {}): ConversationRow {
  n += 1;
  return {
    id: `0192f0a0-1234-7abc-8def-0000000001${String(n).padStart(2, '0')}`,
    channel: 'whatsapp', channelAccountId: LINE, channelAccountName: 'ZZ TEST line', canReply: true,
    contact: { id: `0192f0a0-1234-7abc-8def-0000000002${String(n).padStart(2, '0')}`, channel: 'whatsapp', handle: 'ZZ TEST', displayName: `ZZ TEST guest ${n}`, phone: null, language: 'en', erased: false },
    category: 'general', intent: null, language: 'en', branchId: CENTRAL, teamId: T_CENTRAL, status: 'active',
    handledAt: null, handledByKind: null, lastMessageAt: '2026-11-19T05:00:00.000Z', lastMessagePreview: 'ZZ TEST line',
    unanswered: true, nextAction: 'staff_reply_needed', depositSignal: null, unread: 0, mine: true, assignments: [],
    createdAt: '2026-11-19T04:00:00.000Z', ...over,
  };
}
const page = (over: Partial<ListPage> = {}): ListPage => ({ conversations: [], nextCursor: null, tabCounts: { mine: 16, team: 18 }, ...over });
const noop = () => undefined;
const now = new Date('2026-11-19T06:00:00.000Z');

type ListProps = Parameters<typeof ConversationList>[0];
const listProps = (over: Partial<ListProps> = {}): ListProps => ({
  me, tab: 'mine', page: page(), rows: [row()], loading: false, loadingMore: false, error: null, filters: EMPTY_FILTERS,
  selectedId: null, now, onFilters: noop, onTab: noop, onOpenFilters: noop, onSelect: noop, onMore: noop, ...over,
});
const stats = (variant: 'bar' | 'card') =>
  createElement(StatsRow, { variant, data, error: null, unansweredOnly: false, onToggleUnanswered: noop });
const markup = (el: ReactElement) => renderToStaticMarkup(el);
const count = (html: string, needle: string) => html.split(needle).length - 1;

let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
});
async function mount(el: ReactElement) {
  root = createRoot(host);
  await act(async () => root!.render(el));
}
const press = async (el: Element | null) => {
  expect(el, 'the control is on the page').not.toBeNull();
  await act(async () => (el as HTMLElement).click());
};

describe('SCRUM-1016: each filter is offered once', () => {
  const rail = markup(createElement(Rail, { me, tab: 'mine', counts: { mine: 16, team: 18 }, filters: EMPTY_FILTERS, onTab: noop, onFilters: noop }));
  const list = markup(createElement(ConversationList, listProps({ strip: stats('card') })));
  const bar = markup(createElement(AppBar, { search: '', onSearch: noop, account: null }, stats('bar')));
  const screen = rail + list + bar;

  it('the scope switch: a tab list below 1024 px in the list, the views column’s switch from 1024 px, nothing in the app bar', () => {
    expect(count(screen, 'role="tablist"')).toBe(1);
    expect(list).toMatch(/<div class="lg:hidden"><div role="tablist" aria-label="Which conversations"/);
    expect(count(list, 'role="tab"')).toBe(3);
    expect(count(screen, '<nav aria-label="Which conversations"')).toBe(1);
    expect(rail).toMatch(/^<aside aria-label="Views" class="hidden [^"]*lg:flex/);
    const nav = /<nav aria-label="Which conversations"[\s\S]*?<\/nav>/.exec(rail)![0];
    expect([...nav.matchAll(/<button[^>]*>(Mine|Team|Handled)/g)].map((m) => m[1])).toEqual(['Mine', 'Team', 'Handled']);
    // The header's Handled button, the tiles and the Status row that did the same are gone.
    for (const word of ['>Mine<', '>Team<', '>Handled<']) expect(bar).not.toContain(word);
    expect(rail.replace(nav, '')).not.toMatch(/>(?:Mine|Team|Handled)</);
  });

  it('Topic, Park, Channel and Language: in the views column only, the list carries the sheet’s button below 1024 px', () => {
    for (const group of ['Filter by topic', 'Filter by park', 'Filter by channel', 'Filter by language']) {
      expect(count(screen, `aria-label="${group}"`), group).toBe(1);
      expect(rail).toContain(`aria-label="${group}"`);
    }
    expect(list).not.toContain('data-chip=');
    expect(list).toMatch(/<button type="button" aria-label="Filters" class="[^"]*lg:hidden/);
    // No Status row, no named views, no category legend that filters.
    expect(screen).not.toContain('Filter by status');
    expect(screen).not.toContain('data-chip="status:');
    expect(screen).not.toContain('data-view=');
    expect(screen).not.toContain('Inbox views');
  });

  it('Needs reply: the statistics row’s figure, one per width; Unread: one quick filter in the list', () => {
    const needs = (html: string) => count(html, '<span class="text-[11.5px] font-semibold leading-tight">Needs reply</span>');
    expect(needs(list)).toBe(1);
    expect(list).toMatch(/<div class="lg:hidden"><section aria-label="Today"/);
    expect(needs(bar)).toBe(1);
    expect(bar).toMatch(/<div class="ml-auto hidden min-w-0 lg:flex"><section aria-label="Today"/);
    expect(rail).not.toContain('Needs reply');
    expect(count(screen, '>Unread<')).toBe(1);
    expect(list).toMatch(/<button type="button" aria-pressed="false" class="[^"]*">Unread<\/button>/);
  });

  it('Hide till notices: in the views column, and in the sheet; never twice on one screen', () => {
    expect(count(screen, 'data-switch="hide-notices"')).toBe(1);
    const sheet = markup(createElement(FiltersDialog, { open: true, onClose: noop, me, filters: EMPTY_FILTERS, onChange: noop, onClear: noop }));
    expect(count(sheet, 'data-switch="hide-notices"')).toBe(1);
    // On by default, a switch by role.
    expect(/<input[^>]*data-switch="hide-notices"[^>]*>/.exec(sheet)![0]).toMatch(/(?=.*role="switch")(?=.*checked="")/);
    const off = markup(createElement(FiltersDialog, { open: true, onClose: noop, me, filters: { ...EMPTY_FILTERS, hideNotices: false }, onChange: noop, onClear: noop }));
    expect(/<input[^>]*data-switch="hide-notices"[^>]*>/.exec(off)![0]).not.toContain('checked');
    // The sheet holds the four rows once and nothing that lives elsewhere.
    for (const group of ['Filter by topic', 'Filter by park', 'Filter by channel', 'Filter by language']) {
      expect(count(sheet, `aria-label="${group}"`), group).toBe(1);
    }
    for (const elsewhere of ['role="tablist"', '>Unread<', 'Needs reply', 'Inbox views']) expect(sheet).not.toContain(elsewhere);
  });
});

describe('SCRUM-1016: the Filters sheet', () => {
  it('applies a choice as it is pressed, folds General into Topic, switches the notices, clears and closes', async () => {
    const onChange = vi.fn(), onClear = vi.fn(), onClose = vi.fn();
    await mount(createElement(FiltersDialog, { open: true, onClose, me, filters: EMPTY_FILTERS, onChange, onClear, showLabel: 'Show 9 conversations' }));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close filters');
    await press(dialog.querySelector('[data-chip="category:birthdays"]'));
    expect(onChange).toHaveBeenLastCalledWith({ category: 'birthdays', inbox: '' });
    await press(dialog.querySelector('[data-chip="inbox:general"]'));
    expect(onChange).toHaveBeenLastCalledWith({ category: '', inbox: 'general' });
    await press(dialog.querySelector(`[data-chip="branchId:${CENTRAL}"]`));
    expect(onChange).toHaveBeenLastCalledWith({ branchId: CENTRAL });
    // A test line is a Channel choice of its own, before any of its rows is read.
    await press(dialog.querySelector(`[data-chip="channelAccountId:${LINE}"]`));
    expect(onChange).toHaveBeenLastCalledWith({ channelAccountId: LINE });
    await press(dialog.querySelector('[data-chip="language:th"]'));
    expect(onChange).toHaveBeenLastCalledWith({ language: 'th' });
    await press(dialog.querySelector('[data-switch="hide-notices"]'));
    expect(onChange).toHaveBeenLastCalledWith({ hideNotices: false });
    const buttons = [...dialog.querySelectorAll('button')];
    await press(buttons.find((b) => b.textContent === 'Clear') ?? null);
    expect(onClear).toHaveBeenCalledTimes(1);
    await press(buttons.find((b) => b.textContent === 'Show 9 conversations') ?? null);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a pressed choice pressed again goes back to all; "all" itself never toggles off', async () => {
    const onChange = vi.fn();
    const chosen: Filters = { ...EMPTY_FILTERS, category: 'gm', language: 'ru' };
    await mount(createElement(FiltersDialog, { open: true, onClose: noop, me, filters: chosen, onChange, onClear: noop }));
    await press(document.querySelector('[data-chip="category:gm"]'));
    expect(onChange).toHaveBeenLastCalledWith({ category: '', inbox: '' });
    await press(document.querySelector('[data-chip="language:ru"]'));
    expect(onChange).toHaveBeenLastCalledWith({ language: '' });
    await press(document.querySelector('[data-chip="language:all"]'));
    expect(onChange).toHaveBeenLastCalledWith({ language: '' });
    expect(document.querySelector('[data-chip="category:gm"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-chip="category:all"]')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('says how many conversations it shows only when the list read gives the number whole', () => {
    expect(showConversationsLabel({ loading: true, count: 4, more: false })).toBe('Show conversations');
    expect(showConversationsLabel({ loading: false, count: 9, more: false })).toBe('Show 9 conversations');
    expect(showConversationsLabel({ loading: false, count: 1, more: false })).toBe('Show 1 conversation');
    expect(showConversationsLabel({ loading: false, count: 50, more: true })).toBe('Show 50+ conversations');
    expect(showConversationsLabel({ loading: false, count: 0, more: false })).toBe('Show 0 conversations');
  });
});

describe('SCRUM-1016: the list head', () => {
  it('the scope switch moves with the arrow keys, Home and End, and says the working tabs’ counts', async () => {
    const onTab = vi.fn();
    await mount(createElement(ScopeTabs, { tabs: me.tabs, tab: 'mine', counts: { mine: 16, team: 18 }, onTab }));
    const tabs = [...document.querySelectorAll('[role="tab"]')] as HTMLElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(['Mine16', 'Team18', 'Handled']);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    const list = document.querySelector('[role="tablist"]')!;
    for (const [k, expected] of [['ArrowRight', 'team'], ['ArrowLeft', 'handled'], ['End', 'handled'], ['Home', 'mine']] as const) {
      await act(async () => {
        list.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      });
      expect(onTab).toHaveBeenLastCalledWith(expected);
    }
    await press(tabs[2]!);
    expect(onTab).toHaveBeenLastCalledWith('handled');
  });

  it('Unread is a quick filter of its own; Filters opens the sheet and counts what it applied', async () => {
    const onFilters = vi.fn(), onOpenFilters = vi.fn();
    await mount(createElement(ConversationList, listProps({ onFilters, onOpenFilters, filters: { ...EMPTY_FILTERS, branchId: CENTRAL, language: 'ru' } })));
    const unread = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Unread')!;
    expect(unread.getAttribute('aria-pressed')).toBe('false');
    await press(unread);
    expect(onFilters).toHaveBeenLastCalledWith({ unread: true });
    const filters = document.querySelector('[aria-label="Filters"]')!;
    expect(filters.textContent).toBe('Filters2');
    await press(filters);
    expect(onOpenFilters).toHaveBeenCalled();
    // The applied filters as removable pills; one press clears exactly one.
    await press(document.querySelector('[aria-label="Clear Russian"]'));
    expect(onFilters).toHaveBeenLastCalledWith({ language: '' });
  });

  it('Handled keeps its range, "Resolved by" and the Export that is not built yet, on the Handled tab only', () => {
    const handled = markup(createElement(ConversationList, listProps({ tab: 'handled' })));
    expect(handled).toContain('role="group" aria-label="Handled in the last"');
    expect(handled).toContain('role="group" aria-label="Resolved by"');
    for (const word of ['Today', '7 days', '30 days', '90 days', 'All time', 'Anyone', 'AI', 'Human']) expect(handled).toContain(`>${word}<`);
    expect(handled).toMatch(/<button type="button" aria-pressed="true"[^>]*>30 days</);
    expect(handled).toMatch(/disabled=""[^>]*>Export</);
    expect(markup(createElement(ConversationList, listProps({ tab: 'mine' })))).not.toContain('Handled in the last');
  });
});

describe('SCRUM-1016: the rows and the list’s states', () => {
  it('a row: the face with its channel dot, name and time, one line, one badge, "Topic · Park" and the unread count', () => {
    const html = markup(createElement(ConversationList, listProps({ rows: [row({ unread: 2 })] })));
    expect(html).toMatch(/border-radius:14px/);
    expect(html).toContain('bg-channel-whatsapp');
    expect(html).toContain('>Needs reply<');
    expect(html).toContain('>General · Central Floresta<');
    expect(html).toContain('aria-label="2 unread messages for you"');
    // No category, status or assignee chips, and no hover "Mark handled": the chat carries them.
    for (const gone of ['Mark handled', '>Active<', 'Unassigned', 'ring-violet', 'ring-sky']) expect(html).not.toContain(gone);
  });

  it('a till notice thread, when shown, says so in its one badge', () => {
    const html = markup(createElement(ConversationList, listProps({ rows: [row({ canReply: false, nextAction: 'waiting_customer' })] })));
    expect(html).toContain(`>${TILL_NOTICE_LABEL}<`);
    expect(html).not.toContain('>Waiting for customer<');
  });

  it('a press opens the row; Ready to book stays pinned on top on its green ground', async () => {
    const onSelect = vi.fn();
    const paid = row({ depositSignal: 'paid', nextAction: 'staff_action_needed', category: 'birthdays', teamId: T_BIRTHDAYS });
    const plain = row({ lastMessageAt: '2026-11-19T05:59:00.000Z' });
    await mount(createElement(ConversationList, listProps({ rows: [plain, paid], onSelect, selectedId: paid.id })));
    const group = document.querySelector('[data-testid="ready-to-book"]')!;
    expect(group.querySelector('h3')!.textContent).toBe('Ready to book1');
    const button = group.querySelector('button')!;
    expect(button.className).toContain('bg-money');
    expect(button.className).toContain('ring-ink');
    expect(button.getAttribute('aria-current')).toBe('true');
    expect(document.body.textContent!.indexOf('Ready to book')).toBeLessThan(document.body.textContent!.indexOf(plain.contact.displayName!));
    await press(button);
    expect(onSelect).toHaveBeenCalledWith(paid.id);
  });

  it('says it is reading, could not read, or has nothing; and pages with "More conversations"', async () => {
    expect(markup(createElement(ConversationList, listProps({ rows: [], loading: true })))).toContain('role="status" aria-label="Reading the conversations"');
    const failed = markup(createElement(ConversationList, listProps({ rows: [], error: 'The conversations could not be read.' })));
    expect(failed).toMatch(/role="alert"[^>]*>The conversations could not be read\.</);
    expect(markup(createElement(ConversationList, listProps({ rows: [] })))).toContain('No conversations');
    const onMore = vi.fn();
    await mount(createElement(ConversationList, listProps({ page: page({ nextCursor: 'ZZ-cursor' }), onMore })));
    expect(document.body.textContent).toContain('1+ conversations · newest first');
    await press([...document.querySelectorAll('button')].find((b) => b.textContent === 'More conversations') ?? null);
    expect(onMore).toHaveBeenCalled();
  });
});
