// The Inbox after the staff test night of 21 October 2026 (SCRUM-220
// follow-ups; docs/qa/test-night-2026-10-21/inbox-staff/REPORT.md): the
// findings that are markup, pinned. Node, no DOM — the panel, the dialog and
// the confirmations are rendered to markup with react-dom/server, so what is
// pinned is what the page would say, not how it was wired.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Assignee, ConversationDetail, ConversationRow, Dashboard as DashboardData, InboxEvent, InboxMe, Message } from '@/api/inbox';
import { TranslationNote } from '@/components/atoms';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { newDraftId } from '@/components/Composer';
import { PrimaryMoveConfirm, TeamMoveConfirm } from '@/components/confirms';
import { StatsMore } from '@/components/StatsRow';
import { MANAGERS_ADD_SUPPORT } from '@/components/ChatActions';
import { MessageBubble } from '@/components/MessageBubble';
import { FilterFields } from '@/components/Rail';
import { EMPTY_FILTERS } from '@/lib/query';
import { SHADOW_LABEL, SUPPORT_FULL_HINT, TRANSLATION_PENDING, attachmentsOf } from '@/lib/view';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const CHALONG = '00000000-0000-7000-8000-0000000000c2';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000r1';
const T_CHALONG = '00000000-0000-7000-8000-0000000000r2';
const T_MARKETING = '00000000-0000-7000-8000-0000000000m1';
const GM = '00000000-0000-7000-8000-00000000009a';
const ANYA = '00000000-0000-7000-8000-0000000000a1';
const VERA = '00000000-0000-7000-8000-0000000000a2';
const CONV = '0192f0a0-1234-7abc-8def-0123456789ab';
const CONTACT = '0192f0a0-1234-7abc-8def-0123456789ac';
const CHANNEL_ACCOUNT = '0192f0a0-1234-7abc-8def-0123456789ad';

const teams: InboxMe['teams'] = [
  { id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: false },
  { id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false },
  { id: T_CHALONG, kind: 'reception', name: 'Reception · Robinson Chalong', colour: 'sky', branchId: CHALONG, member: false },
  { id: T_MARKETING, kind: 'marketing', name: 'Marketing', colour: 'pink', branchId: null, member: false },
];
const people: InboxMe['people'] = [
  { accountId: ANYA, name: 'Demo Anya', teamIds: [T_BIRTHDAYS], operatorWide: false },
  { accountId: VERA, name: 'Demo Vera', teamIds: [T_BIRTHDAYS], operatorWide: false },
  { accountId: GM, name: 'Demo Hana (GM)', teamIds: [], operatorWide: true },
];

const caps = (over: Partial<InboxMe['capabilities']>): InboxMe['capabilities'] => ({
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

/** The GM: owner view, every right. */
const hana: InboxMe = {
  accountId: GM,
  name: 'Demo Hana (GM)',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams,
  people,
  defaultReceptionBranchId: CENTRAL,
  capabilities: caps({ assign: true, move: true, reopen: true, templates: true }),
  simulator: null,
};

/** An agent: on the thread as primary, with the reply right only (the rails' rights). */
const anya: InboxMe = {
  ...hana,
  accountId: ANYA,
  name: 'Demo Anya',
  roles: ['events'],
  tabs: ['mine', 'team', 'handled'],
  teams: teams.map((t) => (t.id === T_BIRTHDAYS ? { ...t, member: true } : t)),
  capabilities: caps({}),
};

function slot(over: Partial<Assignee>): Assignee {
  return {
    assignmentId: 'as-primary',
    slot: 'primary',
    slotIndex: 0,
    assigneeKind: 'account',
    accountId: ANYA,
    teamId: null,
    name: 'Demo Anya',
    reason: 'auto',
    assignedAt: '2026-10-20T03:00:00.000Z',
    ...over,
  };
}

const support = (id: string, accountId: string, name: string, slotIndex: 1 | 2): Assignee =>
  slot({ assignmentId: id, slot: 'support', slotIndex, accountId, name });

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: CONV,
    channel: 'facebook',
    channelAccountId: CHANNEL_ACCOUNT,
    channelAccountName: 'Facebook page',
    canReply: true,
    contact: { id: CONTACT, channel: 'facebook', handle: '939562181554109', displayName: 'Liam Demo', phone: null, language: 'en', erased: false },
    category: 'general',
    intent: 'pricing',
    language: 'en',
    branchId: null,
    teamId: T_CENTRAL,
    status: 'active',
    handledAt: null,
    handledByKind: null,
    lastMessageAt: '2026-10-20T03:00:00.000Z',
    lastMessagePreview: 'Thanks',
    unanswered: false,
    unread: 0,
    mine: true,
    assignments: [slot({})],
    createdAt: '2026-10-19T03:00:00.000Z',
    ...over,
  };
}

