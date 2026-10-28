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
// The traceability guard (gate 5): every number, price and date in the
// bubbles must occur in the grounding text the decision cites, and a promise
// word may be granted only when it does (item F: the act, not the word).
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
 * Promise words (§B.3 gate 5), per language. Since the owner's ruling of 28
 * Oct 2026 (SCRUM-220, item F) the guard judges the ACT, not the WORD: a
 * bubble may NAME one freely — to explain a policy ("residents get a discount
 * at Central"), to say we do not offer it, to say a colleague will look into
 * it, or in a question — but may GRANT or CONFIRM one ("we'll refund you",
 * "you'll get a discount", "yes, it's free for you") only when the cited
 * grounding uses the same word. "Feel free" is ordinary English and is
 * removed before matching. Numbers and dates are untouched: a "50% off" is
 * still a number no source holds.
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

// --- The act, not the word (item F) ----------------------------------------------------------

/**
 * A grant the clause makes whatever else it says: the first person giving
 * ("we'll refund", "I can give you", "let me", "happy to give"), an offer put
 * as a question ("would you like a free…?"), "on us", "here's your…", "your
 * refund is approved", "we've applied…". The negated forms ("we can't give",
 * "we don't offer", "мы не можем", "เราไม่สามารถให้") do not match.
 */
const STRONG_GRANTS: readonly RegExp[] = [
  /\b(?:we|i)(?:'ll|'d|\s+will|\s+would|\s+can|\s+could|\s+shall|(?:\s+are|\s+am|'re|'m)\s+(?:happy|glad|able)\s+to|'d\s+be\s+(?:happy|glad)\s+to|\s+would\s+be\s+(?:happy|glad)\s+to)\s+(?:(?:also|gladly|happily|definitely|certainly|still|just|totally)\s+)?(?:offer|give|grant|provide|apply|arrange|throw\s+in|add|refund|compensate|waive|reimburse|send|do|make|let)\b/i,
  /\blet\s+(?:me|us)\s+(?:offer|give|apply|arrange|refund|waive|add|throw\s+in|get\s+you)\b/i,
  /\b(?:happy|glad|pleased)\s+to\s+(?:offer|give|apply|arrange|refund|waive|add|throw\s+in)\b/i,
  /\b(?:would\s+you\s+like|do\s+you\s+want|shall\s+(?:i|we)|can\s+(?:i|we)\s+(?:offer|give|get\s+you)|may\s+(?:i|we)\s+offer)\b/i,
  /\bon\s+(?:us|the\s+house)\b/i,
  /\b(?:here's|here\s+is)\s+(?:a|an|your|the)\b/i,
  /\byour\s+(?:[\w']+\s+){0,2}(?:refund|discount|compensation)\s+(?:is|has\s+been|will\s+be|was|'s)\s+(?:approved|confirmed|processed|issued|applied|on\s+(?:its|the)\s+way|done|sorted|ready)\b/i,
  /\b(?:we|i)(?:'ve|\s+have)\s+(?:already\s+)?(?:applied|added|refunded|processed|approved|issued|arranged|waived|given)\b/i,
  /(?:เรา|ทางเรา|ทางร้าน|แอดมิน|ดิฉัน|ผม|หนู|ทีมงาน)\s*(?:จะ|ขอ|ยินดี(?:ที่จะ)?|สามารถ|ก็)?\s*(?:ให้|มอบ|คืนเงิน|คืน|ชดเชย|ลดให้|จัดให้|แถม)/u,
  /(?<!\p{L})(?:мы|я)\s+(?:(?:с\s+радостью|охотно|можем|могу|готовы|готов|рады|будем\s+рады)\s+)?(?:сделаем|сделаю|сделать|дадим|дам|дать|предоставим|предоставлю|предоставить|вернём|вернем|верну|вернуть|оформим|оформлю|оформить|компенсируем|компенсирую|компенсировать|подарим|подарю|подарить|предложим|предложу|предложить|начислим|применим|применить)(?!\p{L})/iu,
  /(?<!(?<!\p{L})не\s+)(?<!\p{L})(?:сделаем|дадим|предоставим|вернём|вернем|оформим|компенсируем|подарим|предложим|начислим|применим)(?!\p{L})/iu,
];

/**
 * A grant only in a statement that is not a colleague's errand: the second
 * person receiving ("you get", "you'll receive"), "for you", "yes…", "it's
 * free", and their Thai and Russian forms. A question ("do you have an ID for
 * the discount?") or a deferral ("a colleague will look into the refund for
 * you") does not grant.
 */
const WEAK_GRANTS: readonly RegExp[] = [
  /\byou(?:'ll|'re\s+getting|\s+will|\s+can|\s+could|\s+would|\s+are\s+going\s+to|\s+get\s+to)?\s+(?:(?:also|now|still|even)\s+)?(?:get|receive|have|enjoy|qualify\s+for|be\s+getting)\b/i,
  /\bfor\s+you\b/i,
  /^\s*(?:yes|yeah|yep|sure|of\s+course|absolutely|certainly|definitely|ok(?:ay)?)\b/i,
  /\b(?:it's|it\s+is|that's|that\s+is|it'll\s+be|it\s+will\s+be|that'll\s+be|that\s+will\s+be)\s+(?:(?!not\b|never\b|no\b)[\w']+\s+){0,2}free\b/i,
  /(?:คุณ|ลูกค้า|น้อง)\s*(?:จะ|ก็)?\s*ได้(?:รับ)?|จะได้รับ/u,
  /(?:ส่วนลด|คืนเงิน|ชดเชย|ฟรี|ลด)\s*ให้|ให้\s*(?:ฟรี|ส่วนลด)/u,
  /^\s*(?:ได้(?:เลย|ค่ะ|ครับ)?|แน่นอน|ยินดี)/u,
  /(?<!\p{L})вы\s+(?:(?:тоже|также|сразу)\s+)?(?:получите|получаете|можете\s+получить|сможете\s+получить)(?!\p{L})/iu,
  /(?<!\p{L})для\s+вас(?!\p{L})/iu,
  /^\s*(?:да|конечно|хорошо|разумеется|без\s+проблем)(?!\p{L})/iu,
  /(?<!\p{L})(?:это|будет)\s+бесплатн/iu,
];

/** A question: it asks, so it grants nothing unless it is an offer (a strong grant). */
const QUESTION = /\?|ไหม|มั้ย|หรือเปล่า|หรือไม่|ใช่ไหม|คะ(?![฀-๿])/u;

/** A colleague's errand: someone will look into it, which is no grant. */
const DEFERRAL =
  /\b(?:look(?:ing)?\s+into|be\s+in\s+(?:contact|touch)|get\s+back\s+to|contact\s+you|reach\s+out|follow\s+up|check|review|take\s+care\s+of|help\s+(?:you\s+)?with|manager|colleague|team\s+member|someone\s+from)\b|ติดต่อ|ตรวจสอบ|ดูแลเรื่อง|พิจารณา|ผู้จัดการ|เจ้าหน้าที่|свяж|рассмотр|разбер|провер|менеджер|коллег|сотрудник/iu;

/** A negation in the three words before the promise word: "no discount", "not free", "ไม่มีส่วนลด", "без скидки". */
const NEGATED_BEFORE = [
  /(?:\b(?:no|not|never|without|none|nor)\b|n't)\s*(?:[\w'-]+\s+){0,2}$/i,
  /(?:ไม่|งด)[฀-๿\s]{0,12}$/u,
  /(?<!\p{L})(?:не|нет|без|ни)(?!\p{L})\s*(?:\p{L}+\s+){0,2}$/iu,
];

/** The sentences of a bubble, each with its own end mark (times like 10:00 stay whole). */
function sentencesOf(text: string): string[] {
  return text.match(/[^.!?\n;]+[.!?\n;]*/g) ?? [];
}

/** A sentence's clauses: a contrast ("but", "แต่", "но") starts a new one. */
function clausesOf(sentence: string): string[] {
  return sentence.split(/\s(?:but|however|although|though)\s|แต่|อย่างไรก็ตาม|(?<!\p{L})(?:но|однако)(?!\p{L})/iu);
}

/**
 * Whether the text GRANTS or CONFIRMS what `word` names: a clause holding the
 * word, not negated just before it, that makes a strong grant — or, outside a
 * question and a deferral, a weak one.
 */
function grants(text: string, word: RegExp): boolean {
  const global = new RegExp(word.source, word.flags.includes('g') ? word.flags : `${word.flags}g`);
  for (const sentence of sentencesOf(text)) {
    const asks = QUESTION.test(sentence);
    for (const clause of clausesOf(sentence)) {
      const named = [...clause.matchAll(global)].filter((m) => !NEGATED_BEFORE.some((n) => n.test(clause.slice(0, m.index))));
      if (named.length === 0) continue;
      if (STRONG_GRANTS.some((g) => g.test(clause))) return true;
      if (!asks && !DEFERRAL.test(clause) && WEAK_GRANTS.some((g) => g.test(clause))) return true;
    }
  }
  return false;
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
      if (rule.pattern.test(text) && !rule.pattern.test(groundingWords) && grants(text, rule.pattern)) {
        return { ok: false, reason: 'GUARD_PROMISE', rule: rule.id };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Links (SCRUM-220 playbook, owner D4: never guess a customer-facing URL).
// ---------------------------------------------------------------------------

/**
 * A link as a customer would read one: a scheme URL, a `www.` address, or a
 * bare domain on a common top-level domain (with or without a path).
 */
const LINK_PATTERN =
  /(?:\bhttps?:\/\/|\bwww\.)[^\s<>"'`)\]}]+|\b(?:[a-z0-9-]+\.)+(?:com|co|net|org|th|ru|io|app|me|info|link|ly|page)\b(?:\/[^\s<>"'`)\]}]*)?/gi;

/** The links a text holds, scheme removed and trailing punctuation dropped. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(LINK_PATTERN)].map((m) => m[0].replace(/[.,;:!?]+$/, '').replace(/^https?:\/\//i, ''));
}

/**
 * Every link in the bubbles must occur, character for character (the scheme
 * aside), in a source the decision cites: the calculator, menu and booking
 * links the knowledge holds pass; a link with a changed parameter, or one no
 * source holds, is refused.
 */
export function linkGuard(bubbles: readonly string[], groundingTexts: readonly string[]): GuardResult<'GUARD_LINK'> {
  const grounding = groundingTexts.join('\n');
  for (const bubble of bubbles) {
    for (const link of linksIn(bubble)) {
      if (!grounding.includes(link)) return { ok: false, reason: 'GUARD_LINK', rule: 'link' };
    }
  }
  return { ok: true };
}

/** The text with its links taken out (a link's own `?` is not a question). */
function withoutLinks(text: string): string {
  return text.replace(LINK_PATTERN, ' ');
}

// ---------------------------------------------------------------------------
// Never busy (SCRUM-220 playbook, "Voice and golden rules": "Never say the
// park is busy. Walk-ins are always welcome").
// ---------------------------------------------------------------------------

/**
 * Busy words, per language. Like the promise words, a bubble may use one
 * only when a cited source uses the same word ("for kids who find busy
 * places hard, weekday mornings are the calmest time" is the special-needs
 * entry's own). Thai แน่นอน ("certainly") is not แน่น ("packed").
 */
export const BUSY_WORD_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'en:busy', pattern: latin('bus(?:y|ier|iest)') },
  { id: 'en:crowded', pattern: latin('(?:over)?crowded') },
  { id: 'en:full', pattern: latin('full(?:y booked)?') },
  { id: 'th:crowded', pattern: thai('แน่น(?!อน)') },
  { id: 'th:many_people', pattern: thai('คนเยอะ') },
  { id: 'ru:crowded', pattern: cyrillic('многолюдн\\p{L}*') },
  { id: 'ru:busy', pattern: cyrillic('заняты') },
];

/** "Full day", "full-day", "full food credit", "full-service restaurant": the products, not a full park. */
const FULL_IDIOMS =
  /(?<![A-Za-z])full[\s-]*(?:days?|food|service|price|prices|menu|kitchen|credit|details?|amount|access|list|range|meals?)(?![A-Za-z])/gi;

function withoutBusyIdioms(text: string): string {
  return text.replace(FULL_IDIOMS, ' ');
}

export function busyGuard(bubbles: readonly string[], groundingTexts: readonly string[]): GuardResult<'GUARD_BUSY'> {
  const grounding = withoutBusyIdioms(groundingTexts.join('\n'));
  for (const raw of bubbles) {
    const text = withoutBusyIdioms(raw);
    for (const rule of BUSY_WORD_RULES) {
      if (rule.pattern.test(text) && !rule.pattern.test(grounding)) {
        return { ok: false, reason: 'GUARD_BUSY', rule: rule.id };
      }
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// No admission of fault (SCRUM-220 playbook, "Hand-offs": a complaint gets a
// sincere apology that "never admits fault, offers compensation or argues").
// Applied to the words that ride a hand-over; compensation is the promise
// guard's.
// ---------------------------------------------------------------------------

export const FAULT_WORD_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'en:fault', pattern: latin('(?:our|my) (?:fault|mistake|error)') },
  { id: 'en:we_wrong', pattern: latin('we (?:were|are|have been) (?:wrong|at fault|to blame|negligent)') },
  { id: 'en:we_mistake', pattern: latin('we (?:made|have made) (?:a |an )?(?:mistake|error)') },
  { id: 'en:blame', pattern: latin('we (?:take|accept) (?:full )?(?:responsibility|the blame|blame)') },
  { id: 'th:fault', pattern: thai('ความผิด(?:พลาด)?ของ(?:เรา|ทางเรา|ร้าน|สวนสนุก)') },
  { id: 'th:we_wrong', pattern: thai('(?:ทาง)?เราผิด(?!หวัง)') },
  { id: 'ru:fault', pattern: cyrillic('(?:наша|моя) (?:вина|ошибка)') },
  { id: 'ru:we_wrong', pattern: cyrillic('(?:мы|я) виноват\\p{L}*') },
  { id: 'ru:by_us', pattern: cyrillic('по нашей вине') },
];

export function faultGuard(bubbles: readonly string[]): GuardResult<'GUARD_FAULT'> {
  for (const bubble of bubbles) {
    for (const rule of FAULT_WORD_RULES) {
      if (rule.pattern.test(bubble)) return { ok: false, reason: 'GUARD_FAULT', rule: rule.id };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The care services are never framed as "safer" (SCRUM-220 playbook, "Ages,
// nanny and drop-off": "Never frame it as 'safer'; the whole park is safe").
// No source exemption: the knowledge's own nanny entry quotes the word to
// forbid it.
// ---------------------------------------------------------------------------

export const SAFER_FRAMING_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'en:safer', pattern: latin('safer|safest|more safe') },
  { id: 'th:safer', pattern: thai('ปลอดภัยกว่า|ปลอดภัยที่สุด') },
  { id: 'ru:safer', pattern: cyrillic('безопаснее|надёжнее|надежнее') },
];

export function framingGuard(bubbles: readonly string[]): GuardResult<'GUARD_FRAMING'> {
  for (const bubble of bubbles) {
    for (const rule of SAFER_FRAMING_RULES) {
      if (rule.pattern.test(bubble)) return { ok: false, reason: 'GUARD_FRAMING', rule: rule.id };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Languages (SCRUM-220 playbook, "Languages").
// ---------------------------------------------------------------------------

/** The playbook's one offer, in English: Russian or Thai beside English. */
const OFFER_RU = /(?<![A-Za-z])(?:English or Russian|Russian or English)(?![A-Za-z])/i;
const OFFER_TH = /(?<![A-Za-z])(?:English or Thai|Thai or English)(?![A-Za-z])/i;
/** A language menu: never allowed. */
const LANGUAGE_MENU: readonly RegExp[] = [
  /(?<![A-Za-z])(?:which|what|preferred|another|other) language(?![A-Za-z])/i,
  /(?<![A-Za-z])language (?:do|would) you(?![A-Za-z])/i,
  /ภาษา(?:อะไร|ไหน)/u,
  /(?<!\p{L})(?:на каком языке|како[йм] язык\p{L}*)(?!\p{L})/iu,
];

/**
 * Whether the bubbles offer a choice of language, and which: the playbook's
 * Russian (`ru`) or Thai (`th`) offer, a general `menu`, or none. The offer
 * is read in the context of a choice ("continue in English or Russian?",
 * "chat in Russian or English?"), so "Thai families get special prices"
 * is no offer.
 */
export function languageOfferIn(bubbles: readonly string[]): 'ru' | 'th' | 'menu' | null {
  const offers = new Set<'ru' | 'th'>();
  for (const bubble of bubbles) {
    if (LANGUAGE_MENU.some((p) => p.test(bubble))) return 'menu';
    if (OFFER_RU.test(bubble)) offers.add('ru');
    if (OFFER_TH.test(bubble)) offers.add('th');
  }
  // Russian AND Thai offered is a menu, not the playbook's one offer.
  if (offers.size > 1) return 'menu';
  return [...offers][0] ?? null;
}

/** Any letter outside the Latin script (Thai, Cyrillic, Han, Arabic...). */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/** Whether the bubbles are written in the Latin script only: what an English reply to another language must be. */
export function latinScriptOnly(bubbles: readonly string[]): boolean {
  return bubbles.every((b) => !NON_LATIN_LETTER.test(b));
}

// ---------------------------------------------------------------------------
// Gate 7: bubble count, length, and chat shape (no lists, no headings).
// ---------------------------------------------------------------------------

/** Markdown structure a person at a chat desk never types (§B.4 "no bullet lists, no headings"). */
const LIST_OR_HEADING = /^\s*(?:[-*•]\s|\d+[.)]\s|#{1,6}\s)|\*\*/m;

/** A question mark in any script's form. */
const QUESTION_MARK = /[?？¿]/;

/**
 * Gate 7, and since SCRUM-220 the playbook's "one question per reply",
 * enforced mechanically: at most ONE bubble may hold a question mark (a
 * link's own query string aside). The playbook's combined questions — branch
 * and residency, or dates, headcount and branch — are one bubble, so two
 * marks inside one bubble pass. A Thai question with คะ or ไหม and no mark is
 * the prompt's rule (`ONE_QUESTION_RULE`).
 */
export function bubbleGuard(
  bubbles: readonly string[],
  min: number,
): GuardResult<'GUARD_BUBBLES' | 'GUARD_SHAPE'> {
  if (bubbles.length < min || bubbles.length > MAX_BUBBLES) {
    return { ok: false, reason: 'GUARD_BUBBLES', rule: 'count' };
  }
  let total = 0;
  let asking = 0;
  for (const b of bubbles) {
    if (b.trim().length === 0) return { ok: false, reason: 'GUARD_BUBBLES', rule: 'empty' };
    if (b.length > MAX_BUBBLE_CHARS)
      return { ok: false, reason: 'GUARD_BUBBLES', rule: 'bubble_length' };
    if (LIST_OR_HEADING.test(b)) return { ok: false, reason: 'GUARD_SHAPE', rule: 'markdown' };
    if (QUESTION_MARK.test(withoutLinks(b))) asking += 1;
    total += b.length;
  }
  if (total > MAX_TOTAL_CHARS) return { ok: false, reason: 'GUARD_BUBBLES', rule: 'total_length' };
  if (asking > 1) return { ok: false, reason: 'GUARD_SHAPE', rule: 'one_question' };
  return { ok: true };
}
