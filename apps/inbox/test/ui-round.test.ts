// The owner's Inbox UI round of 22 October 2026 (SCRUM-652): filter
// discoverability below desktop width (F1), one Settings control and the
// assistant page's tabs (F2), and the phone showing the list first (F3) —
// pinned the way the test-night file pins its findings: Node, no DOM, the
// components rendered to markup with react-dom/server.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Dashboard as DashboardData, InboxMe } from '@/api/inbox';
import { AssistantSettings, assistantSections } from '@/components/AssistantSettings';
import { ConversationList } from '@/components/ConversationList';
import { Dashboard, DashboardStrip } from '@/components/Dashboard';
import { SettingsMenuItems, settingsMenuEntries } from '@/components/Workspace';
import { EMPTY_FILTERS, filterPills, type Filters } from '@/lib/query';
import type { AssistantTab } from '@/lib/url';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const CHALONG = '00000000-0000-7000-8000-0000000000c2';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000r1';
const T_CHALONG = '00000000-0000-7000-8000-0000000000r2';
const GM = '00000000-0000-7000-8000-00000000009a';

const teams: InboxMe['teams'] = [
  { id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: false },
  { id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false },
  { id: T_CHALONG, kind: 'reception', name: 'Reception · Robinson Chalong', colour: 'sky', branchId: CHALONG, member: false },
];

export const caps = (over: Partial<InboxMe['capabilities']> = {}): InboxMe['capabilities'] => ({
  writes: true,
  dashboard: true,
  assign: false,
  move: false,
  reopen: false,
  templates: false,
  kb: false,
  ai: false,
  ...over,
});

/** The GM: owner view. */
export const hana: InboxMe = {
  accountId: GM,
  name: 'Demo Hana (GM)',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams,
  people: [],
  defaultReceptionBranchId: CENTRAL,
  capabilities: caps({ assign: true, move: true, reopen: true, templates: true, kb: true, ai: true }),
  simulator: null,
};

const noop = () => undefined;

