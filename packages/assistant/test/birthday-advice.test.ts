import { describe, expect, it } from 'vitest';
import {
  BIRTHDAY_ADVICE_OVERRULED,
  BIRTHDAY_ADVICE_RULE,
  adviceAskIn,
  asksBirthdayAdvice,
  birthdayAdviceOverrule,
} from '../src/advice';
import { PART_JOIN } from '../src/compose';
import type { AiDecision } from '../src/decision';
import { BIRTHDAY_DATE_RULE, applyGates, type EpisodeState } from '../src/gate';
import {
  ASK_FIRST_IGNORED_INTENTS,
  BIRTHDAY_INTENTS,
  BIRTHDAYS_PLAN,
  GM_PLAN,
  INTENT_TABLE,
  birthdayThreadOf,
} from '../src/intents';
import { PLAYBOOK_LINES } from '../src/persona';
import { BIRTHDAY_THREAD_LINES, INTENT_MEANING, STATIC_SYSTEM_TEXT, buildPrompt } from '../src/prompt';
import { context, decision, episode, fixtureKnowledge, NOW } from './support';

/**
 * SCRUM-823 (owner, 10 November): in Birthdays & Events the assistant still
 * asks the date-and-park opener (owner D1, 28 October), but a family asking
 * for ADVICE, a RECOMMENDATION or a CHOICE — which park is better for us, what
 * do you suggest, which package would you recommend, can we…, is it possible
 * to… — is handed to a person at once, with the birthday manager's closing
 * line. Two layers, as SCRUM-817's date rule:
 *
 *   1. the model labels it `birthday_advice` (a hand-over that stands alone,
 *      except after the opener: the opener is answered, the line follows);
 *   2. the gate's word list, in Thai, English and Russian, overrules an advice
 *      question the model labelled `birthday_details` or `faq` in a birthday
 *      thread to `birthday_advice`. "Can we…" (the possibility tier) never
 *      withholds a faq answer the model grounded in the knowledge.
 *
 * A plain fact question is still answered, the opener is still asked (alone
 * or beside the advice), and a thread that is not a birthday one is untouched.
 */

const knowledge = fixtureKnowledge();

const BIRTHDAYS: Partial<EpisodeState> = { threadCategory: 'birthdays', earlierIntents: [] };
const GENERAL: Partial<EpisodeState> = { threadCategory: 'general', earlierIntents: [] };
const EARLIER_PARTY: Partial<EpisodeState> = { threadCategory: 'general', earlierIntents: ['birthday_party'] };

const gate = (d: Partial<AiDecision>, e: Partial<EpisodeState>, lines: readonly string[]) =>
  applyGates({ decision: decision(d), grounding: knowledge.grounding, episode: episode(e), openLines: lines });

/** The verdict the safety net makes: the birthday hand-over, alone, the model's words never sent, and why. */
const ADVICE_HANDOVER = {
  action: 'handover',
  reason: 'OVERRULED_BIRTHDAY',
  intent: 'birthday_advice',
  plan: BIRTHDAYS_PLAN,
  holdingBubbles: [],
  droppedHoldingRule: BIRTHDAY_ADVICE_RULE,
} as const;

/** An answer the model might write to a faq label: grounded, so a general thread would send it. */
const FAQ_ANSWER: Partial<AiDecision> = {
  intent: 'faq',
  grounding: ['faq.food-outside'],
  bubbles: ['Both parks are great for parties 😊'],
  reason: 'FACT_IN_KB',
};

/** Advice in the three languages, the brief's own examples among them. */
const ADVICE: Record<'en' | 'ru' | 'th', readonly string[]> = {
  en: [
    'Which branch do you recommend for 12 kids?',
    'which park is better for us?',
    'What do you suggest for a 5 year old?',
    'Which package would you recommend?',
  ],
  ru: ['Какой филиал лучше для детей 5 лет?', 'Что вы посоветуете для 10 детей?', 'Какой пакет выбрать?', 'Подскажите, где лучше провести праздник?'],
  th: ['สาขาไหนดีกว่าคะ', 'แนะนำแพ็กเกจไหนคะ', 'จัดที่ Central ดีไหมคะ', 'สาขาไหนเหมาะกับเด็กเล็กคะ'],
};

/** "Can we…", "is it possible to…" — the owner's examples of a choice to ask a person. */
const POSSIBLE: Record<'en' | 'ru' | 'th', string> = {
  en: 'Is it possible to bring our own entertainer?',
  ru: 'Можно ли прийти со своим аниматором?',
  th: 'เอาเค้กมาเองได้ไหมคะ',
};

