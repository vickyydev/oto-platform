import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  booking,
  branch,
  checkin,
  printJob,
  refund,
  station,
  ticketPackage,
  wallet,
  walletEntry,
  walletKey,
} from '@oto/db';
import { bandShortCode, mintVoucherQr, newId } from '@oto/shared';
import { quoteBooking } from '../src/services/booking-checkout';
import { buildPrintDocument } from '../src/services/sale-printing';
import { createWalletWithGrant, debitWallet, prepaidBalanceOf } from '../src/services/wallet';
import { CHALONG_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 1 — the wallet model and the grants (plan docs/progress/plans/
 * wallet/PLAN.md §2.1-2.2, §6), driven through the routes the till calls.
 *
 * The law is the prototype's (`lib/sale.ts:146-264`); its table is pinned in
 * `packages/shared/test/wallet.test.ts`. What is proved here is that the
 * platform applies it where the money is: inside the finalise transaction a
 * walk-in, a booking's redemption and an offline replay all pass through,
 * once, with a wallet per earning person, ONE QR each, a credit voucher
 * printed for it, and the ledger summing to the balance after every flow.
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
let chalongManager: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
let eatPlayId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
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

// --- Helpers ----------------------------------------------------------------------

/** The ledger is the truth: every wallet's balance is the sum of its entries, and its last entry says so. */
async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total,
           (select e.balance_after from pos.wallet_entry e where e.wallet_id = w.id order by e.created_at desc, e.id desc limit 1) as last_after
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string; last_after: string | null }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
    if (r.last_after !== null) expect(Number(r.last_after), `wallet ${r.id}`).toBe(Number(r.balance));
  }
}

async function commit(payload: Record<string, unknown>): Promise<string> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, ...payload },
  });
  expect(res.statusCode, res.body).toBe(200);
  return saleId;
}

