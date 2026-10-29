/**
 * Operator rules (SCRUM-696): plain instructions an operator teaches the
 * customer assistant, each for one intent (or `any`), optionally with a
 * question to ask first. Pure: no database, no clock.
 *
 * A rule only ADDS. Its instruction reaches the model as one more block
 * after the knowledge (`renderOperatorRules`, read by `buildPrompt`), which
 * says it never overrides the rules above it; with no rule the prompt is
 * unchanged. Its ask-first question never reaches the model: the server asks
 * it (`askFirstOf`), at most one such question per episode, only in the
 * customer's reply language, and only where it cannot interrupt a complaint,
 * a refund, a request for a person, a child in our care, the birthday flow or
 * the number's silence policy. Before a rule is saved or approved,
 * `ruleSafetyFailure` refuses one that would carry a number (digits or number
 * words), a link, a date or a grant (a price, a discount, free entry, a
 * refund, a voucher, an upgrade, compensation, a booking, a callback time,
 * opening hours): the same guards the replies pass, and the act, not the
 * word.
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
 * Only the instruction: a rule's ask-first question is the server's to ask
 * (`askFirstOf`), so the model is never shown it to repeat.
 */
export function renderOperatorRules(rules: readonly OperatorRuleInput[]): string {
  if (rules.length === 0) return '';
  const sorted = [...rules].sort((a, b) => intentOrder(a.intent) - intentOrder(b.intent) || byId(a, b));
  const lines = [OPERATOR_RULES_HEADING, OPERATOR_RULES_LEAD];
  for (const r of sorted) {
    lines.push(`- ${r.intent === RULE_INTENT_ANY ? 'any message' : r.intent}: ${oneLine(r.instruction)}`);
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

// --- What a rule may not grant or state: the act, not the word --------------------------------

type Script = 'latin' | 'thai' | 'cyrillic';

interface GrantTerm {
  id: string;
  /** The refusal it earns: a number word is a number, a grant word a promise, a time or hours a commitment. */
  kind: Extract<RuleUnsafeKind, 'digits' | 'promise' | 'commitment'>;
  script: Script;
  pattern: RegExp;
}

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?';

/** What an opening time or day is named by after "open until", "closed on". */
const TIME_WORDS = `${NUMBER_WORDS}|noon|midday|midnight|mornings?|afternoons?|evenings?|nights?|late|early|sunset|dark|weekdays?|weekends?|(?:public\\s+)?holidays?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?`;

const PRICE_NOUNS = 'price|prices|bill|ticket|tickets|entry|total|admission|order|cost|fee|fees|booking|party|package|visit|meal';

const en = (id: string, kind: GrantTerm['kind'], source: string): GrantTerm => ({
  id: `en:${id}`,
  kind,
  script: 'latin',
  pattern: new RegExp(`(?<![A-Za-z])(?:${source})(?![A-Za-z])`, 'gi'),
});
const th = (id: string, kind: GrantTerm['kind'], source: string): GrantTerm => ({
  id: `th:${id}`,
  kind,
  script: 'thai',
  pattern: new RegExp(source, 'gu'),
});
const ru = (id: string, kind: GrantTerm['kind'], source: string): GrantTerm => ({
  id: `ru:${id}`,
  kind,
  script: 'cyrillic',
  pattern: new RegExp(`(?<!\\p{L})(?:${source})(?!\\p{L})`, 'giu'),
});

/**
 * The words a grant or a stated fact is made of, per language: number words,
 * a percentage, money off, money back, a refund, a voucher, free things,
 * "complimentary", "on us", an upgrade, a discount, a callback or reply
 * "within" a time, and the opening hours ("closed on Mondays", "open until
 * ten"). Each counts only where `exemptAt` finds no reason it grants nothing.
 */
const GRANT_TERMS: readonly GrantTerm[] = [
  en('number', 'digits', `${NUMBER_WORDS}|percent(?:ages?)?|per\\s+cent|half|halves|double`),
  {
    id: 'en:free',
    kind: 'promise',
    script: 'latin',
    // "gluten-free", "hands-free" are no grant; "free-flow" and "free of charge" are.
    pattern: /(?<![A-Za-z-])free(?![A-Za-z])/gi,
  },
  en('discount', 'promise', 'discount\\w*'),
  en('refund', 'promise', 'refund\\w*'),
  en('compensation', 'promise', 'compensat\\w*'),
  en('money_back', 'promise', 'money\\s+back'),
  en('voucher', 'promise', 'vouchers?'),
  en('complimentary', 'promise', 'complimentary'),
  en('on_us', 'promise', 'on\\s+(?:us|the\\s+house)'),
  en('upgrade', 'promise', 'upgrad\\w*'),
  en(
    'off',
    'promise',
    `(?:percent|per\\s+cent|money|price|bit|something|amount|baht|half|${NUMBER_WORDS})\\s+off|off\\s+(?:(?:the|their|your|his|her|a|an|any|each|every)\\s+)?(?:${PRICE_NOUNS})`,
  ),
  en(
    'callback',
    'commitment',
    `(?:call\\s*-?\\s*backs?|callbacks?|ring\\s*backs?)\\s+within|within\\s+(?:[\\w'-]+\\s+){0,2}?(?:minutes?|hours?|days?|weeks?|today|tomorrow|${NUMBER_WORDS})`,
  ),
  en(
    'hours',
    'commitment',
    `(?:closed|shut|close|closes|closing)\\s+(?:on|at|by|from|until|till|til)\\s+(?:(?:the|a|an|every|all|most|some)\\s+)?(?:${TIME_WORDS})|(?:open|opens|opened|opening)\\s+(?:(?:late|early|daily|every\\s+day)\\s+)?(?:until|till|til|from|at|by|to|on)\\s+(?:(?:the|a|an|every|all|most|some)\\s+)?(?:${TIME_WORDS})`,
  ),
  th('percent', 'digits', 'เปอร์เซ็นต์|ลด\\s*%'),
  th('free', 'promise', 'ฟรี'),
  th('discount', 'promise', 'ส่วนลด|ลดราคา'),
  th('refund', 'promise', 'คืนเงิน'),
  th('compensation', 'promise', 'ชดเชย'),
  ru('percent', 'digits', 'процент\\p{L}*'),
  ru('free', 'promise', 'бесплатн\\p{L}*'),
  ru('discount', 'promise', 'скидк\\p{L}*'),
  ru('refund', 'promise', 'возврат\\p{L}*'),
  ru('money_back', 'promise', 'вернём|вернем|верн\\p{L}*\\s+(?:\\p{L}+\\s+)?деньг\\p{L}*'),
  ru('compensation', 'promise', 'компенсац\\p{L}*'),
];

/** "one of", "which one", "no one", "in one line", "one short question", "double-check": no quantity anyone is promised. */
function plainNumberWord(word: string, before: string, after: string): boolean {
  const w = word.toLowerCase();
  if (w === 'one') {
    if (/(?<![A-Za-z])(?:no|which|the|this|that|each|every|any|other|another|same|right|wrong|last)\s+$/i.test(before)) return true;
    if (/^\s+(?:of|another|by\s+one)(?![A-Za-z])/i.test(after)) return true;
    if (/^\s+(?:(?:short|single|clear|friendly|simple)\s+)?(?:line|question|sentence|bubble|message|reply)(?![A-Za-z])/i.test(after)) {
      return true;
    }
  }
  return w === 'double' && /^[\s-]*check/i.test(after);
}

/** The customer asks for it: "if someone asks for a discount", "wants a refund", "asks whether entry is free". */
const ASKED_ABOUT =
  /(?<![A-Za-z])(?:ask|asks|asked|asking|enquir(?:e|es|ed|ing)|inquir(?:e|es|ed|ing)|request(?:s|ed|ing)?|wants?|wanted|wanting|complain(?:s|ed|ing)?|mention(?:s|ed|ing)?|demand(?:s|ed|ing)?|insist(?:s|ed|ing)?|says|said|claim(?:s|ed|ing)?)\s+(?:(?:them|you|us|him|her)\s+)?(?:for|about|on|after|whether|if|that|a|an|the|their|his|her|any|some|more)\s+(?:[\w'-]+\s+){0,2}$/i;

/** An offer put as a question is still an offer: "ask if they want a free coffee". */
const OFFERED_AS_QUESTION =
  /(?<![A-Za-z])(?:ask|offer)\s+(?:(?:them|him|her)\s+)?(?:if|whether)\s+(?:they|he|she)(?:'d|\s+would)?\s+(?:like|want|wants|need|needs|fancy|fancies)\s+(?:[\w'-]+\s+){0,2}$/i;

/** The team decides it: "the team decides discounts", "a colleague will look into the refund". */
const TEAM_DECIDES_BEFORE =
  /(?<![A-Za-z])(?:team|teams|colleague|colleagues|manager|managers|staff|reception|gm|desk|person|people)\s+(?:(?:member|members|will|would|can|must|should|always|alone|only|then|to)\s+){0,2}(?:decide|decides|decided|deciding|handle|handles|handled|approve|approves|approved|confirm|confirms|look\s+into|looks\s+into|check|checks|review|reviews|deal\s+with|deals\s+with|take\s+care\s+of|takes\s+care\s+of|settle|settles)\s+(?:(?:on|about|any|all|every|each|the|a|an|their|whether|if)\s+){0,3}$/i;

/** "discounts are decided by the team", "refund requests go to the GM". */
const TEAM_DECIDES_AFTER =
  /^\s*(?:(?:requests?|questions?|claims?)\s+)?(?:(?:is|are)\s+(?:(?:always|only)\s+)?(?:decided|handled|approved|confirmed|settled)\s+by|(?:is|are)\s+(?:(?:always|only)\s+)?(?:for|up\s+to)|(?:go|goes)\s+to)\s+(?:the\s+)?(?:team|manager|managers|gm|staff|reception|desk|a\s+colleague|colleagues)(?![A-Za-z])/i;

const TH_NEGATED = /(?:ไม่|งด|ห้าม)[฀-๿\s]{0,12}$/u;
const TH_ASKED = /(?:สอบถาม|ถาม|(?:ลูกค้า|เขา|คุณ)\s*(?:ขอ|อยากได้|ต้องการ))[฀-๿\s]{0,12}$/u;
const TH_OFFERED = /(?:สอบถาม|ถาม)[฀-๿\s]{0,8}(?:อยากได้|ต้องการ|รับ|เอา)[฀-๿\s]{0,8}$/u;
const TH_TEAM = '(?:ทีมงาน|ทีม|ผู้จัดการ|เจ้าหน้าที่|พนักงาน)[\\u0E00-\\u0E7F\\s]{0,12}(?:ตัดสินใจ|พิจารณา|ดูแล|ตรวจสอบ|อนุมัติ)';
const TH_TEAM_BEFORE = new RegExp(`${TH_TEAM}[\\u0E00-\\u0E7F\\s]{0,12}$`, 'u');
const TH_TEAM_AFTER = new RegExp(`^[\\u0E00-\\u0E7F\\s]{0,12}?${TH_TEAM}`, 'u');

const RU_NEGATED = /(?<!\p{L})(?:не|нет|без|ни|никогда|нельзя)(?!\p{L})\s*(?:\p{L}+\s+){0,3}$/iu;
const RU_ASKED =
  /(?<!\p{L})(?:спрашива\p{L}*|спрос\p{L}*|проси\p{L}*|просят|попрос\p{L}*|хоч\p{L}*|хот\p{L}*|требу\p{L}*|интересу\p{L}*|жалу\p{L}*)\s+(?:\p{L}+\s+){0,2}$/iu;
const RU_TEAM_BEFORE =
  /(?<!\p{L})(?:команд\p{L}*|менеджер\p{L}*|коллег\p{L}*|сотрудник\p{L}*|администратор\p{L}*)\s+(?:\p{L}+\s+){0,2}?(?:реша\p{L}*|реши\p{L}*|рассм\p{L}*|разбер\p{L}*|провер\p{L}*|одобр\p{L}*|занима\p{L}*)\s+(?:\p{L}+\s+){0,3}$/iu;
const RU_TEAM_AFTER =
  /^\s*(?:\p{L}+\s+){0,2}?(?:реша\p{L}*|реши\p{L}*|рассматрива\p{L}*|одобря\p{L}*)\s+(?:\p{L}+\s+)?(?:команд|менеджер|коллег|сотрудник|администратор)/iu;

/**
 * Why a term grants nothing where it stands: negated just before it ("do
 * not offer discounts", "never promise a callback within the hour"), what the
 * customer asks for ("if someone asks for a refund", but not "ask if they
 * want a free coffee"), or the team's to decide ("the team decides
 * discounts", "refunds go to the GM").
 */
function exemptAt(script: Script, before: string, after: string): boolean {
  switch (script) {
    case 'latin':
      return (
        NEGATED.test(before) ||
        (ASKED_ABOUT.test(before) && !OFFERED_AS_QUESTION.test(before)) ||
        TEAM_DECIDES_BEFORE.test(before) ||
        TEAM_DECIDES_AFTER.test(after)
      );
    case 'thai':
      return (
        TH_NEGATED.test(before) ||
        (TH_ASKED.test(before) && !TH_OFFERED.test(before)) ||
        TH_TEAM_BEFORE.test(before) ||
        TH_TEAM_AFTER.test(after)
      );
    case 'cyrillic':
      return RU_NEGATED.test(before) || RU_ASKED.test(before) || RU_TEAM_BEFORE.test(before) || RU_TEAM_AFTER.test(after);
  }
}

/** A clause: a sentence, or the half after "but", "then", "however" (and their Thai and Russian forms). */
const TERM_CLAUSE_SPLIT = /[.!?;\n]+|,?\s(?:but|however|then)\s|แต่|อย่างไรก็ตาม|(?<!\p{L})(?:но|однако)(?!\p{L})/iu;

/**
 * The first grant or stated fact a text makes, by `GRANT_TERMS`: a term in a
 * clause that nothing there exempts. A heuristic that fails safe, as
 * `commitsTo` does: an honest instruction it refuses is reworded.
 */
function grantTermIn(text: string): { kind: GrantTerm['kind']; rule: string } | null {
  for (const clause of text.split(TERM_CLAUSE_SPLIT)) {
    for (const term of GRANT_TERMS) {
      for (const m of clause.matchAll(term.pattern)) {
        const before = clause.slice(0, m.index);
        const after = clause.slice(m.index + m[0].length);
        if (term.id === 'en:number' && plainNumberWord(m[0], before, after)) continue;
        if (term.id === 'en:free' && (/(?<![A-Za-z])feel\s+$/i.test(before) || /^\s+to(?![A-Za-z])/i.test(after))) continue;
        if (exemptAt(term.script, before, after)) continue;
        return { kind: term.kind, rule: term.id };
      }
    }
  }
  return null;
}

/** A question mark in any script's form. */
const QUESTION_MARK = /[?？¿]/g;

/**
 * Why a rule may not be saved (or approved), or null. In order, over the
 * instruction and every ask-first question: a number (ASCII or Thai digits),
 * a link, the reply guards' date and promise checks (the act, not the word),
 * an imperative grant in the instruction, a grant or stated fact by
 * `GRANT_TERMS` (number words, money off or back, a voucher, free things, an
 * upgrade, a callback time, the opening hours), and for each question: one
 * question mark at most, and the checks a hand-over's lead line passes.
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
  for (const t of texts) {
    const granted = grantTermIn(t);
    if (granted) return granted;
  }
  for (const question of questions) {
    if ((question.match(QUESTION_MARK) ?? []).length > 1) return { kind: 'question', rule: 'one_question' };
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
  /** An ask-first question (any rule's) was already asked this episode, live or in shadow: one per episode. */
  askedFirst: boolean;
  /** The number's silence policy (`channel_account.silence_policy`), or null. */
  silentIntents: ReadonlySet<string> | null;
}

export interface AskFirstFired {
  ruleId: string;
  verdict: Extract<GateVerdict, { action: 'answer' }>;
}

/**
 * The turn's reply when an approved rule says to ask first, or null to keep
 * the gate's verdict exactly as it is. It fires only when: no ask-first
 * question was asked yet this episode (any rule's: one per episode); the
 * verdict is not a silence, the episode cap or a second identity ask; no part
 * of the burst is one of `ASK_FIRST_IGNORED_INTENTS` (a complaint, a refund,
 * a request for a person, an upset or unclear message, a child in our care,
 * the birthday flow, small talk, `other`); no part is on the number's silence
 * policy; a rule with a question matches the deciding intent (or is `any`),
 * its condition holds (`branch_unknown`: no park on the thread, none named in
 * this burst, none asked this episode), it holds the question in the
 * customer's reply language (a rule without it is skipped this turn), and the
 * question passes the lead line's checks. Then the reply is that one question
 * and nothing else: no answer, no closing line, no brochure, no hand-over;
 * the park the customer named stays on the verdict (`branchNamed`), so the
 * thread still takes it.
 */
export function askFirstOf(input: AskFirstInput): AskFirstFired | null {
  if (input.askedFirst) return null;
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
  // A language the assistant does not reply in is answered in English (gate 3): the English question, Latin script only.
  const english = !(AI_REPLY_LANGUAGES as readonly string[]).includes(input.decision.language);
  for (const r of candidates) {
    if (
      r.askFirst.condition === 'branch_unknown' &&
      (input.threadHasBranch || input.decision.branchNamed !== null || input.branchAsked)
    ) {
      continue;
    }
    // Only in the customer's reply language: never an English question to a Thai or Russian customer.
    const question = r.askFirst.question[v.language];
    if (question === undefined) continue;
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
        branchNamed: input.decision.branchNamed,
        thenHandover: null,
        mayAutoHandle: false,
        languageOffer: null,
      },
    };
  }
  return null;
}
