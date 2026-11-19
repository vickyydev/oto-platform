// SCRUM-653 — the dark palette, smoke-pinned: the key surfaces rendered to
// markup (Node, no DOM, as the test-night file renders).
//
// SCRUM-1016 rewrote these pins for the OTO tokens. A surface no longer
// carries a light class and a `dark:` class side by side: it names a token
// (`bg-card`, `text-ink`, `border-line`, ...) whose light and dark values
// both live in src/index.css and swap with the `dark` class on <html>
// (tokens-1016.test.ts holds every pair's contrast in both themes). So a
// surface is pinned two ways: it wears the tokens, and it carries no raw
// neutral palette class — a stray `bg-white` or `slate-*` would stay light
// in the dark theme, which is exactly the regression these pins once caught
// with `dark:` variants. Accent hues not yet moved to tokens keep their
// `dark:` pins. Covered: the shell's rail and header menu, a conversation
// row with its pills, the bubbles (customer, staff, AI, shadow), the
// composer with its send, the statistics row, and a dialog.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationRow, Dashboard as DashboardData, InboxMe, Message } from '@/api/inbox';
import { Composer } from '@/components/Composer';
import { ConversationList } from '@/components/ConversationList';
import { Dialog } from '@/components/Dialog';
import { MessageBubble, ShadowBubble } from '@/components/MessageBubble';
import { Rail } from '@/components/Rail';
import { AccountMenuItems } from '@/components/AppBar';
import { StatsRow } from '@/components/StatsRow';
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
  channelAccountName: 'Reception · Central Floresta',
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
  transcriptStatus: null,
  transcriptLanguage: null,
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

