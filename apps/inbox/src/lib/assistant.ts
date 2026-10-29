/**
 * The assistant's words and small rules on the shell side (SCRUM-590 A3) —
 * pure, so the unit tests read the real thing (test/assistant.test.ts).
 *
 * The rules the shell must not bend live in the plan and the schema: the
 * three modes (§D.4), the KB's field limits (`kb_entry_length_check`), the
 * example's limits and its de-identification rule (`ai_example_length_check`,
 * `ai_example_approved_check`, §D.5). The server enforces every one of them;
 * the shell says them first so nobody types into a refusal.
 */
import { AI_INTENTS, AI_KB_TOPICS, type AiIntent } from '@oto/assistant/intents';
import type { InboxCategoryKey } from '@oto/shared/inbox';
import type {
  AiMode,
  ExampleVerdict,
  KbEntry,
  KbLanguage,
  KbStatus,
  RuleAskFirst,
  RuleCondition,
  TeachMessage,
  TeachOutcome,
} from '@/api/assistant';
import type { InboxEvent, Message } from '@/api/inbox';

// --- The per-number switch (§D.4, §B.5) ------------------------------------------------

export interface AiModeOption {
  value: AiMode;
  label: string;
  /** What it means, in plain words, for the person deciding. */
  description: string;
}

/**
 * The three states, in the order a number moves through them (G11: shadow
 * before live). Live is the one customers hear, and its words say so.
 */
export const AI_MODE_OPTIONS: readonly AiModeOption[] = [
  {
    value: 'off',
    label: 'Off',
    description: 'The assistant does nothing on this number. Every message waits for a person, as today.',
  },
  {
    value: 'shadow',
    label: 'Shadow',
    description:
      'The assistant reads each message and records what it would have done, but sends nothing and changes nothing. Customers never see it. Use this to measure it before going live.',
  },
  {
    value: 'live',
    label: 'Live',
    description:
      'CUSTOMERS HEAR IT. The assistant answers simple questions on this number and hands everything else to the team with a holding line. A person replying always takes over.',
  },
];

export function aiModeOption(mode: AiMode): AiModeOption {
  return AI_MODE_OPTIONS.find((o) => o.value === mode) ?? AI_MODE_OPTIONS[0]!;
}

export const AI_MODE_TINT: Record<AiMode, string> = {
  off: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 ring-slate-200 dark:ring-slate-700',
  shadow: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30',
  live: 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 ring-indigo-200 dark:ring-indigo-500/30',
};

/** Turning a number live is a decision (§C.2): it always asks first. Any other move does not. */
export function modeChangeNeedsConfirm(from: AiMode, to: AiMode): boolean {
  return to === 'live' && from !== 'live';
}

// --- The knowledge base (§C.1) -----------------------------------------------------------

/** `kb_entry_length_check`. */
export const KB_QUESTION_MAX = 200;
export const KB_BODY_MAX = 1200;
/** `kb_entry_key_check`: ≤ 80, lower-case words joined by `.`, `_` or `-`. */
export const KB_KEY_MAX = 80;
const KB_KEY = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

export const KB_TOPICS = AI_KB_TOPICS;
export const KB_TOPIC_LABEL: Record<(typeof AI_KB_TOPICS)[number], string> = {
  about_oto: 'About OTO',
  hours_note: 'Opening hours (note)',
  address_note: 'Address (note)',
  directions: 'Directions',
  parking: 'Parking',
  age_rules: 'Age rules',
  socks: 'Socks',
  prices_note: 'Prices (note)',
  faq: 'FAQ',
};
export function topicLabel(topic: string): string {
  return (KB_TOPIC_LABEL as Record<string, string>)[topic] ?? topic.replace(/_/g, ' ');
}

export const KB_LANGUAGES: readonly [KbLanguage, string][] = [
  ['en', 'English'],
  ['th', 'Thai'],
  ['ru', 'Russian'],
];

export const KB_STATUS_LABEL: Record<KbStatus, string> = { draft: 'Draft', approved: 'Approved', archived: 'Archived' };
export const KB_STATUS_TINT: Record<KbStatus, string> = {
  draft: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 ring-amber-200 dark:ring-amber-500/30',
  approved: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-500/30',
  archived: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 ring-slate-200 dark:ring-slate-700',
};

export interface KbDraft {
  topic: string;
  key: string;
  language: KbLanguage;
  question: string;
  body: string;
}