function detail(r: ConversationRow, over: Partial<ConversationDetail> = {}): ConversationDetail {
  const mode = over.aiMode ?? 'off';
  const aiState = mode === 'off' ? 'off' : mode === 'shadow' ? 'shadow' : over.aiPaused ? 'paused' : 'ready';
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
    aiState,
    event: null,
    ...over,
  };
}

const thread = (d: ConversationDetail | null): Thread => ({
  detail: d,
  messages: [],
  olderCursor: null,
  loading: false,
  loadingOlder: false,
  error: null,
});

const noop = () => undefined;
const never = async () => undefined;

function panel(me: InboxMe, r: ConversationRow, d: ConversationDetail | null, detailsOpen = false): string {
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      row: r,
      thread: thread(d),
      me,
      now: new Date('2026-10-21T03:00:00.000Z'),
      inserted: null,
      detailsOpen,
      onBack: noop,
      onLoadOlder: noop,
      onOpenDetails: noop,
      onCloseDetails: noop,
      onOpenTemplates: noop,
      onAskHandle: noop,
      onChanged: never,
    }),
  );
}

describe('the ids the Inbox mints (customer-AI test night, CR6)', () => {
  // RFC 9562 layout: the version nibble is the 13th hex digit, the variant's
  // top bits the 17th. A v7 id carries the clock in its first 48 bits, so two
  // minted in a row sort in the order they were minted; a v4 is random.
  const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('the composer’s message id is a UUIDv7, so the api’s order of a thread holds for it', () => {
    const first = newDraftId();
    const second = newDraftId();
    expect(first).toMatch(V7);
    expect(second).toMatch(V7);
    expect(first < second).toBe(true);
  });
});

describe('the assistant’s state on a thread (U5)', () => {
  // SCRUM-1016: one line under the chat's header says the state ("Assistant
  // on", "Assistant handed over") with why, and its control is the word Pause
  // or Resume beside it (Chat.dc.html), where the strip's chip once read "AI
  // on · Pause". The states, which carry a control, and the U5 rules are unchanged.
  const pauseButton = /data-ai-action="pause"[^>]*aria-label="Pause the assistant"[^>]*>Pause<\/button>/;
  const resumeButton = /data-ai-action="resume"[^>]*aria-label="Resume the assistant"[^>]*>Resume<\/button>/;
  const r = row();
  it('says the assistant is off on the number, with no pause control', () => {
    const html = panel(anya, r, detail(r, { aiMode: 'off' }));
    expect(html).toContain('Assistant off on this number');
    expect(html).not.toContain('Pause the assistant');
    expect(html).not.toContain('aria-pressed');
  });
  it('says shadow as a label, and live as the pause control', () => {
    expect(panel(anya, r, detail(r, { aiMode: 'shadow' }))).toContain('Assistant in shadow');
    const live = panel(anya, r, detail(r, { aiMode: 'live' }));
    expect(live).toContain('<strong class="font-bold">Assistant on</strong>');
    expect(live).toMatch(pauseButton);
    expect(live).toContain('aria-pressed="false"');
    const paused = panel(anya, r, detail(r, { aiMode: 'live', aiPaused: true }));
    expect(paused).toContain('<strong class="font-bold">Assistant paused</strong>');
    expect(paused).toMatch(resumeButton);
  });
  it('says nothing until the detail — the number’s mode — is in', () => {
    const html = panel(anya, r, null);
    expect(html).not.toContain('Pause the assistant');
    expect(html).not.toContain('Assistant off');
  });

  it('says the api’s thread state when it is there (customer-AI test night, W4a), with the control it needs', () => {
    const live = (aiState: string) => panel(anya, r, { ...detail(r, { aiMode: 'live' }), aiState } as ConversationDetail);
    expect(live('ready')).toMatch(pauseButton);
    expect(live('ready')).toContain('Assistant on</strong> · it answers what it knows');
    expect(live('paused')).toMatch(resumeButton);
    expect(live('left_for_team')).toMatch(resumeButton);
    expect(live('left_for_team')).toContain('Assistant handed over</strong> · it will stay quiet');
    expect(live('person_replied')).toMatch(resumeButton);
    expect(live('person_replied')).toContain('Assistant quiet</strong> · a person replied');
    expect(live('shadow')).toContain('Assistant in shadow');
    expect(live('shadow')).not.toContain('aria-pressed');
    expect(live('off')).toContain('Assistant off on this number');
    expect(live('off')).not.toContain('Pause the assistant');
  });
});

