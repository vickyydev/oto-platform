/**
 * SCRUM-830 — THE CORPUS MEASURE: where the first-message reader
 * (`src/first-message.ts`) would have sent each of the park's real WhatsApp
 * chats, from the family's first line alone, before any model.
 *
 *   pnpm --filter @oto/assistant firstmsg:measure -- --dir <path to imports/whatsapp-history>
 *
 * READ-ONLY, LOCAL, NO MODEL, NO KEY. It reads every WhatsApp export (`.txt`,
 * and the `.txt` inside a `.zip`) under the folder (default
 * `imports/whatsapp-history`, which git ignores), with the parser of
 * `scripts/inbox/whatsapp-history.mjs` (loaded from that file, so the two
 * never drift), counts the same chat exported twice once, and reads each
 * chat's FIRST FAMILY LINE with the reader — the message the ingest sees when
 * it opens the thread — and, beside it, the family's first TURN (the lines
 * they sent in a row before the business answered: "Hi" then "I want a
 * birthday party" is one turn of two lines, and the ingest reads only the
 * first).
 *
 * THE REAL QUEUE: the exports do not say which inbox a chat belonged to. They
 * are one WhatsApp Business number's chats, exported in batches (the folder
 * names are the batches, not queues), and a WhatsApp export carries no label.
 * So instead of an agreement rate against a recorded queue, this prints what
 * share of first lines the reader classifies, and a PROXY from the chat's own
 * words: the BUSINESS's replies in a chat about a party carry a birthday word
 * (a package, a cake, the party room), so a first line sent to Birthdays &
 * Events whose chat's business replies never say one is listed as ambiguous,
 * and a chat whose business replies do say one but whose first line the
 * reader left to the default is a party the first line did not announce.
 * For the GM there is no such proxy in the replies: every chat the reader
 * sends there is listed, for a person to read.
 *
 * WHAT IT PRINTS: counts, cue keys, and chat ids only (the first 12 hex of
 * the sha256 of the chat's lines). Never a name, a phone number, a line or a
 * file name.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { firstMessageCategory, type FirstMessageReading } from '../src/first-message';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

interface ChatLine {
  name: string;
  text: string;
}

interface ExportParser {
  parseChat(raw: string): ChatLine[];
  guessBusiness(chats: ChatLine[][]): string | null;
  txtFromZip(buf: Buffer): string[];
}

async function loadParser(): Promise<ExportParser> {
  const file = join(ROOT, 'scripts', 'inbox', 'whatsapp-history.mjs');
  return (await import(pathToFileURL(file).href)) as ExportParser;
}

/** An error's code ("ENOENT"), never its message (an export's path names the contact). */
function codeOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : null;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/u.test(code) ? code : 'UNKNOWN';
}

function exportsUnder(dir: string, unreadable: Record<string, number>): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch (err) {
      unreadable[codeOf(err)] = (unreadable[codeOf(err)] ?? 0) + 1;
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      try {
        if (statSync(full).isDirectory()) walk(full);
        else if (['.txt', '.zip'].includes(extname(entry).toLowerCase())) files.push(full);
      } catch (err) {
        unreadable[codeOf(err)] = (unreadable[codeOf(err)] ?? 0) + 1;
      }
    }
  };
  walk(dir);
  return files.sort();
}

const idOf = (lines: readonly ChatLine[]) =>
  createHash('sha256')
    .update(lines.map((l) => `${l.name}\u0000${l.text}`).join('\u0001'))
    .digest('hex')
    .slice(0, 12);

/** The business's replies name a birthday matter: the reader's own birthday cues, read over each reply. */
const businessTalksBirthday = (lines: readonly string[]) => lines.some((l) => firstMessageCategory(l)?.category === 'birthdays');

type Queue = 'birthdays' | 'gm' | 'default';
const queueOf = (r: FirstMessageReading | null): Queue => r?.category ?? 'default';

