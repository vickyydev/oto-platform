/**
 * WHAT THE GATE READERS SAY, per park and language (SCRUM-1078).
 *
 * The reader at a gate shows one text per scan and nothing else, so its
 * wording is the park's to choose. This module is the one place that knows
 * the cases, the small words ("labels") around the automatic facts, their
 * built-in wording, and how one scan's answer is laid out on the reader's
 * narrow screen — so the Console's preview and the gate box draw the SAME
 * screen from the same texts.
 *
 * What an administrator changes here is WORDING only. Whether the gate opens
 * is decided on the box (`decideGate` in `@oto/box-agent`) and nothing in
 * this module is read by that decision.
 *
 * The built-in English and Thai are exactly what the gate showed before this
 * ticket (`GATE_MESSAGES` and `reader-layout.ts` in `@oto/box-agent`; a box
 * test pins the two together). The Chinese, Russian and French texts, and
 * the Thai labels, are drafts for the park's review.
 *
 * How a scan's text is drawn (`composeGateScreen`):
 *
 *   - the languages shown are the park's ordered list (default English, then
 *     Thai). Lines are shown in pairs: the first line in each language, then
 *     the second line in each language, and so on. A language with no text
 *     for a case is skipped for that case; a case with no text in any shown
 *     language falls back to its built-in English;
 *   - the automatic facts (band kind, ticket, end time, time left, credit)
 *     are not part of any text and cannot be removed. Their small words are
 *     the labels, taken from the FIRST language shown (an empty label uses
 *     the English one). `{time}` and `{amount}` mark where the value goes; a
 *     label without its mark gets the value after it;
 *   - an approval starts with the brand line and the first text line in
 *     capitals; a refusal starts on a fresh line under the refusal heading
 *     and ends in blank lines, because the reader app prints its own
 *     technical line above it and a stack trace after it;
 *   - a band whose guest chose a language at the till is shown in that
 *     language instead, with one English line under a refusal
 *     (`composeGuestGateScreen`, SCRUM-1077).
 */

import { z } from 'zod';
import { wallClockMinutesInTz } from './business-date';
import { SUPPORTED_LANGS, type SupportedLang } from './i18n/index';
import { formatTHB } from './money';

/** The languages a gate text may be written in: the customer display's five. */
export const GATE_MESSAGE_LANGS = SUPPORTED_LANGS;
export type GateMessageLang = SupportedLang;

export const GATE_MESSAGE_LANG_NAMES: Record<GateMessageLang, string> = {
  en: 'English',
  zh: 'Chinese',
  th: 'Thai',
  ru: 'Russian',
  fr: 'French',
};

/** What the gate shows in, and in which order, when a park has chosen nothing. */
export const GATE_MESSAGE_DEFAULT_LANGUAGES: readonly GateMessageLang[] = ['en', 'th'];

/**
 * Every answer the gate can give, in the order the Console lists them: the
 * two approvals, then the refusals in the order the box reaches them.
 */
export const GATE_MESSAGE_CASES = [
  'welcome',
  'goodbye',
  'NOT_A_BAND',
  'BOX_NOT_READY',
  'BAND_INVALID',
  'BAND_UNKNOWN_OFFLINE',
  'BAND_NOT_FOUND',
  'KID_BAND',
  'NO_GATE_ACCESS',
  'BAND_REVOKED',
  'ANTI_PASSBACK',
  'OVER_TIME',
  'GATE_BUSY',
  'GATE_NOT_READY',
] as const;
export type GateMessageCase = (typeof GATE_MESSAGE_CASES)[number];

export interface GateMessageCaseInfo {
  /** A short name for the case, for the Console. */
  title: string;
  /** Whether the gate opens on this answer. Fixed: a text cannot change it. */
  opens: boolean;
  /** When the gate gives this answer, in plain words (from `decideGate` and the gate host). */
  when: string;
}

