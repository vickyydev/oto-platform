import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account, boothPrize, branch, dailyCategorySummary, dailyDiscountSummary, dailyItemSummary,
  dailyTenderSummary, dailyTicketSummary, dimDate, employee, factBoothDaily, paymentAttempt,
  sale, saleDiscount, saleLine, station, voucher, voucherDefinition, voucherRedemption,
} from '@oto/db';
import { newId, type DiscountReport, type DiscountTransactions, type ProfitabilityReport, type SalesReport, type TaxReceipts, type VatReport } from '@oto/shared';
import { ADMIN, BRANCH_MANAGER, RECEPTION, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

let ctx: TestContext;
let admin: string, manager: string, counter: string;
let operatorId: string, park: string, sibling: string, foreignPark: string, foreignOperator: string;
let ownAccount: string, foreignAccount: string, ownBooth: string, foreignBooth: string, ownPrize: string, foreignPrize: string;
let ownSale: string, foreignSale: string;
const day = '1999-10-21';
const at = new Date(day + 'T08:00:00.000Z');
const ownItem = newId(), foreignItem = newId();
const foreignLabel = 'ZZ TEST Foreign report item';
const ownReceipt = 'ZZ TEST 625 OWN RECEIPT', foreignReceipt = 'ZZ TEST 625 FOREIGN RECEIPT';
const analyticsPaths = ['/reports/sales', '/reports/profitability', '/reports/discounts', '/reports/discounts/transactions', '/reports/tax/vat', '/reports/tax/receipts', '/booths', '/booths/export'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read(path: string, cookie = manager, parks = park) {
  return ctx.app.inject({ method: 'GET', url: '/analytics' + path + '?branches=' + parks + '&from=' + day + '&to=' + day, headers: { cookie } });
}
async function snapshot() {
  return hash(await Promise.all([
    ctx.db.select().from(dailyCategorySummary).where(eq(dailyCategorySummary.businessDate, day)),
    ctx.db.select().from(dailyItemSummary).where(eq(dailyItemSummary.businessDate, day)),
    ctx.db.select().from(dailyTenderSummary).where(eq(dailyTenderSummary.businessDate, day)),
    ctx.db.select().from(dailyDiscountSummary).where(eq(dailyDiscountSummary.businessDate, day)),
    ctx.db.select().from(factBoothDaily).where(eq(factBoothDaily.businessDate, day)),
    ctx.db.select().from(sale).where(inArray(sale.id, [ownSale, foreignSale])),
    ctx.db.select().from(saleDiscount).where(inArray(saleDiscount.saleId, [ownSale, foreignSale])),
  ]));
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  counter = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const outside = await signInAs(ctx.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password);
  const own = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: manager } })).json();
  const foreign = (await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: outside } })).json();
  operatorId = own.account.operatorId; park = own.branch.id; ownAccount = own.account.id;
  foreignOperator = foreign.account.operatorId; foreignPark = foreign.branch.id; foreignAccount = foreign.account.id;
  sibling = newId();
  await ctx.db.insert(branch).values({ id: sibling, operatorId, code: 'zz-report-' + sibling, name: 'ZZ TEST Unread report park' });
  ownBooth = newId(); foreignBooth = newId(); ownPrize = newId(); foreignPrize = newId();
  await ctx.db.insert(station).values([
    { id: ownBooth, operatorId, branchId: park, name: 'ZZ TEST Own report booth', kind: 'booth' },
    { id: foreignBooth, operatorId: foreignOperator, branchId: foreignPark, name: 'ZZ TEST Foreign report booth', kind: 'booth' },
  ]);
  await ctx.db.insert(boothPrize).values([
    { id: ownPrize, operatorId, branchId: park, stationId: ownBooth, nameEn: 'ZZ TEST Own report prize' },
    { id: foreignPrize, operatorId: foreignOperator, branchId: foreignPark, stationId: foreignBooth, nameEn: 'ZZ TEST Foreign report prize' },
  ]);
  // Independent operator and park FKs permit these inconsistent restored rows.
  // Each corrupt row differs from the valid controls by ownership, not amount rules.
  await ctx.db.insert(dailyCategorySummary).values([
    { id: newId(), operatorId, branchId: park, businessDate: day, key: 'fnb', grossSatang: 12000, netSatang: 10000, taxSatang: 2000, taxExclusiveSatang: 2000, txnCount: 1, computedAt: at },
    { id: newId(), operatorId: foreignOperator, branchId: park, businessDate: day, key: 'merch', grossSatang: 99000, netSatang: 99000, txnCount: 1, computedAt: at },
  ]);
  await ctx.db.insert(dailyItemSummary).values([
    { id: newId(), operatorId, branchId: park, businessDate: day, key: ownItem, kind: 'fnb', label: 'ZZ TEST Own report item', quantity: 2, revenueSatang: 12000, costSatang: 3000, computedAt: at },
    { id: newId(), operatorId: foreignOperator, branchId: park, businessDate: day, key: foreignItem, kind: 'merch', label: foreignLabel, quantity: 1, revenueSatang: 99000, costSatang: 1, computedAt: at },
  ]);
  await ctx.db.insert(dailyTenderSummary).values([
    { id: newId(), operatorId, branchId: park, businessDate: day, key: 'cash', method: 'cash', amountSatang: 12000, txnCount: 1, computedAt: at },
    { id: newId(), operatorId: foreignOperator, branchId: park, businessDate: day, key: 'ZZ TEST Foreign tender', method: 'other', amountSatang: 99000, txnCount: 1, computedAt: at },
  ]);
  await ctx.db.insert(dailyDiscountSummary).values([
    { id: newId(), operatorId, branchId: park, businessDate: day, key: 'own', kind: 'manual', discountType: 'fixed', amountSatang: 1200, useCount: 1, appliedByAccountId: ownAccount, appliedByName: 'ZZ TEST Own report operator', computedAt: at },
    { id: newId(), operatorId: foreignOperator, branchId: park, businessDate: day, key: 'foreign', kind: 'manual', discountType: 'fixed', amountSatang: 7000, useCount: 1, appliedByAccountId: foreignAccount, appliedByName: 'ZZ TEST Foreign report operator', computedAt: at },
  ]);
  ownSale = newId(); foreignSale = newId();
  const base = { branchId: park, stationId: ownBooth, businessDate: day, businessDayStart: '06:00:00', timezone: 'Asia/Bangkok', occurredAt: at, pricingMode: 'weekday', pricingModeReason: 'weekday', customerTier: 'standard', engineVersion: '1', taxConfig: {}, taxBreakdown: { netSubtotal: 10000, serviceChargeTotal: 0, taxTotal: 2000, grandTotal: 12000, categories: [] }, netSatang: 10000, taxExclusiveSatang: 2000, grossSatang: 12000, status: 'finalised' as const, finalisedAt: at, receiptSeries: 'ZZ625', receiptSeq: 1 };
  await ctx.db.insert(sale).values([
    { ...base, id: ownSale, operatorId, createdByAccountId: ownAccount, receiptNumber: ownReceipt },
    { ...base, id: foreignSale, operatorId: foreignOperator, createdByAccountId: foreignAccount, stationId: foreignBooth, receiptSeries: 'ZZ625F', receiptNumber: foreignReceipt },
  ]);
  await ctx.db.insert(saleDiscount).values([
    { id: newId(), saleId: ownSale, operatorId, branchId: park, businessDate: day, sequence: 1, kind: 'manual', discountType: 'fixed', valueSatang: 1200, amountSatang: 1200, reason: 'ZZ TEST Own report reason', appliedByAccountId: ownAccount, appliedByName: 'ZZ TEST Own report operator' },
    { id: newId(), saleId: foreignSale, operatorId: foreignOperator, branchId: park, businessDate: day, sequence: 1, kind: 'manual', discountType: 'fixed', valueSatang: 7000, amountSatang: 7000, reason: 'ZZ TEST Foreign report reason', appliedByAccountId: foreignAccount, appliedByName: 'ZZ TEST Foreign report operator' },
  ]);
  await ctx.db.insert(factBoothDaily).values([
    { id: newId(), operatorId, branchId: park, businessDate: day, boothId: ownBooth, prizeId: ownPrize, staffAccountId: ownAccount, spins: 2, vouchersIssued: 2, computedAt: at },
    { id: newId(), operatorId: foreignOperator, branchId: park, businessDate: day, boothId: ownBooth, spins: 9, computedAt: at },
    { id: newId(), operatorId, branchId: park, businessDate: day, boothId: foreignBooth, prizeId: foreignPrize, staffAccountId: foreignAccount, spins: 13, computedAt: at },
  ]);
}, 180_000);

