/**
 * SCRUM-823 — THE THRESHOLD, MEASURED ON THE REAL CHATS BEFORE IT SHIPS.
 *
 * Replays the park's exported WhatsApp chats (the folder
 * `imports/whatsapp-history`, git-ignored, read-only here) through the
 * birthday advice safety net's word list (`src/advice.ts`) and counts how many
 * family turns in a birthday conversation it would hand to a person at once.
 * No model is called and no key is read: the reading is the deterministic word
 * list the gate uses, so the count is what the safety net alone would do (the
 * model's own `birthday_advice` label comes on top of it).
 *
 *   pnpm --filter @oto/assistant advice:measure -- --dir <path to imports/whatsapp-history>
 *
 * What it prints is counts and conversation ids only: an id is the first ten
 * hex characters of the sha256 of the chat's text, so it names a chat without
 * naming anyone. Never a name, a number, a line of a chat or a file name.
 *
 * How it reads a chat (the parser of `scripts/inbox/whatsapp-history.mjs`,
 * loaded from that file so the two never drift):
 *   - every `.txt` export and every `.zip` holding one under the folder; the
 *     same chat exported twice (a .txt and its .zip) is counted once;
 *   - the business is the participant in the most chats; everyone else is the
 *     family; consecutive lines of one side are one turn;
 *   - a BIRTHDAY TURN is a family turn at or after a birthday or party word
 *     (Thai, English, Russian, either side) and within eight turns of the last
 *     one — the exports carry no category and no episode, so this stands in for
 *     "a Birthdays & Events conversation";
 *   - each birthday turn is read line by line by `adviceAskIn` (the raw tier)
 *     and `asksBirthdayAdvice` (the gate's: a "can we" that names a day, a date
 *     or a time is the party's details, not advice).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adviceAskIn, asksBirthdayAdvice, type AdviceAsk } from '../src/advice';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface ChatLine {
  name: string;
  text: string;
}

interface ExportParser {
  parseChat(raw: string): ChatLine[];
  guessBusiness(chats: ChatLine[][]): string | null;
  txtFromZip(buf: Buffer): string[];
  guessLanguage(text: string): 'th' | 'ru' | 'en';
}

/** The parser the examples tool uses, loaded by path so this script stays a TypeScript file over a JavaScript one. */
async function loadParser(): Promise<ExportParser> {
  const file = join(ROOT, 'scripts', 'inbox', 'whatsapp-history.mjs');
  return (await import(pathToFileURL(file).href)) as ExportParser;
}

/** A birthday or a party, in the three languages. */
const BIRTHDAY_WORDS: readonly RegExp[] = [
  /(?<![\p{L}\p{N}])(?:birthday|b-?day|party|parties|celebrat\p{L}*)(?![\p{L}\p{N}])/iu,
  /(?:дн[яеё]м?\s+рождени|день\s+рождени|праздник|вечеринк|(?<![\p{L}])др(?![\p{L}]))/iu,
  /(?:วันเกิด|ปาร์ตี้|ปาร์ตี|ปาตี้|งานเลี้ยง|จัดงาน)/u,
];
const mentionsBirthday = (text: string) => BIRTHDAY_WORDS.some((p) => p.test(text));

/** How many turns after the last birthday word a family turn still counts as the party's. */
const BIRTHDAY_WINDOW = 8;
const EXAMPLES = 10;

function exportsUnder(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (['.txt', '.zip'].includes(extname(entry).toLowerCase())) files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}

const idOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 10);

interface Turn {
  side: 'business' | 'family';
  text: string;
}

