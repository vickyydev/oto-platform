import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alert,
  auditLog,
  band,
  checkin,
  fileObject,
  registration,
  release,
  sale,
  station,
  syncQuarantine,
  ticketPackage,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type BoxAgent,
  type CredentialStore,
  type UploadCrashPoint,
} from '@oto/box-agent';
import { CHECKIN_FACTS, bandShortCode, newId } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import type { FileStorage } from '../src/services/files';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-13 ROUND 4 — THE CLOSING AUDIT: A CHILD'S WHOLE STAY WITH THE LINK DOWN.
 *
 * The platform and a counter box (`createBoxAgent`, the code a Pi runs, over
 * the `edge` schema as the virtual box runs), joined by a link this file cuts.
 * With the link down, through the box's station bridge, exactly as a till on
 * the box lane drives it:
 *
 *   register (consent and the combined photo, kept on the box) → pay on the
 *   box (cash; the drop-off child's band is LEFT for check-in, as online) →
 *   "Check in now" (the band minted with the park's key and printed on the
 *   box) → an edit on the board → a release with a live pickup photo;
 *
 * with the box RESTARTED in the middle and the upload worker's power pulled
 * TWICE. Then the link comes back: every fact files once, the photos upload
 * and link exactly once, a replay of the whole batch writes nothing, and a
 * release that conflicts with one recorded online meanwhile is quarantined
 * with a critical alert — never applied blind.
 */

const keys = generateKeyPairSync('ed25519');
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let cookie: string;
/** A second till, at Counter 2 on the other virtual box, which keeps its internet. */
let cookieB: string;
let counterId: string;
let tillId: string;
let branchId: string;
let packageId: string;
let boxId: string;
let agent: BoxAgent;
let credentials: CredentialStore;
let photoDir: string;
const link: CuttableLink = { cut: false };

/** What object storage holds, by presigned URL. */
const objects = new Map<string, Uint8Array>();
let puts = 0;
/** The upload worker's power lead: the steps it is pulled at, once each. */
const pulls: UploadCrashPoint[] = [];

const fakeStorage: FileStorage = {
  bucket: 'oto-files-test',
  presignedPut: async (objectKey) => `memory://oto-files-test/${objectKey}`,
  presignedGet: async (objectKey) => `memory://oto-files-test/${objectKey}?get`,
  probe: async () => ({ state: 'ready' }),
};

function makeAgent(): BoxAgent {
  return createBoxAgent({
    apiBaseUrl: 'http://checkin-box.test',
    credentials,
    hostname: 'checkin-box',
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { timeouts: { saleMs: 300, probeMs: 300 } },
    bands: { key: currentBandKey },
    photos: {
      enabled: true,
      dir: photoDir,
      put: async (url, bytes) => {
        if (link.cut) throw new Error('ECONNRESET');
        puts += 1;
        objects.set(url, bytes);
        return 200;
      },
      crashPoint: (point) => {
        if (pulls[0] === point) {
          pulls.shift();
          throw new Error(`the power went at ${point}`);
        }
      },
    },
  });
}

/** A restart: the process goes, the store and the photo directory stay. */
async function restartBox(): Promise<void> {
  agent.stop();
  detachInProcessBox(agent);
  agent = makeAgent();
  expect(await agent.prepare()).toBe(true);
  attachInProcessBox(agent);
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, as = cookie) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: as },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

async function onBox(type: string, payload: Record<string, unknown>, actionId = `ck-${newId().slice(-12)}`) {
  return call('POST', `/box/v1/station/${tillId}/intents`, { type, lastSeenSequence: 0, payload, actionId });
}

/** A photo as the till's camera hands it: JPEG bytes in a data URL. */
function jpeg(seed: number, size = 4_000): string {
  const bytes = Buffer.alloc(size, seed);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state !== 'pushed') break;
  }
}

async function openQuarantine() {
  return ctx.db
    .select()
    .from(syncQuarantine)
    .where(and(eq(syncQuarantine.boxId, agent.state.boxId!), eq(syncQuarantine.status, 'open')));
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      OPS_TEST_CONTROLS: 'true',
      STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
  });
  (ctx.app as unknown as { fileStorage: FileStorage }).fileStorage = fakeStorage;
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box = await boxBySlot(ctx.db, 'virtual-1');
  boxId = box.id;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  branchId = till!.branchId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  cookieB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box2 = await boxBySlot(ctx.db, 'virtual-2');
  const [counter] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box2.id), eq(station.name, 'Counter 2')));
  counterId = counter!.id;
  const atCounter = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/station',
    headers: { cookie: cookieB },
    payload: { stationId: counterId },
  });
  expect(atCounter.statusCode).toBe(200);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  photoDir = mkdtempSync(join(tmpdir(), 'oto-checkin-photos-'));
  credentials = memoryCredentialStore();
  agent = makeAgent();
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx.close();
  await teardownAll();
  rmSync(photoDir, { recursive: true, force: true });
});

