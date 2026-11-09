import { describe, expect, it } from 'vitest';
import {
  PARTY_DATE_TIME_ZONE,
  mentionsPartyDate,
  mentionsPartyTime,
  readChatPartyDate,
  readPartyDate,
  readPartyTime,
  readPartyTimePhrase,
} from '../src/chat-dates';

/**
 * SCRUM-814 — the party's date and time as a chat writes them, in Thai,
 * English and Russian. Before this, Book Date read a date only from "21/nov"
 * in English and "Saturday": the prototype's patterns needed a separator and
 * used \b, which never matches beside a Cyrillic or Thai letter.
 *
 * 2026-11-10 is a Tuesday; 2026-11-14 a Saturday; 2026-11-21 a Saturday.
 */
const TUE = '2026-11-10';

describe('readPartyDate: one phrase, from today', () => {
  // [text, today, the date, the confidence]
  const cases: Array<[string, string, string, 'exact' | 'weekday']> = [
    // Russian
    ['15 ноября в 14:00', TUE, '2026-11-15', 'exact'],
    ['Хотим день рождения 21-го ноября', TUE, '2026-11-21', 'exact'],
    ['21 ноября', TUE, '2026-11-21', 'exact'],
    ['ноябрь 21', TUE, '2026-11-21', 'exact'],
    ['15.11', TUE, '2026-11-15', 'exact'],
    ['15.11.2026 в 14:00', TUE, '2026-11-15', 'exact'],
    ['9 ноября', TUE, '2027-11-09', 'exact'],
    ['3 января', '2026-12-28', '2027-01-03', 'exact'],
    ['29 февраля', TUE, '2028-02-29', 'exact'],
    ['в субботу', TUE, '2026-11-14', 'weekday'],
    ['в эту пятницу', TUE, '2026-11-13', 'weekday'],
    ['в следующую субботу', '2026-11-14', '2026-11-21', 'weekday'],
    ['в субботу', '2026-11-14', '2026-11-14', 'weekday'],
    ['в субботу', '2026-12-28', '2027-01-02', 'weekday'],
    ['в субботу 21-го', TUE, '2026-11-21', 'exact'],
    ['завтра', TUE, '2026-11-11', 'weekday'],
    ['послезавтра', TUE, '2026-11-12', 'weekday'],
    ['сегодня', TUE, '2026-11-10', 'weekday'],
    // English
    ['21 November', TUE, '2026-11-21', 'exact'],
    ['Nov 21', TUE, '2026-11-21', 'exact'],
    ['the 21st of Nov please', TUE, '2026-11-21', 'exact'],
    ['November 21st, 2027', TUE, '2027-11-21', 'exact'],
    ['21/nov', TUE, '2026-11-21', 'exact'],
    ['on 3 March', TUE, '2027-03-03', 'exact'],
    ['15/11/2026', TUE, '2026-11-15', 'exact'],
    ['2026-11-15', TUE, '2026-11-15', 'exact'],
    ['Saturday', TUE, '2026-11-14', 'weekday'],
    ['next Saturday', '2026-11-14', '2026-11-21', 'weekday'],
    ['next Monday', TUE, '2026-11-16', 'weekday'],
    ['Saturday 21st', TUE, '2026-11-21', 'exact'],
    ['on Sunday 22nd at 2pm', TUE, '2026-11-22', 'exact'],
    ['tomorrow', TUE, '2026-11-11', 'weekday'],
    ['today', TUE, '2026-11-10', 'weekday'],
    // Thai
    ['วันที่ 15 พ.ย.', TUE, '2026-11-15', 'exact'],
    ['15 พฤศจิกายน', TUE, '2026-11-15', 'exact'],
    ['15พ.ย.2569', TUE, '2026-11-15', 'exact'],
    ['15 พ.ย. พ.ศ. 2569', TUE, '2026-11-15', 'exact'],
    ['๑๕ พ.ย.', TUE, '2026-11-15', 'exact'],
    ['15.11.69', TUE, '2026-11-15', 'exact'],
    ['วันเสาร์ที่ 21 พฤศจิกายน', TUE, '2026-11-21', 'exact'],
    ['วันเสาร์ที่ 21', TUE, '2026-11-21', 'exact'],
    ['วันเสาร์หน้า', '2026-11-14', '2026-11-21', 'weekday'],
    ['เสาร์นี้', TUE, '2026-11-14', 'weekday'],
    ['วันอาทิตย์หน้า', TUE, '2026-11-15', 'weekday'],
    ['พรุ่งนี้', TUE, '2026-11-11', 'weekday'],
  ];
  it.each(cases)('%s (today %s) is %s', (text, today, date, confidence) => {
    const r = readPartyDate(text, today);
    expect(r.date).toBe(date);
    expect(r.confidence).toBe(confidence);
    expect(r.phrase.length).toBeGreaterThan(0);
    expect(text).toContain(r.phrase);
  });

  it('the phrase is the chat’s own words, a weekday before the day included', () => {
    expect(readPartyDate('Хотим день рождения 21-го ноября', TUE).phrase).toBe('21-го ноября');
    expect(readPartyDate('Party on Saturday 21 November please', TUE).phrase).toBe('Saturday 21 November');
    expect(readPartyDate('ยืนยันงาน วันเสาร์ที่ 21 มีนาคม เวลา 14.00 น.', TUE)).toEqual({
      date: '2027-03-21',
      phrase: 'วันเสาร์ที่ 21 มีนาคม',
      confidence: 'exact',
    });
    expect(readPartyDate('можно в субботу?', TUE).phrase).toBe('в субботу');
    expect(readPartyDate('๑๕ พ.ย.', TUE).phrase).toBe('๑๕ พ.ย.');
  });

  it('a text with several dates: the last one wins, a day named outright before a weekday or "tomorrow"', () => {
    expect(readPartyDate('Can we do 20 November? Or maybe 21 November', TUE).date).toBe('2026-11-21');
    expect(readPartyDate('21 November, or next Saturday?', TUE).date).toBe('2026-11-21');
    expect(readPartyDate('Party on Saturday, I will call you tomorrow', TUE).date).toBe('2026-11-14');
  });

  it('a payment’s or a birth’s date is not the party’s; nor a date whose own year is past', () => {
    // Tom's Russian confirmation: the deposit's date comes last.
    expect(readPartyDate('Подтверждаем 21 ноября в 14:00, депозит получен 9 ноября', TUE)).toMatchObject({
      date: '2026-11-21',
      phrase: '21 ноября',
    });
    expect(readPartyDate('Deposit paid on 9 Nov. See you on Saturday 21 November!', TUE).date).toBe('2026-11-21');
    expect(readPartyDate('มัดจำ 3,000 บาท โอนแล้ว 9 พ.ย.', TUE).date).toBeNull();
    expect(readPartyDate('born 15 Nov 2020', TUE).date).toBeNull();
    expect(readPartyDate('21.03.2025', TUE).date).toBeNull();
  });

  it('a deposit with a thousands comma and its date after the party’s date: the party’s date, in the three languages', () => {
    // The comma inside "1,500" does not end the clause; "Депозит" / "Deposit" / "มัดจำ" stay in it.
    for (const [text, phrase] of [
      ['Подтверждаем праздник 21 ноября в 14:00. Депозит 1,500 бат получен 9 ноября.', '21 ноября'],
      ['Confirmed: Saturday 21 November at 14:00. Deposit of 1,500 baht received on 9 November.', 'Saturday 21 November'],
      ['ยืนยันงานวันที่ 21 พ.ย. เวลา 14.00 น. มัดจำ 1,500 บาท วันที่ 9 พ.ย.', '21 พ.ย.'],
    ] as const) {
      expect(readPartyDate(text, TUE), text).toEqual({ date: '2026-11-21', phrase, confidence: 'exact' });
    }
    for (const text of [
      'Prepayment 3,000 THB received 9.11',
      'มัดจำ 1,500 บาท วันที่ 9 พ.ย.',
      'Предоплата 2,000 бат, оплачено 9 ноября',
      'Депозит 1,500 бат, получен 9 ноября',
      'Deposit 1,500 baht, received 9 Nov',
    ]) {
      expect(readPartyDate(text, TUE).date, text).toBeNull();
    }
    // The clause starts after the date before it: the deposit's word does not reach the party's date.
    expect(readPartyDate('Депозит 9 ноября и праздник 21 ноября', TUE).date).toBe('2026-11-21');
  });

  it('a price after a day and month is not its year; a year more than three years ahead is none', () => {
    for (const text of [
      'วันที่ 21 พ.ย. 2590 บาท',
      '21 Nov 2050 baht for the package',
      'Праздник 21 ноября, 2000 бат депозит',
      'งานวันที่ 21 พ.ย. 2500 บาท',
      '21 Nov 2050 for the package',
    ]) {
      expect(readPartyDate(text, TUE), text).toMatchObject({ date: '2026-11-21', confidence: 'exact' });
    }
    expect(readPartyDate('21 Nov 2050 baht for the package', TUE).phrase).toBe('21 Nov');
    // A written year near today stays the year, a Russian "года" after it too.
    expect(readPartyDate('21 ноября 2027 года', TUE).date).toBe('2027-11-21');
    expect(readPartyDate('21 พ.ย. 2570', TUE).date).toBe('2027-11-21');
  });

  it('a day of the month without its month: the next such day, less sure than a day with its month', () => {
    // [text, today, the date, the phrase]
    for (const [text, today, date, phrase] of [
      ['can we do the 21st?', TUE, '2026-11-21', 'the 21st'],
      ['the 21st at 3pm', TUE, '2026-11-21', 'the 21st'],
      ['party on 3rd please', TUE, '2026-12-03', '3rd'],
      ['праздник 15-го в 14:00', TUE, '2026-11-15', '15-го'],
      ['на 15-е число', TUE, '2026-11-15', '15-е число'],
      ['вам удобно 9 числа?', TUE, '2026-12-09', '9 числа'],
      ['วันที่ 15', TUE, '2026-11-15', 'วันที่ 15'],
      ['ขอจองวันที่ ๑๕ ค่ะ', TUE, '2026-11-15', 'วันที่ ๑๕'],
      ['the 31st', '2026-11-10', '2026-12-31', 'the 31st'],
    ] as const) {
      expect(readPartyDate(text, today), text).toEqual({ date, phrase, confidence: 'weekday' });
    }
    // With the month it is the whole day; a weekday is weaker than the day of the month.
    expect(readPartyDate('the 21st of Nov', TUE)).toMatchObject({ date: '2026-11-21', phrase: '21st of Nov', confidence: 'exact' });
    expect(readPartyDate('วันที่ 15 พ.ย.', TUE)).toMatchObject({ phrase: '15 พ.ย.', confidence: 'exact' });
    expect(readPartyDate('Saturday or the 22nd?', TUE)).toMatchObject({ date: '2026-11-22', phrase: 'the 22nd' });
    expect(mentionsPartyDate('the 21st')).toBe(true);
    // An ordinal that counts something else is no day.
    for (const text of ['her 5th birthday', 'the 2nd floor', 'the 3rd child', 'the 1st time', 'для 5-го класса', 'на 2-го взрослого', 'วันที่ 2 คน']) {
      expect(readPartyDate(text, TUE), text).toEqual({ date: null, phrase: '', confidence: 'none' });
    }
    expect(readPartyDate('for his 6th birthday on Saturday', TUE)).toMatchObject({ date: '2026-11-14', phrase: 'Saturday' });
    expect(readPartyDate('วันที่ 15/11', TUE)).toMatchObject({ date: '2026-11-15', phrase: '15/11', confidence: 'exact' });
  });

  it('what is not a date: a count, a measure, a clock time, a phone number, a week, the verb "may"', () => {
    for (const text of [
      'party for 5-6 kids',
      'a 1.5 kg cake',
      '1/2 of the cake',
      'в 14.10 приходите',
      'เวลา 14.00 น.',
      'Call me on 081-234-5678',
      'อาทิตย์หน้า', // next week
      'พระจันทร์', // the moon
      '15 may we come?',
      'We may 2 adults',
      'Hello! How can we help?',
      '31/02',
    ]) {
      expect(readPartyDate(text, TUE), text).toEqual({ date: null, phrase: '', confidence: 'none' });
    }
  });

  it('today is the park’s day: a string, or an instant read in the park’s zone', () => {
    // 2026-11-10 20:00 UTC is already 11 November in Bangkok.
    expect(PARTY_DATE_TIME_ZONE).toBe('Asia/Bangkok');
    expect(readPartyDate('tomorrow', new Date('2026-11-10T20:00:00Z')).date).toBe('2026-11-12');
    expect(readPartyDate('tomorrow', new Date('2026-11-10T20:00:00Z'), 'UTC').date).toBe('2026-11-11');
    expect(readPartyDate('21 November', 'not a day').date).toBeNull();
  });
});

