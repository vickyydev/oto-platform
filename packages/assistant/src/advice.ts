/**
 * SCRUM-823 (owner, 10 Nov 2026): in a birthday conversation the assistant
 * still opens with the date-and-park question (owner D1, 28 Oct), but a
 * family asking for ADVICE, a RECOMMENDATION or a CHOICE — which park is
 * better for us, what do you suggest, which package would you recommend, can
 * we…, is it possible to…, anything beyond the brochure's facts — is handed to
 * a person at once, with the birthday manager's closing line, and the
 * birthday manager on duty is notified (the engine's hand-over notices).
 *
 * The model labels such a message `birthday_advice` (intents.ts). This file is
 * the server's SAFETY NET, the way SCRUM-817's date rule is: in a birthday
 * thread, a part the model labelled `birthday_details` or `faq` whose lines
 * ask for advice in Thai, English or Russian is overruled to
 * `birthday_advice` (`birthdayAdviceOverrule`, applied by `applyGates`).
 *
 * The word list has two tiers, so the owner can see — and move — the
 * threshold (`scripts/birthday-advice-measure.ts` counts both over the real
 * chats):
 *
 *   advice       asking us to recommend, suggest or advise; asking for a
 *                CHOICE (which one is better, which should we take, which one
 *                for us — never "which branch is open on Monday?"); asking
 *                what is better, best or suitable for them; asking what we
 *                think or whether they should.
 *   possibility  "can we…", "is it possible to…", "можно…", "ได้ไหม" — the
 *                owner's own examples. A line that names a day, a date or a
 *                time is the party's details, not advice ("Можно в субботу в
 *                2 часа дня?" stays SCRUM-817's `birthday_details`), so the
 *                possibility tier never fires on one. "ได้ไหม" and "можно" are
 *                also the ordinary way to ask a yes/no FACT in Thai and
 *                Russian ("Можно оплатить картой?", "จ่ายบัตรได้ไหมคะ"), so
 *                this tier never withholds an answer the model grounded in a
 *                fact of the knowledge (`FACT_IN_KB`): only an ungrounded one
 *                is overruled. A polite opener ("May I ask…", "Можно
 *                узнать…") is not a possibility question at all.
 *
 * Beside the opener (owner D1, 28 Oct, the playbook's first rule) the advice
 * never drops it: a burst that holds `birthday_party` and an advice part keeps
 * the opener's answer, and the birthday manager's closing line follows it
 * (`openerBesideAdvice`, `adviceAfterOpener`).
 *
 * The opener stays beside an advice HAND-OVER too (staging, 10 Nov: "We want
 * a birthday party for our daughter. What would you suggest?" was labelled
 * advice alone, and "We would like to book a birthday party for our son.
 * Which package would you recommend?" was handed over by the model itself;
 * either way the family got only the closing line, and was never asked the
 * date and the park). When an advice hand-over to Birthdays & Events answers
 * a party request whose basics nobody has asked yet, the verdict says so
 * (`adviceOpener`, `adviceOpenerOn`) and the engine sends ONE message, the
 * `opener_birthday_advice` template: the playbook's opener question followed
 * by the birthday manager's warm line, in the thread's language — or, where
 * the park is already known, `opener_birthday_advice_park_known`, the same
 * without the park. Nothing of the model's goes, and the hand-over is the one
 * it was. What the family said in an earlier message of the episode counts as
 * said: the opener never asks it again.
 *
 * Pure: no clock, no database, no model.
 */

import { mentionsPartyDate, mentionsPartyTime } from '@oto/shared';
import type { AiDecision } from './decision';
import type { EpisodeState, GateInput, GateVerdict } from './gate';
import {
  BIRTHDAY_INTENTS,
  BIRTHDAYS_PLAN,
  INTENT_TABLE,
  birthdayThreadOf,
  intentPartsOf,
  type AiAskedSlot,
  type AiIntent,
} from './intents';
import { headcountNamedIn, parkNamedIn } from './slots';

