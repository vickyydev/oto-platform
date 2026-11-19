// The playbook build's Inbox UI (SCRUM-220, Tom's playbook 2026-10-28): the
// rail's chip filters in place of the dropdowns, the named inbox views above
// them, every conversation labelled with the number it came in on, and the GM
// queue's label and colour wherever a category shows. Node, no DOM, as the
// other markup files: the components rendered with react-dom/server, and the
// choices' presses read through the same pure functions the components call,
// so what is pinned is what the page would say after a tap.
//
// SCRUM-1016 (the approved redesign) rewrote these pins where the design
// changed what they pinned: the filters are Topic, Park, Channel and
// Language, each once (the Status row only repeated the tabs); the named
// views are gone and each is one of those choices (General is the Topic
// "Kept in General", a test line its Channel choice); the row's quiet text is
// "Topic · Park", with the number in its accessible name; a topic's colour is
// its dot.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationDetail, ConversationRow, InboxMe } from '@/api/inbox';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { ConversationList } from '@/components/ConversationList';
import { DetailsDialog, FiltersDialog } from '@/components/dialogs';
import { FilterFields, Rail } from '@/components/Rail';
import { StatsMore } from '@/components/StatsRow';
import { mergeSources, sourceLabel, sourcesOfRows, toggleChip, type SourceOption } from '@/lib/inboxes';
import { EMPTY_FILTERS, activeFilterCount, filterPills, listQuery, topicOf, topicPatch, type Filters, type TopicChoice } from '@/lib/query';

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
    event: null,
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
      selectedId: null,
      now,
      sources: withSources,
      onFilters: noop,
      onTab: noop,
      onOpenFilters: noop,
      onSelect: noop,
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

/** The `<button …>` tag of one choice, by its data key. */
function tagOf(html: string, key: string): string {
  const m = new RegExp(`<button[^>]*data-chip="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`).exec(html);
  if (!m) throw new Error(`no data-chip="${key}" in the markup`);
  return m[0];
}
const pressed = (html: string, key: string) => tagOf(html, key).includes('aria-pressed="true"');

/** Apply a patch the way the workspace does (`patchFilters`). */
const tap = (f: Filters, patch: Partial<Filters>): Filters => ({ ...f, ...patch });
/** A Topic press, as FilterFields makes it: that choice, or back to all when it was the one chosen. */
const pressTopic = (f: Filters, choice: TopicChoice): Filters => tap(f, topicPatch(topicOf(f) === choice ? '' : choice));
/** Each row's "all". */
const ALLS = ['category:all', 'branchId:all', 'channelAccountId:all', 'language:all'];