describe('readPartyTime: the first clock time, 24-hour', () => {
  const cases: Array<[string, string]> = [
    ['14:00', '14:00'],
    ['Saturday at 2 pm', '14:00'],
    ['2:30pm', '14:30'],
    ['12 am', '00:00'],
    ['14.00 น.', '14:00'],
    ['เวลา 14.00-16.00 น.', '14:00'],
    ['в 14:00', '14:00'],
    ['в 14.00', '14:00'],
    ['14 часов', '14:00'],
    ['в 2 часа дня', '14:00'],
    ['к 5 вечера', '17:00'],
    ['บ่าย 2 โมง', '14:00'],
    ['บ่ายสองโมง', '14:00'],
    ['บ่ายโมง', '13:00'],
    ['4 โมงเย็น', '16:00'],
    ['10 โมง', '10:00'],
    ['2 ทุ่ม', '20:00'],
    ['เที่ยง', '12:00'],
    ['at noon', '12:00'],
    ['from 14:00 to 16:00, cake at 15:30', '14:00'],
  ];
  it.each(cases)('%s is %s', (text, time) => {
    expect(readPartyTime(text)).toBe(time);
  });

  it('with its own words, and none where there is no time', () => {
    expect(readPartyTimePhrase('Ждём вас в 14:00!')).toEqual({ time: '14:00', phrase: 'в 14:00' });
    expect(readPartyTimePhrase('งานเริ่ม บ่าย 2 โมง ค่ะ')).toEqual({ time: '14:00', phrase: 'บ่าย 2 โมง' });
    for (const text of ['15.11', '21 November', '15 kids', 'Call me on 081-234-5678', 'the 1.5 kg cake']) {
      expect(readPartyTime(text), text).toBeNull();
    }
  });

  it('a Russian duration is not the start: "на 2 часа", "длительность 3 часа"', () => {
    expect(readPartyTimePhrase('Пакет на 2 часа, 21 ноября в 15:00')).toEqual({ time: '15:00', phrase: 'в 15:00' });
    expect(readPartyTimePhrase('праздник 21 ноября, длительность 3 часа, начало в 14:00')).toEqual({ time: '14:00', phrase: 'в 14:00' });
    for (const text of ['Пакет на 2 часа', 'длительность 3 часа', 'праздник 2 часа']) {
      expect(readPartyTime(text), text).toBeNull();
    }
    // With "в" before it, or "дня" after it, a small hour is the clock.
    expect(readPartyTime('в 3 часа')).toBe('15:00');
    expect(readPartyTime('на 2 часа дня')).toBe('14:00');
  });
});

