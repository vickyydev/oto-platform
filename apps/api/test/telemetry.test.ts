import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { opsRun } from '@oto/db';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-03 dev evidence for the request-completion line: it groups by the route
 * pattern, it names the business code behind a refusal, and no phone number
 * ever reaches it.
 */

interface Line {
  level: string;
  record: Record<string, unknown>;
  msg: string;
}

/**
 * Pino writes to a file descriptor rather than through `process.stdout.write`,
 * so a test cannot read its own log stream back. Fastify's per-request logger
 * is an ordinary property, though, and the completion line goes through it —
 * so each request carries a capturing logger and the line arrives here whole.
 */
function captureLogger(lines: Line[]): unknown {
  const at = (level: string) => (record: unknown, msg?: string) => {
    lines.push({
      level,
      record: (record && typeof record === 'object' ? record : {}) as Record<string, unknown>,
      msg: msg ?? (typeof record === 'string' ? record : ''),
    });
  };
  const logger: Record<string, unknown> = {
    level: 'info',
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    silent: () => {},
  };
  logger.child = () => logger;
  return logger;
}

let ctx: TestContext;
const lines: Line[] = [];
let reception: string;
let admin: string;

beforeAll(async () => {
  ctx = await createTestContext();
  // Before the first inject: Fastify refuses a hook once the instance has
  // booted, and a hook added directly on it runs ahead of every plugin's.
  ctx.app.addHook('onRequest', async (req) => {
    (req as unknown as { log: unknown }).log = captureLogger(lines);
  });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

function lastCompleted(): Line {
  const found = [...lines].reverse().find((l) => l.msg === 'request completed');
  if (!found) throw new Error('no "request completed" line was written');
  return found;
}

describe('request completion line (S2-03)', () => {
  it('carries the route pattern and a path with no query string', async () => {
    lines.length = 0;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0811111111',
      headers: { cookie: reception },
    });
    expect(res.statusCode).toBe(200);

    const line = lastCompleted();
    expect(line.level).toBe('info');
    expect(line.record.route).toBe('/members/lookup');
    expect(line.record.path).toBe('/members/lookup');
    expect(line.record.statusCode).toBe(200);
    expect(typeof line.record.ms).toBe('number');
    expect(line.record.accountId).toBeTruthy();
    expect(line.record.reqId).toBeTruthy();
    // The flag only appears when it means something.
    expect(line.record.slow).toBeUndefined();
  });

  it('never lets a phone number in the URL reach any log line', async () => {
    lines.length = 0;
    await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=%2B66811111111',
      headers: { cookie: reception },
    });
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain('66811111111');
    expect(everything).not.toContain('phone=');
  });

  it('groups by the route pattern rather than by the resolved path', async () => {
    const id = '00000000-0000-7000-8000-000000000000';
    lines.length = 0;
    await ctx.app.inject({
      method: 'GET',
      url: `/accounts/${id}/permissions`,
      headers: { cookie: admin },
    });
    const line = lastCompleted();
    expect(line.record.route).toBe('/accounts/:id/permissions');
    expect(line.record.path).toBe(`/accounts/${id}/permissions`);
  });

  it('logs a refusal at warn, carrying the code the caller was given', async () => {
    lines.length = 0;
    const res = await ctx.app.inject({ method: 'GET', url: '/members/lookup?phone=0811111111' });
    expect(res.statusCode).toBe(401);

    const line = lastCompleted();
    expect(line.level).toBe('warn');
    expect(line.record.errorCode).toBe('UNAUTHORIZED');
    expect(line.record.route).toBe('/members/lookup');
    // A request refused before it reached a handler still hides its query.
    expect(JSON.stringify(lines)).not.toContain('0811111111');
  });

  it('marks an idempotent replay as a replay rather than as work', async () => {
    const payload = { phone: '+66612345678', nickname: 'TelemetryIdem' };
    const headers = { cookie: reception, 'idempotency-key': 'telemetry-idem-1' };
    const first = await ctx.app.inject({ method: 'POST', url: '/members', payload, headers });
    expect(first.statusCode).toBe(200);

    lines.length = 0;
    const replay = await ctx.app.inject({ method: 'POST', url: '/members', payload, headers });
    expect(replay.statusCode).toBe(200);
    expect(lastCompleted().record.idempotentReplay).toBe(true);
  });

  it('carries the trace context it was given, and hands it back', async () => {
    const traceId = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const traceparent = `00-${traceId}-1122334455667788-01`;
    lines.length = 0;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { traceparent, 'x-oto-action-id': 'till-sale-0001' },
    });
    expect(res.headers.traceparent).toBe(traceparent);
    expect(res.headers['x-oto-action-id']).toBe('till-sale-0001');
    expect(res.headers['x-request-id']).toBeTruthy();

    const line = lastCompleted();
    expect(line.record.traceId).toBe(traceId);
    expect(line.record.actionId).toBe('till-sale-0001');
  });

  it('answers /ready with substance, and answers it fast', async () => {
    const started = Date.now();
    const res = await ctx.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_000);

    const body = res.json() as {
      status: string;
      checks: {
        database: { ok: boolean; latencyMs: number };
        pool: { total: number; idle: number; waiting: number; max: number | null } | null;
        jobs: { configured: boolean; watchdogAgeS: number | null; stale: boolean };
      };
    };
    expect(body.status).toBe('ready');
    expect(body.checks.database.ok).toBe(true);
    expect(typeof body.checks.database.latencyMs).toBe('number');
    expect(body.checks.pool).not.toBeNull();
    expect(typeof body.checks.pool!.total).toBe('number');
    // No watchdog has run here, and readiness must not care: a park does not
    // lose its till because a background job is late.
    expect(body.checks.jobs.stale).toBe(false);
  });

  it('ignores an action id that could forge a log entry', async () => {
    lines.length = 0;
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-oto-action-id': 'bad id\nlevel=fatal' },
    });
    expect(res.headers['x-oto-action-id']).toBeUndefined();
    expect(lastCompleted().record.actionId).toBeUndefined();
  });

  /**
   * The line scrolls past; the row does not. A 5xx is the one failure the
   * caller cannot investigate — the till said "something went wrong" and
   * nobody can say what — so it has to survive until someone looks.
   */
  it('leaves a 5xx in ops_run, logged at error and named by route', async () => {
    const headers = { cookie: admin, 'x-oto-action-id': 'till-failure-01' };
    await ctx.db.execute(sql`
      create or replace function oto_telemetry_fail() returns trigger as $fn$
      begin raise exception 'forced'; end $fn$ language plpgsql;
    `);
    await ctx.db.execute(
      sql.raw(`create trigger oto_telemetry_fail_trg after insert on core.audit_log
               for each row when (new.action = 'member.create') execute function oto_telemetry_fail();`),
    );
    lines.length = 0;
    const failed = await ctx.app.inject({
      method: 'POST',
      url: '/members',
      headers,
      payload: { phone: '+66612340000', nickname: 'TelemetryFailure' },
    });
    await ctx.db.execute(sql`drop trigger oto_telemetry_fail_trg on core.audit_log;`);
    expect(failed.statusCode).toBe(500);

    const line = lastCompleted();
    expect(line.level).toBe('error');
    expect(line.record.route).toBe('/members');

    const runs = await ctx.db.select().from(opsRun).where(eq(opsRun.kind, 'http'));
    const run = runs.find((r) => r.name === 'http:POST /members');
    expect(run).toBeTruthy();
    expect(run!.outcome).toBe('failed');
    expect(run!.requestId).toBe(line.record.reqId);
    expect(run!.actionId).toBe('till-failure-01');
    expect((run!.detail as { statusCode: number; path: string }).path).toBe('/members');
  });
});
