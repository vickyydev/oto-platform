// The playbook build's Inbox UI (SCRUM-220, Tom's playbook 2026-10-28): the
// rail's chip filters in place of the dropdowns, the named inbox views above
// them, every conversation labelled with the number it came in on, and the GM
// queue's label and colour wherever a category shows. Node, no DOM, as the
// other markup files: the components rendered with react-dom/server, and the
// chips' and views' presses read through the same pure functions the
// components call, so what is pinned is what the page would say after a tap.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationDetail, ConversationRow, InboxMe } from '@/api/inbox';
import { CategoryMixCard } from '@/components/atoms';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { ConversationList } from '@/components/ConversationList';
import { DetailsDialog, FiltersDialog } from '@/components/dialogs';
import { FilterFields, InboxViews, Rail } from '@/components/Rail';
import {
  applyView,
  currentView,
  mergeSources,
  namedViews,
  sourceLabel,
  sourcesOfRows,
  toggleChip,
  type SourceOption,
} from '@/lib/inboxes';
import { EMPTY_FILTERS, activeFilterCount, filterPills, listQuery, type Filters } from '@/lib/query';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const CHALONG = '00000000-0000-7000-8000-0000000000c2';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000e1';
const T_CHALONG = '00000000-0000-7000-8000-0000000000e2';
const T_MARKETING = '00000000-0000-7000-8000-0000000000f1';
const T_GM = '00000000-0000-7000-8000-0000000000f2';
const GM = '00000000-0000-7000-8000-00000000009a';
const CONV = '0192f0a0-1234-7abc-8def-0123456789ab';
const CONTACT = '0192f0a0-1234-7abc-8def-0123456789ac';
const WA_CENTRAL = '0192f0a0-1234-7abc-8def-0000000000a1';
const WA_CHALONG = '0192f0a0-1234-7abc-8def-0000000000a2';
const WA_COUNTER = '0192f0a0-1234-7abc-8def-0000000000a3';
const IG = '0192f0a0-1234-7abc-8def-0000000000b1';
const FB = '0192f0a0-1234-7abc-8def-0000000000b2';

const teams: InboxMe['teams'] = [
  { id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: false },
  { id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false },
  { id: T_CHALONG, kind: 'reception', name: 'Reception · Robinson Chalong', colour: 'sky', branchId: CHALONG, member: false },
  { id: T_MARKETING, kind: 'marketing', name: 'Marketing', colour: 'pink', branchId: null, member: false },
  { id: T_GM, kind: 'gm', name: 'GM', colour: 'amber', branchId: null, member: false },
];

const hana: InboxMe = {
  accountId: GM,
  name: 'Demo Hana (GM)',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams,
  people: [{ accountId: GM, name: 'Demo Hana (GM)', teamIds: [], operatorWide: true }],
  defaultReceptionBranchId: CENTRAL,
  capabilities: { writes: true, dashboard: true, assign: true, move: true, reopen: true, templates: true, kb: true, ai: true },
  simulator: null,
};

const sources: SourceOption[] = mergeSources(
  [],
  [
    { id: FB, channel: 'facebook', name: 'OTO Park Facebook' },
    { id: WA_CHALONG, channel: 'whatsapp', name: 'Reception · Robinson Chalong' },
    { id: IG, channel: 'instagram', name: 'OTO Park Instagram' },
    { id: WA_CENTRAL, channel: 'whatsapp', name: 'Reception · Central Floresta' },
    { id: WA_COUNTER, channel: 'whatsapp', name: null },
  ],
);

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: CONV,
    channel: 'whatsapp',
    channelAccountId: WA_CENTRAL,
    channelAccountName: 'Reception · Central Floresta',
    canReply: true,
    contact: { id: CONTACT, channel: 'whatsapp', handle: '+66812345678', displayName: 'Olga Demo', phone: '+66812345678', language: 'ru', erased: false },
    category: 'general',
    intent: 'pricing',
    language: 'ru',
    branchId: CENTRAL,
    teamId: T_CENTRAL,
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-10-28T03:00:00.000Z',
    lastMessagePreview: 'How much is a ticket?',
    unanswered: true,
    unread: 1,
    mine: false,
    assignments: [],
    createdAt: '2026-10-28T02:00:00.000Z',
    ...over,
  };
}

