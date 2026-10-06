import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  memberTierVerification,
  product,
  sale,
  saleLine,
  saleTierClaim,
  stockItem,
  stockLevel,
  stockLocation,
  station,
  ticketPackage,
} from '@oto/db';
import { newId } from '@oto/shared';
import { refundSale, type RefundActor } from '../src/services/refunds';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  OTO_OPERATOR_NAME,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * SCRUM-494 unit "money" — register entries 1, 2 and 3, through the real
 * routes and the refund service, with the database read back.
 *
 *   1. A tier verification needs no document expiry (VerifyTierModal.tsx:43
 *      in the approved design: proof type only). A recorded expiry that has
 *      passed keeps the rate and raises `reverifyDue`; the member's sales go
 *      through at the rate the till shows.
 *   2. The tier staff pick is honoured downwards: a verified member sold at the
 *      default tier (StepCustomerType, Till.tsx handlePickTier) is priced at
 *      it. A tier the member is not verified for prices nothing.
 *   3. Restock on the design's full-scope rule (RefundModal.tsx:95-97,
 *      mockApi.ts:2884-2950).
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let receptionId: string;
let twoHoursId: string;
let memberId: string;
const productIds = new Map<string, string>();

const ticketLine = (kids: number, adults: number, addOns: unknown[] = []) => ({
  id: newId(),
  packageId: twoHoursId,
  kids,
  adults,
  ...(addOns.length ? { addOns } : {}),
});

async function quote(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie }, payload: { branchId, ...payload } });
}

async function commit(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { stationId, branchId, ...payload },
  });
}

async function finalise(saleId: string) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie } });
}

/** What one size of a product holds across the branch's places. */
async function held(code: string, variantId: string | null = null): Promise<number> {
  const rows = await ctx.db
    .select({ quantity: stockLevel.quantity })
    .from(stockLevel)
    .innerJoin(stockItem, eq(stockItem.id, stockLevel.stockItemId))
    .innerJoin(stockLocation, eq(stockLocation.id, stockLevel.stockLocationId))
    .where(
      and(
        eq(stockItem.productId, productIds.get(code)!),
        eq(stockItem.branchId, branchId),
        variantId === null ? sql`${stockItem.variantId} is null` : eq(stockItem.variantId, variantId),
      ),
    );
  return rows.reduce((sum, r) => sum + r.quantity, 0);
}

const actor = (): RefundActor => ({
  accountId: receptionId,
  operatorId,
  stationId,
  assertBranchAllowed: async () => {},
  assertCanApprove: async () => {},
});

async function linesOf(saleId: string) {
  return ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  stationId = (stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!).id;
  const [reception] = await ctx.db
    .select()
    .from(account)
    .where(and(eq(account.operatorId, operatorId), eq(account.phone, RECEPTION.phone)));
  receptionId = reception!.id;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  for (const p of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (p.code) productIds.set(p.code, p.id);
  }

  const created = await ctx.app.inject({
    method: 'POST',
    url: '/members',
    headers: { cookie },
    payload: { phone: '0634940494', nickname: 'Tier Money' },
  });
  expect(created.statusCode, created.body).toBeLessThan(300);
  memberId = created.json().member.id as string;
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('s494 money — entry 1: a verification needs no expiry and does not lapse', () => {
  it('records a verification with the proof type only, audited', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { toTier: 'expat', evidenceType: 'Passport' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().member.tierCode).toBe('expat');
    expect(res.json().member.tierVerification).toMatchObject({
      tier: 'expat',
      proofType: 'Passport',
      expiresAt: null,
      reverifyDue: false,
    });
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'member.tier_verify'), eq(auditLog.operatorId, operatorId)));
    expect(audits.some((a) => (a.after as { memberId?: string }).memberId === memberId)).toBe(true);
  });

  it('still refuses a document whose recorded expiry has already passed', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { toTier: 'expat', evidenceType: 'Passport', evidenceExpiresAt: '2020-01-01' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expired/i);
  });

  it('keeps the rate when a recorded expiry passes, flags re-verify, and the sale goes through', async () => {
    // As if the document checked last year had an expiry that has since passed.
    await ctx.db
      .update(memberTierVerification)
      .set({ evidenceExpiresAt: new Date('2024-01-01T00:00:00Z') })
      .where(eq(memberTierVerification.memberId, memberId));

    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0634940494',
      headers: { cookie },
    });
    expect(lookup.json().member.tierVerification).toMatchObject({
      tier: 'expat',
      expiresAt: '2024-01-01',
      reverifyDue: true,
    });

    // The till auto-applies the verified tier it was shown; the platform agrees.
    const cartLine = ticketLine(2, 1);
    const quoted = await quote({ memberId, tier: 'expat', lines: [cartLine] });
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect(quoted.json()).toMatchObject({ tier: 'expat', tierSource: 'member' });

    const saleId = newId();
    const committed = await commit({
      id: saleId,
      memberId,
      tier: 'expat',
      lines: [{ ...cartLine, lineTotalSatang: quoted.json().lineTotals[cartLine.id] }],
      expectedTotalSatang: quoted.json().totals.grossSatang,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.customerTier).toBe('expat');
  });
});

