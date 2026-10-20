/**
 * The deterministic guards (PLAN §B.3 gates 5–7). Pure functions over the
 * model's bubbles; they return rule ids, never the text they matched, so a
 * guard result can go to an audit row as it stands (§D.1).
 */

import { MAX_BUBBLE_CHARS, MAX_BUBBLES, MAX_TOTAL_CHARS } from './decision';

export type GuardResult<R extends string> = { ok: true } | { ok: false; reason: R; rule: string };

// ---------------------------------------------------------------------------
// The persona guard (gate 6): no self-reference to automation, any language.
// ---------------------------------------------------------------------------

/**
 * Latin words are bounded by Latin letters only, so "Thai" and "said" never
 * match "ai" while "AIแอดมิน" still does. Cyrillic words are bounded by any
 * letter, so "работаем" never matches "бот". Thai has no word spaces, so its
 * words match as substrings.
 */
const latin = (word: string) => new RegExp(`(?<![A-Za-z])${word}(?![A-Za-z])`, 'i');
const cyrillic = (word: string) => new RegExp(`(?<!\\p{L})${word}(?!\\p{L})`, 'iu');
const thai = (word: string) => new RegExp(word, 'u');

export const PERSONA_GUARD_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'en:ai', pattern: latin('a\\.?i\\.?') },
  { id: 'en:bot', pattern: latin('(?:chat)?bots?') },
  { id: 'en:robot', pattern: latin('robots?') },
  { id: 'en:assistant', pattern: latin('assistants?') },
  { id: 'en:model', pattern: latin('(?:language )?models?') },
  { id: 'en:automated', pattern: latin('automat(?:ed|ic|ion)') },
  { id: 'en:artificial', pattern: latin('artificial intelligence') },
  { id: 'en:claude', pattern: latin('claude') },
  { id: 'en:anthropic', pattern: latin('anthropic') },
  { id: 'th:ai', pattern: thai('เอไอ') },
  // Test night 2026-10-21 (W8): the Thai and Russian "assistant" and
  // "chatbot" words, which three Thai KB entries carried ("ระบบผู้ช่วย…").
  // Latin "AI" inside Thai text is caught by en:ai (bounded by Latin letters).
  { id: 'th:chatbot', pattern: thai('แชทบอท') },
  { id: 'th:bot', pattern: thai('บอท') },
  { id: 'th:assistant', pattern: thai('ผู้ช่วย') },
  { id: 'th:artificial', pattern: thai('ปัญญาประดิษฐ์') },
  { id: 'th:robot', pattern: thai('หุ่นยนต์') },
  { id: 'th:auto', pattern: thai('อัตโนมัติ') },
  { id: 'ru:ai', pattern: cyrillic('ИИ') },
  { id: 'ru:chatbot', pattern: cyrillic('чат-?бот\\p{L}*') },
  { id: 'ru:bot', pattern: cyrillic('бот(?:а|у|ом|е|ы|ов|ам|ами|ах)?') },
  { id: 'ru:neural', pattern: cyrillic('нейросет\\p{L}*') },
  { id: 'ru:artificial', pattern: cyrillic('искусственн\\p{L}* интеллект\\p{L}*') },
  { id: 'ru:robot', pattern: cyrillic('робот\\p{L}*') },
  { id: 'ru:assistant', pattern: cyrillic('ассистент\\p{L}*') },
  { id: 'ru:auto', pattern: cyrillic('автоматическ\\p{L}*') },
];

