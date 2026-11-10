/**
 * SCRUM-831 — THE SLOT READER: what a reply asks, and what the customer's
 * answer says (owner, 10 Nov 2026: "the memory is the primary mechanism").
 *
 *   slotsAskedIn(bubbles)       the slots a reply's questions ask, read from
 *                               its own words in Thai, English and Russian —
 *                               the server's check beside the model's
 *                               declared `askedSlots`, never instead of it.
 *   readSlotAnswers(slots, text, today)
 *                               the customer's message read AS THE ANSWER to
 *                               the slots it follows: a number in words or
 *                               digits in the three languages ("แปดขวบ",
 *                               "восемь лет", "8"), a date (the inbox's own
 *                               reader, `@oto/shared` chat-dates), a time, a
 *                               park, residency; a short reply is the answer
 *                               to a name or a package question, kept as
 *                               "answered" with no value (a name is never
 *                               stored).
 *
 * Pure: no clock (the caller passes `today`), no database, no model. Written
 * for the way chats are typed: no `\b` beside a Cyrillic or Thai letter, the
 * Unicode flag where letters matter, Thai read without word spaces.
 */

import { INBOX_OPEN_QUESTION_ANSWER_MAX, readPartyDate, readPartyTimePhrase, type InboxAiAskedSlot } from '@oto/shared';
import type { AiBranchKey } from './decision';

type Slot = InboxAiAskedSlot;

/** Thai interrogatives: a Thai question needs no question mark ("กี่ขวบคะ", "สาขาไหนคะ"). */
const THAI_QUESTION = /ไหม|มั้ย|หรือเปล่า|ไหน|กี่|อะไร|เท่าไ[รห]|เมื่อไ[รห]/u;

// ---------------------------------------------------------------------------
// Numbers, in words and digits, in three languages
// ---------------------------------------------------------------------------

export interface NumberFound {
  value: number;
  start: number;
  end: number;
  /**
   * A word that is as often not a number: English "one" ("the one with the
   * slide"), Russian "один / одна / одно" ("одна" is also "alone"). Read
   * beside a unit ("one adult", "одна девочка"), never as a bare answer.
   */
  weak?: true;
}

const EN_UNITS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const EN_TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const EN_NUMBER = new RegExp(
  `(?<![a-z])(?:(${Object.keys(EN_TENS).join('|')})(?:[\\s-]+(${Object.keys(EN_UNITS).join('|')}))?|(${Object.keys(EN_TEENS).join('|')})|(${Object.keys(EN_UNITS).join('|')})|(a\\s+dozen|dozen))(?![a-z])`,
  'gi',
);

/** Russian number words with their case forms. */
const RU_UNITS: Array<[RegExp, number]> = [
  [/^(?:один|одна|одно|одного|одной|одному|одним)$/u, 1],
  [/^(?:два|две|двух|двум|двумя)$/u, 2],
  [/^(?:три|трёх|трех|трём|трем|тремя)$/u, 3],
  [/^(?:четыре|четырёх|четырех|четырём|четырем|четырьмя)$/u, 4],
  [/^(?:пять|пяти|пятью)$/u, 5],
  [/^(?:шесть|шести|шестью)$/u, 6],
  [/^(?:семь|семи|семью)$/u, 7],
  [/^(?:восемь|восьми|восемью)$/u, 8],
  [/^(?:девять|девяти|девятью)$/u, 9],
];
const RU_TEENS: Array<[RegExp, number]> = [
  [/^(?:десять|десяти|десятью)$/u, 10],
  [/^одиннадцат[ьи]$/u, 11],
  [/^двенадцат[ьи]$/u, 12],
  [/^тринадцат[ьи]$/u, 13],
  [/^четырнадцат[ьи]$/u, 14],
  [/^пятнадцат[ьи]$/u, 15],
  [/^шестнадцат[ьи]$/u, 16],
  [/^семнадцат[ьи]$/u, 17],
  [/^восемнадцат[ьи]$/u, 18],
  [/^девятнадцат[ьи]$/u, 19],
];
const RU_TENS: Array<[RegExp, number]> = [
  [/^двадцат[ьи]$/u, 20],
  [/^тридцат[ьи]$/u, 30],
  [/^(?:сорок|сорока)$/u, 40],
  [/^(?:пятьдесят|пятидесяти)$/u, 50],
];
const RU_WORD = /[а-яё]+/giu;
const RU_WEAK = /^(?:один|одна|одно)$/u;

