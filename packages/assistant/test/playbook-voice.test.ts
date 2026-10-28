import { describe, expect, it } from 'vitest';
import { bubbleGuard, BUSY_WORD_RULES, busyGuard, faultGuard, framingGuard, linkGuard } from '../src/guards';
import {
  EN_PERSONA,
  GREETING_RULE,
  NEVER_BUSY_RULE,
  ONE_QUESTION_RULE,
  PERSONA_VERSION,
  PROHIBITIONS,
  RU_PERSONA,
  SELLING_POINTS_RULE,
  TH_PERSONA,
} from '../src/persona';
import { STATIC_SYSTEM_TEXT } from '../src/prompt';
import { CALCULATOR_CENTRAL, MENU_LINK, pgate } from './playbook-support';

/**
 * SCRUM-220, Tom's playbook (28 Oct 2026) — "Voice and golden rules". The
 * playbook is the FIRST rule: where it and an older prompt rule disagree, the
 * playbook's wording is what the prompt now carries. The mechanical halves
 * (one question, never busy, links, fault) are guards; the rest are rules the
 * compiled prompt is pinned to carry.
 */

describe('A. at most ONE question per reply (playbook: "the only question allowed to slow things down is which branch")', () => {
  it('two bubbles that each ask a question are refused by the bubble guard', () => {
    expect(bubbleGuard(['We open at 10:00 😊 Which branch suits you?', 'Do you need socks?'], 1)).toEqual({
      ok: false,
      reason: 'GUARD_SHAPE',
      rule: 'one_question',
    });
    expect(bubbleGuard(['Мы открыты с 10:00. Какой парк вам удобнее?', 'Нужны носки?'], 1)).toMatchObject({ rule: 'one_question' });
  });

  it("a link's own query string is not a question", () => {
    expect(bubbleGuard([`Here's our calculator: ${CALCULATOR_CENTRAL}`, 'Which branch suits you?'], 1)).toEqual({ ok: true });
  });

  it("the playbook's own combined question (two question marks, one bubble) passes", () => {
    expect(bubbleGuard([EN_PERSONA.branchResidencyQuestion], 1)).toEqual({ ok: true });
    expect(bubbleGuard(['Open every day 10:00–20:00 😊', EN_PERSONA.branchResidencyQuestion], 1)).toEqual({ ok: true });
  });

  it('the gate turns a two-question answer into silence, and drops two-question holding words', () => {
    expect(
      pgate({ intent: 'socks', grounding: ['socks'], bubbles: ['Grip socks please 😊 Which park?', 'Coming today?'] }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_SHAPE', rule: 'one_question' });
    expect(
      pgate({ intent: 'human_requested', action: 'handover', bubbles: ['Sure?', 'One moment?'] }),
    ).toMatchObject({ action: 'handover', holdingBubbles: [], droppedHoldingRule: 'one_question' });
  });

  it('the prompt carries the rule, Thai questions without a question mark included', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(ONE_QUESTION_RULE);
    expect(ONE_QUESTION_RULE).toMatch(/at most ONE question/);
    expect(ONE_QUESTION_RULE).toContain('คะ');
  });
});

describe('A. never say or imply the park is busy', () => {
  it.each([
    ['en:busy', "It's busy on Saturdays, come early!"],
    ['en:busy', 'Weekends are our busiest days.'],
    ['en:crowded', 'It can get crowded after school.'],
    ['en:full', "Sorry, we're full today."],
    ['en:full', "We're fully booked this afternoon."],
    ['th:crowded', 'วันเสาร์คนแน่นนะคะ'],
    ['th:many_people', 'ช่วงบ่ายคนเยอะค่ะ'],
    ['ru:crowded', 'В выходные многолюдно.'],
    ['ru:busy', 'Сегодня мы заняты.'],
  ])('%s is refused when no cited source says it: %j', (rule, bubble) => {
    expect(busyGuard([bubble], ['Opening hours: every day 10:00–20:00'])).toEqual({ ok: false, reason: 'GUARD_BUSY', rule });
  });

  it.each([
    'The full day ticket is ฿1,090 😊',
    'Full-day tickets allow unlimited in and out.',
    'Parent tickets are fully food and drink credit.',
    'ได้แน่นอนค่ะ 😊',
    'Мы работаем каждый день, ждём вас!',
  ])('ordinary words pass: %j', (bubble) => {
    expect(busyGuard([bubble], [])).toEqual({ ok: true });
  });

  it('a busy word the cited source itself uses passes (the special-needs entry)', () => {
    expect(
      busyGuard(
        ['For kids who find busy places hard, weekday mornings are the calmest time 😊'],
        ['Every child is welcome. For kids who find busy places hard, weekday mornings are the calmest time.'],
      ),
    ).toEqual({ ok: true });
  });

  it('rule ids are unique', () => {
    const ids = BUSY_WORD_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the gate refuses an ungrounded busy word in an answer, and drops it from holding words', () => {
    expect(
      pgate({ intent: 'hours', grounding: ['fact.hours.central'], bubbles: ["We're open 10:00–20:00, but it gets busy after 4 😊"] }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_NUMBER' });
    expect(
      pgate({ intent: 'hours', grounding: ['fact.hours.central'], bubbles: ["We're open 10:00–20:00, but weekends get busy 😊"] }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_BUSY', rule: 'en:busy' });
    expect(
      pgate({ intent: 'faq', grounding: ['pb.special-needs'], bubbles: ['Every child is welcome 😊 For kids who find busy places hard, weekday mornings are the calmest time.'] }),
    ).toMatchObject({ action: 'answer' });
    expect(pgate({ intent: 'human_requested', action: 'handover', bubbles: ["It's crowded today, one moment"] })).toMatchObject({
      action: 'handover',
      holdingBubbles: [],
      droppedHoldingRule: 'en:crowded',
    });
  });

  it('the prompt carries the rule, among the absolute prohibitions', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(NEVER_BUSY_RULE);
    expect(PROHIBITIONS.map((p) => p.id)).toContain('no_busy');
  });
});

describe('A. links: only a link a cited source holds, word for word (D4: never guess a customer-facing URL)', () => {
  it('the calculator and menu links pass when the cited source holds them; a changed or invented one does not', () => {
    expect(linkGuard([`Here's our calculator: ${CALCULATOR_CENTRAL}`], [`calculator at ${CALCULATOR_CENTRAL}`])).toEqual({ ok: true });
    expect(linkGuard(['Our menu: phuket.otoplay.co/menu'], [`The menu: ${MENU_LINK} .`])).toEqual({ ok: true });
    expect(
      linkGuard(['Calculator: https://phuket.otoplay.co/prices?branch=chalong&rate=thai&calculator=open'], [`calculator at ${CALCULATOR_CENTRAL}`]),
    ).toEqual({ ok: false, reason: 'GUARD_LINK', rule: 'link' });
    expect(linkGuard(['Book at otoplaypark.com'], [])).toEqual({ ok: false, reason: 'GUARD_LINK', rule: 'link' });
    expect(linkGuard(['See www.otoplay.co for more'], [])).toMatchObject({ ok: false, reason: 'GUARD_LINK' });
  });

  it('plain words, times and prices are not links', () => {
    expect(linkGuard(['Open 10:00–20:00, ฿1,090 for the full day. Central Floresta, e.g. the basement.'], [])).toEqual({ ok: true });
  });

  it('the gate refuses an answer with a link its sources do not hold', () => {
    expect(
      pgate({ intent: 'faq', grounding: ['pb.food'], bubbles: ['Here is our menu: https://phuket.otoplay.co/food-menu 😊'] }),
    ).toMatchObject({ action: 'silent', reason: 'GUARD_LINK' });
    expect(
      pgate({ intent: 'faq', grounding: ['pb.food'], bubbles: [`Here's our menu, so you can pick before you come: ${MENU_LINK}`] }),
    ).toMatchObject({ action: 'answer' });
  });
});

describe('A. selling points: at most one, never in the first price reply, only the three', () => {
  it('the prompt names exactly the three points and the "that\'s expensive" line', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(SELLING_POINTS_RULE);
    expect(SELLING_POINTS_RULE).toMatch(/at most ONE per message/);
    expect(SELLING_POINTS_RULE).toMatch(/never in the first price reply/);
    for (const point of ['a real restaurant', 'head chef', 'healthy food for kids', 'great coffee', 'homemade cakes', 'safety', 'nannies and child supervisors', 'cleanliness', 'deep clean every two weeks']) {
      expect(SELLING_POINTS_RULE).toContain(point);
    }
    expect(SELLING_POINTS_RULE).toContain('parent tickets are food credit at a real restaurant');
    expect(SELLING_POINTS_RULE).toContain('staff supervise the whole park');
    expect(SELLING_POINTS_RULE).toContain('everything is included');
    expect(SELLING_POINTS_RULE).toMatch(/Dinner Promo/);
    expect(SELLING_POINTS_RULE).toMatch(/Food & Play/);
  });
});

describe('A. fault and framing', () => {
  it.each([
    ['en:fault', "I'm so sorry, it was our fault."],
    ['en:we_wrong', 'We were wrong, sorry.'],
    ['en:we_mistake', 'We made a mistake with the food.'],
    ['th:fault', 'ขออภัยค่ะ เป็นความผิดของเราเองค่ะ'],
    ['ru:fault', 'Простите, это наша вина.'],
    ['ru:we_wrong', 'Мы виноваты, извините.'],
  ])('%s: an apology never admits fault — %j', (rule, bubble) => {
    expect(faultGuard([bubble])).toEqual({ ok: false, reason: 'GUARD_FAULT', rule });
  });

  it.each(["I'm so sorry to hear that 🙏", 'ขออภัยจริง ๆ ค่ะ', 'Нам очень жаль это слышать.', 'เราผิดหวังด้วยค่ะ'])('a sincere apology passes: %j', (b) => {
    expect(faultGuard([b])).toEqual({ ok: true });
  });

  it('the nanny service is never framed as safer, whatever a source says', () => {
    expect(framingGuard(['A nanny makes it safer for little ones 😊'])).toEqual({ ok: false, reason: 'GUARD_FRAMING', rule: 'en:safer' });
    expect(framingGuard(['พี่เลี้ยงช่วยให้ปลอดภัยกว่าค่ะ'])).toMatchObject({ ok: false, rule: 'th:safer' });
    expect(framingGuard(['С няней безопаснее.'])).toMatchObject({ ok: false, rule: 'ru:safer' });
    expect(framingGuard(['One-on-one care at Central Floresta, ฿330 per hour 😊'])).toEqual({ ok: true });
  });
});

describe('B. the Russian voice: a warm greeting once, never a formal one on every reply', () => {
  it('the mandatory "Здравствуйте" is gone; the voice greets once and stays friendly and short', () => {
    expect(RU_PERSONA.voice).not.toContain('Open with "Здравствуйте"');
    expect(STATIC_SYSTEM_TEXT).not.toContain('Open with "Здравствуйте"');
    expect(RU_PERSONA.voice).toMatch(/once/);
    expect(RU_PERSONA.voice).toMatch(/friendly/);
    expect(RU_PERSONA.voice).toMatch(/short/);
  });

  it('every language greets once, at the start; a bare "hi" gets the playbook\'s one-liner', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(GREETING_RULE);
    expect(GREETING_RULE).toContain('Hi! How can I help you?');
    expect(GREETING_RULE).toMatch(/once/);
  });

  it('a Russian answer without a greeting passes the gate', () => {
    expect(
      pgate({ language: 'ru', intent: 'socks', grounding: ['socks'], bubbles: ['Да, на площадке нужны нескользящие носки, их можно купить на ресепшене 😊'] }),
    ).toMatchObject({ action: 'answer', language: 'ru' });
  });

  it('the persona version moved with the words', () => {
    expect(PERSONA_VERSION).toBe('persona-2026-10-28.2');
  });

  it("the persona's fixed lines pass the playbook guards", () => {
    for (const p of [TH_PERSONA, EN_PERSONA, RU_PERSONA]) {
      expect(busyGuard([p.identityLine, p.branchQuestion], [])).toEqual({ ok: true });
      expect(bubbleGuard([p.identityLine], 1)).toEqual({ ok: true });
      expect(faultGuard([p.identityLine, p.branchQuestion])).toEqual({ ok: true });
    }
  });
});