export const GATE_MESSAGE_CASE_INFO: Record<GateMessageCase, GateMessageCaseInfo> = {
  welcome: {
    title: 'Welcome',
    opens: true,
    when: 'An adult wristband of this park is let in at the entrance.',
  },
  goodbye: {
    title: 'Goodbye',
    opens: true,
    when: 'A wristband is let out at the exit.',
  },
  NOT_A_BAND: {
    title: 'Not a wristband',
    opens: false,
    when: 'Something that is not an OTO wristband is scanned: a booking QR code, a voucher or a card.',
  },
  BOX_NOT_READY: {
    title: 'Gate box not set up',
    opens: false,
    when: 'The gate box has not received the park’s wristband key, so it cannot check any wristband.',
  },
  BAND_INVALID: {
    title: 'Wristband not genuine',
    opens: false,
    when: 'The code looks like a wristband but was not printed by this park: it was changed or made up.',
  },
  BAND_UNKNOWN_OFFLINE: {
    title: 'Unknown wristband, no internet',
    opens: false,
    when: 'The gate box has not seen this wristband and cannot reach the system to ask, because the internet is down.',
  },
  BAND_NOT_FOUND: {
    title: 'Wristband not found',
    opens: false,
    when: 'The gate box asked the system and the wristband is not on the park’s list of wristbands in play.',
  },
  KID_BAND: {
    title: 'Kid’s wristband',
    opens: false,
    when: 'A kid’s wristband is scanned, at the entrance or the exit. Kids’ wristbands never open the gate.',
  },
  NO_GATE_ACCESS: {
    title: 'Ticket without gate access',
    opens: false,
    when: 'An adult wristband whose ticket has Gate access switched off is scanned, at the entrance or the exit.',
  },
  BAND_REVOKED: {
    title: 'Refunded or replaced wristband',
    opens: false,
    when: 'A wristband that was refunded or replaced is scanned at the entrance. At the exit it is still let out.',
  },
  ANTI_PASSBACK: {
    title: 'Already inside',
    opens: false,
    when: 'The same wristband is scanned at the entrance a second time while it is still inside.',
  },
  OVER_TIME: {
    title: 'Play time ended',
    opens: false,
    when: 'The wristband’s play time has ended, at the entrance or the exit. The guest is sent to the cashier.',
  },
  GATE_BUSY: {
    title: 'Gate busy',
    opens: false,
    when: 'The gate is still waiting for the guest before to pass, or this wristband is being let through at another gate.',
  },
  GATE_NOT_READY: {
    title: 'Gate not ready',
    opens: false,
    when: 'The gate cannot open right now: the barrier did not answer, cannot report a passage, or the reader is not set up on this gate.',
  },
};

/** The small words around the automatic facts, in the order the Console lists them. */
export const GATE_MESSAGE_LABELS = [
  'brand',
  'attention',
  'adult',
  'kid',
  'until',
  'left',
  'comeBackBefore',
  'ended',
  'credit',
] as const;
export type GateMessageLabel = (typeof GATE_MESSAGE_LABELS)[number];

export const GATE_MESSAGE_LABEL_INFO: Record<GateMessageLabel, { title: string; when: string }> = {
  brand: { title: 'Brand line', when: 'The first line of every approval.' },
  attention: { title: 'Refusal heading', when: 'The heading of every refusal.' },
  adult: { title: 'Adult', when: 'Beside the ticket of an adult wristband.' },
  kid: { title: 'Kid', when: 'Beside the ticket of a kid’s wristband.' },
  until: { title: 'Until', when: 'When the play time ends, at the entrance. {time} is the clock time.' },
  left: { title: 'Time left', when: 'How much play time is left. {time} is the time left.' },
  comeBackBefore: {
    title: 'Come back before',
    when: 'When the play time ends, for a guest who is let out. {time} is the clock time.',
  },
  ended: { title: 'Time ended', when: 'A wristband whose play time has ended. {time} is the clock time.' },
  credit: { title: 'Credit', when: 'The wristband’s credit, on an approval. {amount} is the amount.' },
};