/** Facts the knowledge holds: still answered in a birthday thread. */
const FACTS: Record<'en' | 'ru' | 'th', string> = {
  en: 'Do you have parking?',
  ru: 'Есть ли у вас парковка?',
  th: 'มีที่จอดรถไหมคะ',
};

describe('SCRUM-823: the birthday_advice intent', () => {
  it('is a birthday hand-over that stands alone, with the birthday manager’s line and no lead line', () => {
    expect(INTENT_TABLE.birthday_advice).toEqual({ action: 'handover', plan: BIRTHDAYS_PLAN, answerAlongside: false, lead: false });
    expect(BIRTHDAY_INTENTS.has('birthday_advice')).toBe(true);
    expect(birthdayThreadOf({ threadCategory: 'general', earlierIntents: ['birthday_advice'] })).toBe('earlier');
    // An operator rule's ask-first question never interrupts it, as the rest of the birthday flow.
    expect(ASK_FIRST_IGNORED_INTENTS).toContain('birthday_advice');
  });

  it('the prompt names it with examples in the three languages and keeps the opener rule', () => {
    expect(STATIC_SYSTEM_TEXT).toContain(`- birthday_advice: ${INTENT_MEANING.birthday_advice} -> handover, alone:`);
    expect(INTENT_MEANING.birthday_advice).toMatch(/Which branch is better/);
    expect(INTENT_MEANING.birthday_advice).toMatch(/посоветуете/);
    expect(INTENT_MEANING.birthday_advice).toMatch(/สาขาไหน/);
    expect(PLAYBOOK_LINES).toMatch(/birthday_advice \([^\n]*\): alone, no words of your own[^\n]*The opener stays birthday_party\./);
    // The opener (owner D1) is unchanged.
    expect(PLAYBOOK_LINES).toContain('birthday_party: open warmly');
    expect(STATIC_SYSTEM_TEXT).toContain(PLAYBOOK_LINES);
  });

  it('a birthday thread’s user turn carries the advice line beside the date rule; another thread does not', () => {
    const turn = (c: Partial<EpisodeState>) => {
      const built = buildPrompt({
        knowledge,
        episode: [{ from: 'customer', at: NOW, text: 'Which branch is better for us?' }],
        context: context(c),
      });
      if (!built.ok) throw new Error('prompt refused');
      return built.prompt.messages[0].content;
    };
    const birthdays = turn(BIRTHDAYS);
    expect(birthdays).toContain(`${BIRTHDAY_THREAD_LINES.category} ${BIRTHDAY_THREAD_LINES.rule} ${BIRTHDAY_THREAD_LINES.advice}`);
    expect(BIRTHDAY_THREAD_LINES.advice).toMatch(/birthday_advice: no words of your own/);
    expect(BIRTHDAY_THREAD_LINES.advice).toMatch(/still gets birthday_party first/);
    expect(turn(GENERAL)).not.toContain(BIRTHDAY_THREAD_LINES.advice);
  });

  for (const lang of ['en', 'ru', 'th'] as const) {
    it(`the model's own birthday_advice label (${lang}) is a hand-over to Birthdays, whatever it wrote`, () => {
      for (const line of ADVICE[lang]) {
        const v = gate({ language: lang, intent: 'birthday_advice', action: 'answer', bubbles: ['Central is bigger!'] }, BIRTHDAYS, [line]);
        expect(v.action, line).toBe('handover');
        if (v.action !== 'handover') continue;
        expect(v.plan).toEqual(BIRTHDAYS_PLAN);
        expect(v.intent).toBe('birthday_advice');
      }
    });
  }
});

