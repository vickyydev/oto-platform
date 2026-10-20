import { describe, expect, it } from 'vitest';
import { applyGates, EPISODE_ANSWER_CAP, EPISODE_WINDOW_CAP } from '../src/gate';
import { INTENT_TABLE, intentPartsOf } from '../src/intents';
import { decision, episode, fixtureKnowledge } from './support';

const knowledge = fixtureKnowledge();
const gate = (d: Parameters<typeof decision>[0], e: Parameters<typeof episode>[0] = {}) =>
  applyGates({ decision: decision(d), grounding: knowledge.grounding, episode: episode(e) });

describe('the answer gates (PLAN §B.3)', () => {
  it('G1: a greeting needs no grounding and is answered', () => {
    expect(gate({})).toMatchObject({
      action: 'answer',
      reason: 'OK',
      intent: 'greeting',
      language: 'en',
    });
  });

  it('G2: Thai hours grounded in the branch hours pass, with the branch question', () => {
    const v = gate({
      language: 'th',
      intent: 'hours',
      grounding: ['fact.hours.central'],
      bubbles: [
        'สวัสดีค่ะ 😊 OTO เปิดทุกวัน 10:00–20:00 น. ค่ะ',
        'สะดวกมาสาขาไหนคะ Central Floresta หรือ Chalong คะ แอดมินจะได้แจ้งข้อมูลให้ตรงสาขานะคะ',
      ],
      askBranch: true,
      reason: 'FACT_IN_KB',
    });
    expect(v).toMatchObject({
      action: 'answer',
      askBranch: true,
      groundingKeys: ['fact.hours.central'],
    });
  });

  it('G3: a weekend unit price grounded in the catalog passes; a total does not', () => {
    const ok = gate({
      intent: 'ticket_prices',
      grounding: ['fact.prices.chalong'],
      bubbles: [
        "At Chalong on weekends it's ฿390 per child, and 1 adult comes in with each child ticket 😊",
      ],
    });
    expect(ok.action).toBe('answer');
    const total = gate({
      intent: 'ticket_prices',
      grounding: ['fact.prices.chalong'],
      bubbles: ["That's ฿780 for the two kids, with you included."],
    });
    expect(total).toMatchObject({ action: 'silent', reason: 'GUARD_NUMBER' });
  });

  it('G4: Russian socks answer grounded in the socks entry passes', () => {
    expect(
      gate({
        language: 'ru',
        intent: 'socks',
        grounding: ['socks'],
        bubbles: [
          'Здравствуйте! Да, на площадке нужны нескользящие носки, их можно купить на ресепшене 😊',
        ],
      }).action,
    ).toBe('answer');
  });

  it('unsure is silence', () => {
    expect(gate({ certainty: 'unsure' })).toMatchObject({ action: 'silent', reason: 'UNSURE' });
  });

  it('a language other than th/en/ru is silence, even for a handover (G8)', () => {
    expect(gate({ language: 'other' })).toMatchObject({ action: 'silent', reason: 'LANGUAGE' });
    expect(gate({ language: 'other', intent: 'complaint_onsite' })).toMatchObject({
      action: 'silent',
      reason: 'LANGUAGE',
    });
  });

  it('a factual intent with no grounding, an unknown key, or a key of the wrong topic is silence', () => {
    expect(gate({ intent: 'hours', grounding: [], bubbles: ['We open at 10.'] })).toMatchObject({
      reason: 'GROUNDING_MISSING',
    });
    expect(
      gate({ intent: 'hours', grounding: ['fact.hours.patong'], bubbles: ['We open at 10.'] }),
    ).toMatchObject({
      reason: 'GROUNDING_UNKNOWN',
    });
    expect(
      gate({ intent: 'hours', grounding: ['socks'], bubbles: ['We open daily.'] }),
    ).toMatchObject({
      reason: 'GROUNDING_TOPIC',
    });
  });

  it('a needs-translation KB row is not citable; a branch row is cited as key@branch', () => {
    expect(knowledge.grounding.get('parking@central')).toBeDefined();
    expect(knowledge.grounding.get('parking')).toBeUndefined();
    expect(knowledge.grounding.get('faq.food-outside')?.text).not.toContain('นำอาหาร');
  });

  it('the model silent on an answer intent is silence; the model handing over is honoured', () => {
    expect(gate({ action: 'silent', bubbles: [] })).toMatchObject({
      action: 'silent',
      reason: 'MODEL_SILENT',
    });
    expect(gate({ intent: 'hours', action: 'handover', bubbles: [] })).toMatchObject({
      action: 'handover',
      reason: 'MODEL_HANDOVER',
      plan: { templateKey: 'handover_general', route: 'keep' },
    });
  });

  it('gate 7: zero bubbles, four bubbles, an over-long total or a list is silence', () => {
    expect(gate({ bubbles: [] })).toMatchObject({ reason: 'GUARD_BUBBLES' });
    expect(gate({ bubbles: ['a', 'b', 'c', 'd'] })).toMatchObject({ reason: 'GUARD_BUBBLES' });
    expect(gate({ bubbles: ['x'.repeat(400), 'y'.repeat(400), 'z'.repeat(200)] })).toMatchObject({
      reason: 'GUARD_BUBBLES',
    });
    expect(gate({ bubbles: ['Here you go:\n- socks\n- water'] })).toMatchObject({
      reason: 'GUARD_SHAPE',
    });
  });

  it('gate 6: an automation word in an answer is silence', () => {
    expect(gate({ bubbles: ["Hi! I'm the OTO bot 😊"] })).toMatchObject({
      action: 'silent',
      reason: 'GUARD_PERSONA',
    });
  });

  it('the branch question is dropped when the thread has a branch, and never on a birthday', () => {
    const withBranch = gate(
      {
        intent: 'socks',
        grounding: ['socks'],
        bubbles: ['Yes, grip socks please 😊'],
        askBranch: true,
      },
      { threadHasBranch: true },
    );
    expect(withBranch).toMatchObject({ action: 'answer', askBranch: false });
    const birthday = gate({
      intent: 'birthday_brochure',
      bubbles: ['Here are our birthday packages 🎂'],
      askBranch: true,
    });
    expect(birthday).toMatchObject({
      action: 'answer',
      askBranch: false,
      sendBrochure: true,
      thenHandover: { templateKey: 'handover_birthday', route: 'birthdays', brochure: true },
    });
  });

  it('the model cannot send a brochure on a non-birthday intent', () => {
    expect(gate({ sendBrochure: true })).toMatchObject({ action: 'answer', sendBrochure: false });
  });
});

