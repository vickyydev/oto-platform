import { generateKeyPairSync } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  benefitApplication,
  benefitCredential,
  benefitUsage,
  employee,
  idempotencyKey,
  product,
  productCategory,
  sale,
  saleDiscount,
  saleLine,
  station,
} from '@oto/db';
import {
  applyStaffBenefits,
  benefitLinesOf,
  emptyBenefitUsage,
  itemCartLine,
  newId,
  normalizePhone,
  offlineBenefitProfile,
  PRICING_ENGINE_VERSION,
  type OfflineBenefitRecord,
} from '@oto/shared';
import {
  ADMIN,
  OTO_OPERATOR_NAME,
  RECEPTION,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { commitSale } from '../src/services/sale';

/**
 * S2-21 (SCRUM-218) round 3 — a staff benefit at the F&B checkout, through the
 * real routes (plan docs/progress/plans/benefits/PLAN.md §8 round 3).
 *
 * The round's acceptance, as the plan words it (SPRINT_2_PLAN S2-21):
 *   - check 3: Khun Anan's QR comps an F&B order to ฿0; the sale, the
 *     breakdown and the Activity rows name the beneficiary, the processing
 *     staff member, the sale and the comped amount (`benefit.comp`, sensitive);
 *     a revoked credential is refused and changes nothing. Reception applies a
 *     comp with no extra permission (plan Q3's default);
 *   - check 4: Khun Lek's QR on a mixed order applies the 2 daily coffees, the
 *     monthly credit and 30 % off the rest, in that order, to the satang; a
 *     third coffee the same day finds the quota used and still gets the 30 %;
 *   - check 6 (the cloud's half): a benefit QR is refused at sign-in — round
 *     2's suite — and the offline record a box files is checked on replay;
 *   - check 7: two tills claiming the last free coffee at the same instant
 *     give one success, one BENEFIT_QUOTA_EXHAUSTED and one usage row.
 *
 * And the hazards the round names: H1 (above), H2 (a failure after the claim
 * rolls it back; a removal and a void give it back), H3 (the till's figure is
 * never used), H14 (the row's money sits on the coffee), H15 (the cascade
 * caps), H16 (an unlinked "Staff benefit" row is refused).
 */

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let admin: string;
let reception: string;
let operatorId: string;
let receptionId: string;
let stationId: string;
let ticketStationId: string;
let coffeeCategoryId: string;
const item = { espresso: '', water: '', hotdog: '' };
const people = { anan: '', som: '', nok: '', lek: '' };
const codes = { anan: '', som: '', nok: '', lek: '' };
const credentialIds = { anan: '', som: '', nok: '', lek: '' };

let n = 0;
const idem = () => `benefits-r3-${process.pid}-${Date.now()}-${n++}`;

interface Breakdown {
  applicationId: string;
  name: string;
  benefitRole: string;
  isComp: boolean;
  compedSatang: number;
  freeItemsSatang: number;
  creditSatang: number;
  discountSatang: number;
  totalReliefSatang: number;
  appliedSatang: number;
  onlineOnly: string[];
  lines: { cartLineId: string; reliefSatang: number }[];
  source: string;
}
interface Envelope {
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  url: string,
  cookie: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T & Envelope; raw: string; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: (res.body ? res.json() : {}) as T & Envelope,
    raw: res.body,
    headers: res.headers as Record<string, unknown>,
  };
}

const line = (productId: string, quantity = 1) => ({ id: newId(), productId, quantity });

function cart(
  items: ReturnType<typeof line>[],
  benefit?: { code: string; applicationId?: string; expectedReliefSatang?: number } | null,
  extra: Record<string, unknown> = {},
) {
  return {
    stationId,
    channel: 'fnb',
    pickupCode: '27',
    items,
    ...(benefit
      ? { benefit: { applicationId: benefit.applicationId ?? newId(), code: benefit.code, ...(benefit.expectedReliefSatang !== undefined ? { expectedReliefSatang: benefit.expectedReliefSatang } : {}) } }
      : {}),
    ...extra,
  };
}

async function quote(body: Record<string, unknown>, cookie = reception) {
  return call<{ benefit: Breakdown | null; totals: { grossSatang: number; manualDiscountSatang: number } }>(
    'POST',
    '/sales/quote',
    cookie,
    body,
  );
}

