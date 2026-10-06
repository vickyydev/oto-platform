import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, box, branch, product, sale, station, ticketPackage } from '@oto/db';
import {
  SYNC_EVENT_SCHEMA_VERSION,
  canonicalSyncBytes,
  newId,
  type SyncEventEnvelope,
  type SyncPushResponse,
} from '@oto/shared';
import { boxCredential } from '@oto/box-agent';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { issueClaimCode } from '../src/services/box';
import { openBookingCheckout } from '../src/services/booking-checkout';
import { pressSimulatorHostedPage } from '../src/services/payments/gateway';
import { SALE_KIDS_WITHOUT_REGISTRATION, commitSale, type ActorContext } from '../src/services/sale';

/**
 * SCRUM-478 — NO CHILD IS SOLD A TICKET ALONE, on the platform.
 *
 * The till's supervision gate (`pages/Till.tsx`) makes a family register before
 * a kids-only cart reaches Pay. This is the same rule at `commitSale`, where
 * every sale passes: a sale that admits children and not one adult is refused
 * unless a drop-off registration stands behind it. The evidence is what the
 * till sends today — each supervised child's drop-off line under the STAY's id
 * (`pos.checkin.id`, which carries the registration) — or a registration id
 * named outright on the service input.
 *
 * What is NOT gated, and is pinned here so nobody tightens it by accident: a
 * booking's redemption (the family's adults are the booking's), a cart with no
 * admission at all (food, merchandise), and a box's replay — which is warned
 * about on the record and let through, because the money was already taken at
 * a counter with nobody to ask (the box's own gate is round 4).
 */

let ctx: TestContext;
let cookie: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let twoHoursId: string;
let socksProductId: string;
let receptionAccountId: string;

const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

const kidLine = (id = newId()) => ({ id, packageId: twoHoursId, kids: 1, adults: 0 });

async function commit(payload: Record<string, unknown>) {
  return ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: { stationId, ...payload },
  });
}

async function register(children: Record<string, unknown>[]) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie },
    payload: {
      id: newId(),
      branchId,
      stationId,
      guardianName: 'Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { id: string; children: Array<{ id: string }> };
}

const child = (over: Record<string, unknown> = {}) => ({
  checkinId: newId(),
  name: 'Mint',
  ageYears: 6,
  service: 'drop_off',
  allergies: null,
  foodRestrictions: null,
  foodProvision: { mode: 'none', paidSatang: 0 },
  ...over,
});

async function saleRow(saleId: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, saleId)).limit(1);
  return row;
}

async function auditOf(saleId: string, action: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'sale'), eq(auditLog.entityId, saleId), eq(auditLog.action, action)));
}

const actor = (): ActorContext => ({ accountId: receptionAccountId, operatorId, branchId });

// --- A box with a till of its own, as sync-sales.test.ts builds one ----------

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

interface TestBox {
  boxId: string;
  credential: string;
  privateKey: KeyObject;
  stationId: string;
  prefix: string;
  nextSeq: number;
}

let boxCounter = 0;

async function freshBox(): Promise<TestBox> {
  const seeded = await boxBySlot(ctx.db, 'virtual-1');
  const n = (boxCounter += 1);
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: `Gate box ${n}`,
    slot: `gate-${n}`,
    role: 'virtual',
    status: 'unclaimed',
  });
  const boxStationId = newId();
  const prefix = `SG${n}`;
  await ctx.db.insert(station).values({
    id: boxStationId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    boxId,
    name: `Gate offline till ${n}`,
    kind: 'till',
    codePrefix: prefix,
  });
  const { code: claimCode } = await issueClaimCode(ctx.db, boxId);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: {
      claimCode,
      agentVersion: '0.1.0',
      hostname: `gate-${n}`,
      syncPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };
  return { boxId, credential: boxCredential(body.boxId, body.secret), privateKey, stationId: boxStationId, prefix, nextSeq: 1 };
}

