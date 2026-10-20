import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import {
  INTERNAL_LINES,
  buildInternalSystem,
  internalAnswerGuard,
  linkParams,
  type InternalAnswer,
  type InternalLanguage,
  type InternalLinkEntry,
  type ToolCallRequest,
  type ToolCallResult,
  type ToolLoopOutcome,
} from '@oto/assistant';
import { account, ask, branch, employee, toolCall, type AssistantStoredLink, type Db } from '@oto/db';
import {
  ASSISTANT_ASK_RETENTION_DAYS,
  ASSISTANT_ERROR_CODE,
  ASSISTANT_VERSION_WORD,
  SUITE_SCREENS,
  buildSuiteScreenPath,
  findSuiteScreen,
  isoDateInTz,
  newId,
  suiteScreenOffered,
  type AssistantAskCreate,
  type AssistantAskState,
  type AssistantRefusal,
  type Permission,
} from '@oto/shared';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { errors } from '../../lib/errors';
import type { AuthContext } from '../../plugins/session';
import { audit } from '../audit';
import { claimClientId, markReplay } from '../client-id';
import { holdsAnywhere } from '../inbox/read-visibility';
import { recordRun } from '../ops';
import type { EffectivePermission } from '../permissions';
import { withTx, type Exec, type OpContext } from '../tx';
import {
  OtoAppCallTimeout,
  OtoAppUnavailable,
  openOtoAppSession,
  otoAppEnvelope,
  type OtoAppIdentity,
  type OtoAppOpen,
  type OtoAppResponse,
  type OtoAppSession,
} from './call-otoapp';
import { PlatformCallTimeout, callPlatform, toolRequestId, type PlatformResponse } from './call-platform';
import { otoAppHandoff, type InternalAiRuntime } from './runtime';
import { PLATFORM_TOOLS, fitSummary, platformToolDefinitions, summaryBytes, type PlatformToolAdapter } from './tools';
import { OTOAPP_TOOLS, otoAppToolDefinitions, type OtoAppToolAdapter } from './tools-otoapp';
import { loadAskView, type AskRow } from './views';

/**
 * THE INTERNAL ASSISTANT'S ENGINE (SCRUM-591, round I2; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §D.1, §D.4, §E).
 *
 * One ask, synchronously, in the asker's own request:
 *
 *   1. A RESEND of the id is answered from the ask's own row (the route is
 *      `replaysByOwnId`: no second copy of the answer sits in the replay
 *      store); an id naming anybody else's ask is 409 ID_IN_USE.
 *   2. THE OPENING TRANSACTION, under the operator's advisory lock: the kill
 *      switch, a client to ask, the circuit breaker, the asks still in flight
 *      (a person's and the operator's), the person's and the operator's daily
 *      caps. Closed, the row is written in its final state (`off`, `capped`)
 *      with the server's fixed line, and NO model call is made. Open, the row
 *      is written in `asking` — before any model call, so a retry finds it —
 *      with `purge_after` set explicitly.
 *   3. THE LOOP, WITH NO TRANSACTION OPEN (the customer engine's pattern).
 *      Every tool call is the screen's own GET route run as the asker — in
 *      process for a platform tool (`call-platform.ts`); through the asker's
 *      own OTO App session, opened by a server-side hand-off on the first
 *      `oto.*` call and logged out in a `finally`, for an OTO App tool
 *      (`call-otoapp.ts`, round I4) — and its row and audit are written as it
 *      happens, each in its own short transaction. A 401/403/404/423 is a
 *      REFUSAL: the route's own message, verbatim, recorded and shown by the
 *      server; the model gets the envelope and nothing to ground a figure on.
 *      A 5xx, or an OTO App that gives no answer, closes the ask as TOOL_ERROR
 *      rather than letting the model guess.
 *   4. THE CLOSING TRANSACTION: the guards (`internalAnswerGuard`: URLs
 *      stripped, shape, every number and date word traced to THIS ask's
 *      summaries), the links resolved and filtered to what the asker may open,
 *      the refusals, the counts, and one `assistant.ask` audit row.
 *
 * NOTHING HERE WRITES TEXT OUTSIDE THE ASK ROW (§E.1). Audit and ops rows
 * carry ids, words, names of tools and counts; a thrown error is logged by
 * class only. The session token is a local of the request that asked.
 */

export const ASSISTANT_OPS_ADAPTER = 'adapter:assistant.ai';
/** §E.2 "the Phase 2 circuit breaker". */
export const ASSISTANT_CIRCUIT_FAILURES = 5;
export const ASSISTANT_CIRCUIT_PAUSE_MS = 10 * 60_000;
/** An `asking` row this far past the wall time is an ask whose process went away. */
export const ASSISTANT_ABANDON_GRACE_MS = 120_000;

/** The provider being down, as opposed to the model declining: what the breaker counts. */
const OUTAGE_REASONS = ['PROVIDER_TIMEOUT', 'PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_ERROR'] as const;
const isOutage = (reason: string | null | undefined) => (OUTAGE_REASONS as readonly string[]).includes(reason ?? '');

/** A tool result whose status is the route refusing the person (§D.4). */
const REFUSAL_STATUSES = new Set([401, 403, 404, 423]);

/** The lines the server shows for a closed gate. The model never writes these. */
export const ASSISTANT_GATE_LINES = {
  capPerson: {
    th: 'วันนี้คุณถามผู้ช่วยครบจำนวนแล้ว ลองใหม่พรุ่งนี้',
    en: 'You have reached today’s limit of questions to the assistant. Try again tomorrow.',
    ru: 'Вы исчерпали сегодняшний лимит вопросов ассистенту. Попробуйте завтра.',
  },
  capOperator: {
    th: 'ผู้ช่วยตอบครบจำนวนของวันนี้แล้ว ลองใหม่พรุ่งนี้',
    en: 'The assistant has reached today’s limit for the park. Try again tomorrow.',
    ru: 'Ассистент исчерпал сегодняшний лимит для парка. Попробуйте завтра.',
  },
  /** Too many asks still running — the asker's own or the park's (`INTERNAL_AI_CONCURRENT_*`). */
  busy: {
    th: 'ผู้ช่วยกำลังตอบคำถามอื่นอยู่ ลองใหม่อีกสักครู่',
    en: 'The assistant is busy with other questions right now. Try again in a moment.',
    ru: 'Ассистент сейчас занят другими вопросами. Попробуйте снова чуть позже.',
  },
} as const;