/** The rule word an overruled advice question records (the turn's audit `gate`, the hand-over pill's `rule`). */
export const BIRTHDAY_ADVICE_RULE = 'birthday_advice';

/** The labels the safety net overrules when the lines ask for advice (the brief: details or faq). */
export const BIRTHDAY_ADVICE_OVERRULED: ReadonlySet<AiIntent> = new Set<AiIntent>(['birthday_details', 'faq']);

/** What a line asks for: advice proper, or only whether something is possible. */
export type AdviceAsk = 'advice' | 'possibility';

/** A word boundary for Latin and Cyrillic alike (JavaScript's `\b` is ASCII only). */
const W = String.raw`(?<![\p{L}\p{N}])`;
const E = String.raw`(?![\p{L}\p{N}])`;
const words = (alternatives: readonly string[], flags = 'iu') => new RegExp(`${W}(?:${alternatives.join('|')})${E}`, flags);

/** Asking us to recommend, suggest or advise. Never the passive ("we were recommended by a friend"). */
const ASK_TO_RECOMMEND: readonly RegExp[] = [
  words(['recommend', 'recommendation', 'recommendations', 'suggest', 'suggestion', 'suggestions', 'advise', 'advice']),
  words(['посоветуйте', 'посоветуете', 'посоветуешь', 'посоветовать', 'порекомендуйте', 'порекомендуете', 'рекомендуете', 'рекомендуйте', 'рекомендация', 'рекомендации', 'предложите', 'совет', 'советуете']),
  /แนะนำ/u,
];

/**
 * Asking for a CHOICE: which one is better or best, which one should we take,
 * which one would you pick, which one suits us. Never a plain "which" fact:
 * "Which branch is open on Monday?", "Which one has the bigger party room?"
 * and "which packages do you have?" ask the brochure, not for a choice.
 */
const WHICH = String.raw`which(?:\s+\p{L}+){0,3}?`;
const ASK_WHICH: readonly RegExp[] = [
  words([
    String.raw`${WHICH}(?:\s+(?:is|are|would\s+be|will\s+be)|['’]s)\s+(?:better|best|ideal|more\s+suitable|most\s+suitable|right\s+for)`,
    String.raw`${WHICH}\s+(?:should|shall)\s+(?:we|i)`,
    String.raw`${WHICH}\s+(?:would|do)\s+you\s+(?:choose|pick|take|go\s+for|prefer)`,
    String.raw`${WHICH}\s+(?:suits|fits)\s+(?:us|our|me|my)`,
    String.raw`which\s+one\s+(?:is\s+)?for\s+(?:us|our|me|my)`,
  ]),
  words([
    String.raw`как(?:ой|ая|ое|ие|ую)(?:\s+\p{L}+){0,2}?\s+(?:лучше|выбрать|посоветуете|порекомендуете|подойд\p{L}*|подходит)`,
    String.raw`что\s+лучше`,
    String.raw`где\s+лучше`,
    String.raw`что\s+(?:вы\s+|нам\s+|мне\s+)?выбрать`,
  ]),
  /(?:ไหนดี|(?:แบบ|อัน|สาขา|แพ็[กค]เกจ|แพคเกจ|โซน|ห้อง)ไหน(?:ดี|เหมาะ|คุ้ม))/u,
];

/**
 * What is better, best or suitable FOR THEM, or the better option — counted
 * only on a line that asks (a question mark or a question word). Never "the
 * best time to arrive": a best that is not a choice is a fact.
 */
