import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMORY_LINES, REPEAT_LINES, type AiDecision } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { REPEAT_GUARD_ACTION } from '../src/services/inbox/open-question';
import { teardownAll } from './helpers';
import { aiLines, aiWorld, customer, decision, kb, nextPhone, simAccount, staff, teamOf, tick, type AiWorld } from './inbox-ai-support';

/**
 * SCRUM-842 — THE AGE THE CUSTOMER ALREADY SAID IS NEVER ASKED, through the
 * real turn engine (staging, 9 Nov 2026, a park's own WhatsApp number: "do
 * you have drop-off for a six year old?" was answered with "how old is your
 * child?", and the price came only after "she is six years old").
 *
 *   - the turn is told the fact before it decides (`<customer_said>`);
 *   - a draft that is only the age question is decided once more with the
 *     fact, and the answer goes — the age question never does;
 *   - a draft that answers and then asks the age loses the question
 *     server-side, with no second model call and nothing recorded as asked;
 *   - another child's age, never said, is still asked;
 *   - a line with no age changes nothing.
 *
 * FICTIONAL TEST DATA throughout; the fake model only, never the real one.
 */

let w: AiWorld;
let central: string; // a general number at Central, live

const STAGING_LINE = 'ZZ TEST do you have drop-off for a six year old?';
const ANSWER = 'Yes, we do 😊 Our team looks after children in the park while parents shop nearby.';
const AGE_QUESTION = /how old/i;

beforeAll(async () => {
  w = await aiWorld();
  // Due at once: each tick decides the burst just written.
  w.ctx.app.inboxAi.config.debounceMs = 0;
  central = await simAccount(w, { branchId: w.central });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  const [approver] = await staff(w, '+66810084201', 'Known Age Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  await kb(w, approver, {
    key: 'drop-off',
    topic: 'faq',
    language: 'en',
    question: 'Do you have a drop-off service?',
    body: 'Yes: our team looks after children in the park while parents shop nearby (fixture).',
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

const dropOff = (bubbles: string[], askedSlots: AiDecision['askedSlots'] = []) =>
  decision({ intent: 'drop_off_service', grounding: ['drop-off'], reason: 'FACT_IN_KB', bubbles, askedSlots });

/** The customer writes, the model's steps are scripted, one tick decides the burst. */
async function turn(phone: string, text: string, ...decisions: AiDecision[]) {
  const conv = await customer(w, central, phone, text);
  const asked = w.fake.requests.length;
  w.fake.push(...decisions.map((d) => ({ kind: 'decision' as const, decision: d })));
  const sweep = await tick(w, new Date(Date.now() + 500));
  expect(w.fake.remaining).toBe(0);
  return { conv, sweep, prompts: w.fake.requests.slice(asked).map((r) => r.prompt.messages[0].content) };
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

describe('the staging case: "do you have drop-off for a six year old?"', () => {
  it('a draft that only asks the age is decided once more with the fact: the answer goes, the age question never does', async () => {
    const t = await turn(
      nextPhone(),
      STAGING_LINE,
      // What staging did: the model asks what the customer's own line said…
      dropOff(['How old is your little one?'], ['child_age']),
      // …and, told so, answers.
      dropOff([ANSWER]),
    );
    expect(t.sweep.answered).toBe(1);
    // The first prompt already named the fact (the primary mechanism).
    expect(t.prompts).toHaveLength(2);
    expect(t.prompts[0]).toContain('<customer_said>');
    expect(t.prompts[0]).toContain('"customerSaid":"6 years old"');
    expect(t.prompts[0]).toContain(MEMORY_LINES.said);
    // The second pass is given it as the answer the customer already gave.
    expect(t.prompts[1]).toContain('"customerAlreadySaid":"6 years old"');
    expect(t.prompts[1]).toContain(REPEAT_LINES.answered);
    const lines = (await aiLines(w, t.conv.id)).map((l) => l.body ?? '');
    expect(lines).toEqual([ANSWER]);
    expect(lines.filter((l) => AGE_QUESTION.test(l))).toEqual([]);
    // Counted: the guard caught what the prompt did not prevent.
    expect(await guardTrips(t.conv.id)).toEqual([expect.objectContaining({ slot: 'child_age', kind: 'answered', round: 1, outcome: 'rethink', asks: 0 })]);
    // Nothing was asked, so nothing waits for an answer.
    expect(await questionsOf(t.conv.id)).toEqual([]);
  });

  it('a draft that answers and then asks the age loses only the question: one model call, no guard trip, nothing recorded as asked', async () => {
    const t = await turn(nextPhone(), STAGING_LINE, dropOff([ANSWER, 'How old is your little one?'], ['child_age']));
    expect(t.sweep.answered).toBe(1);
    expect(t.prompts).toHaveLength(1);
    expect((await aiLines(w, t.conv.id)).map((l) => l.body)).toEqual([ANSWER]);
    expect(await guardTrips(t.conv.id)).toEqual([]);
    expect(await questionsOf(t.conv.id)).toEqual([]);
  });

  it('the age said in an earlier line of the episode is still known on a later turn', async () => {
    const phone = nextPhone();
    const first = await turn(phone, 'Hi! My daughter is 6 years old', dropOff([ANSWER]));
    expect(first.sweep.answered).toBe(1);
    const t = await turn(phone, 'do you have drop-off?', dropOff(['Yes, we do 😊 Our team is with the children the whole time.', 'How old is she?'], ['child_age']));
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).toContain('"customerSaid":"6 years old"');
    expect((await aiLines(w, t.conv.id)).map((l) => l.body).filter((b) => AGE_QUESTION.test(b ?? ''))).toEqual([]);
    expect(await guardTrips(t.conv.id)).toEqual([]);
  });
});

describe('what was never said is still asked', () => {
  it("another child's age: the question goes and is recorded", async () => {
    const t = await turn(
      nextPhone(),
      'do you have drop-off for a six year old? her brother would come too',
      dropOff(['Yes, we do 😊', 'How old is her brother?'], ['child_age']),
    );
    expect(t.sweep.answered).toBe(1);
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).not.toContain('<customer_said>');
    expect((await aiLines(w, t.conv.id)).map((l) => l.body).join(' ')).toContain('How old is her brother?');
    expect(await guardTrips(t.conv.id)).toEqual([]);
    expect(await questionsOf(t.conv.id)).toEqual([expect.objectContaining({ slot: 'child_age', state: 'open' })]);
  });

  it('a line with no age: the prompt adds nothing and the age question goes as before', async () => {
    const t = await turn(nextPhone(), 'do you have drop-off for 6 kids at 6 pm?', dropOff(['Yes, we do 😊', 'How old are the children?'], ['child_age']));
    expect(t.sweep.answered).toBe(1);
    expect(t.prompts).toHaveLength(1);
    expect(t.prompts[0]).not.toContain('<customer_said>');
    expect((await aiLines(w, t.conv.id)).map((l) => l.body).join(' ')).toContain('How old are the children?');
    expect(await questionsOf(t.conv.id)).toEqual([expect.objectContaining({ slot: 'child_age', state: 'open' })]);
  });
});
