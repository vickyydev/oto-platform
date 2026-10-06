import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  box,
  boxCommand,
  branch,
  device,
  paymentAttempt,
  product,
  sale,
  station,
  ticketPackage,
  wallet,
  walletEntry,
  walletKey,
} from '@oto/db';
import { WALLET_TENDER_CODE, countsAsTillTakings, mintVoucherQr, newId } from '@oto/shared';
import { openAttempt, settleAttempt } from '../src/services/payments/attempt';
import { createWalletWithGrant, prepaidBalanceOf } from '../src/services/wallet';
import { ADMIN, BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 2 — the FOCUSED GATE's reproductions (invariants 1-5), kept.
 *
 * (1) the drawer and the takings: no path opens the drawer for credit or
 *     files it as till money, including a refused press and a park that
 *     configures a `wallet_credit` row on its own tender grid;
 * (2) the last baht: three tills on one wallet, the same press twice at once,
 *     a refused combined press that must take the credit back with it;
 * (3) the refund: a wallet-only sale refunded in pieces hands back no cash;
 *     the terminal's Alipay "wallet" beside stored value on one sale is never
 *     put on a stored-value wallet; credit is never picked off the grid by
 *     the manual or terminal routes;
 * (4) ledger truth under spend: a child's prepaid wallet spent at the
 *     counter, refunded, and released — and a release racing a spend.
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
let admin: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let boxId: string;
let twoHoursId: string;
let friesId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  boxId = till!.boxId!;
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, boxId));
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
  const [fries] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-FRIES'), isNull(product.archivedAt)));
  friesId = fries!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers ---------------------------------------------------------------------------

async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total,
           (select min(e.balance_after) from pos.wallet_entry e where e.wallet_id = w.id)::bigint as low
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string; low: string | null }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
    expect(Number(r.balance), `wallet ${r.id} negative`).toBeGreaterThanOrEqual(0);
    if (r.low !== null) expect(Number(r.low), `wallet ${r.id} went below zero`).toBeGreaterThanOrEqual(0);
  }
}

async function walletWith(amountSatang: number): Promise<{ id: string; qr: string }> {
  const qr = mintVoucherQr();
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `gate-r2-grant:${newId()}`,
      branchId,
      holderName: 'Walk-in guest',
      amountSatang,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
    }),
  );
  return { id: made.wallet.id, qr };
}

async function balanceOfWallet(id: string): Promise<number> {
  const [row] = await ctx.db.select().from(wallet).where(eq(wallet.id, id));
  return row!.balanceSatang;
}

/** French Fries, ฿90 each, at the F&B counter. */
async function fnbOrder(quantity = 1): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '12', items: [{ id: newId(), productId: friesId, quantity }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().sale.totals.grossSatang as number };
}

function finalise(saleId: string, payload: Record<string, unknown>, cookie = reception) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie }, payload });
}

function refundOf(saleId: string, body: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie: manager }, payload: body });
}

async function attemptsOf(saleId: string) {
  return ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
}

async function drawerKicks(): Promise<number> {
  return (await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.boxId, boxId), eq(boxCommand.kind, 'drawer_kick')))).length;
}

type Slice = { route: string; amountSatang: number; status: string; attemptId: string | null; method: string };

// --- (1) THE DRAWER AND THE TAKINGS -------------------------------------------------------

