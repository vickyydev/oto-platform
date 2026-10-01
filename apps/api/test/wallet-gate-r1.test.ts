import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, booking, branch, checkin, refund, sale, saleLine, station, ticketPackage, wallet, walletEntry, walletKey } from '@oto/db';
import { mintVoucherQr, newId } from '@oto/shared';
import { quoteBooking } from '../src/services/booking-checkout';
import { createWalletWithGrant, debitWallet, loadWallet, prepaidBalanceOf } from '../src/services/wallet';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 1 — the GATE's reproductions (focused gate, invariants 1-7).
 *
 * Each block attacks one named invariant: the ledger is the truth (balance ==
 * sum of entries after crashes, replays and races), grants exactly once
 * (replayed finalise, idempotent route, a booking redeemed twice), atomicity
 * (a grant that cannot be written takes the close back; a printout that
 * cannot be queued leaves the grants standing), and the money a child's
 * prepaid wallet is loaded with.
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
let operatorId: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
let eatPlayId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
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
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total,
           (select count(*) from pos.wallet_entry e where e.wallet_id = w.id)::int as n
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string; n: number }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
    // No half wallet: every wallet carries at least its first entry.
    expect(r.n, `wallet ${r.id} has no entry`).toBeGreaterThan(0);
  }
  const orphans = await ctx.db.execute(sql`
    select count(*)::int as n from pos.wallet_key k where not exists (select 1 from pos.wallet_entry e where e.wallet_id = k.wallet_id)`);
  expect((orphans.rows[0] as { n: number }).n).toBe(0);
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

const finaliseReq = (saleId: string, headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception, ...headers }, payload: {} });

async function walletCount(): Promise<number> {
  const r = await ctx.db.execute(sql`select count(*)::int as n from pos.wallet`);
  return (r.rows[0] as { n: number }).n;
}

// --- (4) ATOMICITY ------------------------------------------------------------------

