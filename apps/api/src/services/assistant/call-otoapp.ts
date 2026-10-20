import { ASSISTANT_ERROR_CODE, OTOAPP_ROLES, type OtoAppRole } from '@oto/shared';
import type { Db } from '@oto/db';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthContext } from '../../plugins/session';
import { branchScopeRefusal, holdsAtOwnDepartment } from '../access-control';
import { appAccessPermission, issueHandoffAudited, type HandoffConfig } from '../handoff';
import { hasPermission, type EffectivePermission } from '../permissions';
import type { OpContext } from '../tx';
import { matchesRoute, suffixedRequestId, toolRequestId, type GetRouteTemplate } from './call-platform';

/**
 * THE ONE HTTP HOP TO THE OTO APP (SCRUM-591, round I4; plan
 * docs/progress/plans/internal-assistant-build/PLAN.md §B.3, owner G1).
 *
 * The OTO App is a separate service with its own sessions and roles, and the
 * platform reaches it today only with service keys — exactly what the rule
 * forbids for the assistant. The one per-person seam is the suite hand-off,
 * and this file drives it SERVER SIDE, as the asker, for the length of one ask:
 *
 *   1. MINT. `issueHandoffAudited` — the same service `POST /auth/handoff`
 *      calls — mints an `oto_app` hand-off bound to the ASKER'S OWN session,
 *      after the same `app:oto_app:access` check the route makes (a department
 *      grant counts, as it does there). The `auth.handoff_issue` row carries
 *      the ask's request id and the ask's id. A person without the tile gets
 *      the launcher's own refusal, as a platform refusal line.
 *   2. EXCHANGE. The token is POSTed to the OTO App's existing
 *      `POST /api/auth/handoff`, at the origin the token was minted for (the
 *      `oto_app=` entry of HANDOFF_APP_ORIGINS — no second setting names the
 *      app), with NO Origin header: the app allows an Origin-less POST (a
 *      server) and refuses a foreign one. The app exchanges it at
 *      `/auth/handoff/exchange` itself, maps the account to its own user
 *      (`not_provisioned` or `disabled` otherwise, passed through verbatim as
 *      OTO App refusal lines) and answers its session cookie, `connect.sid`.
 *      One OTO App session per ask.
 *   3. CALL. Each tool is one of the app's existing GET routes, called with
 *      that cookie and an `x-request-id` the app adopts for its own log line.
 *      The app's fences answer: `requireAuth`, `requireManager`, the park
 *      group, the branch, `hr.view_salary` — and its liveness middleware asks
 *      the platform `GET /me` with the person's own token on every call, so a
 *      platform session revoked mid-ask is refused at the next call. The URL
 *      comes from a tool adapter and must match the tool's declared route
 *      templates, exactly as `call-platform.ts` requires.
 *   4. LOGOUT. `close()` POSTs the app's `POST /api/logout`, which ends only
 *      the app's session and never the platform one. The engine calls it in a
 *      `finally`, so it runs when a tool throws and when the ask ends short.
 *
 * THE RULES OF THIS FILE, each pinned by `assistant-otoapp.test.ts`:
 *   - It is the only assistant file that calls `fetch` (the census).
 *   - Tool calls are GET; the only POSTs are the exchange and the logout, and
 *     both are literals here.
 *   - The hand-off token and the app's cookie live in closures of one ask.
 *     They are never logged, stored, returned on a summary or put on a row;
 *     a failure is recorded by class and status only.
 *   - Every call is bounded: the app's per-call limit
 *     (`OTOAPP_DIRECTORY_TIMEOUT_MS`), and the ask's remaining wall time.
 */

/** The OTO App's session cookie (`apps/oto-app/server/auth.ts`). */
export const OTOAPP_SESSION_COOKIE = 'connect.sid';

/** The app's own roles that `hr.view_salary` reaches (`apps/oto-app/shared/hr-salary-permission.ts`: an admin-only action). */
const SALARY_ROLES: ReadonlySet<OtoAppRole> = new Set<OtoAppRole>(['admin', 'operator_admin', 'global_admin']);

export interface OtoAppResponse {
  status: number;
  /** The parsed JSON body, or null when it was not JSON. */
  body: unknown;
  bytes: number;
}

/** A refusal before any tool ran: the platform's (no tile) or the app's (no user, disabled, a dead session). */
export interface OtoAppRefusal {
  system: 'platform' | 'oto_app';
  status: number;
  code: string | null;
  message: string;
}

/** The app gave no usable answer (no connection, a timeout short of the wall time, a 5xx): a tool error, never a guess. */
export class OtoAppUnavailable extends Error {
  constructor(readonly status: number | null) {
    super('the OTO App did not answer');
    this.name = 'OtoAppUnavailable';
  }
}

/** The app did not answer within the ask's remaining wall time. */
export class OtoAppCallTimeout extends Error {
  constructor() {
    super('the OTO App did not answer within the ask’s wall time');
    this.name = 'OtoAppCallTimeout';
  }
}

