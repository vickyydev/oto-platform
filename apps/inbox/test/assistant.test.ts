// The assistant's screens on the shell side (SCRUM-590 A3, plan §D.3, §E,
// §F.3 "the shell's unit tests for the pills and the withdrawn bubble"):
// the three new pills, the withdrawn bubble, the mode control's words and the
// example approve gate. Node, no DOM: the bubble and the review dialog are
// rendered to markup with react-dom/server.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { NOT_ON_YOUR_ACCESS, assistantCapabilities, notOnAccess, type AiExample, type KbTopic } from '@/api/assistant';
import type { InboxEvent, InboxMe, Message } from '@/api/inbox';
import { ExampleReview } from '@/components/AssistantSettings';
import { MessageBubble } from '@/components/MessageBubble';
import {
  AI_MODE_OPTIONS,
  KB_BODY_MAX,
  KB_QUESTION_MAX,
  canApproveExample,
  correctionSource,
  exampleDraftProblem,
  kbDraftProblem,
  kbGroups,
  modeChangeNeedsConfirm,
} from '@/lib/assistant';
import { eventText, timeline, withdrawnNotes, withdrawnWhy } from '@/lib/view';

const T_BIRTHDAYS = '00000000-0000-7000-8000-0000000000b1';
const me: Pick<InboxMe, 'people' | 'teams'> = {
  teams: [{ id: T_BIRTHDAYS, kind: 'birthdays', name: 'Birthdays & Events', colour: 'violet', branchId: null, member: true }],
  people: [],
};
const ctx = { me };

function ev(over: Partial<InboxEvent>): InboxEvent {
  return {
    id: 'e1',
    kind: 'classified',
    actorKind: 'ai',
    actorAccountId: null,
    actorName: null,
    payload: {},
    createdAt: '2026-10-20T08:00:00.000Z',
    ...over,
  };
}

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    direction: 'inbound',
    authorKind: 'customer',
    authorAccountId: null,
    authorName: null,
    body: 'Hello',
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
    createdAt: '2026-10-20T08:00:00.000Z',
    ...over,
  };
}

describe('the three new pills (§D.3)', () => {
  it('says a handover, naming the team it went to and the intent', () => {
    expect(
      eventText(ev({ kind: 'ai_handover', payload: { intent: 'birthday_party', reroutedTeamId: T_BIRTHDAYS } }), ctx),
    ).toBe('AI handed over to Birthdays & Events · birthday party');
    expect(eventText(ev({ kind: 'ai_handover', payload: { intent: 'human_requested', reroutedTeamId: null } }), ctx)).toBe(
      'AI handed over to the team · human requested',
    );
  });

  it('says only that the assistant left a silence for a person — never the reason word', () => {
    const text = eventText(ev({ kind: 'ai_silent', payload: { reason: 'GUARD_NUMBER', intent: 'ticket_prices' } }), ctx);
    expect(text).toBe('AI left this one for the team');
    expect(text).not.toMatch(/GUARD|ticket/);
  });

  it('says a withdrawal and why, in the plan’s words', () => {
    expect(eventText(ev({ kind: 'ai_withdrawn', actorKind: 'system', payload: { messageId: 'm2', reason: 'STAFF_REPLY' } }), ctx)).toBe(
      'AI reply not sent · a person replied',
    );
    expect(withdrawnWhy('PAUSED')).toBe('the assistant was paused');
    expect(withdrawnWhy('HANDLED')).toBe('the conversation was handled');
    expect(withdrawnWhy(undefined)).toBe('a person replied');
  });

  it('keeps "Auto-resolved" for a thread the AI handled', () => {
    expect(eventText(ev({ kind: 'handled', actorKind: 'ai' }), ctx)).toBe('Marked as Handled by AI · Auto-resolved');
  });

  it('carries the event kind on the timeline, so an ai_silent pill can offer a correction', () => {
    const items = timeline([], [ev({ kind: 'ai_silent' })], true, ctx);
    expect(items).toEqual([expect.objectContaining({ kind: 'pill', event: 'ai_silent' })]);
  });
});