/** The drop-off child's cart line, as the till sends it: the stay's id, its fee chosen. */
function dropOffCart(checkinId: string, expectedTotalSatang?: number) {
  return {
    lines: [
      {
        id: checkinId,
        packageId,
        kids: 1,
        adults: 0,
        serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
      },
    ],
    ...(expectedTotalSatang !== undefined ? { expectedTotalSatang } : {}),
  };
}

describe('a drop-off child’s whole stay with the link down (S2-13 round 4)', () => {
  const registrationId = newId();
  const checkinId = newId();
  const saleId = newId();
  const consentPhoto = newId();
  const pickupPhoto = newId();
  const releaseId = newId();
  let bandId: string;
  let shortCode: string | null;

  it('the gate answers from the box: consent and the photo kept on the box, one registration however often it is pressed', async () => {
    // The cache tick pulls the board with everything else.
    await agent.syncCache();
    await agent.setOffline(true, { reason: 'offline check-in' });
    link.cut = true;
    // The platform is out of reach: the till works through its box.
    const config = await onBox('checkin.config', {});
    expect(config.statusCode, JSON.stringify(config.body)).toBe(200);
    expect(config.body.result.policy.bands.length).toBeGreaterThan(0);

    const photo = await onBox('photo.capture', {
      photoId: consentPhoto,
      registrationId,
      purpose: 'consent',
      dataUrl: jpeg(7),
    });
    expect(photo.statusCode, JSON.stringify(photo.body)).toBe(200);
    expect(photo.body.result).toMatchObject({ photoId: consentPhoto, pendingUpload: true });

    // A gate that skipped consent is refused in the counter's words.
    const noConsent = await onBox('checkin.create', {
      registrationId: newId(),
      guardianName: 'Ploy',
      consentAcknowledged: false,
      acknowledgedConfirmationIds: [],
      children: [{ checkinId: newId(), name: 'Mint', ageYears: 6, service: 'drop_off' }],
    });
    expect(noConsent.statusCode).toBe(409);
    expect(noConsent.body.error.code).toBe('CONSENT_REQUIRED');
    expect(noConsent.body.error.message).toContain('finish the form on the customer screen');

    const body = {
      registrationId,
      guardianName: 'Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{ checkinId, name: 'Mint', ageYears: 6, service: 'drop_off', allergies: null }],
      photoId: consentPhoto,
    };
    const created = await onBox('checkin.create', body);
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    expect(created.body.result.registration.children).toEqual([
      expect.objectContaining({ id: checkinId, status: 'registered', service: 'drop_off' }),
    ]);
    // The same press again — a till retrying through a lost answer.
    const again = await onBox('checkin.create', body);
    expect(again.body.result.replayed).toBe(true);
    const awaiting = await onBox('checkin.awaiting', {});
    expect(awaiting.body.result.registrations.map((r: { id: string }) => r.id)).toContain(registrationId);
  });

  it('pays on the box (the supervised band is left for check-in), then "Check in now" mints and prints it — once, across a restart', async () => {
    const quote = await onBox('cart.quote', dropOffCart(checkinId));
    expect(quote.statusCode, JSON.stringify(quote.body)).toBe(200);
    const gross = quote.body.result.quote.totals.grossSatang as number;
    const paid = await onBox('sale.finalise', {
      saleId,
      actionId: `pay-${saleId.slice(-8)}`,
      staffName: 'Nok',
      cart: dropOffCart(checkinId, gross),
      tender: { actionId: `cash-${saleId.slice(-8)}`, method: 'cash', kind: 'cash', amountSatang: gross, tenderedSatang: gross },
    });
    expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
    // Finalisation leaves the drop-off child's band alone, as the platform's does.
    expect(paid.body.result.bands).toEqual([]);

    // The box restarts between the payment and the press.
    await restartBox();

    const press = { event: 'check_in_now', saleId, entries: [{ checkinId }], staffName: 'Nok' };
    const now = await onBox('checkin.update', press);
    expect(now.statusCode, JSON.stringify(now.body)).toBe(200);
    expect(now.body.result.children[0]).toMatchObject({ id: checkinId, status: 'in_park', saleId });
    expect(now.body.result.bands).toHaveLength(1);
    bandId = now.body.result.bands[0].id;
    shortCode = now.body.result.bands[0].shortCode;
    expect(shortCode).toMatch(/^T1-/);
    expect(now.body.result.printJobs.map((j: { kind: string }) => j.kind)).toEqual(['kids_wristband']);

    // Pressed again: answered from the box, no second band.
    const twice = await onBox('checkin.update', press);
    expect(twice.statusCode).toBe(200);
    expect(twice.body.result.replay).toBe(true);
    expect(twice.body.result.bands[0].id).toBe(bandId);
  });

  it('the board answers from the box: an audited edit, and a refusal in the counter’s words', async () => {
    const edit = await onBox('checkin.update', { event: 'edit', checkinId, fields: { allergies: 'Peanuts' } });
    expect(edit.statusCode, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.result).toMatchObject({ changed: 1, checkin: { allergies: 'Peanuts' } });
    const board = await onBox('checkin.board', {});
    const family = board.body.result.families.find((f: { registrationId: string }) => f.registrationId === registrationId);
    expect(family.tab).toBe('in_park');
    expect(family.children[0]).toMatchObject({ status: 'in_park', allergies: 'Peanuts', bandId });

    // A release with no pickup photo is refused, as R-92 refuses it online.
    const noPhoto = await onBox('release.create', { releaseId: newId(), checkinId, collector: { kind: 'dropper_off' } });
    expect(noPhoto.statusCode).toBe(400);
    expect(noPhoto.body.error).toMatchObject({ code: 'PICKUP_PHOTO_REQUIRED', message: 'Take the pickup photo before releasing the child.' });
    // An unlisted collector likewise.
    const pickup = await onBox('photo.capture', { photoId: pickupPhoto, registrationId, purpose: 'pickup', dataUrl: jpeg(9) });
    expect(pickup.statusCode, JSON.stringify(pickup.body)).toBe(200);
    const stranger = await onBox('release.create', {
      releaseId: newId(),
      checkinId,
      collector: { kind: 'guardian', guardianId: newId() },
      pickupPhotoId: pickupPhoto,
    });
    expect(stranger.statusCode).toBe(409);
    expect(stranger.body.error.code).toBe('COLLECTOR_NOT_LISTED');
  });

  it('releases with the live pickup photo kept on the box — once, across a second restart', async () => {
    const context = await onBox('release.context', { checkinId });
    expect(context.statusCode).toBe(200);
    expect(context.body.result.pickups[0]).toMatchObject({ id: 'dropper_off', name: 'Ploy' });

    const body = { releaseId, checkinId, collector: { kind: 'dropper_off' }, pickupPhotoId: pickupPhoto };
    const released = await onBox('release.create', body);
    expect(released.statusCode, JSON.stringify(released.body)).toBe(200);
    expect(released.body.result.release).toMatchObject({ id: releaseId, collectorName: 'Ploy', pickupPhotoFileId: pickupPhoto });

    await restartBox();
    const again = await onBox('release.create', body);
    expect(again.body.result.replay).toBe(true);
    const other = await onBox('release.create', { ...body, releaseId: newId() });
    expect(other.statusCode).toBe(409);
    expect(other.body.error.message).toBe('Mint was already collected by Ploy.');

    // Nothing has reached the ledger yet.
    expect(await ctx.db.select().from(registration).where(eq(registration.id, registrationId))).toEqual([]);
  });

  it('the link comes back: every fact files once, as the online path shapes it', async () => {
    link.cut = false;
    await agent.setOffline(false);
    await flushAll();
    expect((await openQuarantine()).map((q) => q.errorCode)).toEqual([]);

    const [reg] = await ctx.db.select().from(registration).where(eq(registration.id, registrationId));
    expect(reg).toMatchObject({ guardianName: 'Ploy', guardianPhone: '+66812345678', branchId });
    expect(reg!.consentRecordedAt).not.toBeNull();
    expect(reg!.acknowledgedConfirmations.map((c) => c.itemId).sort()).toEqual([...ALL_CONFIRMATIONS].sort());
    expect(reg!.photoFileId).toBeNull(); // still on the box

    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay).toMatchObject({ status: 'out', saleId, bandId, allergies: 'Peanuts', offline: true, scheduledFor: null });
    expect(stay!.checkedInAt).not.toBeNull();
    expect(stay!.checkedOutAt).not.toBeNull();

    const [filedSale] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    expect(filedSale).toMatchObject({ status: 'finalised', origin: 'box' });
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    expect(bands.map((b) => b.id)).toEqual([bandId]);
    expect(bandShortCode(bands[0]!.code)).toBe(shortCode);

    const [rel] = await ctx.db.select().from(release).where(eq(release.checkinId, checkinId));
    expect(rel).toMatchObject({ id: releaseId, offline: true, photoPendingUpload: true, pickupPhotoFileId: null, collectorName: 'Ploy' });

    // The audit trail: each row once, named by the event it came from.
    const trail = await ctx.db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.entityId, [registrationId, checkinId, releaseId]));
    const actions = trail.map((a) => a.action).sort();
    expect(actions).toEqual(
      ['checkin.create', 'checkin.update', 'checkin.update', 'checkin.update', 'registration.create', 'release.create'].sort(),
    );
    expect(trail.every((a) => !!a.sourceEventId)).toBe(true);
    const checkedIn = trail.find((a) => a.action === 'checkin.update' && (a.after as { event?: string }).event === 'check_in_now');
    expect(checkedIn!.after).toMatchObject({ status: 'in_park', scheduledFor: null, offline: true, boxId });
  });

  it('the photos go up and link EXACTLY ONCE, through a worker that loses its power twice', async () => {
    // The first photo's worker loses power after the PUT, the second's after
    // the link: each next pass picks up from the step it had not recorded.
    pulls.push('after_put', 'after_link');
    let passes = 0;
    for (; passes < 6; passes += 1) {
      await agent.uploadPhotos();
      const meta = await agent.photoStore()!.list();
      if (meta.length > 0 && meta.every((m) => !!m.linkedAt)) break;
      // The backoff a failed pass sets is the next tick's business; this is the next tick.
      for (const m of meta) if (m.nextAttemptAt) await agent.photoStore()!.update(m.id, { nextAttemptAt: null });
    }
    expect(pulls, 'both power cuts happened').toEqual([]);
    expect(passes).toBeGreaterThan(0);
    const [rel] = await ctx.db.select().from(release).where(eq(release.id, releaseId));
    expect(rel).toMatchObject({ pickupPhotoFileId: pickupPhoto, photoPendingUpload: false });
    const [reg] = await ctx.db.select().from(registration).where(eq(registration.id, registrationId));
    expect(reg!.photoFileId).toBe(consentPhoto);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay!.photoFileId).toBe(consentPhoto);

    // One file each, one link each — however many passes it took.
    const files = await ctx.db.select().from(fileObject).where(inArray(fileObject.id, [consentPhoto, pickupPhoto]));
    expect(files.map((f) => [f.id, f.ownerEntityType]).sort()).toEqual(
      [
        [consentPhoto, 'registration'],
        [pickupPhoto, 'release'],
      ].sort(),
    );
    const links = await ctx.db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.action, ['release.photo_linked', 'registration.photo_linked']));
    expect(links.filter((a) => a.entityId === releaseId)).toHaveLength(1);
    expect(links.filter((a) => a.entityId === registrationId)).toHaveLength(1);
    expect(objects.size).toBe(2);
    const meta = await agent.photoStore()!.list();
    expect(meta.every((m) => !!m.linkedAt)).toBe(true);
    // Purged a week after the link, not before.
    expect(await agent.photoStore()!.purge(new Date(Date.now() + 6 * 86_400_000))).toBe(0);
    expect(await agent.photoStore()!.purge(new Date(Date.now() + 8 * 86_400_000))).toBe(2);
  });

  it('a replay of the whole batch, and the same fact under a new envelope, write nothing twice', async () => {
    const before = await ctx.db.select().from(auditLog).where(inArray(auditLog.entityId, [registrationId, checkinId, releaseId]));
    expect(await agent.outbox()!.replayLastBatch(50)).toBeGreaterThan(0);
    await flushAll();
    await agent.outbox()!.queue({
      type: CHECKIN_FACTS.release,
      stationId: tillId,
      actorKind: 'account',
      actorAccountId: before.find((a) => a.action === 'release.create')!.actorAccountId,
      actionId: `replay-${newId().slice(-8)}`,
      payload: {
        releaseId,
        checkinId,
        registrationId,
        collector: { kind: 'dropper_off' },
        collectorName: 'Ploy',
        pickupPhotoId: pickupPhoto,
        releasedAt: new Date().toISOString(),
        prepaid: null,
      },
    });
    await flushAll();
    expect((await openQuarantine()).map((q) => q.errorCode)).toEqual([]);
    const after = await ctx.db.select().from(auditLog).where(inArray(auditLog.entityId, [registrationId, checkinId, releaseId]));
    expect(after.length).toBe(before.length);
    expect(await ctx.db.select().from(release).where(eq(release.checkinId, checkinId))).toHaveLength(1);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, saleId))).toHaveLength(1);
    expect(await ctx.db.select().from(checkin).where(eq(checkin.registrationId, registrationId))).toHaveLength(1);
  });
});

