import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BIRTHDAY_THREAD_LINES, type BuiltPrompt, type TurnContext } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { teardownAll } from './helpers';
import {
  ON_DEFAULT_QUEUE,
  aiLines,
  aiWorld,
  conversationRow,
  customer,
  decision,
  eventsOf,
  kb,
  later,
  nextPhone,
  simAccount,
  staff,
  teamOf,
  tick,
  turnsOf,
  type AiWorld,
} from './inbox-ai-support';

/**
 * SCRUM-817, THE BIRTHDAY THREAD'S DATE IN THE TURN ENGINE. On staging (the
 * simulator, 10 November, during the SCRUM-814 proof) a Birthdays & Events
 * conversation got "бронировать не нужно" and the opening hours for "Можно в
 * субботу в 2 часа дня?" (can we do Saturday at 2 pm?): the model read the
 * party's date as a walk-in question. Here, against a real embedded database
 * and the `FakeAssistantClient` scripted with that very reading:
 *
 *   - the model is told the conversation's category, and on a birthday
 *     thread that a day, a date or a time is the party's;
 *   - the gate overrules the walk-in label: the family gets the birthday
 *     manager's closing line, the Birthday & events team has the thread, and
 *     the turn says why (`OVERRULED_BIRTHDAY`, rule `birthday_date`);
 *   - a thread whose earlier reply was the birthday question is a birthday
 *     thread too;
 *   - the same words in a general thread keep the model's answer.
 *
 * FICTIONAL TEST DATA throughout.
 */

/** The prompts the engine built, observed: `buildPrompt` is the real one, recorded. */
const seen = vi.hoisted(() => ({ contexts: [] as unknown[], users: [] as string[] }));
vi.mock('@oto/assistant', async (importOriginal) => {
  const real = await importOriginal<typeof import('@oto/assistant')>();
  return {
    ...real,
    buildPrompt: (input: Parameters<typeof real.buildPrompt>[0]) => {
      seen.contexts.push(input.context);
      const built = real.buildPrompt(input);
      if (built.ok) seen.users.push((built.prompt as BuiltPrompt).messages[0].content);
      return built;
    },
  };
});

let w: AiWorld;
let birthdays: string; // a Birthdays & Events number at Central, live
let general: string; // a general number at Central, live

const RU = 'Можно в субботу в 2 часа дня?';
/** The staging reply, as the model labelled it: a walk-in FAQ, grounded in an approved entry. */
const WALK_IN = 'Бронировать не нужно, приходите в любое время 😊';
const walkIn = () =>
  decision({ language: 'ru', intent: 'faq', grounding: ['faq.booking'], reason: 'FACT_IN_KB', bubbles: [WALK_IN] });

