/**
 * SCRUM-832 — THE CORPUS MEASURE: how often the park's own WhatsApp replies
 * came in several bubbles, and how often a park-dependent answer went before
 * the family had said which park — before and after the turn's one message
 * (`src/compose.ts`).
 *
 *   pnpm --filter @oto/assistant onemsg:measure -- --dir <path to imports/whatsapp-history>
 *
 * READ-ONLY, LOCAL, NO MODEL, NO KEY. It reads every WhatsApp export (`.txt`,
 * and the `.txt` inside a `.zip`) under the folder (default
 * `imports/whatsapp-history`, which git ignores), with the parser of
 * `scripts/inbox/whatsapp-history.mjs` (loaded from that file, so the two
 * never drift), counts the same chat exported twice once, and walks each chat
 * turn by turn: the business is the participant in the most chats, and the
 * lines one side writes in a row are one turn, each line one bubble.
 *
 *   MULTI-BUBBLE TURNS  a business turn of two lines or more after the family
 *                       first wrote; "on one topic" when its lines name at
 *                       most one topic of the reader below (a line naming none —
 *                       "Hi!", "Thank you" — joins any). AFTER: each turn is
 *                       composed into one message (`composeMessage`), so the
 *                       family gets one bubble; counted too, the sentences a
 *                       turn said twice, which the composition drops.
 *   PARK BEFORE KNOWN   a business turn that tells where a park is or how to
 *                       find it (the location reader below), before the family
 *                       named a park in the chat. AFTER: in a general thread
 *                       with no park the assistant asks the park question
 *                       alone instead (`PARK_QUESTION`), so none goes; counted
 *                       too, the owner's exact pattern — the location and
 *                       "which park?" in the same turn.
 *   REPEATS             once the family named a park, a sentence of a business
 *                       turn the business had already sent in that chat
 *                       (`sameSentence`). AFTER: what the composition still
 *                       sends (a sentence the family asks about again, a
 *                       question, or a turn of nothing but repeats).
 *
 * THE ASSUMPTION: the exports carry no thread park. Every chat is read as a
 * general thread with no park until the family names one, as the assistant
 * reads a chat on the operator-wide number; on a park's own number the thread
 * has its park and the park question never comes. Parking and the opening
 * hours are the same at both parks today, so a line about them alone is not
 * park-dependent.
 *
 * WHAT IT PRINTS: counts, and chat ids only (the first 12 hex of the sha256
 * of the chat's lines). Never a name, a phone number, a line or a file name.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PARK_QUESTION, composeMessage, sameSentence, sentencesOf } from '../src/compose';
import { parksNamedIn, slotsAskedIn } from '../src/slots';

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

// --- The topic reader: Thai, English, Russian ------------------------------------------------

/** Where a park is, how to find it inside the mall: the park-dependent topic. */
const LOCATION =
  /(?<![\p{L}])(?:floor|basement|escalator|aquarium|cinema|food ?court|opposite|next to|located|location|address|directions?|map|google maps|tops)(?![\p{L}])|этаж\p{L}*|эскалатор\p{L}*|океанариум\p{L}*|аквариум\p{L}*|кинотеатр\p{L}*|напротив|находимся|адрес\p{L}*|карт[аеуы]|ชั้น|บันไดเลื่อน|อควาเรียม|โรงภาพยนตร์|โรงหนัง|ตรงข้าม|ที่อยู่|แผนที่/iu;
const TOPICS: ReadonlyArray<[string, RegExp]> = [
  ['location', LOCATION],
  ['parking', /parking|park the car|car park|парков\p{L}*|จอดรถ|ที่จอด/iu],
  ['hours', /(?<![\p{L}])(?:open|close[sd]?|hours)(?![\p{L}])|\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b|\d{1,2}:\d{2}\s?[–-]\s?\d{1,2}:\d{2}|работаем|открыт\p{L}*|закрыва\p{L}*|เปิด|ปิด/iu],
  ['prices', /฿|baht|price|ticket|бат\p{L}*|цен\p{L}*|стоимост\p{L}*|билет\p{L}*|บาท|ราคา|ค่าเข้า|บัตร/iu],
  ['birthday', /birthday|party|package|день рожд\p{L}*|праздник\p{L}*|пакет\p{L}*|วันเกิด|ปาร์ตี้|แพ็กเกจ|แพคเกจ/iu],
  ['food', /food|menu|caf[eé]|restaurant|meal|еда|меню|кафе|ресторан|อาหาร|เมนู|คาเฟ่|ร้านอาหาร/iu],
  ['socks_age', /socks|age|years? old|носк\p{L}*|возраст\p{L}*|лет(?![\p{L}])|ถุงเท้า|อายุ|ขวบ/iu],
];
const topicsOf = (line: string) => TOPICS.filter(([, re]) => re.test(line)).map(([t]) => t);
/** A family line asking where a park is or how to find it. */
const ASKS_WHERE =
  /where (?:are|is) (?:you|the park|oto)|how (?:do|can) (?:i|we) (?:get|find|reach)|how to (?:get|find)|location|address|directions|где (?:вы|находит\p{L}*|парк)|как (?:вас )?(?:найти|добраться|проехать)|адрес|อยู่ที่ไหน|อยู่ตรงไหน|ไปยังไง|ไปทางไหน|ที่อยู่/iu;
const askedPark = (line: string) => slotsAskedIn([line]).includes('park');