/** Who the app signed on: what the link gate and the adapters read. No credential. */
export interface OtoAppIdentity {
  userId: string;
  role: OtoAppRole;
  /** The app's permission keys the role carries that the link map gates on. */
  permissions: readonly string[];
  /** The one park the asker's access names, when it names exactly one. */
  homeBranchId: string | null;
  allBranches: boolean;
}

export interface OtoAppCall {
  /** Built by the adapter from validated input. */
  url: string;
  routes: readonly GetRouteTemplate[];
  seq: number;
  part?: number;
  /** The ask's remaining wall time; the per-call limit applies as well. */
  remainingMs: number;
}

export interface OtoAppSession {
  readonly origin: string;
  readonly identity: OtoAppIdentity;
  get(call: OtoAppCall): Promise<OtoAppResponse>;
  /** Logs the app session out. Never throws; a second call does nothing. */
  close(): Promise<void>;
  /** Whether `close` has run (for the engine's record). */
  readonly closed: boolean;
}

export type OtoAppOpen = { ok: true; session: OtoAppSession } | { ok: false; refusal: OtoAppRefusal };

export interface OpenOtoAppSessionInput {
  db: Db;
  ctx: OpContext;
  handoff: HandoffConfig;
  auth: AuthContext;
  effective: EffectivePermission[];
  /** The asker's own platform session token (the ask request's cookie). */
  token: string;
  /** The ask's request id: the mint's audit row and every call's `x-request-id` derive from it. */
  requestId: string;
  askId: string;
  /** The per-call limit (`OTOAPP_DIRECTORY_TIMEOUT_MS`). */
  timeoutMs: number;
  /** The ask's remaining wall time at the first OTO App tool call. */
  remainingMs: number;
  log?: FastifyBaseLogger | undefined;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The app's refusal envelope: `{reason, message}` on the hand-off, `{message}` on most routes, `{error}` on `requireRole`. */
export function otoAppEnvelope(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== 'object') return { code: null, message: null };
  const b = body as { reason?: unknown; message?: unknown; error?: unknown };
  const reason = str(b.reason);
  const message = str(b.message) ?? str(b.error);
  return {
    code: reason && ASSISTANT_ERROR_CODE.test(reason) ? reason : null,
    message,
  };
}

/** The `connect.sid=…` pair out of the exchange's Set-Cookie headers, as the browser would send it back. */
export function sessionCookieOf(setCookies: readonly string[]): string | null {
  for (const header of setCookies) {
    const pair = header.split(';')[0]?.trim() ?? '';
    if (pair.startsWith(`${OTOAPP_SESSION_COOKIE}=`) && pair.length > OTOAPP_SESSION_COOKIE.length + 1) return pair;
  }
  return null;
}

/** The app's `/api/user` body as the identity the link gate reads; a role the map does not know counts as staff. */
export function identityOf(body: unknown): OtoAppIdentity | null {
  if (!body || typeof body !== 'object') return null;
  const u = body as { id?: unknown; role?: unknown; hasAllBranchesAccess?: unknown; allowedBranchIds?: unknown };
  const userId = str(u.id);
  if (!userId) return null;
  const rawRole = str(u.role);
  const role: OtoAppRole = (OTOAPP_ROLES as readonly string[]).includes(rawRole ?? '') ? (rawRole as OtoAppRole) : 'staff';
  const allBranches = u.hasAllBranchesAccess === true;
  const allowed = Array.isArray(u.allowedBranchIds) ? u.allowedBranchIds.filter((b): b is string => typeof b === 'string') : [];
  return {
    userId,
    role,
    permissions: SALARY_ROLES.has(role) ? ['hr.view_salary'] : [],
    homeBranchId: !allBranches && allowed.length === 1 ? allowed[0]! : null,
    allBranches,
  };
}

interface Fetched {
  status: number;
  body: unknown;
  bytes: number;
  setCookies: string[];
}

/**
 * One request to the app, bounded by `timeoutMs`. Throws `OtoAppCallTimeout`
 * when the bound was the ask's wall time and it passed; `OtoAppUnavailable`
 * when the app could not be reached or did not answer within its own limit.
 */
async function request(
  origin: string,
  path: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  bound: { timeoutMs: number; wallMs: number | null },
): Promise<Fetched> {
  const ms = bound.wallMs === null ? bound.timeoutMs : Math.min(bound.timeoutMs, bound.wallMs);
  let res: Response;
  try {
    res = await fetch(`${origin}${path}`, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(Math.max(0, ms)),
      redirect: 'manual',
    });
  } catch {
    // Nothing of the thrown value is read: an undici error can carry the URL and headers.
    if (bound.wallMs !== null && bound.wallMs <= bound.timeoutMs) throw new OtoAppCallTimeout();
    throw new OtoAppUnavailable(null);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return { status: res.status, body, bytes: Buffer.byteLength(text, 'utf8'), setCookies };
}

const JSON_HEADERS = { accept: 'application/json' } as const;

