import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, alert, box, checkin, release, station, syncEvent, syncQuarantine, ticketPackage } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent, type CredentialStore } from '@oto/box-agent';
import { CHECKIN_FACTS, newId } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, boxAuthFromRow, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { replayQuarantined } from '../src/services/sync';
import type { FileStorage } from '../src/services/files';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * S2-13 ROUND 4 — THE GATE'S REPRODUCTIONS (focused gate, 2026-10-01).
 *
 * Three invariants attacked against the landed tree, each kept as a test:
 *
 *   1. EXACTLY ONCE — the same applied "Check in now" fact, met again under a
 *      new envelope after the child has been collected, must write nothing and
 *      raise nothing (the handler's own claim: "the same fact under a new
 *      envelope … meets the row it wrote the first time and writes nothing").
 *   2. THE CONFLICT — a release at the box AND online: the box's quarantines
 *      once, the child's record stays the ONLINE truth, and a box re-send plus
 *      a Failures-tab replay leave one quarantine row and one alert row.
 *   3. THE OTO APP'S CHECKINS TABLES — never written by any sync path: the
 *      tables carry a statement trigger that refuses every write for the whole
 *      run, and their row counts are compared before and after.
 */

const keys = generateKeyPairSync('ed25519');
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let cookie: string;
let cookieB: string;
let tillId: string;
let counterId: string;
let branchId: string;
let packageId: string;
let boxId: string;
let agent: BoxAgent;
let credentials: CredentialStore;
let photoDir: string;
const link: CuttableLink = { cut: false };
let otoappBefore: { dropoff: number; service: number };

const fakeStorage: FileStorage = {
  bucket: 'oto-files-test',
  presignedPut: async (objectKey) => `memory://oto-files-test/${objectKey}`,
  presignedGet: async (objectKey) => `memory://oto-files-test/${objectKey}?get`,
  probe: async () => ({ state: 'ready' }),
};

function makeAgent(): BoxAgent {
  return createBoxAgent({
    apiBaseUrl: 'http://checkin-gate.test',
    credentials,
    hostname: 'checkin-gate-box',
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
      put: async () => {
        if (link.cut) throw new Error('ECONNRESET');
        return 200;
      },
    },
  });
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, as = cookie) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: as },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads deep into each answer's shape (quote.totals, result.*)
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

async function onBox(type: string, payload: Record<string, unknown>) {
  return call('POST', `/box/v1/station/${tillId}/intents`, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `gate-${newId().slice(-12)}`,
  });
}

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

async function otoappCounts() {
  const d = await ctx.db.execute<{ n: string }>(sql`select count(*)::text as n from otoapp.dropoff_checkins`);
  const s = await ctx.db.execute<{ n: string }>(sql`select count(*)::text as n from otoapp.service_checkins`);
  return { dropoff: Number(d.rows[0]!.n), service: Number(s.rows[0]!.n) };
}

function dropOffCart(checkinId: string, expectedTotalSatang?: number) {
  return {
    lines: [{ id: checkinId, packageId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } }],
    ...(expectedTotalSatang !== undefined ? { expectedTotalSatang } : {}),
  };
}

