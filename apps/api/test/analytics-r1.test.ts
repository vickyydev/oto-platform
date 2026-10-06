import { createHash, generateKeyPairSync, sign as signDetached, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { account, box, branch, dirtyDate, product, schema, station, ticketPackage } from '@oto/db';
import {
  SYNC_EVENT_SCHEMA_VERSION,
  addDaysToIsoDate,
  businessDate,
  canonicalSyncBytes,
  mintVoucherQr,
  newId,
  parseDayStart,
  type SyncEventEnvelope,
  type SyncPushResponse,
} from '@oto/shared';
import {
  BRANCH_MANAGER,
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { boxCredential } from '@oto/box-agent';
import { issueClaimCode } from '../src/services/box';
import { openAttempt, settleAttempt } from '../src/services/payments/attempt';
import { createWalletWithGrant } from '../src/services/wallet';
import { priceCart } from '../src/services/sale';

/**
 * S2-15b (SCRUM-216) round 1 — EVERY FACT WRITE MARKS ITS DAY (plan
 * docs/progress/plans/analytics/PLAN.md §8 round 1), driven through the real
 * routes and services and read back from `analytics.dirty_date`:
 *
 *   - a sale finalised at the till, and a sale voided;
 *   - a refund, made today, of a sale three days old: the old day is marked;
 *   - money settled on an attempt that was waiting;
 *   - a wallet movement: a grant, and credit spent on an F&B order;
 *   - the sync apply path: a box sale that reaches the cloud two days after it
 *     was rung up marks the day it was sold, not the day it arrived.
 *
 * The marks are taken by the database at the commit of the transaction that
 * wrote the fact (migration 0064), so each case clears the queue, makes one
 * call, and reads what that one call left.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let operatorId: string;
let branchId: string;
let stationId: string;
let receptionAccountId: string;
let twoHoursId: string;
let friesId: string;
let today: string;

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  today = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [me] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionAccountId = me!.id;
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
  const [fries] = await ctx.db.select().from(product).where(and(eq(product.operatorId, operatorId), eq(product.code, 'FB-FRIES')));
  friesId = fries!.id;
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers ----------------------------------------------------------------------

async function clearMarks(): Promise<void> {
  await ctx.db.delete(dirtyDate);
}

async function marks(): Promise<Array<{ date: string; kind: string; branchId: string }>> {
  const rows = await ctx.db
    .select({ date: dirtyDate.businessDate, kind: dirtyDate.kind, branchId: dirtyDate.branchId })
    .from(dirtyDate)
    .orderBy(dirtyDate.businessDate, dirtyDate.kind);
  return rows;
}

/** A child and an adult on two hours, committed and paid in cash at T1. */
async function cashTicketSale(): Promise<string> {
  const saleId = newId();
  const committed = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] },
  });
  expect(committed.statusCode, committed.body).toBe(200);
  const paid = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception },
    payload: { method: 'cash' },
  });
  expect(paid.statusCode, paid.body).toBe(200);
  return saleId;
}

/** A finalised ฿500 sale on an earlier business day, paid in cash, written as the ledger holds one. */
async function earlierSale(date: string): Promise<string> {
  const saleId = newId();
  const at = new Date(`${date}T12:00:00+07:00`);
  await ctx.db.insert(schema.sale).values({
    id: saleId,
    operatorId,
    branchId,
    stationId,
    businessDate: date,
    businessDayStart: '05:00',
    timezone: 'Asia/Bangkok',
    occurredAt: at,
    createdByAccountId: receptionAccountId,
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    customerTier: 'tourist',
    engineVersion: 'analytics-r1',
    taxConfig: {},
    taxBreakdown: {},
    subtotalSatang: 50_000,
    netSatang: 50_000,
    grossSatang: 50_000,
    receiptSeries: 'AN1',
    receiptSeq: Math.floor(Math.random() * 1e9),
    receiptNumber: `AN1-${newId()}`,
    status: 'finalised',
    finalisedAt: at,
  });
  await ctx.db.insert(schema.paymentAttempt).values({
    id: newId(),
    operatorId,
    branchId,
    saleId,
    stationId,
    businessDate: date,
    method: 'cash',
    methodCode: 'cash',
    status: 'approved',
    amountSatang: 50_000,
    paidAt: at,
    createdAt: at,
  });
  return saleId;
}

// --- The call sites ---------------------------------------------------------------

