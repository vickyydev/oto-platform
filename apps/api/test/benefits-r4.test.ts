import { generateKeyPairSync } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  alert,
  auditLog,
  benefitApplication,
  benefitUsage,
  branch,
  dailySummary,
  employee,
  factBenefitDaily,
  opsExpectation,
  opsLast,
  opsRun,
  paymentAttempt,
  product,
  productCategory,
  sale,
  saleDiscount,
  station,
  wallet,
  walletEntry,
} from '@oto/db';
import {
  addDaysToIsoDate,
  benefitPeriodKey,
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
  CHALONG_MANAGER,
  OTO_OPERATOR_NAME,
  RECEPTION,
  createTestContext,
  operatorIdByName,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { loadEnv } from '../src/env';
import { buildDefaultJobs, createJobRunner, runWatchdog } from '../src/services/jobs';
import { ROLLUP_DAILY_JOB, runDailyRollupJob } from '../src/services/analytics-rollup';
import {
  BENEFIT_ROLLOVER_JOB,
  closeBenefitBranchDay,
  endsAMonth,
  runBenefitRolloverJob,
} from '../src/services/analytics-benefits';

/**
 * S2-21 (SCRUM-218) round 4 — the staff benefits' day, reported, refunded and
 * closed (docs/progress/plans/benefits/PLAN.md §5, §7, §8 round 4; the
 * question defaults Q4 and Q10).
 *
 *   - the fact (`analytics.fact_benefit_daily`) the daily rollup writes, equal
 *     to the applications it reads; GET /analytics/reports/benefits — the
 *     plan's GET /reports/benefits, on the S2-15b reports' shape — split the
 *     prototype's four ways per role, per beneficiary and per day, and its
 *     per-application list;
 *   - Discounts & Comps keeps the prototype's one "Staff benefit" row per
 *     benefited order (Q10's default): a comp row for an owner's comp, a
 *     fixed row for the rest, with the beneficiary in the note and the
 *     processor as who applied it;
 *   - a refund of a benefited order (Q4's default): the quota stays used, the
 *     application, its row and its audit entry stay, nothing is reversed — and
 *     the Audit log and the list say what the order gave back in money;
 *   - H9 (no wallet moves) and H10 (the relief is never revenue or a tender);
 *   - job:benefit.period_rollover: registered with its expectation, closes
 *     each ended day (and, on the last of a month, the month), writes nothing
 *     on a rerun, raises ops.missing when it stops; and the periods themselves
 *     roll by key at the branch's business day, with or without it (H13's
 *     server half).
 */

const keys = generateKeyPairSync('ed25519');
const PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let ctx: TestContext;
let admin: string;
let reception: string;
let operatorId: string;
let branchId: string;
let receptionId: string;
let stationId: string;
let today = '';
let timezone = '';
let dayStartMinutes = 0;
const item = { espresso: '', water: '', hotdog: '' };
const people = { anan: '', som: '', nok: '', lek: '', mali: '' };
const codes = { anan: '', som: '', nok: '', lek: '', mali: '' };

let n = 0;
const idem = () => `benefits-r4-${process.pid}-${Date.now()}-${n++}`;

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

let pickup = 70;
function cart(items: ReturnType<typeof line>[], code?: string | null) {
  return {
    stationId,
    channel: 'fnb',
    pickupCode: String(pickup++),
    items,
    ...(code ? { benefit: { applicationId: newId(), code } } : {}),
  };
}

interface Breakdown {
  freeItemsSatang: number;
  creditSatang: number;
  discountSatang: number;
  compedSatang: number;
  totalReliefSatang: number;
}

async function quote(body: Record<string, unknown>) {
  return call<{ benefit: Breakdown | null; totals: { grossSatang: number } }>('POST', '/sales/quote', reception, body);
}

/** Ring an order up and close it by cash (or with nothing owed). */
async function sold(body: Record<string, unknown>): Promise<{ saleId: string; gross: number }> {
  const saleId = newId();
  const res = await call<{ sale: { totals: { grossSatang: number } } }>('POST', '/sales', reception, {
    id: saleId,
    actionId: newId(),
    ...body,
  });
  expect(res.status, res.raw).toBe(200);
  const gross = res.body.sale.totals.grossSatang;
  const closed = await call('POST', `/sales/${saleId}/finalise`, reception, gross > 0 ? { method: 'cash', amountSatang: gross } : {});
  expect(closed.status, closed.raw).toBe(200);
  return { saleId, gross };
}

const report = (query = '') =>
  call<BenefitReport>('GET', `/analytics/reports/benefits?branches=${branchId}&from=${today}&to=${today}${query}`, admin);
const transactions = (query = '') =>
  call<BenefitTransactions>(
    'GET',
    `/analytics/reports/benefits/transactions?branches=${branchId}&from=${today}&to=${today}${query}`,
    admin,
  );
const factRows = () =>
  ctx.db
    .select()
    .from(factBenefitDaily)
    .where(and(eq(factBenefitDaily.branchId, branchId), eq(factBenefitDaily.businessDate, today)));
const rollup = () => runDailyRollupJob(ctx.db, new Date());

/** The sale facts these tests ring up, by name. */
const sales = { lek: { saleId: '', gross: 0 }, anan: { saleId: '', gross: 0 }, som: { saleId: '', gross: 0 } };

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PRIVATE_KEY } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  operatorId = await operatorIdByName(ctx.db, OTO_OPERATOR_NAME);
  const [rec] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
  receptionId = rec!.id;
  const tills = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  const t1 = tills.find((s) => s.kind === 'till' && s.codePrefix === 'T1')!;
  stationId = t1.id;
  branchId = t1.branchId;
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
    name: 'Espresso (r4)',
    code: 'FB-ESPRESSO-R4',
    priceSatang: 6_000,
    categoryId: coffee!.id,
  });
  const menu = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  item.water = menu.find((p) => p.code === 'FB-WATER')!.id;
  item.hotdog = menu.find((p) => p.code === 'FB-HOTDOG')!.id;

  // A second manager, as the OTO App copy would bring one: the monthly
  // credit's own person for the period tests, untouched by the sales below.
  people.mali = newId();
  await ctx.db.insert(employee).values({ id: people.mali, operatorId, branchId, name: 'Khun Mali (r4 Manager)' });
  const role = await call('PUT', `/benefits/profiles/${people.mali}`, admin, { benefitRole: 'manager', override: null });
  expect(role.status, role.raw).toBe(200);

  const staff = await ctx.db.select({ id: employee.id, name: employee.name }).from(employee).where(eq(employee.operatorId, operatorId));
  const byName = (name: string) => staff.find((r) => r.name === name)!.id;
  people.anan = byName('Khun Anan (Owner)');
  people.som = byName('Som (Reception)');
  people.nok = byName('Nok (Reception)');
  people.lek = byName('Khun Lek (Manager)');
  for (const who of ['anan', 'som', 'nok', 'lek', 'mali'] as const) {
    const issued = await call<{ credential: { id: string } }>('POST', '/benefits/credentials', admin, { employeeId: people[who] });
    expect(issued.status, issued.raw).toBe(200);
    codes[who] = (await call<{ code: string }>('GET', `/benefits/credentials/${issued.body.credential.id}/qr`, admin)).body.code;
  }
}, 240_000);

afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

// --- The day's benefits ---------------------------------------------------------------------

describe('the benefits’ day: sold, rolled up and reported', () => {
  let fnbBefore = 0;
  let walletEntriesBefore = 0;
  let walletBalanceBefore = 0;

  beforeAll(async () => {
    await rollup();
    const [day] = await ctx.db
      .select()
      .from(dailySummary)
      .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, today), eq(dailySummary.source, 'oto_pos')));
    fnbBefore = day?.fnbSatang ?? 0;
    walletEntriesBefore = (await ctx.db.select({ id: walletEntry.id }).from(walletEntry)).length;
    walletBalanceBefore = (await ctx.db.select({ b: wallet.balanceSatang }).from(wallet)).reduce((s, w) => s + w.b, 0);

    // Khun Lek: 3 espressos and 5 hot dogs (฿730) — 2 coffees ฿120, the ฿500
    // credit, 30 % of the ฿110 left; the guest pays ฿77.
    sales.lek = await sold(cart([line(item.espresso, 3), line(item.hotdog, 5)], codes.lek));
    // Khun Anan: the owner's comp — two waters and a hot dog (฿160) to ฿0.
    sales.anan = await sold(cart([line(item.water, 2), line(item.hotdog, 1)], codes.anan));
    // Som: two espressos and a hot dog — her two coffees ฿120, 30 % of ฿110.
    sales.som = await sold(cart([line(item.espresso, 2), line(item.hotdog, 1)], codes.som));
    expect([sales.lek.gross, sales.anan.gross, sales.som.gross]).toEqual([7_700, 0, 7_700]);
    await rollup();
  }, 120_000);

  it('H10 — the relief is never revenue nor a tender: the day’s F&B revenue moves by what the guests paid', async () => {
    const [day] = await ctx.db
      .select()
      .from(dailySummary)
      .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, today), eq(dailySummary.source, 'oto_pos')));
    expect(day!.fnbSatang - fnbBefore).toBe(7_700 + 0 + 7_700);
    const attempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(inArray(paymentAttempt.saleId, [sales.lek.saleId, sales.anan.saleId, sales.som.saleId]));
    // Cash for what the guests paid, and nothing that names a benefit.
    expect(attempts.map((a) => a.method).sort()).toEqual(['cash', 'cash']);
    expect(attempts.reduce((s, a) => s + a.amountSatang, 0)).toBe(15_400);
    expect(JSON.stringify(attempts)).not.toMatch(/benefit/i);
  });

  it('H9 — no wallet moves: no wallet entry is written and no balance changes', async () => {
    expect((await ctx.db.select({ id: walletEntry.id }).from(walletEntry)).length).toBe(walletEntriesBefore);
    const balance = (await ctx.db.select({ b: wallet.balanceSatang }).from(wallet)).reduce((s, w) => s + w.b, 0);
    expect(balance).toBe(walletBalanceBefore);
  });

  it('the daily rollup writes one row per beneficiary and role, provisional today, equal to the applications', async () => {
    const rows = await factRows();
    const of = (employeeId: string) => rows.find((r) => r.employeeId === employeeId)!;
    expect(rows).toHaveLength(3);
    expect(of(people.lek)).toMatchObject({
      benefitRole: 'manager',
      applications: 1,
      compCount: 0,
      freeItemsCount: 1,
      freeItemUnits: 2,
      freeItemsSatang: 12_000,
      creditCount: 1,
      creditSatang: 50_000,
      discountCount: 1,
      discountSatang: 3_300,
      totalReliefSatang: 65_300,
      appliedSatang: 65_300,
      provisional: true,
      operatorId,
    });
    expect(of(people.anan)).toMatchObject({
      benefitRole: 'owner',
      applications: 1,
      compCount: 1,
      compedSatang: 16_000,
      freeItemUnits: 0,
      totalReliefSatang: 16_000,
      appliedSatang: 16_000,
    });
    expect(of(people.som)).toMatchObject({
      benefitRole: 'staff',
      freeItemUnits: 2,
      freeItemsSatang: 12_000,
      creditSatang: 0,
      creditCount: 0,
      discountSatang: 3_300,
      totalReliefSatang: 15_300,
    });
    // Every row is its applications, summed.
    const apps = await ctx.db
      .select()
      .from(benefitApplication)
      .where(and(eq(benefitApplication.branchId, branchId), eq(benefitApplication.businessDate, today)));
    for (const row of rows) {
      const mine = apps.filter((a) => a.employeeId === row.employeeId && a.removedAt === null);
      expect(row.totalReliefSatang).toBe(mine.reduce((s, a) => s + a.totalReliefSatang, 0));
      expect(row.appliedSatang).toBe(mine.reduce((s, a) => s + a.appliedSatang, 0));
    }
  });

  it('a second rollup writes nothing: the rows are only rewritten when a figure moved', async () => {
    const before = await factRows();
    const detail = await rollup();
    expect(detail.benefitRowsWritten).toBe(0);
    expect(detail.benefitRowsRemoved).toBe(0);
    const after = await factRows();
    expect(after.map((r) => [r.id, r.updatedAt.getTime()])).toEqual(before.map((r) => [r.id, r.updatedAt.getTime()]));
  });

  it('GET /analytics/reports/benefits splits the relief four ways, per role, per beneficiary and per day', async () => {
    // Called directly above, the rollup left no run behind; through the runner
    // it does, and that run is when the figures were last brought up to date.
    expect((await report()).body.lastRolledUpAt).toBeNull();
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused', PROCESS_ROLES: 'api,jobs' });
    const daily = buildDefaultJobs({ db: ctx.db, env, log: ctx.app.log, channels: [] }).find((j) => j.name === ROLLUP_DAILY_JOB)!;
    const runner = createJobRunner({ db: ctx.db, env, log: ctx.app.log, channels: [], jobs: [daily] });
    expect(await runner.runJob(ROLLUP_DAILY_JOB, { force: true })).toBe('ok');
    const res = await report();
    expect(res.status, res.raw).toBe(200);
    expect(res.body.totals).toEqual({
      applications: 3,
      compCount: 1,
      compedSatang: 16_000,
      freeItemsCount: 2,
      freeItemUnits: 4,
      freeItemsSatang: 24_000,
      creditCount: 1,
      creditSatang: 50_000,
      discountCount: 2,
      discountSatang: 6_600,
      totalReliefSatang: 96_600,
      appliedSatang: 96_600,
    });
    expect(res.body.byRole.map((r) => [r.role, r.totalReliefSatang])).toEqual([
      ['owner', 16_000],
      ['manager', 65_300],
      ['staff', 15_300],
    ]);
    expect(res.body.byBeneficiary.map((r) => [r.name, r.role, r.appliedSatang])).toEqual([
      ['Khun Lek (Manager)', 'manager', 65_300],
      ['Khun Anan (Owner)', 'owner', 16_000],
      ['Som (Reception)', 'staff', 15_300],
    ]);
    expect(res.body.days).toHaveLength(1);
    expect(res.body.days[0]).toMatchObject({ businessDate: today, branchId, provisional: true, totalReliefSatang: 96_600 });
    expect(res.body.lastRolledUpAt).not.toBeNull();
    expect(res.body).toMatchObject({ employeeId: null, role: null, omitted: [] });
  });

  it('narrowed to one beneficiary or one role; a staff member this operator does not have is a 404', async () => {
    const lek = await report(`&employeeId=${people.lek}`);
    expect(lek.status).toBe(200);
    expect(lek.body.totals.totalReliefSatang).toBe(65_300);
    expect(lek.body.byBeneficiary.map((r) => r.employeeId)).toEqual([people.lek]);
    const owners = await report('&role=owner');
    expect(owners.body.totals).toMatchObject({ applications: 1, compedSatang: 16_000, totalReliefSatang: 16_000 });
    expect(owners.body.role).toBe('owner');
    expect((await report(`&employeeId=${newId()}`)).status).toBe(404);
    expect((await report('&role=cashier')).status).toBe(400);
  });

  it('the per-application list names the beneficiary, the processor, the sale and the four amounts', async () => {
    const res = await transactions();
    expect(res.status, res.raw).toBe(200);
    expect(res.body.rows).toHaveLength(3);
    const lek = res.body.rows.find((r) => r.saleId === sales.lek.saleId)!;
    const [rung] = await ctx.db.select().from(sale).where(eq(sale.id, sales.lek.saleId));
    expect(lek).toMatchObject({
      employeeId: people.lek,
      beneficiaryName: 'Khun Lek (Manager)',
      benefitRole: 'manager',
      processedByAccountId: receptionId,
      transactionId: rung!.receiptNumber ?? sales.lek.saleId,
      stationId,
      origin: 'cloud',
      saleStatus: 'finalised',
      refundedSatang: 0,
      isComp: false,
      freeItemsSatang: 12_000,
      freeItemUnits: 2,
      creditSatang: 50_000,
      discountSatang: 3_300,
      totalReliefSatang: 65_300,
      appliedSatang: 65_300,
    });
    expect(lek.processedByName.length).toBeGreaterThan(0);
    expect(res.body.rows.find((r) => r.saleId === sales.anan.saleId)).toMatchObject({ isComp: true, compedSatang: 16_000 });
    // Newest first.
    expect(res.body.rows.map((r) => r.at)).toEqual([...res.body.rows.map((r) => r.at)].sort().reverse());
    const staffOnly = await transactions('&role=staff');
    expect(staffOnly.body.rows.map((r) => r.saleId)).toEqual([sales.som.saleId]);
  });

  it('read per branch on analytics:read: reception is refused; another park’s manager adds nothing of this park in', async () => {
    const res = await call('GET', `/analytics/reports/benefits?from=${today}&to=${today}`, reception);
    expect(res.status).toBe(403);
    const list = await call('GET', `/analytics/reports/benefits/transactions?from=${today}&to=${today}`, reception);
    expect(list.status).toBe(403);
    const chalong = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const theirs = await call<BenefitReport>('GET', `/analytics/reports/benefits?from=${today}&to=${today}`, chalong);
    expect(theirs.status, theirs.raw).toBe(200);
    expect(theirs.body.branches.map((b) => b.branchId)).not.toContain(branchId);
    expect(theirs.body.totals.applications).toBe(0);
    const named = await call<BenefitReport>(
      'GET',
      `/analytics/reports/benefits?branches=${branchId}&from=${today}&to=${today}`,
      chalong,
    );
    expect(named.status).toBe(403);
    const own = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
    const mine = await call<BenefitReport>('GET', `/analytics/reports/benefits?from=${today}&to=${today}`, own);
    expect(mine.status).toBe(200);
    expect(mine.body.totals.totalReliefSatang).toBe(96_600);
  });
});

