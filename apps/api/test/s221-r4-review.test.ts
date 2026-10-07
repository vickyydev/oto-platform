import { generateKeyPairSync } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  account,
  alert,
  auditLog,
  benefitApplication,
  benefitRoleTemplate,
  benefitUsage,
  branch,
  employee,
  factBenefitDaily,
  idempotencyKey,
  opsLast,
  opsRun,
  product,
  productCategory,
  role,
  roleAssignment,
  sale,
  station,
} from '@oto/db';
import { benefitSeedFutureFrom, seed } from '@oto/db/seed';
import {
  addDaysToIsoDate,
  businessDate,
  newId,
  normalizePhone,
  parseDayStart,
  type BenefitReport,
  type BenefitTransactions,
  type DiscountReport,
  type DiscountTransactions,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  SECOND_OPERATOR_BRANCH_CODE,
  SECOND_OPERATOR_NAME,
  branchIdByCode,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { loadEnv } from '../src/env';
import { buildDefaultJobs, createJobRunner, runWatchdog } from '../src/services/jobs';
import { runDailyRollupJob } from '../src/services/analytics-rollup';
import { BENEFIT_ROLLOVER_JOB, runBenefitRolloverJob } from '../src/services/analytics-benefits';

/**
 * S2-21 (SCRUM-218) round 4 — THE REVIEW'S OWN ATTACK on the round's claims
 * (docs/progress/plans/benefits/PLAN.md §5, §7, §8 round 4; Q4 and Q10 at
 * their defaults). Nothing here is the builder's: every figure is worked out
 * by hand from the prices and the seeded profiles, never read back from the
 * code under test.
 *
 *   1. A day of benefit activity at Central Floresta — a manager's mixed order,
 *      an owner's comp, a staff benefit capped by the order's own manual
 *      discount (H15), a benefit taken off before payment, one on a voided
 *      order, a whole refund and a part refund (Q4) — hand-summed to the satang
 *      against the fact, the report, the per-application list, the Audit log
 *      and Discounts & Comps; replayed rollups and rollovers write nothing.
 *   2. Branch reach on both reports and the Audit log: another operator's
 *      branch and staff are a 404 on the reports and leak nothing on the log;
 *      a manager is held to their park; nobody without the permission reads.
 *   3. The "Staff benefit" reason read by its letters on the platform, at the
 *      quote and the commit, for the round 3 probes and their relatives.
 *   4. The seeded future Manager edit is inert until its day, and exactly one
 *      version answers every day around it.
 *   5. Audit rows for everything the day changed; no benefit QR anywhere it
 *      could be read back.
 *   6. The rollover at the period edge to the millisecond, and its
 *      expectation's two alerts (failing, missing) raised and cleared.
 */

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let admin = '';
let reception = '';
let operatorId = '';
let branchId = '';
let chalongId = '';
let secondBranchId = '';
let stationId = '';
let chalongStationId = '';
let timezone = '';
let dayStartMinutes = 0;
let today = '';
const item = { espresso: '', water: '', hotdog: '' };
const people = { anan: '', som: '', nok: '', lek: '' };
const codes = { anan: '', som: '', nok: '', lek: '' };

let n = 0;
const idem = () => `s221-r4-review-${process.pid}-${Date.now()}-${n++}`;

interface Envelope {
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'DELETE' | 'PUT',
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<{ status: number; body: T & Envelope; raw: string }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: res.statusCode, body: (res.body ? res.json() : {}) as T & Envelope, raw: res.body };
}

const line = (productId: string, quantity = 1) => ({ id: newId(), productId, quantity });
let pickup = 400;
function cart(items: ReturnType<typeof line>[], code: string | null, extra: Record<string, unknown> = {}, at = stationId) {
  return {
    stationId: at,
    channel: 'fnb',
    pickupCode: String(pickup++),
    items,
    ...(code ? { benefit: { applicationId: newId(), code } } : {}),
    ...extra,
  };
}

async function commit(body: Record<string, unknown>, who = reception, saleId = newId()) {
  const res = await call<{ sale: { totals: { grossSatang: number } } }>('POST', '/sales', who, {
    id: saleId,
    actionId: newId(),
    ...body,
  });
  return { ...res, saleId };
}

async function finalise(saleId: string, gross: number, who = reception) {
  const res = await call('POST', `/sales/${saleId}/finalise`, who, gross > 0 ? { method: 'cash', amountSatang: gross } : {});
  expect(res.status, res.raw).toBe(200);
}

/** Ring an order up and close it, asserting what the guest owes. */
async function sold(body: Record<string, unknown>, owes: number, who = reception): Promise<string> {
  const c = await commit(body, who);
  expect(c.status, c.raw).toBe(200);
  expect(c.body.sale.totals.grossSatang).toBe(owes);
  await finalise(c.saleId, owes, who);
  return c.saleId;
}

const appsOf = (saleId: string) => ctx.db.select().from(benefitApplication).where(eq(benefitApplication.saleId, saleId));
const factOf = (at = branchId, date = today) =>
  ctx.db
    .select()
    .from(factBenefitDaily)
    .where(and(eq(factBenefitDaily.branchId, at), eq(factBenefitDaily.businessDate, date)));

const range = () => `from=${today}&to=${today}`;
const env = () => loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused', PROCESS_ROLES: 'api,jobs' });

async function makeAccount(phone: string, grants: Array<{ role: string; scopeType: 'operator' | 'branch'; scopeId: string }>) {
  const id = newId();
  await ctx.db.insert(account).values({
    id,
    operatorId,
    phone: normalizePhone(phone)!,
    passwordHash: await hash('review1234'),
    phoneVerifiedAt: new Date(),
    status: 'active',
  });
  for (const g of grants) {
    const [r] = await ctx.db.select().from(role).where(eq(role.name, g.role)).limit(1);
    await ctx.db.insert(roleAssignment).values({ id: newId(), accountId: id, roleId: r!.id, scopeType: g.scopeType, scopeId: g.scopeId });
  }
  return signInAs(ctx.app, phone, 'review1234');
}

