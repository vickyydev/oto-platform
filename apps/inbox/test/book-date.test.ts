// SCRUM-775 — Book Date and Create BEO on a birthday conversation, and the
// dashboard's BEO card. Node, no DOM, as the other markup files: the
// components rendered with react-dom/server, and the parser, the date it
// reads and the dialog's checks as the pure functions the components call.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationDetail, ConversationEvent, ConversationRow, Dashboard as DashboardData, InboxMe, Message } from '@/api/inbox';
import { OTO_APP_UNREACHABLE, checkedLaunchUrl, openConversationBeo } from '@/api/otoApp';
import { BookDateDialog, readDraft } from '@/components/BookDateDialog';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { Dashboard } from '@/components/Dashboard';
import {
  DEFAULT_START_TIME,
  bookDateDraft,
  eventChipLabel,
  parseBeoFromConversation,
  resolveEventDate,
  type BookDateDraft,
} from '@/lib/beo';
import { BOOK_DATE_NOT_YOURS_REASON, WRITES_PENDING_REASON, eventText, mayBookDate } from '@/lib/view';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000e1';
const ME = '00000000-0000-7000-8000-00000000009a';
const CONV = '0192f0a0-1234-7abc-8def-0123456789ab';
const EVENT = '0192f0a0-1234-7abc-8def-0123456789ee';

const teams = (member: boolean): InboxMe['teams'] => [
  { id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member },
  { id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false },
];

function me(o: { member?: boolean; assign?: boolean; writes?: boolean } = {}): InboxMe {
  return {
    accountId: ME,
    name: 'Agent',
    roles: ['events'],
    tabs: ['mine', 'team', 'handled'],
    teams: teams(o.member ?? true),
    people: [{ accountId: ME, name: 'Agent', teamIds: [T_BIRTHDAYS], operatorWide: false }],
    defaultReceptionBranchId: CENTRAL,
    capabilities: {
      writes: o.writes ?? true,
      dashboard: false,
      assign: o.assign ?? false,
      move: false,
      reopen: false,
      templates: false,
      kb: false,
      ai: false,
    },
    simulator: null,
  };
}

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: CONV,
    channel: 'whatsapp',
    channelAccountId: '0192f0a0-1234-7abc-8def-0000000000a1',
    channelAccountName: 'Reception · Central Floresta',
    canReply: true,
    contact: { id: '0192f0a0-1234-7abc-8def-0123456789ac', channel: 'whatsapp', handle: '+66812345678', displayName: 'Olga Demo', phone: '+66812345678', language: 'en', erased: false },
    category: 'birthdays',
    intent: 'birthday party',
    language: 'en',
    branchId: CENTRAL,
    teamId: T_BIRTHDAYS,
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-11-04T03:00:00.000Z',
    lastMessagePreview: 'Party for 15 kids',
    unanswered: true,
    unread: 1,
    mine: true,
    assignments: [],
    createdAt: '2026-11-04T02:00:00.000Z',
    ...over,
  };
}

const event: ConversationEvent = {
  id: EVENT,
  title: 'Birthday · Olga Demo',
  date: '2099-03-21',
  startTime: '14:00',
  branchId: CENTRAL,
  branchName: 'Oto Play Park, Central Floresta',
  status: 'tentative',
  statusName: 'Tentative',
  archived: false,
  kids: 15,
  adults: null,
  bookedAt: '2026-11-04T03:10:00.000Z',
  bookedByAccountId: ME,
  beoPath: `/studio/events/kanban?beo=${EVENT}`,
};

function detail(r: ConversationRow, ev: ConversationEvent | null): ConversationDetail {
  return {
    ...r,
    teamName: 'Birthdays & Events',
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
    event: ev,
  };
}

