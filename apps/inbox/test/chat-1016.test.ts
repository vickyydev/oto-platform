// SCRUM-1016 — the chat in the OTO look (Chat.dc.html, ChatActions.dc.html,
// ChatPaid.dc.html, Desktop.dc.html), rendered to markup as the test-night
// file renders it: the reply box is the chat's fixed footer, never inside the
// part that scrolls; the header holds the way back, the name, where the chat
// came from, Mark as handled and one menu; and People and actions — the
// sheet below the desktop's width, the panel beside the chat on a desktop —
// holds every control the assignment strip and the details dialog held.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Assignee, ConversationDetail, ConversationRow, InboxMe } from '@/api/inbox';
import { ActionFeedback } from '@/components/ChatActions';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { SUPPORT_FULL_HINT } from '@/lib/view';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000c1';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const GM = '00000000-0000-7000-8000-00000000009a';
const ANYA = '00000000-0000-7000-8000-0000000000a1';
const VERA = '00000000-0000-7000-8000-0000000000a2';
const LINE = '0192f0a0-1234-7abc-8def-0000000000d1';
const noop = () => undefined;

function viewer(o: { assign?: boolean; move?: boolean; reopen?: boolean; writes?: boolean; accountId?: string; testLine?: boolean } = {}): InboxMe {
  return {
    accountId: o.accountId ?? GM,
    name: 'ZZ TEST manager',
    roles: ['owner'],
    tabs: ['mine', 'team', 'handled'],
    teams: [
      { id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: false },
      { id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: o.assign === false },
    ],
    people: [
      { accountId: ANYA, name: 'ZZ TEST Anya', teamIds: [T_BIRTHDAYS], operatorWide: false },
      { accountId: VERA, name: 'ZZ TEST Vera', teamIds: [T_BIRTHDAYS], operatorWide: false },
    ],
    defaultReceptionBranchId: CENTRAL,
    capabilities: {
      writes: o.writes ?? true,
      dashboard: true,
      assign: o.assign ?? true,
      move: o.move ?? true,
      reopen: o.reopen ?? true,
      templates: true,
      kb: false,
      ai: false,
    },
    simulator: null,
    testLines: o.testLine ? [{ id: LINE, channel: 'whatsapp', displayName: 'ZZ TEST line', branchId: null, startOver: true }] : [],
  } as InboxMe;
}

function seat(id: string, slot: 'primary' | 'support', slotIndex: number, accountId: string, name: string): Assignee {
  return { assignmentId: id, slot, slotIndex, assigneeKind: 'account', accountId, teamId: null, name, reason: 'manual', assignedAt: '2026-11-19T04:00:00.000Z' } as Assignee;
}

function row(over: Partial<ConversationRow> = {}): ConversationRow {
  return {
    id: '0192f0a0-1234-7abc-8def-0000000000e1',
    channel: 'whatsapp',
    channelAccountId: LINE,
    channelAccountName: 'ZZ TEST line',
    canReply: true,
    contact: { id: '0192f0a0-1234-7abc-8def-0000000000f1', channel: 'whatsapp', handle: '66900000009', displayName: 'ZZ TEST Sarah', phone: null, language: 'en', erased: false },
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
    unread: 0,
    mine: true,
    assignments: [seat('as-p', 'primary', 0, ANYA, 'ZZ TEST Anya'), seat('as-s1', 'support', 1, VERA, 'ZZ TEST Vera')],
    createdAt: '2026-11-19T04:00:00.000Z',
    ...over,
  };
}

function detail(r: ConversationRow, over: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    ...r,
    teamName: 'Birthdays & Events',
    firstResponseAt: '2026-11-19T04:01:00.000Z',
    reopenedAt: null,
    member: { id: '0192f0a0-1234-7abc-8def-0000000000a9', name: 'ZZ TEST Sarah', childCount: 2 },
    events: [],
    divertTo: { accountId: VERA, name: 'ZZ TEST Vera' },
    aiMode: 'live',
    aiPaused: false,
    aiPausedAt: null,
    aiPausedByAccountId: null,
    aiState: 'left_for_team',
    event: null,
    ...over,
  } as ConversationDetail;
}

function panel(me: InboxMe, r: ConversationRow, d: ConversationDetail | null, detailsOpen = false): string {
  const thread: Thread = { detail: d, messages: [], olderCursor: null, loading: false, loadingOlder: false, error: null };
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      row: r, thread, me, now: new Date('2026-11-19T06:00:00.000Z'), inserted: null, detailsOpen,
      onBack: noop, onLoadOlder: noop, onOpenDetails: noop, onCloseDetails: noop, onOpenTemplates: noop,
      onAskHandle: noop, onChanged: async () => undefined,
    }),
  );
}

