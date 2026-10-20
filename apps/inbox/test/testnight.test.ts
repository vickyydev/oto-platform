// The Inbox after the staff test night of 21 October 2026 (SCRUM-220
// follow-ups; docs/qa/test-night-2026-10-21/inbox-staff/REPORT.md): the
// findings that are markup, pinned. Node, no DOM — the panel, the dialog and
// the confirmations are rendered to markup with react-dom/server, so what is
// pinned is what the page would say, not how it was wired.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Assignee, ConversationDetail, ConversationRow, Dashboard as DashboardData, InboxMe } from '@/api/inbox';
import { TranslationNote } from '@/components/atoms';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { PrimaryMoveConfirm, TeamMoveConfirm } from '@/components/confirms';
import { Dashboard } from '@/components/Dashboard';
import { DetailsDialog, MANAGERS_ADD_SUPPORT, type DetailsActions } from '@/components/dialogs';
import { FilterFields } from '@/components/Rail';
import { EMPTY_FILTERS } from '@/lib/query';
import { SHADOW_LABEL, SUPPORT_FULL_HINT, TRANSLATION_PENDING } from '@/lib/view';

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

describe('the assistant’s state on a thread (U5)', () => {
  const r = row();
  it('says the assistant is off on the number, with no pause control', () => {
    const html = panel(anya, r, detail(r, { aiMode: 'off' }));
    expect(html).toContain('Assistant off on this number');
    expect(html).not.toContain('AI on · Pause');
    expect(html).not.toContain('aria-pressed');
  });
  it('says shadow as a label, and live as the pause control', () => {
    expect(panel(anya, r, detail(r, { aiMode: 'shadow' }))).toContain('Assistant in shadow');
    const live = panel(anya, r, detail(r, { aiMode: 'live' }));
    expect(live).toContain('AI on · Pause');
    expect(live).toContain('aria-pressed="false"');
    expect(panel(anya, r, detail(r, { aiMode: 'live', aiPaused: true }))).toContain('AI paused · Resume');
  });
  it('says nothing until the detail — the number’s mode — is in', () => {
    const html = panel(anya, r, null);
    expect(html).not.toContain('AI on · Pause');
    expect(html).not.toContain('Assistant off');
  });

  it('says the api’s thread state when it is there (customer-AI test night, W4a), with the control it needs', () => {
    const live = (aiState: string) => panel(anya, r, { ...detail(r, { aiMode: 'live' }), aiState } as ConversationDetail);
    expect(live('ready')).toMatch(/data-ai-action="pause"[^>]*>.*AI on · Pause/);
    expect(live('paused')).toMatch(/data-ai-action="resume"[^>]*>.*AI paused · Resume/);
    expect(live('left_for_team')).toMatch(/data-ai-action="resume"[^>]*>.*AI handed over · Resume/);
    expect(live('person_replied')).toMatch(/data-ai-action="resume"[^>]*>.*AI stopped: a person replied · Resume/);
    expect(live('shadow')).toContain('Assistant in shadow');
    expect(live('shadow')).not.toContain('aria-pressed');
    expect(live('off')).toContain('Assistant off on this number');
    expect(live('off')).not.toContain('AI on · Pause');
  });
});

describe('shadow suggestions (customer-AI test night, W5)', () => {
  it('renders what the assistant would have said as a muted, staff-only bubble under the AI chip', () => {
    const r = row();
    const d = detail(r, {
      aiMode: 'shadow',
      events: [
        {
          id: 'sh-1',
          kind: 'ai.shadow',
          actorKind: 'ai',
          actorAccountId: null,
          actorName: null,
          payload: { text: 'Yes, there are free lockers at reception.', turnId: 'turn-9' },
          createdAt: '2026-10-21T02:00:00.000Z',
        },
      ],
    });
    const html = panel(anya, r, d);
    expect(html).toContain('data-shadow="true"');
    expect(html).toContain(SHADOW_LABEL);
    expect(html).toContain('Yes, there are free lockers at reception.');
    expect(html).toContain('AI Assistant');
    expect(html).toContain('border-dashed');
    // Never a pill, never a sent bubble.
    expect(html).not.toContain('ai.shadow');
    expect(html).not.toContain('bg-indigo-50 text-indigo-900');
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
  it('labels a Facebook id in the header and the details', () => {
    expect(panel(anya, r, detail(r))).toContain('Facebook ID 939562181554109');
    expect(panel(anya, r, detail(r), true)).toContain('>Facebook ID</dt>');
  });
  it('shows the desk’s park, not "All branches", on a reception thread with no branch of its own', () => {
    const html = panel(hana, r, detail(r));
    expect(html).toContain('aria-label="Conversation branch"');
    expect(html).toMatch(new RegExp(`<option value="${CENTRAL}" selected="">Central Floresta</option>`));
    // The agent's read-only strip and the details say the same park.
    expect(panel(anya, r, detail(r))).toContain('Central Floresta');
    expect(panel(anya, r, detail(r), true)).toMatch(/>Branch<\/dt><dd[^>]*>Central Floresta</);
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
      byCategory: { birthdays: 0, general: 0, marketing: 0 },
    };
    const card = (d: DashboardData) =>
      renderToStaticMarkup(createElement(Dashboard, { data: d, error: null, unansweredOnly: false, onToggleUnanswered: noop }));
    expect(card({ ...data, scope: 'mine' } as DashboardData)).toContain('your average');
    expect(card(data)).not.toContain('average</span>');
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
  const r = row();
  const actions: DetailsActions = {
    moves: [
      { value: 'birthdays', label: 'Birthdays & Events', dest: { kind: 'birthdays' } },
      { value: `reception:${CENTRAL}`, label: 'Reception · Central Floresta', dest: { kind: 'reception', branchId: CENTRAL } },
    ],
    currentMove: `reception:${CENTRAL}`,
    canMove: true,
    onMove: noop,
    status: 'active',
    canHandle: true,
    canReopen: false,
    onHandle: noop,
    onReopen: noop,
    busy: false,
  };
  const dialog = (me: InboxMe, a: DetailsActions | undefined) =>
    renderToStaticMarkup(
      createElement(DetailsDialog, { open: true, onClose: noop, row: r, detail: detail(r), me, now: new Date(), actions: a }),
    );
  it('carries both controls in the details, shown only where the header hides them', () => {
    const html = dialog(hana, actions);
    expect(html).toMatch(/data-phone-actions="true"[^>]*>/);
    expect(html).toMatch(/class="[^"]*md:hidden[^"]*" data-phone-actions="true"/);
    expect(html).toContain('aria-label="Move to team"');
    expect(html).toContain('aria-label="Set conversation status"');
  });
  it('carries nothing for someone without the rights', () => {
    const html = dialog(anya, { ...actions, canMove: false, canHandle: false, canReopen: false });
    expect(html).not.toContain('data-phone-actions');
    expect(dialog(anya, undefined)).not.toContain('data-phone-actions');
  });
  it('the panel hands the dialog the controls the viewer holds: both for the GM, the status only for the primary', () => {
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
  it('names the filter apart from the strip’s select', () => {
    const html = renderToStaticMarkup(createElement(FilterFields, { me: hana, filters: EMPTY_FILTERS, onChange: noop }));
    expect(html).toContain('aria-label="Filter by branch"');
    expect(html).not.toContain('aria-label="Branch"');
  });
});