/** The placeholder each label carries its value in. */
export const GATE_MESSAGE_LABEL_SLOT: Partial<Record<GateMessageLabel, '{time}' | '{amount}'>> = {
  until: '{time}',
  left: '{time}',
  comeBackBefore: '{time}',
  ended: '{time}',
  credit: '{amount}',
};

/** The longest text the platform stores for one case in one language. */
export const GATE_MESSAGE_TEXT_MAX = 200;
/** The longest label the platform stores. */
export const GATE_MESSAGE_LABEL_MAX = 40;

type ByLang = Record<GateMessageLang, string>;

const same = (text: string): ByLang => ({ en: text, zh: text, th: text, ru: text, fr: text });

// DRAFT: the zh, ru and fr texts below are new wording for the park's review.
// English and Thai are the gate's wording before SCRUM-1078, unchanged.
const SEE_RECEPTION: ByLang = {
  en: 'Please see reception',
  zh: '请到前台咨询',
  th: 'กรุณาติดต่อเคาน์เตอร์',
  ru: 'Обратитесь на ресепшн',
  fr: 'Adressez-vous à l’accueil',
};
const NOT_VALID_SEE_RECEPTION: ByLang = {
  en: 'Band not valid, see reception',
  zh: '手环无效，请到前台咨询',
  th: 'สายรัดข้อมือใช้ไม่ได้ กรุณาติดต่อเคาน์เตอร์',
  ru: 'Браслет недействителен, обратитесь на ресепшн',
  fr: 'Bracelet non valide, adressez-vous à l’accueil',
};

export const GATE_MESSAGE_DEFAULT_CASES: Record<GateMessageCase, ByLang> = {
  welcome: { en: 'Welcome', zh: '欢迎', th: 'ยินดีต้อนรับ', ru: 'Добро пожаловать', fr: 'Bienvenue' },
  goodbye: {
    en: 'Thank you\nSee you again',
    zh: '谢谢\n欢迎再来',
    th: 'ขอบคุณ\nแล้วพบกันใหม่',
    ru: 'Спасибо\nДо новых встреч',
    fr: 'Merci\nÀ bientôt',
  },
  NOT_A_BAND: {
    en: 'Scan your wristband',
    zh: '请扫描您的手环',
    th: 'สแกนสายรัดข้อมือ',
    ru: 'Отсканируйте браслет',
    fr: 'Scannez votre bracelet',
  },
  BOX_NOT_READY: SEE_RECEPTION,
  BAND_INVALID: {
    en: 'Band not valid',
    zh: '手环无效',
    th: 'สายรัดข้อมือไม่ถูกต้อง',
    ru: 'Браслет недействителен',
    fr: 'Bracelet non valide',
  },
  BAND_UNKNOWN_OFFLINE: SEE_RECEPTION,
  BAND_NOT_FOUND: NOT_VALID_SEE_RECEPTION,
  KID_BAND: {
    en: 'Adult band please. Kids enter with their adult',
    zh: '请使用成人手环。儿童请随成人进入',
    th: 'กรุณาใช้สายรัดผู้ใหญ่',
    ru: 'Нужен взрослый браслет. Дети проходят со взрослым',
    fr: 'Bracelet adulte, s’il vous plaît. Les enfants entrent avec leur adulte',
  },
  NO_GATE_ACCESS: NOT_VALID_SEE_RECEPTION,
  BAND_REVOKED: NOT_VALID_SEE_RECEPTION,
  ANTI_PASSBACK: {
    en: 'Already entered',
    zh: '已经入场',
    th: 'สายรัดนี้เข้าแล้ว',
    ru: 'Уже вошли',
    fr: 'Déjà entré',
  },
  OVER_TIME: {
    en: 'Your play time has ended. Please see the cashier.',
    zh: '您的游玩时间已结束，请到收银台',
    // No Thai yet (SCRUM-68): the gate shows the other languages.
    th: '',
    ru: 'Ваше время игры закончилось. Обратитесь в кассу.',
    fr: 'Votre temps de jeu est terminé. Merci de passer à la caisse.',
  },
  GATE_BUSY: {
    en: 'Please wait',
    zh: '请稍候',
    th: 'กรุณารอสักครู่',
    ru: 'Пожалуйста, подождите',
    fr: 'Veuillez patienter',
  },
  GATE_NOT_READY: {
    en: 'Gate not ready, see reception',
    zh: '闸门未就绪，请到前台咨询',
    th: 'ประตูยังไม่พร้อม กรุณาติดต่อเคาน์เตอร์',
    ru: 'Турникет не готов, обратитесь на ресепшн',
    fr: 'Portillon pas prêt, adressez-vous à l’accueil',
  },
};