describe('handovers (PLAN §B.3, §B.4)', () => {
  it('G7: an on-site complaint hands over to reception with the holding line only', () => {
    const v = gate({
      intent: 'complaint_onsite',
      action: 'handover',
      bubbles: [
        'Thank you for letting us know. Please hold on, our reception team will be with you right away.',
      ],
    });
    expect(v).toMatchObject({
      action: 'handover',
      plan: { templateKey: 'handover_complaint_onsite', route: 'general' },
    });
  });

  it('a holding line that promises a refund or compensation is dropped, and the hand-over still happens', () => {
    expect(
      gate({
        intent: 'complaint_onsite',
        action: 'handover',
        bubbles: ["So sorry! We'll refund your tickets."],
      }),
    ).toMatchObject({
      action: 'handover',
      holdingBubbles: [],
      droppedHoldingRule: expect.any(String),
      plan: { templateKey: 'handover_complaint_onsite' },
    });
    expect(
      gate({
        language: 'th',
        intent: 'complaint_onsite',
        action: 'handover',
        bubbles: ['ขออภัยค่ะ เราจะชดเชยให้นะคะ'],
      }),
    ).toMatchObject({
      action: 'handover',
      holdingBubbles: [],
      droppedHoldingRule: expect.any(String),
    });
  });

  it('G13: "50% off" can never ride a discount handover', () => {
    expect(
      gate({ intent: 'discount_negotiation', action: 'answer', bubbles: ['OK, 50% off for you!'] }),
    ).toMatchObject({
      action: 'handover',
      reason: 'OVERRULED_HANDOVER',
      holdingBubbles: [],
      droppedHoldingRule: 'number',
      plan: { templateKey: 'handover_general' },
    });
    expect(gate({ intent: 'discount_negotiation', action: 'answer', bubbles: [] })).toMatchObject({
      action: 'handover',
      reason: 'OVERRULED_HANDOVER',
      plan: { templateKey: 'handover_general' },
    });
  });

  it('G5/G6: a birthday party with a date never confirms the date', () => {
    expect(
      gate({
        intent: 'birthday_party',
        action: 'handover',
        bubbles: ['Lovely! 14 November is booked for you 🎈'],
      }),
    ).toMatchObject({
      action: 'handover',
      holdingBubbles: [],
      droppedHoldingRule: 'number',
      plan: { templateKey: 'handover_birthday', route: 'birthdays' },
    });
    expect(gate({ intent: 'birthday_party', action: 'handover', bubbles: [] })).toMatchObject({
      action: 'handover',
      plan: { templateKey: 'handover_birthday', route: 'birthdays', brochure: true },
    });
  });

  it('G9: the identity question is answered in persona once, then handed over', () => {
    const first = gate({
      intent: 'identity_question',
      bubbles: ["You're chatting with the OTO Play Park team 😊 What can we help you with?"],
    });
    expect(first).toMatchObject({ action: 'answer', intent: 'identity_question' });
    const second = gate(
      { intent: 'identity_question', bubbles: ['Still us 😊'] },
      { identityAnswered: true },
    );
    expect(second).toMatchObject({
      action: 'handover',
      reason: 'IDENTITY_SECOND_ASK',
      plan: { templateKey: 'handover_general', route: 'keep' },
    });
    expect(gate({ intent: 'human_requested', action: 'handover', bubbles: [] })).toMatchObject({
      action: 'handover',
    });
  });
});

