import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPEAT_LINES, type AiDecision } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { eraseOpenQuestionAnswers, loadOpenQuestionMemory, REPEAT_GUARD_ACTION } from '../src/services/inbox/open-question';
import { ADMIN, signInAs, teardownAll } from './helpers';
import {
  SENTINEL,
  aiLines,
  aiWorld,
  call,
  conversationRow,
  customer,
  decision,
  eventsOf,
  kb,
  nextPhone,
  simAccount,
  staff,
  teamOf,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';

/**
 * SCRUM-831 — NEVER ASK TWICE, through the real turn engine (owner, 10 Nov
 * 2026, APPROVED: "the memory is the primary mechanism; the guard is the last
 * net and its firing is counted"). The assistant asked a family "how old will
 * the birthday child be?" twice in one thread after the parent had answered.
 *
 *   - the owner's case replayed: the age asked once, answered "8", the next
 *     turn told so, and a draft that asks it again decided once more with the
 *     fact — the age never goes out twice;
 *   - the table: one row per slot asked, on the line that asked it; answered
 *     with the value read and the line it came from; withdrawn by a hand-over
 *     or a second ask; its CHECKs;
 *   - the guard's hand-over: still asked after the rethink, or asked twice
 *     with no answer, the thread stays with its team and gets its warm line;
 *   - the age as a reflex (an hours question) is refused;
 *   - the counter: one `inbox.ai.repeat_guard` audit row per trip, none on
 *     the happy path; the inbox detail shows what the assistant believes;
 *     the erasure takes the answers.
 *
 * FICTIONAL TEST DATA throughout; the fake model only, never the real one.
 */

let w: AiWorld;
let birthdays: string; // a Birthdays & Events number at Central, live
let birthdaysWide: string; // a Birthdays & Events number with no park: the park is still to ask (SCRUM-832 follow-up)
let general: string; // a general number at Central, live
let adminCookie: string;

beforeAll(async () => {
  w = await aiWorld();
  // Due at once: each tick decides the burst just written, so the lines interleave as in a real chat.
  w.ctx.app.inboxAi.config.debounceMs = 0;
  birthdays = await simAccount(w, { branchId: w.central, defaultCategory: 'birthdays' });
  birthdaysWide = await simAccount(w, { branchId: null, defaultCategory: 'birthdays' });
  general = await simAccount(w, { branchId: w.central });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  const [approver] = await staff(w, '+66810083101', 'Open Question Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  await kb(w, approver, {
    key: 'hours-note',
    topic: 'hours_note',
    language: 'en',
    question: 'When are you open?',
    body: 'We are open every day from 10:00 to 20:00.',
  });
  await kb(w, approver, {
    key: 'drop-off',
    topic: 'faq',
    language: 'en',
    question: 'Do you have a drop-off service?',
    body: 'Yes: our team looks after children in the park while parents shop nearby (fixture).',
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

/** The customer writes, the model's steps are scripted, one tick decides the burst. */
async function turn(account: string, phone: string, text: string, ...decisions: AiDecision[]) {
  const conv = await customer(w, account, phone, text);
  const asked = w.fake.requests.length;
  w.fake.push(...decisions.map((d) => ({ kind: 'decision' as const, decision: d })));
  const sweep = await tick(w, new Date(Date.now() + 500));
  expect(w.fake.remaining).toBe(0);
  return { conv, sweep, prompts: w.fake.requests.slice(asked).map((r) => r.prompt.messages[0].content), requests: w.fake.requests.slice(asked) };
}

async function questionsOf(conversationId: string) {
  return w.ctx.db
    .select()
    .from(s.conversationOpenQuestion)
    .where(eq(s.conversationOpenQuestion.conversationId, conversationId))
    .orderBy(asc(s.conversationOpenQuestion.askedAt), asc(s.conversationOpenQuestion.slot));
}

async function guardTrips(conversationId: string) {
  const rows = await w.ctx.db
    .select({ after: s.auditLog.after })
    .from(s.auditLog)
    .where(and(eq(s.auditLog.action, REPEAT_GUARD_ACTION), sql`${s.auditLog.after}->>'conversationId' = ${conversationId}`))
    .orderBy(asc(s.auditLog.createdAt));
  return rows.map((r) => r.after as Record<string, unknown>);
}

async function customerLines(conversationId: string) {
  return w.ctx.db
    .select({ id: s.message.id, body: s.message.body })
    .from(s.message)
    .where(and(eq(s.message.conversationId, conversationId), eq(s.message.authorKind, 'customer')))
    .orderBy(asc(s.message.createdAt), asc(s.message.id));
}

async function template(key: 'closing_birthday' | 'closing_branch') {
  const [row] = await w.ctx.db
    .select()
    .from(s.template)
    .where(and(eq(s.template.operatorId, w.oto), eq(s.template.key, key), eq(s.template.language, 'en'), sql`${s.template.channel} is null`, sql`${s.template.branchId} is null`))
    .limit(1);
  return row!;
}

const AGE_QUESTION = /how old/i;

describe("the owner's case: the age asked once, answered, never asked again", () => {
  let convId = '';

  it('the age is asked once, on its line, and recorded as the open question', async () => {
    await drain();
    const phone = nextPhone();
    const ask = 'How old will the birthday boy be?';
    // On a number with no park: the combined question below asks the park too (a park's own number never does).
    const t = await turn(
      birthdaysWide,
      phone,
      `Hi! We'd like a birthday party for our son ${SENTINEL}`,
      decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ["Amazing, thank you! We'd love to organize a party for you 🎈", ask], askedSlots: ['child_age'] }),
    );
    convId = t.conv.id;
    expect(t.sweep.answered).toBe(1);
    // A thread with nothing asked yet: the declaration and the age rule ride, no memory block.
    expect(t.prompts[0]).toContain('askedSlots: when a bubble of yours asks');
    expect(t.prompts[0]).not.toContain('<asked_before>');
    // SCRUM-832: the open and the question are one message; the question is recorded on it.
    const lines = await aiLines(w, convId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.body).toContain(ask);
    const [q] = await questionsOf(convId);
    expect(q).toMatchObject({ slot: 'child_age', state: 'open', answer: null, askedMessageId: lines[0]!.id, closedAt: null });
    expect(await guardTrips(convId)).toEqual([]);
  });

  it('the parent answers "8": the reply is read as the answer, the next turn is told so, and nothing trips', async () => {
    const [conv] = await w.ctx.db.select().from(s.conversation).where(eq(s.conversation.id, convId));
    const phone = (await w.ctx.db.select({ handle: s.contact.externalHandle }).from(s.contact).where(eq(s.contact.id, conv!.contactId)))[0]!.handle!.slice(1);
    const next = 'Lovely! What date are you thinking of, roughly how many people, and which park, Central Floresta or Robinson Chalong?';
    const t = await turn(
      birthdaysWide,
      phone,
      '8',
      decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: [next], askedSlots: ['date', 'guests_count', 'park'] }),
    );
    expect(t.sweep.answered).toBe(1);
    expect(t.prompts[0]).toContain('<asked_before>');
    expect(t.prompts[0]).toContain('"slot":"child_age"');
    expect(t.prompts[0]).toContain('"state":"answered","answer":"8"');
    const reply = (await customerLines(convId)).find((l) => l.body === '8')!;
    const qs = await questionsOf(convId);
    expect(qs.find((q) => q.slot === 'child_age')).toMatchObject({ state: 'answered', answer: '8', answeredMessageId: reply.id });
    expect(qs.filter((q) => q.state === 'open').map((q) => q.slot).sort()).toEqual(['date', 'guests_count', 'park']);
    // The happy path: the memory did its work, the guard never fired.
    expect(await guardTrips(convId)).toEqual([]);
  });

  it('a draft asking the age again is decided once more with the fact; the age never goes out twice', async () => {
    const [conv] = await w.ctx.db.select().from(s.conversation).where(eq(s.conversation.id, convId));
    const phone = (await w.ctx.db.select({ handle: s.contact.externalHandle }).from(s.contact).where(eq(s.contact.id, conv!.contactId)))[0]!.handle!.slice(1);
    const t = await turn(
      birthdaysWide,
      phone,
      '14 November, about 15 kids at Central Floresta',
      // The owner's case: the model asks the age again…
      decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ['Perfect! And how old will the birthday boy be?'], askedSlots: ['child_age'] }),
      // …and, told what the parent said, hands the party to the birthday team.
      decision({ intent: 'birthday_details', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }),
    );
    expect(t.sweep.handedOver).toBe(1);
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[1]).toContain('<already_answered>');
    expect(t.prompts[1]).toContain('"customerAlreadySaid":"8 years old"');
    expect(t.prompts[1]).toContain(REPEAT_LINES.answered);
    const lines = await aiLines(w, convId);
    expect(lines.filter((l) => AGE_QUESTION.test(l.body ?? ''))).toHaveLength(1);
    expect(lines.at(-1)!.body).toBe((await template('closing_birthday')).body);
    // Counted: one trip, the slot and why; the rethink fixed it.
    expect(await guardTrips(convId)).toEqual([
      expect.objectContaining({ slot: 'child_age', kind: 'answered', round: 1, outcome: 'rethink', asks: 1 }),
    ]);
    // The basics were read as the answers; the hand-over closed what was left.
    const qs = await questionsOf(convId);
    expect(qs.find((q) => q.slot === 'date')).toMatchObject({ state: 'answered', answer: expect.stringMatching(/^\d{4}-11-14$/) });
    expect(qs.find((q) => q.slot === 'guests_count')).toMatchObject({ state: 'answered', answer: '15 kids' });
    expect(qs.find((q) => q.slot === 'park')).toMatchObject({ state: 'answered', answer: 'central' });
    expect(qs.filter((q) => q.state === 'open')).toEqual([]);
  });

  it('the inbox shows what the assistant believes, under the line that asked', async () => {
    const lines = await aiLines(w, convId);
    const res = await call<{ openQuestions: Array<{ slot: string; state: string; answer: string | null; askedMessageId: string }> }>(
      w,
      adminCookie,
      'GET',
      `/inbox/conversations/${convId}`,
    );
    expect(res.status).toBe(200);
    // SCRUM-832: the first reply was one message, the age asked in it.
    expect(res.body.openQuestions[0]).toMatchObject({ slot: 'child_age', state: 'answered', answer: '8', askedMessageId: lines[0]!.id });
    expect(res.body.openQuestions.map((q) => q.slot)).toEqual(expect.arrayContaining(['child_age', 'date', 'guests_count', 'park']));
  });

  it('the erasure takes the answers with the words; the rows keep their slots', async () => {
    const [conv] = await w.ctx.db.select().from(s.conversation).where(eq(s.conversation.id, convId));
    await w.ctx.db.transaction(async (tx) => {
      expect(await eraseOpenQuestionAnswers(tx, conv!.operatorId, [convId], new Date())).toBe(4);
    });
    const qs = await questionsOf(convId);
    expect(qs.every((q) => q.answer === null)).toBe(true);
    expect(qs.map((q) => q.slot)).toHaveLength(4);
  });
});

