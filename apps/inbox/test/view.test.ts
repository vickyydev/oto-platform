import { describe, expect, it } from 'vitest';
import type { Assignee, InboxEvent, InboxMe, Message } from '@/api/inbox';
import { ApiError } from '@/api/client';
import { HANDOFF_FALLBACK, HANDOFF_REFUSALS, handoffRefusal, readHandoffToken } from '@/auth/handoff';
import { stateForRefusal } from '@/auth/SessionContext';
import { EMPTY_FILTERS, activeFilterCount, listQuery } from '@/lib/query';
import {
  SHADOW_LABEL,
  SUPPORT_FULL_HINT,
  TRANSLATION_PENDING,
  aiStateLine,
  aiStateLineFor,
  archiveFrom,
  assigneeChip,
  attachmentNames,
  attachmentsOf,
  branchLabel,
  branchOptions,
  branchOutcome,
  bubbleTime,
  canHandle,
  categoryTitle,
  defaultTab,
  durationLabel,
  effectiveBranchId,
  eventText,
  groupSummary,
  handleLabel,
  initialsOf,
  isShadowMessage,
  landingTab,
  listTime,
  moveOutcome,
  needsTranslation,
  offeredTemplates,
  responseScopeLabel,
  supportCapLabel,
  timeline,
  tintFor,
  writeMode,
  moveOptions,
  moveValue,
  slotOptions,
  branchSelectOptions,
} from '@/lib/view';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const CHALONG = '00000000-0000-7000-8000-0000000000c2';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000r1';
const T_CHALONG = '00000000-0000-7000-8000-0000000000r2';
const GM = '00000000-0000-7000-8000-00000000009a';
const ALINA = '00000000-0000-7000-8000-0000000000a1';

const me: InboxMe = {
  accountId: ALINA,
  name: 'Alina',
  roles: ['events'],
  tabs: ['mine', 'team', 'handled'],
  teams: [
    { id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: true },
    { id: T_CENTRAL, kind: 'reception', name: 'Reception · Central', colour: 'sky', branchId: CENTRAL, member: false },
    { id: T_CHALONG, kind: 'reception', name: 'Reception · Chalong', colour: 'sky', branchId: CHALONG, member: false },
  ],
  people: [
    { accountId: ALINA, name: 'Alina', teamIds: [T_BIRTHDAYS], operatorWide: false },
    { accountId: GM, name: 'Hanna', teamIds: [], operatorWide: true },
  ],
  defaultReceptionBranchId: CENTRAL,
  capabilities: { writes: false, dashboard: true, assign: false, move: false, reopen: false, templates: false, kb: false, ai: false },
  simulator: null,
};

function assignee(over: Partial<Assignee>): Assignee {
  return {
    assignmentId: 'as-1',
    slot: 'primary',
    slotIndex: 0,
    assigneeKind: 'account',
    accountId: ALINA,
    teamId: null,
    name: null,
    reason: 'auto',
    assignedAt: '2026-10-20T03:00:00.000Z',
    ...over,
  };
}

function event(over: Partial<InboxEvent>): InboxEvent {
  return {
    id: 'ev-1',
    kind: 'routed',
    actorKind: 'system',
    actorAccountId: null,
    actorName: null,
    payload: {},
    createdAt: '2026-10-20T03:00:00.000Z',
    ...over,
  };
}

function msg(id: string, createdAt: string, over: Partial<Message> = {}): Message {
  return {
    id,
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
    createdAt,
    ...over,
  };
}

describe('the write switch (plan §4.3)', () => {
  it('renders the controls disabled while the api says writes are off', () => {
    expect(writeMode(me)).toBe('disabled');
  });
  it('makes the same controls live once the api says writes are on (I3b)', () => {
    expect(writeMode({ capabilities: { ...me.capabilities, writes: true } })).toBe('live');
  });
});

