import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, checkin, nanny, nannyShift, station, syncQuarantine, ticketPackage } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent, type CredentialStore } from '@oto/box-agent';
import { newId } from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import type { FileStorage } from '../src/services/files';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * SCRUM-494 (REGISTER 6) — THE PAID SERVICE ON THE BOX LANE, TO THE LEDGER.
 *
 * With the link down the till's "Check in now" goes to the box with each
 * entry's paid service (the Drop-Off / Nanny switch on the cart line). The
 * box checks the child in on that service, and its `checkin.updated` fact
 * carries it: when the link is back the platform's stay holds the service
 * the family paid for, with the nanny that goes with it, audited.
 */

const keys = generateKeyPairSync('ed25519');
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let cookie: string;
let tillId: string;
let branchId: string;
let operatorId: string;
let packageId: string;
let boxId: string;
let pimId: string;
let agent: BoxAgent;
let credentials: CredentialStore;
let photoDir: string;
const link: CuttableLink = { cut: false };

const fakeStorage: FileStorage = {
  bucket: 'oto-files-test',
  presignedPut: async (objectKey) => `memory://oto-files-test/${objectKey}`,
  presignedGet: async (objectKey) => `memory://oto-files-test/${objectKey}?get`,
  put: async () => {},
  probe: async () => ({ state: 'ready' }),
};

function makeAgent(): BoxAgent {
  return createBoxAgent({
    apiBaseUrl: 'http://s494-checkin.test',
    credentials,
    hostname: 's494-checkin-box',
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

async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie },
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
    actionId: `s494-${newId().slice(-12)}`,
  });
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state !== 'pushed') break;
  }
}

function cartFor(checkinId: string, expectedTotalSatang?: number) {
  return {
    lines: [{ id: checkinId, packageId, kids: 1, adults: 0, serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } }],
    ...(expectedTotalSatang !== undefined ? { expectedTotalSatang } : {}),
  };
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
  const b1 = await boxBySlot(ctx.db, 'virtual-1');
  boxId = b1.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.boxId, b1.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  branchId = till!.branchId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  const [pim] = await ctx.db.select().from(nanny).where(and(eq(nanny.branchId, branchId), eq(nanny.name, 'Pim')));
  pimId = pim!.id;
  operatorId = pim!.operatorId;
  // The seeded shifts follow opening hours; Pim gets one covering now.
  await ctx.db.insert(nannyShift).values({
    id: newId(),
    operatorId,
    nannyId: pimId,
    branchId,
    startsAt: new Date(Date.now() - 3_600_000),
    endsAt: new Date(Date.now() + 3_600_000),
  });
  photoDir = mkdtempSync(join(tmpdir(), 'oto-s494-checkin-'));
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

/**
 * Register one child on `service` and pay on the box with the link down, then
 * press "Check in now" with `entry`; the link comes back and everything files.
 */
async function offlineCheckIn(
  child: { name: string; ageYears: number; service: 'drop_off' | 'nanny' },
  entry: { nannyId?: string | null; service?: 'drop_off' | 'nanny' },
) {
  const registrationId = newId();
  const checkinId = newId();
  const saleId = newId();
  await agent.syncCache();
  await agent.setOffline(true, { reason: 's494 check-in' });
  link.cut = true;
  try {
    const created = await onBox('checkin.create', {
      registrationId,
      guardianName: 'Nid',
      guardianPhone: '0812345679',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{ checkinId, ...child }],
    });
    expect(created.statusCode, JSON.stringify(created.body)).toBe(200);
    const quote = await onBox('cart.quote', cartFor(checkinId));
    expect(quote.statusCode, JSON.stringify(quote.body)).toBe(200);
    const gross = quote.body.result.quote.totals.grossSatang as number;
    const paid = await onBox('sale.finalise', {
      saleId,
      actionId: `pay-${saleId.slice(-8)}`,
      staffName: 'Nok',
      cart: cartFor(checkinId, gross),
      tender: { actionId: `cash-${saleId.slice(-8)}`, method: 'cash', kind: 'cash', amountSatang: gross, tenderedSatang: gross },
    });
    expect(paid.statusCode, JSON.stringify(paid.body)).toBe(200);
    const now = await onBox('checkin.update', {
      event: 'check_in_now',
      saleId,
      entries: [{ checkinId, ...entry }],
      staffName: 'Nok',
    });
    expect(now.statusCode, JSON.stringify(now.body)).toBe(200);
    expect(now.body.result.children[0]).toMatchObject({ id: checkinId, status: 'in_park', service: entry.service ?? child.service });
  } finally {
    link.cut = false;
    await agent.setOffline(false);
  }
  await flushAll();
  const held = await ctx.db
    .select()
    .from(syncQuarantine)
    .where(and(eq(syncQuarantine.boxId, agent.state.boxId!), eq(syncQuarantine.status, 'open')));
  expect(held.map((q) => q.errorCode)).toEqual([]);
  const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
  const trail = await ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'checkin'), eq(auditLog.entityId, checkinId), eq(auditLog.action, 'checkin.update')));
  const checkedIn = trail.find((a) => (a.after as { event?: string }).event === 'check_in_now');
  return { stay: stay!, audit: checkedIn, saleId };
}

describe('s494-checkin sync: the paid service, checked in on the box, reaches the platform', () => {
  it('a Drop-Off stay paid as Nanny is filed as a nanny stay with its nanny, audited', async () => {
    const { stay, audit, saleId } = await offlineCheckIn(
      { name: 'Mint', ageYears: 6, service: 'drop_off' },
      { nannyId: pimId, service: 'nanny' },
    );
    expect(stay).toMatchObject({ status: 'in_park', service: 'nanny', nannyId: pimId, saleId, offline: true });
    expect(audit, 'the check-in is audited').toBeTruthy();
    expect(audit!.before).toMatchObject({ status: 'registered', service: 'drop_off' });
    expect(audit!.after).toMatchObject({ status: 'in_park', service: 'nanny', nannyId: pimId, event: 'check_in_now' });
  });

  it('a nanny-age stay paid as Drop-Off is filed as drop-off with no nanny, audited', async () => {
    const { stay, audit } = await offlineCheckIn({ name: 'Ton', ageYears: 3, service: 'nanny' }, { service: 'drop_off' });
    expect(stay).toMatchObject({ status: 'in_park', service: 'drop_off', nannyId: null });
    expect(audit!.before).toMatchObject({ service: 'nanny' });
    expect(audit!.after).toMatchObject({ service: 'drop_off', nannyId: null, event: 'check_in_now' });
  });
});
