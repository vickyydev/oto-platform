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
 *                       "Hi!", "Thank you" — joins any). AFTER: a turn on one
 *                       topic is composed into one message (`composeMessage`),
 *                       a turn on several keeps a bubble per line; counted
 *                       too, the sentences a line said again after another
 *                       line, which the composition drops, and the turns that
 *                       would lose one.
 *   PARK BEFORE KNOWN   a business turn that tells where a park is or how to
 *                       find it (the location reader below), before the family
 *                       named a park in the chat. AFTER: in a general thread
 *                       with no park, a turn on the park alone (location,
 *                       parking, hours) becomes the park question alone
 *                       (`PARK_QUESTION`) on the owner's pattern — "which
 *                       park?" beside it, or one park's location (one park
 *                       named, or none) — unless a park question already
 *                       waits for the family's answer; an overview naming both
 *                       parks, or a turn with another topic, still goes.
 *   REPEATS             once the family named a park after the business asked
 *                       which one, a sentence of a business turn the business
 *                       had already sent in that chat (`sameSentence`).
 *                       AFTER: what the composition drops (`composeMessage`
 *                       with the gate's repeat rule, the topic reader below
 *                       standing in for the knowledge): a sentence about the
 *                       park sent before the family's answer or in the reply
 *                       to it, in that reply or a later turn on another topic,
 *                       unless the family asks about it again.
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
import { parksNamedIn, questionsIn, slotsAskedIn } from '../src/slots';

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
/** The park topics: the answer that can depend on the park. */
const PARK_TOPICS = new Set(['location', 'parking', 'hours']);
/** The park topics a sentence is about (the reader standing in for the knowledge the gate reads). */
const parkTopicsOf = (s: string) => topicsOf(s).filter((t) => PARK_TOPICS.has(t));
/** A family line's words of four letters or more, a park's name and a few common words left out. */
const COMMON = new Set(['about', 'also', 'have', 'here', 'just', 'like', 'please', 'thank', 'thanks', 'that', 'there', 'they', 'this', 'what', 'when', 'where', 'which', 'will', 'with', 'would', 'your', 'guys', 'hello']);
const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4 && !COMMON.has(w) && parksNamedIn(w).length === 0);
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

  const multi = {
    turns: 0,
    oneTopic: 0,
    severalTopics: 0,
    bubbles: 0,
    oneTopicBubbles: 0,
    duplicateSentences: 0,
    turnsLosingASentence: 0,
    after: { bubbles: 0 },
  };
  const park = {
    turns: 0,
    withParkQuestion: 0,
    chats: new Set<string>(),
    parkQuestionsAsked: 0,
    locationTurns: 0,
    familyAsksWhere: { noPark: 0, parkKnown: 0 },
    after: { parkQuestionAlone: 0, overview: 0, otherTopicBeside: 0, parkQuestionWaiting: 0 },
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
    // The business asked which park and the family has not named one yet.
    let parkAsked = false;
    // What the business said while the park was being resolved (the gate's `parkLines`), once the family named it after the question.
    let parkLines: string[] | null = null;
    // The business turn that answers the family's park, still to come.
    let answering = false;
    const sent: string[] = [];
    let lastFamily: string[] = [];
    for (const turn of turns) {
      if (turn.side === 'family') {
        familyWrote = true;
        lastFamily = turn.lines;
        const named = turn.lines.some((l) => parksNamedIn(l).length > 0);
        if (turn.lines.some((l) => ASKS_WHERE.test(l))) park.familyAsksWhere[named || parkKnown ? 'parkKnown' : 'noPark'] += 1;
        if (named && parkAsked && parkLines === null) {
          parkLines = [...sent];
          answering = true;
        }
        if (named) {
          parkKnown = true;
          parkAsked = false;
        }
        continue;
      }
      if (!familyWrote) {
        sent.push(...turn.lines);
        continue;
      }
      businessTurns += 1;

      // Multi-bubble turns, and what the message makes of them: one bubble on one topic, a bubble per line on several.
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
        const composed = composeMessage(turn.lines, { join: topics.size <= 1 });
        multi.duplicateSentences += composed.duplicates;
        if (composed.duplicates > 0) multi.turnsLosingASentence += 1;
        multi.after.bubbles += composed.bubbles.length;
      }

      // A park-dependent answer before the family named a park.
      const tellsLocation = turn.lines.some((l) => LOCATION.test(l) && !askedPark(l));
      const asksPark = turn.lines.some(askedPark);
      if (tellsLocation) park.locationTurns += 1;
      if (asksPark) park.parkQuestionsAsked += 1;
      if (!parkKnown && tellsLocation) {
        park.turns += 1;
        park.chats.add(chat.id);
        if (asksPark) park.withParkQuestion += 1;
        // After, as `parkFirst` reads the turn.
        const told = turn.lines.filter((l) => !askedPark(l));
        const parkOnly = told.every((l) => topicsOf(l).every((t) => PARK_TOPICS.has(t)));
        const parksNamed = new Set(told.flatMap((l) => parksNamedIn(l)));
        if (parkAsked) park.after.parkQuestionWaiting += 1;
        else if (!parkOnly) park.after.otherTopicBeside += 1;
        else if (asksPark || parksNamed.size <= 1) park.after.parkQuestionAlone += 1;
        else park.after.overview += 1;
      }
      if (!parkKnown && asksPark) parkAsked = true;

      // Repeats once the family named the park after the business asked which one.
      if (parkLines !== null && parkLines.length > 0) {
        const saidBefore = parkLines.flatMap((l) => sentencesOf(l));
        const own = turn.lines.flatMap((l) => sentencesOf(l));
        const repeated = own.filter((s) => saidBefore.some((b) => sameSentence(s, b)));
        if (repeated.length > 0) {
          repeats.sentences += repeated.length;
          repeats.turns += 1;
          repeats.chats.add(chat.id);
          const asked = lastFamily.join('\n');
          const askedTopics = new Set(lastFamily.flatMap(topicsOf));
          if (lastFamily.some((l) => ASKS_WHERE.test(l))) askedTopics.add('location');
          const askedWords = new Set(wordsOf(asked));
          const namedNow = answering ? [] : parksNamedIn(asked);
          const composed = composeMessage(turn.lines, {
            join: new Set(turn.lines.flatMap(topicsOf)).size <= 1,
            said: parkLines,
            keepRepeat: (s) => {
              const topics = parkTopicsOf(s);
              if (topics.length === 0 || questionsIn([s]).length > 0) return true;
              if (!answering && topics.some((t) => askedTopics.has(t))) return true;
              if (parksNamedIn(s).some((p) => namedNow.includes(p))) return true;
              return wordsOf(s).some((w) => askedWords.has(w));
            },
          });
          repeats.after.dropped += composed.repeats;
          repeats.after.sentencesReaching += repeated.length - composed.repeats;
        }
      }
      if (answering && parkLines !== null) {
        parkLines.push(...turn.lines);
        answering = false;
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
      // A turn on one topic composed into one bubble, a turn on several a bubble per line (the closing line the playbook keeps apart is the engine's, not a staff line here).
      after: {
        turns: multi.turns,
        bubbles: multi.after.bubbles,
        sentencesSaidTwiceDropped: multi.duplicateSentences,
        turnsLosingASentence: multi.turnsLosingASentence,
      },
    },
    parkDependentBeforeThePark: {
      before: { turns: park.turns, withTheParkQuestionBeside: park.withParkQuestion, chats: park.chats.size, chatIds: [...park.chats] },
      after: {
        theParkQuestionAlone: park.after.parkQuestionAlone,
        reachingTheFamily: park.turns - park.after.parkQuestionAlone,
        reaching: { overviewOfBothParks: park.after.overview, anotherTopicBeside: park.after.otherTopicBeside, aParkQuestionWaiting: park.after.parkQuestionWaiting },
        parkQuestion: PARK_QUESTION.en,
      },
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
