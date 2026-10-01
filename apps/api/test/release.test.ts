import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  branch,
  checkin,
  dropOffPricing,
  fileObject,
  guardian,
  nanny,
  refund,
  registration,
  release,
  sale,
  station,
  ticketPackage,
} from '@oto/db';
import { newId } from '@oto/shared';
import { CHALONG_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-13 round 3 — pickups and release online (plan docs/progress/plans/
 * checkin/PLAN.md §2.4), driven through the routes the board's pickup sheet
 * and release modal call where the prototype called `getAuthorizedPickups`,
 * `addGuardianToRegistration`, `editGuardian` and `checkOut`.
 *
 * File storage is built (presigning is local arithmetic, so no MinIO is
 * needed): the photos are registered through `POST /files` exactly as the
 * till registers them, and read back through `GET /files/:id/url`.
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
let receptionId: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
  const [acc] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionId = acc!.id;
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
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers --------------------------------------------------------------------

type Provision = {
  mode: 'none' | 'prepaid_credit' | 'prepaid_items';
  paidSatang: number;
  creditSatang?: number;
  items?: { menuItemId: string; menuItemName: string; unitSatang: number; qty: number; redeemedQty: number }[];
};

interface InPark {
  registrationId: string;
  checkinId: string;
  saleId: string;
}

/** Register one child, pay for them and put them in the park — the round-1 path, end to end. */
async function childInPark(
  over: { name?: string; ageYears?: number; service?: 'drop_off' | 'nanny'; food?: Provision; nannyId?: string } = {},
): Promise<InPark> {
  const checkinId = newId();
  const registrationId = newId();
  const food = over.food ?? { mode: 'none', paidSatang: 0 };
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
      children: [
        {
          checkinId,
          name: over.name ?? 'Mint',
          ageYears: over.ageYears ?? 6,
          service: over.service ?? 'drop_off',
          allergies: null,
          foodRestrictions: null,
          foodProvision: food,
        },
      ],
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: {
      id: saleId,
      stationId,
      lines: [
        {
          id: checkinId,
          packageId: twoHoursId,
          kids: 1,
          adults: 0,
          serviceFee:
            over.service === 'nanny'
              ? { label: 'Nanny (2h)', amountSatang: 66_000 }
              : { label: 'Drop-off service', amountSatang: 22_500 },
          foodProvision: food.mode === 'none' ? null : { mode: food.mode, paidSatang: food.paidSatang },
        },
      ],
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(fin.statusCode, fin.body).toBe(200);
  const now = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie: reception },
    payload: { saleId, entries: [{ checkinId, nannyId: over.nannyId ?? null }] },
  });
  expect(now.statusCode, now.body).toBe(200);
  return { registrationId, checkinId, saleId };
}

/** A photo registered the way the till registers one: under the registration. */
async function photo(registrationId: string, cookie = reception): Promise<string> {
  const id = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/files',
    headers: { cookie },
    payload: { id, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: registrationId, filename: 'pickup.jpg' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

async function releaseCall(checkinId: string, payload: Record<string, unknown>, cookie = reception) {
  return ctx.app.inject({
    method: 'POST',
    url: `/checkin/pickups/stays/${checkinId}/release`,
    headers: { cookie },
    payload,
  });
}

async function addGuardianCall(registrationId: string, payload: Record<string, unknown>, cookie = reception) {
  return ctx.app.inject({
    method: 'POST',
    url: `/checkin/pickups/registrations/${registrationId}/guardians`,
    headers: { cookie },
    payload,
  });
}

async function stay(id: string) {
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, id));
  return row!;
}

async function auditOf(entityType: string, entityId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, entityType), eq(auditLog.entityId, entityId)));
}

// --- The list --------------------------------------------------------------------

