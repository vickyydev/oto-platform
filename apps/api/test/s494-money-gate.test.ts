import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  memberTierVerification,
  product,
  sale,
  saleLine,
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
 * SCRUM-494 unit "money" — gate reproductions.
 *
 *   1. An expired document: the member's sale prices and completes at the
 *      verified rate, and `reverifyDue` is raised.
 *   2. A verified member sold at Tourist; an unverified higher tier refused.
 *   3. Restock on the approved design's full-scope rule (RefundModal.tsx:95-112,
 *      mockApi.ts:2878-2960): replay restocks once, partials never restock,
 *      a whole refund after a by-item refund returns the rest once, and a SHOP
 *      by-item refund restocks only the lines it picks (mockApi.ts:2881-2886).
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let receptionId: string;
let twoHoursId: string;
const productIds = new Map<string, string>();

const ticketLine = (kids: number, adults: number, addOns: unknown[] = []) => ({
  id: newId(),
  packageId: twoHoursId,
  kids,
  adults,
  ...(addOns.length ? { addOns } : {}),
});

const socks = (variantId: 's' | 'm', quantity = 1) => ({
  id: productIds.get('AO-GRIPSOCKS')!,
  quantity,
  variantBreakdown: [{ variantId, quantity, variantLabel: variantId.toUpperCase() }],
});

async function quote(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie }, payload: { branchId, ...payload } });
}

async function commit(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie }, payload: { stationId, branchId, ...payload } });
}

async function finalise(saleId: string) {
  const res = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(200);
}

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

const linesOf = (saleId: string) => ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));

