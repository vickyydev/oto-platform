import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { auditLog, deviceCredential, fileObject, station } from '@oto/db';
import { newId, STATION_DISPLAY_LIMIT } from '@oto/shared';
import type { FileStorage } from '../src/services/files';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-1041 — MORE THAN ONE CUSTOMER DISPLAY ON A TILL (the owner's answer
 * of 19 November: "build it now").
 *
 * A till pairs up to three displays; a fourth is refused in plain words. Each
 * display reads the one document the station holds, so every one shows the
 * same sale, prompts and form. An answer pressed on one is taken once: the
 * station keeps one answer at a time, refuses a second made at the same
 * moment, and every display reads the one it kept. Revoking one display ends
 * that display alone. Pairing, the list and revocation keep their guards and
 * their audit rows.
 */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]);

describe('SCRUM-1041 — up to three customer displays on one till', () => {
  let proof: TestContext;
  let managerCookie: string;
  let staffCookie: string;
  let tillId: string;
  let leaseId: string;
  const saved = new Map<string, Buffer>();
  const memory: FileStorage = {
    bucket: 'test-photos',
    presignedPut: async () => 'memory://unused',
    presignedGet: async () => 'memory://unused',
    put: async (key, bytes) => { saved.set(key, Buffer.from(bytes)); },
    remove: async (key) => { saved.delete(key); },
    get: async (key) => { const bytes = saved.get(key); if (!bytes) throw new Error('missing'); return bytes; },
    probe: async () => ({ state: 'ready' }),
  };
  const bearer = () => `Bearer ${randomBytes(32).toString('hex')}`;
  const mint = (authorization: string) => proof.app.inject({ method: 'POST', url: '/display/pairing', headers: { authorization }, payload: {} });
  const claim = (pairingCode: string, name: string, cookie = managerCookie) => proof.app.inject({
    method: 'POST', url: `/stations/${tillId}/displays/claim`, headers: { cookie }, payload: { pairingCode, name },
  });
  const pair = async (name: string) => {
    const authorization = bearer();
    const requested = await mint(authorization);
    expect(requested.statusCode).toBe(200);
    const claimed = await claim(requested.json().pairingCode as string, name);
    expect(claimed.statusCode, claimed.body).toBe(200);
    return { authorization, deviceId: claimed.json().device.id as string, name };
  };
  const session = (authorization: string) => proof.app.inject({ method: 'GET', url: '/display/session', headers: { authorization } });
  const documentOf = async (authorization: string) => {
    const read = await session(authorization);
    expect(read.statusCode, read.body).toBe(200);
    return read.json().document as { sequence: number; language: string; prompt: Record<string, unknown> | null };
  };
  const revoke = (deviceId: string, cookie = managerCookie) => proof.app.inject({
    method: 'POST', url: `/credentials/${deviceId}/revoke`, headers: { cookie }, payload: { reason: 'ZZ TEST display removed' },
  });
  const list = () => proof.app.inject({ method: 'GET', url: `/stations/${tillId}/displays`, headers: { cookie: staffCookie } });
  const activeDisplays = () => proof.db.select({ id: deviceCredential.id }).from(deviceCredential).where(and(
    eq(deviceCredential.stationId, tillId), eq(deviceCredential.kind, 'display'),
    isNull(deviceCredential.revokedAt), isNotNull(deviceCredential.pairedAt), isNotNull(deviceCredential.secretHash),
  ));
  const clearDisplays = () => proof.db.update(deviceCredential).set({ revokedAt: new Date(), secretHash: null }).where(and(
    eq(deviceCredential.stationId, tillId), eq(deviceCredential.kind, 'display'), isNull(deviceCredential.revokedAt),
  ));
  const publish = async (authorization: string, prompt: Record<string, unknown> | null, step = 7) => {
    const published = await proof.app.inject({
      method: 'POST', url: `/stations/${tillId}/intents`, headers: { cookie: staffCookie },
      payload: { type: 'session.publish_display', leaseId, lastSeenSequence: (await documentOf(authorization)).sequence,
        actionId: newId(), payload: { stage: 'input', step, cart: null, totals: null, payment: null, member: null, prompt } },
    });
    expect(published.statusCode, published.body).toBe(200);
  };
  const form = (visitorId: string, overrides: Record<string, unknown> = {}) => ({
    kind: 'consent', requestId: newId(), visitorId,
    slots: [{ id: 'slot-a', name: 'ZZ TEST child', ageYears: 5, requirement: 'drop_off', photo: 'needed' }],
    guardianName: '', consentRequired: true, consentAcknowledged: false, confirmations: [],
    staffReady: false, canContinue: false, completed: false, ...overrides,
  });
  const fill = (prompt: { requestId: string; visitorId: string }, guardianName: string) => ({
    requestId: prompt.requestId, visitorId: prompt.visitorId, action: 'fill',
    slots: [{ id: 'slot-a', name: 'ZZ TEST child', dateOfBirth: null, ageYears: 5, allergiesMedical: '', foodRestrictions: '' }],
    guardianName, consentAcknowledged: false, acknowledgedConfirmationIds: [],
  });
  const answer = (authorization: string, payload: Record<string, unknown>, lastSeenSequence: number, actionId = newId()) =>
    proof.app.inject({ method: 'POST', url: '/display/intents', headers: { authorization },
      payload: { type: 'display.consent', actionId, lastSeenSequence, payload } });

  beforeAll(async () => {
    proof = await createTestContext();
    proof.app.fileStorage = memory;
    managerCookie = await signInAs(proof.app, ADMIN.phone, ADMIN.password);
    staffCookie = await signInAs(proof.app, RECEPTION.phone, RECEPTION.password);
    const [till] = await proof.db.select({ id: station.id }).from(station).where(eq(station.name, 'Reception Till 1')).limit(1);
    tillId = till!.id;
    expect((await proof.app.inject({ method: 'PUT', url: '/me/session/station', headers: { cookie: staffCookie },
      payload: { stationId: tillId } })).statusCode).toBe(200);
    const lease = await proof.app.inject({ method: 'POST', url: `/stations/${tillId}/lease`,
      headers: { cookie: staffCookie }, payload: { holder: 'Multi-display proof', holderKind: 'till' } });
    expect(lease.statusCode, lease.body).toBe(200);
    leaseId = lease.json().lease.leaseId as string;
  });
  afterAll(async () => { await proof.close(); await teardownAll(); });

  it('pairs three displays, refuses a fourth in plain words, and records each pairing', async () => {
    await clearDisplays();
    expect(STATION_DISPLAY_LIMIT).toBe(3);
    const paired = [];
    for (const name of ['ZZ TEST counter left', 'ZZ TEST counter right', 'ZZ TEST tablet']) paired.push(await pair(name));
    expect(await activeDisplays()).toHaveLength(3);

    const fourth = bearer();
    const requested = await mint(fourth);
    const refused = await claim(requested.json().pairingCode as string, 'ZZ TEST fourth');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({ code: 'DISPLAY_STATION_OCCUPIED',
      message: 'This station already has three displays. Revoke one before pairing another' });
    expect((await proof.app.inject({ method: 'GET', url: '/display/pairing', headers: { authorization: fourth } })).json())
      .toEqual({ status: 'pending' });
    // The older way of minting a display credential keeps the same limit.
    const legacy = await proof.app.inject({ method: 'POST', url: `/stations/${tillId}/credentials`,
      headers: { cookie: managerCookie }, payload: { kind: 'display', label: 'ZZ TEST legacy display' } });
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().error.code).toBe('DISPLAY_STATION_OCCUPIED');
    expect(await activeDisplays()).toHaveLength(3);

    for (const display of paired) {
      const audits = await proof.db.select().from(auditLog)
        .where(and(eq(auditLog.action, 'display.paired'), eq(auditLog.entityId, display.deviceId)));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.after).toMatchObject({ stationId: tillId, name: display.name });
    }
    // The till standing here lists each one, by name, in the order they were paired, with when each was seen.
    const listed = await list();
    expect(listed.statusCode, listed.body).toBe(200);
    const rows = listed.json().displays as { id: string; name: string; lastSeenAt: string | null; connected: boolean }[];
    expect(rows.map((row) => [row.id, row.name])).toEqual(paired.map((display) => [display.deviceId, display.name]));
    expect(rows.every((row) => typeof row.lastSeenAt === 'string' && row.connected)).toBe(true);
  });

  it('shows the same sale on every display; an answer from one is taken once and shows on the others', async () => {
    await clearDisplays();
    const displays = [await pair('ZZ TEST left'), await pair('ZZ TEST right')];
    const visitorId = newId();
    await publish(displays[0]!.authorization, form(visitorId));
    const [left, right] = await Promise.all(displays.map((display) => documentOf(display.authorization)));
    expect(right).toEqual(left);
    const prompt = left!.prompt as { requestId: string; visitorId: string };

    // Both families press at the same moment, on the same copy of the form.
    const fromLeft = fill(prompt, 'ZZ TEST guardian left');
    const leftAnswer = await answer(displays[0]!.authorization, fromLeft, left!.sequence, 'left-fill');
    expect(leftAnswer.statusCode, leftAnswer.body).toBe(200);
    const rightAnswer = await answer(displays[1]!.authorization, fill(prompt, 'ZZ TEST guardian right'), right!.sequence, 'right-fill');
    expect(rightAnswer.statusCode).toBe(403);
    expect(rightAnswer.json().error.message).toBe('The till is still handling the acknowledgement already sent.');

    // Each display reads the one answer the station kept: the till takes it once, by its action id.
    const after = await Promise.all(displays.map((display) => documentOf(display.authorization)));
    for (const document of after) {
      expect(document.prompt?.answer).toEqual({ type: 'consent', actionId: 'left-fill', payload: fromLeft });
    }
    expect(after[1]).toEqual(after[0]);

    // The till lays the answer into its form and publishes it: every display shows the guardian's name.
    await publish(displays[0]!.authorization, form(visitorId, { guardianName: 'ZZ TEST guardian left' }));
    const mirrored = await Promise.all(displays.map((display) => documentOf(display.authorization)));
    expect(mirrored.map((document) => document.prompt?.guardianName)).toEqual(['ZZ TEST guardian left', 'ZZ TEST guardian left']);
    expect(mirrored[0]!.prompt?.answer).toBeUndefined();

    // The language chosen on one display is the station's, read by every display.
    const chosen = await proof.app.inject({ method: 'POST', url: '/display/intents', headers: { authorization: displays[1]!.authorization },
      payload: { type: 'display.set_language', actionId: newId(), lastSeenSequence: mirrored[1]!.sequence, payload: { language: 'th' } } });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect((await Promise.all(displays.map((display) => documentOf(display.authorization)))).map((document) => document.language))
      .toEqual(['th', 'th']);
  });

  it('takes the child\'s photo from whichever display the family uses, for the one form of the station', async () => {
    await clearDisplays();
    const displays = [await pair('ZZ TEST left'), await pair('ZZ TEST right')];
    const visitorId = newId();
    await publish(displays[0]!.authorization, form(visitorId));
    const id = newId();
    const stored = await proof.app.inject({ method: 'POST', url: '/display/consent-photos', headers: { authorization: displays[1]!.authorization },
      payload: { id, visitorId, slotId: 'slot-a', contentType: 'image/jpeg', data: JPEG.toString('base64') } });
    expect(stored.statusCode, stored.body).toBe(200);
    const [row] = await proof.db.select().from(fileObject).where(eq(fileObject.id, id));
    // Kept for the station's form, not for the display that took it.
    expect(row).toMatchObject({ ownerEntityType: 'display.consent_photo', ownerEntityId: tillId });
    const collected = await proof.app.inject({ method: 'GET', headers: { cookie: staffCookie },
      url: `/stations/${tillId}/consent-photos/${id}?visitorId=${encodeURIComponent(visitorId)}&slotId=slot-a` });
    expect(collected.statusCode, collected.body).toBe(200);
    // Named to the till by one display, the other display's form reads it as taken once the till says so.
    const document = await documentOf(displays[1]!.authorization);
    const named = await answer(displays[1]!.authorization, { requestId: (document.prompt as { requestId: string }).requestId,
      visitorId, action: 'photo', slotId: 'slot-a', fileId: id }, document.sequence, 'photo-right');
    expect(named.statusCode, named.body).toBe(200);
    await publish(displays[0]!.authorization, form(visitorId, { slots: [{ ...form(visitorId).slots[0]!, photo: 'taken' }] }));
    const shown = await Promise.all(displays.map((display) => documentOf(display.authorization)));
    expect(shown.map((value) => (value.prompt?.slots as { photo: string }[])[0]!.photo)).toEqual(['taken', 'taken']);
  });

  it('revokes one display alone: the others stay paired and showing, and a free place pairs again', async () => {
    await clearDisplays();
    const displays = [await pair('ZZ TEST left'), await pair('ZZ TEST right'), await pair('ZZ TEST tablet')];
    // Reception may read the list at its till, but removing and pairing stay with a manager.
    expect((await revoke(displays[0]!.deviceId, staffCookie)).statusCode).toBe(403);
    const staffClaim = await claim((await mint(bearer())).json().pairingCode as string, 'ZZ TEST staff', staffCookie);
    expect(staffClaim.statusCode).toBe(403);

    expect((await revoke(displays[0]!.deviceId)).statusCode).toBe(200);
    expect((await revoke(displays[0]!.deviceId)).statusCode).toBe(409);
    expect((await session(displays[0]!.authorization)).statusCode).toBe(401);
    expect((await session(displays[1]!.authorization)).statusCode).toBe(200);
    expect((await session(displays[2]!.authorization)).statusCode).toBe(200);
    expect(await proof.db.select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.action, 'display.revoked'), eq(auditLog.entityId, displays[0]!.deviceId),
    ))).toHaveLength(1);
    expect(((await list()).json().displays as { id: string }[]).map((row) => row.id))
      .toEqual([displays[1]!.deviceId, displays[2]!.deviceId]);
    // The place it left is free for another display.
    const replacement = await pair('ZZ TEST replacement');
    expect(((await list()).json().displays as { id: string }[]).map((row) => row.id))
      .toEqual([displays[1]!.deviceId, displays[2]!.deviceId, replacement.deviceId]);
  });
});