describe('atomicity: a grant that cannot be written', () => {
  it('takes the whole close back — no wallet, no key, no entry, sale still open — and a retry grants once', async () => {
    const saleId = await commit({ lines: [{ id: newId(), packageId: eatPlayId, kids: 1, adults: 1 }] });
    const before = await walletCount();
    await ctx.db.execute(sql.raw(`
      create or replace function pos.gate_fail_entry() returns trigger language plpgsql as $$
      begin raise exception 'gate: the entry cannot be written'; end $$;
      create trigger gate_fail_entry before insert on pos.wallet_entry for each row execute function pos.gate_fail_entry();`));
    try {
      const res = await finaliseReq(saleId);
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      await ctx.db.execute(sql.raw('drop trigger gate_fail_entry on pos.wallet_entry; drop function pos.gate_fail_entry();'));
    }
    expect(await walletCount()).toBe(before);
    const [open] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(open!.status).not.toBe('finalised');
    expect(open!.receiptNumber).toBeNull();
    await assertLedgerTruth();

    const ok = await finaliseReq(saleId);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().grants).toHaveLength(2);
    const again = await finaliseReq(saleId);
    expect(again.json().grants).toEqual(ok.json().grants);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId));
    expect(entries).toHaveLength(2);
    await assertLedgerTruth();
  });

  it('a printout that cannot be queued leaves the grants standing, and a later band reprint puts the wallet on its band', async () => {
    const saleId = await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] });
    await ctx.db.execute(sql.raw(`
      create or replace function edge.gate_fail_print() returns trigger language plpgsql as $$
      begin raise exception 'gate: the printer queue is down'; end $$;
      create trigger gate_fail_print before insert on edge.print_job for each row execute function edge.gate_fail_print();`));
    let done;
    try {
      const res = await finaliseReq(saleId);
      expect(res.statusCode, res.body).toBe(200);
      done = res.json();
    } finally {
      await ctx.db.execute(sql.raw('drop trigger gate_fail_print on edge.print_job; drop function edge.gate_fail_print();'));
    }
    expect(done.finalised).toBe(true);
    expect(done.grants).toHaveLength(1);
    const walletId = done.grants[0].walletId as string;
    // The printing savepoint took the bands with it; the credit is still owed and still there.
    const [w] = await ctx.db.select().from(wallet).where(eq(wallet.id, walletId));
    expect(w!.balanceSatang).toBe(done.grants[0].creditSatang);
    await assertLedgerTruth();

    const reprint = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/reprints`,
      headers: { cookie: reception },
      payload: { kind: 'adult_bands', stationId },
    });
    expect(reprint.statusCode, reprint.body).toBe(200);
    const [adultBand] = await ctx.db.select().from(band).where(and(eq(band.saleId, saleId), eq(band.kind, 'adult')));
    const keys = await ctx.db.select().from(walletKey).where(and(eq(walletKey.walletId, walletId), eq(walletKey.kind, 'band')));
    expect(keys.map((k) => k.value)).toEqual([adultBand!.code]);
    await assertLedgerTruth();
  });
});

// --- (3) GRANTS EXACTLY ONCE --------------------------------------------------------

describe('grants exactly once', () => {
  it('the idempotent finalise route re-sent under the same key answers identically and grants once', async () => {
    const saleId = await commit({ lines: [{ id: newId(), packageId: eatPlayId, kids: 2, adults: 1 }] });
    const key = `gate-fin-${newId()}`;
    const a = await finaliseReq(saleId, { 'idempotency-key': key });
    const b = await finaliseReq(saleId, { 'idempotency-key': key });
    expect(a.statusCode, a.body).toBe(200);
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json().grants).toEqual(a.json().grants);
    expect(a.json().grants).toHaveLength(3);
    const n = await ctx.db.execute(sql`select count(distinct wallet_id)::int as n, count(*)::int as e from pos.wallet_entry where sale_id = ${saleId}`);
    expect(n.rows[0]).toEqual({ n: 3, e: 3 });
    await assertLedgerTruth();
  });

  it('a booking redeemed twice earns once: the second press is refused and no second wallet set exists', async () => {
    const id = newId();
    const bookingDate = new Date().toISOString().slice(0, 10);
    const [br] = await ctx.db.select().from(branch).where(eq(branch.id, branchId));
    const quote = await quoteBooking(ctx.db, br!, { tier: 'tourist', visitDate: bookingDate, lines: [{ packageId: eatPlayId, kids: 1, adults: 1 }] });
    await ctx.db.insert(booking).values({
      id,
      operatorId,
      branchId,
      reference: `OTO-GTE-${id.slice(-4).toUpperCase()}`,
      bookingDate,
      status: 'paid',
      totalSatang: quote.totalSatang,
      pricingSnapshot: quote as never,
      payload: {
        tier: 'tourist',
        rateMode: quote.rateMode,
        parentName: 'Khun Ploy',
        phone: '+66812229902',
        contactChannel: 'whatsapp',
        locale: 'en',
        lines: quote.lines as unknown as Array<Record<string, unknown>>,
        clientSnapshot: null,
      },
    });
    const first = await ctx.app.inject({ method: 'POST', url: `/bookings/${id}/redeem`, headers: { cookie: reception }, payload: { stationId } });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().grants).toHaveLength(2);
    const second = await ctx.app.inject({ method: 'POST', url: `/bookings/${id}/redeem`, headers: { cookie: reception }, payload: { stationId } });
    expect(second.statusCode).toBe(409);
    const sales = await ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.bookingId, id));
    expect(sales).toHaveLength(1);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, sales[0]!.id));
    expect(entries).toHaveLength(2);
    await assertLedgerTruth();
  });
});

// --- (1) LEDGER TRUTH under racing writers --------------------------------------------

describe('ledger truth: loads and debits racing on one wallet', () => {
  it('twenty concurrent writers leave balance == sum(entries), refused debits write nothing', async () => {
    const actor = { accountId: null, operatorId };
    const made = await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, actor, {
        actionId: `gate-race-seed:${newId()}`,
        branchId,
        amountSatang: 3_000,
        source: 'prepaid_food',
        keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
      }),
    );
    const walletId = made.wallet.id;
    const writes = Array.from({ length: 20 }, (_, i) =>
      ctx.db
        .transaction((tx) =>
          i % 2 === 0
            ? loadWallet(tx, actor, { walletId, actionId: `gate-race-load:${walletId}:${i}`, amountSatang: 500, source: 'prepaid_food', branchId })
            : debitWallet(tx, actor, { walletId, actionId: `gate-race-debit:${walletId}:${i}`, amountSatang: 1_500, source: 'fnb_order', branchId }),
        )
        .then(() => 'ok' as const)
        .catch((err: { code?: string }) => err.code ?? 'error'),
    );
    const outcomes = await Promise.all(writes);
    expect(outcomes.every((o) => o === 'ok' || o === 'WALLET_INSUFFICIENT')).toBe(true);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.walletId, walletId));
    expect(entries).toHaveLength(1 + outcomes.filter((o) => o === 'ok').length);
    expect(entries.every((e) => e.balanceAfter >= 0)).toBe(true);
    await assertLedgerTruth();
  });
});

// --- A child's prepaid food: what the wallet is loaded with ------------------------------

async function register(food: { mode: 'prepaid_credit'; paidSatang: number; creditSatang?: number }) {
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
      children: [{ checkinId, name: 'Mint', ageYears: 6, service: 'drop_off', allergies: null, foodRestrictions: null, foodProvision: food }],
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  return { checkinId, registrationId };
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
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/checkin/pickups/stays/${checkinId}/release`,
    headers: { cookie: reception },
    payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

const checkInNow = (saleId: string, checkinId: string) =>
  ctx.app.inject({ method: 'POST', url: '/checkin/check-in-now', headers: { cookie: reception }, payload: { saleId, entries: [{ checkinId, nannyId: null }] } });