describe('the authorised-pickup list (R-91)', () => {
  it('starts with the dropper-off, adds in person, promotes from chat, edits and revokes — every change audited, nothing deleted', async () => {
    const family = await childInPark();
    const first = await ctx.app.inject({
      method: 'GET',
      url: `/checkin/pickups/registrations/${family.registrationId}`,
      headers: { cookie: reception },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().pickups).toEqual([
      expect.objectContaining({ id: 'dropper_off', name: 'Ploy', phone: '+66812345678', isDropperOff: true, source: 'dropper_off' }),
    ]);

    // In person, no photo: the prototype's sheet made the photo optional.
    const grandpaId = newId();
    const added = await addGuardianCall(family.registrationId, {
      id: grandpaId,
      name: '  Khun Somchai ',
      relationship: 'grandfather',
      phone: '0899999999',
      source: 'in_person',
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json()).toMatchObject({ id: grandpaId, name: 'Khun Somchai', phone: '+66899999999', source: 'in_person', isDropperOff: false });
    const replay = await addGuardianCall(family.registrationId, { id: grandpaId, name: 'Khun Somchai', source: 'in_person' });
    expect(replay.headers['x-oto-replay']).toBe('true');
    expect(await ctx.db.select().from(guardian).where(eq(guardian.id, grandpaId))).toHaveLength(1);

    // From chat: kept as the prototype had it — a name and the chat photo.
    const noChatPhoto = await addGuardianCall(family.registrationId, { name: 'Aunt Noi', source: 'from_chat' });
    expect(noChatPhoto.statusCode).toBe(400);
    expect(noChatPhoto.json().error.code).toBe('CHAT_PHOTO_REQUIRED');
    const chatPhoto = await photo(family.registrationId);
    const fromChat = await addGuardianCall(family.registrationId, { name: 'Aunt Noi', source: 'from_chat', photoFileId: chatPhoto });
    expect(fromChat.statusCode, fromChat.body).toBe(200);
    const auntId = fromChat.json().id as string;
    const [reowned] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, chatPhoto));
    expect(reowned).toMatchObject({ ownerEntityType: 'guardian', ownerEntityId: auntId });

    // Edit: audited before and after.
    const edit = await ctx.app.inject({
      method: 'PATCH',
      url: `/checkin/pickups/guardians/${grandpaId}`,
      headers: { cookie: reception },
      payload: { relationship: 'grandpa' },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json().relationship).toBe('grandpa');

    // Revoke: off the list, still in the table.
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/guardians/${auntId}/revoke`,
      headers: { cookie: reception },
      payload: {},
    });
    expect(revoke.statusCode, revoke.body).toBe(200);
    const list = (
      await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/registrations/${family.registrationId}`, headers: { cookie: reception } })
    ).json().pickups as { id: string; name: string }[];
    expect(list.map((p) => p.name)).toEqual(['Ploy', 'Khun Somchai']);
    const [kept] = await ctx.db.select().from(guardian).where(eq(guardian.id, auntId));
    expect(kept!.revokedAt).not.toBeNull();
    expect(kept!.revokedByAccountId).toBe(receptionId);

    expect((await auditOf('guardian', grandpaId)).map((a) => a.action).sort()).toEqual(['guardian.create', 'guardian.update']);
    const update = (await auditOf('guardian', grandpaId)).find((a) => a.action === 'guardian.update')!;
    expect(update.before).toEqual({ relationship: 'grandfather' });
    expect(update.after).toMatchObject({ relationship: 'grandpa' });
    expect((await auditOf('guardian', auntId)).map((a) => a.action).sort()).toEqual(['guardian.create', 'guardian.revoke']);
  });

  it('refuses an on-the-spot addition without a photo', async () => {
    const family = await childInPark();
    const res = await addGuardianCall(family.registrationId, { name: 'Uncle Lek', source: 'on_the_spot' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('COLLECTOR_PHOTO_REQUIRED');
  });
});

// --- R-92 ------------------------------------------------------------------------------