/** A neutral palette class that would not follow the theme: slate in any shade, or white as a surface. */
const RAW_NEUTRAL = /(?:^|[\s"'])(?:[a-z-]+:)*(?:bg|text|border|ring|divide|decoration)-slate-\d+|(?:^|[\s"'])(?:[a-z-]+:)*(?:bg|border|ring)-white\b/;

describe('the dark palette on the key surfaces', () => {
  // SCRUM-1016: the rail is the views column — the current tab on the band
  // token with its count in coral ink, the filters' lines washing on hover.
  it('the workspace shell: the views column stands on the ground token, the current tab on the band', () => {
    const html = renderToStaticMarkup(
      createElement(Rail, { me, tab: 'team', counts: { team: 3 }, filters: EMPTY_FILTERS, onTab: noop, onFilters: noop }),
    );
    expect(html).toContain('bg-ground');
    expect(html).toContain('border-line');
    expect(html).toContain('text-ink');
    expect(html).toContain('bg-band font-bold'); // the current tab
    expect(html).toContain('text-coral-ink'); // its count
    expect(html).toContain('hover:bg-wash');
    expect(html).not.toMatch(RAW_NEUTRAL);
  });

  it('the app bar: the account menu card is a token card', () => {
    const html = renderToStaticMarkup(
      createElement(AccountMenuItems, {
        me, theme: 'dark', onTheme: noop, settings: null, onSettings: noop, showSimulator: false, onShowSimulator: noop, onSignOut: noop,
      }),
    );
    expect(html).toContain('bg-card');
    expect(html).toContain('border-line');
    expect(html).toContain('hover:bg-wash');
    expect(html).not.toMatch(RAW_NEUTRAL);
  });

  // SCRUM-1016: the row's badge, selection and unread count are tokens now,
  // so nothing on a row carries a `dark:` class of its own.
  it('a list row: name ink, the badge, the selection and the unread count on tokens', () => {
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
        selectedId: row.id,
        now,
        onFilters: noop,
        onTab: noop,
        onOpenFilters: noop,
        onSelect: noop,
        onMore: noop,
      }),
    );
    expect(html).toContain('text-ink'); // the contact's name
    expect(html).toContain('border-line-soft'); // the row's rule
    expect(html).toContain('bg-band ring-2 ring-inset ring-ink'); // selection, apart from unread
    expect(html).toContain('bg-needs text-needs-ink'); // "Needs reply"
    expect(html).toContain('bg-coral'); // the unread count
    expect(html).not.toMatch(/[\s"]dark:/);
    expect(html).not.toMatch(RAW_NEUTRAL);
  });

  it('the bubbles: customer and staff on tokens, AI indigo tuned, shadow dashed indigo', () => {
    const customer = renderToStaticMarkup(createElement(MessageBubble, { m: msg({}), me, now }));
    expect(customer).toContain('bg-card text-ink ring-1 ring-line');
    expect(customer).not.toMatch(RAW_NEUTRAL);
    const staff = renderToStaticMarkup(
      createElement(MessageBubble, { m: msg({ direction: 'outbound', authorKind: 'staff', authorName: 'Demo Anya' }), me, now }),
    );
    // Dark in both themes (brown, then the till's navy), never inverted.
    expect(staff).toContain('bg-staff text-on-staff');
    expect(staff).toContain('text-on-staff/75'); // its time and ticks
    expect(staff).not.toMatch(RAW_NEUTRAL);
    const ai = renderToStaticMarkup(createElement(MessageBubble, { m: msg({ direction: 'outbound', authorKind: 'ai' }), me, now }));
    expect(ai).toContain('dark:bg-indigo-500/15');
    expect(ai).toContain('dark:text-indigo-200');
    const shadow = renderToStaticMarkup(createElement(ShadowBubble, { text: 'Would have said', at: '2026-10-22T02:00:00.000Z', now }));
    expect(shadow).toContain('dark:border-indigo-500/40');
    expect(shadow).toContain('dark:bg-indigo-500/10');
  });

  it('the composer: the bar is a card, the field a ground well, the send inverted ink', () => {
    const html = renderToStaticMarkup(
      createElement(Composer, { conv: row, me, inserted: null, onOpenTemplates: noop, onSent: noop, onReopen: noop, reopening: false }),
    );
    expect(html).toContain('border-line bg-card'); // the bar
    expect(html).toContain('bg-ground'); // the field's well
    expect(html).toContain('bg-ink text-on-ink'); // the send
    expect(html).not.toMatch(RAW_NEUTRAL);
  });

  it('the statistics row: a token card, the Needs reply figure in coral ink and its pressed state on tokens', () => {
    const data: DashboardData = {
      newToday: 1,
      unanswered: 2,
      active: 3,
      handledToday: 4,
      averageFirstResponseSeconds: 60,
      scope: 'all',
      population: 'active',
      day: '2026-10-22',
      byCategory: { birthdays: 1, general: 2, marketing: 0, gm: 0 },
      beosThisWeek: 0,
      weekStart: '2026-10-19',
    };
    const row = (unansweredOnly: boolean) =>
      renderToStaticMarkup(createElement(StatsRow, { variant: 'card', data, error: null, unansweredOnly, onToggleUnanswered: noop }));
    expect(row(false)).toContain('border-line bg-card'); // the card ground
    expect(row(false)).toContain('text-coral-ink'); // the figure that is the filter
    expect(row(true)).toContain('bg-needs text-needs-ink'); // pressed
    expect(row(false)).toContain('text-ink-muted'); // the figures' words
    expect(row(false)).not.toMatch(RAW_NEUTRAL);
    expect(row(true)).not.toMatch(RAW_NEUTRAL);
  });

  it('a dialog: the scrim, the card, the header rule and the close control on tokens', () => {
    const html = renderToStaticMarkup(
      createElement(Dialog, { open: true, onClose: noop, icon: MessagesSquare, title: 'A dialog', children: 'body' }),
    );
    expect(html).toContain('bg-scrim'); // the overlay
    expect(html).toContain('bg-card'); // the card
    expect(html).toContain('border-line-soft');
    expect(html).not.toMatch(RAW_NEUTRAL);
  });
});
