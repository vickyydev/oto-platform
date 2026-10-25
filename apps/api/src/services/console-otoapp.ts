import type { Db } from '@oto/db';
import type { AuthContext } from '../plugins/session';
import { holdsAtOwnDepartment } from './access-control';
import { appAccessPermission, issueHandoffAudited, type HandoffConfig } from './handoff';
import { hasPermission, type EffectivePermission } from './permissions';
import type { OpContext } from './tx';

/** The Console uses the app's own session and rules; no app data is read here through SQL. */
interface ConsoleOtoAppInput {
  db: Db;
  ctx: OpContext;
  handoff: HandoffConfig;
  auth: AuthContext;
  effective: EffectivePermission[];
  /** The authenticated caller's platform session cookie, never returned or logged. */
  token: string;
  requestId: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Core branch selected by the already-authorized Console route, not an app branch. */
  branchId?: string;
}

interface AppResponse { status: number; body: unknown }
interface AppSession {
  get(path: string): Promise<AppResponse>;
  /** Attempted once. False means the app did not confirm logout. */
  close(): Promise<boolean>;
}

class ConsoleOtoAppError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super('The OTO App request could not be completed.');
    this.name = 'ConsoleOtoAppError';
  }
}

const unavailable = () => new ConsoleOtoAppError(503, 'OTO_APP_UNAVAILABLE');
const MAX_BODY_BYTES = 1024 * 1024;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LIVE = new RegExp(`^/api/timekeeping/live\\?branchId=${UUID}$`);
const REVIEW = new RegExp(`^/api/timekeeping/review\\?date=(\\d{4}-\\d{2}-\\d{2})&branchId=${UUID}$`);
const LEAVE = new RegExp(`^/api/time-off\\?branchId=${UUID}&dateFrom=(\\d{4}-\\d{2}-\\d{2})&dateTo=(\\d{4}-\\d{2}-\\d{2})$`);

function validDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Exact grammar keeps a fixed read capability from becoming a general app proxy. */
function allowedGet(path: string): boolean {
  if (path === '/api/user' || path === '/api/branches' || path === '/api/payroll/month-status') return true;
  if (LIVE.test(path)) return true;
  const review = REVIEW.exec(path);
  if (review) return validDate(review[1]!);
  const leave = LEAVE.exec(path);
  return !!leave && leave[1] === leave[2] && validDate(leave[1]!);
}

function bodyRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/**
 * Open one temporary app session as this exact platform caller. The root
 * summary service owns DTO reduction and branch/tenant mapping; the app owns
 * manager, salary, advisor and data access decisions. Only the audited mint,
 * existing app handoff and app logout are writes, with no business mutation.
 */
