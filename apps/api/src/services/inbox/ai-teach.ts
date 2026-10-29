import { and, asc, eq, gte, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  AI_BRANCH_KEYS,
  AI_INTENTS,
  applyGates,
  askFirstOf,
  buildPrompt,
  buildTeachSystem,
  renderOperatorRules,
  renderTeachDrafts,
  type AiBranchKey,
  type PriorTurn,
  type TeachDraftLine,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolDefinition,
} from '@oto/assistant';
import { aiRule, kbEntry, type Db } from '@oto/db';
import {
  INBOX_AI_CONTENT_LANGUAGES,
  INBOX_KB_KEY_PATTERN,
  INBOX_KB_TOPICS,
  InboxAiRuleCreateSchema,
  InboxKbCreateSchema,
  type InboxAiTeachDryRun,
  type InboxAiTeachRequest,
  type InboxAiTeachResponse,
} from '@oto/shared';
import { AppError } from '../../lib/errors';
import { toJsonSchema } from '../assistant/json-schema';
import { withTx, type OpContext } from '../tx';
import { loadTurnKnowledge, type TurnKnowledge } from './ai-knowledge';
import { createRule } from './ai-rules';
import type { InboxAiRuntime } from './ai-runtime';
import { createKb, type Reach, type SettingsCtx } from './ai-settings';

/**
 * THE TEACH CHAT (SCRUM-696): a park colleague briefs the customer assistant
 * in plain words on the Assistant page, with a curator that reads the same
 * knowledge the customer assistant reads (`buildTeachSystem`).
 *
 * WHAT IT CAN DO. Four tools, and only these: `search_knowledge` (read the
 * operator's entries and rules), `create_fact` (a DRAFT knowledge-base entry,
 * through `createKb`), `create_rule` (a DRAFT operator rule, through
 * `createRule`, which refuses an unsafe one) and `dry_run` (what the assistant
 * would do now with one customer message). None reads or writes a
 * conversation, a message, a turn or an event, and nothing is sent: a draft
 * reaches customers only once a person approves it.
 *
 * THE DRY RUN is the real decision model, the real gate and the real
 * ask-first check on a synthetic one-message episode, in memory. It does not
 * compose a hand-over's closing line or brochure, the routing, a branch
 * number's silence policy, or the withheld-reply fallback (a guarded silence
 * on a main channel becomes the unclear hand-over live): "silent" is reported
 * as the gate said it. It reads the approved knowledge and rules plus the
 * caller's own drafts of the last day, so a draft shows its effect before
 * approval.
 *
 * WHAT IS RECORDED. Each draft is its own transaction with its audit row (the
 * services'); the chat's words are never logged. A tool's transaction runs
 * without the request's idempotency claim (`toolOpCtx`): the teach answer is
 * the request's stored answer, never a draft row.
 */

export const TEACH_MAX_TOOL_CALLS = 6;
export const TEACH_WALL_MS = 90_000;
export const TEACH_DRAFT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const TEACH_LINES = {
  unavailable: 'The assistant is not switched on for this deployment, so it cannot be taught here yet.',
  failed:
    'I could not finish that just now. Anything listed below was saved as a draft; nothing else changed. Try again in a moment.',
} as const;

/** The request's context without its idempotency claim: a tool's withTx must never store its row as the teach answer. */
export function toolOpCtx(base: OpContext): OpContext {
  const { idempotency: _claim, ...rest } = base;
  return rest;
}

export interface TeachDeps {
  db: Db;
  runtime: InboxAiRuntime;
  op: OpContext;
}

type TeachCard = InboxAiTeachResponse['cards'][number];

/** Code points; a longer text is cut to n - 1 and an ellipsis. */
function clip(text: string, n: number): string {
  const chars = [...text];
  return chars.length <= n ? text : `${chars.slice(0, n - 1).join('')}…`;
}

/**
 * The request's messages as the loop takes them: leading replies dropped,
 * consecutive messages of one side joined, each staff → curator pair an
 * earlier turn, and the staff member's last message the question.
 */