function mint(b: TestBox, type: string, payload: Record<string, unknown>): SyncEventEnvelope {
  const base = {
    eventId: newId(),
    journalEpoch: 1,
    boxSeq: b.nextSeq++,
    type,
    schemaVersion: SYNC_EVENT_SCHEMA_VERSION,
    occurredAt: new Date().toISOString(),
    clockTrust: 'trusted' as const,
    stationId: b.stationId,
    actorKind: 'account' as const,
    actorAccountId: receptionAccountId,
    actorCredentialId: null,
    actionId: `act-${newId()}`,
    payload,
  };
  const canonical = canonicalSyncBytes({ ...base, boxId: b.boxId });
  return {
    ...base,
    payloadHash: sha256(canonical),
    sig: signDetached(null, Buffer.from(canonical, 'utf8'), b.privateKey).toString('base64'),
    sigAlg: 'ed25519',
  } as SyncEventEnvelope;
}

async function push(b: TestBox, events: SyncEventEnvelope[]): Promise<SyncPushResponse> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/sync/push',
    headers: { authorization: `Bearer ${b.credential}` },
    payload: { events },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as SyncPushResponse;
}

async function quotedTotal(atStationId: string, lines: Record<string, unknown>[]): Promise<number> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales/quote',
    headers: { cookie },
    payload: { stationId: atStationId, lines },
  });
  expect(res.statusCode, res.body).toBe(200);
  return Number(res.json().totals.grossSatang);
}

// --- A booking paid online, as bookings-redeem.test.ts makes one -------------

let booked = 0;

