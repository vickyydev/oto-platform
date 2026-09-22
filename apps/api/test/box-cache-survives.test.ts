import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { account, boxCache, station } from '@oto/db';
import { newId } from '@oto/shared';
import {
  SqlBoxStore,
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  type AgentFetch,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';
import { boxStoreFor } from '../src/lib/box-store';

/**
 * SCRUM-275, half one — the cache a box holds is a ROW, not a process.
 *
 * Until `edge.box_cache` existed, `SqlBoxStore` on Postgres kept its bundles in
 * a `Map` on the store object and said so where the map was declared. The
 * virtual box runs inside the api, so that map died with every Render deploy:
 * a box that had pulled its staff list and its deny-list an hour ago came back
 * from a deploy holding neither, and an offline unlock is decided from those
 * two copies and from no table beside them (`services/staff-token.ts`). Until
 * the next cache tick refilled them, that box refused everybody — and the worse
 * order, a staff list back without the deny-list, was reachable too.
 *
 * WHAT THIS FILE PROVES, and the shape matters. A test that writes a bundle and
 * reads it back through the SAME store object would pass just as happily on the
 * map. So every assertion below reads through a **store built after the write**,
 * over the same database, and the decisive one reads it through a store built
 * after the api itself was thrown away and rebuilt (`ctx.restart()`, which is
 * what a deploy does). `boxStoreFor(db)` deliberately memoises one store per
 * pool, so it would hand back the very object under test; these build their own
 * for that reason and for no other.
 *
 * The SQLite dialect of the same two methods is proved in
 * `packages/box-agent/test/store.test.ts`, which is the half a Raspberry Pi
 * runs.
 */

let ctx: TestContext;
let agent: BoxAgent;
let boxId: string;
let receptionAccountId: string;
/** Shared between the agents below, the way a Pi's credentials outlive its process. */
const credentials = memoryCredentialStore();

beforeAll(async () => {
  ctx = await createTestContext();
  await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const stations = await ctx.db.select().from(station);
  const till = stations.find((s) => s.name === 'Reception Till 1')!;
  boxId = till.boxId!;
  receptionAccountId = (
    await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone))
  )[0]!.id;

  agent = createBoxAgent({
    apiBaseUrl: 'http://virtual-box.test',
    credentials,
    hostname: 'cache-survives-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const applied = await agent.syncCache();
  expect(applied).toContain('staff');
  expect(applied).toContain('deny_list');
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** `app.inject` behind the agent's transport, as the S2-05 and S2-06 suites do it. */
function injectTransport(onCall?: (path: string) => void): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    onCall?.(path);
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

/** A store with nothing in its own memory, over the database the api is using. */
function freshStore(): SqlBoxStore {
  const client = (ctx.db as unknown as { $client: PgPoolLike }).$client;
  return new SqlBoxStore({ driver: postgresBoxDriver(client) });
}

describe('the cache survives the process that pulled it (SCRUM-275)', () => {
  it('lands in edge.box_cache, one row per scope, carrying the box and its operator', async () => {
    const rows = await ctx.db.select().from(boxCache).where(eq(boxCache.boxId, boxId));
    const scopes = rows.map((r) => r.scope);
    expect(scopes).toContain('staff');
    expect(scopes).toContain('deny_list');

    const [staff] = rows.filter((r) => r.scope === 'staff');
    // The tenancy column the store fills from `core.box` in the same statement:
    // this table is born with the column its nine siblings in `edge` still owe.
    const [boxRow] = await ctx.db
      .select({ operatorId: station.operatorId })
      .from(station)
      .where(eq(station.boxId, boxId))
      .limit(1);
    expect(staff!.operatorId).toBe(boxRow!.operatorId);
    expect(staff!.appliedAt).toBeInstanceOf(Date);
    // The whole scope, not a page of one.
    expect((staff!.payload as { items: unknown[] }).items.length).toBeGreaterThan(0);
  });

  it('a NEW store and a NEW agent find the deny-list before either has pulled anything', async () => {
    /**
     * The deploy, as closely as this suite can stage it: the api is closed and
     * rebuilt on the same database, the agent that pulled the cache is dropped,
     * and what reads the bundle is a store constructed afterwards. Nothing in
     * this test wrote a bundle — the pull happened in `beforeAll`, to a
     * different store object, against an api instance that no longer exists.
     */
    await ctx.restart();

    const calls: string[] = [];
    const store = freshStore();
    const restarted = createBoxAgent({
      apiBaseUrl: 'http://virtual-box.test',
      credentials,
      hostname: 'cache-survives-test',
      fetch: injectTransport((path) => calls.push(path)),
      claimCode: async () => null,
      store,
    });

    const deny = await store.readBundle(boxId, 'deny_list');
    expect(deny, 'the deny-list was lost with the process that pulled it').not.toBeNull();
    const staff = await store.readBundle(boxId, 'staff');
    expect(staff).not.toBeNull();
    const items = (staff!.payload as { items: Array<Record<string, unknown>> }).items;
    // Not merely present: the same copy, with what an offline unlock reads off
    // it — the account and the argon2id hash it verifies against.
    const mine = items.find((s) => s.accountId === receptionAccountId);
    expect(mine).toBeTruthy();
    expect(String(mine!.passwordHash)).toContain('$argon2');

    expect(calls, 'the bundles came back from a pull rather than from the database').toEqual([]);
    expect(restarted.state.boxId).toBeNull();
  });

  it('refuses to cache for a box that does not exist rather than keeping nothing quietly', async () => {
    const store = freshStore();
    // The insert selects the operator from `core.box`, so an id with no box
    // matches no row and writes none. Throwing is the honest answer: a silent
    // no-op here is a box that believes it has a deny-list.
    await expect(
      store.writeBundle(newId(), {
        scope: 'deny_list',
        schemaVersion: 1,
        cursorSeq: 1,
        payload: { items: [] },
        appliedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(/No core\.box row/);
  });

  it('replaces a scope whole on the next pull, and leaves the other scopes alone', async () => {
    const store = freshStore();
    const before = await store.readBundle(boxId, 'staff');
    await store.writeBundle(boxId, {
      scope: 'staff',
      schemaVersion: before!.schemaVersion,
      cursorSeq: before!.cursorSeq + 1,
      payload: { items: [{ accountId: receptionAccountId }] },
      appliedAt: new Date().toISOString(),
    });

    const rows = await ctx.db
      .select()
      .from(boxCache)
      .where(and(eq(boxCache.boxId, boxId), eq(boxCache.scope, 'staff')));
    // One row per (box, scope): the upsert replaces, so a shrinking staff list
    // cannot leave yesterday's people behind in a second row.
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { items: unknown[] }).items).toHaveLength(1);
    expect(await store.readBundle(boxId, 'deny_list')).not.toBeNull();
  });
});