/** The day's sales, by what each one is. */
const day = {
  lekMixed: '',
  ananComp: '',
  somCapped: '',
  nokRemoved: '',
  nokFree: '',
  nokVoided: '',
  lekPercent: '',
};

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
  secondBranchId = await branchIdByCode(ctx.db, SECOND_OPERATOR_BRANCH_CODE, SECOND_OPERATOR_NAME);
  const tills = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  const t1 = tills.find((s) => s.kind === 'till' && s.codePrefix === 'T1')!;
  stationId = t1.id;
  branchId = t1.branchId;
  chalongStationId = tills.find((s) => s.kind === 'till' && s.codePrefix === 'T3')!.id;
  const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
  timezone = br!.timezone;
  dayStartMinutes = parseDayStart(String(br!.businessDayStart).slice(0, 5));
  today = businessDate(new Date(), timezone, dayStartMinutes);

  const [coffee] = await ctx.db
    .select({ id: productCategory.id })
    .from(productCategory)
    .where(and(eq(productCategory.operatorId, operatorId), eq(productCategory.code, 'DRINKS-COFFEE')));
  item.espresso = newId();
  await ctx.db.insert(product).values({
    id: item.espresso,
    operatorId,
    kind: 'menu',
    name: 'Espresso (r4 review)',
    code: 'FB-ESPRESSO-R4R',
    priceSatang: 6_000,
    categoryId: coffee!.id,
  });
  const menu = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  const water = menu.find((p) => p.code === 'FB-WATER')!;
  const hotdog = menu.find((p) => p.code === 'FB-HOTDOG')!;
  // The hand sums below are worked from these two prices.
  expect([water.priceSatang, hotdog.priceSatang]).toEqual([2_500, 11_000]);
  item.water = water.id;
  item.hotdog = hotdog.id;

  const staff = await ctx.db.select({ id: employee.id, name: employee.name }).from(employee).where(eq(employee.operatorId, operatorId));
  const byName = (name: string) => staff.find((r) => r.name === name)!.id;
  people.anan = byName('Khun Anan (Owner)');
  people.som = byName('Som (Reception)');
  people.nok = byName('Nok (Reception)');
  people.lek = byName('Khun Lek (Manager)');
  for (const who of ['anan', 'som', 'nok', 'lek'] as const) {
    const issued = await call<{ credential: { id: string } }>('POST', '/benefits/credentials', admin, { employeeId: people[who] });
    expect(issued.status, issued.raw).toBe(200);
    codes[who] = (await call<{ code: string }>('GET', `/benefits/credentials/${issued.body.credential.id}/qr`, admin)).body.code;
  }
}, 300_000);

afterAll(async () => {
  vi.useRealTimers();
  await ctx?.close();
  await teardownAll();
});

// --- 1. A day of benefits, summed by hand -----------------------------------------------------------

