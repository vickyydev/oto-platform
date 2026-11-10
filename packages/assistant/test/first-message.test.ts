import { describe, expect, it } from 'vitest';
import { FIRST_MESSAGE_CUE_KEYS, firstMessageCategory } from '../src/first-message';

/**
 * SCRUM-830 (owner, 11 November): the FIRST customer message decides the
 * inbox queue, before any model runs — a deterministic reader in Thai,
 * English and Russian. A birthday, a party, a package, a cake, a camp or a
 * school group goes to Birthdays & Events; a refund or a complaint goes to
 * the GM; a greeting or a plain question says nothing (null), and the
 * channel's default stands. A complaint cue wins over a birthday cue in the
 * same line. The reading names the cue's key and language, never the words.
 */

const category = (text: string) => firstMessageCategory(text)?.category ?? null;

describe('birthday words → Birthdays & Events', () => {
  it('English: a birthday, a party, a package, a cake, a celebration, an event', () => {
    expect(firstMessageCategory('I want to book a Birthday Party')).toEqual({ category: 'birthdays', cue: 'birthday', language: 'en' });
    expect(firstMessageCategory('Hi! Do you have party packages for 15 kids?')).toEqual({ category: 'birthdays', cue: 'party', language: 'en' });
    expect(firstMessageCategory('can you send me your packages please?')).toEqual({ category: 'birthdays', cue: 'package', language: 'en' });
    expect(firstMessageCategory('Can I bring my own cake?')).toEqual({ category: 'birthdays', cue: 'cake', language: 'en' });
    expect(firstMessageCategory("We'd like to celebrate our son's 5th with you")).toEqual({ category: 'birthdays', cue: 'celebration', language: 'en' });
    expect(firstMessageCategory('Do you host private events?')).toEqual({ category: 'birthdays', cue: 'event', language: 'en' });
    expect(category('bday for my daughter next month')).toBe('birthdays');
    expect(category('B-day party ideas?')).toBe('birthdays');
  });

  it('English: a camp and a school group are the events team’s too', () => {
    expect(firstMessageCategory('Hello, is there a camp today?')).toEqual({ category: 'birthdays', cue: 'camp', language: 'en' });
    expect(category('Summer camps in April?')).toBe('birthdays');
    expect(firstMessageCategory('We are a school group of 30, can we visit on Tuesday?')).toEqual({ category: 'birthdays', cue: 'school_group', language: 'en' });
    expect(category('Our kindergarten would like a field trip')).toBe('birthdays');
    expect(category('Do you have a group rate for 25 children?')).toBe('birthdays');
  });

  it('a birthday QUESTION about prices or hours alone is still a birthday', () => {
    expect(category('How much is a birthday party?')).toBe('birthdays');
    expect(category('What time can a party start on Sunday?')).toBe('birthdays');
    expect(category('Birthday party prices?')).toBe('birthdays');
  });

  it('Thai: วันเกิด, ปาร์ตี้, แพ็กเกจ, เค้ก, a camp, a school', () => {
    expect(firstMessageCategory('สวัสดีค่ะ อยากจัดวันเกิดให้ลูกชายครบ 6 ขวบ')).toEqual({ category: 'birthdays', cue: 'birthday', language: 'th' });
    expect(firstMessageCategory('มีปาร์ตี้สำหรับเด็ก 10 คนไหมคะ')).toEqual({ category: 'birthdays', cue: 'party', language: 'th' });
    expect(firstMessageCategory('ขอดูแพ็กเกจหน่อยค่ะ')).toEqual({ category: 'birthdays', cue: 'package', language: 'th' });
    expect(category('แพคเกจราคาเท่าไหร่คะ')).toBe('birthdays');
    expect(firstMessageCategory('เอาเค้กมาเองได้ไหมคะ')).toEqual({ category: 'birthdays', cue: 'cake', language: 'th' });
    expect(firstMessageCategory('มีแคมป์ปิดเทอมไหมคะ')).toEqual({ category: 'birthdays', cue: 'camp', language: 'th' });
    expect(firstMessageCategory('โรงเรียนจะพาเด็กมาทัศนศึกษา 40 คน')).toEqual({ category: 'birthdays', cue: 'school_group', language: 'th' });
  });

  it('Russian: день рождения, ДР, праздник, пакет, торт, лагерь, экскурсия', () => {
    expect(firstMessageCategory('Хотим отметить день рождения сына у вас')).toEqual({ category: 'birthdays', cue: 'birthday', language: 'ru' });
    expect(firstMessageCategory('Здравствуйте! Можно у вас ДР отпраздновать?')).toEqual({ category: 'birthdays', cue: 'birthday', language: 'ru' });
    expect(firstMessageCategory('Какие у вас пакеты для праздника?')).toEqual({ category: 'birthdays', cue: 'package', language: 'ru' });
    expect(firstMessageCategory('Можно принести свой торт?')).toEqual({ category: 'birthdays', cue: 'cake', language: 'ru' });
    expect(firstMessageCategory('Хотим отпраздновать 5 лет дочки')).toEqual({ category: 'birthdays', cue: 'celebration', language: 'ru' });
    expect(firstMessageCategory('Есть ли у вас лагерь на каникулах?')).toEqual({ category: 'birthdays', cue: 'camp', language: 'ru' });
    expect(firstMessageCategory('Хотим привести группу из детского сада, 20 детей')).toEqual({ category: 'birthdays', cue: 'school_group', language: 'ru' });
    expect(category('Днём рождения занимаетесь?')).toBe('birthdays');
  });
});