async function finalise(saleId: string) {
  const res = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function ticketSale(packageId: string, kids: number, adults: number) {
  const saleId = await commit({ lines: [{ id: newId(), packageId, kids, adults }] });
  return { saleId, done: await finalise(saleId) };
}

async function linesOf(saleId: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: reception } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

type Grant = { walletId: string; role: string; personIndex: number; creditSatang: number; qrCode: string; holderName: string | null; bandShortCode: string | null; gateAccess: boolean };

// --- Grants at finalise ---------------------------------------------------------------

describe('a walk-in ticket sale grants credit as it closes', () => {
  it('2 Hours Play, 2 kids + 1 adult: the adult earns their list price; one wallet, one QR, on their band, with a voucher', async () => {
    const { saleId, done } = await ticketSale(twoHoursId, 2, 1);
    expect(done.finalised).toBe(true);
    const grants = done.grants as Grant[];
    const detail = await linesOf(saleId);
    const adultUnit = (detail.lines as { kind: string; unitSatang: number }[]).find((l) => l.kind === 'adults_paid')!.unitSatang;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ role: 'adult', personIndex: 0, creditSatang: adultUnit, holderName: 'Walk-in guest', gateAccess: true });
    expect(grants[0]!.qrCode).toMatch(/^QR-[0-9A-HJKMNP-TV-Z]{20}$/);

    // The wallet: one grant entry, ticket_sale, keyed by the sale and the person.
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'grant',
      source: 'ticket_sale',
      amountSatang: adultUnit,
      balanceAfter: adultUnit,
      actionId: `sale:${saleId}:grant:0`,
      stationId,
      branchId,
    });
    expect(entries[0]!.expiresAt).not.toBeNull();

    // ONE QR, and it is the adult's band too.
    const adultBand = (await ctx.db.select().from(band).where(and(eq(band.saleId, saleId), eq(band.kind, 'adult'))))[0]!;
    const keys = await ctx.db.select().from(walletKey).where(eq(walletKey.walletId, grants[0]!.walletId));
    expect(keys.map((k) => k.kind).sort()).toEqual(['band', 'voucher_qr']);
    expect(keys.find((k) => k.kind === 'voucher_qr')!.value).toBe(grants[0]!.qrCode);
    expect(keys.find((k) => k.kind === 'band')!.value).toBe(adultBand.code);

    // The paper: a credit voucher after the bands, carrying that same QR.
    const kinds = (done.printing.jobs as { kind: string }[]).map((j) => j.kind);
    expect(kinds).toEqual(['receipt', 'kids_wristband', 'kids_wristband', 'adult_wristband', 'credit_voucher']);
    const voucherJob = (done.printing.jobs as { id: string; kind: string; subjectType: string; subjectId: string }[]).find(
      (j) => j.kind === 'credit_voucher',
    )!;
    expect(voucherJob).toMatchObject({ subjectType: 'wallet', subjectId: grants[0]!.walletId });
    const [jobRow] = await ctx.db.select().from(printJob).where(eq(printJob.id, voucherJob.id));
    const doc = await buildPrintDocument(ctx.db, { boxId: jobRow!.boxId, operatorId }, voucherJob.id);
    expect(doc.job).toEqual({
      kind: 'credit_voucher',
      data: {
        balance: `฿${(adultUnit / 100).toLocaleString('en-US')}`,
        balanceTHB: adultUnit / 100,
        qrCode: grants[0]!.qrCode,
        holderName: 'Walk-in guest',
      },
    });

    // The sale detail carries the same grants, the band named by its short code.
    expect((detail.grants as Grant[])[0]).toMatchObject({
      walletId: grants[0]!.walletId,
      qrCode: grants[0]!.qrCode,
      bandShortCode: bandShortCode(adultBand.code),
    });

    // Audited: the wallet's creation and its grant, never the QR itself.
    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, grants[0]!.walletId));
    expect(audits.map((a) => a.action).sort()).toEqual(['wallet.create', 'wallet.grant']);
    expect(JSON.stringify(audits)).not.toContain(grants[0]!.qrCode);
    await assertLedgerTruth();
  });

  it('Eat & Play (both, full price): the ฿350 adult and the ฿1,300 kid each get their own wallet and voucher', async () => {
    const { saleId, done } = await ticketSale(eatPlayId, 1, 1);
    const grants = done.grants as Grant[];
    expect(grants.map((g) => [g.role, g.creditSatang, g.gateAccess])).toEqual([
      ['adult', 35_000, true],
      ['kid', 130_000, false],
    ]);
    expect(new Set(grants.map((g) => g.qrCode)).size).toBe(2);
    const kinds = (done.printing.jobs as { kind: string }[]).map((j) => j.kind);
    expect(kinds.filter((k) => k === 'credit_voucher')).toHaveLength(2);
    // Each wallet is on the band of the person who earned it.
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    for (const g of grants) {
      const [k] = await ctx.db.select().from(walletKey).where(and(eq(walletKey.walletId, g.walletId), eq(walletKey.kind, 'band')));
      const b = bands.find((x) => x.code === k!.value)!;
      expect(b.kind).toBe(g.role === 'adult' ? 'adult' : 'kid');
    }
    await assertLedgerTruth();
  });

  it('a replayed finalise grants once and answers with the same wallets', async () => {
    const { saleId, done } = await ticketSale(eatPlayId, 1, 1);
    const again = await finalise(saleId);
    expect(again.replay).toBe(true);
    expect(again.grants).toEqual(done.grants);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId));
    expect(entries).toHaveLength(2);
    const wallets = await ctx.db.execute(sql`select count(distinct wallet_id)::int as n from pos.wallet_entry where sale_id = ${saleId}`);
    expect((wallets.rows[0] as { n: number }).n).toBe(2);
    await assertLedgerTruth();
  });

  it('a package with no credit rule earns nothing, and prints no voucher', async () => {
    await ctx.db.update(ticketPackage).set({ creditRule: null }).where(eq(ticketPackage.id, twoHoursId));
    try {
      const { done } = await ticketSale(twoHoursId, 1, 2);
      expect(done.grants).toEqual([]);
      expect((done.printing.jobs as { kind: string }[]).some((j) => j.kind === 'credit_voucher')).toBe(false);
    } finally {
      await ctx.db.update(ticketPackage).set({ creditRule: { appliesTo: 'adults', basis: 'full_price' } }).where(eq(ticketPackage.id, twoHoursId));
    }
  });
});