describe('SCRUM-823: the word list (three languages, two tiers)', () => {
  it('reads advice proper in Thai, English and Russian', () => {
    for (const lang of ['en', 'ru', 'th'] as const) {
      for (const line of ADVICE[lang]) expect(adviceAskIn([line]), line).toBe('advice');
    }
  });

  it('reads "can we…" and "is it possible to…" as the possibility tier', () => {
    for (const lang of ['en', 'ru', 'th'] as const) expect(adviceAskIn([POSSIBLE[lang]]), POSSIBLE[lang]).toBe('possibility');
    expect(adviceAskIn(['Can we decorate the room ourselves?'])).toBe('possibility');
  });

  it('reads nothing in a plain fact question, a statement or a sign-off', () => {
    for (const line of [
      ...Object.values(FACTS),
      'We were recommended by a friend',
      'Saturday works better for us',
      'Thanks, best regards',
      'Which packages do you have?',
      'ประมาณ 12 คนค่ะ จัดที่ Central Floresta ค่ะ',
      'Нас будет 15 детей',
    ]) {
      expect(adviceAskIn([line]), line).toBeNull();
    }
  });

  it('a fact asked as "which", "best" or politely is not advice (review, 10 Nov)', () => {
    for (const line of [
      'Which branch is open on Monday?',
      'Which one has the bigger party room?',
      'What is the best time to arrive?',
      'Какой филиал открыт в понедельник?',
      'สาขาไหนเปิดวันจันทร์คะ',
      'May I ask what time you close?',
      'Can I see the menu?',
      'Можно узнать, во сколько вы закрываетесь?',
    ]) {
      expect(adviceAskIn([line]), line).toBeNull();
    }
    // A choice still is, and a polite opener never hides one.
    for (const line of ['Which one is better for us?', 'Which package should we take?', 'Which one would you pick?', 'Какой зал лучше выбрать?', 'ห้องไหนดีคะ']) {
      expect(adviceAskIn([line]), line).toBe('advice');
    }
    expect(adviceAskIn(['May I ask, can we bring our own cake?'])).toBe('possibility');
  });

  it('a yes/no fact in "can I", "можно" or "ได้ไหม", answered from the knowledge in a birthday thread, is answered, never handed over', () => {
    const facts: Record<'en' | 'ru' | 'th', readonly string[]> = {
      en: ['Can I pay by card?', 'May I ask what time you close?', 'Can I see the menu?'],
      ru: ['Можно оплатить картой?', 'Можно узнать, во сколько вы закрываетесь?'],
      th: ['จอดรถได้ไหมคะ', 'จ่ายบัตรได้ไหมคะ'],
    };
    for (const lang of ['en', 'ru', 'th'] as const) {
      for (const line of facts[lang]) {
        const v = gate({ ...FAQ_ANSWER, language: lang }, BIRTHDAYS, [line]);
        expect(v.action, line).toBe('answer');
        expect(v.intents, line).toEqual(['faq']);
      }
    }
  });

  it('a "can we" that names a day, a date or a time is the party’s details, never advice (SCRUM-817 stays)', () => {
    for (const line of ['Can we do Saturday at 2 pm?', 'Можно в субботу в 2 часа дня?', 'เสาร์นี้บ่ายสองได้ไหมคะ']) {
      expect(adviceAskIn([line]), line).toBe('possibility');
      expect(asksBirthdayAdvice([line]), line).toBeNull();
    }
    // Advice proper with a date is still advice.
    expect(asksBirthdayAdvice(['Which is better, Saturday or Sunday?'])).toBe('advice');
  });
});