const BETTER: readonly RegExp[] = [
  words([
    String.raw`(?:better|best|ideal|suitable|more\s+suitable)\s+for`,
    String.raw`(?:better|best|ideal)\s+(?:option|choice|package|branch|park|place|deal|idea|one)`,
    String.raw`(?:what|which)(?:['’]s|\s+is|\s+would\s+be)\s+(?:better|best|ideal)(?=\s*(?:[?？.!,]|$))`,
    String.raw`(?:is|would)\s+(?:it|that|this)\s+(?:be\s+)?(?:better|best|ideal|suitable|a\s+good\s+idea)`,
    String.raw`worth\s+it`,
  ]),
  words(['лучше', 'лучший', 'лучшая', 'лучшее', 'лучшие', String.raw`подойд\p{L}*`, String.raw`подходит`, String.raw`подходящ\p{L}*`, String.raw`стоит\s+ли`]),
  /(?:ดีกว่า|ดีที่สุด|เหมาะ|คุ้ม)/u,
];

/**
 * Asking what we think. Not "should we…" or "would you…" on their own: "should
 * we book ahead?" and "would you have a projector?" are facts.
 */
const ASK_OPINION: readonly RegExp[] = [
  words([String.raw`what\s+do\s+you\s+think`, String.raw`do\s+you\s+think`, String.raw`what\s+would\s+you\s+(?:do|choose|pick|go\s+for)`]),
  words([String.raw`как\s+(?:вы\s+)?думаете`, String.raw`стоит\s+ли`]),
  /(?:คิดว่า(?:ไง|ยังไง|อย่างไร)|ว่าไงดี|ดีไหม|ดีมั้ย|ดีมั๊ย)/u,
];

/** "Can we…", "is it possible to…" — the owner's own examples of a choice to ask a person. */
const POSSIBILITY: readonly RegExp[] = [
  words([
    String.raw`can\s+(?:we|i)`,
    String.raw`could\s+(?:we|i)`,
    String.raw`may\s+(?:we|i)`,
    String.raw`is\s+it\s+possible`,
    String.raw`would\s+it\s+be\s+possible`,
    String.raw`possible\s+to`,
    String.raw`are\s+we\s+allowed`,
    String.raw`is\s+it\s+(?:ok|okay|allowed)`,
  ]),
  words(['можно', String.raw`возможно\s+ли`, String.raw`можем\s+ли`, String.raw`могу\s+ли`, String.raw`получится\s+ли`, 'разрешено', 'разрешается', String.raw`реально\s+ли`]),
  /(?:ได้ไหม|ได้มั้ย|ได้มั๊ย|ได้ไม๊|ได้หรือไม่|ได้หรือเปล่า|ได้รึเปล่า|ได้ป่าว|ได้ปะ|เป็นไปได้)/u,
];

/**
 * A polite opener, not a possibility question: "May I ask what time you
 * close?", "Can I see the menu?", "Можно узнать, во сколько вы закрываетесь?".
 * Taken out of the line before the possibility tier reads it, so "May I ask,
 * can we bring our own cake?" still asks.
 */
const POLITE: readonly RegExp[] = [
  new RegExp(
    `${W}(?:can|could|may)\\s+(?:i|we)\\s+(?:please\\s+)?(?:ask|know|find\\s+out|check|see|confirm)${E}`,
    'giu',
  ),
  new RegExp(`${W}(?:можно|могу\\s+ли\\s+я|могу\\s+ли)\\s+(?:узнать|спросить|уточнить|посмотреть|получить)${E}`, 'giu'),
];
const withoutPoliteOpeners = (line: string) => POLITE.reduce((t, p) => t.replace(p, ' '), line);

/** A line that asks: a question mark, or a question word in one of the three languages. */
const QUESTION: readonly RegExp[] = [
  /[?？]/u,
  /^\s*(?:which|what|where|how|should|would|could|can|is|are|do|does|will)\b/i,
  words(['ли', 'какой', 'какая', 'какое', 'какие', 'какую', 'где', 'что', 'как']),
  /(?:ไหน|ไหม|มั้ย|อะไร|ยังไง|อย่างไร|เหรอ|หรือเปล่า|หรือไม่|ป่าว)/u,
];

