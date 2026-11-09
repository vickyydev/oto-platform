import { isoDateInTz } from './dates';

/**
 * THE PARTY'S DATE AND TIME AS A CHAT WRITES THEM (SCRUM-814).
 *
 * One reader for the three languages the parks' chats are written in — Thai,
 * English and Russian — used by the inbox's Book Date (the dialog's first date
 * and time) and by the api's choice of the confirmation message a BEO is
 * filled from (`carriesBirthdayDetails`), so the two never disagree on what a
 * date or a time is.
 *
 * Written for the way the chats are typed, not for ASCII: no `\b` (it never
 * matches beside a Cyrillic or a Thai letter), the Unicode flag everywhere,
 * and no lookbehind (the inbox runs it in the browser). It reads:
 *   - a day and a month name, in either order, with any separator or none:
 *     "15 ноября", "21-го ноября", "21 November", "Nov 21", "21st of Nov",
 *     "15 พ.ย.", "15 พฤศจิกายน", "21/nov", and a year after it when the text
 *     gives one (a Buddhist year, 2569, is its Common Era year, 2026);
 *   - a numeric day.month(.year): "15.11", "15/11/2026", and "2026-11-15";
 *   - a weekday, the next such day from today ("в субботу", "Saturday",
 *     "วันเสาร์"), strictly after today when the text says next ("next
 *     Saturday", "следующую субботу", "วันเสาร์หน้า"); a weekday and a day
 *     number ("Saturday 21st", "วันเสาร์ที่ 21") is the next 21st that is a
 *     Saturday;
 *   - today, tomorrow and the day after, in the three languages.
 * A date without a year is its next occurrence on or after today.
 *
 * WHEN A TEXT NAMES SEVERAL: a day the text names outright beats a weekday,
 * and a weekday beats "today / tomorrow" (those words are as often about a
 * transfer or a call as about the party); within one kind, the LAST one wins
 * (the latest confirmed version). A date written after a payment or a birth
 * ("депозит получен 9 ноября", "deposit paid on 9 Nov", "born 15 Nov 2020") is
 * not the party's, nor is a date whose own year is already past.
 *
 * What it does not do: decide between two dates a person must choose from.
 * The phrase it read is always returned beside the date, so the screen shows
 * the chat's own words and a person confirms them.
 */

/** The parks' zone: every branch is in Bangkok today; a caller with a branch passes its own. */
export const PARTY_DATE_TIME_ZONE = 'Asia/Bangkok';

export type PartyDateConfidence = 'exact' | 'weekday' | 'none';

export interface PartyDateReading {
  /** The calendar date, `YYYY-MM-DD`; null when the text names none. */
  date: string | null;
  /** The text's own words for it, as written ("15 ноября", "next Saturday"); empty when none. */
  phrase: string;
  /** `exact`: the text names the day; `weekday`: a weekday or "tomorrow", counted from today; `none`. */
  confidence: PartyDateConfidence;
}

export interface PartyTimeReading {
  /** `HH:MM`, 24-hour. */
  time: string;
  /** The text's own words for it ("в 14:00", "บ่าย 2 โมง", "2 pm"). */
  phrase: string;
}

// --- Calendar arithmetic, on plain dates ------------------------------------------------