// --- Discounts & Comps (plan Q10's default) ---------------------------------------------------

describe('Discounts & Comps carries each benefited order as the prototype’s one "Staff benefit" row (Q10)', () => {
  it('a comp row for the owner’s comp, a fixed row for the rest, the beneficiary in the note and the processor as who applied it', async () => {
    const res = await call<DiscountTransactions>(
      'GET',
      `/analytics/reports/discounts/transactions?branches=${branchId}&from=${today}&to=${today}`,
      admin,
    );
    expect(res.status, res.raw).toBe(200);
    const benefitRows = res.body.rows.filter((r) => r.reason === 'Staff benefit');
    expect(benefitRows).toHaveLength(3);
    const names = await transactions();
    const processor = names.body.rows[0]!.processedByName;
    const byNote = (note: string) => benefitRows.find((r) => r.note === note)!;
    expect(byNote('Scanned: Khun Lek (Manager) (manager)')).toMatchObject({ source: 'fnb', type: 'fixed', amountSatang: 65_300 });
    expect(byNote('Scanned: Khun Anan (Owner) (owner)')).toMatchObject({ source: 'fnb', type: 'comp', amountSatang: 16_000 });
    expect(byNote('Scanned: Som (Reception) (staff)')).toMatchObject({ source: 'fnb', type: 'fixed', amountSatang: 15_300 });
    for (const row of benefitRows) expect(row.appliedBy).toBe(processor);
    // One row per order, as the prototype folds it: the split is the benefits report's.
    expect(new Set(benefitRows.map((r) => r.transactionId)).size).toBe(3);
  });

  it('the tiles count the comp as a comp and the relief as a manual discount; the panel’s shape is the prototype’s', async () => {
    const res = await call<DiscountReport>(
      'GET',
      `/analytics/reports/discounts?branches=${branchId}&from=${today}&to=${today}`,
      admin,
    );
    expect(res.status, res.raw).toBe(200);
    expect(res.body.compSatang).toBeGreaterThanOrEqual(16_000);
    expect(res.body.manualDiscountSatang).toBeGreaterThanOrEqual(65_300 + 15_300);
    // Q10's default: no four-way split on the panel.
    expect(Object.keys(res.body).sort()).toEqual(
      ['branches', 'byOperator', 'compSatang', 'freeItemBenefitSatang', 'from', 'manualDiscountSatang', 'omitted', 'promoByType', 'promoSatang', 'to'].sort(),
    );
    // The staff benefits' free coffees are not the promo free-item tile.
    expect(res.body.freeItemBenefitSatang).toBe(0);
  });
});

