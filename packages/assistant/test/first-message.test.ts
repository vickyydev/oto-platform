import { describe, expect, it } from 'vitest';
import { FIRST_MESSAGE_CUE_KEYS, firstMessageCategory } from '../src/first-message';

/**
 * SCRUM-830 (owner, 11 November): the FIRST customer message decides the
 * inbox queue, before any model runs — a deterministic reader in Thai,
 * English and Russian. A birthday, a party, a package, a cake, a camp or a
 * school group goes to Birthdays & Events; a refund or a complaint goes to
 * the GM; a greeting or a plain question says nothing (null), and the
 * channel's default stands. A complaint cue wins over a birthday cue in the
 * same line. The reading names the cue's key and the customer's language
 * (the line's script, else the cue's), never the words.
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
    // A school, a kindergarten or a nursery as a GROUP coming.
    expect(category('Can we book a kindergarten visit for 20 kids?')).toBe('birthdays');
    expect(category('A preschool outing on Friday, 18 children')).toBe('birthdays');
    expect(category('Our nursery class would like to come on Thursday')).toBe('birthdays');
    expect(category('We are 3 teachers from our school in Patong, 40 students')).toBe('birthdays');
    expect(category('Is there a discount for 30 students?')).toBe('birthdays');
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
    // A school or a kindergarten as a GROUP coming: beside the bringing of children, a count, a group.
    expect(category('ทางโรงเรียนอยากพานักเรียน 30 คนมาเล่นค่ะ')).toBe('birthdays');
    expect(category('อนุบาลจะพาน้องๆ มา 25 คนค่ะ')).toBe('birthdays');
    expect(category('นักเรียน 25 คน มาเป็นหมู่คณะ')).toBe('birthdays');
    expect(category('คณะครูและนักเรียนจะมาเยี่ยมชมค่ะ')).toBe('birthdays');
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
    // A kindergarten or a school as a GROUP coming; "праздник" as a celebration.
    expect(category('Мы детский сад, хотим привести 20 детей')).toBe('birthdays');
    expect(category('Школьная экскурсия, 30 детей — есть скидка?')).toBe('birthdays');
    expect(category('Групповое посещение, 15 детей')).toBe('birthdays');
    expect(category('Делаете ли вы детские праздники?')).toBe('birthdays');
    expect(category('Празднуем 7 лет сына, какие пакеты?')).toBe('birthdays');
  });

  it('the language is the customer’s: a Thai or a Cyrillic line with a Latin loanword stays Thai or Russian, its own cue first', () => {
    // SCRUM-830 review: the EN cue "package" in a Thai line filed the thread as English and seated the
    // EN rule's people; the line's script names the language, and the Thai cue names the reading.
    expect(firstMessageCategory('สวัสดีค่ะ มี package วันเกิดไหมคะ')).toEqual({ category: 'birthdays', cue: 'birthday', language: 'th' });
    expect(firstMessageCategory('ขอดู package หน่อยค่ะ')).toEqual({ category: 'birthdays', cue: 'package', language: 'th' });
    expect(firstMessageCategory('Здравствуйте! Хотим party для сына, 10 детей')).toEqual({ category: 'birthdays', cue: 'party', language: 'ru' });
    expect(firstMessageCategory('ขอเงินคืนค่ะ staff were rude')).toEqual({ category: 'gm', cue: 'refund', language: 'th' });
    expect(firstMessageCategory('Can I bring my own cake?')).toEqual({ category: 'birthdays', cue: 'cake', language: 'en' });
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

  it('a complaint ABOUT a party in everyday words is the GM’s, not the events team’s', () => {
    // SCRUM-830 review: the GM list held only refund / complain / rude / injury / terrible / scam /
    // compensation, so these fell through to the party word in the same line.
    expect(firstMessageCategory('We were not happy with the party last Saturday')).toEqual({ category: 'gm', cue: 'complaint', language: 'en' });
    expect(firstMessageCategory('Very bad service at our birthday party')).toEqual({ category: 'gm', cue: 'bad_experience', language: 'en' });
    expect(category('Poor service at the party, cake arrived late')).toBe('gm');
    expect(category('The party was a disaster, nobody showed up to host')).toBe('gm');
    expect(category('The party room was dirty and the staff ignored us')).toBe('gm');
    expect(category('Unhappy with how the party went')).toBe('gm');
    expect(category('The party host was unprofessional')).toBe('gm');
    expect(category('The party was a waste of money')).toBe('gm');
    expect(category('Bad experience at your party')).toBe('gm');
    expect(category('Not satisfied with the birthday package we paid for')).toBe('gm');
    expect(category('Dissatisfied with the package')).toBe('gm');
    expect(firstMessageCategory('บริการห่วยมาก ปาร์ตี้เมื่อวาน')).toEqual({ category: 'gm', cue: 'bad_experience', language: 'th' });
    expect(category('ปาร์ตี้เมื่อวานไม่โอเคเลย')).toBe('gm');
    expect(category('จัดงานวันเกิดเมื่อวานไม่ดีเลย')).toBe('gm');
    expect(category('แพ็กเกจไม่คุ้มเลยค่ะ')).toBe('gm');
    expect(category('ปาร์ตี้แย่เลยค่ะ')).toBe('gm');
    expect(firstMessageCategory('Праздник прошёл плохо, аниматор не пришёл')).toEqual({ category: 'gm', cue: 'bad_experience', language: 'ru' });
    expect(category('Нам не понравился день рождения')).toBe('gm');
    expect(category('Никогда больше не придём на ваш праздник')).toBe('gm');
    expect(category('Безобразно организованный праздник')).toBe('gm');
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

  it('no false positive on "in the event of", "refundable" or "worst case" (found on staging, 11 Nov)', () => {
    expect(firstMessageCategory('What happens in the event of rain?')).toBeNull();
    expect(firstMessageCategory('In any event we will be there by 2pm')).toBeNull();
    expect(firstMessageCategory('Is the deposit refundable?')).toBeNull();
    expect(firstMessageCategory('Is the booking non-refundable if we cancel?')).toBeNull();
    expect(firstMessageCategory('Worst case we arrive at 6pm, still ok?')).toBeNull();
    expect(firstMessageCategory('Депозит возвратный?')).toBeNull();
    // The request forms still read as a refund.
    expect(category('Can I get a refund?')).toBe('gm');
    expect(category('Refund please, we did not come')).toBe('gm');
    expect(category('I was charged but never refunded')).toBe('gm');
    expect(category('Верните деньги за вчера')).toBe('gm');
    expect(category('Хочу возврат за билеты')).toBe('gm');
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

  it('no false positive on the park’s own child care, a child who IS at school, or a bare school word', () => {
    // SCRUM-830 review: day care, a nursery and a kindergarten are the park's own nanny / drop-off
    // service (Central reception's) or a child's age bracket, not a school group; a school word
    // counts only as a group coming. A misroute at ingest is sticky (the assistant re-routes only
    // toward a hand-over destination), so these stay with reception.
    expect(firstMessageCategory('Hi, do you have a daycare / drop-off service for a 3 year old?')).toBeNull();
    expect(firstMessageCategory('Is there day care where I can leave my kid for 2 hours?')).toBeNull();
    expect(firstMessageCategory('Is there a day care / drop off service while we shop?')).toBeNull();
    expect(firstMessageCategory('Do you have daycare for a 3 year old?')).toBeNull();
    expect(firstMessageCategory('Do you have a nursery room for feeding the baby?')).toBeNull();
    expect(firstMessageCategory('Do you have a nursery for toddlers?')).toBeNull();
    expect(firstMessageCategory('My daughter is in kindergarten, is the park ok for her age?')).toBeNull();
    expect(firstMessageCategory('Suitable for preschool kids?')).toBeNull();
    expect(firstMessageCategory('เลิกโรงเรียนแล้วพาลูกมาเล่นได้ถึงกี่โมงคะ')).toBeNull();
    expect(firstMessageCategory('หลังเลิกโรงเรียนพาลูกมาได้ไหมคะ')).toBeNull();
    expect(firstMessageCategory('ลูกอายุ 3 ขวบ อยู่อนุบาล 1 เล่นได้ไหมคะ')).toBeNull();
    expect(firstMessageCategory('ลูกอยู่อนุบาล 2 เข้าเล่นได้ไหมคะ')).toBeNull();
    expect(firstMessageCategory('ลูกเป็นนักเรียนอนุบาล 1 เข้าเล่นได้ไหมคะ')).toBeNull();
    expect(firstMessageCategory('Есть скидка для школьников?')).toBeNull();
    expect(firstMessageCategory('Мы небольшой группой, 3 семьи — есть скидка?')).toBeNull();
    expect(firstMessageCategory('Есть ли у вас группа в телеграме?')).toBeNull();
    expect(firstMessageCategory('Ребёнок ходит в детский сад, ему 4, можно к вам?')).toBeNull();
  });

  it('no false positive on the public holidays, a plastic bag, or "I speak … badly"', () => {
    expect(firstMessageCategory('Вы работаете в праздники?')).toBeNull();
    expect(firstMessageCategory('Работаете ли вы в праздничные дни?')).toBeNull();
    expect(firstMessageCategory('Можно взять пакет для обуви?')).toBeNull();
    expect(firstMessageCategory('Я плохо говорю по-тайски, можно по-английски?')).toBeNull();
    expect(firstMessageCategory('Неплохо бы узнать цены')).toBeNull();
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
