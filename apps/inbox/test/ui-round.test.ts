// The owner's Inbox UI round of 22 October 2026 (SCRUM-652): filter
// discoverability below desktop width (F1), one Settings control and the
// assistant page's tabs (F2), and the phone showing the list first (F3) —
// pinned the way the test-night file pins its findings: Node, no DOM, the
// components rendered to markup with react-dom/server.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxMe } from '@/api/inbox';
import { ConversationList } from '@/components/ConversationList';
import { EMPTY_FILTERS, filterPills, type Filters } from '@/lib/query';

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
