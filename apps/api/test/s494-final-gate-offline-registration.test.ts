import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify as verifyArgon } from '@node-rs/argon2';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, alert, auditLog, checkin, product, registration, station, syncQuarantine } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type BoxAgent, type CredentialStore } from '@oto/box-agent';
import {
  CHECKIN_FACTS,
  DEFAULT_SUPERVISION_POLICY,
  buildAcknowledgedConfirmations,
  newId,
  prepaidPaidMismatchRefusal,
} from '@oto/shared';
import { RECEPTION, boxBySlot, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import type { FileStorage } from '../src/services/files';
import { injectedTransport, type CuttableLink } from './box-link';

/**
 * SCRUM-494 (food) — final gate reproduction. A registration recorded on the
 * box with the link down, then replayed, stores its prepaid items the way the
 * online registration does: every item unserved (`redeemedQty: 0`), and an
 * amount paid that is the items' sum. The online path (`insertStays`) holds
 * both; the replay (`sync-checkin.ts applyCheckinCreated`) is the same
 * registration arriving later.
 */

const keys = generateKeyPairSync('ed25519');
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let cookie: string;
let tillId: string;
let boxId: string;
let agent: BoxAgent;
let credentials: CredentialStore;
let photoDir: string;
let hotDog: { id: string; name: string; priceSatang: number };
const link: CuttableLink = { cut: false };

const fakeStorage: FileStorage = {
  bucket: 'oto-files-test',
  presignedPut: async (objectKey) => `memory://oto-files-test/${objectKey}`,
  presignedGet: async (objectKey) => `memory://oto-files-test/${objectKey}?get`,
  probe: async () => ({ state: 'ready' }),
};

function makeAgent(): BoxAgent {
  return createBoxAgent({
    apiBaseUrl: 'http://s494-final-gate.test',
    credentials,
    hostname: 's494-final-gate-box',
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads into each answer's shape
  return { statusCode: res.statusCode, body: res.body ? (JSON.parse(res.body) as Record<string, any>) : {} };
}

async function onBox(type: string, payload: Record<string, unknown>) {
  return call('POST', `/box/v1/station/${tillId}/intents`, {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `s494fg-${newId().slice(-12)}`,
  });
}

async function flushAll(): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state !== 'pushed') break;
  }
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
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, b1.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;

  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  const [hd] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.code, 'FB-HOTDOG'), isNull(product.archivedAt)));
  hotDog = { id: hd!.id, name: hd!.name, priceSatang: hd!.priceSatang };
  photoDir = mkdtempSync(join(tmpdir(), 'oto-s494-final-gate-'));
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

async function registerOffline(name: string, foodProvision: Record<string, unknown>) {
  const checkinId = newId();
  await agent.syncCache();
  await agent.setOffline(true, { reason: 's494 final gate' });
  link.cut = true;
  let status: number;
  try {
    const created = await onBox('checkin.create', {
      registrationId: newId(),
      guardianName: 'Nid',
      guardianPhone: '0812345679',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [{ checkinId, name, ageYears: 6, service: 'drop_off', foodProvision }],
    });
    status = created.statusCode;
  } finally {
    link.cut = false;
    await agent.setOffline(false);
  }
  await flushAll();
  const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
  return { status, stay: stay ?? null };
}