beforeAll(async () => {
  ctx = await createTestContext({
    otoapp: true,
    env: {
      OPS_TEST_CONTROLS: 'true',
      STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
  });
  (ctx.app as unknown as { fileStorage: FileStorage }).fileStorage = fakeStorage;

  // The OTO App's checkins tables refuse EVERY write for the whole run.
  await ctx.db.execute(sql`
    create or replace function otoapp.gate_r4_forbid_checkins_write() returns trigger
    language plpgsql as $$ begin raise exception 'S2-13 r4 gate: otoapp.% was written (%)', tg_table_name, tg_op; end $$`);
  for (const table of ['dropoff_checkins', 'service_checkins']) {
    await ctx.db.execute(
      sql.raw(
        `create trigger gate_r4_forbid before insert or update or delete or truncate on otoapp.${table} ` +
          'for each statement execute function otoapp.gate_r4_forbid_checkins_write()',
      ),
    );
  }
  otoappBefore = await otoappCounts();

  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const b1 = await boxBySlot(ctx.db, 'virtual-1');
  boxId = b1.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, b1.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  branchId = till!.branchId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  cookieB = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const b2 = await boxBySlot(ctx.db, 'virtual-2');
  const [counter] = await ctx.db.select().from(station).where(and(eq(station.boxId, b2.id), eq(station.name, 'Counter 2')));
  counterId = counter!.id;
  expect((await call('PUT', '/me/session/station', { stationId: counterId }, cookieB)).statusCode).toBe(200);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  photoDir = mkdtempSync(join(tmpdir(), 'oto-checkin-gate-'));
  credentials = memoryCredentialStore();
  agent = makeAgent();
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx?.close();
  await teardownAll();
  if (photoDir) rmSync(photoDir, { recursive: true, force: true });
});

/** A whole offline stay on the box, synced: registered, paid, checked in, released. */
async function offlineStayToTheEnd() {
  const registrationId = newId();
  const checkinId = newId();
  const saleId = newId();
  await agent.syncCache();
  await agent.setOffline(true, { reason: 'gate r4' });
  link.cut = true;
  const consent = newId();
  expect((await onBox('photo.capture', { photoId: consent, registrationId, purpose: 'consent', dataUrl: jpeg(5) })).statusCode).toBe(200);
  const created = await onBox('checkin.create', {
    registrationId,
    guardianName: 'Nid',
    guardianPhone: '0812345679',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
    children: [{ checkinId, name: 'Pim', ageYears: 6, service: 'drop_off' }],
    photoId: consent,
  });
  expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
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
  const now = await onBox('checkin.update', { event: 'check_in_now', saleId, entries: [{ checkinId }], staffName: 'Nok' });
  expect(now.statusCode, JSON.stringify(now.body)).toBe(200);
  const pickup = newId();
  expect((await onBox('photo.capture', { photoId: pickup, registrationId, purpose: 'pickup', dataUrl: jpeg(6) })).statusCode).toBe(200);
  const released = await onBox('release.create', {
    releaseId: newId(),
    checkinId,
    collector: { kind: 'dropper_off' },
    pickupPhotoId: pickup,
  });
  expect(released.statusCode, JSON.stringify(released.body)).toBe(200);
  link.cut = false;
  await agent.setOffline(false);
  await flushAll();
  await agent.uploadPhotos();
  return { registrationId, checkinId, saleId };
}

describe('S2-13 r4 gate — exactly once', () => {
  it('the same applied "Check in now", met again under a new envelope after the release, writes nothing and raises nothing', async () => {
    const { checkinId } = await offlineStayToTheEnd();
    expect((await openQuarantine()).map((q) => q.errorCode)).toEqual([]);
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay!.status).toBe('out');

    // The check-in fact the platform filed, exactly as the box sent it.
    const filed = await ctx.db
      .select()
      .from(syncEvent)
      .where(and(eq(syncEvent.type, CHECKIN_FACTS.updated), sql`${syncEvent.payload}->>'checkinId' = ${checkinId}`));
    const nowFact = filed.find((e) => (e.payload as { event?: string }).event === 'check_in_now');
    expect(nowFact, 'the check-in fact was filed').toBeTruthy();

    // A restored store re-queues it under a new envelope.
    await agent.outbox()!.queue({
      type: CHECKIN_FACTS.updated,
      stationId: tillId,
      actorKind: 'account',
      actorAccountId: nowFact!.actorAccountId,
      actionId: `restored-${newId().slice(-8)}`,
      payload: nowFact!.payload as Record<string, unknown>,
    });
    await flushAll();

    const held = await openQuarantine();
    expect(held.map((q) => q.errorCode), 'an applied check-in met again is not "checked in twice"').toEqual([]);
    const raised = await ctx.db.select().from(alert).where(eq(alert.key, `checkin.checked_in_twice:${checkinId}`));
    expect(raised, 'no critical alert for a fact already filed').toEqual([]);
  });
});