const any = (patterns: readonly RegExp[], text: string) => patterns.some((p) => p.test(text));

/**
 * What the lines ask for, the stronger tier first: `advice` (recommend,
 * suggest, which one, better or best in a question, what do you think),
 * `possibility` (can we, is it possible, можно, ได้ไหม), or null. Read line by
 * line, so "better" in one line never borrows another line's question mark.
 */
export function adviceAskIn(lines: readonly string[]): AdviceAsk | null {
  let possible = false;
  for (const raw of lines) {
    const line = raw.normalize('NFC');
    if (any(ASK_TO_RECOMMEND, line) || any(ASK_WHICH, line) || any(ASK_OPINION, line)) return 'advice';
    if (any(BETTER, line) && any(QUESTION, line)) return 'advice';
    if (any(POSSIBILITY, withoutPoliteOpeners(line))) possible = true;
  }
  return possible ? 'possibility' : null;
}

/** SCRUM-817's reading of a day, a date or a time, in the three languages (`@oto/shared` chat-dates). */
const namesDayOrTime = (lines: readonly string[]) => lines.some((t) => mentionsPartyDate(t) || mentionsPartyTime(t));

/**
 * The safety net's own question, without the labels: the lines ask for
 * advice, or ask only whether something is possible and name no day, date or
 * time. The corpus measure counts with it.
 */
export function asksBirthdayAdvice(lines: readonly string[]): AdviceAsk | null {
  const ask = adviceAskIn(lines);
  if (ask === 'possibility' && namesDayOrTime(lines)) return null;
  return ask;
}

/**
 * A part the advice never outranks, as SCRUM-817's date rule reads it: a
 * silent hand-over (a child in our care, lost and found) or a person-first
 * hand-over (a complaint, a refund, an upset message, a request for a
 * person), whose own verdict stands.
 */
function outranks(intent: AiIntent): boolean {
  const rule = INTENT_TABLE[intent];
  return intent !== 'birthday_advice' && (rule.action === 'silent_handover' || (rule.action === 'handover' && !rule.answerAlongside));
}

/**
 * The model answered from a fact of the knowledge: it says so
 * (`FACT_IN_KB`) and cites a source the prompt offered. The possibility tier
 * never withholds such an answer: "Can I pay by card?" answered from the
 * knowledge is a brochure fact, not a choice.
 */
function answeredFromKnowledge(input: GateInput): boolean {
  const d = input.decision;
  return d.action === 'answer' && d.reason === 'FACT_IN_KB' && d.grounding.some((key) => input.grounding.has(key));
}

/**
 * The decision the gate reads instead of the model's, or null to read the
 * model's (applied after SCRUM-817's date rule). In a birthday thread
 * (`birthdayThreadOf`), a burst with a part labelled `birthday_details` or
 * `faq` whose lines ask for advice (`asksBirthdayAdvice`) has those labels
 * read as `birthday_advice`. Only "can we…" (the possibility tier) on a faq
 * part the model answered from the knowledge is left to the model: a
 * grounded fact is answered.
 *
 * Without the opener in the burst, the advice is a hand-over: the model's
 * words go nowhere, and nothing else of the burst is answered beside it.
 * Beside the opener (`birthday_party`), the model's answer is kept for the
 * opener's sake (`openerBesideAdvice` then sends it, and the birthday
 * manager's line after it). A burst the model already labelled
 * `birthday_advice` keeps its labels; a burst with a silent or a person-first
 * part keeps the model's verdict; any other thread is never touched.
 */
