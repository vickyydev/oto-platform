/**
 * SCRUM-831 — THE SLOT READER: what a reply asks, and what the customer's
 * answer says (owner, 10 Nov 2026: "the memory is the primary mechanism").
 *
 *   slotsAskedIn(bubbles)       the slots a reply's questions ask, read from
 *                               its own words in Thai, English and Russian —
 *                               the server's check beside the model's
 *                               declared `askedSlots`, never instead of it.
 *   readSlotAnswers(slots, text, today, { bare })
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
    /^\s*(?:baht|thb|฿|บาท|бат\p{L}*|руб\p{L}*|%|percent|hours?|hrs?|h(?![a-z])|час\p{L}*|ชั่วโมง|ชม|a\.?m\.?|p\.?m\.?|o'?clock|โมง|ทุ่ม|นาฬิกา|น\.|:\d|th(?![a-z])|st(?![a-z])|nd(?![a-z])|rd(?![a-z])|-?го(?!\p{L})|числ\p{L}*|minutes?|mins?|минут\p{L}*|นาที|floor|этаж\p{L}*|ชั้น|famil(?:y|ies)|cars?(?![a-z])|машин\p{L}*|сем(?:ьи|ей|ья)(?!\p{L})|ครอบครัว|คัน)/iu,
  ],
];
/**
 * The child named, then the number: an age, never a count ("she is 8", "my
 * daughter is 8", "he turns 6", "she'll be 8", "ей будет 8", "исполнится 8",
 * "ครบ 8").
 */
const AGE_CUE =
  /(?:(?<![a-z])(?:(?:she|he|daughter|son|boy|girl|kid|child|little one|birthday (?:boy|girl|child))(?:['’]s| is| will be|['’]ll be| turns| is turning| turning| will turn)?|turns|turning|will turn)(?: (?:only|just|almost|nearly))?|(?<!\p{L})(?:(?:ей|ему|дочке|дочери|дочь|дочка|сыну|сын|сынок|имениннику|имениннице|малышу|малышке)(?:\s+(?:будет|исполнится|исполняется|уже|только))?|исполнится|исполняется|исполнилось)|ครบ(?:รอบ)?)\s*$/iu;
/** A headcount: "we will be 8", "we are 12", "table for 8", "нас 8", "нас будет 8", "เรามา 8". */
const HEADCOUNT_CUE =
  /(?:(?<![a-z])(?:we(?:['’]re| are| will be|['’]ll be| would be)?|us|of us|party of|for)|(?<!\p{L})(?:нас|мы|на)(?:\s+(?:будет|будем))?|เรา(?:มา|ไป|มี)?(?:กัน)?(?:ประมาณ)?)\s*$/iu;
/**
 * "for 8" / "на 8" alone is a headcount only in a line that answers. In a
 * line that asks something it names what is asked about ("table for 8?",
 * "столик на 8?" — staging, 10 Nov 2026, read as 8 guests), and the
 * customer's real answer follows later.
 */
const WEAK_HEADCOUNT_CUE = /(?:(?<![a-z])for|(?<!\p{L})на)\s*$/iu;
/** A choice, a time or a place, not a count or an age: "package 3", "option 2", "at 8", "from 3", "grade 3", "в 8", "с 3 до 5", "ห้องที่ 3", "ป.3". */
const CHOICE_OR_TIME_CUE =
  /(?:(?<![a-z])(?:at|from|to|till|until|by|before|after|between|package|option|grade|year|class|table|number|level)|(?<!\p{L})(?:в|к|с|до|после|пакет\p{L}*|вариант\p{L}*|класс\p{L}*|номер\p{L}*|столик\p{L}*)|ห้อง(?:ที่)?|ที่|ป\.|แพ็[กค]เกจ(?:ที่)?|แพคเกจ(?:ที่)?|ตัวเลือก(?:ที่)?|ตอน|เวลา|โต๊ะ(?:ที่)?)\s*$/iu;
