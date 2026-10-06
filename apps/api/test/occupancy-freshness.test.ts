import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, station, ticketPackage, type Db } from '@oto/db';
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
import { gateEventFact } from '@oto/box-agent/gate';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';
import { liveOccupancy } from '../src/services/occupancy';

/**
 * S2-12 round 4 — MEASURING the freshness path (plan §2.6 UNKNOWN): how long
 * a committed passage on the gate box takes to reach the occupancy projection,
 * with the box's outbox exactly as it has landed.
 *
 * Everything real: the gate module's own `gateEventFact`, the agent's outbox
 * and SQL store, `POST /box/v1/sync/push`, the `band.gate_event` handler, and
 * the projection the route answers from. The transport is `app.inject`, so the
 * network hop is zero here — a mall uplink adds its round trip on top.
 *
 * Two numbers, both logged:
 *   1. handler path — queue the fact, flush once, read the projection: what
 *      the platform side costs.
 *   2. cadence path — queue the fact and let the outbox's OWN timer carry it
 *      (`outbox.start()`, the agent's default `syncIntervalMs` of 5 s; a queued
 *      fact does not trigger a push, it waits for the next tick).
 * The chip polls every 5 s on top of (2), so passage → chip is bounded by
 * roughly interval + push + poll.
 */

let ctx: TestContext;
let agent: BoxAgent;
let gateStationId: string;
let branchId: string;
let operatorId: string;
const adults: string[] = [];

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
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

async function sellAdults(n: number): Promise<void> {
  const cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [till] = await ctx.db.select().from(station).where(eq(station.codePrefix, 'T1'));
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  const saleId = newId();
  const rung = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { id: saleId, stationId: till!.id, lines: [{ id: newId(), packageId: pkg!.id, kids: 0, adults: n }] },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie }, payload: {} });
  expect(paid.statusCode, paid.body).toBe(200);
  const bands = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
  adults.push(...bands.map((b) => b.id));
}

const entry = (bandId: string) =>
  gateEventFact({
    eventId: newId(),
    bandId,
    kind: 'entry',
    direction: 'entry',
    side: 'left',
    stationId: gateStationId,
    occurredAt: new Date().toISOString(),
  });

const adultsNow = async () =>
  (await liveOccupancy(ctx.db as Db, { operatorId, branchId, now: new Date() })).adults;

beforeAll(async () => {
  ctx = await createTestContext();
  await sellAdults(2);
  const pool = (ctx.db as unknown as { $client: PgPoolLike }).$client;
  const store = new SqlBoxStore({ driver: postgresBoxDriver(pool) });
  agent = createBoxAgent({
    apiBaseUrl: 'http://occupancy-freshness.test',
    credentials: memoryCredentialStore(),
    hostname: 'occupancy-freshness-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db as Db, ctx.app.log))?.claimCode ?? null,
    store,
    booth: { enabled: false },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const bundle = agent.config()!;
  branchId = bundle.branch.id;
  operatorId = bundle.branch.operatorId ?? agent.state.operatorId!;
  gateStationId = newId();
  await ctx.db.insert(station).values({
    id: gateStationId,
    operatorId,
    branchId,
    boxId: agent.state.boxId!,
    name: 'Freshness lane',
    kind: 'gate',
  });
});

afterAll(async () => {
  agent?.outbox()?.stop();
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

describe('occupancy freshness through the landed outbox (S2-12 round 4, measured)', () => {
  it('handler path: a committed passage is in the projection within the 5-second criterion once pushed', async () => {
    const before = await adultsNow();
    const t0 = performance.now();
    await agent.outbox()!.queue(entry(adults[0]!));
    const flushed = await agent.outbox()!.flush();
    expect(flushed.state).toBe('pushed');
    const after = await adultsNow();
    const ms = performance.now() - t0;
    console.log(`[occupancy-freshness] handler path (queue → push → projection): ${ms.toFixed(0)} ms`);
    expect(after).toBe(before + 1);
    expect(ms).toBeLessThan(5_000);
  });

  it('cadence path: with no explicit flush, the outbox timer alone carries the passage', async () => {
    const before = await adultsNow();
    const outbox = agent.outbox()!;
    await outbox.queue(entry(adults[1]!));
    // Queuing alone pushes nothing: the fact waits for the next tick.
    expect(await adultsNow()).toBe(before);
    const t0 = performance.now();
    outbox.start();
    let seen = before;
    while (seen === before && performance.now() - t0 < 15_000) {
      await new Promise((r) => setTimeout(r, 100));
      seen = await adultsNow();
    }
    outbox.stop();
    const ms = performance.now() - t0;
    console.log(
      `[occupancy-freshness] cadence path (queue → next outbox tick → projection): ${ms.toFixed(0)} ms; ` +
        'worst case passage → chip ≈ outbox interval (5 s) + push + chip poll (5 s)',
    );
    expect(seen).toBe(before + 1);
    // The landed default interval is 5 s; allow push time over it.
    expect(ms).toBeLessThan(7_000);
  }, 20_000);
});