describe('the write controls’ choices (I3b)', () => {
  it('the move badge offers the four destinations in the prototype’s order, and knows where the thread is', () => {
    const withMarketing = {
      teams: [...me.teams, { id: 'tm', kind: 'marketing' as const, name: 'Marketing', colour: 'pink', branchId: null, member: false }],
    };
    expect(moveOptions(withMarketing).map((o) => [o.value, o.label])).toEqual([
      ['birthdays', 'Birthdays & Events'],
      [`reception:${CENTRAL}`, 'Reception · Central'],
      [`reception:${CHALONG}`, 'Reception · Chalong'],
      ['marketing', 'Marketing'],
    ]);
    expect(moveOptions(withMarketing)[2]!.dest).toEqual({ kind: 'reception', branchId: CHALONG });
    expect(moveValue({ category: 'general', branchId: CHALONG }, me)).toBe(`reception:${CHALONG}`);
    // A general thread with no branch sits with the first park's desk (`teamDestOf`).
    expect(moveValue({ category: 'general', branchId: null }, me)).toBe(`reception:${CENTRAL}`);
    expect(moveValue({ category: 'birthdays', branchId: CHALONG }, me)).toBe('birthdays');
  });

  it('a slot picker never offers someone already on the thread; only the primary offers the desks', () => {
    const row = { assignments: [assignee({ accountId: ALINA })] };
    expect(slotOptions(row, me, 'support').map((o) => o.label)).toEqual(['Hanna']);
    expect(slotOptions(row, me, 'primary').map((o) => [o.label, o.assignee.kind])).toEqual([
      ['Hanna', 'account'],
      ['Reception · Central', 'team'],
      ['Reception · Chalong', 'team'],
    ]);
    const desk = { assignments: [assignee({ assigneeKind: 'team', accountId: null, teamId: T_CENTRAL })] };
    expect(slotOptions(desk, me, 'primary').map((o) => o.label)).toEqual(['Alina', 'Hanna', 'Reception · Chalong']);
  });

  it('the branch select: each park, then all branches', () => {
    expect(branchSelectOptions(me.teams)).toEqual([
      { value: CENTRAL, label: 'Central' },
      { value: CHALONG, label: 'Chalong' },
      { value: '', label: 'All branches' },
    ]);
  });
});

describe('who sees Mark as Handled (canHandle, :1873)', () => {
  const active = { status: 'active' as const, mine: false, teamId: T_CENTRAL };
  it('the owner view, on anything active', () => {
    expect(canHandle(active, { roles: ['owner'], teams: me.teams })).toBe(true);
  });
  it('someone on the conversation', () => {
    expect(canHandle({ ...active, mine: true }, me)).toBe(true);
  });
  it('someone in its team', () => {
    expect(canHandle({ ...active, teamId: T_BIRTHDAYS }, me)).toBe(true);
  });
  it('not an outsider, and nobody on a handled one', () => {
    expect(canHandle(active, me)).toBe(false);
    expect(canHandle({ ...active, status: 'handled', mine: true }, me)).toBe(false);
  });
});

describe('chips and names', () => {
  it('initials as the prototype writes them', () => {
    expect(initialsOf('Anna Volkova')).toBe('AV');
    expect(initialsOf('Reception · Central')).toBe('RC');
    expect(initialsOf('Hanna')).toBe('HA');
    expect(initialsOf('Demo Vera (Birthdays EN/RU backup)')).toBe('DV');
    expect(initialsOf(null)).toBe('?');
  });
  it('keeps one tint per person', () => {
    expect(tintFor(ALINA)).toBe(tintFor(ALINA));
  });
  it('paints the GM slate, a team in its colour, the AI indigo', () => {
    expect(assigneeChip(assignee({ accountId: GM }), me).tint).toBe('bg-slate-800 text-white');
    expect(assigneeChip(assignee({ assigneeKind: 'team', accountId: null, teamId: T_CENTRAL }), me)).toMatchObject({
      name: 'Reception · Central',
      tint: 'bg-sky-100 text-sky-700',
    });
    expect(assigneeChip(assignee({ assigneeKind: 'ai', accountId: null }), me).name).toBe('AI Assistant');
  });
});

describe('branches, from the reception teams', () => {
  it('names each park once, by its reception team', () => {
    expect(branchOptions(me.teams)).toEqual([
      { id: CENTRAL, label: 'Central' },
      { id: CHALONG, label: 'Chalong' },
    ]);
  });
  it('calls an operator-wide conversation "All"', () => {
    expect(branchLabel(null, me.teams)).toBe('All');
    expect(branchLabel(CHALONG, me.teams)).toBe('Chalong');
  });
  it('puts a reception thread with no branch of its own at its desk’s park (test night U9)', () => {
    expect(effectiveBranchId({ branchId: null, teamId: T_CENTRAL }, me.teams)).toBe(CENTRAL);
    expect(effectiveBranchId({ branchId: CHALONG, teamId: T_CENTRAL }, me.teams)).toBe(CHALONG);
    // A birthday thread with no branch is at every park.
    expect(effectiveBranchId({ branchId: null, teamId: T_BIRTHDAYS }, me.teams)).toBeNull();
    expect(effectiveBranchId({ branchId: null, teamId: null }, me.teams)).toBeNull();
  });
});