export function birthdayAdviceOverrule(input: GateInput): AiDecision | null {
  const d = input.decision;
  if (birthdayThreadOf(input.episode) === null) return null;
  const labelled = intentPartsOf(d);
  if (labelled.includes('birthday_advice')) return null;
  if (labelled.some(outranks)) return null;
  if (!labelled.some((i) => BIRTHDAY_ADVICE_OVERRULED.has(i))) return null;
  const ask = asksBirthdayAdvice(input.openLines ?? []);
  if (ask === null) return null;
  if (ask === 'possibility' && labelled.includes('faq') && answeredFromKnowledge(input)) return null;
  const parts: AiIntent[] = [];
  for (const i of labelled) {
    const part: AiIntent = BIRTHDAY_ADVICE_OVERRULED.has(i) ? 'birthday_advice' : i;
    if (!parts.includes(part)) parts.push(part);
  }
  if (parts.includes('birthday_party')) return { ...d, intent: parts[0]!, intents: parts };
  return adviceAlone({ ...d, intent: parts[0]!, intents: parts });
}

/** The advice handed over alone: the model's words go nowhere, and nothing else of the burst is answered. */
export function adviceAlone(d: AiDecision): AiDecision {
  return { ...d, action: 'handover', bubbles: [], sendBrochure: false, askBranch: false };
}

/**
 * The opener's part of a burst that holds the opener (`birthday_party`) and
 * an advice part (`birthday_advice`, the model's label or the net's), for the
 * gate to answer; null for any other burst. Owner D1 (28 Oct) is the
 * playbook's first rule: the date-and-park question goes out, and the advice
 * is the birthday manager's after it (`adviceAfterOpener`). Only when the
 * model answered: its own hand-over or silence goes the usual way, and a
 * silent or a person-first part keeps its own verdict.
 */
export function openerBesideAdvice(d: AiDecision): AiDecision | null {
  const parts = intentPartsOf(d);
  if (!parts.includes('birthday_party') || !parts.includes('birthday_advice')) return null;
  if (d.action !== 'answer' || parts.some(outranks)) return null;
  const rest = parts.filter((i) => i !== 'birthday_advice');
  return { ...d, intent: rest[0]!, intents: rest };
}

/**
 * The opener's answer with the advice after it: the answer's words, then the
 * birthday manager's closing line (the hand-over the burst already makes, or
 * Birthdays & Events), the advice part back among the intents so the engine
 * tells the manager. Null when the gate did not answer the opener (a guard,
 * the cap, an unsure model): the caller then hands the advice over alone,
 * never in silence.
 */
export function adviceAfterOpener(v: GateVerdict, labelled: readonly AiIntent[]): GateVerdict | null {
  if (v.action !== 'answer') return null;
  const intents = labelled.filter((i) => i === 'birthday_advice' || v.intents.includes(i));
  const thenHandover = v.thenHandover ?? BIRTHDAYS_PLAN;
  return {
    ...v,
    intents,
    thenHandover,
    sendBrochure: v.thenHandover ? v.sendBrochure : BIRTHDAYS_PLAN.brochure,
    askBranch: false,
    mayAutoHandle: false,
  };
}

const isBirthdaysPlan = (p: { templateKey: string; route: string; brochure: boolean }) =>
  p.templateKey === BIRTHDAYS_PLAN.templateKey && p.route === BIRTHDAYS_PLAN.route && p.brochure === BIRTHDAYS_PLAN.brochure;

/**
 * The verdict of an overruled advice question says why: the Birthday & events
 * hand-over it became carries `OVERRULED_BIRTHDAY` and the rule
 * `birthday_advice`, and no words of the model's ride it.
 */
export function adviceOverruledVerdict(v: GateVerdict): GateVerdict {
  if (v.action !== 'handover' || !isBirthdaysPlan(v.plan)) return v;
  return { ...v, reason: 'OVERRULED_BIRTHDAY', holdingBubbles: [], droppedHoldingRule: BIRTHDAY_ADVICE_RULE };
}

// ---------------------------------------------------------------------------
// The opener beside an advice hand-over (SCRUM-823, staging 10 Nov)
// ---------------------------------------------------------------------------

