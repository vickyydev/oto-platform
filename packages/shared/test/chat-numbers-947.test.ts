import { describe, expect, it } from 'vitest';
import { readChatNumbers } from '../src/chat-dates';

/**
 * SCRUM-947 — which numbers a chat writes can count guests. Book Date offered
 * "8 or 00" kids for a Thai chat that said "11:00-13:00 เด็ก 8 คน": the minutes
 * of a time were read as a count. A number written into a clock time, a date,
 * a price, a phone number or an age counts no guests; a number of its own
 * does, a zero too. Thai, English and Russian, as the parks' chats are written.
 */

/** The numbers that can count guests, as written. */
const counts = (text: string) =>
  readChatNumbers(text)
    .numbers.filter((n) => n.count)
    .map((n) => n.digits);

/** The numbers that cannot, as written. */
const notCounts = (text: string) =>
  readChatNumbers(text)
    .numbers.filter((n) => !n.count)
    .map((n) => n.digits);

describe('the proof’s Thai lines (SCRUM-904, threads C and F)', () => {
  it('thread C: only the kids and the adults are counts', () => {
    const line = 'สวัสดีค่ะ อยากจองงานวันเกิดให้ลูกชาย ZZ Test Niko ครบ 5 ขวบ วันเสาร์ที่ 12 ธันวาคม 11:00-13:00 เด็ก 8 คน ผู้ใหญ่ 4 คน (ZZ TEST)';
    expect(counts(line)).toEqual(['8', '4']);
    expect(notCounts(line)).toEqual(['5', '12', '11', '00', '13', '00']);
  });

  it('thread F: only the kids and the adults are counts', () => {
    const line =
      'สวัสดีค่ะ จองงานวันเกิด ZZ Test Pim ครบ 4 ขวบ วันอาทิตย์ที่ 27 ธันวาคม 14:00-16:00 เด็ก 10 คน ผู้ใหญ่ 5 คน แพ็กเกจวันเกิด Floresta ข้าวผัดสำหรับผู้ใหญ่ค่ะ (ZZ TEST)';
    expect(counts(line)).toEqual(['10', '5']);
    expect(notCounts(line)).toEqual(['4', '27', '14', '00', '16', '00']);
  });
});

describe('a clock time counts no guests', () => {
  it.each([
    ['th', '13:00 เด็ก 8 คน'],
    ['th', '13.00 เด็ก 8 คน'],
    ['th', '13:00 น. เด็ก 8 คน'],
    ['th', '13 น. เด็ก 8 คน'],
    ['th', '11:00-13:00 เด็ก 8 คน'],
    ['th', '11.00 - 13.00 น. เด็ก 8 คน'],
    ['th', 'บ่าย 1 โมง เด็ก 8 คน'],
    ['th', '๑๓:๐๐ เด็ก ๘ คน'],
    ['en', 'at 1 pm, 8 kids'],
    ['en', "at 1 o'clock, 8 kids"],
    ['en', 'from 13:00 to 16:00, 8 kids'],
    ['en', '١٣:٠٠ 8 kids'],
    ['ru', 'в 13:00, 8 детей'],
    ['ru', 'с 11.00 до 13.00, 8 детей'],
    ['ru', 'в 2 часа дня 8 детей'],
  ])('%s: "%s" counts 8 only', (_language, text) => {
    expect(counts(text)).toEqual(['8']);
  });
});

describe('a date counts no guests', () => {
  it.each([
    ['th', 'วันที่ 27 เด็ก 8 คน'],
    ['th', 'วันเสาร์ที่ 12 เด็ก 8 คน'],
    ['th', '12 ธันวาคม เด็ก 8 คน'],
    ['th', '27/12 เด็ก 8 คน'],
    ['th', '12 ธ.ค. 2569 เด็ก 8 คน'],
    ['en', 'on 12.12, 8 kids'],
    ['en', 'on the 21st, 8 kids'],
    ['en', '2026-12-12: 8 kids'],
    ['en', '21 November 8 kids'],
    ['ru', '15-го, 8 детей'],
    ['ru', '21 ноября, 8 детей'],
    ['ru', '21.11.2026 8 детей'],
  ])('%s: "%s" counts 8 only', (_language, text) => {
    expect(counts(text)).toEqual(['8']);
  });
});