describe('the withdrawn bubble (§A.3)', () => {
  const aiLine = msg({ id: 'm2', direction: 'outbound', authorKind: 'ai', body: 'We open at 10:00.', providerStatus: 'withdrawn' });

  it('notes each withdrawn line from its event, and a withdrawn row whose event is not loaded', () => {
    const notes = withdrawnNotes(
      [aiLine, msg({ id: 'm3', direction: 'outbound', authorKind: 'ai', providerStatus: 'withdrawn' })],
      [ev({ kind: 'ai_withdrawn', payload: { messageId: 'm2', reason: 'ASSIGNED' } })],
    );
    expect(notes.get('m2')).toBe('Not sent: a person took the conversation');
    expect(notes.get('m3')).toBe('Not sent: a person replied');
  });

  it('renders struck through, greyed, under the AI chip, with "Not sent: a person replied"', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, { m: aiLine, me, now: new Date('2026-10-20T09:00:00Z'), withdrawnNote: 'Not sent: a person replied' }),
    );
    expect(html).toContain('data-withdrawn="true"');
    expect(html).toContain('<s class="decoration-slate-400">We open at 10:00.</s>');
    expect(html).toContain('Not sent: a person replied');
    expect(html).toContain('AI Assistant');
    expect(html).toContain('border-dashed');
    expect(html).not.toContain('bg-indigo-50 text-indigo-900');
  });

  it('leaves a sent AI line as it was, with the correction control when offered', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        m: { ...aiLine, providerStatus: 'sent' },
        me,
        now: new Date('2026-10-20T09:00:00Z'),
        onCorrect: () => undefined,
      }),
    );
    expect(html).not.toContain('data-withdrawn');
    expect(html).not.toContain('<s ');
    expect(html).toContain('Correct the assistant');
  });

  it('offers no correction on a person’s line', () => {
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        m: msg({ direction: 'outbound', authorKind: 'staff', authorName: 'Alina' }),
        me,
        now: new Date('2026-10-20T09:00:00Z'),
        onCorrect: () => undefined,
      }),
    );
    expect(html).not.toContain('Correct the assistant');
  });
});

describe('the mode control (§D.4)', () => {
  it('offers off, shadow and live, in that order, and live says customers hear it', () => {
    expect(AI_MODE_OPTIONS.map((o) => o.value)).toEqual(['off', 'shadow', 'live']);
    expect(AI_MODE_OPTIONS.find((o) => o.value === 'live')!.description).toMatch(/CUSTOMERS HEAR IT/);
    expect(AI_MODE_OPTIONS.find((o) => o.value === 'shadow')!.description).toMatch(/sends nothing/);
  });

  it('asks before going live, and only then', () => {
    expect(modeChangeNeedsConfirm('off', 'live')).toBe(true);
    expect(modeChangeNeedsConfirm('shadow', 'live')).toBe(true);
    expect(modeChangeNeedsConfirm('live', 'off')).toBe(false);
    expect(modeChangeNeedsConfirm('off', 'shadow')).toBe(false);
  });

  it('opens the page only on the capabilities /inbox/me names', () => {
    const base: InboxMe['capabilities'] = {
      writes: true,
      dashboard: true,
      assign: true,
      move: true,
      reopen: true,
      templates: true,
      kb: false,
      ai: false,
    };
    expect(assistantCapabilities({ capabilities: base })).toEqual({ kb: false, ai: false });
    expect(assistantCapabilities({ capabilities: { ...base, kb: true } })).toEqual({ kb: true, ai: false });
  });

  it('reads a 403 (a branch-scoped kb grant on the examples queue) as "not on your access", never a fault', () => {
    expect(notOnAccess(new ApiError(403, 'FORBIDDEN', 'Forbidden'))).toBe(true);
    expect(notOnAccess(new ApiError(404, 'UNKNOWN', 'Not Found'))).toBe(true);
    expect(notOnAccess(new ApiError(404, 'KB_ENTRY_NOT_FOUND', 'No such entry'))).toBe(false);
    expect(notOnAccess(new ApiError(409, 'KB_NOT_DRAFT', 'Not a draft'))).toBe(false);
    expect(NOT_ON_YOUR_ACCESS).toMatch(/not on your access/);
  });
});

describe('the approve gate (§D.5)', () => {
  const draft = { customerText: 'Can we bring our own cake?', goodReply: 'Yes, outside cakes are welcome.', verdict: 'should_answer' as const };

  it('enables Approve only once "contains no personal data" is ticked', () => {
    expect(canApproveExample({ deidentified: false, draft, busy: false })).toBe(false);
    expect(canApproveExample({ deidentified: true, draft, busy: false })).toBe(true);
  });

  it('keeps it disabled while a write runs or the draft would be refused', () => {
    expect(canApproveExample({ deidentified: true, draft, busy: true })).toBe(false);
    expect(canApproveExample({ deidentified: true, draft: { ...draft, goodReply: '' }, busy: false })).toBe(false);
    expect(canApproveExample({ deidentified: true, draft: { ...draft, goodReply: '', verdict: 'should_handover' }, busy: false })).toBe(true);
  });

  it('opens the review with the tick clear and Approve disabled', () => {
    const example: AiExample = {
      id: 'x1',
      intent: 'faq',
      language: 'en',
      customerText: draft.customerText,
      goodReply: draft.goodReply,
      verdict: 'should_answer',
      status: 'proposed',
      sourceMessageId: 'm1',
      sourceConversationId: 'c1',
      proposedByAccountId: 'a1',
      approvedByAccountId: null,
      approvedAt: null,
      deidentifiedConfirmed: false,
      createdAt: '2026-10-20T08:00:00.000Z',
      updatedAt: '2026-10-20T08:00:00.000Z',
    };
    const html = renderToStaticMarkup(createElement(ExampleReview, { example, onClose: () => undefined, onDone: async () => undefined }));
    expect(html).toContain('Contains no personal data.');
    expect(html).toMatch(/<input type="checkbox"(?![^>]*checked)[^>]*aria-describedby="deidentified-help"/);
    expect(html).toMatch(/<button type="button" disabled="" class="[^"]*">Approve<\/button>/);
  });

  it('holds the example’s limits', () => {
    expect(exampleDraftProblem({ ...draft, customerText: 'x'.repeat(501) })).toMatch(/500/);
    expect(exampleDraftProblem({ ...draft, goodReply: 'x'.repeat(801) })).toMatch(/800/);
  });
});

