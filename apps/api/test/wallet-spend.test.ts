import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  box,
  boxCommand,
  branch,
  modifierGroup,
  modifierOption,
  paymentAttempt,
  product,
  refund,
  sale,
  station,
  ticketPackage,
  wallet,
  walletEntry,
} from '@oto/db';
import { WALLET_TENDER_CODE, countsAsTillTakings, mintVoucherQr, newId } from '@oto/shared';
import { classify } from '../src/services/refunds';
import { tenderMethodOf } from '../src/services/payments/attempt';
import { createWalletWithGrant, debitWallet, loadWallet, prepaidBalanceOf } from '../src/services/wallet';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 2 — SPEND AND REFUNDS (plan docs/progress/plans/wallet/PLAN.md
 * §2.3-2.4, §6), through the routes the F&B and shop counters call.
 *
 * The wallet is a tender the PLATFORM writes: the till sends the scanned key
 * with "use credit", and finalise writes a `wallet` / `wallet_credit` attempt
 * and its `spend` entry under the wallet's row lock. Two tills on the last
 * ฿50: one success, one honest zero. An exact figure above the balance is
 * refused, never floored. The drawer never opens for credit. A refund puts
 * credit back on the SAME wallet, capped and exactly once; the terminal's
 * Alipay "wallet" is never mistaken for stored value. The ledger sums to the
 * balance after every flow.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let boxId: string;
let twoHoursId: string;
const items = new Map<string, { id: string; groups: Map<string, { id: string; options: Map<string, string> }> }>();

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  boxId = till!.boxId!;
  // A registered box is one a drawer kick can be queued for — so "no kick" means something.
  await ctx.db.update(box).set({ registeredAt: new Date(), status: 'online' }).where(eq(box.id, boxId));
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;

  const rows = await ctx.db.select().from(product).where(and(eq(product.operatorId, operatorId), isNull(product.archivedAt)));
  const groups = await ctx.db.select().from(modifierGroup).where(eq(modifierGroup.operatorId, operatorId));
  const options = await ctx.db
    .select()
    .from(modifierOption)
    .where(inArray(modifierOption.modifierGroupId, groups.map((g) => g.id)));
  for (const row of rows) {
    if (!row.code) continue;
    items.set(row.code, {
      id: row.id,
      groups: new Map(
        groups
          .filter((g) => g.productId === row.id)
          .map((g) => [g.name, { id: g.id, options: new Map(options.filter((o) => o.modifierGroupId === g.id).map((o) => [o.name, o.id])) }]),
      ),
    });
  }
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers ----------------------------------------------------------------------

async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
  }
}

/** A wallet with this much credit on it, found by its voucher QR. */
async function walletWith(amountSatang: number): Promise<{ id: string; qr: string }> {
  const qr = mintVoucherQr();
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `test-grant:${newId()}`,
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
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '12', items: [{ id: newId(), productId: items.get('FB-FRIES')!.id, quantity }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().sale.totals.grossSatang as number };
}

/** Grip socks (M), ฿120, at the shop. */
async function shopOrder(): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'shop', items: [{ id: newId(), productId: items.get('MR-SOCKS')!.id, quantity: 1, variant: { variantId: 'm', variantLabel: 'M' } }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().sale.totals.grossSatang as number };
}

function finalise(saleId: string, payload: Record<string, unknown>, cookie = reception) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie }, payload });
}

async function attemptsOf(saleId: string) {
  return ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
}

async function drawerKicks(): Promise<number> {
  return (await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.boxId, boxId), eq(boxCommand.kind, 'drawer_kick')))).length;
}

// --- Spend --------------------------------------------------------------------------

