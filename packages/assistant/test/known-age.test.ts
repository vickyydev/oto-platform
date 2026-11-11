/**
 * SCRUM-842 — THE AGE THE CUSTOMER ALREADY SAID IS NEVER ASKED (staging, 9
 * Nov 2026, Demo WhatsApp · Central Floresta: "do you have drop-off for a six
 * year old?" was answered with "how old is your child?"). The owner's rule
 * (SCRUM-831, SCRUM-832): the assistant never asks what it already knows.
 *
 *   - the reader: the child's age said UNASKED in the customer's own lines,
 *     in digits and number words, in English, Russian and Thai — never a
 *     count, a time, a price, a limit or an adult's age;
 *   - another child whose age was not said makes it unknown again;
 *   - the prompt names the fact below the breakpoint, only when there is one;
 *   - the composer cuts the age question, the rest as written;
 *   - the repeat guard refuses a draft that still asks it, with the fact.
 *
 * FICTIONAL TEST DATA throughout.
 */

import { describe, expect, it } from 'vitest';
import { childAgeSaidByFamily, composeTurn, withoutAgeQuestion, withoutAgeQuestions } from '../src/compose';
import { repeatGuard, type GateInput, type GateVerdict } from '../src/gate';
import { MEMORY_LINES, buildPrompt, type PromptMemory } from '../src/prompt';
import { askedSlotsOf, asksAnotherChildsAge, asksChildAge, childAgeSaidIn } from '../src/slots';
import { context, decision, episode, fixtureKnowledge, NOW } from './support';

const STAGING_LINE = 'ZZ TEST do you have drop-off for a six year old?';
const said = (line: string) => childAgeSaidIn([line]);

describe('the reader: the age the customer said unasked', () => {
  it('reads the staging line', () => {
    expect(said(STAGING_LINE)).toBe('6');
  });

  it('English: digits and number words, the common forms', () => {
    for (const line of [
      'drop-off for a six year old',
      'she is 6 years old',
      'my daughter is 6yo',
      'a 6 y.o. girl',
      'a 6-year-old',
      'for my 6 yr old',
      'my kid, aged six',
      'my son is six',
      'she is six and loves slides',
      "She's 6.",
      'he just turned 6',
      'age: 6',
    ]) {
      expect(said(line), line).toBe('6');
    }
    expect(said('one year old')).toBe('1');
    expect(said('she is seventeen years old')).toBe('17');
    expect(said('my baby is 18 months old')).toBe('18 months');
    expect(said('she is 10 months')).toBe('10 months');
  });

  it('Russian: "шесть лет", "6 лет", "шестилетний/шестилетняя", "ей шесть", "ему 6"', () => {
    for (const line of ['шесть лет', 'ребёнку 6 лет', 'у меня шестилетний сын', 'шестилетняя дочка', 'ей шесть', 'ему 6', '6-летний', 'сыну исполнится 6', 'ему уже шесть']) {
      expect(said(line), line).toBe('6');
    }
    expect(said('дочке 3 года')).toBe('3');
    expect(said('трёхлетка')).toBe('3');
    expect(said('ей 10 месяцев')).toBe('10 months');
  });

  it('Thai: "6 ขวบ", "หก ขวบ", "อายุ 6 ปี"', () => {
    for (const line of ['6 ขวบ', 'หก ขวบ', 'ลูกอายุ 6 ปี', 'น้องหกขวบค่ะ', 'น้อง ๖ ขวบ', 'อายุ 6']) {
      expect(said(line), line).toBe('6');
    }
  });

  it('never an age from an unrelated number', () => {
    for (const line of [
      '6 kids',
      'a party for six kids',
      'at 6 pm',
      'we come at 6',
      '6 tickets',
      '2 tickets for my son',
      'my son 2 tickets',
      '600 baht',
      'table for 6',
      'we are 6',
      '6 years',
      'we lived here 6 years',
      'she is 6 minutes away',
      'she is 2 hours late',
      'she is 12 kg',
      'she is one of them',
      '6 months membership',
      'on the 6th',
      '6 лет назад были у вас',
      'she turned 6 months ago',
      'he started school 2 years ago',
      'ей 6 лет назад подарили билет',
      'живём тут 6 лет',
      'абонемент на 6 месяцев',
      'ей 2 билета',
      '6 ปี',
      'เด็ก 6 คน',
      '6 โมงเย็น',
      '600 บาท',
    ]) {
      expect(said(line), line).toBeNull();
    }
  });

  it("never a limit, a range or an adult's age", () => {
    for (const line of [
      'do you take kids from 4 years old?',
      'is it for kids under 6 years old?',
      'ages 4 to 12 years old',
      '4-12 years old',
      'kids 6 years old and above',
      'up to 12 years old?',
      'до 12 лет',
      'с 4 лет можно?',
      'ตั้งแต่ 4 ขวบ',
      'I am 35 years old',
      'my mother is 70',
    ]) {
      expect(said(line), line).toBeNull();
    }
  });

  it("a birthday: the age the child turns is the child's age; the guests are not", () => {
    expect(said('my son turns six next month')).toBe('6');
    expect(said('my son turns six, we will be six kids')).toBe('6');
    expect(said('a party for 12 kids, she will be 8')).toBe('8');
    expect(said('we will be six kids')).toBeNull();
  });

  it('several children: every age said is kept; a child whose age was not said makes it unknown', () => {
    expect(said('my kids are 6 and 9 years old')).toBe('6, 9');
    expect(childAgeSaidIn(['she is 6', 'and her brother is 9'])).toBe('6, 9');
    // A brother comes in with no age: asking it is no repeat.
    expect(childAgeSaidIn(['drop-off for a six year old', 'can her brother come too?'])).toBeNull();
    expect(said('my daughter is 6 and her brother wants to come')).toBeNull();
    // More children counted than ages said.
    expect(said('I have two kids, one is six')).toBeNull();
    expect(said('I have 2 kids, 6 and 9 years old')).toBe('6, 9');
    // An earlier age stays through lines that say nothing of a child.
    expect(childAgeSaidIn(['is there drop-off for a six year old?', 'at Central Floresta', 'how much is it?'])).toBe('6');
  });
});

