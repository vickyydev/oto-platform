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
 * the gate lets through (an answer verdict; a hand-over's words are its own):
 *
 *   1. PARK FIRST (`parkFirst`): in a general thread with no park, a reply
 *      whose parts depend on the park (`PARK_FIRST_INTENTS`: where a park
 *      is, the way in and the parking, the hours) — read from the knowledge,
 *      never assumed: the topics the reply cites are compared park by park
 *      (`parksDiffer`) — while the customer's burst names no park, is the
 *      playbook's park question ALONE, in the customer's language, declared
 *      `askedSlots: ['park']` so SCRUM-831's memory records it and reads the
 *      family's "Central" as the answer. The price conversation and the
 *      birthday ask the park inside their own one question and are left to
 *      it (`OWN_PARK_QUESTION_INTENTS`); a reply a colleague takes over after
 *      is left as it is.
 *   2. ONE MESSAGE (`composeMessage`): the reply's bubbles are composed into
 *      ONE message — the parts in their order, a blank line between them,
 *      no sentence said twice. The closing or hand-over line the playbook
 *      keeps separate is never a bubble of the verdict: the engine sends it
 *      after the one message (`thenHandover`). Where a template already
 *      carries the hand-over and its question in one message (SCRUM-823's
 *      opener beside an advice hand-over), that one message is the turn's.
 *      The parts ride with it (`parts`): the engine shows them to the
 *      coherence reviewer one by one (SCRUM-677), then sends what survives
 *      side by side as the one message.
 *   3. NO REPETITION (`composeMessage`, `said`): once the park is known, a
 *      sentence the assistant already sent this episode is not sent again —
 *      never a question (the repeat guard owns those), never one the
 *      customer's open lines ask about again, and never when nothing new
 *      would be left (the reply then goes as composed: never silence).
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
  INTENT_TABLE,
  OWN_PARK_QUESTION_INTENTS,
  PARK_FIRST_INTENTS,
  birthdayThreadOf,
  type AiGroundingTopic,
  type AiIntent,
} from './intents';
import { EN_PERSONA, RU_PERSONA, TH_PERSONA } from './persona';
import { parksNamedIn, questionsIn } from './slots';

type AnswerVerdict = Extract<GateVerdict, { action: 'answer' }>;