/**
 * A real pause before the customer's next line. A provider stamps a line in
 * whole seconds and never ahead of the clock, so a line written within the
 * second of the park's last one can sort before it; these tests need the
 * thread in the order it was written.
 */
const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1_100));

/** The customer writes after a pause, and one tick at the moment decides the burst with the scripted steps. */
async function inOrder(account: string, phone: string, text: string, ...decisions: AiDecision[]) {
  await nextSecond();
  const conv = await customer(w, account, phone, text);
  const asked = w.fake.requests.length;
  w.fake.push(...decisions.map((d) => ({ kind: 'decision' as const, decision: d })));
  const sweep = await tick(w, new Date());
  expect(w.fake.remaining).toBe(0);
  // The send job is not this suite's: the assistant's lines left (a queued line a person's reply withdraws never asked anything).
  await w.ctx.db
    .update(s.message)
    .set({ providerStatus: 'sent' })
    .where(and(eq(s.message.conversationId, conv.id), eq(s.message.authorKind, 'ai'), eq(s.message.providerStatus, 'queued')));
  return { conv, sweep, prompts: w.fake.requests.slice(asked).map((r) => r.prompt.messages[0].content) };
}

describe('the reply read is the first reply only (SCRUM-831 review)', () => {
  it('the age asked, an off-topic reply, then a later line with a number: the age stays unread', async () => {
    await drain();
    const phone = nextPhone();
    const first = await inOrder(
      birthdays,
      phone,
      `A birthday party for my son please ${SENTINEL}`,
      decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ['How old will the birthday boy be? 🎈'], askedSlots: ['child_age'] }),
    );
    expect(first.sweep.answered).toBe(1);
    const convId = first.conv.id;
    // The first reply asks something else: no answer, the question stays open.
    const second = await inOrder(
      birthdays,
      phone,
      'how much is it?',
      decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ['Our birthday team will share the packages and prices with you 😊'] }),
    );
    expect(second.sweep.answered).toBe(1);
    // A later line with a number is never read as the age.
    const third = await inOrder(birthdays, phone, '8', decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ['Thank you! 😊'] }));
    const thirdPrompt = third.prompts[0]!;
    expect(third.sweep.answered).toBe(1);
    expect(thirdPrompt).toContain('"slot":"child_age"');
    expect(thirdPrompt).toContain('"state":"open","answer":null');
    const [q] = await questionsOf(convId);
    expect(q).toMatchObject({ slot: 'child_age', state: 'open', answer: null, answeredMessageId: null });
    expect(await guardTrips(convId)).toEqual([]);
  }, 60_000);

  it('a question a person took over is still answered by the reply to them: a hand-over, "8", a staff line, Resume, and the re-ask is refused with the fact', async () => {
    await drain();
    const reception = await teamOf(w, 'reception', w.central);
    const [, cookie] = await staff(w, '+66810083102', 'Open Question Test Agent', 'inbox_agent', { scopeType: 'department', scopeId: reception.departmentId! });
    const phone = nextPhone();
    const askAge = (text: string) =>
      decision({ intent: 'drop_off_service', grounding: ['drop-off'], reason: 'FACT_IN_KB', bubbles: [text], askedSlots: ['child_age'] });

    const { conv, sweep } = await inOrder(general, phone, `Do you have a drop-off service? ${SENTINEL}`, askAge('Yes we do 😊 How old is your little one?'));
    expect(sweep.answered).toBe(1);
    const handover = await inOrder(
      general,
      phone,
      'can I talk to a person please',
      decision({ intent: 'human_requested', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }),
    );
    expect(handover.sweep.handedOver).toBe(1);
    // The hand-over withdrew the open question: a person has the thread.
    expect((await questionsOf(conv.id))[0]).toMatchObject({ slot: 'child_age', state: 'withdrawn', answer: null });
    await nextSecond();
    await customer(w, general, phone, '8');
    expect((await turnsOf(w, conv.id)).filter((t) => t.state === 'pending')).toHaveLength(0);
    const eight = (await customerLines(conv.id)).find((l) => l.body === '8')!;
    const reply = await w.ctx.app.inject({
      method: 'POST',
      url: `/inbox/conversations/${conv.id}/messages`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { id: newId(), text: `Thanks! Our drop-off team will be happy to help ${SENTINEL}` },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    expect((await call(w, cookie, 'POST', `/inbox/conversations/${conv.id}/ai-resume`)).status).toBe(200);
    const t = await inOrder(
      general,
      phone,
      'Great, is drop-off open every day?',
      // The owner's case again: the model asks the age the parent gave the person…
      askAge('Yes, every day 😊 And how old is your little one?'),
      // …and, told what the parent said, answers without it.
      decision({ intent: 'drop_off_service', grounding: ['drop-off'], reason: 'FACT_IN_KB', bubbles: ['Yes, every day 😊'] }),
    );
    expect(t.sweep.answered).toBe(1);
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[0]).toContain('"state":"answered","answer":"8"');
    expect(t.prompts[1]).toContain('"customerAlreadySaid":"8 years old"');
    expect((await aiLines(w, conv.id)).filter((l) => AGE_QUESTION.test(l.body ?? ''))).toHaveLength(1);
    expect((await questionsOf(conv.id))[0]).toMatchObject({ slot: 'child_age', state: 'answered', answer: '8', answeredMessageId: eight.id });
    expect(await guardTrips(conv.id)).toEqual([expect.objectContaining({ slot: 'child_age', kind: 'answered', round: 1, outcome: 'rethink' })]);
  }, 60_000);
});