const ruValue = (word: string, table: Array<[RegExp, number]>): number | null => table.find(([re]) => re.test(word))?.[1] ?? null;

/**
 * Thai numerals, read without word spaces. A word that only starts like a
 * number is not one: "ห้าง" (a mall), "ห้าม" (forbidden), "สามี" (a husband),
 * "สามารถ" (can), "หกล้ม" (to fall), "เก้าอี้" (a chair).
 */
const TH_DIGIT_WORDS: Array<[string, number, RegExp | null]> = [
  ['หนึ่ง', 1, null],
  ['สอง', 2, null],
  ['สาม', 3, /^[ีัา]/u],
  ['สี่', 4, null],
  ['ห้า', 5, /^[งม]/u],
  ['หก', 6, /^ล้ม/u],
  ['เจ็ด', 7, null],
  ['แปด', 8, null],
  ['เก้า', 9, /^อี้/u],
];
const TH_TEN = 'สิบ';
const TH_TWENTY = 'ยี่สิบ';
const TH_UNIT_ONE = 'เอ็ด';

function thaiDigitAt(text: string, i: number): { value: number; end: number } | null {
  for (const [word, value, notBefore] of TH_DIGIT_WORDS) {
    if (!text.startsWith(word, i)) continue;
    const end = i + word.length;
    if (notBefore && notBefore.test(text.slice(end))) return null;
    return { value, end };
  }
  return null;
}

/** One Thai numeral at `i` (up to the nineties), or null. */
function thaiNumberAt(text: string, i: number): { value: number; end: number } | null {
  let tens = 0;
  let at = i;
  if (text.startsWith(TH_TWENTY, at)) {
    tens = 20;
    at += TH_TWENTY.length;
  } else {
    const lead = thaiDigitAt(text, at);
    if (lead && lead.value >= 3 && text.startsWith(TH_TEN, lead.end)) {
      tens = lead.value * 10;
      at = lead.end + TH_TEN.length;
    } else if (text.startsWith(TH_TEN, at)) {
      tens = 10;
      at += TH_TEN.length;
    }
  }
  if (tens > 0) {
    if (text.startsWith(TH_UNIT_ONE, at)) return { value: tens + 1, end: at + TH_UNIT_ONE.length };
    const unit = thaiDigitAt(text, at);
    return unit ? { value: tens + unit.value, end: unit.end } : { value: tens, end: at };
  }
  return thaiDigitAt(text, i);
}

/** Thai digits (๐–๙) as ASCII, one character for one, so every index stays the text's own. */
const asciiDigits = (text: string) => text.replace(/[๐-๙]/gu, (c) => String(c.charCodeAt(0) - 0x0e50));

/**
 * Every whole number a text writes, in digits or in words (Thai, English,
 * Russian), in order: "8", "๘", "eight", "twenty-five", "восемь", "двадцать
 * пять", "แปด", "สิบสอง", "ยี่สิบห้า". Not the second half of a decimal or of
 * a longer number ("081-234"), not a run of five digits or more.
 */
