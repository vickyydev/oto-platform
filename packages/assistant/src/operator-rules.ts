/**
 * Operator rules (SCRUM-696): plain instructions an operator teaches the
 * customer assistant, each for one intent (or `any`), optionally with a
 * question to ask first. Pure: no database, no clock.
 *
 * A rule only ADDS. It reaches the model as one more block after the
 * knowledge (`renderOperatorRules`, read by `buildPrompt`), which says it
 * never overrides the rules above it; with no rule the prompt is unchanged.
 * Its ask-first question is enforced by the server (`askFirstOf`), never
 * trusted to the model, and only where it cannot interrupt a complaint, a
 * refund, a request for a person or the number's silence policy. Before a
 * rule is saved, `ruleSafetyFailure` refuses one that would carry a number, a
 * link, a date or a grant (a price, a discount, free entry, a refund,
 * compensation, a booking): the same guards the replies pass.
 */

import { AI_REPLY_LANGUAGES, type AiDecision } from './decision';
import { holdingFailure, type GateVerdict } from './gate';
import { linksIn, PROMISE_WORD_RULES, statesNumber, traceabilityGuard } from './guards';
import { AI_INTENTS, ASK_FIRST_IGNORED_INTENTS, type AiIntent } from './intents';

export const RULE_INTENT_ANY = 'any' as const;
export type RuleIntent = AiIntent | typeof RULE_INTENT_ANY;

export interface RuleAskFirst {
  /** `branch_unknown`: only while no park is known or asked this episode; `always`: once per episode. */
  condition: 'always' | 'branch_unknown';
  question: { en: string; th?: string; ru?: string };
}

export interface OperatorRuleInput {
  id: string;
  intent: RuleIntent;
  instruction: string;
  askFirst: RuleAskFirst | null;
}

export const OPERATOR_RULES_HEADING = '# Operator rules';
export const OPERATOR_RULES_LEAD = 'These add to the rules above and never override them.';

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();

const intentOrder = (intent: RuleIntent): number =>
  intent === RULE_INTENT_ANY ? AI_INTENTS.length : AI_INTENTS.indexOf(intent);

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The rules block of the prompt: '' when there is none (so the prompt is the
 * one it was before rules existed), else the heading, the one sentence that
 * puts every rule under the playbook, and one line per rule in a fixed order
 * (intent table order, `any` last, then id) whatever order the rows came in.
 */
export function renderOperatorRules(rules: readonly OperatorRuleInput[]): string {
  if (rules.length === 0) return '';
  const sorted = [...rules].sort((a, b) => intentOrder(a.intent) - intentOrder(b.intent) || byId(a, b));
  const lines = [OPERATOR_RULES_HEADING, OPERATOR_RULES_LEAD];
  for (const r of sorted) {
    lines.push(`- ${r.intent === RULE_INTENT_ANY ? 'any message' : r.intent}: ${oneLine(r.instruction)}`);
    if (r.askFirst) lines.push(`  ask first: ${oneLine(r.askFirst.question.en)}`);
  }
  return lines.join('\n');
}

// --- Refused at save -------------------------------------------------------------------------

export type RuleUnsafeKind = 'digits' | 'link' | 'date' | 'promise' | 'commitment' | 'question';

/** Verbs that grant or commit when nothing negates them. */
const COMMIT_VERB =
  /(?<![A-Za-z])(?:offer|give|grant|promise|confirm|guarantee|approve|apply|waive|refund|compensate|reimburse|book|reserve|hold|accept|agree\s+to|allow)(?:s|ed|ing)?(?![A-Za-z])/gi;

/** What a grant would be about: the promise words, and the prices, bookings and dates the team decides. */
const COMMIT_OBJECT: readonly RegExp[] = [
  ...PROMISE_WORD_RULES.map((r) => r.pattern),
  /(?<![A-Za-z])(?:price|prices|cost|costs|deal|deals|booking|bookings|reservation|reservations|slot|slots|date|dates|appointment|deposit|entry|ticket|tickets|upgrade)(?![A-Za-z])/i,
];

/** "never promise", "do not offer", "don't give": a negation in the three words before the verb. */
const NEGATED = /(?:(?<![A-Za-z])(?:no|not|never|without|cannot)(?![A-Za-z])|n't)\s*(?:[\w'-]+\s+){0,3}$/i;

