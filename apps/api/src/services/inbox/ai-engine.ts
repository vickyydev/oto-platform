import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  applyGates,
  buildPrompt,
  scheduleBubbles,
  type AiBranchKey,
  type AiDecision,
  type AiHandoverPlan,
  type AiReplyLanguage,
  type AssistantOutcome,
  type EpisodeMessage,
  type EpisodeState,
  type GateVerdict,
  type PacingConfig,
  type TurnUsage,
} from '@oto/assistant';
import {
  aiTurn,
  assignment,
  channelAccount,
  contact,
  conversation,
  inboxEvent,
  message,
  team,
  template,
  type Db,
  type InboxCategory,
  type InboxTeamKey,
} from '@oto/db';
import { isoDateInTz, newId, renderTemplate } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { audit } from '../audit';
import type { FileStorage } from '../files';
import { recordRun } from '../ops';
import { withTx, type Exec, type Tx } from '../tx';
import type { InboxAiRuntime } from './ai-runtime';
import { loadTurnKnowledge, type TurnKnowledge } from './ai-knowledge';
import { aiEligibility, dueAiMessageIds, type IneligibleReason } from './ai-turns';
import type { InboxChannels } from './channels';
import { routeConversation } from './router';
import { sendAfterCommit } from './send';

/**
 * THE TURN ENGINE: `job:inbox.ai` (SCRUM-590, round A2 lane a; plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §A.2, §B.5, §B.6, §D).
 *
 * Every five seconds, under the job runner's advisory lock:
 *
 *   1. CLAIM each due turn in ONE statement — `pending` and due, or `deciding`
 *      whose lease ran out with an attempt left — moving it to `deciding` with
 *      a 90-second lease (the send path's claim, copied). Two ticks or two
 *      instances cannot both claim it. A lease that runs out twice is given up
 *      as silence (`PROVIDER_ERROR`).
 *   2. Before any call: the kill switches (`INBOX_AI_ENABLED`, the account's
 *      `ai_mode`, the thread's pause), eligibility (§A.3), the daily caps and
 *      the circuit breaker (§D.4). A burst with no text is silence without a
 *      call (X8).
 *   3. THE MODEL CALL, WITH NO TRANSACTION OPEN: the knowledge (`ai-knowledge.ts`)
 *      and the episode built into the prompt, one structured decision, then
 *      the server's gates (`@oto/assistant` `applyGates`). Every call is an
 *      `ops_run` (`adapter:inbox.ai`): ids, outcome, latency, tokens, the
 *      error word.
 *   4. THE COMMIT, under the thread lock, RE-CHECKING EVERYTHING: the turn is
 *      still ours (not cancelled by a person's action, not re-claimed), the
 *      switches still on, the thread still eligible, and no newer customer
 *      message (else `superseded`). Then §B.5: an answer queues `author_kind
 *      'ai'` lines paced by `next_attempt_at`; a handover queues the holding
 *      line (and the birthday brochure) and may re-route; silence writes only
 *      its pill. Shadow mode records the decision on the turn and writes
 *      NOTHING to the thread.
 *   5. SENDS the AI lines whose typing time is over, through the one send
 *      path (`send.ts`), so the 30-second sweeper's grain does not apply.
 *
 * FAILURE IS SILENCE, AND NOTHING LOGS TEXT (§D.1). A turn that throws is
 * logged by id and error class only (a database error can carry the values
 * it was given) and is left to its lease. Audit, events and ops rows carry
 * ids, enums, counts and single words.
 */

export const INBOX_AI_JOB = 'job:inbox.ai';
export const INBOX_AI_INTERVAL_S = 5;
/** How long a claim holds a turn while the model is asked (§A.2). */
export const AI_LEASE_MS = 90_000;
/** Claims a turn may have before it is given up as silence (§A.2). */
export const AI_MAX_ATTEMPTS = 2;
/**
 * A turn claimed this long after it fell due is silence (`STALE`): after an
 * outage or with the switch off for a while, an answer to a question asked
 * long ago is worse than a person picking it up.
 */
export const AI_STALE_MS = 10 * 60_000;
/** §D.4 guard 5. */
export const CIRCUIT_FAILURES = 5;
export const CIRCUIT_PAUSE_MS = 10 * 60_000;
/** Turns one tick decides at most; the rest wait for the next tick. */
const TURN_BATCH = 10;

/** The provider being down, as opposed to the model declining: what the circuit breaker counts. */
const OUTAGE_REASONS = ['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR'] as const;

const TEAM_OF_CATEGORY: Record<InboxCategory, InboxTeamKey> = {
  birthdays: 'birthdays',
  general: 'reception',
  marketing: 'marketing',
};

export interface AiEngineDeps {
  runtime: InboxAiRuntime;
  channels: InboxChannels;
  /** Where the brochure's file is signed from for the send (the send path's media, rails R4). */
  storage?: FileStorage | null;
  log?: FastifyBaseLogger;
  /** The commit's clock; tests pin it. */
  now?: () => Date;
}

export interface AiSweep extends Record<string, unknown> {
  due: number;
  answered: number;
  handedOver: number;
  silent: number;
  shadowed: number;
  cancelled: number;
  superseded: number;
  skipped: number;
  errors: number;
  givenUp: number;
  aiMessagesSent: number;
}

type TurnRow = typeof aiTurn.$inferSelect;
type ConversationRow = typeof conversation.$inferSelect;
type AccountRow = typeof channelAccount.$inferSelect;
type Final = 'answered' | 'handed_over' | 'silent' | 'shadowed' | 'cancelled' | 'superseded' | 'skipped';

/** A database or SDK error's class name, never its message (which can echo values). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.constructor.name || 'Error' : 'NonError';
}

/** An ops error that is one word: what a failed `adapter:inbox.ai` run records. */
function opsError(word: string): Error {
  const e = new Error(`inbox assistant ${word}`);
  e.name = word;
  return e;
}

// --- 1. The claim ---------------------------------------------------------------------------

