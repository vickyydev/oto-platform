import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema, type Db } from '@oto/db';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';
import { integrationsSnapshot, recordRun, type IntegrationDeps } from '../src/services/ops';

/**
 * SCRUM-645 / planner ruling Q26 — "Integration history and the
 * read-availability verdicts land in the same service."
 *
 * Each Integrations row carries its history (last success and last failure
 * from the operational record, test presses included) and whether this read
 * of its evidence answered. A row whose evidence was refused or failed is
 * never green: it may still say what is configured, but it says the record
 * could not be read. A private migrated database and restricted roles; no
 * seed, no app server, no provider (every fetch is captured).
 */
describe('Integrations history and read availability (Q26)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let pool: pg.Pool | undefined;
  let db: Db;
  const roles: string[] = [];
  const pools: pg.Pool[] = [];
  let restoreFetch: () => void;

  const env: IntegrationDeps['env'] = {
    DEPLOY_ENV: 'local',
    SMS_ADAPTER: 'console',
    ALERT_CHANNELS: 'console',
    PROCESS_ROLES: 'api,jobs',
    MINIO_ENDPOINT: 'zz-test.invalid',
    MINIO_PORT: 443,
    MINIO_USE_SSL: true,
    HANDOFF_APP_ORIGINS: '',
  };
  const deps = (database: Db, storage: IntegrationDeps['storage'] = null): IntegrationDeps => ({
    db: database, env, storage, watchdogJob: 'ZZ TEST 645 watchdog',
  });

  async function refused(table: string): Promise<Db> {
    const name = `zz_test_645_int_${randomUUID().replaceAll('-', '')}`;
    roles.push(name);
    await pool!.query(`create role "${name}" nologin`);
    const namespaces = await pool!.query<{ nspname: string }>(
      "select nspname from pg_namespace where nspname not like 'pg_%' and nspname <> 'information_schema'",
    );
    for (const { nspname } of namespaces.rows) {
      await pool!.query(`grant usage on schema "${nspname}" to "${name}"`);
      await pool!.query(`grant select on all tables in schema "${nspname}" to "${name}"`);
    }
    await pool!.query(`revoke select on ${table} from "${name}"`);
    const narrow = new pg.Pool({ connectionString: database!.url, max: 1, options: `-c role=${name}` });
    pools.push(narrow);
    return drizzle(narrow, { schema });
  }

  beforeAll(async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ZZ TEST: no provider'));
    restoreFetch = () => spy.mockRestore();
    database = await createTestDatabase();
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    try {
      for (const p of pools) await p.end();
      for (const name of roles) {
        await pool?.query(`drop owned by "${name}"`);
        await pool?.query(`drop role "${name}"`);
      }
    } finally {
      try { await pool?.end(); } finally {
        try { await database?.drop(); } finally { await stopTestServer(); restoreFetch?.(); }
      }
    }
  });

  it('CONTROL: a readable record answers ok on every row, with each row\'s last success and failure', async () => {
    const at = new Date(Date.now() - 60_000);
    await recordRun(db, { kind: 'integration', name: 'integration:sms.test', outcome: 'ok', startedAt: at, finishedAt: at });
    await recordRun(db, { kind: 'integration', name: 'integration:storage.test', outcome: 'failed', startedAt: at, error: new Error('ZZ TEST') });
    const snapshot = await integrationsSnapshot(deps(db));
    expect(snapshot.providers.map((p) => [p.key, p.availability])).toEqual([
      ['sms', 'ok'], ['storage', 'ok'], ['jobs', 'ok'], ['alerts', 'ok'], ['sentry', 'ok'],
    ]);
    const sms = snapshot.providers.find((p) => p.key === 'sms')!;
    expect(sms.state).toBe('configured');
    expect(sms.lastOkAt).toBe(at.toISOString());
    expect(sms.lastFailedAt).toBeNull();
    const storage = snapshot.providers.find((p) => p.key === 'storage')!;
    expect(storage.lastOkAt).toBeNull();
    expect(storage.lastFailedAt).not.toBeNull();
  });

  it('a refused operational record marks every row that reads it as denied, and none of them reads green', async () => {
    const snapshot = await integrationsSnapshot(deps(await refused('core.ops_last')));
    const sms = snapshot.providers.find((p) => p.key === 'sms')!;
    expect(sms).toMatchObject({ availability: 'denied', lastOkAt: null, lastFailedAt: null, lastDeliveryAt: null });
    expect(sms.state).not.toBe('configured');
    expect(sms.detail).toContain('could not be read');
    expect(snapshot.providers.find((p) => p.key === 'jobs')).toMatchObject({ availability: 'denied' });
    expect(snapshot.providers.find((p) => p.key === 'jobs')!.state).not.toBe('configured');
    // A row with nothing to read keeps its own answer.
    expect(snapshot.providers.find((p) => p.key === 'sentry')).toMatchObject({ availability: 'ok' });
  });

  it('a refused alert-delivery read is the alerts row\'s own denied verdict, not "never delivered"', async () => {
    const snapshot = await integrationsSnapshot(deps(await refused('core.alert_delivery')));
    const alerts = snapshot.providers.find((p) => p.key === 'alerts')!;
    expect(alerts).toMatchObject({ availability: 'denied', lastDeliveryAt: null });
    expect(alerts.state).not.toBe('configured');
    expect(snapshot.providers.find((p) => p.key === 'sms')).toMatchObject({ availability: 'ok', state: 'configured' });
  });

  it('a storage probe that fails is a failed read and a failing row, never configured; one that answers is ok', async () => {
    const broken = { probe: async (): Promise<{ state: string }> => { throw new Error('ZZ TEST probe exploded'); } };
    const storage = (await integrationsSnapshot(deps(db, broken))).providers.find((p) => p.key === 'storage')!;
    expect(storage).toMatchObject({ availability: 'failed', state: 'degraded' });
    expect(JSON.stringify(storage)).not.toContain('exploded');
    const ready = { probe: async () => ({ state: 'ready' }) };
    expect((await integrationsSnapshot(deps(db, ready))).providers.find((p) => p.key === 'storage'))
      .toMatchObject({ availability: 'ok', state: 'configured' });
  });
});
