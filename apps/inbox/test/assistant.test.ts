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
import { ExampleCard, ExampleReview, WITHDRAW_EXAMPLE_LINE, WithdrawExampleConfirm } from '@/components/AssistantSettings';
import { CorrectAssistant } from '@/components/CorrectAssistant';
import { MessageBubble, ShadowBubble } from '@/components/MessageBubble';
import {
  AI_MODE_OPTIONS,
  KB_BODY_MAX,
  KB_QUESTION_MAX,
  canApproveExample,
  correctionSource,
  defaultExampleIntent,
  exampleDraftProblem,
  exampleIntentProblem,
  kbDraftProblem,
  kbGroups,
  modeChangeNeedsConfirm,
  turnForCorrection,
} from '@/lib/assistant';
import { RETHINK_READING_LABEL, eventText, timeline, withdrawnNotes, withdrawnWhy } from '@/lib/view';

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

  it('SCRUM-678: the re-read row is never shown as a delivered message — muted, dashed, labelled, no ticks', () => {
    const at = '2026-10-20T08:59:00.000Z';
    const now = new Date('2026-10-20T09:00:00Z');
    const reading = renderToStaticMarkup(createElement(ShadowBubble, { text: 'Asks whether a camp runs today', at, now, label: RETHINK_READING_LABEL }));
    const sent = renderToStaticMarkup(createElement(MessageBubble, { m: { ...aiLine, providerStatus: 'sent' }, me, now }));
    expect(reading).toContain('data-shadow="true"');
    expect(reading).toContain(RETHINK_READING_LABEL);
    expect(reading).toContain('not sent');
    expect(reading).toContain('border-dashed');
    // A sent bubble carries its delivery tick; the re-read row has none, and none of a sent bubble's markers.
    expect(sent).toContain('lucide-check');
    expect(reading).not.toMatch(/lucide-check|lucide-clock/);
    expect(sent).not.toContain('data-shadow');
    expect(sent).not.toContain('not sent');
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

  describe('the topic it starts on (test night 2026-10-21, U3)', () => {
    it('leaves the server its default when the assistant classified the thread, else starts on the category’s topic', () => {
      expect(defaultExampleIntent('hours', 'general')).toBe('');
      expect(defaultExampleIntent(null, 'general')).toBe('faq');
      expect(defaultExampleIntent('online / branch', 'birthdays')).toBe('birthday_party');
      expect(defaultExampleIntent(null, 'marketing')).toBe('influencer_marketing');
    });

    it('refuses a blank topic before Propose when the thread has no classification', () => {
      expect(exampleIntentProblem('', null)).toMatch(/Choose the topic/);
      expect(exampleIntentProblem('', 'lost items')).toMatch(/Choose the topic/);
      expect(exampleIntentProblem('faq', null)).toBeNull();
      expect(exampleIntentProblem('', 'hours')).toBeNull();
    });

    it('opens on the category’s topic, with no blank choice, on a thread the assistant never classified', () => {
      const html = renderToStaticMarkup(
        createElement(CorrectAssistant, {
          target: { messageId: 'a2' },
          messages,
          intent: 'lost items',
          category: 'general',
          language: 'en',
          onClose: () => undefined,
        }),
      );
      expect(html).not.toContain('As the assistant classified it');
      expect(html).toMatch(/<option value="faq" selected="">/);
      expect(html).toMatch(/<button type="submit" form="correct-assistant" class="[^"]*">(?!<svg)[^<]*Propose example<\/button>/);
    });

    it('keeps the server’s default on a classified thread when no turn names the message', () => {
      const html = renderToStaticMarkup(
        createElement(CorrectAssistant, {
          target: { messageId: 'a2' },
          messages,
          intent: 'hours',
          category: 'general',
          language: 'en',
          onClose: () => undefined,
        }),
      );
      expect(html).toMatch(/<option value="" selected="">As the assistant classified it<\/option>/);
    });
  });

  describe('the corrected message’s own turn (customer-AI test night, D3)', () => {
    // The thread's latest intent is a later price question; the line being
    // corrected (a2) was the parking turn's.
    const turns = [
      ev({ id: 't-reply', kind: 'ai_replied', createdAt: '2026-10-20T08:01:00.000Z', payload: { turnId: 'turn-1', intent: 'directions_parking', messageIds: ['a1', 'a2'] } }),
      ev({ id: 't-silent', kind: 'ai_silent', createdAt: '2026-10-20T08:00:30.000Z', payload: { turnId: 'turn-0', reason: 'MODEL_SILENT', intent: null } }),
      ev({ id: 't-later', kind: 'ai_replied', createdAt: '2026-10-20T08:05:00.000Z', payload: { turnId: 'turn-2', intent: 'ticket_prices', messageIds: ['a9'] } }),
    ];

    it('finds the turn that wrote the line, by the event that names it, or by the row’s own turn id', () => {
      expect(turnForCorrection(turns, { messageId: 'a2' })).toEqual({ turnId: 'turn-1', intent: 'directions_parking' });
      expect(turnForCorrection(turns, { messageId: 'a9' })).toEqual({ turnId: 'turn-2', intent: 'ticket_prices' });
      expect(turnForCorrection(turns, { messageId: 'unknown' }, 'turn-1')).toEqual({ turnId: 'turn-1', intent: 'directions_parking' });
      expect(turnForCorrection(turns, { messageId: 'unknown' })).toBeNull();
      expect(turnForCorrection([], { messageId: 'a2' })).toBeNull();
    });

    it('finds the silence an ai_silent pill marks, at its time, with no intent when it had none', () => {
      expect(turnForCorrection(turns, { at: '2026-10-20T08:00:30.000Z' })).toEqual({ turnId: 'turn-0', intent: null });
      expect(turnForCorrection(turns, { at: '2026-10-20T09:00:00.000Z' })).toBeNull();
    });

    it('opens on the corrected message’s topic, shown, with no blank — not the thread’s latest', () => {
      const html = renderToStaticMarkup(
        createElement(CorrectAssistant, {
          target: { messageId: 'a2' },
          messages,
          events: turns,
          intent: 'ticket_prices',
          category: 'general',
          language: 'en',
          onClose: () => undefined,
        }),
      );
      expect(html).toMatch(/<option value="directions_parking" selected="">/);
      expect(html).not.toMatch(/<option value="ticket_prices" selected="">/);
      expect(html).not.toContain('As the assistant classified it');
      expect(html).toContain('data-topic-source="turn"');
      expect(html).toContain('As the assistant classified this message.');
    });

    it('on a silence the assistant never classified, starts on the category’s topic and says so', () => {
      const html = renderToStaticMarkup(
        createElement(CorrectAssistant, {
          target: { at: '2026-10-20T08:00:30.000Z' },
          messages: messages.slice(0, 4),
          events: turns,
          intent: 'ticket_prices',
          category: 'birthdays',
          language: 'en',
          onClose: () => undefined,
        }),
      );
      expect(html).toMatch(/<option value="birthday_party" selected="">/);
      expect(html).not.toContain('As the assistant classified it');
      expect(html).toContain('data-topic-source="turn-unclassified"');
    });
  });
});

