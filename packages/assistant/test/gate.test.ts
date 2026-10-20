import { describe, expect, it } from 'vitest';
import { applyGates, EPISODE_ANSWER_CAP, EPISODE_WINDOW_CAP } from '../src/gate';
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

  it('a third answer within ten minutes is still answered; a fourth is a CAP_EPISODE handover', () => {
    expect(gate(ask, { aiAnswers: 2, aiAnswersLast10Min: 2 }).action).toBe('answer');
    expect(gate(ask, { aiAnswers: 3, aiAnswersLast10Min: EPISODE_WINDOW_CAP })).toMatchObject({
      action: 'handover',
      reason: 'CAP_EPISODE',
      holdingBubbles: [],
      plan: { templateKey: 'handover_general', route: 'keep' },
    });
  });

  it('at most four answers in an episode, however spread out', () => {
    expect(gate(ask, { aiAnswers: EPISODE_ANSWER_CAP, aiAnswersLast10Min: 0 })).toMatchObject({
      reason: 'CAP_EPISODE',
    });
  });
});
