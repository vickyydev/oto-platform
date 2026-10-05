import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  band,
  branch,
  checkin,
  fileObject,
  paymentAttempt,
  product,
  refund,
  sale,
  saleLine,
  station,
  ticketPackage,
} from '@oto/db';
import { newId, salePrepDocument, bandShortCode } from '@oto/shared';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-494 (food) — the band at the F&B counter, driven through the routes
 * the stations call:
 *
 *   - `GET /wallets/scan` resolves a scanned band to its child's in-park stay
 *     and answers the allergy alert, the restriction, the food consent and the
 *     prepaid items, with the wallet or alone;
 *   - an F&B order names the band holder; its prepaid lines are ฿0 ledger
 *     lines served from the stay when the order is confirmed (the design's
 *     `redeemPrepaidItem`), idempotent, audited and never past what was paid;
 *   - a prepaid-only order closes through the no-tender path;
 *   - the release reads the served counts, so only what was not served is
 *     refunded;
 *   - the prep ticket prints the band holder's own allergy line, not a sibling's.
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
let cookie: string;
let receptionId: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
const menu = new Map<string, { id: string; name: string; priceSatang: number }>();

type Provision = {
  mode: 'none' | 'prepaid_credit' | 'prepaid_items';
  paidSatang: number;
  creditSatang?: number;
  items?: { menuItemId: string; menuItemName: string; unitSatang: number; qty: number; redeemedQty: number }[];
};

interface ChildSpec {
  name: string;
  allergies?: string | null;
  foodRestrictions?: string | null;
  food?: Provision;
}

interface Stay {
  checkinId: string;
  bandCode: string;
}

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  const rows = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, hkt!.operatorId), isNull(product.archivedAt)));
  for (const row of rows) if (row.code) menu.set(row.code, { id: row.id, name: row.name, priceSatang: row.priceSatang });
  const [acc] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionId = acc!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

const item = (code: string) => menu.get(code)!;

const entitlement = (code: string, qty: number) => ({
  menuItemId: item(code).id,
  menuItemName: item(code).name,
  unitSatang: item(code).priceSatang,
  qty,
  redeemedQty: 0,
});

/** One family left with the park: registered, paid for, checked in now — each child banded. */
async function familyInPark(children: ChildSpec[]): Promise<Stay[]> {
  const ids = children.map(() => newId());
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie },
    payload: {
      id: newId(),
      branchId,
      stationId,
      guardianName: 'Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: children.map((c, i) => ({
        checkinId: ids[i],
        name: c.name,
        ageYears: 6,
        service: 'drop_off',
        allergies: c.allergies ?? null,
        foodRestrictions: c.foodRestrictions ?? null,
        foodProvision: c.food ?? { mode: 'none', paidSatang: 0 },
      })),
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      id: saleId,
      stationId,
      lines: children.map((c, i) => ({
        id: ids[i],
        packageId: twoHoursId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
        foodProvision: !c.food || c.food.mode === 'none' ? null : { mode: c.food.mode, paidSatang: c.food.paidSatang },
      })),
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie }, payload: {} });
  expect(fin.statusCode, fin.body).toBe(200);
  const now = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie },
    payload: { saleId, entries: ids.map((checkinId) => ({ checkinId, nannyId: null })) },
  });
  expect(now.statusCode, now.body).toBe(200);
  const out: Stay[] = [];
  for (const checkinId of ids) {
    const [row] = await ctx.db
      .select({ code: band.code })
      .from(checkin)
      .innerJoin(band, eq(band.id, checkin.bandId))
      .where(eq(checkin.id, checkinId));
    expect(row?.code).toBeTruthy();
    out.push({ checkinId, bandCode: row!.code });
  }
  return out;
}