describe('credit at the F&B counter is a tender the platform writes', () => {
  it('use credit covering the whole order: one wallet attempt, one spend entry, the sale closed, the drawer shut', async () => {
    const w = await walletWith(20_000);
    const { saleId, owed } = await fnbOrder();
    expect(owed).toBe(9_000);
    const kicks = await drawerKicks();
    const res = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.finalised).toBe(true);
    expect(body.walletSpend).toEqual({ walletId: w.id, amountSatang: 9_000, balanceAfterSatang: 11_000 });
    expect(body.walletAttempt).toMatchObject({ method: 'wallet', amountSatang: 9_000, status: 'approved' });
    expect(body).not.toHaveProperty('drawerKick');

    const attempts = await attemptsOf(saleId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ method: 'wallet', methodCode: WALLET_TENDER_CODE, amountSatang: 9_000, deviceId: null });
    expect(countsAsTillTakings(attempts[0]!)).toBe(false);

    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'spend',
      source: 'fnb_order',
      amountSatang: -9_000,
      balanceAfter: 11_000,
      paymentAttemptId: attempts[0]!.id,
      actionId: `attempt:${attempts[0]!.id}:spend`,
      stationId,
    });
    expect(await balanceOfWallet(w.id)).toBe(11_000);
    // Credit is not cash: no drawer for wallet + a ฿0 remainder.
    expect(await drawerKicks()).toBe(kicks);
    // Audited: the spend on the wallet, and the close on the sale naming it.
    const spendAudit = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, w.id), eq(auditLog.action, 'wallet.spend')));
    expect(spendAudit).toHaveLength(1);
    const [close] = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.finalise')));
    expect((close!.after as { wallet?: unknown }).wallet).toMatchObject({ walletId: w.id, amountSatang: 9_000 });
    await assertLedgerTruth();
  });

  it('credit short of the order: the remainder defaults to CASH in the same press, and only the cash opens the drawer', async () => {
    const w = await walletWith(5_000);
    const { saleId } = await fnbOrder();
    const kicks = await drawerKicks();
    const res = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, tender: { tenderedSatang: 5_000 }, actionId: newId() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().finalised).toBe(true);
    const attempts = (await attemptsOf(saleId)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(attempts.map((a) => [a.method, a.methodCode, a.amountSatang])).toEqual([
      ['wallet', WALLET_TENDER_CODE, 5_000],
      ['cash', 'cash', 4_000],
    ]);
    expect(attempts[1]).toMatchObject({ tenderedSatang: 5_000, changeSatang: 1_000 });
    expect(await balanceOfWallet(w.id)).toBe(0);
    expect(await drawerKicks()).toBe(kicks + 1);
    await assertLedgerTruth();
  });

  it('a wallet press with no tender leaves the remainder owed; the next press settles it', async () => {
    const w = await walletWith(5_000);
    const { saleId } = await fnbOrder();
    const first = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ finalised: false, outstandingSatang: 4_000 });
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(row!.status).not.toBe('finalised');
    const second = await finalise(saleId, { method: 'cash', kind: 'cash', actionId: newId() });
    expect(second.json().finalised).toBe(true);
    await assertLedgerTruth();
  });

  it('an exact amount above the balance is REFUSED, not floored, and writes nothing', async () => {
    const w = await walletWith(5_000);
    const { saleId } = await fnbOrder();
    const res = await finalise(saleId, { wallet: { key: w.qr, amountSatang: 6_000 }, actionId: newId() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'WALLET_INSUFFICIENT', message: 'This wallet has ฿50 left, not ฿60.' });
    expect(await attemptsOf(saleId)).toHaveLength(0);
    expect(await balanceOfWallet(w.id)).toBe(5_000);
    // An exact amount within the balance is taken as asked.
    const ok = await finalise(saleId, { wallet: { key: w.qr, amountSatang: 3_000 }, actionId: newId() });
    expect(ok.json()).toMatchObject({ outstandingSatang: 6_000, walletSpend: { amountSatang: 3_000, balanceAfterSatang: 2_000 } });
    await assertLedgerTruth();
  });

  it('two tills on the last ฿50 at once: one success, one honest zero — never a negative, never a double charge', async () => {
    const w = await walletWith(5_000);
    const a = await fnbOrder();
    const b = await fnbOrder();
    const [ra, rb] = await Promise.all([
      finalise(a.saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() }),
      finalise(b.saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() }),
    ]);
    const answers = [ra, rb].map((r) => ({ status: r.statusCode, body: r.json() }));
    const won = answers.filter((x) => x.status === 200);
    const lost = answers.filter((x) => x.status !== 200);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(won[0]!.body.walletSpend).toMatchObject({ amountSatang: 5_000, balanceAfterSatang: 0 });
    expect(lost[0]!.status).toBe(409);
    expect(lost[0]!.body.error).toMatchObject({ code: 'WALLET_EMPTY', message: 'This wallet has ฿0 left — take the order in cash or card.' });
    expect(await balanceOfWallet(w.id)).toBe(0);
    const spends = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'spend')));
    expect(spends).toHaveLength(1);
    const walletAttempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(and(inArray(paymentAttempt.saleId, [a.saleId, b.saleId]), eq(paymentAttempt.method, 'wallet')));
    expect(walletAttempts).toHaveLength(1);
    await assertLedgerTruth();
  });

  it('the same press retried spends once and answers as a replay', async () => {
    const w = await walletWith(20_000);
    const { saleId } = await fnbOrder(3);
    const actionId = newId();
    const first = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId });
    expect(first.json()).toMatchObject({ finalised: false, outstandingSatang: 7_000 });
    const again = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ replay: true, outstandingSatang: 7_000 });
    expect(again.json().walletAttempt.id).toBe(first.json().walletAttempt.id);
    expect(await balanceOfWallet(w.id)).toBe(0);
    expect(await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'spend')))).toHaveLength(1);
    await assertLedgerTruth();
  });

  it('the shop spends the SAME pool, filed as a merch order', async () => {
    const w = await walletWith(20_000);
    const food = await fnbOrder();
    expect((await finalise(food.saleId, { wallet: { key: w.qr, useCredit: true } })).statusCode).toBe(200);
    const shop = await shopOrder();
    const res = await finalise(shop.saleId, { wallet: { key: w.qr, useCredit: true } });
    expect(res.statusCode, res.body).toBe(200);
    // ฿110 left of ฿200 after the fries; the ฿120 socks take all of it and ฿10 stays owed.
    expect(res.json()).toMatchObject({ finalised: false, outstandingSatang: shop.owed - 11_000, walletSpend: { amountSatang: 11_000, balanceAfterSatang: 0 } });
    const sources = (await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'spend')))).map((e) => e.source).sort();
    expect(sources).toEqual(['fnb_order', 'merch_order']);
    await assertLedgerTruth();
  });

  it('refuses in the counter’s words: an unknown key, the ticket counter, credit picked off the grid', async () => {
    const { saleId } = await fnbOrder();
    const unknown = await finalise(saleId, { wallet: { key: 'QR-NOPE', useCredit: true } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('WALLET_NOT_FOUND');

    const manual = await finalise(saleId, { method: WALLET_TENDER_CODE, kind: 'other' });
    expect(manual.statusCode).toBe(400);
    expect(manual.json().error.message).toContain('scanning the band or voucher');
    expect(await attemptsOf(saleId)).toHaveLength(0);

    const w = await walletWith(20_000);
    const ticketSaleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: ticketSaleId, stationId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const atTickets = await finalise(ticketSaleId, { wallet: { key: w.qr, useCredit: true } });
    expect(atTickets.statusCode).toBe(409);
    expect(atTickets.json().error.code).toBe('WALLET_NOT_HERE');
    expect(await balanceOfWallet(w.id)).toBe(20_000);
  });

  it('tenderMethodOf files the platform-written credit and refuses it from anyone else', async () => {
    await expect(tenderMethodOf(ctx.db, operatorId, WALLET_TENDER_CODE, undefined, { platform: 'wallet' })).resolves.toBe('wallet');
    await expect(tenderMethodOf(ctx.db, operatorId, WALLET_TENDER_CODE, 'other')).rejects.toMatchObject({ statusCode: 400 });
    await expect(tenderMethodOf(ctx.db, operatorId, 'cash', 'cash')).resolves.toBe('cash');
  });
});