describe('the choice filters in place of the dropdowns', () => {
  it('renders four rows of choices — Topic, Park, Channel, Language — each with its "all", and no selects', () => {
    const html = fields(EMPTY_FILTERS);
    expect(html).not.toContain('<select');
    for (const label of ['Filter by topic', 'Filter by park', 'Filter by channel', 'Filter by language']) {
      expect(html).toContain(`role="group" aria-label="${label}"`);
    }
    // SCRUM-1016: no Status row — the tabs are the status.
    expect(html).not.toContain('Filter by status');
    // Channel: one choice per number, by its display name, Instagram and Facebook among them; a nameless number by its channel.
    for (const label of ['Reception · Central Floresta', 'Reception · Robinson Chalong', 'OTO Park Instagram', 'OTO Park Facebook']) {
      expect(html).toContain(label);
    }
    expect(tagOf(html, `channelAccountId:${WA_COUNTER}`)).toBeTruthy();
    // Topic: every category, the GM queue among them, and the General questions kept out of the parks.
    for (const label of ['Birthdays &amp; Events', 'General', 'Marketing', 'GM', 'Kept in General']) expect(html).toContain(label);
    // Nothing applied: each row stands on its "all", and nothing else is pressed.
    for (const key of ALLS) expect(pressed(html, key)).toBe(true);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(4);
  });

  it('a tap chooses, a second tap on it goes back to all', () => {
    const on = pressTopic(EMPTY_FILTERS, 'birthdays');
    expect(on.category).toBe('birthdays');
    expect(pressed(fields(on), 'category:birthdays')).toBe(true);
    expect(pressed(fields(on), 'category:all')).toBe(false);
    const off = pressTopic(on, 'birthdays');
    expect(off.category).toBe('');
    expect(pressed(fields(off), 'category:birthdays')).toBe(false);
    expect(pressed(fields(off), 'category:all')).toBe(true);
    // The same in every other row.
    const ru = tap(EMPTY_FILTERS, toggleChip(EMPTY_FILTERS, 'language', 'ru'));
    expect(pressed(fields(ru), 'language:ru')).toBe(true);
    expect(tap(ru, toggleChip(ru, 'language', 'ru')).language).toBe('');
  });

  it('choices in different rows combine, and the list asks for all of them at once', () => {
    let f = EMPTY_FILTERS;
    f = tap(f, toggleChip(f, 'branchId', CHALONG));
    f = tap(f, toggleChip(f, 'channelAccountId', WA_CHALONG));
    f = pressTopic(f, 'gm');
    f = tap(f, toggleChip(f, 'language', 'th'));
    const html = fields(f);
    for (const key of [`branchId:${CHALONG}`, `channelAccountId:${WA_CHALONG}`, 'category:gm', 'language:th']) {
      expect(pressed(html, key)).toBe(true);
    }
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(4);
    // "Hide till notices" is on unless turned off: the list asks for the threads that can take a reply.
    expect(listQuery('team', f)).toEqual({
      tab: 'team',
      branchId: CHALONG,
      channelAccountId: WA_CHALONG,
      category: 'gm',
      language: 'th',
      replyable: 'true',
    });
    expect(activeFilterCount(f)).toBe(4);
    // Removing one leaves the others.
    const less = pressTopic(f, 'gm');
    expect(less).toMatchObject({ branchId: CHALONG, channelAccountId: WA_CHALONG, category: '', language: 'th' });
  });

  it('within one row a second choice takes the first one’s place: the list filters one value per row', () => {
    const one = pressTopic(EMPTY_FILTERS, 'birthdays');
    const two = pressTopic(one, 'gm');
    expect(two.category).toBe('gm');
    const html = fields(two);
    expect(pressed(html, 'category:gm')).toBe(true);
    expect(pressed(html, 'category:birthdays')).toBe(false);
  });

  it('the applied-filter pills by the list say the same as the choices, the number by its name', () => {
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
    expect(filterPills({ ...EMPTY_FILTERS, channelAccountId: IG }, teams, []).map((p) => p.label)).toEqual(['Channel']);
  });

  it('the views column carries the choices at desktop width and the phone’s sheet the same choices', () => {
    const f: Filters = { ...EMPTY_FILTERS, language: 'ru' };
    const rail = renderToStaticMarkup(
      createElement(Rail, { me: hana, tab: 'team', counts: { team: 3 }, filters: f, sources, onTab: noop, onFilters: noop }),
    );
    expect(pressed(rail, 'language:ru')).toBe(true);
    expect(rail).toContain('role="group" aria-label="Filter by channel"');
    const dialog = renderToStaticMarkup(
      createElement(FiltersDialog, { open: true, onClose: noop, me: hana, filters: f, sources, onChange: noop, onClear: noop }),
    );
    expect(pressed(dialog, 'language:ru')).toBe(true);
    // The named inboxes are gone from both: each was one of these choices.
    expect(dialog).not.toContain('aria-label="Inbox views"');
    expect(rail).not.toContain('aria-label="Inbox views"');
    expect(dialog).toContain('Hide till notices');
    expect(rail).toContain('Hide till notices');
  });

  it('leaves the Channel row out while no number is known yet, and offers a test line from the start', () => {
    expect(fields(EMPTY_FILTERS, [])).not.toContain('Filter by channel');
    const line = renderToStaticMarkup(
      createElement(FilterFields, {
        me: { ...hana, testLines: [{ id: WA_COUNTER, channel: 'whatsapp', displayName: 'WhatsApp test line', branchId: null, startOver: false }] },
        filters: EMPTY_FILTERS,
        onChange: noop,
        sources: [],
      }),
    );
    expect(line).toContain('aria-label="Filter by channel"');
    expect(line).toMatch(new RegExp(`data-chip="channelAccountId:${WA_COUNTER}"[\\s\\S]*?WhatsApp test line`));
  });
});