/**
 * Which opener a birthday advice hand-over carries (`adviceOpenerOn`): the
 * playbook's whole question (`full`: the date, roughly how many people, which
 * park), or the same question without the park (`park_known`) where the park
 * is already known — the family named one this episode, the model read one,
 * or the thread has its park (a park's own number, or a park the routing
 * already set). Each is its own template (`opener_birthday_advice`,
 * `opener_birthday_advice_park_known`).
 */
export const ADVICE_OPENERS = ['full', 'park_known'] as const;
export type AdviceOpener = (typeof ADVICE_OPENERS)[number];

/**
 * What each opener asks (`PLAYBOOK_LINES` birthday_party, skipping a known
 * park). The engine records them as asked on the opener's line (SCRUM-831),
 * so the family's reply is read as their answer.
 */
export const ADVICE_OPENER_SLOTS_OF: Readonly<Record<AdviceOpener, readonly AiAskedSlot[]>> = {
  full: ['date', 'guests_count', 'park'],
  park_known: ['date', 'guests_count'],
};

/** What the playbook's whole opener asks: the date, roughly how many people, and which park. */
export const ADVICE_OPENER_SLOTS: readonly AiAskedSlot[] = ADVICE_OPENER_SLOTS_OF.full;

/** A question of these slots in the episode's memory means the opener was already put, whatever became of it. */
const OPENER_ASKED_SLOTS: ReadonlySet<AiAskedSlot> = new Set<AiAskedSlot>(['date', 'park']);

/** Asking for a party in Thai, English or Russian: a birthday, a party, a celebration. */
const PARTY_WORDS: readonly RegExp[] = [
  words(['birthday', 'birthdays', 'bday', 'b-day', 'party', 'parties', String.raw`celebrat\p{L}*`]),
  words([
    String.raw`(?:день|дня|дню|днём|днем)\s+рождени\p{L}*`,
    'др',
    String.raw`днюх\p{L}*`,
    String.raw`праздник\p{L}*`,
    String.raw`праздновани\p{L}*`,
    String.raw`отпраздн\p{L}*`,
    String.raw`отмет(?:ить|им)`,
    String.raw`отмеча\p{L}*`,
    String.raw`вечеринк\p{L}*`,
    String.raw`именин\p{L}*`,
  ]),
  /(?:วันเกิด|ปาร์ตี้|ปาร์ตี|งานเลี้ยง|จัดงาน|ฉลอง|เบิร์ดเดย์)/u,
];

/** The family's lines ask for a party: a birthday, a party or a celebration, in Thai, English or Russian. */
export function asksForParty(lines: readonly string[]): boolean {
  return lines.some((raw) => any(PARTY_WORDS, raw.normalize('NFC')));
}

/**
 * A day the date reader leaves to the clock: "tomorrow", "завтра",
 * "พรุ่งนี้". Not the Thai "วันนี้", which opens many a message ("วันนี้อยาก
 * สอบถาม…", today I'd like to ask…) without naming the party's day.
 */
const RELATIVE_DAY: readonly RegExp[] = [
  words(['today', 'tonight', 'tomorrow', 'сегодня', 'завтра', 'послезавтра']),
  /(?:พรุ่งนี้|มะรืน)/u,
];

/**
 * The lines already say a day or a date, or a headcount. The opener is a
 * fixed line that cannot skip either (the playbook: "skipping what they
 * already said"; owner, SCRUM-831: never ask twice), so where the family said
 * one — in this burst or earlier in the episode — the birthday manager's warm
 * line goes alone and the manager takes it from there.
 */
export function namesPartyDayOrCount(lines: readonly string[]): boolean {
  return lines.some((raw) => {
    const t = raw.normalize('NFC');
    return mentionsPartyDate(t) || any(RELATIVE_DAY, t) || headcountNamedIn(t);
  });
}

/** The lines name one park (`parkNamedIn`); naming both is a choice, not a park. */
export function namesOnePark(lines: readonly string[]): boolean {
  return lines.some((raw) => parkNamedIn(raw.normalize('NFC')) !== null);
}

