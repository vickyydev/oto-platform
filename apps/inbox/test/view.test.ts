import { describe, expect, it } from 'vitest';
import type { Assignee, InboxEvent, InboxMe, Message } from '@/api/inbox';
import { ApiError } from '@/api/client';
import { HANDOFF_FALLBACK, HANDOFF_REFUSALS, handoffRefusal, readHandoffToken } from '@/auth/handoff';
import { stateForRefusal } from '@/auth/SessionContext';
import { EMPTY_FILTERS, activeFilterCount, listQuery } from '@/lib/query';
import {
  archiveFrom,
  assigneeChip,
  branchLabel,
  branchOptions,
  bubbleTime,
  canHandle,
  defaultTab,
  durationLabel,
  eventText,
  initialsOf,
  listTime,
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
