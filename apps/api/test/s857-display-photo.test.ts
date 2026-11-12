import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { auditLog, fileObject, station } from '@oto/db';
import { newId } from '@oto/shared';
import type { FileStorage } from '../src/services/files';
import { ADMIN, RECEPTION, SECOND_OPERATOR_ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-857 — THE FAMILY TAKES THE CHILD'S PHOTO ON THE PAIRED DISPLAY.
 *
 * The display sends the picture with its own credential; the platform keeps
 * it only while the form on THAT display's station asks for that child's
 * photo, for that visitor. The till standing at the station collects it to
 * keep with the form (where a staff-taken photo is kept). Proved here: the
 * right form is accepted and recorded, a resend is the same file, another
 * sale, another child, another station, an unpaired screen, a body that is
 * not a photo or is too large are all refused, and the collection is the
 * staff session at that station only, access-logged.
 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);

describe('SCRUM-857 — the family photo from the paired display', () => {
  let proof: TestContext;
  let staffCookie: string;
  let managerCookie: string;
  let tillId: string;
  let authorization: string;
  let leaseId: string;
  const saved = new Map<string, Buffer>();
  const visitorId = newId();
  const memory: FileStorage = {
    bucket: 'test-photos',
    presignedPut: async () => 'memory://unused',
    presignedGet: async () => 'memory://unused',
    put: async (key, bytes) => { saved.set(key, Buffer.from(bytes)); },
    remove: async (key) => { saved.delete(key); },
    get: async (key) => { const bytes = saved.get(key); if (!bytes) throw new Error('missing'); return bytes; },
    probe: async () => ({ state: 'ready' }),
  };

  const pairDisplay = async (stationId: string): Promise<string> => {
    const bearer = `Bearer ${randomBytes(32).toString('hex')}`;
    const requested = await proof.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization: bearer }, payload: {} });
    expect(requested.statusCode).toBe(200);
    const claimed = await proof.app.inject({ method: 'POST', url: `/stations/${stationId}/displays/claim`,
      headers: { cookie: managerCookie }, payload: { pairingCode: requested.json().pairingCode, name: 'Photo display' } });
    expect(claimed.statusCode, claimed.body).toBe(200);
    return bearer;
  };
  const sequenceOf = async (): Promise<number> => {
    const read = await proof.app.inject({ method: 'GET', url: '/display/session', headers: { authorization } });
    return read.json().document.sequence as number;
  };
  const publish = async (prompt: Record<string, unknown> | null, step = 7) => {
    const published = await proof.app.inject({
      method: 'POST', url: `/stations/${tillId}/intents`, headers: { cookie: staffCookie },
      payload: { type: 'session.publish_display', leaseId, lastSeenSequence: await sequenceOf(), actionId: newId(),
        payload: { stage: 'input', step, cart: null, totals: null, payment: null, member: null, prompt } },
    });
    expect(published.statusCode, published.body).toBe(200);
  };
  const form = (overrides: Record<string, unknown> = {}) => ({
    kind: 'consent', requestId: newId(), visitorId,
    slots: [
      { id: 'slot-a', name: 'ZZ TEST photo child', ageYears: 5, requirement: 'drop_off', photo: 'needed' },
      { id: 'slot-b', name: 'ZZ TEST no photo', ageYears: 12, requirement: 'none' },
    ],
    guardianName: '', consentRequired: true, consentAcknowledged: false, confirmations: [],
    staffReady: false, canContinue: false, completed: false, ...overrides,
  });
  const upload = (body: Record<string, unknown>, bearer = authorization) => proof.app.inject({
    method: 'POST', url: '/display/consent-photos', headers: { authorization: bearer },
    payload: { id: newId(), visitorId, slotId: 'slot-a', contentType: 'image/jpeg', data: JPEG.toString('base64'), ...body },
  });
  const collect = (fileId: string, query: { visitorId?: string; slotId?: string } = {}, cookie = staffCookie, stationId = tillId) =>
    proof.app.inject({ method: 'GET', headers: { cookie },
      url: `/stations/${stationId}/consent-photos/${fileId}?visitorId=${encodeURIComponent(query.visitorId ?? visitorId)}&slotId=${encodeURIComponent(query.slotId ?? 'slot-a')}` });

  beforeAll(async () => {
    proof = await createTestContext();
    proof.app.fileStorage = memory;
    managerCookie = await signInAs(proof.app, ADMIN.phone, ADMIN.password);
    staffCookie = await signInAs(proof.app, RECEPTION.phone, RECEPTION.password);
    const [till] = await proof.db.select({ id: station.id }).from(station).where(eq(station.name, 'Reception Till 1')).limit(1);
    tillId = till!.id;
    expect((await proof.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie: staffCookie },
      payload: { stationId: tillId } })).statusCode).toBe(200);
    authorization = await pairDisplay(tillId);
    const lease = await proof.app.inject({ method: 'POST', url: `/stations/${tillId}/lease`,
      headers: { cookie: staffCookie }, payload: { holder: 'Photo proof', holderKind: 'till' } });
    expect(lease.statusCode, lease.body).toBe(200);
    leaseId = lease.json().lease.leaseId as string;
  });
  afterAll(async () => { await proof.close(); await teardownAll(); });

  it('keeps the photo for the form that asks for it, once, recorded, and private', async () => {
    await publish(form());
    const id = newId();
    const first = await upload({ id });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ fileId: id });
    const again = await upload({ id });
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-oto-replay']).toBe('true');
    const rows = await proof.db.select().from(fileObject).where(eq(fileObject.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerEntityType: 'display.consent_photo', ownerEntityId: tillId,
      contentType: 'image/jpeg', size: JPEG.length, uploadedByAccountId: null });
    expect(rows[0]!.objectKey).not.toContain(visitorId);
    expect(rows[0]!.objectKey).not.toContain('slot-a');
    expect([...saved.get(rows[0]!.objectKey)!]).toEqual([...JPEG]);
    const audits = await proof.db.select().from(auditLog)
      .where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'display.consent_photo')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.after).toMatchObject({ stationId: tillId, slotId: 'slot-a', size: JPEG.length });
  });

  it('refuses another sale, another child, a child with no photo asked, and a finished or absent form', async () => {
    await publish(form());
    expect((await upload({ visitorId: newId() })).json().error.code).toBe('DISPLAY_PHOTO_NOT_ASKED');
    expect((await upload({ slotId: 'slot-z' })).json().error.code).toBe('DISPLAY_PHOTO_NOT_ASKED');
    expect((await upload({ slotId: 'slot-b' })).json().error.code).toBe('DISPLAY_PHOTO_NOT_ASKED');
    const { photo: _mark, ...unmarked } = form().slots[0]!;
    await publish(form({ slots: [unmarked] }));
    expect((await upload({})).statusCode).toBe(409);
    await publish(form({ guardianName: 'ZZ TEST guardian', consentAcknowledged: true, staffReady: true, canContinue: true,
      completed: true, slots: [{ ...form().slots[0]!, photo: 'taken' }] }));
    expect((await upload({})).statusCode).toBe(409);
    await publish(null, 4);
    expect((await upload({})).statusCode).toBe(409);
  });

  it('refuses an unpaired screen, a display at another station, and a body that is not a small photo', async () => {
    await publish(form());
    expect((await upload({}, `Bearer ${randomBytes(32).toString('hex')}`)).statusCode).toBe(401);
    expect((await proof.app.inject({ method: 'POST', url: '/display/consent-photos',
      payload: { id: newId(), visitorId, slotId: 'slot-a', contentType: 'image/jpeg', data: JPEG.toString('base64') } })).statusCode).toBe(401);

    const [till] = await proof.db.select().from(station).where(eq(station.id, tillId)).limit(1);
    const otherId = newId();
    await proof.db.insert(station).values({ id: otherId, operatorId: till!.operatorId, branchId: till!.branchId,
      boxId: till!.boxId, name: 'ZZ TEST Photo Till 2', kind: 'till', codePrefix: 'Z2', capabilities: ['tickets'], accessScope: 'all_staff' });
    const elsewhere = await pairDisplay(otherId);
    expect((await upload({}, elsewhere)).json().error.code).toBe('DISPLAY_PHOTO_NOT_ASKED');

    const notImage = await upload({ data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') });
    expect(notImage.statusCode).toBe(400);
    expect((await upload({ contentType: 'image/png' })).statusCode).toBe(400);
    expect((await upload({ contentType: 'image/svg+xml' })).statusCode).toBe(400);
    const large = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(512 * 1024)]);
    expect([400, 413]).toContain((await upload({ data: large.toString('base64') })).statusCode);
    expect((await upload({ stationId: otherId })).statusCode).toBe(400);
  });

  it('is collected by the till standing at that station, for that form and child only, and access-logged', async () => {
    await publish(form());
    const id = newId();
    expect((await upload({ id })).statusCode).toBe(200);
    const collected = await collect(id);
    expect(collected.statusCode, collected.body).toBe(200);
    expect(collected.json()).toEqual({ dataUrl: `data:image/jpeg;base64,${JPEG.toString('base64')}`, contentType: 'image/jpeg' });
    const reads = await proof.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, 'file.read')));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.after).toMatchObject({ ownerEntityType: 'display.consent_photo', stationId: tillId });

    expect((await collect(id, { visitorId: newId() })).statusCode).toBe(404);
    expect((await collect(id, { slotId: 'slot-b' })).statusCode).toBe(404);
    expect((await collect(newId())).statusCode).toBe(404);
    // A manager who is not standing at this till does not collect it.
    expect((await collect(id, {}, managerCookie)).statusCode).toBe(403);
    expect((await collect(id, {}, await signInAs(proof.app, SECOND_OPERATOR_ADMIN.phone, SECOND_OPERATOR_ADMIN.password))).statusCode)
      .toBe(404);
  });
});