describe('(1) credit never opens the drawer and never reads as till takings', () => {
  it('a combined press whose cash is short is refused WHOLE: the credit goes back with it, no attempt, no kick', async () => {
    const w = await walletWith(5_000);
    const { saleId } = await fnbOrder();
    const kicks = await drawerKicks();
    // ฿50 credit, ฿40 remainder in cash — but only ฿30 handed over.
    const res = await finalise(saleId, {
      wallet: { key: w.qr, useCredit: true },
      tender: { method: 'cash', kind: 'cash', tenderedSatang: 3_000 },
      actionId: newId(),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(await attemptsOf(saleId)).toHaveLength(0);
    expect(await balanceOfWallet(w.id)).toBe(5_000);
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId))).toHaveLength(0);
    expect(await drawerKicks()).toBe(kicks);
    await assertLedgerTruth();
  });

  it('wallet-only press, then the cash press: one kick for the cash, none for the credit or the replays', async () => {
    const w = await walletWith(5_000);
    const { saleId } = await fnbOrder();
    const kicks = await drawerKicks();
    const creditAction = newId();
    const first = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: creditAction });
    expect(first.json()).toMatchObject({ finalised: false, outstandingSatang: 4_000 });
    expect(await drawerKicks()).toBe(kicks);
    const cashAction = newId();
    const cash = await finalise(saleId, { method: 'cash', kind: 'cash', tenderedSatang: 5_000, actionId: cashAction });
    expect(cash.json().finalised).toBe(true);
    expect(await drawerKicks()).toBe(kicks + 1);
    // Both presses retried after the close: no second kick, no second spend.
    const againCredit = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: creditAction });
    expect(againCredit.statusCode).toBe(200);
    expect(againCredit.json()).toMatchObject({ replay: true, walletSpend: null });
    expect(againCredit.json().walletAttempt?.id).toBe(first.json().walletAttempt.id);
    await finalise(saleId, { method: 'cash', kind: 'cash', tenderedSatang: 5_000, actionId: cashAction });
    expect(await drawerKicks()).toBe(kicks + 1);
    const attempts = await attemptsOf(saleId);
    expect(attempts.filter((a) => countsAsTillTakings(a)).map((a) => [a.method, a.amountSatang])).toEqual([['cash', 4_000]]);
    expect(await balanceOfWallet(w.id)).toBe(0);
    await assertLedgerTruth();
  });

  it('a park that puts a "wallet_credit" row on its own grid still cannot take money with it, from any door', async () => {
    const made = await ctx.app.inject({
      method: 'POST',
      url: '/payment-methods',
      headers: { cookie: admin },
      payload: { code: WALLET_TENDER_CODE, label: 'Credit', kind: 'cash' },
    });
    // The gate's finding, fixed: the code is reserved at the door
    // (`assertTenderableCode`), so no dead button reaches the grid. And what
    // MUST hold either way is that it never takes money.
    expect(made.statusCode).toBe(400);
    expect(made.json().error.message).toContain(WALLET_TENDER_CODE);
    const configured = false;
    const { saleId } = await fnbOrder();
    const kicks = await drawerKicks();
    const manualFinalise = await finalise(saleId, { method: WALLET_TENDER_CODE, kind: 'cash', tenderedSatang: 9_000, actionId: newId() });
    expect(manualFinalise.statusCode).toBe(400);
    const manualCard = await ctx.app.inject({
      method: 'POST',
      url: '/payments/manual',
      headers: { cookie: reception },
      payload: { saleId, method: WALLET_TENDER_CODE, kind: 'card', approvalCode: 'A1', actionId: newId() },
    });
    expect(manualCard.statusCode).toBeGreaterThanOrEqual(400);
    const terminal = await ctx.app.inject({
      method: 'POST',
      url: '/payments/attempts',
      headers: { cookie: reception },
      payload: { saleId, tender: 'wallet', method: WALLET_TENDER_CODE, actionId: newId() },
    });
    expect(terminal.statusCode).toBeGreaterThanOrEqual(400);
    expect(await attemptsOf(saleId)).toHaveLength(0);
    expect(await drawerKicks()).toBe(kicks);
    if (configured) {
      await ctx.app.inject({ method: 'DELETE', url: `/payment-methods/${WALLET_TENDER_CODE}`, headers: { cookie: admin } });
    }
  });
});

// --- (2) THE LAST BAHT ----------------------------------------------------------------------

