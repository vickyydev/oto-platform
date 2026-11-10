import { describe, expect, it } from 'vitest';
import {
  ADVICE_OPENER_SLOTS,
  BIRTHDAY_ADVICE_RULE,
  adviceOpenerOn,
  asksForParty,
  namesPartyBasics,
  openerAskedBefore,
} from '../src/advice';
import type { AiDecision } from '../src/decision';
import { applyGates, type EpisodeQuestion, type EpisodeState, type GateVerdict } from '../src/gate';
import { BIRTHDAYS_PLAN, INTENT_SLOTS } from '../src/intents';
import { headcountNamedIn } from '../src/slots';
import { decision, episode, fixtureKnowledge } from './support';

/**
 * SCRUM-823, THE OPENER BESIDE AN ADVICE HAND-OVER (staging, 10 November,
 * docs/qa/proof-2026-11-09/SCRUM-823/staging). Two of the run's threads asked
 * for a party and for advice at once:
 *
 *   C   "We want a birthday party for our daughter. What would you suggest?"
 *       — labelled `birthday_advice` alone;
 *   C2  "We would like to book a birthday party for our son. Which package
 *       would you recommend?" — labelled `birthday_advice` and
 *       `birthday_party`, and the model handed over itself.
 *
 * Both families got only the birthday manager's closing line, and neither was
 * asked the date and the park. The owner's rule: the opener STAYS beside an
 * advice hand-over. The gate now marks such a hand-over (`adviceOpener`) and
 * the engine sends one message, the opener's question and the warm line.
 * The run's other two advice threads already named a headcount (A "for a
 * party of 12 kids", D "для 10 детей"), which one fixed line cannot skip:
 * they keep the warm line alone.
 */

const knowledge = fixtureKnowledge();

const BIRTHDAYS: Partial<EpisodeState> = { threadCategory: 'birthdays', earlierIntents: [] };
const GENERAL: Partial<EpisodeState> = { threadCategory: 'general', earlierIntents: [] };

const gate = (d: Partial<AiDecision>, e: Partial<EpisodeState>, lines: readonly string[]): GateVerdict =>
  applyGates({ decision: decision(d), grounding: knowledge.grounding, episode: episode(e), openLines: lines });

/** The model's own reading on staging: advice, handed over, no words of its own. */
const handedOverAsAdvice = (language: 'en' | 'ru' | 'th', withParty: boolean): Partial<AiDecision> => ({
  language,
  intent: 'birthday_advice',
  ...(withParty ? { intents: ['birthday_advice', 'birthday_party'] as AiDecision['intents'] } : {}),
  action: 'handover',
  reason: 'NEEDS_PERSON',
  bubbles: [],
});

/** The two gap wordings, in the three languages: C (advice alone) and C2 (the party labelled beside it). */
const GAP: Record<'en' | 'ru' | 'th', { c: string; c2: string }> = {
  en: {
    c: 'We want a birthday party for our daughter. What would you suggest?',
    c2: 'We would like to book a birthday party for our son. Which package would you recommend?',
  },
  ru: {
    c: 'Хотим устроить день рождения для дочки. Что вы посоветуете?',
    c2: 'Хотим забронировать праздник для сына. Какой пакет вы посоветуете?',
  },
  th: {
    c: 'อยากจัดงานวันเกิดให้ลูกสาวค่ะ แนะนำอะไรดีคะ',
    c2: 'อยากจองปาร์ตี้วันเกิดให้ลูกชายค่ะ แนะนำแพ็กเกจไหนคะ',
  },
};

/** The run's two advice threads that already named a headcount. */
const STAGING_A = 'Which branch would you recommend for a party of 12 kids?';
const STAGING_D = 'Посоветуйте, какой филиал лучше для 10 детей?';

const expectOpener = (v: GateVerdict, what: string) => {
  expect(v.action, what).toBe('handover');
  if (v.action !== 'handover') return;
  expect(v.plan, what).toEqual(BIRTHDAYS_PLAN);
  expect(v.intents, what).toContain('birthday_advice');
  expect(v.adviceOpener, what).toBe(true);
};

const expectWarmLineOnly = (v: GateVerdict, what: string) => {
  expect(v.action, what).toBe('handover');
  if (v.action !== 'handover') return;
  expect(v.plan, what).toEqual(BIRTHDAYS_PLAN);
  expect(v.intents, what).toContain('birthday_advice');
  expect(v.adviceOpener, what).toBeUndefined();
};