describe('a day of staff benefits, hand-summed to the satang across every place it is read', () => {
  let dcBefore: DiscountReport;

  beforeAll(async () => {
    await runDailyRollupJob(ctx.db, new Date());
    dcBefore = (await call<DiscountReport>('GET', `/analytics/reports/discounts?branches=${branchId}&${range()}`, admin)).body;

    // Khun Lek (manager: 2 coffees a day, ฿500 a month, 30 %): 3 espressos and
    // 5 hot dogs, ฿730. Coffees ฿120; credit ฿500 over the ฿610 left; 30 % of
    // ฿110 is ฿33. Relief ฿653, the guest pays ฿77.
    day.lekMixed = await sold(cart([line(item.espresso, 3), line(item.hotdog, 5)], codes.lek), 7_700);
    // Khun Anan (owner): comp. Two waters and a hot dog, ฿160, to ฿0.
    day.ananComp = await sold(cart([line(item.water, 2), line(item.hotdog)], codes.anan), 0);
    // Som (staff: 2 coffees, 30 %): 2 espressos and a hot dog, ฿230, with ฿200
    // off by hand first. The engine's relief is ฿120 + ฿33 = ฿153 on the raw
    // lines; only ฿30 is left on the bill, so the row takes ฿30 (H15).
    day.somCapped = await sold(
      cart([line(item.espresso, 2), line(item.hotdog)], codes.som, {
        manualDiscounts: [{ id: newId(), scope: 'order', type: 'fixed', value: 20_000, reason: 'Service recovery' }],
      }),
      0,
    );
    // Nok (staff, her override: 4 coffees): 2 espressos rung up, the benefit
    // taken off before payment — the order is never closed with it.
    const removed = await commit(cart([line(item.espresso, 2)], codes.nok));
    expect(removed.status, removed.raw).toBe(200);
    day.nokRemoved = removed.saleId;
    const off = await call<{ removed: boolean }>('DELETE', `/sales/${removed.saleId}/benefit`, reception);
    expect(off.status, off.raw).toBe(200);
    expect(off.body.removed).toBe(true);
    // Nok: one espresso, her free coffee, ฿0.
    day.nokFree = await sold(cart([line(item.espresso)], codes.nok), 0);
    // Nok: one espresso rung up and voided.
    const voided = await commit(cart([line(item.espresso)], codes.nok));
    expect(voided.status, voided.raw).toBe(200);
    day.nokVoided = voided.saleId;
    const v = await call('POST', `/sales/${voided.saleId}/void`, reception, { reason: 'Cancelled at the till' });
    expect(v.status, v.raw).toBe(200);
    // Khun Lek again: coffees and credit used up, so 30 % of ฿60 = ฿18; pays ฿42.
    day.lekPercent = await sold(cart([line(item.espresso)], codes.lek), 4_200);

    // Q4: the mixed order refunded whole, the last one refunded ฿10 by hand.
    const whole = await call('POST', `/sales/${day.lekMixed}/refunds`, admin, {
      mode: 'whole',
      reason: 'Guest changed their mind',
      actionId: newId(),
    });
    expect(whole.status, whole.raw).toBe(200);
    const part = await call('POST', `/sales/${day.lekPercent}/refunds`, admin, {
      mode: 'custom',
      amountSatang: 1_000,
      reason: 'Cold coffee',
      actionId: newId(),
    });
    expect(part.status, part.raw).toBe(200);
    await runDailyRollupJob(ctx.db, new Date());
  }, 240_000);

  const HAND = {
    lek: {
      benefitRole: 'manager',
      applications: 2,
      compCount: 0,
      compedSatang: 0,
      freeItemsCount: 1,
      freeItemUnits: 2,
      freeItemsSatang: 12_000,
      creditCount: 1,
      creditSatang: 50_000,
      discountCount: 2,
      discountSatang: 3_300 + 1_800,
      totalReliefSatang: 65_300 + 1_800,
      appliedSatang: 65_300 + 1_800,
    },
    anan: {
      benefitRole: 'owner',
      applications: 1,
      compCount: 1,
      compedSatang: 16_000,
      freeItemsCount: 0,
      freeItemUnits: 0,
      freeItemsSatang: 0,
      creditCount: 0,
      creditSatang: 0,
      discountCount: 0,
      discountSatang: 0,
      totalReliefSatang: 16_000,
      appliedSatang: 16_000,
    },
    som: {
      benefitRole: 'staff',
      applications: 1,
      compCount: 0,
      compedSatang: 0,
      freeItemsCount: 1,
      freeItemUnits: 2,
      freeItemsSatang: 12_000,
      creditCount: 0,
      creditSatang: 0,
      discountCount: 1,
      discountSatang: 3_300,
      totalReliefSatang: 15_300,
      appliedSatang: 3_000,
    },
    nok: {
      benefitRole: 'staff',
      applications: 1,
      compCount: 0,
      compedSatang: 0,
      freeItemsCount: 1,
      freeItemUnits: 1,
      freeItemsSatang: 6_000,
      creditCount: 0,
      creditSatang: 0,
      discountCount: 0,
      discountSatang: 0,
      totalReliefSatang: 6_000,
      appliedSatang: 6_000,
    },
  } as const;
  const SUM_KEYS = [
    'applications',
    'compCount',
    'compedSatang',
    'freeItemsCount',
    'freeItemUnits',
    'freeItemsSatang',
    'creditCount',
    'creditSatang',
    'discountCount',
    'discountSatang',
    'totalReliefSatang',
    'appliedSatang',
  ] as const;
  const handTotals = () =>
    Object.fromEntries(
      SUM_KEYS.map((k) => [k, Object.values(HAND).reduce((s, p) => s + p[k], 0)]),
    ) as Record<(typeof SUM_KEYS)[number], number>;

  it('the hand totals themselves: ฿1,044 of relief, ฿921 off the bills', () => {
    expect(handTotals()).toMatchObject({ applications: 5, totalReliefSatang: 104_400, appliedSatang: 92_100, freeItemUnits: 5 });
  });

  it('the applications as written: removed and voided taken off, the capped one storing the cap, the refunded ones kept', async () => {
    const [mixed] = await appsOf(day.lekMixed);
    expect(mixed).toMatchObject({ removedAt: null, reversedAt: null, totalReliefSatang: 65_300, appliedSatang: 65_300 });
    const [capped] = await appsOf(day.somCapped);
    expect(capped).toMatchObject({ removedAt: null, totalReliefSatang: 15_300, appliedSatang: 3_000 });
    expect((await appsOf(day.nokRemoved)).map((a) => a.removedReason)).toEqual(['removed']);
    expect((await appsOf(day.nokVoided)).map((a) => a.removedReason)).toEqual(['voided']);
    const [refunded] = await ctx.db.select().from(sale).where(eq(sale.id, day.lekMixed));
    expect(refunded).toMatchObject({ status: 'refunded', refundedSatang: 7_700 });
    const [part] = await ctx.db.select().from(sale).where(eq(sale.id, day.lekPercent));
    expect(part).toMatchObject({ status: 'finalised', refundedSatang: 1_000 });
  });

  it('fact_benefit_daily is the hand sums, one row per beneficiary, provisional today', async () => {
    const rows = await factOf();
    expect(rows).toHaveLength(4);
    for (const [who, hand] of Object.entries(HAND) as Array<[keyof typeof HAND, (typeof HAND)[keyof typeof HAND]]>) {
      const row = rows.find((r) => r.employeeId === people[who]);
      expect(row, who).toBeTruthy();
      expect(row, who).toMatchObject({ ...hand, provisional: true, operatorId });
    }
  });

  it('the report reads the same sums: totals, per role, per beneficiary (by what came off) and the day', async () => {
    const res = await call<BenefitReport>('GET', `/analytics/reports/benefits?branches=${branchId}&${range()}`, admin);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.totals).toEqual(handTotals());
    const ofRole = (r: string) => res.body.byRole.find((x) => x.role === r)!;
    expect(res.body.byRole.map((x) => x.role)).toEqual(['owner', 'manager', 'staff']);
    expect(ofRole('owner').totalReliefSatang).toBe(16_000);
    expect(ofRole('manager')).toMatchObject({ totalReliefSatang: 67_100, appliedSatang: 67_100, applications: 2 });
    expect(ofRole('staff')).toMatchObject({ totalReliefSatang: 21_300, appliedSatang: 9_000, applications: 2, freeItemUnits: 3 });
    expect(res.body.byBeneficiary.map((b) => [b.employeeId, b.appliedSatang])).toEqual([
      [people.lek, 67_100],
      [people.anan, 16_000],
      [people.nok, 6_000],
      [people.som, 3_000],
    ]);
    expect(res.body.days).toEqual([{ businessDate: today, branchId, provisional: true, ...handTotals() }]);
  });

  it('the per-application list is the same five, each with its order as it stands now', async () => {
    const res = await call<BenefitTransactions>('GET', `/analytics/reports/benefits/transactions?branches=${branchId}&${range()}`, admin);
    expect(res.status, res.raw).toBe(200);
    const bySale = new Map(res.body.rows.map((r) => [r.saleId, r]));
    expect([...bySale.keys()].sort()).toEqual(
      [day.lekMixed, day.ananComp, day.somCapped, day.nokFree, day.lekPercent].sort(),
    );
    expect(bySale.get(day.lekMixed)).toMatchObject({ saleStatus: 'refunded', refundedSatang: 7_700, appliedSatang: 65_300 });
    expect(bySale.get(day.lekPercent)).toMatchObject({ saleStatus: 'finalised', refundedSatang: 1_000, discountSatang: 1_800 });
    expect(bySale.get(day.somCapped)).toMatchObject({ totalReliefSatang: 15_300, appliedSatang: 3_000, freeItemUnits: 2 });
    expect(bySale.get(day.ananComp)).toMatchObject({ isComp: true, compedSatang: 16_000 });
    for (const k of SUM_KEYS.filter((k) => k.endsWith('Satang'))) {
      expect(res.body.rows.reduce((s, r) => s + (r as unknown as Record<string, number>)[k]!, 0), k).toBe(handTotals()[k]);
    }
  });

  it('the Staff Benefits Audit log lists the same five, refunds said in money', async () => {
    const res = await call<{ applications: Array<{ saleId: string; saleStatus: string; refundedSatang: number; appliedSatang: number }> }>(
      'GET',
      `/benefits/applications?branchId=${branchId}`,
      admin,
    );
    expect(res.status, res.raw).toBe(200);
    const mine = res.body.applications.filter((a) =>
      [day.lekMixed, day.ananComp, day.somCapped, day.nokFree, day.lekPercent, day.nokRemoved, day.nokVoided].includes(a.saleId),
    );
    expect(mine).toHaveLength(5);
    expect(mine.reduce((s, a) => s + a.appliedSatang, 0)).toBe(92_100);
    expect(mine.find((a) => a.saleId === day.lekPercent)).toMatchObject({ saleStatus: 'finalised', refundedSatang: 1_000 });
  });

  it('Discounts & Comps: one "Staff benefit" row per benefited order, summing to what came off the bills (Q10)', async () => {
    const res = await call<DiscountTransactions>('GET', `/analytics/reports/discounts/transactions?branches=${branchId}&${range()}`, admin);
    expect(res.status, res.raw).toBe(200);
    const benefitRows = res.body.rows.filter((r) => r.reason === 'Staff benefit');
    expect(benefitRows).toHaveLength(5);
    expect(benefitRows.reduce((s, r) => s + r.amountSatang, 0)).toBe(92_100);
    expect(benefitRows.filter((r) => r.type === 'comp').map((r) => r.amountSatang)).toEqual([16_000]);
    expect(benefitRows.filter((r) => r.type === 'fixed').map((r) => r.amountSatang).sort((a, b) => a - b)).toEqual([
      1_800, 3_000, 6_000, 65_300,
    ]);
    // The order's own discount is its own row, never folded into the benefit's.
    expect(res.body.rows.filter((r) => r.reason === 'Service recovery').map((r) => r.amountSatang)).toEqual([20_000]);
    // The tiles moved by the same money: the comp, and the rest as manual discounts.
    const after = (await call<DiscountReport>('GET', `/analytics/reports/discounts?branches=${branchId}&${range()}`, admin)).body;
    expect(after.compSatang - dcBefore.compSatang).toBe(16_000);
    expect(after.manualDiscountSatang - dcBefore.manualDiscountSatang).toBe(65_300 + 3_000 + 6_000 + 1_800 + 20_000);
    expect(after.freeItemBenefitSatang - dcBefore.freeItemBenefitSatang).toBe(0);
  });

  it('Q4: the refunds gave nothing back — Lek’s coffees and credit, still used, are what the next quote sees', async () => {
    const usage = await ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, people.lek));
    expect(usage.map((u) => [u.itemKey, u.qtyUsed, u.creditUsedSatang]).sort()).toEqual(
      [
        ['credit', 0, 50_000],
        ['free:coffee', 2, 0],
      ].sort(),
    );
    // Nok: her taken-off and voided coffees came back; the one she was given did not.
    const nok = await ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, people.nok));
    expect(nok.map((u) => [u.itemKey, u.qtyUsed])).toEqual([['free:coffee', 1]]);
    const q = await call<{ benefit: { freeItemsSatang: number; creditSatang: number; discountSatang: number } }>(
      'POST',
      '/sales/quote',
      reception,
      cart([line(item.espresso)], codes.lek),
    );
    expect(q.status, q.raw).toBe(200);
    expect(q.body.benefit).toMatchObject({ freeItemsSatang: 0, creditSatang: 0, discountSatang: 1_800 });
  });

  it('replayed: a rollup, the rollover and the runner’s own run write nothing and move no figure', async () => {
    const before = await factOf();
    const again = await runDailyRollupJob(ctx.db, new Date());
    expect([again.benefitRowsWritten, again.benefitRowsRemoved]).toEqual([0, 0]);
    const roll = await runBenefitRolloverJob(ctx.db, new Date());
    expect([roll.rowsWritten, roll.rowsRemoved, roll.daysClosed]).toEqual([0, 0, 0]);
    const all = buildDefaultJobs({ db: ctx.db, env: env(), log: ctx.app.log, channels: [] });
    const runner = createJobRunner({
      db: ctx.db,
      env: env(),
      log: ctx.app.log,
      channels: [],
      jobs: all.filter((j) => j.name === BENEFIT_ROLLOVER_JOB),
    });
    expect(await runner.runJob(BENEFIT_ROLLOVER_JOB, { force: true })).toBe('ok');
    const after = await factOf();
    expect(after.map((r) => [r.id, r.updatedAt.getTime(), r.computedAt.getTime()])).toEqual(
      before.map((r) => [r.id, r.updatedAt.getTime(), r.computedAt.getTime()]),
    );
  });
});