describe('(2) the last baht', () => {
  it('three tills on one ฿100 wallet at once: ฿90 + ฿10 + the honest zero, never more than the wallet held', async () => {
    const w = await walletWith(10_000);
    const orders = await Promise.all([fnbOrder(), fnbOrder(), fnbOrder()]);
    const answers = await Promise.all(
      orders.map((o) => finalise(o.saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() })),
    );
    const ok = answers.filter((a) => a.statusCode === 200).map((a) => a.json().walletSpend.amountSatang as number);
    const refused = answers.filter((a) => a.statusCode !== 200);
    expect(ok.sort((a, b) => b - a)).toEqual([9_000, 1_000]);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.statusCode).toBe(409);
    expect(refused[0]!.json().error.code).toBe('WALLET_EMPTY');
    expect(await balanceOfWallet(w.id)).toBe(0);
    const spends = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'spend')));
    expect(spends.reduce((s, e) => s + e.amountSatang, 0)).toBe(-10_000);
    const walletAttempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(and(inArray(paymentAttempt.saleId, orders.map((o) => o.saleId)), eq(paymentAttempt.method, 'wallet')));
    expect(walletAttempts.reduce((s, a) => s + a.amountSatang, 0)).toBe(10_000);
    // Every attempt has exactly one spend entry keyed by it.
    for (const a of walletAttempts) {
      expect(spends.filter((e) => e.paymentAttemptId === a.id)).toHaveLength(1);
    }
    await assertLedgerTruth();
  });

  it('the SAME press fired twice at once on one sale spends once', async () => {
    const w = await walletWith(20_000);
    const { saleId } = await fnbOrder(3);
    const actionId = newId();
    const [a, b] = await Promise.all([
      finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId }),
      finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().walletAttempt.id).toBe(b.json().walletAttempt.id);
    expect(await balanceOfWallet(w.id)).toBe(0);
    expect(await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'spend')))).toHaveLength(1);
    expect((await attemptsOf(saleId)).filter((x) => x.method === 'wallet')).toHaveLength(1);
    await assertLedgerTruth();
  });

  it('a refused spend (expired-looking zero, unknown key, ticket counter) leaves balance == sum', async () => {
    const w = await walletWith(1_000);
    const { saleId } = await fnbOrder();
    const exact = await finalise(saleId, { wallet: { key: w.qr, amountSatang: 1_001 }, actionId: newId() });
    expect(exact.statusCode).toBe(409);
    expect(exact.json().error.code).toBe('WALLET_INSUFFICIENT');
    expect(await balanceOfWallet(w.id)).toBe(1_000);
    await assertLedgerTruth();
  });
});

// --- (3) THE REFUND -----------------------------------------------------------------------------