describe('SCRUM-823: the gate’s safety net in a birthday thread', () => {
  it('overrules only details and faq', () => {
    expect([...BIRTHDAY_ADVICE_OVERRULED].sort()).toEqual(['birthday_details', 'faq']);
  });

  for (const lang of ['en', 'ru', 'th'] as const) {
    it(`an advice question labelled faq (${lang}) is handed over as birthday_advice; the model's words never go`, () => {
      for (const line of ADVICE[lang]) {
        const v = gate({ ...FAQ_ANSWER, language: lang }, BIRTHDAYS, [line]);
        expect(v, line).toMatchObject({ ...ADVICE_HANDOVER, language: lang });
        expect(v.intents).toEqual(['birthday_advice']);
      }
    });

    it(`an advice question labelled birthday_details (${lang}) becomes birthday_advice`, () => {
      const v = gate({ language: lang, intent: 'birthday_details', action: 'handover', reason: 'NEEDS_PERSON' }, BIRTHDAYS, [ADVICE[lang][0]!]);
      expect(v).toMatchObject({ ...ADVICE_HANDOVER, language: lang });
    });

    it(`"is it possible…" (${lang}) labelled faq with no fact of the knowledge behind it is handed over too`, () => {
      const ungrounded: Partial<AiDecision>[] = [
        { grounding: [], reason: 'CLEAR_INTENT' },
        { grounding: ['faq.food-outside'], reason: 'FACT_MISSING' },
        { grounding: ['faq.nowhere'], reason: 'FACT_IN_KB' },
      ];
      for (const u of ungrounded) {
        expect(gate({ ...FAQ_ANSWER, ...u, language: lang }, BIRTHDAYS, [POSSIBLE[lang]]), JSON.stringify(u)).toMatchObject(ADVICE_HANDOVER);
      }
    });

    it(`"is it possible…" (${lang}) labelled faq and answered from a fact of the knowledge is answered`, () => {
      const v = gate({ ...FAQ_ANSWER, language: lang }, BIRTHDAYS, [POSSIBLE[lang]]);
      expect(v.action).toBe('answer');
      expect(v.intents).toEqual(['faq']);
    });

    it(`a plain fact question (${lang}) is still answered in a birthday thread`, () => {
      const v = gate(
        { language: lang, intent: 'directions_parking', grounding: ['parking@central'], bubbles: ['Park in the mall car park, level 3 is closest to us 😊'] },
        BIRTHDAYS,
        [FACTS[lang]],
      );
      expect(v.action).toBe('answer');
      const faq = gate({ ...FAQ_ANSWER, language: lang }, BIRTHDAYS, [FACTS[lang]]);
      expect(faq.action).toBe('answer');
    });
  }

  it('"which branch do you recommend for 12 kids?" is handed over at once, the other parts of the burst unanswered', () => {
    const v = gate(
      { intent: 'hours', intents: ['hours', 'faq'], grounding: ['fact.hours.central'], bubbles: ['Open 10:00–20:00 😊', 'Central is bigger!'] },
      BIRTHDAYS,
      ['what time do you open? and which branch do you recommend for 12 kids?'],
    );
    expect(v).toMatchObject({ action: 'handover', reason: 'OVERRULED_BIRTHDAY', plan: BIRTHDAYS_PLAN, holdingBubbles: [] });
    expect(v.intents).toEqual(['hours', 'birthday_advice']);
  });

  it('the opener is still asked: birthday_party is never overruled, whatever the words', () => {
    const opener = gate(
      {
        intent: 'birthday_party',
        bubbles: ["Amazing, thank you! We'd love to organize a party for you 🎈", 'What date are you thinking of, roughly how many people, and which branch?'],
      },
      BIRTHDAYS,
      ['Hi! Can we have a birthday party at OTO?'],
    );
    expect(opener.action).toBe('answer');
    expect(opener.intent).toBe('birthday_party');
  });

  it('a date the model read as hours stays SCRUM-817’s birthday_details; advice with a date becomes birthday_advice', () => {
    const date = gate(
      { language: 'ru', intent: 'hours', grounding: ['fact.hours.central'], bubbles: ['Мы открыты 10:00–20:00 😊'], reason: 'FACT_IN_KB' },
      BIRTHDAYS,
      ['Можно в субботу в 2 часа дня?'],
    );
    expect(date).toMatchObject({ action: 'handover', intent: 'birthday_details', droppedHoldingRule: BIRTHDAY_DATE_RULE });
    const better = gate(
      { intent: 'hours', grounding: ['fact.hours.central'], bubbles: ['Open every day 😊'], reason: 'FACT_IN_KB' },
      BIRTHDAYS,
      ['Which is better for the party, Saturday or Sunday?'],
    );
    expect(better).toMatchObject(ADVICE_HANDOVER);
  });

  it('a thread whose earlier replies were about a party counts as a birthday thread', () => {
    expect(gate(FAQ_ANSWER, EARLIER_PARTY, ['Which branch is better for us?'])).toMatchObject(ADVICE_HANDOVER);
  });

  it('never touches another thread: the same faq answer goes out in a general thread', () => {
    const v = gate(FAQ_ANSWER, GENERAL, ['Which branch is better for us?']);
    expect(v.action).toBe('answer');
    expect(birthdayAdviceOverrule({ decision: decision(FAQ_ANSWER), grounding: knowledge.grounding, episode: episode(GENERAL), openLines: ['Which branch is better?'] })).toBeNull();
  });

  it('a complaint or a child in our care keeps its own verdict', () => {
    const complaint = gate(
      { intent: 'complaint_onsite', intents: ['complaint_onsite', 'faq'], action: 'handover', bubbles: ["We're so sorry to hear that."] },
      BIRTHDAYS,
      ['The party was a mess. Which branch is better next time?'],
    );
    expect(complaint.action === 'handover' || complaint.action === 'answer').toBe(true);
    if (complaint.action === 'handover') expect(complaint.plan).toEqual(GM_PLAN);
    if (complaint.action === 'answer') expect(complaint.thenHandover).toEqual(GM_PLAN);
    const care = gate({ intent: 'drop_off_care', intents: ['drop_off_care', 'faq'], action: 'handover' }, BIRTHDAYS, ['How is my son? Can we pick him up early?']);
    expect(care.action).toBe('silent_handover');
  });

  it('advice beside the opener: the opener is answered, the birthday manager’s line follows, the advice part kept (en, ru, th)', () => {
    const bursts: Array<{ language: 'en' | 'ru' | 'th'; line: string; bubbles: string[] }> = [
      {
        language: 'en',
        line: "Hi! We'd like a birthday party for our son. Which branch do you recommend?",
        bubbles: ["Amazing, thank you! We'd love to organize a party for you 🎈", 'What date are you thinking of, roughly how many people, and which branch?'],
      },
      {
        language: 'ru',
        line: 'Здравствуйте! Хотим отметить день рождения сына. Какой филиал вы посоветуете?',
        bubbles: ['Замечательно, спасибо! Мы с радостью организуем для вас праздник 🎈', 'Какую дату вы рассматриваете, сколько примерно будет гостей и какой филиал вам удобен?'],
      },
      {
        language: 'th',
        line: 'สวัสดีค่ะ อยากจัดงานวันเกิดให้ลูกค่ะ แนะนำสาขาไหนคะ',
        bubbles: ['ยินดีมากเลยค่ะ เรายินดีจัดปาร์ตี้ให้นะคะ 🎈', 'สนใจจัดช่วงไหน ประมาณกี่ท่าน และสาขาไหนคะ'],
      },
    ];
    for (const b of bursts) {
      // SCRUM-832: one message per turn — the opener's two parts in one bubble; the birthday manager's line follows on its own.
      const message = [b.bubbles.join(PART_JOIN)];
      // The net's reading: the model labelled the advice faq.
      const net = gate({ language: b.language, intent: 'birthday_party', intents: ['birthday_party', 'faq'], bubbles: b.bubbles, reason: 'CLEAR_INTENT' }, BIRTHDAYS, [b.line]);
      expect(net, b.line).toMatchObject({ action: 'answer', intent: 'birthday_party', bubbles: message, thenHandover: BIRTHDAYS_PLAN, mayAutoHandle: false });
      expect(net.intents, b.line).toEqual(['birthday_party', 'birthday_advice']);
      // The model's own reading: the same.
      const own = gate({ language: b.language, intent: 'birthday_party', intents: ['birthday_party', 'birthday_advice'], bubbles: b.bubbles, reason: 'CLEAR_INTENT' }, BIRTHDAYS, [b.line]);
      expect(own, b.line).toMatchObject({ action: 'answer', bubbles: message, thenHandover: BIRTHDAYS_PLAN });
      expect(own.intents, b.line).toEqual(['birthday_party', 'birthday_advice']);
    }
  });

  it('a plain fact beside the opener, answered from the knowledge, is answered with it; nothing is handed over', () => {
    const v = gate(
      {
        intent: 'birthday_party',
        intents: ['birthday_party', 'faq'],
        grounding: ['faq.food-outside'],
        reason: 'FACT_IN_KB',
        bubbles: ["Amazing, thank you! We'd love to organize a party for you 🎈", 'What date are you thinking of, roughly how many people, and which branch?'],
      },
      BIRTHDAYS,
      ["Hi! We'd like a birthday party for our son. Can I pay by card?"],
    );
    expect(v).toMatchObject({ action: 'answer', intent: 'birthday_party', thenHandover: null });
    expect(v.intents).toEqual(['birthday_party', 'faq']);
  });

  it('the opener’s words failing a guard beside the advice: the advice is handed over alone, never silence', () => {
    const v = gate(
      { intent: 'birthday_party', intents: ['birthday_party', 'faq'], bubbles: ['We can do 50% off for 30 kids!'], reason: 'CLEAR_INTENT' },
      BIRTHDAYS,
      ["Hi! We'd like a birthday party. Which branch do you recommend?"],
    );
    expect(v).toMatchObject(ADVICE_HANDOVER);
    expect(v.intents).toEqual(['birthday_advice', 'birthday_party']);
  });

  it('no open lines (an older caller): the safety net never fires', () => {
    const v = applyGates({ decision: decision(FAQ_ANSWER), grounding: knowledge.grounding, episode: episode(BIRTHDAYS) });
    expect(v.action).toBe('answer');
  });
});