describe('the wording a reception person misread (test night 2026-10-21, U9)', () => {
  it('tells the topic badge from the team', () => {
    expect(categoryTitle('general', 'Reception · Central')).toBe(
      'Topic: General — what the conversation is about. Team: Reception · Central — who handles it.',
    );
    expect(categoryTitle('birthdays', null)).toBe('Topic: Birthdays & Events — what the conversation is about.');
  });
  it('labels a Facebook or Instagram id so it is not read as a phone number', () => {
    expect(handleLabel('facebook')).toBe('Facebook ID');
    expect(handleLabel('instagram')).toBe('Instagram ID');
    expect(handleLabel('whatsapp')).toBeNull();
    expect(handleLabel('line')).toBeNull();
  });
  it('says whose average the response time is, once the api says the scope', () => {
    expect(responseScopeLabel('mine')).toBe('your average');
    expect(responseScopeLabel('team')).toBe('the team’s average');
    expect(responseScopeLabel('all')).toBe('all');
    expect(responseScopeLabel(undefined)).toBeNull();
    expect(responseScopeLabel('everyone')).toBeNull();
  });
});

describe('the support cap (test night U4)', () => {
  it('says "Support 2/2" only when both places are taken, in the api’s words', () => {
    expect(supportCapLabel(0)).toBeNull();
    expect(supportCapLabel(1)).toBeNull();
    expect(supportCapLabel(2)).toBe('Support 2/2');
    expect(SUPPORT_FULL_HINT).toBe('Both support places are taken. Remove someone first.');
  });
});

describe('the assistant’s state line (test night U5)', () => {
  it('derives from the number’s mode first, then the thread’s pause', () => {
    expect(aiStateLine('off', false)).toEqual({ kind: 'label', text: 'Assistant off on this number' });
    expect(aiStateLine('off', true)).toEqual({ kind: 'label', text: 'Assistant off on this number' });
    expect(aiStateLine('shadow', false)).toEqual({ kind: 'label', text: 'Assistant in shadow' });
    expect(aiStateLine('shadow', true)).toEqual({ kind: 'control', text: 'AI paused · Resume', paused: true, action: 'resume' });
    expect(aiStateLine('live', false)).toEqual({ kind: 'control', text: 'AI on · Pause', paused: false, action: 'pause' });
    expect(aiStateLine('live', true)).toEqual({ kind: 'control', text: 'AI paused · Resume', paused: true, action: 'resume' });
  });

  it('says the api’s own state when it is there (customer-AI test night, W4a), each with its word', () => {
    const live = { aiMode: 'live' as const, aiPaused: false };
    expect(aiStateLineFor({ ...live, aiState: 'ready' })).toEqual({ kind: 'control', text: 'AI on · Pause', paused: false, action: 'pause' });
    expect(aiStateLineFor({ ...live, aiState: 'paused' })).toEqual({ kind: 'control', text: 'AI paused · Resume', paused: true, action: 'resume' });
    expect(aiStateLineFor({ ...live, aiState: 'left_for_team' })).toEqual({
      kind: 'control',
      text: 'AI handed over · Resume',
      paused: true,
      action: 'resume',
    });
    expect(aiStateLineFor({ ...live, aiState: 'person_replied' })).toEqual({
      kind: 'control',
      text: 'AI stopped: a person replied · Resume',
      paused: true,
      action: 'resume',
    });
    expect(aiStateLineFor({ ...live, aiState: 'shadow' })).toEqual({ kind: 'label', text: 'Assistant in shadow' });
    expect(aiStateLineFor({ ...live, aiState: 'off' })).toEqual({ kind: 'label', text: 'Assistant off on this number' });
  });

  it('keeps the U5 derivation when the api says no state, or one it does not know', () => {
    expect(aiStateLineFor({ aiMode: 'off', aiPaused: false })).toEqual({ kind: 'label', text: 'Assistant off on this number' });
    expect(aiStateLineFor({ aiMode: 'live', aiPaused: true, aiState: undefined })).toMatchObject({ text: 'AI paused · Resume' });
    expect(aiStateLineFor({ aiMode: 'live', aiPaused: false, aiState: 'dreaming' })).toMatchObject({ text: 'AI on · Pause' });
  });
});