describe('a refund or a complaint → the GM', () => {
  it('English', () => {
    expect(firstMessageCategory('I want a refund, the staff were rude')).toEqual({ category: 'gm', cue: 'refund', language: 'en' });
    expect(firstMessageCategory('Your staff were rude to my daughter today.')).toEqual({ category: 'gm', cue: 'rude', language: 'en' });
    expect(firstMessageCategory('I want to complain about yesterday')).toEqual({ category: 'gm', cue: 'complaint', language: 'en' });
    expect(firstMessageCategory('My son got hurt on the slide and nobody helped')).toEqual({ category: 'gm', cue: 'injury', language: 'en' });
    expect(firstMessageCategory('Terrible experience, never again')).toEqual({ category: 'gm', cue: 'bad_experience', language: 'en' });
    expect(firstMessageCategory('I was overcharged at the counter')).toEqual({ category: 'gm', cue: 'cheated', language: 'en' });
    expect(category('I want my money back for yesterday')).toBe('gm');
    expect(category('We were charged twice')).toBe('gm');
    expect(category('This is unacceptable')).toBe('gm');
  });

  it('Thai', () => {
    expect(firstMessageCategory('ขอเงินคืนค่ะ พนักงานพูดจาไม่ดี')).toEqual({ category: 'gm', cue: 'refund', language: 'th' });
    expect(firstMessageCategory('อยากร้องเรียนพนักงานค่ะ')).toEqual({ category: 'gm', cue: 'complaint', language: 'th' });
    expect(firstMessageCategory('พนักงานหยาบคายมาก')).toEqual({ category: 'gm', cue: 'rude', language: 'th' });
    expect(firstMessageCategory('ลูกบาดเจ็บที่สไลเดอร์เมื่อวาน')).toEqual({ category: 'gm', cue: 'injury', language: 'th' });
    expect(firstMessageCategory('บริการแย่มากค่ะ')).toEqual({ category: 'gm', cue: 'bad_experience', language: 'th' });
    expect(category('คิดเงินเกินค่ะ')).toBe('gm');
  });

  it('Russian', () => {
    expect(firstMessageCategory('Хочу возврат денег, персонал хамил')).toEqual({ category: 'gm', cue: 'refund', language: 'ru' });
    expect(firstMessageCategory('Верните деньги за вчера')).toEqual({ category: 'gm', cue: 'refund', language: 'ru' });
    expect(firstMessageCategory('Хочу оставить жалобу на сотрудника')).toEqual({ category: 'gm', cue: 'complaint', language: 'ru' });
    expect(firstMessageCategory('Ваши сотрудники нам нагрубили')).toEqual({ category: 'gm', cue: 'rude', language: 'ru' });
    expect(firstMessageCategory('Ребёнок получил травму на горке')).toEqual({ category: 'gm', cue: 'injury', language: 'ru' });
    expect(firstMessageCategory('Ужасное обслуживание')).toEqual({ category: 'gm', cue: 'bad_experience', language: 'ru' });
    expect(category('Нас обманули на кассе')).toBe('gm');
  });

  it('a complaint cue wins over a birthday cue in the same line', () => {
    expect(firstMessageCategory('The birthday party yesterday was terrible, I want a refund')).toEqual({ category: 'gm', cue: 'refund', language: 'en' });
    expect(category('Your staff were rude at our party')).toBe('gm');
    expect(category('ปาร์ตี้เมื่อวานแย่มาก ขอเงินคืน')).toBe('gm');
    expect(category('Хотим вернуть деньги за день рождения, персонал хамил')).toBe('gm');
    expect(category('Праздник был ужасный')).toBe('gm');
  });
});