// --- 2. Branch reach ------------------------------------------------------------------------------

describe('branch reach on the two reports and the Audit log', () => {
  let chalongSale = '';
  let mgr = '';
  let chalongMgr = '';
  let second = '';

  beforeAll(async () => {
    // Khun Lek at Robinson Chalong (the espresso is on every park's menu): his
    // coffees are used today, so 30 % of ฿60 = ฿18; he pays ฿42.
    chalongSale = await sold(cart([line(item.espresso)], codes.lek, {}, chalongStationId), 4_200, admin);
    await runDailyRollupJob(ctx.db, new Date());
    mgr = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    chalongMgr = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    second = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  }, 120_000);

  it('Chalong’s benefit is Chalong’s row: a fact of its own, never added into Central Floresta’s', async () => {
    const rows = await factOf(chalongId);
    expect(rows.map((r) => [r.employeeId, r.discountSatang, r.appliedSatang])).toEqual([[people.lek, 1_800, 1_800]]);
    const central = (await factOf()).find((r) => r.employeeId === people.lek)!;
    expect(central.appliedSatang).toBe(67_100);
    const both = await call<BenefitReport>('GET', `/analytics/reports/benefits?branches=${branchId},${chalongId}&${range()}`, admin);
    expect(both.body.totals.appliedSatang).toBe(92_100 + 1_800);
    expect(both.body.days.map((d) => [d.branchId, d.appliedSatang]).sort()).toEqual(
      [
        [branchId, 92_100],
        [chalongId, 1_800],
      ].sort(),
    );
  });

  it('a park’s manager reads their park only: the other park named is omitted, never added in', async () => {
    const res = await call<BenefitReport>('GET', `/analytics/reports/benefits?branches=${branchId},${chalongId}&${range()}`, mgr);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.branches.map((b) => b.branchId)).toEqual([branchId]);
    expect(res.body.omitted).toEqual([chalongId]);
    expect(res.body.totals.appliedSatang).toBe(92_100);
    const list = await call<BenefitTransactions>(
      'GET',
      `/analytics/reports/benefits/transactions?branches=${branchId},${chalongId}&${range()}`,
      mgr,
    );
    expect(list.body.rows.map((r) => r.saleId)).not.toContain(chalongSale);
    const theirs = await call<BenefitTransactions>('GET', `/analytics/reports/benefits/transactions?${range()}`, chalongMgr);
    expect(theirs.status, theirs.raw).toBe(200);
    expect(theirs.body.rows.map((r) => r.saleId)).toEqual([chalongSale]);
    expect((await call('GET', `/analytics/reports/benefits/transactions?branches=${branchId}&${range()}`, chalongMgr)).status).toBe(403);
  });

  it('another operator’s branch or staff member is a 404 on both reports, whoever asks', async () => {
    for (const path of ['/analytics/reports/benefits', '/analytics/reports/benefits/transactions']) {
      expect((await call('GET', `${path}?branches=${secondBranchId}&${range()}`, admin)).status, path).toBe(404);
      expect((await call('GET', `${path}?branches=${branchId}&${range()}`, second)).status, path).toBe(404);
      expect((await call('GET', `${path}?branches=${secondBranchId}&${range()}&employeeId=${people.lek}`, second)).status, path).toBe(404);
      // Unnamed, the foreign operator reads its own park — and nothing of OTO's.
      const own = await call<BenefitReport & BenefitTransactions>('GET', `${path}?${range()}`, second);
      expect(own.status, own.raw).toBe(200);
      expect(own.body.branches.map((b) => b.branchId)).toEqual([secondBranchId]);
      expect(own.raw).not.toContain(people.lek);
      expect(own.raw).not.toContain(branchId);
    }
  });

  it('the Audit log: the foreign operator reads none of OTO’s rows, by reach or by naming the branch', async () => {
    const all = await call<{ applications: unknown[] }>('GET', '/benefits/applications', second);
    expect(all.status, all.raw).toBe(200);
    expect(all.body.applications).toEqual([]);
    const named = await call<{ applications: unknown[] }>('GET', `/benefits/applications?branchId=${branchId}`, second);
    // Its operator-wide grant covers its own operator only; whatever the
    // answer's status, it carries nothing of OTO's.
    expect(named.raw).not.toContain(people.lek);
    expect(named.raw).not.toContain(day.lekMixed);
    if (named.status === 200) expect(named.body.applications).toEqual([]);
    else expect([403, 404]).toContain(named.status);
  });

  it('the Audit log: each park’s manager reads only their park, and is refused the other by name', async () => {
    const central = await call<{ applications: Array<{ branchId: string; saleId: string }> }>('GET', '/benefits/applications', mgr);
    expect(central.status, central.raw).toBe(200);
    expect(central.body.applications.length).toBe(5);
    expect(central.body.applications.every((a) => a.branchId === branchId)).toBe(true);
    const chalong = await call<{ applications: Array<{ branchId: string; saleId: string }> }>('GET', '/benefits/applications', chalongMgr);
    expect(chalong.body.applications.map((a) => a.saleId)).toEqual([chalongSale]);
    expect((await call('GET', `/benefits/applications?branchId=${chalongId}`, mgr)).status).toBe(403);
    expect((await call('GET', `/benefits/applications?branchId=${branchId}`, chalongMgr)).status).toBe(403);
    // The operator's administrator reads both.
    const both = await call<{ applications: Array<{ saleId: string }> }>('GET', '/benefits/applications', admin);
    expect(both.body.applications.map((a) => a.saleId)).toContain(chalongSale);
    expect(both.body.applications.length).toBe(6);
  });

  it('nobody without the permission reads: reception, and an account holding a park’s staff role only', async () => {
    for (const url of [
      '/benefits/applications',
      `/benefits/applications?branchId=${branchId}`,
      `/analytics/reports/benefits?${range()}`,
      `/analytics/reports/benefits/transactions?${range()}`,
    ]) {
      expect((await call('GET', url, reception)).status, url).toBe(403);
    }
    const staffOnly = await makeAccount('+66900004201', [{ role: 'staff', scopeType: 'branch', scopeId: branchId }]);
    for (const url of ['/benefits/applications', `/analytics/reports/benefits/transactions?branches=${branchId}&${range()}`]) {
      const res = await call('GET', url, staffOnly);
      expect(res.status, url).toBe(403);
      expect(res.raw).not.toContain(day.lekMixed);
    }
  });

  it('a manager of one park seated at another (where they hold reception) never reads the seat’s park', async () => {
    // Recorded in review, not blocking: the route's own guard checks
    // admin:benefit:read at the SESSION's branch before the handler reads by
    // reach (the pattern GET /audit has), so this reader is refused 403 both
    // unnamed and naming their own park until they move their session there.
    // Pinned here only that no other park's row ever leaks to them.
    const split = await makeAccount('+66900004202', [
      { role: 'reception', scopeType: 'branch', scopeId: branchId },
      { role: 'branch_manager', scopeType: 'branch', scopeId: chalongId },
    ]);
    const res = await call<{ applications: Array<{ branchId: string }> }>('GET', '/benefits/applications', split);
    const named = await call<{ applications: Array<{ branchId: string }> }>('GET', `/benefits/applications?branchId=${chalongId}`, split);
    expect((await call('GET', `/benefits/applications?branchId=${branchId}`, split)).status).toBe(403);
    for (const r of [res, named]) {
      if (r.status === 200) expect(r.body.applications.every((a) => a.branchId === chalongId)).toBe(true);
      else expect(r.status).toBe(403);
    }
  });
});