describe('the prompt: the fact below the breakpoint, only when there is one', () => {
  const build = (memory?: PromptMemory) => {
    const built = buildPrompt({
      knowledge: fixtureKnowledge(),
      episode: [{ from: 'customer', at: NOW, text: STAGING_LINE }],
      context: context(),
      ...(memory ? { memory } : {}),
    });
    if (!built.ok) throw new Error(built.reason);
    return built.prompt;
  };

  it('names what the customer said, after the conversation; the system blocks are untouched', () => {
    const plain = build({ questions: [] });
    const p = build({ questions: [], said: { child_age: '6' } });
    expect(p.system).toEqual(plain.system);
    const user = p.messages[0].content;
    expect(user).toContain('<customer_said>');
    expect(user).toContain('"slot":"child_age"');
    expect(user).toContain('"customerSaid":"6 years old"');
    expect(user).toContain(MEMORY_LINES.said);
    expect(user.indexOf('</conversation>')).toBeLessThan(user.indexOf('<customer_said>'));
    expect(user.trimEnd().endsWith('Decide this turn.')).toBe(true);
  });

  it('nothing said: the user turn is byte-identical to the one built before', () => {
    expect(build({ questions: [] }).messages[0].content).not.toContain('customer_said');
    expect(build({ questions: [], said: {} }).messages[0].content).toBe(build({ questions: [] }).messages[0].content);
  });
});

