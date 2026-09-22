import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { account, branch, receiptSeries, sale, saleDiscount, saleLine, station } from '@oto/db';
import { businessDate, newId, parseDayStart, PRICING_ENGINE_VERSION } from '@oto/shared';
import { createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * S2-09a (SCRUM-203) — what the SALES LEDGER'S SHAPE promises, proved against
 * a real Postgres rather than asserted in a comment.
 *
 * `pnpm --filter @oto/db verify-schema` already proves the committed
 * migrations and the Drizzle schema describe the same tables, columns, keys
 * and indexes. What it cannot see is the two things this file is for: it
 * compares check constraints BY NAME ONLY, so a check that allows everything
 * would pass it, and it does not look at triggers at all — so the freeze that
 * makes a finalised sale immutable is invisible to the gate that is supposed
 * to catch schema drift.
 *
 * Nothing here goes through a route: the service and the routes are the rest
 * of SCRUM-203. These are the guarantees the database itself has to hold
 * whatever is built on top of it.
 */

/**
 * Assert a write was refused BY A NAMED CONSTRAINT OR TRIGGER. Drizzle wraps a
 * driver error in "Failed query: …" and hangs the Postgres error off `cause`,
 * so matching the top-level message would pass for any failure at all —
 * including a typo in the test.
 */
async function refusedBy(write: Promise<unknown>, expected: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await write;
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) throw new Error(`expected the write to be refused by ${expected}`);
  const chain: string[] = [];
  let err: unknown = thrown;
  while (err instanceof Error) {
    chain.push(err.message);
    err = err.cause;
  }
  const joined = chain.join(' | ');
  if (!expected.test(joined)) {
    throw new Error(`expected a refusal matching ${expected}, got: ${joined}`);
  }
}

let ctx: TestContext;
let operatorId: string;
let branchId: string;
let branchRow: { id: string; timezone: string; businessDayStart: string };
let stationId: string;
let accountId: string;

/** A complete, self-consistent sale: ฿520 of tickets, VAT 7 % already inside. */
function aSale(overrides: Partial<typeof sale.$inferInsert> = {}): typeof sale.$inferInsert {
  const gross = 52000;
  const tax = Math.round((gross * 7) / 107);
  return {
    id: newId(),
    operatorId,
    branchId,
    stationId,
    businessDate: '2026-09-19',
    businessDayStart: branchRow.businessDayStart,
    timezone: branchRow.timezone,
    occurredAt: new Date('2026-09-19T12:00:00+07:00'),
    createdByAccountId: accountId,
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    customerTier: 'tourist',
    engineVersion: PRICING_ENGINE_VERSION,
    taxConfig: { rates: [], categoryRules: [], discountPlacement: 'before_tax' },
    taxBreakdown: { categories: [], grandTotal: gross },
    subtotalSatang: gross,
    netSatang: gross - tax,
    taxInclusiveSatang: tax,
    grossSatang: gross,
    status: 'tendering',
    ...overrides,
  };
}

