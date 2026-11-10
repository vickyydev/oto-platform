/**
 * SCRUM-831 — THE CORPUS MEASURE: how often a question is asked again after
 * the customer answered it, in the park's own WhatsApp history, before and
 * after the open-question memory and the repeat guard.
 *
 *   pnpm --filter @oto/assistant repeat:measure [--dir <folder>]
 *
 * READ-ONLY, LOCAL, NO MODEL. It reads every WhatsApp export (`.txt`) under
 * the folder (default `imports/whatsapp-history/raw`, which git ignores),
 * de-duplicates the chats by content, and walks each chat turn by turn. Each
 * business reply is a turn the assistant would have decided: it is replayed
 * through `FakeAssistantClient` as the model's draft (the real parser and
 * schema read it), with the prompt built from the conversation and the
 * memory, exactly as the engine builds it.
 *
 *   BEFORE  the reply as it was sent: a question asking a slot the customer
 *           had already answered (read by `readSlotAnswers` from their reply
 *           to the earlier ask), or one asked twice already with no answer,
 *           counted by slot.
 *   AFTER   the same draft through the repeat guard (`repeatGuard`): every
 *           such question is refused before it is sent, so none reaches the
 *           customer; the trips are counted by slot and by what the guard
 *           does next (decide again with the fact, or hand over).
 *
 * Also counted: every question asked, by slot, and how many of them the next
 * customer reply answered as the reader read it (the memory's coverage).
 *
 * The child's age rule (`not_needed`) needs the intent, which only the model
 * labels: the replay passes the birthday intent, so the age is never refused
 * as a reflex here and only repeats are counted.
 *
 * WHAT IT PRINTS: counts, and a chat id (the first 12 hex of the SHA-256 of
 * its text) per chat with a repeat. Never a name, a phone number, a line or a
 * file name — and never an error's message, which names the path (an export
 * is named after the contact): a file or folder that does not read is counted
 * by its error code, and a failure prints a fixed line and the code.
 *
 * A question is read against the customer's first reply after it only, as the
 * engine reads it (`open-question.ts`); a later reply never fills it. The parser below mirrors `scripts/inbox/whatsapp-history.mjs`
 * `parseChat` (Android and iPhone formats); it stays a copy because that file
 * is plain JavaScript outside this package.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoDateInTz } from '@oto/shared';
import { MAX_BUBBLE_CHARS, MAX_BUBBLES, type AiDecision } from '../src/decision';
import { FakeAssistantClient } from '../src/fake';
import { repeatGuard, repeatStep, type EpisodeQuestion } from '../src/gate';
import { AI_ASKED_SLOTS, type AiAskedSlot } from '../src/intents';
import { buildKnowledge, buildPrompt, type EpisodeMessage, type MemoryQuestion } from '../src/prompt';
import { askedSlotsOf, readSlotAnswers } from '../src/slots';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// --- Reading an export (a copy of `whatsapp-history.mjs` `parseChat`) ---------------------------

const ANDROID = /^(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),? (\d{1,2}[:.]\d{2})(?:[ \u202f\u00a0]?([ap]\.?\s?m\.?))? - (.*)$/i;
const IPHONE = /^\[(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}),? (\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)(?:[ \u202f\u00a0]?([ap]\.?\s?m\.?))?\] (.*)$/i;
const DROPPED = [
  /^<media omitted>$/i,
  /^<attached: .*>$/i,
  /^.*\bomitted$/i,
  /^this message was deleted\.?$/i,
  /^you deleted this message\.?$/i,
  /^missed (?:voice|video) call/i,
  /^(?:voice|video) call\b/i,
  /^location: /i,
  /^null$/i,
  /^messages and calls are end-to-end encrypted/i,
  /^this (?:business uses a secure service|chat is with a business account)/i,
  /^<ไม่รวมสื่อ>$/,
  /^ข้อความนี้ถูกลบ/,
  /^<без медиафайлов>$/i,
  /^данное сообщение удалено\.?$/i,
];
const EDITED = /\s*<This message was edited>\s*$/i;

interface Line {
  name: string;
  text: string;
}

function parseChat(raw: string): Line[] {
  const out: Line[] = [];
  let current: Line | null = null;
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
      if (current) (current as Line).text += `\n${rawLine}`;
      continue;
    }
    flush();
    const rest = m[4]!.replace(/^[\u200e\u200f]+/, '');
    const sep = rest.indexOf(': ');
    if (sep <= 0 || rest.charAt(sep + 2) === '\u200e') continue;
    current = { name: rest.slice(0, sep).replace(/[\u200e\u200f\u202a-\u202e~]/g, '').trim(), text: rest.slice(sep + 2).replace(/^[\u200e\u200f]+/, '') };
  }
  flush();
  return out;
}

/** The business: the participant in the most chats, then with the most lines. */
function guessBusiness(chats: Line[][]): string | null {
  const seen = new Map<string, { chats: number; lines: number }>();
  for (const chat of chats) {
    for (const n of new Set(chat.map((m) => m.name))) seen.set(n, { chats: (seen.get(n)?.chats ?? 0) + 1, lines: seen.get(n)?.lines ?? 0 });
    for (const m of chat) seen.get(m.name)!.lines += 1;
  }
  return [...seen.entries()].sort((a, b) => b[1].chats - a[1].chats || b[1].lines - a[1].lines)[0]?.[0] ?? null;
}

