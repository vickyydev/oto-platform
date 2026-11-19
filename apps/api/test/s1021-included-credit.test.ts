import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, branch, station, ticketPackage, wallet, walletEntry, walletKey } from '@oto/db';
import { newId } from '@oto/shared';
import { debitWallet, includedCreditActionId, prepaidBalanceOf } from '../src/services/wallet';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1021 — A SUPERVISED CHILD'S TICKET CREDIT GOES ON THEIR BAND (the
 * owner's answer of 19 November 2026: a dropped-off or nanny child on Eat &
 * Play gets the ticket's credit on their band, as a child playing with a
 * parent does, and the form shows it as included).
 *
 * Until now the grant law passed a supervised child's line by, so the family
 * paid for Eat & Play and the child's band held none of its ฿1,300. Pinned
 * here: the credit loads at "Check in now" onto the child's band, once, at
 * the grant law's figure; the sale's own grants are unchanged; and the
 * prepaid food beside it settles at pickup exactly as before.
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
           coalesce((select sum(e.amount_satang) from pos.wallet_entry e where e.wallet_id = w.id), 0)::bigint as total
    from pos.wallet w`);
  for (const r of rows as { id: string; balance: string; total: string }[]) {
    expect(Number(r.balance), `wallet ${r.id}`).toBe(Number(r.total));
  }
}

async function commit(payload: Record<string, unknown>): Promise<string> {
  const saleId = newId();
  const res = await ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie: reception }, payload: { id: saleId, stationId, ...payload } });
  expect(res.statusCode, res.body).toBe(200);
  return saleId;
}

async function finalise(saleId: string) {
  const res = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function checkInNow(saleId: string, checkinId: string) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie: reception },
    payload: { saleId, entries: [{ checkinId, nannyId: null }] },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** A ZZ TEST child registered for drop-off on `packageId`, paid on one sale. Not yet checked in. */
async function droppedOff(packageId: string, food: { mode: 'prepaid_credit'; paidSatang: number; creditSatang: number } | null) {
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
      guardianName: 'ZZ TEST Parent',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [
        { checkinId, name: 'ZZ TEST Mint', ageYears: 6, service: 'drop_off', allergies: null, foodRestrictions: null, foodProvision: food ?? { mode: 'none', paidSatang: 0 } },
      ],
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const saleId = await commit({
    lines: [
      {
        id: checkinId,
        packageId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
        ...(food ? { foodProvision: { mode: food.mode, paidSatang: food.paidSatang } } : {}),
      },
    ],
  });
  const fin = await finalise(saleId);
  return { checkinId, registrationId, saleId, fin };
}

async function includedEntries(checkinId: string) {
  return ctx.db.select().from(walletEntry).where(eq(walletEntry.actionId, includedCreditActionId(checkinId)));
}

describe('SCRUM-1021 — the ticket credit of a dropped-off child', () => {
  it('Eat & Play: nothing at the sale, ฿1,300 on the child’s band at check-in, and the sale’s grants are unchanged', async () => {
    const family = await droppedOff(eatPlayId, null);
    // The sale still grants nothing for a supervised line: the band is minted at check-in.
    expect(family.fin.grants).toEqual([]);
    expect(await includedEntries(family.checkinId)).toHaveLength(0);

    const done = await checkInNow(family.saleId, family.checkinId);
    const [entry] = await includedEntries(family.checkinId);
    expect(entry).toMatchObject({ kind: 'grant', source: 'ticket_sale', amountSatang: 130_000, saleId: family.saleId, branchId });
    expect(entry!.expiresAt).not.toBeNull();
    const keys = await ctx.db.select().from(walletKey).where(eq(walletKey.walletId, entry!.walletId));
    const [childBand] = await ctx.db.select().from(band).where(eq(band.id, done.bands[0].id));
    expect(keys.find((k) => k.kind === 'band')!.value).toBe(childBand!.code);
    const [w] = await ctx.db.select().from(wallet).where(eq(wallet.id, entry!.walletId));
    expect(w).toMatchObject({ balanceSatang: 130_000, holderName: 'ZZ TEST Mint' });

    // The sale's person grants do not take it in: it has no voucher of its own on the receipt.
    const detail = (await ctx.app.inject({ method: 'GET', url: `/sales/${family.saleId}`, headers: { cookie: reception } })).json();
    expect(detail.grants).toEqual([]);
    // The pickup screen's "You still have X baht remaining" reads the band.
    const context = (await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/stays/${family.checkinId}`, headers: { cookie: reception } })).json();
    expect(context).toMatchObject({ reconciliation: null, bandCreditSatang: 130_000 });
    await assertLedgerTruth();
  });

  it('is loaded once: a retried check-in and a replayed finalise add nothing', async () => {
    const family = await droppedOff(eatPlayId, null);
    await checkInNow(family.saleId, family.checkinId);
    await checkInNow(family.saleId, family.checkinId);
    const again = await finalise(family.saleId);
    expect(again.grants).toEqual([]);
    expect(await includedEntries(family.checkinId)).toHaveLength(1);
    const credit = await ctx.db.execute(
      sql`select coalesce(sum(amount_satang), 0)::int as n from pos.wallet_entry where sale_id = ${family.saleId} and kind = 'grant'`,
    );
    expect((credit.rows[0] as { n: number }).n).toBe(130_000);
    await assertLedgerTruth();
  });

  it('a ticket whose credit is for adults only puts nothing on a dropped-off child', async () => {
    const family = await droppedOff(twoHoursId, null);
    await checkInNow(family.saleId, family.checkinId);
    expect(await includedEntries(family.checkinId)).toHaveLength(0);
    // No wallet on the band: the pickup screen has no figure to show.
    const context = (await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/stays/${family.checkinId}`, headers: { cookie: reception } })).json();
    expect(context.bandCreditSatang).toBeNull();
  });

  it('with prepaid food beside it: one wallet on the band, and pickup hands back exactly what it did before', async () => {
    const family = await droppedOff(eatPlayId, { mode: 'prepaid_credit', paidSatang: 20_000, creditSatang: 20_000 });
    await checkInNow(family.saleId, family.checkinId);
    const held = await prepaidBalanceOf(ctx.db, operatorId, family.checkinId);
    const [included] = await includedEntries(family.checkinId);
    // The same wallet carries both: a band names one wallet.
    expect(included!.walletId).toBe(held!.walletId);
    expect(held).toMatchObject({ balanceSatang: 150_000, loadedSatang: 20_000, refundableSatang: 20_000 });

    // ฿50 spent at the counter: the prepaid food left to hand back is ฿150, as before this change.
    await ctx.db.transaction((tx) =>
      debitWallet(tx, { accountId: null, operatorId }, { walletId: held!.walletId, actionId: `zz-spend:${newId()}`, amountSatang: 5_000, source: 'fnb_order', branchId }),
    );
    const context = (await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/stays/${family.checkinId}`, headers: { cookie: reception } })).json();
    expect(context.reconciliation).toMatchObject({ mode: 'prepaid_credit', paidSatang: 20_000, totalUnusedSatang: 15_000 });
    // What the band can still spend: the prepaid food left and the ticket's credit.
    expect(context.bandCreditSatang).toBe(145_000);

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
    // The ticket's credit stays on the band for the rest of the park's day.
    const [after] = await ctx.db.select().from(wallet).where(eq(wallet.id, held!.walletId));
    expect(after!.balanceSatang).toBe(130_000);
    await assertLedgerTruth();
  });
});