export function teachTurns(messages: InboxAiTeachRequest['messages']): { question: string; priorTurns: PriorTurn[] } {
  const merged: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const m of messages) {
    if (merged.length === 0 && m.role === 'assistant') continue;
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.text = `${last.text}\n\n${m.text}`;
    else merged.push({ role: m.role, text: m.text });
  }
  const priorTurns: PriorTurn[] = [];
  let i = 0;
  for (; i + 1 < merged.length; i += 2) {
    const user = merged[i]!;
    const reply = merged[i + 1]!;
    priorTurns.push({ question: user.text, answer: { answer: clip(reply.text, 1200), links: [], language: 'en' } });
  }
  return { question: merged[i]?.text ?? '', priorTurns };
}

// --- The tools ---------------------------------------------------------------------------------

const Park = z.enum(AI_BRANCH_KEYS);
const RULE_INTENT_WORDS = [...AI_INTENTS, 'any'] as [string, ...string[]];

const SearchInput = z.object({ query: z.string().trim().min(1).max(200) }).strict();
const FactInput = z
  .object({
    topic: z.enum(INBOX_KB_TOPICS),
    key: z.string().max(80).regex(INBOX_KB_KEY_PATTERN),
    language: z.enum(INBOX_AI_CONTENT_LANGUAGES),
    park: Park.optional(),
    question: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(1200),
  })
  .strict();
