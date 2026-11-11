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
 *   - a day of the month without its month ("the 21st", "on 21st", "15-го",
 *     "15 числа", "วันที่ 15"): the next such day on or after today;
 *   - today, tomorrow and the day after, in the three languages.
 * A date without a year is its next occurrence on or after today.
 *
 * WHEN A TEXT NAMES SEVERAL: a day the text names outright beats a day of the
 * month without its month, that beats a weekday, and a weekday beats "today /
 * tomorrow" (those words are as often about a
 * transfer or a call as about the party); within one kind, the LAST one wins
 * (the latest confirmed version). A date written after a payment or a birth
 * ("депозит получен 9 ноября", "Deposit of 1,500 baht received on 9 November",
 * "born 15 Nov 2020") is not the party's, nor is a date whose own year is
 * already past. A price after a day and month is not its year ("21 พ.ย. 2590
 * บาท").
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
  /** `exact`: the text names the day; `weekday`: counted from today (a weekday, a day of the month alone, "tomorrow"); `none`. */
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
  return nextDayOfMonth(today, day);
}

/** The next date on or after today that is this day of the month ("the 21st", "15-го", "วันที่ 15"). */
function nextDayOfMonth(today: Day, day: number): string | null {
  const from = isoOfDay(today);
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
    'депозит|предоплат|оплат|оплач|перев[её]л|перевод|внес[её]н|внесл|чек|родил|дата рождения|' +
    'มัดจำ|โอน|ชำระ|จ่าย|ใบเสร็จ|เกิดวันที่|เกิดเมื่อ',
  'iu',
);
/** "Received" before a date is a payment's when a payment is named just before it ("Deposit 1,500 baht, received 9 Nov"). */
const RECEIVED = /получен|получил|(?:^|[^\p{L}])received(?!\p{L})|ได้รับ/iu;
const A_PAYMENT = /депозит|предоплат|оплат|оплач|(?:^|[^\p{L}])(?:deposit|prepa(?:id|y)|payment)|มัดจำ/iu;
/** Where a clause ends: a full stop, a question, a line; a comma, but not the one inside "1,500". */
const CLAUSE_END = /[;!?\n]|,(?!\d)|\.\s/gu;
/** A price right after a number: it is no year ("21 Nov 2050 baht", "21 พ.ย. 2500.-"). */
const PRICE_AFTER = /^\s*(?:[.,]-|baht|thb|฿|บาท|бат\p{L}*|руб\p{L}*|р\.?(?!\p{L}))/iu;

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
/** A day of the month without its month: "the 21st" (or "on 21st"), "15-го", "15 числа", "วันที่ 15". */
const EN_ORDINAL_DAY = /(the\s+)?(\d{1,2})(?:st|nd|rd|th)(?!\p{L})/giu;
const RU_ORDINAL_DAY = /(\d{1,2})(?:\s*-?\s*(?:го|ого)(?:\s+числа)?(?!\p{L})|(?:\s*-?\s*е)?\s+числ[ао](?!\p{L}))/giu;
const TH_DAY = /วันที่\s*(\d{1,2})(?!\d)/gu;
/** "on" right before "21st". */
const ON_BEFORE = /(?:^|[^\p{L}])on\s+$/iu;
/** A month after the day: the day and month are read whole ("the 21st of Nov", "15-го ноября", "วันที่ 15 พ.ย."). */
const MONTH_AFTER = new RegExp(`^(?:\\s*of)?[\\s./-]*${MONTH}`, 'iu');
/** An ordinal that counts something else: "her 5th birthday", "the 2nd floor", "5-го класса". */
const NOT_A_DAY_AFTER =
  /^\s*(?:(?:birthday|b-?day|anniversary|years?|grade|class|floor|times?|place|row|table|option|package|one|menu|room|zone|day|week|month|hours?|of\s+(?:them|us|you))(?!\p{L})|класс|мест|этаж|раз|рожден|годовщ|пакет|вариант)/iu;
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

/** How sure a date is, the surest first: a stronger one beats a weaker one wherever it is written. */
const EXACT = 4; // the day itself: "21 ноября", "15.11", "Saturday 21st"
const DAY_ONLY = 3; // a day of the month without its month: "the 21st", "15-го", "วันที่ 15"
const WEEKDAY = 2; // a weekday: "в субботу", "next Saturday", "วันเสาร์หน้า"
const RELATIVE = 1; // today, tomorrow, the day after
type Tier = typeof EXACT | typeof DAY_ONLY | typeof WEEKDAY | typeof RELATIVE;
const CONFIDENCE: Record<Tier, PartyDateConfidence> = { 4: 'exact', 3: 'weekday', 2: 'weekday', 1: 'weekday' };

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