/** The same sale, finalised, with a receipt number out of a station series. */
function aFinalisedSale(seq: number): typeof sale.$inferInsert {
  return aSale({
    status: 'finalised',
    finalisedAt: new Date('2026-09-19T12:00:05+07:00'),
    receiptSeries: 'HKT1',
    receiptSeq: seq,
    receiptNumber: `HKT1-${String(seq).padStart(6, '0')}`,
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((b) => b.code === 'hkt-central') ?? branches[0]!;
  branchRow = { id: hkt.id, timezone: hkt.timezone, businessDayStart: hkt.businessDayStart };
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  const stations = await ctx.db.select().from(station).where(eq(station.branchId, branchId));
  stationId = (stations.find((s) => s.kind === 'till') ?? stations[0]!).id;
  const accounts = await ctx.db.select().from(account);
  accountId = accounts[0]!.id;
}, 120_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the sale record (S2-09a)', () => {
  it('keeps everything a receipt has to be rebuilt from years later', async () => {
    const row = aFinalisedSale(1);
    await ctx.db.insert(sale).values(row);
    const [stored] = await ctx.db.select().from(sale).where(eq(sale.id, row.id!));

    // Where and when — the trading day, not the calendar day.
    expect(stored!.businessDate).toBe('2026-09-19');
    expect(stored!.stationId).toBe(stationId);
    expect(stored!.timezone).toBe(branchRow.timezone);
    // What was charged and why.
    expect(stored!.pricingMode).toBe('weekday');
    expect(stored!.customerTier).toBe('tourist');
    expect(stored!.engineVersion).toBe(PRICING_ENGINE_VERSION);
    // The money, in parts rather than one number.
    expect(stored!.netSatang + stored!.taxInclusiveSatang).toBe(stored!.grossSatang);
    expect(stored!.receiptNumber).toBe('HKT1-000001');
  });

  it('stamps the business date the branch day start gives, not the calendar date', async () => {
    // 00:30 the morning after, while the previous day is still being closed.
    const lateNight = new Date('2026-09-20T00:30:00+07:00');
    const resolved = businessDate(
      lateNight,
      branchRow.timezone,
      parseDayStart(branchRow.businessDayStart),
    );
    expect(resolved).toBe('2026-09-19');

    const row = aSale({ occurredAt: lateNight, businessDate: resolved });
    await ctx.db.insert(sale).values(row);
    const [stored] = await ctx.db.select().from(sale).where(eq(sale.id, row.id!));
    expect(stored!.businessDate).toBe('2026-09-19');
  });

  it('refuses totals that do not add up', async () => {
    // A gross that is not net + service + tax: the arithmetic of a receipt
    // nobody could check.
    await refusedBy(ctx.db.insert(sale).values(aSale({ grossSatang: 99999 })), /sale_totals_check/);
  });

  it('refuses a discount total that is not its own parts', async () => {
    await refusedBy(
      ctx.db
        .insert(sale)
        .values(
          aSale({ discountSatang: 5000, manualDiscountSatang: 1000, promoDiscountSatang: 0 }),
        ),
      /sale_discount_parts_check/,
    );
  });

  it('refuses a finalised sale with no receipt number', async () => {
    await refusedBy(
      ctx.db.insert(sale).values(aSale({ status: 'finalised', finalisedAt: new Date() })),
      /sale_finalised_check/,
    );
  });

  it('refuses a void with no reason — a cancelled sale has to say why', async () => {
    await refusedBy(
      ctx.db.insert(sale).values(aSale({ status: 'voided', voidedAt: new Date() })),
      /sale_void_check/,
    );
  });

  it('refuses a refund larger than the sale', async () => {
    await refusedBy(
      ctx.db.insert(sale).values(aSale({ refundedSatang: 99999 })),
      /sale_refund_bound_check/,
    );
  });
});

describe('pressing Pay twice (S2-09a)', () => {
  it('produces one sale, because the till minted the id', async () => {
    const row = aSale();
    await ctx.db.insert(sale).values(row);
    // The same request arriving again through a dropped connection.
    await refusedBy(ctx.db.insert(sale).values(row), /sale_pkey/);
    const found = await ctx.db.select().from(sale).where(eq(sale.id, row.id!));
    expect(found).toHaveLength(1);
  });

  it('refuses a retry that minted a new id but carried the same action id', async () => {
    const actionId = `act-${newId()}`;
    await ctx.db.insert(sale).values(aSale({ actionId }));
    await refusedBy(ctx.db.insert(sale).values(aSale({ actionId })), /sale_action_unique/);
  });
});