describe('(3) a refund puts credit back once, and never pays credit out as cash', () => {
  it('a wallet-only sale refunded in three pieces: every baht back on the wallet, no cash slice ever', async () => {
    const w = await walletWith(20_000);
    const { saleId } = await fnbOrder();
    const res = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() });
    expect(res.json().finalised).toBe(true);
    expect(await balanceOfWallet(w.id)).toBe(11_000);
    const slices: Slice[] = [];
    for (const body of [
      { mode: 'custom', amountSatang: 3_000, reason: 'Cold' },
      { mode: 'custom', amountSatang: 3_000, reason: 'Still cold' },
      { mode: 'whole', reason: 'All of it' },
    ]) {
      const r = await refundOf(saleId, { ...body, actionId: newId() });
      expect(r.statusCode, r.body).toBe(200);
      slices.push(...(r.json().refund.tenderAllocation as Slice[]));
    }
    expect(slices.every((s) => s.route === 'wallet' && s.status === 'done')).toBe(true);
    expect(slices.reduce((s, x) => s + x.amountSatang, 0)).toBe(9_000);
    expect(await balanceOfWallet(w.id)).toBe(20_000);
    const restores = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'refund')));
    expect(restores.reduce((s, e) => s + e.amountSatang, 0)).toBe(9_000);
    await assertLedgerTruth();
  });

  it('the terminal Alipay "wallet" beside stored value on one sale: only the stored value goes back on a wallet', async () => {
    const w = await walletWith(5_000);
    const { saleId } = await fnbOrder();
    const first = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() });
    expect(first.json()).toMatchObject({ finalised: false, outstandingSatang: 4_000 });

    // The EDC's Alipay: `qr` money on a device, `payload.tender = 'wallet'` — the confusion.
    const deviceId = newId();
    await ctx.db.insert(device).values({
      id: deviceId, operatorId, branchId, boxId, kind: 'terminal', label: 'Gate r2 EDC', transport: 'simulated', protocol: 'ghl_linkpos',
    });
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const alipayId = await ctx.db.transaction(async (tx) => {
      const opened = await openAttempt(tx, {
        operatorId, branchId, stationId, saleId, deviceId, businessDate: row!.businessDate!,
        method: 'qr', methodCode: 'promptpay', provider: 'ghl', amountSatang: 4_000,
        payload: { tender: 'wallet', wallet: 'alipay', protocol: 'ghl_linkpos' },
      });
      await settleAttempt(tx, opened.id, { paidAt: new Date() });
      return opened.id;
    });
    const closed = await finalise(saleId, { actionId: newId() });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().finalised).toBe(true);
    const [alipay] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, alipayId));
    expect(countsAsTillTakings(alipay!)).toBe(true);

    // A partial refund bigger than the credit: the stored value goes back on its wallet,
    // the Alipay part is NEVER a wallet slice and never touches the ledger.
    const r = await refundOf(saleId, { mode: 'custom', amountSatang: 7_000, reason: 'Wrong order', actionId: newId() });
    expect(r.statusCode, r.body).toBe(200);
    const slices = r.json().refund.tenderAllocation as Slice[];
    const walletSlices = slices.filter((s) => s.route === 'wallet');
    expect(walletSlices.map((s) => s.amountSatang)).toEqual([5_000]);
    expect(slices.find((s) => s.attemptId === alipayId)?.route).not.toBe('wallet');
    expect(await balanceOfWallet(w.id)).toBe(5_000);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId));
    expect(entries.every((e) => e.paymentAttemptId !== alipayId)).toBe(true);
    // The rest of the sale: nothing more on the wallet.
    const rest = await refundOf(saleId, { mode: 'whole', reason: 'The rest', actionId: newId() });
    expect(rest.statusCode, rest.body).toBe(200);
    expect((rest.json().refund.tenderAllocation as Slice[]).some((s) => s.route === 'wallet')).toBe(false);
    expect(await balanceOfWallet(w.id)).toBe(5_000);
    await assertLedgerTruth();
  });
});

// --- (4) LEDGER TRUTH UNDER SPEND: a child's prepaid wallet -------------------------------------

async function register(paidSatang: number) {
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
      guardianPhone: '0812345679',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{ checkinId, name: 'Mint', ageYears: 6, service: 'drop_off', allergies: null, foodRestrictions: null, foodProvision: { mode: 'prepaid_credit', paidSatang, creditSatang: paidSatang } }],
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  return { checkinId, registrationId };
}

async function checkedInWithPrepaid(paidSatang: number) {
  const { checkinId, registrationId } = await register(paidSatang);
  const saleId = newId();
  const committed = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: {
      id: saleId,
      stationId,
      lines: [{ id: checkinId, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 }, foodProvision: { mode: 'prepaid_credit', paidSatang } }],
    },
  });
  expect(committed.statusCode, committed.body).toBe(200);
  expect((await finalise(saleId, { method: 'cash', kind: 'cash', actionId: newId() })).statusCode).toBe(200);
  const now = await ctx.app.inject({ method: 'POST', url: '/checkin/check-in-now', headers: { cookie: reception }, payload: { saleId, entries: [{ checkinId, nannyId: null }] } });
  expect(now.statusCode, now.body).toBe(200);
  const held = await prepaidBalanceOf(ctx.db, operatorId, checkinId);
  expect(held?.balanceSatang).toBe(paidSatang);
  const [qr] = await ctx.db.select().from(walletKey).where(and(eq(walletKey.walletId, held!.walletId), eq(walletKey.kind, 'voucher_qr')));
  return { checkinId, registrationId, saleId, walletId: held!.walletId, key: qr!.value };
}

