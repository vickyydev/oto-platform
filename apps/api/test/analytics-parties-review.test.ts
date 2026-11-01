import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { branch, hourlySummary, partyPayment, paymentAttempt, station } from '@oto/db';
import { addDaysToIsoDate, businessDate, newId, parseDayStart, type AnalyticsSummary } from '@oto/shared';
import { rollupDailyBranchDay, rollupHourlyBranchDay, type RollupBranchClock } from '../src/services/analytics-rollup';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/** SCRUM-508 adversarial review: the actual party tab must feed Performance.
 * P1 FIXED: sales-only rollups omit parties and their payments. Prescribed
 * fix: read the branch's events seam and party payment ledger in both rollups,
 * preserving analytics Q3's same-day timing and the existing sale arithmetic.
 */
let ctx: TestContext;
let clock: RollupBranchClock;
let date: string;
let cookie: string;
let till: string;
let takenAttempt: string;
const tenant = newId();
const appBranch = newId();
const party = newId();

async function event(id: string, day: string, type = 'birthday') {
  await ctx.db.execute(sql`insert into otoapp.core_events
    (id, tenant_id, branch_id, event_type, title, event_date, start_time, end_time,
     total_value, prepayment_amount, status)
    values (${id}, ${tenant}, ${appBranch}, ${type}, 'ZZ TEST Performance party', ${day},
      '13:00', '16:00', 10000, 1000, 'upcoming')`);
}