/**
 * A folder or a file the script could not read, counted and never named: an
 * export's path names the contact ("WhatsApp Chat with …", often a phone
 * number), and an fs error's message carries the path. Only its code is kept.
 */
interface Unreadable {
  folders: number;
  files: number;
  byCode: Record<string, number>;
}

/** An error's code ("ENOENT", "EBUSY"), or "UNKNOWN": never its message. */
function codeOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : null;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/u.test(code) ? code : 'UNKNOWN';
}

function countUnreadable(unreadable: Unreadable, kind: 'folders' | 'files', err: unknown): void {
  unreadable[kind] += 1;
  const code = codeOf(err);
  unreadable.byCode[code] = (unreadable.byCode[code] ?? 0) + 1;
}

function exportsUnder(dir: string, unreadable: Unreadable): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch (err) {
      countUnreadable(unreadable, 'folders', err);
      return;
    }
    for (const entry of entries) {
      const full = join(d, entry);
      let folder: boolean;
      try {
        folder = statSync(full).isDirectory();
      } catch (err) {
        countUnreadable(unreadable, 'files', err);
        continue;
      }
      if (folder) walk(full);
      else if (extname(entry).toLowerCase() === '.txt') files.push(full);
    }
  };
  walk(dir);
  return files.sort();
}

// --- The replay -----------------------------------------------------------------------------

interface Turn {
  side: 'business' | 'customer';
  lines: string[];
}

function turnsOf(chat: Line[], business: string): Turn[] {
  const turns: Turn[] = [];
  for (const m of chat) {
    const side = m.name === business ? 'business' : 'customer';
    const last = turns.at(-1);
    if (last && last.side === side) last.lines.push(m.text);
    else turns.push({ side, lines: [m.text] });
  }
  return turns;
}

type Counts = Record<AiAskedSlot, number>;
const zero = (): Counts => Object.fromEntries(AI_ASKED_SLOTS.map((s) => [s, 0])) as Counts;
const total = (c: Counts) => Object.values(c).reduce((a, b) => a + b, 0);
const nonZero = (c: Counts) => Object.fromEntries(Object.entries(c).filter(([, v]) => v > 0));

interface Asked {
  slot: AiAskedSlot;
  state: EpisodeQuestion['state'];
  answer: string | null;
  at: Date;
  /** No customer reply has come since it was asked: the next one is read as its answer. */
  awaiting: boolean;
}

