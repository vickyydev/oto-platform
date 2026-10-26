import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { alert, operator, schema, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { newId } from '@oto/shared';
import { healthSnapshot, type HealthDeps } from '../src/services/ops';

/**
 * SCRUM-645 / Q26: a failed evidence read must not impersonate an empty estate.
 * Severity: high (false healthy). Prescribed fix: retain read availability in
 * the Health answer instead of treating an unread alert list as healthy data.
 * This does not choose a replacement status or change /ready's admission rule.
 * Only a private migrated database is used: no seed, app server or provider.
 */
describe('Health read availability (Q26)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let pool: pg.Pool | undefined;
  let restrictedPool: pg.Pool | undefined;
  let db: Db;
  let restrictedDb: Db;
  const operatorId = newId();
  const roleName = `zz_test_645_health_${randomUUID().replaceAll('-', '')}`;
  const role = `"${roleName}"`;
  let roleCreated = false;

  const deps = (database: Db): HealthDeps => ({
    db: database,
    operatorId,
    reach: { kind: 'operator' },
    watchdogJob: 'ZZ TEST 645 absent watchdog',
    watchdogIntervalSeconds: 30,
    failureThreshold: 3,
  });

  async function criticalAlert() {
    const id = newId();
    await db.insert(alert).values({
      id,
      operatorId,
      key: `ZZ TEST 645 critical ${id}`,
      category: 'ops.missing',
      severity: 'critical',
      subject: 'ZZ TEST 645 evidence fixture',
      summary: 'ZZ TEST 645 critical alert remains open',
    });
    return id;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new pg.Pool({ connectionString: database.url, max: 2, application_name: 's645-health-owner' });
    db = drizzle(pool, { schema });
    await db.insert(operator).values({ id: operatorId, name: 'ZZ TEST 645 health availability' });
    await pool.query(`create role ${role} nologin`);
    roleCreated = true;
    const namespaces = await pool.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema'",
    );
    for (const { nspname } of namespaces.rows) {
      const namespace = `"${nspname.replaceAll('"', '""')}"`;
      await pool.query(`grant usage on schema ${namespace} to ${role}`);
      await pool.query(`grant select on all tables in schema ${namespace} to ${role}`);
    }
    await pool.query(`revoke select on core.alert from ${role}`);
    restrictedPool = new pg.Pool({
      connectionString: database.url,
      max: 1,
      options: `-c role=${roleName}`,
      application_name: 's645-health-restricted',
    });
    restrictedDb = drizzle(restrictedPool, { schema });
  });

  afterEach(async () => {
    if (pool) await db.delete(alert).where(eq(alert.operatorId, operatorId));
  });

  afterAll(async () => {
    try {
      await restrictedPool?.end();
    } finally {
      try {
        if (pool && roleCreated) {
          await pool.query(`drop owned by ${role}`);
          await pool.query(`drop role ${role}`);
        }
      } finally {
        try {
          await pool?.end();
        } finally {
          try {
            await database?.drop();
          } finally {
            await stopTestServer();
          }
        }
      }
    }
  });

  it('CONTROL: a genuinely empty estate retains the native healthy result', async () => {
    const snapshot = await healthSnapshot(deps(db));
    expect(snapshot.checks.find((check) => check.key === 'database')?.status).toBe('ok');
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.boxes).toEqual([]);
    expect(snapshot.alerts).toEqual([]);
    expect(snapshot.status).toBe('ok');
  });

  it('CONTROL: a readable own critical alert is down while only its restricted read fails', async () => {
    const id = await criticalAlert();
    const snapshot = await healthSnapshot(deps(db));
    expect(snapshot.alerts.map((row) => row.id)).toEqual([id]);
    expect(snapshot.status).toBe('down');
    expect((await restrictedPool!.query('select 1 as healthy')).rows).toEqual([{ healthy: 1 }]);
    await expect(restrictedPool!.query('select id from core.alert')).rejects.toMatchObject({ code: '42501' });
    await expect(restrictedPool!.query('select name from core.ops_last')).resolves.toMatchObject({ rows: [] });
    expect((await db.select({ id: alert.id }).from(alert).where(eq(alert.id, id))).map((row) => row.id)).toEqual([id]);
  });

  it.fails('FINDING Q26 high: an unread critical-alert list must not produce a healthy estate', async () => {
    const id = await criticalAlert();
    const readable = await healthSnapshot(deps(db));
    expect(readable.status).toBe('down');
    expect(readable.alerts.map((row) => row.id)).toEqual([id]);
    const snapshot = await healthSnapshot(deps(restrictedDb));
    expect(snapshot.checks.find((check) => check.key === 'database')?.status).toBe('ok');
    expect((await db.select({ id: alert.id }).from(alert).where(eq(alert.id, id))).map((row) => row.id)).toEqual([id]);
    expect(snapshot.status).not.toBe('ok');
  });
});