interface Day {
  y: number;
  m: number;
  d: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const isoOf = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;

function realDate(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

function dayFromIso(iso: string): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return realDate(y, mo, d) ? { y, m: mo, d } : null;
}

const isoOfDay = (day: Day) => isoOf(day.y, day.m, day.d);

function plusDays(day: Day, n: number): string {
  return new Date(Date.UTC(day.y, day.m - 1, day.d + n)).toISOString().slice(0, 10);
}

const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** The next day/month on or after today (this year, else a later one: 29 February waits for a leap year). */
function nextOccurrence(today: Day, month: number, day: number): string | null {
  const from = isoOfDay(today);
  for (let y = today.y; y <= today.y + 4; y++) {
    if (!realDate(y, month, day)) continue;
    const candidate = isoOf(y, month, day);
    if (candidate >= from) return candidate;
  }
  return null;
}

/** The next such weekday: today or later, or (`strict`, "next Saturday") after today. */
function nextWeekday(today: Day, weekday: number, strict: boolean): string {
  let ahead = (weekday - weekdayOf(today.y, today.m, today.d) + 7) % 7;
  if (strict && ahead === 0) ahead = 7;
  return plusDays(today, ahead);
}

/** The next date on or after today that is this day of the month and this weekday ("Saturday 21st"). */
function nextWeekdayAndDay(today: Day, weekday: number, day: number): string | null {
  const from = isoOfDay(today);
  let y = today.y;
  let m = today.m;
  for (let i = 0; i < 28; i++) {
    if (realDate(y, m, day) && weekdayOf(y, m, day) === weekday && isoOf(y, m, day) >= from) return isoOf(y, m, day);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  // No such day for over two years: the day of the month alone.
  for (let j = 0; j < 13; j++) {
    const mm = ((today.m - 1 + j) % 12) + 1;
    const yy = today.y + Math.floor((today.m - 1 + j) / 12);
    if (realDate(yy, mm, day) && isoOf(yy, mm, day) >= from) return isoOf(yy, mm, day);
  }
  return null;
}

/** A four-digit year as written: Common Era (2026) or Buddhist era (2569 is 2026); else not a year. */
function fullYear(text: string): number | null {
  const n = Number(text);
  if (n >= 2443 && n <= 2643) return n - 543;
  if (n >= 1900 && n <= 2100) return n;
  return null;
}

/** A two-digit year ("15.11.26", "15.11.69"): the Common Era or the Buddhist year near today, else none. */
function shortYear(text: string, today: Day): number | null {
  const n = Number(text);
  for (const y of [2000 + n, 2500 + n - 543]) if (y >= today.y - 2 && y <= today.y + 5) return y;
  return null;
}

// --- The words ---------------------------------------------------------------------------

const THAI_LETTER = '[\\u0E00-\\u0E7F]';

/** Each month in the three languages: English names and short forms, Russian stems, Thai names and abbreviations. */
const MONTHS: ReadonlyArray<{ month: number; en: string; ru: string; th: string }> = [
  { month: 1, en: 'january|jan', ru: 'январ[ьяею]|янв', th: `มกราคม|ม\\.\\s?ค\\.?|มค(?!${THAI_LETTER})` },
  { month: 2, en: 'february|feb', ru: 'феврал[ьяею]|фев', th: `กุมภาพันธ์|ก\\.\\s?พ\\.?|กพ(?!${THAI_LETTER})` },
  { month: 3, en: 'march|mar', ru: 'март[аеу]?|мар', th: `มีนาคม|มี\\.\\s?ค\\.?|มีค(?!${THAI_LETTER})` },
  { month: 4, en: 'april|apr', ru: 'апрел[ьяею]|апр', th: `เมษายน|เม\\.\\s?ย\\.?|เมย(?!${THAI_LETTER})` },
  { month: 5, en: 'may', ru: 'ма[йяею]', th: `พฤษภาคม|พ\\.\\s?ค\\.?|พค(?!${THAI_LETTER})` },
  { month: 6, en: 'june|jun', ru: 'июн[ьяею]|июн', th: `มิถุนายน|มิ\\.\\s?ย\\.?|มิย(?!${THAI_LETTER})` },
  { month: 7, en: 'july|jul', ru: 'июл[ьяею]|июл', th: `กรกฎาคม|ก\\.\\s?ค\\.?|กค(?!${THAI_LETTER})` },
  { month: 8, en: 'august|aug', ru: 'август[аеу]?|авг', th: `สิงหาคม|ส\\.\\s?ค\\.?|สค(?!${THAI_LETTER})` },
  { month: 9, en: 'september|sept|sep', ru: 'сентябр[ьяею]|сент|сен', th: `กันยายน|ก\\.\\s?ย\\.?|กย(?!${THAI_LETTER})` },
  { month: 10, en: 'october|oct', ru: 'октябр[ьяею]|окт', th: `ตุลาคม|ต\\.\\s?ค\\.?|ตค(?!${THAI_LETTER})` },
  { month: 11, en: 'november|nov', ru: 'ноябр[ьяею]|нояб|ноя', th: `พฤศจิกายน|พ\\.\\s?ย\\.?|พย(?!${THAI_LETTER})` },
  { month: 12, en: 'december|dec', ru: 'декабр[ьяею]|дек', th: `ธันวาคม|ธ\\.\\s?ค\\.?|ธค(?!${THAI_LETTER})` },
];

const EN_MONTHS = MONTHS.map((m) => m.en).join('|');
const RU_MONTHS = MONTHS.map((m) => m.ru).join('|');
const TH_MONTHS = MONTHS.map((m) => m.th).join('|');
/** A month word: English and Russian end at a letter; Thai is written without spaces, so it may run on. */
const MONTH = `(?:(?:${EN_MONTHS})\\.?(?!\\p{L})|(?:${RU_MONTHS})\\.?(?!\\p{L})|(?:${TH_MONTHS}))`;
const MONTH_EN_RU = `(?:(?:${EN_MONTHS})\\.?(?!\\p{L})|(?:${RU_MONTHS})\\.?(?!\\p{L}))`;

const MONTH_OF = MONTHS.map((m) => ({ month: m.month, re: new RegExp(`^(?:${m.en}|${m.ru}|${m.th})\\.?$`, 'iu') }));
function monthOf(word: string): number | null {
  const w = word.trim();
  return MONTH_OF.find((m) => m.re.test(w))?.month ?? null;
}

/** A count or a measure after a number: "15 kids", "2 pm", "3 часа" — the number is not a day. */
const UNIT_AFTER = new RegExp(
  '^\\s*(?:kids?|children|child|guests?|adults?|people|pax|persons?|years?|yrs?|hours?|hrs?|kg|%|baht|thb|฿|' +
    'a\\.?m\\.?|p\\.?m\\.?|o\'?clock|' +
    'дет\\p{L}*|ребен\\p{L}*|взросл\\p{L}*|гост\\p{L}*|человек\\p{L}*|лет|год\\p{L}*|час\\p{L}*|ч\\.|кг|бат\\p{L}*|руб\\p{L}*|' +
    'เด็ก|คน|ผู้ใหญ่|ท่าน|ปี|ขวบ|ชั่วโมง|ชม|โมง|ทุ่ม|นาฬิกา|น\\.|บาท|กก)',
  'iu',
);

/**
 * Words that make a date not the party's: a payment, a transfer, a birth. Not
 * "received" alone: "we received your request for 21 November" names the party.
 */
const NOT_THE_PARTY = new RegExp(
  '(?:^|[^\\p{L}])(?:deposit|prepa(?:id|y)|pa(?:id|y)|transfer|invoice|receipt|born|birth ?date|date of birth|dob)|' +
    'депозит|предоплат|оплат|перев[её]л|перевод|внес[её]н|внесл|чек|родил|дата рождения|' +
    'มัดจำ|โอน|ชำระ|จ่าย|ใบเสร็จ|เกิดวันที่|เกิดเมื่อ',
  'iu',
);

const EN_WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const RU_WEEKDAY_STEMS: Array<[string, number]> = [
  ['понедельник', 1],
  ['вторник', 2],
  ['сред', 3],
  ['четверг', 4],
  ['пятниц', 5],
  ['суббот', 6],
  ['воскресень', 0],
];
const TH_WEEKDAYS: Record<string, number> = {
  อาทิตย์: 0,
  จันทร์: 1,
  อังคาร: 2,
  พุธ: 3,
  พฤหัส: 4,
  พฤหัสบดี: 4,
  ศุกร์: 5,
  เสาร์: 6,
};
/** Thai weekday names that are a weekday even without "วัน" ("เสาร์ 21"). */
const TH_BARE_WEEKDAYS = new Set(['เสาร์', 'ศุกร์', 'พฤหัส', 'พฤหัสบดี']);

// The patterns. Global, Unicode, case-insensitive; boundaries before a match are checked in code.
const DAY_MONTH = new RegExp(
  `(\\d{1,2})(?:\\s*(?:st|nd|rd|th)(?!\\p{L})|\\s*-?\\s*(?:го|ого|ое|е)(?!\\p{L}))?(?:\\s*of(?!\\p{L}))?[\\s./-]*(${MONTH})`,
  'giu',
);
const MONTH_DAY = new RegExp(
  `(${MONTH_EN_RU})[\\s,.]*(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th|-?го|-?е)?(?!\\p{L})(?!\\d|[:.]\\d)`,
  'giu',
);
const NUMERIC = /(\d{1,2})([./-])(\d{1,2})(?:\2(\d{4}|\d{2}))?(?!\d)/gu;
const ISO = /(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/gu;
const EN_WEEKDAY = /(?:(this\s+coming|this|next|coming)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?(?!\p{L})/giu;
const RU_WEEKDAY =
  /(?:(во|в|на)\s+)?(?:(следующ\p{L}*|эт\p{L}*|ближайш\p{L}*)\s+)?(понедельник\p{L}*|вторник\p{L}*|сред[аеуы]|четверг\p{L}*|пятниц\p{L}*|суббот\p{L}*|воскресень\p{L}*)(?!\p{L})/giu;
const TH_WEEKDAY = /(วัน)?(จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์)(?:\s*(หน้า|นี้|ที่จะถึง))?/gu;
const EN_RU_RELATIVE = /(day\s+after\s+tomorrow|tomorrow|today|tonight|послезавтра|завтра|сегодня)(?!\p{L})/giu;
const TH_RELATIVE = /(มะรืนนี้|มะรืน|พรุ่งนี้|วันนี้|คืนนี้)/gu;
/** Right after a weekday: the day of the month ("Saturday 21st", "วันเสาร์ที่ 21", "субботу 21-го"). */
const WEEKDAY_DAY = /[\s,]*(?:the\s+|ที่\s*)?(\d{1,2})(?:st|nd|rd|th|-?го|-?е)?(?!\d)/iuy;
/** A month right after a day: the day and month are read by DAY_MONTH, not as a weekday's day. */
const MONTH_NEXT = new RegExp(`^(?:st|nd|rd|th|-?го|-?е)?(?:\\s*of)?[\\s./-]*${MONTH}`, 'iu');
/** A year right after a day and month ("21 March 2027", "15 พ.ย. 2569", "15 พ.ย. พ.ศ. 2569"). */
const YEAR_AFTER = /[\s,./-]*(?:(?:พ\.?\s?ศ\.?|ค\.?\s?ศ\.?)\s*)?(\d{4})(?!\d)/uy;
/** What sits between a weekday and the day it names ("Saturday, the 21st", "วันเสาร์ที่ 21"). */
const WEEKDAY_GAP = /^[\s,]*(?:the\s+|ที่\s*)?$/iu;
/** Before a dotted number: a word that makes it a clock time ("в 14.10", "at 15.10"). */
const TIME_WORD_BEFORE = /(?:^|[^\p{L}])(?:в|во|с|до|около|at|from|to|till|until|by|around|เวลา|ตั้งแต่|ถึง)\s*$/iu;
/** After a dotted number: a clock-time marker or a time range ("14.10 น.", "14.10-16.10"). */
const TIME_MARK_AFTER = /^(?:\s*(?:น\.?|นาฬิกา|ч\.?|час\p{L}*|hrs?|h)(?!\p{L})|\s*[-–—]\s*\d{1,2}[.:]\d{2})/iu;
const TIME_RANGE_BEFORE = /\d{1,2}[.:]\d{2}\s*[-–—]\s*$/u;

const LETTER = /\p{L}/u;
const isLetter = (c: string | undefined) => c !== undefined && LETTER.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** A number starts here: no digit before it, nor a number's separator after a digit ("081-234", "12.5"). */
function numberStartsAt(text: string, i: number): boolean {
  const p = text[i - 1];
  if (isDigit(p)) return false;
  if (p !== undefined && '.:/-,'.includes(p) && isDigit(text[i - 2])) return false;
  return true;
}

// --- Scanning a text ---------------------------------------------------------------------

type Tier = 1 | 2 | 3;
/** 3: the day itself; 2: a weekday; 1: today / tomorrow. */
const CONFIDENCE: Record<Tier, PartyDateConfidence> = { 3: 'exact', 2: 'weekday', 1: 'weekday' };

interface Found {
  start: number;
  end: number;
  tier: Tier;
  /** The text gave the year: a date before today is no party date. */
  yearGiven: boolean;
  resolve: (today: Day) => string | null;
}

/** Each match of `re`; `accept` answers a candidate or null (the scan then retries one character on). */
function scan(re: RegExp, text: string, accept: (m: RegExpExecArray) => Found | null): Found[] {
  const out: Found[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const f = accept(m);
    if (f) {
      out.push(f);
      re.lastIndex = Math.max(f.end, m.index + 1);
    } else {
      re.lastIndex = m.index + 1;
    }
  }
  return out;
}

/** Thai digits as ASCII, one for one, so every index stays the text's own. */
const asciiDigits = (text: string) => text.replace(/[๐-๙]/gu, (c) => String(c.charCodeAt(0) - 0x0e50));

/** The year after a day and month, when there is a real one there; else nothing (the number is something else). */
function yearAt(text: string, at: number): { year: number; end: number } | null {
  YEAR_AFTER.lastIndex = at;
  const y = YEAR_AFTER.exec(text);
  if (!y) return null;
  const year = fullYear(y[1]!);
  return year === null ? null : { year, end: at + y[0].length };
}

/** "may" typed in lower case and followed by a word is the verb ("15 may we come"), not May. */
function mayTheVerb(word: string, after: string): boolean {
  return word === 'may' && /^\s+\p{L}/u.test(after);
}

function dayMonth(text: string): Found[] {
  return scan(DAY_MONTH, text, (m) => {
    if (!numberStartsAt(text, m.index)) return null;
    const day = Number(m[1]);
    const month = monthOf(m[2]!);
    if (!month || day < 1 || day > 31) return null;
    let end = m.index + m[0].length;
    if (mayTheVerb(m[2]!, text.slice(end))) return null;
    const year = yearAt(text, end);
    if (year) end = year.end;
    return {
      start: m.index,
      end,
      tier: 3,
      yearGiven: year !== null,
      resolve: (today) => (year ? (realDate(year.year, month, day) ? isoOf(year.year, month, day) : null) : nextOccurrence(today, month, day)),
    };
  });
}

function monthDay(text: string): Found[] {
  return scan(MONTH_DAY, text, (m) => {
    if (isLetter(text[m.index - 1])) return null;
    const word = m[1]!.replace(/\.$/u, '');
    if (word === 'may') return null; // "may 2 adults come" — the verb
    const month = monthOf(word);
    const day = Number(m[2]);
    if (!month || day < 1 || day > 31) return null;
    let end = m.index + m[0].length;
    if (UNIT_AFTER.test(text.slice(end))) return null;
    const year = yearAt(text, end);
    if (year) end = year.end;
    return {
      start: m.index,
      end,
      tier: 3,
      yearGiven: year !== null,
      resolve: (today) => (year ? (realDate(year.year, month, day) ? isoOf(year.year, month, day) : null) : nextOccurrence(today, month, day)),
    };
  });
}

function numeric(text: string): Found[] {
  return scan(NUMERIC, text, (m) => {
    if (!numberStartsAt(text, m.index)) return null;
    const day = Number(m[1]);
    const sep = m[2]!;
    const monthText = m[3]!;
    const month = Number(monthText);
    const yearText = m[4];
    const end = m.index + m[0].length;
    const after = text.slice(end);
    if (day < 1 || day > 31 || month < 1 || month > 12) return null;
    // Part of a longer number: "1.2.3", "14:10", "15.11.2026.".
    if (/^(?:[:.,/-]\d)/u.test(after)) return null;
    // "5-6 kids" is a range, "1.5 hours" a measure: a dash needs the year, a dot two month digits.
    if (sep === '-' && !yearText) return null;
    if (sep === '.' && !yearText && monthText.length < 2) return null;
    // "1/2" is a half.
    if (sep === '/' && !yearText && ['1/2', '1/3', '1/4', '2/3', '3/4'].includes(`${day}/${month}`)) return null;
    if (UNIT_AFTER.test(after)) return null;
    // A clock time written with a dot: "в 14.10", "14.10 น.", "14.10-16.10".
    if (!yearText && sep === '.' && day <= 23) {
      const before = text.slice(Math.max(0, m.index - 16), m.index);
      if (TIME_WORD_BEFORE.test(before) || TIME_MARK_AFTER.test(after) || TIME_RANGE_BEFORE.test(before)) return null;
    }
    return {
      start: m.index,
      end,
      tier: 3,
      yearGiven: !!yearText,
      resolve: (today) => {
        if (!yearText) return nextOccurrence(today, month, day);
        const year = yearText.length === 4 ? fullYear(yearText) : shortYear(yearText, today);
        return year !== null && realDate(year, month, day) ? isoOf(year, month, day) : null;
      },
    };
  });
}

function isoDates(text: string): Found[] {
  return scan(ISO, text, (m) => {
    if (!numberStartsAt(text, m.index)) return null;
    const year = fullYear(m[1]!);
    const month = Number(m[3]);
    const day = Number(m[4]);
    if (year === null || !realDate(year, month, day)) return null;
    return { start: m.index, end: m.index + m[0].length, tier: 3, yearGiven: true, resolve: () => isoOf(year, month, day) };
  });
}

/** A weekday found, and the day of the month written right after it when there is one. */
function weekdayFound(text: string, start: number, end: number, weekday: number, strict: boolean): Found {
  WEEKDAY_DAY.lastIndex = end;
  const dm = WEEKDAY_DAY.exec(text);
  if (dm) {
    const day = Number(dm[1]);
    const dayEnd = end + dm[0].length;
    const after = text.slice(dayEnd);
    const tail = text.slice(end + dm[0].search(/\d/u) + dm[1]!.length);
    // Not a clock time ("Saturday 14:00"), a count ("в субботу 15 детей"), a month's day
    // ("Saturday 21 March", read by DAY_MONTH) or a numeric date ("Saturday 21/11").
    if (day >= 1 && day <= 31 && !/^[:./-]\d/u.test(after) && !UNIT_AFTER.test(after) && !MONTH_NEXT.test(tail)) {
      return { start, end: dayEnd, tier: 3, yearGiven: false, resolve: (today) => nextWeekdayAndDay(today, weekday, day) };
    }
  }
  return { start, end, tier: 2, yearGiven: false, resolve: (today) => nextWeekday(today, weekday, strict) };
}

function weekdays(text: string): Found[] {
  const en = scan(EN_WEEKDAY, text, (m) => {
    if (isLetter(text[m.index - 1])) return null;
    const weekday = EN_WEEKDAYS[m[2]!.toLowerCase()];
    if (weekday === undefined) return null;
    return weekdayFound(text, m.index, m.index + m[0].length, weekday, /^next$/iu.test(m[1] ?? ''));
  });
  const ru = scan(RU_WEEKDAY, text, (m) => {
    if (isLetter(text[m.index - 1])) return null;
    const word = m[3]!.toLowerCase();
    const weekday = RU_WEEKDAY_STEMS.find(([stem]) => word.startsWith(stem))?.[1];
    if (weekday === undefined) return null;
    return weekdayFound(text, m.index, m.index + m[0].length, weekday, /^следующ/iu.test(m[2] ?? ''));
  });
  const th = scan(TH_WEEKDAY, text, (m) => {
    const name = m[2]!;
    // "อาทิตย์" alone is a week ("อาทิตย์หน้า", next week); Sunday is "วันอาทิตย์". The
    // moon, Mars and Mercury ("จันทร์", "อังคาร", "พุธ") are a weekday only as "วัน…" or "…หน้า/นี้".
    if (name === 'อาทิตย์' && !m[1]) return null;
    if (!m[1] && !m[3] && !TH_BARE_WEEKDAYS.has(name)) return null;
    const weekday = TH_WEEKDAYS[name];
    if (weekday === undefined) return null;
    return weekdayFound(text, m.index, m.index + m[0].length, weekday, m[3] === 'หน้า');
  });
  return [...en, ...ru, ...th];
}

function relatives(text: string): Found[] {
  const offset = (word: string) => {
    const w = word.toLowerCase().replace(/\s+/gu, ' ');
    if (w === 'day after tomorrow' || w === 'послезавтра' || w.startsWith('มะรืน')) return 2;
    if (w === 'tomorrow' || w === 'завтра' || w === 'พรุ่งนี้') return 1;
    return 0;
  };
  const found = (m: RegExpExecArray): Found => {
    const n = offset(m[1]!);
    return { start: m.index, end: m.index + m[0].length, tier: 1, yearGiven: false, resolve: (today) => plusDays(today, n) };
  };
  return [
    ...scan(EN_RU_RELATIVE, text, (m) => (isLetter(text[m.index - 1]) ? null : found(m))),
    ...scan(TH_RELATIVE, text, found),
  ];
}

/** Every date the text names, in order, overlaps resolved (the earlier, then the longer, stands). */
function datesIn(text: string): Array<Found & { phraseStart: number }> {
  const all = [...isoDates(text), ...numeric(text), ...dayMonth(text), ...monthDay(text), ...weekdays(text), ...relatives(text)].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const kept: Found[] = [];
  for (const f of all) {
    const last = kept[kept.length - 1];
    if (last && f.start < last.end) continue;
    kept.push(f);
  }
  // A weekday right before the day it names is part of the phrase: "Saturday 21 March", "в субботу 21 марта".
  return kept.map((f, i) => {
    const prev = kept[i - 1];
    const joins = f.tier === 3 && prev && prev.tier === 2 && WEEKDAY_GAP.test(text.slice(prev.end, f.start));
    return { ...f, phraseStart: joins ? prev.start : f.start };
  });
}

function prepared(text: string): { original: string; scan: string } {
  const original = (text ?? '').normalize('NFC');
  return { original, scan: asciiDigits(original) };
}

function todayDay(today: string | Date, timeZone: string): Day | null {
  return dayFromIso(today instanceof Date ? isoDateInTz(today, timeZone) : today);
}

interface Best {
  date: string;
  phrase: string;
  tier: Tier;
  at: number;
}

/** The party's date in one text, with its kind; null when it names none. */
function bestDate(text: string, today: Day): Best | null {
  const { original, scan: t } = prepared(text);
  const from = isoOfDay(today);
  let best: Best | null = null;
  for (const f of datesIn(t)) {
    if (notThePartysAt(t, f.phraseStart)) continue;
    const date = f.resolve(today);
    if (!date || (f.yearGiven && date < from)) continue;
    if (!best || f.tier > best.tier || (f.tier === best.tier && f.start >= best.at)) {
      best = { date, phrase: original.slice(f.phraseStart, f.end).trim(), tier: f.tier, at: f.start };
    }
  }
  return best;
}

/** The clause before a date names a payment or a birth: "депозит получен 9 ноября". */
function notThePartysAt(text: string, start: number): boolean {
  const before = text.slice(Math.max(0, start - 48), start);
  const cut = Math.max(before.search(/[,;!?\n][^,;!?\n]*$/u), before.search(/\.\s[^.]*$/u));
  return NOT_THE_PARTY.test(cut >= 0 ? before.slice(cut + 1) : before);
}

/**
 * The party's date one text names, counted from `today` (the park's day,
 * `YYYY-MM-DD`, or an instant read in `timeZone`), with the text's own words
 * for it. `{ date: null, phrase: '', confidence: 'none' }` when it names none.
 */
export function readPartyDate(text: string, today: string | Date = new Date(), timeZone: string = PARTY_DATE_TIME_ZONE): PartyDateReading {
  const day = todayDay(today, timeZone);
  const best = day ? bestDate(text, day) : null;
  return best ? { date: best.date, phrase: best.phrase, confidence: CONFIDENCE[best.tier] } : { date: null, phrase: '', confidence: 'none' };
}

/**
 * Does the text name a day — a date or a weekday (not "today" or "tomorrow")?
 * Read without a "today": the confirmation message the BEO is filled from is
 * one that names the party's day (`carriesBirthdayDetails`, api).
 */
export function mentionsPartyDate(text: string): boolean {
  return datesIn(prepared(text).scan).some((f) => f.tier >= 2);
}

// --- The time ----------------------------------------------------------------------------

const TH_NUMBER: Record<string, number> = { หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6 };
const hourOf = (word: string) => TH_NUMBER[word] ?? Number(word);
const clock = (h: number, m: number) => (h >= 0 && h <= 23 && m >= 0 && m <= 59 ? `${pad(h)}:${pad(m)}` : null);

interface TimeFound {
  start: number;
  end: number;
  time: string;
}

/** Each pattern, and the clock time its match names (null: not a time after all). */
const TIME_PATTERNS: Array<{ re: RegExp; read: (m: RegExpExecArray) => string | null; numberAt?: (m: RegExpExecArray) => number }> = [
  // 14:00, at 14:00, в 14:00, 2:30 pm, 14:00 น.
  {
    re: /(?:(at|в|во|с|from|around|около|เวลา)\s*)?(\d{1,2}):(\d{2})(?!\d)(?:\s*(a\.?m\.?|p\.?m\.?)(?!\p{L}))?(?:\s*น\.?)?/giu,
    read: (m) => twelveHour(Number(m[2]), Number(m[3]), m[4]),
    numberAt: (m) => m.index + m[0].indexOf(m[2]!),
  },
  // 2pm, 2 p.m., 2.30 pm
  {
    re: /(\d{1,2})(?:[.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?!\p{L})/giu,
    read: (m) => twelveHour(Number(m[1]), Number(m[2] ?? 0), m[3]),
  },
  // 14.00 น., 14.00 นาฬิกา
  { re: /(\d{1,2})[.:](\d{2})\s*(?:น\.?|นาฬิกา)/gu, read: (m) => clock(Number(m[1]), Number(m[2])) },
  // เวลา 14.00, в 14.00, at 14.30
  {
    re: /(เวลา|в|во|с|at|from|around|около)\s*(\d{1,2})\.(\d{2})(?!\d|[.:/]\d)/giu,
    read: (m) => clock(Number(m[2]), Number(m[3])),
    numberAt: (m) => m.index + m[0].indexOf(m[2]!),
  },
  // 14 часов, в 2 часа дня, в 5 ч.
  {
    re: /(?:(в|во|к|с)\s+)?(\d{1,2})\s*(?:час(?:а|ов)?(?!\p{L})|ч\.?(?!\p{L}))(?:\s*(дня|вечера|утра|ночи)(?!\p{L}))?/giu,
    read: (m) => russianHour(Number(m[2]), m[3]),
    numberAt: (m) => m.index + m[0].indexOf(m[2]!),
  },
  // в 2 дня, к 5 вечера
  {
    re: /(в|во|к|с)\s+(\d{1,2})\s+(дня|вечера|утра|ночи)(?!\p{L})/giu,
    read: (m) => russianHour(Number(m[2]), m[3]),
    numberAt: (m) => m.index + m[0].indexOf(m[2]!),
  },
  // บ่าย 2 โมง, บ่ายสองโมง, บ่ายโมง, บ่าย 2 โมงครึ่ง
  {
    re: /บ่าย\s*(\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า|หก)?\s*(โมง)?(\s*ครึ่ง)?/gu,
    read: (m) => {
      if (!m[1] && !m[2]) return null;
      const h = m[1] ? hourOf(m[1]) : 1;
      return h >= 1 && h <= 6 ? clock(12 + h, m[3] ? 30 : 0) : null;
    },
  },
  // 4 โมงเย็น, สี่โมงเย็น, 10 โมงเช้า
  {
    re: /(\d{1,2}|หนึ่ง|สอง|สาม|สี่|ห้า|หก)\s*โมง\s*(ครึ่ง\s*)?(เย็น|เช้า)/gu,
    read: (m) => {
      const h = hourOf(m[1]!);
      const minutes = m[2] ? 30 : 0;
      if (m[3] === 'เย็น') return h >= 1 && h <= 6 ? clock(12 + h, minutes) : null;
      return h >= 5 && h <= 12 ? clock(h, minutes) : null;
    },
  },
  // 1 ทุ่ม … 5 ทุ่ม (19:00 … 23:00)
  {
    re: /(\d|หนึ่ง|สอง|สาม|สี่|ห้า)\s*ทุ่ม(\s*ครึ่ง)?/gu,
    read: (m) => {
      const h = hourOf(m[1]!);
      return h >= 1 && h <= 5 ? clock(18 + h, m[2] ? 30 : 0) : null;
    },
  },
  // 14 นาฬิกา
  { re: /(\d{1,2})\s*นาฬิกา/gu, read: (m) => clock(Number(m[1]), 0) },
  // 2 โมง, 10 โมง (a bare hour: 1-6 is the afternoon, 7-12 the morning)
  {
    re: /(\d{1,2})\s*โมง(\s*ครึ่ง)?(?!\s*(?:เย็น|เช้า))/gu,
    read: (m) => {
      const h = Number(m[1]);
      const minutes = m[2] ? 30 : 0;
      if (h >= 1 && h <= 6) return clock(12 + h, minutes);
      return h >= 7 && h <= 12 ? clock(h, minutes) : null;
    },
  },
  // เที่ยง, noon, midday
  { re: /เที่ยง(?:วัน|ตรง)?/gu, read: () => '12:00' },
  { re: /(?:at\s+)?(?:noon|midday)(?!\p{L})/giu, read: (m) => (m.index > 0 && isLetter(m.input[m.index - 1]) ? null : '12:00') },
];

function twelveHour(h: number, m: number, ampm: string | undefined): string | null {
  if (!ampm) return clock(h, m);
  if (h < 1 || h > 12) return null;
  const pm = /^p/iu.test(ampm);
  return clock((h % 12) + (pm ? 12 : 0), m);
}

/** A Russian hour: "дня"/"вечера" is the afternoon or evening; a bare 1-7 o'clock is too (no party starts at 3 am). */
function russianHour(h: number, part: string | undefined): string | null {
  const p = (part ?? '').toLowerCase();
  if (p === 'дня' || p === 'вечера') return h >= 1 && h <= 11 ? clock(h + 12, 0) : h === 12 ? '12:00' : null;
  if (p === 'утра') return h >= 1 && h <= 11 ? clock(h, 0) : null;
  if (p === 'ночи') return h === 12 ? '00:00' : h >= 1 && h <= 5 ? clock(h, 0) : null;
  if (h >= 1 && h <= 7) return clock(h + 12, 0);
  return clock(h, 0);
}

/**
 * The first clock time a text names, with its own words: "14:00", "2 pm",
 * "14.00 น.", "в 14:00", "14 часов", "บ่าย 2 โมง". The first is the start: a
 * message gives the start before the end and the cake.
 */
export function readPartyTimePhrase(text: string): PartyTimeReading | null {
  const { original, scan: t } = prepared(text);
  let best: TimeFound | null = null;
  for (const { re, read, numberAt } of TIME_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const at = re.lastIndex;
      const digits = numberAt ? numberAt(m) : m.index;
      const time = numberStartsAt(t, digits) || !isDigit(t[digits]) ? read(m) : null;
      if (time) {
        // A prefix word glued to a word before it ("that 14:00") is not the prefix: start at the number.
        const start = m.index < digits && isLetter(t[m.index - 1]) ? digits : m.index;
        const end = m.index + m[0].length;
        if (!best || start < best.start || (start === best.start && end > best.end)) best = { start, end, time };
      }
      re.lastIndex = at > m.index ? at : m.index + 1;
    }
  }
  return best ? { time: best.time, phrase: original.slice(best.start, best.end).trim() } : null;
}

/** The first clock time a text names, `HH:MM`, or null. */
export function readPartyTime(text: string): string | null {
  return readPartyTimePhrase(text)?.time ?? null;
}

/** Does the text name a clock time? (`carriesBirthdayDetails`, api.) */
export function mentionsPartyTime(text: string): boolean {
  return readPartyTimePhrase(text) !== null;
}

// --- A whole chat ------------------------------------------------------------------------

export interface PartyChatLine {
  text: string;
  /** Written by a person on the team (not the customer, the assistant or a system notice). */
  team: boolean;
}

export interface PartyChatReading extends PartyDateReading {
  /** Whose line the date came from. */
  by: 'team' | 'customer' | null;
  /** The index of that line. */
  line: number | null;
  /** The party's start, `HH:MM`, or null when the chat names none. */
  time: string | null;
  /** The chat's own words for the time; empty when none. */
  timePhrase: string;
}

/**
 * The party's date and time in a whole chat, its lines in order. A day named
 * outright beats a weekday wherever it is; then a team line's date beats a
 * customer's (the team confirms what the customer asked); then the later line
 * wins. The time is the one written with that date, else the team's latest,
 * else the customer's latest.
 */
export function readChatPartyDate(
  lines: readonly PartyChatLine[],
  today: string | Date = new Date(),
  timeZone: string = PARTY_DATE_TIME_ZONE,
): PartyChatReading {
  const day = todayDay(today, timeZone);
  let chosen: { line: number; team: boolean; found: Best } | null = null;
  for (let i = 0; day && i < lines.length; i++) {
    const l = lines[i]!;
    const found = bestDate(l.text, day);
    if (!found) continue;
    const better =
      !chosen ||
      found.tier > chosen.found.tier ||
      (found.tier === chosen.found.tier && l.team && !chosen.team) ||
      (found.tier === chosen.found.tier && l.team === chosen.team);
    if (better) chosen = { line: i, team: l.team, found };
  }
  let time: PartyTimeReading | null = chosen ? readPartyTimePhrase(lines[chosen.line]!.text) : null;
  for (const team of [true, false]) {
    for (let i = lines.length - 1; i >= 0 && !time; i--) if (lines[i]!.team === team) time = readPartyTimePhrase(lines[i]!.text);
  }
  return {
    date: chosen?.found.date ?? null,
    phrase: chosen?.found.phrase ?? '',
    confidence: chosen ? CONFIDENCE[chosen.found.tier] : 'none',
    by: chosen ? (chosen.team ? 'team' : 'customer') : null,
    line: chosen?.line ?? null,
    time: time?.time ?? null,
    timePhrase: time?.phrase ?? '',
  };
}
