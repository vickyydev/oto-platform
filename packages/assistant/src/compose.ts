/**
 * SCRUM-832 — ONE MESSAGE PER TURN, PARK FIRST (owner, 10 Nov 2026, APPROVED:
 * "the two bubbles for Central say the same thing on the same topic, so it
 * should be one combined message in one bubble"). The owner's case: in a
 * general thread with no park, "How to find you guys?" got both parks'
 * locations in one bubble and "which park?" in a second; "Central" then got
 * the walking directions, and a second bubble said the location again and
 * added the parking.
 *
 * The last step of `applyGates` (gate.ts), after every other net, on a reply
 * the gate lets through (an answer verdict; a hand-over's words are its own,
 * SCRUM-823's opener beside an advice hand-over included):
 *
 *   1. PARK FIRST (`parkFirst`): in a general thread with no park known — not
 *      on the thread, not read by the model, not answered to the park
 *      question, not named by the family this episode — a reply whose every
 *      part depends on the park (`PARK_FIRST_INTENTS`, a greeting or a
 *      thank-you aside) is the playbook's park question ALONE, in the
 *      customer's language, declared `askedSlots: ['park']` so SCRUM-831's
 *      memory records it and reads the family's "Central" as the answer. Only
 *      on the owner's pattern: the model asked which park next to that
 *      answer, or answered for one park the family never named (a guess) —
 *      and only where the knowledge says the parks' answers differ
 *      (`parksDiffer`), never while a park question still waits for its
 *      answer. A reply that tells both parks and asks nothing is an overview
 *      (where are your branches, which is closest to Kata) and goes as
 *      written; a burst with another question (a café, socks) keeps the
 *      model's own park handling, every part answered.
 *   2. ONE MESSAGE (`composeMessage`): the parts of an answer on ONE topic
 *      (`topicsOfIntents`) are composed into one message — the parts in their
 *      order, a blank line between them — and an answer on several topics
 *      keeps a bubble per part, as the prompt asks (`MULTI_PART_RULE`). A
 *      sentence one part says again after another part said it is dropped,
 *      never inside one part, never a sentence with a number, never a row of
 *      a list; a part loses only that sentence, its line breaks kept. The
 *      closing or hand-over line the playbook keeps separate is never a
 *      bubble of the verdict: the engine sends it after the one message
 *      (`thenHandover`). The parts ride with it (`parts`): the engine shows
 *      them to the coherence reviewer one by one (SCRUM-677), then sends what
 *      survives side by side as the one message.
 *   3. THE PARK ASKED ONCE: once the park is known, a sentence that asks only
 *      which park is dropped (`asksOnlyThePark`), and the reply no longer
 *      declares the park asked — never the whole reply, and never in the
 *      price conversation or the birthday, which ask the park inside their
 *      own one question (`OWN_PARK_QUESTION_INTENTS`).
 *   4. NO REPETITION (`repeatRule`): once the family answered the park
 *      question this episode, a sentence about the park (where it is, the way
 *      in, the parking, the hours: read against the knowledge,
 *      `parkTopicsOf`) that the assistant sent before or in the reply that
 *      answered it (`EpisodeState.parkLines`) is not sent again — in the turn
 *      that answers the park question, and in a later turn whose answer is
 *      on another topic. Never when the family asks about it again (the
 *      reply answers that topic, or the family names the park it is about),
 *      never a question, and never when nothing new would be left.
 *
 * Before the gate, `parkAnswerRead`: the family's reply to the park question
 * names the park the memory read as its answer, and the model left
 * `branchNamed` empty — the gate reads that park, so the thread's park is set.
 *
 * Pure: no clock, no database, no model.
 */

import { AI_BRANCH_KEYS, type AiBranchKey, type AiReplyLanguage } from './decision';
import type { EpisodeQuestion, EpisodeState, GateInput, GateVerdict, GroundingSource } from './gate';
import {
  ASIDE_INTENTS,
  INTENT_TABLE,
  OWN_PARK_QUESTION_INTENTS,
  PARK_FIRST_INTENTS,
  birthdayThreadOf,
  topicsOfIntents,
  type AiAskedSlot,
  type AiGroundingTopic,
  type AiIntent,
} from './intents';
import { EN_PERSONA, RU_PERSONA, TH_PERSONA } from './persona';
import { askedSlotsOf, parksNamedIn, questionsIn, slotsAskedIn } from './slots';

type AnswerVerdict = Extract<GateVerdict, { action: 'answer' }>;