export function personaGuard(bubbles: readonly string[]): GuardResult<'GUARD_PERSONA'> {
  for (const bubble of bubbles) {
    for (const rule of PERSONA_GUARD_RULES) {
      if (rule.pattern.test(bubble)) return { ok: false, reason: 'GUARD_PERSONA', rule: rule.id };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The traceability guard (gate 5): every number, price, date and promise word
// in the bubbles must occur in the grounding text the decision cites.
// ---------------------------------------------------------------------------

/** Thai digits ๐–๙ read as 0–9. */
function asciiDigits(text: string): string {
  return text.replace(/[๐-๙]/g, (d) => String(d.charCodeAt(0) - 0x0e50));
}

/**
 * A time written 10:00, 10.00 or 10:00:00 (a database `time` column, as the
 * OTO App's shift rows carry it) is the same time. Seconds other than :00
 * are kept: 10:00:30 is not 10:00.
 */
function canonicalNumber(token: string): string {
  const t = token.replace(/,/g, '');
  const time = /^(\d{1,2})[.:](\d{2})(?::00)?$/.exec(t);
  if (time) return `${Number(time[1])}:${time[2]}`;
  return t.replace(/^0+(?=\d)/, '');
}

const NUMBER_TOKEN = /\d+(?:[.,:]\d+)*/g;

/**
 * The numbers a text states. A compound token also grounds its parts, so
 * "10:00–20:00" in the grounding grounds "10" and "20" in a reply.
 */
function numbersIn(text: string): string[] {
  return asciiDigits(text).match(NUMBER_TOKEN) ?? [];
}

/**
 * Whether a text states any number at all, by the traceability guard's own
 * tokeniser (Thai digits included): what the internal engine asks of a
 * question back before marking it as small talk.
 */
export function statesNumber(text: string): boolean {
  return numbersIn(text).length > 0;
}

function groundedNumbers(grounding: string): Set<string> {
  const out = new Set<string>();
  for (const token of numbersIn(grounding)) {
    out.add(canonicalNumber(token));
    for (const part of token.split(/[.,:]/)) out.add(canonicalNumber(part));
    out.add(canonicalNumber(token.replace(/,/g, '')));
  }
  return out;
}

/**
 * Month names in the three languages. English "May" only counts next to a
 * number, since "you may" is ordinary English. Weekday names are deliberately
 * not dates here: "open every day" and "on Saturdays" are common in grounded
 * answers, and a held date always carries a day number, which the number
 * check already demands be grounded.
 */
export const DATE_WORD_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  ...[
    ['jan', 'jan(?:uary)?'],
    ['feb', 'feb(?:ruary)?'],
    ['mar', 'mar(?:ch)?'],
    ['apr', 'apr(?:il)?'],
    ['jun', 'june?'],
    ['jul', 'july?'],
    ['aug', 'aug(?:ust)?'],
    ['sep', 'sept?(?:ember)?'],
    ['oct', 'oct(?:ober)?'],
    ['nov', 'nov(?:ember)?'],
    ['dec', 'dec(?:ember)?'],
  ].map(([id, word]) => ({ id: `en:${id}`, pattern: latin(word as string) })),
  {
    id: 'en:may',
    pattern: /(?:\d\s*(?:st|nd|rd|th)?\s*May(?![A-Za-z]))|(?:(?<![A-Za-z])May\s*\d)/i,
  },
  ...[
    'มกราคม',
    'กุมภาพันธ์',
    'มีนาคม',
    'เมษายน',
    'พฤษภาคม',
    'มิถุนายน',
    'กรกฎาคม',
    'สิงหาคม',
    'กันยายน',
    'ตุลาคม',
    'พฤศจิกายน',
    'ธันวาคม',
    'ม\\.ค\\.',
    'ก\\.พ\\.',
    'มี\\.ค\\.',
    'เม\\.ย\\.',
    'พ\\.ค\\.',
    'มิ\\.ย\\.',
    'ก\\.ค\\.',
    'ส\\.ค\\.',
    'ก\\.ย\\.',
    'ต\\.ค\\.',
    'พ\\.ย\\.',
    'ธ\\.ค\\.',
  ].map((word, i) => ({ id: `th:month${i}`, pattern: thai(word) })),
  ...[
    'январ\\p{L}*',
    'феврал\\p{L}*',
    'март\\p{L}*',
    'апрел\\p{L}*',
    'ма[йяе]',
    'июн\\p{L}*',
    'июл\\p{L}*',
    'август\\p{L}*',
    'сентябр\\p{L}*',
    'октябр\\p{L}*',
    'ноябр\\p{L}*',
    'декабр\\p{L}*',
  ].map((word, i) => ({ id: `ru:month${i}`, pattern: cyrillic(word) })),
];

/**
 * Promise words (§B.3 gate 5), per language. A bubble may use one only when
 * the cited grounding uses the same word: "free for under-ones" passes when
 * the age-rules entry says so; "we'll give you a free entry" does not.
 * "Feel free" is ordinary English and is removed before matching.
 */
export const PROMISE_WORD_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'en:refund', pattern: latin('refund\\w*') },
  { id: 'en:compensation', pattern: latin('compensat\\w*') },
  { id: 'en:free', pattern: latin('free') },
  { id: 'en:discount', pattern: latin('discount\\w*') },
  { id: 'th:refund', pattern: thai('คืนเงิน') },
  { id: 'th:compensation', pattern: thai('ชดเชย') },
  { id: 'th:free', pattern: thai('ฟรี') },
  { id: 'th:discount', pattern: thai('ส่วนลด') },
  { id: 'ru:refund', pattern: cyrillic('возврат\\p{L}*') },
  { id: 'ru:compensation', pattern: cyrillic('компенсац\\p{L}*') },
  { id: 'ru:free', pattern: cyrillic('бесплатн\\p{L}*') },
  { id: 'ru:discount', pattern: cyrillic('скидк\\p{L}*') },
];

