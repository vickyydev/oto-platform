// SCRUM-831 (never ask twice): under the assistant's line that asked the
// customer something, the thread shows what it asked and what it read the
// reply as — "asked: child's age · answered 8" — so staff see what the
// assistant believes. Node, no DOM, as the other markup files: the panel
// rendered with react-dom/server. FICTIONAL TEST DATA.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConversationDetail, ConversationRow, InboxMe, Message } from '@/api/inbox';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { OpenQuestionLine } from '@/components/OpenQuestionLine';
import { SLOT_LABEL, openQuestionText, openQuestionsByMessage, type OpenQuestion } from '@/lib/open-question';
import { INBOX_AI_ASKED_SLOTS } from '@oto/shared/inbox-open-question';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const GM = '00000000-0000-7000-8000-00000000009a';
const CONV = '0192f0a0-1234-7abc-8def-0123456789ab';
const CONTACT = '0192f0a0-1234-7abc-8def-0123456789ac';
const WA = '0192f0a0-1234-7abc-8def-0000000000a1';
const ASKED = '0192f0a0-1234-7abc-8def-0000000000d1';
const ANSWER = '0192f0a0-1234-7abc-8def-0000000000d2';
const OTHER = '0192f0a0-1234-7abc-8def-0000000000d3';

const me: InboxMe = {
  accountId: GM,
  name: 'Demo GM',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams: [{ id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: false }],
  people: [{ accountId: GM, name: 'Demo GM', teamIds: [], operatorWide: true }],
  defaultReceptionBranchId: CENTRAL,
  capabilities: { writes: true, dashboard: true, assign: true, move: true, reopen: true, templates: true, kb: true, ai: true },
  simulator: null,
};

const row: ConversationRow = {
  id: CONV,
  channel: 'whatsapp',
  channelAccountId: WA,
  channelAccountName: 'Birthdays',
  canReply: true,
  contact: { id: CONTACT, channel: 'whatsapp', handle: '+66800000000', displayName: 'ZZ TEST Parent', phone: '+66800000000', language: 'en', erased: false },
  category: 'birthdays',
  intent: 'birthday_party',
  language: 'en',
  branchId: CENTRAL,
  teamId: T_BIRTHDAYS,
  status: 'active',
  handledAt: null,
  handledByKind: null,
  lastMessageAt: '2026-11-10T03:00:00.000Z',
  lastMessagePreview: '8',
  unanswered: true,
  unread: 1,
  mine: false,
  assignments: [],
  createdAt: '2026-11-10T02:00:00.000Z',
};

const question = (over: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: '0192f0a0-1234-7abc-8def-0000000000e1',
  slot: 'child_age',
  state: 'answered',
  askedMessageId: ASKED,
  askedAt: '2026-11-10T02:30:00.000Z',
  answer: '8',
  answeredMessageId: ANSWER,
  closedAt: '2026-11-10T03:00:00.000Z',
  ...over,
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

function panel(openQuestions: OpenQuestion[] | undefined): string {
  const detail: ConversationDetail = {
    ...row,
    teamName: 'Birthdays & Events',
    firstResponseAt: null,
    reopenedAt: null,
    member: null,
    events: [],
    divertTo: null,
    aiMode: 'live',
    aiPaused: false,
    aiPausedAt: null,
    aiPausedByAccountId: null,
    aiState: 'ready',
    event: null,
    ...(openQuestions ? { openQuestions } : {}),
  };
  const messages = [
    msg({ id: OTHER, createdAt: '2026-11-10T02:29:59.000Z', direction: 'outbound', authorKind: 'ai', body: 'Amazing, thank you! 🎈', providerStatus: 'sent' }),
    msg({ id: ASKED, createdAt: '2026-11-10T02:30:00.000Z', direction: 'outbound', authorKind: 'ai', body: 'How old will the birthday boy be?', providerStatus: 'sent' }),
    msg({ id: ANSWER, createdAt: '2026-11-10T03:00:00.000Z', body: '8' }),
  ];
  const thread: Thread = { detail, messages, olderCursor: null, loading: false, loadingOlder: false, error: null };
  const noop = () => undefined;
  return renderToStaticMarkup(
    createElement(ChatPanel, {
      row,
      thread,
      me,
      now: new Date('2026-11-10T04:00:00.000Z'),
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

describe('what the assistant believes, under the line that asked', () => {
  it('"asked: child\'s age · answered 8" under the asking line, and only there', () => {
    const html = panel([question()]);
    expect(html.match(/data-testid="open-question"/g)).toHaveLength(1);
    expect(html).toContain('asked: child&#x27;s age · answered 8');
    // Right after the asking line, before the parent's answer.
    expect(html.indexOf('How old will the birthday boy be?')).toBeLessThan(html.indexOf('data-testid="open-question"'));
    expect(html.indexOf('data-testid="open-question"')).toBeLessThan(html.lastIndexOf('>8<'));
  });

  it('a thread whose detail carries no questions (an older server) shows nothing', () => {
    expect(panel(undefined)).not.toContain('data-testid="open-question"');
    expect(panel([])).not.toContain('data-testid="open-question"');
  });

  it('every state in words; a park by its name; a name never shown', () => {
    expect(openQuestionText(question({ state: 'open', answer: null }))).toBe("asked: child's age · waiting for the answer");
    expect(openQuestionText(question({ state: 'withdrawn', answer: null }))).toBe("asked: child's age · not answered");
    expect(openQuestionText(question({ slot: 'park', answer: 'chalong' }))).toBe('asked: the park · answered Robinson Chalong');
    expect(openQuestionText(question({ slot: 'child_name', answer: null }))).toBe("asked: child's name · answered");
    expect(openQuestionText(question({ slot: 'guests_count', answer: '12 kids, 8 adults' }))).toBe('asked: how many people · answered 12 kids, 8 adults');
    // Every slot the server can record has its words.
    for (const slot of INBOX_AI_ASKED_SLOTS) expect(SLOT_LABEL[slot]).toBeTruthy();
  });

  it('the combined question: each part on the one line, grouped by the line that asked', () => {
    const qs = [question({ slot: 'date', answer: '2026-11-14' }), question({ id: 'q2', slot: 'park', state: 'open', answer: null, answeredMessageId: null, closedAt: null })];
    const byLine = openQuestionsByMessage(qs);
    expect(byLine.get(ASKED)).toHaveLength(2);
    const html = renderToStaticMarkup(createElement(OpenQuestionLine, { questions: byLine.get(ASKED)! }));
    expect(html).toContain('asked: the date · answered 2026-11-14');
    expect(html).toContain('asked: the park · waiting for the answer');
    expect(renderToStaticMarkup(createElement(OpenQuestionLine, { questions: [] }))).toBe('');
  });
});