describe("the guard's hand-over: the thread stays with its team and gets its warm line", () => {
  it('still asked after the rethink: handed over, the closing line goes, never the second ask', async () => {
    await drain();
    const phone = nextPhone();
    const first = await turn(
      general,
      phone,
      `Do you have a drop-off service? ${SENTINEL}`,
      decision({ intent: 'drop_off_service', grounding: ['drop-off'], reason: 'FACT_IN_KB', bubbles: ['Yes we do 😊 How old is your little one?'], askedSlots: ['child_age'] }),
    );
    expect(first.sweep.answered).toBe(1);
    const again = (text: string) =>
      decision({ intent: 'drop_off_service', grounding: ['drop-off'], reason: 'FACT_IN_KB', bubbles: [text], askedSlots: ['child_age'] });
    const t = await turn(general, phone, 'she is five', again('Great! And how old is she exactly?'), again('Sure! How old is she?'));
    expect(t.sweep.handedOver).toBe(1);
    const convId = first.conv.id;
    const [row] = await turnsOf(w, convId).then((ts) => ts.slice(-1));
    expect(row).toMatchObject({ state: 'handed_over', reason: 'REPEAT_QUESTION' });
    const lines = await aiLines(w, convId);
    expect(lines.filter((l) => AGE_QUESTION.test(l.body ?? ''))).toHaveLength(1);
    expect(lines.at(-1)!.body).toBe((await template('closing_branch')).body);
    const handover = (await eventsOf(w, convId)).filter((e) => e.kind === 'ai_handover').at(-1)!;
    expect(handover.payload).toMatchObject({ rule: 'repeat_question', destination: 'general' });
    // The thread stays with Central's reception.
    expect(await conversationRow(w, convId)).toMatchObject({ category: 'general', teamId: (await teamOf(w, 'reception', w.central)).id });
    expect(await guardTrips(convId)).toEqual([
      expect.objectContaining({ slot: 'child_age', kind: 'answered', round: 1, outcome: 'rethink' }),
      expect.objectContaining({ slot: 'child_age', kind: 'answered', round: 2, outcome: 'handover' }),
    ]);
    expect((await questionsOf(convId)).find((q) => q.slot === 'child_age')).toMatchObject({ state: 'answered', answer: '5' });
  });

  it('asked twice with no answer: the third ask hands over at once, with no second model call', async () => {
    await drain();
    const phone = nextPhone();
    const askDate = (text: string) => decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: [text], askedSlots: ['date'] });
    const first = await turn(birthdays, phone, `Hello, a birthday party please ${SENTINEL}`, askDate('Amazing! What date are you thinking of?'));
    const convId = first.conv.id;
    // Not an answer: the question stays open, and one more ask may go.
    expect((await turn(birthdays, phone, 'how much is it?', askDate('Our birthday team will share the packages! What date are you thinking of?'))).sweep.answered).toBe(1);
    let qs = await questionsOf(convId);
    expect(qs.map((q) => q.state)).toEqual(['withdrawn', 'open']);
    const t = await turn(birthdays, phone, 'hmm not sure', askDate('No problem! Which date would suit you?'));
    expect(t.prompts).toHaveLength(1);
    expect(t.sweep.handedOver).toBe(1);
    expect((await turnsOf(w, convId)).at(-1)).toMatchObject({ state: 'handed_over', reason: 'REPEAT_QUESTION' });
    expect((await aiLines(w, convId)).at(-1)!.body).toBe((await template('closing_birthday')).body);
    expect(await guardTrips(convId)).toEqual([expect.objectContaining({ slot: 'date', kind: 'asked_twice', asks: 2, round: 1, outcome: 'handover' })]);
    qs = await questionsOf(convId);
    expect(qs.filter((q) => q.state === 'open')).toEqual([]);
  });
});

