import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, branch, refund, sale, saleLine, station, ticketPackage, wallet, walletEntry, walletKey } from '@oto/db';
import { bandShortCode, formatTHB, newId, saleReceiptDocument } from '@oto/shared';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import { debitWallet, expireWalletsForDay, extraCreditActionId } from '../src/services/wallet';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1048 — EXTRA FOOD CREDIT ON ANY CHILD TICKET, AS ITS OWN LINE (the
 * owner's answer of 19 November 2026). Until now extra prepaid food credit
 * existed only for a dropped-off or nanny child, chosen on their form.
 *
 * Pinned here, through the routes the till calls: the line names a child on a
 * ticket line of the same cart; the credit lands on that child's band when
 * the sale is paid, once (a retried commit, a retried close, a commit re-sent
 * without the child as the counter box's copy of a cart is); another child's
 * band is untouched; a refund of the line takes it back off the band and is
 * refused once any of it is spent; and the line is priced, taxed and filed
 * exactly as a dropped-off child's extra-credit row is. The rule that no
 * child is sold a ticket alone is unchanged.
 */

const STORAGE_ENV = {
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'oto',
  MINIO_SECRET_KEY: 'otosecret123',
  MINIO_BUCKET: 'oto-files-test',
};
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
let eatPlayId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
  eatPlayId = pkgs.find((p) => p.name === 'Eat & Play Kids Pass')!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
  }
}

type Line = Record<string, unknown> & { id: string };

/** A ticket line of `kids` and `adults`, and an extra credit line for its child at `kidOrdinal`. */
function cartOf(packageId: string, kids: number, adults: number, extra: { kidOrdinal: number; satang: number } | null) {
  const ticket: Line = { id: newId(), packageId, kids, adults };
  const credit: Line | null = extra
    ? {
        id: newId(),
        packageId,
        kids: 0,
        adults: 0,
        foodProvision: { mode: 'prepaid_credit', paidSatang: extra.satang },
        creditFor: { cartLineId: ticket.id, kidOrdinal: extra.kidOrdinal },
      }
    : null;
  return { ticket, credit, lines: credit ? [ticket, credit] : [ticket] };
}

function post(url: string, payload: Record<string, unknown>, cookie = reception) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie }, payload });
}

async function commitLines(lines: Line[], saleId: string = newId()): Promise<string> {
  const res = await post('/sales', { id: saleId, stationId, lines });
  expect(res.statusCode, res.body).toBe(200);
  return saleId;
}

async function finalise(saleId: string) {
  const res = await post(`/sales/${saleId}/finalise`, {});
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function ledgerOf(saleId: string) {
  return ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId)).orderBy(asc(saleLine.lineNo));
}

async function extraLineOf(saleId: string) {
  return (await ledgerOf(saleId)).find((l) => (l.payload as { creditFor?: unknown } | null)?.creditFor)!;
}

/** The kids bands minted on one ticket line, in the order they were minted. */
async function kidBandsOf(saleId: string, cartLineId: string) {
  const lines = await ledgerOf(saleId);
  const ids = new Set(lines.filter((l) => l.cartLineId === cartLineId).map((l) => l.id));
  const bands = await ctx.db
    .select()
    .from(band)
    .where(and(eq(band.saleId, saleId), eq(band.kind, 'kid')))
    .orderBy(asc(band.createdAt), asc(band.id));
  return bands.filter((b) => b.saleLineId && ids.has(b.saleLineId));
}

async function walletOnBand(code: string) {
  const [key] = await ctx.db.select().from(walletKey).where(and(eq(walletKey.kind, 'band'), eq(walletKey.value, code)));
  if (!key) return null;
  const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, key.walletId));
  return row ?? null;
}