// --- Refunds -------------------------------------------------------------------------

describe('a refund puts credit back where credit paid', () => {
  async function paidWithCreditAndCash() {
    const w = await walletWith(5_000);
    const { saleId } = await fnbOrder();
    const res = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, tender: { method: 'cash', kind: 'cash' }, actionId: newId() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().finalised).toBe(true);
    expect(await balanceOfWallet(w.id)).toBe(0);
    const creditAttempt = (await attemptsOf(saleId)).find((a) => a.method === 'wallet')!;
    return { w, saleId, creditAttempt };
  }

  function refundOf(saleId: string, body: Record<string, unknown>) {
    return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie: manager }, payload: body });
  }

  it('a whole refund: the wallet slice credits the SAME wallet now; only the cash part is cash', async () => {
    const { w, saleId, creditAttempt } = await paidWithCreditAndCash();
    const actionId = newId();
    const res = await refundOf(saleId, { mode: 'whole', reason: 'Wrong order', actionId });
    expect(res.statusCode, res.body).toBe(200);
    const slices = res.json().refund.tenderAllocation as { route: string; amountSatang: number; status: string; attemptId: string | null }[];
    expect(slices.map((s) => [s.route, s.amountSatang, s.status])).toEqual([
      ['wallet', 5_000, 'done'],
      ['cash', 4_000, 'done'],
    ]);
    expect(res.json().refund.pending).toBe(false);
    expect(await balanceOfWallet(w.id)).toBe(5_000);
    const refundId = res.json().refund.id as string;
    const [restore] = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'refund')));
    expect(restore).toMatchObject({
      source: 'refund',
      amountSatang: 5_000,
      balanceAfter: 5_000,
      refundId,
      paymentAttemptId: creditAttempt.id,
      actionId: `refund:${refundId}:attempt:${creditAttempt.id}`,
    });

    // Replayed: the refund it recorded, and no second restore.
    const again = await refundOf(saleId, { mode: 'whole', reason: 'Wrong order', actionId });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().replay).toBe(true);
    expect(await balanceOfWallet(w.id)).toBe(5_000);
    expect(await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'refund')))).toHaveLength(1);
    const audits = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, w.id), eq(auditLog.action, 'wallet.refund')));
    expect(audits).toHaveLength(1);
    await assertLedgerTruth();
  });

  it('partial refunds restore credit capped at what was used, exactly once across them', async () => {
    const { w, saleId } = await paidWithCreditAndCash();
    const first = await refundOf(saleId, { mode: 'custom', amountSatang: 3_000, reason: 'Cold fries', actionId: newId() });
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json().refund.tenderAllocation as { route: string; amountSatang: number }[]).map((s) => [s.route, s.amountSatang])).toEqual([['wallet', 3_000]]);
    expect(await balanceOfWallet(w.id)).toBe(3_000);
    const second = await refundOf(saleId, { mode: 'custom', amountSatang: 4_000, reason: 'Still cold', actionId: newId() });
    expect(second.statusCode, second.body).toBe(200);
    expect((second.json().refund.tenderAllocation as { route: string; amountSatang: number }[]).map((s) => [s.route, s.amountSatang])).toEqual([
      ['wallet', 2_000],
      ['cash', 2_000],
    ]);
    // ฿50 of credit used, ฿50 restored — never more.
    expect(await balanceOfWallet(w.id)).toBe(5_000);
    const third = await refundOf(saleId, { mode: 'whole', reason: 'All of it', actionId: newId() });
    expect((third.json().refund.tenderAllocation as { route: string }[]).every((s) => s.route === 'cash')).toBe(true);
    expect(await balanceOfWallet(w.id)).toBe(5_000);
    const [row] = await ctx.db.select().from(refund).where(eq(refund.saleId, saleId)).limit(1);
    expect(row).toBeTruthy();
    await assertLedgerTruth();
  });

  it('the terminal’s Alipay "wallet" and stored value side by side: only stored value is the wallet channel', () => {
    const terminalEwallet = { method: 'qr' as const, methodCode: 'promptpay', deviceId: newId(), invoiceNo: null, provider: 'ghl' as const };
    const storedValue = { method: 'wallet' as const, methodCode: WALLET_TENDER_CODE, deviceId: null, invoiceNo: null, provider: 'manual' as const };
    expect(classify(terminalEwallet)).toBe('terminal');
    expect(classify(storedValue)).toBe('wallet');
    // A wallet-method row that is not the platform's credit is never put on a wallet.
    expect(classify({ ...storedValue, methodCode: 'alipay' })).toBe('manual');
    expect(countsAsTillTakings(terminalEwallet)).toBe(true);
    expect(countsAsTillTakings(storedValue)).toBe(false);
  });
});