describe('s494 money — entry 1, walk-in: a tier claim needs no expiry either', () => {
  async function claim(payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/sales/tier-claims',
      headers: { cookie, 'idempotency-key': newId() },
      payload: { branchId, toTier: 'thai', evidenceType: 'Residence certificate', ...payload },
    });
  }

  it('records a claim with the proof type only, audited, and it prices the walk-in sale', async () => {
    const actionId = newId();
    const res = await claim({ actionId });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().claim).toMatchObject({ toTier: 'thai', evidenceExpiresAt: null });

    // The same tap again is the same claim, not a second decision.
    const again = await claim({ actionId });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().claim.id).toBe(res.json().claim.id);

    const [row] = await ctx.db.select().from(saleTierClaim).where(eq(saleTierClaim.actionId, actionId));
    expect(row!.evidenceExpiresAt).toBeNull();
    const trail = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'sale_tier_claim'), eq(auditLog.actionId, actionId)));
    expect(trail).toHaveLength(1);
    expect((trail[0]!.after as { evidenceExpiresAt: unknown }).evidenceExpiresAt).toBeNull();

    const cartLine = ticketLine(2, 1);
    const quoted = await quote({ tier: 'thai', tierClaimActionId: actionId, lines: [cartLine] });
    expect(quoted.statusCode, quoted.body).toBe(200);
    expect(quoted.json()).toMatchObject({ tier: 'thai', tierSource: 'claim' });

    const saleId = newId();
    const committed = await commit({
      id: saleId,
      tier: 'thai',
      tierClaimActionId: actionId,
      lines: [{ ...cartLine, lineTotalSatang: quoted.json().lineTotals[cartLine.id] }],
      expectedTotalSatang: quoted.json().totals.grossSatang,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const [sold] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(sold!.customerTier).toBe('thai');
    expect(sold!.tierClaimId).toBe(row!.id);
  });

  it('still refuses a claim on a document whose recorded expiry has already passed', async () => {
    const res = await claim({ actionId: newId(), evidenceExpiresAt: '2020-01-01' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/expired/i);
  });
});