describe("the child's age only where the playbook needs it", () => {
  it('an hours answer that asks the age as a reflex is decided once more without it', async () => {
    await drain();
    const hours = (bubbles: string[]) =>
      decision({ intent: 'hours', grounding: ['hours-note'], reason: 'FACT_IN_KB', bubbles, askedSlots: bubbles.length > 1 ? ['child_age'] : [] });
    const t = await turn(
      general,
      nextPhone(),
      `What time do you open? ${SENTINEL}`,
      hours(['We are open every day from 10:00 to 20:00 😊', 'How old are your kids?']),
      hours(['We are open every day from 10:00 to 20:00 😊']),
    );
    expect(t.sweep.answered).toBe(1);
    expect(t.prompts[1]).toContain(REPEAT_LINES.not_needed);
    expect((await aiLines(w, t.conv.id)).map((l) => l.body)).toEqual(['We are open every day from 10:00 to 20:00 😊']);
    expect(await guardTrips(t.conv.id)).toEqual([expect.objectContaining({ slot: 'child_age', kind: 'not_needed', outcome: 'rethink' })]);
    expect(await questionsOf(t.conv.id)).toEqual([]);
  });
});

describe('the effort of an open-question turn', () => {
  it('runs at the configured effort only while a question is open; unset, every turn runs at the client’s own', async () => {
    await drain();
    w.ctx.app.inboxAi.config.openQuestionEffort = 'medium';
    try {
      const phone = nextPhone();
      const first = await turn(
        birthdays,
        phone,
        `A party for my daughter please ${SENTINEL}`,
        decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ['How old will she be?'], askedSlots: ['child_age'] }),
      );
      expect(first.requests[0]!.effort).toBeUndefined();
      const second = await turn(birthdays, phone, 'แปดขวบค่ะ', decision({ language: 'th', intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ['ขอบคุณค่ะ 😊'] }));
      expect(second.requests[0]!.effort).toBe('medium');
      expect((await questionsOf(first.conv.id))[0]).toMatchObject({ state: 'answered', answer: '8' });
    } finally {
      w.ctx.app.inboxAi.config.openQuestionEffort = null;
    }
  });
});

