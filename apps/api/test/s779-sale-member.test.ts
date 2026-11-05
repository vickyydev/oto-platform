import { and, eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, member, sale, saleTierClaim, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-779 — ONE SALE WHEN A WALK-IN WITH A TIER CLAIM BECOMES A MEMBER.
 *
 * Seen on staging on 5 November: reception checked a document for a walk-in
 * and priced the order at the Thai rate, the payment screen rang the sale up
 * as a walk-in priced by that claim, and the family's details — typed on the
 * customer display — were saved as a new member with the verification a
 * moment later. The till's Confirm then rang up a SECOND sale under the
 * member and the first stayed unpaid.
 *
 * Driven here exactly as the till drives it, through the real routes with a
 * real reception session: claim, quote, ring up, save the member and the
 * verification, then hand the member to the sale that is already open. One
 * sale exists afterwards; it carries the member, and nothing it was rung up
 * with — the tier, the claim that priced it, the money — has moved.
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;

const post = (url: string, payload: Record<string, unknown>, key: string = newId()) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie, 'idempotency-key': key }, payload });

/** A Thai-rate document check, a quote it prices and the walk-in sale rung up from it. */
async function walkInWithClaim(): Promise<{ saleId: string; actionId: string; gross: number }> {
  const actionId = newId();
  const claimed = await post('/sales/tier-claims', {
    actionId, branchId, toTier: 'thai', evidenceType: 'Driving licence', evidenceExpiresAt: '2099-12-31',
  });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const cartLine = { id: newId(), packageId: twoHoursId, kids: 1, adults: 1 };
  const quoted = await post('/sales/quote', { branchId, tierClaimActionId: actionId, lines: [cartLine] });
  expect(quoted.statusCode, quoted.body).toBe(200);
  const quote = quoted.json();
  expect(quote.tier).toBe('thai');
  expect(quote.tierSource).toBe('claim');
  const saleId = newId();
  const rungUp = await post('/sales', {
    id: saleId, stationId, branchId, tierClaimActionId: actionId, customerPhone: '+66812077900',
    lines: [{ ...cartLine, lineTotalSatang: quote.lineTotals[cartLine.id] }],
    expectedTotalSatang: quote.totals.grossSatang,
  });
  expect(rungUp.statusCode, rungUp.body).toBe(200);
  return { saleId, actionId, gross: quote.totals.grossSatang as number };
}

/** What the till's deferred save does with the display's details: a member, and the verification on them. */
async function memberFromDisplay(phone: string, nickname: string): Promise<string> {
  const created = await post('/members', { phone, nickname });
  expect(created.statusCode, created.body).toBe(200);
  const memberId = (created.json() as { member: { id: string } }).member.id;
  const verified = await post(`/members/${memberId}/tier-verification`, {
    toTier: 'thai', evidenceType: 'Driving licence', evidenceExpiresAt: '2099-12-31',
  });
  expect(verified.statusCode, verified.body).toBe(200);
  return memberId;
}

const attach = (saleId: string, memberId: string, key?: string) => post(`/sales/${saleId}/member`, { memberId }, key);