describe('the per-episode cap (PLAN §D.4 guard 3, golden G16)', () => {
  const ask = {
    intent: 'socks' as const,
    grounding: ['socks'],
    bubbles: ['Yes, grip socks please 😊'],
  };

  it('the cap is eight answers in ten minutes, and eight in the episode (test night 2026-10-21, W3)', () => {
    expect(EPISODE_WINDOW_CAP).toBe(8);
    expect(EPISODE_ANSWER_CAP).toBe(8);
  });

  it('an eighth answer within ten minutes is still answered; a ninth is a CAP_EPISODE handover', () => {
    // The conversation that hit the old cap of three: parking, the children's
    // price, "and for adults?", "what about on Saturday?" — all answered now.
    expect(gate(ask, { aiAnswers: 3, aiAnswersLast10Min: 3 }).action).toBe('answer');
    expect(gate(ask, { aiAnswers: 7, aiAnswersLast10Min: 7 }).action).toBe('answer');
    expect(gate(ask, { aiAnswers: 8, aiAnswersLast10Min: EPISODE_WINDOW_CAP })).toMatchObject({
      action: 'handover',
      reason: 'CAP_EPISODE',
      holdingBubbles: [],
      plan: { templateKey: 'handover_general', route: 'keep' },
    });
  });

  it('at most eight answers in an episode, however spread out', () => {
    expect(gate(ask, { aiAnswers: EPISODE_ANSWER_CAP, aiAnswersLast10Min: 0 })).toMatchObject({
      reason: 'CAP_EPISODE',
    });
  });
});