// --- Round 1 carryovers ----------------------------------------------------------------

describe('round 1 carryovers', () => {
  it('debitWallet’s replay names the wallet it debited', async () => {
    const a = await walletWith(5_000);
    const b = await walletWith(5_000);
    const actionId = `carry:${newId()}`;
    const actor = { accountId: null, operatorId };
    await ctx.db.transaction((tx) => debitWallet(tx, actor, { walletId: a.id, actionId, amountSatang: 1_000, source: 'refund', branchId }));
    const replay = await ctx.db.transaction((tx) => debitWallet(tx, actor, { walletId: a.id, actionId, amountSatang: 1_000, source: 'refund', branchId }));
    expect(replay.replayed).toBe(true);
    const other = await ctx.db
      .transaction((tx) => debitWallet(tx, actor, { walletId: b.id, actionId, amountSatang: 1_000, source: 'refund', branchId }))
      .catch((err: { code?: string }) => err);
    expect(other).toMatchObject({ code: 'ACTION_ID_REUSED' });
    expect(await balanceOfWallet(b.id)).toBe(5_000);
  });

  it('a stay’s release refund is capped at its own load less its own spends; an earlier stay’s leftover stays on the wallet', async () => {
    const earlierStay = newId();
    const thisStay = newId();
    const actor = { accountId: null, operatorId };
    // The child's wallet: ฿100 left from an earlier stay, then ฿200 loaded for this one, ฿50 spent.
    const made = await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, actor, {
        actionId: `checkin:${earlierStay}:prepaid`,
        branchId,
        amountSatang: 10_000,
        source: 'prepaid_food',
        keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
        now: new Date(Date.now() - 60_000),
      }),
    );
    await ctx.db.transaction((tx) =>
      loadWallet(tx, actor, { walletId: made.wallet.id, actionId: `checkin:${thisStay}:prepaid`, amountSatang: 20_000, source: 'prepaid_food', branchId, now: new Date(Date.now() - 30_000) }),
    );
    await ctx.db.transaction((tx) =>
      debitWallet(tx, actor, { walletId: made.wallet.id, actionId: `spend:${newId()}`, amountSatang: 5_000, source: 'fnb_order', branchId }),
    );
    const held = await ctx.db.transaction((tx) => prepaidBalanceOf(tx, operatorId, thisStay, { lock: true }));
    expect(held).toMatchObject({ balanceSatang: 25_000, loadedSatang: 20_000, spentSatang: 5_000, refundableSatang: 15_000 });
    await assertLedgerTruth();
  });
});
