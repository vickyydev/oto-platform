// @vitest-environment jsdom
//
// SCRUM-1016 — the accessibility pass across the Inbox (inventory §7 items
// 20 to 25): no control inside another, every button and link named, every
// field labelled, and the reasons a control is off said on the page rather
// than only in a hover tooltip. Each surface is rendered to markup and read
// back into a document, as a screen reader would meet it.
//
// FICTIONAL TEST DATA: every name is "ZZ TEST".
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Assignee, ConversationDetail, ConversationRow, InboxMe } from '@/api/inbox';
import { AppBar } from '@/components/AppBar';
import { AssistantSettings } from '@/components/AssistantSettings';
import { TemplateSettings } from '@/components/TemplateSettings';
import { BookDateDialog } from '@/components/BookDateDialog';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { HandleConfirm, PrimaryMoveConfirm, StartOverConfirm, TeamMoveConfirm } from '@/components/confirms';
import { ConversationList } from '@/components/ConversationList';
import { FiltersDialog } from '@/components/dialogs';
import { Rail } from '@/components/Rail';
import { EMPTY_FILTERS } from '@/lib/query';
import { BOOK_DATE_NOT_YOURS_REASON, SUPPORT_FULL_HINT } from '@/lib/view';
import { paidPrebookingFixture } from './paid-prebooking-fixture';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000c1';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const T_MARKETING = '00000000-0000-7000-8000-0000000000d1';
const ME = '00000000-0000-7000-8000-00000000009a';
const ANYA = '00000000-0000-7000-8000-0000000000a1';
const VERA = '00000000-0000-7000-8000-0000000000a2';
const NINA = '00000000-0000-7000-8000-0000000000a3';
const LINE = '0192f0a0-1234-7abc-8def-0000000000d1';
const noop = () => undefined;
const now = new Date('2026-11-19T06:00:00.000Z');

function viewer(o: { assign: boolean; birthdays: boolean }): InboxMe {
  return {
    accountId: ME,
    name: 'ZZ TEST viewer',
    roles: o.assign ? ['owner'] : ['marketing'],
    tabs: ['mine', 'team', 'handled'],
    teams: [
      { id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false },
      { id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: o.birthdays },
      { id: T_MARKETING, kind: 'marketing', name: 'Marketing', colour: 'pink', branchId: null, member: !o.birthdays && !o.assign },
    ],
    people: [
      { accountId: ANYA, name: 'ZZ TEST Anya', teamIds: [T_BIRTHDAYS], operatorWide: false },
      { accountId: VERA, name: 'ZZ TEST Vera', teamIds: [T_BIRTHDAYS], operatorWide: false },
      { accountId: NINA, name: 'ZZ TEST Nina', teamIds: [T_BIRTHDAYS], operatorWide: false },
    ],
    defaultReceptionBranchId: CENTRAL,
    capabilities: { writes: true, dashboard: true, assign: o.assign, move: o.assign, reopen: o.assign, templates: o.assign, kb: false, ai: false },
    simulator: null,
    testLines: [{ id: LINE, channel: 'whatsapp', displayName: 'ZZ TEST line', branchId: null, startOver: true }],
    contactChannels: [],
  } as unknown as InboxMe;
}

const seat = (id: string, slot: 'primary' | 'support', slotIndex: number, accountId: string, name: string): Assignee =>
  ({ assignmentId: id, slot, slotIndex, assigneeKind: 'account', accountId, teamId: null, name, reason: 'manual', assignedAt: '2026-11-19T04:00:00.000Z' }) as Assignee;

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: '0192f0a0-1234-7abc-8def-0000000000e1',
    channel: 'whatsapp',
    channelAccountId: LINE,
    channelAccountName: 'ZZ TEST line',
    canReply: true,
    contact: { id: '0192f0a0-1234-7abc-8def-0000000000f1', channel: 'whatsapp', handle: 'ZZ TEST', displayName: 'ZZ TEST Sarah', phone: null, language: 'en', erased: false },
    category: 'birthdays',
    intent: 'birthday_details',
    language: 'en',
    branchId: CENTRAL,
    teamId: T_BIRTHDAYS,
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-11-19T05:00:00.000Z',
    lastMessagePreview: 'ZZ TEST hello',
    unanswered: true,
    nextAction: 'staff_reply_needed',
    depositSignal: null,
    unread: 2,
    mine: true,
    assignments: [
      seat('as-p', 'primary', 0, ANYA, 'ZZ TEST Anya'),
      seat('as-s1', 'support', 1, VERA, 'ZZ TEST Vera'),
      seat('as-s2', 'support', 2, NINA, 'ZZ TEST Nina'),
    ],
    createdAt: '2026-11-19T04:00:00.000Z',
    ...over,
  };
}