function msg(over: Partial<Message> & Pick<Message, 'id' | 'createdAt'>): Message {
  return {
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
    ...over,
  };
}

function ev(over: Partial<InboxEvent> & Pick<InboxEvent, 'id' | 'kind'>): InboxEvent {
  return { actorKind: 'system', actorAccountId: null, actorName: null, payload: {}, createdAt: '2026-10-21T02:00:00.000Z', ...over };
}

describe('a hand-over’s pills, in one line (customer-AI test night, W7)', () => {
  const at = '2026-10-21T02:00:00.000Z';
  const r = row({ category: 'birthdays', teamId: T_BIRTHDAYS });
  const handover: InboxEvent[] = [
    ev({ id: 'c', kind: 'classified', actorKind: 'ai', payload: { turnId: 't', intent: 'birthday_party', language: 'en' }, createdAt: at }),
    ev({ id: 'rl', kind: 'released', actorKind: 'ai', payload: { slot: 'primary', teamId: T_CENTRAL }, createdAt: at }),
    ev({ id: 'mv', kind: 'moved_team', actorKind: 'ai', payload: { fromTeamId: T_CENTRAL, toTeamId: T_BIRTHDAYS }, createdAt: at }),
    ev({ id: 'ro', kind: 'routed', actorKind: 'system', payload: { teamId: T_BIRTHDAYS, language: 'en' }, createdAt: at }),
    ev({ id: 'a1', kind: 'assigned', actorKind: 'system', payload: { slot: 'primary', accountId: ANYA }, createdAt: at }),
    ev({ id: 'a2', kind: 'assigned', actorKind: 'system', payload: { slot: 'support', accountId: VERA }, createdAt: at }),
    ev({
      id: 'h',
      kind: 'ai_handover',
      actorKind: 'ai',
      payload: { turnId: 't', intent: 'birthday_party', reroutedTeamId: T_BIRTHDAYS, brochureFileIds: ['file-brochure'], messageIds: ['b1', 'h1'] },
      createdAt: at,
    }),
  ];
  const messages = [
    msg({ id: 'c1', createdAt: '2026-10-21T01:59:00.000Z', body: 'hi my son turns 5 on 14 Nov, want a party for 15 kids' }),
    msg({ id: 'b1', createdAt: at, direction: 'outbound', authorKind: 'ai', body: null, mediaFileIds: ['file-brochure'], providerStatus: 'sent' }),
    msg({ id: 'h1', createdAt: '2026-10-21T02:00:01.000Z', direction: 'outbound', authorKind: 'ai', body: 'Here are our birthday packages 🎂. One moment please.', providerStatus: 'sent' }),
  ];
  const thread7 = (d: Partial<ConversationDetail> = {}): Thread => ({ ...thread(detail(r, { teamName: 'Birthdays & Events', events: handover, ...d })), messages });
  const html = renderToStaticMarkup(
    createElement(ChatPanel, {
      row: r,
      thread: thread7(),
      me: anya,
      now: new Date('2026-10-21T03:00:00.000Z'),
      inserted: null,
      detailsOpen: false,
      onBack: noop,
      onLoadOlder: noop,
      onOpenDetails: noop,
      onCloseDetails: noop,
      onOpenTemplates: noop,
      onAskHandle: noop,
      onChanged: never,
    }),
  );

  it('collapses the seven pills into one expandable line that says where, the brochure and who', () => {
    expect(html).toContain('data-pill-group="7"');
    expect(html).toContain('AI handed over to Birthdays &amp; Events — brochure sent, Demo Anya primary, Demo Vera support');
    expect(html).toMatch(/<details[^>]*><summary/);
    // The pills are still there, under the line.
    expect(html).toContain('Assigned Demo Anya as primary');
    expect(html).toContain('Moved from Reception · Central Floresta → Birthdays &amp; Events by AI');
    // SCRUM-1016: a pill is plain words on the band (Chat.dc.html), with no bot icon on a person's
    // pill; the seven are counted by their band, under the one summary line.
    const group = html.slice(html.indexOf('data-pill-group="7"'), html.indexOf('</details>'));
    expect((group.match(/rounded-full bg-band px-3 py-1\.5/g) ?? []).length).toBe(7);
  });

  it('names the brochure on the AI’s bubble with a way to open it, instead of "No text · 1 attachment"', () => {
    expect(html).toContain('Birthday brochure');
    expect(html).toContain('aria-label="Open Birthday brochure"');
    expect(html).toContain('data-attachment="file-brochure"');
    expect(html).not.toContain('No text');
    expect(html).not.toContain('1 attachment');
  });
});