/** How the turn's message was composed: counts and words, never text (the turn's pill and audit). */
export interface TurnComposition {
  /** The reply became the park question alone (`parkFirst`). */
  parkFirst: boolean;
  /** The model's bubbles the message was composed from. */
  bubbles: number;
  /** The parts went as ONE message (an answer on one topic); false: a bubble per part. */
  joined: boolean;
  /** Sentences one part said again after another, dropped. */
  duplicates: number;
  /** Sentences already sent this episode about the park, dropped once the family gave it. */
  repeats: number;
  /** Sentences asking only which park, dropped once the park was known. */
  parkQuestions: number;
}

/** Between the parts of the one message: a blank line, in every language. */
export const PART_JOIN = '\n\n';

/** The playbook's park question, by reply language (the persona's own line: "Central Floresta", never "Central" alone). */
export const PARK_QUESTION: Readonly<Record<AiReplyLanguage, string>> = {
  en: EN_PERSONA.branchQuestion,
  th: TH_PERSONA.branchQuestion,
  ru: RU_PERSONA.branchQuestion,
};

const isBranchKey = (v: unknown): v is AiBranchKey => typeof v === 'string' && (AI_BRANCH_KEYS as readonly string[]).includes(v);

/** The knowledge's topics a park-dependent answer rests on: where a park is, the way in, the parking, the hours. */
export const PARK_TOPICS: ReadonlySet<AiGroundingTopic> = new Set<AiGroundingTopic>(
  [...PARK_FIRST_INTENTS].flatMap((i) => {
    const rule = INTENT_TABLE[i];
    return rule.action === 'answer' && rule.groundingTopics !== null ? [...rule.groundingTopics] : [];
  }),
);

// ---------------------------------------------------------------------------
// The park
// ---------------------------------------------------------------------------

/** The park the family gave in answer to the assistant's park question this episode (SCRUM-831's memory), the latest. */
export function answeredPark(questions: readonly EpisodeQuestion[] | undefined): AiBranchKey | null {
  for (const q of [...(questions ?? [])].reverse()) {
    if (q.slot === 'park' && q.state === 'answered' && isBranchKey(q.answer)) return q.answer;
  }
  return null;
}

/** A park question of this episode still waits for the family's answer: it is never asked again here (the repeat guard counts the asks). */
export function parkQuestionOpen(questions: readonly EpisodeQuestion[] | undefined): boolean {
  return (questions ?? []).some((q) => q.slot === 'park' && q.state === 'open');
}

/**
 * The park the family named this episode: the latest of their lines that
 * names a park — earlier messages included (`EpisodeState.customerLines`),
 * and this burst — when it names exactly one. A line naming both ("Central or
 * Chalong, which is closer?") is a choice, not a park: null.
 */
export function parkNamedByFamily(input: GateInput): AiBranchKey | null {
  const lines = [...(input.episode.customerLines ?? []), ...(input.openLines ?? [])];
  for (const line of [...lines].reverse()) {
    const named = parksNamedIn(line.normalize('NFC'));
    if (named.length === 1) return named[0]!;
    if (named.length > 1) return null;
  }
  return null;
}

/**
 * The park is known: the thread has one, the model read one in this burst,
 * or the family already answered the park question this episode.
 */
export function parkKnown(branchNamed: AiBranchKey | null, episode: EpisodeState): boolean {
  return episode.threadHasBranch || branchNamed !== null || answeredPark(episode.questions) !== null;
}

/**
 * The gate's input with the family's answer to the park question read as the
 * park they named: the latest of their lines this episode that names a park
 * names exactly that park, the memory read it as the answer, the thread has
 * no park and the model left `branchNamed` empty. Else the input as given.
 */
export function parkAnswerRead(input: GateInput): GateInput {
  const d = input.decision;
  if (d.branchNamed !== null || input.episode.threadHasBranch) return input;
  const answered = answeredPark(input.episode.questions);
  if (answered === null || parkNamedByFamily(input) !== answered) return input;
  return { ...input, decision: { ...d, branchNamed: answered } };
}

/** The park a source belongs to: a live fact's (`fact.hours.central`), a park's row (`key@chalong`), or the one park its key or words name. Null: both parks'. */
function parkOfSource(s: GroundingSource): AiBranchKey | null {
  const fact = /^fact\.[a-z_]+\.([a-z_]+)$/.exec(s.key);
  if (fact) return isBranchKey(fact[1]) ? fact[1] : null;
  const at = s.key.lastIndexOf('@');
  if (at !== -1) {
    const park = s.key.slice(at + 1);
    return isBranchKey(park) ? park : null;
  }
  const byKey = parksNamedIn(s.key);
  if (byKey.length > 0) return byKey.length === 1 ? byKey[0]! : null;
  const byText = parksNamedIn(s.text);
  return byText.length === 1 ? byText[0]! : null;
}

