import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, saleLine, station, ticketPackage, walletEntry } from '@oto/db';
import { mintVoucherQr, newId } from '@oto/shared';
import { createWalletWithGrant } from '../src/services/wallet';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-14a round 1 — the RE-CHECK gate's reproductions (invariants 1-3, 7).
 *
 * The grant law driven through the real ledger to the satang against the
 * prototype's `lib/sale.ts:146-264` (free adults, fixed, percent, list price
 * under a discount), grants exactly once under concurrent closes of one sale,
 * one prepaid load under concurrent check-in presses, and no negative entry
 * anywhere but the release's refund.
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
    expect(r.n, `wallet ${r.id} has no entry`).toBeGreaterThan(0);
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

const finaliseReq = (saleId: string) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });

async function ledgerUnits(saleId: string): Promise<{ kid: number; adult: number }> {
  const rows = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
  return {
    kid: rows.find((r) => r.kind === 'kids')?.unitSatang ?? 0,
    adult: rows.find((r) => r.kind === 'adults_paid')?.unitSatang ?? 0,
  };
}

type Grant = { role: string; personIndex: number; creditSatang: number };
const shape = (grants: Grant[]) => grants.map((g) => [g.personIndex, g.role, g.creditSatang]);

async function setTwoHours(rule: unknown): Promise<void> {
  // Tourist: the first adult free, overflow at the flat admission (the Thai Full Day rule, on the tourist tier).
  await ctx.db
    .update(ticketPackage)
    .set({
      creditRule: rule as never,
      adultRules: {
        tourist: { kind: 'free_adults', freeAdults: 1, overflow: 'set_price', price: { weekday: 35_000, weekend: 50_000 } },
        expat: { kind: 'set_price', price: { weekday: 35_000, weekend: 50_000 } },
        thai: { kind: 'set_price', price: { weekday: 35_000, weekend: 50_000 } },
      } as never,
    })
    .where(eq(ticketPackage.id, twoHoursId));
}

// --- (2) THE GRANT LAW through the ledger, to the satang ------------------------------

describe('grant law vs the prototype (lib/sale.ts:146-264), read off the frozen ledger', () => {
  it('free_adults + adults/full_price: paid adults earn the list unit, the free adult nothing; adults ordered first', async () => {
    await setTwoHours({ appliesTo: 'adults', basis: 'full_price' });
    const saleId = await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 3 }] });
    const res = await finaliseReq(saleId);
    expect(res.statusCode, res.body).toBe(200);
    const { adult } = await ledgerUnits(saleId);
    expect([35_000, 50_000]).toContain(adult);
    expect(shape(res.json().grants)).toEqual([
      [0, 'adult', adult],
      [1, 'adult', adult],
    ]);
    await assertLedgerTruth();
  });

  it('fixed ฿150 for both: every person earns ฿150 — the free adult too — in person order', async () => {
    await setTwoHours({ appliesTo: 'both', basis: 'fixed', value: 150 });
    const saleId = await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 2, adults: 2 }] });
    const res = await finaliseReq(saleId);
    expect(res.statusCode, res.body).toBe(200);
    expect(shape(res.json().grants)).toEqual([
      [0, 'adult', 15_000],
      [1, 'adult', 15_000],
      [2, 'kid', 15_000],
      [3, 'kid', 15_000],
    ]);
    await assertLedgerTruth();
  });

  it('percent 10 for both: 10% of each list unit; the free adult (list 0) earns nothing and has no wallet', async () => {
    await setTwoHours({ appliesTo: 'both', basis: 'percent', value: 10 });
    const saleId = await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 2 }] });
    const res = await finaliseReq(saleId);
    expect(res.statusCode, res.body).toBe(200);
    const { kid, adult } = await ledgerUnits(saleId);
    // Adults: [paid, free] → only the paid one earns. Then the kid. `personIndex`
    // counts EARNING persons (the prototype's positional grant order).
    expect(shape(res.json().grants)).toEqual([
      [0, 'adult', Math.round(adult * 0.1)],
      [1, 'kid', Math.round(kid * 0.1)],
    ]);
    await assertLedgerTruth();
  });

  it('a discounted sale earns from the LIST price (OD-W2), not the price after the discount', async () => {
    const saleId = await commit({
      lines: [{ id: newId(), packageId: eatPlayId, kids: 1, adults: 1 }],
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'fixed', value: 50_000, reason: 'Loyalty' }],
    });
    const res = await finaliseReq(saleId);
    expect(res.statusCode, res.body).toBe(200);
    expect(shape(res.json().grants)).toEqual([
      [0, 'adult', 35_000],
      [1, 'kid', 130_000],
    ]);
    await assertLedgerTruth();
  });
});