/** The lines already say some of the party's basics: a day or a date, a headcount, or one park. */
export function namesPartyBasics(lines: readonly string[]): boolean {
  return namesPartyDayOrCount(lines) || namesOnePark(lines);
}

/**
 * The opener was already put this episode: a date or park question in the
 * memory (SCRUM-831: open, answered, or taken over by a person), or an
 * earlier reply labelled the opener.
 */
export function openerAskedBefore(episode: EpisodeState): boolean {
  return (
    (episode.questions ?? []).some((q) => OPENER_ASKED_SLOTS.has(q.slot)) || (episode.earlierIntents ?? []).includes('birthday_party')
  );
}

/**
 * The burst is a party request: the model labelled the opener
 * (`birthday_party`), or it is the family's first word on a party — no
 * earlier reply of the episode was about a birthday — and its lines ask for
 * one (`asksForParty`).
 */
function partyRequest(labelled: readonly AiIntent[], input: GateInput): boolean {
  if (labelled.includes('birthday_party')) return true;
  if ((input.episode.earlierIntents ?? []).some((i) => BIRTHDAY_INTENTS.has(i))) return false;
  return asksForParty(input.openLines ?? []);
}

/**
 * Everything the family wrote this episode that the opener must not ask
 * again: the episode's customer lines (`EpisodeState.customerLines`, earlier
 * bursts included) and this burst's.
 */
function saidThisEpisode(input: GateInput): string[] {
  return [...(input.episode.customerLines ?? []), ...(input.openLines ?? [])];
}

/**
 * SCRUM-823 (staging, 10 Nov): THE OPENER STAYS BESIDE AN ADVICE HAND-OVER.
 * A verdict that hands a birthday advice question to Birthdays & Events — the
 * model's own hand-over, its own `birthday_advice` label, or the safety net's
 * — carries `adviceOpener` when:
 *
 *   - the burst is a party request (`partyRequest`);
 *   - the opener was never put this episode (`openerAskedBefore`): a second
 *     advice question after it gets the warm line alone;
 *   - nothing the family wrote this episode — this burst or an earlier one —
 *     says a day, a date or a headcount (`namesPartyDayOrCount`), and the
 *     model did not read the basics in (`birthday_details`).
 *
 * Which opener: the whole question (`full`), or, where the park is already
 * known — one park named this episode (`namesOnePark`), the park the model
 * read (`branchNamed`), or the thread's own park (`threadHasBranch`) — the
 * question without the park (`park_known`). The family is never asked the
 * park they named, and never asked the park of a thread that has one, as the
 * gate's park question never is (`askBranch`).
 *
 * The engine then sends ONE message, that opener's template (its question,
 * then the birthday manager's warm line), records its slots as asked, and
 * hands over exactly as the verdict says: the intents keep `birthday_advice`,
 * so the manager on duty is told. Any other verdict — an answer (the overrule
 * path keeps the model's own opener), silence, a hand-over elsewhere, the
 * episode cap's — is returned as it is.
 */
export function adviceOpenerOn(v: GateVerdict, input: GateInput): GateVerdict {
  if (v.action !== 'handover' || v.reason === 'CAP_EPISODE') return v;
  if (!isBirthdaysPlan(v.plan) || !v.intents.includes('birthday_advice')) return v;
  const labelled = intentPartsOf(input.decision);
  if (labelled.includes('birthday_details')) return v;
  if (!partyRequest(labelled, input)) return v;
  if (openerAskedBefore(input.episode)) return v;
  const said = saidThisEpisode(input);
  if (namesPartyDayOrCount(said)) return v;
  const parkKnown = input.decision.branchNamed !== null || input.episode.threadHasBranch || namesOnePark(said);
  return { ...v, adviceOpener: parkKnown ? 'park_known' : 'full' };
}
