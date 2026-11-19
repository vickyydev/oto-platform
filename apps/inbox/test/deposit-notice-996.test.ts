// @vitest-environment jsdom
// SCRUM-996 — a paid pre-booking deposit shows on the chat: the row's label
// (read out by screen readers), the "Ready to book" group pinned above the
// list, and the line beside Book Date for a person who may book. The list
// markup with react-dom/server; the chat's line in a DOM, as it is fetched.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INBOX_DEPOSIT_SIGNALS } from '@oto/shared';
import { inboxApi, type ConversationDetail, type ConversationRow, type InboxMe } from '@/api/inbox';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { ConversationList } from '@/components/ConversationList';
import {
  DEPOSIT_SIGNAL_LABELS,
  NEXT_ACTION_LABELS,
  READY_TO_BOOK_LABEL,
  depositPaidLine,
  withReadyToBook,
} from '@/lib/list-state';
import { EMPTY_FILTERS } from '@/lib/query';
import { paidPrebookingFixture } from './paid-prebooking-fixture';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const ME = '00000000-0000-7000-8000-00000000009a';
const noop = () => undefined;

function me(o: { member?: boolean; assign?: boolean } = {}): InboxMe {
  return {
    accountId: ME,
    name: 'ZZ TEST agent',
    roles: ['events'],
    tabs: ['mine', 'team', 'handled'],
    teams: [{ id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: o.member ?? true }],
    people: [],
    defaultReceptionBranchId: CENTRAL,
    capabilities: { writes: true, dashboard: false, assign: o.assign ?? false, move: false, reopen: false, templates: false, kb: false, ai: false },
    simulator: null,
  };
}
let n = 0;
function row(over: Partial<ConversationRow> = {}): ConversationRow {
  n += 1;
  return {
    id: `0192f0a0-1234-7abc-8def-0000000000${String(n).padStart(2, '0')}`,
    channel: 'whatsapp',
    channelAccountId: '0192f0a0-1234-7abc-8def-0000000000a1',
    channelAccountName: 'ZZ TEST line',
    canReply: true,
    contact: { id: `0192f0a0-1234-7abc-8def-0000000001${String(n).padStart(2, '0')}`, channel: 'whatsapp', handle: 'ZZ TEST', displayName: `ZZ TEST guest ${n}`, phone: null, language: 'en', erased: false },
    category: 'birthdays',
    intent: null,
    language: 'en',
    branchId: CENTRAL,
    teamId: T_BIRTHDAYS,
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-11-19T05:00:00.000Z',
    lastMessagePreview: 'ZZ TEST line',
    unanswered: false,
    nextAction: 'ai_sent',
    depositSignal: null,
    unread: 0,
    mine: false,
    assignments: [],
    createdAt: '2026-11-19T04:00:00.000Z',
    ...over,
  };
}
function list(rows: ConversationRow[], viewer = me()) {
  return renderToStaticMarkup(
    createElement(ConversationList, {
      me: viewer, tab: 'team', page: null, rows, loading: false, loadingMore: false, error: null,
      filters: EMPTY_FILTERS, selectedId: null, now: new Date('2026-11-19T06:00:00Z'),
      onFilters: noop, onTab: noop, onOpenFilters: noop, onSelect: noop, onAskHandle: noop, onMore: noop,
    }),
  );
}

describe('SCRUM-996: the words on the row', () => {
  it('the owner\'s three labels and the action the list asks for', () => {
    expect(DEPOSIT_SIGNAL_LABELS).toEqual({
      paid: 'Deposit paid · book the date',
      paid_date_passed: 'Deposit paid · date passed, needs staff',
      needs_checking: 'Deposit needs checking',
    });
    expect(Object.keys(DEPOSIT_SIGNAL_LABELS).sort()).toEqual([...INBOX_DEPOSIT_SIGNALS].sort());
    expect(NEXT_ACTION_LABELS.staff_action_needed).toBe('Staff action needed');
  });
  it.each(INBOX_DEPOSIT_SIGNALS)('%s stands beside the next-action label and is read out by screen readers', (signal) => {
    const r = row({ depositSignal: signal, nextAction: 'staff_action_needed' });
    const html = list([r]);
    expect(html).toContain(`data-deposit-signal="${signal}"`);
    expect(html).toContain(`>${DEPOSIT_SIGNAL_LABELS[signal]}<`);
    expect(html).toContain('>Staff action needed<');
    expect(html).toMatch(new RegExp(`aria-label="[^"]*${DEPOSIT_SIGNAL_LABELS[signal]}[^"]*"`));
  });
  it('no label and no group without a signal, as before', () => {
    const html = list([row(), row({ depositSignal: undefined })]);
    expect(html).not.toContain('data-deposit-signal');
    expect(html).not.toContain(READY_TO_BOOK_LABEL);
  });
});

