import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { alert, box, branch, operator, opsExpectation, schema, type Db } from '@oto/db';
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

  /** A second restricted role, refused one other evidence table (Q26 controls). */
  async function restrictedOn(table: string) {
    const name = `zz_test_645_narrow_${randomUUID().replaceAll('-', '')}`;
    const quoted = `"${name}"`;
    await pool!.query(`create role ${quoted} nologin`);
    const namespaces = await pool!.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema'",
    );
    for (const { nspname } of namespaces.rows) {
      const namespace = `"${nspname.replaceAll('"', '""')}"`;
      await pool!.query(`grant usage on schema ${namespace} to ${quoted}`);
      await pool!.query(`grant select on all tables in schema ${namespace} to ${quoted}`);
    }
    await pool!.query(`revoke select on ${table} from ${quoted}`);
    const narrow = new pg.Pool({ connectionString: database!.url, max: 1, options: `-c role=${name}`, application_name: 's645-health-narrow' });
    return {
      pool: narrow,
      release: async () => {
        try {
          await narrow.end();
        } finally {
          await pool!.query(`drop owned by ${quoted}`);
          await pool!.query(`drop role ${quoted}`);
        }
      },
    };
  }

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

  it('FINDING Q26 high: an unread critical-alert list must not produce a healthy estate', async () => {
    const id = await criticalAlert();
    const readable = await healthSnapshot(deps(db));
    expect(readable.status).toBe('down');
    expect(readable.alerts.map((row) => row.id)).toEqual([id]);
    const snapshot = await healthSnapshot(deps(restrictedDb));
    expect(snapshot.checks.find((check) => check.key === 'database')?.status).toBe('ok');
    expect((await db.select({ id: alert.id }).from(alert).where(eq(alert.id, id))).map((row) => row.id)).toEqual([id]);
    expect(snapshot.status).not.toBe('ok');
  });

  // --- Planner Q26: the verdicts the fix carries, each with its control ----

  it('Q26 CONTROL: a readable healthy estate reads ok and names every consulted read as ok', async () => {
    const snapshot = await healthSnapshot(deps(db));
    expect(snapshot.status).toBe('ok');
    expect(snapshot.evidence.map((e) => [e.source, e.availability]).sort()).toEqual([
      ['alerts', 'ok'], ['fleet', 'ok'], ['jobs', 'ok'], ['occupancy', 'ok'], ['watchdog', 'ok'],
    ]);
    expect(snapshot.evidence.every((e) => e.detail === null)).toBe(true);
  });

  it('Q26 CONTROL: a readable critical alert still reads down', async () => {
    const id = await criticalAlert();
    const snapshot = await healthSnapshot(deps(db));
    expect(snapshot.status).toBe('down');
    expect(snapshot.alerts.map((row) => row.id)).toEqual([id]);
    expect(snapshot.evidence.find((e) => e.source === 'alerts')?.availability).toBe('ok');
  });

  it('Q26: a refused alert read is an explicit unknown verdict carried in the answer, never an empty all-clear', async () => {
    await criticalAlert();
    const snapshot = await healthSnapshot(deps(restrictedDb));
    expect(snapshot.status).toBe('unknown');
    expect(snapshot.alerts).toEqual([]);
    expect(snapshot.evidence.find((e) => e.source === 'alerts')).toEqual({
      source: 'alerts', label: 'The open alerts', availability: 'denied', detail: 'the database refused this read',
    });
    // Only the refused read is marked: the readable ones still say ok.
    expect(snapshot.evidence.filter((e) => e.availability !== 'ok').map((e) => e.source)).toEqual(['alerts']);
    expect(snapshot.checks.find((check) => check.key === 'database')?.status).toBe('ok');
  });

  it('Q26: a known fault still outranks missing evidence — a critical overdue job reads down with the alerts unread', async () => {
    const name = `ZZ TEST 645 overdue ${newId()}`;
    await db.insert(opsExpectation).values({
      name, kind: 'job', intervalSeconds: 60, graceSeconds: 0, severity: 'critical',
      createdAt: new Date(Date.now() - 3_600_000),
    });
    try {
      const snapshot = await healthSnapshot(deps(restrictedDb));
      expect(snapshot.jobs.find((job) => job.name === name)?.status).toBe('down');
      expect(snapshot.evidence.find((e) => e.source === 'alerts')?.availability).toBe('denied');
      expect(snapshot.status).toBe('down');
    } finally {
      await db.delete(opsExpectation).where(eq(opsExpectation.name, name));
    }
  });

  it('Q26: a refused job-register read and a refused fleet read are each unknown evidence, not an empty register or fleet', async () => {
    for (const [table, source] of [['core.ops_expectation', 'jobs'], ['core.box', 'fleet']] as const) {
      const { pool: narrow, release } = await restrictedOn(table);
      try {
        const snapshot = await healthSnapshot(deps(drizzle(narrow, { schema })));
        expect(snapshot.status, table).toBe('unknown');
        expect(snapshot.evidence.find((e) => e.source === source)?.availability, table).toBe('denied');
        expect(snapshot.evidence.find((e) => e.source === 'alerts')?.availability, table).toBe('ok');
      } finally {
        await release();
      }
    }
  });

  it('Q26: a refused supporting fleet read (quarantine) marks the shown boxes as incomplete instead of a clean fleet', async () => {
    const parkId = newId();
    const boxId = newId();
    await db.insert(branch).values({ id: parkId, operatorId, name: 'ZZ TEST 645 evidence park', code: `zz645e${parkId.slice(-6)}` });
    await db.insert(box).values({
      id: boxId, operatorId, branchId: parkId, name: 'ZZ TEST 645 evidence box', slot: 'ZZ645E', role: 'booth',
      status: 'online', registeredAt: new Date(), lastHeartbeatAt: new Date(), agentVersion: '0.0.1',
    });
    const { pool: narrow, release } = await restrictedOn('edge.sync_quarantine');
    try {
      const readable = await healthSnapshot(deps(db));
      expect(readable.boxes.map((b) => b.id)).toEqual([boxId]);
      expect(readable.evidence.find((e) => e.source === 'fleet')?.availability).toBe('ok');
      const snapshot = await healthSnapshot(deps(drizzle(narrow, { schema })));
      // The box itself is still shown — what could be read is not thrown away.
      expect(snapshot.boxes.map((b) => b.id)).toEqual([boxId]);
      expect(snapshot.evidence.find((e) => e.source === 'fleet')).toMatchObject({ availability: 'denied' });
      expect(snapshot.status).not.toBe('ok');
      expect(snapshot.status).not.toBe('warn');
    } finally {
      await release();
      await db.delete(box).where(eq(box.id, boxId));
      await db.delete(branch).where(eq(branch.id, parkId));
    }
  });
});