/** The asker's language before the model has said: the script the question is written in. */
export function questionLanguage(question: string): InternalLanguage {
  if (/[฀-๿]/.test(question)) return 'th';
  if (/[Ѐ-ӿ]/.test(question)) return 'ru';
  return 'en';
}

export interface AskDeps {
  app: FastifyInstance;
  db: Db;
  runtime: InternalAiRuntime;
  log?: FastifyBaseLogger;
}

export interface AskCaller {
  auth: AuthContext;
  effective: EffectivePermission[];
  /** The ask request's id: the audit rows' and every tool call's correlation. */
  requestId: string;
  /** The asker's own session token. Held for this request only. */
  token: string;
}

/** A database or SDK error's class name, never its message (which can echo values). */
function errorName(err: unknown): string {
  return err instanceof Error ? err.constructor.name || 'Error' : 'NonError';
}

/** An ops error that is one word. */
function opsError(word: string): Error {
  const e = new Error(`internal assistant ${word}`);
  e.name = word;
  return e;
}

/** A context for the engine's own transactions: never the replay claim (the route answers resends itself). */
function txCtx(caller: AskCaller, log?: FastifyBaseLogger): OpContext {
  return {
    requestId: caller.requestId,
    actorAccountId: caller.auth.accountId,
    operatorId: caller.auth.operatorId,
    branchId: caller.auth.branchId,
    ...(log ? { log } : {}),
  };
}

function bangkokDayStart(now: Date): string {
  return `${isoDateInTz(now, 'Asia/Bangkok')}T00:00:00+07:00`;
}

// --- The gate (§E.2) ----------------------------------------------------------------------

type GateLine = 'off' | 'capPerson' | 'capOperator' | 'busy';

type Gate =
  | { open: true }
  | { open: false; state: 'off' | 'capped'; reason: string; line: GateLine; raise: boolean };

interface DayUsage {
  personAsks: number;
  operatorAsks: number;
  tokens: number;
  raised: { person: boolean; asks: boolean; tokens: boolean; busy: boolean };
}

/** Today's (Bangkok) asks and tokens: asks that went to the model, not ones a gate closed. */
async function todaysUsage(db: Exec, auth: AuthContext, now: Date): Promise<DayUsage> {
  const dayStart = bangkokDayStart(now);
  const [row] = (
    await db.execute<{
      person_asks: number;
      operator_asks: number;
      tokens: string | number;
      raised_person: boolean | null;
      raised_asks: boolean | null;
      raised_tokens: boolean | null;
      raised_busy: boolean | null;
    }>(sql`
      select count(*) filter (where state not in ('off', 'capped') and account_id = ${auth.accountId})::int as person_asks,
             count(*) filter (where state not in ('off', 'capped'))::int as operator_asks,
             coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0) + coalesce(cache_read_tokens, 0)), 0) as tokens,
             bool_or(reason = 'CAP_PERSON' and account_id = ${auth.accountId}) as raised_person,
             bool_or(reason = 'CAP_DAILY') as raised_asks,
             bool_or(reason = 'CAP_TOKENS') as raised_tokens,
             bool_or(reason = 'BUSY') as raised_busy
        from assistant.ask
       where operator_id = ${auth.operatorId} and created_at >= ${dayStart}::timestamptz`)
  ).rows;
  return {
    personAsks: Number(row?.person_asks ?? 0),
    operatorAsks: Number(row?.operator_asks ?? 0),
    tokens: Number(row?.tokens ?? 0),
    raised: {
      person: Boolean(row?.raised_person),
      asks: Boolean(row?.raised_asks),
      tokens: Boolean(row?.raised_tokens),
      busy: Boolean(row?.raised_busy),
    },
  };
}

/**
 * The asks still running: `asking` rows young enough to be (an ask's loop
 * ends within `created_at` + the wall time; past the abandon grace the row is
 * a process that went away, closed by the purge or the next resend). Tokens
 * are counted only when a row closes, so this is the one bound on what is
 * open at once — per person and per operator.
 */
async function inFlight(db: Exec, auth: AuthContext, now: Date, windowMs: number): Promise<{ person: number; operator: number }> {
  const since = new Date(now.getTime() - windowMs).toISOString();
  const [row] = (
    await db.execute<{ person: number; operator: number }>(sql`
      select count(*) filter (where account_id = ${auth.accountId})::int as person,
             count(*)::int as operator
        from assistant.ask
       where operator_id = ${auth.operatorId} and state = 'asking' and created_at >= ${since}::timestamptz`)
  ).rows;
  return { person: Number(row?.person ?? 0), operator: Number(row?.operator ?? 0) };
}

/**
 * The operator's latest asks that reached the model, newest first by
 * `created_at`: the breaker's evidence. Keyed on when the ask was made, never
 * on `updated_at` — an ask's loop ends within `created_at` + the wall time,
 * and a later edit of the row (the asker rating it, which bumps `updated_at`)
 * must not move an old failure back into the window.
 */
async function recentModelAsks(db: Exec, operatorId: string, now: Date, n: number) {
  return db
    .select({ reason: ask.reason, at: ask.createdAt })
    .from(ask)
    .where(
      and(
        eq(ask.operatorId, operatorId),
        isNotNull(ask.personaVersion),
        gte(ask.createdAt, new Date(now.getTime() - 86_400_000)),
      ),
    )
    .orderBy(desc(ask.createdAt), desc(ask.id))
    .limit(n);
}