describe('nothing to read → null, the channel’s default stands', () => {
  it('a greeting alone, a plain question, a thank-you', () => {
    expect(firstMessageCategory('hello')).toBeNull();
    expect(firstMessageCategory('Hi there!')).toBeNull();
    expect(firstMessageCategory('What time do you open?')).toBeNull();
    expect(firstMessageCategory('How much is it for 2 kids and me on Saturday?')).toBeNull();
    expect(firstMessageCategory('Is there parking?')).toBeNull();
    expect(firstMessageCategory('Thanks!')).toBeNull();
    expect(firstMessageCategory('สวัสดีค่ะ OTO เปิดกี่โมงถึงกี่โมงคะ')).toBeNull();
    expect(firstMessageCategory('ราคาเท่าไหร่คะ')).toBeNull();
    expect(firstMessageCategory('Здравствуйте! Нужны ли носки?')).toBeNull();
    expect(firstMessageCategory('Можно скидку если придём с тремя детьми?')).toBeNull();
    expect(firstMessageCategory("I think I left my son's blue jacket at the park yesterday")).toBeNull();
    expect(firstMessageCategory('Hi, do you have a nanny service? I would like to book one')).toBeNull();
  });

  it('an empty, null or undefined text', () => {
    expect(firstMessageCategory('')).toBeNull();
    expect(firstMessageCategory(null)).toBeNull();
    expect(firstMessageCategory(undefined)).toBeNull();
  });

  it('no false positive on a cue inside an unrelated word (Latin and Cyrillic are read at word boundaries)', () => {
    expect(firstMessageCategory('Do you sell pancakes at the cafe?')).toBeNull();
    expect(firstMessageCategory('Is the campus parking free?')).toBeNull();
    expect(firstMessageCategory('I saw your campaign on Instagram')).toBeNull();
    expect(firstMessageCategory('We are a party of four, is there a table?')).toBeNull();
    expect(firstMessageCategory('Does a third party sell your tickets?')).toBeNull();
    expect(firstMessageCategory('Can a 12 year old come without an adult? Our eventual plan is Sunday')).toBeNull();
    expect(firstMessageCategory('Is it hurtful to the ears? (my son is sensitive to noise)')).toBeNull();
    expect(firstMessageCategory('Грубо говоря, нас будет 10')).toBeNull();
    expect(firstMessageCategory('Сколько стоит билет, носки и др.?')).toBeNull();
    expect(firstMessageCategory('Какой адрес?')).toBeNull();
  });

  it('a cue stays a cue at a boundary with punctuation, case and NFC-decomposed text', () => {
    expect(category('BIRTHDAY!!!')).toBe('birthdays');
    expect(category('party?')).toBe('birthdays');
    expect(category('(refund)')).toBe('gm');
    expect(category('день рождения'.normalize('NFD'))).toBe('birthdays');
    expect(category('วันเกิด'.normalize('NFD'))).toBe('birthdays');
  });
});

describe('the cue keys', () => {
  it('every reading names a listed key', () => {
    for (const text of ['birthday', 'party', 'package', 'cake', 'celebrate', 'event', 'camp', 'school trip', 'refund', 'complaint', 'rude', 'hurt', 'terrible', 'scam', 'compensation']) {
      const r = firstMessageCategory(text);
      expect(r, text).not.toBeNull();
      expect(FIRST_MESSAGE_CUE_KEYS).toContain(r!.cue);
    }
  });
});