/** What a park's source says, without the park's own name: a live fact is "<park name> opening hours: <hours>". */
function parkFreeText(s: GroundingSource): string {
  const body = s.key.startsWith('fact.') && s.text.includes(': ') ? s.text.slice(s.text.indexOf(': ') + 2) : s.text;
  return body.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** A live fact the park has not set ("not set (do not state it)"): the knowledge says nothing of that park there. */
const NOT_SET = /^not set\b/u;

/**
 * The knowledge says the parks' answers on this topic differ: each park's own
 * sources of the topic (live facts, rows kept for one park, entries named for
 * one park) compared, their words without the park's name. A topic only
 * both-parks entries answer (parking is free at both malls) does not differ,
 * and neither does one the knowledge says nothing of for a park (a live fact
 * not set, no entry of its own): there is nothing to compare.
 */
export function parksDiffer(topic: AiGroundingTopic, grounding: ReadonlyMap<string, GroundingSource>): boolean {
  const by: Record<AiBranchKey, string[]> = { central: [], chalong: [] };
  for (const s of grounding.values()) {
    if (s.topic !== topic) continue;
    const park = parkOfSource(s);
    if (park === null) continue;
    const text = parkFreeText(s);
    if (s.key.startsWith('fact.') && NOT_SET.test(text)) continue;
    by[park].push(text);
  }
  const a = by.central.sort();
  const b = by.chalong.sort();
  if (a.length === 0 || b.length === 0) return false;
  return a.length !== b.length || a.some((t, i) => t !== b[i]);
}

/**
 * The reply's answer depends on the park: a part in `PARK_FIRST_INTENTS`
 * whose cited topics (or, citing none of them, its own topics) differ park by
 * park in the knowledge.
 */
export function dependsOnPark(
  v: { intents: readonly AiIntent[]; groundingKeys: readonly string[] },
  grounding: ReadonlyMap<string, GroundingSource>,
): boolean {
  for (const intent of v.intents) {
    if (!PARK_FIRST_INTENTS.has(intent)) continue;
    const rule = INTENT_TABLE[intent];
    if (rule.action !== 'answer' || rule.groundingTopics === null) continue;
    const topics = rule.groundingTopics;
    const cited = new Set<AiGroundingTopic>();
    for (const key of v.groundingKeys) {
      const topic = grounding.get(key)?.topic;
      if (topic !== undefined && topics.includes(topic)) cited.add(topic);
    }
    const read = cited.size > 0 ? [...cited] : topics;
    if (read.some((t) => parksDiffer(t, grounding))) return true;
  }
  return false;
}

/**
 * The reply answers for ONE park: every park-dependent source it cites that
 * belongs to a park (a live fact, a park's row, an entry named for one park)
 * is that park's. With no park known, that is a guess. A reply citing both
 * parks' sources is an overview; one citing only both-parks entries names no
 * park.
 */
export function guessesOnePark(v: { groundingKeys: readonly string[] }, grounding: ReadonlyMap<string, GroundingSource>): boolean {
  const parks = new Set<AiBranchKey>();
  for (const key of v.groundingKeys) {
    const s = grounding.get(key);
    if (!s || !PARK_TOPICS.has(s.topic)) continue;
    const park = parkOfSource(s);
    if (park !== null) parks.add(park);
  }
  return parks.size === 1;
}

/**
 * PARK FIRST: the reply as the playbook's park question alone, or null to
 * leave it. Only in a general thread (not a birthday one) with no park known
 * (`parkKnown`, nor named by the family this episode: `parkNamedByFamily`; a
 * burst naming both parks is a choice, answered), no park question still
 * waiting for its answer, no colleague taking over after it, a reply whose
 * every part is park-dependent (a greeting or a thank-you aside), an answer
 * that depends on the park (`dependsOnPark`), and the owner's pattern: the
 * model asked which park (`askBranch`, or the park among the slots it asks),
 * or it answered for one park only (`guessesOnePark`).
 */
export function parkFirst(v: AnswerVerdict, input: GateInput): AnswerVerdict | null {
  const ep = input.episode;
  const d = input.decision;
  if (v.thenHandover !== null) return null;
  if ((ep.threadCategory ?? 'general') !== 'general' || birthdayThreadOf(ep) !== null) return null;
  const topical = v.intents.filter((i) => !ASIDE_INTENTS.has(i));
  if (topical.length === 0 || !topical.every((i) => PARK_FIRST_INTENTS.has(i))) return null;
  if (parkKnown(v.branchNamed, ep)) return null;
  if (parksNamedIn((input.openLines ?? []).join('\n')).length > 0) return null;
  if (parkNamedByFamily(input) !== null) return null;
  if (parkQuestionOpen(ep.questions)) return null;
  if (!dependsOnPark(v, input.grounding)) return null;
  const modelAsked = d.askBranch || askedSlotsOf(d.askedSlots, v.bubbles).includes('park');
  if (!modelAsked && !guessesOnePark(v, input.grounding)) return null;
  return {
    ...v,
    bubbles: [PARK_QUESTION[v.language]],
    sendBrochure: false,
    askBranch: true,
    mayAutoHandle: false,
    languageOffer: null,
    askedSlots: ['park'],
    composition: { parkFirst: true, bubbles: v.bubbles.length, joined: true, duplicates: 0, repeats: 0, parkQuestions: 0 },
  };
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/** A sentence of a text, as written, and where it sits in it. */
interface Span {
  text: string;
  start: number;
  end: number;
}

/**
 * Where one sentence ends and the next begins inside a line: after a full
 * stop, an exclamation or a question mark; after an emoji that ends one
 * sentence before a capital starts the next; and — Thai writes no full stop —
 * after a clause closed by a polite particle (ค่ะ, คะ, ครับ…) before the next
 * Thai word. A space inside a Thai clause, or beside a Latin word inside Thai
 * ("ชั้น B ของ Central Floresta"), never splits.
 */
const SENTENCE_BREAK =
  /(?<=[.!?…。！？])\s+|(?<=\p{Extended_Pictographic}\uFE0F?)\s+(?=\p{Lu})|(?<=ค่ะ|คะ|ครับ|ค่า|จ้า|จ้ะ)[ \t\u00A0]+(?=[\u0E00-\u0E7F])/gu;

/** A text's sentences, in order, with their places: split at a line break and at `SENTENCE_BREAK`. */
function spansOf(text: string): Span[] {
  const out: Span[] = [];
  for (const line of text.matchAll(/[^\n]+/gu)) {
    const base = line.index;
    const l = line[0];
    const push = (a: number, b: number) => {
      const raw = l.slice(a, b);
      const trimmed = raw.trim();
      if (!trimmed) return;
      const start = base + a + (raw.length - raw.trimStart().length);
      out.push({ text: trimmed, start, end: start + trimmed.length });
    };
    let from = 0;
    for (const m of l.matchAll(SENTENCE_BREAK)) {
      push(from, m.index);
      from = m.index + m[0].length;
    }
    push(from, l.length);
  }
  return out;
}

/**
 * A text's sentences, in order, as written: split at a line break, after a
 * full stop, an exclamation or a question mark, after an emoji that ends one
 * sentence before a capital starts the next, and in Thai after a clause a
 * polite particle closes. A Thai line is otherwise one clause.
 */
export function sentencesOf(text: string): string[] {
  return spansOf(text.normalize('NFC')).map((s) => s.text);
}

/**
 * The text less the dropped sentences, everything else as written: a line
 * keeps its lead and the spaces between its kept sentences, a line that loses
 * every sentence goes, and the line breaks between the rest stay.
 */
function withoutSpans(text: string, spans: readonly Span[], dropped: ReadonlySet<number>): string {
  const out: string[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const here = spans.flatMap((s, i) => (s.start >= start && s.end <= end ? [{ s, i }] : []));
    const kept = here.filter(({ i }) => !dropped.has(i));
    if (here.length === 0 || kept.length === here.length) {
      out.push(line);
      continue;
    }
    if (kept.length === 0) continue;
    let rebuilt = line.slice(0, here[0]!.s.start - start);
    kept.forEach(({ s }, k) => {
      if (k > 0) {
        const before = here[here.findIndex((h) => h.s === s) - 1]!.s;
        rebuilt += line.slice(before.end - start, s.start - start) || ' ';
      }
      rebuilt += s.text;
    });
    out.push(rebuilt.trimEnd());
  }
  return out
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** Letters, marks (Thai vowels and tones) and digits, lower case, one space between; an emoji's joiners and variation selectors are no marks. */
const normalized = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/\u200D|[\uFE00-\uFE0F]|\u20E3/gu, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

const trigrams = (s: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i + 3 <= s.length; i += 1) out.push(s.slice(i, i + 3));
  return out;
};

const subset = <T>(a: readonly T[], b: readonly T[]) => a.every((x) => b.includes(x));
const letterCount = (s: string) => s.match(/\p{L}/gu)?.length ?? 0;
const THAI = /[\u0E00-\u0E7F]/u;

/** A sentence shorter than this (in letters) is never read as a near repeat ("Easy!", "Hi!"), and never dropped as said twice, even word for word. */
const MIN_NEAR_LETTERS = 12;
/** Thai writes no spaces between words: the share of a Thai sentence's three-letter runs another must hold. */
const THAI_NEAR_SAME = 0.9;
/** Words that say nothing of their own (Latin and Cyrillic); shorter than three letters is never a word here. */
const FILLER = new Set([
  'the', 'and', 'for', 'are', 'our', 'you', 'your', 'with', 'this', 'that', 'from', 'just', 'also', 'will', 'have', 'has',
  'was', 'were', 'then', 'there', 'here', 'all', 'can', 'its',
  'это', 'для', 'вас', 'нас', 'все', 'так', 'там', 'тут', 'уже', 'еще', 'ещё',
]);
const wordsOf = (normal: string) => normal.split(' ').filter((w) => /^[\p{Script=Latin}\p{Script=Cyrillic}]{3,}$/u.test(w) && !FILLER.has(w));
/** Fewer words than this are a repeat only word for word: a heading ("For the children") is not one of a longer line. */
const MIN_NEAR_WORDS = 3;
/** And a near repeat says at least this share of what the other said: a name inside a long paragraph is not a repeat of it. */
const NEAR_COVERS = 0.5;
/** A "not" in one and not the other is never the same thing ("Socks are required" is not "Socks are not required for adults"). */
const NEGATION = /(?<![\p{L}])(?:not|no|never|none|cannot)(?![\p{L}])|n['’]t(?![\p{L}])|(?<![\p{L}])(?:не|нет|нельзя|ни)(?![\p{L}])|ไม่/iu;

/**
 * `a` says what `b` already said: the same words, or nearly — three words or
 * more, every one of them in `b` (a word of its own is a fact of its own:
 * "weekends" is not "weekdays", "reception" is not "the restaurant"), and at
 * least half of what `b` says; in Thai most of its three-letter runs — with no
 * number, no park and no "not" of its own. "We're on the basement floor of
 * Central Floresta, opposite the aquarium" says again what "One is at Central
 * Floresta on the basement floor, opposite the aquarium, and the other…"
 * said; "Weekend: 690 baht per child" does not say "Weekday: 690 baht per
 * child", and "Central Floresta is open 10:00–20:00" does not say
 * "…10:00–21:00".
 */
export function sameSentence(a: string, b: string): boolean {
  const na = normalized(a);
  const nb = normalized(b);
  if (na === '') return false;
  if (na === nb) return true;
  if (letterCount(na) < MIN_NEAR_LETTERS) return false;
  if (!subset(na.match(/\p{N}+/gu) ?? [], nb.match(/\p{N}+/gu) ?? [])) return false;
  if (!subset(parksNamedIn(a), parksNamedIn(b))) return false;
  if (NEGATION.test(a) !== NEGATION.test(b)) return false;
  if (THAI.test(na)) {
    const runsA = new Set(trigrams(na));
    const runsB = new Set(trigrams(nb));
    const shared = [...runsA].filter((t) => runsB.has(t)).length;
    return runsA.size > 0 && shared / runsA.size >= THAI_NEAR_SAME && shared / runsB.size >= NEAR_COVERS;
  }
  const words = [...new Set(wordsOf(na))];
  if (words.length < MIN_NEAR_WORDS) return false;
  const inB = new Set(wordsOf(nb));
  if (words.some((w) => !inB.has(w))) return false;
  return words.length / inB.size >= NEAR_COVERS;
}

const isQuestion = (s: string) => questionsIn([s]).length > 0;

/** A sentence that asks which park and nothing else ("Which branch are you thinking of…?"); the birthday's combined question asks more, and stays. */
export function asksOnlyThePark(sentence: string): boolean {
  if (!isQuestion(sentence)) return false;
  const slots = slotsAskedIn([sentence]);
  return slots.length === 1 && slots[0] === 'park';
}

/** A sentence with something to say: at least this many letters. */
const SUBSTANTIVE_LETTERS = 12;
const substantive = (s: string) => letterCount(s) >= SUBSTANTIVE_LETTERS;

// ---------------------------------------------------------------------------
// What a sentence is about
// ---------------------------------------------------------------------------

/** A park's own name, which says nothing of the topic ("See you at Central Floresta!"). */
const PARK_NAME_WORD = /^(?:central|floresta|robinson|chalong|централ\p{L}*|флорест\p{L}*|робинсон\p{L}*|чалонг\p{L}*)$/u;
const THAI_PARK_NAMES = /เซ็นทรัล|ฟลอเรสต้า|โรบินสัน|ฉลอง|central|floresta|robinson|chalong/gu;
/** The words and numbers that carry what a text says (Latin and Cyrillic), the parks' names left out. */
const contentOf = (normal: string): string[] => [
  ...new Set(
    normal
      .split(' ')
      .filter((w) => (/^[\p{Script=Latin}\p{Script=Cyrillic}]{3,}$/u.test(w) && !FILLER.has(w) && !PARK_NAME_WORD.test(w)) || /^\p{N}+$/u.test(w)),
  ),
];
/** A Thai sentence must share this share of its three-letter runs with a source to restate it. */
const THAI_RESTATES = 0.5;
const THAI_MIN_RUNS = 6;

/**
 * The sentence restates the source: in Latin or Cyrillic, two of its words or
 * numbers or more, at least half of them, are the source's (the parks' names
 * left out); in Thai, half its three-letter runs are.
 */
function restates(sentence: string, source: string): boolean {
  const ns = normalized(sentence);
  const nsrc = normalized(source);
  if (THAI.test(ns)) {
    const plain = (t: string) => t.replace(THAI_PARK_NAMES, ' ').replace(/\s+/gu, '');
    const runs = new Set(trigrams(plain(ns)));
    if (runs.size < THAI_MIN_RUNS) return false;
    const inSource = new Set(trigrams(plain(nsrc)));
    return [...runs].filter((t) => inSource.has(t)).length / runs.size >= THAI_RESTATES;
  }
  const words = contentOf(ns);
  if (words.length < 2) return false;
  const inSource = new Set(contentOf(nsrc));
  const shared = words.filter((w) => inSource.has(w)).length;
  return shared >= 2 && shared / words.length >= NEAR_COVERS;
}

/**
 * The park topics a sentence is about (`PARK_TOPICS`), read from the
 * knowledge, never assumed: the topics of the offered sources it restates.
 * None: the sentence is not about the park ("See you soon at OTO!").
 */
export function parkTopicsOf(sentence: string, grounding: ReadonlyMap<string, GroundingSource>): AiGroundingTopic[] {
  const out = new Set<AiGroundingTopic>();
  for (const s of grounding.values()) if (PARK_TOPICS.has(s.topic) && !out.has(s.topic) && restates(sentence, s.text)) out.add(s.topic);
  return [...out];
}

/** Words too common to say what a message asks about. */
const COMMON = new Set([
  'about', 'also', 'and', 'are', 'can', 'could', 'from', 'have', 'here', 'just', 'like', 'please', 'thank', 'thanks', 'that', 'the',
  'there', 'they', 'this', 'what', 'when', 'where', 'which', 'will', 'with', 'would', 'your', 'you', 'guys', 'hello',
  'есть', 'если', 'когда', 'где', 'как', 'какой', 'какая', 'что', 'это', 'для', 'вас', 'нас', 'здравствуйте', 'спасибо', 'пожалуйста',
]);
const THAI_PARTICLES = /ค่ะ|คะ|นะ|ครับ|จ้า|ค่า/gu;

/**
 * The customer's open lines ask about what the sentence says: a word of four
 * letters or more they share (neither a park's name nor a common word), or,
 * in Thai, four letters in a row. A family asking again gets the answer again.
 */
function customerAsksAbout(lines: string, sentence: string): boolean {
  if (lines.trim() === '') return false;
  const s = normalized(sentence);
  const words = normalized(lines)
    .split(' ')
    .filter((w) => /^[\p{Script=Latin}\p{Script=Cyrillic}\p{N}]{4,}$/u.test(w) && !COMMON.has(w) && parksNamedIn(w).length === 0);
  if (words.some((w) => new RegExp(`(?<![\\p{L}\\p{N}])${w}`, 'u').test(s))) return true;
  for (const run of lines.normalize('NFC').replace(THAI_PARTICLES, ' ').match(/[\u0E00-\u0E7F]{4,}/gu) ?? []) {
    if (parksNamedIn(run).length > 0) continue;
    for (let i = 0; i + 4 <= run.length; i += 1) if (sentence.includes(run.slice(i, i + 4))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The one message
// ---------------------------------------------------------------------------

/** What `composeMessage` may drop besides a sentence said twice in the reply. */
export interface ComposeOptions {
  /** Compose the parts into ONE message (an answer on one topic); false: a bubble per part. Default true. */
  join?: boolean;
  /** Lines already sent this episode: a sentence among them is a repeat (`repeatRule`). */
  said?: readonly string[];
  /** A repeat that is still sent: the family asked about it again. Absent: none is. */
  keepRepeat?: (sentence: string) => boolean;
  /** A question the reply no longer asks (`asksOnlyThePark` once the park is known). Never the whole reply. */
  dropQuestion?: (sentence: string) => boolean;
}

/** The turn's bubbles, the parts they hold (each as written, less what was dropped), and what composing them dropped. */
export interface ComposedMessage {
  /** One bubble when joined, else one per part left. */
  bubbles: string[];
  /** The parts, in order. */
  parts: string[];
  duplicates: number;
  repeats: number;
  parkQuestions: number;
}

/**
 * THE MESSAGE: the parts in their order, joined by a blank line (`PART_JOIN`)
 * into ONE bubble, or, `join: false`, a bubble each. Each part is as written
 * unless a sentence of it was dropped — then only that sentence is cut out,
 * the part's line breaks kept. Dropped:
 *
 *   - a sentence a later part says again after an earlier part said it (near
 *     enough, `sameSentence`) — never inside one part, never one under
 *     `MIN_NEAR_LETTERS` letters, and never between parts that are each an
 *     item of their own: a part of several lines (a list, a table: each row
 *     its own fact), a part with a number (a package, a park's prices:
 *     "Adults 150 baht" and "Includes a cake" at each are facts of each), or
 *     two parts about two different parks;
 *   - a question `dropQuestion` names — unless nothing would be left;
 *   - given `said`, a sentence already sent that `keepRepeat` does not keep —
 *     never a question, and none at all when no new sentence with something
 *     to say would be left (never silence).
 */
export function composeMessage(parts: readonly string[], opts: ComposeOptions = {}): ComposedMessage {
  const texts = parts.map((p) => p.normalize('NFC'));
  const spans = texts.map((t) => spansOf(t));
  const dropped = spans.map(() => new Set<number>());
  const live = (i: number, j: number) => !dropped[i]!.has(j);
  // A part of several lines is a list or a table: each row is a fact of its own.
  const rows = texts.map((t) => t.trim().includes('\n'));
  // A part with a number is a fact sheet of its item (a package, a park's prices): its sentences are its own.
  const numbered = texts.map((t) => /\p{N}/u.test(t));
  const parkOf = texts.map((t) => {
    const named = parksNamedIn(t);
    return named.length === 1 ? named[0]! : null;
  });
  // Two parts each about one park, not the same one: the same words are a fact of each park.
  const otherPark = (i: number, k: number) => parkOf[i] !== null && parkOf[k] !== null && parkOf[i] !== parkOf[k];
  const sameItem = (i: number, k: number) => !rows[k] && !numbered[k] && !otherPark(i, k);

  let duplicates = 0;
  spans.forEach((ss, i) => {
    if (rows[i] || numbered[i]) return;
    ss.forEach((s, j) => {
      if (letterCount(s.text) < MIN_NEAR_LETTERS) return;
      const before = spans
        .slice(0, i)
        .some((earlier, k) => sameItem(i, k) && earlier.some((b, m) => live(k, m) && sameSentence(s.text, b.text)));
      if (!before) return;
      dropped[i]!.add(j);
      duplicates += 1;
    });
  });

  let parkQuestions = 0;
  if (opts.dropQuestion) {
    const asks: Array<[number, number]> = [];
    spans.forEach((ss, i) => ss.forEach((s, j) => live(i, j) && opts.dropQuestion!(s.text) && asks.push([i, j])));
    const left = spans.some((ss, i) => ss.some((_, j) => live(i, j) && !asks.some(([a, b]) => a === i && b === j)));
    if (asks.length > 0 && left) {
      for (const [i, j] of asks) dropped[i]!.add(j);
      parkQuestions = asks.length;
    }
  }

  let repeats = 0;
  const said = (opts.said ?? []).flatMap((l) => sentencesOf(l));
  if (said.length > 0) {
    const saidBefore = (s: string) => said.some((b) => sameSentence(s, b));
    const trial: Array<[number, number]> = [];
    spans.forEach((ss, i) =>
      ss.forEach((s, j) => {
        if (!live(i, j) || isQuestion(s.text) || !saidBefore(s.text)) return;
        if (opts.keepRepeat?.(s.text) === true) return;
        trial.push([i, j]);
      }),
    );
    const isTrial = (i: number, j: number) => trial.some(([a, b]) => a === i && b === j);
    const fresh = spans.some((ss, i) => ss.some((s, j) => live(i, j) && !isTrial(i, j) && substantive(s.text) && !saidBefore(s.text)));
    if (trial.length > 0 && fresh) {
      for (const [i, j] of trial) dropped[i]!.add(j);
      repeats = trial.length;
    }
  }

  const out = texts
    .map((t, i) => (dropped[i]!.size === 0 ? parts[i]!.trim() : withoutSpans(t, spans[i]!, dropped[i]!)))
    .filter((t) => t.length > 0);
  const join = opts.join ?? true;
  return { bubbles: join ? [out.join(PART_JOIN)] : out, parts: out, duplicates, repeats, parkQuestions };
}

/**
 * NO REPETITION, as the owner ruled it (rule 3), or null where it does not
 * apply: once the family answered the park question this episode, what the
 * assistant said about the park before or in the reply that answered it
 * (`EpisodeState.parkLines`) — where a park is, the way in, the parking, the
 * hours (`parkTopicsOf`) — is not said again, in the turn that answers the
 * park question (`parkAnsweredNow`) or a later one. A repeat stays when:
 *
 *   - it is not about the park ("See you soon at OTO!");
 *   - in a later turn, the reply answers its topic (its intents' topics, or
 *     a source it cites): the family asked again ("Sorry, where is Central
 *     again?", "We are lost in the mall, help!", "Where do we leave the
 *     car?");
 *   - in a later turn, the family names the park it is about;
 *   - the family's lines share a word with it (`customerAsksAbout`).
 *
 * In the turn that answers the park question, the family's "Central" is the
 * answer, not a question about Central: the location already given is not
 * said again, and the directions and the parking are.
 */
export function repeatRule(v: AnswerVerdict, input: GateInput): Pick<ComposeOptions, 'said' | 'keepRepeat'> | null {
  const ep = input.episode;
  const said = ep.parkLines ?? [];
  if (said.length === 0 || answeredPark(ep.questions) === null) return null;
  const answering = ep.parkAnsweredNow === true;
  const covered = new Set<AiGroundingTopic>();
  for (const i of v.intents) {
    const rule = INTENT_TABLE[i];
    if (rule.action === 'answer') for (const t of rule.groundingTopics ?? []) covered.add(t);
  }
  for (const key of v.groundingKeys) {
    const topic = input.grounding.get(key)?.topic;
    if (topic !== undefined) covered.add(topic);
  }
  const asked = (input.openLines ?? []).join('\n');
  const namedNow = answering ? [] : parksNamedIn(asked);
  return {
    said,
    keepRepeat: (s) => {
      const topics = parkTopicsOf(s, input.grounding);
      if (topics.length === 0) return true;
      if (!answering && topics.some((t) => covered.has(t))) return true;
      if (parksNamedIn(s).some((p) => namedNow.includes(p))) return true;
      return customerAsksAbout(asked, s);
    },
  };
}

/**
 * The park the family named this episode, read for an answer that depends on
 * the park when the model left it unnamed on a thread with none: the thread's
 * park is set to it, as when they answer the park question.
 */
function familyParkFor(v: AnswerVerdict, input: GateInput): AiBranchKey | null {
  if (v.branchNamed !== null || input.episode.threadHasBranch) return null;
  if (!v.intents.some((i) => PARK_FIRST_INTENTS.has(i))) return null;
  return parkNamedByFamily(input);
}

/**
 * The turn's message (the last step of `applyGates`): an answer verdict as
 * the park question alone (`parkFirst`), or with its bubbles composed — one
 * message when the answer is on one topic (`topicsOfIntents`), a sentence a
 * later part says again dropped, the park question dropped once the park is
 * known, repeats dropped once the family gave the park (`repeatRule`). The
 * parts the one message joins ride with it (`parts`, for the coherence
 * review). A verdict with nothing to change is returned as it is; a
 * hand-over (SCRUM-823's opener beside an advice hand-over included), a
 * silence and a silent hand-over always are.
 */
export function composeTurn(v: GateVerdict, input: GateInput): GateVerdict {
  if (v.action !== 'answer' || v.bubbles.length === 0) return v;
  const asked = parkFirst(v, input);
  if (asked) return asked;
  const familyPark = familyParkFor(v, input);
  const branchNamed = v.branchNamed ?? familyPark;
  const known = parkKnown(branchNamed, input.episode) || parkNamedByFamily(input) !== null;
  // The price conversation and the birthday ask the park inside their own one question, which is
  // theirs to word (and the repeat guard's to refuse): never cut from it, whatever the slot reader sees.
  const ownQuestion = v.intents.some((i) => OWN_PARK_QUESTION_INTENTS.has(i));
  const join = topicsOfIntents(v.intents).length <= 1;
  const composed = composeMessage(v.bubbles, {
    join,
    ...(repeatRule(v, input) ?? {}),
    ...(known && !ownQuestion ? { dropQuestion: asksOnlyThePark } : {}),
  });
  const dropped = composed.duplicates + composed.repeats + composed.parkQuestions;
  const joined = join && v.bubbles.length > 1;
  if (dropped === 0 && !joined && familyPark === null) return v;
  const unasked: Partial<AnswerVerdict> =
    composed.parkQuestions > 0
      ? { askBranch: false, askedSlots: (input.decision.askedSlots ?? []).filter((s): s is AiAskedSlot => s !== 'park') }
      : {};
  return {
    ...v,
    branchNamed,
    bubbles: composed.bubbles,
    ...unasked,
    ...(join && composed.parts.length > 1 ? { parts: composed.parts } : {}),
    composition: {
      parkFirst: false,
      bubbles: v.bubbles.length,
      joined: join,
      duplicates: composed.duplicates,
      repeats: composed.repeats,
      parkQuestions: composed.parkQuestions,
    },
  };
}