interface Measured {
  conversation: string;
  turn: number;
  tier: AdviceAsk;
  opener: boolean;
  language: 'th' | 'ru' | 'en';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--dir');
  const dir = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : join(ROOT, 'imports', 'whatsapp-history'));
  if (!existsSync(dir)) throw new Error('No export folder there. Pass --dir <imports/whatsapp-history>.');
  const parser = await loadParser();

  const seen = new Set<string>();
  const chats: { id: string; lines: ChatLine[] }[] = [];
  const files = exportsUnder(dir);
  for (const f of files) {
    const texts = extname(f).toLowerCase() === '.zip' ? parser.txtFromZip(readFileSync(f)) : [readFileSync(f, 'utf8')];
    for (const t of texts) {
      const lines = parser.parseChat(t);
      if (lines.length === 0) continue;
      // The same chat as a .txt and inside its .zip is one chat.
      const id = idOf(lines.map((l) => `${l.name}\u0000${l.text}`).join('\u0001'));
      if (seen.has(id)) continue;
      seen.add(id);
      chats.push({ id, lines });
    }
  }
  const business = parser.guessBusiness(chats.map((c) => c.lines));
  if (!business) throw new Error('No messages found in the exports.');

  let familyTurns = 0;
  let birthdayChats = 0;
  let birthdayTurns = 0;
  let possibilityWithDate = 0;
  const birthdayByLanguage = { th: 0, en: 0, ru: 0 };
  const measured: Measured[] = [];
  for (const chat of chats) {
    const turns: Turn[] = [];
    for (const m of chat.lines) {
      const side = m.name === business ? 'business' : 'family';
      const last = turns[turns.length - 1];
      if (last && last.side === side) last.text += `\n${m.text}`;
      else turns.push({ side, text: m.text });
    }
    let lastBirthday = -Infinity;
    let openerSeen = false;
    let inBirthday = false;
    turns.forEach((turn, i) => {
      if (mentionsBirthday(turn.text)) lastBirthday = i;
      if (turn.side !== 'family') return;
      familyTurns += 1;
      if (i - lastBirthday > BIRTHDAY_WINDOW) return;
      if (!inBirthday) birthdayChats += 1;
      inBirthday = true;
      birthdayTurns += 1;
      birthdayByLanguage[parser.guessLanguage(turn.text)] += 1;
      const lines = turn.text.split('\n').filter((l) => l.trim() !== '');
      const raw = adviceAskIn(lines);
      const gated = asksBirthdayAdvice(lines);
      if (raw === 'possibility' && gated === null) possibilityWithDate += 1;
      const opener = !openerSeen;
      openerSeen = true;
      if (gated !== null) {
        measured.push({ conversation: chat.id, turn: i, tier: gated, opener, language: parser.guessLanguage(turn.text) });
      }
    });
  }

  const count = (pred: (m: Measured) => boolean) => measured.filter(pred).length;
  const pct = (n: number) => (birthdayTurns === 0 ? '0.0' : ((100 * n) / birthdayTurns).toFixed(1));
  const advice = count((m) => m.tier === 'advice');
  const possibility = count((m) => m.tier === 'possibility');
  // Examples by id only: the advice tier first, then the possibility tier, a chat once.
  const examples: string[] = [];
  for (const tier of ['advice', 'possibility'] as const) {
    for (const m of measured.filter((x) => x.tier === tier)) {
      if (examples.length >= EXAMPLES) break;
      const label = `${m.conversation}#${m.turn} (${m.tier}, ${m.language}${m.opener ? ', opening turn' : ''})`;
      if (!examples.some((e) => e.startsWith(`${m.conversation}#`))) examples.push(label);
    }
  }

  const summary = {
    filesRead: files.length,
    chats: chats.length,
    familyTurns,
    birthdayChats,
    birthdayTurns,
    birthdayTurnsByLanguage: birthdayByLanguage,
    adviceHandovers: measured.length,
    byTier: { advice, possibility },
    share: { all: `${pct(measured.length)}%`, adviceOnly: `${pct(advice)}%` },
    byLanguage: {
      th: count((m) => m.language === 'th'),
      en: count((m) => m.language === 'en'),
      ru: count((m) => m.language === 'ru'),
    },
    onTheOpeningTurn: count((m) => m.opener),
    possibilityKeptAsDetails: possibilityWithDate,
    chatsWithAnAdviceHandover: new Set(measured.map((m) => m.conversation)).size,
    examples,
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