describe('the cut: the age question goes, the rest as written', () => {
  it('a sentence that asks only the age goes whole, in each language', () => {
    expect(withoutAgeQuestion('How old is your little one?', 'en')).toBe('');
    expect(withoutAgeQuestion('Let me know how old she is 😊', 'en')).toBe('');
    expect(withoutAgeQuestion('How old is she, so I can check?', 'en')).toBe('');
    expect(withoutAgeQuestion('Сколько лет ребёнку?', 'ru')).toBe('');
    expect(withoutAgeQuestion('น้องอายุกี่ขวบคะ', 'th')).toBe('');
  });

  it('one clause of a combined question: only that clause is cut, the sentence stays whole', () => {
    expect(withoutAgeQuestion('Which day would you like, and how old is she?', 'en')).toBe('Which day would you like?');
    expect(withoutAgeQuestion('May I ask which day you would like and how old she is?', 'en')).toBe('May I ask which day you would like?');
    expect(withoutAgeQuestion('How old is she, and which park would you like, Central Floresta or Robinson Chalong?', 'en')).toBe(
      'Which park would you like, Central Floresta or Robinson Chalong?',
    );
    expect(withoutAgeQuestion('What date are you thinking of, roughly how many people, and how old will the birthday child be?', 'en')).toBe(
      'What date are you thinking of and roughly how many people?',
    );
    expect(withoutAgeQuestion('На какую дату планируете, и сколько лет ребёнку?', 'ru')).toBe('На какую дату планируете?');
  });

  it('a statement before the age question stays, closed as a statement', () => {
    expect(withoutAgeQuestion("It's 225 baht a visit, how old is she?", 'en')).toBe("It's 225 baht a visit.");
    expect(withoutAgeQuestion('Стоимость 225 бат за визит, сколько лет ребёнку?', 'ru')).toBe('Стоимость 225 бат за визит.');
  });

  it('left as written where a cut would break the sentence, lose a fact, or the question is about another child', () => {
    // The age clause opens the request, or sits in its middle.
    expect(withoutAgeQuestion('Could you tell me how old she is and which day you would like?', 'en')).toBeNull();
    expect(withoutAgeQuestion('Подскажите, пожалуйста, сколько лет ребёнку и на какую дату планируете?', 'ru')).toBeNull();
    // Thai is never split: a sentence with a price, or with another ask, stays.
    expect(withoutAgeQuestion('ราคา 225 บาท น้องกี่ขวบคะ', 'th')).toBeNull();
    expect(withoutAgeQuestion('สะดวกวันไหน และน้องอายุกี่ขวบคะ', 'th')).toBeNull();
    // No age asked.
    expect(withoutAgeQuestion('Which day would you like to come?', 'en')).toBeNull();
    expect(withoutAgeQuestion('Our drop-off is for children aged 4 and up.', 'en')).toBeNull();
    // Another child.
    expect(withoutAgeQuestion('And how old is her brother?', 'en')).toBeNull();
    expect(withoutAgeQuestion('How old is your other child?', 'en')).toBeNull();
    expect(withoutAgeQuestion('А сколько лет старшему?', 'ru')).toBeNull();
    expect(asksAnotherChildsAge(['Great 😊 And how old is her brother?'])).toBe(true);
    expect(asksAnotherChildsAge(['How old is your little one?'])).toBe(false);
  });

  it('a bubble keeps its other sentences and its line breaks', () => {
    expect(withoutAgeQuestions('Yes, we have drop-off at Central Floresta! 😊 How old is your child?\nIt is 225 baht a visit.', 'en')).toEqual({
      text: 'Yes, we have drop-off at Central Floresta! 😊\nIt is 225 baht a visit.',
      cuts: 1,
    });
    expect(withoutAgeQuestions('It is 225 baht a visit.', 'en')).toEqual({ text: 'It is 225 baht a visit.', cuts: 0 });
  });
});