function detail(r: ConversationRow): ConversationDetail {
  return {
    ...r,
    teamName: 'Reception · Central Floresta',
    firstResponseAt: null,
    reopenedAt: null,
    member: null,
    events: [],
    divertTo: null,
    aiMode: 'off',
    aiPaused: false,
    aiPausedAt: null,
    aiPausedByAccountId: null,
    aiState: 'off',
  };
}

const thread = (d: ConversationDetail | null): Thread => ({ detail: d, messages: [], olderCursor: null, loading: false, loadingOlder: false, error: null });
const noop = () => undefined;
const now = new Date('2026-10-28T04:00:00.000Z');

function list(rows: ConversationRow[], filters: Filters = EMPTY_FILTERS, withSources: readonly SourceOption[] = sources): string {
  return renderToStaticMarkup(
    createElement(ConversationList, {
      me: hana,
      tab: 'team',
      page: null,
      rows,
      loading: false,
      loadingMore: false,
      error: null,
      filters,
      search: '',
      selectedId: null,
      now,
      sources: withSources,
      onSearch: noop,
      onFilters: noop,
      onTab: noop,
      onOpenFilters: noop,
      onSelect: noop,
      onAskHandle: noop,
      onMore: noop,
    }),
  );
}

function panel(r: ConversationRow, detailsOpen = false): string {
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      row: r,
      thread: thread(detail(r)),
      me: hana,
      now,
      inserted: null,
      detailsOpen,
      onBack: noop,
      onLoadOlder: noop,
      onOpenDetails: noop,
      onCloseDetails: noop,
      onOpenTemplates: noop,
      onAskHandle: noop,
      onChanged: async () => undefined,
    }),
  );
}

const fields = (filters: Filters, withSources: readonly SourceOption[] = sources) =>
  renderToStaticMarkup(createElement(FilterFields, { me: hana, filters, onChange: noop, sources: withSources }));

