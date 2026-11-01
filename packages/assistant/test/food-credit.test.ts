import { describe, expect, it } from 'vitest';
import { applyGates } from '../src/gate';
import { INTENT_TABLE } from '../src/intents';
import { buildKnowledge, type ExampleInput, type KbEntryInput } from '../src/prompt';
import { PLAYBOOK_KB, TIER_BRANCHES } from './playbook-support';
import { FIXTURE_KB, decision, episode } from './support';

/**
 * SCRUM-676, the real-chat replay (2 Nov 2026), the second miss: a Thai
 * customer pasted the price calculator's summary (Central Floresta, weekend,
 * Food & Play, one child, one adult) and asked how much of it can be spent on
 * food. The knowledge holds the answer — the Food & Play price note says the
 * whole amount can be spent in the restaurant — and an approved example says
 * exactly that sentence. The staging turn read two parts, `ticket_prices` and
 * `faq` (a food question), cited the price note, and the gate refused it
 * (GROUNDING_TOPIC): the `faq` part accepted only an entry filed under `faq`,
 * so a grounded, correct reply became the Thai holding line and a hand-over.
 *
 * A `faq` part now also rests on a price note, where the playbook files what
 * a ticket or a deal includes (food credit among it). The other topics keep
 * their own intents, and a live fact (hours, address, prices) is still not a
 * `faq` source.
 *
 * FICTIONAL TEST DATA in the shape staging holds: the price note paraphrases
 * the playbook entry, and the customer's words are anonymised.
 */

const FOOD_PLAY: KbEntryInput[] = [
  {
    key: 'pb.deal-food-play',
    topic: 'prices_note',
    language: 'en',
    branch: null,
    question: 'What is the Food & Play ticket?',
    body: 'Food & Play at Central Floresta (fixture): 1,300 baht for one child’s full-day play, and the whole amount can be spent in the restaurant.',
    needsTranslation: true,
  },
  {
    key: 'pb.deal-food-play',
    topic: 'prices_note',
    language: 'th',
    branch: null,
    question: 'ตั๋ว Food & Play คืออะไรคะ?',
    body: 'Food & Play ที่ Central Floresta (fixture): 1,300 บาท สำหรับเด็กหนึ่งคนเล่นได้ทั้งวัน และใช้ยอดเงินทั้งหมดในร้านอาหารได้ค่ะ',
    needsTranslation: false,
  },
];

/** The approved example, as staging holds it (customer words anonymised). */
const EXAMPLE: ExampleInput = {
  intent: 'ticket_prices',
  language: 'th',
  customerText: 'สวัสดีค่ะ สอบถามค่าเล่นที่เซ็นทรัล ฟลอเรสต้า · สุดสัปดาห์ · Food & Play เด็ก 1 คน · ผู้ใหญ่ 1 คน ราคานี้สั่งอาหารได้เท่าไหร่คะ',
  goodReply: 'แพ็กเกจ Food & Play สามารถใช้ยอดเงินเป็นเครดิตสำหรับสั่งอาหารได้เต็มจำนวนค่ะ 😊',
  verdict: 'should_answer',
};

const knowledge = buildKnowledge({ kb: [...FIXTURE_KB, ...PLAYBOOK_KB, ...FOOD_PLAY], branches: TIER_BRANCHES, examples: [EXAMPLE] });

/** The staging turn's decision: two parts, the price note cited, the example's sentence. */
const replayed = (over: Parameters<typeof decision>[0] = {}) =>
  decision({
    language: 'th',
    intent: 'ticket_prices',
    intents: ['ticket_prices', 'faq'],
    reason: 'FACT_IN_KB',
    grounding: ['pb.deal-food-play'],
    bubbles: [EXAMPLE.goodReply],
    ...over,
  });

describe('SCRUM-676: the Food & Play food-credit question (the replay\'s second miss)', () => {
  it('the knowledge the model reads holds the fact and the approved example', () => {
    expect(knowledge.text).toContain('[pb.deal-food-play] (prices_note, th)');
    expect(knowledge.text).toContain(`- ticket_prices (th, should_answer) customer: ${JSON.stringify(EXAMPLE.customerText)}`);
    expect(knowledge.grounding.get('pb.deal-food-play')?.topic).toBe('prices_note');
  });

  it('a faq part rests on a faq entry or a price note; the other topics keep their own intents', () => {
    const faq = INTENT_TABLE.faq;
    expect(faq.action === 'answer' && faq.groundingTopics).toEqual(['faq', 'prices_note']);
    expect(
      applyGates({
        decision: decision({ intent: 'faq', reason: 'FACT_IN_KB', grounding: ['socks'], bubbles: ['Yes, grip socks for everyone on the play floor 😊'] }),
        grounding: knowledge.grounding,
        episode: episode(),
      }),
    ).toMatchObject({ action: 'silent', reason: 'GROUNDING_TOPIC' });
  });

  it('the replayed decision is answered with the example\'s sentence, nobody takes over', () => {
    expect(applyGates({ decision: replayed(), grounding: knowledge.grounding, episode: episode({ threadHasBranch: true }) })).toMatchObject({
      action: 'answer',
      reason: 'OK',
      intent: 'ticket_prices',
      intents: ['ticket_prices', 'faq'],
      language: 'th',
      bubbles: [EXAMPLE.goodReply],
      groundingKeys: ['pb.deal-food-play'],
      thenHandover: null,
    });
  });

  it('the amount itself may be said: the price note grounds it', () => {
    const bubble = 'Food & Play 1,300 บาท ใช้เป็นเครดิตสั่งอาหารได้เต็มจำนวนเลยค่ะ 😊';
    expect(applyGates({ decision: replayed({ bubbles: [bubble] }), grounding: knowledge.grounding, episode: episode({ threadHasBranch: true }) })).toMatchObject({
      action: 'answer',
      bubbles: [bubble],
    });
  });

  it('a faq part still never rests on a live fact, and an uncited amount is still refused', () => {
    expect(
      applyGates({
        decision: decision({ intent: 'faq', reason: 'FACT_IN_KB', grounding: ['fact.prices.central'], bubbles: ['Yes, you can spend it on food 😊'] }),
        grounding: knowledge.grounding,
        episode: episode(),
      }),
    ).toMatchObject({ action: 'silent', reason: 'GROUNDING_TOPIC' });
    expect(
      applyGates({
        decision: replayed({ bubbles: ['Food & Play 1,500 บาท ใช้เป็นเครดิตอาหารได้ค่ะ'] }),
        grounding: knowledge.grounding,
        episode: episode({ threadHasBranch: true }),
      }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_NUMBER' });
  });
});