// DRAFT: every label but the English is new wording for the park's review.
export const GATE_MESSAGE_DEFAULT_LABELS: Record<GateMessageLabel, ByLang> = {
  brand: same('OTO PLAY PARK'),
  attention: { en: 'ATTENTION', zh: '请注意', th: 'โปรดทราบ', ru: 'ВНИМАНИЕ', fr: 'ATTENTION' },
  adult: { en: 'Adult', zh: '成人', th: 'ผู้ใหญ่', ru: 'Взрослый', fr: 'Adulte' },
  kid: { en: 'Kid', zh: '儿童', th: 'เด็ก', ru: 'Ребёнок', fr: 'Enfant' },
  until: {
    en: 'until {time}',
    zh: '至 {time}',
    th: 'ถึง {time}',
    ru: 'до {time}',
    fr: 'jusqu’à {time}',
  },
  left: {
    en: '{time} left',
    zh: '剩余 {time}',
    th: 'เหลือ {time}',
    ru: 'осталось {time}',
    fr: 'reste {time}',
  },
  comeBackBefore: {
    en: 'come back before {time}',
    zh: '请在 {time} 前返回',
    th: 'กลับมาก่อน {time}',
    ru: 'вернитесь до {time}',
    fr: 'revenez avant {time}',
  },
  ended: {
    en: 'ended {time}',
    zh: '{time} 已结束',
    th: 'หมดเวลา {time}',
    ru: 'время вышло {time}',
    fr: 'terminé à {time}',
  },
  credit: {
    en: 'Credit {amount}',
    zh: '余额 {amount}',
    th: 'เครดิต {amount}',
    ru: 'Баланс {amount}',
    fr: 'Crédit {amount}',
  },
};

/** One park's gate wording, every case and label in every language. */
export interface GateMessageTexts {
  languages: GateMessageLang[];
  cases: Record<GateMessageCase, ByLang>;
  labels: Record<GateMessageLabel, ByLang>;
}

/** The built-in wording, as a fresh copy. */
export function defaultGateMessages(): GateMessageTexts {
  const copy = <K extends string>(from: Record<K, ByLang>): Record<K, ByLang> =>
    Object.fromEntries(Object.entries(from).map(([k, v]) => [k, { ...(v as ByLang) }])) as Record<K, ByLang>;
  return {
    languages: [...GATE_MESSAGE_DEFAULT_LANGUAGES],
    cases: copy(GATE_MESSAGE_DEFAULT_CASES),
    labels: copy(GATE_MESSAGE_DEFAULT_LABELS),
  };
}

// --- Cleaning what an administrator typed -------------------------------------

/**
 * A text as the platform keeps it: line breaks as `\n`, every other control
 * character removed (a tab becomes a space), runs of spaces made one, spaces at the ends of each line and blank lines at the
 * ends of the text dropped. Labels are one line: a line break becomes a space.
 */
