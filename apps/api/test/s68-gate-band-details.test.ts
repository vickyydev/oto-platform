import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, box, branch, sale, saleLine, station, ticketPackage, type Db } from '@oto/db';
import { bandValidUntil, newId } from '@oto/shared';
import {
  createBoxAgent,
  memoryCredentialStore,
  postgresBoxDriver,
  SqlBoxStore,
  type AgentFetch,
  type BoxAgent,
  type PgPoolLike,
} from '@oto/box-agent';
import { RECEPTION, createTestContext, signInAs, takeStation, teardownAll, type TestContext } from './helpers';
import { boxAuthFromRow, provisionVirtualBox } from '../src/services/box';
import { withBandGateDetails } from '../src/services/band-gate-details';
import { cacheBundle } from '../src/services/sync';

/**
 * SCRUM-68 — each band the box receives carries its ticket's label, its stay
 * label and `validUntil`, computed with the band print's own rule: the sale's
 * close + the line's stay hours + the extra play applied to that band. An
 * Add time on the till moves it on the box's next pull of the `bands` scope.
 */

let ctx: TestContext;
let db: Db;
let cookie: string;
let stationId: string;
let twoHoursId: string;
let agent: BoxAgent;
let store: SqlBoxStore;

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

async function admission() {
  await takeStation(ctx.app, cookie, stationId);
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { stationId, id: newId(), lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] },
  });
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().sale.id as string;
  const closed = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${id}/finalise`,
    headers: { cookie },
    payload: { actionId: newId() },
  });
  expect(closed.statusCode, closed.body).toBe(200);
  return id;
}

async function addHour(saleId: string, bandId: string) {
  const made = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/extensions`,
    headers: { cookie },
    payload: { actionId: newId(), stationId, optionId: 'ext-60', selection: { mode: 'bands', bandIds: [bandId] } },
  });
  expect(made.statusCode, made.body).toBe(200);
  const chargeId = made.json().sale.id as string;
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${chargeId}/finalise`,
    headers: { cookie },
    payload: { actionId: newId() },
  });
  expect(paid.statusCode, paid.body).toBe(200);
  expect(paid.json().finalised).toBe(true);
}

beforeAll(async () => {
  ctx = await createTestContext();
  db = ctx.db;
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  const tills = await db.select().from(station).where(and(eq(station.branchId, hkt!.id), eq(station.kind, 'till')));
  stationId = (tills.find((s) => s.codePrefix === 'T1') ?? tills[0]!).id;
  const packages = await db.select().from(ticketPackage).where(eq(ticketPackage.branchId, hkt!.id));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const pool = (db as unknown as { $client: PgPoolLike }).$client;
  store = new SqlBoxStore({ driver: postgresBoxDriver(pool) });
  agent = createBoxAgent({
    apiBaseUrl: 'http://s68-gate.test',
    credentials: memoryCredentialStore(),
    hostname: 's68-gate-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(db, ctx.app.log))?.claimCode ?? null,
    store,
    booth: { enabled: false },
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

describe('the bands scope carries each band its ticket, stay and end (SCRUM-68)', () => {
  it('computes validUntil with the band print rule, and an Add time on one band moves only that band', async () => {
    const saleId = await admission();
    const rows = await db.select().from(band).where(eq(band.saleId, saleId));
    expect(rows).toHaveLength(2);
    const [s] = await db.select().from(sale).where(eq(sale.id, saleId));
    const [line] = await db.select().from(saleLine).where(eq(saleLine.id, rows[0]!.saleLineId!));
    expect(line!.stayHours).toBeGreaterThan(0);
    const start = s!.finalisedAt ?? s!.occurredAt;
    const plain = bandValidUntil(start, line!.stayHours, 0)!.toISOString();

    const before = await withBandGateDetails(db, rows);
    for (const r of before) {
      // The ticket's name, not the unit's "Adults" / "Kids".
      expect(r.ticketLabel).toBe('2 Hours Play');
      expect(r.stayLabel).toBe(line!.stayDurationLabel ?? `${line!.stayHours} hours`);
      expect(r.validUntil).toBe(plain);
      // The band row is kept whole beside the new fields.
      expect(r.id).toBeTruthy();
      expect(r.kind).toMatch(/kid|adult/);
    }

    const adult = rows.find((r) => r.kind === 'adult')!;
    await addHour(saleId, adult.id);
    const after = new Map((await withBandGateDetails(db, rows)).map((r) => [r.id, r]));
    expect(after.get(adult.id)!.validUntil).toBe(new Date(Date.parse(plain) + 60 * 60_000).toISOString());
    expect(after.get(rows.find((r) => r.kind === 'kid')!.id)!.validUntil).toBe(plain);
  });

  it('a band with no line or no sale has no end and no ticket made up; no stay hours, no end', async () => {
    const saleId = await admission();
    const rows = await db.select().from(band).where(eq(band.saleId, saleId));
    const detailed = await withBandGateDetails(db, [
      { ...rows[0]!, saleLineId: null },
      { ...rows[0]!, saleId: null },
    ]);
    expect(detailed[0]).toMatchObject({ ticketLabel: null, stayLabel: null, validUntil: null });
    expect(detailed[1]!.validUntil).toBeNull();
    expect(detailed[1]!.ticketLabel).toBe('2 Hours Play');
    expect(await withBandGateDetails(db, [])).toEqual([]);
    // The rule itself: a line that sells no stay hours has no end.
    expect(bandValidUntil(new Date(), null, 60)).toBeNull();
    expect(bandValidUntil(new Date(), 0, 0)).toBeNull();
  });

  it('the box pulls the fields with its band copy, and its next pull carries an Add time', async () => {
    const saleId = await admission();
    const rows = await db.select().from(band).where(eq(band.saleId, saleId));
    const adult = rows.find((r) => r.kind === 'adult')!;
    await agent.syncCache();
    const held = await store.readBundle(agent.state.boxId!, 'bands');
    const items = (held?.payload as { items: Array<{ id: string; validUntil?: string; ticketLabel?: string }> }).items;
    const mine = items.find((i) => i.id === adult.id)!;
    expect(mine.ticketLabel).toBe('2 Hours Play');
    expect(Number.isFinite(Date.parse(mine.validUntil!))).toBe(true);

    // An Add time, then the box's own pull of the scope (the gate's `?scopes=bands`).
    await addHour(saleId, adult.id);
    const [row] = await db.select().from(box).where(eq(box.id, agent.state.boxId!));
    const pulled = await cacheBundle(db, boxAuthFromRow(row!), { scopes: ['bands'] });
    const moved = (pulled.scopes.bands!.items as Array<{ id: string; validUntil?: string }>).find(
      (i) => i.id === adult.id,
    )!;
    expect(Date.parse(moved.validUntil!)).toBe(Date.parse(mine.validUntil!) + 60 * 60_000);
  });
});