describe('withdrawing an approved example (test night U2)', () => {
  const example: AiExample = {
    id: 'x1',
    intent: 'faq',
    language: 'en',
    customerText: 'Can we bring our own cake?',
    goodReply: 'Yes, outside cakes are welcome.',
    verdict: 'should_answer',
    status: 'approved',
    sourceMessageId: null,
    sourceConversationId: null,
    proposedByAccountId: 'a1',
    approvedByAccountId: 'a2',
    approvedAt: '2026-10-21T08:00:00.000Z',
    deidentifiedConfirmed: true,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-21T08:00:00.000Z',
  };
  const card = (x: AiExample) =>
    renderToStaticMarkup(
      createElement(ExampleCard, { example: x, proposer: null, onReview: () => undefined, onWithdraw: () => undefined }),
    );

  it('offers Withdraw on an approved example and Review on a proposed one', () => {
    expect(card(example)).toContain('Withdraw');
    expect(card(example)).not.toContain('Review');
    expect(card({ ...example, status: 'proposed' })).toContain('Review');
    expect(card({ ...example, status: 'proposed' })).not.toContain('Withdraw');
    expect(card({ ...example, status: 'rejected' })).not.toContain('Withdraw');
  });

  it('says what withdrawing means before the press', () => {
    const html = renderToStaticMarkup(
      createElement(WithdrawExampleConfirm, { example, busy: false, error: null, onCancel: () => undefined, onConfirm: () => undefined }),
    );
    expect(WITHDRAW_EXAMPLE_LINE).toBe('The assistant stops using this example on every live number.');
    expect(html).toContain(WITHDRAW_EXAMPLE_LINE);
    expect(html).toContain('Yes, withdraw');
  });
});