describe('concurrency and idempotency of the primitive', () => {
  it('two concurrent createWalletWithGrant with the same action key make one wallet', async () => {
    const actionId = `race:${newId()}`;
    const actor = { accountId: null, operatorId };
    const make = () =>
      ctx.db.transaction((tx) =>
        createWalletWithGrant(tx, actor, {
          actionId,
          branchId,
          holderName: 'Race',
          amountSatang: 5_000,
          source: 'ticket_sale',
          keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
        }),
      );
    const [a, b] = await Promise.all([make(), make()]);
    expect(a.wallet.id).toBe(b.wallet.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, actionId));
    expect(entries).toHaveLength(1);
    const keys = await ctx.db.select().from(walletKey).where(eq(walletKey.walletId, a.wallet.id));
    expect(keys).toHaveLength(1);
    await assertLedgerTruth();
  });

  it('a debit larger than the balance is refused in words and writes nothing', async () => {
    const made = await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, { accountId: null, operatorId }, {
        actionId: `over:${newId()}`,
        branchId,
        amountSatang: 5_000,
        source: 'ticket_sale',
        keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
      }),
    );
    const refused = await ctx.db
      .transaction((tx) =>
        debitWallet(tx, { accountId: null, operatorId }, { walletId: made.wallet.id, actionId: `over-spend:${newId()}`, amountSatang: 5_001, source: 'fnb_order', branchId }),
      )
      .catch((err: { code?: string; message?: string }) => err);
    expect(refused).toMatchObject({ code: 'WALLET_INSUFFICIENT', message: 'This wallet has ฿50 left, not ฿50.01.' });
    const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, made.wallet.id));
    expect(row!.balanceSatang).toBe(5_000);
    await assertLedgerTruth();
  });
});

// --- Booking redemption ------------------------------------------------------------------

describe('a booking redeemed at the counter earns like the walk-in', () => {
  it('1 kid + 1 adult on 2 Hours Play: the adult earns the booked adult unit, through the same finalise', async () => {
    const id = newId();
    const bookingDate = new Date().toISOString().slice(0, 10);
    const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
    const quote = await quoteBooking(ctx.db, br!, { tier: 'tourist', visitDate: bookingDate, lines: [{ packageId: twoHoursId, kids: 1, adults: 1 }] });
    await ctx.db.insert(booking).values({
      id,
      operatorId,
      branchId,
      reference: `OTO-WAL-${id.slice(-4).toUpperCase()}`,
      bookingDate,
      status: 'paid',
      totalSatang: quote.totalSatang,
      pricingSnapshot: quote as never,
      payload: {
        tier: 'tourist',
        rateMode: quote.rateMode,
        parentName: 'Khun Ploy',
        phone: '+66812229901',
        contactChannel: 'whatsapp',
        locale: 'en',
        lines: quote.lines as unknown as Array<Record<string, unknown>>,
        clientSnapshot: null,
      },
    });
    const res = await ctx.app.inject({ method: 'POST', url: `/bookings/${id}/redeem`, headers: { cookie: reception }, payload: { stationId } });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const adultUnit = (quote.lines[0] as unknown as { adultUnitSatang: number }).adultUnitSatang;
    expect((body.grants as Grant[]).map((g) => [g.role, g.creditSatang, g.holderName])).toEqual([['adult', adultUnit, 'Booking guest']]);
    expect((body.printing.jobs as { kind: string }[]).filter((j) => j.kind === 'credit_voucher')).toHaveLength(1);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, body.sale.id));
    expect(entries).toHaveLength(1);
    await assertLedgerTruth();
  });
});

// --- A child's prepaid food --------------------------------------------------------------