/**
 * The year after a day and month, when there is a real one there; else nothing
 * (the number is something else, and the day and month stand without a year).
 * Not a price ("21 พ.ย. 2590 บาท", "21 ноября, 2000 бат"), nor a year more than
 * three years after today ("21 Nov 2050 for the package"). A past year stays a
 * year: "15 Nov 2020" is a day that has gone, not this year's 15 November.
 */
function yearAt(text: string, at: number, today: Day | null): { year: number; end: number } | null {
  YEAR_AFTER.lastIndex = at;
  const y = YEAR_AFTER.exec(text);
  if (!y) return null;
  const end = at + y[0].length;
  if (PRICE_AFTER.test(text.slice(end))) return null;
  const year = fullYear(y[1]!);
  if (year === null || (today && year > today.y + 3)) return null;
  return { year, end };
}

/** "may" typed in lower case and followed by a word is the verb ("15 may we come"), not May. */
function mayTheVerb(word: string, after: string): boolean {
  return word === 'may' && /^\s+\p{L}/u.test(after);
}

function dayMonth(text: string, today: Day | null): Found[] {
  return scan(DAY_MONTH, text, (m) => {
    if (!numberStartsAt(text, m.index)) return null;
    const day = Number(m[1]);
    const month = monthOf(m[2]!);
    if (!month || day < 1 || day > 31) return null;
    let end = m.index + m[0].length;
    if (mayTheVerb(m[2]!, text.slice(end))) return null;
    const year = yearAt(text, end, today);
    if (year) end = year.end;
    return {
      start: m.index,
      end,
      tier: EXACT,
      yearGiven: year !== null,
      resolve: (today) => (year ? (realDate(year.year, month, day) ? isoOf(year.year, month, day) : null) : nextOccurrence(today, month, day)),
    };
  });
}