/** The sheet's markup: everything from the dialog on. */
const sheetOf = (html: string) => html.slice(html.indexOf('role="dialog"'));
/** The desktop panel's markup. */
const panelOf = (html: string) => {
  const at = html.indexOf('data-region="customer-panel"');
  return html.slice(at, html.indexOf('</aside>', at));
};

describe('SCRUM-1016: the reply box is the chat’s fixed footer', () => {
  const r = row();
  const html = panel(viewer(), r, detail(r));

  it('renders the box for an open chat, after the thread and outside the part that scrolls', () => {
    const scroller = html.indexOf('overflow-y-auto overflow-x-hidden bg-ground');
    const box = html.indexOf('aria-label="Reply"');
    expect(scroller).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(scroller);
    // The thread is the one part that grows and scrolls; the composer does not shrink away under it.
    expect(html).toMatch(/class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-ground[^"]*"/);
    expect(html).toMatch(/<div class="shrink-0 border-t border-line bg-card[^"]*"><form/);
    // The chat is a column the full height of its place, on a phone too (no width variant on it).
    expect(html).toMatch(/^<div class="flex min-h-0 min-w-0 flex-1"><div class="flex min-h-0 min-w-0 flex-1 flex-col">/);
  });

  it('a phone gets the way back in the header; from 768 px the list stands beside the chat', () => {
    expect(html).toMatch(/aria-label="Back to the conversations" class="[^"]*md:hidden[^"]*"/);
  });

  it('carries Templates, the microphone, the growing box and Send — and no emoji or attach button', () => {
    expect(html).toContain('aria-label="Templates"');
    // The microphone needs a browser that records; dictation.test.ts drives it in a DOM.
    expect(html).toContain('placeholder="Reply to ZZ TEST Sarah"');
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain('Emoji');
    expect(html).not.toContain('Attach a file');
    expect(html).not.toContain('Not in this build yet');
  });

  it('a handled thread and a till notice keep their footer in place of the box', () => {
    const handled = row({ status: 'handled', handledAt: '2026-11-19T05:30:00.000Z' });
    expect(panel(viewer(), handled, detail(handled))).toContain('Handled — composer disabled');
    const notice = row({ canReply: false });
    expect(panel(viewer(), notice, detail(notice))).toContain('Notices from the till — this thread cannot take a reply.');
  });
});

describe('SCRUM-1016: the chat’s header and the assistant’s line', () => {
  const r = row();
  const html = panel(viewer(), r, detail(r));

  it('names the contact, then the number it came in on, the topic and the park', () => {
    expect(html).toContain('>ZZ TEST Sarah</h2>');
    expect(html).toContain('<span title="WhatsApp">ZZ TEST line</span> · Birthdays · Central Floresta</p>');
  });

  it('holds Mark as handled and one menu, People and actions, which steps aside where the panel shows', () => {
    expect(html).toMatch(/aria-label="Mark as handled"/);
    expect(html).toMatch(/aria-label="People and actions"[^>]*class="[^"]*xl:hidden/);
    expect(html).not.toContain('aria-label="Conversation details"');
  });

  it('beside the simulator’s panel, the chat’s panel and its menu move to 1760 px', () => {
    const thread: Thread = { detail: detail(r), messages: [], olderCursor: null, loading: false, loadingOlder: false, error: null };
    const wide = renderToStaticMarkup(
      createElement(ChatPanel, {
        row: r, thread, me: viewer(), now: new Date('2026-11-19T06:00:00.000Z'), inserted: null, detailsOpen: false,
        onBack: noop, onLoadOlder: noop, onOpenDetails: noop, onCloseDetails: noop, onOpenTemplates: noop,
        onAskHandle: noop, onChanged: async () => undefined, panelWide: true,
      }),
    );
    expect(wide).toMatch(/data-region="customer-panel" class="[^"]*min-\[1760px\]:flex/);
    expect(wide).toMatch(/aria-label="People and actions"[^>]*class="[^"]*min-\[1760px\]:hidden/);
  });

  it('says the assistant’s state in one line, with Resume, and who is on the chat', () => {
    expect(html).toContain('<strong class="font-bold">Assistant handed over</strong> · it will stay quiet');
    expect(html).toMatch(/data-ai-action="resume"[^>]*>Resume<\/button>/);
    expect(html).toContain('aria-label="Primary: ZZ TEST Anya. Support: ZZ TEST Vera"');
  });

  it('wears only the OTO tokens: no raw palette class and no dark variant of its own', () => {
    const booked = row();
    const all = panel(viewer(), booked, detail(booked), true);
    expect(all).not.toMatch(/(?:^|[\s"'])(?:[a-z-]+:)*(?:bg|text|border|ring|decoration)-(?:slate|indigo|violet|amber|emerald|rose|teal|sky|pink|blue|orange)-\d+/);
    expect(all).not.toMatch(/(?:^|[\s"'])(?:[a-z-]+:)*(?:bg|border|ring)-white\b/);
    expect(all).not.toMatch(/[\s"]dark:/);
  });
});

describe('SCRUM-1016: People and actions holds every control', () => {
  const r = row();
  const d = detail(r);
  const gm = viewer({ testLine: true });
  const html = panel(gm, r, d, true);

  it.each([
    ['the sheet', sheetOf],
    ['the desktop panel', panelOf],
  ] as const)('%s: the people, with change, add, remove and divert', (_, part) => {
    const p = part(html);
    expect(p).toContain('ZZ TEST Anya');
    expect(p).toContain('Primary · answers this chat');
    expect(p).toContain('aria-label="Set primary"');
    expect(p).toContain('Support · 1 of 2');
    expect(p).toContain('aria-label="Remove support: ZZ TEST Vera"');
    expect(p.match(/aria-label="Set support"/g)).toHaveLength(2); // change Vera, add a second
    expect(p).toContain('aria-label="Divert to ZZ TEST Vera"');
  });

  it.each([
    ['the sheet', sheetOf],
    ['the desktop panel', panelOf],
  ] as const)('%s: the team and the park to change; the status said', (_, part) => {
    const p = part(html);
    expect(p).toContain('aria-label="Move to team"');
    expect(p).toContain('aria-label="Conversation branch"');
    // SCRUM-1016 (review): the status is a read-out here. Mark as handled has
    // its homes in the chat's header and the sheet's footer, Reopen in the
    // composer; the "Set conversation status" select offered both a third time.
    expect(p).toMatch(/>Status<\/span><span[^>]*><span data-status="active">Active<\/span>/);
    expect(p).not.toContain('aria-label="Set conversation status"');
    expect(p).toContain('title="Topic: Birthdays &amp; Events — what the conversation is about. Team: Birthdays &amp; Events — who handles it."');
  });

  it('the assistant: a row of the sheet, which covers the chat on a phone; beside the desktop panel, the chat’s own line', () => {
    // SCRUM-1016 (review): Desktop.dc.html has no Assistant row in the panel,
    // and the line above the thread holds Pause or Resume on screen beside it.
    expect(sheetOf(html)).toMatch(/>Assistant<\/span>[^]*aria-label="Resume the assistant"/);
    expect(panelOf(html)).not.toContain('aria-label="Resume the assistant"');
    expect(panelOf(html)).not.toContain('>Assistant</span>');
    const chatOnly = html.slice(0, html.indexOf('data-region="customer-panel"'));
    expect(chatOnly).toMatch(/data-ai-action="resume"[^>]*aria-label="Resume the assistant"/);
  });

  it.each([
    ['the sheet', sheetOf],
    ['the desktop panel', panelOf],
  ] as const)('%s: the contact, the member link and the times; rename and Start over; Book the date and Create BEO', (_, part) => {
    const p = part(html);
    expect(p).toMatch(/>Member<\/dt><dd[^>]*>ZZ TEST Sarah · 2 children<\/dd>/);
    for (const k of ['Contact', 'Phone', 'Source', 'Channel', 'Language', 'Topic', 'Intent', 'Started', 'First reply', 'Handled', 'Reopened']) {
      expect(p).toContain(`>${k}</dt>`);
    }
    expect(p).toContain('aria-label="Edit name"');
    expect(p).toContain('aria-label="Start over"');
    expect(p).toMatch(/>(?:<svg[^]*?<\/svg>)?Book the date<\/button>/);
    expect(p).toMatch(/>(?:<svg[^]*?<\/svg>)?Create BEO<\/button>/);
  });

  it('the sheet is titled with the contact and ends with Mark as handled', () => {
    const sheet = sheetOf(html);
    expect(sheet).toContain('>ZZ TEST Sarah</h2>');
    expect(sheet).toContain('WhatsApp · EN · member');
    expect(sheet).toContain('aria-label="Close people and actions"');
    // Its footer, after the details: the one wide Mark as handled.
    expect(sheet.lastIndexOf('Mark as handled</span></button>')).toBeGreaterThan(sheet.indexOf('>Reopened</dt>'));
  });

  it('says "Support 2/2" with its reason once both places are taken', () => {
    const full = row({ assignments: [...r.assignments, seat('as-s2', 'support', 2, GM, 'ZZ TEST manager')] });
    const p = panelOf(panel(gm, full, detail(full)));
    expect(p).toContain('Support 2/2');
    expect(p).toContain(SUPPORT_FULL_HINT);
    expect(p.match(/aria-label="Set support"/g)).toHaveLength(2); // changing each, adding none
  });

  it('an agent who may not assign sees the people without pickers, and that managers add support', () => {
    const agent = viewer({ assign: false, move: false, reopen: false, accountId: ANYA });
    const p = panelOf(panel(agent, r, detail(r)));
    expect(p).toContain('ZZ TEST Anya');
    // As today, the primary may hand the chat on (“mayAssign”); the support places are a manager's.
    expect(p).toContain('aria-label="Set primary"');
    expect(p).not.toContain('aria-label="Set support"');
    // Someone off the chat, in no team on it and with no rights on it, gets neither.
    const off = viewer({ assign: false, move: false, reopen: false, accountId: GM });
    const outsider: InboxMe = { ...off, roles: ['staff'], teams: off.teams.map((t) => ({ ...t, member: false })) };
    const theirs = row({ mine: false });
    const bystanderChat = panel(outsider, theirs, detail(theirs));
    const bystander = panelOf(bystanderChat);
    expect(bystander).not.toContain('aria-label="Set primary"');
    // SCRUM-1016 (review): Mark as handled is the header's (the status row is a read-out); a bystander gets none.
    expect(bystanderChat).not.toContain('aria-label="Mark as handled"');
    expect(p).not.toContain('aria-label="Move to team"');
    expect(p).not.toContain('aria-label="Conversation branch"');
    expect(p).toContain('Managers add support');
    // She is the primary: she may still mark it handled, from the chat's header.
    expect(panel(agent, r, detail(r))).toContain('aria-label="Mark as handled"');
  });

  it('with writes not switched on, every control is there, disabled, with why', () => {
    const html = panel(viewer({ writes: false }), r, detail(r));
    const p = panelOf(html);
    expect(p).toContain('aria-label="Change the primary owner — Coming with the channel connection"');
    expect(p).toContain('aria-label="Move to another team — Coming with the channel connection"');
    expect(p).toContain('aria-label="Change the branch — Coming with the channel connection"');
    // SCRUM-1016 (review): Mark as handled is the chat header's, not the status row's.
    expect(html.slice(0, html.indexOf('data-region="customer-panel"'))).toContain('aria-label="Mark as handled — Coming with the channel connection"');
  });
});

describe('SCRUM-1016 (review): the desktop panel is laid out for its width', () => {
  // The review's pictures at 1440 px: the panel used the sheet's parts, and in
  // its 268 px a support name read "Z..", "Support · 1 of 2" broke a word a
  // line, the team read "Birthday…" and "Divert to …" took two lines.
  const r = row();
  const gm = viewer({ testLine: true });
  const html = panel(gm, r, detail(r), true);
  const p = panelOf(html);
  const sheet = sheetOf(html);

  it('a person’s action words sit on their own line under the name and the role', () => {
    expect(p.match(/data-person-row="stacked"/g)).toHaveLength(2);
    expect(p).toMatch(/title="Support · 1 of 2" class="truncate text-\[12.5px\] text-ink-muted">Support · 1 of 2<\/span><span class="-ml-3 mt-0.5 flex flex-wrap items-center">/);
    // The sheet, a phone's full width, keeps the words beside the name.
    expect(sheet).not.toContain('data-person-row');
  });

  it('Add support and Divert are a line each, never two words side by side', () => {
    expect(p).toContain('class="flex flex-col border-t border-line-soft empty:hidden');
    expect(p).not.toContain('grid-flow-col');
    expect(p).toMatch(/aria-label="Divert to ZZ TEST Vera" class="inline-flex min-h-12 w-full items-center gap-1.5 px-3.5 /);
    expect(sheet).toContain('grid auto-cols-fr grid-flow-col');
  });

  it('a row’s label sits over its value, and the value keeps its whole words', () => {
    for (const label of ['Team', 'Park', 'Status']) {
      expect(p, label).toContain(`<span class="flex min-w-0 flex-1 flex-col gap-0.5 py-1.5"><span class="text-[12.5px] text-ink-muted">${label}</span>`);
    }
    expect(p).not.toContain('w-20 shrink-0');
    expect(p).toContain('<span class="min-w-0 break-words">Central Floresta</span>');
    expect(p).not.toMatch(/<span class="truncate">(?:Central Floresta|Birthdays)/);
    // The sheet keeps its label column.
    expect(sheet).toContain('<span class="w-20 shrink-0 text-[13.5px] text-ink-muted">Team</span>');
  });

  it('the party’s Book the date and Create BEO stand one over the other', () => {
    const party = p.slice(p.indexOf('>Party</h3>'));
    expect(party).toMatch(/^>Party<\/h3><div class="flex flex-col gap-2"><div class="flex flex-col gap-2">/);
    expect(sheet.slice(sheet.indexOf('>Party</h3>'))).toMatch(/^>Party<\/h3><div class="flex flex-col gap-2"><div class="grid grid-cols-2 gap-2">/);
  });

  it('the sheet opens with the contact’s face before the name, as drawn', () => {
    expect(sheet).toMatch(/<div class="relative shrink-0"><div aria-hidden="true" class="[^"]*" style="width:44px;height:44px;[^"]*">ZS<\/div><span title="WhatsApp"[^>]*><\/span><\/div><div class="min-w-0 flex-1"><h2/);
  });
});

describe('SCRUM-1016 (review): the chat header on a tablet', () => {
  it('Mark as handled is an icon below 1024 px, so the name keeps its room', () => {
    const r = row();
    const html = panel(viewer(), r, detail(r));
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(header).toMatch(/aria-label="Mark as handled" title="Mark as handled" class="[^"]*lg:w-auto[^"]*"/);
    expect(header).toContain('<span class="hidden lg:inline">Mark as handled</span>');
    expect(header).not.toMatch(/md:(?:w-auto|inline|border|px-3\.5)/);
  });
});

describe('SCRUM-1016 (review): Reopen has one home, the composer', () => {
  it('a handled chat offers Reopen in the composer and only says its status in People and actions', () => {
    const handled = row({ status: 'handled', handledAt: '2026-11-19T05:30:00.000Z' });
    const html = panel(viewer(), handled, detail(handled), true);
    expect(html.match(/>Reopen<\/button>/g)).toHaveLength(1);
    expect(sheetOf(html)).toContain('<span data-status="handled">Handled</span>');
    expect(html).not.toContain('aria-label="Set conversation status"');
  });

  it('a handled thread of till notices, which has no reply box, is reopened from the composer too', () => {
    const notice = row({ canReply: false, status: 'handled', handledAt: '2026-11-19T05:30:00.000Z' });
    const html = panel(viewer(), notice, detail(notice));
    expect(html).toContain('Notices from the till — this thread cannot take a reply.');
    expect(html.match(/>Reopen<\/button>/g)).toHaveLength(1);
    // Someone without the reopen right gets the notice alone.
    expect(panel(viewer({ reopen: false }), notice, detail(notice))).not.toContain('>Reopen<');
    // With writes not switched on, it is there, disabled, with why.
    expect(panel(viewer({ writes: false }), notice, detail(notice))).toContain('aria-label="Reopen — Coming with the channel connection"');
  });
});

describe('SCRUM-1016: an action’s outcome stays in view', () => {
  it('says the server’s refusal in red and what an action did in green, each dismissable', () => {
    const html = renderToStaticMarkup(
      createElement(ActionFeedback, {
        error: 'ZZ TEST refused',
        note: 'Host added: ZZ TEST Anya',
        onDismissError: noop,
        onDismissNote: noop,
      }),
    );
    expect(html).toMatch(/role="alert" class="[^"]*bg-danger[^"]*text-danger-ink[^"]*"><span[^>]*>ZZ TEST refused<\/span>/);
    expect(html).toMatch(/role="status" class="[^"]*bg-money[^"]*text-money-ink[^"]*"><span[^>]*>Host added: ZZ TEST Anya<\/span>/);
    expect(html.match(/aria-label="Dismiss"/g)).toHaveLength(2);
    expect(renderToStaticMarkup(createElement(ActionFeedback, { error: null, note: null, onDismissError: noop, onDismissNote: noop }))).toBe('');
  });
});