describe('an attachment on a person’s message (customer-AI test night, W7)', () => {
  const r = row();
  const render = (m: Message) =>
    renderToStaticMarkup(createElement(MessageBubble, { m, me: anya, now: new Date('2026-10-21T03:00:00.000Z'), attachments: attachmentsOf(m) }));
  it('shows a plain attachment with its name unknown, openable on a press', () => {
    const html = render(msg({ id: 's1', createdAt: '2026-10-21T02:00:00.000Z', direction: 'outbound', authorKind: 'staff', authorName: 'Demo Anya', body: 'Here is the map', mediaFileIds: ['file-map'] }));
    expect(html).toContain('Attachment');
    expect(html).toContain('aria-label="Open Attachment"');
    expect(html).toContain('Here is the map');
  });
  it('links the api’s own url and name when the media entry carries them, read optionally', () => {
    const m = {
      ...msg({ id: 's2', createdAt: '2026-10-21T02:00:00.000Z', direction: 'outbound', authorKind: 'ai', body: null, mediaFileIds: ['file-b'] }),
      media: [{ fileId: 'file-b', name: 'brochure.pdf', url: 'https://files.example/signed/b.pdf', contentType: 'application/pdf' }],
    } as Message;
    const html = render(m);
    expect(html).toContain('brochure.pdf');
    expect(html).toContain('href="https://files.example/signed/b.pdf"');
    expect(html).not.toContain('No text');
  });
  it('keeps "No text" for a textless message with nothing attached', () => {
    expect(render(msg({ id: 's3', createdAt: '2026-10-21T02:00:00.000Z', body: null }))).toContain('No text');
    expect(r.id).toBe(CONV);
  });
});

describe('shadow suggestions (customer-AI test night, W5)', () => {
  it('renders the shadow row as a muted, staff-only bubble under the AI chip, and its pill as a pill', () => {
    const r = row();
    const at = '2026-10-21T02:00:00.000Z';
    const d = detail(r, {
      aiMode: 'shadow',
      events: [
        ev({
          id: 'sh-1',
          kind: 'ai_shadow',
          actorKind: 'ai',
          payload: { turnId: 'turn-9', messageId: 'shadow-1', intent: 'faq', intents: ['faq'], language: 'en', action: 'answer', templateKey: null, holdingLine: 'none', brochure: false },
          createdAt: at,
        }),
      ],
    });
    const t: Thread = {
      ...thread(d),
      messages: [
        msg({ id: 'c1', createdAt: '2026-10-21T01:59:00.000Z', body: 'do you have lockers for bags?' }),
        msg({
          id: 'shadow-1',
          createdAt: at,
          direction: 'outbound',
          authorKind: 'ai',
          body: 'Yes, there are free lockers at reception.\nAsk the team for a key.',
          providerStatus: 'shadow' as unknown as Message['providerStatus'],
        }),
      ],
    };
    const html = renderToStaticMarkup(
      createElement(ChatPanel, {
        row: r,
        thread: t,
        me: anya,
        now: new Date('2026-10-21T03:00:00.000Z'),
        inserted: null,
        detailsOpen: false,
        onBack: noop,
        onLoadOlder: noop,
        onOpenDetails: noop,
        onCloseDetails: noop,
        onOpenTemplates: noop,
        onAskHandle: noop,
        onChanged: never,
      }),
    );
    expect(html).toContain('data-shadow="true"');
    expect(html).toContain(SHADOW_LABEL);
    expect(html).toContain('Yes, there are free lockers at reception.');
    // SCRUM-1016: under the "Assistant" label (Chat.dc.html), dashed on the card.
    expect(html).toContain('</svg> Assistant</span>');
    expect(html).toContain('border-dashed');
    expect(html).toContain('AI in shadow · would have answered · faq');
    // Never an ordinary AI bubble, never the default pill ("ai shadow"), no correction control on it.
    expect(html).not.toContain('rounded-tr-md bg-mint text-teal');
    expect(html).not.toContain('ai shadow');
    expect(html).not.toContain('Correct the assistant');
  });
});