describe('SCRUM-1016: each named view is one choice now', () => {
  it('All, General, Birthdays & Events, GM and each park: the filters the view set, one choice pressed in each row', () => {
    const busy: Filters = { ...EMPTY_FILTERS, q: 'cake', unanswered: true };
    const cases: Array<[string, Filters, Partial<Filters>, string[]]> = [
      ['All conversations', busy, { category: '', branchId: '', inbox: '' }, ALLS],
      // SCRUM-789: the General inbox is its own filter, not the General topic.
      ['General (held)', pressTopic(busy, 'held'), { category: '', branchId: '', inbox: 'general' }, ['inbox:general', 'branchId:all', 'channelAccountId:all', 'language:all']],
      ['Birthdays & Events', pressTopic(busy, 'birthdays'), { category: 'birthdays', inbox: '' }, ['category:birthdays', 'branchId:all', 'channelAccountId:all', 'language:all']],
      ['GM', pressTopic(busy, 'gm'), { category: 'gm', inbox: '' }, ['category:gm', 'branchId:all', 'channelAccountId:all', 'language:all']],
      ['Central Floresta', tap(busy, toggleChip(busy, 'branchId', CENTRAL)), { category: '', branchId: CENTRAL, inbox: '' }, ['category:all', `branchId:${CENTRAL}`, 'channelAccountId:all', 'language:all']],
    ];
    for (const [name, f, expected, keys] of cases) {
      expect(f, name).toMatchObject(expected);
      // The search and the unanswered toggle are not the choice's: they stay.
      expect(f.q).toBe('cake');
      expect(f.unanswered).toBe(true);
      const html = fields(f);
      for (const key of keys) expect(pressed(html, key), `${name}: ${key}`).toBe(true);
      expect((html.match(/aria-pressed="true"/g) ?? []).length, name).toBe(4);
    }
  });

  it('SCRUM-789: "Kept in General" asks the list for the General inbox, never with a topic, and shows as one pill', () => {
    const general = pressTopic(EMPTY_FILTERS, 'held');
    expect(listQuery('team', general)).toMatchObject({ inbox: 'general' });
    expect(listQuery('team', general)).not.toHaveProperty('category');
    // A topic chosen after it takes its place.
    const birthdays = pressTopic(general, 'birthdays');
    expect(listQuery('team', birthdays)).toMatchObject({ category: 'birthdays' });
    expect(listQuery('team', birthdays)).not.toHaveProperty('inbox');
    expect(filterPills(general, teams).map((p) => p.label)).toEqual(['Kept in General']);
    expect(filterPills(general, teams)[0]!.clear).toEqual({ inbox: '' });
    expect(activeFilterCount(general)).toBe(1);
  });

  it('SCRUM-789: a conversation held in General says so on its team badge, and every desk is offered as a move', () => {
    const held = panel(row({ category: 'general', teamId: null }));
    expect(held).toMatch(/<option value="" disabled=""[^>]*>General<\/option>/);
    expect(held).toContain(`<option value="reception:${CENTRAL}">`);
    // Seated at its park: no General entry in the picker.
    expect(panel(row({ category: 'general', teamId: T_CENTRAL }))).not.toMatch(/<option value="" disabled=""[^>]*>General<\/option>/);
  });

  it('the views column counts each topic from the list read; the sheet and a read without counts show none', () => {
    const topicCounts = { birthdays: 9, general: 5, marketing: 1, gm: 2, heldInGeneral: 3 };
    const rail = renderToStaticMarkup(
      createElement(Rail, { me: hana, tab: 'team', counts: { team: 17 }, topicCounts, filters: EMPTY_FILTERS, sources, onTab: noop, onFilters: noop }),
    );
    const countIn = (html: string, key: string) =>
      new RegExp(`data-chip="${key}"(?:(?!</button>)[\\s\\S])*?>(\\d+)</span></button>`).exec(html)?.[1];
    expect(countIn(rail, 'category:birthdays')).toBe('9');
    expect(countIn(rail, 'category:gm')).toBe('2');
    expect(countIn(rail, 'inbox:general')).toBe('3');
    // "All topics" is the four topics together.
    expect(countIn(rail, 'category:all')).toBe('17');
    const sheet = renderToStaticMarkup(createElement(FilterFields, { me: hana, filters: EMPTY_FILTERS, onChange: noop, sources, topicCounts }));
    expect(countIn(sheet, 'category:birthdays')).toBeUndefined();
    const uncounted = renderToStaticMarkup(
      createElement(Rail, { me: hana, tab: 'team', counts: null, filters: EMPTY_FILTERS, sources, onTab: noop, onFilters: noop }),
    );
    expect(countIn(uncounted, 'category:birthdays')).toBeUndefined();
  });
});