interface Tally {
  birthdays: number;
  gm: number;
  default: number;
}
const tally = (): Tally => ({ birthdays: 0, gm: 0, default: 0 });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--dir');
  const dir = resolve(at >= 0 && args[at + 1] ? args[at + 1]! : join(ROOT, 'imports', 'whatsapp-history'));
  if (!existsSync(dir)) fail('no export folder there: pass --dir <imports/whatsapp-history>');
  const parser = await loadParser();

  const unreadable: Record<string, number> = {};
  const files = exportsUnder(dir, unreadable);
  const seen = new Set<string>();
  const chats: Array<{ id: string; lines: ChatLine[] }> = [];
  for (const f of files) {
    let texts: string[];
    try {
      texts = extname(f).toLowerCase() === '.zip' ? parser.txtFromZip(readFileSync(f)) : [readFileSync(f, 'utf8')];
    } catch (err) {
      unreadable[codeOf(err)] = (unreadable[codeOf(err)] ?? 0) + 1;
      continue;
    }
    for (const t of texts) {
      const lines = parser.parseChat(t);
      if (lines.length === 0) continue;
      const id = idOf(lines);
      if (seen.has(id)) continue;
      seen.add(id);
      chats.push({ id, lines });
    }
  }
  const business = parser.guessBusiness(chats.map((c) => c.lines));
  if (!business) fail('no messages found in the exports');

  const firstLine = tally();
  const firstTurn = tally();
  const cueCounts: Record<string, number> = {};
  const firstTurnOnly = { birthdays: 0, gm: 0 };
  const ids = {
    gm: [] as string[],
    birthdaysUncorroborated: [] as string[],
    birthdaysUnanswered: [] as string[],
    partyChatsTheFirstLineMissed: [] as string[],
    partyChatsTheFirstTurnCatches: [] as string[],
  };
  let familyChats = 0;
  let businessOpened = 0;
  let partyChats = 0;
  let partyChatsCaught = 0;
  let partyChatsCaughtByTurn = 0;
  let birthdaysCorroborated = 0;
  let birthdaysUnanswered = 0;
  // A default first line whose family wrote a cue LATER in the chat (the ingest reads only the first).
  const later = { birthdays: 0, gm: 0, inTheSecondFamilyLine: 0, ids: { birthdays: [] as string[], gm: [] as string[] } };

  for (const chat of chats) {
    const firstFamilyAt = chat.lines.findIndex((l) => l.name !== business);
    if (firstFamilyAt < 0) continue;
    familyChats += 1;
    if (firstFamilyAt > 0) businessOpened += 1;
    const first = chat.lines[firstFamilyAt]!;
    const turn: string[] = [];
    for (let i = firstFamilyAt; i < chat.lines.length && chat.lines[i]!.name !== business; i += 1) turn.push(chat.lines[i]!.text);

    const lineReading = firstMessageCategory(first.text);
    const lineQueue = queueOf(lineReading);
    firstLine[lineQueue] += 1;
    if (lineReading) {
      const key = `${lineReading.language}:${lineReading.cue}`;
      cueCounts[key] = (cueCounts[key] ?? 0) + 1;
    }
    // The first turn, read as one message: the strongest reading among its lines (a complaint wins).
    const turnReadings = turn.map(firstMessageCategory);
    const turnQueue: Queue = turnReadings.some((r) => r?.category === 'gm') ? 'gm' : turnReadings.some((r) => r?.category === 'birthdays') ? 'birthdays' : 'default';
    firstTurn[turnQueue] += 1;
    if (lineQueue === 'default' && turnQueue !== 'default') firstTurnOnly[turnQueue] += 1;

    // The proxy: the business's own replies in this chat name a birthday matter.
    const replies = chat.lines.filter((l) => l.name === business).map((l) => l.text);
    const party = businessTalksBirthday(replies);
    if (party) {
      partyChats += 1;
      if (lineQueue === 'birthdays') partyChatsCaught += 1;
      else if (turnQueue === 'birthdays') {
        partyChatsCaughtByTurn += 1;
        ids.partyChatsTheFirstTurnCatches.push(chat.id);
      } else ids.partyChatsTheFirstLineMissed.push(chat.id);
    }
    if (lineQueue === 'birthdays') {
      if (party) birthdaysCorroborated += 1;
      else if (replies.length === 0) {
        // The export holds no text reply from the business at all (a reply
        // by media or voice is not in a text export): nothing to corroborate.
        birthdaysUnanswered += 1;
        ids.birthdaysUnanswered.push(chat.id);
      } else ids.birthdaysUncorroborated.push(chat.id);
    }
    if (lineQueue === 'gm') ids.gm.push(chat.id);

    // The family's later lines, where the first said nothing: what a reader of every message would add.
    if (lineQueue === 'default') {
      const familyLines = chat.lines.filter((l) => l.name !== business).map((l) => l.text);
      const readings = familyLines.slice(1).map(firstMessageCategory);
      const at = readings.findIndex((r) => r !== null);
      if (at >= 0) {
        const q = readings.some((r) => r?.category === 'gm') ? 'gm' : 'birthdays';
        later[q] += 1;
        later.ids[q].push(chat.id);
        if (at === 0) later.inTheSecondFamilyLine += 1;
      }
    }
  }

  const pct = (n: number, of: number) => (of === 0 ? null : Math.round((n / of) * 1000) / 10);
  const report = {
    corpus: {
      files: files.length,
      unreadable,
      chats: chats.length,
      chatsWhereTheFamilyWrote: familyChats,
      chatsTheBusinessOpened: businessOpened,
    },
    theRealQueue: 'not in the export: one WhatsApp Business number, exported in batches, no label per chat — the proxy below reads the business’s own replies instead',
    firstLine: {
      // Where the ingest would send each chat from the family's first message alone.
      sentTo: firstLine,
      share: { birthdays: pct(firstLine.birthdays, familyChats), gm: pct(firstLine.gm, familyChats), default: pct(firstLine.default, familyChats) },
      cues: cueCounts,
    },
    firstTurn: {
      // The same, had the ingest read the family's whole first turn (the lines before the business answered).
      sentTo: firstTurn,
      caughtOnlyByALaterLineOfTheTurn: firstTurnOnly,
    },
    laterInTheChat: {
      // A first line that said nothing, where a later family line carries a cue: the thread the
      // ingest leaves on the default and only the assistant's second opinion can move.
      defaultFirstLines: firstLine.default,
      aLaterFamilyLineSaysBirthdays: later.birthdays,
      aLaterFamilyLineSaysGm: later.gm,
      ofWhichInTheVerySecondFamilyLine: later.inTheSecondFamilyLine,
      ids: later.ids,
    },
    proxy: {
      partyChats: {
        // Chats whose BUSINESS replies name a birthday matter: the staff talked about a party.
        chats: partyChats,
        firstLineSentToBirthdays: partyChatsCaught,
        firstLineShare: pct(partyChatsCaught, partyChats),
        firstTurnWouldAdd: partyChatsCaughtByTurn,
        firstTurnShare: pct(partyChatsCaught + partyChatsCaughtByTurn, partyChats),
        theFirstTurnCatchesIds: ids.partyChatsTheFirstTurnCatches,
        neitherCatchesIds: ids.partyChatsTheFirstLineMissed,
      },
      birthdaysFromTheFirstLine: {
        chats: firstLine.birthdays,
        // The export holds no text reply from the business: nothing to corroborate either way.
        noBusinessTextReplyInTheExport: birthdaysUnanswered,
        answered: firstLine.birthdays - birthdaysUnanswered,
        corroboratedByTheBusinessReplies: birthdaysCorroborated,
        corroboratedShareOfAnswered: pct(birthdaysCorroborated, firstLine.birthdays - birthdaysUnanswered),
        // Possible false positives: the business replied and never said a birthday word. Ids for a person to read.
        answeredButUncorroboratedIds: ids.birthdaysUncorroborated,
        noBusinessTextReplyIds: ids.birthdaysUnanswered,
      },
      gmFromTheFirstLine: {
        chats: firstLine.gm,
        // No proxy in the replies: every one listed, for a person to read.
        ids: ids.gm,
      },
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** A fixed line, never a path or a name. */
function fail(line: string): never {
  process.stderr.write(`first-message-measure: ${line}\n`);
  process.exit(1);
}

main().catch((err: unknown) => fail(`failed (${codeOf(err)})`));