function detail(r: ConversationRow): ConversationDetail {
  return {
    ...r,
    teamName: 'Birthdays & Events',
    firstResponseAt: null,
    reopenedAt: null,
    member: null,
    events: [],
    divertTo: { accountId: VERA, name: 'ZZ TEST Vera' },
    aiMode: 'live',
    aiPaused: false,
    aiPausedAt: null,
    aiPausedByAccountId: null,
    aiState: 'ready',
    event: null,
  } as ConversationDetail;
}

function chat(me: InboxMe, detailsOpen: boolean): string {
  const r = row();
  const thread: Thread = { detail: detail(r), messages: [], olderCursor: null, loading: false, loadingOlder: false, error: null };
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      row: r, thread, me, now, inserted: null, detailsOpen,
      onBack: noop, onLoadOlder: noop, onOpenDetails: noop, onCloseDetails: noop, onOpenTemplates: noop,
      onAskHandle: noop, onChanged: async () => undefined,
    }),
  );
}

/** The markup read back into a document. */
function doc(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

const nameOf = (el: Element, root: HTMLElement): string => {
  // A box or a switch inside its label is named by the label's words.
  if (el.tagName === 'INPUT' && el.closest('label')) return (el.closest('label')!.textContent ?? '').trim();
  const label = el.getAttribute('aria-label');
  if (label?.trim()) return label.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map((id) => root.querySelector(`[id="${id}"]`)?.textContent ?? '').join(' ').trim();
  return (el.textContent ?? '').trim();
};

/** Every rule of the pass, said once for a surface. */
function audit(html: string): string[] {
  const root = doc(html);
  const faults: string[] = [];
  for (const el of root.querySelectorAll('button button, button a[href], button input, button select, button textarea, a[href] button, a[href] a[href], [role="button"] button'))
    faults.push(`a control inside a control: ${el.outerHTML.slice(0, 80)}`);
  for (const el of root.querySelectorAll('button, a[href], [role="tab"], [role="radio"], [role="switch"]'))
    if (!nameOf(el, root)) faults.push(`a control with no name: ${el.outerHTML.slice(0, 120)}`);
  for (const el of root.querySelectorAll('input:not([type="hidden"]), select, textarea')) {
    const id = el.getAttribute('id');
    const labelled = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.closest('label') || (id && root.querySelector(`label[for="${id}"]`));
    if (!labelled) faults.push(`a field with no label: ${el.outerHTML.slice(0, 120)}`);
  }
  return faults;
}

const surfaces: Array<[string, () => string]> = [
  ['the app bar', () => renderToStaticMarkup(createElement(AppBar, { search: '', onSearch: noop, onNewContact: noop, account: null }))],
  ['the views column', () => renderToStaticMarkup(createElement(Rail, { me: viewer({ assign: true, birthdays: false }), tab: 'team', counts: { team: 3 }, filters: EMPTY_FILTERS, onTab: noop, onFilters: noop }))],
  [
    'the list',
    () =>
      renderToStaticMarkup(
        createElement(ConversationList, {
          me: viewer({ assign: true, birthdays: false }), tab: 'team', page: { conversations: [], nextCursor: 'more', tabCounts: { team: 2 } },
          rows: [row(), row({ id: '0192f0a0-1234-7abc-8def-0000000000e2', depositSignal: 'paid', nextAction: 'staff_action_needed' })],
          loading: false, loadingMore: false, error: null, filters: EMPTY_FILTERS, selectedId: null, now,
          onFilters: noop, onTab: noop, onOpenFilters: noop, onSelect: noop, onMore: noop,
        } as Parameters<typeof ConversationList>[0]),
      ),
  ],
  ['a chat, a manager, with people and actions open', () => chat(viewer({ assign: true, birthdays: false }), true)],
  ['a chat, an agent who may not book, with people and actions open', () => chat(viewer({ assign: false, birthdays: false }), true)],
  [
    'Book the date',
    () =>
      renderToStaticMarkup(
        createElement(BookDateDialog, {
          open: true, customer: 'ZZ TEST Sarah',
          initial: { date: '2099-11-21', dateFrom: '', startTime: '14:00', timeFrom: '', branchId: CENTRAL, kids: '', adults: '', contactName: 'ZZ TEST', phone: '', childName: '', childAge: '' },
          branches: [{ value: CENTRAL, label: 'ZZ TEST park' }], busy: false, error: null, thenOpensBeo: false,
          onCancel: noop, onSave: noop, initialDeposit: { ...paidPrebookingFixture(CENTRAL), state: 'requested', paymentLink: 'https://example.invalid/pay' },
          onReadDeposit: async () => ({ draft: null }), onRequestDeposit: async () => ({ draft: null }), onFetch: async () => ({}) as never,
        }),
      ),
  ],
  [
    'the confirmations',
    () =>
      [
        createElement(HandleConfirm, { open: true, busy: false, error: 'ZZ TEST refusal', onCancel: noop, onConfirm: noop }),
        createElement(PrimaryMoveConfirm, { pending: { name: 'ZZ TEST Vera', fromCategory: 'general', toCategory: 'birthdays', toTeamName: 'Birthdays & Events' }, busy: false, error: null, onCancel: noop, onConfirm: noop }),
        createElement(TeamMoveConfirm, { pending: { toTeamName: 'Marketing', fromTeamName: 'GM' }, busy: false, error: null, onCancel: noop, onConfirm: noop }),
        createElement(StartOverConfirm, { open: true, busy: false, error: null, lineName: 'ZZ TEST line', onCancel: noop, onConfirm: noop }),
      ]
        .map((el: ReactElement) => renderToStaticMarkup(el))
        .join(''),
  ],
  ['the templates page', () => renderToStaticMarkup(createElement(TemplateSettings, { me: viewer({ assign: true, birthdays: false }), onBack: noop }))],
  ...(['numbers', 'knowledge', 'examples', 'rules', 'teach'] as const).map((tab): [string, () => string] => [
    `the assistant page, ${tab}`,
    () => {
      const me = viewer({ assign: true, birthdays: false });
      return renderToStaticMarkup(
        createElement(AssistantSettings, { me: { ...me, capabilities: { ...me.capabilities, kb: true, ai: true } }, tab, onBack: noop, onTab: noop }),
      );
    },
  ]),
  ['the filters sheet', () => renderToStaticMarkup(createElement(FiltersDialog, { open: true, onClose: noop, me: viewer({ assign: true, birthdays: false }), filters: EMPTY_FILTERS, onChange: noop, onClear: noop }))],
];

describe('SCRUM-1016: the accessibility pass', () => {
  it.each(surfaces)('%s: no control inside another, every control named, every field labelled', (_, render) => {
    expect(audit(render())).toEqual([]);
  });

  it.each(surfaces.filter(([name]) => /page|Book the date|confirmations/.test(name)))(
    '%s: on the tokens, and every button a 44 px target on a phone',
    (_, render) => {
      const html = render();
      expect(html).not.toMatch(/\b(?:bg|text|border|ring)-(?:slate|amber|indigo|emerald|violet|rose|sky|orange)-\d/);
      expect(html).not.toMatch(/\bdark:/);
      for (const b of doc(html).querySelectorAll('button')) {
        expect(b.className, b.textContent ?? '').toMatch(/(?:^|\s)(?:min-h-1[12]|h-11|h-12)(?:\s|$)/);
      }
    },
  );

  it('why Book the date and Create BEO are off is said on the page, not only in a tooltip', () => {
    const html = chat(viewer({ assign: false, birthdays: false }), true);
    expect(doc(html).querySelector('[data-testid="book-off-reason"]')?.textContent).toBe(BOOK_DATE_NOT_YOURS_REASON);
    // A person who may book sees no such line.
    expect(chat(viewer({ assign: true, birthdays: false }), true)).not.toContain('data-testid="book-off-reason"');
  });

  it('"Support 2/2" says why on the sheet, as text', () => {
    const root = doc(chat(viewer({ assign: true, birthdays: false }), true));
    const lines = [...root.querySelectorAll('span')].map((s) => s.textContent);
    expect(lines).toContain(SUPPORT_FULL_HINT);
    expect(root.querySelector(`[title="${SUPPORT_FULL_HINT}"]`)).toBeNull();
  });

  it('a native select laid invisibly over a row or a word hands its focus ring to what is seen', () => {
    const html = chat(viewer({ assign: true, birthdays: false }), true);
    const root = doc(html);
    // SCRUM-1016 (review): the status row is a read-out now, with no select to hand a ring.
    for (const name of ['Move to team', 'Conversation branch']) {
      const select = root.querySelector(`select[aria-label="${name}"]`)!;
      expect(select.className, name).toContain('opacity-0');
      expect(select.closest('div')!.className, name).toContain('has-[select:focus-visible]:outline-coral');
    }
    const word = root.querySelector('select[aria-label="Set primary"]')!.parentElement!;
    expect(word.className).toContain('has-[:focus-visible]:outline-coral');
  });

  it('every control falls back to the coral focus ring', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const css = readFileSync(path.resolve(import.meta.dirname, '..', 'src/index.css'), 'utf8');
    expect(css).toContain(':where(button, a[href], input, select, textarea');
    expect(css).toMatch(/\):focus-visible \{\s*outline: 2px solid var\(--oto-coral\);\s*outline-offset: 2px;/);
  });
});