async function bookOnline(kids: number, adults: number): Promise<{ id: string; reference: string; totalSatang: number }> {
  booked += 1;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: `10.211.${Math.floor(booked / 250)}.${(booked % 250) + 1}`,
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: `08129${String(booked).padStart(5, '0')}`,
      parentName: 'Khun Ploy',
      tier: 'tourist',
      lines: [{ packageId: twoHoursId, kids, adults }],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const made = res.json() as { id: string; reference: string; totalSatang: number };
  const checkout = await openBookingCheckout(ctx.db, ctx.app.env, ctx.app.log, {}, {
    bookingId: made.id,
    method: 'promptpay',
  });
  const pressed = await pressSimulatorHostedPage(ctx.db, ctx.app.env, ctx.app.log, {
    attemptId: checkout.attemptId,
    action: 'pay',
  });
  expect(pressed?.webhookOutcome).toBe('settled');
  return made;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE)).limit(1);
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')))
    .limit(1);
  stationId = till!.id;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')))
    .limit(1);
  twoHoursId = pkg!.id;
  const [socks] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'MR-SOCKS')))
    .limit(1);
  socksProductId = socks!.id;
  const [reception] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone)).limit(1);
  receptionAccountId = reception!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('SCRUM-478 — children are not sold tickets on their own (POST /sales)', () => {
  it('refuses a kids-only cart with no registration behind it, by name, and writes nothing', async () => {
    const saleId = newId();
    const res = await commit({ id: saleId, lines: [kidLine(), kidLine()] });
    expect(res.statusCode, res.body).toBe(409);
    const { error } = res.json();
    expect(error.code).toBe(SALE_KIDS_WITHOUT_REGISTRATION);
    expect(error.message).toContain('adult admission');
    expect(error.details).toMatchObject({ kids: 2, adults: 0, reason: 'no_registration' });
    expect(await saleRow(saleId)).toBeUndefined();
    expect(await auditOf(saleId, 'sale.create')).toHaveLength(0);
  });

  it('passes a kids-only cart whose lines are the registered stays — what the till sends after its gate', async () => {
    const reg = await register([child({ name: 'Dao' }), child({ name: 'Fah', ageYears: 7 })]);
    const saleId = newId();
    const res = await commit({
      id: saleId,
      lines: [
        { ...kidLine(reg.children[0]!.id), serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } },
        { ...kidLine(reg.children[1]!.id), serviceFee: { label: 'Drop-off service', amountSatang: 22_500 } },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await saleRow(saleId))?.status).toBe('tendering');
    const [created] = await auditOf(saleId, 'sale.create');
    expect(created!.after).toMatchObject({ registrationIds: [reg.id] });
    expect(await auditOf(saleId, 'sale.supervision_unverified')).toHaveLength(0);
  });

  it('a sibling waived down to a plain ticket rides on the registered child’s line', async () => {
    const reg = await register([child({ name: 'Nok', ageYears: 10, service: 'none' })]);
    const res = await commit({
      id: newId(),
      lines: [kidLine(reg.children[0]!.id), kidLine()],
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('passes a cart with an adult admission beside the children', async () => {
    const saleId = newId();
    const res = await commit({ id: saleId, lines: [{ id: newId(), packageId: twoHoursId, kids: 2, adults: 1 }] });
    expect(res.statusCode, res.body).toBe(200);
    const [created] = await auditOf(saleId, 'sale.create');
    expect(created!.after).toMatchObject({ registrationIds: [] });
  });

  it('passes a cart with no admission at all — merchandise only', async () => {
    const res = await commit({
      id: newId(),
      items: [{ id: newId(), productId: socksProductId, quantity: 1, variant: { variantId: 'm', variantLabel: 'M' } }],
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('SCRUM-478 — a registration named on the service input', () => {
  it('passes when it is real and this park’s', async () => {
    const reg = await register([child({ name: 'Bee' })]);
    const saleId = newId();
    const result = await ctx.db.transaction((tx) =>
      commitSale(tx, actor(), { id: saleId, stationId, lines: [kidLine()], registrationId: reg.id }),
    );
    expect(result.sale.id).toBe(saleId);
    const [created] = await auditOf(saleId, 'sale.create');
    expect(created!.after).toMatchObject({ registrationIds: [reg.id] });
  });

  it('refuses one that is not on file, and says that is why', async () => {
    const saleId = newId();
    await expect(
      ctx.db.transaction((tx) =>
        commitSale(tx, actor(), { id: saleId, stationId, lines: [kidLine()], registrationId: newId() }),
      ),
    ).rejects.toMatchObject({
      code: SALE_KIDS_WITHOUT_REGISTRATION,
      details: { reason: 'registration_not_found' },
    });
    expect(await saleRow(saleId)).toBeUndefined();
  });
});

describe('SCRUM-478 — what the gate leaves alone', () => {
  it('a kids-only booking paid online is still redeemed at the counter', async () => {
    const made = await bookOnline(1, 0);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${made.id}/redeem`,
      headers: { cookie },
      payload: { stationId },
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await ctx.db.select().from(sale).where(eq(sale.bookingId, made.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.salesChannel).toBe('booking');
    expect(rows[0]!.status).toBe('finalised');
    expect(await auditOf(rows[0]!.id, 'sale.supervision_unverified')).toHaveLength(0);
  });

  it('a box’s replay of a kids-only sale is banked with a warning on the record, not refused', async () => {
    const b = await freshBox();
    const lines = [kidLine()];
    const total = await quotedTotal(b.stationId, lines);
    const saleId = newId();
    const answer = await push(b, [
      mint(b, 'sale.finalised', {
        saleId,
        cart: { lines, expectedTotalSatang: total },
        tenders: [
          {
            actionId: `press-${newId()}`,
            methodCode: 'cash',
            kind: 'cash',
            amountSatang: total,
            tenderedSatang: total,
            changeSatang: 0,
          },
        ],
        receipt: { series: b.prefix, seq: 1, number: `${b.prefix}-000001` },
      }),
    ]);
    expect(answer.results[0]!.errorCode ?? null).toBeNull();
    expect(answer.applied).toBe(1);
    expect(answer.quarantined).toBe(0);

    const row = await saleRow(saleId);
    expect(row!.status).toBe('finalised');
    expect(row!.origin).toBe('box');
    expect(row!.grossSatang).toBe(total);

    const warnings = await auditOf(saleId, 'sale.supervision_unverified');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.after).toMatchObject({
      kids: 1,
      adults: 0,
      reason: 'no_registration',
      gate: 'warn',
      boxId: b.boxId,
    });
  });
});
