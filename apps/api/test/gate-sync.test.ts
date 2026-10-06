import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  auditLog,
  band,
  bandEvent,
  station,
  syncQuarantine,
  ticketPackage,
  type Db,
} from '@oto/db';
import { GATE_EVENT_TYPE, newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import { gateEventFact, type GateJournalInput } from '@oto/box-agent/gate';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { provisionVirtualBox } from '../src/services/box';

/**
 * S2-12 round 2 — the platform half of the gate box: the `band.gate_event`
 * handler and the deny list's named revoked bands.
 *
 * Every fact here is built by the gate module's own `gateEventFact` and goes
 * through the real outbox and the real `POST /box/v1/sync/push`, so a name or
 * a field the two ends disagree on lands in quarantine instead of passing.
 */

let ctx: TestContext;
let agent: BoxAgent;
let store: SqlBoxStore;
let gateStationId: string;
let adultBandId: string;
let kidBandId: string;

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

/** A ticket sale finalised in cash: one kid band and one adult band (S2-11). */
async function sellBands(): Promise<void> {
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
    payload: {
      id: saleId,
      stationId: till!.id,
      lines: [{ id: newId(), packageId: pkg!.id, kids: 1, adults: 1 }],
    },
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie },
    payload: {},
  });
  expect(paid.statusCode, paid.body).toBe(200);
  const bands = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
  adultBandId = bands.find((b) => b.kind === 'adult')!.id;
  kidBandId = bands.find((b) => b.kind === 'kid')!.id;
}

function fact(over: Partial<GateJournalInput> = {}) {
  return gateEventFact({
    eventId: newId(),
    bandId: adultBandId,
    kind: 'entry',
    direction: 'entry',
    side: 'left',
    stationId: gateStationId,
    occurredAt: new Date().toISOString(),
    ...over,
  });
}

async function push(): Promise<void> {
  const flushed = await agent.outbox()!.flush();
  expect(flushed.state).toBe('pushed');
}

beforeAll(async () => {
  ctx = await createTestContext();
  await sellBands();
  const pool = (ctx.db as unknown as { $client: PgPoolLike }).$client;
  store = new SqlBoxStore({ driver: postgresBoxDriver(pool) });
  agent = createBoxAgent({
    apiBaseUrl: 'http://gate-sync.test',
    credentials: memoryCredentialStore(),
    hostname: 'gate-sync-test',
    fetch: injectTransport(),
    claimCode: async () =>
      (await provisionVirtualBox(ctx.db as Db, ctx.app.log))?.claimCode ?? null,
    store,
    booth: { enabled: false },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  const bundle = agent.config()!;
  gateStationId = newId();
  await ctx.db.insert(station).values({
    id: gateStationId,
    operatorId: bundle.branch.operatorId ?? agent.state.operatorId!,
    branchId: bundle.branch.id,
    boxId: agent.state.boxId!,
    name: 'Gate sync test lane',
    kind: 'gate',
  });
});

afterAll(async () => {
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

describe('band.gate_event (S2-12 round 2)', () => {
  it('files an entry as a band_event with the box-minted id, station, box and detail, and audits it', async () => {
    const entry = fact();
    const eventId = (entry.payload as { eventId: string }).eventId;
    await agent.outbox()!.queue(entry);
    await push();
    const [row] = await ctx.db.select().from(bandEvent).where(eq(bandEvent.id, eventId));
    expect(row, 'no band_event row for the gate entry').toBeTruthy();
    expect(row!.kind).toBe('entry');
    expect(row!.bandId).toBe(adultBandId);
    expect(row!.stationId).toBe(gateStationId);
    expect(row!.boxId).toBe(agent.state.boxId);
    expect(row!.detail).toMatchObject({ direction: 'entry', side: 'left' });
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'gate.entry'), eq(auditLog.entityId, adultBandId)));
    expect(audits).toHaveLength(1);
  });

  it('is idempotent: the same event id under a new envelope, and a replayed batch, write nothing more', async () => {
    const first = fact({ kind: 'exit', direction: 'exit', side: 'right', exitWithoutEntry: false });
    const eventId = (first.payload as { eventId: string }).eventId;
    await agent.outbox()!.queue(first);
    await push();
    // The same fact again, as a fresh envelope (a restored store would mint one).
    await agent.outbox()!.queue({ ...first, payload: { ...first.payload } });
    await push();
    // And the Console's "Replay last batch".
    expect(await agent.outbox()!.replayLastBatch(1)).toBe(1);
    await push();
    const rows = await ctx.db.select().from(bandEvent).where(eq(bandEvent.id, eventId));
    expect(rows).toHaveLength(1);
    const refused = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.type, GATE_EVENT_TYPE));
    expect(refused.map((r) => r.errorCode)).toEqual([]);
  });

  it('records denied, timeout and alarm; an alarm raises the station alert', async () => {
    await agent.outbox()!.queue(fact({ kind: 'denied', reason: 'ANTI_PASSBACK' }));
    await agent.outbox()!.queue(fact({ kind: 'timeout', inferred: true }));
    await agent.outbox()!.queue(fact({ kind: 'alarm', alarm: 'tailgating' }));
    await push();
    const rows = await ctx.db.select().from(bandEvent).where(eq(bandEvent.bandId, adultBandId));
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['denied', 'timeout', 'alarm']));
    const denied = rows.find((r) => r.kind === 'denied');
    expect(denied!.detail).toMatchObject({ reason: 'ANTI_PASSBACK' });
    const [raised] = await ctx.db
      .select()
      .from(alert)
      .where(eq(alert.key, `gate.tailgating:${gateStationId}`));
    expect(raised, 'no tailgating alert').toBeTruthy();
  });

  it('holds an event for a band not here yet in quarantine, to replay', async () => {
    await agent.outbox()!.queue(fact({ bandId: newId() }));
    await push();
    const refused = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(eq(syncQuarantine.type, GATE_EVENT_TYPE));
    expect(refused.map((r) => r.errorCode)).toEqual(['SYNC_BAND_ABSENT']);
  });
});

describe('the deny list names revoked bands (S2-12 round 2)', () => {
  it('carries a revoked band with its kind, since `bands` carries active ones only', async () => {
    await ctx.db.update(band).set({ status: 'revoked' }).where(eq(band.id, kidBandId));
    await agent.syncCache();
    const held = await store.readBundle(agent.state.boxId!, 'deny_list');
    const items = (
      held?.payload as { items: Array<{ revokedBands?: Array<{ id: string; kind: string }> }> }
    ).items;
    expect(items[0]!.revokedBands).toEqual(
      expect.arrayContaining([{ id: kidBandId, kind: 'kid', gateAccess: false }]),
    );
    expect(items[0]!.revokedBands!.some((b) => b.id === adultBandId)).toBe(false);
  });
});
