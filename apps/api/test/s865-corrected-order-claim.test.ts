import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, member, sale, saleTierClaim, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import {
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
 * SCRUM-865 — A CORRECTED ORDER AFTER PAY, on the platform's side.
 *
 * The till rings the sale up at Pay, which spends the document check or hand
 * approval that priced it. When staff press Back, change the order and press
 * Pay again, the till now voids that first sale — reason "Order changed at the
 * till after Pay" — before it rings the corrected one up, and the void gives
 * the claim back. Between the change and the second Pay the till QUOTES the
 * corrected cart, and that quote must still price at the confirmed rate: the
 * claim is spent by this till's own unpaid sale, which is about to be voided.
 * The commit gets no such grace — the claim is spent with a conditional
 * update, so a corrected sale is written on it only once the first has let
 * go — and a first sale that took money keeps the claim, void or no void.
 *
 * Driven through the real routes as the till drives them, as a reception
 * session seated at Reception Till 1 (the claim records the session's till).
 */

let ctx: TestContext;
let cookie: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
let maliId: string;

const ORDER_CHANGED_AFTER_PAY = 'Order changed at the till after Pay';

const line = (packageId: string, kids: number, adults: number) => ({
  id: newId(),
  packageId,
  kids,
  adults,
});

/** The Thai rate confirmed at the till: a hand approval, as SCRUM-772 records it. */
const approveThai = async (): Promise<string> => {
  const actionId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales/tier-approvals',
    headers: { cookie },
    payload: { actionId, branchId, toTier: 'thai', reason: 'confirmed_at_till' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return actionId;
};

const quote = (payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie }, payload: { branchId, ...payload } });

const commit = (payload: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { id: newId(), stationId, branchId, ...payload },
  });

/** Ring the cart up at the figure the platform quoted for it, as the till does. */
const ringUp = async (payload: Record<string, unknown>, cartLine: ReturnType<typeof line>) => {
  const quoted = await quote({ ...payload, lines: [cartLine] });
  expect(quoted.statusCode, quoted.body).toBe(200);
  const committed = await commit({
    ...payload,
    lines: [{ ...cartLine, lineTotalSatang: quoted.json().lineTotals[cartLine.id] }],
    expectedTotalSatang: quoted.json().totals.grossSatang,
  });
  return { quoted: quoted.json(), committed };
};

