import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAMPS_PLAN } from '@oto/assistant';
import { schema as s } from '@oto/db';
import { INBOX_TEMPLATE_BODIES, INBOX_TEMPLATE_TRANSLATIONS } from '@oto/db/seed';
import { newId } from '@oto/shared';
import { closingKeysOf } from '../src/services/inbox/ai-destination';
import { teardownAll } from './helpers';
import {
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
 * SCRUM-676, THE REAL-CHAT REPLAY (2 Nov 2026), IN THE TURN ENGINE. Nine real
 * customer questions from the exported chat history, anonymised, were played
 * against the assistant on staging; two were handled wrongly. Each is played
 * here through the real webhook, the real prompt builder, the real gates and
 * the real send path, with the `FakeAssistantClient` returning the decision
 * the live model made (read off the staging turn: its intent, parts and
 * citations).
 *
 *   - "Do you have camp today? And next week?" was read as a school or group,
 *     answered with the group line's "special deal" and closed with the
 *     birthday manager's line. A camp is its own intent now, and a hand-over:
 *     the playbook's neutral "not covered" line in the customer's language,
 *     the Birthday & events inbox, no deal or offer words, and the burst's
 *     other questions still answered first.
 *   - A Thai customer pasted the price calculator's summary (Food & Play)
 *     and asked how much of it is food credit. The model answered with the
 *     approved example's sentence, citing the Food & Play price note, and
 *     read two parts (`ticket_prices`, `faq`); the gate refused the reply
 *     (GROUNDING_TOPIC: a `faq` part took only an entry filed under `faq`)
 *     and the customer got the Thai unclear line. A `faq` part now also
 *     rests on a price note.
 *
 * FICTIONAL TEST DATA: the KB rows are written for these checks only.
 */

let w: AiWorld;
let wide: string; // an operator-wide number, live, no park
let approver: string;

beforeAll(async () => {
  w = await aiWorld();
  wide = await simAccount(w, { branchId: null });
  const receptionCentral = await teamOf(w, 'reception', w.central);
  [approver] = await staff(w, '+66810009676', 'Replay Test Approver', 'inbox_agent', {
    scopeType: 'department',
    scopeId: receptionCentral.departmentId!,
  });
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

/** The replay's camp question, anonymised. */
const CAMP_QUESTION = 'Hello, is there a camp today? And what about next week?';
/** No line the assistant sends about a camp offers a deal, a proposal or an offer, in any language. */
const DEAL_WORDS = /deal|discount|offer|proposal|ส่วนลด|โปร|ข้อเสนอ|скидк|предложени/i;
/** The camp closing in each language the engine answers in. */
const CAMP_CLOSING = {
  en: INBOX_TEMPLATE_BODIES.closing_unclear,
  th: INBOX_TEMPLATE_TRANSLATIONS.th.closing_unclear,
  ru: INBOX_TEMPLATE_TRANSLATIONS.ru.closing_unclear,
} as const;

async function handoverEvent(conversationId: string) {
  return (await eventsOf(w, conversationId)).find((e) => e.kind === 'ai_handover');
}

describe('SCRUM-676: a camp question (the replay\'s first miss)', () => {
  it('the camps plan closes with the playbook\'s unclear line, to Birthdays & events; that inbox\'s own line is the fallback', () => {
    expect(closingKeysOf({ plan: CAMPS_PLAN, branchLine: false, unclear: false }, 'birthdays')).toEqual(['closing_unclear', 'closing_birthday']);
  });

  it('the camp closing offers nothing in any language; the events line would (the reason it is not the camp line)', () => {
    for (const line of Object.values(CAMP_CLOSING)) expect(DEAL_WORDS.test(line), line).toBe(false);
    for (const line of [INBOX_TEMPLATE_BODIES.handover_events, INBOX_TEMPLATE_TRANSLATIONS.th.handover_events, INBOX_TEMPLATE_TRANSLATIONS.ru.handover_events]) {
      expect(DEAL_WORDS.test(line), line).toBe(true);
    }
  });

  it.each(['en', 'th', 'ru'] as const)(
    '%s: the model hands the camp over: the unclear line in that language, the Birthday & events inbox, no deal and no birthday manager',
    async (language) => {
      const conv = await customer(w, wide, nextPhone(), CAMP_QUESTION);
      w.fake.push({ kind: 'decision', decision: decision({ language, intent: 'camps', action: 'handover', reason: 'FACT_MISSING', bubbles: [] }) });
      expect((await tick(w, later(25_000))).handedOver).toBe(1);
      const lines = (await aiLines(w, conv.id)).map((l) => l.body);
      expect(lines).toEqual([CAMP_CLOSING[language]]);
      expect(lines.some((l) => DEAL_WORDS.test(l ?? ''))).toBe(false);
      expect(lines).not.toContain(INBOX_TEMPLATE_BODIES.closing_birthday);
      const birthdays = await teamOf(w, 'birthdays');
      expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'birthdays', teamId: birthdays.id, intent: 'camps' });
      expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', intent: 'camps' });
      expect((await handoverEvent(conv.id))!.payload).toMatchObject({
        intent: 'camps',
        destination: 'birthdays',
        templateKey: 'closing_unclear',
        closingKey: 'closing_unclear',
        holdingLine: 'template',
      });
    },
  );

  it('the replay\'s own reply — the group line\'s deal, written as an answer — is overruled: none of it reaches the customer', async () => {
    const conv = await customer(w, wide, nextPhone(), CAMP_QUESTION);
    w.fake.push({
      kind: 'decision',
      decision: decision({
        intent: 'camps',
        reason: 'CLEAR_INTENT',
        bubbles: ["We'd love to welcome your little ones, and we can put together a special deal!"],
      }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    const lines = (await aiLines(w, conv.id)).map((l) => l.body);
    expect(lines).toEqual([CAMP_CLOSING.en]);
    expect(lines.some((l) => DEAL_WORDS.test(l ?? ''))).toBe(false);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'OVERRULED_HANDOVER', intent: 'camps' });
  });

  it('a camp entry in the knowledge does not make a camp answerable: the model\'s camp answer is overruled and never sent', async () => {
    await kb(w, approver, {
      key: 'faq.kids-camp',
      topic: 'faq',
      language: 'en',
      question: 'Do you run a kids camp?',
      body: 'Our kids camp (fixture) runs in the school holidays at Central Floresta: games, crafts and lunch, for children from 5 years old.',
    });
    const conv = await customer(w, wide, nextPhone(), CAMP_QUESTION);
    const answer = 'Yes! Our kids camp runs today at Central Floresta, with games, crafts and lunch 😊';
    w.fake.push({ kind: 'decision', decision: decision({ intent: 'camps', reason: 'FACT_IN_KB', grounding: ['faq.kids-camp'], bubbles: [answer] }) });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([CAMP_CLOSING.en]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'OVERRULED_HANDOVER', intent: 'camps' });
    // The camp entry reached the model's knowledge; citing it changes nothing.
    expect(w.fake.requests.at(-1)!.prompt.system[1].text).toContain('[faq.kids-camp] (faq, en)');
  });

  it('the hours and a camp in one message: the hours answered first, then the camp closing, and Birthday & events takes the thread (D1a)', async () => {
    const central = await simAccount(w, { branchId: w.central });
    const every = { open: '10:00', close: '20:00' };
    await w.ctx.db
      .update(s.branch)
      .set({ openingHours: { mon: every, tue: every, wed: every, thu: every, fri: every, sat: every, sun: every } as never })
      .where(eq(s.branch.id, w.central));
    const conv = await customer(w, central, nextPhone(), 'What time do you open, and is there a camp today?');
    const hours = "We're open every day 10:00–20:00 😊";
    w.fake.push({
      kind: 'decision',
      decision: decision({ intent: 'hours', intents: ['hours', 'camps'], reason: 'FACT_IN_KB', grounding: ['fact.hours.central'], bubbles: [hours] }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([hours, CAMP_CLOSING.en]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'OK', intent: 'hours', action: 'answer' });
    const birthdays = await teamOf(w, 'birthdays');
    expect(await conversationRow(w, conv.id)).toMatchObject({ category: 'birthdays', teamId: birthdays.id });
    expect((await handoverEvent(conv.id))!.payload).toMatchObject({ intents: ['hours', 'camps'], destination: 'birthdays', closingKey: 'closing_unclear' });
  });
});

/** The replay's Thai question, anonymised: the price calculator's summary, then the question. */
const FOOD_CREDIT_QUESTION = [
  'สวัสดีค่ะ ขอสอบถามค่าใช้จ่ายการมาเล่นค่ะ',
  'เซ็นทรัล ฟลอเรสต้า · สุดสัปดาห์ · Food & Play',
  'เด็ก 1 คน · ผู้ใหญ่ 1 คน · ราคาคนไทย',
  'รวมโดยประมาณ: ฿1,300',
  'ยอดนี้ใช้สั่งอาหารได้เท่าไหร่คะ',
].join('\n');
/** The approved example's reply, as staging holds it: the whole amount is food credit. */
const FOOD_CREDIT_REPLY = 'แพ็กเกจ Food & Play สามารถใช้ยอดเงินเป็นเครดิตสำหรับสั่งอาหารได้เต็มจำนวนค่ะ 😊';

describe('SCRUM-676: the Thai Food & Play food-credit question (the replay\'s second miss)', () => {
  let central: string;

  beforeAll(async () => {
    central = await simAccount(w, { branchId: w.central });
    // The playbook's price note as staging holds it: English flagged for its translations, and Thai.
    await kb(w, approver, {
      key: 'pb.deal-food-play',
      topic: 'prices_note',
      language: 'en',
      needsTranslation: true,
      question: 'What is the Food & Play ticket?',
      body: 'Food & Play at Central Floresta (fixture): 1,300 baht for one child’s full-day play, and the whole amount can be spent in the restaurant.',
    });
    await kb(w, approver, {
      key: 'pb.deal-food-play',
      topic: 'prices_note',
      language: 'th',
      question: 'ตั๋ว Food & Play คืออะไรคะ?',
      body: 'Food & Play ที่ Central Floresta (fixture): 1,300 บาท สำหรับเด็กหนึ่งคนเล่นได้ทั้งวัน และใช้ยอดเงินทั้งหมดในร้านอาหารได้ค่ะ',
    });
    // The approved example that says exactly the sentence (customer words anonymised).
    await w.ctx.db.insert(s.aiExample).values({
      id: newId(),
      operatorId: w.oto,
      intent: 'ticket_prices',
      language: 'th',
      customerText: 'สวัสดีค่ะ สอบถามค่าเล่นที่เซ็นทรัล ฟลอเรสต้า · สุดสัปดาห์ · Food & Play เด็ก 1 คน · ผู้ใหญ่ 1 คน ราคานี้สั่งอาหารได้เท่าไหร่คะ',
      goodReply: FOOD_CREDIT_REPLY,
      verdict: 'should_answer',
      status: 'approved',
      proposedByAccountId: approver,
      approvedByAccountId: approver,
      approvedAt: new Date(),
      deidentifiedConfirmed: true,
    });
  });

  it('the staging turn\'s decision — two parts, the price note cited, the example\'s sentence — is answered, not handed over', async () => {
    const conv = await customer(w, central, nextPhone(), FOOD_CREDIT_QUESTION);
    w.fake.push({
      kind: 'decision',
      decision: decision({
        language: 'th',
        intent: 'ticket_prices',
        intents: ['ticket_prices', 'faq'],
        reason: 'FACT_IN_KB',
        grounding: ['pb.deal-food-play'],
        bubbles: [FOOD_CREDIT_REPLY],
      }),
    });
    expect((await tick(w, later(25_000))).answered).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([FOOD_CREDIT_REPLY]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'answered', reason: 'OK', intent: 'ticket_prices' });
    expect(await handoverEvent(conv.id)).toBeUndefined();
    // The real prompt carried the fact (both languages, one source) and the approved example.
    const knowledge = w.fake.requests.at(-1)!.prompt.system[1].text;
    expect(knowledge).toContain('[pb.deal-food-play] (prices_note, en)');
    expect(knowledge).toContain('[pb.deal-food-play] (prices_note, th)');
    expect(knowledge).toContain(`reply: ${JSON.stringify(FOOD_CREDIT_REPLY)}`);
  });

  it('the guards still hold: an amount the cited note does not state is withheld into the Thai unclear line', async () => {
    const conv = await customer(w, central, nextPhone(), FOOD_CREDIT_QUESTION);
    w.fake.push({
      kind: 'decision',
      decision: decision({
        language: 'th',
        intent: 'ticket_prices',
        intents: ['ticket_prices', 'faq'],
        reason: 'FACT_IN_KB',
        grounding: ['pb.deal-food-play'],
        bubbles: ['ใช้เป็นเครดิตอาหารได้ 1,000 บาทค่ะ'],
      }),
    });
    expect((await tick(w, later(25_000))).handedOver).toBe(1);
    expect((await aiLines(w, conv.id)).map((l) => l.body)).toEqual([INBOX_TEMPLATE_TRANSLATIONS.th.closing_unclear]);
    expect((await turnsOf(w, conv.id))[0]).toMatchObject({ state: 'handed_over', reason: 'GUARD_NUMBER' });
  });
});
