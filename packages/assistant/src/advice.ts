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
 *   advice       asking us to recommend, suggest or advise; asking which one
 *                (branch, package, option); asking what is better, best or
 *                suitable; asking what we think or whether they should.
 *   possibility  "can we…", "is it possible to…", "можно…", "ได้ไหม" — the
 *                owner's own examples. A line that names a day, a date or a
 *                time is the party's details, not advice ("Можно в субботу в
 *                2 часа дня?" stays SCRUM-817's `birthday_details`), so the
 *                possibility tier never fires on one.
 *
 * Pure: no clock, no database, no model.
 */

import { mentionsPartyDate, mentionsPartyTime } from '@oto/shared';
import type { AiDecision } from './decision';
import type { GateInput, GateVerdict } from './gate';
import {
  BIRTHDAYS_PLAN,
  INTENT_TABLE,
  birthdayThreadOf,
  intentPartsOf,
  type AiIntent,
} from './intents';

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
 * Asking which one: a branch, a package, an option, a room… Singular only:
 * "which packages do you have?" asks for the brochure, not for a choice.
 */
const ASK_WHICH: readonly RegExp[] = [
  words([String.raw`which\s+(?:one|branch|park|package|option|location|place|room|theme|menu|is\s+better|would\s+be)`]),
  words([
    String.raw`как(?:ой|ая|ое|ие|ую)\s+(?:лучше|выбрать|филиал|парк|пакет|вариант|зал|тем[ау]|меню)`,
    String.raw`что\s+лучше`,
    String.raw`где\s+лучше`,
    String.raw`что\s+(?:вы\s+)?выбрать`,
  ]),
  /(?:ไหนดี|แบบไหน|อันไหน|สาขาไหน|แพ็[กค]เกจไหน|แพคเกจไหน|โซนไหน|ห้องไหน)/u,
];

/** What is better, best or suitable — counted only on a line that asks (a question mark or a question word). */
const BETTER: readonly RegExp[] = [
  words(['better', String.raw`best(?!\s+(?:regards|wishes))`, 'ideal', 'suitable', String.raw`worth\s+it`]),
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
    if (any(POSSIBILITY, line)) possible = true;
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
 * The decision the gate reads instead of the model's, or null to read the
 * model's (applied after SCRUM-817's date rule). In a birthday thread
 * (`birthdayThreadOf`), a burst with a part labelled `birthday_details` or
 * `faq` whose lines ask for advice (`asksBirthdayAdvice`) becomes a
 * hand-over: those labels become `birthday_advice`, the model's words go
 * nowhere, and nothing else of the burst is answered beside it. A burst the
 * model already labelled `birthday_advice` keeps its labels; a burst with a
 * silent or a person-first part keeps the model's verdict; any other thread
 * is never touched.
 */
export function birthdayAdviceOverrule(input: GateInput): AiDecision | null {
  const d = input.decision;
  if (birthdayThreadOf(input.episode) === null) return null;
  const labelled = intentPartsOf(d);
  if (labelled.includes('birthday_advice')) return null;
  if (labelled.some(outranks)) return null;
  if (!labelled.some((i) => BIRTHDAY_ADVICE_OVERRULED.has(i))) return null;
  if (asksBirthdayAdvice(input.openLines ?? []) === null) return null;
  const parts: AiIntent[] = [];
  for (const i of labelled) {
    const part: AiIntent = BIRTHDAY_ADVICE_OVERRULED.has(i) ? 'birthday_advice' : i;
    if (!parts.includes(part)) parts.push(part);
  }
  return { ...d, intent: parts[0]!, intents: parts, action: 'handover', bubbles: [], sendBrochure: false, askBranch: false };
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