describe('SCRUM-823 staging: the four advice wordings', () => {
  it('C, labelled birthday_advice alone: the opener goes with the hand-over (en)', () => {
    const v = gate(handedOverAsAdvice('en', false), BIRTHDAYS, [GAP.en.c]);
    expectOpener(v, GAP.en.c);
    expect(v).toMatchObject({ reason: 'OK', intent: 'birthday_advice', intents: ['birthday_advice'], language: 'en' });
  });

  it('C2, the party labelled beside the advice and handed over by the model: the opener goes with the hand-over (en)', () => {
    const v = gate(handedOverAsAdvice('en', true), BIRTHDAYS, [GAP.en.c2]);
    expectOpener(v, GAP.en.c2);
    expect(v).toMatchObject({ reason: 'OK', intent: 'birthday_advice', intents: ['birthday_advice', 'birthday_party'] });
  });

  it('A, "for a party of 12 kids": the headcount is said, so the warm line goes alone', () => {
    expectWarmLineOnly(gate(handedOverAsAdvice('en', false), BIRTHDAYS, [STAGING_A]), STAGING_A);
  });

  it('D, "для 10 детей": no party asked for, a headcount said; the warm line goes alone', () => {
    expectWarmLineOnly(gate(handedOverAsAdvice('ru', false), BIRTHDAYS, [STAGING_D]), STAGING_D);
  });

  for (const lang of ['en', 'ru', 'th'] as const) {
    it(`C and C2 in ${lang}: the opener goes, in the thread's language, the intents keep birthday_advice`, () => {
      const c = gate(handedOverAsAdvice(lang, false), BIRTHDAYS, [GAP[lang].c]);
      expectOpener(c, GAP[lang].c);
      expect(c.action === 'handover' && c.language, GAP[lang].c).toBe(lang);
      const c2 = gate(handedOverAsAdvice(lang, true), BIRTHDAYS, [GAP[lang].c2]);
      expectOpener(c2, GAP[lang].c2);
      expect(c2.intents, GAP[lang].c2).toEqual(['birthday_advice', 'birthday_party']);
    });

    it(`C in ${lang} read by the model as a faq answer: the safety net hands it over, with the opener, and none of the model's words`, () => {
      const v = gate(
        { language: lang, intent: 'faq', grounding: ['faq.food-outside'], reason: 'FACT_IN_KB', bubbles: ['Both parks are great for parties 😊'] },
        BIRTHDAYS,
        [GAP[lang].c],
      );
      expectOpener(v, GAP[lang].c);
      expect(v).toMatchObject({ reason: 'OVERRULED_BIRTHDAY', holdingBubbles: [], droppedHoldingRule: BIRTHDAY_ADVICE_RULE });
    });
  }

  it('the party asked for in a general thread is the birthday flow too: the advice hand-over carries the opener', () => {
    expectOpener(gate(handedOverAsAdvice('en', true), GENERAL, [GAP.en.c2]), GAP.en.c2);
    expectOpener(gate(handedOverAsAdvice('en', false), GENERAL, [GAP.en.c]), GAP.en.c);
  });
});

