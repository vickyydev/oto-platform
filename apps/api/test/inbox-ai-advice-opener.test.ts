import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADVICE_OPENER_SLOTS, slotsAskedIn, type AiDecision } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { ADVICE_OPENER_KEY } from '../src/services/inbox/ai-destination';
import { ADMIN, signInAs, teardownAll } from './helpers';
import {
  aiLines,
  aiWorld,
  call,
  conversationRow,
  customer,
  decision,
  eventsOf,
  nextPhone,
  simAccount,
  staff,
  teamOf,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';

/**
 * SCRUM-823, THE OPENER BESIDE AN ADVICE HAND-OVER, through the real turn
 * engine (staging, 10 November, docs/qa/proof-2026-11-09/SCRUM-823/staging):
 * "We want a birthday party for our daughter. What would you suggest?" and
 * "We would like to book a birthday party for our son. Which package would
 * you recommend?" were handed to Birthdays & Events with the closing line
 * alone, and the family was never asked the date and the park. Against a real
 * embedded database and the `FakeAssistantClient` scripted with the staging
 * readings:
 *
 *   - ONE message goes, the `opener_birthday_advice` template: the opener's
 *     question, then the birthday manager's warm line, in the thread's
 *     language — never two bubbles, never the model's words;
 *   - the hand-over is recorded with `birthday_advice`, the thread is in the
 *     Birthdays & Events queue, and the manager's notice is queued;
 *   - the opener's slots (date, roughly how many people, which park) are
 *     recorded open on that line, so the family's reply is read as the
 *     answer once the assistant has the thread again;
 *   - a second advice question after it gets the warm line alone;
 *   - an opener template that is not usable falls back to the warm line, and
 *     records nothing as asked.
 *
 * FICTIONAL TEST DATA throughout; the fake model only, never the real one.
 */

let w: AiWorld;
let birthdays: string; // a Birthdays & Events number at Central, live
let general: string; // a general number at Central, live
let adminCookie: string;
let agentCookie: string;

const C = 'We want a birthday party for our daughter. What would you suggest?';
const C2 = 'We would like to book a birthday party for our son. Which package would you recommend?';

/** The model's staging readings: advice alone (C), or the party beside it (C2), handed over with no words of its own. */
const adviceAlone = (language: AiDecision['language'] = 'en') =>
  decision({ language, intent: 'birthday_advice', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] });
const adviceWithParty = (language: AiDecision['language'] = 'en') =>
  decision({ language, intent: 'birthday_advice', intents: ['birthday_advice', 'birthday_party'], action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] });

