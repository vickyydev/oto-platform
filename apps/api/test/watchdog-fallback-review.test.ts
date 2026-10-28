import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alert, box, branch, operator, opsExpectation, schema, syncQuarantine, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { newId } from '@oto/shared';
import { loadEnv, type Env } from '../src/env';
import { buildLogger } from '../src/lib/logger';
import { boxSettings } from '../src/services/box';
import { runWatchdog } from '../src/services/jobs';
import type { AlertChannel, AlertMessage } from '../src/services/ops';

/**
 * SCRUM-662 house review. High: an unread count must not clear an incident.
 * Prescribed fix: retain unread fleet evidence and apply no fallback-derived
 * fleet effects. Actual job checks and silent-box marking remain independent.
 * Native private PG only: no seed, API server, scheduled runner or provider.
 */
describe('Watchdog fallback evidence (SCRUM-662)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let pool: pg.Pool | undefined, restrictedPool: pg.Pool | undefined;
  let db: Db, restrictedDb: Db, env: Env;
  let roleCreated = false;
  const roleName = `zz_test_662_${randomUUID().replaceAll('-', '')}`, role = `"${roleName}"`;
  const operatorId = newId(), branchId = newId();
  const delivered: AlertMessage[] = [];
  const channels: AlertChannel[] = [{ name: 'console', deliver: async message => {
    delivered.push(message); return { target: 'ZZ TEST 662 capture' };
  } }];
  const log = buildLogger('test');
  const watchdog = (connection = db) => runWatchdog({ db: connection, env, log, channels });
  const alertOf = async (key: string) => (await db.select().from(alert).where(eq(alert.key, key)))[0]!;

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new pg.Pool({ connectionString: database.url, max: 4, application_name: 's662-owner' });
    db = drizzle(pool, { schema });
    env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: database.url, PROCESS_ROLES: 'api',
      CONSOLE_DIGEST_ENABLED: 'false', ALERT_WEBHOOK_URL: '' });
    await db.insert(operator).values({ id: operatorId, name: 'ZZ TEST 662 watchdog' });
    await db.insert(branch).values({ id: branchId, operatorId, name: 'ZZ TEST 662 park', code: 'zz-test-662',
      openingHours: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
        .map(day => [day, { open: '00:00', close: '00:00' }])) });
    await pool.query(`create role ${role} nologin`); roleCreated = true;
    const namespaces = await pool.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema'",
    );
    for (const { nspname } of namespaces.rows) {
      const namespace = `"${nspname.replaceAll('"', '""')}"`;
      await pool.query(`grant usage on schema ${namespace} to ${role}`);
      await pool.query(`grant select on all tables in schema ${namespace} to ${role}`);
    }
    await pool.query(`grant update on core.box to ${role}`);
    await pool.query(`grant insert,update on core.alert to ${role}`);
    await pool.query(`grant insert on core.alert_delivery to ${role}`);
    await pool.query(`revoke select on edge.sync_quarantine from ${role}`);
    restrictedPool = new pg.Pool({ connectionString: database.url, max: 3,
      options: `-c role=${roleName}`, application_name: 's662-restricted' });
    restrictedDb = drizzle(restrictedPool, { schema });
  }, 180_000);

  afterAll(async () => {
    try { await restrictedPool?.end(); } finally {
      try {
        if (pool && roleCreated) {
          await pool.query(`drop owned by ${role}`);
          await pool.query(`drop role ${role}`);
          expect((await pool.query('select 1 from pg_roles where rolname=$1', [roleName])).rows).toEqual([]);
        }
      } finally {
        try { await pool?.end(); } finally {
          try { await database?.drop(); } finally { await stopTestServer(); }
        }
      }
    }
  });

  async function fixture(reason: 'poison' | 'epoch_regressed' = 'poison') {
    const boxId = newId(), quarantineId = newId();
    await db.insert(box).values({ id: boxId, operatorId, branchId, name: 'ZZ TEST 662 box',
      slot: `zz662-${boxId}`, role: 'booth', status: 'online', registeredAt: new Date(),
      lastHeartbeatAt: new Date(), agentVersion: boxSettings().minAgentVersion,
      currentEpoch: reason === 'epoch_regressed' ? 2 : 1,
      lastStatus: { uptimeS: 1, outboxDepth: 0, clockOffsetMs: 0 } });
    await db.insert(syncQuarantine).values({ id: quarantineId, boxId, eventId: newId(),
      journalEpoch: 1, boxSeq: 1, reason, payload: { fixture: 'ZZ TEST 662' } });
    const key = `${reason === 'epoch_regressed' ? 'sync.epoch_regressed' : 'sync.quarantine'}:${boxId}`;
    await watchdog();
    const opened = await alertOf(key);
    expect(opened).toMatchObject({ key, status: 'open', resolvedAt: null, resolvedReason: null });
    expect(opened.lastNotifiedAt).toBeInstanceOf(Date);
    expect(delivered.some(message => message.key === key && message.event === 'opened')).toBe(true);
    return { boxId, quarantineId, key, opened };
  }

  it('CONTROL: a readable positive quarantine count remains open and is not delivered twice', async () => {
    const f = await fixture();
    await watchdog();
    expect(await alertOf(f.key)).toMatchObject({ id: f.opened.id, status: 'open', resolvedAt: null, occurrences: 2 });
    expect(delivered.filter(message => message.key === f.key && message.event === 'opened')).toHaveLength(1);
  });

  it.each(['poison', 'epoch_regressed'] as const)(
    'R1 high: a denied %s count cannot resolve the real alert or announce recovery', async reason => {
      const f = await fixture(reason);
      const before = await db.select().from(syncQuarantine).where(eq(syncQuarantine.id, f.quarantineId));
      expect((await restrictedPool!.query('select 1 as healthy')).rows).toEqual([{ healthy: 1 }]);
      // The watchdog can really perform its native writes; only the evidence SELECT is refused.
      await restrictedPool!.query('update core.box set updated_at=updated_at where false');
      await expect(restrictedPool!.query('select count(*) from edge.sync_quarantine'))
        .rejects.toMatchObject({ code: '42501' });
      const summary = await watchdog(restrictedDb);
      const after = await alertOf(f.key);
      expect(after.status).toBe('open');
      expect(after).toEqual(f.opened);
      expect(delivered.filter(message => message.key === f.key && message.event === 'resolved')).toEqual([]);
      expect(await db.select().from(syncQuarantine).where(eq(syncQuarantine.id, f.quarantineId))).toEqual(before);
      expect(summary).toMatchObject({ fleetAvailability: 'denied', fleetEvaluated: false });
    },
  );

  it('CONTROL: restored reads and an actually cleared quarantine resolve the same alert exactly once', async () => {
    const f = await fixture();
    await pool!.query(`grant select on edge.sync_quarantine to ${role}`);
    try {
      await db.update(syncQuarantine).set({ status: 'discarded', resolvedAt: new Date(),
        resolutionNote: 'ZZ TEST 662 readable recovery' }).where(eq(syncQuarantine.id, f.quarantineId));
      await watchdog(restrictedDb);
      expect(await alertOf(f.key)).toMatchObject({ id: f.opened.id, status: 'resolved', resolvedReason: 'cleared' });
      expect((await alertOf(f.key)).resolvedAt).toBeInstanceOf(Date);
      await watchdog(restrictedDb);
      expect(delivered.filter(message => message.key === f.key && message.event === 'resolved')).toHaveLength(1);
    } finally { await pool!.query(`revoke select on edge.sync_quarantine from ${role}`); }
  });

  it('CONTROL: job checks and factual silent-box marking still run while fleet support is unread', async () => {
    const f = await fixture();
    const name = `ZZ TEST 662 expected ${newId()}`;
    await db.insert(opsExpectation).values({ name, kind: 'job', description: 'ZZ TEST 662 missing job',
      intervalSeconds: 1, graceSeconds: 0, severity: 'warning', createdAt: new Date(Date.now() - 3_600_000) });
    await db.update(box).set({ lastHeartbeatAt: new Date(Date.now() - 3_600_000) }).where(eq(box.id, f.boxId));
    const summary = await watchdog(restrictedDb);
    expect(await alertOf(`ops.missing:${name}`)).toMatchObject({ status: 'open' });
    expect((await db.select({ status: box.status }).from(box).where(eq(box.id, f.boxId)))[0]?.status).toBe('offline');
    expect(summary.missing).toBeGreaterThanOrEqual(1);
    expect(summary.boxesSilenced).toBeGreaterThanOrEqual(1);
  });

  it('R2 high: a real blocked support read reaches its deadline without resolving an incident', async () => {
    const f = await fixture(), holder = await pool!.connect();
    let narrow: pg.Pool | undefined;
    await pool!.query(`grant select on edge.sync_quarantine to ${role}`);
    try {
      await holder.query('begin');
      const holderPid = Number((await holder.query('select pg_backend_pid() as pid')).rows[0].pid);
      await holder.query('lock table edge.sync_quarantine in access exclusive mode');
      narrow = new pg.Pool({ connectionString: database!.url, max: 3,
        options: `-c role=${roleName} -c statement_timeout=5000`, application_name: 's662-blocked' });
      const operation = watchdog(drizzle(narrow, { schema })).then(
        value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
      );
      const deadline = Date.now() + 4_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const observed = await pool!.query<{ blocked: boolean }>(
          `select $1::int = any(pg_blocking_pids(pid)) as blocked from pg_stat_activity
           where application_name='s662-blocked' and wait_event_type='Lock'`, [holderPid],
        );
        if (observed.rows.some(row => row.blocked)) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked, 'observe the native lock wait before classifying this as a deadline failure').toBe(true);
      const outcome = await operation;
      if (!outcome.ok) throw outcome.error;
      expect((await alertOf(f.key)).status).toBe('open');
      expect(await alertOf(f.key)).toEqual(f.opened);
      expect(outcome.value).toMatchObject({ fleetAvailability: 'failed', fleetEvaluated: false });
      expect(delivered.filter(message => message.key === f.key && message.event === 'resolved')).toEqual([]);
    } finally {
      try { await holder.query('rollback'); } finally {
        holder.release();
        try { await narrow?.end(); } finally { await pool!.query(`revoke select on edge.sync_quarantine from ${role}`); }
      }
    }
  });
});
