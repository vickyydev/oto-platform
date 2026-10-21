import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { account, branch, schema, session } from '@oto/db';
import { newId } from '@oto/shared';
import { OverviewSchema } from '../src/routes/console';
import { overviewOf, overviewScopeOf, type OverviewSnapshot } from '../src/services/console';
import type { EffectivePermission } from '../src/services/permissions';
import {
  ADMIN, BRANCH_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN,
  createTestContext, signInAs, teardownAll, type TestContext,
} from './helpers';

let ctx: TestContext;
let admin: string;
let manager: string;
let reception: string;
let central: string;
let chalong: string;
let foreign: string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const rows = await ctx.db.select().from(branch);
  central = rows.find((b) => b.code === 'hkt-central')!.id;
  chalong = rows.find((b) => b.code === 'robinson-chalong')!.id;
  foreign = rows.find((b) => b.code === 'second-operator-1')!.id;
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('Overview existing-source figures', () => {
  const now = new Date('2026-07-15T12:00:00Z');
  const computed = new Date('2026-07-15T11:58:00Z');
  const parkA = newId();
  const parkB = newId();
  let operatorId: string;
  let effective: EffectivePermission[];
  let snapshot: OverviewSnapshot;

  beforeAll(async () => {
    const [home] = await ctx.db.select().from(branch).where(eq(branch.id, central));
    operatorId = home!.operatorId;
    effective = [{ permission: 'console:overview:read', scopeType: 'operator', scopeId: operatorId, roleName: 'overview only' }];
    await ctx.db.insert(branch).values([
      { id: parkA, operatorId, name: 'ZZ TEST Overview west', code: 'zz-overview-west', timezone: 'Pacific/Honolulu', openingHours: {}, createdAt: new Date('2026-01-01Z') },
      { id: parkB, operatorId, name: 'ZZ TEST Overview east', code: 'zz-overview-east', timezone: 'Pacific/Kiritimati', openingHours: {}, createdAt: new Date('2026-01-01Z') },
    ]);
    await ctx.db.insert(schema.dailySummary).values([
      { id: newId(), operatorId, branchId: parkA, businessDate: '2026-07-14', source: 'pisell', formulaVersion: 30, frozen: true, computedAt: computed, revenueSatang: 321_000, guestsKids: 4, guestsAdults: 2, inputFingerprint: 'zz-overview-a' },
      { id: newId(), operatorId, branchId: parkA, businessDate: '2026-07-14', formulaVersion: 1, computedAt: computed, revenueSatang: 999_000, ticketsSatang: 999_000, inputFingerprint: 'zz-overview-wrong-source' },
      { id: newId(), operatorId, branchId: parkB, businessDate: '2026-07-15', formulaVersion: 1, provisional: true, computedAt: computed, revenueSatang: 123_000, ticketsSatang: 123_000, guestsKids: 5, guestsAdults: 2, inputFingerprint: 'zz-overview-b' },
    ]);
    await ctx.db.insert(schema.branchSourceSwitch).values({ id: newId(), operatorId, branchId: parkA, source: 'pisell', preference: 'legacy', switchedAt: computed });
    await ctx.db.insert(schema.booking).values([
      { id: newId(), operatorId, branchId: parkA, reference: 'ZZ-OVERVIEW-1', bookingDate: '2026-07-14', status: 'pending' },
      { id: newId(), operatorId, branchId: parkA, reference: 'ZZ-OVERVIEW-2', bookingDate: '2026-07-14', status: 'cancelled' },
      { id: newId(), operatorId, branchId: parkA, reference: 'ZZ-OVERVIEW-WRONG-DAY', bookingDate: '2026-07-15' },
      { id: newId(), operatorId, branchId: parkB, reference: 'ZZ-OVERVIEW-3', bookingDate: '2026-07-15' },
    ]);
    const channel = newId();
    await ctx.db.insert(schema.channelAccount).values({ id: channel, operatorId, channel: 'whatsapp', provider: 'simulator', externalId: 'ZZ TEST overview', displayName: 'ZZ TEST overview' });
    async function thread(branchId: string | null, shape: { lastCustomerMessageAt?: Date; lastStaffMessageAt?: Date; lastRoutedAt?: Date; status?: 'handled'; handledAt?: Date }) {
      const contactId = newId();
      await ctx.db.insert(schema.contact).values({ id: contactId, operatorId, channel: 'whatsapp', externalHandle: contactId, displayName: 'ZZ TEST overview' });
      await ctx.db.insert(schema.conversation).values({ id: newId(), operatorId, branchId, channelAccountId: channel, contactId, ...shape });
    }
    await thread(parkA, { lastCustomerMessageAt: computed });
    await thread(parkA, { lastCustomerMessageAt: computed });
    await thread(parkA, { lastCustomerMessageAt: computed, lastStaffMessageAt: now });
    await thread(parkA, { lastCustomerMessageAt: computed, status: 'handled', handledAt: now });
    await thread(parkB, { lastRoutedAt: computed });
    await thread(null, { lastCustomerMessageAt: computed });
    await ctx.db.insert(schema.alert).values([
      { id: newId(), key: 'ZZ TEST overview-a', category: 'test', subject: 'ZZ TEST overview', summary: 'ZZ TEST overview', operatorId, branchId: parkA },
      { id: newId(), key: 'ZZ TEST overview-acknowledged', category: 'test', subject: 'ZZ TEST overview', summary: 'ZZ TEST overview', operatorId, branchId: parkA, status: 'acknowledged', acknowledgedAt: computed },
      { id: newId(), key: 'ZZ TEST overview-resolved', category: 'test', subject: 'ZZ TEST overview', summary: 'ZZ TEST overview', operatorId, branchId: parkA, status: 'resolved', resolvedAt: computed },
      { id: newId(), key: 'ZZ TEST overview-b', category: 'test', subject: 'ZZ TEST overview', summary: 'ZZ TEST overview', operatorId, branchId: parkB },
      { id: newId(), key: 'ZZ TEST overview-operator', category: 'test', subject: 'ZZ TEST overview', summary: 'ZZ TEST overview', operatorId },
      { id: newId(), key: 'ZZ TEST overview-platform', category: 'test', subject: 'ZZ TEST overview', summary: 'ZZ TEST overview' },
    ]);
    const boxId = newId();
    await ctx.db.insert(schema.box).values([
      { id: boxId, operatorId, branchId: parkA, name: 'ZZ TEST offline after hours', slot: 'zz-offline', status: 'offline', registeredAt: computed, lastHeartbeatAt: computed },
      { id: newId(), operatorId, branchId: parkA, name: 'ZZ TEST disabled', slot: 'zz-disabled', status: 'disabled', registeredAt: computed },
      { id: newId(), operatorId, branchId: parkA, name: 'ZZ TEST archived offline', slot: 'zz-archived', status: 'offline', archivedAt: computed },
    ]);
    const stationId = newId();
    const saleId = newId();
    const adultBandId = newId();
    const [actor] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, ADMIN.phone));
    await ctx.db.insert(schema.station).values({ id: stationId, operatorId, branchId: parkA, boxId, name: 'ZZ TEST gate', kind: 'gate', codePrefix: 'ZZOV' });
    await ctx.db.insert(schema.sale).values({
      id: saleId, operatorId, branchId: parkA, stationId, createdByAccountId: actor!.id,
      businessDate: '2026-07-14', businessDayStart: '05:00', timezone: 'Pacific/Honolulu', occurredAt: computed,
      pricingMode: 'weekday', pricingModeReason: 'ZZ TEST', customerTier: 'tourist', engineVersion: 'ZZ TEST', taxConfig: {}, taxBreakdown: {},
    });
    await ctx.db.insert(schema.band).values([
      { id: adultBandId, operatorId, branchId: parkA, saleId, kind: 'adult', gateAccess: true, code: 'ZZ TEST overview adult' },
      { id: newId(), operatorId, branchId: parkA, saleId, kind: 'kid', code: 'ZZ TEST overview child' },
    ]);
    await ctx.db.insert(schema.bandEvent).values({ id: newId(), bandId: adultBandId, stationId, boxId, kind: 'entry', createdAt: computed });
    snapshot = await overviewOf(ctx.db, { operatorId, effective, now });
  });

  it('reads all seven totals from existing rules with only the overview grant', () => {
    expect(snapshot.parks.find((p) => p.branchId === parkA)).toMatchObject({
      revenueSatang: 321_000, guests: 6, inParkNow: 2, bookingsToday: 2,
      inboxUnanswered: 2, openAlerts: 2, boxesOffline: 1,
    });
    expect(snapshot.totals).toMatchObject({ revenueSatang: 444_000, guests: 13, inParkNow: 2, bookingsToday: 3, inboxUnanswered: 3, openAlerts: 3 });
    expect(OverviewSchema.safeParse(snapshot).success).toBe(true);
  });

  it('preserves each park’s business day, selected source and rollup and gate freshness', () => {
    expect(snapshot.parks.find((p) => p.branchId === parkA)).toMatchObject({
      businessDate: '2026-07-14', analyticsSource: 'pisell', provisional: false, lastRolledUpAt: computed.toISOString(), occupancyAsOf: computed.toISOString(), occupancyStale: false,
    });
    expect(snapshot.parks.find((p) => p.branchId === parkB)).toMatchObject({
      businessDate: '2026-07-15', analyticsSource: 'oto_pos', provisional: true, lastRolledUpAt: computed.toISOString(), occupancyAsOf: null, occupancyStale: true,
    });
  });

  it('filters every figure to the selected park and excludes operator/platform or unassigned counts', async () => {
    const single = await overviewOf(ctx.db, { operatorId, effective, now, branchId: parkA });
    expect(single.selectedBranchIds).toEqual([parkA]);
    expect(single.parks).toHaveLength(1);
    expect(single.totals).toEqual({ revenueSatang: 321_000, guests: 6, inParkNow: 2, bookingsToday: 2, inboxUnanswered: 2, openAlerts: 2, boxesOffline: 1 });
  });

  it('keeps signed satang compatible with the analytics response contract', () => {
    expect(OverviewSchema.safeParse({ ...snapshot, totals: { ...snapshot.totals, revenueSatang: -100 } }).success).toBe(true);
  });

  it('does not turn a failed source query into an empty successful total', async () => {
    const failure = new Error('ZZ TEST source unavailable');
    const failingDb = { select() { throw failure; } } as unknown as typeof ctx.db;
    await expect(overviewOf(failingDb, { operatorId, effective, now })).rejects.toBe(failure);
  });

  it('resolves branch reach and archives before any figures are loaded', () => {
    const live = { id: parkA, name: 'ZZ TEST live', timezone: 'Pacific/Honolulu', businessDayStart: '05:00', archivedAt: null, createdAt: computed };
    const archived = { ...live, id: parkB, archivedAt: computed };
    const branchGrant: EffectivePermission[] = [{ permission: 'console:overview:read', scopeType: 'branch', scopeId: parkA, roleName: 'ZZ TEST branch' }];
    expect(overviewScopeOf({ branches: [live, archived], operatorId, effective: branchGrant })).toEqual({ available: [live], selected: [live] });
    expect(() => overviewScopeOf({ branches: [live], operatorId, effective: [] })).toThrow('Missing permission console:overview:read');
  });
});