// --- A refund of a benefited order (plan Q4's default) ------------------------------------------

describe('a refund of a benefited order gives no quota back (plan Q4’s default)', () => {
  let factBefore: typeof factBenefitDaily.$inferSelect | undefined;

  beforeAll(async () => {
    factBefore = (await factRows()).find((r) => r.employeeId === people.som);
    const refund = await call<{ refund: { amountSatang: number } }>('POST', `/sales/${sales.som.saleId}/refunds`, admin, {
      mode: 'whole',
      reason: 'Guest changed their mind',
      actionId: newId(),
    });
    expect(refund.status, refund.raw).toBe(200);
  }, 60_000);

  it('the sale is refunded; the coffees stay used, and the application is neither removed nor reversed', async () => {
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, sales.som.saleId));
    expect(row).toMatchObject({ status: 'refunded', refundedSatang: 7_700 });
    const usage = await ctx.db
      .select()
      .from(benefitUsage)
      .where(and(eq(benefitUsage.employeeId, people.som), eq(benefitUsage.itemKey, 'free:coffee')));
    expect(usage.map((u) => [u.periodKey, u.qtyUsed])).toEqual([[benefitPeriodKey('daily', today), 2]]);
    const [app] = await ctx.db.select().from(benefitApplication).where(eq(benefitApplication.saleId, sales.som.saleId));
    expect(app).toMatchObject({ removedAt: null, reversedAt: null, reversedByRefundId: null, appliedSatang: 15_300 });
    const reverse = await ctx.db
      .select()
      .from(auditLog)
      .where(and(inArray(auditLog.action, ['benefit.reverse', 'benefit.remove']), eq(auditLog.entityId, app!.id)));
    expect(reverse).toEqual([]);
    const [linked] = await ctx.db
      .select()
      .from(saleDiscount)
      .where(and(eq(saleDiscount.saleId, sales.som.saleId), eq(saleDiscount.benefitApplicationId, app!.id)));
    expect(linked).toMatchObject({ reason: 'Staff benefit', amountSatang: 15_300 });
  });

  it('Som’s next coffee today finds her two used, and still gets the 30 %', async () => {
    const q = await quote(cart([line(item.espresso)], codes.som));
    expect(q.status, q.raw).toBe(200);
    expect(q.body.benefit).toMatchObject({ freeItemsSatang: 0, discountSatang: 1_800, totalReliefSatang: 1_800 });
  });

  it('the Audit log keeps the entry and says what the order gave back in money', async () => {
    const res = await call<{ applications: Array<{ saleId: string; saleStatus: string; refundedSatang: number; totalReliefSatang: number }> }>(
      'GET',
      '/benefits/applications',
      admin,
    );
    expect(res.status).toBe(200);
    expect(res.body.applications.find((a) => a.saleId === sales.som.saleId)).toMatchObject({
      saleStatus: 'refunded',
      refundedSatang: 7_700,
      totalReliefSatang: 15_300,
    });
    expect(res.body.applications.find((a) => a.saleId === sales.lek.saleId)).toMatchObject({
      saleStatus: 'finalised',
      refundedSatang: 0,
    });
  });

  it('the figures: the relief stays on its day, the refund is the sale’s, and Discounts & Comps keeps the row', async () => {
    // The refund marked the day; the rollup recomputed it and the row did not move.
    const detail = await rollup();
    expect(detail.benefitRowsWritten).toBe(0);
    const after = (await factRows()).find((r) => r.employeeId === people.som)!;
    expect({ ...after, updatedAt: null, computedAt: null }).toEqual({ ...factBefore!, updatedAt: null, computedAt: null });
    const list = await transactions(`&employeeId=${people.som}`);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0]).toMatchObject({ saleStatus: 'refunded', refundedSatang: 7_700, appliedSatang: 15_300 });
    const discounts = await call<DiscountTransactions>(
      'GET',
      `/analytics/reports/discounts/transactions?branches=${branchId}&from=${today}&to=${today}`,
      admin,
    );
    expect(discounts.body.rows.filter((r) => r.note === 'Scanned: Som (Reception) (staff)')).toHaveLength(1);
  });
});

