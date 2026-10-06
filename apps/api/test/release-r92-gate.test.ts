import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, fileObject, guardian, release, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-13 round 3 gate — R-92 reproductions. A STORED sign-up photo (the child
 * with the dropper-off, owned by the registration) must never stand in for a
 * photo taken at the counter: not as the on-the-spot collector's photo, and not
 * (a sibling's) as the live pickup photo. These tests assert the REQUIRED
 * behaviour; they fail while the walk-around exists.
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
let branchId: string;
let stationId: string;
let twoHoursId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
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

async function childrenInPark(names: string[]): Promise<{ registrationId: string; checkinIds: string[] }> {
  const registrationId = newId();
  const checkinIds = names.map(() => newId());
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
      children: names.map((name, i) => ({
        checkinId: checkinIds[i],
        name,
        ageYears: 6,
        service: 'drop_off',
        allergies: null,
        foodRestrictions: null,
        foodProvision: { mode: 'none', paidSatang: 0 },
      })),
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
      lines: checkinIds.map((id) => ({
        id,
        packageId: twoHoursId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
        foodProvision: null,
      })),
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const fin = await ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: reception }, payload: {} });
  expect(fin.statusCode, fin.body).toBe(200);
  const now = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie: reception },
    payload: { saleId, entries: checkinIds.map((checkinId) => ({ checkinId, nannyId: null })) },
  });
  expect(now.statusCode, now.body).toBe(200);
  return { registrationId, checkinIds };
}

async function photo(registrationId: string): Promise<string> {
  const id = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/files',
    headers: { cookie: reception },
    payload: { id, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: registrationId, filename: 'p.jpg' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

async function attachSignUp(registrationId: string, fileId: string, checkinIds: string[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/checkin/registrations/${registrationId}/photo`,
    headers: { cookie: reception },
    payload: { fileId, checkinIds },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('R-92 gate — a stored sign-up photo never stands in for a counter photo', () => {
  it('refuses the sign-up photo as an on-the-spot collector photo (unlisted stranger released)', async () => {
    const fam = await childrenInPark(['Mint']);
    const signUp = await photo(fam.registrationId);
    await attachSignUp(fam.registrationId, signUp, fam.checkinIds);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/stays/${fam.checkinIds[0]}/release`,
      headers: { cookie: reception },
      payload: {
        collector: { kind: 'on_the_spot', name: 'Unlisted Stranger', photoFileId: signUp },
        pickupPhotoFileId: await photo(fam.registrationId),
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('COLLECTOR_PHOTO_REQUIRED');
    expect(await ctx.db.select().from(release).where(eq(release.checkinId, fam.checkinIds[0]!))).toHaveLength(0);
    expect(await ctx.db.select().from(guardian).where(eq(guardian.registrationId, fam.registrationId))).toHaveLength(0);
    const [file] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, signUp));
    expect(file).toMatchObject({ ownerEntityType: 'registration', ownerEntityId: fam.registrationId });
  });

  it("refuses a sibling's stored sign-up photo as the live pickup photo", async () => {
    const fam = await childrenInPark(['Kai', 'Kao']);
    const a = await photo(fam.registrationId);
    await attachSignUp(fam.registrationId, a, [fam.checkinIds[0]!]);
    const b = await photo(fam.registrationId);
    await attachSignUp(fam.registrationId, b, [fam.checkinIds[1]!]);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/stays/${fam.checkinIds[0]}/release`,
      headers: { cookie: reception },
      payload: { collector: { kind: 'dropper_off' }, pickupPhotoFileId: b },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('PICKUP_PHOTO_REQUIRED');
  });

  it('refuses the sign-up photo as a pickup-list photo added from the sheet (re-owning the sign-up photo)', async () => {
    const fam = await childrenInPark(['Ice']);
    const signUp = await photo(fam.registrationId);
    await attachSignUp(fam.registrationId, signUp, fam.checkinIds);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/registrations/${fam.registrationId}/guardians`,
      headers: { cookie: reception },
      payload: { name: 'Somebody', source: 'on_the_spot', photoFileId: signUp },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('COLLECTOR_PHOTO_REQUIRED');
    const [file] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, signUp));
    expect(file).toMatchObject({ ownerEntityType: 'registration', ownerEntityId: fam.registrationId });
  });

  it("refuses the sign-up photo as a listed person's photo on edit (PATCH goes through the same check)", async () => {
    const fam = await childrenInPark(['Nam']);
    const signUp = await photo(fam.registrationId);
    await attachSignUp(fam.registrationId, signUp, fam.checkinIds);
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/registrations/${fam.registrationId}/guardians`,
      headers: { cookie: reception },
      payload: { name: 'Auntie', source: 'in_person' },
    });
    expect(added.statusCode, added.body).toBe(200);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/checkin/pickups/guardians/${added.json().id}`,
      headers: { cookie: reception },
      payload: { photoFileId: signUp },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('COLLECTOR_PHOTO_REQUIRED');
    const [g] = await ctx.db.select().from(guardian).where(eq(guardian.id, added.json().id));
    expect(g!.photoFileId).toBeNull();
    const [file] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, signUp));
    expect(file).toMatchObject({ ownerEntityType: 'registration', ownerEntityId: fam.registrationId });
  });

  it('still accepts photos taken at the counter: a fresh collector photo and a fresh pickup photo release the child', async () => {
    const fam = await childrenInPark(['Fah']);
    const signUp = await photo(fam.registrationId);
    await attachSignUp(fam.registrationId, signUp, fam.checkinIds);
    const collectorPhoto = await photo(fam.registrationId);
    const pickupPhoto = await photo(fam.registrationId);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/pickups/stays/${fam.checkinIds[0]}/release`,
      headers: { cookie: reception },
      payload: {
        collector: { kind: 'on_the_spot', name: 'Uncle Boon', photoFileId: collectorPhoto },
        pickupPhotoFileId: pickupPhoto,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().release.collectorName).toBe('Uncle Boon');
    expect(res.json().release.collectorSource).toBe('on_the_spot');
    const [signUpFile] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, signUp));
    expect(signUpFile).toMatchObject({ ownerEntityType: 'registration', ownerEntityId: fam.registrationId });
    const [pickupFile] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, pickupPhoto));
    expect(pickupFile!.ownerEntityType).toBe('release');
    const [collectorFile] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, collectorPhoto));
    expect(collectorFile!.ownerEntityType).toBe('guardian');
  });
});