/** How the turn's one message was composed: counts and words, never text (the turn's pill and audit). */
export interface TurnComposition {
  /** The reply became the park question alone (`parkFirst`). */
  parkFirst: boolean;
  /** The model's bubbles the one message was composed from. */
  bubbles: number;
  /** Sentences the reply said twice, dropped. */
  duplicates: number;
  /** Sentences already sent this episode, dropped once the park was known. */
  repeats: number;
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

/**
 * The park is known: the thread has one, the model read one in this burst,
 * or the family already answered the park question this episode.
 */
export function parkKnown(branchNamed: AiBranchKey | null, episode: EpisodeState): boolean {
  return episode.threadHasBranch || branchNamed !== null || answeredPark(episode.questions) !== null;
}

/**
 * The gate's input with the family's answer to the park question read as the
 * park they named: their burst names exactly that park, the memory read it
 * as the answer, the thread has no park and the model left `branchNamed`
 * empty. Else the input as given.
 */
export function parkAnswerRead(input: GateInput): GateInput {
  const d = input.decision;
  if (d.branchNamed !== null || input.episode.threadHasBranch) return input;
  const answered = answeredPark(input.episode.questions);
  if (answered === null) return input;
  const named = parksNamedIn((input.openLines ?? []).join('\n'));
  if (named.length !== 1 || named[0] !== answered) return input;
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
 * PARK FIRST: the reply as the playbook's park question alone, or null to
 * leave it. Only in a general thread (not a birthday one) with no park known,
 * a burst that names no park, no flow that asks the park in its own question,
 * no colleague taking over after it, and an answer that depends on the park.
 */
export function parkFirst(v: AnswerVerdict, input: GateInput): AnswerVerdict | null {
  const ep = input.episode;
  if (v.thenHandover !== null) return null;
  if ((ep.threadCategory ?? 'general') !== 'general' || birthdayThreadOf(ep) !== null) return null;
  if (v.intents.some((i) => OWN_PARK_QUESTION_INTENTS.has(i))) return null;
  if (parkKnown(v.branchNamed, ep)) return null;
  if (parksNamedIn((input.openLines ?? []).join('\n')).length > 0) return null;
  if (!dependsOnPark(v, input.grounding)) return null;
  return {
    ...v,
    bubbles: [PARK_QUESTION[v.language]],
    sendBrochure: false,
    askBranch: true,
    mayAutoHandle: false,
    languageOffer: null,
    askedSlots: ['park'],
    composition: { parkFirst: true, bubbles: v.bubbles.length, duplicates: 0, repeats: 0 },
  };
}

// ---------------------------------------------------------------------------
// The one message
// ---------------------------------------------------------------------------

/**
 * A text's sentences, in order, as written: split after a full stop, an
 * exclamation or a question mark, after an emoji that ends one sentence
 * before a capital starts the next, at a line break, and — Thai writes no
 * full stop — at a space between two Thai letters. A space beside a Latin
 * word inside Thai ("ชั้น B ของ Central Floresta") never splits.
 */
export function sentencesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of text.normalize('NFC').split(/\n+/u)) {
    for (const piece of line.split(
      /(?<=[.!?…。！？])\s+|(?<=\p{Extended_Pictographic}\uFE0F?)\s+(?=\p{Lu})|(?<=[\u0E00-\u0E7F])\s+(?=[\u0E00-\u0E7F])/u,
    )) {
      const s = piece.trim();
      if (s) out.push(s);
    }
  }
  return out;
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

/** A sentence shorter than this (in letters) is never read as a near repeat ("Easy!", "Hi!"), only an exact one. */
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
/** A long sentence may carry one word of its own and still say the same thing ("We're right on the basement floor…"). */
const LONG_SENTENCE_WORDS = 6;
/** Fewer words than this are a repeat only word for word: a heading ("For the children") is not one of a longer line. */
const MIN_NEAR_WORDS = 3;
/** And a near repeat says at least this share of what the other said: a name inside a long paragraph is not a repeat of it. */
const NEAR_COVERS = 0.5;
/** A "not" in one and not the other is never the same thing ("Socks are required" is not "Socks are not required for adults"). */
const NEGATION = /(?<![\p{L}])(?:not|no|never|none|cannot)(?![\p{L}])|n['’]t(?![\p{L}])|(?<![\p{L}])(?:не|нет|нельзя|ни)(?![\p{L}])|ไม่/iu;

/**
 * `a` says what `b` already said: the same words, or nearly — three words or
 * more, every one of them in `b` (one word of its own allowed in a long
 * sentence), and at least half of what `b` says; in Thai most of its
 * three-letter runs — with no number, no park and no "not" of its own. "We're on
 * the basement floor of Central Floresta, opposite the aquarium" says again
 * what "One is at Central Floresta on the basement floor, opposite the
 * aquarium, and the other…" said; "Weekend: 690 baht per child" does not say
 * "Weekday: 690 baht per child", and "Central Floresta is open 10:00–20:00"
 * does not say "…10:00–21:00".
 */
export function sameSentence(a: string, b: string): boolean {
  const na = normalized(a);
  const nb = normalized(b);
  if (na === '') return false;
  if (na === nb) return true;
  if ((na.match(/\p{L}/gu)?.length ?? 0) < MIN_NEAR_LETTERS) return false;
  if (!subset(na.match(/\p{N}+/gu) ?? [], nb.match(/\p{N}+/gu) ?? [])) return false;
  if (!subset(parksNamedIn(a), parksNamedIn(b))) return false;
  if (NEGATION.test(a) !== NEGATION.test(b)) return false;
  if (/[\u0E00-\u0E7F]/u.test(na)) {
    const runsA = new Set(trigrams(na));
    const runsB = new Set(trigrams(nb));
    const shared = [...runsA].filter((t) => runsB.has(t)).length;
    return runsA.size > 0 && shared / runsA.size >= THAI_NEAR_SAME && shared / runsB.size >= NEAR_COVERS;
  }
  const words = [...new Set(wordsOf(na))];
  if (words.length < MIN_NEAR_WORDS) return false;
  const inB = new Set(wordsOf(nb));
  const own = words.filter((w) => !inB.has(w)).length;
  if ((words.length - own) / inB.size < NEAR_COVERS) return false;
  return own === 0 || (own === 1 && words.length >= LONG_SENTENCE_WORDS);
}

const isQuestion = (s: string) => questionsIn([s]).length > 0;

/** A sentence with something to say: at least this many letters. */
const SUBSTANTIVE_LETTERS = 12;
const substantive = (s: string) => (s.match(/\p{L}/gu)?.length ?? 0) >= SUBSTANTIVE_LETTERS;

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

/** The one message, the parts it joins (each as written, less what was dropped), and what composing it dropped. */
export interface ComposedMessage {
  text: string;
  parts: string[];
  duplicates: number;
  repeats: number;
}

/**
 * ONE MESSAGE: the parts in their order, a blank line between them
 * (`PART_JOIN`), each part as written unless a sentence of it was dropped
 * (then its other sentences joined by a space, as Thai, English and Russian
 * all write them). Dropped: a sentence the reply already said (near enough,
 * `sameSentence`); and, given `said` (the assistant's lines this episode,
 * once the park is known), a sentence already sent — never a question, never
 * one the customer's `openLines` ask about, and none at all when no new
 * sentence with something to say would be left.
 */
export function composeMessage(
  parts: readonly string[],
  opts: { said?: readonly string[]; openLines?: readonly string[] } = {},
): ComposedMessage {
  const pieces = parts.map((p) => sentencesOf(p));
  let kept = pieces.map((ps) => ps.map(() => true));
  const before: string[] = [];
  let duplicates = 0;
  pieces.forEach((ps, i) =>
    ps.forEach((s, j) => {
      if (before.some((b) => sameSentence(s, b))) {
        kept[i]![j] = false;
        duplicates += 1;
      } else {
        before.push(s);
      }
    }),
  );

  let repeats = 0;
  const said = (opts.said ?? []).flatMap((l) => sentencesOf(l));
  if (said.length > 0) {
    const asked = (opts.openLines ?? []).join('\n');
    const saidBefore = (s: string) => said.some((b) => sameSentence(s, b));
    const trial = kept.map((row) => [...row]);
    let n = 0;
    pieces.forEach((ps, i) =>
      ps.forEach((s, j) => {
        if (!trial[i]![j] || isQuestion(s) || !saidBefore(s) || customerAsksAbout(asked, s)) return;
        trial[i]![j] = false;
        n += 1;
      }),
    );
    const fresh = pieces.some((ps, i) => ps.some((s, j) => trial[i]![j] && substantive(s) && !saidBefore(s)));
    if (n > 0 && fresh) {
      kept = trial;
      repeats = n;
    }
  }

  const out = pieces
    .map((ps, i) => (kept[i]!.every(Boolean) ? parts[i]!.trim() : ps.filter((_, j) => kept[i]![j]).join(' ')))
    .filter((t) => t.length > 0);
  return { text: out.join(PART_JOIN), parts: out, duplicates, repeats };
}

/**
 * The turn's message (the last step of `applyGates`): an answer verdict as
 * the park question alone (`parkFirst`), or with its bubbles composed into
 * one (`composeMessage`), repeats dropped once the park is known; the parts
 * the one message joins ride with it (`parts`, for the coherence review). A
 * verdict that is already one bubble with nothing to drop is returned as it
 * is; a hand-over, a silence and a silent hand-over always are.
 */
export function composeTurn(v: GateVerdict, input: GateInput): GateVerdict {
  if (v.action !== 'answer' || v.bubbles.length === 0) return v;
  const asked = parkFirst(v, input);
  if (asked) return asked;
  const said = parkKnown(v.branchNamed, input.episode) ? (input.episode.aiLines ?? []) : [];
  const composed = composeMessage(v.bubbles, { said, openLines: input.openLines ?? [] });
  if (v.bubbles.length === 1 && composed.duplicates === 0 && composed.repeats === 0) return v;
  return {
    ...v,
    bubbles: [composed.text],
    ...(composed.parts.length > 1 ? { parts: composed.parts } : {}),
    composition: { parkFirst: false, bubbles: v.bubbles.length, duplicates: composed.duplicates, repeats: composed.repeats },
  };
}