async function commit(body: Record<string, unknown>, cookie = reception, id: string = newId()) {
  return call<{
    sale: { id: string; status: string; totals: { grossSatang: number } };
    benefit: Breakdown | null;
    replay: boolean;
  }>('POST', '/sales', cookie, { id, actionId: newId(), ...body });
}

async function usageOf(employeeId: string) {
  return ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, employeeId));
}

async function applicationsOf(saleId: string) {
  return ctx.db.select().from(benefitApplication).where(eq(benefitApplication.saleId, saleId));
}

async function auditOf(action: string, entityIds: string[]) {
  if (entityIds.length === 0) return [];
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), inArray(auditLog.entityId, entityIds)));
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const [rec] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  receptionId = rec!.id;

  const tills = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  const t1 = tills.find((s) => s.kind === 'till' && s.codePrefix === 'T1')!;
  stationId = t1.id;
  // A till that sells tickets and not food: the F&B-only rule's counter-example.
  ticketStationId = newId();
  await ctx.db.insert(station).values({
    id: ticketStationId,
    operatorId,
    branchId: t1.branchId,
    name: 'Tickets Only Till (r3)',
    kind: 'till',
    codePrefix: 'TR',
    capabilities: ['tickets'],
    accessScope: 'all_staff',
  });

  const [coffee] = await ctx.db
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, 'DRINKS-COFFEE')));
  coffeeCategoryId = coffee!.id;
  // An espresso with no questions to answer, filed under Coffee: the seeded
  // free coffee's target. ฿60.
  item.espresso = newId();
  await ctx.db.insert(product).values({
    id: item.espresso,
    operatorId,
    kind: 'menu',
    name: 'Espresso (r3)',
    code: 'FB-ESPRESSO-R3',
    priceSatang: 6_000,
    categoryId: coffeeCategoryId,
  });
  const menu = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  item.water = menu.find((p) => p.code === 'FB-WATER')!.id;
  item.hotdog = menu.find((p) => p.code === 'FB-HOTDOG')!.id;

  const staff = await ctx.db
    .select({ id: employee.id, name: employee.name })
    .from(employee)
    .where(eq(employee.operatorId, operatorId));
  const byName = (name: string) => staff.find((r) => r.name === name)!.id;
  people.anan = byName('Khun Anan (Owner)');
  people.som = byName('Som (Reception)');
  people.nok = byName('Nok (Reception)');
  people.lek = byName('Khun Lek (Manager)');
  for (const who of ['anan', 'som', 'nok', 'lek'] as const) {
    const issued = await call<{ credential: { id: string } }>('POST', '/benefits/credentials', admin, {
      employeeId: people[who],
    });
    expect(issued.status).toBe(200);
    credentialIds[who] = issued.body.credential.id;
    codes[who] = (
      await call<{ code: string }>('GET', `/benefits/credentials/${issued.body.credential.id}/qr`, admin)
    ).body.code;
  }
}, 180_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('check 4 — Khun Lek on a mixed order: two coffees, the credit, then 30 % off the rest', () => {
  // 3 espressos (฿180) and 5 hot dogs (฿550): ฿730.
  //   free items: 2 coffees               ฿120
  //   credit: ฿500 a month, greedily      ฿500  (the third coffee ฿60, then ฿440 of hot dogs)
  //   30 % off what is left (฿110)        ฿33
  //   relief ฿653; the guest pays ฿77.
  const lines = () => [line(item.espresso, 3), line(item.hotdog, 5)];
  let saleId = '';

  it('the quote previews the four amounts from the platform and claims nothing', async () => {
    const before = await usageOf(people.lek);
    const q = await quote(cart(lines(), { code: codes.lek }));
    expect(q.status, q.raw).toBe(200);
    expect(q.body.benefit).toMatchObject({
      name: 'Khun Lek (Manager)',
      benefitRole: 'manager',
      isComp: false,
      compedSatang: 0,
      freeItemsSatang: 12_000,
      creditSatang: 50_000,
      discountSatang: 3_300,
      totalReliefSatang: 65_300,
      appliedSatang: 65_300,
      source: 'platform',
    });
    expect(q.body.totals.grossSatang).toBe(7_700);
    expect(q.raw).not.toContain(codes.lek.slice(codes.lek.lastIndexOf('.') + 1, codes.lek.lastIndexOf('.') + 20));
    expect(await usageOf(people.lek)).toEqual(before);

    const preview = await call<{ benefit: Breakdown; totals: { grossSatang: number } }>(
      'POST',
      `/sales/${newId()}/benefit/preview`,
      reception,
      cart(lines(), { code: codes.lek }),
    );
    expect(preview.status, preview.raw).toBe(200);
    expect(preview.body.benefit.totalReliefSatang).toBe(65_300);
    expect(preview.body.totals.grossSatang).toBe(7_700);
    expect(await usageOf(people.lek)).toEqual(before);
  });

  it('the commit applies it in the sale’s transaction: one linked "Staff benefit" row, the claim, the audit', async () => {
    saleId = newId();
    const applicationId = newId();
    const res = await commit(cart(lines(), { code: codes.lek, applicationId, expectedReliefSatang: 65_300 }), reception, saleId);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.sale.totals.grossSatang).toBe(7_700);
    expect(res.body.benefit).toMatchObject({ applicationId, totalReliefSatang: 65_300, appliedSatang: 65_300 });

    const [row] = await applicationsOf(saleId);
    expect(row).toMatchObject({
      clientId: applicationId,
      employeeId: people.lek,
      credentialId: credentialIds.lek,
      benefitRole: 'manager',
      processedByAccountId: receptionId,
      stationId,
      origin: 'cloud',
      isComp: false,
      freeItemsSatang: 12_000,
      creditSatang: 50_000,
      discountSatang: 3_300,
      totalReliefSatang: 65_300,
      appliedSatang: 65_300,
      removedAt: null,
    });
    const discounts = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(discounts).toHaveLength(1);
    expect(discounts[0]).toMatchObject({
      kind: 'manual',
      discountType: 'fixed',
      valueSatang: 65_300,
      amountSatang: 65_300,
      reason: 'Staff benefit',
      note: 'Scanned: Khun Lek (Manager) (manager)',
      appliedByAccountId: receptionId,
      benefitApplicationId: row!.id,
    });
    // The quota: two coffees today, ฿500 this month.
    const usage = await usageOf(people.lek);
    expect(usage.find((u) => u.itemKey === 'free:coffee')).toMatchObject({ qtyUsed: 2, periodKind: 'daily' });
    expect(usage.find((u) => u.itemKey === 'credit')).toMatchObject({ creditUsedSatang: 50_000, periodKind: 'monthly' });
    // The audit row, with the station and the box.
    const [applied] = await auditOf('benefit.apply', [row!.id]);
    expect(applied!.after).toMatchObject({
      saleId,
      employeeName: 'Khun Lek (Manager)',
      processedByAccountId: receptionId,
      stationId,
      boxId: expect.any(String),
      totalReliefSatang: 65_300,
    });
    expect(await auditOf('benefit.comp', [row!.id])).toHaveLength(0);
    // Is this card in use: the round 2 column, set by the application.
    const [cred] = await ctx.db.select().from(benefitCredential).where(eq(benefitCredential.id, credentialIds.lek));
    expect(cred!.lastSeenAt).not.toBeNull();

    const closed = await call<{ sale: { status: string } }>('POST', `/sales/${saleId}/finalise`, reception, {
      method: 'cash',
      amountSatang: 7_700,
    });
    expect(closed.status, closed.raw).toBe(200);
    expect(closed.body.sale.status).toBe('finalised');
  });

  it('a third coffee the same day finds the quota used and still gets the 30 %', async () => {
    const q = await quote(cart([line(item.espresso, 1)], { code: codes.lek }));
    expect(q.status, q.raw).toBe(200);
    expect(q.body.benefit).toMatchObject({ freeItemsSatang: 0, creditSatang: 0, discountSatang: 1_800, totalReliefSatang: 1_800 });
    expect(q.body.totals.grossSatang).toBe(4_200);
  });

  it('the row’s money sits on the lines it relieved (H14)', async () => {
    const [row] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    const allocations = row!.allocations as { cartLineId: string | null; amountSatang: number }[];
    expect(allocations.reduce((sum, a) => sum + a.amountSatang, 0)).toBe(65_300);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const espresso = lines.find((l) => l.productId === item.espresso)!;
    const hotdog = lines.find((l) => l.productId === item.hotdog)!;
    // 3 espressos: ฿120 free + ฿60 credit; 5 hot dogs: ฿440 credit + ฿33 off.
    expect(espresso.discountSatang).toBe(18_000);
    expect(hotdog.discountSatang).toBe(47_300);
    expect(allocations.find((a) => a.cartLineId === espresso.cartLineId)?.amountSatang).toBe(18_000);
  });
});