describe('shadow suggestions on the thread read (customer-AI test night, W5)', () => {
  const ctx = { me };
  const at = '2026-10-20T03:00:00.000Z';
  // The shadow turn: one unsent row with the would-be lines, and a pill that names it — never any text on the pill.
  const shadowRow = msg('sm1', at, {
    direction: 'outbound',
    authorKind: 'ai',
    body: 'We open at 10:00.\nEvery day.',
    providerStatus: 'shadow' as unknown as Message['providerStatus'],
  });
  const pill = event({
    id: 's1',
    kind: 'ai_shadow',
    actorKind: 'ai',
    createdAt: at,
    payload: { turnId: 't1', messageId: 'sm1', intent: 'hours', intents: ['hours'], language: 'en', action: 'answer', templateKey: null, holdingLine: 'none', brochure: false },
  });

  it('shows the shadow row as the shadow item, its turn from the pill that names it, and the pill as a pill', () => {
    expect(timeline([shadowRow], [pill], true, ctx)).toEqual([
      { kind: 'shadow', at, id: 'sm1', text: 'We open at 10:00.\nEvery day.', turnId: 't1' },
      { kind: 'pill', at, id: 's1', text: 'AI in shadow · would have answered · hours', event: 'ai_shadow' },
    ]);
    expect(isShadowMessage(shadowRow)).toBe(true);
    expect(isShadowMessage(msg('m', at, { providerStatus: 'sent' }))).toBe(false);
    expect(SHADOW_LABEL).toBe('Shadow suggestion — not sent');
  });

  it('words the shadow pill by what it would have done, and never builds a bubble from the pill', () => {
    expect(eventText(event({ kind: 'ai_shadow', payload: { action: 'handover', intent: 'birthday_party', brochure: true } }), ctx)).toBe(
      'AI in shadow · would have handed over · birthday party',
    );
    expect(eventText(event({ kind: 'ai_shadow', payload: { action: 'silent' } }), ctx)).toBe('AI in shadow · would have stayed silent');
    expect(eventText(event({ kind: 'ai_shadow', payload: {} }), ctx)).toBe('AI in shadow');
    // A payload with words (an older shape) is still a pill, never a bubble.
    expect(timeline([], [event({ id: 's9', kind: 'ai_shadow', payload: { text: 'not a bubble', turnId: 't9' } })], true, ctx).map((i) => i.kind)).toEqual([
      'pill',
    ]);
  });

  it('leaves a shadow row’s turn unknown when no pill names it', () => {
    expect(timeline([shadowRow], [], true, ctx)).toEqual([{ kind: 'shadow', at, id: 'sm1', text: 'We open at 10:00.\nEvery day.', turnId: null }]);
  });
});

describe('runs of system pills in one line (customer-AI test night, W7)', () => {
  const ctx = { me };
  const at = '2026-10-20T03:00:00.000Z';
  const later = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString();
  /** The seven pills one AI hand-over writes, in one moment. */
  const handover = [
    event({ id: 'c', kind: 'classified', actorKind: 'ai', payload: { turnId: 't', intent: 'birthday_party', language: 'en' }, createdAt: at }),
    event({ id: 'r', kind: 'released', actorKind: 'ai', payload: { slot: 'primary', teamId: T_CENTRAL }, createdAt: at }),
    event({ id: 'mv', kind: 'moved_team', actorKind: 'ai', payload: { fromTeamId: T_CENTRAL, toTeamId: T_BIRTHDAYS }, createdAt: at }),
    event({ id: 'ro', kind: 'routed', actorKind: 'system', payload: { teamId: T_BIRTHDAYS, language: 'en' }, createdAt: at }),
    event({ id: 'a1', kind: 'assigned', actorKind: 'system', payload: { slot: 'primary', accountId: ALINA }, createdAt: at }),
    event({ id: 'a2', kind: 'assigned', actorKind: 'system', payload: { slot: 'support', accountId: GM }, createdAt: at }),
    event({
      id: 'h',
      kind: 'ai_handover',
      actorKind: 'ai',
      payload: { turnId: 't', intent: 'birthday_party', reroutedTeamId: T_BIRTHDAYS, brochureFileIds: ['f1'], messageIds: ['m2'] },
      createdAt: at,
    }),
  ];

  it('says a hand-over in one line — where it went, the brochure, who it seated — with the pills under it', () => {
    const items = timeline([], handover, true, ctx);
    expect(items).toHaveLength(1);
    const g = items[0]!;
    expect(g.kind).toBe('group');
    if (g.kind !== 'group') return;
    expect(g.summary).toBe('AI handed over to Birthdays & Events — brochure sent, Alina primary, Hanna support');
    expect(g.pills.map((p) => p.id)).toEqual(['c', 'r', 'mv', 'ro', 'a1', 'a2', 'h']);
    expect(g.id).toBe('group:c');
  });

  it('says a hand-over with nothing seated and no brochure plainly', () => {
    const only = [event({ id: 'h', kind: 'ai_handover', actorKind: 'ai', payload: { reroutedTeamId: null, intent: 'lost_item' }, createdAt: at })];
    expect(groupSummary([{ item: { text: 'x' }, event: only[0]! }], ctx)).toBe('AI handed over to the team');
  });

  it('leads any other run with its most telling pill and counts the rest', () => {
    const hana = { actorKind: 'account' as const, actorAccountId: GM };
    const run = [
      event({ id: 'r', kind: 'released', ...hana, payload: { slot: 'primary', teamId: T_CENTRAL }, createdAt: at }),
      event({ id: 'a', kind: 'assigned', ...hana, payload: { slot: 'primary', accountId: ALINA }, createdAt: later(1) }),
      event({ id: 'mv', kind: 'moved_team', ...hana, payload: { followsPrimary: true, fromTeamId: T_CENTRAL, toTeamId: T_BIRTHDAYS }, createdAt: later(1) }),
    ];
    const items = timeline([], run, true, ctx);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'group',
      summary: 'Auto-moved from Reception · Central → Birthdays & Events (follows primary owner) · 2 more',
    });
  });

  it('breaks a run at a message, at another actor, at a gap, and never swallows an ai_silent pill', () => {
    const auto = [
      event({ id: 'ro', kind: 'routed', actorKind: 'system', payload: { teamId: T_CENTRAL }, createdAt: at }),
      event({ id: 'a1', kind: 'assigned', actorKind: 'system', payload: { slot: 'primary', teamId: T_CENTRAL }, createdAt: at }),
    ];
    // A message between two pills: two single pills.
    const split = timeline([msg('m1', later(1))], [auto[0]!, { ...auto[1]!, createdAt: later(2) }], true, ctx);
    expect(split.map((i) => i.kind)).toEqual(['pill', 'message', 'pill']);
    // The same actor within the gap: one group; a person's pill after the router's: apart.
    const byHana = event({ id: 'h1', kind: 'handled', actorKind: 'account', actorAccountId: GM, createdAt: later(2) });
    expect(timeline([], [...auto, byHana], true, ctx).map((i) => i.kind)).toEqual(['group', 'pill']);
    // A gap longer than the moment: apart.
    expect(timeline([], [auto[0]!, { ...auto[1]!, createdAt: later(61) }], true, ctx).map((i) => i.kind)).toEqual(['pill', 'pill']);
    expect(timeline([], [auto[0]!, { ...auto[1]!, createdAt: later(60) }], true, ctx).map((i) => i.kind)).toEqual(['group']);
    // An ai_silent pill keeps its correction control in view: never grouped.
    const silent = event({ id: 's', kind: 'ai_silent', actorKind: 'ai', payload: { turnId: 't' }, createdAt: at });
    const classified = event({ id: 'c', kind: 'classified', actorKind: 'ai', payload: { turnId: 't', intent: 'hours' }, createdAt: at });
    expect(timeline([], [classified, silent], true, ctx).map((i) => i.kind)).toEqual(['pill', 'pill']);
  });
});

