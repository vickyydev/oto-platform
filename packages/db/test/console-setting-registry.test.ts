import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '../src/testing';

/** SCRUM-646: metadata only, never a store of settings or credentials. */
describe('Console setting registry native storage', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let pool: pg.Pool;
  beforeAll(async () => {
    database = await createTestDatabase();
    pool = new pg.Pool({ connectionString: database.url, max: 2, application_name: 's646-registry-storage' });
  }, 180_000);
  afterAll(async () => {
    try { await pool?.end(); } finally {
      try { await database?.drop(); } finally { await stopTestServer(); }
    }
  });

  async function tableReady() {
    const result = await pool.query("select to_regclass('core.setting_registry')::text as name");
    expect(result.rows).toEqual([{ name: 'core.setting_registry' }]);
  }

  it('CONTROL: the existing operator setting document remains separate', async () => {
    expect((await pool.query("select to_regclass('core.setting')::text as name")).rows)
      .toEqual([{ name: 'core.setting' }]);
    expect((await pool.query("select column_name from information_schema.columns where table_schema='core' and table_name='setting'")).rows
      .map(row => row.column_name)).toContain('value');
  });

  it('R1 high: declares only the approved metadata columns, with a UUID identity', async () => {
    await tableReady();
    const columns = (await pool.query<{ column_name: string; data_type: string }>(
      "select column_name,data_type from information_schema.columns where table_schema='core' and table_name='setting_registry'",
    )).rows;
    expect(columns.map(row => row.column_name).sort()).toEqual([
      'id', 'key', 'label', 'app_owner', 'owning_page_url', 'editable_here', 'required_permission',
      'last_changed_at', 'created_at', 'updated_at',
    ].sort());
    expect(columns.find(row => row.column_name === 'id')?.data_type).toBe('uuid');
    expect(columns.some(row => row.data_type === 'jsonb')).toBe(false);
  });

  it('R2 high: catalogue timestamps never invent the underlying setting last-change time', async () => {
    await tableReady();
    const result = await pool.query(
      `insert into core.setting_registry(id,key,label,app_owner,required_permission)
       values($1,$2,$3,$4,$5) returning editable_here,last_changed_at,created_at,updated_at`,
      [randomUUID(), `ZZ TEST 646 metadata ${randomUUID()}`, 'ZZ TEST metadata', 'platform', 'pos:print:read'],
    );
    expect(result.rows[0]).toMatchObject({ editable_here: false, last_changed_at: null });
    expect(result.rows[0].created_at).toBeInstanceOf(Date);
    expect(result.rows[0].updated_at).toBeInstanceOf(Date);
  });

  it('R3 high: one named unique catalogue key preserves a single identity', async () => {
    await tableReady();
    const key = `ZZ TEST 646 unique ${randomUUID()}`;
    const values = [randomUUID(), key, 'ZZ TEST metadata', 'platform', 'pos:print:read'];
    const insert = `insert into core.setting_registry(id,key,label,app_owner,required_permission) values($1,$2,$3,$4,$5)`;
    await pool.query(insert, values);
    await expect(pool.query(insert, [randomUUID(), ...values.slice(1)]))
      .rejects.toMatchObject({ code: '23505', constraint: 'setting_registry_key_unique' });
    expect((await pool.query('select id from core.setting_registry where key=$1', [key])).rows)
      .toEqual([{ id: values[0] }]);
  });

  it('R4 medium: a freshly migrated registry is honestly empty until catalogue integration', async () => {
    await tableReady();
    expect((await pool.query("select count(*)::int as count from core.setting_registry where key not like 'ZZ TEST %' ")).rows)
      .toEqual([{ count: 0 }]);
  });
});