describe('S2-13 r4 gate — the conflict', () => {
  it('released at the box AND online: one quarantine, one alert, the online release stands — through a re-send and a Failures-tab replay', async () => {
    const registrationId = newId();
    const checkinId = newId();
    const saleId = newId();
    const reg = await call('POST', '/checkin/registrations', {
      id: registrationId,
      branchId,
      stationId: tillId,
      guardianName: 'Fon',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{ checkinId, name: 'Tao', ageYears: 7, service: 'drop_off' }],
    });
    expect(reg.statusCode, JSON.stringify(reg.body)).toBe(200);
    expect((await call('POST', '/sales', { id: saleId, stationId: tillId, ...dropOffCart(checkinId) })).statusCode).toBe(200);
    expect((await call('POST', `/sales/${saleId}/finalise`, {})).statusCode).toBe(200);
    expect((await call('POST', '/checkin/check-in-now', { saleId, entries: [{ checkinId }] })).statusCode).toBe(200);
    expect(await agent.syncCheckin()).toBe(true);

    await agent.setOffline(true, { reason: 'gate r4 conflict' });
    link.cut = true;
    const photoId = newId();
    expect((await onBox('photo.capture', { photoId, registrationId, purpose: 'pickup', dataUrl: jpeg(8) })).statusCode).toBe(200);
    const boxRelease = newId();
    const atBox = await onBox('release.create', { releaseId: boxRelease, checkinId, collector: { kind: 'dropper_off' }, pickupPhotoId: photoId });
    expect(atBox.statusCode, JSON.stringify(atBox.body)).toBe(200);

    const fileId = newId();
    expect(
      (
        await call(
          'POST',
          '/files',
          { id: fileId, contentType: 'image/jpeg', ownerEntityType: 'registration', ownerEntityId: registrationId, filename: 'p.jpg' },
          cookieB,
        )
      ).statusCode,
    ).toBe(200);
    const onlineRelease = newId();
    const online = await call(
      'POST',
      `/checkin/pickups/stays/${checkinId}/release`,
      { id: onlineRelease, collector: { kind: 'dropper_off' }, pickupPhotoFileId: fileId, stationId: counterId },
      cookieB,
    );
    expect(online.statusCode, JSON.stringify(online.body)).toBe(200);
    const [truth] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));

    link.cut = false;
    await agent.setOffline(false);
    await flushAll();
    // The box re-sends the batch (an answer lost on the way back) …
    await agent.outbox()!.replayLastBatch(50);
    await flushAll();
    // … and a person presses Replay on the Failures tab.
    const conflictRows = (await openQuarantine()).filter((q) => q.errorCode === 'SYNC_RELEASE_CONFLICT');
    expect(conflictRows).toHaveLength(1);
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, agent.state.boxId!));
    const [admin] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
    const again = await replayQuarantined(ctx.db, boxAuthFromRow(boxRow!), conflictRows[0]!.id, { requestId: 'gate-r4' }, admin!.id);
    expect(again.result).toBe('quarantined');

    const allRows = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, agent.state.boxId!), eq(syncQuarantine.errorCode, 'SYNC_RELEASE_CONFLICT')));
    expect(allRows, 'one quarantine row for the one conflicting release').toHaveLength(1);
    const alerts = await ctx.db.select().from(alert).where(eq(alert.key, `checkin.released_twice:${checkinId}`));
    expect(alerts, 'the key fires once: one alert row').toHaveLength(1);
    expect(alerts[0]!.severity).toBe('critical');

    // The child's record is the ONLINE truth, untouched by the box's release.
    const rels = await ctx.db.select().from(release).where(eq(release.checkinId, checkinId));
    expect(rels.map((r) => r.id)).toEqual([onlineRelease]);
    const [after] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(after!.status).toBe('out');
    expect(after!.checkedOutAt?.toISOString()).toBe(truth!.checkedOutAt?.toISOString());
    expect(after!.checkedOutByAccountId).toBe(truth!.checkedOutByAccountId);
    expect(after!.updatedAt.toISOString()).toBe(truth!.updatedAt.toISOString());
  });
});

describe('S2-13 r4 gate — the OTO App checkins tables', () => {
  it('no sync path wrote them: the refusing trigger never fired and the counts are unchanged', async () => {
    expect(await otoappCounts()).toEqual(otoappBefore);
    // The trigger is still armed (a write would have thrown somewhere above).
    const armed = await ctx.db.execute<{ n: string }>(
      sql`select count(*)::text as n from pg_trigger where tgname = 'gate_r4_forbid' and not tgisinternal`,
    );
    expect(Number(armed.rows[0]!.n)).toBe(2);
  });
});