beforeAll(async () => {
  w = await aiWorld();
  birthdays = await simAccount(w, { branchId: w.central, defaultCategory: 'birthdays' });
  general = await simAccount(w, { branchId: w.central });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  const [approver] = await staff(w, '+66810008171', 'Birthday Date Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
  await kb(w, approver, {
    key: 'faq.booking',
    topic: 'faq',
    language: 'ru',
    question: 'Нужно ли бронировать визит?',
    body: 'Бронировать не нужно: приходите в любое время работы парка.',
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

/** Settle every turn due now, so a test starts from a quiet queue. */
async function drain(): Promise<void> {
  await w.ctx.db
    .update(s.aiTurn)
    .set({ state: 'cancelled', reason: 'TEST_DRAIN', leaseUntil: null })
    .where(sql`state in ('pending','deciding')`);
}

async function closingBirthdayRu() {
  const [row] = await w.ctx.db
    .select()
    .from(s.template)
    .where(
      and(
        eq(s.template.operatorId, w.oto),
        eq(s.template.key, 'closing_birthday'),
        eq(s.template.language, 'ru'),
        isNull(s.template.channel),
        isNull(s.template.branchId),
        isNull(s.template.archivedAt),
      ),
    )
    .limit(1);
  expect(row!.needsTranslation).toBe(false);
  return row!;
}

describe('SCRUM-817: a day, a date or a time in a birthday thread is the party’s', () => {
  it('Birthdays & Events, the Russian line read as a walk-in FAQ: the birthday manager’s line goes, never the FAQ answer', async () => {
    await drain();
    seen.contexts.length = 0;
    seen.users.length = 0;
    const conv = await customer(w, birthdays, '79161238171', RU);
    expect(conv.category).toBe('birthdays');
    w.fake.push({ kind: 'decision', decision: walkIn() });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);

    // Layer 1: the model was told the category, and that the date is the party's.
    expect((seen.contexts.at(-1) as TurnContext).threadCategory).toBe('birthdays');
    const user = seen.users.at(-1)!;
    expect(user).toContain('"threadCategory":"birthdays"');
    expect(user).toContain(`${BIRTHDAY_THREAD_LINES.category} ${BIRTHDAY_THREAD_LINES.rule}`);

    // Layer 2: the walk-in label was overruled; the family gets the birthday flow's closing line.
    const closing = await closingBirthdayRu();
    const lines = await aiLines(w, conv.id);
    expect(lines.map((l) => ({ body: l.body, templateId: l.templateId, bodyLanguage: l.bodyLanguage }))).toEqual([
      { body: closing.body, templateId: closing.id, bodyLanguage: 'ru' },
    ]);
    expect(lines.map((l) => l.body).join(' ')).not.toContain('Бронировать');
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({
      state: 'handed_over',
      reason: 'OVERRULED_BIRTHDAY',
      intent: 'birthday_details',
      action: 'handover',
    });
    const handover = (await eventsOf(w, conv.id)).find((e) => e.kind === 'ai_handover');
    expect(handover!.payload).toMatchObject({
      intent: 'birthday_details',
      reason: 'OVERRULED_BIRTHDAY',
      rule: 'birthday_date',
      destination: 'birthdays',
      templateKey: 'closing_birthday',
      closingKey: 'closing_birthday',
      holdingLine: 'template',
    });
    const team = await teamOf(w, 'birthdays');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'birthdays', teamId: team.id, intent: 'birthday_details' });
  });

  it('a general thread whose earlier reply was the birthday question: the date is the party’s, and Birthdays takes it', async () => {
    await drain();
    seen.contexts.length = 0;
    seen.users.length = 0;
    const phone = nextPhone();
    // SCRUM-830 would route this opener to Birthdays at ingest; the hint keeps the thread general,
    // which is what this scenario (a birthday reply EARLIER in a general thread) is about.
    const conv = await customer(w, general, phone, 'Хотим отметить день рождения сына у вас', ON_DEFAULT_QUEUE);
    const ask = 'Как здорово, спасибо! Будем рады организовать праздник. Сколько примерно будет гостей и в каком парке, Central Floresta или Robinson Chalong?';
    w.fake.push({ kind: 'decision', decision: decision({ language: 'ru', intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: [ask] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general' });
    // A general thread with no birthday reply yet: its category, no birthday line.
    expect(seen.users.at(-1)).toContain('"threadCategory":"general"');
    expect(seen.users.at(-1)).not.toContain(BIRTHDAY_THREAD_LINES.rule);

    await customer(w, general, phone, RU);
    w.fake.push({ kind: 'decision', decision: walkIn() });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const second = seen.contexts.at(-1) as TurnContext;
    expect(second.threadCategory).toBe('general');
    expect(second.earlierIntents).toEqual(['birthday_party']);
    expect(seen.users.at(-1)).toContain(`${BIRTHDAY_THREAD_LINES.earlier} ${BIRTHDAY_THREAD_LINES.rule}`);

    const closing = await closingBirthdayRu();
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([ask, closing.body]);
    expect((await turnsOf(w, conv.id))[1]).toMatchObject({ state: 'handed_over', reason: 'OVERRULED_BIRTHDAY', intent: 'birthday_details' });
    const team = await teamOf(w, 'birthdays');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'birthdays', teamId: team.id });
  });

  it('the same words in a general thread with no party in it: the model’s label stands and its answer goes', async () => {
    await drain();
    seen.users.length = 0;
    const conv = await customer(w, general, nextPhone(), RU);
    w.fake.push({ kind: 'decision', decision: walkIn() });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect(seen.users.at(-1)).not.toContain(BIRTHDAY_THREAD_LINES.rule);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([WALK_IN]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'answered', reason: 'OK', intent: 'faq' });
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'general' });
  });

  it('the model reading the party in a Birthdays & Events thread: its one birthday question goes, nothing is overruled', async () => {
    await drain();
    const conv = await customer(w, birthdays, nextPhone(), RU);
    const ask = 'Как здорово, спасибо! Будем рады организовать праздник. Сколько примерно будет гостей и в каком парке, Central Floresta или Robinson Chalong?';
    w.fake.push({ kind: 'decision', decision: decision({ language: 'ru', intent: 'birthday_party', reason: 'CLEAR_INTENT', bubbles: [ask] }) });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([ask]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'answered', reason: 'OK', intent: 'birthday_party' });
  });
});
