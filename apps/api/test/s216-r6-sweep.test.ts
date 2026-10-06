import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { account, branch, discountDefinition, sale, station, ticketPackage } from '@oto/db';
import { businessDate, newId, parseDayStart } from '@oto/shared';
import {
  ADMIN,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-15b (SCRUM-216) round 6 — the closing sweep's repairs and its standing
 * check (plan docs/progress/plans/analytics/PLAN.md §8 round 6, §10).
 *
 *   the promo card  Admin > Reports > Wallet & Promo's promo-code card was the
 *                   last report figure read from this browser's mock sales:
 *                   each code's uses are counted from the platform's sales
 *                   (`GET /menu/discounts` `usedCount`, the count its limit is
 *                   held to) and the range's value read from the platform's
 *                   promo rows
 */

let ctx: TestContext | null = null;

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('S2-15b round 6 — the promo code card reads the platform, not this browser’s mock sales', () => {
  let db: TestContext;
  let admin: string;
  let reception: string;
  let operatorId: string;
  let hkt: string;
  let T: string;

  const get = (cookie: string, url: string) => db.app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: Record<string, unknown>) =>
    db.app.inject({ method: 'POST', url, headers: { cookie }, payload });

  beforeAll(async () => {
    ctx = await createTestContext();
    db = ctx;
    admin = await signInAs(db.app, ADMIN.phone, ADMIN.password);
    reception = await signInAs(db.app, RECEPTION.phone, RECEPTION.password);
    const [r] = await db.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
    operatorId = r!.operatorId;
    hkt = await branchIdByCode(db.db, CENTRAL_BRANCH_CODE);
    const [central] = await db.db.select().from(branch).where(eq(branch.id, hkt));
    T = businessDate(new Date(), central!.timezone, parseDayStart(central!.businessDayStart));
  }, 300_000);

  it('each code says how many finalised sales carried it, and the range’s promo rows carry its value', async () => {
    const code = 'R6SWEEP';
    await db.db.insert(discountDefinition).values({
      id: newId(),
      operatorId,
      code,
      label: 'Round 6 sweep',
      kind: 'percent',
      valueBp: 1_000,
      usageLimit: 10,
    });
    const [till] = await db.db
      .select({ id: station.id })
      .from(station)
      .where(and(eq(station.branchId, hkt), eq(station.name, 'Reception Till 1')));
    const [pkg] = await db.db
      .select({ id: ticketPackage.id })
      .from(ticketPackage)
      .where(and(eq(ticketPackage.branchId, hkt), eq(ticketPackage.name, '1 Hour Play')));
    await takeStation(db.app, reception, till!.id);
    const ring = async (): Promise<string> => {
      const id = newId();
      const res = await post(reception, '/sales', {
        id,
        stationId: till!.id,
        lines: [{ id: newId(), packageId: pkg!.id, kids: 1, adults: 1 }],
        promoCodes: [code],
        promos: [{ code, label: 'Round 6 sweep', type: 'percent', value: 10 }],
      });
      expect(res.statusCode, res.body).toBe(200);
      return id;
    };
    const kept = await ring();
    expect((await post(reception, `/sales/${kept}/finalise`, { actionId: newId(), method: 'cash' })).statusCode).toBe(200);
    // Rung up and walked away from: never a use.
    const dropped = await ring();
    expect((await post(reception, `/sales/${dropped}/void`, { reason: 'Guest left before paying' })).statusCode).toBe(200);

    const listed = await get(admin, '/menu/discounts');
    expect(listed.statusCode, listed.body).toBe(200);
    const menu = listed.json() as { discounts: Array<{ code: string; usedCount: number; usageLimit: number | null }> };
    expect(menu.discounts.find((d) => d.code === code)).toMatchObject({ usedCount: 1, usageLimit: 10 });

    const list = await get(admin, `/analytics/reports/discounts/transactions?branches=${hkt}&from=${T}&to=${T}`);
    expect(list.statusCode, list.body).toBe(200);
    const rows = (list.json() as { promoRows: Array<{ transactionId: string; code: string; amountSatang: number }> }).promoRows.filter(
      (r) => r.code === code,
    );
    const [keptRow] = await db.db.select({ receiptNumber: sale.receiptNumber }).from(sale).where(eq(sale.id, kept));
    expect(rows.map((r) => r.transactionId)).toEqual([keptRow!.receiptNumber]);
    expect(rows[0]!.amountSatang).toBeGreaterThan(0);
  });
});