export async function openConsoleOtoApp(input: ConsoleOtoAppInput): Promise<AppSession> {
  const { auth } = input;
  const permission = appAccessPermission('oto_app');
  const targetBranch = input.branchId ?? auth.branchId ?? undefined;
  let departmentHeld: boolean;
  try {
    departmentHeld = await holdsAtOwnDepartment(input.db, input.effective, permission, auth.operatorId);
  } catch {
    throw unavailable();
  }
  if (!departmentHeld && !hasPermission(input.effective, permission, {
    operatorId: auth.operatorId, branchId: targetBranch,
  })) {
    throw new ConsoleOtoAppError(403, 'OTO_APP_FORBIDDEN');
  }

  const origin = input.handoff.origins.get('oto_app');
  if (!origin) throw new ConsoleOtoAppError(503, 'OTO_APP_NOT_CONFIGURED');
  try {
    const parsed = new URL(origin);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw unavailable();
  } catch {
    throw new ConsoleOtoAppError(503, 'OTO_APP_NOT_CONFIGURED');
  }
  if (!input.token) throw new ConsoleOtoAppError(401, 'OTO_APP_FORBIDDEN');
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 60_000) throw unavailable();

  // The audit seat remains the actual live session's, even when the selected
  // summary park differs. The normal exchange rechecks that live seat.
  let issued: { origin: string; token: string };
  try {
    issued = await issueHandoffAudited(input.db, input.ctx, input.handoff, {
      sessionId: auth.sessionId, accountId: auth.accountId, operatorId: auth.operatorId,
      branchId: auth.branchId, sessionToken: input.token, audience: 'oto_app',
      requestId: input.requestId, after: { purpose: 'console.staff_summary' },
    });
  } catch {
    throw unavailable();
  }
  if (issued.origin !== origin || !issued.token || issued.token.length > 8192) throw unavailable();

  const fetcher = input.fetch ?? fetch;
  let cookie: string | null = null;
  let closePromise: Promise<boolean> | null = null;

  const close = (): Promise<boolean> => {
    closePromise ??= (async () => {
      try {
        const response = await request('/api/logout', 'POST', '{}');
        return response.status === 200 && bodyRecord(response.body)?.ok === true;
      } catch {
        return false;
      } finally {
        cookie = null;
      }
    })();
    return closePromise;
  };

  async function request(path: string, method: 'GET' | 'POST', body?: string) {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(unavailable());
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      return await Promise.race([aborted, (async () => {
        const response = await fetcher(`${origin}${path}`, {
          method, redirect: 'manual', signal: controller.signal,
          headers: {
            accept: 'application/json', 'x-request-id': input.requestId,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(cookie ? { cookie } : {}),
          },
          ...(body === undefined ? {} : { body }),
        });
        if (path === '/api/auth/handoff') {
          // The server may already have opened a session even if its body is
          // malformed, oversized or stalls. Retain only its expected cookie
          // before body validation, so every acknowledged session can close.
          for (const header of response.headers.getSetCookie()) {
            const pair = header.split(';')[0]?.trim() ?? '';
            if (/^connect\.sid=[^\s;,]+$/.test(pair)) {
              cookie = pair;
              break;
            }
          }
        }
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable();
        }
        const declaredLength = response.headers.get('content-length');
        if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)) {
          void response.body?.cancel().catch(() => undefined);
          throw unavailable();
        }
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        if (response.body) {
          reader = response.body.getReader();
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BODY_BYTES) {
              void reader.cancel().catch(() => undefined);
              throw unavailable();
            }
            chunks.push(chunk.value);
          }
        }
        const text = Buffer.concat(chunks, bytes).toString('utf8');
        let parsedBody: unknown = null;
        try {
          parsedBody = text ? JSON.parse(text) : null;
        } catch {
          // Some native refusals use sendStatus (plain text). Keep their
          // status without retaining that text; malformed success is not data.
          if (response.status < 400 || response.status >= 500) throw unavailable();
        }
        return { status: response.status, body: parsedBody, headers: response.headers };
      })()]);
    } catch {
      void reader?.cancel().catch(() => undefined);
      // Fetch/JSON errors may contain a URL, cookie, response or private text.
      throw unavailable();
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', rejectAbort);
    }
  }

  try {
    const exchanged = await request('/api/auth/handoff', 'POST', JSON.stringify({ token: issued.token }));
    if (exchanged.status === 401 || exchanged.status === 403) {
      const reason = bodyRecord(exchanged.body)?.reason;
      throw new ConsoleOtoAppError(exchanged.status,
        reason === 'not_provisioned' ? 'OTO_APP_NOT_PROVISIONED' : 'OTO_APP_FORBIDDEN');
    }
    if (exchanged.status !== 200 || bodyRecord(exchanged.body)?.ok !== true || !cookie) throw unavailable();
  } catch (error) {
    if (cookie && !(await close())) throw unavailable();
    throw error;
  }

  try {
    const who = await request('/api/user', 'GET');
    if (who.status === 401 || who.status === 403) throw new ConsoleOtoAppError(who.status, 'OTO_APP_FORBIDDEN');
    if (who.status !== 200) throw unavailable();
    const user = bodyRecord(who.body);
    if (!user || user.platformUserId !== auth.accountId) throw new ConsoleOtoAppError(403, 'OTO_APP_IDENTITY_MISMATCH');
  } catch (error) {
    const confirmed = await close();
    if (!confirmed) throw unavailable();
    throw error;
  }

  return {
    async get(path) {
      if (closePromise) throw new ConsoleOtoAppError(503, 'OTO_APP_CLOSED');
      if (typeof path !== 'string' || !allowedGet(path)) throw new ConsoleOtoAppError(400, 'OTO_APP_INVALID_TARGET');
      const response = await request(path, 'GET');
      return { status: response.status, body: response.body };
    },
    close,
  };
}