describe('a message’s attachments (customer-AI test night, W7)', () => {
  it('names the brochure from the assistant’s events', () => {
    const names = attachmentNames([
      event({ kind: 'ai_handover', actorKind: 'ai', payload: { brochureFileIds: ['f1', 'f2'] } }),
      event({ id: 'e2', kind: 'ai_replied', actorKind: 'ai', payload: { brochureFileIds: [] } }),
      event({ id: 'e3', kind: 'routed', payload: { brochureFileIds: ['not-this'] } }),
    ]);
    expect([...names.entries()]).toEqual([
      ['f1', 'Birthday brochure'],
      ['f2', 'Birthday brochure'],
    ]);
  });

  it('lists the row’s file ids, named where known, and reads the api’s media entries optionally', () => {
    const base = { mediaFileIds: ['f1', 'f2'], audioFileId: 'a1' };
    expect(attachmentsOf(base, new Map([['f1', 'Birthday brochure']]))).toEqual([
      { fileId: 'f1', name: 'Birthday brochure', url: null, contentType: null },
      { fileId: 'f2', name: null, url: null, contentType: null },
      { fileId: 'a1', name: null, url: null, contentType: null },
    ]);
    const withMedia = {
      ...base,
      media: [
        { fileId: 'f1', name: 'brochure.pdf', url: 'https://files.example/b.pdf', contentType: 'application/pdf' },
        { id: 'f9', name: 'photo.jpg', contentType: 'image/jpeg' },
        'nonsense',
      ],
    };
    expect(attachmentsOf(withMedia, new Map([['f1', 'Birthday brochure']]))).toEqual([
      { fileId: 'f1', name: 'brochure.pdf', url: 'https://files.example/b.pdf', contentType: 'application/pdf' },
      { fileId: 'f2', name: null, url: null, contentType: null },
      { fileId: 'a1', name: null, url: null, contentType: null },
      { fileId: 'f9', name: 'photo.jpg', url: null, contentType: 'image/jpeg' },
    ]);
    expect(attachmentsOf({ mediaFileIds: [], audioFileId: null })).toEqual([]);
  });
});

describe('the landing tab (test night U8)', () => {
  it('opens an agent on My Inbox when they hold a thread, else on the default', () => {
    expect(landingTab(['mine', 'team', 'handled'], 3)).toBe('mine');
    expect(landingTab(['mine', 'team', 'handled'], 0)).toBe('team');
    expect(landingTab(['mine', 'team', 'handled'], undefined)).toBe('team');
    expect(landingTab(['team', 'handled'], 3)).toBe('team');
  });
});

