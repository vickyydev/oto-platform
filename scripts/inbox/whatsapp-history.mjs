#!/usr/bin/env node
// Seed the customer assistant's EXAMPLES from the park's own WhatsApp Business
// chat history (SCRUM-220). Local tooling: the chats and every file this
// writes stay under imports/whatsapp-history/, which git ignores. Only the
// tool is committed.
//
//   node scripts/inbox/whatsapp-history.mjs parse [dir] [--business "Name"]
//   node scripts/inbox/whatsapp-history.mjs select [dir] [--target 30] [--max-pairs 300] [--api <origin>]
//   node scripts/inbox/whatsapp-history.mjs load [dir] --api <origin> [--prefix /api] [--as ADMIN] [--dry-run]
//
// parse   reads every .txt export (and every .zip holding one) under the
//         folder, both the Android and the iPhone format, pairs each customer
//         turn with the business's reply, DE-IDENTIFIES both before anything
//         is written, and writes pairs.json.
// select  sends the de-identified pairs to Claude in batches for intent,
//         language, verdict, a quality score and a cleaned reply in the
//         business's voice, keeps the best ~target (at most 2 per intent and
//         language), and writes selected.json plus kb-gaps.md — facts staff
//         kept telling customers that the knowledge base may lack, as
//         suggestions only. Needs ANTHROPIC_API_KEY (never printed).
// load    signs in (STAGING_<AS>_PHONE / STAGING_<AS>_PASSWORD from the
//         environment or the repo-root .env) and posts selected.json to
//         POST /inbox/ai/examples/import in chunks of at most 50. Every
//         example lands PROPOSED: a person reviews and approves each one in
//         Settings → Assistant → Examples before the assistant uses it.
//
// Nothing here prints a chat's words, a customer's name, a phone number or a
// secret: only counts, the business's own name, and error codes.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DIR = join(ROOT, 'imports', 'whatsapp-history');
export const MODEL = 'claude-opus-5-5';
const IMPORT_CHUNK = 50;

// --- The vocabulary, read from the source that owns it ----------------------------------------