function list(filters: Filters, me: InboxMe = hana): string {
  return renderToStaticMarkup(
    createElement(ConversationList, {
      me,
      tab: 'team',
      page: null,
      rows: [],
      loading: false,
      loadingMore: false,
      error: null,
      filters,
      search: '',
      selectedId: null,
      now: new Date('2026-10-22T03:00:00.000Z'),
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

describe('F1 — the Filters button says so, below desktop width', () => {
  it('carries the visible word beside the icon, and keeps the count badge', () => {
    const plain = list(EMPTY_FILTERS);
    expect(plain).toContain('aria-label="Filters"');
    expect(plain).toContain('Filters');
    // No filters applied: no count badge, no pills.
    expect(plain).not.toContain('aria-label="Clear');

    const filtered = list({ ...EMPTY_FILTERS, category: 'birthdays', language: 'ru' });
    expect(filtered).toContain('>2</span>');
  });
});

describe('F1 — the applied filters as removable pills under the search line', () => {
  const applied: Filters = { ...EMPTY_FILTERS, category: 'birthdays', branchId: CENTRAL, status: 'active', language: 'ru' };

  it('shows one pill per applied filter, labelled from the option tables FilterFields uses', () => {
    const html = list(applied);
    for (const label of ['Birthdays &amp; Events', 'Central Floresta', 'Active', 'Russian']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-label="Clear Birthdays &amp; Events"');
    expect(html).toContain('aria-label="Clear Central Floresta"');
    expect(html).toContain('aria-label="Clear Active"');
    expect(html).toContain('aria-label="Clear Russian"');
  });

  it('shows no pills when nothing is applied (the unanswered toggle and search are not filters here)', () => {
    expect(filterPills({ ...EMPTY_FILTERS, unanswered: true, q: 'cake' }, teams)).toEqual([]);
  });

  it('each pill clears exactly its own filter and nothing else', () => {
    const pills = filterPills(applied, teams);
    expect(pills.map((p) => p.key)).toEqual(['category', 'branchId', 'status', 'language']);
    for (const pill of pills) {
      expect(pill.clear).toEqual({ [pill.key]: '' });
      const next = { ...applied, ...pill.clear };
      // The cleared one is empty; the other three stay as they were.
      expect(next[pill.key]).toBe('');
      for (const other of pills.filter((p) => p.key !== pill.key)) {
        expect(next[other.key]).toBe(applied[other.key]);
      }
    }
  });
});

describe('F2 — one Settings control, listing only what the viewer may open', () => {
  const simulator: InboxMe['simulator'] = { channelAccounts: [] };

  it('offers each entry only on its capability, the simulator marked test-only', () => {
    expect(settingsMenuEntries({ ...hana, simulator }).map((e) => e.label)).toEqual([
      'Templates',
      'Assistant',
      'Simulator · test only',
    ]);
    expect(settingsMenuEntries({ ...hana, capabilities: caps({ templates: true }) }).map((e) => e.key)).toEqual(['templates']);
    expect(settingsMenuEntries({ ...hana, capabilities: caps({ kb: true }) }).map((e) => e.key)).toEqual(['assistant']);
    expect(settingsMenuEntries({ ...hana, capabilities: caps({ ai: true }) }).map((e) => e.key)).toEqual(['assistant']);
    expect(settingsMenuEntries({ ...hana, capabilities: caps() })).toEqual([]);
    expect(settingsMenuEntries({ ...hana, capabilities: caps(), simulator }).map((e) => e.key)).toEqual(['simulator']);
  });

  it('renders the permitted entries as a menu, and nothing it may not', () => {
    const html = renderToStaticMarkup(createElement(SettingsMenuItems, { me: { ...hana, simulator }, onChoose: noop }));
    expect(html).toContain('role="menu"');
    for (const label of ['Templates', 'Assistant', 'Simulator · test only']) expect(html).toContain(label);

    const kbOnly = renderToStaticMarkup(
      createElement(SettingsMenuItems, { me: { ...hana, capabilities: caps({ kb: true }) }, onChoose: noop }),
    );
    expect(kbOnly).toContain('Assistant');
    expect(kbOnly).not.toContain('Templates');
    expect(kbOnly).not.toContain('Simulator');
  });
});

describe("F2 — the assistant page's three tabs", () => {
  function assistant(me: InboxMe, tab: AssistantTab | null): string {
    return renderToStaticMarkup(createElement(AssistantSettings, { me, tab, onBack: noop, onTab: noop }));
  }
  const selected = (html: string, label: string) =>
    new RegExp(`aria-selected="true"[^>]*>${label}<`).test(html);

  it('offers Numbers on inbox:ai:manage, Knowledge and Examples on inbox:kb:manage, in that order', () => {
    expect(assistantSections({ ai: true, kb: true }).map(([, l]) => l)).toEqual(['Numbers', 'Knowledge', 'Examples']);
    expect(assistantSections({ ai: false, kb: true }).map(([s]) => s)).toEqual(['knowledge', 'examples']);
    expect(assistantSections({ ai: true, kb: false }).map(([s]) => s)).toEqual(['numbers']);
    expect(assistantSections({ ai: false, kb: false })).toEqual([]);
  });

  it('renders the named tab as selected, one section at a time', () => {
    const knowledge = assistant(hana, 'knowledge');
    expect(selected(knowledge, 'Knowledge')).toBe(true);
    expect(selected(knowledge, 'Numbers')).toBe(false);
    const examples = assistant(hana, 'examples');
    expect(selected(examples, 'Examples')).toBe(true);
    expect(selected(examples, 'Knowledge')).toBe(false);
  });

  it('defaults to the first tab the viewer may see, and clamps a tab they may not', () => {
    // hana holds both rights: the default is Numbers.
    expect(selected(assistant(hana, null), 'Numbers')).toBe(true);
    // A kb-only viewer defaults to Knowledge, and ?tab=numbers clamps there.
    const kbOnly: InboxMe = { ...hana, capabilities: caps({ kb: true }) };
    expect(selected(assistant(kbOnly, null), 'Knowledge')).toBe(true);
    expect(selected(assistant(kbOnly, 'numbers'), 'Knowledge')).toBe(true);
    expect(assistant(kbOnly, null)).not.toContain('Numbers');
  });
});

describe('F3 — the phone shows the list first', () => {
  const data: DashboardData = {
    scope: 'all',
    newToday: 4,
    unanswered: 3,
    handledToday: 5,
    active: 12,
    averageFirstResponseSeconds: 754,
    population: 'active',
    byCategory: { birthdays: 5, general: 4, marketing: 3, gm: 0 },
    day: '2026-10-22',
  };

  function grid(unansweredOnly = false): string {
    return renderToStaticMarkup(
      createElement(Dashboard, { data, error: null, unansweredOnly, onToggleUnanswered: noop }),
    );
  }
  function strip(unansweredOnly = false): string {
    return renderToStaticMarkup(
      createElement(DashboardStrip, { data, error: null, unansweredOnly, onToggleUnanswered: noop }),
    );
  }

  it('keeps the card grid for lg and up, unchanged, and off the phone', () => {
    const html = grid();
    // The grid renders only at lg: `hidden` below, `lg:grid` above.
    expect(/class="[^"]*\bhidden\b[^"]*\blg:grid\b[^"]*"/.test(html)).toBe(true);
    // The lg cards are all still there, with their figures.
    for (const label of ['New today', 'Unanswered', 'Active', 'Handled today', 'Avg response', 'By category']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('12m 34s');
    expect(grid(true)).toContain('aria-pressed="true"');
  });

  it('opens the list behind every tile that has one: Active, Handled today, each category (demo day 2026-10-27)', () => {
    const wired = (over: Record<string, unknown> = {}) =>
      renderToStaticMarkup(
        createElement(Dashboard, {
          data,
          error: null,
          unansweredOnly: false,
          onToggleUnanswered: noop,
          onToggleActive: noop,
          onToggleHandledToday: noop,
          onPickCategory: noop,
          ...over,
        }),
      );
    const html = wired();
    // Unanswered, Active and Handled today are buttons; New today and Avg response stay read-outs.
    const buttons = html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const labelled = (label: string) => buttons.some((b) => b.includes(label));
    expect(labelled('Unanswered')).toBe(true);
    expect(labelled('Active')).toBe(true);
    expect(labelled('Handled today')).toBe(true);
    expect(labelled('New today')).toBe(false);
    expect(labelled('Avg response')).toBe(false);
    // Each category in the legend is its own button, named for the list it opens.
    for (const name of ['Birthdays &amp; Events', 'General', 'Marketing']) expect(html).toContain(`Show ${name} only`);
    // Pressed states read back.
    expect(wired({ activeOnly: true })).toContain('Click to clear filter');
    expect(wired({ handledTodayShown: true })).toContain('Click to go back');
    expect(wired({ category: 'birthdays' })).toContain('Showing Birthdays &amp; Events only');
  });

  it('without the new handlers the tiles render exactly as before: only Unanswered is a button', () => {
    const buttons = grid().match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('Unanswered');
  });

  it('gives the phone one compact line: the unanswered chip, active, avg response', () => {
    const html = strip();
    expect(html).toContain('lg:hidden');
    expect(html).toContain('Unanswered 3');
    expect(html).toContain('Active');
    expect(html).toContain('>12<');
    expect(html).toContain('Avg response');
    expect(html).toContain('12m 34s');
    // The chip toggles the unanswered filter, like the card.
    expect(html).toContain('aria-pressed="false"');
    expect(strip(true)).toContain('aria-pressed="true"');
    // It is the compact line, not the card grid.
    expect(html).not.toContain('New today');
    expect(html).not.toContain('By category');
  });

  it('renders the strip inside the list header, above the search line', () => {
    const el = createElement(DashboardStrip, { data, error: null, unansweredOnly: false, onToggleUnanswered: noop });
    const html = renderToStaticMarkup(
      createElement(ConversationList, {
        me: hana,
        tab: 'team',
        strip: el,
        page: null,
        rows: [],
        loading: false,
        loadingMore: false,
        error: null,
        filters: EMPTY_FILTERS,
        search: '',
        selectedId: null,
        now: new Date('2026-10-22T03:00:00.000Z'),
        onSearch: noop,
        onFilters: noop,
        onTab: noop,
        onOpenFilters: noop,
        onSelect: noop,
        onAskHandle: noop,
        onMore: noop,
      }),
    );
    expect(html).toContain('Unanswered 3');
    expect(html.indexOf('Unanswered 3')).toBeLessThan(html.indexOf('aria-label="Search"'));
    // The card grid stays out of the list.
    expect(html).not.toContain('New today');
  });
});