/**
 * Opens the asker's OTO App session for this ask (steps 1 and 2), or answers
 * the refusal that stopped it. Throws `OtoAppUnavailable` / `OtoAppCallTimeout`
 * when the app gave no answer: the engine closes the ask as TOOL_ERROR or
 * WALL_TIME, never with a guess.
 */
export async function openOtoAppSession(input: OpenOtoAppSessionInput): Promise<OtoAppOpen> {
  const { auth, db } = input;
  const permission = appAccessPermission('oto_app');

  // 1. The tile, checked as POST /auth/handoff checks it: a department grant, else the seat.
  const held =
    (await holdsAtOwnDepartment(db, input.effective, permission, auth.operatorId)) ||
    hasPermission(input.effective, permission, { operatorId: auth.operatorId, branchId: auth.branchId ?? undefined });
  if (!held) {
    const elsewhere = auth.branchId
      ? await branchScopeRefusal(db, input.effective, permission, auth.operatorId, auth.branchId)
      : null;
    return {
      ok: false,
      refusal: {
        system: 'platform',
        status: 403,
        code: elsewhere?.code ?? 'FORBIDDEN',
        message: elsewhere?.message ?? `Missing permission ${permission}`,
      },
    };
  }
  const issued = await issueHandoffAudited(db, input.ctx, input.handoff, {
    sessionId: auth.sessionId,
    accountId: auth.accountId,
    operatorId: auth.operatorId,
    branchId: auth.branchId,
    sessionToken: input.token,
    audience: 'oto_app',
    requestId: input.requestId,
    after: { askId: input.askId },
  });
  const origin = issued.origin;

  // 2. The exchange, at the origin the token was minted for, with no Origin header (a server's POST).
  const exchanged = await request(
    origin,
    '/api/auth/handoff',
    {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'content-type': 'application/json', 'x-request-id': suffixedRequestId(input.requestId, '.h') },
      body: JSON.stringify({ token: issued.token }),
    },
    { timeoutMs: input.timeoutMs, wallMs: input.remainingMs },
  );
  if (exchanged.status === 401 || exchanged.status === 403) {
    const { code, message } = otoAppEnvelope(exchanged.body);
    return {
      ok: false,
      refusal: { system: 'oto_app', status: exchanged.status, code, message: (message ?? 'The OTO App refused the sign-in').slice(0, 500) },
    };
  }
  if (exchanged.status !== 200) throw new OtoAppUnavailable(exchanged.status);
  const cookie = sessionCookieOf(exchanged.setCookies);
  // Signed in with no session to hold: nothing to call with, and nothing to log out.
  if (!cookie) throw new OtoAppUnavailable(exchanged.status);

  let closed = false;
  const headersFor = (requestId: string): Record<string, string> => ({ ...JSON_HEADERS, cookie, 'x-request-id': requestId });

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      const res = await request(
        origin,
        '/api/logout',
        { method: 'POST', headers: { ...headersFor(suffixedRequestId(input.requestId, '.x')), 'content-type': 'application/json' }, body: '{}' },
        { timeoutMs: input.timeoutMs, wallMs: null },
      );
      if (res.status !== 200) input.log?.warn({ status: res.status }, 'the OTO App session was not logged out');
    } catch (err) {
      input.log?.warn({ error: err instanceof Error ? err.name : 'NonError' }, 'the OTO App session was not logged out');
    }
  };

  // Who the app signed on: the role and park the link gate and the adapters read.
  let who: Fetched;
  try {
    who = await request(
      origin,
      '/api/user',
      { method: 'GET', headers: headersFor(suffixedRequestId(input.requestId, '.u')) },
      { timeoutMs: input.timeoutMs, wallMs: input.remainingMs },
    );
  } catch (err) {
    await close();
    throw err;
  }
  if (who.status === 401 || who.status === 403) {
    // The app's liveness check found the platform session gone between the exchange and now.
    await close();
    const { code, message } = otoAppEnvelope(who.body);
    return { ok: false, refusal: { system: 'oto_app', status: who.status, code, message: (message ?? 'Not signed in').slice(0, 500) } };
  }
  const identity = who.status === 200 ? identityOf(who.body) : null;
  if (!identity) {
    await close();
    throw new OtoAppUnavailable(who.status);
  }

  const session: OtoAppSession = {
    origin,
    identity,
    get closed() {
      return closed;
    },
    async get(call) {
      if (closed) throw new OtoAppUnavailable(null);
      if (!call.url.startsWith('/') || call.url.startsWith('//') || call.url.includes('://')) {
        throw new TypeError('assistant OTO App call: the URL is not a path on the app');
      }
      if (!call.routes.some((r) => matchesRoute(call.url, r))) {
        throw new TypeError('assistant OTO App call: the URL is not one of the tool’s declared routes');
      }
      const res = await request(
        origin,
        call.url,
        { method: 'GET', headers: headersFor(toolRequestId(input.requestId, call.seq, call.part ?? 0)) },
        { timeoutMs: input.timeoutMs, wallMs: call.remainingMs },
      );
      return { status: res.status, body: res.body, bytes: res.bytes };
    },
    close,
  };
  return { ok: true, session };
}