/** The editor's refusals before the server's: one sentence per field, null when the draft can be saved. */
export function kbDraftProblem(d: KbDraft): string | null {
  if (!(KB_TOPICS as readonly string[]).includes(d.topic)) return 'Choose a topic.';
  if (!d.key.trim()) return 'Give the entry a key, e.g. faq.food-outside.';
  if (d.key.length > KB_KEY_MAX) return `The key is at most ${KB_KEY_MAX} characters.`;
  if (!KB_KEY.test(d.key)) return 'The key is lower-case words and numbers joined by a dot, dash or underscore.';
  if (!d.question.trim()) return 'Write the question as a customer would ask it.';
  if (d.question.length > KB_QUESTION_MAX) return `The question is at most ${KB_QUESTION_MAX} characters.`;
  if (!d.body.trim()) return 'Write the answer.';
  if (d.body.length > KB_BODY_MAX) return `The answer is at most ${KB_BODY_MAX} characters.`;
  return null;
}

/**
 * The list grouped by topic (the plan's "KB list by topic and language"),
 * topics in the schema's order, inside each the key then the language.
 */
export function kbGroups(entries: readonly KbEntry[]): { topic: string; entries: KbEntry[] }[] {
  const order = (t: string) => {
    const i = (KB_TOPICS as readonly string[]).indexOf(t);
    return i < 0 ? KB_TOPICS.length : i;
  };
  const lang = (l: string) => KB_LANGUAGES.findIndex(([v]) => v === l);
  const topics = [...new Set(entries.map((e) => e.topic))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return topics.map((topic) => ({
    topic,
    entries: entries
      .filter((e) => e.topic === topic)
      .sort((a, b) => a.key.localeCompare(b.key) || lang(a.language) - lang(b.language)),
  }));
}

// --- The examples (§E, §D.5) -------------------------------------------------------------

/** `ai_example_length_check`. */
export const EXAMPLE_CUSTOMER_MAX = 500;
export const EXAMPLE_REPLY_MAX = 800;

export const INTENTS: readonly AiIntent[] = AI_INTENTS;
export const intentLabel = (intent: string): string => intent.replace(/_/g, ' ');

export const VERDICT_OPTIONS: readonly [ExampleVerdict, string][] = [
  ['should_answer', 'It should have answered like this'],
  ['should_handover', 'It should have handed over to the team'],
  ['should_stay_silent', 'It should have stayed silent'],
];
export const VERDICT_LABEL: Record<ExampleVerdict, string> = {
  should_answer: 'Should answer',
  should_handover: 'Should hand over',
  should_stay_silent: 'Should stay silent',
};

export interface ExampleDraft {
  customerText: string;
  goodReply: string;
  verdict: ExampleVerdict;
}

/** The example's refusals before the server's (`ai_example_length_check`, `ai_example_reply_check`). */
export function exampleDraftProblem(d: ExampleDraft): string | null {
  if (!d.customerText.trim()) return 'Write the customer’s question.';
  if (d.customerText.length > EXAMPLE_CUSTOMER_MAX) return `The customer’s question is at most ${EXAMPLE_CUSTOMER_MAX} characters.`;
  if (d.verdict === 'should_answer' && !d.goodReply.trim()) return 'Write the reply it should have sent.';
  if (d.goodReply.length > EXAMPLE_REPLY_MAX) return `The reply is at most ${EXAMPLE_REPLY_MAX} characters.`;
  return null;
}

/**
 * THE APPROVE GATE (§D.5, `ai_example_approved_check`): an example is approved
 * only with the approver's own "contains no personal data" tick, on a draft
 * that would save, and not while another write is in flight. The button reads
 * this and nothing else.
 */
export function canApproveExample(s: { deidentified: boolean; draft: ExampleDraft; busy: boolean }): boolean {
  return s.deidentified && !s.busy && exampleDraftProblem(s.draft) === null;
}

/** An example's language: the KB's three; anything else is English (G8: other languages are left to people). */
export function exampleLanguage(code: string | null | undefined): KbLanguage {
  return code === 'th' || code === 'ru' ? code : 'en';
}

export function exampleIntent(intent: string | null | undefined): AiIntent {
  return (INTENTS as readonly string[]).includes(intent ?? '') ? (intent as AiIntent) : 'other';
}

/** The thread's intent when it is one of the assistant's, else null. */
export function knownIntent(intent: string | null | undefined): AiIntent | null {
  return (INTENTS as readonly string[]).includes(intent ?? '') ? (intent as AiIntent) : null;
}

/**
 * The topic a correction starts on (test night 2026-10-21, U3). The api takes
 * the assistant's own classification of that message, then the thread's
 * (`ai-settings.ts` createExample), and refuses INTENT_REQUIRED when neither is
 * one of its intents — which it did only after Propose. So: a thread the
 * assistant classified starts blank ("as the assistant classified it", the
 * server's default); one it never classified starts on its category's
 * nearest topic, so there is always one to send.
 */
export const CATEGORY_DEFAULT_INTENT: Record<InboxCategoryKey, AiIntent> = {
  birthdays: 'birthday_party',
  general: 'faq',
  marketing: 'influencer_marketing',
  // The playbook's GM queue (SCRUM-220): its most common matter, as the api's default.
  gm: 'complaint_online',
};

export function defaultExampleIntent(threadIntent: string | null, category: InboxCategoryKey): AiIntent | '' {
  return knownIntent(threadIntent) !== null ? '' : CATEGORY_DEFAULT_INTENT[category];
}

/** The refusal the dialog says before Propose: a blank topic is only the server's default when the thread has one. */
export function exampleIntentProblem(chosen: string, threadIntent: string | null): string | null {
  if (chosen !== '' || knownIntent(threadIntent) !== null) return null;
  return 'Choose the topic this example teaches: the assistant has not classified this conversation.';
}

/** The assistant's turn behind the line being corrected, and what it classified. */
export interface CorrectionTurn {
  turnId: string | null;
  intent: AiIntent | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * The turn of the message being corrected (customer-AI test night, D3: a
 * parking correction was saved as ticket_prices, the thread's LATEST intent,
 * because the topic started from the thread rather than the message). An AI
 * line is named in its turn's `ai_replied` or `ai_handover` event
 * (`payload.messageIds`), and the message row's own `aiTurnId` — the
 * customer-AI lane's field, read optionally — names the turn outright. The
 * silence an `ai_silent` pill marks is that pill's event, at its time. Null
 * when no turn names the message: then the topic starts as before.
 */
export function turnForCorrection(
  events: readonly InboxEvent[],
  target: { messageId: string } | { at: string },
  aiTurnId?: unknown,
): CorrectionTurn | null {
  const of = (e: InboxEvent): CorrectionTurn => ({ turnId: text(e.payload.turnId), intent: knownIntent(text(e.payload.intent)) });
  if ('messageId' in target) {
    const byTurn = typeof aiTurnId === 'string' ? aiTurnId : null;
    const e = events.find(
      (x) =>
        (x.kind === 'ai_replied' || x.kind === 'ai_handover') &&
        ((byTurn !== null && x.payload.turnId === byTurn) ||
          (Array.isArray(x.payload.messageIds) && x.payload.messageIds.includes(target.messageId))),
    );
    return e ? of(e) : null;
  }
  const e = events.find((x) => x.kind === 'ai_silent' && x.createdAt === target.at);
  return e ? of(e) : null;
}

/**
 * "Correct the assistant", pre-filled (§E): the customer's words the line
 * answered — every customer message since the previous non-customer line,
 * newest last — and the AI's own line. On an `ai_silent` pill there is no AI
 * line: the customer's burst before the pill.
 */
export function correctionSource(
  messages: readonly Message[],
  target: { messageId: string } | { at: string },
): { customerText: string; customerMessageId: string | null; aiText: string } {
  // `end`: the index the backward walk starts from — the AI line itself, or
  // the first message after the pill.
  let end: number;
  let aiText = '';
  if ('messageId' in target) {
    end = messages.findIndex((m) => m.id === target.messageId);
    if (end >= 0) aiText = messages[end]!.body ?? '';
  } else {
    end = messages.filter((m) => m.createdAt <= target.at).length;
  }
  let start = Math.max(end, 0);
  // Walk back past the AI's other bubbles in the same answer, then over the customer's burst.
  while (start > 0 && messages[start - 1]!.authorKind === 'ai') start--;
  const burst: Message[] = [];
  while (start > 0 && messages[start - 1]!.authorKind === 'customer') {
    burst.unshift(messages[start - 1]!);
    start--;
  }
  const text = burst
    .map((m) => m.body ?? '')
    .filter(Boolean)
    .join('\n')
    .slice(0, EXAMPLE_CUSTOMER_MAX);
  return { customerText: text, customerMessageId: burst[burst.length - 1]?.id ?? null, aiText };
}

// --- Behaviour rules and the teach chat (SCRUM-696) --------------------------------------

/** `ai_rule_length_check` and `ai_rule_ask_first_check`, counted in characters as the server counts them. */
export const RULE_INSTRUCTION_MAX = 600;
export const RULE_QUESTION_MAX = 200;
/** The teach request's limits (`InboxAiTeachRequestSchema`). */
export const TEACH_MAX_MESSAGES = 20;
export const TEACH_MESSAGE_MAX = 2000;

const length = (t: string) => [...t.trim()].length;

/** A rule is for one of the assistant's intents, or for every message. */
export const RULE_INTENT_ANY = 'any';
export function ruleIntentLabel(intent: string): string {
  return intent === RULE_INTENT_ANY ? 'Any message' : intentLabel(intent);
}

/**
 * The intents an ask-first question never interrupts: the engine ignores the
 * question there, and the instruction still reaches the prompt. A copy of
 * `ASK_FIRST_IGNORED_INTENTS` (packages/assistant/src/intents.ts, SCRUM-696);
 * once that lands this line becomes a re-export of it.
 */
export const ASK_FIRST_IGNORED_INTENTS: readonly AiIntent[] = [
  'complaint_onsite',
  'complaint_online',
  'refund_request',
  'human_requested',
  'greeting',
  'thanks_closing',
  'identity_question',
  'other',
];
export function askFirstIgnored(intent: string): boolean {
  return (ASK_FIRST_IGNORED_INTENTS as readonly string[]).includes(intent);
}

export const RULE_CONDITION_OPTIONS: readonly [RuleCondition, string][] = [
  ['branch_unknown', 'When the park is not known yet'],
  ['always', 'Always'],
];
export const RULE_CONDITION_LABEL: Record<RuleCondition, string> = {
  branch_unknown: 'When the park is not known yet',
  always: 'Always',
};

export interface RuleDraft {
  intent: string;
  instruction: string;
  askFirst: boolean;
  condition: RuleCondition;
  questionEn: string;
  questionTh: string;
  questionRu: string;
}

/** The rule editor's refusals before the server's: one sentence, null when the draft can be saved. */
export function ruleDraftProblem(d: RuleDraft): string | null {
  if (d.intent !== RULE_INTENT_ANY && !(INTENTS as readonly string[]).includes(d.intent))
    return 'Choose the kind of message this rule is for.';
  if (length(d.instruction) === 0) return 'Write what the assistant should do.';
  if (length(d.instruction) > RULE_INSTRUCTION_MAX) return `The instruction is at most ${RULE_INSTRUCTION_MAX} characters.`;
  if (d.askFirst) {
    if (length(d.questionEn) === 0) return 'Write the question to ask first, in English.';
    if ([d.questionEn, d.questionTh, d.questionRu].some((q) => length(q) > RULE_QUESTION_MAX))
      return `A question is at most ${RULE_QUESTION_MAX} characters.`;
  }
  return null;
}

/** The ask-first part as the api takes it: null when unticked; Thai and Russian only when written. */
export function ruleAskFirst(d: RuleDraft): RuleAskFirst | null {
  if (!d.askFirst) return null;
  const th = d.questionTh.trim();
  const ru = d.questionRu.trim();
  return { condition: d.condition, question: { en: d.questionEn.trim(), ...(th ? { th } : {}), ...(ru ? { ru } : {}) } };
}

/** What a dry run says the assistant would do. */
export const TEACH_OUTCOME_LABEL: Record<TeachOutcome, string> = {
  answer: 'Answers',
  handover: 'Hands over to the team',
  silent_handover: 'Hands over without a word',
  silent: 'Stays silent',
  ask_first: 'Asks first',
};

/**
 * What the teach chat sends each turn: the last twenty lines, newest last,
 * starting on one of the staff member's (the api refuses a leading reply and
 * an empty line).
 */
export function teachPayload(lines: readonly TeachMessage[]): TeachMessage[] {
  const kept = lines.filter((l) => l.text.trim() !== '').slice(-TEACH_MAX_MESSAGES);
  const first = kept.findIndex((l) => l.role === 'user');
  return (first < 0 ? [] : kept.slice(first)).map((l) => ({
    role: l.role,
    text: [...l.text].slice(0, TEACH_MESSAGE_MAX).join(''),
  }));
}