const voidSale = (saleId: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/void`,
    headers: { cookie },
    payload: { reason: ORDER_CHANGED_AFTER_PAY },
  });

const finalise = (saleId: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie }, payload });

const claimRow = async (actionId: string) =>
  (await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId)))[0]!;

const saleRow = async (saleId: string) => (await ctx.db.select().from(sale).where(eq(sale.id, saleId)))[0]!;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  // Seated at the till, as a till session is: the claim records the station.
  await takeStation(ctx.app, cookie, stationId);
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  const members = await ctx.db.select().from(member).where(eq(member.operatorId, central!.operatorId));
  maliId = members.find((m) => m.phone === '+66811111111')!.id;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-865 — the first Pay spends the approval; the void gives it back; the corrected cart sells at the confirmed rate', () => {
  it('a member confirmed Thai by hand: quoted at Thai while the first sale is unpaid, refused at commit until it is voided, then sold at Thai', async () => {
    const actionId = await approveThai();
    const first = await ringUp({ memberId: maliId, tierClaimActionId: actionId }, line(twoHoursId, 1, 1));
    expect(first.committed.statusCode, first.committed.body).toBe(200);
    const firstSaleId = first.committed.json().sale.id as string;
    expect((await claimRow(actionId)).spentBySaleId).toBe(firstSaleId);

    // Back, change kids 1 -> 2: the corrected cart is quoted while the first
    // sale is still unpaid at this till. The approval still prices it, and
    // nothing is refused — the till is about to void that sale.
    const corrected = line(twoHoursId, 2, 1);
    const requoted = await quote({ memberId: maliId, tierClaimActionId: actionId, lines: [corrected] });
    expect(requoted.statusCode, requoted.body).toBe(200);
    expect(requoted.json().tier).toBe('thai');
    expect(requoted.json().tierSource).toBe('claim');
    expect(requoted.json().tierClaimRefusal).toBeNull();

    // The commit gets no grace: the claim is still spent by the first sale.
    const tooSoon = await commit({
      memberId: maliId,
      tierClaimActionId: actionId,
      lines: [{ ...corrected, lineTotalSatang: requoted.json().lineTotals[corrected.id] }],
      expectedTotalSatang: requoted.json().totals.grossSatang,
    });
    expect(tooSoon.statusCode, tooSoon.body).toBe(409);
    expect(tooSoon.json().error.code).toBe('TIER_CLAIM_SPENT');

    // The till voids the superseded sale, which gives the approval back...
    const voided = await voidSale(firstSaleId);
    expect(voided.statusCode, voided.body).toBe(200);
    expect((await claimRow(actionId)).spentBySaleId).toBeNull();

    // ...and the corrected cart commits at the Thai rate on the same approval.
    const sold = await commit({
      memberId: maliId,
      tierClaimActionId: actionId,
      lines: [{ ...corrected, lineTotalSatang: requoted.json().lineTotals[corrected.id] }],
      expectedTotalSatang: requoted.json().totals.grossSatang,
    });
    expect(sold.statusCode, sold.body).toBe(200);
    const soldRow = await saleRow(sold.json().sale.id);
    expect(soldRow.customerTier).toBe('thai');
    expect(soldRow.tierClaimId).toBe((await claimRow(actionId)).id);
    expect((await claimRow(actionId)).spentBySaleId).toBe(sold.json().sale.id);
    expect((await saleRow(firstSaleId)).status).toBe('voided');
  });

  it('a walk-in with no member yet is quoted at the confirmed rate too, from the claim', async () => {
    const actionId = await approveThai();
    const first = await ringUp({ tierClaimActionId: actionId }, line(twoHoursId, 1, 1));
    expect(first.committed.statusCode, first.committed.body).toBe(200);
    const corrected = line(twoHoursId, 2, 1);
    const requoted = await quote({ tierClaimActionId: actionId, lines: [corrected] });
    expect(requoted.statusCode, requoted.body).toBe(200);
    expect(requoted.json().tier).toBe('thai');
    expect(requoted.json().tierSource).toBe('claim');
    expect(requoted.json().tierClaimRefusal).toBeNull();
    // The quote with the till's own Thai figure is not a price mismatch either.
    const withFigure = await quote({
      tierClaimActionId: actionId,
      lines: [{ ...corrected, lineTotalSatang: requoted.json().lineTotals[corrected.id] }],
    });
    expect(withFigure.statusCode, withFigure.body).toBe(200);
    expect(withFigure.json().tier).toBe('thai');
  });

  it('a first sale that took money is not voided, and keeps the approval spent', async () => {
    const actionId = await approveThai();
    const first = await ringUp({ tierClaimActionId: actionId }, line(twoHoursId, 1, 1));
    expect(first.committed.statusCode, first.committed.body).toBe(200);
    const firstSaleId = first.committed.json().sale.id as string;
    const owed = first.committed.json().outstandingSatang as number;

    // Part of the money is taken on the first sale.
    const part = await finalise(firstSaleId, { method: 'cash', amountSatang: Math.floor(owed / 2) });
    expect(part.statusCode, part.body).toBe(200);
    expect(part.json().finalised).toBe(false);

    // The void is refused: money taken is refunded, not voided.
    const refused = await voidSale(firstSaleId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('SALE_HAS_PAYMENT');
    expect((await claimRow(actionId)).spentBySaleId).toBe(firstSaleId);
    expect((await saleRow(firstSaleId)).status).toBe('tendering');

    // And the corrected cart is told the approval is spent, at the default rate.
    const requoted = await quote({ tierClaimActionId: actionId, lines: [line(twoHoursId, 2, 1)] });
    expect(requoted.statusCode, requoted.body).toBe(200);
    expect(requoted.json().tier).toBe('tourist');
    expect(requoted.json().tierSource).toBe('default');
    expect(requoted.json().tierClaimRefusal?.code).toBe('TIER_CLAIM_SPENT');
  });

  it('a first sale that was paid keeps the approval spent for the next cart', async () => {
    const actionId = await approveThai();
    const first = await ringUp({ tierClaimActionId: actionId }, line(twoHoursId, 1, 1));
    expect(first.committed.statusCode, first.committed.body).toBe(200);
    const firstSaleId = first.committed.json().sale.id as string;
    const owed = first.committed.json().outstandingSatang as number;
    const paid = await finalise(firstSaleId, { method: 'cash', amountSatang: owed, tenderedSatang: owed });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(paid.json().sale.status).toBe('finalised');

    const next = await quote({ tierClaimActionId: actionId, lines: [line(twoHoursId, 1, 1)] });
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().tier).toBe('tourist');
    expect(next.json().tierClaimRefusal?.code).toBe('TIER_CLAIM_SPENT');
    expect(next.json().tierClaimRefusal?.details.saleId).toBe(firstSaleId);
  });
});
