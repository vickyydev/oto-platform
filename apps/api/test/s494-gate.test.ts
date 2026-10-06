import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, bandEvent, branch, station, ticketPackage, type Db } from '@oto/db';
import { newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import { bandCopyFrom, decideGate } from '@oto/box-agent/gate';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';
import { currentBandKey } from '../src/services/bands';
import { liveOccupancy } from '../src/services/occupancy';

/**
 * SCRUM-494 register item 4 — each ticket's Gate access reaches the gate.
 *
 * The approved design: an adult band takes `gateAccess` from its line's
 * ticket package, a kids band never has it (`lib/sale.ts:buildPersonGrants`,
 * `mockApi.ts:issueWalkInBands`); the gate reader checks that flag only (BL
 * §7.1, R-83); occupancy counts only gate-access bands as adults and every
 * band without it follows its group (`mockApi.ts:getLiveOccupancy`).
 *
 * One sale here has two ticket lines: an adult on a ticket with Gate access
 * on, and an adult and a child on a copy of the same ticket with it off.
 */

let ctx: TestContext;
let db: Db;
let cookie: string;
let agent: BoxAgent;
let store: SqlBoxStore;
let gatePkgId: string;
let noGatePkgId: string;
let saleId: string;
let gateAdult: typeof band.$inferSelect;
let noGateAdult: typeof band.$inferSelect;
let kid: typeof band.$inferSelect;
let gateStationId: string;

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: url.replace(/^https?:\/\/[^/]+/, ''),
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

async function sell(lines: Array<{ packageId: string; kids: number; adults: number }>): Promise<string> {
  const [till] = await db.select().from(station).where(eq(station.codePrefix, 'T1'));
  const id = newId();
  const rung = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { id, stationId: till!.id, lines: lines.map((l) => ({ id: newId(), ...l })) },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${id}/finalise`,
    headers: { cookie },
    payload: {},
  });
  expect(paid.statusCode, paid.body).toBe(200);
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [till] = await db.select().from(station).where(eq(station.codePrefix, 'T1'));
  const [pkg] = await db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  gatePkgId = pkg!.id;
  expect(pkg!.gateAccess).toBe(true);
  noGatePkgId = newId();
  await db.insert(ticketPackage).values({
    ...pkg!,
    id: noGatePkgId,
    name: '2 Hours Play (no gate)',
    gateAccess: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  saleId = await sell([
    { packageId: gatePkgId, kids: 0, adults: 1 },
    { packageId: noGatePkgId, kids: 1, adults: 1 },
  ]);
  const rows = await db.select().from(band).where(eq(band.saleId, saleId));
  expect(rows).toHaveLength(3);
  kid = rows.find((b) => b.kind === 'kid')!;
  const adults = rows.filter((b) => b.kind === 'adult');
  gateAdult = adults.find((b) => b.gateAccess)!;
  noGateAdult = adults.find((b) => !b.gateAccess)!;

  const pool = (db as unknown as { $client: PgPoolLike }).$client;
  store = new SqlBoxStore({ driver: postgresBoxDriver(pool) });
  agent = createBoxAgent({
    apiBaseUrl: 'http://s494-gate.test',
    credentials: memoryCredentialStore(),
    hostname: 's494-gate-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(db, ctx.app.log))?.claimCode ?? null,
    store,
    booth: { enabled: false },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const bundle = agent.config()!;
  gateStationId = newId();
  await db.insert(station).values({
    id: gateStationId,
    operatorId: bundle.branch.operatorId ?? agent.state.operatorId!,
    branchId: bundle.branch.id,
    boxId: agent.state.boxId!,
    name: 'S494 gate lane',
    kind: 'gate',
  });
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

describe('a band takes its Gate access from its line ticket when it is minted', () => {
  it('the adult on the gate ticket has it; the adult on the no-gate ticket and the child do not', async () => {
    expect(gateAdult).toBeDefined();
    expect(noGateAdult).toBeDefined();
    const lines = new Map(
      (await db.select().from(band).where(eq(band.saleId, saleId))).map((b) => [b.id, b.saleLineId]),
    );
    expect(gateAdult.gateAccess).toBe(true);
    expect(noGateAdult.gateAccess).toBe(false);
    expect(kid.gateAccess).toBe(false);
    // Each adult band is on its own line's unit.
    expect(lines.get(gateAdult.id)).not.toBe(lines.get(noGateAdult.id));
  });

  it('the minted event records the flag the band was issued with', async () => {
    const [minted] = await db
      .select()
      .from(bandEvent)
      .where(and(eq(bandEvent.bandId, noGateAdult.id), eq(bandEvent.kind, 'minted')));
    expect(minted!.detail).toMatchObject({ gateAccess: false });
  });

  it('changing the ticket later does not change a band already issued', async () => {
    await db.update(ticketPackage).set({ gateAccess: true }).where(eq(ticketPackage.id, noGatePkgId));
    try {
      const [row] = await db.select().from(band).where(eq(band.id, noGateAdult.id));
      expect(row!.gateAccess).toBe(false);
    } finally {
      await db.update(ticketPackage).set({ gateAccess: false }).where(eq(ticketPackage.id, noGatePkgId));
    }
  });

  it('a kids band cannot carry Gate access (database check)', async () => {
    await expect(db.update(band).set({ gateAccess: true }).where(eq(band.id, kid.id))).rejects.toThrow();
  });
});

describe('the box bands scope carries the flag and the gate checks it', () => {
  it('the bands copy on the box holds gateAccess for each band', async () => {
    await agent.syncCache();
    const held = await store.readBundle(agent.state.boxId!, 'bands');
    const items = (held?.payload as { items: Array<{ id: string; gateAccess?: boolean }> }).items;
    const byId = new Map(items.map((i) => [i.id, i.gateAccess]));
    expect(byId.get(gateAdult.id)).toBe(true);
    expect(byId.get(noGateAdult.id)).toBe(false);
    expect(byId.get(kid.id)).toBe(false);
  });

  it('opens for the gate-ticket adult and refuses the no-gate adult in both directions, as for a kids band', async () => {
    const held = await store.readBundle(agent.state.boxId!, 'bands');
    const deny = await store.readBundle(agent.state.boxId!, 'deny_list');
    const items = (b: typeof held) => ((b?.payload as { items?: unknown[] } | undefined)?.items ?? []);
    const copy = bandCopyFrom(items(held), items(deny));
    const key = currentBandKey();
    expect(key).toBeTruthy();
    const decide = (code: string, direction: 'entry' | 'exit') =>
      decideGate({ code, direction, key, lookup: copy.lookup, inside: () => false, unknownMeans: 'offline' });

    expect(decide(gateAdult.code, 'entry')).toMatchObject({ open: true, bandId: gateAdult.id });
    for (const direction of ['entry', 'exit'] as const) {
      expect(decide(noGateAdult.code, direction)).toMatchObject({
        open: false,
        reason: 'NO_GATE_ACCESS',
        bandId: noGateAdult.id,
      });
      expect(decide(kid.code, direction)).toMatchObject({ open: false, reason: 'KID_BAND' });
    }
  });

  it('the deny list carries the flag of a stopped band', async () => {
    await db.update(band).set({ status: 'revoked' }).where(eq(band.id, noGateAdult.id));
    try {
      await agent.syncCache();
      const held = await store.readBundle(agent.state.boxId!, 'deny_list');
      const items = (
        held?.payload as { items: Array<{ revokedBands?: Array<{ id: string; kind: string; gateAccess?: boolean }> }> }
      ).items;
      expect(items[0]!.revokedBands).toEqual(
        expect.arrayContaining([{ id: noGateAdult.id, kind: 'adult', gateAccess: false }]),
      );
    } finally {
      await db.update(band).set({ status: 'active' }).where(eq(band.id, noGateAdult.id));
    }
  });
});

describe('occupancy: a band without Gate access follows its group', () => {
  const bkk = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);
  const pass = (bandId: string, kind: 'entry' | 'exit', at: Date) =>
    db.insert(bandEvent).values({
      id: newId(),
      bandId,
      kind,
      stationId: gateStationId,
      boxId: agent.state.boxId!,
      detail: { direction: kind, side: 'left' },
      createdAt: at,
    });

  const count = async (now: Date) => {
    const [b] = await db.select().from(branch).where(eq(branch.id, gateAdult.branchId));
    const v = await liveOccupancy(db, { operatorId: b!.operatorId, branchId: b!.id, now });
    return { adults: v.adults, kids: v.kids, total: v.total };
  };

  it('counts only the gate adult as an adult; the no-gate adult and the child follow while the group is inside', async () => {
    const day = '2030-03-04';
    expect(await count(bkk(day, '09:00'))).toEqual({ adults: 0, kids: 0, total: 0 });
    await pass(gateAdult.id, 'entry', bkk(day, '10:00'));
    expect(await count(bkk(day, '10:01'))).toEqual({ adults: 1, kids: 2, total: 3 });
    await pass(gateAdult.id, 'exit', bkk(day, '11:00'));
    expect(await count(bkk(day, '11:01'))).toEqual({ adults: 0, kids: 0, total: 0 });
  });

  it('a passage credited to a no-gate band does not make it, or its group, inside', async () => {
    const day = '2030-03-05';
    await pass(noGateAdult.id, 'entry', bkk(day, '10:00'));
    expect(await count(bkk(day, '10:01'))).toEqual({ adults: 0, kids: 0, total: 0 });
  });
});