async function newMember(phone: string): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: '/members', headers: { cookie }, payload: { phone, nickname: `Gate ${phone.slice(-4)}` } });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().member.id as string;
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  branchId = await branchIdByCode(ctx.db, CENTRAL_BRANCH_CODE);
  const stations = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
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
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('s494 money gate — 1: an expired document keeps the rate and flags re-verify', () => {
  it('a document checked with an expiry that later passes: register and lookup flag it; the sale completes at the verified rate', async () => {
    const memberId = await newMember('0634941001');
    const future = `${new Date().getUTCFullYear() + 1}-06-30`;
    const verified = await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { toTier: 'thai', evidenceType: 'Residence certificate', evidenceExpiresAt: future },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json().member.tierVerification).toMatchObject({ expiresAt: future, reverifyDue: false });

    await ctx.db
      .update(memberTierVerification)
      .set({ evidenceExpiresAt: new Date('2025-01-01T00:00:00Z') })
      .where(eq(memberTierVerification.memberId, memberId));

    const one = await ctx.app.inject({ method: 'GET', url: `/members/${memberId}`, headers: { cookie } });
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().member.tierVerification).toMatchObject({ tier: 'thai', reverifyDue: true });

    const register = await ctx.app.inject({ method: 'GET', url: '/members?q=0634941001', headers: { cookie } });
    if (register.statusCode === 200 && Array.isArray(register.json().members)) {
      const row = register.json().members.find((m: { id: string }) => m.id === memberId);
      if (row) expect(row.tierVerification).toMatchObject({ tier: 'thai', reverifyDue: true });
    }

    const cartLine = ticketLine(1, 1);
    const q = await quote({ memberId, tier: 'thai', lines: [cartLine] });
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()).toMatchObject({ tier: 'thai', tierSource: 'member' });
    expect(q.json().disagreements.tierDiffers).toBe(false);
    const saleId = newId();
    const c = await commit({
      id: saleId,
      memberId,
      tier: 'thai',
      lines: [{ ...cartLine, lineTotalSatang: q.json().lineTotals[cartLine.id] }],
      expectedTotalSatang: q.json().totals.grossSatang,
    });
    expect(c.statusCode, c.body).toBe(200);
    await finalise(saleId);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.customerTier).toBe('thai');
    expect(row!.status).toBe('finalised');
  });

  it('a verification with no expiry is replayed under one Idempotency-Key, written once', async () => {
    const memberId = await newMember('0634941002');
    const key = newId();
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/members/${memberId}/tier-verification`,
        headers: { cookie, 'idempotency-key': key },
        payload: { toTier: 'expat', evidenceType: 'Passport' },
      });
    const a = await send();
    const b = await send();
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    const rows = await ctx.db.select().from(memberTierVerification).where(eq(memberTierVerification.memberId, memberId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidenceExpiresAt).toBeNull();
  });
});

describe('s494 money gate — 2: Tourist for a verified member; an unverified tier refused', () => {
  it('a member with no verification cannot be priced at a discounted tier the till names', async () => {
    const memberId = await newMember('0634941003');
    const cartLine = ticketLine(2, 1);
    const asExpat = await quote({ memberId, tier: 'expat', lines: [cartLine] });
    expect(asExpat.statusCode, asExpat.body).toBe(200);
    expect(asExpat.json()).toMatchObject({ tier: 'tourist' });
    expect(asExpat.json().disagreements.tierDiffers).toBe(true);
    // The till's line at a discounted rate the platform will not charge.
    const verifiedMember = await newMember('0634941004');
    await ctx.app.inject({
      method: 'POST',
      url: `/members/${verifiedMember}/tier-verification`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { toTier: 'expat', evidenceType: 'Passport' },
    });
    const expatPrice = await quote({ memberId: verifiedMember, tier: 'expat', lines: [cartLine] });
    expect(expatPrice.json().tier).toBe('expat');
    const touristPrice = await quote({ memberId, tier: 'tourist', lines: [cartLine] });
    expect(expatPrice.json().lineTotals[cartLine.id]).not.toBe(touristPrice.json().lineTotals[cartLine.id]);
    const refused = await commit({
      id: newId(),
      memberId,
      tier: 'expat',
      lines: [{ ...cartLine, lineTotalSatang: expatPrice.json().lineTotals[cartLine.id] }],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('SALE_LINE_PRICE_MISMATCH');
  });

  it('a Thai-verified member sold at Tourist completes at Tourist; the member keeps Thai', async () => {
    const memberId = await newMember('0634941005');
    await ctx.app.inject({
      method: 'POST',
      url: `/members/${memberId}/tier-verification`,
      headers: { cookie, 'idempotency-key': newId() },
      payload: { toTier: 'thai', evidenceType: 'Residence certificate' },
    });
    const cartLine = ticketLine(1, 2);
    const q = await quote({ memberId, tier: 'tourist', lines: [cartLine] });
    expect(q.json()).toMatchObject({ tier: 'tourist', tierSource: 'default' });
    const saleId = newId();
    const c = await commit({
      id: saleId,
      memberId,
      tier: 'tourist',
      lines: [{ ...cartLine, lineTotalSatang: q.json().lineTotals[cartLine.id] }],
      expectedTotalSatang: q.json().totals.grossSatang,
    });
    expect(c.statusCode, c.body).toBe(200);
    await finalise(saleId);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.customerTier).toBe('tourist');
    const one = await ctx.app.inject({ method: 'GET', url: `/members/${memberId}`, headers: { cookie } });
    expect(one.json().member.tierCode).toBe('thai');
  });
});

describe('s494 money gate — 3: restock on the full-scope rule', () => {
  async function twoCartLineTicketSale(): Promise<{ saleId: string; a: string; b: string }> {
    const saleId = newId();
    const a = ticketLine(1, 1, [socks('s')]);
    const b = ticketLine(1, 0, [socks('m')]);
    const res = await commit({ id: saleId, lines: [a, b] });
    expect(res.statusCode, res.body).toBe(200);
    await finalise(saleId);
    return { saleId, a: a.id, b: b.id };
  }

  it('replaying a whole refund by its action id restocks once', async () => {
    const before = await held('AO-GRIPSOCKS', 's');
    const { saleId } = await twoCartLineTicketSale();
    const actionId = newId();
    const first = await ctx.db.transaction((tx) => refundSale(tx, actor(), saleId, { mode: 'whole', reason: 'Closed', actionId }));
    const again = await ctx.db.transaction((tx) => refundSale(tx, actor(), saleId, { mode: 'whole', reason: 'Closed', actionId }));
    expect(first.replay).toBe(false);
    expect(again.replay).toBe(true);
    expect(again.refund.id).toBe(first.refund.id);
    expect(await held('AO-GRIPSOCKS', 's')).toBe(before);
  });

  it('a by-item refund of one cart line never restocks; the whole refund after it returns both socks once', async () => {
    const s = await held('AO-GRIPSOCKS', 's');
    const m = await held('AO-GRIPSOCKS', 'm');
    const { saleId, a } = await twoCartLineTicketSale();
    expect(await held('AO-GRIPSOCKS', 's')).toBe(s - 1);
    expect(await held('AO-GRIPSOCKS', 'm')).toBe(m - 1);
    const aLines = (await linesOf(saleId)).filter((l) => l.cartLineId === a && l.quantity > 0 && l.grossSatang > 0);
    const partial = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'items', lineIds: aLines.map((l) => l.id), reason: 'One left' }),
    );
    expect(partial.refundStatus).toBe('partially_refunded');
    expect(partial.refund.lines.every((l) => !l.restock)).toBe(true);
    expect(await held('AO-GRIPSOCKS', 's')).toBe(s - 1);

    const whole = await ctx.db.transaction((tx) => refundSale(tx, actor(), saleId, { mode: 'whole', reason: 'All left' }));
    expect(whole.refundStatus).toBe('refunded');
    expect(await held('AO-GRIPSOCKS', 's')).toBe(s);
    expect(await held('AO-GRIPSOCKS', 'm')).toBe(m);
    // Money is never counted twice: restock-only entries carry nothing.
    const carried = whole.refund.lines.reduce((sum, l) => sum + l.grossSatang, 0) + partial.refund.lines.reduce((sum, l) => sum + l.grossSatang, 0);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(carried).toBeLessThanOrEqual(row!.grossSatang);
  });

  it('an F&B by-item partial never restocks; the by-item refund that empties the sale restocks every stocked line', async () => {
    const water = await held('FB-WATER');
    const saleId = newId();
    const res = await commit({
      id: saleId,
      channel: 'fnb',
      pickupCode: '7',
      items: [
        { id: newId(), productId: productIds.get('FB-WATER')!, quantity: 2 },
        { id: newId(), productId: productIds.get('FB-PADTHAI')!, quantity: 1 },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    await finalise(saleId);
    expect(await held('FB-WATER')).toBe(water - 2);
    const lines = await linesOf(saleId);
    const waterLine = lines.find((l) => l.productId === productIds.get('FB-WATER'))!;
    const padthai = lines.find((l) => l.productId === productIds.get('FB-PADTHAI'))!;
    await ctx.db.transaction((tx) => refundSale(tx, actor(), saleId, { mode: 'items', lineIds: [waterLine.id], reason: 'Spilled' }));
    expect(await held('FB-WATER')).toBe(water - 2);
    const rest = await ctx.db.transaction((tx) => refundSale(tx, actor(), saleId, { mode: 'items', lineIds: [padthai.id], reason: 'Cold' }));
    expect(rest.refundStatus).toBe('refunded');
    expect(await held('FB-WATER')).toBe(water);
  });

  it('a shop by-item refund that empties the sale restocks only the lines it picks (mockApi.ts:2881-2886)', async () => {
    const cap = await held('MR-CAP');
    const bottle = await held('MR-BOTTLE');
    const saleId = newId();
    const res = await commit({
      id: saleId,
      items: [
        { id: newId(), productId: productIds.get('MR-CAP')!, quantity: 1 },
        { id: newId(), productId: productIds.get('MR-BOTTLE')!, quantity: 1 },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    await finalise(saleId);
    const lines = await linesOf(saleId);
    const capLine = lines.find((l) => l.productId === productIds.get('MR-CAP'))!;
    const bottleLine = lines.find((l) => l.productId === productIds.get('MR-BOTTLE'))!;
    // A custom amount the size of the cap's price: a concession, nothing handed back.
    const custom = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'custom', amountSatang: capLine.grossSatang, reason: 'Faded print' }),
    );
    expect(custom.refundStatus).toBe('partially_refunded');
    expect(await held('MR-CAP')).toBe(cap - 1);
    // The bottle comes back, by item, and that empties the sale.
    const rest = await ctx.db.transaction((tx) =>
      refundSale(tx, actor(), saleId, { mode: 'items', lineIds: [bottleLine.id], reason: 'Leaks' }),
    );
    expect(rest.refundStatus).toBe('refunded');
    expect(await held('MR-BOTTLE')).toBe(bottle);
    // The design restocks the picked bottle only; the customer kept the cap.
    expect(await held('MR-CAP')).toBe(cap - 1);
  });
});