// --- 3. The reason read by its letters --------------------------------------------------------------

describe('a till’s own "Staff benefit" row, however it is spelled, is refused at the quote and the commit', () => {
  const REFUSED = [
    'Staffㅤbenefit', // Hangul filler (round 3 probe)
    'Staff⠀benefit', // braille blank (round 3 probe)
    'Staffᅟbenefit', // Hangul choseong filler
    'Staffᅠbenefit', // Hangul jungseong filler
    'Staffﾠbenefit', // halfwidth Hangul filler
    'Staff​benefit', // zero-width space
    'Staff⁠benefit', // word joiner
    'Staff﻿benefit', // BOM
    'Staff­benefit', // soft hyphen
    'Staff᠎benefit', // Mongolian vowel separator
    'Staff͏ benefit', // combining grapheme joiner
    'Staff️ benefit', // variation selector
    'Staff\u{E0020}benefit', // tag space
    'Staff　benefit', // ideographic space
    'Staff benefit', // line separator
    'Staff\tbenefit',
    'Staffbenefit',
    'STAFF-BENEFIT',
    'staff_benefit',
    'Staff. Benefit!',
    'S̶taff benefit', // combining long stroke overlay
    'Ｓｔａｆｆ ｂｅｎｅｆｉｔ', // full-width
    '\u{1D412}\u{1D42D}\u{1D41A}\u{1D41F}\u{1D41F} benefit', // mathematical bold
    'Staff benefit 1',
  ];
  const ACCEPTED = ['Staff meal', 'Service recovery', 'Staff benefits adjustment'];

  const forged = (reason: string) =>
    cart([line(item.hotdog)], null, {
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'comp', value: 0, reason, note: 'Scanned: Khun Anan (owner)' }],
    });

  it('every probe is refused BENEFIT_DISCOUNT_UNLINKED, and no sale is written', async () => {
    for (const reason of REFUSED) {
      const q = await call('POST', '/sales/quote', reception, forged(reason));
      expect(q.status, JSON.stringify(reason)).toBe(409);
      expect(q.body.error!.code, JSON.stringify(reason)).toBe('BENEFIT_DISCOUNT_UNLINKED');
      const c = await commit(forged(reason));
      expect(c.status, JSON.stringify(reason)).toBe(409);
      expect(c.body.error!.code, JSON.stringify(reason)).toBe('BENEFIT_DISCOUNT_UNLINKED');
      expect(await ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.id, c.saleId)), JSON.stringify(reason)).toHaveLength(0);
    }
  });

  it('an ordinary manual comp whose letters are not the reason’s still rings up', async () => {
    for (const reason of ACCEPTED) {
      const q = await call<{ totals: { grossSatang: number } }>('POST', '/sales/quote', reception, forged(reason));
      expect(q.status, `${reason}: ${q.raw}`).toBe(200);
      expect(q.body.totals.grossSatang).toBe(0);
    }
  });
});