describe('a release that conflicts with one recorded online meanwhile', () => {
  it('is quarantined with a critical alert naming both — never applied blind', async () => {
    // A family checked in ONLINE; the box takes its copy.
    const registrationId = newId();
    const checkinId = newId();
    const saleId = newId();
    const reg = await call('POST', '/checkin/registrations', {
      id: registrationId,
      branchId,
      stationId: tillId,
      guardianName: 'Fah',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{ checkinId, name: 'Ton', ageYears: 7, service: 'drop_off' }],
    });
    expect(reg.statusCode, JSON.stringify(reg.body)).toBe(200);
    expect((await call('POST', '/sales', { id: saleId, stationId: tillId, ...dropOffCart(checkinId) })).statusCode).toBe(200);
    expect((await call('POST', `/sales/${saleId}/finalise`, {})).statusCode).toBe(200);
    const now = await call('POST', '/checkin/check-in-now', { saleId, entries: [{ checkinId }] });
    expect(now.statusCode, JSON.stringify(now.body)).toBe(200);
    expect(await agent.syncCheckin()).toBe(true);

    // The link drops; the box releases Ton to Fah.
    await agent.setOffline(true, { reason: 'offline release' });
    link.cut = true;
    const photoId = newId();
    expect(
      (await onBox('photo.capture', { photoId, registrationId, purpose: 'pickup', dataUrl: jpeg(3) })).statusCode,
    ).toBe(200);
    const offlineRelease = newId();
    const atBox = await onBox('release.create', {
      releaseId: offlineRelease,
      checkinId,
      collector: { kind: 'dropper_off' },
      pickupPhotoId: photoId,
    });
    expect(atBox.statusCode, JSON.stringify(atBox.body)).toBe(200);

    // Meanwhile, at Counter 2 — another box, with the internet — Ton is released too.
    const fileId = newId();
    const registered = await call(
      'POST',
      '/files',
      { id: fileId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: registrationId, filename: 'pickup.jpg' },
      cookieB,
    );
    expect(registered.statusCode, JSON.stringify(registered.body)).toBe(200);
    const online = await call(
      'POST',
      `/checkin/pickups/stays/${checkinId}/release`,
      { id: newId(), collector: { kind: 'dropper_off' }, pickupPhotoFileId: fileId, stationId: counterId },
      cookieB,
    );
    expect(online.statusCode, JSON.stringify(online.body)).toBe(200);

    // The first box's link comes back.
    link.cut = false;
    await agent.setOffline(false);
    await flushAll();
    const held = (await openQuarantine()).filter((q) => q.errorCode === 'SYNC_RELEASE_CONFLICT');
    expect(held).toHaveLength(1);
    expect(held[0]!.reason).toBe('conflict');
    expect(held[0]!.type).toBe(CHECKIN_FACTS.release);
    expect(await ctx.db.select().from(release).where(eq(release.checkinId, checkinId))).toHaveLength(1);
    expect(await ctx.db.select().from(release).where(eq(release.id, offlineRelease))).toEqual([]);
    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `checkin.released_twice:${checkinId}`));
    expect(raised, 'the double release raises an alert').toBeTruthy();
    expect(raised!.severity).toBe('critical');
    expect(raised!.summary).toContain('Ton was released twice');
    expect(raised!.summary).toContain('at a counter online');
    const detail = raised!.detail as { second: { releaseId: string; boxId: string } };
    expect(detail.second.releaseId).toBe(offlineRelease);
    expect(detail.second.boxId).toBe(agent.state.boxId);
    // Its photo never links to a release that was not applied.
    await agent.uploadPhotos();
    expect(await ctx.db.select().from(fileObject).where(eq(fileObject.id, photoId))).toEqual([]);
  });
});