describe('what an action did, in a line (test night U6, U9)', () => {
  const people = { people: me.people };
  const before = [{ assignmentId: 'as-1' }];
  it('names the branch step’s host, or why there is none, from the api’s answer', () => {
    expect(branchOutcome({ hostAdded: false, hostSkipped: 'no_host' }, before, people)).toBe('No host for this branch');
    expect(branchOutcome({ hostAdded: false, hostSkipped: 'host_inactive' }, before, people)).toBe('The host is inactive');
    expect(branchOutcome({ hostAdded: false, hostSkipped: 'already_on' }, before, people)).toBe('Already on the thread');
    expect(branchOutcome({ hostAdded: false, hostSkipped: 'support_full' }, before, people)).toBe('Support is full');
    expect(branchOutcome({ hostAdded: true, host: { accountId: GM, name: 'Hanna' } }, before, people)).toBe('Host added: Hanna');
    expect(branchOutcome({ hostAdded: true, host: { accountId: GM, name: null } }, before, people)).toBe('Host added: Hanna');
    // Before the api lane lands: the new support place in the answer, by the people list.
    expect(
      branchOutcome(
        {
          hostAdded: true,
          assignments: [
            { assignmentId: 'as-1', slot: 'primary', accountId: ALINA, reason: 'auto' },
            { assignmentId: 'as-9', slot: 'support', accountId: GM, reason: 'auto' },
          ],
        },
        before,
        people,
      ),
    ).toBe('Host added: Hanna');
    expect(branchOutcome({ hostAdded: true }, before, people)).toBe('Host added');
    expect(branchOutcome({ hostAdded: false }, before, people)).toBeNull();
    expect(branchOutcome({}, before, people)).toBeNull();
  });
  it('names who a move seated', () => {
    expect(
      moveOutcome(
        {
          assignments: [
            { slot: 'primary', assigneeKind: 'account', accountId: ALINA, teamId: null },
            { slot: 'support', assigneeKind: 'account', accountId: GM, teamId: null },
          ],
        },
        me,
      ),
    ).toBe('Now with Alina as primary · Hanna added as support');
    expect(moveOutcome({ assignments: [{ slot: 'primary', assigneeKind: 'team', accountId: null, teamId: T_CENTRAL }] }, me)).toBe(
      'Now with Reception · Central as primary',
    );
    expect(moveOutcome({ assignments: [] }, me)).toBeNull();
    expect(moveOutcome({}, me)).toBeNull();
  });
});

describe('the templates offered to a reply (test night U1)', () => {
  const t = (key: string, language: string) => ({ id: `${key}-${language}`, key, language });
  const list = [t('handover_birthday', 'en'), t('handover_events', 'ru'), t('follow_up', 'ru'), t('follow_up', 'en'), t('handover_general', 'th')];
  it('puts the conversation’s language first with follow_up at the top, the rest under other languages', () => {
    const { own, others } = offeredTemplates(list, 'ru');
    expect(own.map((x) => x.id)).toEqual(['follow_up-ru', 'handover_events-ru']);
    expect(others.map((x) => x.id)).toEqual(['follow_up-en', 'handover_birthday-en', 'handover_general-th']);
  });
  it('offers everything as own when the language is unknown', () => {
    const { own, others } = offeredTemplates(list, null);
    expect(own[0]!.key).toBe('follow_up');
    expect(own).toHaveLength(5);
    expect(others).toEqual([]);
  });
  it('reads needsTranslation optionally, and says it in one way everywhere', () => {
    expect(needsTranslation({ needsTranslation: true })).toBe(true);
    expect(needsTranslation({ needsTranslation: 'yes' })).toBe(false);
    expect(needsTranslation({})).toBe(false);
    expect(TRANSLATION_PENDING).toBe('English text — not translated yet');
  });
});