describe('SCRUM-1048 — extra food credit on a child ticket, as its own line', () => {
  it('is quoted and filed as its own ฿300 line, kept apart from the ticket it names', async () => {
    const { ticket, credit, lines } = cartOf(eatPlayId, 2, 1, { kidOrdinal: 1, satang: 30_000 });
    const quote = await post('/sales/quote', { stationId, lines });
    expect(quote.statusCode, quote.body).toBe(200);
    expect(quote.json().quote.lineTotals[credit!.id]).toBe(30_000);

    const saleId = await commitLines(lines);
    const extra = await extraLineOf(saleId);
    expect(extra).toMatchObject({
      cartLineId: credit!.id,
      kind: 'food_provision',
      ticketPackageId: eatPlayId,
      kidCount: 0,
      adultCount: 0,
      grossSatang: 30_000,
      payload: { priceSource: 'till_snapshot', creditFor: { cartLineId: ticket.id, kidOrdinal: 1 } },
    });
    // The sale's detail names the child too, so a sale resumed on the till shows it as its own line.
    const detail = (await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: reception } })).json();
    const shown = (detail.lines as { cartLineId: string; creditFor: unknown; supervised: boolean }[]).find((l) => l.cartLineId === credit!.id);
    expect(shown).toMatchObject({ creditFor: { cartLineId: ticket.id, kidOrdinal: 1 }, supervised: false });
  });

  it('loads on the named child’s band when paid, on top of the ticket’s own credit; the other child’s band is untouched', async () => {
    const { ticket, lines } = cartOf(eatPlayId, 2, 1, { kidOrdinal: 1, satang: 30_000 });
    const saleId = await commitLines(lines);
    const done = await finalise(saleId);
    // The receipt's credit vouchers are the ticket's own grants, as before.
    const kidGrants = (done.grants as { role: string; creditSatang: number }[]).filter((g) => g.role === 'kid');
    expect(kidGrants.map((g) => g.creditSatang)).toEqual([130_000, 130_000]);

    const [first, second] = await kidBandsOf(saleId, ticket.id);
    expect((await walletOnBand(first!.code))!.balanceSatang).toBe(130_000);
    const named = (await walletOnBand(second!.code))!;
    expect(named.balanceSatang).toBe(160_000);
    const [load] = await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, extraCreditActionId(saleId, (await extraLineOf(saleId)).id)));
    expect(load).toMatchObject({ walletId: named.id, kind: 'grant', source: 'prepaid_food', amountSatang: 30_000, saleId, branchId });
    expect(load!.expiresAt).not.toBeNull();
    await assertLedgerTruth();
  });

  it('a ticket that earns a child nothing: the credit is a wallet of the child’s own, on the child’s band', async () => {
    // 2 Hours Play's credit is the adults' only.
    const { ticket, lines } = cartOf(twoHoursId, 1, 1, { kidOrdinal: 0, satang: 20_000 });
    const saleId = await commitLines(lines);
    const done = await finalise(saleId);
    expect((done.grants as { role: string }[]).map((g) => g.role)).toEqual(['adult']);
    const [kidBand] = await kidBandsOf(saleId, ticket.id);
    const own = (await walletOnBand(kidBand!.code))!;
    expect(own).toMatchObject({ balanceSatang: 20_000, holderName: 'Walk-in guest' });
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, own.id));
    expect(entries.map((e) => [e.kind, e.source, e.amountSatang])).toEqual([['grant', 'prepaid_food', 20_000]]);
    await assertLedgerTruth();
  });

  it('the receipt says which band holds it, and the credit section the whole of what each QR holds', async () => {
    const eatPlay = cartOf(eatPlayId, 2, 1, { kidOrdinal: 1, satang: 30_000 });
    const saleId = await commitLines(eatPlay.lines);
    await finalise(saleId);
    const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const snapshot = await salePrintSnapshotOf(ctx.db, saleRow!);
    const [, second] = await kidBandsOf(saleId, eatPlay.ticket.id);
    const receipt = saleReceiptDocument(snapshot);
    const row = receipt.lines.find((l) => l.name === 'Prepaid food')!;
    expect(row.note).toBe(`On band ${bandShortCode(second!.code)}`);
    // The named child's QR holds the ticket's ฿1,300 and the ฿300 this sale loaded.
    expect(receipt.creditVouchers!.map((v) => v.balance)).toContain(formatTHB(160_000));
    expect(snapshot.credits!.filter((c) => c.creditSatang === 130_000)).toHaveLength(1);

    // A ticket that earns the child nothing: the credit's own wallet and QR are on the receipt.
    const twoHours = cartOf(twoHoursId, 1, 1, { kidOrdinal: 0, satang: 20_000 });
    const ownSale = await commitLines(twoHours.lines);
    await finalise(ownSale);
    const [ownRow] = await ctx.db.select().from(sale).where(eq(sale.id, ownSale));
    const ownSnapshot = await salePrintSnapshotOf(ctx.db, ownRow!);
    const [kidBand] = await kidBandsOf(ownSale, twoHours.ticket.id);
    const own = (await walletOnBand(kidBand!.code))!;
    const [qr] = await ctx.db.select().from(walletKey).where(and(eq(walletKey.walletId, own.id), eq(walletKey.kind, 'voucher_qr')));
    expect(ownSnapshot.credits!.at(-1)).toMatchObject({ creditSatang: 20_000, qrCode: qr!.value, holderName: 'Walk-in guest' });
    expect(saleReceiptDocument(ownSnapshot).lines.find((l) => l.name === 'Prepaid food')!.note).toBe(`On band ${bandShortCode(kidBand!.code)}`);
  });

  it('lands once: a retried commit, a retried close, and a commit re-sent without the child add nothing', async () => {
    const { ticket, credit, lines } = cartOf(eatPlayId, 1, 1, { kidOrdinal: 0, satang: 25_000 });
    const saleId = await commitLines(lines);
    await commitLines(lines, saleId);
    // The counter box's copy of a cart does not carry `creditFor`: the same
    // sale re-sent that way is the same lines, and the stored line still names the child.
    const { creditFor: _dropped, ...bare } = credit!;
    await commitLines([ticket, bare as Line], saleId);
    await finalise(saleId);
    await finalise(saleId);
    const extra = await extraLineOf(saleId);
    const loads = await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, extraCreditActionId(saleId, extra.id)));
    expect(loads).toHaveLength(1);
    const [kidBand] = await kidBandsOf(saleId, ticket.id);
    expect((await walletOnBand(kidBand!.code))!.balanceSatang).toBe(130_000 + 25_000);
    const credit2 = await ctx.db.execute(
      sql`select coalesce(sum(amount_satang), 0)::int as n from pos.wallet_entry where sale_id = ${saleId} and source = 'prepaid_food'`,
    );
    expect((credit2.rows[0] as { n: number }).n).toBe(25_000);
    await assertLedgerTruth();
  });

  async function refundLine(saleId: string, saleLineId: string) {
    return post(`/sales/${saleId}/refunds`, { mode: 'items', lineIds: [saleLineId], reason: 'Not wanted', actionId: newId() }, manager);
  }

  it('a refund of the line before any is spent takes all of it back off the band', async () => {
    const { ticket, lines } = cartOf(eatPlayId, 1, 1, { kidOrdinal: 0, satang: 30_000 });
    const saleId = await commitLines(lines);
    await finalise(saleId);
    const extra = await extraLineOf(saleId);
    const res = await refundLine(saleId, extra.id);
    expect(res.statusCode, res.body).toBe(200);
    const refundId = res.json().refund.id as string;
    const [kidBand] = await kidBandsOf(saleId, ticket.id);
    expect((await walletOnBand(kidBand!.code))!.balanceSatang).toBe(130_000);
    const [taken] = await ctx.db.select().from(walletEntry).where(eq(walletEntry.refundId, refundId));
    expect(taken).toMatchObject({ kind: 'spend', source: 'refund', amountSatang: -30_000, saleId });
    await assertLedgerTruth();
  });

  it('once any of it is spent the refund is refused and nothing is written', async () => {
    const { ticket, lines } = cartOf(eatPlayId, 1, 1, { kidOrdinal: 0, satang: 30_000 });
    const saleId = await commitLines(lines);
    await finalise(saleId);
    const [kidBand] = await kidBandsOf(saleId, ticket.id);
    const held = (await walletOnBand(kidBand!.code))!;
    // ฿50 at the counter: the credit the family paid for is spent first (R21).
    await ctx.db.transaction((tx) =>
      debitWallet(tx, { accountId: null, operatorId }, { walletId: held.id, actionId: `test-spend:${newId()}`, amountSatang: 5_000, source: 'fnb_order', branchId }),
    );
    const res = await refundLine(saleId, (await extraLineOf(saleId)).id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'PREPAID_CREDIT_SPENT' });
    expect(res.json().error.message).toBe(
      'This extra food credit has already been used (฿50 of ฿300), so this food line cannot be refunded.',
    );
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(0);
    expect((await walletOnBand(kidBand!.code))!.balanceSatang).toBe(160_000 - 5_000);
    await assertLedgerTruth();
  });

  it('a whole-sale refund takes the credit back off the band once, with the rest of the sale', async () => {
    const { lines } = cartOf(eatPlayId, 1, 1, { kidOrdinal: 0, satang: 30_000 });
    const saleId = await commitLines(lines);
    await finalise(saleId);
    const extra = await extraLineOf(saleId);
    const res = await post(`/sales/${saleId}/refunds`, { mode: 'whole', reason: 'Not wanted', actionId: newId() }, manager);
    expect(res.statusCode, res.body).toBe(200);
    const refundId = res.json().refund.id as string;
    const backs = (await ctx.db.select().from(walletEntry).where(eq(walletEntry.refundId, refundId))).filter(
      (e) => (e.payload as { extraCreditLineId?: string } | null)?.extraCreditLineId === extra.id,
    );
    expect(backs.map((e) => [e.kind, e.source, e.amountSatang])).toEqual([['spend', 'refund', -30_000]]);
    await assertLedgerTruth();
  });

  it('a ticket that earns the child nothing: the refund empties the credit’s own wallet', async () => {
    const { ticket, lines } = cartOf(twoHoursId, 1, 1, { kidOrdinal: 0, satang: 20_000 });
    const saleId = await commitLines(lines);
    await finalise(saleId);
    const res = await refundLine(saleId, (await extraLineOf(saleId)).id);
    expect(res.statusCode, res.body).toBe(200);
    const [kidBand] = await kidBandsOf(saleId, ticket.id);
    expect((await walletOnBand(kidBand!.code))!.balanceSatang).toBe(0);
    await assertLedgerTruth();
  });

  it('a manual discount on the line loads what the line charged, and its refund takes that back', async () => {
    const { ticket, credit, lines } = cartOf(eatPlayId, 1, 1, { kidOrdinal: 0, satang: 30_000 });
    const saleId = newId();
    const committed = await post(
      '/sales',
      {
        id: saleId,
        stationId,
        lines,
        manualDiscounts: [{ id: newId(), scope: 'line', targetLineId: credit!.id, type: 'percent', value: 50, reason: 'ZZ TEST half' }],
      },
      manager,
    );
    expect(committed.statusCode, committed.body).toBe(200);
    await post(`/sales/${saleId}/finalise`, {}, manager);
    const extra = await extraLineOf(saleId);
    expect(extra.grossSatang).toBe(15_000);
    const [load] = await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, extraCreditActionId(saleId, extra.id)));
    expect(load!.amountSatang).toBe(15_000);
    const [kidBand] = await kidBandsOf(saleId, ticket.id);
    expect((await walletOnBand(kidBand!.code))!.balanceSatang).toBe(130_000 + 15_000);
    const res = await refundLine(saleId, extra.id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await walletOnBand(kidBand!.code))!.balanceSatang).toBe(130_000);
    await assertLedgerTruth();
  });

  it('once the credit has expired its refund is refused in those words, not as used', async () => {
    const { lines } = cartOf(twoHoursId, 1, 1, { kidOrdinal: 0, satang: 20_000 });
    const saleId = await commitLines(lines);
    await finalise(saleId);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const far = new Date(Date.now() + 30 * 24 * 3600_000);
    const expired = await expireWalletsForDay(ctx.db, branchId, row!.businessDate!, far);
    expect(expired.expiredSatang).toBeGreaterThanOrEqual(20_000);
    const res = await refundLine(saleId, (await extraLineOf(saleId)).id);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'PREPAID_CREDIT_EXPIRED',
      message: 'This extra food credit has expired and is no longer on the band, so this food line cannot be refunded.',
    });
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(0);
    await assertLedgerTruth();
  });

  it('one line per child: a second line naming the same child is refused', async () => {
    const c = cartOf(eatPlayId, 2, 1, { kidOrdinal: 0, satang: 10_000 });
    const res = await post('/sales', { id: newId(), stationId, lines: [...c.lines, { ...c.credit!, id: newId() }] });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toBe('That child already has extra food credit on this order');
  });

  it('is priced, taxed and filed exactly as a dropped-off child’s extra credit row', async () => {
    const { lines } = cartOf(twoHoursId, 1, 1, { kidOrdinal: 0, satang: 30_000 });
    const saleId = await commitLines(lines);
    const extra = await extraLineOf(saleId);

    const checkinId = newId();
    const reg = await post('/checkin/registrations', {
      id: newId(),
      branchId,
      stationId,
      guardianName: 'ZZ TEST Parent',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [
        {
          checkinId,
          name: 'ZZ TEST Mint',
          ageYears: 6,
          service: 'drop_off',
          allergies: null,
          foodRestrictions: null,
          foodProvision: { mode: 'prepaid_credit', paidSatang: 30_000, creditSatang: 30_000 },
        },
      ],
    });
    expect(reg.statusCode, reg.body).toBe(200);
    const dropOffSale = await commitLines([
      {
        id: checkinId,
        packageId: twoHoursId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
        foodProvision: { mode: 'prepaid_credit', paidSatang: 30_000 },
      },
    ]);
    const food = (await ledgerOf(dropOffSale)).find((l) => l.kind === 'food_provision')!;
    const filed = (l: typeof food) => ({
      kind: l.kind,
      label: l.label,
      revenueCategory: l.revenueCategory,
      taxableCategory: l.taxableCategory,
      quantity: l.quantity,
      unitSatang: l.unitSatang,
      baseSatang: l.baseSatang,
      netSatang: l.netSatang,
      serviceChargeSatang: l.serviceChargeSatang,
      taxSatang: l.taxSatang,
      taxMode: l.taxMode,
      taxRateBp: l.taxRateBp,
      grossSatang: l.grossSatang,
      ticketPackageId: l.ticketPackageId,
    });
    expect(filed(extra)).toEqual(filed(food));
    const breakdownOf = async (id: string) => {
      const [row] = await ctx.db.select({ tb: sale.taxBreakdown }).from(sale).where(eq(sale.id, id));
      return ((row!.tb as { categories: { category: string }[] }).categories ?? []).find((c) => c.category === 'stored_value');
    };
    expect(await breakdownOf(saleId)).toEqual(await breakdownOf(dropOffSale));
  });

  it('refuses a line that names nothing it can load', async () => {
    const refusals: [string, (c: ReturnType<typeof cartOf>) => Line[]][] = [
      ['That ticket has no child for this food credit', (c) => [c.ticket, { ...c.credit!, creditFor: { cartLineId: c.ticket.id, kidOrdinal: 2 } }]],
      ['The ticket this food credit is for is not on the order', (c) => [c.ticket, { ...c.credit!, creditFor: { cartLineId: newId(), kidOrdinal: 0 } }]],
      ['Extra food credit needs an amount', (c) => [c.ticket, { ...c.credit!, foodProvision: { mode: 'prepaid_credit', paidSatang: 0 } }]],
      ['Extra food credit is a line of its own, with nobody and nothing else on it', (c) => [c.ticket, { ...c.credit!, adults: 1 }]],
    ];
    for (const [message, shape] of refusals) {
      const res = await post('/sales', { id: newId(), stationId, lines: shape(cartOf(eatPlayId, 2, 1, { kidOrdinal: 0, satang: 10_000 })) });
      expect(res.statusCode, message).toBe(400);
      expect(res.json().error.message).toBe(message);
    }
  });

  it('does not loosen the rule that no child is sold a ticket alone', async () => {
    const { lines } = cartOf(eatPlayId, 1, 0, { kidOrdinal: 0, satang: 30_000 });
    const res = await post('/sales', { id: newId(), stationId, lines });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('SALE_KIDS_WITHOUT_REGISTRATION');
  });
});