beforeAll(async () => {
  w = await aiWorld();
  // Due at once: each tick decides the burst just written.
  w.ctx.app.inboxAi.config.debounceMs = 0;
  birthdays = await simAccount(w, { branchId: w.central, defaultCategory: 'birthdays' });
  general = await simAccount(w, { branchId: w.central });
  const birthdaysTeam = await teamOf(w, 'birthdays');
  [, agentCookie] = await staff(w, '+66810008234', 'ZZ TEST Opener Agent', 'inbox_agent', {
    scopeType: 'department',
    scopeId: birthdaysTeam.departmentId!,
  });
  adminCookie = await signInAs(w.ctx.app, ADMIN.phone, ADMIN.password);
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

/** Settle every turn due now, so a test starts from a quiet queue and a fresh script. */
async function drain(): Promise<void> {
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
  expect(w.fake.remaining).toBe(0);
}

/** The family writes, the model's reading is scripted, one tick decides the burst. */
async function turn(account: string, phone: string, text: string, d: AiDecision) {
  const conv = await customer(w, account, phone, text);
  w.fake.push({ kind: 'decision', decision: d });
  const sweep = await tick(w, new Date(Date.now() + 500));
  expect(w.fake.remaining).toBe(0);
  return { conv, sweep };
}

async function templateRow(key: 'opener_birthday_advice' | 'closing_birthday', language: 'en' | 'ru' | 'th') {
  const [row] = await w.ctx.db
    .select()
    .from(s.template)
    .where(
      and(
        eq(s.template.operatorId, w.oto),
        eq(s.template.key, key),
        eq(s.template.language, language),
        isNull(s.template.channel),
        isNull(s.template.branchId),
        isNull(s.template.archivedAt),
      ),
    )
    .limit(1);
  expect(row, `${key}/${language}`).toBeDefined();
  expect(row!.needsTranslation, `${key}/${language}`).toBe(false);
  return row!;
}

const questionsOf = (conversationId: string) =>
  w.ctx.db
    .select()
    .from(s.conversationOpenQuestion)
    .where(eq(s.conversationOpenQuestion.conversationId, conversationId))
    .orderBy(asc(s.conversationOpenQuestion.askedAt), asc(s.conversationOpenQuestion.slot));

const noticesOf = (conversationId: string) =>
  w.ctx.db.select().from(s.handoverNotification).where(eq(s.handoverNotification.conversationId, conversationId));

/**
 * A person resumes the assistant on the thread. The tick that handed it over
 * ran half a second ahead (`turn`), so the hand-over is stamped then; the
 * Resume must come after it, as it does on a real thread.
 */
async function resume(conversationId: string) {
  await new Promise((done) => setTimeout(done, 700));
  const resumed = await call(w, agentCookie, 'POST', `/inbox/conversations/${conversationId}/ai-resume`);
  expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
}

const handoverPayload = async (conversationId: string) =>
  (await eventsOf(w, conversationId)).filter((e) => e.kind === 'ai_handover').map((e) => e.payload as Record<string, unknown>);

/** What the opener's hand-over leaves, whatever the language: one line, the hand-over, three open questions, a notice. */
async function expectOpenerHandover(conversationId: string, language: 'en' | 'ru' | 'th', intents: string[]) {
  const opener = await templateRow('opener_birthday_advice', language);
  const lines = await aiLines(w, conversationId);
  // ONE message: the opener's question and the warm line, verbatim; nothing of the model's.
  expect(lines.map((l) => ({ body: l.body, templateId: l.templateId, bodyLanguage: l.bodyLanguage }))).toEqual([
    { body: opener.body, templateId: opener.id, bodyLanguage: language },
  ]);
  const [t] = await turnsOf(w, conversationId);
  expect(t).toMatchObject({ state: 'handed_over', intent: 'birthday_advice', messageIds: [lines[0]!.id] });
  // The hand-over is the one it was: birthday_advice, to Birthdays & Events, the opener's line its closing line.
  expect(await handoverPayload(conversationId)).toEqual([
    expect.objectContaining({
      intent: 'birthday_advice',
      intents,
      destination: 'birthdays',
      templateKey: 'closing_birthday',
      closingKey: ADVICE_OPENER_KEY,
      holdingLine: 'template',
      templateId: opener.id,
      messageIds: [lines[0]!.id],
    }),
  ]);
  const birthdaysTeam = await teamOf(w, 'birthdays');
  expect(await conversationRow(w, conversationId)).toMatchObject({ category: 'birthdays', teamId: birthdaysTeam.id });
  // The opener's three basics asked on that line, open for the family's reply.
  const qs = await questionsOf(conversationId);
  expect(qs.map((q) => q.slot).sort()).toEqual([...ADVICE_OPENER_SLOTS].sort());
  expect(qs.every((q) => q.state === 'open' && q.askedMessageId === lines[0]!.id && q.turnId === t!.id && q.answer === null)).toBe(true);
  // The birthday manager's notice is queued, for the advice.
  const notices = await noticesOf(conversationId);
  expect(notices.length).toBeGreaterThan(0);
  expect(notices.every((n) => n.kind === 'notice' && n.intent === 'birthday_advice' && n.destination === 'birthdays' && n.turnId === t!.id)).toBe(true);
  return { opener, line: lines[0]!, turn: t! };
}

describe('SCRUM-823 staging: the opener goes with the advice hand-over, as one message', () => {
  it('the opener template asks the three basics in every language, and ends with the birthday manager’s warm line', async () => {
    for (const language of ['en', 'ru', 'th'] as const) {
      const opener = await templateRow('opener_birthday_advice', language);
      const closing = await templateRow('closing_birthday', language);
      expect(slotsAskedIn([opener.body]), language).toEqual(expect.arrayContaining([...ADVICE_OPENER_SLOTS]));
      expect(slotsAskedIn([opener.body]).filter((slot) => !ADVICE_OPENER_SLOTS.includes(slot)), language).toEqual([]);
      // The warm line is the birthday manager's, as the closing line says it.
      const warm = { en: 'Our birthday manager will be with you shortly.', ru: 'Наш менеджер по праздникам скоро свяжется с вами.', th: 'ผู้จัดการฝ่ายงานวันเกิดของเราจะมาดูแลคุณในอีกไม่นานค่ะ' }[language];
      expect(opener.body.endsWith(warm), language).toBe(true);
      expect(closing.body.endsWith(warm), language).toBe(true);
    }
  });

  it('C, labelled birthday_advice alone (en): one message with the opener and the warm line; handed over, three questions open, the notice queued', async () => {
    await drain();
    const { conv, sweep } = await turn(birthdays, nextPhone(), C, adviceAlone());
    expect(sweep.handedOver).toBe(1);
    const { line } = await expectOpenerHandover(conv.id, 'en', ['birthday_advice']);
    expect(line.body).toMatch(/What date are you thinking of, roughly how many people, and which branch/);

    // The inbox: the asked line under the bubble, and the hand-over's notice on the pill.
    const detail = await call<{ openQuestions: Array<{ slot: string; state: string; askedMessageId: string }>; handoverNotices: unknown[] }>(
      w,
      adminCookie,
      'GET',
      `/inbox/conversations/${conv.id}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.openQuestions.map((q) => [q.slot, q.state, q.askedMessageId]).sort()).toEqual(
      [...ADVICE_OPENER_SLOTS].sort().map((slot) => [slot, 'open', line.id]),
    );
    expect(detail.body.handoverNotices).toHaveLength(1);
    // One audit row for the questions, slots only.
    const [asked] = await w.ctx.db
      .select({ after: s.auditLog.after })
      .from(s.auditLog)
      .where(and(eq(s.auditLog.action, 'inbox.ai.open_question'), eq(s.auditLog.entityId, conv.id)));
    expect((asked!.after as { asked: string[] }).asked.sort()).toEqual([...ADVICE_OPENER_SLOTS].sort());
  });

  it('C2, the party labelled and handed over by the model itself (en): the same one message, both parts kept', async () => {
    await drain();
    const { conv, sweep } = await turn(birthdays, nextPhone(), C2, adviceWithParty());
    expect(sweep.handedOver).toBe(1);
    await expectOpenerHandover(conv.id, 'en', ['birthday_advice', 'birthday_party']);
  });

  it('C in Russian and C2 in Thai: the opener in the thread’s language', async () => {
    await drain();
    const ru = await turn(birthdays, nextPhone(), 'Хотим устроить день рождения для дочки. Что вы посоветуете?', adviceAlone('ru'));
    expect(ru.sweep.handedOver).toBe(1);
    await expectOpenerHandover(ru.conv.id, 'ru', ['birthday_advice']);
    await drain();
    const th = await turn(birthdays, nextPhone(), 'อยากจองปาร์ตี้วันเกิดให้ลูกชายค่ะ แนะนำแพ็กเกจไหนคะ', adviceWithParty('th'));
    expect(th.sweep.handedOver).toBe(1);
    await expectOpenerHandover(th.conv.id, 'th', ['birthday_advice', 'birthday_party']);
  });

  it('C2 in a general thread: the advice moves it to Birthdays & Events, with the opener', async () => {
    await drain();
    const { conv, sweep } = await turn(general, nextPhone(), C2, adviceWithParty());
    expect(sweep.handedOver).toBe(1);
    await expectOpenerHandover(conv.id, 'en', ['birthday_advice', 'birthday_party']);
  });

  it('A, "for a party of 12 kids": a headcount said, so the warm line goes alone and nothing is asked', async () => {
    await drain();
    const { conv, sweep } = await turn(birthdays, nextPhone(), 'Which branch would you recommend for a party of 12 kids?', adviceAlone());
    expect(sweep.handedOver).toBe(1);
    const closing = await templateRow('closing_birthday', 'en');
    expect((await aiLines(w, conv.id)).map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([{ body: closing.body, templateId: closing.id }]);
    expect(await handoverPayload(conv.id)).toEqual([expect.objectContaining({ intents: ['birthday_advice'], closingKey: 'closing_birthday' })]);
    expect(await questionsOf(conv.id)).toEqual([]);
    expect((await noticesOf(conv.id)).length).toBeGreaterThan(0);
  });
});

describe('SCRUM-823: after the opener', () => {
  it('a person resumes the assistant: the family’s reply is read as the answer to the opener', async () => {
    await drain();
    const phone = nextPhone();
    const first = await turn(birthdays, phone, C, adviceAlone());
    expect(first.sweep.handedOver).toBe(1);
    await resume(first.conv.id);

    const reply = await turn(
      birthdays,
      phone,
      '14 December, about 15 kids, Central Floresta',
      decision({ intent: 'birthday_details', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }),
    );
    expect(reply.sweep.handedOver).toBe(1);
    const qs = await questionsOf(first.conv.id);
    expect(qs.find((q) => q.slot === 'date')).toMatchObject({ state: 'answered', answer: expect.stringMatching(/^\d{4}-12-14$/) });
    expect(qs.find((q) => q.slot === 'guests_count')).toMatchObject({ state: 'answered', answer: '15 kids' });
    expect(qs.find((q) => q.slot === 'park')).toMatchObject({ state: 'answered', answer: 'central' });
    // Nothing asked twice: the details went with the warm line.
    const lines = await aiLines(w, first.conv.id);
    expect(lines.at(-1)!.body).toBe((await templateRow('closing_birthday', 'en')).body);
    expect(lines.filter((l) => /What date are you thinking of/.test(l.body ?? ''))).toHaveLength(1);
  });

  it('a second advice question in the same thread after the opener: the warm line alone, the opener never twice', async () => {
    await drain();
    const phone = nextPhone();
    const first = await turn(birthdays, phone, C2, adviceWithParty());
    expect(first.sweep.handedOver).toBe(1);
    await resume(first.conv.id);

    const second = await turn(birthdays, phone, 'And which package would you recommend for the party?', adviceWithParty());
    expect(second.sweep.handedOver).toBe(1);
    const opener = await templateRow('opener_birthday_advice', 'en');
    const closing = await templateRow('closing_birthday', 'en');
    expect((await aiLines(w, first.conv.id)).map((l) => l.body)).toEqual([opener.body, closing.body]);
    const payloads = await handoverPayload(first.conv.id);
    expect(payloads.map((p) => p.closingKey)).toEqual([ADVICE_OPENER_KEY, 'closing_birthday']);
    expect(payloads[1]).toMatchObject({ intents: ['birthday_advice', 'birthday_party'] });
    // The opener's questions were never answered; the second hand-over withdrew them, and asked nothing new.
    const qs = await questionsOf(first.conv.id);
    expect(qs).toHaveLength(ADVICE_OPENER_SLOTS.length);
    expect(qs.every((q) => q.state === 'withdrawn')).toBe(true);
  });

  it('the opener template switched off: the warm line goes alone, and nothing is recorded as asked', async () => {
    await drain();
    const opener = await templateRow('opener_birthday_advice', 'en');
    await w.ctx.db.update(s.template).set({ active: false }).where(eq(s.template.id, opener.id));
    try {
      const { conv, sweep } = await turn(birthdays, nextPhone(), C, adviceAlone());
      expect(sweep.handedOver).toBe(1);
      const closing = await templateRow('closing_birthday', 'en');
      expect((await aiLines(w, conv.id)).map((l) => ({ body: l.body, templateId: l.templateId }))).toEqual([{ body: closing.body, templateId: closing.id }]);
      expect(await handoverPayload(conv.id)).toEqual([expect.objectContaining({ intents: ['birthday_advice'], closingKey: 'closing_birthday' })]);
      expect(await questionsOf(conv.id)).toEqual([]);
    } finally {
      await w.ctx.db.update(s.template).set({ active: true }).where(eq(s.template.id, opener.id));
    }
  });
});
