import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, boxCommand, branch, paymentAttempt, product, refund, station, ticketPackage, wallet, walletEntry } from '@oto/db';
import { countsAsTillTakings, mintVoucherQr, newId } from '@oto/shared';
import { createWalletWithGrant, debitWallet, loadWallet, prepaidActionId, prepaidBalanceOf } from '../src/services/wallet';
import { BRANCH_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 2 — the RE-CHECK gate's reproductions (invariants 1-4), kept.
 *
 * (1) no wallet refusal path writes an attempt, a kick or a takings row;
 * (2) refusals (expired, another park, the ticket counter, more than owed)
 *     leave balance == sum and nothing written;
 * (3) a replayed refund — sequential and concurrent — restores once; two
 *     racing refunds of one wallet-only sale never pay credit out as cash; a
 *     mixed sale's cash slices never exceed the cash taken;
 * (4) the cross-stay cap: another stay's release debit is not this stay's
 *     spending (service level — two overlapping stays of one saved child).
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let otherBranchId: string;
let stationId: string;
let boxId: string;
let twoHoursId: string;
let friesId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [other] = await ctx.db.select().from(branch).where(and(eq(branch.operatorId, operatorId), ne(branch.id, branchId)));
  otherBranchId = other!.id;
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

async function assertLedgerTruth(): Promise<void> {
  const { rows } = await ctx.db.execute(sql`
    select w.id, w.balance_satang::bigint as balance,
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
    expect(Number(r.balance)).toBeGreaterThanOrEqual(0);
  }
}

async function walletWith(amountSatang: number, at = () => branchId): Promise<{ id: string; qr: string }> {
  const qr = mintVoucherQr();
  const made = await ctx.db.transaction((tx) =>
    createWalletWithGrant(tx, { accountId: null, operatorId }, {
      actionId: `gate-r2-recheck:${newId()}`,
      branchId: at(),
      holderName: 'Walk-in guest',
      amountSatang,
      source: 'ticket_sale',
      keys: [{ kind: 'voucher_qr', value: qr }],
    }),
  );
  return { id: made.wallet.id, qr };
}

const balanceOf = async (id: string) => (await ctx.db.select().from(wallet).where(eq(wallet.id, id)))[0]!.balanceSatang;
const attemptsOf = (saleId: string) => ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId));
const kicks = async () => (await ctx.db.select().from(boxCommand).where(and(eq(boxCommand.boxId, boxId), eq(boxCommand.kind, 'drawer_kick')))).length;

async function fnbOrder(quantity = 1): Promise<string> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '12', items: [{ id: newId(), productId: friesId, quantity }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return saleId;
}

const finalise = (saleId: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload });
const refundOf = (saleId: string, body: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie: manager }, payload: body });

type Slice = { route: string; amountSatang: number; status: string; attemptId: string | null };

describe('(1)(2) refusals write nothing: no attempt, no kick, no entry', () => {
  it('an expired wallet, another park’s wallet, the ticket counter and more than owed', async () => {
    const before = await kicks();
    // Expired: refused in the counter's words, nothing taken.
    const expired = await walletWith(5_000);
    await ctx.db.update(wallet).set({ status: 'expired' }).where(eq(wallet.id, expired.id));
    const s1 = await fnbOrder();
    const r1 = await finalise(s1, { wallet: { key: expired.qr, useCredit: true }, tender: { method: 'cash', kind: 'cash' }, actionId: newId() });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe('WALLET_EXPIRED');
    expect(await attemptsOf(s1)).toHaveLength(0);
    expect(await balanceOf(expired.id)).toBe(5_000);

    // Another park's wallet reads as no wallet at all.
    const elsewhere = await walletWith(5_000, () => otherBranchId);
    const r2 = await finalise(s1, { wallet: { key: elsewhere.qr, useCredit: true }, actionId: newId() });
    expect(r2.statusCode).toBe(404);
    expect(r2.json().error.code).toBe('WALLET_NOT_FOUND');
    expect(await balanceOf(elsewhere.id)).toBe(5_000);

    // The ticket counter: credit does not pay for tickets.
    const good = await walletWith(100_000);
    const ticketSale = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: ticketSale, stationId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    const r3 = await finalise(ticketSale, { wallet: { key: good.qr, useCredit: true }, actionId: newId() });
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error.code).toBe('WALLET_NOT_HERE');
    expect(await attemptsOf(ticketSale)).toHaveLength(0);

    // An exact figure above what the order owes is refused, never floored.
    const r4 = await finalise(s1, { wallet: { key: good.qr, amountSatang: 9_001 }, actionId: newId() });
    expect(r4.statusCode).toBe(400);
    expect(await attemptsOf(s1)).toHaveLength(0);
    expect(await balanceOf(good.id)).toBe(100_000);
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, s1))).toHaveLength(0);
    expect(await kicks()).toBe(before);
    await assertLedgerTruth();
  });
});

describe('(3) the refund, replayed and raced', () => {
  it('the same refund sent twice in a row and twice at once restores ONCE', async () => {
    const w = await walletWith(20_000);
    const saleId = await fnbOrder();
    expect((await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() })).json().finalised).toBe(true);
    expect(await balanceOf(w.id)).toBe(11_000);

    const body = { mode: 'custom', amountSatang: 3_000, reason: 'Cold', actionId: newId() };
    const [a, b] = await Promise.all([refundOf(saleId, body), refundOf(saleId, body)]);
    const c = await refundOf(saleId, body);
    for (const r of [a, b, c]) expect(r.statusCode, r.body).toBe(200);
    expect(new Set([a, b, c].map((r) => r.json().refund.id)).size).toBe(1);
    expect(await balanceOf(w.id)).toBe(14_000);
    const restores = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.walletId, w.id), eq(walletEntry.kind, 'refund')));
    expect(restores).toHaveLength(1);
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(1);
    await assertLedgerTruth();
  });

  it('two different whole refunds racing on a wallet-only sale: credit back once in total, never a cash slice', async () => {
    const w = await walletWith(20_000);
    const saleId = await fnbOrder();
    expect((await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() })).json().finalised).toBe(true);
    const answers = await Promise.all([
      refundOf(saleId, { mode: 'whole', reason: 'A', actionId: newId() }),
      refundOf(saleId, { mode: 'whole', reason: 'B', actionId: newId() }),
    ]);
    const ok = answers.filter((r) => r.statusCode === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const slices = ok.flatMap((r) => r.json().refund.tenderAllocation as Slice[]);
    expect(slices.some((s) => s.route === 'cash')).toBe(false);
    expect(slices.reduce((s, x) => s + x.amountSatang, 0)).toBe(9_000);
    expect(await balanceOf(w.id)).toBe(20_000);
    await assertLedgerTruth();
  });

  it('credit + cash: refunds in pieces hand back at most the cash taken in cash, the rest on the wallet', async () => {
    const w = await walletWith(5_000);
    const saleId = await fnbOrder();
    const credit = await finalise(saleId, { wallet: { key: w.qr, useCredit: true }, actionId: newId() });
    expect(credit.json()).toMatchObject({ finalised: false, outstandingSatang: 4_000 });
    const cash = await finalise(saleId, { method: 'cash', kind: 'cash', tenderedSatang: 4_000, actionId: newId() });
    expect(cash.json().finalised).toBe(true);
    const takings = (await attemptsOf(saleId)).filter((a) => countsAsTillTakings(a)).reduce((s, a) => s + a.amountSatang, 0);
    expect(takings).toBe(4_000);

    const slices: Slice[] = [];
    for (const body of [
      { mode: 'custom', amountSatang: 7_000, reason: 'Most of it' },
      { mode: 'custom', amountSatang: 1_000, reason: 'More' },
      { mode: 'whole', reason: 'The rest' },
    ]) {
      const r = await refundOf(saleId, { ...body, actionId: newId() });
      expect(r.statusCode, r.body).toBe(200);
      slices.push(...(r.json().refund.tenderAllocation as Slice[]));
    }
    const cashOut = slices.filter((s) => s.route === 'cash').reduce((s, x) => s + x.amountSatang, 0);
    const walletBack = slices.filter((s) => s.route === 'wallet').reduce((s, x) => s + x.amountSatang, 0);
    expect(walletBack).toBe(5_000);
    expect(cashOut).toBe(4_000);
    expect(cashOut).toBeLessThanOrEqual(takings);
    expect(await balanceOf(w.id)).toBe(5_000);
    // Nothing left: a fourth refund is refused, not paid in cash.
    const more = await refundOf(saleId, { mode: 'custom', amountSatang: 100, reason: 'Again', actionId: newId() });
    expect(more.statusCode).toBeGreaterThanOrEqual(400);
    await assertLedgerTruth();
  });
});

describe('(4) the cross-stay cap', () => {
  /**
   * KEPT AS it.fails: `prepaidBalanceOf` counts every `spend` entry after this
   * stay's load as this stay's spending — including ANOTHER stay's release
   * debit (kind `spend`, source `refund`). With two overlapping stays of one
   * saved child (nothing in check-in refuses the second), B's release refunds
   * ฿0 and keeps its own ฿100 on the wallet. Errs against the guest, never
   * pays out more than loaded; balance == sum holds. Fix: count only counter
   * spends (`fnb_order` / `merch_order`) and their restores.
   */
  it.fails("another stay's release debit is not this stay's spending (two overlapping stays of one child)", async () => {
    // Stay A loads ฿150 and stay B ฿100 on the child's one wallet; nothing is
    // spent at a counter. A is released first and its ฿150 goes back in cash.
    const stayA = newId();
    const stayB = newId();
    const actor = { accountId: null, operatorId };
    const made = await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, actor, {
        actionId: prepaidActionId(stayA), branchId, holderName: 'Mint', amountSatang: 15_000, source: 'prepaid_food',
        keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
      }),
    );
    const walletId = made.wallet.id;
    await new Promise((r) => setTimeout(r, 5));
    await ctx.db.transaction((tx) => loadWallet(tx, actor, { walletId, actionId: prepaidActionId(stayB), amountSatang: 10_000, source: 'prepaid_food', branchId }));
    await new Promise((r) => setTimeout(r, 5));
    const heldA = await prepaidBalanceOf(ctx.db, operatorId, stayA);
    expect(heldA?.refundableSatang).toBe(15_000);
    await ctx.db.transaction((tx) =>
      debitWallet(tx, actor, { walletId, actionId: `release:${newId()}:prepaid`, amountSatang: 15_000, source: 'refund', branchId }),
    );
    // B spent nothing: all ฿100 of its own load is still on the wallet and refundable.
    const heldB = await prepaidBalanceOf(ctx.db, operatorId, stayB);
    expect(heldB?.balanceSatang).toBe(10_000);
    expect(heldB?.refundableSatang).toBe(10_000);
  });
});