describe('the support cap (U4)', () => {
  it('says "Support 2/2" with the api’s reason where "Add support" sat, once both places are taken', () => {
    const full = row({ assignments: [slot({}), support('as-s1', VERA, 'Demo Vera', 1), support('as-s2', GM, 'Demo Hana (GM)', 2)] });
    const html = panel(hana, full, detail(full));
    expect(html).toContain('Support 2/2');
    expect(html).toContain(SUPPORT_FULL_HINT);
    expect(html).not.toContain('Add support');
  });
  it('keeps "Add support" while a place is free', () => {
    const one = row({ assignments: [slot({}), support('as-s1', VERA, 'Demo Vera', 1)] });
    const html = panel(hana, one, detail(one));
    expect(html).toContain('Add support');
    expect(html).not.toContain('Support 2/2');
  });
});

describe('dead ends for an agent without a word (U7)', () => {
  const handled = row({ status: 'handled', handledAt: '2026-10-21T02:00:00.000Z', handledByKind: 'account' });
  it('tells an agent a manager can reopen a handled thread; offers the GM Reopen', () => {
    expect(panel(anya, handled, detail(handled))).toContain('A manager can reopen this');
    const gm = panel(hana, handled, detail(handled));
    expect(gm).toContain('Reopen');
    expect(gm).not.toContain('A manager can reopen this');
  });
  it('shows an agent no "Add support", and tells them in the details that managers add it', () => {
    const r = row();
    expect(panel(anya, r, detail(r))).not.toContain('Add support');
    expect(panel(anya, r, detail(r), true)).toContain(MANAGERS_ADD_SUPPORT);
    expect(panel(hana, r, detail(r), true)).not.toContain(MANAGERS_ADD_SUPPORT);
  });
});

describe('the wording (U9)', () => {
  const r = row();
  // SCRUM-1016: the header's second line says where the chat came from
  // (Chat.dc.html); the id is in People and actions' details, labelled so
  // nobody dials it.
  it('labels a Facebook id in the details', () => {
    expect(panel(anya, r, detail(r))).toMatch(/>Facebook ID<\/dt><dd[^>]*>939562181554109<\/dd>/);
    expect(panel(anya, r, detail(r))).not.toContain('>Handle</dt>');
  });
  it('shows the desk’s park, not "All branches", on a reception thread with no branch of its own', () => {
    const html = panel(hana, r, detail(r));
    expect(html).toContain('aria-label="Conversation branch"');
    expect(html).toMatch(new RegExp(`<option value="${CENTRAL}" selected="">Central Floresta</option>`));
    // The agent's read-only Park row says the same park (SCRUM-1016: the
    // details' Branch line became People and actions' Park row).
    const agent = panel(anya, r, detail(r));
    expect(agent).not.toContain('aria-label="Conversation branch"');
    expect(agent).toMatch(/>Park<\/span><span[^>]*><span class="truncate">Central Floresta<\/span>/);
    // And the header says where the chat came from: the number, the topic, the park.
    expect(agent).toContain(' · General · Central Floresta</p>');
  });
  it('explains the category badge against the team, in a tooltip', () => {
    expect(panel(anya, r, detail(r))).toContain(
      'title="Topic: General — what the conversation is about. Team: Reception · Central Floresta — who handles it."',
    );
  });
  it('labels the average response by its scope once the api says it', () => {
    const data: DashboardData = {
      day: '2026-10-21',
      newToday: 0,
      unanswered: 0,
      active: 0,
      handledToday: 0,
      averageFirstResponseSeconds: 252,
      scope: 'mine',
      population: 'active',
      byCategory: { birthdays: 0, general: 0, marketing: 0, gm: 0 },
      beosThisWeek: 0,
      weekStart: '2026-10-19',
    };
    // SCRUM-1016: whose average it is now reads beside "Avg reply" under More figures.
    const card = (d: DashboardData) => renderToStaticMarkup(createElement(StatsMore, { data: d }));
    expect(card(data)).toContain('your average');
    expect(card({ ...data, scope: 'team' })).toContain('the team’s average');
    // An api that says no scope (an older deployment) leaves the card as it was.
    expect(card({ ...data, scope: undefined } as unknown as DashboardData)).not.toContain('average</span>');
  });
  it('marks a template still in English in one way', () => {
    expect(renderToStaticMarkup(createElement(TranslationNote))).toContain(TRANSLATION_PENDING);
  });
});

