import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, branch, checkin, child, fileObject, member, registration, station } from '@oto/db';
import { PHOTO_REUSE_REFUSED, newId } from '@oto/shared';
import {
  CHALONG_BRANCH_CODE,
  CHALONG_MANAGER,
  RECEPTION,
  branchIdByCode,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

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
  const res = await registerRaw(kid, { registrationId, checkinId });
  expect(res.statusCode, res.body).toBe(200);
  return { registrationId, checkinId };
}

/** The gate's write as the till sends it, with what a test changes in it. */
function registerRaw(
  kid: { childId: string; memberId: string; name: string },
  ids: { registrationId: string; checkinId: string },
  options: { cookie?: string; branchId?: string; stationId?: string | null; photoReuse?: { checkinId: string; fromCheckinId: string }[] } = {},
) {
  const { registrationId, checkinId } = ids;
  return ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: options.cookie ?? reception, 'idempotency-key': newId() },
    payload: {
      id: registrationId,
      branchId: options.branchId ?? branchId,
      stationId: options.stationId === undefined ? stationId : options.stationId,
      ...(options.photoReuse ? { photoReuse: options.photoReuse } : {}),
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
}

async function attachPhoto(registrationId: string, checkinId: string, cookie = reception): Promise<string> {
  const fileId = newId();
  const file = await ctx.app.inject({
    method: 'POST',
    url: '/files',
    headers: { cookie },
    payload: { id: fileId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: registrationId, filename: 'p.jpg' },
  });
  expect(file.statusCode, file.body).toBe(200);
  const attach = await ctx.app.inject({
    method: 'POST',
    url: `/checkin/registrations/${registrationId}/photo`,
    headers: { cookie },
    payload: { fileId, checkinIds: [checkinId] },
  });
  expect(attach.statusCode, attach.body).toBe(200);
  return fileId;
}

const lastPhoto = (childId: string) =>
  ctx.app.inject({ method: 'GET', url: `/checkin/children/${childId}/last-photo?branchId=${branchId}`, headers: { cookie: reception } });
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
    // SCRUM-1053 — named in the registration's own write, the reuse is refused
    // and nothing is written (the separate reuse route is gone).
    const ids = { registrationId: newId(), checkinId: newId() };
    const res = await registerRaw(mine, ids, { photoReuse: [{ checkinId: ids.checkinId, fromCheckinId: earlier.checkinId }] });
    expect(res.statusCode).toBe(400);
    expect((JSON.parse(res.body) as { error: { code: string } }).error.code).toBe(PHOTO_REUSE_REFUSED);
    expect(await ctx.db.select().from(registration).where(eq(registration.id, ids.registrationId))).toHaveLength(0);
  });
});

/**
 * SCRUM-1018 fix round — THE REUSE IN THE REGISTRATION'S OWN WRITE. The
 * reuse once followed the registration as a separate call: when that call
 * failed (the counter box lane, a refusal, a reload) the registration stood
 * and the stay had no photo. Now the reuse rides in the write itself, and a
 * refusal refuses the registration, so nothing is written without its photo.
 */