/** A `export const NAME = [ 'a', 'b' ] as const;` list out of a TypeScript source, without compiling it. */
function constList(file, name) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const m = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(text);
  if (!m) throw new Error(`${name} not found in ${file}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
export const AI_INTENTS = constList('packages/assistant/src/intents.ts', 'AI_INTENTS');
export const KB_TOPICS = constList('packages/shared/src/inbox-ai.ts', 'INBOX_KB_TOPICS');
export const VERDICTS = constList('packages/shared/src/inbox-ai.ts', 'INBOX_AI_EXAMPLE_VERDICTS');
export const LANGUAGES = constList('packages/shared/src/inbox-ai.ts', 'INBOX_AI_CONTENT_LANGUAGES');

// --- The personal-data shapes ----------------------------------------------------------------
//
// A copy of the platform's screen (apps/api/src/services/inbox/personal-data.ts):
// the import route refuses an example that still matches one of these, so the
// tool replaces them first and drops a pair that still holds one. The test
// runs the screen's own cases. Change both together.

const PHONE_LIKE_SRC = String.raw`\+\d(?:[\s().-]{0,2}\d){7,}|(?<!\d)0(?:[\s().-]{0,2}\d){8,}|\d{8,}`;
const EMAIL_SRC = String.raw`[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}`;
const QUERY_URL_SRC = String.raw`\b(?:https?:\/\/|www\.)[^\s?#]*\?[^\s#]*=[^\s]*`;
const HANDLE_SRC = String.raw`\b(line(?:\s*id)?|ig|instagram|telegram|tg|wechat|whatsapp)(\s*[:：]\s*)@?[\w.-]{2,}`;

const SCREEN = [
  [new RegExp(EMAIL_SRC, 'i'), 'an e-mail address'],
  [new RegExp(QUERY_URL_SRC, 'i'), 'a web address with a query string'],
  [new RegExp(HANDLE_SRC, 'i'), 'a messaging handle'],
  [new RegExp(PHONE_LIKE_SRC), 'a phone number or another long number'],
];

/** The kind of personal data `text` still seems to hold, or null — the platform's screen, said again. */
export function screen(text) {
  if (!text) return null;
  const plain = asciiDigits(text);
  for (const [pattern, kind] of SCREEN) if (pattern.test(plain)) return kind;
  return null;
}

/** Thai digits (\u0e50-\u0e59) as the ASCII digits they are, so a number written in Thai is caught too. */
export const asciiDigits = (text) => text.replace(/[\u0e50-\u0e59]/g, (d) => String(d.charCodeAt(0) - 0x0e50));

/** A run of ten or more digits however it is broken up: a number the replacements missed. */
const LEFTOVER_DIGITS = /\d(?:[^\p{L}\d\n]?\d){9,}/u;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isThai = (s) => /[\u0e00-\u0e7f]/.test(s);

/** Replace one name wherever it stands as a word (a substring, for Thai, which has no word spaces). */
function replaceName(text, name) {
  if (!name || [...name].length < 2) return text;
  if (isThai(name)) return text.split(name).join('[name]');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name)}(?![\\p{L}\\p{N}])`, 'giu'), '[name]');
}

/** A word whose first letter may be either case — the name rules below cannot use the `i` flag, which would let `\p{Lu}` match lower case. */
const either = (word) => `[${word[0].toUpperCase()}${word[0].toLowerCase()}]${escapeRe(word.slice(1))}`;
const NAME = String.raw`\p{Lu}[\p{Ll}'-]+(?:\s+\p{Lu}[\p{Ll}'-]+)?`;
const SIGN_OFF = new RegExp(
  String.raw`((?<!\p{L})(?:${['thanks', 'thank you', 'thx', 'regards', 'best regards', 'kind regards', 'cheers', 'спасибо', 'с уважением'].map(either).join('|')})[,!.]?\s+)` +
    String.raw`(${NAME})\s*[.!]?\s*$`,
  'mu',
);
const INTRODUCED = new RegExp(
  String.raw`((?<!\p{L})(?:${['my name is', "my name's", 'меня зовут'].map(either).join('|')})\s+)(${NAME})` +
    String.raw`|((?<!\p{L})(?:${['this is', "i'm", 'i am'].map(either).join('|')})\s+)(${NAME})(?=\s+(?:from|here|speaking)(?!\p{L}))`,
  'gu',
);
const DASH_SIGNATURE = /(^|\n)\s*[-–—~]\s*\p{Lu}[\p{Ll}'-]+(?:\s+\p{Lu}[\p{Ll}'-]+)?\s*$/u;

/**
 * Take a turn's personal data out, BEFORE anything is written: the names the
 * customer goes by (their display name, each part of it, a name they sign or
 * introduce themselves with), phone-like numbers, e-mails, links carrying a
 * query string, and messaging handles. What a name looks like in a sentence
 * is guessed, not known — which is why every example is still reviewed by a
 * person before the assistant may use it.
 */
export function deidentify(text, names = []) {
  let out = asciiDigits(text);
  const parts = new Set();
  for (const n of names) {
    if (!n) continue;
    const clean = n.replace(/[\u200e\u200f\u202a-\u202e~]/g, '').trim();
    if (!clean || /^\+?[\d\s().-]+$/.test(clean)) continue; // a number as a display name: the phone rule covers it
    parts.add(clean);
    for (const p of clean.split(/\s+/)) if ([...p].length >= 2) parts.add(p);
  }
  // Addresses first, whole — a name inside one (anna.p@…) must not split it.
  out = out
    .replace(new RegExp(EMAIL_SRC, 'gi'), '[email]')
    .replace(new RegExp(QUERY_URL_SRC, 'gi'), '[link]')
    .replace(new RegExp(HANDLE_SRC, 'gi'), (_m, kind, sep) => `${kind}${sep}[handle]`)
    .replace(/(^|[\s(])@[\w.]{3,}/g, '$1[handle]')
    .replace(new RegExp(PHONE_LIKE_SRC, 'g'), '[phone]');
  for (const p of [...parts].sort((a, b) => b.length - a.length)) out = replaceName(out, p);
  out = out
    .replace(INTRODUCED, (_m, lead, _n, lead2) => `${lead ?? lead2}[name]`)
    .replace(SIGN_OFF, (_m, lead) => `${lead}[name]`)
    .replace(DASH_SIGNATURE, '$1- [name]');
  return out;
}

/** Thai letters → th, Cyrillic → ru, otherwise en. */
export function guessLanguage(text) {
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  return 'en';
}

// --- Reading an export ------------------------------------------------------------------------

// Android: "27/10/2026, 14:05 - Name: text", "27/10/26, 2:05 pm - Name: text".
const ANDROID = /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),? (\d{1,2}[:.]\d{2})(?:[ \u202f\u00a0]?([ap]\.?\s?m\.?))? - (.*)$/i;
// iPhone: "[27/10/2026, 14:05:33] Name: text", "[27/10/26, 2:05:33 PM] Name: text".
const IPHONE = /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),? (\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)(?:[ \u202f\u00a0]?([ap]\.?\s?m\.?))?\] (.*)$/i;

/** Lines that are not anybody's words: media placeholders, deletions, calls, shares. */
const DROPPED = [
  /^<media omitted>$/i,
  /^<attached: .*>$/i,
  /^(?:image|video|audio|sticker|gif|document|contact card|voice message|video note) omitted$/i,
  /^.*\bomitted$/i,
  /^this message was deleted\.?$/i,
  /^you deleted this message\.?$/i,
  /^missed (?:voice|video) call/i,
  /^(?:voice|video) call\b/i,
  /^location: /i,
  /^live location shared$/i,
  /^poll:/i,
  /^null$/i,
  /^messages and calls are end-to-end encrypted/i,
  /^this (?:business uses a secure service|chat is with a business account)/i,
  /^<ไม่รวมสื่อ>$/,
  /^ข้อความนี้ถูกลบ/,
  /^<без медиафайлов>$/i,
  /^данное сообщение удалено\.?$/i,
];
const EDITED = /\s*<This message was edited>\s*$/i;

/**
 * One export's messages, oldest first: `{ name, text }`. A line that does not
 * open a message continues the one before it; system lines (no "Name: ") and
 * media placeholders are dropped.
 */
export function parseChat(raw) {
  const out = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const text = current.text.replace(EDITED, '').trim();
    if (text && !DROPPED.some((re) => re.test(text))) out.push({ name: current.name, text });
    current = null;
  };
  for (const rawLine of raw.replace(/^\ufeff/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/^[\u200e\u200f\u202a-\u202e]+/, '');
    const m = ANDROID.exec(line) ?? IPHONE.exec(line);
    if (!m) {
      if (current) current.text += `\n${rawLine}`;
      continue;
    }
    flush();
    const rest = m[4].replace(/^[\u200e\u200f]+/, '');
    const sep = rest.indexOf(': ');
    // A system line: no "Name: " (Android: "Messages and calls are end-to-end
    // encrypted", "X joined"), or \u2014 the iPhone's way \u2014 a text that opens with
    // an invisible left-to-right mark ("\u200eimage omitted", the encryption notice
    // under the contact's own name).
    if (sep <= 0 || rest.charAt(sep + 2) === '\u200e') continue;
    current = {
      name: rest.slice(0, sep).replace(/[\u200e\u200f\u202a-\u202e~]/g, '').trim(),
      text: rest.slice(sep + 2).replace(/^[\u200e\u200f]+/, ''),
    };
  }
  flush();
  return out;
}

/**
 * The business: the participant who appears in the most chats (an export is
 * one customer's chat, so the business is in every one), then the one with
 * the most messages. `--business` overrides it.
 */
export function guessBusiness(chats) {
  const seen = new Map();
  for (const chat of chats) {
    const names = new Set(chat.map((m) => m.name));
    for (const n of names) {
      const s = seen.get(n) ?? { chats: 0, messages: 0 };
      s.chats += 1;
      seen.set(n, s);
    }
    for (const m of chat) seen.get(m.name).messages += 1;
  }
  return [...seen.entries()].sort((a, b) => b[1].chats - a[1].chats || b[1].messages - a[1].messages)[0]?.[0] ?? null;
}

/**
 * Consecutive lines of one side make a turn; a customer turn followed by the
 * business's turn makes a pair. Both are de-identified here — the customer's
 * display names (every customer in the chat) are what is taken out first.
 * A pair that still holds a personal-data shape, or a long run of digits, is
 * dropped rather than written.
 */
export function toPairs(chat, business) {
  const customers = [...new Set(chat.map((m) => m.name))].filter((n) => n !== business);
  const turns = [];
  for (const m of chat) {
    const side = m.name === business ? 'business' : 'customer';
    const last = turns[turns.length - 1];
    if (last && last.side === side) last.text += `\n${m.text}`;
    else turns.push({ side, text: m.text });
  }
  const pairs = [];
  let dropped = 0;
  for (let i = 0; i + 1 < turns.length; i += 1) {
    if (turns[i].side !== 'customer' || turns[i + 1].side !== 'business') continue;
    const customer = deidentify(turns[i].text, customers).trim();
    const reply = deidentify(turns[i + 1].text, customers).trim();
    if (!customer || !reply) continue;
    if ([customer, reply].some((t) => screen(t) || LEFTOVER_DIGITS.test(t))) {
      dropped += 1;
      continue;
    }
    pairs.push({ language: guessLanguage(customer + reply), customer, reply });
  }
  return { pairs, dropped };
}

/** The `.txt` entries of a zip (stored or deflated; no zip64), with node's own zlib. */
export function txtFromZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip directory is damaged');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!name.toLowerCase().endsWith('.txt')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.push(data.toString('utf8'));
    else if (method === 8) out.push(inflateRawSync(data).toString('utf8'));
    else throw new Error(`zip entry uses compression method ${method}; unzip it first`);
  }
  return out;
}

function exportsUnder(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (['.txt', '.zip'].includes(extname(entry).toLowerCase())) files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}

// --- parse ------------------------------------------------------------------------------------

export function cmdParse(dir, opts) {
  if (!existsSync(dir)) throw new Error(`No folder ${dir}. Put the WhatsApp exports (.txt or .zip) there first.`);
  const files = exportsUnder(dir);
  const chats = [];
  for (const f of files) {
    const texts = extname(f).toLowerCase() === '.zip' ? txtFromZip(readFileSync(f)) : [readFileSync(f, 'utf8')];
    for (const t of texts) {
      const chat = parseChat(t);
      if (chat.length > 0) chats.push(chat);
    }
  }
  const messages = chats.reduce((n, c) => n + c.length, 0);
  const business = opts.business ?? guessBusiness(chats);
  if (!business) throw new Error('No messages found in the exports.');
  if (!chats.some((c) => c.some((m) => m.name === business))) {
    throw new Error('Nobody in the exports goes by that --business name.');
  }
  const pairs = [];
  let dropped = 0;
  for (const chat of chats) {
    const made = toPairs(chat, business);
    pairs.push(...made.pairs);
    dropped += made.dropped;
  }
  const languages = pairs.reduce((acc, p) => ({ ...acc, [p.language]: (acc[p.language] ?? 0) + 1 }), {});
  mkdirSync(dir, { recursive: true });
  const outFile = join(dir, 'pairs.json');
  writeFileSync(
    outFile,
    JSON.stringify({ generatedAt: new Date().toISOString(), business, chats: chats.length, pairs: pairs.map((p, i) => ({ n: i, ...p })) }, null, 2),
  );
  console.log(`Business side: "${business}"${opts.business ? ' (from --business)' : ' (guessed: in the most chats, then the most messages; pass --business "Name" to change it)'}`);
  console.log(`Files read: ${files.length}  chats: ${chats.length}  messages: ${messages}`);
  console.log(`Pairs written: ${pairs.length}  dropped as still holding personal data: ${dropped}`);
  console.log(`Languages (guessed by script): ${JSON.stringify(languages)}`);
  console.log(`Wrote ${outFile}`);
}

// --- select -----------------------------------------------------------------------------------

/** A seeded shuffle, so a rerun samples the same pairs. */
function shuffled(list, seed) {
  const out = [...list];
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** At most `max` pairs, each language given its share first, so a small language is not drowned. */
export function samplePairs(pairs, max, seed = 220) {
  if (pairs.length <= max) return pairs;
  const byLang = new Map();
  for (const p of shuffled(pairs, seed)) byLang.set(p.language, [...(byLang.get(p.language) ?? []), p]);
  const out = [];
  const queues = [...byLang.values()];
  while (out.length < max && queues.some((q) => q.length > 0)) {
    for (const q of queues) if (q.length > 0 && out.length < max) out.push(q.shift());
  }
  return out;
}

/** A UUIDv7 — the platform's own id layout (`@oto/shared` newId), so a resend names the same example. */
export function uuidv7() {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The best `target` examples, spread across intent × language: each
 * (intent, language) contributes at most two, best quality first, and every
 * group's best is taken before any group's second.
 */
export function pickBest(rated, target) {
  const usable = rated.filter(
    (r) =>
      r.keep !== false &&
      r.quality >= 3 &&
      AI_INTENTS.includes(r.intent) &&
      LANGUAGES.includes(r.language) &&
      VERDICTS.includes(r.verdict) &&
      r.customerText &&
      [...r.customerText].length <= 500 &&
      (r.goodReply == null || [...r.goodReply].length <= 800) &&
      (r.verdict !== 'should_answer' || r.goodReply) &&
      !screen(r.customerText) &&
      !screen(r.goodReply),
  );
  const groups = new Map();
  for (const r of usable) {
    const k = `${r.intent}|${r.language}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const g of groups.values()) g.sort((a, b) => b.quality - a.quality);
  const out = [];
  for (const round of [0, 1]) {
    const firsts = [...groups.values()].map((g) => g[round]).filter(Boolean).sort((a, b) => b.quality - a.quality);
    for (const r of firsts) if (out.length < target) out.push(r);
  }
  return out;
}