describe('the move confirmations (U6)', () => {
  it('asks before the team badge moves a thread, and says who the routing seats', () => {
    const html = renderToStaticMarkup(
      createElement(TeamMoveConfirm, {
        pending: { toTeamName: 'Marketing', fromTeamName: 'Reception · Robinson Chalong' },
        busy: false,
        error: null,
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(html).toContain('Move to another team?');
    expect(html).toContain('its default owner becomes primary');
    expect(html).toContain('its backup is added as support');
    expect(html).toContain('Yes, move to Marketing');
  });
  it('says the primary move once', () => {
    const html = renderToStaticMarkup(
      createElement(PrimaryMoveConfirm, {
        pending: { name: 'Demo Anya', fromCategory: 'general', toCategory: 'birthdays', toTeamName: 'Birthdays & Events' },
        busy: false,
        error: null,
        onCancel: noop,
        onConfirm: noop,
      }),
    );
    expect(html).not.toContain('Changing primary owner will move this conversation');
    expect(html.split('will move this conversation')).toHaveLength(2);
    expect(html).toContain('Continue?');
  });
});

describe('the phone’s team and status controls (U10)', () => {
  // SCRUM-1016: the team and status controls a phone found in the details
  // dialog are rows of People and actions — the sheet a phone opens from the
  // chat's menu, the panel beside the chat on a desktop — at every width.
  const r = row();
  it('the sheet carries both controls for the GM, in the section that holds them', () => {
    const html = panel(hana, r, detail(r), true);
    const sheet = html.slice(html.indexOf('role="dialog"'));
    expect(sheet).toContain('data-phone-actions="true"');
    expect(sheet).toContain('aria-label="Move to team"');
    expect(sheet).toContain('aria-label="Set conversation status"');
  });
  it('the panel hands the sheet the controls the viewer holds: both for the GM, the status only for the primary', () => {
    const gm = panel(hana, r, detail(r), true);
    expect(gm).toContain('data-phone-actions="true"');
    expect(gm).toContain('aria-label="Move to team"');
    expect(gm).toContain('aria-label="Set conversation status"');
    // The agent is the primary: she may mark it handled, not move it.
    const agent = panel(anya, r, detail(r), true);
    expect(agent).toContain('aria-label="Set conversation status"');
    expect(agent).not.toContain('aria-label="Move to team"');
    // An agent off the thread, with no rights on it, gets no actions block.
    const bystander = panel({ ...anya, accountId: VERA, name: 'Demo Vera' }, { ...r, mine: false }, detail({ ...r, mine: false }), true);
    expect(bystander).not.toContain('data-phone-actions');
  });
});

describe('two controls labelled "Branch" (U12)', () => {
  // SCRUM-1016: the filter's visible word is "Park" (approved as drawn); it
  // stays named apart from the chat's "Conversation branch" select.
  it('names the filter apart from the strip’s select', () => {
    const html = renderToStaticMarkup(createElement(FilterFields, { me: hana, filters: EMPTY_FILTERS, onChange: noop }));
    expect(html).toContain('aria-label="Filter by park"');
    expect(html).not.toContain('aria-label="Branch"');
    expect(html).not.toContain('aria-label="Conversation branch"');
  });
});