/** Five consecutive provider failures pause the assistant for ten minutes from the fifth's `created_at` (§E.2). */
export async function circuitOpen(db: Exec, operatorId: string, now: Date): Promise<boolean> {
  const asks = await recentModelAsks(db, operatorId, now, ASSISTANT_CIRCUIT_FAILURES);
  return (
    asks.length === ASSISTANT_CIRCUIT_FAILURES &&
    asks.every((a) => isOutage(a.reason)) &&
    now.getTime() - asks[0]!.at.getTime() < ASSISTANT_CIRCUIT_PAUSE_MS
  );
}

async function gateOf(tx: Exec, runtime: InternalAiRuntime, auth: AuthContext, now: Date): Promise<Gate> {
  const cfg = runtime.config;
  if (!cfg.enabled) return { open: false, state: 'off', reason: 'DISABLED', line: 'off', raise: false };
  if (!runtime.client) return { open: false, state: 'off', reason: 'NO_CLIENT', line: 'off', raise: false };
  if (await circuitOpen(tx, auth.operatorId, now)) {
    return { open: false, state: 'off', reason: 'CIRCUIT_OPEN', line: 'off', raise: false };
  }
  const usage = await todaysUsage(tx, auth, now);
  const open = await inFlight(tx, auth, now, cfg.wallMs + ASSISTANT_ABANDON_GRACE_MS);
  if (open.person >= cfg.concurrentPerPerson || open.operator >= cfg.concurrentPerOperator) {
    return { open: false, state: 'capped', reason: 'BUSY', line: 'busy', raise: !usage.raised.busy };
  }
  if (usage.personAsks >= cfg.personDailyCap) {
    return { open: false, state: 'capped', reason: 'CAP_PERSON', line: 'capPerson', raise: !usage.raised.person };
  }
  if (usage.operatorAsks >= cfg.dailyAskCap) {
    return { open: false, state: 'capped', reason: 'CAP_DAILY', line: 'capOperator', raise: !usage.raised.asks };
  }
  if (usage.tokens >= cfg.dailyTokenCap) {
    return { open: false, state: 'capped', reason: 'CAP_TOKENS', line: 'capOperator', raise: !usage.raised.tokens };
  }
  return { open: true };
}

function gateLine(line: GateLine, lang: InternalLanguage): string {
  return line === 'off' ? INTERNAL_LINES.off[lang] : ASSISTANT_GATE_LINES[line][lang];
}

/** One ops failure for a guard that just tripped (§E.2: "raised once"). */
async function raiseGuard(db: Db, caller: AskCaller, askId: string, word: string): Promise<void> {
  const at = new Date();
  await recordRun(db, {
    kind: 'adapter',
    name: ASSISTANT_OPS_ADAPTER,
    outcome: 'failed',
    startedAt: at,
    finishedAt: at,
    operatorId: caller.auth.operatorId,
    branchId: caller.auth.branchId,
    requestId: caller.requestId,
    detail: { askId, outcome: word },
    error: opsError(word),
  });
}

// --- Links (§C) ------------------------------------------------------------------------------

/** The link map as the model reads it: every screen's key, what it shows, its parameters. */
export function linkEntries(): InternalLinkEntry[] {
  return SUITE_SCREENS.map((s) => ({ key: s.key, shows: s.shows, params: s.params.map((p) => p.name) }));
}

/**
 * The model's links whose parameter VALUES this ask's own summaries contain
 * (§C, §E.4): an id no tool returned is dropped, as a figure no tool returned
 * would be. A path shape check alone lets a number dressed as a uuid through.
 * An enum value is the screen's fixed vocabulary (`tab=preview`), not data,
 * and passes; an empty optional value is skipped by the path builder and
 * passes too. Links the server gathered from the tools called are grounded
 * by construction and are not filtered here.
 */
export function groundedLinks(
  wanted: ReadonlyArray<{ key: string; params: Record<string, string> }>,
  groundingTexts: readonly string[],
): Array<{ key: string; params: Record<string, string> }> {
  const ground = groundingTexts.join('\n').toLowerCase();
  return wanted.filter((link) => {
    const screen = findSuiteScreen(link.key);
    if (!screen) return false;
    return Object.entries(link.params).every(([name, value]) => {
      const param = screen.params.find((p) => p.name === name);
      if (!param) return false;
      if (param.kind === 'enum' || value === '') return true;
      return ground.includes(value.toLowerCase());
    });
  });
}

/** What the link gate knows of the asker's OTO App side: their role and permission keys, once an ask opened a session. */
export type OtoAppViewer = Pick<OtoAppIdentity, 'role' | 'permissions'> | null;

/**
 * Keys with parameters, resolved: an unknown key, a bad parameter or a screen
 * the asker would not be let into is dropped (§C). An OTO App screen gated on
 * an OTO App role or permission is offered only when THIS ask opened the
 * asker's OTO App session (round I4) and the app said their role: a link is a
 * courtesy, never a guess.
 */