const RATING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'facts'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'keep', 'intent', 'language', 'verdict', 'quality', 'customerText', 'goodReply'],
        properties: {
          n: { type: 'integer' },
          keep: { type: 'boolean' },
          intent: { type: 'string', enum: AI_INTENTS },
          language: { type: 'string', enum: LANGUAGES },
          verdict: { type: 'string', enum: VERDICTS },
          quality: { type: 'integer', description: '1 (useless) to 5 (an ideal example)' },
          customerText: { type: 'string' },
          goodReply: { type: ['string', 'null'] },
        },
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact', 'topic', 'language'],
        properties: {
          fact: { type: 'string' },
          topic: { type: 'string', enum: [...KB_TOPICS, 'other'] },
          language: { type: 'string', enum: LANGUAGES },
        },
      },
    },
  },
};

const GAPS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fact', 'topic', 'times', 'note'],
        properties: {
          fact: { type: 'string' },
          topic: { type: 'string', enum: [...KB_TOPICS, 'other'] },
          times: { type: 'integer' },
          note: { type: 'string' },
        },
      },
    },
  },
};

function ratingSystem(business) {
  return [
    `You curate training examples for the customer-service assistant of an indoor children's play park ("${business}" on WhatsApp).`,
    'Each item is one customer message and the reply the park\'s staff sent. Personal data has already been replaced with placeholders such as [name], [phone], [email], [link] and [handle].',
    'For every item return:',
    `- intent: exactly one of: ${AI_INTENTS.join(', ')}.`,
    '- language: th, en or ru — the customer\'s language.',
    '- verdict: should_answer when a correct, timeless answer can be given from general park facts; should_handover when the reply depends on a person (bookings, birthday parties, events, complaints, payments, lost items, discounts, anything about a specific date, promotion or price that may change); should_stay_silent when the customer message needs no reply (a sticker, "ok", a closing thanks the staff did not answer).',
    '- quality: 1–5, how good this pair is as an example for the assistant to imitate (clear question, helpful reply, typical of what customers ask). Use 1–2 for unclear, rude, off-topic or one-off exchanges.',
    '- customerText: the customer message, lightly cleaned (typos may stay), still holding NO personal data — keep the placeholders, remove any name, number, date of birth, child detail or booking detail that slipped through. At most 500 characters.',
    '- goodReply: the reply rewritten as the park should send it every time, in the SAME language and the staff\'s own voice and tone (keep their emoji and politeness particles such as ค่ะ/คะ/ครับ). Remove anything time-bound: specific dates, current promotions, prices that may change, staff names. If the reply cannot be made timeless, set verdict to should_handover and write the short holding reply staff would give before a person takes over. null only when the verdict is should_stay_silent. At most 800 characters.',
    '- keep: false when the item must not become an example at all (personal data you cannot remove, abusive, meaningless).',
    'Also return facts: each general fact about the park that staff stated in these replies (opening hours, age rules, socks, parking, what is included, food rules, …) — one short sentence each, never a price or a date that may change, with the closest knowledge-base topic.',
  ].join('\n');
}