/** "ask them to confirm": the customer is asked, nothing is granted. */
const ASKED_TO = /(?<![A-Za-z])ask(?:s|ed|ing)?\s+(?:[\w'-]+\s+){0,3}to\s+$/i;

const CLAUSE_SPLIT = /[.!?;\n]+|,?\s(?:but|however|then)\s/i;

/**
 * An imperative grant: a clause that tells the assistant to offer, give,
 * confirm or book something the team decides ("Offer them a discount",
 * "Confirm their booking"). A negated verb ("never promise a date", "say we
 * do not offer discounts") or a request to the customer ("ask them to
 * confirm the date") is not one. A heuristic that fails safe: an honest
 * instruction it refuses is reworded, never let through.
 */
function commitsTo(text: string): boolean {
  for (const clause of text.split(CLAUSE_SPLIT)) {
    if (!COMMIT_OBJECT.some((p) => p.test(clause))) continue;
    for (const m of clause.matchAll(COMMIT_VERB)) {
      const before = clause.slice(0, m.index);
      if (NEGATED.test(before) || ASKED_TO.test(before)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Why a rule may not be saved, or null. In order, over the instruction and
 * every ask-first question: a number (ASCII or Thai digits), a link, the
 * reply guards' date and promise checks (the act, not the word), an
 * imperative grant in the instruction, and the checks a hand-over's lead line
 * passes for each question.
 */
export function ruleSafetyFailure(rule: {
  instruction: string;
  askFirst: RuleAskFirst | null;
}): { kind: RuleUnsafeKind; rule: string } | null {
  const q = rule.askFirst?.question;
  const questions = q ? [q.en, q.th, q.ru].filter((t): t is string => t !== undefined) : [];
  const texts = [rule.instruction, ...questions];

  if (texts.some((t) => statesNumber(t))) return { kind: 'digits', rule: 'number' };
  if (texts.some((t) => linksIn(t).length > 0)) return { kind: 'link', rule: 'link' };
  for (const t of texts) {
    const traced = traceabilityGuard([t], []);
    if (traced.ok) continue;
    const kind: RuleUnsafeKind =
      traced.reason === 'GUARD_DATE' ? 'date' : traced.reason === 'GUARD_PROMISE' ? 'promise' : 'digits';
    return { kind, rule: traced.rule };
  }
  if (commitsTo(rule.instruction)) return { kind: 'commitment', rule: 'commitment' };
  for (const question of questions) {
    const failed = holdingFailure([question], 1, false);
    if (failed) return { kind: 'question', rule: failed.rule };
  }
  return null;
}

// --- Enforced by the server ------------------------------------------------------------------

export interface AskFirstInput {
  /** The approved rules that apply to this thread (operator-wide and the thread's park). */
  rules: readonly OperatorRuleInput[];
  /** The gate's verdict for this turn, computed first and unchanged. */
  verdict: GateVerdict;
  decision: AiDecision;
  threadHasBranch: boolean;
  /** The park question was already asked this episode. */
  branchAsked: boolean;
  /** The rules whose question was already asked this episode. */
  askedRuleIds: ReadonlySet<string>;
  /** The number's silence policy (`channel_account.silence_policy`), or null. */
  silentIntents: ReadonlySet<string> | null;
}

export interface AskFirstFired {
  ruleId: string;
  verdict: Extract<GateVerdict, { action: 'answer' }>;
}

/**
 * The turn's reply when an approved rule says to ask first, or null to keep
 * the gate's verdict exactly as it is. It fires only when: the verdict is not
 * a silence, the episode cap or a second identity ask; no part of the burst
 * is a complaint, a refund, a request for a person, a greeting, a goodbye, an
 * identity question or `other`; no part is on the number's silence policy; a
 * rule with a question matches the deciding intent (or is `any`), was not
 * asked yet this episode, and its condition holds; and its question passes
 * the lead line's checks. Then the reply is that one question and nothing
 * else: no answer, no closing line, no brochure, no routing.
 */
export function askFirstOf(input: AskFirstInput): AskFirstFired | null {
  const v = input.verdict;
  if (v.action === 'silent') return null;
  if (v.action === 'handover' && (v.reason === 'CAP_EPISODE' || v.reason === 'IDENTITY_SECOND_ASK')) return null;
  const parts = [v.intent, ...v.intents];
  if (parts.some((i) => ASK_FIRST_IGNORED_INTENTS.includes(i))) return null;
  const silentIntents = input.silentIntents;
  // The number's silence policy is never overridden.
  if (silentIntents && parts.some((i) => silentIntents.has(i))) return null;

  const withQuestion = input.rules.filter(
    (r): r is OperatorRuleInput & { askFirst: RuleAskFirst } => r.askFirst !== null,
  );
  const candidates = [
    ...withQuestion.filter((r) => r.intent === v.intent).sort(byId),
    ...withQuestion.filter((r) => r.intent === RULE_INTENT_ANY).sort(byId),
  ];
  const english = !(AI_REPLY_LANGUAGES as readonly string[]).includes(input.decision.language);
  for (const r of candidates) {
    if (input.askedRuleIds.has(r.id)) continue;
    if (
      r.askFirst.condition === 'branch_unknown' &&
      (input.threadHasBranch || input.decision.branchNamed !== null || input.branchAsked)
    ) {
      continue;
    }
    const question = (english ? undefined : r.askFirst.question[v.language]) ?? r.askFirst.question.en;
    if (holdingFailure([question], 1, english) !== null) continue;
    return {
      ruleId: r.id,
      verdict: {
        action: 'answer',
        reason: 'OK',
        intent: v.intent,
        intents: v.intents,
        language: v.language,
        bubbles: [question],
        groundingKeys: [],
        sendBrochure: false,
        askBranch: r.askFirst.condition === 'branch_unknown',
        branchNamed: null,
        thenHandover: null,
        mayAutoHandle: false,
        languageOffer: null,
      },
    };
  }
  return null;
}