/** Thai writes what is counted before the number ("เด็ก 12 คน", "ผู้ใหญ่ 5 คน", "อายุ 8"); so do "aged 8", a price sign, and the cues above. */
const BEFORE: Array<[Exclude<Unit, null>, RegExp]> = [
  ['kids', /(?:เด็ก|น้อง)(?:ๆ)?\s*(?:ประมาณ|ราวๆ?|รวม|จำนวน)?\s*$/u],
  ['adults', /(?:ผู้ใหญ่|ผู้ปกครอง)\s*(?:ประมาณ|ราวๆ?|รวม|จำนวน)?\s*$/u],
  // Not the end of another word: "Package 3" is no age.
  ['years', /(?:อายุ|(?<![a-z])aged?)\s*$/iu],
  ['years', AGE_CUE],
  ['people', HEADCOUNT_CUE],
  ['other', /(?:[฿$#]|no\.|room|ราคา|เบอร์)\s*$/iu],
  ['other', CHOICE_OR_TIME_CUE],
];

/**
 * A reply that says what it counts in words a bare number never answers an
 * age or a count from (SCRUM-831 review): "we", "table", "package", "option",
 * "grade", "нас", "будет", "ห้อง"… — "Package 3 please", "we are 2 families",
 * "нас будет 8" are no age.
 */
const BARE_CUE =
  /(?<![a-z])(?:we|we['’]re|us|for|table|at|package|option|grade|year|class|room|cars?|famil(?:y|ies)|will be)(?![a-z])|(?<!\p{L})(?:нас|мы|будет|будем|столик\p{L}*|пакет\p{L}*|вариант\p{L}*|класс\p{L}*|машин\p{L}*)(?!\p{L})|เรา|โต๊ะ|ห้อง|แพ็[กค]เกจ|แพคเกจ|ครอบครัว/iu;
/** A bare answer is short: a few words ("8", "eight!", "twins, 6 and 4", "She'll be 8 on Saturday"). */
const BARE_ANSWER_WORDS = 8;
const BARE_ANSWER_CHARS = 60;

function unitOf(text: string, n: NumberFound, asking: boolean): Unit {
  const after = text.slice(n.end);
  const said = AFTER.find(([, re]) => re.test(after))?.[0] ?? null;
  // "เด็ก 12 คน": the people word after the number counts the kids named before it.
  if (said !== null && said !== 'people') return said;
  const before = text.slice(Math.max(0, n.start - 16), n.start);
  // "table for 8?": a thing asked about, not the headcount, when the line asks.
  if (asking && said === null && WEAK_HEADCOUNT_CUE.test(before)) return 'other';
  return BEFORE.find(([, re]) => re.test(before))?.[0] ?? said;
}

/**
 * SCRUM-823: the text names a headcount — kids, adults or people counted
 * ("a party of 12 kids", "для 10 детей", "เด็ก 12 คน", "we will be 20", "for
 * 15 guests"), never an age ("our 5 year old"), a time, a price or a choice.
 * Read without a "today": a caller that also asks for a date reads the date
 * on its own (`@oto/shared` `mentionsPartyDate`).
 */
export function headcountNamedIn(text: string): boolean {
  const plain = asciiDigits(text.normalize('NFC'));
  // The same reading as an answer's: "table for 8?" names no headcount.
  const asking = asksSomething(text);
  return numbersIn(plain).some((n) => {
    if (n.weak) return false;
    const unit = unitOf(plain, n, asking);
    return unit === 'kids' || unit === 'adults' || unit === 'people';
  });
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

/** Every park a text names (SCRUM-832: "Central or Chalong, which is closer?" names both). */
export function parksNamedIn(text: string): AiBranchKey[] {
  return (Object.keys(PARK_WORDS) as AiBranchKey[]).filter((k) => PARK_WORDS[k].test(text));
}

/** The park a text names, or null (none, or both). */
export function parkNamedIn(text: string): AiBranchKey | null {
  const named = parksNamedIn(text);
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

/** How a reply is read (`readSlotAnswers`). */
export interface SlotReadOptions {
  /**
   * The slots an answer with no unit may fill — a bare number ("8") or a
   * free answer ("Mia"): those the line just before the reply asked. Absent:
   * every slot asked (the customer's first reply to the assistant's own
   * question). A number with its unit ("8 years", "восемь лет", "แปดขวบ"), a
   * date, a time, a park and residency are read for every slot asked.
   */
  bare?: readonly Slot[];
}

/**
 * The customer's message read AS THE ANSWER to the slots the assistant asked
 * (SCRUM-831): each slot the reply fills, with the value kept for it; a slot
 * it does not answer is absent. `today` is the park's day (`YYYY-MM-DD`): a
 * date is counted from it. A bare number ("8", "восемь", "แปด") answers the
 * one numeric question asked, never one of several, never a count it names
 * ("12 kids" is no age), and only from a short reply that asks nothing and
 * names no headcount, time or choice ("we will be 8", "table for 8?",
 * "Package 3 please", "Grade 3", "ห้องที่ 3" are no age; "my daughter is 8",
 * "she turns 6" are no count).
 */
export function readSlotAnswers(asked: readonly Slot[], reply: string, today: string, opts: SlotReadOptions = {}): SlotAnswers {
  const out: SlotAnswers = {};
  const text = reply.normalize('NFC').trim();
  if (text === '') return out;
  const slots = asked.filter((s) => s !== 'other');
  const plain = asciiDigits(withoutDatesAndTimes(text, today));
  const asking = asksSomething(text);
  const counted = numbersIn(plain).map((n) => ({ ...n, unit: unitOf(plain, n, asking) }));
  const bareAllowed = (s: Slot) => opts.bare === undefined || opts.bare.includes(s);
  const bareReply = !asking && !BARE_CUE.test(plain) && wordCount(plain) <= BARE_ANSWER_WORDS && [...text].length <= BARE_ANSWER_CHARS;
  const numericBare = slots.filter((s) => NUMERIC.has(s) && bareAllowed(s));
  const bareSlot = bareReply && numericBare.length === 1 ? numericBare[0]! : null;
  const bareNumbers = counted.filter((n) => n.unit === null && !n.weak);
  const bare = (slot: Slot) => (slot === bareSlot ? bareNumbers : []);
  const of = (unit: Unit) => counted.filter((n) => n.unit === unit);

  for (const slot of slots) {
    switch (slot) {
      case 'child_age': {
        const ages = [
          ...of('years').filter((n) => n.value <= 17).map((n) => String(n.value)),
          ...of('months').filter((n) => n.value <= 36).map((n) => `${n.value} months`),
        ];
        if (ages.length === 0) ages.push(...bare(slot).filter((n) => n.value <= 17).map((n) => String(n.value)));
        if (ages.length > 0) out.child_age = clip([...new Set(ages)].join(', '));
        break;
      }
      case 'kids_count':
      case 'adults_count': {
        const n = of(slot === 'kids_count' ? 'kids' : 'adults')[0] ?? bare(slot).find((b) => b.value >= 1 && b.value <= 300);
        if (n) out[slot] = String(n.value);
        break;
      }
      case 'guests_count': {
        const kids = of('kids')[0];
        const adults = of('adults')[0];
        const people = of('people')[0] ?? bare(slot).find((b) => b.value >= 1 && b.value <= 300);
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
        if (FREE.has(slot) && bareAllowed(slot) && wordCount(text) <= FREE_ANSWER_WORDS && !asksSomething(text)) out[slot] = null;
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
    /how old|what age|(?<![a-z])age (?:of|is) (?:the|your|her|his)|years old will|turning|which birthday|(?:her|his|their|the) \d+(?:st|nd|rd|th)(?: or \d+(?:st|nd|rd|th))? birthday|сколько (?:лет|годик\p{L}*|исполн\p{L}*)|сколько (?:ей|ему|ребенку|ребёнку|имениннику|имениннице|малышу|малышке) (?:лет|исполн\p{L}*)|какой возраст|возраст (?:ребенка|ребёнка|именинни\p{L}*|малыш\p{L}*|детей)|อายุ(?:เท่าไ|กี่|ประมาณ)|(?:บอก|แจ้ง|ขอทราบ)อายุ|กี่ขวบ|ครบ(?:รอบ)?\s*กี่/iu,
  ],
  [
    'kids_count',
    /how many (?:kids|children|little ones|child)|number of (?:kids|children)|сколько (?:детей|деток|ребят\p{L}*|малыш\p{L}*)|เด็ก(?:ๆ)?(?:ประมาณ)?(?:กี่|จำนวน)|เด็ก[^?]{0,12}กี่คน|น้อง(?:ๆ)?(?:ประมาณ)?กี่คน/iu,
  ],
  ['adults_count', /how many (?:adults|grown-?ups|parents)|сколько (?:взрослых|родителей)|ผู้ใหญ่(?:ประมาณ)?(?:กี่|จำนวน)|ผู้ใหญ่[^?]{0,12}กี่/iu],
  [
    'guests_count',
    /how many (?:(?:little|young|small) )?(?:people|guests|persons|friends|of you)|roughly how many|about how many|headcount|number of (?:guests|people)|сколько (?:примерно |приблизительно )?(?:будет )?(?:человек|гостей|вас)|กี่ท่าน|กี่คน|จำนวนแขก|แขกประมาณ/iu,
  ],
  [
    'park',
    /which (?:park|branch|location)|which of (?:our|the) (?:parks|branches|locations)|what (?:park|branch|location)|central floresta (?:or|หรือ|или) (?:robinson )?chalong|robinson chalong (?:or|หรือ|или) central|какой (?:парк|филиал)|какой из (?:наших )?(?:парков|филиалов)|в каком (?:парке|филиале)|в какой (?:парк|филиал)|สาขาไหน|สาขาใด/iu,
  ],
  [
    'date',
    /what date|which date|which day|what day|what dates|dates? (?:are you|you're) thinking|when (?:would|will|is|are|do) (?:you|the party|it)|when(?:['’]s| is) (?:her|his|their|the|your)(?: \p{L}+)? birthday|(?:picked|chosen|set|got|have|found) (?:a|the) date|dates? in mind|(?<![a-z])(?:the|your|a|preferred) (?:party |event |preferred )?dates?(?![a-z])|какую дату|какого числа|на какое число|на какую дату|в какой день|какой день|(?<!\p{L})дат[уаы](?!\p{L})|когда (?:у (?:неё|нее|него|вас|ребенка|ребёнка) )?(?:день рождения|праздник|др(?!\p{L}))|когда (?:планиру\p{L}*|хотите|будет|вы)|วันไหน|วันที่เท่าไ|วันที่สะดวก|(?:แจ้ง|บอก)วันที่|วันอะไร|สะดวกวัน|วันเกิด\S{0,12}?(?:วันไหน|วันที่|เมื่อไ)/iu,
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

/**
 * An ask written as a request, with no question mark (SCRUM-831 review): "Let
 * me know how old she is 😊", "Напишите, пожалуйста, сколько лет ребёнку.",
 * "Подскажите возраст именинника", "รบกวนแจ้งวันที่ค่ะ", "บอกอายุน้องหน่อยค่ะ".
 */
const IMPERATIVE_ASK =
  /(?<![a-z])(?:let (?:me|us) know|tell (?:me|us)|please (?:share|send|confirm|tell)|share with us|could you (?:share|tell|confirm|send)|drop (?:me|us) a (?:line|message))(?![a-z])|(?<!\p{L})(?:напишите|подскажите|сообщите|уточните|скажите|расскажите|дайте знать)(?!\p{L})|(?:บอก|แจ้ง)[^\n.!?]{0,40}?หน่อย|(?<!ที่)รบกวน|ขอทราบ/iu;

/** A reply's questions: each sentence that ends in a question mark, holds a Thai interrogative, or asks as a request ("let me know…", "напишите…", "รบกวน…"). */
export function questionsIn(bubbles: readonly string[]): string[] {
  const out: string[] = [];
  for (const b of bubbles) {
    for (const piece of b.split(/(?<=[?？!.。])\s+|\n+/u)) {
      const s = piece.trim();
      if (s && (/[?？]/u.test(s) || THAI_QUESTION.test(s) || IMPERATIVE_ASK.test(s))) out.push(s);
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

// ---------------------------------------------------------------------------
// SCRUM-842: the child's age the customer said unasked
// ---------------------------------------------------------------------------

/** "six year old", "6-year-old", "6 yrs old", "6yo", "6 y.o.", "6 y/o": an age and nothing else. */
const SAID_YEARS_OLD = /^\s*-?\s*(?:(?:years?|yrs?)[\s-]*olds?|y\.?\s?\/?o\.?)(?![a-z])/iu;
const SAID_MONTHS_OLD = /^\s*-?\s*(?:months?|mos?)[\s-]*olds?(?![a-z])/iu;
/** "6 лет", "3 года", "годик". */
const SAID_RU_YEARS = /^\s*(?:лет|год(?:а|ик|ика|иков)?)(?!\p{L})/iu;
/** "6 ขวบ": Thai counts only a child's years in ขวบ. */
const SAID_TH_YEARS = /^\s*ขวบ/u;
/** Years or months with no "old": an age only after a word for the child ("she is 6 years", "ей 10 месяцев", "อายุ 6 ปี"). */
const SAID_LOOSE_YEARS = /^\s*(?:-?\s*years?(?![a-z])|yrs?(?![a-z])|ปี)/iu;
const SAID_LOOSE_MONTHS = /^\s*(?:months?(?![a-z])|mos?(?![a-z])|мес(?:яц\p{L}*)?|เดือน)/iu;
/** The child, then the number: "she is six", "my son turns 6", "aged six", "age: 6", "ей шесть", "ему 6", "сыну исполнится 6", "อายุ 6". */
const SAID_CHILD_CUE =
  /(?:(?<![a-z])(?:(?:she|he|daughter|son|boy|girl|kid|child|little one|toddler|baby|brother|sister|one)(?:['’]s| is| will be|['’]ll be| turns| is turning| turning| will turn| just turned| turned)|aged|age(?: is|:)?|turns|turning|turned)(?: (?:only|just|almost|nearly|now|already))?|(?<!\p{L})(?:(?:ей|ему|дочке|дочери|доче|сыну|сыночку|ребенку|ребёнку|малышу|малышке|имениннику|имениннице|девочке|мальчику)(?:\s+(?:будет|исполнится|исполняется|исполнилось|уже|только|скоро|почти))*|исполнится|исполняется|исполнилось)|อายุ)\s*$/iu;
/** After a number with no unit, the age ends there: the line's end, a mark, or a word that starts something else ("she is six and loves slides"). */
const SAID_BARE_END =
  /^\s*(?:$|[.,!?;:)…]|(?:and|but|so|now|already|today|this|next|on|in|soon)(?![a-z])|(?:и|а|но)(?!\p{L})|ค่ะ|คะ|ครับ|แล้ว)/iu;
/** A limit or a range, not a child: "from 4 years old", "under 6", "up to 12 years", "4 to 12 years old", "от 3 лет", "до 12 лет", "ตั้งแต่ 4 ขวบ". */
const SAID_BOUND_BEFORE =
  /(?:(?<![a-z])(?:from|under|over|above|below|up to|until|till|to|than|least|most|min(?:imum)?|max(?:imum)?|between|ages)|(?<!\p{L})(?:от|до|с|старше|младше|больше|меньше|минимум|максимум)|ตั้งแต่|ต่ำกว่า|ไม่เกิน|เกิน|ถึง|มากกว่า|น้อยกว่า)\s*$/iu;
const SAID_BOUND_AFTER = /^\s*(?:\+|and (?:up|over|above|older)|or (?:older|younger|over|under|above|more|less)|и (?:старше|младше)|ขึ้นไป|ลงมา)/iu;
/** Years that are no age: "живём тут 6 лет"; and a time gone by, in any language: "6 лет назад", "she turned 6 months ago", "6 ปีที่แล้ว". */
const SAID_DURATION_BEFORE = /(?<!\p{L})(?:жив\p{L}*|работа\p{L}*|через|течение|последни\p{L}*|кажд\p{L}*)(?:\s+\p{L}+)?\s*$/iu;
const SAID_AGO_AFTER = /^\s*(?:ago(?![a-z])|назад|ที่แล้ว|ก่อน)/iu;
/** "6 and 9 years old", "6, 4 and 2 years old", "6 и 9 лет", "6 กับ 9 ขวบ": the numbers before the one with the unit are ages too. */
const SAID_LIST_JOIN = /^\s*(?:,\s*(?:and|и)?|and|&|и|และ|กับ)\s*$/iu;

/** "шестилетний", "шестилетняя", "трёхлетка", "6-летний". */
const RU_AGE_STEMS: Array<[string, number]> = [
  ['двух', 2],
  ['тр[её]х', 3],
  ['четыр[её]х', 4],
  ['пяти', 5],
  ['шести', 6],
  ['семи', 7],
  ['восьми', 8],
  ['девяти', 9],
  ['десяти', 10],
  ['одиннадцати', 11],
  ['двенадцати', 12],
  ['тринадцати', 13],
  ['четырнадцати', 14],
  ['пятнадцати', 15],
  ['шестнадцати', 16],
  ['семнадцати', 17],
];
const RU_AGE_WORD = new RegExp(`(?<![\\p{L}\\d])(?:(${RU_AGE_STEMS.map(([s]) => s).join('|')})|(\\d{1,2})\\s?-?\\s?(?:х\\s?-?\\s?)?)лет[нк]\\p{L}*`, 'giu');
/** "годовалый": one year old. */
const RU_ONE_YEAR_OLD = /(?<!\p{L})годовал\p{L}*/iu;

/**
 * Another child comes into the line: a brother, a sister, a friend, "another
 * one". Their age was not said, so asking it is no repeat.
 */
const OTHER_CHILD =
  /(?<![a-z])(?:brothers?|sisters?|siblings?|cousins?|friends?|(?:another|other|second|third) (?:child|kid|one|boy|girl|son|daughter)|(?:younger|older|elder|eldest|youngest) (?:one|child|kid|son|daughter))(?![a-z])|(?<!\p{L})(?:брат\p{L}*|сестр\p{L}*|ещ[её] (?:один|одна|одного|одну)|втор\p{L}* (?:реб[её]н\p{L}*|сын\p{L}*|доч\p{L}*)|младш\p{L}*|старш\p{L}*|друг(?:а|ом|у)?|друзья|друзей|подруг\p{L}*)(?!\p{L})|อีกคน|พี่ชาย|พี่สาว|น้องชาย|น้องสาว|เพื่อน/iu;

/** The reply's age question is about another child than the one whose age was said ("And how old is her brother?", "How old is your other child?"). */
const OTHER_CHILD_ASKED =
  /(?<![a-z])(?:others?|another|second|third|younger|older|youngest|eldest|oldest|each|both|brothers?|sisters?|siblings?|friends?|cousins?)(?![a-z])|(?<!\p{L})(?:втор\p{L}*|друг\p{L}*|ещ[её]|брат\p{L}*|сестр\p{L}*|младш\p{L}*|старш\p{L}*|кажд\p{L}*|остальн\p{L}*|подруг\p{L}*)(?!\p{L})|อีกคน|คนอื่น|พี่|แต่ละคน|เพื่อน/iu;

const MAX_CHILD_YEARS = 17;
const MAX_CHILD_MONTHS = 36;
/** A family's own children counted in a line ("my two kids", "двое детей"): up to this many; more is a party's guest list. */
const MAX_SIBLINGS = 4;

/** The family's children a line counts ("I have 2 kids", "трое детей" as "3 детей"), 2 to `MAX_SIBLINGS`; 0 when it counts none. */
function siblingsCountedIn(line: string): number {
  const text = asciiDigits(line.normalize('NFC'));
  const asking = asksSomething(text);
  const counts = numbersIn(text)
    .filter((n) => !n.weak && unitOf(text, n, asking) === 'kids' && n.value >= 2 && n.value <= MAX_SIBLINGS)
    .map((n) => n.value);
  return Math.max(0, ...counts);
}

/** The ages one line states, as kept values ("6", "10 months"), in the line's order. */
function agesStatedIn(line: string): string[] {
  const text = asciiDigits(line.normalize('NFC'));
  const numbers = numbersIn(text);
  const found: Array<{ at: number; value: string }> = [];
  const years = (n: NumberFound) => n.value >= 1 && n.value <= MAX_CHILD_YEARS;
  const lead = (n: NumberFound) => text.slice(Math.max(0, n.start - 40), n.start);
  numbers.forEach((n, i) => {
    const after = text.slice(n.end);
    const before = lead(n);
    if (SAID_BOUND_BEFORE.test(before)) return;
    const cue = SAID_CHILD_CUE.test(before);
    const months = [SAID_MONTHS_OLD, ...(cue ? [SAID_LOOSE_MONTHS] : [])].map((re) => re.exec(after)).find((m) => m !== null);
    if (months) {
      const fits = n.value >= 1 && n.value <= MAX_CHILD_MONTHS;
      const rest = after.slice(months[0].length);
      if (fits && !SAID_BOUND_AFTER.test(rest) && !SAID_AGO_AFTER.test(rest)) found.push({ at: n.start, value: `${n.value} months` });
      return;
    }
    const russian = SAID_RU_YEARS.exec(after);
    const unit = SAID_YEARS_OLD.exec(after) ?? SAID_TH_YEARS.exec(after) ?? russian ?? (cue ? SAID_LOOSE_YEARS.exec(after) : null);
    if (unit) {
      const rest = after.slice(unit[0].length);
      if (!years(n) || SAID_BOUND_AFTER.test(rest) || SAID_AGO_AFTER.test(rest)) return;
      // Russian "лет" counts any years: no age after "живём тут".
      if (unit === russian && !cue && SAID_DURATION_BEFORE.test(before)) return;
      found.push({ at: n.start, value: String(n.value) });
      // "6 and 9 years old": the numbers listed before it.
      for (let k = i - 1; k >= 0; k--) {
        const prev = numbers[k]!;
        if (prev.weak || !years(prev) || !SAID_LIST_JOIN.test(text.slice(prev.end, numbers[k + 1]!.start))) break;
        if (SAID_BOUND_BEFORE.test(lead(prev))) break;
        found.push({ at: prev.start, value: String(prev.value) });
      }
      return;
    }
    // No unit: only right after the child ("she is six", "ему 6", "อายุ 6"), and only where the age ends there.
    if (cue && !n.weak && years(n) && SAID_BARE_END.test(after) && !SAID_BOUND_AFTER.test(after)) found.push({ at: n.start, value: String(n.value) });
  });
  for (const m of text.matchAll(RU_AGE_WORD)) {
    const stem = m[1]?.toLowerCase();
    const value = stem ? (RU_AGE_STEMS.find(([s]) => new RegExp(`^${s}$`, 'u').test(stem))?.[1] ?? null) : Number(m[2]);
    if (value !== null && value >= 1 && value <= MAX_CHILD_YEARS) found.push({ at: m.index, value: String(value) });
  }
  const one = RU_ONE_YEAR_OLD.exec(text);
  if (one) found.push({ at: one.index, value: '1' });
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.value))];
}

/**
 * SCRUM-842 (staging, 9 Nov 2026: "do you have drop-off for a six year old?"
 * was answered with "how old is your child?"): THE CHILD'S AGE THE CUSTOMER
 * SAID IN THEIR OWN LINES this episode, unasked — the value kept as the
 * answer reader keeps it ("6", "6, 9", "10 months"), or null.
 *
 * Stricter than the reply reader (`readSlotAnswers`), because nothing was
 * asked: a number is an age only with an age's own unit ("six year old",
 * "6yo", "6 лет", "шестилетняя", "6 ขวบ") or right after the child ("she is
 * six", "my son turns 6", "ему 6", "อายุ 6 ปี") — never a count, a time, a
 * price or a limit ("6 kids", "at 6 pm", "6 tickets", "600 baht", "from 4
 * years old"), and never an adult's (over 17).
 *
 * A later line that brings in ANOTHER CHILD whose age it does not give ("can
 * her brother come too?") makes the age unknown again, and so does a family
 * that counts more children than ages ("I have two kids, one is six"): asking
 * it is no repeat.
 */
export function childAgeSaidIn(lines: readonly string[]): string | null {
  let known: string[] = [];
  let siblings = 0;
  for (const line of lines) {
    const ages = agesStatedIn(line);
    siblings = Math.max(siblings, siblingsCountedIn(line));
    if (OTHER_CHILD.test(line.normalize('NFC'))) {
      known = ages.length >= 2 || (ages.length === 1 && known.length > 0) ? [...new Set([...known, ...ages])] : [];
    } else if (ages.length > 0) {
      known = [...new Set([...known, ...ages])];
    }
  }
  return known.length === 0 || known.length < siblings ? null : clip(known.join(', '));
}

/**
 * A question of the reply asks the age of ANOTHER child than the one the
 * customer told us about ("And how old is her brother?", "А сколько лет
 * старшему?"): no repeat of what was said — it is neither cut nor refused.
 */
export function asksAnotherChildsAge(bubbles: readonly string[]): boolean {
  return questionsIn(bubbles).some((q) => asksChildAge(q) && OTHER_CHILD_ASKED.test(q));
}

/** The text asks the child's age, in any of the three languages (the question detector's own words). */
export function asksChildAge(text: string): boolean {
  return ASKS.some(([slot, re]) => slot === 'child_age' && re.test(text));
}