export function resolveLinks(
  wanted: ReadonlyArray<{ key: string; params: Record<string, string> }>,
  effective: EffectivePermission[],
  operatorId: string,
  otoApp: OtoAppViewer = null,
): AssistantStoredLink[] {
  const viewer = { has: (p: Permission) => holdsAnywhere(effective, p, operatorId), otoApp };
  const out: AssistantStoredLink[] = [];
  const seen = new Set<string>();
  for (const link of wanted) {
    const screen = findSuiteScreen(link.key);
    if (!screen) continue;
    const path = buildSuiteScreenPath(link.key, link.params);
    if (path === null) continue;
    if (!suiteScreenOffered(screen, viewer)) continue;
    const id = `${link.key}|${path}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ key: link.key, params: { ...link.params } });
    if (out.length >= 3) break;
  }
  return out;
}

// --- The executor (§B.2, §D.4) -------------------------------------------------------------

interface AskTrace {
  refusals: AssistantRefusal[];
  /** The screens the tools called would show, for an ask that ends short (§C). */
  gathered: Array<{ key: string; params: Record<string, string> }>;
  okCalls: number;
  recorded: number;
  /** The asker's OTO App role and permission keys, once this ask opened their session (the link gate). */
  otoApp: OtoAppViewer;
}

/**
 * The asker's OTO App session for ONE ask (§B.3): opened by the first `oto.*`
 * call, held for the rest, logged out by the engine's `finally`. A refusal at
 * the opening (no tile, `not_provisioned`, `disabled`, a dead session) is
 * remembered too: every later `oto.*` call of the ask gets the same refusal
 * and no second hand-off is minted.
 */
class OtoAppHolder {
  private opened: OtoAppOpen | null = null;
  constructor(private readonly open: (remainingMs: number) => Promise<OtoAppOpen>) {}

  async get(remainingMs: number): Promise<OtoAppOpen> {
    if (!this.opened) this.opened = await this.open(remainingMs);
    return this.opened;
  }

  /** Logs the app session out, if one was opened. Never throws. */
  async close(): Promise<void> {
    if (this.opened?.ok) await this.opened.session.close();
  }

  get isOpen(): boolean {
    return this.opened?.ok === true;
  }
}

/** The OTO App tools are offered when the switch is on, a hand-off to the app is configured, and the asker holds the tile. */
export function otoAppToolsOffered(runtime: InternalAiRuntime, caller: AskCaller): boolean {
  return (
    runtime.config.otoAppTools &&
    otoAppHandoff(runtime.config) !== null &&
    holdsAnywhere(caller.effective, 'app:oto_app:access', caller.auth.operatorId)
  );
}

/** Thrown by the executor on a 5xx: the loop closes the ask as TOOL_ERROR. */
class ToolServerError extends Error {
  constructor() {
    super('a tool route failed');
    this.name = 'ToolServerError';
  }
}

function envelopeOf(body: unknown): { code: string | null; message: string | null } {
  const err = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (!err || typeof err !== 'object') return { code: null, message: null };
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' && ASSISTANT_ERROR_CODE.test(e.code) ? e.code : null;
  return { code, message: typeof e.message === 'string' ? e.message : null };
}

/** The sentence a refusal shows when the route sent none (never invented: the status's own words). */
const STATUS_WORDS: Record<number, string> = {
  401: 'Not signed in',
  403: 'Not allowed',
  404: 'Not found',
  423: 'This session is locked — unlock to continue',
};

interface ToolRowInput {
  askId: string;
  seq: number;
  tool: string;
  system: 'platform' | 'oto_app';
  route: string;
  args: Record<string, unknown>;
  status: number | null;
  code: string | null;
  rows: number | null;
  bytes: number | null;
  truncated: boolean;
  latencyMs: number;
  requestId: string;
}

/** The tool call's row and its audit, in one short transaction, as it happens. */
async function recordToolCall(deps: AskDeps, caller: AskCaller, r: ToolRowInput): Promise<void> {
  await withTx(deps.db, txCtx(caller, deps.log), 'assistant.tool.call', async (tx) => {
    const id = newId();
    await tx.insert(toolCall).values({
      id,
      operatorId: caller.auth.operatorId,
      askId: r.askId,
      seq: r.seq,
      tool: r.tool,
      system: r.system,
      route: r.route,
      args: r.args,
      status: r.status,
      code: r.code,
      rows: r.rows,
      bytes: r.bytes,
      truncated: r.truncated,
      latencyMs: r.latencyMs,
    });
    // Ids and words: the route TEMPLATE, never the URL or its arguments (§E.1).
    await audit.record(tx, {
      actorAccountId: caller.auth.accountId,
      action: 'assistant.tool.call',
      entityType: 'assistant.tool_call',
      entityId: id,
      operatorId: caller.auth.operatorId,
      branchId: caller.auth.branchId,
      requestId: r.requestId,
      after: {
        askId: r.askId,
        seq: r.seq,
        tool: r.tool,
        system: r.system,
        route: r.route,
        status: r.status,
        code: r.code,
        rows: r.rows,
        bytes: r.bytes,
        truncated: r.truncated,
        latencyMs: r.latencyMs,
      },
    });
  });
}

/** The ask's remaining wall time at this instant, from the call's budget. */
const remainingOf = (deadline: number) => Math.max(0, deadline - Date.now());

interface ToolOutcome {
  bodies: unknown[];
  failed: { status: number; body: unknown; bytes: number } | null;
  outOfTime: boolean;
}

function executorFor(deps: AskDeps, caller: AskCaller, askId: string, trace: AskTrace, otoApp: OtoAppHolder, now: () => Date) {
  /** A row for a call that got no answer, by word: WALL_TIME, OTOAPP_UNAVAILABLE, INVALID_ARGUMENTS. */
  const recordNoAnswer = async (
    adapter: PlatformToolAdapter | OtoAppToolAdapter,
    system: 'platform' | 'oto_app',
    call: ToolCallRequest,
    args: Record<string, unknown>,
    code: string,
    status: number | null,
    latencyMs: number,
  ) => {
    await recordToolCall(deps, caller, {
      askId,
      seq: call.seq,
      tool: adapter.name,
      system,
      route: adapter.routes[0]!,
      args,
      status,
      code,
      rows: null,
      bytes: null,
      truncated: false,
      latencyMs,
      requestId: toolRequestId(caller.requestId, call.seq),
    });
    trace.recorded += 1;
  };

  /** Every part of a platform tool, in process (§B.2). */
  const runPlatform = async (adapter: PlatformToolAdapter, input: never, call: ToolCallRequest, deadline: number): Promise<ToolOutcome> => {
    const out: ToolOutcome = { bodies: [], failed: null, outOfTime: false };
    for (const [part, url] of adapter.urls(input).entries()) {
      let res: PlatformResponse;
      try {
        res = await callPlatform(deps.app, {
          token: caller.token,
          requestId: caller.requestId,
          seq: call.seq,
          part,
          url,
          routes: adapter.routes,
          timeoutMs: deadline - Date.now(),
        });
      } catch (err) {
        if (!(err instanceof PlatformCallTimeout)) throw err;
        out.outOfTime = true;
        break;
      }
      if (res.status < 200 || res.status >= 300) {
        out.failed = res;
        break;
      }
      out.bodies.push(res.body);
    }
    return out;
  };

  /**
   * Every part of an OTO App tool, through the asker's own app session (§B.3).
   * `unavailable` when the app gave no answer: the caller records
   * OTOAPP_UNAVAILABLE and closes the ask as TOOL_ERROR.
   */
  const runOtoApp = async (
    adapter: OtoAppToolAdapter,
    input: never,
    session: OtoAppSession,
    call: ToolCallRequest,
    deadline: number,
  ): Promise<ToolOutcome | { unavailable: number | null }> => {
    const out: ToolOutcome = { bodies: [], failed: null, outOfTime: false };
    for (const [part, url] of adapter.urls(input, session.identity).entries()) {
      let res: OtoAppResponse;
      try {
        res = await session.get({ url, routes: adapter.routes, seq: call.seq, part, remainingMs: remainingOf(deadline) });
      } catch (err) {
        if (err instanceof OtoAppCallTimeout) {
          out.outOfTime = true;
          break;
        }
        if (err instanceof OtoAppUnavailable) return { unavailable: err.status };
        throw err;
      }
      if (res.status < 200 || res.status >= 300) {
        out.failed = res;
        break;
      }
      out.bodies.push(res.body);
    }
    return out;
  };

  return async (call: ToolCallRequest): Promise<ToolCallResult> => {
    const platform = PLATFORM_TOOLS.get(call.name);
    const oto = platform ? undefined : OTOAPP_TOOLS.get(call.name);
    const adapter = platform ?? oto;
    // The loop only calls tools it was given; anything else is a programming error.
    if (!adapter) throw new TypeError('assistant: an executor call for a tool that is not registered');
    const system = platform ? 'platform' : 'oto_app';
    const route = adapter.routes[0]!;
    // The same id the tool's own request carried, so its log line and any denial audit row correlate.
    const toolReqId = toolRequestId(caller.requestId, call.seq);
    const parsed = adapter.input.safeParse(call.input ?? {});
    if (!parsed.success) {
      await recordNoAnswer(adapter, system, call, {}, 'INVALID_ARGUMENTS', null, 0);
      return {
        ok: false,
        data: { error: { code: 'INVALID_ARGUMENTS', message: 'The arguments do not match the tool’s schema.' } },
      };
    }
    const input = parsed.data as never;
    const args = parsed.data as Record<string, unknown>;
    const started = Date.now();
    // The ask's remaining wall time is this call's budget, shared by a tool's parts (§D.1 step 4).
    const deadline = started + call.remainingMs;

    let run: ToolOutcome;
    let who: OtoAppIdentity | null = null;
    if (platform) {
      run = await runPlatform(platform, input, call, deadline);
    } else {
      // The asker's OTO App session: opened on the first oto.* call of the ask, one per ask (§B.3).
      let opened: OtoAppOpen;
      try {
        opened = await otoApp.get(remainingOf(deadline));
      } catch (err) {
        if (err instanceof OtoAppCallTimeout) {
          await recordNoAnswer(adapter, system, call, args, 'WALL_TIME', null, Date.now() - started);
          return { ok: false, data: { error: { code: 'WALL_TIME', message: 'The question ran out of time before this answered.' } } };
        }
        if (err instanceof OtoAppUnavailable) {
          await recordNoAnswer(adapter, system, call, args, 'OTOAPP_UNAVAILABLE', err.status, Date.now() - started);
          throw new ToolServerError();
        }
        throw err;
      }
      if (!opened.ok) {
        // §D.4: the refusal that stopped the sign-on, verbatim — the platform's (no tile) or the app's.
        const r = opened.refusal;
        const message = r.message.slice(0, 500);
        await recordToolCall(deps, caller, {
          askId,
          seq: call.seq,
          tool: adapter.name,
          system,
          route,
          args,
          status: r.status,
          code: r.code,
          rows: null,
          bytes: null,
          truncated: false,
          latencyMs: Date.now() - started,
          requestId: toolReqId,
        });
        trace.recorded += 1;
        trace.refusals.push({ tool: adapter.name, system: r.system, status: r.status, code: r.code, message });
        return { ok: false, data: { error: { status: r.status, code: r.code, message } } };
      }
      who = opened.session.identity;
      trace.otoApp = { role: who.role, permissions: who.permissions };
      const got = await runOtoApp(oto!, input, opened.session, call, deadline);
      if ('unavailable' in got) {
        await recordNoAnswer(adapter, system, call, args, 'OTOAPP_UNAVAILABLE', got.unavailable, Date.now() - started);
        throw new ToolServerError();
      }
      run = got;
    }
    const latencyMs = Date.now() - started;

    if (run.outOfTime) {
      // The route outlasted the ask. Recorded as a call that got no answer; the loop, whose
      // clock has now passed the wall time, closes the ask as WALL_TIME before any further turn.
      await recordNoAnswer(adapter, system, call, args, 'WALL_TIME', null, latencyMs);
      return { ok: false, data: { error: { code: 'WALL_TIME', message: 'The question ran out of time before this answered.' } } };
    }

    if (run.failed) {
      const failed = run.failed;
      const { code, message } = platform ? envelopeOf(failed.body) : otoAppEnvelope(failed.body);
      await recordToolCall(deps, caller, {
        askId,
        seq: call.seq,
        tool: adapter.name,
        system,
        route,
        args,
        status: failed.status,
        code,
        rows: null,
        bytes: failed.bytes,
        truncated: false,
        latencyMs,
        requestId: toolReqId,
      });
      trace.recorded += 1;
      if (failed.status >= 500) throw new ToolServerError();
      const sentence = (message ?? STATUS_WORDS[failed.status] ?? 'Refused').slice(0, 500);
      if (REFUSAL_STATUSES.has(failed.status)) {
        // §D.4: the route's own sentence, verbatim. The server shows it; the model cannot reword it.
        trace.refusals.push({ tool: adapter.name, system, status: failed.status, code, message: sentence });
      }
      return { ok: false, data: { error: { status: failed.status, code, message: sentence } } };
    }

    const draft = platform ? platform.summarise(run.bodies, input, now()) : oto!.summarise(run.bodies, input, now(), who!);
    const summary = fitSummary(draft);
    await recordToolCall(deps, caller, {
      askId,
      seq: call.seq,
      tool: adapter.name,
      system,
      route,
      args,
      status: 200,
      code: null,
      rows: draft.rows,
      bytes: summaryBytes(summary),
      truncated: summary.truncated === true,
      latencyMs,
      requestId: toolReqId,
    });
    trace.recorded += 1;
    trace.okCalls += 1;
    const link = adapter.deepLink(input);
    if (link) trace.gathered.push(link);
    return { ok: true, data: summary };
  };
}

// --- The asker (§D.2 block 2) -----------------------------------------------------------------

async function askerOf(db: Db, caller: AskCaller) {
  const [row] = await db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(eq(account.id, caller.auth.accountId))
    .limit(1);
  const [seat] = caller.auth.branchId
    ? await db.select({ name: branch.name }).from(branch).where(eq(branch.id, caller.auth.branchId)).limit(1)
    : [];
  const tiles = [
    ...new Set(
      caller.effective
        .map((g) => /^app:([a-z_]+):access$/.exec(g.permission)?.[1])
        .filter((t): t is string => !!t),
    ),
  ];
  return {
    name: row?.nickname || row?.name || 'a colleague',
    seatBranch: seat?.name ?? null,
    tiles,
  };
}

// --- The ask ---------------------------------------------------------------------------------

/**
 * `POST /assistant/asks`. Answers the ask's row as it ends (or as it stands,
 * for a resend). Never throws for anything the model or a tool does.
 */
export async function askAssistant(deps: AskDeps, caller: AskCaller, input: AssistantAskCreate) {
  const { auth } = caller;
  const now = new Date();

  // 1. A resend of the same id is answered from the row; anybody else's id is refused.
  const claim = await claimClientId(
    input.id,
    async (id) => (await deps.db.select().from(ask).where(eq(ask.id, id)).limit(1))[0],
    (row) => row.operatorId === auth.operatorId && row.accountId === auth.accountId,
  );
  if (claim.replay) {
    let row = claim.row;
    if (row.state === 'asking') {
      const abandoned = now.getTime() - row.updatedAt.getTime() > deps.runtime.config.wallMs + ASSISTANT_ABANDON_GRACE_MS;
      if (!abandoned) {
        throw errors.conflict('ASK_IN_FLIGHT', 'This question is still being answered — ask for it again in a moment');
      }
      row = (await closeAbandoned(deps.db, row, caller.requestId)) ?? row;
    }
    return markReplay(await loadAskView(deps.db, row));
  }

  // 2. The opening transaction: the gate, and the row before any model call.
  const lang = questionLanguage(input.question);
  const opened = await withTx(deps.db, txCtx(caller, deps.log), 'assistant.ask.open', async (tx) => {
    // One ask at a time per operator through the gate, so a cap is exact.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`assistant.ask:${auth.operatorId}`}))`);
    const gate = await gateOf(tx, deps.runtime, auth, now);
    const purgeAfter = new Date(now.getTime() + ASSISTANT_ASK_RETENTION_DAYS * 86_400_000);
    const closed = !gate.open;
    const [row] = await tx
      .insert(ask)
      .values({
        id: claim.id,
        operatorId: auth.operatorId,
        accountId: auth.accountId,
        sessionId: auth.sessionId,
        branchId: auth.branchId,
        question: input.question,
        state: closed ? gate.state : 'asking',
        reason: closed ? gate.reason : null,
        answer: closed ? gateLine(gate.line, lang) : null,
        latencyMs: closed ? 0 : null,
        purgeAfter,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit.record(tx, {
      actorAccountId: auth.accountId,
      action: closed ? 'assistant.ask' : 'assistant.ask.open',
      entityType: 'assistant.ask',
      entityId: claim.id,
      operatorId: auth.operatorId,
      branchId: auth.branchId,
      requestId: caller.requestId,
      // Ids and words only: the question is in the ask row and nowhere else.
      after: closed
        ? { askId: claim.id, state: gate.state, reason: gate.reason, toolCalls: 0, questionLength: input.question.length }
        : { askId: claim.id, state: 'asking', questionLength: input.question.length },
    });
    return { row: row!, gate };
  });
  if (!opened.gate.open) {
    if (opened.gate.raise) await raiseGuard(deps.db, caller, opened.row.id, opened.gate.reason);
    return loadAskView(deps.db, opened.row);
  }

  // 3. The loop, with no transaction open.
  const client = deps.runtime.client!;
  const trace: AskTrace = { refusals: [], gathered: [], okCalls: 0, recorded: 0, otoApp: null };
  const asker = await askerOf(deps.db, caller);
  const built = buildInternalSystem({ links: linkEntries(), asker, now, answerMode: client.answerMode });
  // The OTO App tools are offered only when they can be served (§B.3, §E.2); the fence is still the app's.
  const offerOtoApp = otoAppToolsOffered(deps.runtime, caller);
  const otoApp = new OtoAppHolder((remainingMs) => {
    const target = otoAppHandoff(deps.runtime.config);
    // Offered only when configured (above); a switch flipped mid-ask is the app not answering.
    if (!target) throw new OtoAppUnavailable(null);
    return openOtoAppSession({
      db: deps.db,
      ctx: txCtx(caller, deps.log),
      handoff: target.handoff,
      auth,
      effective: caller.effective,
      token: caller.token,
      requestId: caller.requestId,
      askId: opened.row.id,
      timeoutMs: deps.runtime.config.otoAppTimeoutMs,
      remainingMs,
      log: deps.log,
    });
  });
  const started = new Date();
  let outcome: ToolLoopOutcome;
  try {
    outcome = await client.converse({
      system: built.system,
      question: input.question,
      tools: [...platformToolDefinitions(), ...(offerOtoApp ? otoAppToolDefinitions() : [])],
      execute: executorFor(deps, caller, opened.row.id, trace, otoApp, () => new Date()),
      maxToolCalls: deps.runtime.config.maxToolCalls,
      wallMs: deps.runtime.config.wallMs,
      answerMode: built.answerMode,
    });
  } catch (err) {
    // The client never throws by contract; a throw is classified by class, never logged with values.
    deps.log?.error({ askId: opened.row.id, error: errorName(err) }, 'the internal assistant loop threw');
    outcome = {
      ok: false,
      reason: 'PROVIDER_ERROR',
      error: { errorClass: errorName(err), status: null, requestId: null },
      usage: null,
      model: null,
      calls: [],
      groundingTexts: [],
      turns: 0,
      requestIds: [],
      latencyMs: Date.now() - started.getTime(),
    };
  } finally {
    // §B.3 step 4: the OTO App session lives for one ask — logged out however the loop ended,
    // a tool that threw included. The cookie goes with the closure.
    await otoApp.close();
  }
  await recordModelRun(deps.db, caller, opened.row.id, outcome, started, trace.recorded);

  // 4. The closing transaction.
  const closedRow = await closeAsk(deps, caller, opened.row, outcome, trace, built.personaVersion, lang, now);

  // §E.2: the provider failure that makes five in a row opens the breaker, raised once.
  if (!outcome.ok && isOutage(outcome.reason)) {
    const asks = await recentModelAsks(deps.db, auth.operatorId, new Date(), ASSISTANT_CIRCUIT_FAILURES + 1);
    const run = asks.findIndex((a) => !isOutage(a.reason));
    const consecutive = run === -1 ? asks.length : run;
    if (consecutive === ASSISTANT_CIRCUIT_FAILURES) await raiseGuard(deps.db, caller, opened.row.id, 'CIRCUIT_OPEN');
  }
  return loadAskView(deps.db, closedRow);
}