describe('mentionsPartyDate / mentionsPartyTime: what the BEO confirmation picker asks', () => {
  it('a day or a weekday is a date; "today" and "tomorrow" alone are not', () => {
    for (const text of ['21 марта', '15 พ.ย.', 'Saturday', 'วันอาทิตย์', '21/03', '2027-03-21', '21-го ноября']) {
      expect(mentionsPartyDate(text), text).toBe(true);
    }
    for (const text of ['tomorrow', 'завтра', 'พรุ่งนี้', 'Hello!', '14.00 น.']) {
      expect(mentionsPartyDate(text), text).toBe(false);
    }
    expect(mentionsPartyTime('บ่าย 2 โมง')).toBe(true);
    expect(mentionsPartyTime('21 марта')).toBe(false);
  });
});

describe('readChatPartyDate: a whole chat, its lines in order', () => {
  const line = (text: string, team = false) => ({ text, team });

  it('a team line’s date wins over the customer’s when they differ, with the team’s words', () => {
    const r = readChatPartyDate(
      [line('Здравствуйте! Можно 15 ноября в 14:00?'), line('15 ноября занято, есть 16 ноября в 15:00', true), line('Хорошо')],
      TUE,
    );
    expect(r).toEqual({
      date: '2026-11-16',
      phrase: '16 ноября',
      confidence: 'exact',
      by: 'team',
      line: 1,
      time: '15:00',
      timePhrase: 'в 15:00',
    });
  });

  it('the customer’s date when the team names none; its time with it', () => {
    const r = readChatPartyDate([line('Can we come on 21 November at 2 pm with 15 kids?'), line('Yes of course!', true)], TUE);
    expect(r).toMatchObject({ date: '2026-11-21', phrase: '21 November', by: 'customer', line: 0, time: '14:00', timePhrase: '2 pm' });
  });

  it('a day named outright beats a weekday, whoever wrote it', () => {
    const r = readChatPartyDate([line('วันเสาร์ที่ 21 พฤศจิกายน ได้ไหมคะ'), line('ได้ค่ะ เจอกันวันเสาร์', true)], TUE);
    expect(r).toMatchObject({ date: '2026-11-21', by: 'customer', confidence: 'exact' });
  });

  it('the time: the date’s own line, else the team’s latest, else the customer’s', () => {
    const r = readChatPartyDate([line('21 November please'), line('Great, we start at 15:00', true)], TUE);
    expect(r).toMatchObject({ date: '2026-11-21', time: '15:00', timePhrase: 'at 15:00' });
    const c = readChatPartyDate([line('Around 16:00 is best'), line('Which day?', true), line('21 November')], TUE);
    expect(c).toMatchObject({ date: '2026-11-21', time: '16:00' });
  });

  it('a deadline or the opening hours on another line is not the party’s time', () => {
    for (const lines of [
      [line('Хотим праздник 21 ноября'), line('внесите депозит до 18:00 сегодня', true)],
      [line('Party on 21 November please'), line('We are open today until 20:00', true)],
      [line('Хотим праздник 21 ноября'), line('Мы работаем с 10:00 до 20:00', true)],
      [line('ขอจองวันที่ 21 พ.ย. ค่ะ'), line('เปิด 10.00-20.00 น. ค่ะ', true)],
    ]) {
      expect(readChatPartyDate(lines, TUE), lines[1]!.text).toMatchObject({ date: '2026-11-21', time: null, timePhrase: '' });
    }
    // A start word, or a time given as a point, still counts.
    expect(readChatPartyDate([line('21 ноября'), line('Начало в 15:00', true)], TUE)).toMatchObject({ time: '15:00' });
    expect(readChatPartyDate([line('21 พ.ย.'), line('เริ่ม 15.00 น. ค่ะ', true)], TUE)).toMatchObject({ time: '15:00' });
  });

  it('a chat that names no date or time', () => {
    expect(readChatPartyDate([line('Hello'), line('Hi! How can we help?', true)], TUE)).toEqual({
      date: null,
      phrase: '',
      confidence: 'none',
      by: null,
      line: null,
      time: null,
      timePhrase: '',
    });
    expect(readChatPartyDate([], TUE).date).toBeNull();
  });
});