/** The `<button …>` tag of one chip or view, by its data key. */
function tagOf(html: string, attr: 'data-chip' | 'data-view', key: string): string {
  const m = new RegExp(`<button[^>]*${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(html);
  if (!m) throw new Error(`no ${attr}="${key}" in the markup`);
  return m[0];
}
const pressed = (html: string, key: string) => tagOf(html, 'data-chip', key).includes('aria-pressed="true"');
const current = (html: string, key: string) => tagOf(html, 'data-view', key).includes('aria-current="true"');

/** Apply a patch the way the workspace does (`patchFilters`). */
const tap = (f: Filters, patch: Partial<Filters>): Filters => ({ ...f, ...patch });

describe('the chip filters in place of the dropdowns', () => {
  it('renders five rows of toggle chips — Branch, Source, Topic, Status, Language — and no selects', () => {
    const html = fields(EMPTY_FILTERS);
    expect(html).not.toContain('<select');
    for (const label of ['Filter by branch', 'Filter by source', 'Filter by topic', 'Filter by status', 'Filter by language']) {
      expect(html).toContain(`role="group" aria-label="${label}"`);
    }
    // Source: one chip per number, by its display name, Instagram and Facebook among them; a nameless number by its channel.
    for (const label of ['Reception · Central Floresta', 'Reception · Robinson Chalong', 'OTO Park Instagram', 'OTO Park Facebook']) {
      expect(html).toContain(label);
    }
    expect(tagOf(html, 'data-chip', `channelAccountId:${WA_COUNTER}`)).toBeTruthy();
    // Topic: every category, the GM queue among them.
    for (const label of ['Birthdays &amp; Events', 'General', 'Marketing', 'GM']) expect(html).toContain(label);
    // Nothing applied: nothing pressed.
    expect(html).not.toContain('aria-pressed="true"');
  });

  it('a tap adds the chip, a second tap on it removes it', () => {
    const on = tap(EMPTY_FILTERS, toggleChip(EMPTY_FILTERS, 'category', 'birthdays'));
    expect(on.category).toBe('birthdays');
    expect(pressed(fields(on), 'category:birthdays')).toBe(true);
    const off = tap(on, toggleChip(on, 'category', 'birthdays'));
    expect(off.category).toBe('');
    expect(pressed(fields(off), 'category:birthdays')).toBe(false);
  });

  it('chips in different rows combine, and the list asks for all of them at once', () => {
    let f = EMPTY_FILTERS;
    f = tap(f, toggleChip(f, 'branchId', CHALONG));
    f = tap(f, toggleChip(f, 'channelAccountId', WA_CHALONG));
    f = tap(f, toggleChip(f, 'category', 'gm'));
    f = tap(f, toggleChip(f, 'status', 'active'));
    f = tap(f, toggleChip(f, 'language', 'th'));
    const html = fields(f);
    for (const key of [`branchId:${CHALONG}`, `channelAccountId:${WA_CHALONG}`, 'category:gm', 'status:active', 'language:th']) {
      expect(pressed(html, key)).toBe(true);
    }
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(5);
    expect(listQuery('team', f)).toEqual({
      tab: 'team',
      branchId: CHALONG,
      channelAccountId: WA_CHALONG,
      category: 'gm',
      status: 'active',
      language: 'th',
    });
    expect(activeFilterCount(f)).toBe(5);
    // Removing one leaves the others.
    const less = tap(f, toggleChip(f, 'category', 'gm'));
    expect(less).toMatchObject({ branchId: CHALONG, channelAccountId: WA_CHALONG, category: '', status: 'active', language: 'th' });
  });

  it('within one row a second chip takes the first one’s place: the list filters one value per row', () => {
    const one = tap(EMPTY_FILTERS, toggleChip(EMPTY_FILTERS, 'category', 'birthdays'));
    const two = tap(one, toggleChip(one, 'category', 'gm'));
    expect(two.category).toBe('gm');
    const html = fields(two);
    expect(pressed(html, 'category:gm')).toBe(true);
    expect(pressed(html, 'category:birthdays')).toBe(false);
  });

  it('the applied-filter pills under the search say the same as the chips, the source by its name', () => {
    const f: Filters = { ...EMPTY_FILTERS, category: 'gm', channelAccountId: WA_CENTRAL, branchId: CENTRAL };
    const pills = filterPills(f, teams, sources);
    expect(pills.map((p) => [p.key, p.label])).toEqual([
      ['category', 'GM'],
      ['branchId', 'Central Floresta'],
      ['channelAccountId', 'Reception · Central Floresta'],
    ]);
    expect(pills.find((p) => p.key === 'channelAccountId')?.clear).toEqual({ channelAccountId: '' });
    const html = list([], f);
    expect(html).toContain('aria-label="Clear Reception · Central Floresta"');
    // A number not (yet) in the known sources still gets a pill that clears it.
    expect(filterPills({ ...EMPTY_FILTERS, channelAccountId: IG }, teams, []).map((p) => p.label)).toEqual(['Source']);
  });

  it('the rail carries the chips at desktop width and the phone’s filter dialog the same chips', () => {
    const f: Filters = { ...EMPTY_FILTERS, language: 'ru' };
    const rail = renderToStaticMarkup(
      createElement(Rail, { me: hana, tab: 'team', counts: { team: 3 }, filters: f, sources, onTab: noop, onFilters: noop }),
    );
    expect(pressed(rail, 'language:ru')).toBe(true);
    expect(rail).toContain('role="group" aria-label="Filter by source"');
    const dialog = renderToStaticMarkup(
      createElement(FiltersDialog, { open: true, onClose: noop, me: hana, filters: f, sources, onChange: noop, onClear: noop }),
    );
    expect(pressed(dialog, 'language:ru')).toBe(true);
    expect(dialog).toContain('aria-label="Inbox views"');
  });

  it('leaves the Source row out while no number is known yet', () => {
    expect(fields(EMPTY_FILTERS, [])).not.toContain('Filter by source');
  });
});

describe('the named inbox views above the filters', () => {
  const views = namedViews(hana);

  it('offers All, Birthdays & Events, GM, then one per park, in that order', () => {
    expect(views.map((v) => v.label)).toEqual(['All conversations', 'Birthdays & Events', 'GM', 'Central Floresta', 'Robinson Chalong']);
    // The GM view needs the GM team; an operator without it has no GM view.
    expect(namedViews({ teams: teams.filter((t) => t.kind !== 'gm') }).map((v) => v.key)).not.toContain('gm');
  });

  it('each view applies its own filter set and clears the other chips', () => {
    const busy: Filters = { ...EMPTY_FILTERS, language: 'ru', status: 'active', channelAccountId: IG, q: 'cake', unanswered: true };
    const expected: Record<string, Partial<Filters>> = {
      all: { category: '', branchId: '' },
      birthdays: { category: 'birthdays', branchId: '' },
      gm: { category: 'gm', branchId: '' },
      [`branch:${CENTRAL}`]: { category: '', branchId: CENTRAL },
      [`branch:${CHALONG}`]: { category: '', branchId: CHALONG },
    };
    for (const v of views) {
      const f = tap(busy, applyView(v));
      expect(f).toMatchObject({ ...expected[v.key], language: '', status: '', channelAccountId: '' });
      // The search and the unanswered toggle are not the view's: they stay.
      expect(f.q).toBe('cake');
      expect(f.unanswered).toBe(true);
      expect(currentView(f, views)).toEqual({ key: v.key, modified: false });
      // The chips reflect the view.
      const html = fields(f);
      if (f.category) expect(pressed(html, `category:${f.category}`)).toBe(true);
      if (f.branchId) expect(pressed(html, `branchId:${f.branchId}`)).toBe(true);
      expect((html.match(/aria-pressed="true"/g) ?? []).length).toBe(v.key === 'all' ? 0 : 1);
      // And the rail marks the view as the one open.
      const rail = renderToStaticMarkup(createElement(InboxViews, { me: hana, filters: f, onChange: noop }));
      expect(current(rail, v.key)).toBe(true);
      expect((rail.match(/aria-current="true"/g) ?? []).length).toBe(1);
    }
  });

  it('changing a chip away from a view moves to a modified All', () => {
    const birthdays = tap(EMPTY_FILTERS, applyView(views.find((v) => v.key === 'birthdays')!));
    const changed = tap(birthdays, toggleChip(birthdays, 'language', 'ru'));
    expect(currentView(changed, views)).toEqual({ key: 'all', modified: true });
    const rail = renderToStaticMarkup(createElement(InboxViews, { me: hana, filters: changed, onChange: noop }));
    expect(current(rail, 'all')).toBe(true);
    expect(current(rail, 'birthdays')).toBe(false);
    expect(rail).toContain('Filtered');
    // A chip that lands exactly on a view's set is that view.
    expect(currentView(tap(EMPTY_FILTERS, toggleChip(EMPTY_FILTERS, 'category', 'gm')), views)).toEqual({ key: 'gm', modified: false });
    // Plain All says nothing extra.
    expect(renderToStaticMarkup(createElement(InboxViews, { me: hana, filters: EMPTY_FILTERS, onChange: noop }))).not.toContain('Filtered');
  });

  it('ships without per-view counts: nothing cheap counts unread or unanswered per view', () => {
    const rail = renderToStaticMarkup(createElement(InboxViews, { me: hana, filters: EMPTY_FILTERS, onChange: noop }));
    // The tabs' count pill (`rounded-full px-1.5 text-[10px] font-semibold`) is not on any view.
    expect(rail).not.toContain('rounded-full px-1.5 text-[10px] font-semibold');
    expect(rail).not.toMatch(/>\d+<\/span>/);
  });
});

describe('the source, everywhere a conversation shows', () => {
  it('labels a number by its display name, else by its channel', () => {
    expect(sourceLabel('whatsapp', 'Reception · Central Floresta')).toBe('Reception · Central Floresta');
    expect(sourceLabel('whatsapp', null)).toBe('WhatsApp');
    expect(sourceLabel('instagram', '   ')).toBe('Instagram');
  });

  it('the list row says the number, not the bare channel; with no name, the channel', () => {
    const named = list([row()]);
    expect(named).toContain(' · Reception · Central Floresta</span>');
    expect(named).not.toContain(' · WhatsApp</span>');
    const nameless = list([row({ channelAccountName: null })]);
    expect(nameless).toContain(' · WhatsApp</span>');
  });

  it('the chat header says the number; with no name, the channel', () => {
    expect(panel(row())).toContain('>Reception · Central Floresta</span>');
    expect(panel(row({ channelAccountName: null }))).toContain('>WhatsApp</span>');
  });

  it('the details dialog has a Source line, with the channel kept on its own line', () => {
    const r = row();
    const html = renderToStaticMarkup(createElement(DetailsDialog, { open: true, onClose: noop, row: r, detail: detail(r), me: hana, now }));
    expect(html).toMatch(/>Source<\/dt><dd[^>]*>Reception · Central Floresta<\/dd>/);
    expect(html).toMatch(/>Channel<\/dt><dd[^>]*>WhatsApp<\/dd>/);
    const bare = row({ channelAccountName: null, channel: 'instagram' });
    const fallback = renderToStaticMarkup(createElement(DetailsDialog, { open: true, onClose: noop, row: bare, detail: detail(bare), me: hana, now }));
    expect(fallback).toMatch(/>Source<\/dt><dd[^>]*>Instagram<\/dd>/);
  });

  it('learns the numbers from the rows it reads: new ones join, a name fills a nameless one, nothing changes on a repeat', () => {
    const start = mergeSources([], [{ id: WA_COUNTER, channel: 'whatsapp', name: null }]);
    const learned = mergeSources(start, sourcesOfRows([row({ channelAccountId: WA_COUNTER, channelAccountName: 'Counter WhatsApp' }), row()]));
    expect(learned.map((s) => [s.id, sourceLabel(s.channel, s.name)])).toEqual([
      [WA_COUNTER, 'Counter WhatsApp'],
      [WA_CENTRAL, 'Reception · Central Floresta'],
    ]);
    // The same rows again: the very same array, so the workspace does not re-render for nothing.
    expect(mergeSources(learned, sourcesOfRows([row()]))).toBe(learned);
    // WhatsApp numbers first, then Instagram, then Facebook.
    expect(sources.map((s) => s.channel)).toEqual(['whatsapp', 'whatsapp', 'whatsapp', 'instagram', 'facebook']);
  });
});

describe('the GM queue’s label and colour wherever a category shows', () => {
  it('the list row’s category badge: GM in amber', () => {
    const html = list([row({ category: 'gm', teamId: T_GM })]);
    expect(html).toMatch(/bg-amber-50[^"]*text-amber-700[^"]*"[^>]*>GM</);
  });

  it('the dashboard legend: the amber bar segment, the amber icon, GM named in the bar’s label', () => {
    const html = renderToStaticMarkup(
      createElement(CategoryMixCard, { data: { birthdays: 1, general: 2, marketing: 0, gm: 3 }, onPick: noop }),
    );
    expect(html).toContain('GM 3');
    expect(html).toContain('bg-amber-500');
    expect(html).toContain('text-amber-500');
    expect(html).toContain('title="Show GM only"');
  });

  it('the applied-filter pill and the topic chip: GM, with the amber mark', () => {
    const f: Filters = { ...EMPTY_FILTERS, category: 'gm' };
    const html = list([], f);
    expect(html).toContain('aria-label="Clear GM"');
    expect(html).toMatch(/bg-amber-50[^"]*"[^>]*>GM</);
    const chips = fields(EMPTY_FILTERS);
    expect(tagOf(chips, 'data-chip', 'category:gm')).toBeTruthy();
    expect(chips).toMatch(/data-chip="category:gm"[^>]*>\s*<span[^>]*bg-amber-500/);
  });
});