function msg(body: string, authorKind: Message['authorKind'] = 'customer'): Message {
  return {
    id: '0192f0a0-1234-7abc-8def-0000000000' + String(Math.floor(Math.random() * 90) + 10),
    direction: authorKind === 'customer' ? 'inbound' : 'outbound',
    authorKind,
    authorAccountId: null,
    authorName: null,
    body,
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
    createdAt: '2026-11-04T03:00:00.000Z',
  };
}

const noop = () => undefined;
const thread = (d: ConversationDetail | null): Thread => ({ detail: d, messages: [], olderCursor: null, loading: false, loadingOlder: false, error: null });

function panel(viewer: InboxMe, ev: ConversationEvent | null, r = row()): string {
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      row: r,
      thread: thread(detail(r, ev)),
      me: viewer,
      now: new Date('2026-11-04T04:00:00.000Z'),
      inserted: null,
      detailsOpen: false,
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

/** A button that carries the disabled attribute (not the `disabled:` style). */
const DISABLED = / disabled=""/;

/** The `<button …>…</button>` whose text is exactly `text`. */
function buttonNamed(html: string, text: string): string | null {
  const re = /<button[^>]*>(?:(?!<\/button>).)*<\/button>/gs;
  for (const m of html.matchAll(re)) if (m[0].replace(/<[^>]+>/g, '').trim() === text) return m[0];
  return null;
}

// The day msg() writes its lines: the chat's dates are counted from it (SCRUM-814), so the reading is the same whatever day the test runs.
const WRITTEN_ON = '2026-11-04';

describe("the prototype's reading of the chat, ported (parseBeoFromConversation, :2109-2158)", () => {
  const conv = row();
  it('reads the kids, the date phrase, the age, an animator and a cake from the customer’s own lines', () => {
    const data = parseBeoFromConversation(conv, [
      msg('Hello! Can we book a party for 15 kids on 21/mar?'),
      msg('Sure, which package?', 'staff'),
      msg('My son will be 5 years old. We want an animator and a cake 🎂'),
    ], WRITTEN_ON);
    expect(data).toMatchObject({
      customerName: 'Olga Demo',
      contact: '+66812345678',
      phone: '+66812345678',
      branchId: CENTRAL,
      eventDate: '21/mar',
      numKids: '15',
      numAdults: '',
      age: '5',
      animator: true,
      cake: true,
      packageName: 'Birthday Package — TBD',
    });
  });

  it('reads Russian and Thai the prototype’s way, and a weekday', () => {
    expect(parseBeoFromConversation(conv, [msg('День рождения, 12 детей, в субботы')], WRITTEN_ON).numKids).toBe('12');
    expect(parseBeoFromConversation(conv, [msg('งานวันเกิด 20 เด็ก')], WRITTEN_ON).numKids).toBe('20');
    expect(parseBeoFromConversation(conv, [msg('ฉลอง 7 ขวบ')], WRITTEN_ON).age).toBe('7');
    expect(parseBeoFromConversation(conv, [msg('Can we come next saturday with 8 kids')], WRITTEN_ON).eventDate).toBe('next saturday');
    expect(parseBeoFromConversation(conv, [msg('party on Sunday')], WRITTEN_ON).eventDate).toBe('Sunday');
  });

  it('keeps what the prototype’s kids rule does not read: a staff line', () => {
    expect(parseBeoFromConversation(conv, [msg('for 30 kids', 'staff')], WRITTEN_ON).numKids).toBe('');
    expect(parseBeoFromConversation(conv, [msg('nothing useful')], WRITTEN_ON)).toMatchObject({ eventDate: '', numKids: '', age: '', animator: false, cake: false });
  });

  // SCRUM-814: the prototype's date pattern needed a separator ("14/mar") and so never read
  // "14 March" — the owner reported it as not working. The shared reader reads it, in the
  // chat's own words.
  it('reads "14 March" with a space (SCRUM-814: the prototype’s pattern did not)', () => {
    expect(parseBeoFromConversation(conv, [msg('on 14 March please')], WRITTEN_ON).eventDate).toBe('14 March');
  });
});

describe('the phrase becomes a calendar date, from the park’s day', () => {
  const today = '2026-11-04'; // a Wednesday
  it('a day and month is its next occurrence, today or later', () => {
    expect(resolveEventDate('21/mar', today)).toBe('2027-03-21');
    expect(resolveEventDate('14-nov', today)).toBe('2026-11-14');
    expect(resolveEventDate('4.nov', today)).toBe('2026-11-04');
    expect(resolveEventDate('3/nov', today)).toBe('2027-11-03');
    expect(resolveEventDate('18-мая', today)).toBe('2027-05-18');
    expect(resolveEventDate('5.พ.ค', today)).toBe('2027-05-05');
  });
  it('a date that does not exist, or no phrase, is no date', () => {
    expect(resolveEventDate('31/feb', today)).toBeNull();
    expect(resolveEventDate('', today)).toBeNull();
    expect(resolveEventDate('soon', today)).toBeNull();
  });
  it('a weekday is the next such day, today or later', () => {
    expect(resolveEventDate('Saturday', today)).toBe('2026-11-07');
    expect(resolveEventDate('next sunday', today)).toBe('2026-11-08');
    expect(resolveEventDate('wednesday', today)).toBe('2026-11-04');
    expect(resolveEventDate('субботы', today)).toBe('2026-11-07');
  });
});

describe('the dialog opens with the reading and checks before it saves', () => {
  const draft = bookDateDraft(
    parseBeoFromConversation(row(), [msg('Party for 15 kids on 21/mar, she turns 6 years')], WRITTEN_ON),
    '2026-11-04',
    CENTRAL,
  );
  it('fills the date, the park, the guests, the contact and the age; the Events module’s start time', () => {
    expect(draft).toEqual<BookDateDraft>({
      date: '2027-03-21',
      dateFrom: '21/mar',
      startTime: DEFAULT_START_TIME,
      timeFrom: '',
      branchId: CENTRAL,
      kids: '15',
      adults: '',
      contactName: 'Olga Demo',
      phone: '+66812345678',
      childName: '',
      childAge: '6',
    });
  });
  it('opens Phone empty on a channel that gives no phone: a handle is no phone number', () => {
    const instagram = row({
      channel: 'instagram',
      contact: { id: '0192f0a0-1234-7abc-8def-0123456789ad', channel: 'instagram', handle: '17841400000000001', displayName: 'Olga Demo', phone: null, language: 'en', erased: false },
    });
    const data = parseBeoFromConversation(instagram, [msg('Party for 15 kids on 21/mar')], WRITTEN_ON);
    // The prototype's free contact keeps the handle; the Phone field does not take it.
    expect(data.contact).toBe('17841400000000001');
    expect(data.phone).toBe('');
    const d = bookDateDraft(data, '2026-11-04', CENTRAL);
    expect(d.phone).toBe('');
    expect(readDraft(d)).toMatchObject({ values: { phone: null } });
  });

  it('reads the draft into the route’s fields, or says what is missing', () => {
    expect(readDraft(draft)).toEqual({
      values: {
        branchId: CENTRAL,
        date: '2027-03-21',
        startTime: '14:00',
        kids: 15,
        adults: null,
        contactName: 'Olga Demo',
        phone: '+66812345678',
        childName: null,
        childAge: 6,
      },
    });
    expect(readDraft({ ...draft, date: '' })).toEqual({ problem: 'Choose the date.' });
    expect(readDraft({ ...draft, branchId: '' })).toEqual({ problem: 'Choose the park.' });
    expect(readDraft({ ...draft, kids: 'ten' })).toEqual({ problem: 'Kids is a whole number.' });
    expect(readDraft({ ...draft, contactName: '  ' })).toEqual({ problem: 'Enter who is booking.' });
  });
  it('renders the fields, the chat’s phrase beside the date, and the save', () => {
    const html = renderToStaticMarkup(
      createElement(BookDateDialog, {
        open: true,
        customer: 'Olga Demo',
        initial: draft,
        branches: [{ value: CENTRAL, label: 'Central Floresta' }],
        busy: false,
        error: null,
        thenOpensBeo: false,
        onCancel: noop,
        onSave: noop,
      }),
    );
    expect(html).toContain('Book Date — Olga Demo');
    expect(html).toContain('The chat says “21/mar”');
    expect(html).toContain('value="2027-03-21"');
    expect(html).toContain('Central Floresta');
    expect(html).toContain('>Book date</button>');
  });
});

describe('Book Date and Create BEO in the conversation', () => {
  it('for the birthdays team: both live, no event yet', () => {
    const html = panel(me(), null);
    expect(buttonNamed(html, 'Book Date')).not.toMatch(DISABLED);
    expect(buttonNamed(html, 'Create BEO')).not.toMatch(DISABLED);
    expect(html).not.toContain('Event: ');
    expect(html).not.toContain('With the event orders');
  });

  it('a manager who assigns, outside the team, may book too', () => {
    expect(mayBookDate(me({ member: false, assign: true }))).toBe(true);
    expect(buttonNamed(panel(me({ member: false, assign: true }), null), 'Book Date')).not.toMatch(DISABLED);
  });

  it('anyone else sees both disabled, with why', () => {
    const viewer = me({ member: false, assign: false });
    expect(mayBookDate(viewer)).toBe(false);
    const html = panel(viewer, null);
    expect(buttonNamed(html, 'Book Date')).toMatch(DISABLED);
    expect(html).toContain(`title="${BOOK_DATE_NOT_YOURS_REASON}"`);
  });

  it('with writes not switched on, both say so, as the other controls do', () => {
    const html = panel(me({ writes: false }), null);
    expect(buttonNamed(html, 'Book Date')).toMatch(DISABLED);
    expect(buttonNamed(html, 'Create BEO')).toMatch(DISABLED);
    expect(html).toContain(`title="${WRITES_PENDING_REASON}"`);
    expect(html).not.toContain(BOOK_DATE_NOT_YOURS_REASON);
  });

  it('once booked: "Date Booked", and the chip naming the date and the park, which opens the event', () => {
    const html = panel(me(), event);
    expect(buttonNamed(html, 'Date Booked')).toMatch(DISABLED);
    expect(buttonNamed(html, 'Create BEO')).not.toMatch(DISABLED);
    const chip = buttonNamed(html, 'Event: 21 Mar 2099 at Central Floresta');
    expect(chip).not.toBeNull();
    expect(chip).toContain('Tentative in the Events calendar');
  });

  it('an event archived in the Events module says so on the button and the chip; Create BEO still opens it', () => {
    const html = panel(me(), { ...event, archived: true });
    expect(buttonNamed(html, 'Date Booked')).toBeNull();
    expect(buttonNamed(html, 'Event archived')).toMatch(DISABLED);
    expect(buttonNamed(html, 'Create BEO')).not.toMatch(DISABLED);
    const chip = buttonNamed(html, 'Event: 21 Mar 2099 at Central Floresta · Archived');
    expect(chip).not.toBeNull();
    expect(chip).toContain('Archived in the Events calendar');
  });

  it('a conversation outside Birthdays & Events has neither', () => {
    const html = panel(me(), null, row({ category: 'general', teamId: T_CENTRAL }));
    expect(buttonNamed(html, 'Book Date')).toBeNull();
    expect(buttonNamed(html, 'Create BEO')).toBeNull();
  });

  it('the chip label, and the pill the booking leaves', () => {
    expect(eventChipLabel({ date: '2099-03-21', branchName: 'Central Floresta' })).toBe('Event: 21 Mar 2099 at Central Floresta');
    expect(eventChipLabel({ date: '2099-03-21', branchName: null })).toBe('Event: 21 Mar 2099');
    expect(eventChipLabel({ date: '2099-03-21', branchName: 'Central Floresta', archived: true })).toBe(
      'Event: 21 Mar 2099 at Central Floresta · Archived',
    );
    expect(
      eventText(
        { id: EVENT, kind: 'date_booked', actorKind: 'account', actorAccountId: ME, actorName: 'Anya', payload: {}, createdAt: event.bookedAt },
        { me: me() },
      ),
    ).toBe('Date blocked in the Events calendar by Anya · awaiting confirmation');
  });
});

describe('Create BEO goes only to a hand-off address the api answered', () => {
  it('takes the OTO App hand-off with its BEO target, and nothing else', () => {
    const ok = 'https://otoapp.example/#handoff=eyJ.abc.def&to=%2Fstudio%2Fevents%2Fkanban%3Fbeo%3D0192f0a0-1234-7abc-8def-0123456789ee';
    expect(checkedLaunchUrl(ok)).toBe(ok);
    expect(checkedLaunchUrl('https://otoapp.example/#handoff=eyJ.abc.def')).toBe('https://otoapp.example/#handoff=eyJ.abc.def');
    for (const bad of [null, '', 'javascript:alert(1)//#handoff=x', 'https://otoapp.example/', 'https://otoapp.example/#to=%2Fx', 'not a url']) {
      expect(() => checkedLaunchUrl(bad), String(bad)).toThrow(OTO_APP_UNREACHABLE);
    }
  });
});

describe("the dashboard's BEO card", () => {
  it('counts the week’s booked birthdays', () => {
    const data: DashboardData = {
      scope: 'all',
      newToday: 1,
      unanswered: 0,
      handledToday: 0,
      active: 1,
      averageFirstResponseSeconds: null,
      population: 'active',
      byCategory: { birthdays: 1, general: 0, marketing: 0, gm: 0 },
      day: '2026-11-04',
      beosThisWeek: 3,
      weekStart: '2026-11-02',
    };
    const html = renderToStaticMarkup(createElement(Dashboard, { data, error: null, unansweredOnly: false, onToggleUnanswered: noop }));
    expect(html).toContain('BEOs created · week');
    expect(html).toContain('Since Monday 2026-11-02');
    expect(html).toMatch(/BEOs created · week<\/div><\/div><div[^>]*><div[^>]*>3<\/div>/);
  });
});

describe('Create BEO asks the BEO form for its AI Fill; the event chip does not (SCRUM-660)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const launch = `https://otoapp.example/#handoff=eyJ.abc.def&to=${encodeURIComponent(`/studio/events/kanban?beo=${EVENT}&fill=inbox`)}`;

  /** Records what the inbox sends to open-beo, and answers a hand-off. */
  function recordOpenBeo() {
    const sent: Array<{ url: string; body: unknown; contentType: string | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        sent.push({ url, body: init.body === undefined ? undefined : JSON.parse(String(init.body)), contentType: headers['content-type'] });
        return new Response(
          JSON.stringify({ conversationId: CONV, eventId: EVENT, beoPath: '/x', launchUrl: launch, expiresAt: new Date().toISOString() }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    return sent;
  }

  it('Create BEO sends aiFill, and the tab goes to the hand-off the api answered', async () => {
    const sent = recordOpenBeo();
    const tab = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    await openConversationBeo(CONV, tab, { aiFill: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toMatch(new RegExp(`/inbox/conversations/${CONV}/open-beo$`));
    expect(sent[0]!.body).toEqual({ aiFill: true });
    expect(sent[0]!.contentType).toBe('application/json');
    expect(tab.location.href).toBe(launch);
  });

  it('the event chip sends no body: the form opens as it is', async () => {
    const sent = recordOpenBeo();
    const tab = { location: { href: '' }, close: vi.fn() } as unknown as Window;
    await openConversationBeo(CONV, tab);
    expect(sent[0]!.body).toBeUndefined();
    expect(sent[0]!.contentType).toBeUndefined();
  });
});