describe('SCRUM-996: the "Ready to book" group', () => {
  it('pins the paid chats above the rest in their own order; "needs checking" stays in the list', () => {
    const newest = row({ lastMessageAt: '2026-11-19T05:59:00.000Z' });
    const paidB = row({ depositSignal: 'paid', nextAction: 'staff_action_needed' });
    const checking = row({ depositSignal: 'needs_checking', nextAction: 'staff_action_needed' });
    const paidA = row({ depositSignal: 'paid_date_passed', nextAction: 'staff_action_needed' });
    const html = list([newest, paidB, checking, paidA]);
    const at = (r: ConversationRow) => html.indexOf(`>${r.contact.displayName}<`);
    expect(html).toContain(`aria-label="${READY_TO_BOOK_LABEL}"`);
    const heading = html.indexOf(`>${READY_TO_BOOK_LABEL}<`);
    expect(heading).toBeGreaterThan(-1);
    expect(heading).toBeLessThan(at(paidB));
    expect(at(paidB)).toBeLessThan(at(paidA));
    expect(at(paidA)).toBeLessThan(at(newest));
    expect(at(newest)).toBeLessThan(at(checking));
  });
  it('the first page\'s group comes first in the rows, each conversation once', () => {
    const a = row(), b = row({ depositSignal: 'paid' }), c = row({ depositSignal: 'paid' });
    expect(withReadyToBook([b, c], [a, c]).map((r) => r.id)).toEqual([b.id, c.id, a.id]);
    expect(withReadyToBook(undefined, [a, c]).map((r) => r.id)).toEqual([a.id, c.id]);
  });
});

describe('SCRUM-996: the line beside Book Date', () => {
  const paid = paidPrebookingFixture(CENTRAL);
  it('says the amount, the gateway verification and its time, and names a simulator payment', () => {
    expect(depositPaidLine({ ...paid, simulator: false }, 'paid')).toBe(
      'Deposit ฿3,000 paid and gateway verified at 16 Nov, 19:00. Check capacity, then Book Date.',
    );
    expect(depositPaidLine(paid, 'paid')).toBe(
      'Simulator test payment, no real money: deposit ฿3,000 paid and gateway verified at 16 Nov, 19:00. Check capacity, then Book Date.',
    );
    expect(depositPaidLine({ ...paid, simulator: false }, 'paid_date_passed')).toBe(
      'Deposit ฿3,000 paid and gateway verified at 16 Nov, 19:00. The party date has passed: staff must resolve the paid deposit with the family.',
    );
  });

  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.restoreAllMocks();
  });
  async function open(viewer: InboxMe, r: ConversationRow) {
    const detail: ConversationDetail = {
      ...r, teamName: 'Birthdays & Events', firstResponseAt: null, reopenedAt: null, member: null, events: [], divertTo: null,
      aiMode: 'off', aiPaused: false, aiPausedAt: null, aiPausedByAccountId: null, aiState: 'off', event: null,
    };
    const thread: Thread = { detail, messages: [], olderCursor: null, loading: false, loadingOlder: false, error: null };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(ChatPanel, {
        row: r, thread, me: viewer, now: new Date('2026-11-19T06:00:00.000Z'), inserted: null, detailsOpen: false,
        onBack: noop, onLoadOlder: noop, onOpenDetails: noop, onCloseDetails: noop, onOpenTemplates: noop,
        onAskHandle: noop, onChanged: async () => undefined,
      }));
    });
    await act(async () => undefined);
  }

  it('a person who may book sees the line once the deposit reads paid, and it opens Book Date', async () => {
    const read = vi.spyOn(inboxApi, 'prebooking').mockResolvedValue({ draft: { ...paid, simulator: false } });
    vi.spyOn(inboxApi, 'bookDateProposal').mockRejectedValue(new Error('ZZ TEST no reading'));
    await open(me(), row({ depositSignal: 'paid', nextAction: 'staff_action_needed' }));
    const line = host!.querySelector('[data-testid="deposit-paid-line"]') as HTMLButtonElement | null;
    expect(line?.textContent).toBe('Deposit ฿3,000 paid and gateway verified at 16 Nov, 19:00. Check capacity, then Book Date.');
    expect(read).toHaveBeenCalled();
    await act(async () => line!.click());
    expect(host!.ownerDocument.body.textContent).toContain('Book Date — ');
  });

  it('a person who sees the chat but may not book gets no line and no amount, and nothing is asked for them', async () => {
    const read = vi.spyOn(inboxApi, 'prebooking').mockResolvedValue({ draft: paid });
    vi.spyOn(inboxApi, 'bookDateProposal').mockRejectedValue(new Error('ZZ TEST no reading'));
    await open(me({ member: false }), row({ depositSignal: 'paid', nextAction: 'staff_action_needed' }));
    expect(host!.querySelector('[data-testid="deposit-paid-line"]')).toBeNull();
    expect(host!.textContent).not.toContain('฿3,000');
    expect(read).not.toHaveBeenCalled();
  });

  it('no line before the payment, nor for a deposit that needs checking', async () => {
    const read = vi.spyOn(inboxApi, 'prebooking').mockResolvedValue({ draft: { ...paid, state: 'needs_review', paidAt: null } });
    vi.spyOn(inboxApi, 'bookDateProposal').mockRejectedValue(new Error('ZZ TEST no reading'));
    await open(me(), row({ depositSignal: 'needs_checking', nextAction: 'staff_action_needed' }));
    expect(host!.querySelector('[data-testid="deposit-paid-line"]')).toBeNull();
    await act(async () => root!.unmount());
    root = null;
    await open(me(), row({ depositSignal: null }));
    expect(host!.querySelector('[data-testid="deposit-paid-line"]')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