describe('a fact marks its own day (SCRUM-216 round 1)', () => {
  it('a sale finalised at the till marks today', async () => {
    await clearMarks();
    await cashTicketSale();
    // The adult's ticket credit is a wallet movement of the same day.
    expect(await marks()).toEqual([
      { date: today, kind: 'sales', branchId },
      { date: today, kind: 'wallet', branchId },
    ]);
  });

  it('a sale voided at the till marks its day', async () => {
    const saleId = newId();
    const committed = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: saleId, stationId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] },
    });
    expect(committed.statusCode, committed.body).toBe(200);
    // Committed and unpaid is not yet a fact of any day.
    await clearMarks();
    const voided = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/void`,
      headers: { cookie: reception },
      payload: { reason: 'Guest walked away' },
    });
    expect(voided.statusCode, voided.body).toBe(200);
    const [row] = await ctx.db.select().from(dirtyDate);
    expect(row).toMatchObject({ businessDate: today, kind: 'sales', branchId, reason: 'sale:voided' });
  });

  it('a refund made today of a sale three days old marks the old day, not today', async () => {
    const old = addDaysToIsoDate(today, -3);
    const saleId = await earlierSale(old);
    await clearMarks();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/refunds`,
      headers: { cookie: manager },
      payload: { mode: 'custom', amountSatang: 10_000, reason: 'Left early', actionId: newId() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await marks()).toEqual([{ date: old, kind: 'sales', branchId }]);
  });

  it('money settled on a waiting attempt marks its sale’s day; the opening alone does not', async () => {
    const old = addDaysToIsoDate(today, -1);
    const saleId = await earlierSale(old);
    await clearMarks();
    const opened = await ctx.db.transaction((tx) =>
      openAttempt(tx, {
        saleId,
        operatorId,
        branchId,
        stationId,
        businessDate: old,
        method: 'qr',
        methodCode: 'promptpay',
        amountSatang: 0,
      }),
    );
    expect(await marks()).toEqual([]);
    await ctx.db.transaction((tx) => settleAttempt(tx, opened.id, { paidAt: new Date() }));
    expect(await marks()).toEqual([{ date: old, kind: 'sales', branchId }]);
  });

  it('a wallet grant marks the wallet’s day, and credit spent on an F&B order marks the order’s day too', async () => {
    await clearMarks();
    const qr = mintVoucherQr();
    await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, { accountId: null, operatorId }, {
        actionId: `analytics-r1:${newId()}`,
        branchId,
        holderName: 'Walk-in guest',
        amountSatang: 20_000,
        source: 'ticket_sale',
        keys: [{ kind: 'voucher_qr', value: qr }],
      }),
    );
    expect(await marks()).toEqual([{ date: today, kind: 'wallet', branchId }]);

    const saleId = newId();
    const order = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id: saleId, stationId, channel: 'fnb', pickupCode: '7', items: [{ id: newId(), productId: friesId, quantity: 1 }] },
    });
    expect(order.statusCode, order.body).toBe(200);
    await clearMarks();
    const paid = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/finalise`,
      headers: { cookie: reception },
      payload: { wallet: { key: qr, useCredit: true }, actionId: newId() },
    });
    expect(paid.statusCode, paid.body).toBe(200);
    expect(await marks()).toEqual([
      { date: today, kind: 'sales', branchId },
      { date: today, kind: 'wallet', branchId },
    ]);
  });
});

// --- The sync apply path ----------------------------------------------------------

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

interface TestBox {
  boxId: string;
  credential: string;
  privateKey: KeyObject;
  stationId: string;
  prefix: string;
  nextSeq: number;
}

/** A box with one till of its own, registered the way a Pi registers. */
async function freshBox(): Promise<TestBox> {
  const seeded = await boxBySlot(ctx.db, 'virtual-1');
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: 'Analytics box',
    slot: 'analytics-1',
    role: 'virtual',
    status: 'unclaimed',
  });
  const tillId = newId();
  await ctx.db.insert(station).values({
    id: tillId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    boxId,
    name: 'Analytics till',
    kind: 'till',
    codePrefix: 'AN',
  });
  const { code: claimCode } = await issueClaimCode(ctx.db, boxId);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: {
      claimCode,
      agentVersion: '0.1.0',
      hostname: 'analytics-1',
      syncPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };
  return {
    boxId,
    credential: boxCredential(body.boxId, body.secret),
    privateKey,
    stationId: tillId,
    prefix: 'AN',
    nextSeq: 1,
  };
}

function mint(b: TestBox, type: string, payload: Record<string, unknown>, occurredAt: Date): SyncEventEnvelope {
  const base = {
    eventId: newId(),
    journalEpoch: 1,
    boxSeq: b.nextSeq++,
    type,
    schemaVersion: SYNC_EVENT_SCHEMA_VERSION,
    occurredAt: occurredAt.toISOString(),
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

describe('the sync apply path marks the day a box sale was sold (SCRUM-216 round 1)', () => {
  it('a box sale synced two days late marks its own business date, not the day it arrived', async () => {
    const b = await freshBox();
    const soldOn = addDaysToIsoDate(today, -2);
    const occurredAt = new Date(`${soldOn}T14:30:00+07:00`);
    const lines = [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 0 }];
    const priced = await priceCart(
      ctx.db,
      { accountId: receptionAccountId, operatorId, branchId },
      { branchId, lines },
      occurredAt,
      { mode: 'quote', stationId: b.stationId },
    );
    const total = priced.money.grossSatang;
    const saleId = newId();
    await clearMarks();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/box/v1/sync/push',
      headers: { authorization: `Bearer ${b.credential}` },
      payload: {
        events: [
          mint(
            b,
            'sale.finalised',
            {
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
            },
            occurredAt,
          ),
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const answer = res.json() as SyncPushResponse;
    expect(answer.applied, JSON.stringify(answer.results)).toBe(1);
    const [row] = await ctx.db.select({ businessDate: schema.sale.businessDate }).from(schema.sale).where(eq(schema.sale.id, saleId));
    expect(row!.businessDate).toBe(soldOn);
    expect(await marks()).toEqual([{ date: soldOn, kind: 'sales', branchId }]);
    // Nothing for the day it arrived.
    const arrived = await ctx.db.execute(sql`select count(*)::int as n from analytics.dirty_date where business_date = ${today}::date`);
    expect(Number((arrived.rows[0] as { n: number }).n)).toBe(0);
  });
});
