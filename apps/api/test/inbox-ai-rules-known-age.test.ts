import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiDecision } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { newId } from '@oto/shared';
import { teardownAll } from './helpers';
import { aiLines, aiWorld, call, customer, decision, eventsOf, kb, nextPhone, simAccount, staff, teamOf, tick, type AiWorld } from './inbox-ai-support';

/**
 * SCRUM-842 — AN ASK-FIRST RULE NEVER ASKS WHAT THE FAMILY ALREADY SAID,
 * through the real turn engine (staging, 11 Nov 2026, a park's own WhatsApp
 * number: an approved team rule on drop_off_service put "Happy to help! How
 * old is your child?" after "do you have drop-off for a six year old?").
 *
 *   - the staging line, in English, Russian and Thai: the rule's question is
 *     NOT sent, the model's own answer goes, and the reply's pill records the
 *     rule as satisfied (`already_said`) — never as asked;
 *   - the age given earlier in the episode counts the same;
 *   - no age said: the rule's question goes exactly as before;
 *   - a rule asking something else still asks, whatever age was said;
 *   - a satisfied rule did not spend the episode's one ask-first question.
 *
 * FICTIONAL TEST DATA throughout; the fake model only, never the real one.
 */

let w: AiWorld;
let central: string; // a general number at Central, live
let editorCookie: string;

const STAGING_LINE = 'ZZ TEST do you have drop-off for a six year old?';
const QUESTION = { en: 'Happy to help! How old is your child?', th: 'ยินดีค่ะ น้องอายุกี่ขวบคะ', ru: 'С радостью помогу! Сколько лет ребёнку?' };
const DAY_QUESTION = 'Happy to help! Which day would you like to come?';
const ANSWER = 'Yes, we do 😊 Our team looks after children in the park while parents shop nearby.';
const ANSWER_RU = 'Да, конечно 😊 Наша команда присматривает за детьми в парке, пока родители рядом.';
const ANSWER_TH = 'มีค่ะ 😊 ทีมงานของเราดูแลเด็กๆ ในสวนสนุกระหว่างที่ผู้ปกครองอยู่ใกล้ๆ ค่ะ';