describe('a price counts no guests', () => {
  it.each([
    ['th', 'ราคา 590 เด็ก 8 คน'],
    ['th', 'ราคา 1,500 บาท เด็ก 8 คน'],
    ['th', '590 บาท เด็ก 8 คน'],
    ['th', '590บาทค่ะ เด็ก 8 คน'],
    ['en', '฿1,500 for 8 kids'],
    ['en', 'price: 590, 8 kids'],
    ['en', '500 baht, 8 kids'],
    ['ru', 'цена 590, 8 детей'],
    ['ru', '1500 руб, 8 детей'],
  ])('%s: "%s" counts 8 only', (_language, text) => {
    expect(counts(text)).toEqual(['8']);
  });
});

describe('a phone number counts no guests', () => {
  it.each([
    ['th', 'โทร 0812345678 เด็ก 8 คน'],
    ['th', 'โทร 081-234-5678 เด็ก 8 คน'],
    ['th', 'เบอร์ 076 123 456 เด็ก 8 คน'],
    ['en', 'call +66 81 234 5678, 8 kids'],
    ['en', 'my number is +66812345678 and 8 kids'],
    ['ru', 'мой номер 081 234 567, 8 детей'],
    ['ru', '+7 912 345 67 89, 8 детей'],
  ])('%s: "%s" counts 8 only', (_language, text) => {
    expect(counts(text)).toEqual(['8']);
  });

  it('a count written right after a phone number stays a count', () => {
    expect(counts('0812345678 10 kids')).toEqual(['10']);
    expect(counts('+66 81 234 5678 10 kids')).toEqual(['10']);
  });
});

describe('an age counts no guests', () => {
  it.each([
    ['th', 'ครบ 5 ขวบ เด็ก 8 คน'],
    ['th', 'ลูกอายุ 5 เด็ก 8 คน'],
    ['th', 'อายุ 5 ปี เด็ก 8 คน'],
    ['th', '5-6 ขวบ เด็ก 8 คน'],
    ['en', 'turning 5, 8 kids'],
    ['en', 'my 5 year old, 8 kids'],
    ['en', 'a 5-year-old, 8 kids'],
    ['en', 'aged 5 to 6 years, 8 kids'],
    ['ru', 'исполняется 5, 8 детей'],
    ['ru', 'сыну 5 лет, 8 детей'],
    ['ru', 'на 5-летие, 8 детей'],
  ])('%s: "%s" counts 8 only', (_language, text) => {
    expect(counts(text)).toEqual(['8']);
  });
});

describe('a count is still a count', () => {
  it('a number of its own counts, in the three languages, a zero too', () => {
    expect(counts('เด็ก 8 คน ผู้ใหญ่ 4 คน')).toEqual(['8', '4']);
    expect(counts('8 kids and 4 adults')).toEqual(['8', '4']);
    expect(counts('8 детей и 4 взрослых')).toEqual(['8', '4']);
    expect(counts('0 kids, 10 adults')).toEqual(['0', '10']);
    expect(counts('เด็ก 0 คน')).toEqual(['0']);
  });

  it('a range of counts stays counts; a range with a time, a price or an age does not', () => {
    expect(counts('8-10 kids')).toEqual(['8', '10']);
    expect(counts('เด็ก 8 - 10 คน')).toEqual(['8', '10']);
    expect(counts('11:00 - 13 kids')).toEqual([]);
    expect(counts('500-700 บาท')).toEqual([]);
  });

  it('a weekday before a count leaves it a count, as the date reader rules ("в субботу 15 детей")', () => {
    expect(counts('в субботу 15 детей')).toEqual(['15']);
    expect(counts('Saturday 15 kids')).toEqual(['15']);
  });

  it('Thai and Arabic-Indic digits are read as the digits they are', () => {
    expect(readChatNumbers('เด็ก ๑๐ คน').numbers).toEqual([{ digits: '10', value: 10, start: 5, end: 7, count: true }]);
    expect(readChatNumbers('٨ kids').numbers).toEqual([{ digits: '8', value: 8, start: 0, end: 1, count: true }]);
    expect(readChatNumbers('เด็ก ๑๐ คน').text).toBe('เด็ก 10 คน');
  });

  it('a text with no digits has no numbers', () => {
    expect(readChatNumbers('สิบคน, ten kids, десять детей').numbers).toEqual([]);
    expect(readChatNumbers('').numbers).toEqual([]);
  });
});
