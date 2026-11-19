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
import { AccountMenuItems, AppBar, settingsMenuEntries, type AccountMenuProps } from '@/components/AppBar';
import { ConversationList } from '@/components/ConversationList';
import { StatsMore, StatsRow } from '@/components/StatsRow';
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
      selectedId: null,
      now: new Date('2026-10-22T03:00:00.000Z'),
      onFilters: noop,
      onTab: noop,
      onOpenFilters: noop,
      onSelect: noop,
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

// SCRUM-1016 took the Status filter away (the tabs are the status), so the
// pills are Topic, Park, Channel and Language.
describe('F1 — the applied filters as removable pills by the list', () => {
  const applied: Filters = { ...EMPTY_FILTERS, category: 'birthdays', branchId: CENTRAL, language: 'ru' };

  it('shows one pill per applied filter, labelled from the option tables FilterFields uses', () => {
    const html = list(applied);
    for (const label of ['Birthdays &amp; Events', 'Central Floresta', 'Russian']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('aria-label="Clear Birthdays &amp; Events"');
    expect(html).toContain('aria-label="Clear Central Floresta"');
    expect(html).toContain('aria-label="Clear Russian"');
    expect(html).not.toContain('aria-label="Clear Active"');
  });

  it('shows no pills when nothing is applied (the quick filters, the search and the notices switch are not filters here)', () => {
    expect(filterPills({ ...EMPTY_FILTERS, unanswered: true, unread: true, hideNotices: false, q: 'cake' }, teams)).toEqual([]);
  });

  it('each pill clears exactly its own filter and nothing else', () => {
    const pills = filterPills(applied, teams);
    expect(pills.map((p) => p.key)).toEqual(['category', 'branchId', 'language']);
    for (const pill of pills) {
      expect(pill.clear).toEqual({ [pill.key]: '' });
      const next = { ...applied, ...pill.clear };
      // The cleared one is empty; the other two stay as they were.
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

  // SCRUM-1016: the entries live in the one account menu now, beside the
  // theme and Sign out; the settings part keeps its "Settings" group name.
  const menu = (over: Partial<AccountMenuProps> = {}) =>
    renderToStaticMarkup(
      createElement(AccountMenuItems, {
        me: hana,
        theme: 'light',
        onTheme: noop,
        settings: null,
        onSettings: noop,
        showSimulator: false,
        onShowSimulator: noop,
        onSignOut: noop,
        ...over,
      }),
    );

  it('renders the permitted entries as a menu, and nothing it may not', () => {
    const html = menu({ me: { ...hana, simulator } });
    expect(html).toContain('role="menu"');
    expect(html).toContain('role="group" aria-label="Settings"');
    for (const label of ['Templates', 'Assistant', 'Simulator · test only']) expect(html).toContain(label);

    const kbOnly = menu({ me: { ...hana, capabilities: caps({ kb: true }) } });
    expect(kbOnly).toContain('Assistant');
    expect(kbOnly).not.toContain('Templates');
    expect(kbOnly).not.toContain('Simulator');
  });

  it('says the viewer’s name and view once, and holds Sign out for everyone; an agent sees no settings group', () => {
    const agent = menu({ me: { ...hana, roles: ['events'], capabilities: caps() } });
    expect(agent.match(/Demo Hana \(GM\)/g)).toHaveLength(1);
    expect(agent).toContain('Sign out');
    expect(agent).not.toContain('aria-label="Settings"');
    expect(menu()).toContain('Owner view');
  });

  it('marks the settings page that is open, and offers Back to the suite only with its address', () => {
    expect(menu({ settings: 'templates' })).toMatch(/aria-current="page"[^>]*>(?:<svg[\s\S]*?<\/svg>)?<span[^>]*>Templates</);
    expect(menu()).not.toContain('Back to the suite');
    expect(menu({ launcherUrl: 'https://suite.example.invalid/' })).toMatch(/<a role="menuitem" href="https:\/\/suite\.example\.invalid\/"/);
  });
});

describe("F2 — the assistant page's three tabs", () => {
  function assistant(me: InboxMe, tab: AssistantTab | null): string {
    return renderToStaticMarkup(createElement(AssistantSettings, { me, tab, onBack: noop, onTab: noop }));
  }
  const selected = (html: string, label: string) =>
    new RegExp(`aria-selected="true"[^>]*>${label}<`).test(html);

  it('offers Numbers on inbox:ai:manage, Knowledge, Examples, Rules and Teach on inbox:kb:manage, in that order', () => {
    expect(assistantSections({ ai: true, kb: true }).map(([, l]) => l)).toEqual(['Numbers', 'Knowledge', 'Examples', 'Rules', 'Teach']);
    expect(assistantSections({ ai: false, kb: true }).map(([s]) => s)).toEqual(['knowledge', 'examples', 'rules', 'teach']);
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

// SCRUM-1016 replaced F3's seven-tile grid and the phone's compact strip
// with one slim row of four figures, as the owner approved: Needs reply, New
// today, Avg reply, Handled today. "Needs reply" is the list's one unanswered
// control; the rest (active, by topic, BEOs this week) is one tap away. The
// phone still sees the list first: the row is one line under the tabs.
describe('SCRUM-1016 — the statistics in one slim row', () => {
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
    beosThisWeek: 0,
    weekStart: '2026-10-19',
  };

  function row(over: Partial<Parameters<typeof StatsRow>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(StatsRow, { variant: 'card', data, error: null, unansweredOnly: false, onToggleUnanswered: noop, ...over }),
    );
  }

  it('shows the four figures, and Needs reply is the only toggle', () => {
    const html = row();
    for (const label of ['Needs reply', 'New today', 'Avg reply', 'Handled today']) expect(html).toContain(label);
    expect(html).toContain('>3<');
    expect(html).toContain('>4<');
    expect(html).toContain('>5<');
    expect(html).toContain('12m 34s');
    // One pressed-state control in the row: the filter itself.
    expect(html.match(/aria-pressed=/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>(?:(?!<\/button>)[\s\S])*Needs reply/);
    expect(row({ unansweredOnly: true })).toContain('aria-pressed="true"');
    // The rest of the dashboard is not on the page.
    expect(html).not.toContain('Active');
    expect(html).not.toContain('By topic');
    expect(html).not.toContain('BEOs');
  });

  it('opens the other figures from the row, one tap away', () => {
    const html = row();
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-label="4 new today, average reply 12m 34s, 5 handled today\. More figures"/);
    const more = renderToStaticMarkup(createElement(StatsMore, { data }));
    expect(more).toMatch(/Active<\/dt><dd[^>]*>12</);
    expect(more).toContain('By topic');
    for (const name of ['Birthdays &amp; Events', 'General', 'Marketing', 'GM']) expect(more).toContain(name);
    expect(more).toMatch(/data-topic="birthdays"[\s\S]*?>5</);
    expect(more).toContain('BEOs created · week');
    // Read-outs only: a topic is filtered under Filters, never from here.
    expect(more).not.toContain('<button');
  });

  it('shows "—" while the read is out, and a refused read in words, keeping the filter', () => {
    const loading = row({ data: null });
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/>—</g)?.length).toBeGreaterThanOrEqual(4);
    const failed = row({ data: null, error: 'The dashboard could not be read.' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('The dashboard could not be read.');
    expect(failed).toContain('aria-pressed="false"');
    expect(failed).not.toContain('aria-haspopup');
  });

  it('gives a viewer without the dashboard the filter alone, without figures', () => {
    const html = row({ figures: false, data: null });
    expect(html).toContain('Needs reply');
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('—');
    expect(html).not.toContain('New today');
  });

  it('renders the row inside the list header below 1024 px, above the count and Filters', () => {
    const el = createElement(StatsRow, { variant: 'card', data, error: null, unansweredOnly: false, onToggleUnanswered: noop });
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
        selectedId: null,
        now: new Date('2026-10-22T03:00:00.000Z'),
        onFilters: noop,
        onTab: noop,
        onOpenFilters: noop,
        onSelect: noop,
        onMore: noop,
      }),
    );
    expect(html).toMatch(/<div class="lg:hidden"><section aria-label="Today"/);
    expect(html.indexOf('Needs reply')).toBeLessThan(html.indexOf('aria-label="Filters"'));
    // The old second control is gone from the list.
    expect(html).not.toContain('Unanswered only');
  });

  it('runs the same figures inline in the app bar from 1024 px', () => {
    const html = renderToStaticMarkup(
      createElement(
        AppBar,
        { search: '', onSearch: noop, account: null },
        createElement(StatsRow, { variant: 'bar', data, error: null, unansweredOnly: false, onToggleUnanswered: noop }),
      ),
    );
    expect(html).toMatch(/<div class="ml-auto hidden min-w-0 lg:flex"><section aria-label="Today"/);
    expect(html).toContain('aria-label="Search"');
    expect(html).toContain('alt="OTO"');
    expect(html).toContain('>Inbox</h1>');
  });
});
