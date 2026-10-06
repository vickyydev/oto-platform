import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, bandEvent, box, station, syncEvent, ticketPackage, type Db } from '@oto/db';
import { LiveOccupancyViewSchema, newId } from '@oto/shared';
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
import {
  CHALONG_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { provisionVirtualBox } from '../src/services/box';
import { liveOccupancy } from '../src/services/occupancy';

/**
 * S2-12 round 4 — GATE RE-CHECK reproductions (kept as tests).
 *
 * MIXED CLOCK TRUST ON ONE BOX. `clock_trust` is stamped per event when the
 * box queues it (`clockStamp()` in the agent), and the clock is measured on
 * the heartbeat, a channel separate from the outbox push. So one outbox batch
 * can carry an entry queued BEFORE the box measured its clock (untrusted,
 * placed by the projection at `received_at`) followed by an exit queued AFTER
 * (trusted, placed at its own stamp — which is earlier than the batch's
 * `received_at`). The projection then orders the exit before the entry and
 * leaves the adult and their sale's children counted inside, fresh, for the
 * rest of the trading day, although the box's own gapless `box_seq` on the
 * ledger says the entry came first.
 */

let ctx: TestContext;
let db: Db;
let receptionCookie: string;
let agent: BoxAgent;
let agentStation: string;
let agentBranch: string;
let agentOperator: string;
const BEHIND_MS = 60 * 60 * 1000;

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

async function sell(kids: number, adults: number): Promise<{ saleId: string; adults: string[]; kids: string[] }> {
  const [till] = await db.select().from(station).where(eq(station.codePrefix, 'T1'));
  const [pkg] = await db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, till!.branchId), eq(ticketPackage.name, '2 Hours Play')));
  const saleId = newId();
  const rung = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: receptionCookie },
    payload: { id: saleId, stationId: till!.id, lines: [{ id: newId(), packageId: pkg!.id, kids, adults }] },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: receptionCookie },
    payload: {},
  });
  expect(paid.statusCode, paid.body).toBe(200);
  const bands = await db.select().from(band).where(eq(band.saleId, saleId));
  return {
    saleId,
    adults: bands.filter((b) => b.kind === 'adult').map((b) => b.id),
    kids: bands.filter((b) => b.kind === 'kid').map((b) => b.id),
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const pool = (ctx.db as unknown as { $client: PgPoolLike }).$client;
  agent = createBoxAgent({
    apiBaseUrl: 'http://occupancy-recheck.test',
    credentials: memoryCredentialStore(),
    hostname: 'occupancy-recheck-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db as Db, ctx.app.log))?.claimCode ?? null,
    store: new SqlBoxStore({ driver: postgresBoxDriver(pool) }),
    booth: { enabled: false },
    now: () => Date.now() - BEHIND_MS,
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const bundle = agent.config()!;
  agentBranch = bundle.branch.id;
  agentOperator = bundle.branch.operatorId ?? agent.state.operatorId!;
  agentStation = newId();
  await db.insert(station).values({
    id: agentStation,
    operatorId: agentOperator,
    branchId: agentBranch,
    boxId: agent.state.boxId!,
    name: 'Recheck lane',
    kind: 'gate',
  });
});

afterAll(async () => {
  agent?.outbox()?.stop();
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

describe('re-check — mixed clock trust in one outbox batch', () => {
  it('an entry queued before the heartbeat measured the clock and an exit queued after, pushed together, leave the family OUT', async () => {
    const s = await sell(1, 1);
    const adult = s.adults[0]!;
    const before = await liveOccupancy(db, { operatorId: agentOperator, branchId: agentBranch, now: new Date() });

    // 1. The family walks in while the Pi's clock is still unmeasured: queued untrusted.
    const entryId = newId();
    await agent.outbox()!.queue(
      gateEventFact({
        eventId: entryId,
        bandId: adult,
        kind: 'entry',
        direction: 'entry',
        side: 'left',
        stationId: agentStation,
        occurredAt: new Date(Date.now() - BEHIND_MS).toISOString(),
      }),
    );
    // 2. A heartbeat gets through and measures the clock; from here events are trusted.
    await agent.heartbeat();
    // 3. The family walks out; the box stamps the corrected (true) time, trusted.
    const exitAt = new Date();
    const exitId = newId();
    await agent.outbox()!.queue(
      gateEventFact({
        eventId: exitId,
        bandId: adult,
        kind: 'exit',
        direction: 'exit',
        side: 'left',
        stationId: agentStation,
        occurredAt: exitAt.toISOString(),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    // 4. The outbox pushes both in one batch.
    expect((await agent.outbox()!.flush()).state).toBe('pushed');

    const ledger = async (bandEventId: string) => {
      const [row] = await db.select().from(bandEvent).where(eq(bandEvent.id, bandEventId));
      const [se] = await db
        .select()
        .from(syncEvent)
        .where(eq(syncEvent.eventId, (row!.detail as { sourceEventId: string }).sourceEventId));
      return se!;
    };
    const entryLedger = await ledger(entryId);
    const exitLedger = await ledger(exitId);
    expect(entryLedger.clockTrust).not.toBe('trusted');
    expect(exitLedger.clockTrust).toBe('trusted');
    // The box's own journal order is unambiguous.
    expect(entryLedger.boxSeq).toBeLessThan(exitLedger.boxSeq);

    await db.update(box).set({ lastHeartbeatAt: new Date(), lastStatus: { outboxDepth: 0, oldestUnackedAgeS: null } });
    const after = await liveOccupancy(db, { operatorId: agentOperator, branchId: agentBranch, now: new Date() });
    expect(after.stale).toBe(false);
    expect(after.adults, 'the adult who walked in and out is still counted inside').toBe(before.adults);
    expect(after.kids, 'their child is still counted inside').toBe(before.kids);
  });
});

describe('re-check — honest staleness through the route', () => {
  it('a branch with no gate station at all answers stale, gates 0, asOf null', async () => {
    const chalong = await branchIdByCode(db, CHALONG_BRANCH_CODE);
    const view = await liveOccupancy(db, { operatorId: agentOperator, branchId: chalong });
    expect(view).toMatchObject({ gates: 0, stale: true, asOf: null });
    expect(LiveOccupancyViewSchema.parse(view).stale).toBe(true);
  });
});