describe('GET /overview access', () => {
  it('requires a signed-in overview reader and validates its park filter', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/overview' })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/overview', headers: { cookie: reception } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/overview?branchId=not-a-uuid', headers: { cookie: admin } })).statusCode).toBe(400);
  });

  it('answers only the branch manager’s grant reach, independently of the session seat', async () => {
    const [reader] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, BRANCH_MANAGER.phone));
    await ctx.db.update(session).set({ branchId: chalong }).where(eq(session.accountId, reader!.id));
    const res = await ctx.app.inject({ method: 'GET', url: '/overview', headers: { cookie: manager } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().selectedBranchIds).toEqual([central]);
    expect(res.json().branches.map((b: { id: string }) => b.id)).toEqual([central]);
    const upper = await ctx.app.inject({ method: 'GET', url: `/overview?branchId=${central.toUpperCase()}`, headers: { cookie: manager } });
    expect(upper.statusCode, upper.body).toBe(200);
    expect(upper.json().selectedBranchIds).toEqual([central]);
    expect((await ctx.app.inject({ method: 'GET', url: `/overview?branchId=${chalong}`, headers: { cookie: manager } })).statusCode).toBe(403);
  });

  it('hides foreign, absent and archived parks without disclosing their names', async () => {
    const other = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
    for (const cookie of [admin, manager]) {
      const res = await ctx.app.inject({ method: 'GET', url: `/overview?branchId=${foreign}`, headers: { cookie } });
      expect(res.statusCode, res.body).toBe(404);
    }
    expect((await ctx.app.inject({ method: 'GET', url: `/overview?branchId=${central}`, headers: { cookie: other } })).statusCode).toBe(404);
    await ctx.db.update(branch).set({ archivedAt: new Date() }).where(eq(branch.id, chalong));
    expect((await ctx.app.inject({ method: 'GET', url: `/overview?branchId=${chalong}`, headers: { cookie: admin } })).statusCode).toBe(404);
    await ctx.db.update(branch).set({ archivedAt: null }).where(eq(branch.id, chalong));
  });
});