// --- The rollover ---------------------------------------------------------------------------------

describe('job:benefit.period_rollover — the previous period, closed at the day start', () => {
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused', PROCESS_ROLES: 'api,jobs' });

  it('is registered on the day-end jobs’ cadence, and registering it wrote its expectation', async () => {
    const all = buildDefaultJobs({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const job = all.find((j) => j.name === BENEFIT_ROLLOVER_JOB);
    expect(job, 'the rollover is not registered').toBeTruthy();
    expect(job!.intervalSeconds).toBe(300);
    const runner = createJobRunner({ db: ctx.db, env, log: ctx.app.log, channels: [], jobs: [job!] });
    await runner.start();
    await runner.stop();
    const [expectation] = await ctx.db.select().from(opsExpectation).where(eq(opsExpectation.name, BENEFIT_ROLLOVER_JOB));
    expect(expectation).toMatchObject({ kind: 'job', intervalSeconds: 300, enabled: true });
    const [run] = await ctx.db
      .select()
      .from(opsRun)
      .where(eq(opsRun.name, BENEFIT_ROLLOVER_JOB))
      .orderBy(desc(opsRun.startedAt))
      .limit(1);
    expect(run).toMatchObject({ kind: 'job', outcome: 'ok' });
    expect(Object.keys(run!.detail as Record<string, number>).sort()).toEqual(
      ['branches', 'days', 'daysClosed', 'monthsClosed', 'rowsRemoved', 'rowsWritten'].sort(),
    );
    // Today has not ended: nothing of today is closed.
    expect((await factRows()).every((r) => r.provisional)).toBe(true);
  });

  it('a missed rollover raises the expectation alert on Health, and a run closes it', async () => {
    const [expectation] = await ctx.db.select().from(opsExpectation).where(eq(opsExpectation.name, BENEFIT_ROLLOVER_JOB));
    const late = new Date(Date.now() - (expectation!.intervalSeconds + expectation!.graceSeconds + 600) * 1000);
    await ctx.db.update(opsLast).set({ lastOkAt: late, lastStartedAt: late }).where(eq(opsLast.name, BENEFIT_ROLLOVER_JOB));
    await runWatchdog({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const key = `ops.missing:${BENEFIT_ROLLOVER_JOB}`;
    const [open] = await ctx.db.select().from(alert).where(eq(alert.key, key));
    expect(open).toMatchObject({ category: 'ops.missing', status: 'open' });
    await ctx.db.update(opsLast).set({ lastOkAt: new Date() }).where(eq(opsLast.name, BENEFIT_ROLLOVER_JOB));
    await runWatchdog({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    const [closed] = await ctx.db.select().from(alert).where(eq(alert.key, key));
    expect(closed!.status).toBe('resolved');
  });

  it('once the branch’s day has turned over, the day’s rows are rewritten final — and on the last of a month, the month', async () => {
    const before = await factRows();
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    expect(businessDate(tomorrow, timezone, dayStartMinutes)).toBe(addDaysToIsoDate(today, 1));
    const detail = await runBenefitRolloverJob(ctx.db, tomorrow);
    expect(detail.daysClosed).toBe(1);
    expect(detail.monthsClosed).toBe(endsAMonth(today) ? 1 : 0);
    expect(detail.rowsWritten).toBe(before.length);
    const after = await factRows();
    expect(after.every((r) => !r.provisional)).toBe(true);
    // The figures did not move: closing is the flag, never a recompute that differs.
    const strip = (r: typeof after[number]) => ({ ...r, provisional: null, updatedAt: null, computedAt: null });
    expect(after.map(strip)).toEqual(before.map(strip));
    // The report says the day is closed.
    expect((await report()).body.days[0]!.provisional).toBe(false);
  });

  it('a rerun closes nothing again and writes nothing; two rollovers at once write one row per key', async () => {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const again = await runBenefitRolloverJob(ctx.db, tomorrow);
    expect([again.rowsWritten, again.rowsRemoved, again.daysClosed]).toEqual([0, 0, 0]);
    const clock = { id: branchId, operatorId };
    const both = await Promise.all([
      closeBenefitBranchDay(ctx.db, clock, today, tomorrow),
      closeBenefitBranchDay(ctx.db, clock, today, tomorrow),
    ]);
    expect(both.map((b) => b.written)).toEqual([0, 0]);
    expect(await factRows()).toHaveLength(3);
  });

  it('the daily rollup’s sweep of an ended day closes the same rows; whichever comes first, the other writes nothing', async () => {
    // Rolled up today, really: the day has not ended, so its rows are provisional.
    await rollup();
    expect((await factRows()).every((r) => r.provisional)).toBe(true);
    // A day on, the rollup's own sweep of ended provisional days closes them…
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    await runDailyRollupJob(ctx.db, tomorrow);
    expect((await factRows()).every((r) => !r.provisional)).toBe(true);
    // …and the rollover then finds nothing left to close.
    const after = await runBenefitRolloverJob(ctx.db, tomorrow);
    expect([after.daysClosed, after.rowsWritten]).toEqual([0, 0]);
  });

  it('a row the day no longer has is removed by the next write', async () => {
    // Taken off below the routes (a demo reset's shape): its sale's day loses the row.
    await ctx.db
      .update(benefitApplication)
      .set({ removedAt: new Date(), removedReason: 'removed', removedByAccountId: receptionId })
      .where(eq(benefitApplication.saleId, sales.anan.saleId));
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const closed = await closeBenefitBranchDay(ctx.db, { id: branchId, operatorId }, today, tomorrow);
    expect(closed.removed).toBe(1);
    expect((await factRows()).map((r) => r.employeeId).sort()).toEqual([people.lek, people.som].sort());
  });

  it('the last trading day of a month is the end of a monthly period', () => {
    expect(endsAMonth('2026-10-31')).toBe(true);
    expect(endsAMonth('2026-10-30')).toBe(false);
    expect(endsAMonth('2026-12-31')).toBe(true);
    expect(endsAMonth('2028-02-28')).toBe(false);
    expect(endsAMonth('2028-02-29')).toBe(true);
  });
});

// --- The periods roll by key (plan §3 "Periods", Q6, H13) ------------------------------------------

describe('the periods roll by key at the branch’s business day, with or without the rollover (H13)', () => {
  it('the keys follow the branch’s trading day, never the calendar midnight (Q6’s default: the sale’s business date)', () => {
    // Asia/Bangkok, the day starting 05:00: 31 Oct 23:59, 1 Nov 00:01 and
    // 04:59 are all 31 October's trading day; 05:01 is the first of November's.
    const at = (iso: string) => businessDate(new Date(iso), 'Asia/Bangkok', 5 * 60);
    const cases: Array<[string, string, string]> = [
      ['2026-10-31T16:59:00Z', '2026-10-31', '2026-10'],
      ['2026-10-31T17:01:00Z', '2026-10-31', '2026-10'],
      ['2026-10-31T21:59:00Z', '2026-10-31', '2026-10'],
      ['2026-10-31T22:01:00Z', '2026-11-01', '2026-11'],
    ];
    for (const [instant, day, month] of cases) {
      const d = at(instant);
      expect(d, instant).toBe(day);
      expect(benefitPeriodKey('daily', d), instant).toBe(day);
      expect(benefitPeriodKey('monthly', d), instant).toBe(month);
    }
  });

  async function seedUsage(employeeId: string, itemKey: string, kind: 'daily' | 'monthly', key: string, qty: number, credit: number) {
    await ctx.db.insert(benefitUsage).values({
      id: newId(),
      operatorId,
      employeeId,
      itemKey,
      periodKind: kind,
      periodKey: key,
      qtyUsed: qty,
      creditUsedSatang: credit,
    });
  }

  it('yesterday’s coffees and last month’s credit, used to the full, leave today’s whole — no job needed', async () => {
    const yesterday = addDaysToIsoDate(today, -1);
    const lastMonth = benefitPeriodKey('monthly', addDaysToIsoDate(`${today.slice(0, 7)}-01`, -1));
    await seedUsage(people.mali, 'free:coffee', 'daily', benefitPeriodKey('daily', yesterday), 2, 0);
    await seedUsage(people.mali, 'credit', 'monthly', lastMonth, 0, 50_000);
    // 3 espressos and 5 hot dogs, as Khun Lek's: the whole of today's benefit.
    const q = await quote(cart([line(item.espresso, 3), line(item.hotdog, 5)], codes.mali));
    expect(q.status, q.raw).toBe(200);
    expect(q.body.benefit).toMatchObject({ freeItemsSatang: 12_000, creditSatang: 50_000, discountSatang: 3_300 });
  });

  it('today’s keys, used to the full, leave nothing of either until the next day and the next month', async () => {
    await seedUsage(people.mali, 'free:coffee', 'daily', benefitPeriodKey('daily', today), 2, 0);
    await seedUsage(people.mali, 'credit', 'monthly', benefitPeriodKey('monthly', today), 0, 50_000);
    const q = await quote(cart([line(item.espresso, 3), line(item.hotdog, 5)], codes.mali));
    expect(q.status, q.raw).toBe(200);
    // 30 % of ฿730.
    expect(q.body.benefit).toMatchObject({ freeItemsSatang: 0, creditSatang: 0, discountSatang: 21_900 });
    // The rollover closes figures; it never touches a counter.
    const counters = await ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, people.mali));
    await runBenefitRolloverJob(ctx.db, new Date(Date.now() + 24 * 3600 * 1000));
    expect(await ctx.db.select().from(benefitUsage).where(eq(benefitUsage.employeeId, people.mali))).toEqual(counters);
  });

  it('the period keys a sale claims are its own trading day’s', async () => {
    const rows = await ctx.db.execute<{ period_key: string; business_date: string }>(sql`
      select distinct d->>'periodKey' as period_key, a.business_date::text as business_date, d->>'periodKind' as kind
        from promo.benefit_application a, jsonb_array_elements(a.usage_deltas) d
       where a.sale_id = ${sales.lek.saleId}::uuid`);
    const keysOf = rows.rows.map((r) => r.period_key).sort();
    expect(keysOf).toEqual([benefitPeriodKey('monthly', today), benefitPeriodKey('daily', today)].sort());
  });
});