// --- (3) GRANTS EXACTLY ONCE under concurrent closes ------------------------------------

describe('grants exactly once: five concurrent finalise presses of one sale', () => {
  it('make one grant set, and every answer carries the same wallets', async () => {
    const saleId = await commit({ lines: [{ id: newId(), packageId: eatPlayId, kids: 2, adults: 1 }] });
    const answers = await Promise.all(Array.from({ length: 5 }, () => finaliseReq(saleId)));
    for (const a of answers) expect(a.statusCode, a.body).toBe(200);
    const sets = answers.map((a) => JSON.stringify((a.json().grants as { walletId: string }[]).map((g) => g.walletId)));
    expect(new Set(sets).size).toBe(1);
    const entries = await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId));
    expect(entries).toHaveLength(3);
    expect(new Set(entries.map((e) => e.walletId)).size).toBe(3);
    await assertLedgerTruth();
  });

  it('five concurrent createWalletWithGrant with one action key make one wallet with one entry', async () => {
    const actionId = `gate-recheck:${newId()}`;
    const actor = { accountId: null, operatorId };
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ctx.db.transaction((tx) =>
          createWalletWithGrant(tx, actor, {
            actionId,
            branchId,
            amountSatang: 12_345,
            source: 'ticket_sale',
            keys: [{ kind: 'voucher_qr', value: mintVoucherQr() }],
          }),
        ),
      ),
    );
    expect(new Set(results.map((r) => r.wallet.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const n = await ctx.db.execute(sql`select count(*)::int as n from pos.wallet_entry where action_id = ${actionId}`);
    expect((n.rows[0] as { n: number }).n).toBe(1);
    // The losers' fresh QRs were never attached: one key on the one wallet.
    const keys = await ctx.db.execute(sql`select count(*)::int as n from pos.wallet_key where wallet_id = ${results[0]!.wallet.id}`);
    expect((keys.rows[0] as { n: number }).n).toBe(1);
    await assertLedgerTruth();
  });
});

// --- (1)+(3) one prepaid load under concurrent check-in presses ---------------------------

describe("a child's prepaid load under three concurrent check-in-now presses", () => {
  it('loads once, and the ledger sums to the balance', async () => {
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
        children: [
          {
            checkinId,
            name: 'Mint',
            ageYears: 6,
            service: 'drop_off',
            allergies: null,
            foodRestrictions: null,
            foodProvision: { mode: 'prepaid_credit', paidSatang: 15_000, creditSatang: 15_000 },
          },
        ],
      },
    });
    expect(reg.statusCode, reg.body).toBe(200);
    const saleId = await commit({
      lines: [
        {
          id: checkinId,
          packageId: eatPlayId,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
          foodProvision: { mode: 'prepaid_credit', paidSatang: 15_000 },
        },
      ],
    });
    const fin = await finaliseReq(saleId);
    expect(fin.statusCode, fin.body).toBe(200);
    // The drop-off child's Eat & Play line is skipped by the grant law (their food is their own wallet).
    expect(fin.json().grants).toEqual([]);
    const presses = await Promise.all(
      Array.from({ length: 3 }, () =>
        ctx.app.inject({
          method: 'POST',
          url: '/checkin/check-in-now',
          headers: { cookie: reception },
          payload: { saleId, entries: [{ checkinId, nannyId: null }] },
        }),
      ),
    );
    expect(presses.some((p) => p.statusCode === 200)).toBe(true);
    const loads = await ctx.db.execute(
      sql`select count(*)::int as n, coalesce(sum(amount_satang), 0)::int as total from pos.wallet_entry where action_id = ${`checkin:${checkinId}:prepaid`}`,
    );
    expect(loads.rows[0]).toEqual({ n: 1, total: 15_000 });
    await assertLedgerTruth();
  });
});

// --- (7) NO NEW SPEND PATH ------------------------------------------------------------------

describe('no negative entry this round except a release refund', () => {
  it('after every flow above, every negative entry is a refund-sourced debit naming its refund', async () => {
    const { rows } = await ctx.db.execute(
      sql`select count(*)::int as n from pos.wallet_entry where amount_satang < 0 and not (source = 'refund' and refund_id is not null)`,
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});