describe('SCRUM-823: the opener is asked once, and never over what the family said', () => {
  const asked = (state: EpisodeQuestion['state']): EpisodeQuestion[] =>
    ADVICE_OPENER_SLOTS.map((slot) => ({ slot, state, answer: state === 'answered' && slot === 'park' ? 'central' : null }));
  const second = 'Which package would you recommend for the party?';

  it('a second advice question after the opener (its questions still open): the warm line alone', () => {
    const e = { ...BIRTHDAYS, earlierIntents: ['birthday_party' as const], questions: asked('open') };
    expectWarmLineOnly(gate(handedOverAsAdvice('en', false), e, [second]), second);
    expectWarmLineOnly(gate(handedOverAsAdvice('en', true), e, [second]), second);
  });

  it('after the opener was answered, or taken over by a person: the warm line alone', () => {
    for (const state of ['answered', 'withdrawn'] as const) {
      expectWarmLineOnly(gate(handedOverAsAdvice('en', true), { ...BIRTHDAYS, questions: asked(state) }, [GAP.en.c2]), state);
    }
    // One date question is enough: the park question alone, too.
    expectWarmLineOnly(gate(handedOverAsAdvice('en', true), { ...BIRTHDAYS, questions: [{ slot: 'date', state: 'open', answer: null }] }, [GAP.en.c2]), 'date');
    expectWarmLineOnly(gate(handedOverAsAdvice('en', true), { ...BIRTHDAYS, questions: [{ slot: 'park', state: 'answered', answer: 'chalong' }] }, [GAP.en.c2]), 'park');
  });

  it('an earlier reply was the opener (no question kept for it): the warm line alone', () => {
    expect(openerAskedBefore(episode({ earlierIntents: ['birthday_party'] }))).toBe(true);
    expectWarmLineOnly(gate(handedOverAsAdvice('en', true), { ...BIRTHDAYS, earlierIntents: ['birthday_party'] }, [GAP.en.c2]), 'earlier opener');
  });

  it('a question the opener does not ask (the child’s age) never stops it', () => {
    const e = { ...BIRTHDAYS, questions: [{ slot: 'child_age' as const, state: 'answered' as const, answer: '5' }] };
    expect(openerAskedBefore(episode(e))).toBe(false);
    expectOpener(gate(handedOverAsAdvice('en', true), e, [GAP.en.c2]), 'child_age asked');
  });

  it('party words after an earlier birthday reply are not a first request: the model’s label decides', () => {
    const e = { ...BIRTHDAYS, earlierIntents: ['birthday_cake' as const] };
    expectWarmLineOnly(gate(handedOverAsAdvice('en', false), e, [GAP.en.c]), 'advice alone');
    expectOpener(gate(handedOverAsAdvice('en', true), e, [GAP.en.c2]), 'birthday_party labelled');
  });

  it('a greeting answered first is no birthday reply: the family’s first word on the party still gets the opener', () => {
    expectOpener(gate(handedOverAsAdvice('en', false), { ...BIRTHDAYS, earlierIntents: ['greeting'], aiAnswers: 1 }, [GAP.en.c]), 'after a greeting');
  });

  it('a burst that already says a date, a day, a headcount or the park: the warm line alone (one fixed line cannot skip it)', () => {
    for (const line of [
      'We want a birthday party for our daughter on 5 December. What would you suggest?',
      'We want a birthday party for our daughter this Saturday. What would you suggest?',
      'We want a birthday party for our daughter tomorrow. What would you suggest?',
      'We want a birthday party for about 15 kids. What would you suggest?',
      'We want a birthday party at Central Floresta. Which package would you recommend?',
      'Хотим отметить день рождения в субботу. Что посоветуете?',
      'Хотим день рождения на 20 человек. Что посоветуете?',
      'อยากจัดวันเกิดพรุ่งนี้ค่ะ แนะนำอะไรดีคะ',
      'อยากจัดวันเกิดที่ Central ค่ะ แนะนำแพ็กเกจไหนคะ',
      'อยากจัดวันเกิด เด็ก 12 คนค่ะ แนะนำอะไรดีคะ',
    ]) {
      expect(namesPartyBasics([line]), line).toBe(true);
      expectWarmLineOnly(gate(handedOverAsAdvice('en', true), BIRTHDAYS, [line]), line);
    }
    // The park the model read in the burst counts too.
    expectWarmLineOnly(gate({ ...handedOverAsAdvice('en', true), branchNamed: 'chalong' }, BIRTHDAYS, [GAP.en.c2]), 'branchNamed');
  });

  it('the model read the basics in (birthday_details beside the advice): the warm line alone', () => {
    const v = gate({ ...handedOverAsAdvice('en', false), intent: 'birthday_details', intents: ['birthday_details', 'birthday_advice'] }, BIRTHDAYS, [GAP.en.c]);
    expectWarmLineOnly(v, 'birthday_details');
  });

  it('advice with no party asked for: the warm line alone', () => {
    for (const line of ['Which branch is better for us?', 'Is it possible to bring our own entertainer?', 'สาขาไหนดีกว่าคะ']) {
      expect(asksForParty([line]), line).toBe(false);
      expectWarmLineOnly(gate(handedOverAsAdvice('en', false), BIRTHDAYS, [line]), line);
    }
  });
});