async function post(path: string, body: Record<string, unknown>) {
  const res = await ctx.app.inject({ method: 'POST', url: path, headers: { cookie },
    payload: { branchId: clock.id, stationId: till, ...body } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function pay(id: string, amount: number) {
  const paymentId = newId();
  await post(`/parties/${id}/payments`, { paymentId, amountSatang: amount,
    tender: { method: 'card', kind: 'card' } });
  const [row] = await ctx.db.select().from(partyPayment).where(eq(partyPayment.id, paymentId));
  return row!.paymentAttemptId;
}

async function summary() {
  await rollupDailyBranchDay(ctx.db, clock, date, new Date());
  const res = await ctx.app.inject({ method: 'GET', headers: { cookie },
    url: `/analytics/summary?branches=${clock.id}&from=${date}&to=${date}&group=total` });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as AnalyticsSummary).merged[0]!;
}

beforeAll(async () => {
  ctx = await createTestContext({ otoapp: true });
  const [b] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  clock = { id: b!.id, operatorId: b!.operatorId, timezone: b!.timezone,
    dayStartMinutes: parseDayStart(b!.businessDayStart), live: true };
  date = businessDate(new Date(), clock.timezone, clock.dayStartMinutes);
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [s] = await ctx.db.select().from(station).where(and(eq(station.branchId, clock.id), eq(station.codePrefix, 'T1')));
  till = s!.id;
  await ctx.db.execute(sql`insert into otoapp.tenants (id, name, slug) values (${tenant}, 'ZZ TEST', ${tenant})`);
  await ctx.db.execute(sql`insert into otoapp.branches (id, tenant_id, name, address, core_branch_id)
    values (${appBranch}, ${tenant}, 'ZZ TEST Performance', 'ZZ TEST', ${clock.id})`);
  await event(party, date);
  await post(`/parties/${party}/charges`, { chargeId: newId(), kind: 'fnb', totalSatang: 50000,
    items: [{ name: 'ZZ TEST snacks', qty: 1, lineTotalSatang: 50000 }] });
  takenAttempt = await pay(party, 25000);
  // Stable local hour, including when the suite runs before the day start.
  await ctx.db.update(paymentAttempt).set({ paidAt: new Date(`${date}T13:15:00+07:00`) }).where(eq(paymentAttempt.id, takenAttempt));
}, 300000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-508 party source and Q3 timing', () => {
  it('P1 FIXED: a real party charge and payment makes Parties today 1 and contributes its takings', async () => {
    expect(await summary()).toMatchObject({ partiesCount: 1, partiesSatang: 25000, revenueSatang: 25000, txnCount: 1,
      fnbSatang: 0, guestsKids: 0, vatSatang: 0 });
  });

  it('P1 FIXED: the hourly chart includes the same party money as the daily headline', async () => {
    await rollupHourlyBranchDay(ctx.db, clock, date, new Date());
    const hours = await ctx.db.select().from(hourlySummary).where(and(eq(hourlySummary.branchId, clock.id), eq(hourlySummary.businessDate, date)));
    expect(hours).toHaveLength(1);
    expect(hours[0]).toMatchObject({ hour: 13, partiesSatang: 25000, revenueSatang: 25000, txnCount: 1, guests: 0 });
  });

  it('P1 FIXED: earlier deposits, future parties, camps and unpaid charges do not inflate today', async () => {
    const earlier = await pay(party, 15000);
    await ctx.db.update(paymentAttempt).set({ businessDate: addDaysToIsoDate(date, -1),
      paidAt: new Date(`${addDaysToIsoDate(date, -1)}T13:15:00+07:00`) }).where(eq(paymentAttempt.id, earlier));
    const future = newId();
    await event(future, addDaysToIsoDate(date, 1));
    await pay(future, 35000);
    await event(newId(), date, 'camp');
    expect(await summary()).toMatchObject({ partiesCount: 1, partiesSatang: 25000, revenueSatang: 25000, txnCount: 1 });
  });

  it('a second rollup of identical inputs writes nothing', async () => {
    await summary();
    expect(await rollupDailyBranchDay(ctx.db, clock, date, new Date())).toBe('unchanged');
  });

  it('an unpaid party counts once, regardless of its status, but contributes no money', async () => {
    const unpaid = newId();
    await event(unpaid, date);
    await ctx.db.execute(sql`update otoapp.core_events set status = 'cancelled' where id = ${unpaid}`);
    expect(await summary()).toMatchObject({ partiesCount: 2, partiesSatang: 25000, txnCount: 1 });
    await ctx.db.execute(sql`update otoapp.core_events set is_archived = true, archived_at = now() where id = ${unpaid}`);
    expect(await summary()).toMatchObject({ partiesCount: 1, partiesSatang: 25000, txnCount: 1 });
  });

  it('the confirmed party date wins over the date captured on its old payments', async () => {
    await ctx.db.execute(sql`update otoapp.core_events set event_date = ${addDaysToIsoDate(date, 1)} where id = ${party}`);
    expect(await summary()).toMatchObject({ partiesCount: 0, partiesSatang: 0, revenueSatang: 0, txnCount: 0 });
    await ctx.db.execute(sql`update otoapp.core_events set event_date = ${date} where id = ${party}`);
    expect(await summary()).toMatchObject({ partiesCount: 1, partiesSatang: 25000, txnCount: 1 });
  });

  it('another branch cannot contribute parties or payments', async () => {
    const [other] = await ctx.db.select().from(branch).where(eq(branch.code, 'robinson-chalong'));
    await ctx.db.execute(sql`update otoapp.branches set core_branch_id = ${other!.id} where id = ${appBranch}`);
    expect(await summary()).toMatchObject({ partiesCount: 0, partiesSatang: 0, txnCount: 0 });
    await ctx.db.execute(sql`update otoapp.branches set core_branch_id = ${clock.id} where id = ${appBranch}`);
    // A malformed imported link must not pull another branch's tender in.
    await ctx.db.update(paymentAttempt).set({ branchId: other!.id }).where(eq(paymentAttempt.id, takenAttempt));
    expect(await summary()).toMatchObject({ partiesCount: 1, partiesSatang: 0, txnCount: 0 });
    await ctx.db.update(paymentAttempt).set({ branchId: clock.id }).where(eq(paymentAttempt.id, takenAttempt));
  });

  it('a cancelled tender disappears from both daily and hourly figures', async () => {
    const payments = await ctx.db.select().from(partyPayment).where(eq(partyPayment.otoappEventId, party));
    for (const paid of payments) {
      await ctx.db.update(paymentAttempt).set({ status: 'cancelled' }).where(eq(paymentAttempt.id, paid.paymentAttemptId));
    }
    expect(await summary()).toMatchObject({ partiesCount: 1, partiesSatang: 0, revenueSatang: 0, txnCount: 0 });
    await rollupHourlyBranchDay(ctx.db, clock, date, new Date());
    expect(await ctx.db.select().from(hourlySummary).where(and(eq(hourlySummary.branchId, clock.id), eq(hourlySummary.businessDate, date)))).toHaveLength(0);
  });
});