// --- 4. The seeded future Manager edit ----------------------------------------------------------------

describe('the seeded Manager edit is inert until its day, and one version answers every day around it', () => {
  it('Khun Lek reads ฿500 up to the day before, ฿600 from the day; the template’s history is the two versions', async () => {
    const from = benefitSeedFutureFrom(today);
    const credit = async (on: string) => {
      const res = await call<{ profile: { credit?: { amountSatang: number } }; templateVersionId: string | null }>(
        'GET',
        `/benefits/profiles/${people.lek}/effective?on=${on}`,
        admin,
      );
      expect(res.status, res.raw).toBe(200);
      return [res.body.profile.credit?.amountSatang, res.body.templateVersionId] as const;
    };
    const rows = await ctx.db
      .select()
      .from(benefitRoleTemplate)
      .where(and(eq(benefitRoleTemplate.operatorId, operatorId), eq(benefitRoleTemplate.role, 'manager')));
    expect(rows).toHaveLength(2);
    const seeded = rows.find((r) => r.effectiveTo === from)!;
    const future = rows.find((r) => r.effectiveFrom === from)!;
    expect(future.effectiveTo).toBeNull();
    for (const on of [today, addDaysToIsoDate(today, 1), addDaysToIsoDate(from, -1)]) {
      expect(await credit(on), on).toEqual([50_000, seeded.id]);
    }
    for (const on of [from, addDaysToIsoDate(from, 1), addDaysToIsoDate(from, 400)]) {
      expect(await credit(on), on).toEqual([60_000, future.id]);
    }
    // Today's checkout priced at ฿500: Khun Lek's whole credit went on the mixed order above.
    const [mixed] = await appsOf(day.lekMixed);
    expect(mixed!.creditSatang).toBe(50_000);
  });

  it('a seed run on a later month writes nothing new: no third version, no QR', async () => {
    const templates = await ctx.db.select().from(benefitRoleTemplate);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 75 * 86_400_000));
    try {
      // The seed, run now, would date the edit from another month: convergence
      // has to come from what is already there, not from the date matching.
      expect(benefitSeedFutureFrom(businessDate(new Date(), timezone, dayStartMinutes))).not.toBe(
        benefitSeedFutureFrom(today),
      );
      await seed(ctx.db);
    } finally {
      vi.useRealTimers();
    }
    const sorted = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(sorted(await ctx.db.select().from(benefitRoleTemplate))).toEqual(sorted(templates));
  }, 300_000);
});