describe('s494 money — entry 2: the tier staff pick is honoured downwards only', () => {
  it('prices a verified member at the default (Tourist) rate when staff pick it', async () => {
    const cartLine = ticketLine(2, 1);
    const expat = await quote({ memberId, tier: 'expat', lines: [cartLine] });
    const tourist = await quote({ memberId, tier: 'tourist', lines: [cartLine] });
    expect(tourist.statusCode, tourist.body).toBe(200);
    expect(tourist.json()).toMatchObject({ tier: 'tourist', tierSource: 'default' });
    expect(tourist.json().disagreements.tierDiffers).toBe(false);
    expect(tourist.json().totals.grossSatang).toBeGreaterThan(expat.json().totals.grossSatang);

    const saleId = newId();
    const committed = await commit({
      id: saleId,
      memberId,
      tier: 'tourist',
      lines: [{ ...cartLine, lineTotalSatang: tourist.json().lineTotals[cartLine.id] }],
      expectedTotalSatang: tourist.json().totals.grossSatang,
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.customerTier).toBe('tourist');
    expect(row!.memberId).toBe(memberId);
    // The member's verified tier is untouched by the pick.
    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/members/lookup?phone=0634940494',
      headers: { cookie },
    });
    expect(lookup.json().member.tierCode).toBe('expat');
  });

  it('does not price a tier the member is not verified for', async () => {
    const cartLine = ticketLine(2, 1);
    const thai = await quote({ memberId, tier: 'thai', lines: [cartLine] });
    expect(thai.statusCode, thai.body).toBe(200);
    expect(thai.json()).toMatchObject({ tier: 'expat', tierSource: 'member' });
    expect(thai.json().disagreements.tierDiffers).toBe(true);

    // A line priced at another rate than the member's is refused, not charged.
    const tourist = await quote({ memberId, tier: 'tourist', lines: [cartLine] });
    const refused = await commit({
      id: newId(),
      memberId,
      tier: 'thai',
      lines: [{ ...cartLine, lineTotalSatang: tourist.json().lineTotals[cartLine.id] }],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SALE_LINE_PRICE_MISMATCH');
  });
});

describe('s494 money — entry 3: restock on the full-scope rule', () => {
  const socks = () => ({
    id: productIds.get('AO-GRIPSOCKS')!,
    quantity: 2,
    variantBreakdown: [
      { variantId: 's', quantity: 1, variantLabel: 'S' },
      { variantId: 'm', quantity: 1, variantLabel: 'M' },
    ],
  });

  async function ticketSaleWithSocks(): Promise<string> {
    const saleId = newId();
    const res = await commit({ id: saleId, lines: [ticketLine(1, 1, [socks()])] });
    expect(res.statusCode, res.body).toBe(200);
    expect((await finalise(saleId)).statusCode).toBe(200);
    return saleId;
  }

  it('a whole refund after a by-item refund of the socks returns the socks once', async () => {
    const before = { s: await held('AO-GRIPSOCKS', 's'), m: await held('AO-GRIPSOCKS', 'm') };
    const saleId = await ticketSaleWithSocks();
    expect(await held('AO-GRIPSOCKS', 's')).toBe(before.s - 1);
    const addon = (await linesOf(saleId)).find((l) => l.kind === 'addon')!;

    // Partial, by item: covers the socks line's money, returns nothing yet.
    const partial = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'items', lineIds: [addon.id], reason: 'Wrong size' }),
    );
    expect(partial.refund.lines).toEqual([expect.objectContaining({ saleLineId: addon.id, restock: false })]);
    expect(await held('AO-GRIPSOCKS', 's')).toBe(before.s - 1);

    // Whole: full scope, so the socks an earlier refund covered go back now.
    const whole = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'whole', reason: 'Guest left' }),
    );
    expect(whole.refundStatus).toBe('refunded');
    expect(whole.refund.lines).toContainEqual(
      expect.objectContaining({ saleLineId: addon.id, restock: true, restockOnly: true, grossSatang: 0 }),
    );
    expect(await held('AO-GRIPSOCKS', 's')).toBe(before.s);
    expect(await held('AO-GRIPSOCKS', 'm')).toBe(before.m);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.refund')));
    expect(audits).toHaveLength(2);
  });

  it('a by-item ticket refund that takes the whole remainder restocks', async () => {
    const before = await held('AO-GRIPSOCKS', 'm');
    const saleId = await ticketSaleWithSocks();
    const ids = (await linesOf(saleId)).filter((l) => l.quantity > 0).map((l) => l.id);
    const res = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'items', lineIds: ids, reason: 'Closed early' }),
    );
    expect(res.refundStatus).toBe('refunded');
    expect(await held('AO-GRIPSOCKS', 'm')).toBe(before);
  });

  it('a custom refund of the full remainder of a ticket sale restocks', async () => {
    const before = await held('AO-GRIPSOCKS', 's');
    const saleId = await ticketSaleWithSocks();
    const gross = (await ctx.db.select().from(sale).where(eq(sale.id, saleId)))[0]!.grossSatang;
    const res = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'custom', amountSatang: gross, reason: 'Unwell' }),
    );
    expect(res.refundStatus).toBe('refunded');
    expect(res.refund.amountSatang).toBe(gross);
    expect(await held('AO-GRIPSOCKS', 's')).toBe(before);
  });

  it('a shop sale: by-item returns its line, a custom full refund returns the rest, never twice', async () => {
    const cap = await held('MR-CAP');
    const bottle = await held('MR-BOTTLE');
    const saleId = newId();
    const res = await commit({
      id: saleId,
      items: [
        { id: newId(), productId: productIds.get('MR-CAP')!, quantity: 2 },
        { id: newId(), productId: productIds.get('MR-BOTTLE')!, quantity: 1 },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await finalise(saleId)).statusCode).toBe(200);
    expect(await held('MR-CAP')).toBe(cap - 2);
    const capLine = (await linesOf(saleId)).find((l) => l.productId === productIds.get('MR-CAP'))!;

    await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'items', lineIds: [capLine.id], reason: 'Wrong colour' }),
    );
    expect(await held('MR-CAP')).toBe(cap);
    expect(await held('MR-BOTTLE')).toBe(bottle - 1);

    const rest = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'custom', amountSatang: 10_000_000, reason: 'Unhappy' }),
    );
    expect(rest.refundStatus).toBe('refunded');
    expect(await held('MR-CAP')).toBe(cap);
    expect(await held('MR-BOTTLE')).toBe(bottle);
  });

  it('a partial custom refund returns nothing', async () => {
    const before = await held('AO-GRIPSOCKS', 'm');
    const saleId = await ticketSaleWithSocks();
    const res = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'custom', amountSatang: 1_000, reason: 'Slide closed' }),
    );
    expect(res.refundStatus).toBe('partially_refunded');
    expect(res.refund.lines).toEqual([]);
    expect(await held('AO-GRIPSOCKS', 'm')).toBe(before - 1);
  });
});