describe('time, on the parks’ day', () => {
  // 2026-10-20 10:00 in Bangkok.
  const now = new Date('2026-10-20T03:00:00.000Z');
  it('stamps a row by the clock today, then yesterday, a weekday, a date', () => {
    expect(listTime('2026-10-20T01:05:00.000Z', now)).toBe('08:05');
    expect(listTime('2026-10-19T10:00:00.000Z', now)).toBe('Yesterday');
    expect(listTime('2026-10-16T10:00:00.000Z', now)).toBe('Fri');
    expect(listTime('2026-10-01T10:00:00.000Z', now)).toBe('1 Oct');
    expect(listTime(null, now)).toBe('');
  });
  it('counts the day in Bangkok, not UTC', () => {
    // 18:30 UTC on the 19th is 01:30 on the 20th in Bangkok: today.
    expect(listTime('2026-10-19T18:30:00.000Z', now)).toBe('01:30');
  });
  it('stamps a bubble with its date when it is not today', () => {
    expect(bubbleTime('2026-10-20T02:02:00.000Z', now)).toBe('09:02');
    expect(bubbleTime('2026-10-12T11:02:00.000Z', now)).toBe('12 Oct 18:02');
  });
  it('writes the average response as the card does', () => {
    expect(durationLabel(252)).toBe('4m 12s');
    expect(durationLabel(42)).toBe('42s');
    expect(durationLabel(3900)).toBe('1h 05m');
    expect(durationLabel(null)).toBe('—');
  });
  it('turns the archive range into handledFrom', () => {
    expect(archiveFrom('7d', now)).toBe('2026-10-13T03:00:00.000Z');
    expect(archiveFrom('all', now)).toBeUndefined();
  });
});

describe('the list query', () => {
  const now = new Date('2026-10-20T03:00:00.000Z');
  it('sends only the filters that are set', () => {
    expect(listQuery('team', EMPTY_FILTERS, { now })).toEqual({ tab: 'team' });
    expect(
      listQuery('mine', { ...EMPTY_FILTERS, category: 'birthdays', language: 'ru', q: '  olga ', unanswered: true }, { now }),
    ).toEqual({ tab: 'mine', category: 'birthdays', language: 'ru', q: 'olga', unanswered: 'true' });
  });
  it('applies the archive range and resolver on Handled only', () => {
    const f = { ...EMPTY_FILTERS, archiveRange: '7d' as const, resolvedBy: 'ai' as const };
    expect(listQuery('team', f, { now })).toEqual({ tab: 'team' });
    expect(listQuery('handled', f, { now, cursor: 'c1', limit: 50 })).toEqual({
      tab: 'handled',
      handledFrom: '2026-10-13T03:00:00.000Z',
      resolvedBy: 'ai',
      cursor: 'c1',
      limit: 50,
    });
  });
  it('counts the rail’s filters for the phone’s button', () => {
    expect(activeFilterCount({ ...EMPTY_FILTERS, branchId: CENTRAL, status: 'active', q: 'x' })).toBe(2);
  });
});