describe('SCRUM-823: every other turn is as it was', () => {
  it('a plain fact in a birthday thread is answered, with no opener', () => {
    const v = gate(
      { intent: 'directions_parking', grounding: ['parking@central'], reason: 'FACT_IN_KB', bubbles: ['Park in the mall car park, level 3 is closest to us 😊'] },
      BIRTHDAYS,
      ['We want a birthday party later. Do you have parking?'],
    );
    expect(v.action).toBe('answer');
    expect('adviceOpener' in v).toBe(false);
  });

  it('the overrule path keeps the model’s own opener: an answer, the birthday manager’s line after it, no template opener', () => {
    const bubbles = ["Amazing, thank you! We'd love to organize a party for you 🎈", 'What date are you thinking of, roughly how many people, and which branch?'];
    for (const intents of [['birthday_party', 'faq'], ['birthday_party', 'birthday_advice']] as const) {
      const v = gate({ intent: 'birthday_party', intents: [...intents], bubbles, reason: 'CLEAR_INTENT' }, BIRTHDAYS, [GAP.en.c2]);
      expect(v, intents.join()).toMatchObject({ action: 'answer', intent: 'birthday_party', bubbles, thenHandover: BIRTHDAYS_PLAN });
      expect(v.intents, intents.join()).toEqual(['birthday_party', 'birthday_advice']);
      expect('adviceOpener' in v, intents.join()).toBe(false);
    }
  });

  it('the model’s opener failing a guard beside the advice: handed over alone, and the template opener asks in its place', () => {
    const v = gate(
      { intent: 'birthday_party', intents: ['birthday_party', 'faq'], bubbles: ['We can do 50% off for 30 kids!'], reason: 'CLEAR_INTENT' },
      BIRTHDAYS,
      ["Hi! We'd like a birthday party. Which branch do you recommend?"],
    );
    expectOpener(v, 'guard');
    expect(v).toMatchObject({ reason: 'OVERRULED_BIRTHDAY', holdingBubbles: [], droppedHoldingRule: BIRTHDAY_ADVICE_RULE });
  });

  it('a hand-over that is not birthday advice never carries the opener (the party’s details, a complaint, a child in our care)', () => {
    const details = gate({ intent: 'birthday_details', action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] }, BIRTHDAYS, ['We would like a birthday party, about 12 kids']);
    expect(details.action === 'handover' && details.adviceOpener).toBeFalsy();
    const complaint = gate(
      { intent: 'complaint_onsite', intents: ['complaint_onsite', 'birthday_advice'], action: 'handover', reason: 'NEEDS_PERSON', bubbles: [] },
      BIRTHDAYS,
      ['The party was a mess. Which branch is better for a birthday next time?'],
    );
    expect(complaint.action === 'handover' && complaint.adviceOpener).toBeFalsy();
    const care = gate({ intent: 'drop_off_care', intents: ['drop_off_care', 'birthday_advice'], action: 'handover' }, BIRTHDAYS, ['Is my son ok? And which party package do you suggest?']);
    expect(care.action).toBe('silent_handover');
  });

  it('adviceOpenerOn returns any verdict that is not a birthday advice hand-over untouched', () => {
    const input = { decision: decision(handedOverAsAdvice('en', false)), grounding: knowledge.grounding, episode: episode(BIRTHDAYS), openLines: [GAP.en.c] };
    const silent: GateVerdict = { action: 'silent', reason: 'MODEL_SILENT', intent: 'birthday_advice', intents: ['birthday_advice'] };
    expect(adviceOpenerOn(silent, input)).toBe(silent);
    const cap: GateVerdict = {
      action: 'handover',
      reason: 'CAP_EPISODE',
      intent: 'birthday_advice',
      intents: ['birthday_advice'],
      language: 'en',
      plan: BIRTHDAYS_PLAN,
      holdingBubbles: [],
      branchNamed: null,
    };
    expect(adviceOpenerOn(cap, input)).toBe(cap);
  });

  it('no open lines (an older caller) and no party label: no opener', () => {
    const v = applyGates({ decision: decision(handedOverAsAdvice('en', false)), grounding: knowledge.grounding, episode: episode(BIRTHDAYS) });
    expectWarmLineOnly(v, 'no lines');
  });
});

describe('SCRUM-823: the readers', () => {
  it('the opener asks the playbook’s three basics, each a slot of the opener’s flow', () => {
    expect(ADVICE_OPENER_SLOTS).toEqual(['date', 'guests_count', 'park']);
    for (const slot of ADVICE_OPENER_SLOTS) expect(INTENT_SLOTS.birthday_party).toContain(slot);
  });

  it('a party asked for, in the three languages', () => {
    for (const line of [
      ...Object.values(GAP).flatMap((g) => [g.c, g.c2]),
      'Can we celebrate our son’s 5th here?',
      'Хотим отметить ДР сына',
      'Хотим отпраздновать именины',
      'ขอสอบถามเรื่องจัดงานเลี้ยงค่ะ',
    ]) {
      expect(asksForParty([line]), line).toBe(true);
    }
    for (const line of [STAGING_D, 'Which branch is better for us?', 'Do you have parking?', 'สาขาไหนดีกว่าคะ', 'Какой пакет лучше?']) {
      expect(asksForParty([line]), line).toBe(false);
    }
  });

  it('a headcount, never an age, a time or a choice', () => {
    for (const line of ['a party of 12 kids', 'для 10 детей', 'на 20 человек', 'เด็ก 12 คน', 'we will be 20', 'for 15 guests', 'about 8 adults']) {
      expect(headcountNamedIn(line), line).toBe(true);
    }
    for (const line of ['for our 5 year old', 'at 2 pm', 'package 3', 'which one is better?', 'для детей 5 лет', 'for 3 hours', 'her 6th birthday']) {
      expect(headcountNamedIn(line), line).toBe(false);
    }
  });

  it('the gap wordings name none of the basics; "today" in Thai opens a message without naming the day', () => {
    for (const g of Object.values(GAP)) expect(namesPartyBasics([g.c, g.c2]), g.c).toBe(false);
    expect(namesPartyBasics(['วันนี้อยากสอบถามเรื่องจัดงานวันเกิดค่ะ แนะนำอะไรดีคะ'])).toBe(false);
  });
});