describe('release refusals (R-92, server-side)', () => {
  it('refuses an unlisted collector, a revoked one, a missing pickup photo and a missing name — and changes nothing', async () => {
    const family = await childInPark();
    const other = await childInPark();
    const pickupPhoto = await photo(family.registrationId);

    // Unlisted: a person on ANOTHER family's list, and an id that names nobody.
    const strangerId = newId();
    expect((await addGuardianCall(other.registrationId, { id: strangerId, name: 'Stranger', source: 'in_person' })).statusCode).toBe(200);
    const unlisted = await releaseCall(family.checkinId, { collector: { kind: 'guardian', guardianId: strangerId }, pickupPhotoFileId: pickupPhoto });
    expect(unlisted.statusCode).toBe(409);
    expect(unlisted.json().error).toMatchObject({ code: 'COLLECTOR_NOT_LISTED' });
    expect(unlisted.json().error.message).toContain('not on this child');
    const nobody = await releaseCall(family.checkinId, { collector: { kind: 'guardian', guardianId: newId() }, pickupPhotoFileId: pickupPhoto });
    expect(nobody.json().error.code).toBe('COLLECTOR_NOT_LISTED');

    // Revoked.
    const exId = newId();
    expect((await addGuardianCall(family.registrationId, { id: exId, name: 'Ex Nanny', source: 'in_person' })).statusCode).toBe(200);
    expect(
      (await ctx.app.inject({ method: 'POST', url: `/checkin/pickups/guardians/${exId}/revoke`, headers: { cookie: reception }, payload: {} })).statusCode,
    ).toBe(200);
    const revoked = await releaseCall(family.checkinId, { collector: { kind: 'guardian', guardianId: exId }, pickupPhotoFileId: pickupPhoto });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error.code).toBe('COLLECTOR_REVOKED');
    expect(revoked.json().error.message).toContain('Ex Nanny was taken off the pickup list');

    // Missing pickup photo — for the dropper-off too.
    const noPhoto = await releaseCall(family.checkinId, { collector: { kind: 'dropper_off' } });
    expect(noPhoto.statusCode).toBe(400);
    expect(noPhoto.json().error.code).toBe('PICKUP_PHOTO_REQUIRED');

    // On the spot: a missing name, a missing photo.
    const collectorPhoto = await photo(family.registrationId);
    const noName = await releaseCall(family.checkinId, {
      collector: { kind: 'on_the_spot', name: '   ', photoFileId: collectorPhoto },
      pickupPhotoFileId: pickupPhoto,
    });
    expect(noName.statusCode).toBe(400);
    expect(noName.json().error.code).toBe('COLLECTOR_NAME_REQUIRED');
    const noCollectorPhoto = await releaseCall(family.checkinId, {
      collector: { kind: 'on_the_spot', name: 'Uncle Lek' },
      pickupPhotoFileId: pickupPhoto,
    });
    expect(noCollectorPhoto.statusCode).toBe(400);
    expect(noCollectorPhoto.json().error.code).toBe('COLLECTOR_PHOTO_REQUIRED');

    // A photo of somebody else's registration is no photo at all.
    const foreignPhoto = await photo(other.registrationId);
    const foreign = await releaseCall(family.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: foreignPhoto });
    expect(foreign.statusCode).toBe(404);

    // Nothing moved: still in the park, no release, no on-the-spot person added.
    expect((await stay(family.checkinId)).status).toBe('in_park');
    expect(await ctx.db.select().from(release).where(eq(release.checkinId, family.checkinId))).toHaveLength(0);
    const names = (await ctx.db.select().from(guardian).where(eq(guardian.registrationId, family.registrationId))).map((g) => g.name);
    expect(names).not.toContain('Uncle Lek');
  });

  it('refuses a release, a context read and a photo read to an account without pos:checkin at that park', async () => {
    const family = await childInPark();
    const pickupPhoto = await photo(family.registrationId);
    const res = await releaseCall(family.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: pickupPhoto }, chalongManager);
    expect(res.statusCode).toBe(403);
    const ctxRead = await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/stays/${family.checkinId}`, headers: { cookie: chalongManager } });
    expect(ctxRead.statusCode).toBe(403);
    const listRead = await ctx.app.inject({
      method: 'GET',
      url: `/checkin/pickups/registrations/${family.registrationId}`,
      headers: { cookie: chalongManager },
    });
    expect(listRead.statusCode).toBe(403);
    const photoRead = await ctx.app.inject({ method: 'GET', url: `/files/${pickupPhoto}/url`, headers: { cookie: chalongManager } });
    expect(photoRead.statusCode).toBe(403);
    const added = await addGuardianCall(family.registrationId, { name: 'Somebody', source: 'in_person' }, chalongManager);
    expect(added.statusCode).toBe(403);
    expect((await stay(family.checkinId)).status).toBe('in_park');
  });
});

// --- The release -------------------------------------------------------------------------

describe('the release', () => {
  it('on the spot, end to end: the collector added with name and photo, verified by the signed-in account, the pickup photo kept, the stay out', async () => {
    const family = await childInPark({ name: 'Kai' });
    const collectorPhoto = await photo(family.registrationId);
    const pickupPhoto = await photo(family.registrationId);
    const releaseId = newId();
    const body = {
      id: releaseId,
      stationId,
      collector: { kind: 'on_the_spot', name: 'Uncle Lek', relationship: 'uncle', photoFileId: collectorPhoto },
      pickupPhotoFileId: pickupPhoto,
    };
    const res = await releaseCall(family.checkinId, body);
    expect(res.statusCode, res.body).toBe(200);
    const view = res.json().release;
    expect(view).toMatchObject({
      id: releaseId,
      collectorName: 'Uncle Lek',
      collectorSource: 'on_the_spot',
      verifiedByAccountId: receptionId,
      pickupPhotoFileId: pickupPhoto,
      stationId,
      settlement: null,
    });

    const [row] = await ctx.db.select().from(release).where(eq(release.id, releaseId));
    expect(row).toMatchObject({ checkinId: family.checkinId, collectorName: 'Uncle Lek', verifiedByAccountId: receptionId, pickupPhotoFileId: pickupPhoto });
    const [added] = await ctx.db.select().from(guardian).where(eq(guardian.id, row!.guardianId!));
    expect(added).toMatchObject({ name: 'Uncle Lek', relationship: 'uncle', source: 'on_the_spot', photoFileId: collectorPhoto, addedByAccountId: receptionId });
    const files = await ctx.db.select().from(fileObject).where(eq(fileObject.id, pickupPhoto));
    expect(files[0]).toMatchObject({ ownerEntityType: 'release', ownerEntityId: releaseId });

    const after = await stay(family.checkinId);
    expect(after.status).toBe('out');
    expect(after.checkedOutByAccountId).toBe(receptionId);
    expect(after.checkedOutAt).not.toBeNull();
    const [reg] = await ctx.db.select().from(registration).where(eq(registration.id, family.registrationId));
    expect(reg!.retentionUntil).not.toBeNull();

    const releaseAudit = await auditOf('release', releaseId);
    expect(releaseAudit.map((a) => a.action)).toEqual(['release.create']);
    expect(releaseAudit[0]!.after).toMatchObject({ stationId, collectorName: 'Uncle Lek', collectorSource: 'on_the_spot', verifiedByAccountId: receptionId });
    expect((await auditOf('guardian', added!.id)).map((a) => a.action)).toEqual(['guardian.create']);
    expect((await auditOf('checkin', family.checkinId)).some((a) => (a.after as { event?: string }).event === 'release')).toBe(true);

    // The same press again answers the release it made; a different one is refused.
    const again = await releaseCall(family.checkinId, body);
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    const twice = await releaseCall(family.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(family.registrationId) });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('ALREADY_RELEASED');
    expect(await ctx.db.select().from(release).where(eq(release.checkinId, family.checkinId))).toHaveLength(1);
  });

  it('releases to a listed guardian and to the dropper-off', async () => {
    const one = await childInPark();
    const gId = newId();
    expect((await addGuardianCall(one.registrationId, { id: gId, name: 'Grandma Ying', source: 'in_person' })).statusCode).toBe(200);
    const res = await releaseCall(one.checkinId, { collector: { kind: 'guardian', guardianId: gId }, pickupPhotoFileId: await photo(one.registrationId) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().release).toMatchObject({ guardianId: gId, collectorName: 'Grandma Ying', collectorSource: 'in_person' });

    const two = await childInPark();
    const res2 = await releaseCall(two.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(two.registrationId) });
    expect(res2.statusCode, res2.body).toBe(200);
    expect(res2.json().release).toMatchObject({ guardianId: null, collectorName: 'Ploy', collectorSource: 'dropper_off' });
  });

  it('access-logs every read of a check-in photo (R-94)', async () => {
    const family = await childInPark();
    const signUp = await photo(family.registrationId);
    const attach = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${family.registrationId}/photo`,
      headers: { cookie: reception },
      payload: { fileId: signUp, checkinIds: [family.checkinId] },
    });
    expect(attach.statusCode, attach.body).toBe(200);
    const context = await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/stays/${family.checkinId}`, headers: { cookie: reception } });
    expect(context.statusCode, context.body).toBe(200);
    expect(context.json()).toMatchObject({ signUpPhotoFileId: signUp, prepaidPolicy: 'refund', status: 'in_park' });
    expect(context.json().pickups[0]).toMatchObject({ id: 'dropper_off', photoFileId: signUp });

    // The stored sign-up photo can never stand in for the live pickup photo.
    const reused = await releaseCall(family.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: signUp });
    expect(reused.statusCode).toBe(400);
    expect(reused.json().error.code).toBe('PICKUP_PHOTO_REQUIRED');

    for (let i = 0; i < 2; i++) {
      const read = await ctx.app.inject({ method: 'GET', url: `/files/${signUp}/url`, headers: { cookie: reception } });
      expect(read.statusCode, read.body).toBe(200);
    }
    const reads = (await auditOf('file_object', signUp)).filter((a) => a.action === 'file.read');
    expect(reads).toHaveLength(2);
    expect(reads[0]).toMatchObject({ actorAccountId: receptionId, branchId });
    expect(reads[0]!.after).toMatchObject({ ownerEntityType: 'registration', ownerEntityId: family.registrationId });

    // A refused read writes no access row and hands out no URL.
    const refused = await ctx.app.inject({ method: 'GET', url: `/files/${signUp}/url`, headers: { cookie: chalongManager } });
    expect(refused.statusCode).toBe(403);
    expect((await auditOf('file_object', signUp)).filter((a) => a.action === 'file.read')).toHaveLength(2);
  });
});

// --- Prepaid food, to the satang ----------------------------------------------------------------

describe('prepaid food reconciliation (seeded policy: refund)', () => {
  it('refunds the unredeemed items against the linked sale, to the satang', async () => {
    const food: Provision = {
      mode: 'prepaid_items',
      paidSatang: 4_550 * 2 + 12_525,
      items: [
        { menuItemId: 'm-juice', menuItemName: 'Orange juice', unitSatang: 4_550, qty: 2, redeemedQty: 1 },
        { menuItemId: 'm-sandwich', menuItemName: 'Ham sandwich', unitSatang: 12_525, qty: 1, redeemedQty: 0 },
      ],
    };
    const family = await childInPark({ food });
    const context = (await ctx.app.inject({ method: 'GET', url: `/checkin/pickups/stays/${family.checkinId}`, headers: { cookie: reception } })).json();
    expect(context.reconciliation).toMatchObject({
      mode: 'prepaid_items',
      paidSatang: 21_625,
      totalRedeemedSatang: 4_550,
      totalUnusedSatang: 17_075,
    });
    expect(context.reconciliation.itemBreakdown).toEqual([
      { menuItemName: 'Orange juice', qty: 2, redeemedQty: 1, unredeemedQty: 1, unitSatang: 4_550, unredeemedSatang: 4_550 },
      { menuItemName: 'Ham sandwich', qty: 1, redeemedQty: 0, unredeemedQty: 1, unitSatang: 12_525, unredeemedSatang: 12_525 },
    ]);

    const [before] = await ctx.db.select().from(sale).where(eq(sale.id, family.saleId));
    const res = await releaseCall(family.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(family.registrationId) });
    expect(res.statusCode, res.body).toBe(200);
    const settlement = res.json().release.settlement;
    expect(settlement).toMatchObject({ policy: 'refund', unusedSatang: 17_075, refundedSatang: 17_075, settlementError: null });

    const refunds = await ctx.db.select().from(refund).where(eq(refund.saleId, family.saleId));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ id: settlement.refundId, amountSatang: 17_075, mode: 'custom', reason: 'Unused prepaid food at pickup' });
    const [after] = await ctx.db.select().from(sale).where(eq(sale.id, family.saleId));
    expect(after!.refundedSatang - before!.refundedSatang).toBe(17_075);
    const [row] = await ctx.db.select().from(release).where(eq(release.checkinId, family.checkinId));
    expect(row).toMatchObject({ prepaidPolicy: 'refund', prepaidUnusedSatang: 17_075, refundId: settlement.refundId, refundNoSale: false });
  });

  it('refunds unused prepaid credit in full when nothing was spent against it', async () => {
    const family = await childInPark({ food: { mode: 'prepaid_credit', paidSatang: 20_050, creditSatang: 20_050 } });
    const res = await releaseCall(family.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(family.registrationId) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().release.settlement).toMatchObject({ policy: 'refund', unusedSatang: 20_050, refundedSatang: 20_050 });
  });

  it('records refund_no_sale when the stay has no linked sale, and still releases the child', async () => {
    const family = await childInPark({ food: { mode: 'prepaid_credit', paidSatang: 15_000, creditSatang: 15_000 } });
    await ctx.db.update(checkin).set({ saleId: null }).where(eq(checkin.id, family.checkinId));
    const res = await releaseCall(family.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(family.registrationId) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().release.settlement).toEqual({
      policy: 'refund',
      unusedSatang: 15_000,
      refundId: null,
      refundedSatang: 0,
      settlementError: 'refund_no_sale',
    });
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, family.saleId))).toHaveLength(0);
    const [row] = await ctx.db.select().from(release).where(eq(release.checkinId, family.checkinId));
    expect(row).toMatchObject({ refundNoSale: true, refundId: null, prepaidUnusedSatang: 15_000 });
    expect((await stay(family.checkinId)).status).toBe('out');
    const [created] = (await auditOf('release', row!.id)).filter((a) => a.action === 'release.create');
    expect((created!.after as { prepaid: unknown }).prepaid).toMatchObject({ refundNoSale: true, refundFailure: 'NO_LINKED_SALE' });
  });

  it('a fully redeemed provision settles nothing, and a forfeit branch refunds nothing', async () => {
    const used = await childInPark({
      food: {
        mode: 'prepaid_items',
        paidSatang: 9_000,
        items: [{ menuItemId: 'm-juice', menuItemName: 'Juice', unitSatang: 4_500, qty: 2, redeemedQty: 2 }],
      },
    });
    const res = await releaseCall(used.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(used.registrationId) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().release.settlement).toBeNull();
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, used.saleId))).toHaveLength(0);

    await ctx.db.update(dropOffPricing).set({ prepaidFoodUnused: 'forfeit' }).where(eq(dropOffPricing.branchId, branchId));
    try {
      const kept = await childInPark({ food: { mode: 'prepaid_credit', paidSatang: 10_000, creditSatang: 10_000 } });
      const res2 = await releaseCall(kept.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(kept.registrationId) });
      expect(res2.statusCode, res2.body).toBe(200);
      expect(res2.json().release.settlement).toMatchObject({ policy: 'forfeit', unusedSatang: 10_000, refundId: null, settlementError: null });
      expect(await ctx.db.select().from(refund).where(eq(refund.saleId, kept.saleId))).toHaveLength(0);
    } finally {
      await ctx.db.update(dropOffPricing).set({ prepaidFoodUnused: 'refund' }).where(eq(dropOffPricing.branchId, branchId));
    }
  });
});

// --- The nanny ---------------------------------------------------------------------------------

describe('the nanny', () => {
  it('is freed by the release and can be assigned again', async () => {
    const [aor] = await ctx.db.select().from(nanny).where(and(eq(nanny.branchId, branchId), eq(nanny.name, 'Aor')));
    const loadOf = async () => {
      const res = await ctx.app.inject({ method: 'GET', url: `/checkin/config?branchId=${branchId}`, headers: { cookie: reception } });
      return (res.json().nannies as { id: string; load: number }[]).find((n) => n.id === aor!.id)!.load;
    };
    const base = await loadOf();
    const baby = await childInPark({ name: 'Baby', ageYears: 3, service: 'nanny', nannyId: aor!.id });
    expect(await loadOf()).toBe(base + 1);

    const res = await releaseCall(baby.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(baby.registrationId) });
    expect(res.statusCode, res.body).toBe(200);
    expect(await loadOf()).toBe(base);
    const created = (await ctx.db.select().from(auditLog).where(and(eq(auditLog.action, 'release.create'), eq(auditLog.entityId, res.json().release.id))))[0]!;
    expect((created.after as { nannyFreed: string }).nannyFreed).toBe(aor!.id);

    const next = await childInPark({ name: 'Toddler', ageYears: 2, service: 'nanny', nannyId: aor!.id });
    expect((await stay(next.checkinId)).nannyId).toBe(aor!.id);
    expect(await loadOf()).toBe(base + 1);
  });
});