// --- 5. Audit rows, and no QR anywhere -----------------------------------------------------------------

describe('audit rows for everything the day changed, and no benefit QR anywhere it could be read back', () => {
  it('each application one benefit.apply; the comp one benefit.comp; the taken-off and voided one benefit.remove; no reversal', async () => {
    const live = [day.lekMixed, day.ananComp, day.somCapped, day.nokFree, day.lekPercent];
    const apps = await ctx.db
      .select()
      .from(benefitApplication)
      .where(inArray(benefitApplication.saleId, [...live, day.nokRemoved, day.nokVoided]));
    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.entityId, apps.map((a) => a.id)));
    for (const a of apps) {
      const mine = rows.filter((r) => r.entityId === a.id).map((r) => r.action).sort();
      if (a.saleId === day.ananComp) expect(mine, a.saleId).toEqual(['benefit.apply', 'benefit.comp']);
      else if (a.removedReason) expect(mine, a.saleId).toEqual(['benefit.apply', 'benefit.remove']);
      else expect(mine, a.saleId).toEqual(['benefit.apply']);
    }
    const removal = rows.find((r) => r.action === 'benefit.remove' && apps.find((a) => a.id === r.entityId)!.saleId === day.nokVoided);
    expect(removal!.after).toMatchObject({ reason: 'voided' });
    expect(await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'benefit.reverse'))).toEqual([]);
    // The two refunds and the void are audited as what they are, on their sales.
    const refunds = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'sale.refund'), inArray(auditLog.entityId, [day.lekMixed, day.lekPercent])));
    expect(refunds.map((r) => [r.entityId, (r.after as { refundedSatang: number }).refundedSatang]).sort()).toEqual(
      [
        [day.lekMixed, 7_700],
        [day.lekPercent, 1_000],
      ].sort(),
    );
    const voids = await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'sale.void'), eq(auditLog.entityId, day.nokVoided)));
    expect(voids).toHaveLength(1);
  });

  it('no QR — nor its signature — in the audit log, the idempotency store, the job runs, the fact or any answer', async () => {
    const secrets = Object.values(codes).flatMap((c) => [c, c.slice(c.lastIndexOf('.') + 1)]);
    expect(secrets.every((s) => s.length >= 20)).toBe(true);
    const haystacks: Array<[string, string]> = [
      ['audit_log', JSON.stringify(await ctx.db.select().from(auditLog))],
      ['idempotency_key', JSON.stringify(await ctx.db.select().from(idempotencyKey))],
      ['ops_run', JSON.stringify(await ctx.db.select().from(opsRun))],
      ['fact_benefit_daily', JSON.stringify(await ctx.db.select().from(factBenefitDaily))],
      ['benefit_application', JSON.stringify(await ctx.db.select().from(benefitApplication))],
      ['report', (await call('GET', `/analytics/reports/benefits?${range()}`, admin)).raw],
      ['transactions', (await call('GET', `/analytics/reports/benefits/transactions?${range()}`, admin)).raw],
      ['applications', (await call('GET', '/benefits/applications', admin)).raw],
      ['discounts', (await call('GET', `/analytics/reports/discounts/transactions?${range()}`, admin)).raw],
    ];
    const { rows } = await ctx.db.execute<{ t: string }>(sql`select string_agg(note || ' ' || reason, ' ') as t from pos.sale_discount`);
    haystacks.push(['sale_discount', rows[0]?.t ?? '']);
    for (const [where, text] of haystacks) {
      for (const secret of secrets) expect(text.includes(secret), `${where} carries a benefit QR`).toBe(false);
    }
  });
});

// --- 6. The rollover at the period edge, and its alerts --------------------------------------------------