async function scan(key: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/wallets/scan?key=${encodeURIComponent(key)}&branchId=${branchId}`,
    headers: { cookie },
  });
}

async function order(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie, 'idempotency-key': newId() },
    payload: { stationId, channel: 'fnb', pickupCode: '42', ...payload },
  });
}

async function finalise(saleId: string, payload: Record<string, unknown> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie, 'idempotency-key': newId() },
    payload,
  });
}

async function itemsOf(checkinId: string) {
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
  return row!.foodProvision?.items ?? [];
}

async function redeemAudits(checkinId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'checkin.prepaid_redeem'), eq(auditLog.entityId, checkinId)));
}

describe('s494 — the counter scan resolves a band to its child in the park', () => {
  it('answers the allergy alert, the restriction, the consent and the prepaid items — alone when there is no wallet', async () => {
    const food: Provision = {
      mode: 'prepaid_items',
      paidSatang: item('FB-HOTDOG').priceSatang,
      items: [entitlement('FB-HOTDOG', 1)],
    };
    const [kai] = await familyInPark([{ name: 'Kai', allergies: 'Peanuts', foodRestrictions: 'No nuts', food }]);
    const res = await scan(kai!.bandCode);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.wallet).toBeNull();
    expect(body.stay).toMatchObject({
      checkinId: kai!.checkinId,
      childName: 'Kai',
      allergiesMedical: 'Peanuts',
      foodRestrictions: 'No nuts',
      mayOrderFood: true,
      foodProvision: { mode: 'prepaid_items', items: [{ menuItemId: item('FB-HOTDOG').id, qty: 1, redeemedQty: 0 }] },
    });
    expect((await scan('T9-ZZZZZZ')).statusCode).toBe(404);
  });

  it('a child whose parent authorised no food reads mayOrderFood false', async () => {
    const [tyler] = await familyInPark([{ name: 'Tyler' }]);
    const body = (await scan(tyler!.bandCode)).json();
    expect(body.stay).toMatchObject({ childName: 'Tyler', mayOrderFood: false, allergiesMedical: null });
  });
});

describe('s494 — prepaid meal entitlements are served on the platform', () => {
  it('a mixed order: the prepaid line is a ฿0 ledger line, served when confirmed, once, audited', async () => {
    const food: Provision = {
      mode: 'prepaid_items',
      paidSatang: item('FB-HOTDOG').priceSatang + 2 * item('FB-WATER').priceSatang,
      items: [entitlement('FB-HOTDOG', 1), entitlement('FB-WATER', 2)],
    };
    const [mia] = await familyInPark([{ name: 'Mia', food }]);
    const saleId = newId();
    const prepaidLine = newId();
    const paidLine = newId();
    const res = await order({
      id: saleId,
      bandHolder: { checkinId: mia!.checkinId },
      items: [
        { id: prepaidLine, productId: item('FB-HOTDOG').id, quantity: 1, prepaid: { checkinId: mia!.checkinId }, lineTotalSatang: 0 },
        { id: paidLine, productId: item('FB-JUICE').id, quantity: 1 },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().sale.totals.grossSatang).toBe(item('FB-JUICE').priceSatang);
    const lines = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const served = lines.find((l) => l.cartLineId === prepaidLine)!;
    expect(served).toMatchObject({ kind: 'fnb_item', grossSatang: 0, unitSatang: 0, quantity: 1 });
    expect(served.payload).toMatchObject({ prepaid: { checkinId: mia!.checkinId, menuItemId: item('FB-HOTDOG').id }, holder: { checkinId: mia!.checkinId } });
    const history = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json().correctionBandShortCode).toBe(bandShortCode(mia!.bandCode));
    expect(history.json().lines.find((line: { cartLineId: string }) => line.cartLineId === prepaidLine))
      .toMatchObject({ prepaid: { checkinId: mia!.checkinId, menuItemId: item('FB-HOTDOG').id }, holderCheckinId: mia!.checkinId });
    expect(history.body.includes(mia!.bandCode)).toBe(false);
    // Not served before the order is confirmed.
    expect((await itemsOf(mia!.checkinId)).map((i) => i.redeemedQty)).toEqual([0, 0]);

    const fin = await finalise(saleId, { method: 'cash' });
    expect(fin.statusCode, fin.body).toBe(200);
    expect(fin.json().finalised).toBe(true);
    expect((await itemsOf(mia!.checkinId)).map((i) => i.redeemedQty)).toEqual([1, 0]);
    const audits = await redeemAudits(mia!.checkinId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ saleId, shortfall: false, redeemed: [{ menuItemId: item('FB-HOTDOG').id, qty: 1, applied: 1 }] });
    expect(audits[0]!.actorAccountId).toBe(receptionId);

    // A retried confirm is the same close: nothing is served twice.
    const again = await finalise(saleId, { method: 'cash' });
    expect(again.statusCode, again.body).toBe(200);
    expect((await itemsOf(mia!.checkinId)).map((i) => i.redeemedQty)).toEqual([1, 0]);
    expect(await redeemAudits(mia!.checkinId)).toHaveLength(1);

    // The served item is used up: a second one is refused in the counter's words.
    const more = await order({
      id: newId(),
      bandHolder: { checkinId: mia!.checkinId },
      items: [{ id: newId(), productId: item('FB-HOTDOG').id, quantity: 1, prepaid: { checkinId: mia!.checkinId }, lineTotalSatang: 0 }],
    });
    expect(more.statusCode).toBe(409);
    expect(more.json().error.code).toBe('PREPAID_USED_UP');
    expect(more.json().error.message).toBe("Mia's prepaid Hot Dog has already been served.");
  });

  it('a prepaid-only order closes through the no-tender path, at the confirm and at the ฿0 commit', async () => {
    const food: Provision = {
      mode: 'prepaid_items',
      paidSatang: 3 * item('FB-WATER').priceSatang,
      items: [entitlement('FB-WATER', 3)],
    };
    const [noa] = await familyInPark([{ name: 'Noa', food }]);
    const saleId = newId();
    const res = await order({
      id: saleId,
      bandHolder: { checkinId: noa!.checkinId },
      items: [{ id: newId(), productId: item('FB-WATER').id, quantity: 1, prepaid: { checkinId: noa!.checkinId }, lineTotalSatang: 0 }],
      expectedTotalSatang: 0,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().sale.totals.grossSatang).toBe(0);
    const fin = await finalise(saleId);
    expect(fin.statusCode, fin.body).toBe(200);
    expect(fin.json()).toMatchObject({ finalised: true, attempt: null });
    expect(await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, saleId))).toHaveLength(0);
    expect((await itemsOf(noa!.checkinId))[0]!.redeemedQty).toBe(1);

    // The ฿0 commit that closes at once (`finalise: true`) serves too.
    const closed = await order({
      id: newId(),
      finalise: true,
      bandHolder: { checkinId: noa!.checkinId },
      items: [{ id: newId(), productId: item('FB-WATER').id, quantity: 2, prepaid: { checkinId: noa!.checkinId }, lineTotalSatang: 0 }],
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().finalised).toBe(true);
    expect((await itemsOf(noa!.checkinId))[0]!.redeemedQty).toBe(3);
  });

  it('refuses a prepaid line that is not the child’s, one with no band, and one with options', async () => {
    const food: Provision = { mode: 'prepaid_items', paidSatang: item('FB-WATER').priceSatang, items: [entitlement('FB-WATER', 1)] };
    const [lee] = await familyInPark([{ name: 'Lee', food }]);
    const notHis = await order({
      bandHolder: { checkinId: lee!.checkinId },
      items: [{ id: newId(), productId: item('FB-HOTDOG').id, quantity: 1, prepaid: { checkinId: lee!.checkinId }, lineTotalSatang: 0 }],
    });
    expect(notHis.statusCode).toBe(409);
    expect(notHis.json().error).toMatchObject({ code: 'PREPAID_NOT_ENTITLED', message: "Hot Dog is not one of Lee's prepaid items." });
    const noBand = await order({
      items: [{ id: newId(), productId: item('FB-WATER').id, quantity: 1, prepaid: { checkinId: lee!.checkinId }, lineTotalSatang: 0 }],
    });
    expect(noBand.statusCode).toBe(409);
    expect(noBand.json().error.code).toBe('PREPAID_NEEDS_BAND');
    const tooMany = await order({
      bandHolder: { checkinId: lee!.checkinId },
      items: [{ id: newId(), productId: item('FB-WATER').id, quantity: 2, prepaid: { checkinId: lee!.checkinId }, lineTotalSatang: 0 }],
    });
    expect(tooMany.statusCode).toBe(409);
    expect(tooMany.json().error.message).toBe('Lee has only 1 prepaid Bottled Water left to serve.');
    expect((await itemsOf(lee!.checkinId))[0]!.redeemedQty).toBe(0);
  });
});

describe('s494 — the food-consent rule at the ledger', () => {
  it('refuses food for a child whose parent did not authorise it, and records the override with the account', async () => {
    const [tyler] = await familyInPark([{ name: 'Tyler' }]);
    const refused = await order({
      bandHolder: { checkinId: tyler!.checkinId },
      items: [{ id: newId(), productId: item('FB-WATER').id, quantity: 1 }],
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'FOOD_NOT_AUTHORIZED', message: 'Parent did not authorize food orders for this child.' });

    const saleId = newId();
    const allowed = await order({
      id: saleId,
      bandHolder: { checkinId: tyler!.checkinId, foodOverride: true },
      items: [{ id: newId(), productId: item('FB-WATER').id, quantity: 1 }],
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const [line] = await ctx.db.select().from(saleLine).where(eq(saleLine.saleId, saleId));
    const holder = (line!.payload as { holder: { checkinId: string; foodOverride: { accountId: string; at: string } } }).holder;
    expect(holder.checkinId).toBe(tyler!.checkinId);
    expect(holder.foodOverride.accountId).toBe(receptionId);
  });
});

describe('s494 — pickup refunds only what was not served', () => {
  it('the release reads the served counts off the stay', async () => {
    const food: Provision = {
      mode: 'prepaid_items',
      paidSatang: item('FB-HOTDOG').priceSatang + 2 * item('FB-WATER').priceSatang,
      items: [entitlement('FB-HOTDOG', 1), entitlement('FB-WATER', 2)],
    };
    const [ana] = await familyInPark([{ name: 'Ana', food }]);
    const saleId = newId();
    const res = await order({
      id: saleId,
      bandHolder: { checkinId: ana!.checkinId },
      items: [
        { id: newId(), productId: item('FB-HOTDOG').id, quantity: 1, prepaid: { checkinId: ana!.checkinId }, lineTotalSatang: 0 },
        { id: newId(), productId: item('FB-WATER').id, quantity: 1, prepaid: { checkinId: ana!.checkinId }, lineTotalSatang: 0 },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await finalise(saleId)).statusCode).toBe(200);

    const context = (
      await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/stays/${ana!.checkinId}`, headers: { cookie } })
    ).json();
    expect(context.reconciliation).toMatchObject({ mode: 'prepaid_items', totalUnusedSatang: item('FB-WATER').priceSatang });

    const [stayRow] = await ctx.db.select().from(checkin).where(eq(checkin.id, ana!.checkinId));
    const photoId = newId();
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/files',
      headers: { cookie },
      payload: { id: photoId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: stayRow!.registrationId, filename: 'pickup.jpg' },
    });
    expect(up.statusCode, up.body).toBe(200);
    expect(await ctx.db.select().from(fileObject).where(eq(fileObject.id, photoId))).toHaveLength(1);
    const released = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/stays/${ana!.checkinId}/release`,
      headers: { cookie },
      payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: photoId },
    });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().release.settlement).toMatchObject({
      policy: 'refund',
      unusedSatang: item('FB-WATER').priceSatang,
      refundedSatang: item('FB-WATER').priceSatang,
    });
    const refunds = await ctx.db.select().from(refund).where(eq(refund.id, released.json().release.settlement.refundId));
    expect(refunds[0]!.amountSatang).toBe(item('FB-WATER').priceSatang);
  });
});

describe('s494 — the prep ticket prints the band holder’s own allergy line', () => {
  it('names the band’s child and their allergy, never the sibling’s', async () => {
    const [mint, june] = await familyInPark([
      { name: 'Mint', allergies: 'Peanuts' },
      { name: 'June', allergies: 'Shellfish' },
    ]);
    // The family's two stays share a registration; only one band is scanned.
    const scanned = (await scan(june!.bandCode)).json();
    expect(scanned.stay).toMatchObject({ childName: 'June', allergiesMedical: 'Shellfish' });
    const saleId = newId();
    const res = await order({
      id: saleId,
      // June's parent prepaid no food, so staff recorded the override.
      bandHolder: { checkinId: june!.checkinId, foodOverride: true },
      items: [{ id: newId(), productId: item('FB-HOTDOG').id, quantity: 1 }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await finalise(saleId, { method: 'cash' })).statusCode).toBe(200);
    const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const snapshot = await salePrintSnapshotOf(ctx.db, row!);
    expect(snapshot.bandHolder).toEqual({ name: 'June', allergiesMedical: 'Shellfish' });
    const ticket = salePrepDocument(snapshot, 'kitchen');
    expect(ticket.holderName).toBe('June');
    expect(ticket.allergiesMedical).toBe('Shellfish');
    expect(JSON.stringify(ticket)).not.toContain('Peanuts');
    expect(mint).toBeTruthy();
  });
});