describe('receipt numbering (S2-09a)', () => {
  it('allocates per station from a series, and the series row is the high-water mark', async () => {
    const series = {
      id: newId(),
      operatorId,
      branchId,
      stationId,
      series: 'HKT9',
      kind: 'sale' as const,
      nextSeq: 1,
    };
    await ctx.db.insert(receiptSeries).values(series);
    const [stored] = await ctx.db
      .select()
      .from(receiptSeries)
      .where(eq(receiptSeries.id, series.id));
    expect(stored!.nextSeq).toBe(1);
    expect(stored!.seqPadding).toBe(6);
  });

  it('refuses one station issuing the same number twice, whichever box minted it', async () => {
    await ctx.db.insert(sale).values(aFinalisedSale(428));
    // A second box, restored from a backup, believing it is still at 428.
    await refusedBy(
      ctx.db.insert(sale).values(aFinalisedSale(428)),
      /sale_receipt_unique|sale_receipt_number_unique/,
    );
  });
});

describe('a finalised sale is frozen (S2-09a)', () => {
  it('refuses to change what the guest was charged', async () => {
    const row = aFinalisedSale(900);
    await ctx.db.insert(sale).values(row);
    await refusedBy(
      ctx.db.update(sale).set({ grossSatang: 1 }).where(eq(sale.id, row.id!)),
      /frozen/,
    );
    const [stored] = await ctx.db.select().from(sale).where(eq(sale.id, row.id!));
    expect(stored!.grossSatang).toBe(52000);
  });

  it('refuses to reopen it', async () => {
    const row = aFinalisedSale(901);
    await ctx.db.insert(sale).values(row);
    await refusedBy(
      ctx.db.update(sale).set({ status: 'tendering' }).where(eq(sale.id, row.id!)),
      /cannot go from finalised/,
    );
  });

  it('still allows the void and refund columns, which are a sale’s later life', async () => {
    const row = aFinalisedSale(902);
    await ctx.db.insert(sale).values(row);
    await ctx.db
      .update(sale)
      .set({
        status: 'voided',
        voidedAt: new Date(),
        voidedByAccountId: accountId,
        voidReason: 'Rung up twice',
      })
      .where(eq(sale.id, row.id!));
    const [stored] = await ctx.db.select().from(sale).where(eq(sale.id, row.id!));
    expect(stored!.status).toBe('voided');
    // And once voided it stays voided.
    await refusedBy(
      ctx.db.update(sale).set({ status: 'refunded' }).where(eq(sale.id, row.id!)),
      /cannot change again/,
    );
  });

  it('lets an unfinalised sale still be edited — the cart is not the ledger', async () => {
    const row = aSale();
    await ctx.db.insert(sale).values(row);
    await ctx.db.update(sale).set({ note: 'held for the party table' }).where(eq(sale.id, row.id!));
    const [stored] = await ctx.db.select().from(sale).where(eq(sale.id, row.id!));
    expect(stored!.note).toBe('held for the party table');
  });
});