describe("the reuse in the registration's own write", () => {
  let source: { registrationId: string; checkinId: string; fileId: string };
  const refusedCode = (res: { body: string }) => (JSON.parse(res.body) as { error: { code: string } }).error.code;
  const registrationRows = (id: string) => ctx.db.select().from(registration).where(eq(registration.id, id));

  beforeAll(async () => {
    const reg = await register(mine);
    source = { ...reg, fileId: await attachPhoto(reg.registrationId, reg.checkinId) };
  });

  it('the new stay is written holding the same stored photo, with who confirmed it', async () => {
    const ids = { registrationId: newId(), checkinId: newId() };
    const res = await registerRaw(mine, ids, { photoReuse: [{ checkinId: ids.checkinId, fromCheckinId: source.checkinId }] });
    expect(res.statusCode, res.body).toBe(200);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, ids.checkinId));
    expect(stay!.photoFileId).toBe(source.fileId);
    const [reg] = await registrationRows(ids.registrationId);
    expect(reg!.photoFileId).toBe(source.fileId);
    const rows = await reuseRows(ids.registrationId);
    expect(rows).toHaveLength(1);
    const after = rows[0]!.after as Record<string, unknown>;
    expect(after.confirmation).toBe('still_matches');
    expect(after.confirmedByAccountId).toBe(rows[0]!.actorAccountId);
    expect(after.children).toEqual([{ checkinId: ids.checkinId, photoFileId: source.fileId, reusedFromCheckinId: source.checkinId }]);
    // The photo is read through the same permission check as any stay photo.
    const url = await ctx.app.inject({ method: 'GET', url: `/files/${source.fileId}/url`, headers: { cookie: reception } });
    expect(url.statusCode, url.body).toBe(200);
    // Sent again with the same id: the registration is answered, nothing more is recorded.
    const again = await registerRaw(mine, ids, { photoReuse: [{ checkinId: ids.checkinId, fromCheckinId: source.checkinId }] });
    expect(again.statusCode, again.body).toBe(200);
    expect(await reuseRows(ids.registrationId)).toHaveLength(1);
    // The date staff are shown is the photo's own, not the newest stay's.
    const latest = (await lastPhoto(mine.childId)).json().photo as { checkinId: string; takenAt: string };
    expect(latest.checkinId).toBe(ids.checkinId);
    const [file] = await ctx.db.select().from(fileObject).where(eq(fileObject.id, source.fileId));
    expect(latest.takenAt).toBe(file!.createdAt.toISOString());
  });

  it("refused (another child's photo): nothing is written, and the refusal says to take a new photo", async () => {
    const ids = { registrationId: newId(), checkinId: newId() };
    const res = await registerRaw(theirs, ids, { photoReuse: [{ checkinId: ids.checkinId, fromCheckinId: source.checkinId }] });
    expect(res.statusCode).toBe(400);
    expect(refusedCode(res)).toBe(PHOTO_REUSE_REFUSED);
    expect(res.body).toContain('take a new photo');
    expect(await registrationRows(ids.registrationId)).toHaveLength(0);
    expect(await ctx.db.select().from(checkin).where(eq(checkin.id, ids.checkinId))).toHaveLength(0);
  });

  it("refused: another park's stay of the same child", async () => {
    const chalongId = await branchIdByCode(ctx.db, CHALONG_BRANCH_CODE);
    const chalong = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const there = { registrationId: newId(), checkinId: newId() };
    const made = await registerRaw(mine, there, { cookie: chalong, branchId: chalongId, stationId: null });
    expect(made.statusCode, made.body).toBe(200);
    await attachPhoto(there.registrationId, there.checkinId, chalong);
    const ids = { registrationId: newId(), checkinId: newId() };
    const res = await registerRaw(mine, ids, { photoReuse: [{ checkinId: ids.checkinId, fromCheckinId: there.checkinId }] });
    expect(res.statusCode).toBe(400);
    expect(refusedCode(res)).toBe(PHOTO_REUSE_REFUSED);
    expect(await registrationRows(ids.registrationId)).toHaveLength(0);
  });

  it('refused: a cancelled stay', async () => {
    const cancelled = await register(mine);
    await attachPhoto(cancelled.registrationId, cancelled.checkinId);
    const cancel = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${cancelled.registrationId}/cancel`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { reason: 'ZZ TEST went home' },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    const ids = { registrationId: newId(), checkinId: newId() };
    const res = await registerRaw(mine, ids, { photoReuse: [{ checkinId: ids.checkinId, fromCheckinId: cancelled.checkinId }] });
    expect(res.statusCode).toBe(400);
    expect(refusedCode(res)).toBe(PHOTO_REUSE_REFUSED);
    expect(await registrationRows(ids.registrationId)).toHaveLength(0);
  });

  it("names only a child on the registration", async () => {
    const ids = { registrationId: newId(), checkinId: newId() };
    const res = await registerRaw(mine, ids, { photoReuse: [{ checkinId: newId(), fromCheckinId: source.checkinId }] });
    expect(res.statusCode).toBe(400);
    expect(await registrationRows(ids.registrationId)).toHaveLength(0);
  });

  it('staff of another park are refused in the write', async () => {
    const chalong = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);
    const ids = { registrationId: newId(), checkinId: newId() };
    const res = await registerRaw(mine, ids, { cookie: chalong, photoReuse: [{ checkinId: ids.checkinId, fromCheckinId: source.checkinId }] });
    expect(res.statusCode).toBe(403);
    expect(await registrationRows(ids.registrationId)).toHaveLength(0);
  });

  it('SCRUM-1053: the separate reuse route no screen called is gone', async () => {
    const here = await register(mine);
    const separate = await ctx.app.inject({
      method: 'POST',
      url: `/checkin/registrations/${here.registrationId}/photo-reuse`,
      headers: { cookie: reception, 'idempotency-key': newId() },
      payload: { children: [{ checkinId: here.checkinId, fromCheckinId: source.checkinId }] },
    });
    expect(separate.statusCode).toBe(404);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, here.checkinId));
    expect(stay!.photoFileId).toBeNull();
  });
});