async function anthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    await import(pathToFileURL(join(ROOT, 'scripts', 'agent', 'env.mjs')).href);
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in the environment (or the repo-root .env).');
  const require = createRequire(join(ROOT, 'packages', 'assistant', 'package.json'));
  const mod = await import(pathToFileURL(require.resolve('@anthropic-ai/sdk')).href);
  const Anthropic = mod.default ?? mod.Anthropic;
  return new Anthropic();
}

/** One structured call; its JSON and its token use. A refusal or a cut-off answers null. */
async function askJson(client, system, user, schema, usage) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  });
  usage.input += res.usage?.input_tokens ?? 0;
  usage.output += res.usage?.output_tokens ?? 0;
  usage.calls += 1;
  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
    console.log(`  a batch came back ${res.stop_reason}; it is skipped`);
    return null;
  }
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    console.log('  a batch came back without readable JSON; it is skipped');
    return null;
  }
}

async function cmdSelect(dir, opts) {
  const pairsFile = join(dir, 'pairs.json');
  if (!existsSync(pairsFile)) throw new Error(`No ${pairsFile}. Run "parse" first.`);
  const { business, pairs } = JSON.parse(readFileSync(pairsFile, 'utf8'));
  const target = Number(opts.target ?? 30);
  const batchSize = Number(opts.batch ?? 25);
  const sample = samplePairs(pairs, Number(opts['max-pairs'] ?? 300));
  const client = await anthropicClient();
  const usage = { input: 0, output: 0, calls: 0 };
  const rated = [];
  const facts = [];
  console.log(`Rating ${sample.length} of ${pairs.length} pairs with ${MODEL} in batches of ${batchSize}…`);
  for (let i = 0; i < sample.length; i += batchSize) {
    const batch = sample.slice(i, i + batchSize).map((p) => ({ n: p.n, customer: p.customer, reply: p.reply }));
    const answer = await askJson(client, ratingSystem(business), JSON.stringify({ items: batch }), RATING_SCHEMA, usage);
    if (answer) {
      const known = new Set(batch.map((b) => b.n));
      rated.push(...answer.items.filter((r) => known.has(r.n)));
      facts.push(...answer.facts);
    }
    console.log(`  ${Math.min(i + batchSize, sample.length)}/${sample.length} rated`);
  }

  const picked = pickBest(rated, target);
  const selected = picked.map((r) => ({
    id: uuidv7(),
    intent: r.intent,
    language: r.language,
    verdict: r.verdict,
    customerText: r.customerText.trim(),
    goodReply: r.verdict === 'should_stay_silent' && !r.goodReply ? null : (r.goodReply?.trim() || null),
    quality: r.quality,
  }));
  writeFileSync(
    join(dir, 'selected.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), model: MODEL, business, examples: selected }, null, 2),
  );

  // The knowledge base's gaps: suggestions only, never loaded by this tool.
  let existing = [];
  if (opts.api) {
    const session = await signIn(opts.api, opts.prefix ?? '/api', opts.as ?? 'ADMIN');
    const res = await session.get('/inbox/kb?status=approved');
    if (res.ok) existing = (await res.json()).entries.map((e) => `${e.topic} · ${e.language} · ${e.question} — ${e.body}`);
    else console.log(`  the knowledge base could not be read (${res.status}); gaps are judged against its topics only`);
  }
  let gaps = [];
  if (facts.length > 0) {
    const answer = await askJson(
      client,
      'You maintain the knowledge base of a children\'s play park\'s customer assistant. Merge duplicate facts, count how many times each was stated, and return only the facts that the existing knowledge base does NOT already cover. Never include prices, dates or promotions. Keep the sentences short and neutral, in English.',
      JSON.stringify({ topics: KB_TOPICS, existingEntries: existing, statedFacts: facts }),
      GAPS_SCHEMA,
      usage,
    );
    gaps = (answer?.gaps ?? []).sort((a, b) => b.times - a.times);
  }
  const lines = [
    '# Knowledge-base gaps from the WhatsApp history',
    '',
    `Generated ${new Date().toISOString()} by \`scripts/inbox/whatsapp-history.mjs select\`.`,
    'SUGGESTIONS ONLY: facts staff kept telling customers that the knowledge base does not seem to hold.',
    'Check each one with the park before drafting it in Settings → Assistant → Knowledge. Nothing here was loaded.',
    existing.length > 0 ? `Compared against ${existing.length} approved knowledge-base entries.` : 'Compared against the knowledge-base topics only (run with --api to compare against the live entries).',
    '',
  ];
  for (const topic of [...KB_TOPICS, 'other']) {
    const here = gaps.filter((g) => g.topic === topic);
    if (here.length === 0) continue;
    lines.push(`## ${topic}`, '');
    for (const g of here) lines.push(`- ${g.fact} (stated ${g.times}×)${g.note ? ` — ${g.note}` : ''}`);
    lines.push('');
  }
  if (gaps.length === 0) lines.push('No gaps found.', '');
  writeFileSync(join(dir, 'kb-gaps.md'), lines.join('\n'));

  const cover = selected.reduce((acc, x) => ({ ...acc, [`${x.intent}/${x.language}`]: (acc[`${x.intent}/${x.language}`] ?? 0) + 1 }), {});
  const dollars = (usage.input * 4 + usage.output * 20) / 1_000_000;
  console.log(`Rated: ${rated.length}  usable and picked: ${selected.length} (target ${target})`);
  console.log(`Coverage (intent/language): ${JSON.stringify(cover)}`);
  console.log(`Verdicts: ${JSON.stringify(selected.reduce((a, x) => ({ ...a, [x.verdict]: (a[x.verdict] ?? 0) + 1 }), {}))}`);
  console.log(`Knowledge-base gap suggestions: ${gaps.length}`);
  console.log(`Token use: ${usage.calls} calls, ${usage.input} input + ${usage.output} output tokens (about $${dollars.toFixed(2)} at list price)`);
  console.log(`Wrote ${join(dir, 'selected.json')} and ${join(dir, 'kb-gaps.md')}. Read them before "load".`);
}

// --- load -------------------------------------------------------------------------------------

/** A signed-in session on the platform: the cookie it was given, and get/post through it. */
async function signIn(origin, prefix, who) {
  await import(pathToFileURL(join(ROOT, 'scripts', 'agent', 'env.mjs')).href);
  const phone = process.env[`STAGING_${who}_PHONE`];
  const password = process.env[`STAGING_${who}_PASSWORD`];
  if (!phone || !password) throw new Error(`Set STAGING_${who}_PHONE and STAGING_${who}_PASSWORD in the environment (or the repo-root .env).`);
  const base = `${origin.replace(/\/$/, '')}${prefix}`;
  const res = await fetch(`${base}/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null))?.error;
    throw new Error(`Sign-in refused (${res.status} ${err?.code ?? ''}). Check the STAGING_${who}_* settings.`);
  }
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const headers = (extra = {}) => ({ cookie, ...extra });
  return {
    get: (path) => fetch(`${base}${path}`, { headers: headers() }),
    post: (path, body, key) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: headers({ 'content-type': 'application/json', 'idempotency-key': key }),
        body: JSON.stringify(body),
      }),
  };
}

/** The same chunk always travels under the same key, so a rerun is answered as a replay. */
export function chunkKey(examples) {
  return `wa-history-${createHash('sha256').update(examples.map((x) => x.id).join(',')).digest('hex').slice(0, 40)}`;
}

export async function cmdLoad(dir, opts) {
  if (!opts.api) throw new Error('Name the platform: load --api https://oto-inbox-staging.onrender.com');
  const file = join(dir, 'selected.json');
  if (!existsSync(file)) throw new Error(`No ${file}. Run "select" first.`);
  const { examples } = JSON.parse(readFileSync(file, 'utf8'));
  const body = examples.map(({ id, intent, language, verdict, customerText, goodReply }) => ({
    id,
    intent,
    language,
    verdict,
    customerText,
    goodReply: goodReply ?? null,
  }));
  const flagged = body.map((x, i) => [i, screen(x.customerText) ?? screen(x.goodReply)]).filter(([, k]) => k);
  if (flagged.length > 0) {
    throw new Error(`selected.json still looks like it holds personal data at example(s) ${flagged.map(([i]) => i + 1).join(', ')}. Edit them and run load again.`);
  }
  const chunks = [];
  for (let i = 0; i < body.length; i += IMPORT_CHUNK) chunks.push(body.slice(i, i + IMPORT_CHUNK));
  if (opts['dry-run']) {
    console.log(`Dry run: ${body.length} examples in ${chunks.length} request(s) to ${opts.api}; nothing sent.`);
    return;
  }
  const session = await signIn(opts.api, opts.prefix ?? '/api', (opts.as ?? 'ADMIN').toUpperCase());
  let created = 0;
  let replayed = 0;
  for (const chunk of chunks) {
    const res = await session.post('/inbox/ai/examples/import', { examples: chunk }, chunkKey(chunk));
    const answer = await res.json().catch(() => null);
    if (!res.ok) {
      const err = answer?.error;
      throw new Error(
        `Import refused (${res.status} ${err?.code ?? ''}): ${err?.message ?? ''} ${err?.details ? JSON.stringify(err.details) : ''}`.trim() +
          (created + replayed > 0 ? ` — ${created} created and ${replayed} already there before this request.` : ''),
      );
    }
    created += answer.created;
    replayed += answer.replayed;
  }
  console.log(`Loaded ${body.length} examples: ${created} created as PROPOSED, ${replayed} were already there (a resend).`);
  console.log('Nothing reaches the assistant yet. Review each one in Settings → Assistant → Examples:');
  console.log('edit until it holds no personal data, tick "Contains no personal data", then Approve (or Reject/Delete).');
}

// --- The command line -------------------------------------------------------------------------

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) opts[key] = true;
      else {
        opts[key] = next;
        i += 1;
      }
    } else positional.push(a);
  }
  return { command, opts, positional };
}

const USAGE = `Usage:
  node scripts/inbox/whatsapp-history.mjs parse [dir] [--business "Name"]
  node scripts/inbox/whatsapp-history.mjs select [dir] [--target 30] [--max-pairs 300] [--batch 25] [--api <origin>]
  node scripts/inbox/whatsapp-history.mjs load [dir] --api <origin> [--prefix /api] [--as ADMIN] [--dry-run]
The folder defaults to imports/whatsapp-history/ (git-ignored).`;

async function main() {
  const { command, opts, positional } = parseArgs(process.argv.slice(2));
  const dir = resolve(positional[0] ?? opts.dir ?? DEFAULT_DIR);
  if (command === 'parse') cmdParse(dir, opts);
  else if (command === 'select') await cmdSelect(dir, opts);
  else if (command === 'load') await cmdLoad(dir, opts);
  else {
    console.log(USAGE);
    process.exitCode = command ? 1 : 0;
  }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