describe('check 3 — Khun Anan’s comp, and a revoked QR', () => {
  it('comps the F&B order to ฿0 for reception, with a sensitive `benefit.comp` row', async () => {
    const saleId = newId();
    const res = await commit(cart([line(item.water, 2), line(item.hotdog, 1)], { code: codes.anan }), reception, saleId);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.sale.totals.grossSatang).toBe(0);
    expect(res.body.benefit).toMatchObject({ isComp: true, compedSatang: 16_000, totalReliefSatang: 16_000 });
    const [d] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(d).toMatchObject({ discountType: 'comp', amountSatang: 16_000, reason: 'Staff benefit' });
    const [row] = await applicationsOf(saleId);
    expect(row).toMatchObject({ isComp: true, compedSatang: 16_000, usageDeltas: [] });
    const [comp] = await auditOf('benefit.comp', [row!.id]);
    expect(comp!.after).toMatchObject({
      sensitive: true,
      saleId,
      employeeName: 'Khun Anan (Owner)',
      processedByAccountId: receptionId,
      compedSatang: 16_000,
    });
    // Closed with no tender: nothing is owed.
    const closed = await call<{ sale: { status: string; receiptNumber: string } }>(
      'POST',
      `/sales/${saleId}/finalise`,
      reception,
      {},
    );
    expect(closed.status, closed.raw).toBe(200);
    expect(closed.body.sale.status).toBe('finalised');
  });

  it('a revoked QR is refused — "Benefit revoked" — at the quote and the commit, and changes nothing', async () => {
    const revoked = await call('POST', `/benefits/credentials/${credentialIds.nok}/revoke`, admin, {});
    expect(revoked.status).toBe(200);
    const before = await usageOf(people.nok);
    const q = await quote(cart([line(item.espresso)], { code: codes.nok }));
    expect(q.status).toBe(409);
    expect(q.body.error).toMatchObject({ code: 'BENEFIT_REVOKED' });
    expect(q.body.error!.message).toMatch(/^Benefit revoked/);
    const saleId = newId();
    const c = await commit(cart([line(item.espresso)], { code: codes.nok }), reception, saleId);
    expect(c.status).toBe(409);
    expect(c.body.error!.code).toBe('BENEFIT_REVOKED');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
    expect(await usageOf(people.nok)).toEqual(before);
  });
});