/** Every model call of the ask is one adapter run (§E.1): ids, outcome, turns, tokens — never text. */
async function recordModelRun(
  db: Db,
  caller: AskCaller,
  askId: string,
  outcome: ToolLoopOutcome,
  startedAt: Date,
  toolCalls: number,
): Promise<void> {
  const reason = outcome.ok ? null : outcome.reason;
  // The model bounded by the tool cap is the design working, not a fault.
  const failed = reason !== null && reason !== 'TOOL_CAP';
  await recordRun(db, {
    kind: 'adapter',
    name: ASSISTANT_OPS_ADAPTER,
    outcome: failed ? 'failed' : 'ok',
    startedAt,
    operatorId: caller.auth.operatorId,
    branchId: caller.auth.branchId,
    requestId: caller.requestId,
    detail: {
      askId,
      outcome: reason ?? 'ok',
      model: outcome.model,
      turns: outcome.turns,
      toolCalls,
      latencyMs: Math.max(0, Math.round(outcome.latencyMs)),
      inputTokens: outcome.usage?.inputTokens ?? null,
      outputTokens: outcome.usage?.outputTokens ?? null,
      cacheReadTokens: outcome.usage?.cacheReadTokens ?? null,
      cacheWriteTokens: outcome.usage?.cacheWriteTokens ?? null,
      providerRequestIds: outcome.requestIds,
      errorClass: outcome.ok ? null : (outcome.error?.errorClass ?? null),
      status: outcome.ok ? null : (outcome.error?.status ?? null),
    },
    ...(failed ? { error: opsError(reason) } : {}),
  });
}