function monthDay(text: string, today: Day | null): Found[] {
  return scan(MONTH_DAY, text, (m) => {
    if (isLetter(text[m.index - 1])) return null;
    const word = m[1]!.replace(/\.$/u, '');
    if (word === 'may') return null; // "may 2 adults come" — the verb
    const month = monthOf(word);
    const day = Number(m[2]);
    if (!month || day < 1 || day > 31) return null;
    let end = m.index + m[0].length;
    if (UNIT_AFTER.test(text.slice(end))) return null;
    const year = yearAt(text, end, today);
    if (year) end = year.end;
    return {
      start: m.index,
      end,
      tier: EXACT,
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
      tier: EXACT,
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
    return { start: m.index, end: m.index + m[0].length, tier: EXACT, yearGiven: true, resolve: () => isoOf(year, month, day) };
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
      return { start, end: dayEnd, tier: EXACT, yearGiven: false, resolve: (today) => nextWeekdayAndDay(today, weekday, day) };
    }
  }
  return { start, end, tier: WEEKDAY, yearGiven: false, resolve: (today) => nextWeekday(today, weekday, strict) };
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

/**
 * A day of the month the text names without its month: the next such day on
 * or after today ("can we do the 21st?", "праздник 15-го", "วันที่ 15"), less
 * sure than a day with its month and surer than a weekday.
 */
function daysOfMonth(text: string): Found[] {
  const found = (start: number, digitsAt: number, digits: string, end: number): Found | null => {
    const day = Number(digits);
    if (day < 1 || day > 31 || !numberStartsAt(text, digitsAt)) return null;
    // A numeric date or a clock time goes on after the number: "วันที่ 15/11", "วันที่ 14.00".
    if (/^[:./-]\d/u.test(text.slice(digitsAt + digits.length))) return null;
    const after = text.slice(end);
    if (MONTH_AFTER.test(after) || UNIT_AFTER.test(after) || NOT_A_DAY_AFTER.test(after)) return null;
    return { start, end, tier: DAY_ONLY, yearGiven: false, resolve: (today) => nextDayOfMonth(today, day) };
  };
  const end = (m: RegExpExecArray) => m.index + m[0].length;
  const en = scan(EN_ORDINAL_DAY, text, (m) => {
    // "the 21st", or "on 21st"; not "her 5th", "my 2nd".
    if (m[1] ? isLetter(text[m.index - 1]) : !ON_BEFORE.test(text.slice(Math.max(0, m.index - 8), m.index))) return null;
    return found(m.index, m.index + (m[1]?.length ?? 0), m[2]!, end(m));
  });
  const ru = scan(RU_ORDINAL_DAY, text, (m) => found(m.index, m.index, m[1]!, end(m)));
  const th = scan(TH_DAY, text, (m) => found(m.index, end(m) - m[1]!.length, m[1]!, end(m)));
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
    return { start: m.index, end: m.index + m[0].length, tier: RELATIVE, yearGiven: false, resolve: (today) => plusDays(today, n) };
  };
  return [
    ...scan(EN_RU_RELATIVE, text, (m) => (isLetter(text[m.index - 1]) ? null : found(m))),
    ...scan(TH_RELATIVE, text, found),
  ];
}

/**
 * Every date the text names, in order, overlaps resolved (the earlier, then the
 * longer, stands). `today` (when known) is what a written year is checked
 * against. `clauseFrom` is where the date's own clause can start at the
 * earliest: the end of the date before it.
 */
function datesIn(text: string, today: Day | null): Array<Found & { phraseStart: number; clauseFrom: number }> {
  const all = [
    ...isoDates(text),
    ...numeric(text),
    ...dayMonth(text, today),
    ...monthDay(text, today),
    ...daysOfMonth(text),
    ...weekdays(text),
    ...relatives(text),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Found[] = [];
  for (const f of all) {
    const last = kept[kept.length - 1];
    if (last && f.start < last.end) continue;
    kept.push(f);
  }
  // A weekday right before the day it names is part of the phrase: "Saturday 21 March", "в субботу 21 марта".
  return kept.map((f, i) => {
    const prev = kept[i - 1];
    const joins = f.tier === EXACT && prev && prev.tier === WEEKDAY && WEEKDAY_GAP.test(text.slice(prev.end, f.start));
    const before = joins ? kept[i - 2] : prev;
    return { ...f, phraseStart: joins ? prev.start : f.start, clauseFrom: before ? before.end : 0 };
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

/**
 * The party's date in one text, counted from `today` (the day it was written),
 * with its kind; null when it names none. `notBefore`: a date before it is
 * not the party's (default `today`). `minTier`: weaker kinds are not read.
 */
function bestDate(text: string, today: Day, opts: { notBefore?: string; minTier?: Tier } = {}): Best | null {
  const { original, scan: t } = prepared(text);
  const notBefore = opts.notBefore ?? isoOfDay(today);
  let best: Best | null = null;
  for (const f of datesIn(t, today)) {
    if (f.tier < (opts.minTier ?? RELATIVE)) continue;
    if (notThePartysAt(t, f.phraseStart, f.clauseFrom)) continue;
    const date = f.resolve(today);
    // A year-less date resolves on or after `today`; one with its own year, or one
    // written on an earlier day, may fall before `notBefore`.
    if (!date || date < notBefore) continue;
    if (!best || f.tier > best.tier || (f.tier === best.tier && f.start >= best.at)) {
      best = { date, phrase: original.slice(f.phraseStart, f.end).trim(), tier: f.tier, at: f.start };
    }
  }
  return best;
}

/**
 * The clause before a date names a payment or a birth: "депозит получен 9
 * ноября", "Deposit of 1,500 baht received on 9 November". The clause starts
 * after the date before it and after the last clause mark (not the comma inside
 * "1,500").
 */
function notThePartysAt(text: string, start: number, clauseFrom: number): boolean {
  const near = text.slice(Math.max(clauseFrom, start - 48), start);
  let cut = 0;
  for (const m of near.matchAll(CLAUSE_END)) cut = m.index + m[0].length;
  const clause = near.slice(cut);
  return NOT_THE_PARTY.test(clause) || (RECEIVED.test(clause) && A_PAYMENT.test(near));
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
  return datesIn(prepared(text).scan, null).some((f) => f.tier >= WEEKDAY);
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
  // 14 часов, в 2 часа дня, в 5 ч. A bare "2 часа" ("Пакет на 2 часа", "длительность 3 часа")
  // is how long the party lasts, not when it starts: a small hour is a clock time only with
  // "в/во/к/с" before it or "дня/вечера/утра/ночи" after it.
  {
    re: /(?:(в|во|к|с)\s+)?(\d{1,2})\s*(?:час(?:а|ов)?(?!\p{L})|ч\.?(?!\p{L}))(?:\s*(дня|вечера|утра|ночи)(?!\p{L}))?/giu,
    read: (m) => {
      // "к" glued to a word ("праздник 2 часа") is that word's last letter, not "к".
      const before = !!m[1] && !isLetter(m.input[m.index - 1]);
      return before || m[3] || Number(m[2]) >= 8 ? russianHour(Number(m[2]), m[3]) : null;
    },
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
  const best = timesIn(t)[0];
  return best ? { time: best.time, phrase: original.slice(best.start, best.end).trim() } : null;
}

/** Every clock time a prepared text names, in order; of two readings of the same words the earlier, then the longer. */
function timesIn(t: string): TimeFound[] {
  const found: TimeFound[] = [];
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
        found.push({ start, end: m.index + m[0].length, time });
      }
      re.lastIndex = at > m.index ? at : m.index + 1;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: TimeFound[] = [];
  for (const f of found) {
    const last = kept[kept.length - 1];
    if (!last || f.start >= last.end) kept.push(f);
  }
  return kept;
}

// --- A time that is not the start (SCRUM-836) -------------------------------------------

/**
 * A chat gives times that are not when the party starts: "we want the park's
 * cake at 16:00", "food at 15:00", "setup ready by 13:30", "ends at 17:00",
 * "14:00 to 16:30". Book Date once proposed the cake's 16:00 as the start of
 * a party whose family had "not decided the start time yet". A time is NOT
 * the start when the words right before it, with no break between, name the
 * cake, the food or the setup, or say it is the end; or when the cake, the
 * food or the setup is named right after it ("16:00 cake"). The party, its
 * day or a word for the start in between makes it the party's again ("cake
 * and the party at 14:00", "with a cake, Saturday at 14:00"), and so does a
 * thing that only comes WITH what is said before it ("a party with pizza at
 * 14:00", "праздник с тортом в 14:00").
 */
const TIED_THING =
  /(?:^|[^\p{L}])(?:cakes?|candles?|food|meals?|lunch|dinner|pizzas?|snacks?|buffet|catering|drinks?|set[\s-]?up|decor\p{L}*|balloons?)(?!\p{L})|торт|свеч|(?:^|[^\p{L}])(?:ед[аыуе]|обед\p{L}*|ужин\p{L}*|меню)(?!\p{L})|пицц|угощен|закуск|фуршет|оформлен|декор|украшен|подготовк|เค้ก|เทียน|อาหาร|พิซซ่า|ของว่าง|ขนม|เครื่องดื่ม|บุฟเฟ่ต์|ตกแต่ง|จัดสถานที่|จัดเตรียม|เซ็?ตอัพ|ลูกโป่ง/giu;
/** The party itself, named between the thing and the time: the time is the party's. */
const PARTY_WORD =
  /(?:^|[^\p{L}])(?:party|birthday|b-?day|celebration|event|guests?|(?:we|they|everyone|kids|children)(?:['’]ll)?(?:\s+(?:will|all|can|would|should))*\s+(?:arrive|come|be\s+there))(?!\p{L})|праздник|вечеринк|рождени|гост|приход|прид[её]м|ปาร์ตี้|วันเกิด|งาน|มาถึง|แขก/iu;
/** The words between a thing and its time hold no break: one clause. */
const CLAUSE_BREAK = /[.!?;,\n]/;
/** The time is the end: "to 16:30", "until 17:00", "ends at 17:00", "до 16:30", "ถึง 16.30 น.". */
const END_BEFORE =
  /(?:(?:^|[^\p{L}])(?:to|till|til|until|ends?|ending|ended|finish\p{L}*|over)(?:\s+(?:at|by|around))?|(?:^|[^\p{L}])(?:до|по)|заканчива\p{L}*(?:\s+(?:в|к))?|закончи\p{L}*(?:\s+(?:в|к))?|(?:^|[^\p{L}])конец(?:\s+(?:в|к))?|окончани\p{L}*(?:\s+(?:в|к))?|ถึง|จบ(?:งาน)?|เลิก(?:งาน)?|สิ้นสุด)\s*(?:ตอน|เวลา)?\s*$/iu;
/** A range written with a dash: the second time is the end ("14:00 - 16:30"). */
const RANGE_DASH = /^\s*[-–—~]\s*$/;
/** Right after the time, before the thing it is the time of ("16:00 cake", "16:00 — торт", "16.00 เค้ก"). */
const THING_AFTER = /^\s*[-–—:]?\s*(?:for\s+)?(?:the\s+)?(?:park'?s\s+)?(?:birthday\s+)?/iu;
/** Right before a thing: it comes with what was said before it ("with a cake", "с тортом", "พร้อมเค้ก"). */
const COMES_WITH =
  /(?:(?:^|[^\p{L}])(?:with|plus|including|includes?|incl\.?)\s+(?:(?:a|an|the|our|own|some|park'?s|birthday|big|small)\s+)*|(?:^|[^\p{L}])(?:с|со|включая)\s+|(?:พร้อม|รวม)\s*)$/iu;
/** A thing is tied to a time at most this far before it. */
const TIED_REACH = 48;

/** The last thing a text names: where its word starts and ends; null when it names none. */
function lastThing(text: string): { start: number; end: number } | null {
  TIED_THING.lastIndex = 0;
  let last: { start: number; end: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = TIED_THING.exec(text)) !== null) {
    // The pattern's own leading non-letter (a space) is not the word.
    const lead = Math.max(m[0].search(/\p{L}/u), 0);
    last = { start: m.index + lead, end: m.index + m[0].length };
  }
  return last;
}

function thingStartsAt(text: string): boolean {
  TIED_THING.lastIndex = 0;
  const m = TIED_THING.exec(text);
  // The pattern's own leading non-letter (a space) may be its first character.
  return m !== null && m.index === 0 && m[0].search(/\p{L}/u) <= 1;
}

/** Is the time at `found` in `t` something other than the party's start? `prev`: the time before it, if any. */
function isNotTheStart(t: string, found: TimeFound, prev: TimeFound | undefined): boolean {
  const lead = t.slice(prev ? prev.end : 0, found.start);
  // The end: an end word right before it, or a dash after another time.
  if (END_BEFORE.test(lead) || (prev !== undefined && RANGE_DASH.test(lead))) return true;
  const partys = (between: string) => PARTY_WORD.test(between) || START_WORD.test(between) || mentionsPartyDate(between);
  // The cake, the food or the setup right before it, in one clause.
  const thing = lastThing(lead);
  if (thing && !COMES_WITH.test(lead.slice(0, thing.start))) {
    const between = lead.slice(thing.end);
    if (between.length <= TIED_REACH && !CLAUSE_BREAK.test(between) && !partys(between)) return true;
  }
  // The same named right after it, when nothing before it in its sentence makes the time the party's.
  const tail = t.slice(found.end);
  const after = tail.slice(THING_AFTER.exec(tail)?.[0].length ?? 0);
  if (thingStartsAt(after)) {
    const sentence = /[^.!?;\n]*$/.exec(lead)?.[0] ?? '';
    if (!partys(sentence)) return true;
  }
  return false;
}

export interface PartyTimeRole extends PartyTimeReading {
  /** False when the text ties the time to the cake, the food, the setup or the end: not the party's start. */
  start: boolean;
}

/** Every clock time a text names, in order, each with whether it can be the party's start. */
export function readPartyTimeRoles(text: string): PartyTimeRole[] {
  const { original, scan: t } = prepared(text);
  const times = timesIn(t);
  return times.map((f, i) => ({
    time: f.time,
    phrase: original.slice(f.start, f.end).trim(),
    start: !isNotTheStart(t, f, times[i - 1]),
  }));
}

/**
 * The party's start in a text, with its own words: the first clock time that
 * is not the cake's, the food's, the setup's or the end's; null when the text
 * names no time, or only such times.
 */
export function readPartyStartPhrase(text: string): PartyTimeReading | null {
  const first = readPartyTimeRoles(text).find((r) => r.start);
  return first ? { time: first.time, phrase: first.phrase } : null;
}

/** The first clock time a text names, `HH:MM`, or null. */
export function readPartyTime(text: string): string | null {
  return readPartyTimePhrase(text)?.time ?? null;
}

/** Does the text name a clock time? (`carriesBirthdayDetails`, api.) */
export function mentionsPartyTime(text: string): boolean {
  return readPartyTimePhrase(text) !== null;
}

/** A word for the party's start ("начало в 14:00", "we start at 3pm", "เริ่ม 14.00 น."). */
const START_WORD = /(?:^|[^\p{L}])(?:start|starts|starting|begin|begins|beginning)(?!\p{L})|начал|начн|начин|เริ่ม/iu;
/** A time given as a point ("at 15:00", "в 14:00", "around 16:00", "เวลา 14.00"), not a deadline ("до 18:00", "until 20:00"). */
const TIME_AS_A_POINT = /^(?:at|в|во|с|from|around|около|เวลา)(?!\p{L})/iu;
/** The park's opening hours are no party's time ("We are open today until 20:00", "работаем с 10:00"). */
const OPENING_HOURS = /(?:^|[^\p{L}])(?:open|opens|opening|close|closes|closing|closed)(?!\p{L})|работаем|открыт|закрыва|закрыт|เปิด|ปิด/iu;

/**
 * A line's time is the party's when the line names the party's day or its
 * start, or gives the time as a point ("в 14:00", "around 16:00"); not a
 * deadline ("внесите депозит до 18:00 сегодня") nor the opening hours.
 */
function isPartyTimeLine(text: string, time: PartyTimeReading): boolean {
  if (OPENING_HOURS.test(text)) return false;
  return mentionsPartyDate(text) || START_WORD.test(text) || TIME_AS_A_POINT.test(time.phrase);
}

// --- A whole chat ------------------------------------------------------------------------

export interface PartyChatLine {
  text: string;
  /** Written by a person on the team (not the customer, the assistant or a system notice). */
  team: boolean;
  /**
   * When it was written, an ISO instant: a date in it is counted from that day
   * (an old "15 марта" or "в субботу" is a day that has gone), and a line
   * older than `PARTY_CHAT_WINDOW_DAYS` is not read. Absent: written today.
   */
  at?: string | null;
}

/** A chat's lines written more than this many days before today are not read for the party's date or time. */
export const PARTY_CHAT_WINDOW_DAYS = 60;

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
 * outright beats a day of the month alone, that beats a weekday, wherever each
 * is; within one kind the LATER line wins, whoever wrote it: a team line
 * answers what the customer asked before it ("15 ноября занято, есть 16
 * ноября"), and a customer's later date (a new party, a move: "перенести на 22
 * ноября?") answers the team's. "Today" and "tomorrow" are not read here: a
 * greeting or a promise to call back says them ("How can I help you today?",
 * "отвечу завтра"). Each line's date is counted from the day it was written,
 * and a date that has gone by today is passed over, as is a line older than
 * `PARTY_CHAT_WINDOW_DAYS`.
 *
 * The time is the one written with that date, else the team's latest, else the
 * customer's latest, from a line that names the party's day or its start or
 * gives the time as a point ("в 14:00"); a deadline ("до 18:00") or the opening
 * hours leave it empty. A time the chat ties to the cake, the food, the setup
 * or the party's end is never the start (SCRUM-836, `readPartyStartPhrase`):
 * with no other time in the chat the start stays empty for a person to give.
 */
export function readChatPartyDate(
  lines: readonly PartyChatLine[],
  today: string | Date = new Date(),
  timeZone: string = PARTY_DATE_TIME_ZONE,
): PartyChatReading {
  const day = todayDay(today, timeZone);
  const todayIso = day ? isoOfDay(day) : '';
  const oldest = day ? plusDays(day, -PARTY_CHAT_WINDOW_DAYS) : '';
  /** The day a line was written (today when it does not say, or says a later day); null: too old to read. */
  const writtenOn = (l: PartyChatLine): Day | null => {
    if (!day || !l.at) return day;
    const instant = new Date(l.at);
    if (Number.isNaN(instant.getTime())) return day;
    const iso = isoDateInTz(instant, timeZone);
    if (iso < oldest) return null;
    return iso >= todayIso ? day : dayFromIso(iso);
  };
  const lineDays = lines.map(writtenOn);
  let chosen: { line: number; team: boolean; found: Best } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const from = lineDays[i];
    if (!from) continue;
    const found = bestDate(l.text, from, { notBefore: todayIso, minTier: WEEKDAY });
    if (found && (!chosen || found.tier >= chosen.found.tier)) chosen = { line: i, team: l.team, found };
  }
  let time: PartyTimeReading | null = chosen ? readPartyStartPhrase(lines[chosen.line]!.text) : null;
  /** Another line names another party: a day that has gone, or a different day ("Подтверждаем ваш праздник 15 марта в 14:00"). */
  const anotherParty = (l: PartyChatLine, from: Day): boolean => {
    if (!mentionsPartyDate(l.text)) return false;
    const its = bestDate(l.text, from, { notBefore: todayIso, minTier: WEEKDAY });
    return !its || (its.tier === EXACT && its.date !== chosen?.found.date);
  };
  for (const team of [true, false]) {
    for (let i = lines.length - 1; i >= 0 && !time; i--) {
      const l = lines[i]!;
      const from = lineDays[i];
      if (l.team !== team || !from || anotherParty(l, from)) continue;
      const found = readPartyStartPhrase(l.text);
      if (found && isPartyTimeLine(l.text, found)) time = found;
    }
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