function withoutIdioms(text: string): string {
  return text.replace(/feel\s+free/gi, ' ');
}

export type TraceReason = 'GUARD_NUMBER' | 'GUARD_DATE' | 'GUARD_PROMISE';

/**
 * @param bubbles the model's bubbles
 * @param groundingTexts the text of every grounding source the decision cites
 *   (and only those): KB bodies and rendered live facts. Conversation text is
 *   deliberately NOT grounding: a customer who writes "50%" or "14 November"
 *   must not thereby license the reply to repeat it (G13, "never confirm a
 *   date").
 */
export function traceabilityGuard(
  bubbles: readonly string[],
  groundingTexts: readonly string[],
): GuardResult<TraceReason> {
  const grounding = groundingTexts.join('\n');
  const numbers = groundedNumbers(grounding);
  const groundingWords = withoutIdioms(grounding);
  for (const raw of bubbles) {
    for (const token of numbersIn(raw)) {
      const canon = canonicalNumber(token);
      if (!numbers.has(canon)) return { ok: false, reason: 'GUARD_NUMBER', rule: 'number' };
    }
    for (const rule of DATE_WORD_RULES) {
      if (rule.pattern.test(raw) && !rule.pattern.test(grounding)) {
        return { ok: false, reason: 'GUARD_DATE', rule: rule.id };
      }
    }
    const text = withoutIdioms(raw);
    for (const rule of PROMISE_WORD_RULES) {
      if (rule.pattern.test(text) && !rule.pattern.test(groundingWords)) {
        return { ok: false, reason: 'GUARD_PROMISE', rule: rule.id };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Gate 7: bubble count, length, and chat shape (no lists, no headings).
// ---------------------------------------------------------------------------

/** Markdown structure a person at a chat desk never types (§B.4 "no bullet lists, no headings"). */
const LIST_OR_HEADING = /^\s*(?:[-*•]\s|\d+[.)]\s|#{1,6}\s)|\*\*/m;

export function bubbleGuard(
  bubbles: readonly string[],
  min: number,
): GuardResult<'GUARD_BUBBLES' | 'GUARD_SHAPE'> {
  if (bubbles.length < min || bubbles.length > MAX_BUBBLES) {
    return { ok: false, reason: 'GUARD_BUBBLES', rule: 'count' };
  }
  let total = 0;
  for (const b of bubbles) {
    if (b.trim().length === 0) return { ok: false, reason: 'GUARD_BUBBLES', rule: 'empty' };
    if (b.length > MAX_BUBBLE_CHARS)
      return { ok: false, reason: 'GUARD_BUBBLES', rule: 'bubble_length' };
    if (LIST_OR_HEADING.test(b)) return { ok: false, reason: 'GUARD_SHAPE', rule: 'markdown' };
    total += b.length;
  }
  if (total > MAX_TOTAL_CHARS) return { ok: false, reason: 'GUARD_BUBBLES', rule: 'total_length' };
  return { ok: true };
}