interface Final {
  state: Exclude<AssistantAskState, 'asking' | 'off' | 'capped'>;
  reason: string | null;
  answer: string;
  links: AssistantStoredLink[];
  guardRule: string | null;
  urlsStripped: number;
}

function finalOf(
  outcome: ToolLoopOutcome,
  trace: AskTrace,
  caller: AskCaller,
  question: string,
  questionLang: InternalLanguage,
): Final {
  const gathered = resolveLinks(trace.gathered, caller.effective, caller.auth.operatorId, trace.otoApp);
  if (!outcome.ok) {
    const digging = outcome.reason === 'TOOL_CAP' || outcome.reason === 'WALL_TIME';
    const linked = gathered.length > 0;
    return {
      // "plus the best link" (§D.1 step 4); a provider failure shows no partial figure (Q11). With no
      // screen reached, the digging line stands as a sentence of its own and the ask is failed.
      state: digging && linked ? 'link_only' : 'failed',
      reason: outcome.reason,
      answer: digging
        ? (linked ? INTERNAL_LINES.tooMuchDigging : INTERNAL_LINES.tooMuchDiggingNoLink)[questionLang]
        : INTERNAL_LINES.failed[questionLang],
      links: gathered,
      guardRule: null,
      urlsStripped: 0,
    };
  }
  const answer: InternalAnswer = outcome.answer;
  const lang = answer.language;
  // A link's parameter is held to the same grounding as a figure: this ask's summaries.
  const wanted = groundedLinks(
    answer.links.map((l) => ({ key: l.key, params: linkParams(l) })),
    outcome.groundingTexts,
  );
  const modelLinks = resolveLinks(wanted, caller.effective, caller.auth.operatorId, trace.otoApp);
  // Grounding = the summaries THIS ask's tools returned, and the asker's own words (a number or a
  // month they typed may be echoed: it is their input). Never a refusal.
  const guard = internalAnswerGuard(answer, outcome.groundingTexts, question);
  if (!guard.ok) {
    // The links survive the guard (§C): the model's, grounded, and the screens the tools called show.
    const links = resolveLinks([...wanted, ...trace.gathered], caller.effective, caller.auth.operatorId, trace.otoApp);
    const linked = links.length > 0;
    return {
      // "The link plus the line": with no link the asker may open, the line stands as a sentence of its
      // own and the state follows the digging case above — link_only only when a link is there.
      state: linked ? 'link_only' : 'failed',
      reason: guard.reason,
      answer: (linked ? INTERNAL_LINES.guardFallback : INTERNAL_LINES.guardFallbackNoLink)[lang],
      links,
      guardRule: guard.rule,
      urlsStripped: guard.urlsStripped,
    };
  }
  const allRefused = trace.refusals.length > 0 && trace.okCalls === 0;
  return {
    state: allRefused ? 'refused' : 'answered',
    reason: allRefused ? 'TOOL_REFUSED' : null,
    answer: guard.answer.answer,
    links: modelLinks,
    guardRule: null,
    urlsStripped: guard.urlsStripped,
  };
}