/** The state a refused check-in must leave: no load, no wallet for the stay, the child still registered. */
async function expectNothingLoaded(checkinId: string): Promise<void> {
  expect(await prepaidBalanceOf(ctx.db, operatorId, checkinId)).toBeNull();
  const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
  expect(stay!.status).toBe('registered');
  expect(stay!.bandId).toBeNull();
  await assertLedgerTruth();
}

describe("a child's prepaid wallet holds what the sale charged for it", () => {
  it('a registration claiming more credit than the sale charged is refused — nothing loads, nobody goes in', async () => {
    // The family is charged ฿200 of prepaid food on the sale; the registration row claims ฿10,000 of credit.
    const { checkinId } = await register({ mode: 'prepaid_credit', paidSatang: 20_000, creditSatang: 1_000_000 });
    const saleId = await commit({
      lines: [
        {
          id: checkinId,
          packageId: twoHoursId,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
          foodProvision: { mode: 'prepaid_credit', paidSatang: 20_000 },
        },
      ],
    });
    expect((await finaliseReq(saleId)).statusCode).toBe(200);
    const now = await checkInNow(saleId, checkinId);
    expect(now.statusCode, now.body).toBe(409);
    expect(now.json().error.code).toBe('PREPAID_FOOD_MISMATCH');
    expect(now.json().error.message).toContain('฿10,000');
    expect(now.json().error.message).toContain('฿200');
    await expectNothingLoaded(checkinId);
  });

  it('a sale that charged no prepaid food is refused too, whatever the registration says', async () => {
    const { checkinId } = await register({ mode: 'prepaid_credit', paidSatang: 20_000, creditSatang: 20_000 });
    // The drop-off line went through with its fee only — nothing was charged for food.
    const saleId = await commit({
      lines: [{ id: checkinId, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } }],
    });
    expect((await finaliseReq(saleId)).statusCode).toBe(200);
    const now = await checkInNow(saleId, checkinId);
    expect(now.statusCode, now.body).toBe(409);
    expect(now.json().error.code).toBe('PREPAID_FOOD_MISMATCH');
    expect(now.json().error.message).toContain('charged nothing');
    await expectNothingLoaded(checkinId);
  });

  it('a registration that agrees with the sale loads exactly the figure off the sale ledger, and the load names the line', async () => {
    const { checkinId } = await register({ mode: 'prepaid_credit', paidSatang: 15_000, creditSatang: 15_000 });
    const saleId = await commit({
      lines: [
        {
          id: checkinId,
          packageId: twoHoursId,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
          foodProvision: { mode: 'prepaid_credit', paidSatang: 15_000 },
        },
      ],
    });
    expect((await finaliseReq(saleId)).statusCode).toBe(200);
    const now = await checkInNow(saleId, checkinId);
    expect(now.statusCode, now.body).toBe(200);
    const held = await prepaidBalanceOf(ctx.db, operatorId, checkinId);
    expect(held?.balanceSatang).toBe(15_000);
    const [foodLine] = await ctx.db
      .select()
      .from(saleLine)
      .where(and(eq(saleLine.saleId, saleId), eq(saleLine.cartLineId, checkinId), eq(saleLine.kind, 'food_provision')));
    expect(foodLine!.grossSatang).toBe(15_000);
    const [load] = await ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, `checkin:${checkinId}:prepaid`));
    expect(load).toMatchObject({ kind: 'grant', source: 'prepaid_food', amountSatang: 15_000, saleId });
    expect((load!.payload as { saleLineId?: string }).saleLineId).toBe(foodLine!.id);
    await assertLedgerTruth();
  });

  it('a prepaid-credit child in the park with no wallet load (the box lane, or in the park at deploy) is still refunded the unused food at release', async () => {
    const { checkinId, registrationId } = await register({ mode: 'prepaid_credit', paidSatang: 20_000, creditSatang: 20_000 });
    const saleId = await commit({
      lines: [
        {
          id: checkinId,
          packageId: twoHoursId,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
          foodProvision: { mode: 'prepaid_credit', paidSatang: 20_000 },
        },
      ],
    });
    expect((await finaliseReq(saleId)).statusCode).toBe(200);
    // The state a box's offline check-in replay leaves (`sync-checkin.ts`, check_in_now):
    // in the park on the sale, no wallet loaded — exactly what a stay checked in before
    // S2-14a deployed looks like too.
    await ctx.db
      .update(checkin)
      .set({ status: 'in_park', checkedInAt: new Date(), saleId, offline: true, updatedAt: new Date() })
      .where(eq(checkin.id, checkinId));
    expect(await prepaidBalanceOf(ctx.db, operatorId, checkinId)).toBeNull();
    const out = await release(checkinId, registrationId);
    // Nothing on any band was spent; the ฿200 paid is unused and the branch policy refunds it.
    expect(out.release.settlement).toMatchObject({ policy: 'refund', unusedSatang: 20_000, refundedSatang: 20_000 });
    const [refunded] = await ctx.db.select().from(refund).where(eq(refund.saleId, saleId));
    expect(refunded?.amountSatang).toBe(20_000);
  });
});