const RuleInput = z
  .object({
    intent: z.enum(RULE_INTENT_WORDS),
    park: Park.optional(),
    instruction: z.string().trim().min(1).max(600),
    askFirst: z
      .object({
        condition: z.enum(['always', 'branch_unknown']),
        question: z
          .object({
            en: z.string().trim().min(1).max(200),
            th: z.string().trim().min(1).max(200).optional(),
            ru: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
const DryRunInput = z.object({ customerMessage: z.string().trim().min(1).max(500) }).strict();

const TOOLS: ReadonlyArray<{ name: string; description: string; input: z.ZodTypeAny }> = [
  {
    name: 'create_fact',
    description:
      'Save a DRAFT knowledge-base entry (a fact about the park) for approval under Assistant → Knowledge. Search first so you do not duplicate an entry. key: a lower-case slug such as faq.lost-property; language: the language the fact is written in; park: central or chalong, or leave it out for both parks; question: as a customer would ask it; body: the fact. Nothing reaches customers until a person approves it.',
    input: FactInput,
  },
  {
    name: 'create_rule',
    description:
      'Save a DRAFT behaviour rule for approval under Assistant → Rules. intent: the kind of message it is about, or any. instruction: what to do, in plain English, with no numbers, links, dates, prices or promises. askFirst: when the rule says to ask something first, the question (en, and th / ru when known), with condition branch_unknown when the question is which park, else always. park: central or chalong, or leave it out for both parks. The server refuses an unsafe rule and says why.',
    input: RuleInput,
  },
  {
    name: 'dry_run',
    description:
      'What the assistant would do now with one customer message: the real decision and checks on that one message, with the approved knowledge and rules and your drafts of the last day. Returns the intent, the outcome (answer, handover, silent_handover, silent or ask_first), the bubbles and the rule that fired. It does not compose a hand-over\'s closing line, the routing or a number\'s silence policy, and nothing is sent.',
    input: DryRunInput,
  },
  {
    name: 'search_knowledge',
    description:
      'Search the knowledge base and the behaviour rules (drafts and approved) for words of the query: matching entries with their key, park, status, question and body, and matching rules.',
    input: SearchInput,
  },
];

/** The tool definitions, sorted by name (the cached prefix stays the same bytes). */
export function teachToolDefinitions(): ToolDefinition[] {
  return [...TOOLS]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: toJsonSchema(t.input) as ToolDefinition['inputSchema'],
    }));
}

const badInput = (message: string): ToolCallResult => ({ ok: false, data: { error: { code: 'BAD_INPUT', message } } });
const refused = (code: string, message: string): ToolCallResult => ({ ok: false, data: { error: { code, message } } });
const UNKNOWN_PARK = 'That park is not one the assistant knows.';

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'The input is not valid.';
  return issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

/** A park key to its branch id; `undefined` (both parks) when none is named, null when the park is unknown. */
function branchOfPark(knowledge: TurnKnowledge, park: AiBranchKey | undefined): string | null | undefined {
  if (park === undefined) return undefined;
  return knowledge.branchOfKey.get(park) ?? null;
}

async function searchKnowledge(deps: TeachDeps, ctx: SettingsCtx, knowledge: TurnKnowledge, query: string) {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => [...w].length >= 3);
  const hit = (...texts: string[]) => {
    const hay = texts.join('\n').toLowerCase();
    return words.some((w) => hay.includes(w));
  };
  const parkOf = (branchId: string | null) => (branchId === null ? null : (knowledge.keyOfBranch.get(branchId) ?? null));
  const entries = await deps.db
    .select()
    .from(kbEntry)
    .where(and(eq(kbEntry.operatorId, ctx.operatorId), ne(kbEntry.status, 'archived')))
    .orderBy(asc(kbEntry.key), asc(kbEntry.language), asc(kbEntry.id));
  const rules = await deps.db
    .select()
    .from(aiRule)
    .where(and(eq(aiRule.operatorId, ctx.operatorId), ne(aiRule.status, 'archived')))
    .orderBy(asc(aiRule.createdAt), asc(aiRule.id));
  return {
    entries: entries
      .filter((e) => hit(e.key, e.question, e.body))
      .slice(0, 8)
      .map((e) => ({
        id: e.id,
        key: e.key,
        topic: e.topic,
        language: e.language,
        park: parkOf(e.branchId),
        status: e.status as 'draft' | 'approved',
        question: e.question,
        body: e.body,
      })),
    rules: rules
      .filter((r) => hit(r.instruction))
      .slice(0, 8)
      .map((r) => ({
        id: r.id,
        intent: r.intent,
        park: parkOf(r.branchId),
        status: r.status as 'draft' | 'approved',
        instruction: r.instruction,
        askFirst: r.askFirst ?? null,
      })),
  };
}

/** "  Ask  which PARK " → "ask which park": the sameness test for a repeated instruction. */
const sameText = (a: string, b: string): boolean =>
  a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

interface RecentDrafts {
  rules: Array<{ id: string; intent: string; branchId: string | null; instruction: string }>;
  facts: Array<{ id: string; key: string; language: string; branchId: string | null; question: string }>;
}

/**
 * What the caller saved as drafts in the last day. The curator reads it as a
 * list in its system prompt (the transcript it is sent holds words only, not
 * its earlier tool calls — without this list a curator that had saved a rule
 * on an earlier turn concluded it had not, apologised, and saved it again),
 * and `create_rule` / `create_fact` answer a repeat from it instead of
 * inserting a second row.
 */
async function recentDrafts(deps: TeachDeps, ctx: SettingsCtx): Promise<RecentDrafts> {
  const since = new Date(ctx.now.getTime() - TEACH_DRAFT_WINDOW_MS);
  const rules = await deps.db
    .select({ id: aiRule.id, intent: aiRule.intent, branchId: aiRule.branchId, instruction: aiRule.instruction })
    .from(aiRule)
    .where(
      and(
        eq(aiRule.operatorId, ctx.operatorId),
        eq(aiRule.status, 'draft'),
        eq(aiRule.updatedByAccountId, ctx.accountId),
        gte(aiRule.createdAt, since),
      ),
    )
    .orderBy(asc(aiRule.createdAt), asc(aiRule.id));
  const facts = await deps.db
    .select({ id: kbEntry.id, key: kbEntry.key, language: kbEntry.language, branchId: kbEntry.branchId, question: kbEntry.question })
    .from(kbEntry)
    .where(
      and(
        eq(kbEntry.operatorId, ctx.operatorId),
        eq(kbEntry.status, 'draft'),
        eq(kbEntry.updatedByAccountId, ctx.accountId),
        gte(kbEntry.createdAt, since),
      ),
    )
    .orderBy(asc(kbEntry.createdAt), asc(kbEntry.id));
  return { rules, facts };
}

function draftLines(d: RecentDrafts): TeachDraftLine[] {
  return [
    ...d.rules.map((r) => ({ kind: 'rule' as const, id: r.id, about: r.intent, text: r.instruction })),
    ...d.facts.map((f) => ({ kind: 'fact' as const, id: f.id, about: `${f.key} (${f.language})`, text: f.question })),
  ];
}

/**
 * The dry run (see the file note): decision, gate and ask-first on a
 * synthetic one-message episode on a main channel with no park, in memory.
 * No model run is recorded, no turn is written, nothing is sent.
 */
export async function dryRun(
  deps: TeachDeps,
  ctx: SettingsCtx,
  customerMessage: string,
): Promise<{ ok: true; data: InboxAiTeachDryRun } | { ok: false; code: string; message: string }> {
  const decider = deps.runtime.client;
  if (!decider) {
    return { ok: false, code: 'NO_CLIENT', message: 'The customer assistant is switched off here, so a dry run cannot be made.' };
  }
  const knowledge = await loadTurnKnowledge(deps.db, ctx.operatorId, ctx.now, {
    draftsBy: { accountId: ctx.accountId, since: new Date(ctx.now.getTime() - TEACH_DRAFT_WINDOW_MS) },
  });
  // A synthetic main-channel message has no park: only both-parks rules apply.
  const rules = (knowledge.rules ?? []).filter((r) => r.branchId === null);
  const built = buildPrompt({
    knowledge: knowledge.knowledge,
    episode: [{ from: 'customer', at: ctx.now, text: customerMessage }],
    context: {
      now: ctx.now,
      threadBranch: null,
      priceModeToday: knowledge.priceModeToday,
      contactCountryCode: null,
      earlier: { answered: 0, brochureSent: false, branchAsked: false, identityAnswered: false, languageOffered: false },
    },
    ...(rules.length > 0 ? { rules } : {}),
  });
  if (!built.ok) return { ok: false, code: 'KB_TOO_LARGE', message: 'The knowledge is too large for the assistant to read.' };
  const outcome = await decider.decide({ prompt: built.prompt });
  if (!outcome.ok) return { ok: false, code: outcome.reason, message: 'The customer assistant did not answer the dry run.' };
  const gated = applyGates({
    decision: outcome.decision,
    grounding: built.prompt.grounding,
    episode: {
      aiAnswers: 0,
      aiAnswersLast10Min: 0,
      identityAnswered: false,
      threadHasBranch: false,
      contactCountryCode: null,
      languageOffered: false,
    },
  });
  const fired =
    rules.length > 0
      ? askFirstOf({
          rules,
          verdict: gated,
          decision: outcome.decision,
          threadHasBranch: false,
          branchAsked: false,
          askedFirst: false,
          silentIntents: null,
        })
      : null;
  const v = fired?.verdict ?? gated;
  return {
    ok: true,
    data: {
      message: customerMessage,
      intent: v.intent,
      outcome: fired ? 'ask_first' : v.action,
      bubbles: v.action === 'answer' ? v.bubbles : v.action === 'handover' ? v.holdingBubbles : [],
      ruleFired: fired?.ruleId ?? null,
    },
  };
}

// --- The chat ----------------------------------------------------------------------------------

/**
 * One turn of the teach chat: the curator's reply, a card for every draft it
 * saved this turn, and the last dry run's result. A loop that ends without an
 * answer says so in a fixed line; the drafts already saved stay listed.
 */
export async function teach(
  deps: TeachDeps,
  ctx: SettingsCtx,
  reach: Reach,
  input: InboxAiTeachRequest,
): Promise<InboxAiTeachResponse> {
  const teacher = deps.runtime.teacher ?? null;
  if (!teacher) throw new AppError(503, 'TEACH_UNAVAILABLE', TEACH_LINES.unavailable);
  const knowledge = await loadTurnKnowledge(deps.db, ctx.operatorId, ctx.now);
  const approved = knowledge.rules ?? [];
  const drafts = await recentDrafts(deps, ctx);
  const built = buildTeachSystem({
    knowledgeText: knowledge.knowledge.text,
    rulesText: renderOperatorRules(approved),
    draftsText: renderTeachDrafts(draftLines(drafts)),
    answerMode: teacher.answerMode,
  });
  const { question, priorTurns } = teachTurns(input.messages);
  const taughtFrom = input.messages[input.messages.length - 1]?.text ?? null;

  const cards: TeachCard[] = [];
  let lastDryRun: InboxAiTeachDryRun | null = null;

  const execute = async (call: ToolCallRequest): Promise<ToolCallResult> => {
    try {
      switch (call.name) {
        case 'search_knowledge': {
          const parsed = SearchInput.safeParse(call.input);
          if (!parsed.success) return badInput(firstIssue(parsed.error));
          return { ok: true, data: await searchKnowledge(deps, ctx, knowledge, parsed.data.query) };
        }
        case 'create_fact': {
          const parsed = FactInput.safeParse(call.input);
          if (!parsed.success) return badInput(firstIssue(parsed.error));
          const { park, ...fact } = parsed.data;
          const branchId = branchOfPark(knowledge, park);
          if (branchId === null) return badInput(UNKNOWN_PARK);
          const body = InboxKbCreateSchema.safeParse({ ...fact, branchId: branchId ?? null });
          if (!body.success) return badInput(firstIssue(body.error));
          // The same draft again (this turn or an earlier one today): the one that exists, no second row.
          const sameFact = drafts.facts.find(
            (f) => f.key === body.data.key && f.language === body.data.language && (f.branchId ?? null) === (body.data.branchId ?? null),
          );
          if (sameFact) {
            cards.push({ kind: 'fact', id: sameFact.id, title: clip(`${sameFact.key} · ${sameFact.question}`, 120), status: 'draft' });
            return { ok: true, data: { id: sameFact.id, key: sameFact.key, language: sameFact.language, status: 'draft', alreadySaved: true, approveAt: 'Assistant → Knowledge' } };
          }
          const made = await withTx(deps.db, deps.op, 'inbox.kb.create', (tx) => createKb(tx, ctx, reach, body.data));
          drafts.facts.push({ id: made.id, key: made.key, language: made.language, branchId: made.branchId, question: made.question });
          cards.push({ kind: 'fact', id: made.id, title: clip(`${made.key} · ${made.question}`, 120), status: 'draft' });
          return { ok: true, data: { id: made.id, key: made.key, language: made.language, status: 'draft', approveAt: 'Assistant → Knowledge' } };
        }
        case 'create_rule': {
          const parsed = RuleInput.safeParse(call.input);
          if (!parsed.success) return badInput(firstIssue(parsed.error));
          const { park, askFirst, ...rule } = parsed.data;
          const branchId = branchOfPark(knowledge, park);
          if (branchId === null) return badInput(UNKNOWN_PARK);
          const body = InboxAiRuleCreateSchema.safeParse({ ...rule, branchId: branchId ?? null, askFirst: askFirst ?? null });
          if (!body.success) return badInput(firstIssue(body.error));
          const labelOf = (intent: string) => (intent === 'any' ? 'Any message' : intent.replace(/_/g, ' '));
          // The same rule again (this turn or an earlier one today): the one that exists, no second row.
          const sameRule = drafts.rules.find(
            (r) => r.intent === body.data.intent && (r.branchId ?? null) === (body.data.branchId ?? null) && sameText(r.instruction, body.data.instruction),
          );
          if (sameRule) {
            cards.push({ kind: 'rule', id: sameRule.id, title: clip(`${labelOf(sameRule.intent)}: ${sameRule.instruction}`, 120), status: 'draft' });
            return { ok: true, data: { id: sameRule.id, intent: sameRule.intent, status: 'draft', alreadySaved: true, approveAt: 'Assistant → Rules' } };
          }
          const made = await withTx(deps.db, deps.op, 'inbox.ai_rule.create', (tx) =>
            createRule(tx, ctx, reach, body.data, { source: 'teach', taughtFrom }),
          );
          drafts.rules.push({ id: made.id, intent: made.intent, branchId: made.branchId, instruction: made.instruction });
          cards.push({ kind: 'rule', id: made.id, title: clip(`${labelOf(made.intent)}: ${made.instruction}`, 120), status: 'draft' });
          return { ok: true, data: { id: made.id, intent: made.intent, status: 'draft', approveAt: 'Assistant → Rules' } };
        }
        case 'dry_run': {
          const parsed = DryRunInput.safeParse(call.input);
          if (!parsed.success) return badInput(firstIssue(parsed.error));
          const ran = await dryRun(deps, ctx, parsed.data.customerMessage);
          if (!ran.ok) return refused(ran.code, ran.message);
          lastDryRun = ran.data;
          return { ok: true, data: ran.data };
        }
        default:
          return refused('UNKNOWN_TOOL', 'No such tool.');
      }
    } catch (err) {
      // A service's refusal (RULE_UNSAFE, KB_KEY_TAKEN, …) goes back to the model as data, in its sentence.
      if (err instanceof AppError) return refused(err.code, err.message);
      throw err;
    }
  };

  const outcome = await teacher.converse({
    system: built.system,
    question,
    priorTurns,
    tools: teachToolDefinitions(),
    execute,
    maxToolCalls: TEACH_MAX_TOOL_CALLS,
    wallMs: TEACH_WALL_MS,
    answerMode: built.answerMode,
  });
  return { reply: outcome.ok ? outcome.answer.answer : TEACH_LINES.failed, cards, dryRun: lastDryRun };
}