describe('s494 final gate — a registration replayed from the box stores prepaid items as online does', () => {
  it('every prepaid item starts unserved, whatever the counter sent', async () => {
    const { status, stay } = await registerOffline('Final Gate Unserved', {
      mode: 'prepaid_items',
      paidSatang: hotDog.priceSatang * 2,
      items: [{ menuItemId: hotDog.id, menuItemName: hotDog.name, unitSatang: hotDog.priceSatang, qty: 2, redeemedQty: 2 }],
    });
    expect(status).toBe(200);
    expect(stay, 'the replayed stay is on the platform').not.toBeNull();
    expect(stay!.foodProvision?.items?.[0]).toMatchObject({ qty: 2, redeemedQty: 0 });
  });

  it('an amount paid that is not the items’ sum is never stored as the entitlement', async () => {
    const { status, stay } = await registerOffline('Final Gate Sum', {
      mode: 'prepaid_items',
      paidSatang: hotDog.priceSatang + 100,
      items: [{ menuItemId: hotDog.id, menuItemName: hotDog.name, unitSatang: hotDog.priceSatang, qty: 1, redeemedQty: 0 }],
    });
    // Refused at the box counter (as online), or never filed with the mismatch.
    const stored = stay?.foodProvision ?? null;
    const sum = (stored?.items ?? []).reduce((s, it) => s + it.unitSatang * it.qty, 0);
    expect(status === 200 ? stored !== null && stored.mode === 'prepaid_items' && stored.paidSatang !== sum : false).toBe(false);
  });

  it('a mismatch that still reaches the platform registers the family without the prepaid food, held in quarantine with an alert', async () => {
    const registrationId = newId();
    const checkinId = newId();
    const now = new Date().toISOString();
    const [staff] = await ctx.db.select({ id: account.id }).from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
    const accountId = staff!.id;
    // A fact queued past the counter's own check (a box on an older agent).
    await agent.outbox()!.queue({
      type: CHECKIN_FACTS.created,
      stationId: tillId,
      actorAccountId: accountId,
      payload: {
        registrationId,
        guardianName: 'Nid',
        guardianPhone: '0812345679',
        contactChannel: 'whatsapp',
        consentRecordedAt: now,
        acknowledgedConfirmations: buildAcknowledgedConfirmations(DEFAULT_SUPERVISION_POLICY, ALL_CONFIRMATIONS, now),
        children: [
          {
            checkinId,
            name: 'Final Gate Quarantine',
            ageYears: 6,
            service: 'drop_off',
            foodProvision: {
              mode: 'prepaid_items',
              paidSatang: hotDog.priceSatang + 100,
              items: [{ menuItemId: hotDog.id, menuItemName: hotDog.name, unitSatang: hotDog.priceSatang, qty: 1, redeemedQty: 1 }],
            },
          },
        ],
      },
    });
    await flushAll();

    const [reg] = await ctx.db.select().from(registration).where(eq(registration.id, registrationId));
    expect(reg, 'the family is registered').toBeDefined();
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay, 'the stay is on the platform').toBeDefined();
    expect(stay!.foodProvision, 'the mismatch is not kept as the entitlement').toBeNull();
    expect(stay!.mayOrderFood).toBe(false);

    const held = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, boxId), eq(syncQuarantine.status, 'open'), eq(syncQuarantine.errorCode, 'SYNC_PREPAID_PAID_MISMATCH')));
    const row = held.find((q) => (q.payload as { payload?: { registrationId?: string } }).payload?.registrationId === registrationId);
    expect(row, 'the registration is held in quarantine').toBeDefined();
    expect(row!.reason).toBe('conflict');
    expect(row!.errorMessage).toContain(prepaidPaidMismatchRefusal('Final Gate Quarantine', hotDog.priceSatang, hotDog.priceSatang + 100));

    const [raised] = await ctx.db.select().from(alert).where(eq(alert.key, `checkin.prepaid_paid_mismatch:${registrationId}`));
    expect(raised?.severity).toBe('critical');
    expect(raised?.resolvedAt).toBeNull();

    const [trailRow] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'checkin.prepaid_set_aside'), eq(auditLog.entityId, checkinId)));
    expect(trailRow?.after).toMatchObject({ itemsSatang: hotDog.priceSatang, paidSatang: hotDog.priceSatang + 100 });

    // A further push files nothing more for it.
    await flushAll();
    const again = await ctx.db
      .select()
      .from(syncQuarantine)
      .where(and(eq(syncQuarantine.boxId, boxId), eq(syncQuarantine.errorCode, 'SYNC_PREPAID_PAID_MISMATCH')));
    expect(again.filter((q) => (q.payload as { payload?: { registrationId?: string } }).payload?.registrationId === registrationId)).toHaveLength(1);
  });
});