describe('a burst with several parts (test night 2026-10-21, D1a, W2)', () => {
  const parking = [
    "Yes, there's parking 😊 Park in the mall car park, level 3 is closest to us.",
    'From Kata, take the bypass road north and follow the signs for the mall.',
    'Outside food is not allowed, but our cafe serves meals and snacks.',
  ];

  it('three questions, all in the knowledge: one reply that answers each part', () => {
    const v = gate({
      intent: 'directions_parking',
      intents: ['directions_parking', 'faq'],
      grounding: ['parking@central', 'faq.food-outside'],
      bubbles: parking,
      reason: 'FACT_IN_KB',
    });
    expect(v).toMatchObject({
      action: 'answer',
      reason: 'OK',
      intent: 'directions_parking',
      intents: ['directions_parking', 'faq'],
      groundingKeys: ['parking@central', 'faq.food-outside'],
      thenHandover: null,
      sendBrochure: false,
    });
    expect(v.action === 'answer' && v.bubbles).toEqual(parking);
  });

  it('a decision without `intents` (recorded before they existed) is its one intent', () => {
    expect(gate({ intent: 'socks', grounding: ['socks'], bubbles: ['Yes, grip socks please 😊'] })).toMatchObject({
      action: 'answer',
      intents: ['socks'],
    });
  });

  it('hours and a party: the hours are answered, then the brochure and the birthday holding line, routed to Birthdays', () => {
    const v = gate({
      intent: 'hours',
      intents: ['hours', 'birthday_party'],
      grounding: ['fact.hours.central'],
      bubbles: ["We're open every day 10:00–20:00 😊"],
      reason: 'FACT_IN_KB',
    });
    expect(v).toMatchObject({
      action: 'answer',
      reason: 'OK',
      intent: 'hours',
      intents: ['hours', 'birthday_party'],
      sendBrochure: true,
      askBranch: false,
      thenHandover: { templateKey: 'handover_birthday', route: 'birthdays', brochure: true },
      mayAutoHandle: false,
    });
  });

  it('a date or a price in the answer part is still refused by the guards, over the whole reply', () => {
    expect(
      gate({
        intent: 'hours',
        intents: ['hours', 'birthday_party'],
        grounding: ['fact.hours.central'],
        bubbles: ["We're open 10:00–20:00, and the 14th is all yours for the party 🎈"],
      }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_NUMBER' });
    expect(
      gate({
        intent: 'hours',
        intents: ['hours', 'birthday_party'],
        grounding: ['fact.hours.central'],
        bubbles: ["We're open 10:00–20:00, and the party room is free for you 🎈"],
      }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_PROMISE' });
  });

  it('each factual part cites a key of its own topic: an uncited part is silence', () => {
    expect(
      gate({
        intent: 'hours',
        intents: ['hours', 'socks'],
        grounding: ['fact.hours.central'],
        bubbles: ["We're open 10:00–20:00 😊 And yes, grip socks please."],
      }),
    ).toMatchObject({ action: 'silent', reason: 'GROUNDING_TOPIC', intents: ['hours', 'socks'] });
  });

  it('a complaint beside a question: the holding line alone, and none of the answer rides it', () => {
    const v = gate({
      intent: 'complaint_onsite',
      intents: ['complaint_onsite', 'hours'],
      grounding: ['fact.hours.central'],
      bubbles: ["We're open 10:00–20:00 😊"],
    });
    expect(v).toMatchObject({
      action: 'handover',
      reason: 'OVERRULED_HANDOVER',
      intents: ['complaint_onsite', 'hours'],
      plan: { templateKey: 'handover_complaint_onsite', route: 'general' },
      holdingBubbles: [],
    });
    expect(v.action === 'handover' && v.droppedHoldingRule).toBeFalsy();
    for (const alone of ['emotional_or_unclear', 'human_requested', 'complaint_online'] as const) {
      const rule = INTENT_TABLE[alone];
      if (rule.action !== 'handover') throw new Error(alone);
      expect(rule.answerAlongside).toBe(false);
      expect(gate({ intent: 'hours', intents: ['hours', alone], grounding: ['fact.hours.central'], bubbles: ['10:00–20:00'] })).toMatchObject({
        action: 'handover',
        plan: rule.plan,
        holdingBubbles: [],
      });
    }
  });

  it('`other` as the primary is silence whatever else is listed; an `other` beside real parts is dropped', () => {
    expect(gate({ intent: 'other', intents: ['other', 'hours'], grounding: ['fact.hours.central'], bubbles: ['10:00–20:00'] })).toMatchObject({
      action: 'silent',
      reason: 'INTENT_SILENT',
    });
    expect(gate({ intent: 'hours', intents: ['hours', 'other'], grounding: ['fact.hours.central'], bubbles: ['10:00–20:00 😊'] })).toMatchObject({
      action: 'answer',
      intents: ['hours'],
    });
  });

  it('every part hands over: the first part’s plan, the model’s words as the holding line', () => {
    expect(
      gate({
        intent: 'birthday_party',
        intents: ['birthday_party', 'discount_negotiation'],
        action: 'handover',
        bubbles: ['Lovely, one moment please 🎈'],
      }),
    ).toMatchObject({
      action: 'handover',
      reason: 'OK',
      intents: ['birthday_party', 'discount_negotiation'],
      plan: { templateKey: 'handover_birthday', route: 'birthdays', brochure: true },
      holdingBubbles: ['Lovely, one moment please 🎈'],
    });
  });

  it('the model choosing silent or handover on a burst with an answerable part is honoured, with the burst’s own plan', () => {
    expect(gate({ intent: 'hours', intents: ['hours', 'birthday_party'], action: 'silent', bubbles: [] })).toMatchObject({
      action: 'silent',
      reason: 'MODEL_SILENT',
    });
    expect(gate({ intent: 'hours', intents: ['hours', 'birthday_party'], action: 'handover', bubbles: [] })).toMatchObject({
      action: 'handover',
      reason: 'OK',
      plan: { templateKey: 'handover_birthday', route: 'birthdays', brochure: true },
    });
  });

  it('a second identity ask beside a question is answered for the question and handed over for the ask', () => {
    const v = gate(
      {
        intent: 'socks',
        intents: ['socks', 'identity_question'],
        grounding: ['socks'],
        bubbles: ['Yes, grip socks please 😊'],
      },
      { identityAnswered: true },
    );
    expect(v).toMatchObject({
      action: 'answer',
      thenHandover: { templateKey: 'handover_general', route: 'keep', brochure: false },
    });
  });

  it('the cap on a mixed burst hands over with the burst’s own plan', () => {
    expect(
      gate(
        { intent: 'hours', intents: ['hours', 'birthday_party'], grounding: ['fact.hours.central'], bubbles: ['10:00–20:00'] },
        { aiAnswers: 8, aiAnswersLast10Min: 8 },
      ),
    ).toMatchObject({
      action: 'handover',
      reason: 'CAP_EPISODE',
      plan: { templateKey: 'handover_birthday', route: 'birthdays', brochure: true },
    });
  });

  it('`intents` is at most four parts, the primary first, no intent twice', () => {
    expect(intentPartsOf({ intent: 'hours', intents: ['socks', 'hours', 'socks', 'faq', 'age_rules', 'address'] })).toEqual([
      'hours',
      'socks',
      'faq',
      'age_rules',
    ]);
    expect(intentPartsOf({ intent: 'hours' })).toEqual(['hours']);
  });
});