async function saleRow(saleId: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  return row!;
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const stations = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  const till = stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!;
  stationId = till.id;
  operatorId = till.operatorId;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the open sale takes the member', () => {
  it('leaves one sale, under the member, with its tier, its claim and its money as rung up', async () => {
    const { saleId, gross } = await walkInWithClaim();
    const before = await saleRow(saleId);
    expect(before.memberId).toBeNull();
    expect(before.customerTier).toBe('thai');
    expect(before.tierClaimId).not.toBeNull();

    const memberId = await memberFromDisplay('+66812077901', 'ZZ Nok');
    const res = await attach(saleId, memberId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      replay: false, saleId, memberId, status: 'tendering', customerTier: 'thai', tierClaimId: before.tierClaimId,
    });

    const after = await saleRow(saleId);
    expect(after.memberId).toBe(memberId);
    expect(after.customerTier).toBe('thai');
    expect(after.tierClaimId).toBe(before.tierClaimId);
    expect(after.grossSatang).toBe(gross);
    expect(after.status).toBe('tendering');
    // The claim still names the sale it paid for.
    const [claim] = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.id, before.tierClaimId!));
    expect(claim!.spentBySaleId).toBe(saleId);

    // The money is taken on that same sale, and it closes under the member.
    const paid = await post(`/sales/${saleId}/finalise`, {
      method: 'cash', kind: 'cash', amountSatang: gross, tenderedSatang: gross,
    });
    expect(paid.statusCode, paid.body).toBe(200);
    const closed = await saleRow(saleId);
    expect(closed.status).toBe('finalised');
    expect(closed.memberId).toBe(memberId);

    // ONE SALE: nothing else was rung up for this family, and nothing is left unpaid.
    const theirs = await ctx.db.select().from(sale).where(
      and(eq(sale.operatorId, operatorId), or(eq(sale.memberId, memberId), eq(sale.id, saleId))),
    );
    expect(theirs.map((row) => row.id)).toEqual([saleId]);

    const audits = await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.member_attach')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toEqual({ memberId: null });
    expect(audits[0]!.after).toMatchObject({ memberId, customerTier: 'thai', tierClaimId: before.tierClaimId, grossSatang: gross });
  });

  it('answers the same member again as a replay, and a replayed key with the same answer', async () => {
    const { saleId } = await walkInWithClaim();
    const memberId = await memberFromDisplay('+66812077902', 'ZZ Ploy');
    const key = newId();
    const first = await attach(saleId, memberId, key);
    expect(first.statusCode, first.body).toBe(200);
    const again = await attach(saleId, memberId, key);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    const fresh = await attach(saleId, memberId);
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().replay).toBe(true);
    expect(fresh.headers['x-oto-replay']).toBe('true');
    const audits = await ctx.db.select().from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.member_attach')));
    expect(audits).toHaveLength(1);
  });
});

describe('what the open sale will not take', () => {
  it('a different member once it has one', async () => {
    const { saleId } = await walkInWithClaim();
    const first = await memberFromDisplay('+66812077903', 'ZZ Fah');
    const second = await memberFromDisplay('+66812077904', 'ZZ Dao');
    expect((await attach(saleId, first)).statusCode).toBe(200);
    const res = await attach(saleId, second);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SALE_MEMBER_SET');
    expect((await saleRow(saleId)).memberId).toBe(first);
  });

  it('a member on a closed or voided sale', async () => {
    const memberId = await memberFromDisplay('+66812077905', 'ZZ Kaew');
    const closed = await walkInWithClaim();
    const paid = await post(`/sales/${closed.saleId}/finalise`, {
      method: 'cash', kind: 'cash', amountSatang: closed.gross, tenderedSatang: closed.gross,
    });
    expect(paid.statusCode, paid.body).toBe(200);
    const onClosed = await attach(closed.saleId, memberId);
    expect(onClosed.statusCode).toBe(409);
    expect(onClosed.json().error.code).toBe('SALE_FINALISED');

    const voided = await walkInWithClaim();
    expect((await post(`/sales/${voided.saleId}/void`, { reason: 'Customer changed their mind' })).statusCode).toBe(200);
    const onVoided = await attach(voided.saleId, memberId);
    expect(onVoided.statusCode).toBe(409);
    expect(onVoided.json().error.code).toBe('SALE_VOIDED');
    const rows = await ctx.db.select().from(sale).where(inArray(sale.id, [closed.saleId, voided.saleId]));
    expect(rows.every((row) => row.memberId === null)).toBe(true);
  });

  it('a member nobody has, and a sale the platform does not hold', async () => {
    const { saleId } = await walkInWithClaim();
    const unknown = await attach(saleId, newId());
    expect(unknown.statusCode).toBe(404);
    const [someone] = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId)).limit(1);
    const noSale = await attach(newId(), someone!.id);
    expect(noSale.statusCode).toBe(404);
    expect((await saleRow(saleId)).memberId).toBeNull();
  });
});
