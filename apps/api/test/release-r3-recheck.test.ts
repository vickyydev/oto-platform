import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, checkin, fileObject, guardian, release, station, ticketPackage } from '@oto/db';
import { newId } from '@oto/shared';
import { CHALONG_MANAGER, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * S2-13 round 3 gate, re-check — R-92 walk-around attempts after the
 * sign-up-photo fix, and the photo-safety invariants on guardian- and
 * release-owned photos. Every case asserts the REQUIRED behaviour.
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
let branchId: string;
let stationId: string;
let twoHoursId: string;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
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

async function childInPark(): Promise<{ registrationId: string; checkinId: string }> {
  const registrationId = newId();
  const checkinId = newId();
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
          name: 'Mint',
          ageYears: 6,
          service: 'drop_off',
          allergies: null,
          foodRestrictions: null,
          foodProvision: { mode: 'none', paidSatang: 0 },
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
        { id: checkinId, packageId: twoHoursId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 }, foodProvision: null },
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
    payload: { saleId, entries: [{ checkinId, nannyId: null }] },
  });
  expect(now.statusCode, now.body).toBe(200);
  return { registrationId, checkinId };
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

const releaseCall = (checkinId: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/checkin/pickups/stays/${checkinId}/release`, headers: { cookie: reception }, payload });

const addGuardianCall = (registrationId: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: `/checkin/pickups/registrations/${registrationId}/guardians`, headers: { cookie: reception }, payload });

async function nothingReleased(checkinId: string) {
  expect(await ctx.db.select().from(release).where(eq(release.checkinId, checkinId))).toHaveLength(0);
  const [row] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
  expect(row!.status).toBe('in_park');
}

describe('R-92 re-check — walk-around attempts', () => {
  it("refuses another registration's photo as the on-the-spot collector photo and as the pickup photo", async () => {
    const mine = await childInPark();
    const theirs = await childInPark();
    const foreign = await photo(theirs.registrationId);
    const a = await releaseCall(mine.checkinId, {
      collector: { kind: 'on_the_spot', name: 'Stranger', photoFileId: foreign },
      pickupPhotoFileId: await photo(mine.registrationId),
    });
    expect(a.statusCode).toBe(404);
    const b = await releaseCall(mine.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: foreign });
    expect(b.statusCode).toBe(404);
    await nothingReleased(mine.checkinId);
    expect(await ctx.db.select().from(guardian).where(eq(guardian.registrationId, mine.registrationId))).toHaveLength(0);
  });

  it('refuses a revoked guardian, also when smuggled back as on_the_spot under their old id with their old photo', async () => {
    const fam = await childInPark();
    const gId = newId();
    const gPhoto = await photo(fam.registrationId);
    const added = await addGuardianCall(fam.registrationId, { id: gId, name: 'Ex', source: 'in_person', photoFileId: gPhoto });
    expect(added.statusCode, added.body).toBe(200);
    const rev = await ctx.app.inject({ method: 'POST', url: `/checkin/pickups/guardians/${gId}/revoke`, headers: { cookie: reception }, payload: {} });
    expect(rev.statusCode, rev.body).toBe(200);

    const direct = await releaseCall(fam.checkinId, { collector: { kind: 'guardian', guardianId: gId }, pickupPhotoFileId: await photo(fam.registrationId) });
    expect(direct.statusCode).toBe(409);
    expect(direct.json().error.code).toBe('COLLECTOR_REVOKED');

    const smuggled = await releaseCall(fam.checkinId, {
      collector: { kind: 'on_the_spot', guardianId: gId, name: 'Ex', photoFileId: gPhoto },
      pickupPhotoFileId: await photo(fam.registrationId),
    });
    expect(smuggled.statusCode).toBe(409);
    await nothingReleased(fam.checkinId);
    const [g] = await ctx.db.select().from(guardian).where(eq(guardian.id, gId));
    expect(g!.revokedAt).not.toBeNull();
  });

  it("refuses a listed guardian's own stored photo as the live pickup photo", async () => {
    const fam = await childInPark();
    const gId = newId();
    const gPhoto = await photo(fam.registrationId);
    expect((await addGuardianCall(fam.registrationId, { id: gId, name: 'Auntie', source: 'in_person', photoFileId: gPhoto })).statusCode).toBe(200);
    const res = await releaseCall(fam.checkinId, { collector: { kind: 'guardian', guardianId: gId }, pickupPhotoFileId: gPhoto });
    expect(res.statusCode).toBe(404);
    await nothingReleased(fam.checkinId);
  });

  it("refuses a released sibling's pickup photo as this child's pickup photo", async () => {
    const one = await childInPark();
    const pickupPhoto = await photo(one.registrationId);
    expect((await releaseCall(one.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: pickupPhoto })).statusCode).toBe(200);
    const two = await childInPark();
    const res = await releaseCall(two.checkinId, { collector: { kind: 'dropper_off' }, pickupPhotoFileId: pickupPhoto });
    expect(res.statusCode).toBe(404);
    await nothingReleased(two.checkinId);
  });

  it('a replay with the same release id but a different collector answers the first release and writes nothing new', async () => {
    const fam = await childInPark();
    const id = newId();
    const first = await releaseCall(fam.checkinId, { id, collector: { kind: 'dropper_off' }, pickupPhotoFileId: await photo(fam.registrationId) });
    expect(first.statusCode, first.body).toBe(200);
    const replay = await releaseCall(fam.checkinId, {
      id,
      collector: { kind: 'on_the_spot', name: 'Somebody Else', photoFileId: await photo(fam.registrationId) },
      pickupPhotoFileId: await photo(fam.registrationId),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().release.collectorName).toBe('Ploy');
    expect(await ctx.db.select().from(guardian).where(eq(guardian.registrationId, fam.registrationId))).toHaveLength(0);
    expect(await ctx.db.select().from(release).where(eq(release.checkinId, fam.checkinId))).toHaveLength(1);
  });
});

describe('photo safety re-check — guardian- and release-owned photos', () => {
  it('a refused read of a guardian or release photo is 403, carries no signed url and writes no access row; an allowed read writes one', async () => {
    const fam = await childInPark();
    const collectorPhoto = await photo(fam.registrationId);
    const pickupPhoto = await photo(fam.registrationId);
    const res = await releaseCall(fam.checkinId, {
      collector: { kind: 'on_the_spot', name: 'Uncle Boon', photoFileId: collectorPhoto },
      pickupPhotoFileId: pickupPhoto,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toMatch(/X-Amz-|https?:\/\//);

    for (const fileId of [collectorPhoto, pickupPhoto]) {
      const refused = await ctx.app.inject({ method: 'GET', url: `/files/${fileId}/url`, headers: { cookie: chalongManager } });
      expect(refused.statusCode).toBe(403);
      expect(refused.body).not.toMatch(/X-Amz-|https?:\/\//);
      const reads = () =>
        ctx.db.select().from(auditLog).where(and(eq(auditLog.entityType, 'file_object'), eq(auditLog.entityId, fileId), eq(auditLog.action, 'file.read')));
      expect(await reads()).toHaveLength(0);
      const ok = await ctx.app.inject({ method: 'GET', url: `/files/${fileId}/url`, headers: { cookie: reception } });
      expect(ok.statusCode, ok.body).toBe(200);
      const rows = await reads();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.branchId).toBe(branchId);
    }
    const [g] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, collectorPhoto));
    expect(g!.ownerEntityType).toBe('guardian');
  });
});