describe('job:benefit.period_rollover at the period edge, and its expectation', () => {
  /** The first instant of the next trading day at the branch, to the millisecond. */
  function nextDayStart(): Date {
    let lo = Date.now();
    let hi = lo + 48 * 3_600_000;
    expect(businessDate(new Date(lo), timezone, dayStartMinutes)).toBe(today);
    expect(businessDate(new Date(hi), timezone, dayStartMinutes) > today).toBe(true);
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (businessDate(new Date(mid), timezone, dayStartMinutes) === today) lo = mid;
      else hi = mid;
    }
    return new Date(hi);
  }

  it('one millisecond before the day starts nothing of today closes; at the instant it does — the figures unmoved', async () => {
    await runDailyRollupJob(ctx.db, new Date());
    const before = await factOf();
    expect(before.length).toBe(4);
    expect(before.every((r) => r.provisional)).toBe(true);
    const edge = nextDayStart();
    expect(businessDate(new Date(edge.getTime() - 1), timezone, dayStartMinutes)).toBe(today);
    expect(businessDate(edge, timezone, dayStartMinutes)).toBe(addDaysToIsoDate(today, 1));

    const early = await runBenefitRolloverJob(ctx.db, new Date(edge.getTime() - 1));
    expect(early.rowsWritten).toBe(0);
    expect((await factOf()).every((r) => r.provisional)).toBe(true);
    // The daily rollup a millisecond early keeps the day open too.
    await runDailyRollupJob(ctx.db, new Date(edge.getTime() - 1));
    expect((await factOf()).every((r) => r.provisional)).toBe(true);

    const onTime = await runBenefitRolloverJob(ctx.db, edge);
    // Today's two parks' rows: Central Floresta's four and Chalong's one.
    expect(onTime.rowsWritten).toBe(5);
    expect(onTime.daysClosed).toBe(2);
    const after = await factOf();
    expect(after.every((r) => !r.provisional)).toBe(true);
    const strip = (r: (typeof after)[number]) => ({ ...r, provisional: null, updatedAt: null, computedAt: null });
    expect(after.map(strip)).toEqual(before.map(strip));
    const report = await call<BenefitReport>('GET', `/analytics/reports/benefits?branches=${branchId}&${range()}`, admin);
    expect(report.body.days.map((d) => d.provisional)).toEqual([false]);
    expect(report.body.totals.appliedSatang).toBe(92_100);
    // Rerun at the same instant: nothing.
    const again = await runBenefitRolloverJob(ctx.db, edge);
    expect([again.rowsWritten, again.daysClosed]).toEqual([0, 0]);
  });

  it('a rollover that fails three times running raises ops.failing; one that has not succeeded in time, ops.missing; both clear', async () => {
    const all = buildDefaultJobs({ db: ctx.db, env: env(), log: ctx.app.log, channels: [] });
    const runner = createJobRunner({
      db: ctx.db,
      env: env(),
      log: ctx.app.log,
      channels: [],
      jobs: all.filter((j) => j.name === BENEFIT_ROLLOVER_JOB),
    });
    await runner.start();
    await runner.stop();
    // A provisional row for an ended day the applications do not have: the
    // rollover must remove it — and a trigger refuses every write, so it fails.
    const ended = addDaysToIsoDate(today, -2);
    await ctx.db.insert(factBenefitDaily).values({
      id: newId(),
      operatorId,
      branchId,
      businessDate: ended,
      employeeId: people.som,
      benefitRole: 'staff',
      applications: 1,
      discountCount: 1,
      discountSatang: 100,
      totalReliefSatang: 100,
      appliedSatang: 100,
      provisional: true,
      computedAt: new Date(),
    });
    await ctx.db.execute(sql`create or replace function analytics.s221_r4_review_refuse() returns trigger language plpgsql as $$
      begin raise exception 's221 r4 review: refused'; end $$`);
    await ctx.db.execute(sql`create trigger s221_r4_review_refuse before insert or update or delete on analytics.fact_benefit_daily
      for each row execute function analytics.s221_r4_review_refuse()`);
    try {
      for (let i = 0; i < 3; i += 1) expect(await runner.runJob(BENEFIT_ROLLOVER_JOB, { force: true })).toBe('failed');
    } finally {
      await ctx.db.execute(sql`drop trigger s221_r4_review_refuse on analytics.fact_benefit_daily`);
      await ctx.db.execute(sql`drop function analytics.s221_r4_review_refuse()`);
    }
    const [last] = await ctx.db.select().from(opsLast).where(eq(opsLast.name, BENEFIT_ROLLOVER_JOB));
    expect(last!.consecutiveFailures).toBeGreaterThanOrEqual(3);
    const watchdog = () => runWatchdog({ db: ctx.db, env: env(), log: ctx.app.log, channels: [] });
    await watchdog();
    const failKey = `ops.failing:${BENEFIT_ROLLOVER_JOB}`;
    const missKey = `ops.missing:${BENEFIT_ROLLOVER_JOB}`;
    expect((await ctx.db.select().from(alert).where(eq(alert.key, failKey)))[0]).toMatchObject({ status: 'open' });
    // The last success long ago: missing too.
    await ctx.db
      .update(opsLast)
      .set({ lastOkAt: new Date(Date.now() - 3 * 3_600_000) })
      .where(eq(opsLast.name, BENEFIT_ROLLOVER_JOB));
    await watchdog();
    expect((await ctx.db.select().from(alert).where(eq(alert.key, missKey)))[0]).toMatchObject({ status: 'open' });

    // The writes allowed again: the next run succeeds, removes the stray row, and both alerts close.
    expect(await runner.runJob(BENEFIT_ROLLOVER_JOB, { force: true })).toBe('ok');
    expect(await factOf(branchId, ended)).toEqual([]);
    await watchdog();
    expect((await ctx.db.select().from(alert).where(eq(alert.key, failKey)))[0]!.status).toBe('resolved');
    expect((await ctx.db.select().from(alert).where(eq(alert.key, missKey)))[0]!.status).toBe('resolved');
  });
});