interface Turn {
  side: 'business' | 'family';
  lines: string[];
}

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

  const multi = { turns: 0, oneTopic: 0, severalTopics: 0, bubbles: 0, oneTopicBubbles: 0, duplicateSentences: 0, after: { bubbles: 0 } };
  const park = {
    turns: 0,
    withParkQuestion: 0,
    chats: new Set<string>(),
    parkQuestionsAsked: 0,
    locationTurns: 0,
    familyAsksWhere: { noPark: 0, parkKnown: 0 },
    after: { parkQuestionAlone: 0 },
  };
  const repeats = { sentences: 0, turns: 0, chats: new Set<string>(), after: { sentencesReaching: 0, dropped: 0 } };
  const multiChats = new Set<string>();
  let businessTurns = 0;

  for (const chat of chats) {
    const turns: Turn[] = [];
    for (const m of chat.lines) {
      const side = m.name === business ? 'business' : 'family';
      const last = turns.at(-1);
      if (last && last.side === side) last.lines.push(m.text);
      else turns.push({ side, lines: [m.text] });
    }
    let familyWrote = false;
    let parkKnown = false;
    const sent: string[] = [];
    let lastFamily: string[] = [];
    for (const turn of turns) {
      if (turn.side === 'family') {
        familyWrote = true;
        lastFamily = turn.lines;
        const named = turn.lines.some((l) => parksNamedIn(l).length > 0);
        if (turn.lines.some((l) => ASKS_WHERE.test(l))) park.familyAsksWhere[named || parkKnown ? 'parkKnown' : 'noPark'] += 1;
        if (named) parkKnown = true;
        continue;
      }
      if (!familyWrote) {
        sent.push(...turn.lines);
        continue;
      }
      businessTurns += 1;

      // Multi-bubble turns, and what one message makes of them.
      if (turn.lines.length >= 2) {
        const topics = new Set(turn.lines.flatMap(topicsOf));
        multi.turns += 1;
        multi.bubbles += turn.lines.length;
        multiChats.add(chat.id);
        if (topics.size <= 1) {
          multi.oneTopic += 1;
          multi.oneTopicBubbles += turn.lines.length;
        } else {
          multi.severalTopics += 1;
        }
        // After: the turn's lines as the gate composes the model's bubbles — one message.
        const composed = composeMessage(turn.lines);
        multi.duplicateSentences += composed.duplicates;
        multi.after.bubbles += composed.text.length > 0 ? 1 : 0;
      }

      // A park-dependent answer before the family named a park.
      const tellsLocation = turn.lines.some((l) => LOCATION.test(l) && !askedPark(l));
      if (tellsLocation) park.locationTurns += 1;
      if (turn.lines.some(askedPark)) park.parkQuestionsAsked += 1;
      if (!parkKnown && tellsLocation) {
        park.turns += 1;
        park.chats.add(chat.id);
        if (turn.lines.some(askedPark)) park.withParkQuestion += 1;
        park.after.parkQuestionAlone += 1;
      }

      // Repeats once the park is known.
      if (parkKnown && sent.length > 0) {
        const saidBefore = sent.flatMap((l) => sentencesOf(l));
        const own = turn.lines.flatMap((l) => sentencesOf(l));
        const repeated = own.filter((s) => saidBefore.some((b) => sameSentence(s, b)));
        if (repeated.length > 0) {
          repeats.sentences += repeated.length;
          repeats.turns += 1;
          repeats.chats.add(chat.id);
          const composed = composeMessage(turn.lines, { said: sent, openLines: lastFamily });
          repeats.after.dropped += composed.repeats;
          repeats.after.sentencesReaching += repeated.length - composed.repeats;
        }
      }
      sent.push(...turn.lines);
    }
  }

  const report = {
    corpus: { files: files.length, unreadable, chats: chats.length, businessTurnsAfterTheFamilyWrote: businessTurns },
    multiBubbleTurns: {
      before: {
        turns: multi.turns,
        bubbles: multi.bubbles,
        onOneTopic: { turns: multi.oneTopic, bubbles: multi.oneTopicBubbles },
        onSeveralTopics: multi.severalTopics,
        sentencesSaidTwiceInATurn: multi.duplicateSentences,
        chats: multiChats.size,
        chatIds: [...multiChats],
      },
      // Each of those turns composed: one bubble each (the closing line the playbook keeps apart is the engine's, not a staff line here).
      after: { turns: multi.turns, bubbles: multi.after.bubbles, sentencesSaidTwiceDropped: multi.duplicateSentences },
    },
    parkDependentBeforeThePark: {
      before: { turns: park.turns, withTheParkQuestionBeside: park.withParkQuestion, chats: park.chats.size, chatIds: [...park.chats] },
      after: { reachingTheFamily: park.turns - park.after.parkQuestionAlone, theParkQuestionAlone: park.after.parkQuestionAlone, parkQuestion: PARK_QUESTION.en },
      businessTurnsTellingALocation: park.locationTurns,
      familyTurnsAskingWhereOrHowToFindUs: park.familyAsksWhere,
      parkQuestionsTheBusinessAsked: park.parkQuestionsAsked,
    },
    repeatsOnceTheParkIsKnown: {
      before: { sentences: repeats.sentences, turns: repeats.turns, chats: repeats.chats.size, chatIds: [...repeats.chats] },
      after: { dropped: repeats.after.dropped, stillSent: repeats.after.sentencesReaching },
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** A fixed line, never a path or a name. */
function fail(line: string): never {
  process.stderr.write(`one-message-measure: ${line}\n`);
  process.exit(1);
}

main().catch((err: unknown) => fail(`failed (${codeOf(err)})`));