describe('the knowledge base editor (§C.1)', () => {
  const ok = { topic: 'faq', key: 'faq.food-outside', language: 'en' as const, question: 'Can we bring food?', body: 'Snacks yes.' };

  it('holds the schema’s limits: question ≤ 200, body ≤ 1200, a slug key', () => {
    expect(kbDraftProblem(ok)).toBeNull();
    expect(kbDraftProblem({ ...ok, question: 'x'.repeat(KB_QUESTION_MAX + 1) })).toMatch(/200/);
    expect(kbDraftProblem({ ...ok, question: 'x'.repeat(KB_QUESTION_MAX) })).toBeNull();
    expect(kbDraftProblem({ ...ok, body: 'x'.repeat(KB_BODY_MAX + 1) })).toMatch(/1200/);
    expect(kbDraftProblem({ ...ok, key: 'FAQ food' })).toMatch(/lower-case/);
    expect(kbDraftProblem({ ...ok, topic: 'prices' })).toMatch(/topic/);
  });

  it('groups by topic in the schema’s order, then key, then language', () => {
    const e = (topic: KbTopic, key: string, language: 'en' | 'th' | 'ru') => ({
      id: `${key}-${language}`,
      branchId: null,
      topic,
      key,
      language,
      question: 'q',
      body: 'b',
      status: 'draft' as const,
      needsTranslation: false,
      sourceExampleId: null,
      updatedByAccountId: null,
      approvedByAccountId: null,
      approvedAt: null,
      canManage: true,
      createdAt: '2026-10-20T08:00:00.000Z',
      updatedAt: '2026-10-20T08:00:00.000Z',
    });
    const groups = kbGroups([e('faq', 'faq.a', 'th'), e('socks', 'socks.rule', 'en'), e('faq', 'faq.a', 'en'), e('about_oto', 'about', 'ru')]);
    expect(groups.map((g) => g.topic)).toEqual(['about_oto', 'socks', 'faq']);
    expect(groups[2]!.entries.map((x) => x.id)).toEqual(['faq.a-en', 'faq.a-th']);
  });
});

describe('"Correct the assistant", pre-filled (§E)', () => {
  const messages = [
    msg({ id: 'c0', body: 'Earlier question', createdAt: '2026-10-20T07:00:00.000Z' }),
    msg({ id: 's0', direction: 'outbound', authorKind: 'staff', body: 'Staff answer', createdAt: '2026-10-20T07:05:00.000Z' }),
    msg({ id: 'c1', body: 'Hi', createdAt: '2026-10-20T08:00:00.000Z' }),
    msg({ id: 'c2', body: 'What time do you open?', createdAt: '2026-10-20T08:00:05.000Z' }),
    msg({ id: 'a1', direction: 'outbound', authorKind: 'ai', body: 'Hello!', createdAt: '2026-10-20T08:01:00.000Z' }),
    msg({ id: 'a2', direction: 'outbound', authorKind: 'ai', body: 'We open at 10:00.', createdAt: '2026-10-20T08:01:01.000Z' }),
  ];

  it('takes the customer’s burst the AI answered and the AI’s own line', () => {
    expect(correctionSource(messages, { messageId: 'a2' })).toEqual({
      customerText: 'Hi\nWhat time do you open?',
      customerMessageId: 'c2',
      aiText: 'We open at 10:00.',
    });
  });

  it('under an ai_silent pill, takes the burst before the pill and no AI line', () => {
    expect(correctionSource(messages.slice(0, 4), { at: '2026-10-20T08:00:30.000Z' })).toEqual({
      customerText: 'Hi\nWhat time do you open?',
      customerMessageId: 'c2',
      aiText: '',
    });
  });
});