async function childInPark(food: { mode: 'prepaid_credit'; paidSatang: number; creditSatang: number }) {
  const checkinId = newId();
  const registrationId = newId();
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: reception },
    payload: {
      id: registrationId,
      branchId,
      stationId,
      guardianName: 'Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{ checkinId, name: 'Mint', ageYears: 6, service: 'drop_off', allergies: null, foodRestrictions: null, foodProvision: food }],
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const saleId = await commit({
    lines: [
      {
        id: checkinId,
        // Eat & Play pays kids too — and a drop-off child's line still earns nothing.
        packageId: eatPlayId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
        foodProvision: { mode: food.mode, paidSatang: food.paidSatang },
      },
    ],
  });
  const fin = await finalise(saleId);
  // A drop-off child's ticket earns nothing: their food is their own wallet.
  expect(fin.grants).toEqual([]);
  const now = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie: reception },
    payload: { saleId, entries: [{ checkinId, nannyId: null }] },
  });
  expect(now.statusCode, now.body).toBe(200);
  return { checkinId, registrationId, saleId, bandId: now.json().bands[0].id as string };
}

describe("a prepaid-credit child's food money is their own wallet", () => {
  it('check-in-now loads it on the child’s band; release refunds what is really left and takes it off the wallet', async () => {
    const family = await childInPark({ mode: 'prepaid_credit', paidSatang: 20_000, creditSatang: 20_000 });
    const held = await prepaidBalanceOf(ctx.db, operatorId, family.checkinId);
    expect(held).toMatchObject({ balanceSatang: 20_000 });
    const [load] = await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, `checkin:${family.checkinId}:prepaid`));
    expect(load).toMatchObject({ kind: 'grant', source: 'prepaid_food', amountSatang: 20_000, saleId: family.saleId });
    const [childBand] = await ctx.db.select().from(band).where(eq(band.id, family.bandId));
    const keys = await ctx.db.select().from(walletKey).where(eq(walletKey.walletId, held!.walletId));
    expect(keys.find((k) => k.kind === 'band')!.value).toBe(childBand!.code);
    expect(keys.some((k) => k.kind === 'voucher_qr')).toBe(true);
    const [w] = await ctx.db.select().from(wallet).where(eq(wallet.id, held!.walletId));
    expect(w!.holderName).toBe('Mint');

    // A retried check-in loads nothing twice.
    const retry = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-now',
      headers: { cookie: reception },
      payload: { saleId: family.saleId, entries: [{ checkinId: family.checkinId, nannyId: null }] },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    expect((await prepaidBalanceOf(ctx.db, operatorId, family.checkinId))!.balanceSatang).toBe(20_000);

    // ฿50 spent at the counter (round 2's tender writes exactly this entry).
    await ctx.db.transaction((tx) =>
      debitWallet(tx, { accountId: null, operatorId }, { walletId: held!.walletId, actionId: `test-spend:${newId()}`, amountSatang: 5_000, source: 'fnb_order', branchId }),
    );
    await assertLedgerTruth();

    // The release's reconciliation reads the real balance: ฿150 unused, not ฿200.
    const context = (
      await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/stays/${family.checkinId}`, headers: { cookie: reception } })
    ).json();
    expect(context.reconciliation).toMatchObject({ mode: 'prepaid_credit', paidSatang: 20_000, remainingCreditSatang: 15_000, totalUnusedSatang: 15_000, totalRedeemedSatang: 5_000 });

    const photoId = newId();
    const file = await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie: reception },
      payload: { id: photoId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: family.registrationId, filename: 'pickup.jpg' },
    });
    expect(file.statusCode, file.body).toBe(200);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/stays/${family.checkinId}/release`,
      headers: { cookie: reception },
      payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().release.settlement).toMatchObject({ policy: 'refund', unusedSatang: 15_000, refundedSatang: 15_000 });
    const [refunded] = await ctx.db.select().from(refund).where(eq(refund.saleId, family.saleId));
    expect(refunded!.amountSatang).toBe(15_000);

    // The cash went back, so the credit came off: the band holds nothing now.
    const after = await prepaidBalanceOf(ctx.db, operatorId, family.checkinId);
    expect(after!.balanceSatang).toBe(0);
    const ledger = await ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, held!.walletId));
    expect(ledger.map((e) => [e.kind, e.source, e.amountSatang]).sort()).toEqual(
      [
        ['grant', 'prepaid_food', 20_000],
        ['spend', 'fnb_order', -5_000],
        ['spend', 'refund', -15_000],
      ].sort(),
    );
    expect(ledger.find((e) => e.source === 'refund')!.refundId).toBe(refunded!.id);
    const [stayRow] = await ctx.db.select().from(checkin).where(eq(checkin.id, family.checkinId));
    expect(stayRow!.status).toBe('out');
    await assertLedgerTruth();
  });
});

