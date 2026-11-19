import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, checkin, child, member, registration, station } from '@oto/db';
import { newId } from '@oto/shared';
import { RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1018 — A RETURNING CHILD'S LAST PHOTO, REUSED ON STAFF'S WORD.
 *
 * The owner's answer of 19 November: a returning family is asked only the
 * three agreement ticks, and the last visit's photo of child and guardian may
 * be reused when staff confirm it still matches. The till reads the child's
 * last stay with a photo here and names it once the registration is written.
 * These pins hold the safety of it: only this child's photo, only at this
 * park, only while the photo is still kept, the reuse recorded with who
 * confirmed it, and nothing written twice.
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
/** Two seeded children of two different families. */
let mine: { childId: string; memberId: string; name: string };
let theirs: { childId: string; memberId: string; name: string };

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const seeded = await ctx.db
    .select({ childId: child.id, memberId: child.memberId, name: child.name })
    .from(child)
    .innerJoin(member, eq(member.id, child.memberId))
    .where(and(eq(member.operatorId, hkt!.operatorId), isNull(child.archivedAt)));
  mine = seeded[0]!;
  theirs = seeded.find((c) => c.memberId !== mine.memberId)!;
  expect(theirs).toBeDefined();
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function register(kid: { childId: string; memberId: string; name: string }): Promise<{ registrationId: string; checkinId: string }> {
  const registrationId = newId();
  const checkinId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: reception },
    payload: {
      id: registrationId,
      branchId,
      stationId,
      memberId: kid.memberId,
      guardianName: 'ZZ TEST guardian',
      guardianPhone: '0898020001',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{
        checkinId,
        childId: kid.childId,
        name: kid.name,
        ageYears: 6,
        service: 'drop_off',
        allergies: null,
        foodRestrictions: null,
        foodProvision: { mode: 'none', paidSatang: 0 },
      }],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { registrationId, checkinId };
}

async function attachPhoto(registrationId: string, checkinId: string): Promise<string> {
  const fileId = newId();
  const file = await ctx.app.inject({
    method: 'POST',
    url: '/files',
    headers: { cookie: reception },
    payload: { id: fileId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: registrationId, filename: 'p.jpg' },
  });
  expect(file.statusCode, file.body).toBe(200);
  const attach = await ctx.app.inject({
    method: 'POST',
    url: `/checkin/registrations/${registrationId}/photo`,
    headers: { cookie: reception },
    payload: { fileId, checkinIds: [checkinId] },
  });
  expect(attach.statusCode, attach.body).toBe(200);
  return fileId;
}

const lastPhoto = (childId: string) =>
  ctx.app.inject({ method: 'GET', url: `/checkin/children/${childId}/last-photo?branchId=${branchId}`, headers: { cookie: reception } });
const reuse = (registrationId: string, children: { checkinId: string; fromCheckinId: string }[], key = newId()) =>
  ctx.app.inject({
    method: 'POST',
    url: `/checkin/registrations/${registrationId}/photo-reuse`,
    headers: { cookie: reception, 'idempotency-key': key },
    payload: { children },
  });
const reuseRows = (registrationId: string) =>
  ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, registrationId), eq(auditLog.action, 'registration.photo_reused')));

describe('the last photo of a returning child', () => {
  let earlier: { registrationId: string; checkinId: string; fileId: string };

  it('a child never photographed here has none', async () => {
    const res = await lastPhoto(theirs.childId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ photo: null });
  });

  it("is the child's own last stay with a photo at this park", async () => {
    const reg = await register(mine);
    const fileId = await attachPhoto(reg.registrationId, reg.checkinId);
    earlier = { ...reg, fileId };
    const res = await lastPhoto(mine.childId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().photo).toMatchObject({ checkinId: reg.checkinId, registrationId: reg.registrationId, fileId });
    // Another family's child still has none: the photo is found by the child.
    expect((await lastPhoto(theirs.childId)).json()).toEqual({ photo: null });
  });

  it('an unknown child is not found', async () => {
    const res = await lastPhoto(newId());
    expect(res.statusCode).toBe(404);
  });

  it('staff confirm it still matches: the new stay points at the same stored photo, recorded with who confirmed', async () => {
    const next = await register(mine);
    const res = await reuse(next.registrationId, [{ checkinId: next.checkinId, fromCheckinId: earlier.checkinId }]);
    expect(res.statusCode, res.body).toBe(200);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, next.checkinId));
    expect(stay!.photoFileId).toBe(earlier.fileId);
    const [reg] = await ctx.db.select().from(registration).where(eq(registration.id, next.registrationId));
    expect(reg!.photoFileId).toBe(earlier.fileId);
    const rows = await reuseRows(next.registrationId);
    expect(rows).toHaveLength(1);
    const after = rows[0]!.after as Record<string, unknown>;
    expect(after.confirmation).toBe('still_matches');
    expect(after.confirmedByAccountId).toBe(rows[0]!.actorAccountId);
    expect(after.children).toEqual([{ checkinId: next.checkinId, photoFileId: earlier.fileId, reusedFromCheckinId: earlier.checkinId }]);
    // The photo is read through the same permission check as any stay photo.
    const url = await ctx.app.inject({ method: 'GET', url: `/files/${earlier.fileId}/url`, headers: { cookie: reception } });
    expect(url.statusCode, url.body).toBe(200);
    // Pressed again: nothing more is written and nothing more is recorded.
    const again = await reuse(next.registrationId, [{ checkinId: next.checkinId, fromCheckinId: earlier.checkinId }]);
    expect(again.statusCode, again.body).toBe(200);
    expect(await reuseRows(next.registrationId)).toHaveLength(1);
  });

  it("is never put on another child's stay", async () => {
    const other = await register(theirs);
    const res = await reuse(other.registrationId, [{ checkinId: other.checkinId, fromCheckinId: earlier.checkinId }]);
    expect(res.statusCode).toBe(400);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, other.checkinId));
    expect(stay!.photoFileId).toBeNull();
    expect(await reuseRows(other.registrationId)).toHaveLength(0);
  });

  it('a stay that already holds a photo keeps it', async () => {
    const next = await register(mine);
    const own = await attachPhoto(next.registrationId, next.checkinId);
    const res = await reuse(next.registrationId, [{ checkinId: next.checkinId, fromCheckinId: earlier.checkinId }]);
    expect(res.statusCode, res.body).toBe(200);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, next.checkinId));
    expect(stay!.photoFileId).toBe(own);
    expect(await reuseRows(next.registrationId)).toHaveLength(0);
  });

  it('past the retention date the photo is not offered and not reused', async () => {
    // Every registration that owns one of this child's photos is past its date.
    await ctx.db.update(registration).set({ retentionUntil: new Date(Date.now() - 60_000) })
      .where(eq(registration.id, earlier.registrationId));
    const latest = (await lastPhoto(mine.childId)).json().photo as { registrationId: string } | null;
    if (latest) {
      await ctx.db.update(registration).set({ retentionUntil: new Date(Date.now() - 60_000) })
        .where(eq(registration.id, latest.registrationId));
    }
    expect((await lastPhoto(mine.childId)).json()).toEqual({ photo: null });
    const next = await register(mine);
    const res = await reuse(next.registrationId, [{ checkinId: next.checkinId, fromCheckinId: earlier.checkinId }]);
    expect(res.statusCode).toBe(400);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, next.checkinId));
    expect(stay!.photoFileId).toBeNull();
  });
});
