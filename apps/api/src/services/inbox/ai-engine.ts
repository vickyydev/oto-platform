import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  AI_REPLY_LANGUAGES,
  BY_BRANCH,
  REVIEW_THREAD_LINES,
  REVIEW_VERSION,
  applyGates,
  applyReview,
  intentPartsOf,
  isMixedOrigin,
  joinReviewed,
  readTopic,
  resolvePlan,
  buildPrompt,
  reviewItemsOf,
  reviewWithDeadline,
  scheduleBubbles,
  type AiBranchKey,
  type AiDecision,
  type AiHandoverPlan,
  type AiIntent,
  type AiReplyLanguage,
  type AppliedReview,
  type AssistantClient,
  type AssistantOutcome,
  type BuiltPrompt,
  type EpisodeMessage,
  type EpisodeState,
  type GateVerdict,
  type PacingConfig,
  type PromptInput,
  type ProviderFailure,
  type ReviewOrigin,
  type ReviewOutcome,
  type ReviewRefusal,
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
  type InboxTemplateKey,
} from '@oto/db';
import { isoDateInTz, newId, renderTemplate } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { audit } from '../audit';
import type { FileStorage } from '../files';
import { recordRun } from '../ops';
import { withTx, type Exec, type Tx } from '../tx';
import { assistantSettingOverridesOf } from '../assistant-settings';
import type { InboxAiRuntime } from './ai-runtime';
import {
  PLAN_CLOSING_KEYS,
  WITHHELD_REPLY_REASONS,
  closingKeysOf,
  destinationOf,
  isUnclearHandover,
  planHonoured,
  planOwner,
  silencedBy,
  silentIntentsOf,
} from './ai-destination';
import { loadTurnKnowledge, type TurnKnowledge } from './ai-knowledge';
import { aiEligibility, dueAiMessageIds, type IneligibleReason } from './ai-turns';
import { callingCodeOf } from './calling-code';
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
 *      error word. Then, still with no transaction open, THE COHERENCE REVIEW
 *      (SCRUM-677, `reviewStage`): a reply that mixes the model's words and a
 *      fixed line is shown to the reviewer, which returns operations only
 *      (keep, drop, merge) under the server's rules, failing open. A reply
 *      it reads as answering something else (SCRUM-678, `rethinkTurn`) is
 *      decided once more with its reading as a hint; a second miss is the
 *      unclear hand-over. The operator's `coherenceReview` switch governs both.
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
 * THE PLAYBOOK (SCRUM-220, Tom's Inbox Bot Playbook — the first rule;
 * `ai-destination.ts`): a hand-over goes where the playbook sends it (the GM
 * queue for an online complaint or an influencer; the thread's park, else the
 * GM, for an unclear message) and closes with that DESTINATION's line, the
 * intent's own template when the destination has none. A number's SILENCE
 * POLICY turns a hand-over it covers into a silent one: the thread routes and
 * the assistant stops for the episode (`ai_handover`, `silent: true`), and no
 * line goes; the turn says `SILENCE_POLICY`. A `silent_handover` the policy
 * does not cover is a normal hand-over with the branch's line
 * (`POLICY_MISSING`). Spam the model read and stayed silent on leaves the
 * Unanswered queue, handled by the assistant (`SPAM_TIDIED`), unless an
 * earlier line of the episode still waits for a person.
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
  gm: 'gm',
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

/** A line of the episode as the engine reads it: the prompt's shape, and the row's id (the burst's anchor). */
type EpisodeRow = EpisodeMessage & { id: string };

/**
 * The episode as data for the prompt: its messages by the time each was
 * written, then by id — NEVER BY ID ALONE (test night 2026-10-21, CR6). A
 * staff line sent from the Inbox carried a random v4 id, which sorts after
 * every v7 id the api mints, so by id it was the thread's newest line and the
 * customer's lines after it were hidden: silence, `NO_TEXT`, for the rest of
 * the episode. A customer line's `created_at` is the provider's stamp, in
 * whole seconds, so within one second it can sit before a park line written
 * a moment earlier; `burstOf` allows for that. Never a withdrawn line.
 */
async function loadEpisode(db: Exec, conv: ConversationRow, episodeStart: Date): Promise<EpisodeRow[]> {
  const rows = await db
    .select({ id: message.id, authorKind: message.authorKind, body: message.body, createdAt: message.createdAt })
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
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(40);
  return rows.reverse().map((r) => ({
    id: r.id,
    from: r.authorKind,
    at: r.createdAt,
    text: r.body !== null && r.body.trim() !== '' ? r.body : null,
  }));
}

/**
 * The customer's latest burst: the customer lines after the last line anyone
 * else wrote — and always from the turn's trigger onward. The turn exists for
 * its trigger, and nothing of the park's answers a line after it is written
 * (a person's reply cancels the turn; a newer line supersedes it), so the
 * trigger is open whatever its stamp says: a provider stamps a line when the
 * customer sent it, in whole seconds, so a line sent in the same second as
 * the park's last line, or in flight behind it, sorts before that line.
 */
function burstStart(episode: readonly EpisodeRow[], triggerMessageId: string): number {
  let lastPark = -1;
  let trigger = -1;
  for (let i = 0; i < episode.length; i += 1) {
    if (episode[i]!.from !== 'customer') lastPark = i;
    if (episode[i]!.id === triggerMessageId) trigger = i;
  }
  return trigger === -1 ? lastPark + 1 : Math.min(lastPark + 1, trigger);
}

function burstOf(episode: readonly EpisodeRow[], triggerMessageId: string): EpisodeRow[] {
  return episode.slice(burstStart(episode, triggerMessageId)).filter((m) => m.from === 'customer');
}

/**
 * Nothing earlier in the episode waits for a person (SCRUM-220 spam tidy): no
 * customer line before the burst that the assistant did not answer — a line
 * out of hours, a question it left in silence — and no earlier turn of the
 * episode that ended silent. Only then may spam mark the thread handled.
 */
async function quietBeforeBurst(
  db: Exec,
  conv: ConversationRow,
  episode: readonly EpisodeRow[],
  triggerMessageId: string,
  episodeStart: Date,
  turnId: string,
): Promise<boolean> {
  let waiting = false;
  for (const m of episode.slice(0, burstStart(episode, triggerMessageId))) {
    if (m.from === 'customer') waiting = true;
    else if (m.from === 'ai') waiting = false;
  }
  if (waiting) return false;
  const [silent] = await db
    .select({ id: aiTurn.id })
    .from(aiTurn)
    .where(
      and(
        eq(aiTurn.operatorId, conv.operatorId),
        eq(aiTurn.conversationId, conv.id),
        eq(aiTurn.state, 'silent'),
        gte(aiTurn.createdAt, episodeStart),
        sql`${aiTurn.id} <> ${turnId}`,
      ),
    )
    .limit(1);
  return !silent;
}