/** §A.2: one statement, so two claimers can never both have it. */
export async function claimAiTurn(db: Exec, turnId: string, now: Date): Promise<TurnRow | null> {
  const [row] = await db
    .update(aiTurn)
    .set({
      state: 'deciding',
      attempts: sql`${aiTurn.attempts} + 1`,
      leaseUntil: new Date(now.getTime() + AI_LEASE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(aiTurn.id, turnId),
        or(
          and(eq(aiTurn.state, 'pending'), lte(aiTurn.dueAt, now)),
          and(eq(aiTurn.state, 'deciding'), lte(aiTurn.leaseUntil, now), lt(aiTurn.attempts, AI_MAX_ATTEMPTS)),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

// --- 2. What the turn knows before it asks -------------------------------------------------

interface Usage {
  turns: number;
  tokens: number;
  /** CAP_DAILY was already raised today. */
  raised: boolean;
}

/** Today's (Bangkok) model calls and tokens of an operator (§D.4 guard 4). */
async function todaysUsage(db: Exec, operatorId: string, now: Date): Promise<Usage> {
  const dayStart = `${isoDateInTz(now, 'Asia/Bangkok')}T00:00:00+07:00`;
  const [row] = (
    await db.execute<{ turns: number; tokens: string | number; raised: boolean | null }>(sql`
      select count(*) filter (where latency_ms is not null)::int as turns,
             coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0) + coalesce(cache_read_tokens, 0)), 0) as tokens,
             bool_or(reason = 'CAP_DAILY') as raised
        from inbox.ai_turn
       where operator_id = ${operatorId} and created_at >= ${dayStart}::timestamptz`)
  ).rows;
  return { turns: Number(row?.turns ?? 0), tokens: Number(row?.tokens ?? 0), raised: Boolean(row?.raised) };
}

/** The operator's latest model calls, newest first (the circuit breaker's evidence). */
async function recentCalls(db: Exec, operatorId: string, now: Date, n: number): Promise<Array<{ reason: string | null; at: Date }>> {
  const rows = await db
    .select({ reason: aiTurn.reason, at: aiTurn.updatedAt })
    .from(aiTurn)
    .where(
      and(
        eq(aiTurn.operatorId, operatorId),
        sql`${aiTurn.latencyMs} is not null`,
        gte(aiTurn.createdAt, new Date(now.getTime() - 86_400_000)),
      ),
    )
    .orderBy(desc(aiTurn.updatedAt), desc(aiTurn.id))
    .limit(n);
  return rows;
}

const isOutage = (reason: string | null) => (OUTAGE_REASONS as readonly string[]).includes(reason ?? '');

/** §D.4 guard 5: five consecutive provider failures pause the assistant for ten minutes. */
async function circuitOpen(db: Exec, operatorId: string, now: Date): Promise<boolean> {
  const calls = await recentCalls(db, operatorId, now, CIRCUIT_FAILURES);
  return (
    calls.length === CIRCUIT_FAILURES &&
    calls.every((c) => isOutage(c.reason)) &&
    now.getTime() - calls[0]!.at.getTime() < CIRCUIT_PAUSE_MS
  );
}

/**
 * The episode as data for the prompt: its messages in ARRIVAL order (the ids
 * are UUIDv7, minted as each row is written), never a withdrawn line. Not by
 * `created_at`: a provider's timestamp is whole seconds, so a customer line
 * can carry a time before an assistant line written a moment earlier.
 */
async function loadEpisode(db: Exec, conv: ConversationRow, episodeStart: Date): Promise<EpisodeMessage[]> {
  const rows = await db
    .select({ authorKind: message.authorKind, body: message.body, createdAt: message.createdAt })
    .from(message)
    .where(
      and(
        eq(message.operatorId, conv.operatorId),
        eq(message.conversationId, conv.id),
        gte(message.createdAt, episodeStart),
        // Never a withdrawn line, and never a shadow one (test night 2026-10-21,
        // W5): what the assistant would have said is staff's to read, not a
        // reply the customer saw.
        sql`coalesce(${message.providerStatus}, '') not in ('withdrawn', 'shadow')`,
      ),
    )
    .orderBy(desc(message.id))
    .limit(40);
  return rows.reverse().map((r) => ({
    from: r.authorKind,
    at: r.createdAt,
    text: r.body !== null && r.body.trim() !== '' ? r.body : null,
  }));
}

/** The customer's latest burst: the customer lines after the last line anyone else wrote. */
function burstOf(episode: EpisodeMessage[]): EpisodeMessage[] {
  const out: EpisodeMessage[] = [];
  for (let i = episode.length - 1; i >= 0; i -= 1) {
    if (episode[i]!.from !== 'customer') break;
    out.unshift(episode[i]!);
  }
  return out;
}

interface EpisodeFacts {
  state: EpisodeState;
  earlier: { answered: number; brochureSent: boolean; branchAsked: boolean; identityAnswered: boolean };
}

/** §D.4 guard 3 and the prompt's context line, counted from this episode's own rows. */
async function episodeFacts(db: Exec, conv: ConversationRow, episodeStart: Date, now: Date): Promise<EpisodeFacts> {
  const answered = await db
    .select({ intent: aiTurn.intent, at: aiTurn.updatedAt })
    .from(aiTurn)
    .where(
      and(
        eq(aiTurn.operatorId, conv.operatorId),
        eq(aiTurn.conversationId, conv.id),
        eq(aiTurn.state, 'answered'),
        gte(aiTurn.createdAt, episodeStart),
      ),
    );
  const events = await db
    .select({ kind: inboxEvent.kind, payload: inboxEvent.payload })
    .from(inboxEvent)
    .where(
      and(
        eq(inboxEvent.operatorId, conv.operatorId),
        eq(inboxEvent.conversationId, conv.id),
        eq(inboxEvent.actorKind, 'ai'),
        inArray(inboxEvent.kind, ['ai_replied', 'ai_handover']),
        gte(inboxEvent.createdAt, episodeStart),
      ),
    );
  const tenAgo = now.getTime() - 10 * 60_000;
  const identityAnswered = answered.some((t) => t.intent === 'identity_question');
  const payloads = events.map((e) => (e.payload ?? {}) as { askBranch?: unknown; brochureFileIds?: unknown });
  return {
    state: {
      aiAnswers: answered.length,
      aiAnswersLast10Min: answered.filter((t) => t.at.getTime() >= tenAgo).length,
      identityAnswered,
      threadHasBranch: conv.branchId !== null,
    },
    earlier: {
      answered: answered.length,
      brochureSent: payloads.some((p) => Array.isArray(p.brochureFileIds) && p.brochureFileIds.length > 0),
      branchAsked: payloads.some((p) => p.askBranch === true),
      identityAnswered,
    },
  };
}

// --- 3. The run of one turn ----------------------------------------------------------------

/** What the turn ended with, before the commit re-checks it. */
interface TurnResult {
  /** A person's action or a kill switch: the turn is cancelled and nothing reaches the thread. */
  cancel?: string;
  /** Silence with no verdict: a cap, the circuit, a provider failure, no text… */
  silence?: string;
  verdict?: GateVerdict;
  decision?: AiDecision;
  model?: string | null;
  personaVersion?: string;
  kbVersion?: string;
  usage?: TurnUsage | null;
  latencyMs?: number;
  knowledge?: TurnKnowledge;
}

async function recordModelRun(
  db: Db,
  turn: TurnRow,
  conv: ConversationRow,
  outcome: AssistantOutcome,
  startedAt: Date,
): Promise<void> {
  const reason = outcome.ok ? null : outcome.reason;
  await recordRun(db, {
    kind: 'adapter',
    name: 'adapter:inbox.ai',
    outcome: outcome.ok ? 'ok' : 'failed',
    startedAt,
    operatorId: turn.operatorId,
    branchId: conv.branchId,
    // Ids, the outcome word, latency and tokens. Never a prompt, a decision or a line.
    detail: {
      turnId: turn.id,
      conversationId: turn.conversationId,
      outcome: outcome.ok ? 'ok' : reason,
      model: outcome.model,
      latencyMs: outcome.latencyMs,
      inputTokens: outcome.usage?.inputTokens ?? null,
      outputTokens: outcome.usage?.outputTokens ?? null,
      cacheReadTokens: outcome.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: outcome.usage?.cacheWriteTokens ?? null,
      providerRequestId: outcome.requestId,
      errorClass: outcome.ok ? null : (outcome.error?.errorClass ?? null),
      status: outcome.ok ? null : (outcome.error?.status ?? null),
    },
    ...(reason ? { error: opsError(reason) } : {}),
  });
}

/** One ops failure for a guard that just tripped (§D.4: "raised once"). */
async function raiseGuard(db: Db, turn: TurnRow, branchId: string | null, word: 'CAP_DAILY' | 'CIRCUIT_OPEN'): Promise<void> {
  const at = new Date();
  await recordRun(db, {
    kind: 'adapter',
    name: 'adapter:inbox.ai',
    outcome: 'failed',
    startedAt: at,
    finishedAt: at,
    operatorId: turn.operatorId,
    branchId,
    detail: { turnId: turn.id, conversationId: turn.conversationId, outcome: word },
    error: opsError(word),
  });
}

async function decideTurn(db: Db, deps: AiEngineDeps, turn: TurnRow, now: Date): Promise<TurnResult & { conv?: ConversationRow }> {
  const cfg = deps.runtime.config;
  const [conv] = await db
    .select()
    .from(conversation)
    .where(and(eq(conversation.operatorId, turn.operatorId), eq(conversation.id, turn.conversationId)))
    .limit(1);
  if (!conv) return { cancel: 'GONE' };
  const [account] = await db
    .select()
    .from(channelAccount)
    .where(and(eq(channelAccount.operatorId, conv.operatorId), eq(channelAccount.id, conv.channelAccountId)))
    .limit(1);
  if (!account) return { conv, cancel: 'GONE' };

  // The kill switches and a person: nothing reaches the thread.
  if (!cfg.enabled) return { conv, cancel: 'DISABLED' };
  if (account.aiMode !== 'live' && account.aiMode !== 'shadow') return { conv, cancel: 'MODE_OFF' };
  const eligible = await aiEligibility(db, conv);
  if (!eligible.ok) return { conv, cancel: eligible.reason };

  if (now.getTime() - turn.dueAt.getTime() > AI_STALE_MS) return { conv, silence: 'STALE' };

  // §D.4 guard 4: the daily caps. Raised once a day, on the first turn over.
  const usage = await todaysUsage(db, turn.operatorId, now);
  if (usage.turns >= cfg.dailyTurnCap || usage.tokens >= cfg.dailyTokenCap) {
    if (!usage.raised) await raiseGuard(db, turn, conv.branchId, 'CAP_DAILY');
    return { conv, silence: 'CAP_DAILY' };
  }
  // §D.4 guard 5.
  if (await circuitOpen(db, turn.operatorId, now)) return { conv, silence: 'CIRCUIT_OPEN' };

  const episode = await loadEpisode(db, conv, eligible.episodeStart);
  const burst = burstOf(episode);
  // X8: a voice note, an image or a sticker with no words is a person's to pick up.
  if (burst.length === 0 || burst.every((m) => m.text === null)) return { conv, silence: 'NO_TEXT' };

  const knowledge = await loadTurnKnowledge(db, turn.operatorId, now);
  const facts = await episodeFacts(db, conv, eligible.episodeStart, now);
  const built = buildPrompt({
    knowledge: knowledge.knowledge,
    episode,
    context: {
      now,
      threadBranch: conv.branchId ? (knowledge.keyOfBranch.get(conv.branchId) ?? null) : null,
      priceModeToday: knowledge.priceModeToday,
      earlier: facts.earlier,
    },
  });
  if (!built.ok) return { conv, silence: built.reason, kbVersion: knowledge.knowledge.version, knowledge };

  const client = deps.runtime.client;
  if (!client) return { conv, silence: 'NO_CLIENT', kbVersion: built.prompt.kbVersion, personaVersion: built.prompt.personaVersion };

  const startedAt = new Date();
  let outcome: AssistantOutcome;
  try {
    outcome = await client.decide({ prompt: built.prompt });
  } catch (err) {
    // The client never throws by contract; a throw is classified, never logged.
    outcome = {
      ok: false,
      reason: 'PROVIDER_ERROR',
      error: { errorClass: errorName(err), status: null, requestId: null },
      usage: null,
      model: null,
      requestId: null,
      latencyMs: Date.now() - startedAt.getTime(),
    };
  }
  await recordModelRun(db, turn, conv, outcome, startedAt);

  const base: TurnResult = {
    model: outcome.model ?? client.model,
    personaVersion: built.prompt.personaVersion,
    kbVersion: built.prompt.kbVersion,
    usage: outcome.usage,
    latencyMs: Math.max(0, Math.round(outcome.latencyMs)),
    knowledge,
  };
  if (!outcome.ok) return { ...base, conv, silence: outcome.reason };
  const verdict = applyGates({ decision: outcome.decision, grounding: built.prompt.grounding, episode: facts.state });
  return { ...base, conv, decision: outcome.decision, verdict };
}

// --- 4. The commit ------------------------------------------------------------------------

interface LineItem {
  body: string | null;
  templateId?: string | null;
  mediaFileIds?: string[];
}

/** At most 140 characters on a character boundary — the ingest's preview rule. */
function previewOf(text: string | null): string | null {
  if (!text) return null;
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length <= 140 ? chars.join('') : `${chars.slice(0, 139).join('')}…`;
}

/** The templates that may carry a line on this thread: active, live, its channel or any, its branch or any. */
async function usableTemplates(tx: Tx, conv: ConversationRow, account: AccountRow, key: string) {
  const branchId = conv.branchId ?? account.branchId;
  return tx
    .select()
    .from(template)
    .where(
      and(
        eq(template.operatorId, conv.operatorId),
        eq(template.key, key as never),
        eq(template.active, true),
        isNull(template.archivedAt),
        or(isNull(template.channel), eq(template.channel, account.channel)),
        or(isNull(template.branchId), branchId ? eq(template.branchId, branchId) : sql`false`),
      ),
    );
}

type HoldingLine = { kind: 'template' | 'persona' | 'none'; items: LineItem[]; templateId: string | null };

/**
 * The holding line (§C.5, owner G6 default): the template VERBATIM in the
 * customer's language; the model's own checked words only where that
 * language's row still needs translation (or is missing); and nothing when
 * neither exists — the handover still happens, a person owns the thread.
 */
async function holdingLine(
  tx: Tx,
  conv: ConversationRow,
  account: AccountRow,
  key: string,
  language: AiReplyLanguage,
  modelWords: readonly string[],
): Promise<HoldingLine> {
  const rows = (await usableTemplates(tx, conv, account, key)).filter((t) => t.language === language);
  const rank = (t: (typeof rows)[number]) => (t.channel ? 0 : 2) + (t.branchId ? 0 : 1);
  const row = rows.sort((a, b) => rank(a) - rank(b))[0];
  if (row && !row.needsTranslation) {
    const rendered = renderTemplate(row.body, {});
    if (rendered.missing.length === 0) {
      return { kind: 'template', items: [{ body: rendered.text, templateId: row.id }], templateId: row.id };
    }
  }
  if (modelWords.length > 0) return { kind: 'persona', items: modelWords.map((w) => ({ body: w })), templateId: null };
  return { kind: 'none', items: [], templateId: null };
}

/**
 * The birthday brochure (§C.5): the file(s) on the `handover_birthday`
 * template — the thread's park's when it has one, both parks' on a branchless
 * thread — one message per file, through the send path (media, rails R4).
 */
async function brochureFiles(tx: Tx, conv: ConversationRow, account: AccountRow, language: AiReplyLanguage): Promise<string[]> {
  const rows = await tx
    .select()
    .from(template)
    .where(
      and(
        eq(template.operatorId, conv.operatorId),
        eq(template.key, 'handover_birthday'),
        eq(template.active, true),
        isNull(template.archivedAt),
        or(isNull(template.channel), eq(template.channel, account.channel)),
        sql`cardinality(${template.attachmentFileIds}) > 0`,
      ),
    );
  const branchId = conv.branchId ?? account.branchId;
  const candidates = branchId
    ? (() => {
        const own = rows.filter((r) => r.branchId === branchId);
        return own.length > 0 ? own : rows.filter((r) => r.branchId === null);
      })()
    : rows;
  // One row per park: the customer's language first, then English, then any.
  const byPark = new Map<string, (typeof rows)[number]>();
  const langRank = (l: string) => (l === language ? 0 : l === 'en' ? 1 : 2);
  for (const r of candidates) {
    const k = r.branchId ?? '';
    const prior = byPark.get(k);
    if (!prior || langRank(r.language) < langRank(prior.language)) byPark.set(k, r);
  }
  return [...new Set([...byPark.values()].flatMap((r) => r.attachmentFileIds))];
}

/** No person seated anyone on this thread: every active slot is the system's or the assistant's. */
async function noPersonRouting(tx: Tx, conv: ConversationRow): Promise<boolean> {
  const [row] = await tx
    .select({ id: assignment.id })
    .from(assignment)
    .where(
      and(
        eq(assignment.operatorId, conv.operatorId),
        eq(assignment.conversationId, conv.id),
        isNull(assignment.releasedAt),
        eq(assignment.assignedByKind, 'account'),
      ),
    )
    .limit(1);
  return !row;
}

/**
 * The assistant moves the thread (§B.5, rails change R3): the move-team path
 * — every slot released, the category, team and branch set, the destination's
 * rule seated — with the assistant as the actor and `assigned_by_kind 'ai'`.
 */
async function aiMove(
  tx: Tx,
  conv: ConversationRow,
  dest: typeof team.$inferSelect,
  category: InboxCategory,
  branchId: string | null,
  at: Date,
): Promise<string> {
  const slots = await tx
    .select()
    .from(assignment)
    .where(and(eq(assignment.operatorId, conv.operatorId), eq(assignment.conversationId, conv.id), isNull(assignment.releasedAt)));
  if (slots.length > 0) {
    await tx
      .update(assignment)
      .set({ releasedAt: at, updatedAt: at })
      .where(and(eq(assignment.operatorId, conv.operatorId), inArray(assignment.id, slots.map((s) => s.id)), isNull(assignment.releasedAt)));
    await tx.insert(inboxEvent).values(
      slots.map((a) => ({
        id: newId(),
        operatorId: conv.operatorId,
        conversationId: conv.id,
        kind: 'released' as const,
        actorKind: 'ai' as const,
        payload: {
          assignmentId: a.id,
          slot: a.slot,
          slotIndex: a.slotIndex,
          assigneeKind: a.assigneeKind,
          accountId: a.accountId,
          teamId: a.teamId,
          reason: 'move',
        },
        createdAt: at,
      })),
    );
  }
  await tx
    .update(conversation)
    .set({ category, teamId: dest.id, branchId, updatedAt: at })
    .where(and(eq(conversation.operatorId, conv.operatorId), eq(conversation.id, conv.id)));
  await tx.insert(inboxEvent).values({
    id: newId(),
    operatorId: conv.operatorId,
    conversationId: conv.id,
    kind: 'moved_team',
    actorKind: 'ai',
    payload: {
      followsPrimary: false,
      byAi: true,
      fromTeamId: conv.teamId,
      toTeamId: dest.id,
      toTeamName: dest.name,
      fromCategory: conv.category,
      toCategory: category,
      fromBranchId: conv.branchId,
      toBranchId: branchId,
    },
    createdAt: at,
  });
  await routeConversation(tx, {
    operatorId: conv.operatorId,
    conversationId: conv.id,
    category,
    language: conv.language ?? 'en',
    branchId,
    at,
    reroute: { teamId: dest.id, reason: 'move', by: 'ai' },
  });
  return dest.id;
}

async function teamFor(tx: Tx, operatorId: string, category: InboxCategory, branchId: string | null) {
  const key = TEAM_OF_CATEGORY[category];
  const [t] = await tx
    .select()
    .from(team)
    .where(
      and(
        eq(team.operatorId, operatorId),
        eq(team.key, key),
        key === 'reception' ? (branchId ? eq(team.branchId, branchId) : sql`false`) : isNull(team.branchId),
      ),
    )
    .orderBy(asc(team.sortOrder), asc(team.createdAt))
    .limit(1);
  return t ?? null;
}

interface Routing {
  branchSet: string | null;
  reroutedTeamId: string | null;
}

/**
 * The branch the customer named, and the category the intent belongs to
 * (§B.5): a branchless general thread takes the named park and that park's
 * reception; a handover whose category differs from the thread's moves it —
 * each only when no person has touched the routing.
 */
async function applyRouting(
  tx: Tx,
  conv: ConversationRow,
  branchNamed: AiBranchKey | null,
  plan: AiHandoverPlan | null,
  knowledge: TurnKnowledge | undefined,
  at: Date,
): Promise<Routing> {
  const out: Routing = { branchSet: null, reroutedTeamId: null };
  if (!(await noPersonRouting(tx, conv))) return out;
  let branchId = conv.branchId;
  if (branchNamed && conv.category === 'general' && conv.branchId === null && knowledge) {
    const named = knowledge.branchOfKey.get(branchNamed) ?? null;
    if (named) {
      branchId = named;
      out.branchSet = named;
      await tx
        .update(conversation)
        .set({ branchId: named, updatedAt: at })
        .where(and(eq(conversation.operatorId, conv.operatorId), eq(conversation.id, conv.id)));
      await tx.insert(inboxEvent).values({
        id: newId(),
        operatorId: conv.operatorId,
        conversationId: conv.id,
        kind: 'branch_set',
        actorKind: 'ai',
        payload: { fromBranchId: null, toBranchId: named, byAi: true },
        createdAt: at,
      });
    }
  }
  const target: InboxCategory = plan && plan.route !== 'keep' ? plan.route : conv.category;
  if (target !== conv.category || out.branchSet) {
    const dest = await teamFor(tx, conv.operatorId, target, branchId);
    if (dest && dest.id !== conv.teamId) {
      const destBranch = dest.key === 'reception' ? dest.branchId : branchId;
      out.reroutedTeamId = await aiMove(tx, { ...conv, branchId }, dest, target, destBranch, at);
    }
  }
  return out;
}

/** Writes the turn's final row and its decide audit. */
async function closeTurn(
  tx: Tx,
  turn: TurnRow,
  conv: ConversationRow | undefined,
  state: Exclude<Final, 'skipped'>,
  reason: string,
  r: TurnResult,
  at: Date,
  messageIds: string[] = [],
): Promise<void> {
  const v = r.verdict;
  const d = r.decision;
  const fields = {
    state,
    reason,
    intent: v?.intent ?? d?.intent ?? null,
    action: v?.action ?? (state === 'silent' ? ('silent' as const) : null),
    certainty: d?.certainty ?? null,
    language: d?.language ?? null,
    model: r.model ?? null,
    personaVersion: r.personaVersion ?? null,
    kbVersion: r.kbVersion ?? null,
    inputTokens: r.usage?.inputTokens ?? null,
    outputTokens: r.usage?.outputTokens ?? null,
    cacheReadTokens: r.usage?.cacheReadTokens ?? null,
    latencyMs: r.latencyMs ?? null,
    messageIds,
  };
  await tx
    .update(aiTurn)
    .set({ ...fields, leaseUntil: null, updatedAt: at })
    .where(and(eq(aiTurn.operatorId, turn.operatorId), eq(aiTurn.id, turn.id)));
  await audit.record(tx, {
    actorAccountId: null,
    action: 'inbox.ai.turn.decide',
    entityType: 'inbox.ai_turn',
    entityId: turn.id,
    operatorId: turn.operatorId,
    branchId: conv?.branchId ?? null,
    requestId: null,
    before: { state: 'deciding', attempts: turn.attempts },
    after: {
      turnId: turn.id,
      conversationId: turn.conversationId,
      ...fields,
      // The gate's rule id, and the grounding keys the answer rests on —
      // only keys the prompt offered, never a string the model invented.
      gate: v && v.action === 'silent' ? (v.rule ?? null) : null,
      groundingKeys: v && v.action === 'answer' ? v.groundingKeys : [],
      // Every part the burst held (test night 2026-10-21, D1a): the turn row
      // keeps the primary in `intent`; the audit keeps them all.
      intents: v?.intents ?? d?.intents ?? null,
      cacheWriteTokens: r.usage?.cacheWriteTokens ?? null,
    },
  });
}

async function writeLines(
  tx: Tx,
  conv: ConversationRow,
  language: AiReplyLanguage,
  items: LineItem[],
  at: Date,
  random: () => number,
  pacing: PacingConfig,
): Promise<string[]> {
  if (items.length === 0) return [];
  const due = scheduleBubbles(at, items.map((i) => i.body ?? ''), random, pacing);
  const rows = items.map((item, i) => ({
    id: newId(),
    operatorId: conv.operatorId,
    conversationId: conv.id,
    channelAccountId: conv.channelAccountId,
    direction: 'outbound' as const,
    authorKind: 'ai' as const,
    body: item.body,
    bodyLanguage: language,
    templateId: item.templateId ?? null,
    mediaFileIds: item.mediaFileIds ?? [],
    providerStatus: 'queued' as const,
    source: 'channel' as const,
    nextAttemptAt: due[i]!,
    // One millisecond apart, so the thread reads them in the order they leave.
    createdAt: new Date(at.getTime() + i),
    updatedAt: at,
  }));
  await tx.insert(message).values(rows);
  const last = rows[rows.length - 1]!;
  const preview = [...rows].reverse().find((r) => r.body)?.body ?? null;
  // AI lines are not an answer (`shared/inbox.ts` isUnanswered): the staff
  // clock and the first-response time do not move.
  await tx
    .update(conversation)
    .set({
      lastMessageAt: sql`greatest(${conversation.lastMessageAt}, ${last.createdAt.toISOString()}::timestamptz)`,
      ...(preview ? { lastMessagePreview: previewOf(preview) } : {}),
      updatedAt: at,
    })
    .where(and(eq(conversation.operatorId, conv.operatorId), eq(conversation.id, conv.id)));
  return rows.map((r) => r.id);
}

/**
 * A shadow turn's reply, kept for staff (test night 2026-10-21, W5): ONE
 * `author_kind 'ai'` row with `provider_status 'shadow'`, the lines joined
 * with a newline, and no `next_attempt_at` — the send claim takes `queued`
 * rows only, so it never leaves. It lives where message text already lives,
 * so the erasure and the retention sweep redact it with every other line;
 * the episode loader skips it, and the thread's last-message fields do not
 * move (nobody received anything). Null when there was nothing to say.
 */
async function writeShadowLine(tx: Tx, conv: ConversationRow, language: AiReplyLanguage, lines: readonly string[], at: Date): Promise<string | null> {
  const body = lines.map((l) => l.trim()).filter((l) => l.length > 0).join('\n');
  if (body.length === 0) return null;
  const id = newId();
  await tx.insert(message).values({
    id,
    operatorId: conv.operatorId,
    conversationId: conv.id,
    channelAccountId: conv.channelAccountId,
    direction: 'outbound',
    authorKind: 'ai',
    body,
    bodyLanguage: language,
    templateId: null,
    mediaFileIds: [],
    // In the column's CHECK (`0084_inbox_ai_shadow`) but not in the rails'
    // `MessageStoredStatus`, whose readers rank and move deliveries this row
    // never joins (`MESSAGE_CHECK_STATUSES`); written as SQL for that reason.
    providerStatus: sql`'shadow'`,
    source: 'channel',
    nextAttemptAt: null,
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

function event(conv: ConversationRow, kind: typeof inboxEvent.$inferInsert.kind, payload: Record<string, unknown>, at: Date) {
  return { id: newId(), operatorId: conv.operatorId, conversationId: conv.id, kind, actorKind: 'ai' as const, payload, createdAt: at };
}

/**
 * The commit (§A.2, §B.5). Answers what the turn became, or `skipped` when it
 * is no longer this claim's to close (a person cancelled it, or its lease ran
 * out and another claim has it).
 */
async function commitTurn(db: Db, deps: AiEngineDeps, claimed: TurnRow, r: TurnResult): Promise<Final> {
  const at = (deps.now ?? (() => new Date()))();
  return withTx(
    db,
    { operatorId: claimed.operatorId, ...(deps.log ? { log: deps.log } : {}) },
    'inbox.ai.turn.commit',
    async (tx): Promise<Final> => {
      const [conv] = await tx
        .select()
        .from(conversation)
        .where(and(eq(conversation.operatorId, claimed.operatorId), eq(conversation.id, claimed.conversationId)))
        .limit(1)
        .for('update');
      const [turn] = await tx
        .select()
        .from(aiTurn)
        .where(and(eq(aiTurn.operatorId, claimed.operatorId), eq(aiTurn.id, claimed.id)))
        .limit(1)
        .for('update');
      if (!turn || turn.state !== 'deciding' || turn.attempts !== claimed.attempts) return 'skipped';
      if (!conv) {
        await closeTurn(tx, turn, undefined, 'cancelled', 'GONE', r, at);
        return 'cancelled';
      }
      if (r.cancel) {
        await closeTurn(tx, turn, conv, 'cancelled', r.cancel, r, at);
        return 'cancelled';
      }

      // RE-CHECK EVERYTHING under the lock: the switches, a person, a newer message.
      const [account] = await tx
        .select()
        .from(channelAccount)
        .where(and(eq(channelAccount.operatorId, conv.operatorId), eq(channelAccount.id, conv.channelAccountId)))
        .limit(1);
      if (!deps.runtime.config.enabled) {
        await closeTurn(tx, turn, conv, 'cancelled', 'DISABLED', r, at);
        return 'cancelled';
      }
      if (!account || (account.aiMode !== 'live' && account.aiMode !== 'shadow')) {
        await closeTurn(tx, turn, conv, 'cancelled', 'MODE_OFF', r, at);
        return 'cancelled';
      }
      const eligible = await aiEligibility(tx, conv);
      if (!eligible.ok) {
        await closeTurn(tx, turn, conv, 'cancelled', eligible.reason satisfies IneligibleReason, r, at);
        return 'cancelled';
      }
      const [newer] = (
        await tx.execute<{ newer: boolean }>(sql`
          select exists (
                   select 1 from inbox.message m
                    where m.operator_id = ${conv.operatorId} and m.conversation_id = ${conv.id}
                      and m.direction = 'inbound'
                      and (m.id > ${turn.triggerMessageId}
                           or m.created_at > (select t.created_at from inbox.message t where t.id = ${turn.triggerMessageId})))
              or exists (
                   select 1 from inbox.ai_turn p
                    where p.operator_id = ${conv.operatorId} and p.conversation_id = ${conv.id}
                      and p.state = 'pending' and p.id <> ${turn.id}) as newer`)
      ).rows;
      if (newer?.newer) {
        await closeTurn(tx, turn, conv, 'superseded', 'SUPERSEDED', r, at);
        return 'superseded';
      }

      const v = r.verdict;
      const reason = r.silence ?? (v ? v.reason : 'PROVIDER_ERROR');

      // SHADOW (§B.5): the decision on the turn, and nothing the customer
      // sees. Since the test night (2026-10-21, W5) what it WOULD have said —
      // the answer, and the holding line a hand-over would have sent — is kept
      // as one `shadow` message row for staff, named by an `ai_shadow` pill;
      // the thread's routing, intent, language and last-message fields stay
      // as they are. A silent decision keeps nothing: nothing would have gone.
      if (account.aiMode === 'shadow') {
        let messageIds: string[] = [];
        if (v && v.action !== 'silent') {
          const plan: AiHandoverPlan | null = v.action === 'handover' ? v.plan : v.thenHandover;
          const lines: string[] = v.action === 'answer' ? [...v.bubbles] : [];
          let holdingKind: HoldingLine['kind'] = 'none';
          if (plan) {
            const holding = await holdingLine(tx, conv, account, plan.templateKey, v.language, v.action === 'handover' ? v.holdingBubbles : []);
            holdingKind = holding.kind;
            lines.push(...holding.items.flatMap((i) => (i.body ? [i.body] : [])));
          }
          const id = await writeShadowLine(tx, conv, v.language, lines, at);
          messageIds = id ? [id] : [];
          await tx.insert(inboxEvent).values(
            event(conv, 'ai_shadow', {
              turnId: turn.id,
              messageId: id,
              intent: v.intent,
              intents: v.intents,
              language: v.language,
              action: v.action,
              templateKey: plan?.templateKey ?? null,
              holdingLine: holdingKind,
              brochure: plan?.brochure ?? false,
            }, at),
          );
        }
        await closeTurn(tx, turn, conv, 'shadowed', reason, r, at, messageIds);
        return 'shadowed';
      }

      if (!v || v.action === 'silent') {
        await tx.insert(inboxEvent).values(event(conv, 'ai_silent', { turnId: turn.id, reason, intent: v?.intent ?? null }, at));
        await closeTurn(tx, turn, conv, 'silent', reason, r, at);
        return 'silent';
      }

      const random = deps.runtime.random;
      await tx.insert(inboxEvent).values(
        event(conv, 'classified', { turnId: turn.id, intent: v.intent, intents: v.intents, language: v.language }, at),
      );
      await tx
        .update(conversation)
        .set({ intent: v.intent, language: v.language, updatedAt: at })
        .where(and(eq(conversation.operatorId, conv.operatorId), eq(conversation.id, conv.id)));
      await tx
        .update(contact)
        .set({ language: sql`coalesce(${contact.language}, ${v.language})`, updatedAt: at })
        .where(and(eq(contact.operatorId, conv.operatorId), eq(contact.id, conv.contactId)));
      // The thread as it now stands, for everything below (test night
      // 2026-10-21, D2): the re-route must seat the people of the rule for
      // the language the customer WROTE in, not the `en` the ingest fell back
      // to when the channel sent no hint — a Thai birthday went to the EN/RU
      // birthday pair.
      const classified: ConversationRow = { ...conv, intent: v.intent, language: v.language };

      const handover: AiHandoverPlan | null = v.action === 'handover' ? v.plan : v.thenHandover;
      const items: LineItem[] = v.action === 'answer' ? v.bubbles.map((b) => ({ body: b })) : [];
      let brochure: string[] = [];
      let holding: HoldingLine = { kind: 'none', items: [], templateId: null };
      if (handover) {
        if (handover.brochure) brochure = await brochureFiles(tx, conv, account, v.language);
        holding = await holdingLine(
          tx,
          conv,
          account,
          handover.templateKey,
          v.language,
          v.action === 'handover' ? v.holdingBubbles : [],
        );
        items.push(...brochure.map((f) => ({ body: null, mediaFileIds: [f] })), ...holding.items);
      }
      const messageIds = await writeLines(tx, conv, v.language, items, at, random, deps.runtime.config.pacing);
      const routing = await applyRouting(tx, classified, v.branchNamed, handover, r.knowledge, at);

      if (v.action === 'answer') {
        await tx.insert(inboxEvent).values(
          event(conv, 'ai_replied', {
            turnId: turn.id,
            intent: v.intent,
            intents: v.intents,
            messageIds,
            askBranch: v.askBranch,
            brochureFileIds: brochure,
          }, at),
        );
      }
      if (handover) {
        await tx.insert(inboxEvent).values(
          event(conv, 'ai_handover', {
            turnId: turn.id,
            intent: v.intent,
            intents: v.intents,
            reason: v.reason,
            templateKey: handover.templateKey,
            holdingLine: holding.kind,
            templateId: holding.templateId,
            brochureFileIds: brochure,
            messageIds,
            reroutedTeamId: routing.reroutedTeamId,
            branchId: routing.branchSet,
          }, at),
        );
        await audit.record(tx, {
          actorAccountId: null,
          action: 'inbox.ai.handover',
          entityType: 'inbox.conversation',
          entityId: conv.id,
          operatorId: conv.operatorId,
          branchId: routing.branchSet ?? conv.branchId,
          requestId: null,
          before: { category: conv.category, teamId: conv.teamId, branchId: conv.branchId },
          after: {
            turnId: turn.id,
            intent: v.intent,
            templateKey: handover.templateKey,
            holdingLine: holding.kind,
            brochureFileIds: brochure,
            reroutedTeamId: routing.reroutedTeamId,
            branchId: routing.branchSet,
          },
        });
      }

      // X7 / owner G4 default: a closing on an episode no person touched is handled by the assistant.
      if (v.action === 'answer' && v.mayAutoHandle && !handover) {
        await tx
          .update(conversation)
          .set({ status: 'handled', handledAt: at, handledByKind: 'ai', handledByAccountId: null, updatedAt: at })
          .where(and(eq(conversation.operatorId, conv.operatorId), eq(conversation.id, conv.id)));
        await tx.insert(inboxEvent).values(event(conv, 'handled', { handledByKind: 'ai', turnId: turn.id }, at));
        await audit.record(tx, {
          actorAccountId: null,
          action: 'inbox.conversation.handle',
          entityType: 'inbox.conversation',
          entityId: conv.id,
          operatorId: conv.operatorId,
          branchId: conv.branchId,
          requestId: null,
          before: { status: 'active' },
          after: { status: 'handled', handledAt: at.toISOString(), handledByKind: 'ai', turnId: turn.id },
        });
      }

      const state = handover ? 'handed_over' : 'answered';
      await closeTurn(tx, turn, conv, state, reason, r, at, messageIds);
      return state;
    },
  );
}

/** Claims, decides and commits one turn. Never throws for the model's reasons. */
export async function runAiTurn(db: Db, deps: AiEngineDeps, turnId: string, now: Date): Promise<Final> {
  const claimed = await claimAiTurn(db, turnId, now);
  if (!claimed) return 'skipped';
  const result = await decideTurn(db, deps, claimed, now);
  const final = await commitTurn(db, deps, claimed, result);
  // §D.4 guard 5: the failure that makes five in a row opens the circuit, raised once.
  if (result.silence && isOutage(result.silence) && result.latencyMs !== undefined) {
    const calls = await recentCalls(db, claimed.operatorId, now, CIRCUIT_FAILURES + 1);
    const run = calls.findIndex((c) => !isOutage(c.reason));
    const consecutive = run === -1 ? calls.length : run;
    if (consecutive === CIRCUIT_FAILURES) await raiseGuard(db, claimed, result.conv?.branchId ?? null, 'CIRCUIT_OPEN');
  }
  return final;
}

/** A turn whose lease ran out on its last attempt: silence (§A.2). */
async function giveUp(db: Db, deps: AiEngineDeps, turn: TurnRow): Promise<Final> {
  return commitTurn(db, deps, turn, { silence: 'PROVIDER_ERROR' });
}

/** `job:inbox.ai`: one tick. Counts only in the run's detail. */
export async function runInboxAiJob(db: Db, deps: AiEngineDeps, now: Date): Promise<AiSweep> {
  const sweep: AiSweep = {
    due: 0,
    answered: 0,
    handedOver: 0,
    silent: 0,
    shadowed: 0,
    cancelled: 0,
    superseded: 0,
    skipped: 0,
    errors: 0,
    givenUp: 0,
    aiMessagesSent: 0,
  };
  const count = (f: Final) => {
    if (f === 'answered') sweep.answered += 1;
    else if (f === 'handed_over') sweep.handedOver += 1;
    else if (f === 'silent') sweep.silent += 1;
    else if (f === 'shadowed') sweep.shadowed += 1;
    else if (f === 'cancelled') sweep.cancelled += 1;
    else if (f === 'superseded') sweep.superseded += 1;
    else sweep.skipped += 1;
  };

  const expired = await db
    .select()
    .from(aiTurn)
    .where(and(eq(aiTurn.state, 'deciding'), lte(aiTurn.leaseUntil, now), gte(aiTurn.attempts, AI_MAX_ATTEMPTS)))
    .limit(TURN_BATCH);
  for (const t of expired) {
    try {
      const f = await giveUp(db, deps, t);
      if (f !== 'skipped') sweep.givenUp += 1;
      count(f);
    } catch (err) {
      sweep.errors += 1;
      deps.log?.error({ turnId: t.id, error: errorName(err) }, 'an assistant turn could not be given up; the next tick retries');
    }
  }

  const due = await db
    .select({ id: aiTurn.id })
    .from(aiTurn)
    .where(
      or(
        and(eq(aiTurn.state, 'pending'), lte(aiTurn.dueAt, now)),
        and(eq(aiTurn.state, 'deciding'), lte(aiTurn.leaseUntil, now), lt(aiTurn.attempts, AI_MAX_ATTEMPTS)),
      ),
    )
    .orderBy(asc(aiTurn.dueAt), asc(aiTurn.id))
    .limit(TURN_BATCH);
  sweep.due = due.length;
  for (const { id } of due) {
    try {
      count(await runAiTurn(db, deps, id, now));
    } catch (err) {
      // Left to its lease: the next tick after it retries once, then silence.
      sweep.errors += 1;
      deps.log?.error({ turnId: id, error: errorName(err) }, 'an assistant turn failed; its lease decides what happens next');
    }
  }

  // §B.6: the AI lines whose typing time is over leave now, through the one send path.
  const lines = await dueAiMessageIds(db, now);
  if (lines.length > 0) {
    const sent = await sendAfterCommit(
      db,
      {
        channels: deps.channels,
        storage: deps.storage ?? null,
        ...(deps.log ? { log: deps.log } : {}),
        now: deps.now ?? (() => now),
      },
      lines,
    );
    sweep.aiMessagesSent = sent.filter((o) => o.outcome === 'sent').length;
  }
  return sweep;
}