async function release(checkinId: string, registrationId: string) {
  const photoId = newId();
  const file = await ctx.app.inject({
    method: 'POST',
    url: '/files',
    headers: { cookie: reception },
    payload: { id: photoId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: registrationId, filename: 'pickup.jpg' },
  });
  expect(file.statusCode, file.body).toBe(200);
  return ctx.app.inject({
    method: 'POST',
    url: `/checkin/pickups/stays/${checkinId}/release`,
    headers: { cookie: reception },
    payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId },
  });
}

describe("(4) ledger truth under spend: a child's prepaid wallet", () => {
  it('spent at the counter, part-refunded, then released: the release refunds exactly what is left of THIS stay', async () => {
    const child = await checkedInWithPrepaid(15_000);
    const order = await fnbOrder();
    const spent = await finalise(order.saleId, { wallet: { key: child.key, useCredit: true }, actionId: newId() });
    expect(spent.statusCode, spent.body).toBe(200);
    expect(spent.json().walletSpend).toMatchObject({ amountSatang: 9_000, balanceAfterSatang: 6_000 });
    const back = await refundOf(order.saleId, { mode: 'custom', amountSatang: 4_000, reason: 'Half the fries', actionId: newId() });
    expect(back.statusCode, back.body).toBe(200);
    expect(await balanceOfWallet(child.walletId)).toBe(10_000);

    const out = await release(child.checkinId, child.registrationId);
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json().release.settlement).toMatchObject({ policy: 'refund', refundedSatang: 10_000 });
    expect(await balanceOfWallet(child.walletId)).toBe(0);
    // The check-in sale's refund never exceeds the food it charged.
    const refunds = await ctx.db.execute(sql`select coalesce(sum(amount_satang),0)::bigint as n from pos.refund where sale_id = ${child.saleId}`);
    expect(Number((refunds.rows[0] as { n: string }).n)).toBe(10_000);
    // Nothing left to spend after the child has gone.
    const after = await fnbOrder();
    const empty = await finalise(after.saleId, { wallet: { key: child.key, useCredit: true }, actionId: newId() });
    expect(empty.statusCode).toBe(409);
    expect(empty.json().error.code).toBe('WALLET_EMPTY');
    await assertLedgerTruth();
  });

  it('a release racing a counter spend on the same child wallet: spent + refunded == loaded, never negative', async () => {
    const child = await checkedInWithPrepaid(15_000);
    const order = await fnbOrder();
    const photoId = newId();
    const file = await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie: reception },
      payload: { id: photoId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: child.registrationId, filename: 'pickup.jpg' },
    });
    expect(file.statusCode, file.body).toBe(200);
    const [spend, rel] = await Promise.all([
      finalise(order.saleId, { wallet: { key: child.key, useCredit: true }, actionId: newId() }),
      ctx.app.inject({
        method: 'POST',
        url: `/checkin/pickups/stays/${child.checkinId}/release`,
        headers: { cookie: reception },
        payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId },
      }),
    ]);
    expect(rel.statusCode, rel.body).toBe(200);
    const spentSatang = spend.statusCode === 200 ? (spend.json().walletSpend.amountSatang as number) : 0;
    if (spend.statusCode !== 200) expect(spend.json().error.code).toBe('WALLET_EMPTY');
    const refunds = await ctx.db.execute(sql`select coalesce(sum(amount_satang),0)::bigint as n from pos.refund where sale_id = ${child.saleId}`);
    const refundedSatang = Number((refunds.rows[0] as { n: string }).n);
    expect(spentSatang + refundedSatang + (await balanceOfWallet(child.walletId))).toBe(15_000);
    expect(await balanceOfWallet(child.walletId)).toBe(0);
    await assertLedgerTruth();
  });
});