// --- Reading a wallet ----------------------------------------------------------------

describe('GET /wallets — the lookup the Wallet view builds on', () => {
  it('finds a wallet by its voucher QR and by its band’s short code; never shows the band’s signed code', async () => {
    const { saleId, done } = await ticketSale(twoHoursId, 0, 1);
    const grant = (done.grants as Grant[])[0]!;
    const byQr = await ctx.app.inject({ method: 'GET', url: `/wallets/lookup?key=${encodeURIComponent(grant.qrCode.toLowerCase())}`, headers: { cookie: reception } });
    expect(byQr.statusCode, byQr.body).toBe(200);
    expect(byQr.json().wallet).toMatchObject({ id: grant.walletId, balanceSatang: grant.creditSatang, status: 'active', holderName: 'Walk-in guest' });
    expect(byQr.json().ledger).toHaveLength(1);
    expect(byQr.json().ledger[0]).toMatchObject({ kind: 'grant', source: 'ticket_sale', amountSatang: grant.creditSatang, balanceAfterSatang: grant.creditSatang, actorName: 'Som (Reception)' });

    const [adult] = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    const short = bandShortCode(adult!.code)!;
    const byBand = await ctx.app.inject({ method: 'GET', url: `/wallets/lookup?key=${encodeURIComponent(short)}`, headers: { cookie: reception } });
    expect(byBand.statusCode, byBand.body).toBe(200);
    expect(byBand.json().wallet.id).toBe(grant.walletId);
    expect(byBand.body).not.toContain(adult!.code);
    expect(byBand.json().wallet.keys).toEqual(expect.arrayContaining([{ kind: 'band', display: short }]));

    const byFullCode = await ctx.app.inject({ method: 'GET', url: `/wallets/lookup?key=${encodeURIComponent(adult!.code)}`, headers: { cookie: reception } });
    expect(byFullCode.json().wallet.id).toBe(grant.walletId);

    const byId = await ctx.app.inject({ method: 'GET', url: `/wallets/${grant.walletId}`, headers: { cookie: reception } });
    expect(byId.statusCode, byId.body).toBe(200);
    expect(byId.json().wallet.id).toBe(grant.walletId);
  });

  it('refuses in the counter’s words: an unknown key, another park’s wallet, no session', async () => {
    const unknown = await ctx.app.inject({ method: 'GET', url: '/wallets/lookup?key=QR-NOPE', headers: { cookie: reception } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error).toMatchObject({ code: 'WALLET_NOT_FOUND', message: 'No wallet carries that band or voucher — check the code and scan again.' });

    const { done } = await ticketSale(twoHoursId, 0, 1);
    const grant = (done.grants as Grant[])[0]!;
    const otherPark = await ctx.app.inject({ method: 'GET', url: `/wallets/lookup?key=${grant.qrCode}`, headers: { cookie: chalongManager } });
    expect(otherPark.statusCode).toBe(404);
    expect(otherPark.json().error.code).toBe('WALLET_NOT_FOUND');
    const otherParkById = await ctx.app.inject({ method: 'GET', url: `/wallets/${grant.walletId}`, headers: { cookie: chalongManager } });
    expect(otherParkById.statusCode).toBe(404);

    const anonymous = await ctx.app.inject({ method: 'GET', url: `/wallets/lookup?key=${grant.qrCode}` });
    expect(anonymous.statusCode).toBe(401);
    const blank = await ctx.app.inject({ method: 'GET', url: '/wallets/lookup?key=', headers: { cookie: reception } });
    expect(blank.statusCode).toBe(400);
  });
});