describe('the server’s figures, never the till’s', () => {
  it('a "Staff benefit" row sent by a till is refused at the quote and the commit (H16)', async () => {
    const discount = { id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Staff benefit', note: 'Scanned: Khun Anan (owner)' };
    const forged = cart([line(item.espresso)], null, { manualDiscounts: [discount] });
    const q = await quote(forged);
    expect(q.status).toBe(409);
    expect(q.body.error!.code).toBe('BENEFIT_DISCOUNT_UNLINKED');
    const saleId = newId();
    const c = await commit(
      cart([line(item.espresso)], null, { manualDiscounts: [{ ...discount, reason: ' staff BENEFIT ' }] }),
      reception,
      saleId,
    );
    expect(c.status).toBe(409);
    expect(c.body.error!.code).toBe('BENEFIT_DISCOUNT_UNLINKED');
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
  });

  it('a tampered body moves nothing: a till total that disagrees is refused, and nothing is claimed (H3)', async () => {
    const before = await usageOf(people.som);
    const saleId = newId();
    // A hot dog (฿110): Som's 30 % makes it ฿77. A till claiming ฿0 is refused.
    const res = await commit(
      cart([line(item.hotdog)], { code: codes.som, expectedReliefSatang: 11_000 }, { expectedTotalSatang: 0 }),
      reception,
      saleId,
    );
    expect(res.status).toBe(409);
    expect(['SALE_TOTAL_MISMATCH', 'BENEFIT_QUOTA_EXHAUSTED']).toContain(res.body.error!.code);
    expect(await ctx.db.select().from(sale).where(eq(sale.id, saleId))).toHaveLength(0);
    expect(await usageOf(people.som)).toEqual(before);
    // The same cart with no figures of the till's at all is priced by the platform alone.
    const q = await quote(cart([line(item.hotdog)], { code: codes.som, expectedReliefSatang: 99_999 }));
    expect(q.body.benefit!.totalReliefSatang).toBe(3_300);
  });

  it('is applied at the F&B station only', async () => {
    const q = await quote(cart([line(item.espresso)], { code: codes.som }, { channel: 'till' }));
    expect(q.status).toBe(409);
    expect(q.body.error!.code).toBe('BENEFIT_FNB_ONLY');
    const { channel: _claimed, ...unclaimed } = cart([line(item.espresso)], { code: codes.som });
    const c = await commit({ ...unclaimed, stationId: ticketStationId });
    expect(c.status).toBe(409);
    expect(['BENEFIT_FNB_ONLY', 'SALE_CHANNEL_MISMATCH']).toContain(c.body.error!.code);
  });

  it('after the order’s own manual discount the cascade caps the benefit, and the row records the cap (H15)', async () => {
    const saleId = newId();
    // ฿60 espresso, ฿50 off by hand first: Som's free coffee (฿60) can take only ฿10.
    const res = await commit(
      cart([line(item.espresso)], { code: codes.som }, {
        manualDiscounts: [{ id: newId(), scope: 'order', type: 'fixed', value: 5_000, reason: 'Service recovery' }],
      }),
      reception,
      saleId,
    );
    expect(res.status, res.raw).toBe(200);
    expect(res.body.sale.totals.grossSatang).toBe(0);
    const [row] = await applicationsOf(saleId);
    expect(row).toMatchObject({ freeItemsSatang: 6_000, totalReliefSatang: 6_000, appliedSatang: 1_000 });
    const rows = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(rows.map((r) => [r.sequence, r.reason, r.amountSatang])).toEqual([
      [1, 'Service recovery', 5_000],
      [2, 'Staff benefit', 1_000],
    ]);
    // Taken off again before any money, so Som keeps her coffees for the cases below.
    const off = await call('DELETE', `/sales/${saleId}/benefit`, reception);
    expect(off.status, off.raw).toBe(200);
  });
});

describe('check 7 — two tills and the last coffee (H1)', () => {
  it('gives one success, one BENEFIT_QUOTA_EXHAUSTED and one usage row at the quota', async () => {
    // Som has two free coffees a day. One is used; two tills race for the last.
    const first = await commit(cart([line(item.espresso)], { code: codes.som }));
    expect(first.status, first.raw).toBe(200);
    // Two tills, two scans of the same QR, one instant — each was shown the
    // free coffee by its quote, as a till always is. Whichever order the two
    // transactions meet in, one claim finds no room: the conditional claim
    // when both read before either wrote, the shown relief when one read after.
    const shown = await quote(cart([line(item.espresso)], { code: codes.som }));
    expect(shown.body.benefit!.freeItemsSatang).toBe(6_000);
    const ids = [newId(), newId()];
    const [a, b] = await Promise.all(
      ids.map((id) =>
        commit(cart([line(item.espresso)], { code: codes.som, expectedReliefSatang: 6_000 }), reception, id),
      ),
    );
    const statuses = [a!.status, b!.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loserAt = a!.status === 409 ? 0 : 1;
    const loser = loserAt === 0 ? a! : b!;
    const winner = loserAt === 0 ? b! : a!;
    expect(loser.body.error!.code).toBe('BENEFIT_QUOTA_EXHAUSTED');
    expect(winner.body.benefit!.freeItemsSatang).toBe(6_000);
    const rows = (await usageOf(people.som)).filter((u) => u.itemKey === 'free:coffee');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qtyUsed).toBe(2);
    // The loser's sale was never written, and nothing was applied to it.
    expect(await ctx.db.select().from(sale).where(eq(sale.id, ids[loserAt]!))).toHaveLength(0);
    expect(await applicationsOf(ids[loserAt]!)).toHaveLength(0);
    // And the next quote says so: no coffee left, the 30 % still given.
    const q = await quote(cart([line(item.espresso)], { code: codes.som }));
    expect(q.body.benefit).toMatchObject({ freeItemsSatang: 0, discountSatang: 1_800 });
  });

  it('a commit priced before another till took the last of it is refused, not filed at a figure nobody saw', async () => {
    // The till was shown ฿60 of relief; the coffee is gone, so the recompute is ฿18.
    const res = await commit(cart([line(item.espresso)], { code: codes.som, expectedReliefSatang: 6_000 }));
    expect(res.status).toBe(409);
    expect(res.body.error!.code).toBe('BENEFIT_QUOTA_EXHAUSTED');
    expect(res.body.error!.message).toMatch(/^Som \(Reception\)'s free items or staff credit were used at another till/);
  });
});

describe('idempotency on the application id, and giving the quota back (H2)', () => {
  it('a replayed commit claims once; the same scan rung up again moves the claim, and the old sale cannot be closed with it', async () => {
    // Som's two coffees went to the race above: start her counters again, as
    // a new trading day would (a daily quota is a key per day, never a job).
    await ctx.db.delete(benefitUsage).where(eq(benefitUsage.employeeId, people.som));
    const applicationId = newId();
    const body = cart([line(item.espresso)], { code: codes.som, applicationId });
    const saleA = newId();
    const actionA = newId();
    const first = await call<{ benefit: Breakdown }>('POST', '/sales', reception, { id: saleA, actionId: actionA, ...body });
    expect(first.status, first.raw).toBe(200);
    const again = await call<{ replay: boolean }>('POST', '/sales', reception, { id: saleA, actionId: actionA, ...body });
    expect(again.status).toBe(200);
    expect(again.body.replay).toBe(true);
    let coffee = (await usageOf(people.som)).find((u) => u.itemKey === 'free:coffee')!;
    expect(coffee.qtyUsed).toBe(1);

    // The order changed after Pay: rung up again as a new sale, the same scan.
    const saleB = newId();
    const moved = await commit(
      cart([line(item.espresso), line(item.water)], { code: codes.som, applicationId }),
      reception,
      saleB,
    );
    expect(moved.status, moved.raw).toBe(200);
    coffee = (await usageOf(people.som)).find((u) => u.itemKey === 'free:coffee')!;
    expect(coffee.qtyUsed).toBe(1);
    const [onA] = await applicationsOf(saleA);
    const [onB] = await applicationsOf(saleB);
    expect(onA).toMatchObject({ removedReason: 'moved' });
    expect(onB).toMatchObject({ clientId: applicationId, removedAt: null });
    const [movedAudit] = await auditOf('benefit.remove', [onA!.id]);
    expect(movedAudit!.after).toMatchObject({ reason: 'moved', movedToSaleId: saleB, stationId });
    const stale = await call('POST', `/sales/${saleA}/finalise`, reception, { method: 'cash' });
    expect(stale.status).toBe(409);
    expect((stale.body as Envelope).error!.code).toBe('BENEFIT_APPLICATION_RELEASED');

    // Taken off B before any money: the coffee goes back, audited, and B is rung up again.
    const off = await call<{ removed: boolean; applicationId: string }>('DELETE', `/sales/${saleB}/benefit`, reception);
    expect(off.status, off.raw).toBe(200);
    expect(off.body).toMatchObject({ removed: true, applicationId });
    coffee = (await usageOf(people.som)).find((u) => u.itemKey === 'free:coffee')!;
    expect(coffee.qtyUsed).toBe(0);
    expect(await auditOf('benefit.remove', [onB!.id])).toHaveLength(1);
    const closeB = await call('POST', `/sales/${saleB}/finalise`, reception, { method: 'cash' });
    expect((closeB.body as Envelope).error!.code).toBe('BENEFIT_APPLICATION_RELEASED');
    const twice = await call<{ removed: boolean }>('DELETE', `/sales/${saleB}/benefit`, reception);
    expect(twice.body.removed).toBe(false);
    // Its answer is an ordinary one: kept under its key and replayed, never
    // mistaken for a credential by the store's backstop.
    const key = idem();
    const once = await call('DELETE', `/sales/${saleB}/benefit`, reception, undefined, { 'idempotency-key': key });
    const replayed = await call('DELETE', `/sales/${saleB}/benefit`, reception, undefined, { 'idempotency-key': key });
    expect(replayed.headers['x-oto-replay']).toBe('true');
    expect(replayed.body).toEqual(once.body);
  });

  it('a void gives the quota back', async () => {
    const saleId = newId();
    const res = await commit(cart([line(item.espresso)], { code: codes.som }), reception, saleId);
    expect(res.status, res.raw).toBe(200);
    expect((await usageOf(people.som)).find((u) => u.itemKey === 'free:coffee')!.qtyUsed).toBe(1);
    const voided = await call('POST', `/sales/${saleId}/void`, reception, { reason: 'Cancelled at the till' });
    expect(voided.status, voided.raw).toBe(200);
    expect((await usageOf(people.som)).find((u) => u.itemKey === 'free:coffee')!.qtyUsed).toBe(0);
    const [row] = await applicationsOf(saleId);
    expect(row).toMatchObject({ removedReason: 'voided' });
  });

  it('a failure after the claim, in the same transaction, leaves no claim behind', async () => {
    const before = (await usageOf(people.som)).find((u) => u.itemKey === 'free:coffee')?.qtyUsed ?? 0;
    const saleId = newId();
    await expect(
      ctx.db.transaction(async (tx) => {
        await commitSale(
          tx,
          { accountId: receptionId, operatorId, branchId: null },
          { id: saleId, ...cart([line(item.espresso)], { code: codes.som }) } as never,
        );
        throw new Error('forced after the claim');
      }),
    ).rejects.toThrow('forced after the claim');
    expect((await usageOf(people.som)).find((u) => u.itemKey === 'free:coffee')?.qtyUsed ?? 0).toBe(before);
    expect(await applicationsOf(saleId)).toHaveLength(0);
  });
});

describe('an offline benefit, checked on replay against the engine version it was priced with', () => {
  function offlineRecord(over: Partial<OfflineBenefitRecord> = {}): {
    record: OfflineBenefitRecord;
    items: ReturnType<typeof line>[];
  } {
    const items = [line(item.espresso, 2)];
    // What a box computes from its scope: Som's standing 30 % and no quota.
    const cartLines = [
      itemCartLine(
        {
          id: items[0]!.id,
          itemId: item.espresso,
          name: 'Espresso',
          itemKind: 'menu',
          unitPrice: 6_000,
          quantity: 2,
          taxCategory: 'fnb',
          categoryIds: [coffeeCategoryId],
          tier: 'tourist',
        },
        { mode: 'weekday', socks: { addOnId: 's', price: 0, label: 'Socks' } },
      ),
    ];
    const result = applyStaffBenefits(
      offlineBenefitProfile({ comp: false, standingDiscount: { percent: 30, target: { kind: 'fnb' } } }),
      emptyBenefitUsage(),
      benefitLinesOf(cartLines).lines,
    );
    return {
      items,
      record: {
        applicationId: newId(),
        credentialId: credentialIds.som,
        employeeId: people.som,
        name: 'Som (Reception)',
        benefitRole: 'staff',
        day: new Date().toISOString().slice(0, 10),
        isComp: false,
        compedSatang: 0,
        discountSatang: result.discountSatang,
        totalReliefSatang: result.totalReliefSatang,
        onlineOnly: ['freeItems'],
        standingDiscount: { percent: 30, target: { kind: 'fnb' } },
        engineVersion: PRICING_ENGINE_VERSION,
        ...over,
      },
    };
  }

  async function replay(record: OfflineBenefitRecord, items: ReturnType<typeof line>[], expected: number) {
    const saleId = newId();
    const run = () =>
      ctx.db.transaction((tx) =>
        commitSale(
          tx,
          { accountId: receptionId, operatorId, branchId: null },
          {
            id: saleId,
            stationId,
            channel: 'fnb',
            pickupCode: '31',
            items,
            benefitOffline: record,
            expectedTotalSatang: expected,
          },
          new Date(),
          { printing: 'skip', promoPricing: 'as_recorded', replayEngineVersion: PRICING_ENGINE_VERSION },
        ),
      );
    return { saleId, run };
  }

  it('files the comp or the standing percent a box applied, with no claim, as a box application', async () => {
    const { record, items } = offlineRecord();
    expect(record.discountSatang).toBe(3_600);
    const before = await usageOf(people.som);
    const { saleId, run } = await replay(record, items, 12_000 - 3_600);
    const committed = await run();
    expect(committed.sale.totals.grossSatang).toBe(8_400);
    const [row] = await applicationsOf(saleId);
    expect(row).toMatchObject({ origin: 'box', discountSatang: 3_600, usageDeltas: [], clientId: record.applicationId });
    expect(await usageOf(people.som)).toEqual(before);
  });

  it('refuses a record whose figures the platform’s own profile does not give (H12)', async () => {
    const { record, items } = offlineRecord();
    const drifted = { ...record, discountSatang: 4_000, totalReliefSatang: 4_000 };
    const { run } = await replay(drifted, items, 8_000);
    await expect(run()).rejects.toMatchObject({ code: 'BENEFIT_OFFLINE_DRIFT' });
    const free = { ...record, isComp: true, compedSatang: 12_000, discountSatang: 0, totalReliefSatang: 12_000 };
    await expect((await replay(free, items, 0)).run()).rejects.toMatchObject({ code: 'BENEFIT_OFFLINE_DRIFT' });
  });

  it('refuses a record priced with an engine this platform does not have', async () => {
    const { record, items } = offlineRecord({ engineVersion: '2099.01.01-1' });
    const { run } = await replay(record, items, 8_400);
    await expect(run()).rejects.toMatchObject({ code: 'BENEFIT_OFFLINE_ENGINE_UNSUPPORTED' });
  });
});

describe('POST /benefits/resolve keeps nothing, and echoes a prefixed QR short of its signature', () => {
  it('a live QR behind a scanner’s code id or pasted quotes is cut at its signature, and the store holds nothing', async () => {
    const sig = codes.som.slice(codes.som.lastIndexOf('.') + 1);
    for (const sent of [`]Q1${codes.som}`, `\u200b${codes.som}`, `"${codes.som}"`, `QR: ${codes.som}`]) {
      const key = idem();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/benefits/resolve',
        headers: { cookie: reception, 'idempotency-key': key },
        payload: { code: sent },
      });
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(sig.slice(0, 16));
      expect(res.body).toContain('OTO-BEN:v1:');
      const stored = await ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key));
      expect(stored).toHaveLength(0);
    }
    // And a good one: answered, and not kept either.
    const key = idem();
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/benefits/resolve',
      headers: { cookie: reception, 'idempotency-key': key },
      payload: { code: codes.som },
    });
    expect(ok.statusCode).toBe(200);
    expect(await ctx.db.select().from(idempotencyKey).where(eq(idempotencyKey.key, key))).toHaveLength(0);
  });
});