describe('the timeline', () => {
  const ctx = { me };
  it('words the pills as the prototype does', () => {
    expect(eventText(event({ payload: { teamId: T_BIRTHDAYS, language: 'ru' } }), ctx)).toBe(
      'Language: RU · Routed to Birthdays & Events',
    );
    expect(eventText(event({ kind: 'assigned', payload: { slot: 'primary', accountId: ALINA } }), ctx)).toBe(
      'Assigned Alina as primary',
    );
    expect(
      eventText(event({ kind: 'assigned', actorKind: 'account', actorAccountId: GM, payload: { slot: 'support', accountId: ALINA } }), ctx),
    ).toBe('Hanna added Alina as support');
    expect(eventText(event({ kind: 'handled', actorKind: 'account', actorName: 'Alina' }), ctx)).toBe('Marked as Handled by Alina');
    expect(eventText(event({ kind: 'reopened', actorKind: 'customer', payload: { automatic: true } }), ctx)).toBe(
      'Reopened · the customer wrote again',
    );
    // I3b: the cross-team primary's pill (:1158), and a reply the channel refused.
    expect(
      eventText(
        event({
          kind: 'moved_team',
          actorKind: 'account',
          actorName: 'Alina',
          payload: { followsPrimary: true, fromTeamId: T_CENTRAL, toTeamId: T_BIRTHDAYS },
        }),
        ctx,
      ),
    ).toBe('Auto-moved from Reception · Central → Birthdays & Events (follows primary owner)');
    expect(
      eventText(event({ kind: 'diverted', actorKind: 'account', actorName: 'Alina', payload: { toAccountId: GM } }), ctx),
    ).toBe('Diverted to Hanna by Alina');
    // Its seat changes are not said twice.
    expect(eventText(event({ kind: 'released', payload: { slot: 'primary', accountId: ALINA, reason: 'divert' } }), ctx)).toBeNull();
    expect(eventText(event({ kind: 'assigned', payload: { slot: 'primary', accountId: GM, reason: 'divert' } }), ctx)).toBeNull();
    expect(eventText(event({ kind: 'send_failed', payload: { refusal: 'INVALID_RECIPIENT' } }), ctx)).toBe(
      'Reply not sent · INVALID_RECIPIENT',
    );
  });
  it('names the branch a "Branch set" pill set, and the pause and its undo (test night U5, U9)', () => {
    const hana = { kind: 'branch_set' as const, actorKind: 'account' as const, actorName: 'Hanna' };
    // Today's payload names the branch by id; the api lane's `after.branchName` wins when it is there.
    expect(eventText(event({ ...hana, payload: { fromBranchId: null, toBranchId: CENTRAL } }), ctx)).toBe('Branch set to Central by Hanna');
    expect(
      eventText(event({ ...hana, payload: { fromBranchId: null, toBranchId: CENTRAL, after: { branchName: 'Central Floresta' } } }), ctx),
    ).toBe('Branch set to Central Floresta by Hanna');
    expect(eventText(event({ ...hana, payload: { fromBranchId: CENTRAL, toBranchId: null } }), ctx)).toBe(
      'Branch set to all branches by Hanna',
    );
    expect(eventText(event({ ...hana, payload: {} }), ctx)).toBe('Branch set by Hanna');
    // The api's kinds are the enum's underscore form; a pause says what it withdrew.
    expect(eventText(event({ kind: 'ai_paused', actorKind: 'account', actorName: 'Hanna', payload: { turnsCancelled: 0, messagesWithdrawn: 0 } }), ctx)).toBe(
      'AI paused by Hanna',
    );
    expect(eventText(event({ kind: 'ai_paused', actorKind: 'account', actorName: 'Hanna', payload: { turnsCancelled: 1, messagesWithdrawn: 2 } }), ctx)).toBe(
      'AI paused by Hanna · 2 lines withdrawn',
    );
    expect(eventText(event({ kind: 'ai_paused', actorKind: 'account', actorName: 'Hanna', payload: { messagesWithdrawn: 1 } }), ctx)).toBe(
      'AI paused by Hanna · 1 line withdrawn',
    );
    expect(eventText(event({ kind: 'ai_resumed', actorKind: 'account', actorAccountId: GM, payload: {} }), ctx)).toBe('AI resumed by Hanna');
  });
  it('leaves out the events a bubble already shows', () => {
    expect(eventText(event({ kind: 'received' }), ctx)).toBeNull();
    expect(eventText(event({ kind: 'ai_replied' }), ctx)).toBeNull();
  });
  it('interleaves pills and messages by time, a pill after its message on a tie', () => {
    const items = timeline(
      [msg('m1', '2026-10-20T03:00:00.000Z'), msg('m2', '2026-10-20T03:05:00.000Z')],
      [event({ id: 'e1', createdAt: '2026-10-20T03:00:00.000Z', payload: { teamId: T_BIRTHDAYS } })],
      true,
      ctx,
    );
    expect(items.map((i) => (i.kind === 'message' ? i.message.id : i.id))).toEqual(['m1', 'e1', 'm2']);
  });
  it('holds back pills older than the loaded page until it reaches the start', () => {
    const messages = [msg('m9', '2026-10-20T05:00:00.000Z')];
    const events = [event({ id: 'old', createdAt: '2026-10-20T03:00:00.000Z', payload: { teamId: T_BIRTHDAYS } })];
    expect(timeline(messages, events, false, ctx).map((i) => i.kind)).toEqual(['message']);
    expect(timeline(messages, events, true, ctx).map((i) => i.kind)).toEqual(['pill', 'message']);
  });
});

describe('sign-on (plan §4.2)', () => {
  it('reads the hand-off token out of the fragment', () => {
    expect(readHandoffToken('#handoff=abc.def.ghi')).toBe('abc.def.ghi');
    expect(readHandoffToken('#x=1&handoff=a%2Eb')).toBe('a.b');
    expect(readHandoffToken('#other=1')).toBeNull();
    expect(readHandoffToken('')).toBeNull();
  });
  it('words a refusal as the Console does', () => {
    expect(handoffRefusal(new ApiError(401, 'HANDOFF_EXPIRED', 'x'))).toBe(HANDOFF_REFUSALS.expired);
    expect(handoffRefusal(new ApiError(401, 'HANDOFF_INVALID', 'x', { reason: 'replayed' }))).toBe(HANDOFF_REFUSALS.replayed);
    expect(handoffRefusal(new Error('offline'))).toBe(HANDOFF_FALLBACK);
  });
  it('reads where the session stands off one refused /inbox/me', () => {
    expect(stateForRefusal(new ApiError(401, 'UNAUTHENTICATED', 'x'))).toBe('signed-out');
    expect(stateForRefusal(new ApiError(423, 'SESSION_LOCKED', 'x'))).toBe('locked');
    expect(stateForRefusal(new ApiError(403, 'MUST_CHANGE_PASSWORD', 'x'))).toBe('must-change-password');
    expect(stateForRefusal(new ApiError(403, 'FORBIDDEN', 'x'))).toBe('no-access');
  });
  it('opens on Team, as the prototype does, when the viewer has it', () => {
    expect(defaultTab(['mine', 'team', 'handled'])).toBe('team');
    expect(defaultTab(['handled'])).toBe('handled');
  });
});