export function cleanGateText(raw: string, oneLine = false): string {
  const unified = raw.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const stripped = unified.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u200B\u2028\u2029]/g, '');
  const lines = stripped.split('\n').map((line) => line.replace(/ {2,}/g, ' ').trim());
  const text = oneLine ? lines.join(' ').replace(/ {2,}/g, ' ') : lines.join('\n');
  return text.replace(/^\n+|\n+$/g, '').trim();
}

// --- The wire: what a gate box is sent -------------------------------------------

/**
 * Read the texts a box was sent (`gateMessages` in its config bundle), or
 * null when there is nothing usable. Tolerant by design: a case, label or
 * language this release does not know is ignored, one it knows but was not
 * sent keeps its built-in wording, and anything that is not text is left
 * out — a box is updated on its own schedule and must never refuse its
 * configuration over wording.
 */
export function readGateMessagesWire(value: unknown): GateMessageTexts | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { languages?: unknown; cases?: unknown; labels?: unknown };
  if (!Array.isArray(v.languages)) return null;
  const languages: GateMessageLang[] = [];
  for (const lang of v.languages) {
    if ((GATE_MESSAGE_LANGS as readonly unknown[]).includes(lang) && !languages.includes(lang as GateMessageLang)) {
      languages.push(lang as GateMessageLang);
    }
  }
  if (languages.length === 0) return null;
  const out = defaultGateMessages();
  out.languages = languages;
  const take = <K extends string>(
    sent: unknown,
    keys: readonly K[],
    into: Record<K, ByLang>,
    max: number,
    oneLine: boolean,
  ): void => {
    if (!sent || typeof sent !== 'object') return;
    for (const key of keys) {
      const row = (sent as Record<string, unknown>)[key];
      if (!row || typeof row !== 'object') continue;
      for (const lang of GATE_MESSAGE_LANGS) {
        const text = (row as Record<string, unknown>)[lang];
        if (typeof text === 'string') into[key][lang] = cleanGateText(text, oneLine).slice(0, max);
      }
    }
  };
  take(v.cases, GATE_MESSAGE_CASES, out.cases, GATE_MESSAGE_TEXT_MAX, false);
  take(v.labels, GATE_MESSAGE_LABELS, out.labels, GATE_MESSAGE_LABEL_MAX, true);
  return out;
}

// --- The reader's screen ------------------------------------------------------------

/**
 * The reader's screen as measured at the park (26 November 2026): a narrow
 * column of about 15 characters a line and about 17 lines.
 */
export const GATE_READER_SCREEN = { width: 15, lines: 17 } as const;

/** The reader app's own line above every refusal; our reply cannot remove it. */
export const GATE_READER_APP_ERROR_LINE = 'java.lang.Exception: ';

/** A dashed line. A line of box-drawing strokes showed as one short dash on the reader. */
export const GATE_READER_RULE = '— — — — —';

/** Blank lines after a refusal, so the reader app's stack trace falls below the screen. */
export const GATE_READER_REFUSAL_PADDING_LINES = 14;

export type BandKindWord = 'adult' | 'kid';

/** What the box knows about the scanned band, for the facts under the text. */
export interface GateScreenFacts {
  kind?: BandKindWord;
  ticketLabel?: string;
  /** When the band's play ends, epoch ms. */
  validUntil?: number;
  creditSatang?: number;
  /** The box's corrected clock. */
  now: number;
  /** The branch's zone, for the clock time; absent, only the time left is shown. */
  timezone?: string;
}

export type GateScreenPart = 'kind' | 'ticket' | 'time' | 'credit';

/** Which facts each answer carries, as the gate host decides them (SCRUM-68). */
export const GATE_SCREEN_PARTS: Record<GateMessageCase, readonly GateScreenPart[]> = {
  welcome: ['kind', 'ticket', 'time', 'credit'],
  goodbye: ['kind', 'ticket', 'time', 'credit'],
  NOT_A_BAND: [],
  BOX_NOT_READY: [],
  BAND_INVALID: [],
  BAND_UNKNOWN_OFFLINE: [],
  BAND_NOT_FOUND: [],
  KID_BAND: ['ticket', 'time'],
  NO_GATE_ACCESS: [],
  BAND_REVOKED: [],
  ANTI_PASSBACK: [],
  OVER_TIME: ['ticket', 'time'],
  GATE_BUSY: [],
  GATE_NOT_READY: [],
};