describe('the source, everywhere a conversation shows', () => {
  it('labels a number by its display name, else by its channel', () => {
    expect(sourceLabel('whatsapp', 'Reception · Central Floresta')).toBe('Reception · Central Floresta');
    expect(sourceLabel('whatsapp', null)).toBe('WhatsApp');
    expect(sourceLabel('instagram', '   ')).toBe('Instagram');
  });

  // SCRUM-1016: the row's quiet text is "Topic · Park" (approved as drawn);
  // its number is said with the rest of the row, its channel is the dot.
  it('the list row says the number in its accessible name, not the bare channel; with no name, the channel', () => {
    const named = list([row()]);
    expect(named).toMatch(/aria-label="Olga Demo, [^"]*, on Reception · Central Floresta, /);
    expect(named).toContain('>General · Central Floresta</span>');
    expect(named).toContain('title="WhatsApp"');
    const nameless = list([row({ channelAccountName: null })]);
    expect(nameless).toMatch(/aria-label="Olga Demo, [^"]*, on WhatsApp, /);
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
  // SCRUM-1016: no category chip on the row; the GM queue is named in its quiet text.
  it('the list row names the GM queue in its quiet text, without a chip', () => {
    const html = list([row({ category: 'gm', teamId: T_GM, branchId: null })]);
    expect(html).toMatch(/text-ink-muted">GM<\/span>/);
    expect(html).not.toMatch(/bg-amber-50/);
  });

  // SCRUM-1016: the dashboard's legend became "By topic" under More figures:
  // a read-out with the topic's dot (the GM queue's amber token), the filter
  // by topic staying under Filters (the choice pinned in the next test).
  it('the statistics legend: GM named in the bar’s label, its amber dot in the bar and the list', () => {
    const html = renderToStaticMarkup(
      createElement(StatsMore, {
        data: {
          scope: 'all', newToday: 0, unanswered: 0, handledToday: 0, active: 6, averageFirstResponseSeconds: null,
          population: 'active', day: '2026-10-28', beosThisWeek: 0, weekStart: '2026-10-26',
          byCategory: { birthdays: 1, general: 2, marketing: 0, gm: 3 },
        },
      }),
    );
    expect(html).toContain('GM 3');
    expect(html).toMatch(/<span class="bg-topic-gm" style="width:50%"><\/span>/);
    expect(html).toMatch(/data-topic="gm"[^>]*><span aria-hidden="true" class="[^"]*bg-topic-gm"><\/span><span[^>]*>GM<\/span><span[^>]*>3</);
  });

  it('the applied-filter pill and the topic choice: GM, with the amber dot', () => {
    const f: Filters = { ...EMPTY_FILTERS, category: 'gm' };
    const html = list([], f);
    expect(html).toContain('aria-label="Clear GM"');
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*bg-topic-gm"><\/span><span[^>]*>GM</);
    const chips = fields(EMPTY_FILTERS);
    expect(tagOf(chips, 'category:gm')).toBeTruthy();
    expect(chips).toMatch(/data-chip="category:gm"[^>]*>\s*<span[^>]*bg-topic-gm/);
  });
});