/** A reply as the model's draft would be shaped: at most three bubbles, each within the bound. */
function draftOf(lines: readonly string[], askedSlots: AiAskedSlot[]): AiDecision {
  // The schema bounds a bubble in UTF-16 units (an emoji is two): clipped so, never mid-pair.
  const clip = (l: string) => l.slice(0, MAX_BUBBLE_CHARS).replace(/[\uD800-\uDBFF]$/u, '').trim();
  const bubbles = lines.slice(0, MAX_BUBBLES).map((l) => clip(l) || '…');
  return {
    language: 'en',
    intent: 'birthday_party',
    certainty: 'sure',
    action: 'answer',
    grounding: [],
    bubbles,
    sendBrochure: false,
    branchNamed: null,
    askBranch: false,
    reason: 'CLEAR_INTENT',
    askedSlots,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dirAt = args.indexOf('--dir');
  const dir = dirAt >= 0 ? resolve(args[dirAt + 1]!) : join(ROOT, 'imports', 'whatsapp-history', 'raw');
  if (!existsSync(dir)) fail('no export folder found: pass --dir <folder holding the WhatsApp .txt exports>');

  const unreadable: Unreadable = { folders: 0, files: 0, byCode: {} };
  const files = exportsUnder(dir, unreadable);
  const byHash = new Map<string, Line[]>();
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, 'utf8');
    } catch (err) {
      // An export that does not read (locked, or a cloud file that did not download): counted by its code, never named.
      countUnreadable(unreadable, 'files', err);
      continue;
    }
    const chat = parseChat(text);
    if (chat.length === 0) continue;
    byHash.set(createHash('sha256').update(text).digest('hex').slice(0, 12), chat);
  }
  const chats = [...byHash.entries()];
  const business = guessBusiness(chats.map(([, c]) => c));
  if (!business) fail('no messages found in the exports');

  const knowledge = buildKnowledge({ kb: [], branches: [], examples: [] });
  const fake = new FakeAssistantClient();
  const today = new Date('2026-11-10T05:00:00.000Z');
  const todayIso = isoDateInTz(today, 'Asia/Bangkok');

  const asked = zero();
  const answered = zero();
  const before = { answered: zero(), askedTwice: zero() };
  const after = { reached: zero(), rethink: zero(), handover: zero() };
  const chatsWithRepeat: string[] = [];
  let eligible = 0;
  let malformed = 0;

  for (const [id, chat] of chats) {
    const turns = turnsOf(chat, business);
    const memory: Asked[] = [];
    const episode: EpisodeMessage[] = [];
    let at = today.getTime() - turns.length * 60_000;
    let repeated = false;
    for (const turn of turns) {
      at += 60_000;
      if (turn.side === 'customer') {
        // The customer's first reply after a question read as its answer, as the engine reads it; a later reply never is.
        const open = memory.filter((q) => q.state === 'open' && q.awaiting);
        for (const q of memory) q.awaiting = false;
        for (const text of turn.lines) {
          const read = readSlotAnswers([...new Set(open.filter((q) => q.state === 'open').map((q) => q.slot))], text, todayIso);
          for (const q of open) {
            if (q.state === 'open' && q.slot in read) {
              q.state = 'answered';
              q.answer = read[q.slot] ?? null;
              answered[q.slot] += 1;
            }
          }
        }
        for (const text of turn.lines) episode.push({ from: 'customer', at: new Date(at), text });
        continue;
      }
      if (!episode.some((m) => m.from === 'customer')) {
        for (const text of turn.lines) episode.push({ from: 'staff', at: new Date(at), text });
        continue;
      }
      eligible += 1;
      // The draft, replayed through the fake as the model's decision, with the memory in the prompt.
      const slots = askedSlotsOf(undefined, turn.lines);
      const memoryQuestions: MemoryQuestion[] = memory.map((q) => ({ slot: q.slot, askedAt: q.at, state: q.state, answer: q.answer }));
      const built = buildPrompt({
        knowledge,
        episode: episode.slice(-20),
        context: { now: new Date(at), threadBranch: null, priceModeToday: {}, earlier: { answered: 0, brochureSent: false, branchAsked: false, identityAnswered: false } },
        memory: { questions: memoryQuestions },
      });
      if (!built.ok) continue;
      fake.push({ kind: 'decision', decision: draftOf(turn.lines, slots) });
      const outcome = await fake.decide({ prompt: built.prompt });
      if (!outcome.ok) {
        malformed += 1;
        continue;
      }
      const draftSlots = askedSlotsOf(outcome.decision.askedSlots, outcome.decision.bubbles);
      for (const slot of draftSlots) {
        const refusal = repeatGuard({ asked: [slot], questions: memory.map((q) => ({ slot: q.slot, state: q.state, answer: q.answer })), intents: ['birthday_party'] });
        if (refusal) {
          repeated = true;
          if (refusal.kind === 'answered') before.answered[slot] += 1;
          else if (refusal.kind === 'asked_twice') before.askedTwice[slot] += 1;
          // After: never sent. Decided again with the fact, or handed over.
          if (repeatStep(refusal, false) === 'rethink') after.rethink[slot] += 1;
          else after.handover[slot] += 1;
        }
      }
      // What the history did next: the asks it sent are the memory's new open questions.
      for (const slot of draftSlots) {
        asked[slot] += 1;
        for (const q of memory) if (q.slot === slot && q.state === 'open') q.state = 'withdrawn';
        memory.push({ slot, state: 'open', answer: null, at: new Date(at), awaiting: true });
      }
      for (const text of turn.lines) episode.push({ from: 'staff', at: new Date(at), text });
    }
    if (repeated) chatsWithRepeat.push(id);
  }

  const beforeTotal = total(before.answered) + total(before.askedTwice);
  const report = {
    corpus: {
      files: files.length,
      unreadable,
      chats: chats.length,
      assistantEligibleTurns: eligible,
      draftsTheParserRefused: malformed,
    },
    questionsAsked: { total: total(asked), bySlot: nonZero(asked) },
    answeredByTheNextReply: { total: total(answered), bySlot: nonZero(answered) },
    before: {
      repeatedQuestions: beforeTotal,
      askedAgainAfterAnAnswer: nonZero(before.answered),
      askedAThirdTimeUnanswered: nonZero(before.askedTwice),
    },
    after: {
      repeatedQuestionsReachingTheCustomer: total(after.reached),
      guardTrips: beforeTotal,
      decidedAgainWithTheFact: nonZero(after.rethink),
      handedOver: nonZero(after.handover),
    },
    chatsWithARepeat: { count: chatsWithRepeat.length, ids: chatsWithRepeat },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/** A fixed line, never a path or a name. */
function fail(line: string): never {
  process.stderr.write(`repeat-measure: ${line}\n`);
  process.exit(1);
}

// Never the error's message: an fs error's names a path, and an export's path names the contact. A fixed line and the code only.
main().catch((err: unknown) => fail(`failed (${codeOf(err)})`));