interface EpisodeFacts {
  state: EpisodeState;
  earlier: { answered: number; brochureSent: boolean; branchAsked: boolean; identityAnswered: boolean; languageOffered: boolean };
}

/**
 * §D.4 guard 3 and the prompt's context line, counted from this episode's own
 * rows. Since SCRUM-220 (the playbook's "Languages") the gate reads the
 * contact's calling code and whether the one language offer was already made
 * (an earlier reply's `languageOffer`), so a +7 or +66 customer may be made
 * the offer once and never twice.
 */
async function episodeFacts(
  db: Exec,
  conv: ConversationRow,
  episodeStart: Date,
  now: Date,
  contactCountryCode: string | null,
): Promise<EpisodeFacts> {
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
  const payloads = events.map((e) => (e.payload ?? {}) as { askBranch?: unknown; brochureFileIds?: unknown; languageOffer?: unknown });
  const languageOffered = payloads.some((p) => p.languageOffer === 'ru' || p.languageOffer === 'th');
  return {
    state: {
      aiAnswers: answered.length,
      aiAnswersLast10Min: answered.filter((t) => t.at.getTime() >= tenAgo).length,
      identityAnswered,
      threadHasBranch: conv.branchId !== null,
      contactCountryCode,
      languageOffered,
    },
    earlier: {
      answered: answered.length,
      brochureSent: payloads.some((p) => Array.isArray(p.brochureFileIds) && p.brochureFileIds.length > 0),
      branchAsked: payloads.some((p) => p.askBranch === true),
      identityAnswered,
      languageOffered,
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
  /** Nothing earlier in the episode waits for a person: read only for a silence the spam tidy may close. */
  quietBefore?: boolean;
  /** SCRUM-677: what the coherence review left for the commit. */
  review?: ReviewState;
  /** SCRUM-678: the turn was decided again after a WRONG_TOPIC review. */
  rethink?: Rethink;
  /** SCRUM-678: the verdict is the unclear hand-over a rethink ended in (item D's machinery). */
  withheld?: boolean;
  /** The turn's reason word when the engine, not the gate, decided it (`WRONG_TOPIC`). */
  turnReason?: string;
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
  // SCRUM-638: the operator's saved caps first — sparse and validated, so an
  // absent or invalid row leaves the native numbers; the global config is
  // never mutated. A zero cap still means zero.
  const saved = (await assistantSettingOverridesOf(db, turn.operatorId)).inbox;
  const dailyTurnCap = saved.dailyTurnCap ?? cfg.dailyTurnCap;
  const dailyTokenCap = saved.dailyTokenCap ?? cfg.dailyTokenCap;
  const usage = await todaysUsage(db, turn.operatorId, now);
  if (usage.turns >= dailyTurnCap || usage.tokens >= dailyTokenCap) {
    if (!usage.raised) await raiseGuard(db, turn, conv.branchId, 'CAP_DAILY');
    return { conv, silence: 'CAP_DAILY' };
  }
  // §D.4 guard 5.
  if (await circuitOpen(db, turn.operatorId, now)) return { conv, silence: 'CIRCUIT_OPEN' };

  const episode = await loadEpisode(db, conv, eligible.episodeStart);
  const burst = burstOf(episode, turn.triggerMessageId);
  // X8: a voice note, an image or a sticker with no words is a person's to pick up.
  if (burst.length === 0 || burst.every((m) => m.text === null)) return { conv, silence: 'NO_TEXT' };

  const knowledge = await loadTurnKnowledge(db, turn.operatorId, now);
  // SCRUM-220 playbook: the calling code of the number the customer writes
  // from (`66`, `7`), for the language and residency questions — given to the
  // model in its context AND to the gate, which checks the one language offer
  // against it.
  const [person] = await db
    .select({ phone: contact.phone })
    .from(contact)
    .where(and(eq(contact.operatorId, conv.operatorId), eq(contact.id, conv.contactId)))
    .limit(1);
  const contactCountryCode = callingCodeOf(person?.phone);
  const facts = await episodeFacts(db, conv, eligible.episodeStart, now, contactCountryCode);
  const promptInput: PromptInput = {
    knowledge: knowledge.knowledge,
    episode,
    context: {
      now,
      threadBranch: conv.branchId ? (knowledge.keyOfBranch.get(conv.branchId) ?? null) : null,
      priceModeToday: knowledge.priceModeToday,
      contactCountryCode,
      earlier: facts.earlier,
    },
  };
  const built = buildPrompt(promptInput);
  if (!built.ok) return { conv, silence: built.reason, kbVersion: knowledge.knowledge.version, knowledge };

  const client = deps.runtime.client;
  if (!client) return { conv, silence: 'NO_CLIENT', kbVersion: built.prompt.kbVersion, personaVersion: built.prompt.personaVersion };

  const outcome = await askModel(db, client, turn, conv, built.prompt);

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
  const quietBefore =
    verdict.action === 'silent' && verdict.reason === 'INTENT_SILENT'
      ? await quietBeforeBurst(db, conv, episode, turn.triggerMessageId, eligible.episodeStart, turn.id)
      : undefined;
  const decided: TurnResult = { ...base, decision: outcome.decision, verdict, ...(quietBefore === undefined ? {} : { quietBefore }) };
  // SCRUM-677: the coherence review, before anything is scheduled.
  const reviewed = await reviewStage(db, deps, turn, conv, account, episode, decided);
  const first: TurnResult & { conv: ConversationRow } = { ...withReview(decided, reviewed), conv };
  if (reviewed.state.kind !== 'wrong_topic') return first;
  // SCRUM-678: the reply answers something else; the turn is decided once more.
  return rethinkTurn({
    db,
    deps,
    turn,
    conv,
    account,
    episode,
    client,
    promptInput,
    episodeState: facts.state,
    first,
    topic: reviewed.state,
    now,
  });
}

/** One model call for a turn, recorded as its ops run. The client never throws; a throw is classified, never logged. */
async function askModel(db: Db, client: AssistantClient, turn: TurnRow, conv: ConversationRow, prompt: BuiltPrompt): Promise<AssistantOutcome> {
  const startedAt = new Date();
  let outcome: AssistantOutcome;
  try {
    outcome = await client.decide({ prompt });
  } catch (err) {
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
  return outcome;
}

/** A decided turn with its review: the review's state, its tokens and its time added to the turn's. */
function withReview(r: TurnResult, reviewed: { state: ReviewState; outcome: ReviewOutcome | null }): TurnResult {
  return {
    ...r,
    review: reviewed.state,
    usage: addUsage(r.usage, reviewed.outcome?.usage),
    latencyMs: (r.latencyMs ?? 0) + Math.max(0, Math.round(reviewed.outcome?.latencyMs ?? 0)),
  };
}

// --- 3b. The rethink (SCRUM-678) ------------------------------------------------------------

/** The word a claimed turn carries once its rethink began: a re-claim never rethinks twice. */
const RETHINK_MARK = 'RETHINK';

/** One round of a rethink, as the turn records it: words, never text. */
interface RoundRecord {
  intent: AiIntent | null;
  action: string | null;
  reason: string;
  /** What the reviewer said of the round's reply; null when it was not reviewed. */
  topic: 'answers' | 'wrong_topic' | null;
}

interface Rethink {
  why: 'WRONG_TOPIC';
  /** The reviewer's reading: text, so it is written only where message text lives (`writeShadowLine`), never on a record. */
  reading: string;
  suggestedIntent: AiIntent | null;
  rounds: RoundRecord[];
}

const roundOf = (v: GateVerdict, topic: RoundRecord['topic']): RoundRecord => ({ intent: v.intent, action: v.action, reason: v.reason, topic });

/** What a review said of a reply's topic, for the round's record. */
function topicOf(state: ReviewState): RoundRecord['topic'] {
  if (state.kind === 'wrong_topic') return 'wrong_topic';
  if (state.kind === 'reviewed' || (state.kind === 'ignored' && state.why !== 'NO_READING')) return 'answers';
  return null;
}

/**
 * The unclear hand-over a rethink ends in when it cannot send a reply (the
 * owner's item D machinery): the playbook's unclear line, the thread to its
 * park when it is known, else the GM; a number whose silence policy covers
 * the intent keeps true silence. Nothing the model wrote goes.
 */
function unclearAfterRethink(d: AiDecision, threadHasBranch: boolean): GateVerdict {
  const intents = intentPartsOf(d);
  const language = (AI_REPLY_LANGUAGES as readonly string[]).includes(d.language) ? (d.language as AiReplyLanguage) : 'en';
  return {
    action: 'handover',
    reason: 'OVERRULED_HANDOVER',
    intent: intents[0]!,
    intents,
    language,
    plan: resolvePlan(BY_BRANCH, threadHasBranch || d.branchNamed !== null),
    holdingBubbles: [],
    droppedHoldingRule: 'wrong_topic',
    branchNamed: d.branchNamed,
  };
}

/**
 * The turn's one claim on a rethink, in one statement: the turn still ours
 * (deciding, this attempt), marked so a re-claim after a lost lease never
 * rethinks again, and its lease renewed for the second round.
 */
async function markRethink(db: Db, turn: TurnRow, now: Date): Promise<boolean> {
  const at = new Date(Math.max(now.getTime(), Date.now()));
  const rows = await db
    .update(aiTurn)
    .set({ reason: RETHINK_MARK, leaseUntil: new Date(at.getTime() + AI_LEASE_MS), updatedAt: at })
    .where(
      and(
        eq(aiTurn.operatorId, turn.operatorId),
        eq(aiTurn.id, turn.id),
        eq(aiTurn.state, 'deciding'),
        eq(aiTurn.attempts, turn.attempts),
      ),
    )
    .returning({ id: aiTurn.id });
  return rows.length === 1;
}

/**
 * THE RETHINK: the reviewer read the reply as answering something else
 * (WRONG_TOPIC). It never rewrites: its operations are discarded and the turn
 * goes through the WHOLE pipeline once more — the prompt rebuilt with the
 * reviewer's reading beside the customer's words (`RethinkHint`), a fresh
 * decision, the gate and every guard, and the review again. HARD BOUND: one
 * rethink per burst. A second WRONG_TOPIC, a provider failure, or a second
 * pass that would say nothing ends in the unclear hand-over; a second reply
 * the gate withholds takes item D's own path. Never a third round.
 */
async function rethinkTurn(a: {
  db: Db;
  deps: AiEngineDeps;
  turn: TurnRow;
  conv: ConversationRow;
  account: AccountRow;
  episode: readonly EpisodeRow[];
  client: AssistantClient;
  promptInput: PromptInput;
  episodeState: EpisodeState;
  first: TurnResult & { conv: ConversationRow };
  topic: Extract<ReviewState, { kind: 'wrong_topic' }>;
  now: Date;
}): Promise<TurnResult & { conv: ConversationRow }> {
  const { first, topic } = a;
  const rethink: Rethink = {
    why: 'WRONG_TOPIC',
    reading: topic.reading,
    suggestedIntent: topic.suggestedIntent,
    rounds: [roundOf(first.verdict!, 'wrong_topic')],
  };
  const unclear = (r: TurnResult, round?: RoundRecord): TurnResult & { conv: ConversationRow } => ({
    ...r,
    conv: a.conv,
    verdict: unclearAfterRethink(r.decision ?? first.decision!, a.conv.branchId !== null),
    withheld: true,
    turnReason: 'WRONG_TOPIC',
    review: { kind: 'not_mixed' },
    rethink: { ...rethink, rounds: round ? [...rethink.rounds, round] : rethink.rounds },
  });
  if (a.turn.reason === RETHINK_MARK) return unclear(first);
  // No longer this claim's (a person acted, or the lease was lost): the commit finds it so and writes nothing.
  if (!(await markRethink(a.db, a.turn, a.now))) return first;
  const built = buildPrompt({ ...a.promptInput, rethink: { reading: topic.reading, suggestedIntent: topic.suggestedIntent } });
  if (!built.ok) return unclear(first, { intent: null, action: null, reason: built.reason, topic: null });
  const outcome = await askModel(a.db, a.client, a.turn, a.conv, built.prompt);
  const spent: TurnResult = {
    ...first,
    model: outcome.model ?? first.model ?? null,
    usage: addUsage(first.usage, outcome.usage),
    latencyMs: (first.latencyMs ?? 0) + Math.max(0, Math.round(outcome.latencyMs)),
  };
  if (!outcome.ok) return unclear(spent, { intent: null, action: null, reason: outcome.reason, topic: null });
  const verdict = applyGates({ decision: outcome.decision, grounding: built.prompt.grounding, episode: a.episodeState });
  // The first round's spam reading (`quietBefore`) is never read again: a second silence is the unclear line below.
  const second: TurnResult = { ...spent, decision: outcome.decision, verdict };
  // Silence the customer asked for nothing of is no answer to a rethought question.
  if (verdict.action === 'silent' && !WITHHELD_REPLY_REASONS.has(verdict.reason)) return unclear(second, roundOf(verdict, null));
  const reviewed = await reviewStage(a.db, a.deps, a.turn, a.conv, a.account, a.episode, second);
  const sent = withReview(second, reviewed);
  if (reviewed.state.kind === 'wrong_topic') return unclear(sent, roundOf(verdict, 'wrong_topic'));
  return { ...sent, conv: a.conv, rethink: { ...rethink, rounds: [...rethink.rounds, roundOf(verdict, topicOf(reviewed.state))] } };
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
async function usableTemplates(tx: Exec, conv: ConversationRow, account: AccountRow, key: string) {
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

type HoldingLine = {
  kind: 'template' | 'persona' | 'none';
  items: LineItem[];
  templateId: string | null;
  /** The destination's closing line that carried it (SCRUM-220 playbook); null when the intent's template or the model's words did. */
  closingKey: InboxTemplateKey | null;
  /** The template that carried it, whichever rung (SCRUM-677: the review's locks and record); null for the model's words. */
  templateKey: InboxTemplateKey | null;
};

const NO_LINE: HoldingLine = { kind: 'none', items: [], templateId: null, closingKey: null, templateKey: null };

/** A template's line VERBATIM in the customer's language: the most specific usable row, translated, with nothing left to fill. */
async function templateLine(
  tx: Exec,
  conv: ConversationRow,
  account: AccountRow,
  key: string,
  language: AiReplyLanguage,
): Promise<{ item: LineItem; templateId: string } | null> {
  const rows = (await usableTemplates(tx, conv, account, key)).filter((t) => t.language === language);
  const rank = (t: (typeof rows)[number]) => (t.channel ? 0 : 2) + (t.branchId ? 0 : 1);
  const row = rows.sort((a, b) => rank(a) - rank(b))[0];
  if (!row || row.needsTranslation) return null;
  const rendered = renderTemplate(row.body, {});
  if (rendered.missing.length > 0) return null;
  return { item: { body: rendered.text, templateId: row.id }, templateId: row.id };
}

/**
 * The line a hand-over closes with (SCRUM-220 playbook; §C.5, owner G6
 * default): the first usable of its closing keys (`closingKeysOf`) verbatim
 * in the customer's language — the unclear line for an unclear hand-over,
 * then the DESTINATION's: the birthday manager, the general manager, the
 * branch. Where none is usable (Marketing has none; a row may be missing,
 * inactive or untranslated in this language): the plan's own template (the
 * brochure's `handover_birthday`, the unclear `handover_general`), then the team-neutral
 * `handover_general` — since the playbook a plan carries its destination's
 * closing key, and the old per-topic lines name teams the playbook moved
 * (reception for a complaint, marketing for a collaboration). The model's own
 * checked holding words only where none of those is usable in the language;
 * and nothing when neither exists — the hand-over still happens, a person
 * owns the thread.
 */
async function closingLine(
  tx: Exec,
  conv: ConversationRow,
  account: AccountRow,
  closingKeys: readonly InboxTemplateKey[],
  plan: AiHandoverPlan,
  language: AiReplyLanguage,
  modelWords: readonly string[],
): Promise<HoldingLine> {
  for (const closingKey of closingKeys) {
    const line = await templateLine(tx, conv, account, closingKey, language);
    if (line) return { kind: 'template', items: [line.item], templateId: line.templateId, closingKey, templateKey: closingKey };
  }
  // A plan's own line (SCRUM-677) goes only through its rung, never as a fallback.
  const fallbacks = new Set<string>([plan.templateKey, 'handover_general']);
  for (const key of [...closingKeys, ...PLAN_CLOSING_KEYS]) fallbacks.delete(key);
  for (const key of fallbacks) {
    const line = await templateLine(tx, conv, account, key, language);
    if (line) return { kind: 'template', items: [line.item], templateId: line.templateId, closingKey: null, templateKey: key as InboxTemplateKey };
  }
  if (modelWords.length > 0) {
    return { kind: 'persona', items: modelWords.map((w) => ({ body: w })), templateId: null, closingKey: null, templateKey: null };
  }
  return NO_LINE;
}

/**
 * The birthday brochure (§C.5): the file(s) on the `handover_birthday`
 * template — the thread's park's when it has one, both parks' on a branchless
 * thread — one message per file, through the send path (media, rails R4).
 */
async function brochureFiles(tx: Exec, conv: ConversationRow, account: AccountRow, language: AiReplyLanguage): Promise<string[]> {
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
async function noPersonRouting(tx: Exec, conv: ConversationRow): Promise<boolean> {
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

async function teamFor(tx: Exec, operatorId: string, category: InboxCategory, branchId: string | null) {
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

/** The hand-over a verdict makes, as the engine reads it (SCRUM-220 playbook, `ai-destination.ts`). */
interface Handover {
  plan: AiHandoverPlan;
  /** The intent whose hand-over it is; null for the cap's, a second identity question's, the model's call. */
  owner: AiIntent | null;
  /**
   * The number's silence policy covers it: nothing is said — no answer, no
   * lead line, no closing line, no brochure — and the thread still routes.
   */
  silenced: boolean;
  /** A `silent_handover` the policy does not cover: a normal hand-over with the branch's closing line. */
  branchLine: boolean;
  /** The playbook's "Unclear or not covered" hand-over: its unclear line, whichever queue it goes to. */
  unclear: boolean;
}

function handoverOf(v: GateVerdict | undefined, silent: ReadonlySet<string> | null, withheld = false): Handover | null {
  if (!v || v.action === 'silent') return null;
  const plan = v.action === 'answer' ? v.thenHandover : v.plan;
  if (!plan) return null;
  const owner = planOwner(v.intents, plan);
  const silenced = silencedBy(silent, v.intents, owner, v.intent);
  const branchLine = v.action === 'silent_handover' && !silenced;
  // The model handing over on its own, or a reply the gate withheld (item D),
  // is the playbook's "Unclear or not covered" row.
  const byModel = withheld || (v.action === 'handover' && v.reason === 'MODEL_HANDOVER');
  return { plan, owner, silenced, branchLine, unclear: !branchLine && isUnclearHandover(v.intents, plan, byModel) };
}

/**
 * SCRUM-671, item D (owner ruling, 28 Oct 2026): a customer never gets pure
 * silence on a main channel. When the gate WITHHOLDS a reply the model wrote
 * (`WITHHELD_REPLY_REASONS`: a grounding refusal, a guard, or an unsure
 * model), the turn becomes
 * the "Unclear or not covered" hand-over: the playbook's unclear line, and the
 * thread to the park when it is known, else the GM. None of the withheld words
 * go (`holdingBubbles` empty). A number whose silence policy covers the
 * intent keeps true silence, as before. The turn keeps the gate's own reason
 * word (`commitTurn`), so a reviewer sees WHY the reply was held back.
 */
function withheldReplyFallback(
  v: GateVerdict | undefined,
  d: AiDecision | undefined,
  silent: ReadonlySet<string> | null,
  threadHasBranch: boolean,
): GateVerdict | null {
  if (!v || v.action !== 'silent' || !d || v.intent === null || !WITHHELD_REPLY_REASONS.has(v.reason)) return null;
  const intents = v.intents.length > 0 ? v.intents : [v.intent];
  if (silencedBy(silent, intents, null, v.intent)) return null;
  const language = (AI_REPLY_LANGUAGES as readonly string[]).includes(d.language) ? (d.language as AiReplyLanguage) : 'en';
  return {
    action: 'handover',
    reason: 'OVERRULED_HANDOVER',
    intent: v.intent,
    intents,
    language,
    plan: resolvePlan(BY_BRANCH, threadHasBranch || d.branchNamed !== null),
    holdingBubbles: [],
    droppedHoldingRule: v.rule ?? v.reason,
    branchNamed: d.branchNamed,
  };
}

/** The turn's reason word once the number's policy has been read. */
function handoverReason(h: Handover | null, reason: string): string {
  if (h?.silenced) return 'SILENCE_POLICY';
  if (h?.branchLine) return 'POLICY_MISSING';
  return reason;
}

/** What the routing will do, read before anything is written: the closing line names where the thread ends up. */
interface RoutingPlan {
  /** The park the customer named, for a branchless general thread. */
  branchSet: string | null;
  move: { dest: typeof team.$inferSelect; category: InboxCategory; branchId: string | null } | null;
  /** The thread's category once the routing is done. */
  category: InboxCategory;
}

/**
 * The branch the customer named, and the destination of the hand-over (§B.5,
 * and since SCRUM-220 the playbook's: `destinationOf`): a branchless general
 * thread takes the named park and that park's reception; a hand-over whose
 * destination differs from the thread's category moves it; a branch-desk plan
 * that names its own park (`plan.branch`: a nanny booking goes to Central
 * Floresta, the only park with the service) goes to that park's reception
 * whatever the thread's park — each only when no person has touched the
 * routing. Read-only; `executeRouting` writes it.
 */
async function planRouting(
  tx: Exec,
  conv: ConversationRow,
  branchNamed: AiBranchKey | null,
  handover: Handover | null,
  knowledge: TurnKnowledge | undefined,
): Promise<RoutingPlan> {
  const stay: RoutingPlan = { branchSet: null, move: null, category: conv.category };
  if (!(await noPersonRouting(tx, conv))) return stay;
  let branchId = conv.branchId;
  let branchSet: string | null = null;
  if (branchNamed && conv.category === 'general' && conv.branchId === null && knowledge) {
    const named = knowledge.branchOfKey.get(branchNamed) ?? null;
    if (named) {
      branchId = named;
      branchSet = named;
    }
  }
  const target: InboxCategory = handover
    ? destinationOf(handover.owner, handover.plan, { category: conv.category, branchKnown: branchId !== null })
    : conv.category;
  const planPark =
    target === 'general' && handover?.plan.branch && knowledge ? (knowledge.branchOfKey.get(handover.plan.branch) ?? null) : null;
  const destBranch = planPark ?? branchId;
  let move: RoutingPlan['move'] = null;
  if (target !== conv.category || branchSet || destBranch !== conv.branchId) {
    const dest = await teamFor(tx, conv.operatorId, target, destBranch);
    if (dest && dest.id !== conv.teamId) {
      move = { dest, category: target, branchId: dest.key === 'reception' ? dest.branchId : destBranch };
    }
  }
  return { branchSet, move, category: move ? move.category : conv.category };
}

/** The thread ends where the hand-over's plan sends it, so the plan's own closing line may go (SCRUM-677). */
function ownLineGoes(h: Handover, routing: RoutingPlan, conv: ConversationRow, knowledge: TurnKnowledge | undefined): boolean {
  if (!knowledge) return false;
  const endBranchId = routing.move ? routing.move.branchId : (routing.branchSet ?? conv.branchId);
  return planHonoured(h.plan, { category: routing.category, endBranchId }, knowledge.keyOfBranch);
}

async function executeRouting(tx: Tx, conv: ConversationRow, plan: RoutingPlan, at: Date): Promise<Routing> {
  const out: Routing = { branchSet: plan.branchSet, reroutedTeamId: null };
  if (plan.branchSet) {
    await tx
      .update(conversation)
      .set({ branchId: plan.branchSet, updatedAt: at })
      .where(and(eq(conversation.operatorId, conv.operatorId), eq(conversation.id, conv.id)));
    await tx.insert(inboxEvent).values({
      id: newId(),
      operatorId: conv.operatorId,
      conversationId: conv.id,
      kind: 'branch_set',
      actorKind: 'ai',
      payload: { fromBranchId: null, toBranchId: plan.branchSet, byAi: true },
      createdAt: at,
    });
  }
  if (plan.move) {
    out.reroutedTeamId = await aiMove(
      tx,
      { ...conv, branchId: plan.branchSet ?? conv.branchId },
      plan.move.dest,
      plan.move.category,
      plan.move.branchId,
      at,
    );
  }
  return out;
}

// --- The reply, composed and reviewed (SCRUM-677) -----------------------------------------------

/** One line of the reply as composed, with where it came from. */
interface OutLine extends LineItem {
  origin: ReviewOrigin;
  /** The template a fixed line came from; null for the model's words. */
  templateKey: InboxTemplateKey | null;
}

/** The reply a verdict makes on this thread, and everything the commit needs to send it. */
interface ComposedReply {
  /** The verdict the turn acts on: the gate's, or the unclear hand-over a withheld reply became (item D). */
  v: GateVerdict | undefined;
  fallback: boolean;
  handover: Handover | null;
  /** Where the thread ends up; null for a silent verdict, which routes nothing. */
  routing: RoutingPlan | null;
  replied: boolean;
  brochure: string[];
  holding: HoldingLine;
  lines: OutLine[];
}

/**
 * The reply, composed: the answer's bubbles (unless the number's policy
 * silences the hand-over), then the brochure and the closing line. READ-ONLY,
 * so the decide phase composes exactly what the commit will, with no
 * transaction open, for the review to read; the commit composes again under
 * the thread lock and sends that.
 */
async function composeReply(exec: Exec, conv: ConversationRow, account: AccountRow, r: TurnResult): Promise<ComposedReply> {
  const silentSet = silentIntentsOf(account.silencePolicy);
  const fallback = withheldReplyFallback(r.verdict, r.decision, silentSet, conv.branchId !== null);
  const v = fallback ?? r.verdict;
  // SCRUM-220 playbook: the hand-over this turn makes, with the number's
  // silence policy read (`ai-destination.ts`); a rethink's unclear hand-over
  // (SCRUM-678) is a withheld reply's.
  const handover = handoverOf(v, silentSet, fallback !== null || r.withheld === true);
  const none: ComposedReply = { v, fallback: fallback !== null, handover, routing: null, replied: false, brochure: [], holding: NO_LINE, lines: [] };
  if (!v || v.action === 'silent') return none;
  // Where the thread ends up is read first: the closing line names it.
  const routing = await planRouting(exec, { ...conv, intent: v.intent, language: v.language }, v.branchNamed, handover, r.knowledge);
  // A hand-over the number's policy silences says nothing at all, its
  // answer included (the nanny on Central's own number is the desk's).
  const replied = v.action === 'answer' && !handover?.silenced;
  const lines: OutLine[] = replied ? v.bubbles.map((b) => ({ body: b, origin: 'model', templateKey: null })) : [];
  let brochure: string[] = [];
  let holding: HoldingLine = NO_LINE;
  if (handover && !handover.silenced) {
    if (handover.plan.brochure) brochure = await brochureFiles(exec, conv, account, v.language);
    holding = await closingLine(
      exec,
      conv,
      account,
      closingKeysOf(handover, routing.category, ownLineGoes(handover, routing, conv, r.knowledge)),
      handover.plan,
      v.language,
      v.action === 'handover' ? v.holdingBubbles : [],
    );
    const fixed = holding.kind === 'template';
    const key = holding.templateKey;
    lines.push(
      ...brochure.map((f): OutLine => ({ body: null, mediaFileIds: [f], origin: 'template', templateKey: 'handover_birthday' })),
      ...holding.items.map((i): OutLine => ({ ...i, origin: fixed ? 'template' : 'model', templateKey: fixed ? key : null })),
    );
  }
  return { ...none, routing, replied, brochure, holding, lines };
}

/** What the decide phase's review left for the commit. */
type ReviewState =
  | { kind: 'off' }
  | { kind: 'none' }
  | { kind: 'not_mixed' }
  | { kind: 'failed'; reason: ProviderFailure }
  /** Not valid operations (`ReviewRefusal`), or a wrong topic with nothing read (`NO_READING`). */
  | { kind: 'ignored'; why: ReviewRefusal | 'NO_READING' }
  | { kind: 'reviewed'; fingerprint: string; applied: Extract<AppliedReview, { ok: true }> }
  /** SCRUM-678: the reply answers something else; never reaches the commit (the rethink resolves it). */
  | { kind: 'wrong_topic'; reading: string; suggestedIntent: AiIntent | null };

/**
 * What the turn's audit and timeline say the review did: ids, counts and
 * words, never a line's text. `dropped` names each removed item by its place,
 * its origin and the template it came from.
 */
type CoherenceRecord =
  | { state: 'skipped'; reason: 'SWITCHED_OFF' | 'NOT_MIXED' | 'NO_REVIEWER' }
  | { state: 'failed' | 'ignored'; reason: string; version: string }
  | { state: 'stale'; reason: 'CHANGED'; version: string }
  | {
      state: 'reviewed';
      version: string;
      items: number;
      sent: number;
      merged: number;
      dropped: Array<{ index: number; origin: ReviewOrigin; key: InboxTemplateKey | null }>;
    };

/** The composed lines as the review saw them: the commit applies its verdict only to this very reply. */
function fingerprintOf(lines: readonly OutLine[]): string {
  return JSON.stringify(lines.map((l) => [l.origin, l.body, l.templateId ?? null, l.mediaFileIds ?? [], l.templateKey]));
}

const reviewItemsOfLines = (lines: readonly OutLine[]) =>
  reviewItemsOf(lines.map((l) => ({ origin: l.origin, text: l.body, templateKey: l.templateKey })));

/**
 * THE REVIEW STAGE, in the decide phase with no transaction open: after the
 * gate, on a send that mixes the model's words and a fixed line, one call to
 * the reviewer within its cap (`@oto/assistant` review.ts). The operator's
 * switch is read fresh, like the caps. Never throws for the reviewer's
 * reasons and never blocks the reply: anything but valid operations leaves
 * the reply as composed.
 */
async function reviewStage(
  db: Db,
  deps: AiEngineDeps,
  turn: TurnRow,
  conv: ConversationRow,
  account: AccountRow,
  episode: readonly EpisodeRow[],
  r: TurnResult,
): Promise<{ state: ReviewState; outcome: ReviewOutcome | null }> {
  if ((await assistantSettingOverridesOf(db, turn.operatorId)).inbox.coherenceReview === false) return { state: { kind: 'off' }, outcome: null };
  const reviewer = deps.runtime.reviewer;
  if (!reviewer) return { state: { kind: 'none' }, outcome: null };
  const composed = await composeReply(db, conv, account, r);
  const items = reviewItemsOfLines(composed.lines);
  if (!composed.v || composed.v.action === 'silent' || !isMixedOrigin(items)) return { state: { kind: 'not_mixed' }, outcome: null };
  const startedAt = new Date();
  const outcome = await reviewWithDeadline(
    reviewer,
    { thread: episode.slice(-REVIEW_THREAD_LINES).map((m) => ({ from: m.from, text: m.text })), items, language: composed.v.language },
    deps.runtime.config.reviewTimeoutMs,
  );
  await recordReviewRun(db, turn, conv, outcome, startedAt);
  if (!outcome.ok) return { state: { kind: 'failed', reason: outcome.reason }, outcome };
  // SCRUM-678: a reply on the wrong topic discards the operations; the turn is decided again.
  const topic = readTopic(outcome.decision);
  if (topic.kind === 'invalid') return { state: { kind: 'ignored', why: 'NO_READING' }, outcome };
  if (topic.kind === 'wrong_topic') return { state: { kind: 'wrong_topic', reading: topic.reading, suggestedIntent: topic.suggestedIntent }, outcome };
  const applied = applyReview(items, outcome.decision);
  if (!applied.ok) return { state: { kind: 'ignored', why: applied.why }, outcome };
  return { state: { kind: 'reviewed', fingerprint: fingerprintOf(composed.lines), applied }, outcome };
}

/** One ops run per review call: ids, the outcome word, latency and tokens. Never a line. */
async function recordReviewRun(db: Db, turn: TurnRow, conv: ConversationRow, outcome: ReviewOutcome, startedAt: Date): Promise<void> {
  const reason = outcome.ok ? null : outcome.reason;
  await recordRun(db, {
    kind: 'adapter',
    name: 'adapter:inbox.ai.review',
    outcome: outcome.ok ? 'ok' : 'failed',
    startedAt,
    operatorId: turn.operatorId,
    branchId: conv.branchId,
    detail: {
      turnId: turn.id,
      conversationId: turn.conversationId,
      outcome: outcome.ok ? 'ok' : reason,
      version: REVIEW_VERSION,
      model: outcome.model,
      latencyMs: Math.max(0, Math.round(outcome.latencyMs)),
      inputTokens: outcome.usage?.inputTokens ?? null,
      outputTokens: outcome.usage?.outputTokens ?? null,
      providerRequestId: outcome.requestId,
      errorClass: outcome.ok ? null : (outcome.error?.errorClass ?? null),
      status: outcome.ok ? null : (outcome.error?.status ?? null),
    },
    ...(reason ? { error: opsError(reason) } : {}),
  });
}

/**
 * The commit's reading of the review: its operations over the lines the
 * commit composed — only when they are the very lines the reviewer saw
 * (else `stale`, sent as composed) — and the record the turn keeps.
 */
function settleReview(lines: readonly OutLine[], review: ReviewState | undefined): { lines: LineItem[]; record: CoherenceRecord | null } {
  if (lines.length === 0) return { lines: [], record: null };
  const as = (record: CoherenceRecord) => ({ lines: [...lines] as LineItem[], record });
  if (review?.kind === 'off') return as({ state: 'skipped', reason: 'SWITCHED_OFF' });
  if (!isMixedOrigin(reviewItemsOfLines(lines))) return as({ state: 'skipped', reason: 'NOT_MIXED' });
  if (!review || review.kind === 'none') return as({ state: 'skipped', reason: 'NO_REVIEWER' });
  if (review.kind === 'not_mixed') return as({ state: 'stale', reason: 'CHANGED', version: REVIEW_VERSION });
  if (review.kind === 'failed') return as({ state: 'failed', reason: review.reason, version: REVIEW_VERSION });
  if (review.kind === 'ignored') return as({ state: 'ignored', reason: review.why, version: REVIEW_VERSION });
  if (review.kind === 'wrong_topic') return as({ state: 'ignored', reason: 'WRONG_TOPIC', version: REVIEW_VERSION });
  if (fingerprintOf(lines) !== review.fingerprint) return as({ state: 'stale', reason: 'CHANGED', version: REVIEW_VERSION });
  const { groups, dropped, merged } = review.applied;
  const bodies = lines.map((l) => l.body);
  const out = groups.map((g): LineItem => {
    if (g.indices.length === 1) return lines[g.indices[0]!]!;
    // A merged line is its items' words joined, nothing added; no template
    // carried it verbatim, so it names none.
    const [body] = joinReviewed(bodies, [g]);
    return { body: body ?? null, templateId: null, mediaFileIds: [] };
  });
  return {
    lines: out,
    record: {
      state: 'reviewed',
      version: REVIEW_VERSION,
      items: lines.length,
      sent: out.length,
      merged,
      dropped: dropped.map((index) => ({ index, origin: lines[index]!.origin, key: lines[index]!.templateKey })),
    },
  };
}

/** SCRUM-678: a rethink as the turn's audit and timeline keep it — ids and words, never the reading. */
interface RethinkRecord {
  rethought: true;
  why: 'WRONG_TOPIC';
  suggestedIntent: AiIntent | null;
  /** The never-sent `shadow` row holding the reviewer's reading, for staff. */
  readingMessageId: string | null;
  /** How the turn ended: a reply, the unclear hand-over, or a silence the number's policy chose. */
  ended: 'reply' | 'unclear' | 'silent';
  rounds: RoundRecord[];
}

/**
 * The reviewer's reading is words about the customer's message, so it lives
 * where message text lives — one `shadow` message row (never sent, skipped by
 * the episode, reached by the erasure and the retention sweep), a moment
 * before the reply — and the record names it by id.
 */
async function rethinkRecordOf(tx: Tx, conv: ConversationRow, r: TurnResult, composed: ComposedReply, at: Date): Promise<RethinkRecord> {
  const rethink = r.rethink!;
  const readingMessageId = await writeShadowLine(tx, conv, 'en', [rethink.reading], new Date(at.getTime() - 1));
  const v = composed.v;
  const ended = !v || v.action === 'silent' || composed.handover?.silenced ? 'silent' : composed.fallback || r.withheld ? 'unclear' : 'reply';
  return { rethought: true, why: rethink.why, suggestedIntent: rethink.suggestedIntent, readingMessageId, ended, rounds: rethink.rounds };
}

/** Two calls' usage as the turn's: the daily token cap counts the review too. */
function addUsage(a: TurnUsage | null | undefined, b: TurnUsage | null | undefined): TurnUsage | null {
  if (!a && !b) return null;
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    cacheReadTokens: (a?.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0),
    cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + (b?.cacheWriteTokens ?? 0),
  };
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
  records: { coherence?: CoherenceRecord | null; rethink?: RethinkRecord | null } = {},
): Promise<void> {
  const v = r.verdict;
  const d = r.decision;
  const fields = {
    state,
    reason,
    intent: v?.intent ?? d?.intent ?? null,
    // A `silent_handover` (SCRUM-220 playbook) routes the thread, silently or
    // with the branch's line: it is a hand-over; the reason word says which.
    action: v ? (v.action === 'silent_handover' ? ('handover' as const) : v.action) : state === 'silent' ? ('silent' as const) : null,
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
      gate: v && v.action === 'silent' ? (v.rule ?? null) : v && v.action === 'handover' ? (v.droppedHoldingRule ?? null) : null,
      groundingKeys: v && v.action === 'answer' ? v.groundingKeys : [],
      // Every part the burst held (test night 2026-10-21, D1a): the turn row
      // keeps the primary in `intent`; the audit keeps them all.
      intents: v?.intents ?? d?.intents ?? null,
      cacheWriteTokens: r.usage?.cacheWriteTokens ?? null,
      // SCRUM-677: what the coherence review did to the reply; null when nothing was sent.
      coherence: records.coherence ?? null,
      // SCRUM-678: the turn was decided again, why, and both rounds; null when it was not.
      rethink: records.rethink ?? null,
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
      // A customer line newer than the trigger — by its time, then its id,
      // never by id alone (test night 2026-10-21, CR6: by id, a bubble the
      // provider stamped EARLIER but delivered later read as newer and
      // superseded the answer it was part of) — or a pending turn another
      // line opened while this one was deciding.
      const [newer] = (
        await tx.execute<{ newer: boolean }>(sql`
          select exists (
                   select 1 from inbox.message m
                     join inbox.message t on t.operator_id = m.operator_id and t.id = ${turn.triggerMessageId}
                    where m.operator_id = ${conv.operatorId} and m.conversation_id = ${conv.id}
                      and m.direction = 'inbound'
                      and (m.created_at, m.id) > (t.created_at, t.id))
              or exists (
                   select 1 from inbox.ai_turn p
                    where p.operator_id = ${conv.operatorId} and p.conversation_id = ${conv.id}
                      and p.state = 'pending' and p.id <> ${turn.id}) as newer`)
      ).rows;
      if (newer?.newer) {
        await closeTurn(tx, turn, conv, 'superseded', 'SUPERSEDED', r, at);
        return 'superseded';
      }

      const gated = r.verdict;
      // The gate's own word stays the turn's reason, also when a withheld
      // reply turns into the unclear hand-over (item D).
      const reason = r.silence ?? r.turnReason ?? (gated ? gated.reason : 'PROVIDER_ERROR');
      // The reply as the verdict composes it on the thread as it now stands
      // (SCRUM-677: the same composition the review read, read again under
      // the lock), and the review's operations over it when it still matches.
      const composed = await composeReply(tx, conv, account, r);
      const { v, handover } = composed;
      const turnResult: TurnResult = composed.fallback ? { ...r, verdict: v } : r;
      const finalReason = handoverReason(handover, reason);
      const settled = settleReview(composed.lines, r.review);
      // SCRUM-678: a rethought turn keeps the reviewer's reading for staff, and says how it ended.
      const rethink = r.rethink ? await rethinkRecordOf(tx, conv, r, composed, at) : null;
      const records = { coherence: settled.record, rethink };

      // SHADOW (§B.5): the decision on the turn, and nothing the customer
      // sees. Since the test night (2026-10-21, W5) what it WOULD have said —
      // the answer, and the closing line a hand-over would have sent — is kept
      // as one `shadow` message row for staff, named by an `ai_shadow` pill;
      // the thread's routing, intent, language and last-message fields stay
      // as they are. A silent decision keeps nothing: nothing would have gone;
      // nor does a hand-over the number's policy silences, answer and all.
      if (account.aiMode === 'shadow') {
        let messageIds: string[] = [];
        if (v && v.action !== 'silent') {
          const holding = composed.holding;
          const lines = settled.lines.flatMap((l) => (l.body ? [l.body] : []));
          const id = await writeShadowLine(tx, conv, v.language, lines, at);
          messageIds = id ? [id] : [];
          await tx.insert(inboxEvent).values(
            event(conv, 'ai_shadow', {
              turnId: turn.id,
              messageId: id,
              intent: v.intent,
              intents: v.intents,
              language: v.language,
              action: handover?.silenced ? 'silent_handover' : v.action === 'silent_handover' ? 'handover' : v.action,
              templateKey: handover?.plan.templateKey ?? null,
              closingKey: holding.closingKey,
              destination: handover ? (composed.routing?.category ?? null) : null,
              holdingLine: holding.kind,
              brochure: handover && !handover.silenced ? handover.plan.brochure : false,
              coherence: settled.record,
              rethink,
            }, at),
          );
        }
        await closeTurn(tx, turn, conv, 'shadowed', finalReason, turnResult, at, messageIds, records);
        return 'shadowed';
      }

      if (!v || v.action === 'silent') {
        // SCRUM-220 playbook, spam tidy: spam the model read — the burst all
        // `other`, in a language it reads — leaves the Unanswered queue,
        // handled by the assistant, unless an earlier line of the episode
        // still waits for a person. The thread and its lines stay as they are.
        const spam =
          v?.action === 'silent' &&
          v.reason === 'INTENT_SILENT' &&
          v.intents.every((i) => i === 'other') &&
          r.decision !== undefined &&
          (AI_REPLY_LANGUAGES as readonly string[]).includes(r.decision.language) &&
          r.quietBefore === true;
        const silentReason = spam ? 'SPAM_TIDIED' : reason;
        await tx.insert(inboxEvent).values(
          event(conv, 'ai_silent', { turnId: turn.id, reason: silentReason, intent: v?.intent ?? null, ...(rethink ? { rethink } : {}) }, at),
        );
        if (spam) await handleByAi(tx, conv, turn.id, at, 'SPAM');
        await closeTurn(tx, turn, conv, 'silent', silentReason, r, at, [], records);
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
      // Composed above, before anything was written; a non-silent verdict always has its routing read.
      const plan = composed.routing!;
      const { replied, brochure, holding } = composed;
      const items = settled.lines;
      // SCRUM-638: the operator's saved typing pace, the same fresh-read rule
      // as the caps; the document's two fields map onto the native ceilings.
      const pace = (await assistantSettingOverridesOf(tx, conv.operatorId)).inbox;
      const pacing = {
        firstBubbleMaxMs: pace.firstBubbleMs ?? deps.runtime.config.pacing.firstBubbleMaxMs,
        bubbleGapMaxMs: pace.bubbleGapMs ?? deps.runtime.config.pacing.bubbleGapMaxMs,
      };
      const messageIds = await writeLines(tx, conv, v.language, items, at, random, pacing);
      const routing = await executeRouting(tx, classified, plan, at);

      if (replied && v.action === 'answer') {
        await tx.insert(inboxEvent).values(
          event(conv, 'ai_replied', {
            turnId: turn.id,
            intent: v.intent,
            intents: v.intents,
            messageIds,
            askBranch: v.askBranch,
            brochureFileIds: brochure,
            // SCRUM-220 playbook: the one language offer, so the next turn's
            // gate refuses a second (`episodeFacts`).
            languageOffer: v.languageOffer,
            // SCRUM-677: what the coherence review removed or joined, by place and origin.
            coherence: settled.record,
            rethink,
          }, at),
        );
      }
      if (handover) {
        await tx.insert(inboxEvent).values(
          event(conv, 'ai_handover', {
            turnId: turn.id,
            intent: v.intent,
            intents: v.intents,
            reason: finalReason,
            // The rule that dropped the model's words, or withheld its reply (item D): WHY, for a reviewer.
            rule: v.action === 'handover' ? (v.droppedHoldingRule ?? null) : null,
            silent: handover.silenced,
            destination: plan.category,
            templateKey: handover.plan.templateKey,
            closingKey: holding.closingKey,
            holdingLine: holding.kind,
            templateId: holding.templateId,
            brochureFileIds: brochure,
            messageIds,
            reroutedTeamId: routing.reroutedTeamId,
            branchId: routing.branchSet,
            coherence: settled.record,
            rethink,
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
            silent: handover.silenced,
            destination: plan.category,
            templateKey: handover.plan.templateKey,
            closingKey: holding.closingKey,
            holdingLine: holding.kind,
            brochureFileIds: brochure,
            reroutedTeamId: routing.reroutedTeamId,
            branchId: routing.branchSet,
          },
        });
      }

      // X7 / owner G4 default: a closing on an episode no person touched is handled by the assistant.
      if (v.action === 'answer' && v.mayAutoHandle && !handover) await handleByAi(tx, conv, turn.id, at, null);

      const state = handover ? 'handed_over' : 'answered';
      await closeTurn(tx, turn, conv, state, finalReason, turnResult, at, messageIds, records);
      return state;
    },
  );
}

/**
 * The assistant marks the thread handled (X7 / owner G4: a closing on an
 * episode no person touched; SCRUM-220: spam it read). The customer's next
 * message reopens it as a new episode.
 */
async function handleByAi(tx: Tx, conv: ConversationRow, turnId: string, at: Date, why: 'SPAM' | null): Promise<void> {
  await tx
    .update(conversation)
    .set({ status: 'handled', handledAt: at, handledByKind: 'ai', handledByAccountId: null, updatedAt: at })
    .where(and(eq(conversation.operatorId, conv.operatorId), eq(conversation.id, conv.id)));
  await tx.insert(inboxEvent).values(event(conv, 'handled', { handledByKind: 'ai', turnId, ...(why ? { reason: why } : {}) }, at));
  await audit.record(tx, {
    actorAccountId: null,
    action: 'inbox.conversation.handle',
    entityType: 'inbox.conversation',
    entityId: conv.id,
    operatorId: conv.operatorId,
    branchId: conv.branchId,
    requestId: null,
    before: { status: 'active' },
    after: { status: 'handled', handledAt: at.toISOString(), handledByKind: 'ai', turnId, ...(why ? { reason: why } : {}) },
  });
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