export function numbersIn(raw: string): NumberFound[] {
  const text = asciiDigits(raw.normalize('NFC'));
  const found: NumberFound[] = [];
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/gu)) {
    if (/[.,:/-]/u.test(text[m.index - 1] ?? '') && /\d/u.test(text[m.index - 2] ?? '')) continue;
    const whole = m[0].replace(/[.,]\d+$/u, '');
    if (whole.length > 4) continue;
    found.push({ value: Number(whole), start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(EN_NUMBER)) {
    const [, tens, tensUnit, teen, unit, dozen] = m;
    const value = tens
      ? EN_TENS[tens.toLowerCase()]! + (tensUnit ? EN_UNITS[tensUnit.toLowerCase()]! : 0)
      : teen
        ? EN_TEENS[teen.toLowerCase()]!
        : unit
          ? EN_UNITS[unit.toLowerCase()]!
          : dozen
            ? 12
            : null;
    if (value === null) continue;
    const weak = unit?.toLowerCase() === 'one';
    found.push({ value, start: m.index, end: m.index + m[0].length, ...(weak ? { weak: true as const } : {}) });
  }
  const words = [...text.matchAll(RU_WORD)].map((m) => ({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const tens = ruValue(w.word, RU_TENS);
    if (tens !== null) {
      const next = words[i + 1];
      const unit = next && /^\s+$/u.test(text.slice(w.end, next.start)) ? ruValue(next.word, RU_UNITS) : null;
      found.push({ value: tens + (unit ?? 0), start: w.start, end: unit !== null ? next!.end : w.end });
      if (unit !== null) i++;
      continue;
    }
    const value = ruValue(w.word, RU_TEENS) ?? ruValue(w.word, RU_UNITS);
    if (value !== null) found.push({ value, start: w.start, end: w.end, ...(RU_WEAK.test(w.word) ? { weak: true as const } : {}) });
  }
  for (let i = 0; i < text.length; ) {
    const n = /[฀-๿]/u.test(text[i]!) ? thaiNumberAt(text, i) : null;
    if (n) {
      found.push({ value: n.value, start: i, end: n.end });
      i = n.end;
    } else {
      i++;
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// What a number counts
// ---------------------------------------------------------------------------

type Unit = 'years' | 'months' | 'kids' | 'adults' | 'people' | 'other' | null;

/** A unit written after the number ("8 years", "12 kids", "восемь лет", "แปดขวบ", "2 pm"). */
const AFTER: Array<[Exclude<Unit, null>, RegExp]> = [
  ['months', /^\s*(?:months?|mos?(?![a-z])|мес(?:яц\p{L}*)?|เดือน)/iu],
  ['years', /^\s*(?:-?\s*years?(?:-old)?|yrs?(?![a-z])|y\.\s?o\.?|yo(?![a-z])|лет(?!\p{L})|год(?:а|ик|ика|иков)?(?!\p{L})|годовал\p{L}*|ขวบ|ปี)/iu],
  ['kids', /^\s*(?:kids?|children|child|little ones|boys?|girls?|дет\p{L}*|ребят\p{L}*|ребен\p{L}*|ребён\p{L}*|малыш\p{L}*|мальчик\p{L}*|девоч\p{L}*|เด็ก)/iu],
  ['adults', /^\s*(?:adults?|grown-?ups?|parents?|взросл\p{L}*|родител\p{L}*|ผู้ใหญ่|ผู้ปกครอง)/iu],
  ['people', /^\s*(?:people|persons?|guests?|pax|of us|человек\p{L}*|чел\.|гост\p{L}*|คน|ท่าน)/iu],
  [
    'other',
    /^\s*(?:baht|thb|฿|บาท|бат\p{L}*|руб\p{L}*|%|percent|hours?|hrs?|h(?![a-z])|час\p{L}*|ชั่วโมง|ชม|a\.?m\.?|p\.?m\.?|o'?clock|โมง|ทุ่ม|นาฬิกา|น\.|:\d|th(?![a-z])|st(?![a-z])|nd(?![a-z])|rd(?![a-z])|-?го(?!\p{L})|числ\p{L}*|minutes?|mins?|минут\p{L}*|นาที|floor|этаж\p{L}*|ชั้น)/iu,
  ],
];
/** Thai writes what is counted before the number ("เด็ก 12 คน", "ผู้ใหญ่ 5 คน", "อายุ 8"); so do "aged 8" and a price sign. */
const BEFORE: Array<[Exclude<Unit, null>, RegExp]> = [
  ['kids', /(?:เด็ก|น้อง)(?:ๆ)?\s*(?:ประมาณ|ราวๆ?|รวม|จำนวน)?\s*$/u],
  ['adults', /(?:ผู้ใหญ่|ผู้ปกครอง)\s*(?:ประมาณ|ราวๆ?|รวม|จำนวน)?\s*$/u],
  ['years', /(?:อายุ|aged?)\s*$/iu],
  ['other', /(?:[฿$#]|no\.|room|ราคา|เบอร์)\s*$/iu],
];

function unitOf(text: string, n: NumberFound): Unit {
  const after = text.slice(n.end);
  const said = AFTER.find(([, re]) => re.test(after))?.[0] ?? null;
  // "เด็ก 12 คน": the people word after the number counts the kids named before it.
  if (said !== null && said !== 'people') return said;
  const before = text.slice(Math.max(0, n.start - 16), n.start);
  return BEFORE.find(([, re]) => re.test(before))?.[0] ?? said;
}

/** The text with its date and time phrases blanked out (same length), so "on the 14th" or "at 2 pm" is no count and no age. */
function withoutDatesAndTimes(text: string, today: string): string {
  let out = text;
  const blank = (phrase: string) => {
    if (!phrase) return false;
    const at = out.indexOf(phrase);
    if (at < 0) return false;
    out = out.slice(0, at) + ' '.repeat(phrase.length) + out.slice(at + phrase.length);
    return true;
  };
  for (let i = 0; i < 4; i++) {
    const date = blank(readPartyDate(out, today).phrase);
    const time = blank(readPartyTimePhrase(out)?.phrase ?? '');
    if (!date && !time) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parks and residency
// ---------------------------------------------------------------------------

const PARK_WORDS: Record<AiBranchKey, RegExp> = {
  central: /central|floresta|централ\p{L}*|флорест\p{L}*|เซ็นทรัล|เซนทรัล|ฟลอเรส/iu,
  chalong: /chalong|robinson|чалонг\p{L}*|робинсон\p{L}*|ฉลอง|โรบินสัน/iu,
};

/** The park a text names, or null (none, or both). */
export function parkNamedIn(text: string): AiBranchKey | null {
  const named = (Object.keys(PARK_WORDS) as AiBranchKey[]).filter((k) => PARK_WORDS[k].test(text));
  return named.length === 1 ? named[0]! : null;
}

const RESIDENT =
  /resident|live (?:here|in phuket|in thailand)|living (?:here|in phuket|in thailand)|expat|work permit|живу|живём|живем|резидент|местн\p{L}*|อาศัยอยู่|อยู่ภูเก็ต/iu;
const TOURIST = /tourist|holiday|vacation|visiting|турист\p{L}*|отдыха\p{L}*|в отпуске|นักท่องเที่ยว|มาเที่ยว/iu;

// ---------------------------------------------------------------------------
// The customer's message read as the answer
// ---------------------------------------------------------------------------

/** The slots a reply answered: the value kept for each (short), or null for "answered" with nothing kept (a name). */
export type SlotAnswers = Partial<Record<Slot, string | null>>;

/** The numeric slots: a bare number answers one of them only when it is the only one asked. */
const NUMERIC: ReadonlySet<Slot> = new Set<Slot>(['child_age', 'kids_count', 'adults_count', 'guests_count']);
/** The free-answer slots: a short reply that asks nothing is their answer; nothing of it is kept. */
const FREE: ReadonlySet<Slot> = new Set<Slot>(['child_name', 'package']);
/** The most words a free answer has ("Mia", "the golden one please"). */
const FREE_ANSWER_WORDS = 8;

const wordCount = (text: string) => text.trim().split(/\s+/u).filter(Boolean).length;
const asksSomething = (text: string) => /[?？]/u.test(text) || THAI_QUESTION.test(text);
const clip = (value: string) => [...value].slice(0, INBOX_OPEN_QUESTION_ANSWER_MAX).join('');

/**
 * The customer's message read AS THE ANSWER to the slots the assistant asked
 * (SCRUM-831): each slot the reply fills, with the value kept for it; a slot
 * it does not answer is absent. `today` is the park's day (`YYYY-MM-DD`): a
 * date is counted from it. A bare number ("8", "восемь", "แปด") answers the
 * one numeric question asked, never one of several, and never a count it
 * names ("12 kids" is no age).
 */
export function readSlotAnswers(asked: readonly Slot[], reply: string, today: string): SlotAnswers {
  const out: SlotAnswers = {};
  const text = reply.normalize('NFC').trim();
  if (text === '') return out;
  const slots = asked.filter((s) => s !== 'other');
  const plain = asciiDigits(withoutDatesAndTimes(text, today));
  const counted = numbersIn(plain).map((n) => ({ ...n, unit: unitOf(plain, n) }));
  const numericAsked = slots.filter((s) => NUMERIC.has(s));
  const bare = numericAsked.length === 1 ? counted.filter((n) => n.unit === null && !n.weak) : [];
  const of = (unit: Unit) => counted.filter((n) => n.unit === unit);

  for (const slot of slots) {
    switch (slot) {
      case 'child_age': {
        const ages = [
          ...of('years').filter((n) => n.value <= 17).map((n) => String(n.value)),
          ...of('months').filter((n) => n.value <= 36).map((n) => `${n.value} months`),
        ];
        if (ages.length === 0) ages.push(...bare.filter((n) => n.value <= 17).map((n) => String(n.value)));
        if (ages.length > 0) out.child_age = clip([...new Set(ages)].join(', '));
        break;
      }
      case 'kids_count':
      case 'adults_count': {
        const n = of(slot === 'kids_count' ? 'kids' : 'adults')[0] ?? bare.find((b) => b.value >= 1 && b.value <= 300);
        if (n) out[slot] = String(n.value);
        break;
      }
      case 'guests_count': {
        const kids = of('kids')[0];
        const adults = of('adults')[0];
        const people = of('people')[0] ?? bare.find((b) => b.value >= 1 && b.value <= 300);
        const parts = [kids ? `${kids.value} kids` : null, adults ? `${adults.value} adults` : null].filter((p): p is string => p !== null);
        if (parts.length > 0) out.guests_count = clip(parts.join(', '));
        else if (people) out.guests_count = String(people.value);
        break;
      }
      case 'date': {
        const read = readPartyDate(text, today);
        if (read.date) out.date = read.date;
        break;
      }
      case 'time': {
        const read = readPartyTimePhrase(text);
        if (read) out.time = read.time;
        break;
      }
      case 'park': {
        const park = parkNamedIn(text);
        if (park) out.park = park;
        break;
      }
      case 'residency': {
        const resident = RESIDENT.test(text);
        const tourist = TOURIST.test(text);
        if (resident !== tourist) out.residency = resident ? 'resident' : 'tourist';
        break;
      }
      default:
        if (FREE.has(slot) && wordCount(text) <= FREE_ANSWER_WORDS && !asksSomething(text)) out[slot] = null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// What a reply asks
// ---------------------------------------------------------------------------

/** Each slot's question, in the three languages. Read only inside a question (`questionsIn`). */
const ASKS: ReadonlyArray<[Slot, RegExp]> = [
  [
    'child_age',
    /how old|what age|age (?:of|is) (?:the|your|her|his)|years old will|сколько (?:лет|годик\p{L}*|исполн\p{L}*)|какой возраст|возраст (?:ребенка|ребёнка|именинни\p{L}*|малыш\p{L}*|детей)|อายุ(?:เท่าไ|กี่|ประมาณ)|กี่ขวบ|ครบกี่/iu,
  ],
  [
    'kids_count',
    /how many (?:kids|children|little ones|child)|сколько (?:детей|деток|ребят\p{L}*|малыш\p{L}*)|เด็ก(?:ๆ)?(?:ประมาณ)?(?:กี่|จำนวน)|เด็ก[^?]{0,12}กี่คน|น้อง(?:ๆ)?(?:ประมาณ)?กี่คน/iu,
  ],
  ['adults_count', /how many (?:adults|grown-?ups|parents)|сколько (?:взрослых|родителей)|ผู้ใหญ่(?:ประมาณ)?(?:กี่|จำนวน)|ผู้ใหญ่[^?]{0,12}กี่/iu],
  [
    'guests_count',
    /how many (?:people|guests|persons|of you)|roughly how many|about how many|headcount|number of (?:guests|people)|сколько (?:человек|гостей|вас)|сколько будет (?:гостей|человек)|กี่ท่าน|กี่คน|จำนวนแขก|แขกประมาณ/iu,
  ],
  [
    'park',
    /which (?:park|branch|location)|central floresta (?:or|หรือ|или) (?:robinson )?chalong|robinson chalong (?:or|หรือ|или) central|какой (?:парк|филиал)|в каком (?:парке|филиале)|สาขาไหน|สาขาใด/iu,
  ],
  [
    'date',
    /what date|which date|which day|what day|what dates|dates? (?:are you|you're) thinking|when (?:would|will|is|are|do) (?:you|the party|it)|какую дату|какого числа|на какое число|на какую дату|в какой день|какой день|когда (?:планиру\p{L}*|хотите|будет|вы)|วันไหน|วันที่เท่าไ|วันอะไร|สะดวกวัน/iu,
  ],
  ['time', /what time|which time|at what time|во сколько|в какое время|какое время|กี่โมง|เวลาไหน|ช่วงเวลาไหน/iu],
  [
    'child_name',
    /what(?:'s| is) (?:(?:his|her|their) name|the (?:birthday )?(?:child|boy|girl|kid)'s name|your (?:son|daughter|child|little one)'s name)|name of the birthday|как зовут|имя (?:ребенка|ребёнка|именинни\p{L}*|малыш\p{L}*)|น้องชื่อ|ชื่อน้อง|ชื่ออะไร/iu,
  ],
  ['package', /which package|what package|which of (?:our|the) packages|какой пакет|какой из пакетов|แพ็[กค]เกจไหน|แพคเกจไหน/iu],
  [
    'residency',
    /(?:are you|do you) (?:a )?(?:resident|living|live (?:here|in phuket|in thailand)|on holiday|visiting|a tourist)|resident or|tourist or|вы (?:живете|живёте|резидент|турист|отдыхаете)|в отпуске или|жив[её]те в таиланде|жив[её]те на пхукете|резидент или|อาศัยอยู่|เป็นนักท่องเที่ยว/iu,
  ],
];

/** A reply's questions: each sentence that ends in a question mark, or that holds a Thai interrogative. */
export function questionsIn(bubbles: readonly string[]): string[] {
  const out: string[] = [];
  for (const b of bubbles) {
    for (const piece of b.split(/(?<=[?？!.。])\s+|\n+/u)) {
      const s = piece.trim();
      if (s && (/[?？]/u.test(s) || THAI_QUESTION.test(s))) out.push(s);
    }
  }
  return out;
}

/**
 * The slots a reply asks the customer for, read from its own questions. A
 * headcount question that names the kids or the adults is theirs, not the
 * general "how many people".
 */
export function slotsAskedIn(bubbles: readonly string[]): Slot[] {
  const found = new Set<Slot>();
  for (const q of questionsIn(bubbles)) {
    const here = ASKS.filter(([, re]) => re.test(q)).map(([slot]) => slot);
    for (const slot of here) {
      if (slot === 'guests_count' && (here.includes('kids_count') || here.includes('adults_count'))) continue;
      found.add(slot);
    }
  }
  return [...found];
}

/**
 * The slots a reply asks: what the model declares, and what its own questions
 * ask (`other` and repeats dropped). A declaration counts only when a bubble
 * asks something at all: a reply with no question asks nothing, whatever the
 * decision says.
 */
export function askedSlotsOf(declared: readonly Slot[] | undefined, bubbles: readonly string[]): Slot[] {
  if (questionsIn(bubbles).length === 0) return [];
  const out: Slot[] = [];
  for (const s of [...(declared ?? []), ...slotsAskedIn(bubbles)]) if (s !== 'other' && !out.includes(s)) out.push(s);
  return out;
}
