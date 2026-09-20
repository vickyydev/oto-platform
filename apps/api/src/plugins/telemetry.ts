import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors';
import { recordRun, type RecordRunInput } from '../services/ops';

/**
 * One line per request, and the seam every failure leaves through (S2-03).
 *
 * Sprint 1 logged Fastify's own request/response pair, which carried the full
 * URL — and the URL carries phone numbers. S2-01a replaced it with a single
 * scrubbed completion line in `app.ts`. This plugin takes that line over and
 * gives it what the ticket asks for: the route PATTERN as well as the path, so
 * a hundred lookups of a hundred different members group under
 * `/members/:id` instead of scattering; the account and branch acting; whether
 * the answer was an idempotent replay rather than work; and the correlation
 * ids a request arrived with, so one id follows a sale from the till, through
 * here, to the box and back.
 *
 * What never appears: a body, a token, a query string. Everything personal in
 * an HTTP request to this API is in one of those three.
 */

/** W3C trace context: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`. */
const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * An action id groups the several requests one gesture at the till makes. It
 * is echoed into log lines, so it is accepted only in a shape that cannot
 * forge a log entry or smuggle a header — the same rule as `x-request-id`.
 */
const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Above this, a request carries `slow: true`. It is deliberately a flag on
 * the ordinary line rather than a second line: the interesting question is
 * "which route is slow", and that is only answerable if the slow requests sit
 * in the same stream as the fast ones.
 */
const DEFAULT_SLOW_REQUEST_MS = 1000;

interface TelemetryContext {
  /** The error that reached the error handler, kept for the ops_run detail. */
  error?: unknown;
  errorCode?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    telemetry: TelemetryContext | null;
  }
}

export interface TelemetryOptions {
  /** Defaults to `SLOW_REQUEST_MS`, then to one second. */
  slowRequestMs?: number;
}

/**
 * Write the run, and never let recording a failure become one. An `ops_run`
 * insert that fails — a migration not yet applied, the database gone — is a
 * reason to log, not a reason to turn a 500 into a different 500 or to take
 * the process down while it is trying to say why.
 */
export async function recordFailedRun(app: FastifyInstance, run: RecordRunInput): Promise<void> {
  try {
    await recordRun(app.db, run);
  } catch (err) {
    app.log.error({ err, opsName: run.name }, 'ops run could not be recorded');
  }
}

/**
 * For the process-level handlers in `index.ts`: an uncaught exception or an
 * unhandled rejection belongs in the same place as a 5xx, because from the
 * park's side they are the same event — the till asked for something and
 * nothing came back.
 */
export async function recordProcessFailure(
  app: FastifyInstance,
  name: string,
  err: unknown,
): Promise<void> {
  await recordFailedRun(app, {
    kind: 'process',
    name,
    outcome: 'failed',
    startedAt: new Date(),
    error: err,
  });
}

export const telemetryPlugin = fp(async (app: FastifyInstance, opts: TelemetryOptions = {}) => {
  const slowRequestMs = opts.slowRequestMs ?? configuredSlowRequestMs();
  app.decorateRequest('telemetry', null);

  /**
   * Nothing is read in `onRequest`, deliberately. Hooks added directly on the
   * instance run before a plugin's, so a request refused by the origin check
   * would never have reached an `onRequest` hook of ours — and a refused write
   * is exactly the request worth correlating.
   */
  app.addHook('onError', async (req, _reply, err) => {
    telemetryOf(req).error = err;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    const traceparent = req.headers.traceparent;
    if (typeof traceparent === 'string' && TRACEPARENT.test(traceparent)) {
      reply.header('traceparent', traceparent);
    }
    const actionId = validActionId(req);
    if (actionId) reply.header('x-oto-action-id', actionId);

    if (reply.statusCode >= 400) {
      const t = telemetryOf(req);
      t.errorCode ??= errorCodeOf(t.error, payload);
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const t = req.telemetry;
    const ms = Math.round(reply.elapsedTime);
    const status = reply.statusCode;
    const route = req.routeOptions?.url ?? '(unrouted)';
    const record = {
      method: req.method,
      route,
      path: pathOf(req.url),
      statusCode: status,
      ms,
      reqId: req.id,
      accountId: req.auth?.accountId,
      branchId: req.auth?.branchId ?? undefined,
      stationId: req.auth?.stationId ?? undefined,
      traceId: traceIdOf(req),
      actionId: validActionId(req),
      errorCode: t?.errorCode,
      // A replay answered from the store did none of the work the route
      // describes, so counting it as one is counting a sale twice.
      idempotentReplay: reply.getHeader('x-oto-replay') === 'true' ? true : undefined,
      slow: ms >= slowRequestMs ? true : undefined,
    };
    if (status >= 500) req.log.error(record, 'request completed');
    else if (status >= 400) req.log.warn(record, 'request completed');
    else req.log.info(record, 'request completed');

    /**
     * A 5xx is the one failure a caller cannot investigate and nobody sees
     * unless it is written down: the till showed "something went wrong" and
     * the log line scrolled past. `ops_run` is where it is still there on
     * Monday, grouped with the others like it.
     */
    if (status >= 500) {
      await recordFailedRun(app, {
        kind: 'http',
        name: `http:${req.method} ${route}`,
        outcome: 'failed',
        startedAt: new Date(Date.now() - ms),
        error: t?.error,
        detail: { statusCode: status, path: pathOf(req.url) },
        requestId: req.id,
        actionId: record.actionId ?? null,
        operatorId: req.auth?.operatorId ?? null,
        branchId: req.auth?.branchId ?? null,
        stationId: req.auth?.stationId ?? null,
      });
    }
  });
});

function telemetryOf(req: FastifyRequest): TelemetryContext {
  return (req.telemetry ??= {});
}

/** Path only: a query string carries phones, codes and search terms. */
function pathOf(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function traceIdOf(req: FastifyRequest): string | undefined {
  const traceparent = req.headers.traceparent;
  if (typeof traceparent !== 'string') return undefined;
  return TRACEPARENT.exec(traceparent)?.[1];
}

function validActionId(req: FastifyRequest): string | undefined {
  const actionId = req.headers['x-oto-action-id'];
  return typeof actionId === 'string' && ACTION_ID.test(actionId) ? actionId : undefined;
}

/**
 * The business code behind a refusal. Read from the error where one was
 * thrown, and otherwise parsed back out of our own envelope — the idempotency
 * plugin answers 409 by sending a reply rather than by throwing, and a replay
 * that nobody can see the reason for is the one people ask about.
 */
function errorCodeOf(err: unknown, payload: unknown): string | undefined {
  if (err instanceof AppError) return err.code;
  if (typeof payload === 'string' && payload.length > 0 && payload.length < 4096) {
    try {
      const body = JSON.parse(payload) as { error?: { code?: unknown } };
      if (typeof body.error?.code === 'string') return body.error.code;
    } catch {
      // Not our envelope (a file, a redirect body) — nothing to name.
    }
  }
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Read from the process rather than from `env.ts`, which is where every other
 * setting belongs and where this one should move: the schema is shared with
 * the deploy blueprint and the boot guard, and widening it is a change to
 * files this plugin has no business touching.
 */
function configuredSlowRequestMs(): number {
  const raw = Number(process.env.SLOW_REQUEST_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SLOW_REQUEST_MS;
}