afterAll(async () => { await ctx?.close(); await teardownAll(); });

describe('SCRUM-625 independent Reports review', () => {
  it('R1 [high] legitimate owned figures retain satang, costs and receipt totals; fix: fence ownership without changing report formulas', async () => {
    const sales = await read('/reports/sales'); expect(sales.statusCode).toBe(200);
    expect(sales.json<SalesReport>().categories.find(row => row.category === 'fnb')).toMatchObject({ grossRevenueSatang: 12000, taxCollectedSatang: 2000, count: 1 });
    const profit = await read('/reports/profitability'); expect(profit.statusCode).toBe(200);
    expect(profit.json<ProfitabilityReport>().fnb.find(row => row.itemId === ownItem)).toMatchObject({ qty: 2, revenueSatang: 12000, cogsSatang: 3000, marginSatang: 9000, marginPercent: 75, costTracked: true });
    const receipts = await read('/reports/tax/receipts'); expect(receipts.statusCode).toBe(200);
    expect(receipts.json<TaxReceipts>().rows.find(row => row.transactionId === ownReceipt)).toMatchObject({ netSubtotalSatang: 10000, taxTotalSatang: 2000, grandTotalSatang: 12000 });
  });

  it('R2 [critical] foreign-operator facts attached to a readable park add no money, names or rows; fix: fence each report fact by both owning operator and park', async () => {
    const sales = await read('/reports/sales'), profit = await read('/reports/profitability'), discounts = await read('/reports/discounts'), vat = await read('/reports/tax/vat');
    for (const response of [sales, profit, discounts, vat]) expect(response.statusCode).toBe(200);
    expect.soft(sales.json<SalesReport>().categories.some(row => row.category === 'merch')).toBe(false);
    expect.soft(sales.json<SalesReport>().payments.some(row => row.method === 'ZZ TEST Foreign tender')).toBe(false);
    expect.soft(profit.json<ProfitabilityReport>().merch.some(row => row.itemId === foreignItem)).toBe(false);
    expect.soft(discounts.json<DiscountReport>().manualDiscountSatang).toBe(1200);
    expect.soft(discounts.body.includes('ZZ TEST Foreign report operator')).toBe(false);
    expect.soft(vat.json<VatReport>().rows.some(row => row.category === 'merch')).toBe(false);
  });

  it('R3 [critical] a foreign sale carrying an owned park cannot enter transaction or receipt exports; fix: tenant-fence the counted sale before its joins', async () => {
    const discounts = await read('/reports/discounts/transactions'), receipts = await read('/reports/tax/receipts');
    expect(discounts.statusCode).toBe(200); expect(receipts.statusCode).toBe(200);
    expect(discounts.json<DiscountTransactions>().rows.some(row => row.transactionId === ownReceipt)).toBe(true);
    expect.soft(discounts.json<DiscountTransactions>().rows.some(row => row.transactionId === foreignReceipt)).toBe(false);
    expect.soft(receipts.json<TaxReceipts>().rows.some(row => row.transactionId === foreignReceipt)).toBe(false);
    expect.soft(discounts.body.includes('ZZ TEST Foreign report operator')).toBe(false);
  });

  it('R4 [critical] Booth JSON and CSV exclude foreign facts and referenced booth/prize/person identities; fix: fence facts and every tenant-owned join', async () => {
    const report = await read('/booths'), csv = await read('/booths/export');
    expect(report.statusCode).toBe(200); expect(csv.statusCode).toBe(200);
    const booths = report.json<{ booths: Array<{ boothId: string; spins: number }> }>().booths;
    expect.soft(booths.find(row => row.boothId === ownBooth)?.spins).toBe(2);
    for (const value of [foreignBooth, foreignPrize, foreignAccount, 'ZZ TEST Foreign report booth', 'ZZ TEST Foreign report prize']) {
      expect.soft(report.body.includes(value)).toBe(false); expect.soft(csv.body.includes(value)).toBe(false);
    }
  });

  it('R5 [high] explicit parks retain omitted/404/403 semantics and UUID canonicalization; fix: preserve the existing per-park report resolver', async () => {
    for (const path of analyticsPaths) {
      const response = await read(path, manager, park.toUpperCase() + ',' + sibling);
      expect(response.statusCode).toBe(200);
      if (path !== '/booths/export') expect(response.json<{ omitted: string[]; branches: Array<{ branchId: string }> }>()).toMatchObject({ omitted: [sibling], branches: [{ branchId: park }] });
      expect((await read(path, manager, sibling)).statusCode).toBe(403);
      expect((await read(path, manager, foreignPark)).statusCode).toBe(404);
      expect((await read(path, manager, newId())).statusCode).toBe(404);
      expect((await read(path, counter)).statusCode).toBe(403);
    }
  });

  it('R6 [high] read/export is read-only and keeps date validation plus CSV privacy headers; fix: preserve business rows and bounded query refusal', async () => {
    const before = await snapshot();
    for (const path of analyticsPaths) {
      expect((await read(path, admin)).statusCode).toBe(200);
      const backwards = await ctx.app.inject({ method: 'GET', url: '/analytics' + path + '?branches=' + park + '&from=2000-01-02&to=2000-01-01', headers: { cookie: admin } });
      expect(backwards.statusCode).toBe(400);
    }
    const csv = await read('/booths/export');
    expect(csv.headers['content-type']).toContain('text/csv'); expect(csv.headers['cache-control']).toBe('no-store');
    expect(csv.headers['content-disposition']).toContain('booth-report_' + day + '_' + day + '.csv');
    expect(await snapshot()).toBe(before);
    expect((await ctx.app.inject({ method: 'GET', url: '/analytics/reports/sales?from=' + day + '&to=' + day })).statusCode).toBe(401);
  });

  it('R7 [critical] owned records never expose foreign optional labels or foreign discount children; fix: fence joined identities and project only owned optional IDs', async () => {
    const foreignEmployee = newId(), privateName = 'ZZ TEST Foreign optional report identity';
    await ctx.db.insert(employee).values({ id: foreignEmployee, operatorId: foreignOperator, name: privateName });
    // Both account and employee are real rows, but the optional relationship is corrupt.
    await ctx.db.update(account).set({ employeeId: foreignEmployee }).where(inArray(account.id, [ownAccount, foreignAccount]));
    await ctx.db.insert(factBoothDaily).values({ id: newId(), operatorId, branchId: park, businessDate: day, boothId: ownBooth, prizeId: foreignPrize, staffAccountId: foreignAccount, spins: 5, computedAt: at });
    await ctx.db.insert(saleDiscount).values({ id: newId(), saleId: ownSale, operatorId: foreignOperator, branchId: foreignPark, businessDate: day, sequence: 2, kind: 'manual', discountType: 'fixed', valueSatang: 321, amountSatang: 321, reason: 'ZZ TEST Foreign child discount', appliedByAccountId: foreignAccount, appliedByName: privateName });
    const report = await read('/booths'), csv = await read('/booths/export'), transactions = await read('/reports/discounts/transactions'), receipts = await read('/reports/tax/receipts');
    for (const response of [report, csv, transactions, receipts]) {
      expect(response.statusCode).toBe(200);
      expect.soft(response.body.includes(privateName)).toBe(false);
    }
    for (const value of [foreignPrize, foreignAccount, 'ZZ TEST Foreign report prize']) {
      expect.soft(report.body.includes(value)).toBe(false); expect.soft(csv.body.includes(value)).toBe(false);
    }
    expect.soft(transactions.body.includes('ZZ TEST Foreign child discount')).toBe(false);
    expect(receipts.json<TaxReceipts>().rows.some(row => row.transactionId === ownReceipt)).toBe(true);
    expect(report.json<{ booths: Array<{ boothId: string; spins: number }> }>().booths.find(row => row.boothId === ownBooth)?.spins).toBe(7);
  });

  it('R8 [critical] foreign and sibling sale children cannot change an owned receipt method or source; fix: match payment and line operator/park to their counted parent sale', async () => {
    const scenarios = [
      { operatorId: foreignOperator, branchId: foreignPark, methodCode: 'ZZ TEST Foreign child tender', valid: false },
      { operatorId, branchId: sibling, methodCode: 'ZZ TEST Sibling child tender', valid: false },
      { operatorId, branchId: park, methodCode: 'cash', valid: true },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      const attemptId = newId(), lineId = newId();
      try {
        await ctx.db.insert(paymentAttempt).values({ id: attemptId, operatorId: scenario.operatorId, branchId: scenario.branchId, saleId: ownSale, businessDate: day, method: 'cash', methodCode: scenario.methodCode, provider: 'manual', status: 'approved', amountSatang: 12000 });
        await ctx.db.insert(saleLine).values({ id: lineId, saleId: ownSale, operatorId: scenario.operatorId, branchId: scenario.branchId, businessDate: day, lineNo: 100 + index, cartLineId: newId(), kind: 'fnb_item', label: 'ZZ TEST Child report item', taxableCategory: 'fnb', customerTier: 'standard' });
        const receipts = await read('/reports/tax/receipts'), transactions = await read('/reports/discounts/transactions');
        expect(receipts.statusCode).toBe(200); expect(transactions.statusCode).toBe(200);
        const receipt = receipts.json<TaxReceipts>().rows.find(row => row.transactionId === ownReceipt);
        expect.soft(receipt?.paymentMethod).toBe(scenario.valid ? 'cash' : 'unknown');
        expect.soft(receipt?.kind).toBe(scenario.valid ? 'fnb' : 'ticket');
        expect.soft(receipt?.grandTotalSatang).toBe(12000);
        expect.soft(transactions.json<DiscountTransactions>().rows.find(row => row.transactionId === ownReceipt)?.source).toBe(scenario.valid ? 'fnb' : 'sale');
      } finally {
        await ctx.db.delete(saleLine).where(eq(saleLine.id, lineId));
        await ctx.db.delete(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
      }
    }
  });

  it('R9 [high] only owned dimensions and occurrence-owned voucher joins classify an owned report; fix: fence dimension/redemption/voucher owners while preserving legitimate cross-park issue', async () => {
    const dimensionId = newId(), ticketId = newId();
    try {
      await ctx.db.insert(dailyTicketSummary).values({ id: ticketId, operatorId, branchId: park, businessDate: day, kind: 'tier', key: 'ZZ TEST R9 tier', label: 'ZZ TEST R9 tier', saleCount: 1, revenueSatang: 1234, computedAt: at });
      await ctx.db.insert(dimDate).values({ id: dimensionId, operatorId: foreignOperator, branchId: park, date: day, weekday: 4, rateMode: 'weekend' });
      const corrupt = await read('/reports/sales'); expect(corrupt.statusCode).toBe(200);
      expect.soft(corrupt.json<SalesReport>().weekdayWeekend).toEqual([{ mode: 'weekday', saleCount: 1, revenueSatang: 1234 }]);
      await ctx.db.update(dimDate).set({ operatorId }).where(eq(dimDate.id, dimensionId));
      const legitimate = await read('/reports/sales'); expect(legitimate.statusCode).toBe(200);
      expect(legitimate.json<SalesReport>().weekdayWeekend).toEqual([{ mode: 'weekend', saleCount: 1, revenueSatang: 1234 }]);
    } finally {
      await ctx.db.delete(dimDate).where(eq(dimDate.id, dimensionId));
      await ctx.db.delete(dailyTicketSummary).where(eq(dailyTicketSummary.id, ticketId));
    }

    const ownDefinition = newId(), foreignDefinition = newId();
    await ctx.db.insert(voucherDefinition).values([
      { id: ownDefinition, operatorId, code: 'zz-test-625-' + ownDefinition, nameEn: 'ZZ TEST Own report definition', kind: 'discount', valueType: 'amount', valueSatang: 100 },
      { id: foreignDefinition, operatorId: foreignOperator, code: 'zz-test-625-' + foreignDefinition, nameEn: 'ZZ TEST Foreign report definition', kind: 'discount', valueType: 'amount', valueSatang: 100 },
    ]);
    const scenarios = [
      { voucherOperator: foreignOperator, issuedPark: foreignPark, redemptionOperator: foreignOperator, occurrencePark: foreignPark, valid: false },
      { voucherOperator: foreignOperator, issuedPark: foreignPark, redemptionOperator: operatorId, occurrencePark: park, valid: false },
      { voucherOperator: operatorId, issuedPark: sibling, redemptionOperator: operatorId, occurrencePark: sibling, valid: false },
      { voucherOperator: operatorId, issuedPark: foreignPark, redemptionOperator: operatorId, occurrencePark: park, valid: false },
      // The voucher was issued at a sibling park but redeemed at this sale's park: approved.
      { voucherOperator: operatorId, issuedPark: sibling, redemptionOperator: operatorId, occurrencePark: park, valid: true },
    ];
    const voucherIds: string[] = [], redemptionIds: string[] = [], completed: number[] = [];
    // Redemption history is append-only (0021); these exact fixtures are removed
    // only by this TestContext's disposable database teardown, as in analytics-r2.
    for (const [index, scenario] of scenarios.entries()) {
        const voucherId = newId(), redemptionId = newId(), discountId = newId();
        const code = 'ZZ' + newId().replaceAll('-', '').slice(-8).toUpperCase();
        const label = 'ZZ TEST R9 classification ' + index;
        let discountInserted = false;
        try {
          await ctx.db.insert(voucher).values({ id: voucherId, operatorId: scenario.voucherOperator, branchId: scenario.issuedPark, voucherDefinitionId: scenario.voucherOperator === operatorId ? ownDefinition : foreignDefinition, code });
          voucherIds.push(voucherId);
          await ctx.db.insert(voucherRedemption).values({ id: redemptionId, operatorId: scenario.redemptionOperator, voucherId, kind: 'consumed', saleId: ownSale, branchId: scenario.occurrencePark, stationId: ownBooth });
          redemptionIds.push(redemptionId);
          await ctx.db.insert(saleDiscount).values({ id: discountId, saleId: ownSale, operatorId, branchId: park, businessDate: day, sequence: 100 + index, kind: 'promo', discountType: 'fixed', code, label, valueSatang: 100, amountSatang: 100 });
          discountInserted = true;
          const response = await read('/reports/discounts/transactions'); expect(response.statusCode).toBe(200);
          const row = response.json<DiscountTransactions>().promoRows.find(item => item.label === label);
          expect(row).toBeDefined();
          // Compare booleans so a fixture voucher code is never printed by assertion diagnostics.
          expect.soft(row?.code === code, 'voucher ownership case ' + index).toBe(!scenario.valid);
          if (scenario.valid) expect(row?.code.endsWith(code.slice(-4))).toBe(true);
          completed.push(index);
        } finally {
          if (discountInserted) {
            const deleted = await ctx.db.delete(saleDiscount).where(eq(saleDiscount.id, discountId)).returning({ id: saleDiscount.id });
            expect(deleted).toHaveLength(1);
          }
        }
    }
    expect(completed).toEqual([0, 1, 2, 3, 4]);
    expect(await ctx.db.select({ id: voucherRedemption.id }).from(voucherRedemption).where(inArray(voucherRedemption.id, redemptionIds))).toHaveLength(5);
    expect(await ctx.db.select({ id: voucher.id }).from(voucher).where(inArray(voucher.id, voucherIds))).toHaveLength(5);
    expect(await ctx.db.select({ id: voucherDefinition.id }).from(voucherDefinition).where(inArray(voucherDefinition.id, [ownDefinition, foreignDefinition]))).toHaveLength(2);
  });
});