async function closeAsk(
  deps: AskDeps,
  caller: AskCaller,
  row: AskRow,
  outcome: ToolLoopOutcome,
  trace: AskTrace,
  personaVersion: string,
  lang: InternalLanguage,
  askedAt: Date,
): Promise<AskRow> {
  const f = finalOf(outcome, trace, caller, row.question, lang);
  const at = new Date();
  // The row's CHECK (`ask_version_words_check`) takes one word. A provider's model id in any other
  // shape must not fail the close and strand the ask: the id asked for stands in.
  const model =
    [outcome.model, deps.runtime.client?.model, deps.runtime.config.model].find(
      (m): m is string => typeof m === 'string' && ASSISTANT_VERSION_WORD.test(m),
    ) ?? null;
  return withTx(deps.db, txCtx(caller, deps.log), 'assistant.ask.close', async (tx) => {
    const [closed] = await tx
      .update(ask)
      .set({
        state: f.state,
        reason: f.reason,
        answer: f.answer,
        links: f.links,
        refusals: trace.refusals,
        model,
        personaVersion,
        inputTokens: outcome.usage?.inputTokens ?? null,
        outputTokens: outcome.usage?.outputTokens ?? null,
        cacheReadTokens: outcome.usage?.cacheReadTokens ?? null,
        latencyMs: Math.max(0, at.getTime() - askedAt.getTime()),
        updatedAt: at,
      })
      .where(and(eq(ask.operatorId, row.operatorId), eq(ask.id, row.id), eq(ask.state, 'asking')))
      .returning();
    if (!closed) {
      // Closed elsewhere meanwhile (the purge's abandon sweep): answer it as it stands.
      const [now] = await tx.select().from(ask).where(eq(ask.id, row.id)).limit(1);
      return now ?? row;
    }
    await audit.record(tx, {
      actorAccountId: caller.auth.accountId,
      action: 'assistant.ask',
      entityType: 'assistant.ask',
      entityId: row.id,
      operatorId: caller.auth.operatorId,
      branchId: caller.auth.branchId,
      requestId: caller.requestId,
      before: { state: 'asking' },
      after: {
        askId: row.id,
        state: f.state,
        reason: f.reason,
        guardRule: f.guardRule,
        tools: outcome.calls.filter((c) => c.known).map((c) => c.name),
        toolCalls: outcome.calls.length,
        unknownToolCalls: outcome.calls.filter((c) => !c.known).length,
        refusals: trace.refusals.map((r) => ({ tool: r.tool, status: r.status, code: r.code })),
        links: f.links.map((l) => l.key),
        urlsStripped: f.urlsStripped,
        // Whether this ask signed the asker into the OTO App, and as which role: words, no id.
        otoApp: trace.otoApp ? { role: trace.otoApp.role } : null,
        turns: outcome.turns,
        model,
        personaVersion,
        inputTokens: outcome.usage?.inputTokens ?? null,
        outputTokens: outcome.usage?.outputTokens ?? null,
        cacheReadTokens: outcome.usage?.cacheReadTokens ?? null,
        answerLength: f.answer.length,
      },
    });
    return closed;
  });
}

/** An `asking` row whose request went away (a restart mid-ask): closed as failed, audited. */
export async function closeAbandoned(db: Db, row: AskRow, requestId: string | null): Promise<AskRow | null> {
  return withTx(db, { requestId: requestId ?? undefined, operatorId: row.operatorId }, 'assistant.ask.abandon', async (tx) => {
    const at = new Date();
    const [closed] = await tx
      .update(ask)
      .set({
        state: 'failed',
        reason: 'ABANDONED',
        answer: INTERNAL_LINES.failed[questionLanguage(row.question)],
        latencyMs: Math.max(0, at.getTime() - row.createdAt.getTime()),
        updatedAt: at,
      })
      .where(and(eq(ask.operatorId, row.operatorId), eq(ask.id, row.id), eq(ask.state, 'asking')))
      .returning();
    if (!closed) return null;
    await audit.record(tx, {
      actorAccountId: null,
      action: 'assistant.ask',
      entityType: 'assistant.ask',
      entityId: row.id,
      operatorId: row.operatorId,
      branchId: row.branchId,
      requestId,
      before: { state: 'asking' },
      after: { askId: row.id, state: 'failed', reason: 'ABANDONED' },
    });
    return closed;
  });
}