beforeAll(async () => {
  w = await aiWorld();
  // Due at once: each tick decides the burst just written.
  w.ctx.app.inboxAi.config.debounceMs = 0;
  central = await simAccount(w, { branchId: w.central });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  const [approver] = await staff(w, '+66810084211', 'Rule Age Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  for (const language of ['en', 'ru', 'th'] as const) {
    await kb(w, approver, {
      key: `drop-off-${language}`,
      topic: 'faq',
      language,
      question: 'Do you have a drop-off service?',
      body: 'Yes: our team looks after children in the park while parents shop nearby (fixture).',
    });
  }
  const marketing = await teamOf(w, 'marketing');
  const kbRole = newId();
  await w.ctx.db.insert(s.role).values({ id: kbRole, operatorId: w.oto, name: 'rule_age_editor_test', description: 'Rule editor' });
  await w.ctx.db.insert(s.rolePermission).values({ id: newId(), roleId: kbRole, permission: 'inbox:kb:manage' });
  [, editorCookie] = await staff(w, '+66810084212', 'Rule Age Test Editor', 'rule_age_editor_test', {
    scopeType: 'department',
    scopeId: marketing.departmentId!,
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

async function approvedRule(body: Record<string, unknown>): Promise<string> {
  const made = await call<{ id: string }>(w, editorCookie, 'POST', '/inbox/ai/rules', body);
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const approved = await call<{ id: string }>(w, editorCookie, 'POST', `/inbox/ai/rules/${made.body.id}/approve`);
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return made.body.id;
}

/** Only the rules a check names are live. */
async function onlyRules(...bodies: Array<Record<string, unknown>>): Promise<string[]> {
  await w.ctx.db.update(s.aiRule).set({ status: 'archived' }).where(sql`status <> 'archived'`);
  const ids: string[] = [];
  for (const b of bodies) ids.push(await approvedRule(b));
  return ids;
}

const AGE_RULE = {
  intent: 'drop_off_service',
  instruction: 'Before the drop-off details, find out how old the child is.',
  askFirst: { condition: 'always', question: QUESTION },
};
const DAY_RULE = {
  intent: 'drop_off_service',
  instruction: 'Find out which day they plan to come.',
  askFirst: { condition: 'always', question: { en: DAY_QUESTION } },
};

const dropOff = (bubbles: string[], over: Partial<AiDecision> = {}) =>
  decision({ intent: 'drop_off_service', grounding: [`drop-off-${over.language ?? 'en'}`], reason: 'FACT_IN_KB', bubbles, ...over });

/** The customer writes, the model's step is scripted, one tick decides the burst. */
async function turn(phone: string, text: string, d: AiDecision) {
  const conv = await customer(w, central, phone, text);
  w.fake.push({ kind: 'decision', decision: d });
  const sweep = await tick(w, new Date(Date.now() + 500));
  expect(w.fake.remaining).toBe(0);
  return { conv, sweep };
}

const bodies = async (conversationId: string) => (await aiLines(w, conversationId)).map((l) => l.body);
const replies = async (conversationId: string) =>
  (await eventsOf(w, conversationId)).filter((e) => e.kind === 'ai_replied').map((e) => e.payload as Record<string, unknown>);

describe('the staging case: an approved ask-first rule on drop_off_service, and the age already said', () => {
  let ruleId = '';

  beforeAll(async () => {
    [ruleId] = (await onlyRules(AGE_RULE)) as [string];
  });

  it("the exact staging line: the rule's question is not sent, the model's answer goes, the pill records the rule as satisfied", async () => {
    const t = await turn(nextPhone(), STAGING_LINE, dropOff([ANSWER]));
    expect(t.sweep.answered).toBe(1);
    expect(await bodies(t.conv.id)).toEqual([ANSWER]);
    const [pill] = await replies(t.conv.id);
    expect(pill).toMatchObject({ intent: 'drop_off_service', askFirstSatisfied: [{ ruleId, reason: 'already_said', slots: ['child_age'] }] });
    expect(pill).not.toHaveProperty('askFirstRuleId');
  });

  it("the model's own age question after its answer is cut as on any turn: nothing asks the age", async () => {
    const t = await turn(nextPhone(), STAGING_LINE, dropOff([ANSWER, 'How old is your little one?'], { askedSlots: ['child_age'] }));
    expect(t.sweep.answered).toBe(1);
    expect(await bodies(t.conv.id)).toEqual([ANSWER]);
  });

  it('in Russian and in Thai', async () => {
    const ru = await turn(nextPhone(), 'ZZ TEST у вас есть дроп-офф для шестилетнего ребёнка?', dropOff([ANSWER_RU], { language: 'ru' }));
    expect(await bodies(ru.conv.id)).toEqual([ANSWER_RU]);
    expect((await replies(ru.conv.id))[0]).toMatchObject({ askFirstSatisfied: [{ ruleId, reason: 'already_said' }] });
    const ru2 = await turn(nextPhone(), 'ZZ TEST есть дроп-офф? дочке шесть лет', dropOff([ANSWER_RU], { language: 'ru' }));
    expect(await bodies(ru2.conv.id)).toEqual([ANSWER_RU]);
    const th = await turn(nextPhone(), 'ZZ TEST มีบริการรับฝากเด็กไหมคะ ลูก 6 ขวบค่ะ', dropOff([ANSWER_TH], { language: 'th' }));
    expect(await bodies(th.conv.id)).toEqual([ANSWER_TH]);
    expect((await replies(th.conv.id))[0]).toMatchObject({ askFirstSatisfied: [{ ruleId, reason: 'already_said' }] });
  });

  it('the age given earlier in the episode: not asked on the later turn', async () => {
    const phone = nextPhone();
    const first = await turn(phone, 'Hi! My daughter is 6 years old', decision({ intent: 'greeting', reason: 'CLEAR_INTENT', bubbles: ['Hello! 😊 How can we help?'] }));
    expect(first.sweep.answered).toBe(1);
    const t = await turn(phone, 'do you have drop-off?', dropOff([ANSWER]));
    expect(t.sweep.answered).toBe(1);
    expect(await bodies(t.conv.id)).toEqual(['Hello! 😊 How can we help?', ANSWER]);
    expect((await replies(t.conv.id)).at(-1)).toMatchObject({ askFirstSatisfied: [{ ruleId, reason: 'already_said' }] });
  });

  it("no age said: the rule's question goes exactly as before, in the customer's language, once", async () => {
    const phone = nextPhone();
    const t = await turn(phone, 'ZZ TEST do you have drop-off?', dropOff([ANSWER]));
    expect(t.sweep.answered).toBe(1);
    expect(await bodies(t.conv.id)).toEqual([QUESTION.en]);
    const [pill] = await replies(t.conv.id);
    expect(pill).toMatchObject({ askFirstRuleId: ruleId });
    expect(pill).not.toHaveProperty('askFirstSatisfied');
    // A count and a time are no age.
    const count = await turn(nextPhone(), 'do you have drop-off for 6 kids at 6 pm?', dropOff([ANSWER]));
    expect(await bodies(count.conv.id)).toEqual([QUESTION.en]);
    const ru = await turn(nextPhone(), 'ZZ TEST у вас есть дроп-офф?', dropOff([ANSWER_RU], { language: 'ru' }));
    expect(await bodies(ru.conv.id)).toEqual([QUESTION.ru]);
    // The answer to the rule's question, then the answer; the question is never put twice.
    const next = await turn(phone, 'she is six', dropOff([ANSWER]));
    expect(next.sweep.answered).toBe(1);
    expect(await bodies(t.conv.id)).toEqual([QUESTION.en, ANSWER]);
  });

  it("another child comes in with no age: the rule's question is asked", async () => {
    const t = await turn(nextPhone(), 'do you have drop-off for a six year old? her brother would come too', dropOff([ANSWER]));
    expect(await bodies(t.conv.id)).toEqual([QUESTION.en]);
  });
});

describe('a rule that asks something else is unchanged', () => {
  it('a day question on the same intent still goes, whatever age was said', async () => {
    const [dayId] = await onlyRules(DAY_RULE);
    const t = await turn(nextPhone(), STAGING_LINE, dropOff([ANSWER]));
    expect(t.sweep.answered).toBe(1);
    expect(await bodies(t.conv.id)).toEqual([DAY_QUESTION]);
    const [pill] = await replies(t.conv.id);
    expect(pill).toMatchObject({ askFirstRuleId: dayId });
    expect(pill).not.toHaveProperty('askFirstSatisfied');
  });

  it('beside a satisfied age rule, the day rule asks: the satisfied one spent nothing, and both are on the pill', async () => {
    const ids = await onlyRules(AGE_RULE, DAY_RULE);
    const t = await turn(nextPhone(), STAGING_LINE, dropOff([ANSWER]));
    expect(await bodies(t.conv.id)).toEqual([DAY_QUESTION]);
    const [pill] = await replies(t.conv.id);
    const satisfied = (pill!['askFirstSatisfied'] as Array<{ ruleId: string }>).map((x) => x.ruleId);
    expect(ids).toContain(pill!['askFirstRuleId']);
    expect(ids).toContain(satisfied[0]);
    expect(satisfied).toHaveLength(1);
    expect(satisfied[0]).not.toBe(pill!['askFirstRuleId']);
  });
});
