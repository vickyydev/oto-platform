import { randomInt } from 'node:crypto';
import { hash as argonHash, verify as verifyArgon2 } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  account,
  boothConfigVersion,
  boothStaffAssignment,
  box,
  boxCache,
  credential,
  employee,
  station,
  ticketPackage,
} from '@oto/db';
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
import { issueClaimCode, provisionVirtualBox } from '../src/services/box';
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
let tillId: string;
let packageId: string;
let cookie: string;
let receptionAccountId: string;
/** Every path the agent under test has asked for, for the SCRUM-322 case. */
const calls: string[] = [];
/** Shared between the agents below, the way a Pi's credentials outlive its process. */
const credentials = memoryCredentialStore();

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);

  const stations = await ctx.db.select().from(station);
  const till = stations.find((s) => s.name === 'Reception Till 1')!;
  boxId = till.boxId!;
  tillId = till.id;
  packageId = (
    await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, till.branchId))
  ).find((p) => p.name === '2 Hours Play')!.id;
  receptionAccountId = (
    await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone))
  )[0]!.id;

  agent = createBoxAgent({
    apiBaseUrl: 'http://virtual-box.test',
    credentials,
    hostname: 'cache-survives-test',
    fetch: injectTransport((path) => calls.push(path)),
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

/**
 * SCRUM-322 — the agent's half: the receipt mark is read on its own tick.
 *
 * The cloud stopped hashing `receipt_series` into the bundle's version, because
 * it moves on every finalised sale and was making a SELLING box pull its whole
 * cache every minute. That trade is only safe if the box still gets the mark,
 * so this is the half that says it does: a tick in which the bundle is answered
 * 304 still leaves the box holding the number the cloud last issued.
 *
 * It drives the real agent against the real route — `pullReceiptSeries` is not
 * reachable from `@oto/box-agent`'s own test runner, which cannot load
 * `agent.ts` at all — and the sale is a real finalised sale, so the mark is one
 * `allocateReceipt` actually issued.
 */
describe('the receipt mark rides its own tick (SCRUM-322)', () => {
  /** The mark this box holds for T1, out of its own cached scope. */
  async function heldMark(): Promise<number> {
    const held = await freshStore().readBundle(boxId, 'receipt_series');
    expect(held, 'the box has never cached where its numbering stands').not.toBeNull();
    const items = (held!.payload as { items: Array<{ prefix: string | null; highWaterMark: number }> })
      .items;
    return items.find((i) => i.prefix === 'T1')!.highWaterMark;
  }

  /** A ฿0 comp at the till: one call, one finalised sale, one receipt number. */
  async function sellOnce(): Promise<number> {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie },
      payload: {
        stationId: tillId,
        id: newId(),
        lines: [{ id: newId(), packageId, kids: 1, adults: 1 }],
        manualDiscounts: [
          { id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Staff / family' },
        ],
        finalise: true,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return Number(res.json().sale.receiptSeq);
  }

  it('is refreshed on a tick the bundle answers 304, and rewrites nothing else', async () => {
    const before = await heldMark();
    const staffBefore = await freshStore().readBundle(boxId, 'staff');

    const seq = await sellOnce();
    expect(seq).toBeGreaterThan(before);

    calls.length = 0;
    const applied = await agent.syncCache();

    /**
     * Nothing an administrator changed, so the bundle leg was a 304 and no
     * administered scope was rewritten — which is what the empty answer says.
     * Before this ticket the same tick rewrote all nine `edge.box_cache` rows
     * and carried the branch's whole member page to do it.
     *
     * The two calls are the whole of the new shape: the conditional bundle,
     * then the mark on its own scope with no validator on it.
     */
    expect(applied).toEqual([]);

    // And the box is standing on the number the cloud just issued anyway,
    // which is the whole of what makes the 304 above safe.
    expect(await heldMark(), 'the box is holding a receipt number already spent').toBe(seq);
    expect(calls).toEqual([
      '/box/v1/cache?schemaVersion=1',
      '/box/v1/cache?schemaVersion=1&scopes=receipt_series',
    ]);

    const staffAfter = await freshStore().readBundle(boxId, 'staff');
    expect(staffAfter!.appliedAt, 'the staff list was rewritten for nothing').toBe(
      staffBefore!.appliedAt,
    );
  });
});

/**
 * SCRUM-412 — the agent's half: a box that runs only a booth pulls the booth's
 * three scopes and holds nothing else, and the booth still signs somebody in by
 * PIN and plays from them with the internet gone.
 *
 * The real agent, the real store on Postgres and the real routes, as above — on
 * a box of its own with one booth on it, built the way the Console builds one,
 * so nothing here touches the virtual box the cases above hold. The wheel is
 * Booth 1's published version, set on this booth as a publish would leave it.
 */
describe('a box that runs only a booth holds the booth’s cache and nothing else (SCRUM-412)', () => {
  const PIN = '36910';
  let boothBoxId: string;
  let personId: string;
  let boothAgent: BoxAgent;
  let applied: string[];
  /** The wire, as the booth box sees it: switched off for the offline case. */
  let online = true;
  const callsWhileOffline: string[] = [];

  beforeAll(async () => {
    const [till] = await ctx.db.select().from(station).where(eq(station.id, tillId)).limit(1);
    const { operatorId, branchId } = till!;

    boothBoxId = newId();
    await ctx.db.insert(box).values({
      id: boothBoxId,
      operatorId,
      branchId,
      name: 'Booth-only box',
      slot: 'booth-only-1',
      role: 'booth',
    });
    const boothStationId = newId();
    await ctx.db.insert(station).values({
      id: boothStationId,
      operatorId,
      branchId,
      boxId: boothBoxId,
      name: 'Booth-only Booth',
      kind: 'booth',
      codePrefix: 'BZ',
    });

    const [booth1] = await ctx.db
      .select({ id: station.id })
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.name, 'Booth 1')))
      .limit(1);
    const [wheel] = await ctx.db
      .select()
      .from(boothConfigVersion)
      .where(eq(boothConfigVersion.stationId, booth1!.id))
      .orderBy(desc(boothConfigVersion.version))
      .limit(1);
    await ctx.db.insert(boothConfigVersion).values({
      id: newId(),
      operatorId,
      branchId,
      stationId: boothStationId,
      version: 1,
      layoutId: wheel!.layoutId,
      bundle: wheel!.bundle,
      bundleHash: wheel!.bundleHash,
      note: 'SCRUM-412: Booth 1’s wheel',
    });

    // Somebody on this booth's list, and on no other, with a PIN.
    const phone = '+66900004131';
    const employeeId = newId();
    await ctx.db.insert(employee).values({
      id: employeeId,
      operatorId,
      branchId,
      name: 'Kanya (Test)',
      nickname: 'Kanya',
      phone,
    });
    personId = newId();
    await ctx.db.insert(account).values({
      id: personId,
      operatorId,
      employeeId,
      phone,
      passwordHash: await argonHash('kanya-pw-1'),
      status: 'active',
    });
    await ctx.db.insert(boothStaffAssignment).values({
      id: newId(),
      stationId: boothStationId,
      accountId: personId,
      addedBy: receptionAccountId,
    });
    await ctx.db.insert(credential).values({
      id: newId(),
      operatorId,
      accountId: personId,
      kind: 'pin',
      secretHash: await argonHash(PIN),
      createdByAccountId: receptionAccountId,
    });

    const wire = injectTransport();
    boothAgent = createBoxAgent({
      apiBaseUrl: 'http://booth-only.test',
      credentials: memoryCredentialStore(),
      hostname: 'booth-only-test',
      fetch: async (url, init) => {
        if (!online) {
          callsWhileOffline.push(url);
          throw new Error('the line is down');
        }
        return wire(url, init);
      },
      claimCode: async () => (await issueClaimCode(ctx.db, boothBoxId)).code,
      store: freshStore(),
      booth: {
        randomIndex: (max) => randomInt(max),
        verifySecret: (hash, secret) => verifyArgon2(hash, secret),
      },
    });
    await boothAgent.ensureRegistered();
    await boothAgent.syncConfig();
    applied = await boothAgent.syncCache();
  }, 180_000);

  afterAll(() => {
    boothAgent?.booth()?.stop();
    boothAgent?.stop();
  });

  it('pulls the three scopes a booth reads, and writes no other', async () => {
    // The deny-list first, as `planCacheApply` orders them.
    expect(applied).toEqual(['deny_list', 'staff', 'booth']);

    // Not a member, a price or a receipt mark on this box's disk: the
    // receipt tick that follows every pull was answered with nothing to write.
    const rows = await ctx.db.select().from(boxCache).where(eq(boxCache.boxId, boothBoxId));
    expect(rows.map((r) => r.scope).sort()).toEqual(['booth', 'deny_list', 'staff']);

    // Kanya, and not reception, who works the till and the virtual box's booth.
    const staff = (
      rows.find((r) => r.scope === 'staff')!.payload as { items: Array<{ accountId: string }> }
    ).items;
    expect(staff.map((s) => s.accountId)).toEqual([personId]);
  });

  it('signs the person in by PIN and plays, with the internet gone', async () => {
    const booth = boothAgent.booth();
    expect(booth, 'the agent built no booth module').toBeTruthy();
    await booth!.start();
    expect(booth!.config(), 'the booth adopted no wheel from the cache it holds').toBeTruthy();

    await boothAgent.setOffline(true, { reason: 'test' });
    online = false;

    const signedIn = await booth!.signIn({ pin: PIN });
    expect(signedIn.ok, 'the booth refused a PIN its own cache carries').toBe(true);
    expect(signedIn.accountId).toBe(personId);

    const spun = await booth!.spin({ idempotencyKey: newId() });
    expect(spun.spinId).toBeTruthy();
    expect(spun.voucherCode, 'the booth minted no code for the prize it drew').toBeTruthy();
    expect(spun.staffAccountId, 'the spin was recorded unattributed').toBe(personId);

    expect(callsWhileOffline, 'the booth reached for the internet').toEqual([]);
  });
});
