// SCRUM-653 — the dark palette, smoke-pinned: the key surfaces rendered to
// markup (Node, no DOM, as the test-night file renders) carry dark: variants,
// so a refactor that drops the inverted classes fails here rather than on
// the floor. Covered: the shell's rail and header menu, a conversation row
// with its search and pills, the bubbles (customer, staff, AI, shadow), the
// composer with its send, the dashboard cards, and a dialog.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationRow, Dashboard as DashboardData, InboxMe, Message } from '@/api/inbox';
import { Composer } from '@/components/Composer';
import { ConversationList } from '@/components/ConversationList';
import { Dashboard } from '@/components/Dashboard';
import { Dialog } from '@/components/Dialog';
import { MessageBubble, ShadowBubble } from '@/components/MessageBubble';
import { Rail } from '@/components/Rail';
import { SettingsMenuItems } from '@/components/Workspace';
import { MessagesSquare } from 'lucide-react';
import { EMPTY_FILTERS } from '@/lib/query';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000r1';
const GM = '00000000-0000-7000-8000-00000000009a';
const CONV = '0192f0a0-1234-7abc-8def-0123456789ab';
const CONTACT = '0192f0a0-1234-7abc-8def-0123456789ac';

const me: InboxMe = {
  accountId: GM,
  name: 'Demo Hana (GM)',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams: [{ id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false }],
  people: [],
  defaultReceptionBranchId: CENTRAL,
  capabilities: { writes: true, dashboard: true, assign: true, move: true, reopen: true, templates: true, kb: true, ai: true },
  simulator: null,
};

const row: ConversationRow = {
  id: CONV,
  channel: 'whatsapp',
  channelAccountId: '0192f0a0-1234-7abc-8def-0123456789ad',
  canReply: true,
  contact: { id: CONTACT, channel: 'whatsapp', handle: '66900000001', displayName: 'Liam Demo', phone: null, language: 'en', erased: false },
  category: 'general',
  intent: 'pricing',
  language: 'en',
  branchId: null,
  teamId: T_CENTRAL,
  status: 'active',
  handledAt: null,
  handledByKind: null,
  lastMessageAt: '2026-10-22T03:00:00.000Z',
  lastMessagePreview: 'Thanks',
  unanswered: true,
  unread: 1,
  mine: false,
  assignments: [],
  createdAt: '2026-10-21T03:00:00.000Z',
};

const msg = (over: Partial<Message>): Message => ({
  id: 'm1',
  direction: 'inbound',
  authorKind: 'customer',
  authorAccountId: null,
  authorName: null,
  body: 'hello',
  bodyLanguage: 'en',
  translatedBody: null,
  translatedTo: null,
  mediaFileIds: [],
  audioFileId: null,
  transcript: null,
  templateId: null,
  providerStatus: null,
  source: 'channel',
  sentAt: null,
  deliveredAt: null,
  readAt: null,
  redacted: false,
  createdAt: '2026-10-22T02:00:00.000Z',
  ...over,
});

const now = new Date('2026-10-22T03:00:00.000Z');
const noop = () => undefined;

describe('the dark palette on the key surfaces', () => {
  it('the workspace shell: the rail inverts its ground, tabs and count pills', () => {
    const html = renderToStaticMarkup(
      createElement(Rail, { me, tab: 'team', counts: { team: 3 }, filters: EMPTY_FILTERS, onTab: noop, onFilters: noop }),
    );
    expect(html).toContain('dark:bg-slate-950/40');
    expect(html).toContain('dark:border-slate-800');
    expect(html).toContain('dark:text-slate-100');
  });

  it('the header: the settings menu card inverts', () => {
    const html = renderToStaticMarkup(createElement(SettingsMenuItems, { me, onChoose: noop }));
    expect(html).toContain('dark:bg-slate-900');
    expect(html).toContain('dark:hover:bg-slate-800');
  });

  it('a list row: ground, name ink, preview and the unanswered chip invert', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationList, {
        me,
        tab: 'team',
        page: null,
        rows: [row],
        loading: false,
        loadingMore: false,
        error: null,
        filters: EMPTY_FILTERS,
        search: '',
        selectedId: row.id,
        now,
        onSearch: noop,
        onFilters: noop,
        onTab: noop,
        onOpenFilters: noop,
        onSelect: noop,
        onAskHandle: noop,
        onMore: noop,
      }),
    );
    expect(html).toContain('dark:bg-slate-950/60'); // the selected row's ground
    expect(html).toContain('dark:text-slate-100'); // the contact's name
    expect(html).toContain('dark:ring-slate-700'); // search and pills
    expect(html).toContain('dark:bg-rose-500/15'); // the unanswered chip, readable rose
  });

  it('the bubbles: customer white to slate-800, staff tuned, AI indigo tuned, shadow dashed indigo', () => {
    const customer = renderToStaticMarkup(createElement(MessageBubble, { m: msg({}), me, now }));
    expect(customer).toContain('bg-white dark:bg-slate-800');
    const staff = renderToStaticMarkup(
      createElement(MessageBubble, { m: msg({ direction: 'outbound', authorKind: 'staff', authorName: 'Demo Anya' }), me, now }),
    );
    expect(staff).toContain('bg-slate-900 text-white dark:bg-slate-700');
    const ai = renderToStaticMarkup(createElement(MessageBubble, { m: msg({ direction: 'outbound', authorKind: 'ai' }), me, now }));
    expect(ai).toContain('dark:bg-indigo-500/15');
    expect(ai).toContain('dark:text-indigo-200');
    const shadow = renderToStaticMarkup(createElement(ShadowBubble, { text: 'Would have said', at: '2026-10-22T02:00:00.000Z', now }));
    expect(shadow).toContain('dark:border-indigo-500/40');
    expect(shadow).toContain('dark:bg-indigo-500/10');
  });

  it('the composer: the bar, the field and the send invert', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, { conv: row, me, inserted: null, onOpenTemplates: noop, onSent: noop, onReopen: noop, reopening: false }),
    );
    expect(html).toContain('dark:bg-slate-900'); // the bar
    expect(html).toContain('dark:bg-slate-950/60'); // the field's well
    expect(html).toContain('dark:bg-slate-100 dark:text-slate-900'); // the send, inverted
  });

  it('the dashboard: the cards and their accent tints invert', () => {
    const data: DashboardData = {
      newToday: 1,
      unanswered: 2,
      active: 3,
      handledToday: 4,
      averageFirstResponseSeconds: 60,
      scope: 'all',
      population: 'active',
      day: '2026-10-22',
      byCategory: { birthdays: 1, general: 2, marketing: 0 },
    };
    const html = renderToStaticMarkup(
      createElement(Dashboard, { data, error: null, unansweredOnly: false, onToggleUnanswered: noop }),
    );
    expect(html).toContain('dark:bg-slate-900'); // the card ground
    expect(html).toContain('dark:bg-rose-500/15'); // the unanswered tint
    expect(html).toContain('dark:bg-emerald-500/15'); // handled today
  });

  it('a dialog: the card, header rule and close control invert', () => {
    const html = renderToStaticMarkup(
      createElement(Dialog, { open: true, onClose: noop, icon: MessagesSquare, title: 'A dialog', children: 'body' }),
    );
    expect(html).toContain('dark:bg-slate-950/60'); // the overlay
    expect(html).toContain('dark:bg-slate-900'); // the card
    expect(html).toContain('dark:border-slate-800');
  });
});