function lines(text: string | undefined): string[] {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The case's text lines in the shown languages, paired line by line. */
export function gateMessageLines(texts: GateMessageTexts, key: GateMessageCase): string[] {
  const perLanguage = texts.languages.map((lang) => lines(texts.cases[key]?.[lang]));
  const out: string[] = [];
  const longest = Math.max(0, ...perLanguage.map((l) => l.length));
  for (let i = 0; i < longest; i += 1) {
    for (const list of perLanguage) if (list[i] !== undefined) out.push(list[i]!);
  }
  return out.length ? out : lines(GATE_MESSAGE_DEFAULT_CASES[key].en);
}

/** A label in the first shown language; an empty one uses the English, then the built-in English. */
export function gateMessageLabel(texts: GateMessageTexts, key: GateMessageLabel): string {
  const first = texts.languages[0] ?? 'en';
  const pick = (text: string | undefined) => cleanGateText(text ?? '', true);
  return pick(texts.labels[key]?.[first]) || pick(texts.labels[key]?.en) || GATE_MESSAGE_DEFAULT_LABELS[key].en;
}

/** A label with its value in its place; without a place, the value follows the label. */
export function fillGateLabel(label: string, value: string | null): string {
  const slot = /\{(time|amount)\}/;
  if (value === null) return label.replace(slot, '').replace(/\s{2,}/g, ' ').trim();
  return slot.test(label) ? label.replace(slot, value) : `${label} ${value}`.trim();
}

function clock(instant: number, timezone: string): string | null {
  try {
    const minutes = wallClockMinutesInTz(new Date(instant), timezone);
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

/** "1 h 20 min", "45 min", "2 h" — as `screen.ts` in `@oto/box-agent` words it. */
function span(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const icon = (symbol: string, text: string): string => `${symbol} ${text}`;

/** The fact lines under the text, with their icons, or none. */
function factLines(
  texts: GateMessageTexts,
  key: GateMessageCase,
  facts: GateScreenFacts | undefined,
): string[] {
  if (!facts) return [];
  const show = GATE_SCREEN_PARTS[key];
  const leaving = key === 'goodbye';
  const out: string[] = [];
  const ticket = facts.ticketLabel?.trim();
  if (ticket && show.includes('ticket')) {
    if (facts.kind && show.includes('kind')) out.push(icon('👤', gateMessageLabel(texts, facts.kind)));
    out.push(icon('🎟', ticket));
  }
  if (show.includes('time') && facts.validUntil !== undefined && Number.isFinite(facts.validUntil)) {
    const at = facts.timezone ? clock(facts.validUntil, facts.timezone) : null;
    if (facts.now > facts.validUntil) {
      out.push(icon('⏰', fillGateLabel(gateMessageLabel(texts, 'ended'), at)));
    } else {
      if (at) {
        out.push(icon('⏰', fillGateLabel(gateMessageLabel(texts, leaving ? 'comeBackBefore' : 'until'), at)));
      }
      const left = span(Math.ceil((facts.validUntil - facts.now) / 60_000));
      out.push(icon('⏳', fillGateLabel(gateMessageLabel(texts, 'left'), left)));
    }
  }
  if (show.includes('credit') && facts.creditSatang !== undefined && facts.creditSatang >= 0) {
    out.push(icon('💰', fillGateLabel(gateMessageLabel(texts, 'credit'), formatTHB(facts.creditSatang))));
  }
  return out;
}

/**
 * The text the reader is sent for one answer: the case's text in the shown
 * languages and the facts the box knows, laid out for the reader's screen.
 * With the built-in wording this is exactly what the gate showed before
 * SCRUM-1078 (`readerScreen` in `@oto/box-agent`, pinned by a box test).
 */
export function composeGateScreen(
  texts: GateMessageTexts,
  key: GateMessageCase,
  facts?: GateScreenFacts,
): string {
  const text = gateMessageLines(texts, key);
  const details = factLines(texts, key, facts);
  const below = details.length ? [GATE_READER_RULE, ...details] : [];
  if (GATE_MESSAGE_CASE_INFO[key].opens) {
    const [first = '', ...rest] = text;
    const heading = icon(key === 'goodbye' ? '👋' : '✅', first.toUpperCase());
    return [gateMessageLabel(texts, 'brand'), heading, ...rest, ...below].join('\n');
  }
  return (
    ['', '', icon('⚠️', gateMessageLabel(texts, 'attention')), GATE_READER_RULE, ...text, ...below].join('\n') +
    '\n'.repeat(GATE_READER_REFUSAL_PADDING_LINES)
  );
}

/**
 * SCRUM-1077 — THE SCREEN FOR A BAND WHOSE GUEST CHOSE A LANGUAGE AT THE TILL
 * (`guestLanguage` on its `bands` row, `guest-language.ts`):
 *
 *   - the case's text in that language only, and the small words around the
 *     facts in it too (`gateMessageLabel` reads the first language shown);
 *   - a refusal adds one line in English under that text, so staff at the
 *     gate can read why; none when the guest chose English;
 *   - no Thai line is added for a guest who chose another language;
 *   - the park's wording for that language when it has some for this case,
 *     else the built-in text for that language, and a label likewise (then the
 *     English one). With no text for the case in that language at all (the
 *     built-in Thai for OVER_TIME is empty) the answer is null: the caller
 *     lays the screen out in the park's own list of languages, as for a band
 *     with no language. The screen is never empty.
 *
 * `texts` is the park's wording, or null when the park changed nothing (the
 * built-in wording is used then). Wording only: whether the gate opens is
 * decided before this and nothing here is read by that decision.
 */
export function composeGuestGateScreen(
  texts: GateMessageTexts | null,
  key: GateMessageCase,
  language: GateMessageLang,
  facts?: GateScreenFacts,
): string | null {
  const wording = texts ?? defaultGateMessages();
  const own = lines(wording.cases[key]?.[language]);
  const text = own.length ? own : lines(GATE_MESSAGE_DEFAULT_CASES[key][language]);
  if (text.length === 0) return null;
  const english = GATE_MESSAGE_CASE_INFO[key].opens || language === 'en' ? null : gateStaffLine(wording, key);
  const staffLine = english && english !== text.join(' ') ? english : null;
  const label = (k: GateMessageLabel): ByLang => {
    const row = wording.labels[k] ?? GATE_MESSAGE_DEFAULT_LABELS[k];
    const mine = cleanGateText(row[language] ?? '', true);
    return { ...row, [language]: mine || GATE_MESSAGE_DEFAULT_LABELS[k][language] };
  };
  const shown: GateMessageTexts = {
    languages: [language],
    cases: {
      ...wording.cases,
      [key]: { ...wording.cases[key], [language]: [...text, ...(staffLine ? [staffLine] : [])].join('\n') },
    },
    labels: Object.fromEntries(GATE_MESSAGE_LABELS.map((k) => [k, label(k)])) as Record<GateMessageLabel, ByLang>,
  };
  return composeGateScreen(shown, key, facts);
}

/** A case's English text as one line, for staff under a refusal: the park's, else the built-in. */
function gateStaffLine(texts: GateMessageTexts, key: GateMessageCase): string {
  const own = lines(texts.cases[key]?.en);
  return (own.length ? own : lines(GATE_MESSAGE_DEFAULT_CASES[key].en)).join(' ');
}

/** How wide a line is on the reader, roughly: Thai marks take no room, an emoji two. */
function width(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E\uFE0F\u200D]/.test(ch)) continue;
    n += /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return n;
}

/** How many reader lines one line takes, wrapped at word breaks. */
function wrapped(line: string, columns: number): number {
  if (!line.trim()) return 1;
  let count = 1;
  let used = 0;
  for (const word of line.split(/\s+/).filter(Boolean)) {
    const w = width(word);
    const need = used === 0 ? w : used + 1 + w;
    if (need <= columns) {
      used = need;
      continue;
    }
    if (used > 0) count += 1;
    count += Math.max(0, Math.ceil(w / columns) - 1);
    used = w % columns || (w > 0 ? columns : 0);
  }
  return count;
}

/** A screen as the Console previews it: the lines the reader shows, and how many it takes. */
export interface GateScreenPreview {
  /** For a refusal, the first line is the reader app's own technical line. */
  lines: string[];
  /** Reader lines after wrapping at `GATE_READER_SCREEN.width`. */
  count: number;
  /** More than `GATE_READER_SCREEN.lines`: the end will not be seen. */
  tooLong: boolean;
}

export function previewGateScreen(screen: string, key: GateMessageCase): GateScreenPreview {
  const all = screen.replace(/\n+$/, '').split('\n');
  // A refusal's text follows the app's own line on the same line: its first
  // (empty) line is the rest of that one.
  const shown = GATE_MESSAGE_CASE_INFO[key].opens ? all : [GATE_READER_APP_ERROR_LINE.trim(), ...all.slice(1)];
  const count = shown.reduce((n, line) => n + wrapped(line, GATE_READER_SCREEN.width), 0);
  return { lines: shown, count, tooLong: count > GATE_READER_SCREEN.lines };
}

// --- The api's shapes ----------------------------------------------------------------

const LangSchema = z.enum(GATE_MESSAGE_LANGS);
const CaseSchema = z.enum(GATE_MESSAGE_CASES);
const LabelSchema = z.enum(GATE_MESSAGE_LABELS);

const TextsByLang = (max: number) => z.record(LangSchema, z.string().max(max * 2));

export const GateMessageLanguagesSchema = z
  .array(LangSchema)
  .min(1)
  .max(GATE_MESSAGE_LANGS.length)
  .refine((list) => new Set(list).size === list.length, { message: 'A language is listed twice' });

/** Every case and label in every language: the effective wording, or the defaults. */
export const GateMessageTextsSchema = z.object({
  languages: z.array(LangSchema),
  cases: z.record(CaseSchema, z.record(LangSchema, z.string())),
  labels: z.record(LabelSchema, z.record(LangSchema, z.string())),
});

/**
 * PUT: the wording the park wants. What equals the built-in wording is not
 * stored, so "Reset to default" is sending the default back. A case, label or
 * language left out keeps the built-in wording. Lengths are checked after
 * cleaning (`cleanGateText`), against `GATE_MESSAGE_TEXT_MAX` and
 * `GATE_MESSAGE_LABEL_MAX`.
 */
export const GateMessagesWriteSchema = z.object({
  languages: GateMessageLanguagesSchema,
  cases: z.record(CaseSchema, TextsByLang(GATE_MESSAGE_TEXT_MAX)).optional(),
  labels: z.record(LabelSchema, TextsByLang(GATE_MESSAGE_LABEL_MAX)).optional(),
});
export type GateMessagesWrite = z.infer<typeof GateMessagesWriteSchema>;

export const GateMessagesReadSchema = z.object({
  branchId: z.string().uuid(),
  /** What the gate shows: the built-in wording with the park's changes over it. */
  texts: GateMessageTextsSchema,
  /** The built-in wording, for "Reset to default". */
  defaults: GateMessageTextsSchema,
  /** How many texts and settings the park has changed; 0 means the gate shows the built-in wording. */
  changed: z.number().int().min(0),
  updatedAt: z.string().nullable(),
});
export type GateMessagesRead = z.infer<typeof GateMessagesReadSchema>;