describe('sale lines and discounts (S2-09a)', () => {
  /** The units the shared engine decomposes a cart line into, as the ledger keeps them. */
  async function insertLines(saleId: string): Promise<void> {
    await ctx.db.insert(saleLine).values([
      {
        id: newId(),
        saleId,
        operatorId,
        branchId,
        businessDate: '2026-09-19',
        lineNo: 1,
        cartLineId: newId(),
        kind: 'kids',
        label: '2 Hours Play — Kids',
        taxableCategory: 'tickets',
        quantity: 2,
        unitSatang: 20000,
        baseSatang: 40000,
        netSatang: 37383,
        taxSatang: 2617,
        taxMode: 'inclusive',
        taxRateBp: 700,
        grossSatang: 40000,
        customerTier: 'tourist',
        kidCount: 2,
        adultCount: 3,
        freeAdultCount: 2,
        stayHours: 2,
        stayDurationLabel: '2 Hours',
      },
      {
        id: newId(),
        saleId,
        operatorId,
        branchId,
        businessDate: '2026-09-19',
        lineNo: 2,
        cartLineId: newId(),
        kind: 'adults_free',
        label: 'Adults (free)',
        taxableCategory: 'tickets',
        quantity: 2,
        unitSatang: 0,
        baseSatang: 0,
        netSatang: 0,
        taxSatang: 0,
        grossSatang: 0,
        customerTier: 'tourist',
        kidCount: 2,
        adultCount: 3,
        freeAdultCount: 2,
      },
    ]);
  }

  it('keeps the ticket mix on the line: kids, adults, the free-adult allowance and the stay', async () => {
    const row = aSale();
    await ctx.db.insert(sale).values(row);
    await insertLines(row.id!);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, row.id!));
    expect(lines).toHaveLength(2);
    const kids = lines.find((l) => l.kind === 'kids')!;
    expect(kids.kidCount).toBe(2);
    expect(kids.adultCount).toBe(3);
    expect(kids.freeAdultCount).toBe(2);
    expect(kids.stayDurationLabel).toBe('2 Hours');
    expect(kids.netSatang + kids.taxSatang + kids.serviceChargeSatang).toBe(kids.grossSatang);
  });

  it('refuses a line whose own parts do not add up', async () => {
    const row = aSale();
    await ctx.db.insert(sale).values(row);
    await refusedBy(
      ctx.db.insert(saleLine).values({
        id: newId(),
        saleId: row.id!,
        operatorId,
        branchId,
        businessDate: '2026-09-19',
        lineNo: 1,
        cartLineId: newId(),
        kind: 'kids',
        label: 'Kids',
        taxableCategory: 'tickets',
        grossSatang: 40000,
        netSatang: 100,
        taxSatang: 0,
        customerTier: 'tourist',
      }),
      /sale_line_totals_check/,
    );
  });

  it('freezes the lines with the sale', async () => {
    const row = aFinalisedSale(910);
    await ctx.db.insert(sale).values(row);
    await ctx.db.insert(saleLine).values({
      id: newId(),
      saleId: row.id!,
      operatorId,
      branchId,
      businessDate: '2026-09-19',
      lineNo: 1,
      cartLineId: newId(),
      kind: 'kids',
      label: 'Kids',
      taxableCategory: 'tickets',
      quantity: 2,
      unitSatang: 20000,
      baseSatang: 40000,
      netSatang: 40000,
      grossSatang: 40000,
      customerTier: 'tourist',
    });
    await refusedBy(
      ctx.db.update(saleLine).set({ label: 'Adults' }).where(eq(saleLine.saleId, row.id!)),
      /frozen with it/,
    );
  });

  it('insists a staff discount names its reason and who gave it', async () => {
    const row = aSale();
    await ctx.db.insert(sale).values(row);
    await refusedBy(
      ctx.db.insert(saleDiscount).values({
        id: newId(),
        saleId: row.id!,
        operatorId,
        branchId,
        businessDate: '2026-09-19',
        sequence: 1,
        kind: 'manual',
        discountType: 'fixed',
        valueSatang: 5000,
        amountSatang: 5000,
      }),
      /sale_discount_manual_check/,
    );

    await ctx.db.insert(saleDiscount).values({
      id: newId(),
      saleId: row.id!,
      operatorId,
      branchId,
      businessDate: '2026-09-19',
      sequence: 1,
      kind: 'manual',
      discountType: 'fixed',
      valueSatang: 5000,
      amountSatang: 5000,
      reason: 'Service recovery',
      appliedByAccountId: accountId,
      appliedByName: 'Reception',
    });

    // The order discounts ran in IS the money, so two cannot share a position.
    await refusedBy(
      ctx.db.insert(saleDiscount).values({
        id: newId(),
        saleId: row.id!,
        operatorId,
        branchId,
        businessDate: '2026-09-19',
        sequence: 1,
        kind: 'promo',
        discountType: 'percent',
        percentBp: 1000,
        code: 'TENOFF',
        amountSatang: 4700,
      }),
      /sale_discount_order_unique/,
    );
  });
});