describe('the table: inbox.conversation_open_question', () => {
  it('holds its shape by CHECK: an answer is short, answered says by which line, one open row per slot', async () => {
    const [q] = await w.ctx.db.select().from(s.conversationOpenQuestion).limit(1);
    type Row = typeof s.conversationOpenQuestion.$inferInsert;
    const base: Row = { ...q!, id: newId(), state: 'withdrawn', closedAt: new Date(), answer: null, answeredMessageId: null };
    // A valid closed row goes in.
    await w.ctx.db.insert(s.conversationOpenQuestion).values(base);
    const refused = async (row: Partial<Row>) =>
      expect(w.ctx.db.insert(s.conversationOpenQuestion).values({ ...base, id: newId(), ...row })).rejects.toThrow();
    await refused({ state: 'answered', answer: '8', answeredMessageId: null });
    await refused({ state: 'open', closedAt: null, answer: '8' });
    await refused({ slot: 'shoe_size' as never });
    await refused({ state: 'answered', answeredMessageId: q!.askedMessageId, answer: 'x'.repeat(41) });
    // One open question per slot per thread.
    const open: Row = { ...base, state: 'open', closedAt: null, slot: 'package' };
    await w.ctx.db.insert(s.conversationOpenQuestion).values({ ...open, id: newId() });
    await expect(w.ctx.db.insert(s.conversationOpenQuestion).values({ ...open, id: newId() })).rejects.toThrow();
  });

  it('a question whose line never left was never asked: withdrawn, not counted, not in the prompt', async () => {
    await drain();
    const t = await turn(
      general,
      nextPhone(),
      `Do you do drop-off? ${SENTINEL}`,
      decision({ intent: 'drop_off_service', grounding: ['drop-off'], reason: 'FACT_IN_KB', bubbles: ['Yes we do 😊 How old is your little one?'], askedSlots: ['child_age'] }),
    );
    const [q] = await questionsOf(t.conv.id);
    // A person acted before the line left: it was withdrawn on the timeline (plan §A.3).
    await w.ctx.db.update(s.message).set({ providerStatus: 'withdrawn' }).where(eq(s.message.id, q!.askedMessageId));
    const episode = (await w.ctx.db.select().from(s.message).where(eq(s.message.conversationId, t.conv.id))).map((m) => ({
      id: m.id,
      from: m.authorKind,
      at: m.createdAt,
      text: m.body,
    }));
    const memory = await loadOpenQuestionMemory(w.ctx.db, t.conv, new Date(Date.now() - 3_600_000), episode, [], new Date());
    expect(memory.questions).toEqual([]);
    expect(memory.withdrawals).toEqual([{ id: q!.id, slot: 'child_age' }]);
    expect(memory.hadOpen).toBe(false);
  });

  it('shadow mode asks nothing of the customer, so nothing is recorded', async () => {
    await drain();
    const shadow = await simAccount(w, { branchId: w.central, aiMode: 'shadow', defaultCategory: 'birthdays' });
    const t = await turn(
      shadow,
      nextPhone(),
      `Birthday party please ${SENTINEL}`,
      decision({ intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: ['How old will the birthday child be?'], askedSlots: ['child_age'] }),
    );
    expect(t.sweep.shadowed).toBe(1);
    expect(await questionsOf(t.conv.id)).toEqual([]);
  });
});