describe('the turn: composed without the age question once the customer said the age', () => {
  const verdict = (bubbles: string[], askedSlots: Array<'child_age' | 'date'> = ['child_age']): { v: GateVerdict; input: GateInput } => {
    const d = decision({ intent: 'drop_off_service', bubbles, askedSlots });
    const v: GateVerdict = {
      action: 'answer',
      reason: 'OK',
      intent: 'drop_off_service',
      intents: ['drop_off_service'],
      language: 'en',
      bubbles,
      groundingKeys: [],
      sendBrochure: false,
      askBranch: false,
      branchNamed: null,
      thenHandover: null,
      mayAutoHandle: true,
      languageOffer: null,
    };
    return { v, input: { decision: d, grounding: new Map(), episode: episode({ threadHasBranch: true, customerLines: [STAGING_LINE] }), openLines: [STAGING_LINE] } };
  };
  const asks = (v: GateVerdict) => (v.action === 'answer' ? askedSlotsOf(v.askedSlots, v.bubbles) : null);

  it('the staging line is read from the episode, the burst counted once', () => {
    expect(childAgeSaidByFamily(verdict([]).input)).toBe('6');
  });

  it('an answer with the age question after it: the answer goes, the question does not, and nothing is recorded as asked', () => {
    const { v, input } = verdict(['Yes, we have a drop-off service 😊 It is 225 baht a visit.', 'How old is your little one?']);
    const out = composeTurn(v, input);
    expect(out).toMatchObject({ action: 'answer', bubbles: ['Yes, we have a drop-off service 😊 It is 225 baht a visit.'], askedSlots: [] });
    expect(out.action === 'answer' && out.composition).toMatchObject({ ageQuestions: 1 });
    expect(asks(out)).toEqual([]);
  });

  it('another question of the reply stays intact', () => {
    const { v, input } = verdict(['Yes, we do 😊 Which day would you like to come, and how old is she?'], ['child_age', 'date']);
    const out = composeTurn(v, input);
    expect(out).toMatchObject({ action: 'answer', bubbles: ['Yes, we do 😊 Which day would you like to come?'], askedSlots: ['date'] });
    expect(asks(out)).toEqual(['date']);
  });

  it('a reply that is only the age question is never cut to silence: it stays for the repeat guard', () => {
    const { v, input } = verdict(['How old is your child?']);
    const out = composeTurn(v, input);
    expect(out).toMatchObject({ action: 'answer', bubbles: ['How old is your child?'] });
    expect(asks(out)).toEqual(['child_age']);
  });

  it('no age said: the reply is untouched', () => {
    const { v, input } = verdict(['Yes, we have a drop-off service 😊', 'How old is your little one?']);
    const quiet = { ...input, episode: episode({ threadHasBranch: true, customerLines: ['do you have drop-off?'] }), openLines: ['do you have drop-off?'] };
    const out = composeTurn(v, quiet);
    expect(out.action === 'answer' && out.bubbles.join(' ')).toContain('How old is your little one?');
  });
});

describe('the repeat guard: what the customer said unasked is an answer they gave', () => {
  it('a draft asking the age the customer said is refused with the fact, where the age matters too', () => {
    const refusal = repeatGuard({ asked: ['child_age'], questions: [], intents: ['drop_off_service'], said: { child_age: '6' } });
    expect(refusal).toEqual({ slot: 'child_age', kind: 'answered', answer: '6', asks: 0 });
    // The same on a birthday: "my son turns six".
    expect(repeatGuard({ asked: ['date', 'child_age'], questions: [], intents: ['birthday_party'], said: { child_age: '6' } })).toMatchObject({
      slot: 'child_age',
      kind: 'answered',
      answer: '6',
    });
  });

  it('nothing said, or another slot asked: the draft may go', () => {
    expect(repeatGuard({ asked: ['child_age'], questions: [], intents: ['drop_off_service'] })).toBeNull();
    expect(repeatGuard({ asked: ['child_age'], questions: [], intents: ['drop_off_service'], said: {} })).toBeNull();
    expect(repeatGuard({ asked: ['date', 'park'], questions: [], intents: ['drop_off_service'], said: { child_age: '6' } })).toBeNull();
  });

  it("the detector's own words say what asks the age", () => {
    expect(asksChildAge('how old is she')).toBe(true);
    expect(asksChildAge('which day would you like')).toBe(false);
  });
});