describe('the Staff Benefits Audit log, on the platform’s rows', () => {
  it('lists every benefit applied to a recorded order, newest first, and nothing taken off or still unpaid', async () => {
    const log = await call<{
      applications: Array<{
        employeeName: string;
        processedByName: string | null;
        isComp: boolean;
        totalReliefSatang: number;
        receiptNumber: string | null;
        stationId: string;
        at: string;
      }>;
    }>('GET', '/benefits/applications', admin);
    expect(log.status, log.raw).toBe(200);
    const rows = log.body.applications;
    // Khun Lek's mixed order and Khun Anan's comp were closed; the rest were
    // taken off, voided, moved, or left rung up and unpaid.
    expect(rows.map((r) => r.employeeName).sort()).toEqual(['Khun Anan (Owner)', 'Khun Lek (Manager)']);
    expect(rows.every((r) => r.receiptNumber && r.stationId === stationId && r.processedByName)).toBe(true);
    expect(rows.find((r) => r.isComp)?.employeeName).toBe('Khun Anan (Owner)');
    expect([...rows].sort((a, b) => b.at.localeCompare(a.at))).toEqual(rows);
    // Reception applies benefits; reading the log is the back office's.
    const denied = await call('GET', '/benefits/applications', reception);
    expect(denied.status).toBe(403);
  });
});
