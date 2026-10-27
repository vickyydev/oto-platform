import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import { schema, type Db } from '../src/index';
import { settingRegistry } from '../src/schema/index';
import { convergeSettingRegistry, SETTING_CATALOGUE, type SettingCatalogueEntry } from '../src/setting-registry';
import { createTestDatabase, stopTestServer } from '../src/testing';

/**
 * SCRUM-646: the settings catalogue converges idempotently. Identities stay,
 * unchanged metadata is never rewritten, a catalogue run never claims a
 * setting changed, and nothing the catalogue no longer lists is deleted.
 */
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
let pool: pg.Pool;
let db: Db;
const t0 = new Date('2026-10-27T01:00:00.000Z');
const t1 = new Date('2026-10-27T02:00:00.000Z');
const t2 = new Date('2026-10-27T03:00:00.000Z');

beforeAll(async () => {
  database = await createTestDatabase();
  pool = new pg.Pool({ connectionString: database.url, max: 2, application_name: 's646-registry-convergence' });
  db = drizzle(pool, { schema });
}, 180_000);
afterAll(async () => {
  try { await pool?.end(); } finally {
    try { await database?.drop(); } finally { await stopTestServer(); }
  }
});

const rows = () => db.select().from(settingRegistry).orderBy(asc(settingRegistry.key));

describe('settings catalogue convergence', () => {
  it('the code catalogue has unique keys and fixed same-app Console paths only', () => {
    const keys = SETTING_CATALOGUE.map(entry => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of SETTING_CATALOGUE as readonly SettingCatalogueEntry[]) {
      if (entry.owningPageUrl !== null) expect(entry.owningPageUrl).toMatch(/^\/(?!\/)[a-z0-9/-]+$/);
      expect(entry.editableHere).toBe(entry.owningPageUrl !== null);
    }
  });

  it('a first run inserts every catalogue key, never a last-change time', async () => {
    const result = await convergeSettingRegistry(db, SETTING_CATALOGUE, t0);
    expect(result.inserted.sort()).toEqual(SETTING_CATALOGUE.map(entry => entry.key).sort());
    expect(result.updated).toEqual([]);
    const stored = await rows();
    expect(stored).toHaveLength(SETTING_CATALOGUE.length);
    for (const row of stored) {
      expect(row.lastChangedAt).toBeNull();
      expect(row.createdAt.toISOString()).toBe(t0.toISOString());
      expect(row.updatedAt.toISOString()).toBe(t0.toISOString());
    }
  });

  it('a second run with the same catalogue writes nothing and keeps every identity', async () => {
    const before = await rows();
    const result = await convergeSettingRegistry(db, SETTING_CATALOGUE, t1);
    expect(result.inserted).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged.sort()).toEqual(SETTING_CATALOGUE.map(entry => entry.key).sort());
    expect(await rows()).toEqual(before);
  });

  it('changed metadata is rewritten on the same identity; unchanged rows stay untouched', async () => {
    const before = await rows();
    const relabelled = SETTING_CATALOGUE.map(entry => entry.key === 'branch_tax' ? { ...entry, label: 'Tax and service' } : entry);
    const result = await convergeSettingRegistry(db, relabelled, t2);
    expect(result).toEqual({ inserted: [], updated: ['branch_tax'], unchanged: expect.any(Array) });
    const after = await rows();
    for (const row of after) {
      const prior = before.find(old => old.key === row.key)!;
      expect(row.id).toBe(prior.id);
      expect(row.lastChangedAt).toBeNull();
      if (row.key === 'branch_tax') {
        expect(row.label).toBe('Tax and service');
        expect(row.updatedAt.toISOString()).toBe(t2.toISOString());
        expect(row.createdAt).toEqual(prior.createdAt);
      } else {
        expect(row).toEqual(prior);
      }
    }
    await convergeSettingRegistry(db, SETTING_CATALOGUE, t2);
    const [restored] = await db.select().from(settingRegistry).where(eq(settingRegistry.key, 'branch_tax'));
    expect(restored!.label).toBe('Tax');
    expect(restored!.id).toBe(before.find(row => row.key === 'branch_tax')!.id);
  });

  it('a stored key the catalogue no longer lists is kept, and a stored last-change time is never overwritten', async () => {
    const retired = newId();
    const recorded = new Date('2026-10-01T00:00:00.000Z');
    await db.insert(settingRegistry).values({ id: retired, key: 'ZZ TEST 646 retired', label: 'Retired',
      appOwner: 'platform', requiredPermission: 'pos:print:read', lastChangedAt: recorded });
    const tax = (await db.select().from(settingRegistry).where(eq(settingRegistry.key, 'branch_tax')))[0]!;
    await db.update(settingRegistry).set({ lastChangedAt: recorded, label: 'drifted' }).where(eq(settingRegistry.id, tax.id));
    await convergeSettingRegistry(db, SETTING_CATALOGUE, t2);
    const [kept] = await db.select().from(settingRegistry).where(eq(settingRegistry.id, retired));
    expect(kept).toMatchObject({ key: 'ZZ TEST 646 retired', lastChangedAt: recorded });
    const [repaired] = await db.select().from(settingRegistry).where(eq(settingRegistry.id, tax.id));
    expect(repaired).toMatchObject({ label: 'Tax', lastChangedAt: recorded });
  });

  it('a catalogue that repeats a key is refused before any write', async () => {
    const before = await rows();
    const twice = [SETTING_CATALOGUE[0], { ...SETTING_CATALOGUE[0], key: 'ZZ TEST 646 new' }, SETTING_CATALOGUE[0]];
    await expect(convergeSettingRegistry(db, twice, t2)).rejects.toThrow(/repeats a key/);
    expect(await rows()).toEqual(before);
  });
});
