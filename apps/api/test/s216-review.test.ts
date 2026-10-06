import { createHash, generateKeyPairSync, randomInt, sign as signDetached, type KeyObject } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  account,
  box,
  branch,
  dailySummary,
  dirtyDate,
  hourlySummary,
  opsRun,
  paymentAttempt,
  product,
  refund,
  sale,
  saleLine,
  schema,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
  walletEntry,
  type Db,
} from '@oto/db';
import {
  SALES_BOOTH_CHANNEL,
  SYNC_EVENT_SCHEMA_VERSION,
  addDaysToIsoDate,
  businessDate,
  canonicalSyncBytes,
  mintBoothCode,
  newId,
  parseDayStart,
  type SyncEventEnvelope,
  type SyncPushResponse,
} from '@oto/shared';
import { boxCredential } from '@oto/box-agent';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { loadEnv } from '../src/env';
import { issueClaimCode } from '../src/services/box';
import { priceCart } from '../src/services/sale';
import { openBookingCheckout } from '../src/services/booking-checkout';
import { pressSimulatorHostedPage } from '../src/services/payments/gateway';
import { createJobRunner } from '../src/services/jobs';
import { runWalletLiabilityJob } from '../src/services/wallet';
import {
  ROLLUP_DAILY_JOB,
  ROLLUP_HOURLY_JOB,
  claimDirtyDates,
  releaseDirtyClaim,
  rollupDailyBranchDay,
  runDailyRollupJob,
  runHourlyRollupJob,
  type RollupBranchClock,
} from '../src/services/analytics-rollup';

/**
 * SCRUM-216 review of lane G (analytics rounds 1-2): the rollup attacked with
 * a trading day made through the REAL routes and services — the till's
 * commit and finalise, a keyed-in card, the wallet tender, the refund
 * allocation, a void, the booth voucher hold, an online booking and its
 * redemption, a drop-off stay, and box sales synced days late — never rows
 * shaped by hand. Every figure is then summed here, sale by sale, and
 * compared with `analytics.daily_summary` to the satang.
 *
 * Then the business day (01:30, a refund of an older sale, a late sync), double
 * counting (credit, the booking), the frozen flag against every job and hook,
 * and races and replays (two runs, a replayed job, a mark landing mid-rollup).
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let admin: string;
let operatorId: string;
let branchId: string;
let tillId: string;
let receptionAccountId: string;
let oneHourId: string;
let twoHoursId: string;
let juiceId: string;
let plushId: string;
let boothDefinitionId: string;
let bookingPackageId: string;
let clock: RollupBranchClock;
/** Today at Central, and two older trading days. */
let T: string;
let O: string;
let M: string;
const hoursOf = new Map<string, number>();

beforeAll(async () => {
  ctx = await createTestContext({ env: { PROCESS_ROLES: 'api,jobs', OPS_TEST_CONTROLS: 'true' } });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  clock = {
    id: branchId,
    operatorId,
    timezone: hkt!.timezone,
    dayStartMinutes: parseDayStart(hkt!.businessDayStart),
    live: true,
  };
  T = businessDate(new Date(), hkt!.timezone, parseDayStart(hkt!.businessDayStart));
  O = addDaysToIsoDate(T, -2);
  M = addDaysToIsoDate(T, -5);
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  await takeStation(ctx.app, reception, tillId);
  const [me] = await ctx.db.select().from(account).where(eq(account.phone, RECEPTION.phone));
  receptionAccountId = me!.id;
  const pkgs = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, branchId));
  for (const p of pkgs) hoursOf.set(p.id, p.hours);
  oneHourId = pkgs.find((p) => p.name === '1 Hour Play')!.id;
  twoHoursId = pkgs.find((p) => p.name === '2 Hours Play')!.id;
  const products = await ctx.db.select().from(product).where(eq(product.operatorId, operatorId));
  juiceId = products.find((p) => p.code === 'FB-JUICE')!.id;
  plushId = products.find((p) => p.code === 'MR-PLUSH' && p.branchId === branchId)!.id;
  const [def] = await ctx.db
    .select({ id: voucherDefinition.id })
    .from(voucherDefinition)
    .where(and(eq(voucherDefinition.operatorId, operatorId), eq(voucherDefinition.code, 'spin-voucher-150')));
  boothDefinitionId = def!.id;
  const catalog = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  bookingPackageId = (catalog.json() as { packages: Array<{ id: string }> }).packages[0]!.id;
  // The seed's own marks are worked off first, so each case reads only what it made.
  await runDailyRollupJob(ctx.db, new Date());
  await runHourlyRollupJob(ctx.db, new Date());
}, 240_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Calling the real routes ----------------------------------------------------------

async function post(cookie: string, url: string, payload?: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie }, ...(payload ? { payload } : {}) });
}

async function commit(payload: Record<string, unknown>): Promise<string> {
  const id = newId();
  const res = await post(reception, '/sales', { id, stationId: tillId, ...payload });
  expect(res.statusCode, res.body).toBe(200);
  return id;
}

async function finalise(saleId: string, payload: Record<string, unknown> = {}) {
  const res = await post(reception, `/sales/${saleId}/finalise`, { actionId: newId(), ...payload });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    finalised: boolean;
    grants: Array<{ walletId: string; qrCode: string; creditSatang: number }>;
    redeemedVoucherIds: string[];
  };
}

async function manualCard(saleId: string, amountSatang: number): Promise<void> {
  const res = await post(reception, '/payments/manual', {
    saleId,
    amountSatang,
    approvalCode: '123456',
    tid: '12345678',
    last4: '4242',
    actionId: newId(),
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function refundOf(saleId: string, payload: Record<string, unknown>): Promise<string> {
  const res = await post(manager, `/sales/${saleId}/refunds`, { reason: 'Review refund', actionId: newId(), ...payload });
  expect(res.statusCode, res.body).toBe(200);
  const rows = await ctx.db.select().from(refund).where(eq(refund.saleId, saleId));
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).at(-1)!.id;
}

async function saleOf(id: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, id));
  return row!;
}

async function dayRow(date: string, source: 'oto_pos' | 'pisell' = 'oto_pos') {
  const [row] = await ctx.db
    .select()
    .from(dailySummary)
    .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, date), eq(dailySummary.source, source)));
  return row;
}

async function hourRows(date: string) {
  return ctx.db
    .select()
    .from(hourlySummary)
    .where(and(eq(hourlySummary.branchId, branchId), eq(hourlySummary.businessDate, date)))
    .orderBy(hourlySummary.hour);
}

async function salesMarks(): Promise<string[]> {
  const rows = await ctx.db
    .select({ date: dirtyDate.businessDate })
    .from(dirtyDate)
    .where(and(eq(dirtyDate.kind, 'sales'), eq(dirtyDate.branchId, branchId)))
    .orderBy(dirtyDate.businessDate);
  return rows.map((r) => r.date);
}

async function rollAll(now = new Date()): Promise<void> {
  await runDailyRollupJob(ctx.db, now);
  await runHourlyRollupJob(ctx.db, now);
}

// --- A box, as a Pi registers one, and its signed sync events ---------------------------

const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

interface TestBox {
  boxId: string;
  credential: string;
  privateKey: KeyObject;
  stationId: string;
  nextSeq: number;
}

let theBox: TestBox | null = null;

async function reviewBox(): Promise<TestBox> {
  if (theBox) return theBox;
  const seeded = await boxBySlot(ctx.db, 'virtual-1');
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    name: 'Review box',
    slot: 's216-review-1',
    role: 'virtual',
    status: 'unclaimed',
  });
  const stationId = newId();
  await ctx.db.insert(station).values({
    id: stationId,
    operatorId: seeded.operatorId,
    branchId: seeded.branchId,
    boxId,
    name: 'Review till',
    kind: 'till',
    codePrefix: 'RV',
  });
  const { code: claimCode } = await issueClaimCode(ctx.db, boxId);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const registered = await ctx.app.inject({
    method: 'POST',
    url: '/box/v1/register',
    payload: {
      claimCode,
      agentVersion: '0.1.0',
      hostname: 's216-review-1',
      syncPublicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      syncKeyAlgorithm: 'ed25519',
    },
  });
  expect(registered.statusCode, registered.body).toBe(200);
  const body = registered.json() as { boxId: string; secret: string };
  theBox = { boxId, credential: boxCredential(body.boxId, body.secret), privateKey, stationId, nextSeq: 1 };
  return theBox;
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

/** A box's cash ticket sale, rung up at `occurredAt` and reaching the cloud now. */
async function boxSale(occurredAt: Date, line: { packageId: string; kids: number; adults: number }): Promise<string> {
  const b = await reviewBox();
  const lines = [{ id: newId(), ...line }];
  const priced = await priceCart(
    ctx.db,
    { accountId: receptionAccountId, operatorId, branchId },
    { branchId, lines },
    occurredAt,
    { mode: 'quote', stationId: b.stationId },
  );
  const total = priced.money.grossSatang;
  const saleId = newId();
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
              { actionId: `press-${newId()}`, methodCode: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total, changeSatang: 0 },
            ],
          },
          occurredAt,
        ),
      ],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect((res.json() as SyncPushResponse).applied, res.body).toBe(1);
  return saleId;
}

// --- The pieces of the day that need more than a cart --------------------------------

let booked = 0;

/** A booking made and paid the way a customer does: the public route, then the gateway's hosted page. */
async function bookOnline(kids: number, adults: number): Promise<{ id: string; totalSatang: number }> {
  booked += 1;
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: `10.216.0.${booked}`,
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345216',
      parentName: 'Khun Ploy',
      tier: 'tourist',
      lines: [{ packageId: bookingPackageId, kids, adults }],
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  const made = res.json() as { id: string; totalSatang: number };
  const checkout = await openBookingCheckout(ctx.db, ctx.app.env, ctx.app.log, {}, { bookingId: made.id, method: 'promptpay' });
  const pressed = await pressSimulatorHostedPage(ctx.db, ctx.app.env, ctx.app.log, { attemptId: checkout.attemptId, action: 'pay' });
  expect(pressed?.webhookOutcome).toBe('settled');
  return made;
}

/** One registered drop-off stay at Central: its id is the cart line the child's ticket rides on. */
async function registerStay(): Promise<string> {
  const checkinId = newId();
  const res = await post(reception, '/checkin/registrations', {
    id: newId(),
    branchId,
    stationId: tillId,
    guardianName: 'Ploy',
    guardianPhone: '0812345678',
    contactChannel: 'whatsapp',
    consentAcknowledged: true,
    acknowledgedConfirmationIds: ['confirm-15min', 'confirm-no-refund', 'confirm-evac'],
    children: [
      {
        checkinId,
        name: 'Mint',
        ageYears: 6,
        service: 'drop_off',
        allergies: null,
        foodRestrictions: null,
        foodProvision: { mode: 'none', paidSatang: 0 },
      },
    ],
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { children: Array<{ id: string }> }).children[0]!.id;
}

// --- The day, through the routes -------------------------------------------------------

interface Built {
  A: string;
  B: string;
  C: string;
  C2: string;
  D: string;
  E: string;
  F: string;
  G: string;
  H: string;
  I: string;
  J: string;
  O1: string;
  O2: string;
  creditUsedC: number;
  refundC: number;
  refundC2: number;
  refundO1: number;
  bookingKids: number;
  bookingAdults: number;
  bookingTotal: number;
}

let built: Built;

describe('lane G review: the figures, the business day and double counting', () => {
  it('H1, H5 — a box sale synced two days late, and one rung up at 01:30, mark the day they were sold and nothing else', async () => {
    expect(await salesMarks()).toEqual([]);
    const O1 = await boxSale(new Date(`${O}T14:30:00+07:00`), { packageId: twoHoursId, kids: 1, adults: 1 });
    // 01:30 the morning after O is still O's trading day (day start 05:00).
    const O2 = await boxSale(new Date(`${addDaysToIsoDate(O, 1)}T01:30:00+07:00`), { packageId: oneHourId, kids: 1, adults: 1 });
    expect((await saleOf(O1)).businessDate).toBe(O);
    expect((await saleOf(O2)).businessDate).toBe(O);
    expect(await salesMarks()).toEqual([O]);
    built = { O1, O2 } as Built;
  });

  it('builds today through the till, the wallet, the refunds, the booth voucher, a booking and a drop-off stay', async () => {
    // A — 2 Hours, a child and an adult, cash. The tickets grant credit.
    const A = await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] });
    const paidA = await finalise(A, { method: 'cash' });
    expect(paidA.finalised).toBe(true);
    const grant = paidA.grants.find((g) => g.creditSatang > 0);
    expect(grant, 'the 2 Hours tickets grant credit').toBeDefined();

    // B — 1 Hour, three children and an adult on ONE cart line; ฿500 keyed-in card, the rest cash.
    const B = await commit({ lines: [{ id: newId(), packageId: oneHourId, kids: 3, adults: 1 }] });
    await manualCard(B, 50_000);
    expect((await finalise(B, { method: 'cash' })).finalised).toBe(true);

    // C — F&B paid with A's credit first and cash for the rest; then a part refund.
    const credit = grant!.creditSatang;
    const C = await commit({
      channel: 'fnb',
      pickupCode: '21',
      items: [{ id: newId(), productId: juiceId, quantity: Math.floor(credit / 7_000) + 3 }],
    });
    expect((await finalise(C, { wallet: { key: grant!.qrCode, useCredit: true }, method: 'cash' })).finalised).toBe(true);
    const tendersC = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, C));
    const creditUsedC = tendersC.filter((t) => t.method === 'wallet').reduce((s, t) => s + t.amountSatang, 0);
    expect(creditUsedC).toBe(credit);
    const refundC = Math.min(15_000, credit);
    const rC = await refundOf(C, { mode: 'custom', amountSatang: refundC });
    // The platform's allocation puts a refund back on the wallet first.
    const restoredC = await ctx.db.select().from(walletEntry).where(and(eq(walletEntry.refundId, rC), eq(walletEntry.kind, 'refund')));
    expect(restoredC.reduce((s, e) => s + e.amountSatang, 0)).toBe(refundC);

    // C2 — F&B, ฿50 keyed-in card and the rest cash; a ฿60 part refund (no credit on it).
    const C2 = await commit({ channel: 'fnb', pickupCode: '22', items: [{ id: newId(), productId: juiceId, quantity: 2 }] });
    await manualCard(C2, 5_000);
    expect((await finalise(C2, { method: 'cash' })).finalised).toBe(true);
    const refundC2 = 6_000;
    await refundOf(C2, { mode: 'custom', amountSatang: refundC2 });

    // D — merch, cash, then refunded whole: it still counts as a transaction.
    const D = await commit({ channel: 'shop', items: [{ id: newId(), productId: plushId, quantity: 1 }] });
    expect((await finalise(D, { method: 'cash' })).finalised).toBe(true);
    await refundOf(D, { mode: 'whole' });
    expect((await saleOf(D)).status).toBe('refunded');

    // E — voided; F — rung up and never paid. Neither counts.
    const E = await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 2, adults: 1 }] });
    const voided = await post(reception, `/sales/${E}/void`, { reason: 'Guest walked away' });
    expect(voided.statusCode, voided.body).toBe(200);
    const F = await commit({ lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 2 }] });
    expect((await saleOf(F)).status).toBe('tendering');

    // G — a booth voucher, held at the till and spent on 2 Hours for a child and an adult.
    const code = mintBoothCode('B1', (max) => randomInt(max));
    const voucherId = newId();
    await ctx.db.insert(voucher).values({
      id: voucherId,
      operatorId,
      branchId,
      voucherDefinitionId: boothDefinitionId,
      code,
      source: 'booth',
      status: 'issued',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
    });
    const G = newId();
    const held = await post(reception, `/sales/${G}/vouchers`, { code });
    expect(held.statusCode, held.body).toBe(200);
    const rungG = await post(reception, '/sales', {
      id: G,
      stationId: tillId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
      promoCodes: [code],
    });
    expect(rungG.statusCode, rungG.body).toBe(200);
    expect((await finalise(G, { method: 'cash' })).redeemedVoucherIds).toEqual([voucherId]);

    // H — a booking made and paid online, redeemed at the till.
    const bookingKids = 2;
    const bookingAdults = 1;
    const made = await bookOnline(bookingKids, bookingAdults);
    const redeemed = await post(reception, `/bookings/${made.id}/redeem`, { stationId: tillId });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const H = (redeemed.json() as { sale: { id: string } }).sale.id;

    // I — a registered child's drop-off stay: the stay's id is the cart line.
    const stay = await registerStay();
    const I = await commit({ lines: [{ id: stay, packageId: twoHoursId, kids: 1, adults: 0 }] });
    expect((await finalise(I, { method: 'cash' })).finalised).toBe(true);

    // J — one family's sale: an ordinary 2 Hours line and a second child's drop-off stay. All of it is Drop-off.
    const stayJ = await registerStay();
    const J = await commit({
      lines: [
        { id: newId(), packageId: twoHoursId, kids: 1, adults: 1 },
        { id: stayJ, packageId: twoHoursId, kids: 1, adults: 0 },
      ],
    });
    expect((await finalise(J, { method: 'cash' })).finalised).toBe(true);

    // A refund made today of O's box sale: it reduces O, not today.
    const refundO1 = 20_000;
    await refundOf(built.O1, { mode: 'custom', amountSatang: refundO1 });

    built = {
      ...built,
      A, B, C, C2, D, E, F, G, H, I, J,
      creditUsedC, refundC, refundC2, refundO1,
      bookingKids, bookingAdults, bookingTotal: made.totalSatang,
    };
    expect(await salesMarks()).toEqual([O, T]);
  });

  it('today’s row equals the day summed by hand, sale by sale, to the satang', async () => {
    await rollAll();
    const b = built;
    const g = async (id: string) => (await saleOf(id)).grossSatang;
    const [gA, gB, gC, gC2, gD, gG, gH, gI, gJ] = await Promise.all([
      g(b.A), g(b.B), g(b.C), g(b.C2), g(b.D), g(b.G), g(b.H), g(b.I), g(b.J),
    ]);

    // Each ticket sale's total is what was taken for it.
    const taken = async (id: string) =>
      (await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, id)))
        .filter((a) => a.status === 'approved')
        .reduce((s, a) => s + a.amountSatang, 0);
    expect(await taken(b.A)).toBe(gA);
    expect(await taken(b.B)).toBe(gB);
    expect(await taken(b.G)).toBe(gG);
    expect(await taken(b.I)).toBe(gI);
    expect(await taken(b.J)).toBe(gJ);
    // The booking: its redemption sale is the booking's total, once.
    expect(gH).toBe(b.bookingTotal);

    const hours = (pkg: string) => hoursOf.get(pkg) ?? 0;
    const mix = { h1: 0, h2: 0, full: 0 };
    const addMix = (pkg: string, people: number) => {
      const h = hours(pkg);
      if (h === 1) mix.h1 += people;
      else if (h === 2) mix.h2 += people;
      else if (h >= 3) mix.full += people;
    };
    addMix(twoHoursId, 2); // A
    addMix(oneHourId, 4); // B: three children and an adult on one cart line
    addMix(twoHoursId, 2); // G
    addMix(bookingPackageId, b.bookingKids + b.bookingAdults); // H
    addMix(twoHoursId, 1); // I
    addMix(twoHoursId, 3); // J: both cart lines

    const tickets = gA + gB + gG + gH;
    // I, and the whole of J: never split by line.
    const dropoff = gI + gJ;
    // F&B: money other than credit, less the cash part of its refunds.
    const fnbC = Math.max(0, gC - b.creditUsedC - (b.refundC - b.refundC));
    const fnbC2 = Math.max(0, gC2 - b.refundC2);
    const merch = Math.max(0, gD - gD);
    const counted = [b.A, b.B, b.C, b.C2, b.D, b.G, b.H, b.I, b.J];
    const rows = await ctx.db.select().from(sale).where(inArray(sale.id, counted));
    const vat = rows.reduce((s, r) => s + r.taxInclusiveSatang + r.taxExclusiveSatang, 0);
    const service = rows.reduce((s, r) => s + r.serviceChargeSatang, 0);
    const discounts = rows.reduce((s, r) => s + r.discountSatang, 0);
    expect((await saleOf(b.G)).discountSatang).toBe(15_000);

    expect(await dayRow(T)).toMatchObject({
      formulaVersion: 1,
      provisional: true,
      frozen: false,
      ticketsSatang: tickets,
      fnbSatang: fnbC + fnbC2,
      merchSatang: merch,
      partiesSatang: 0,
      dropoffSatang: dropoff,
      revenueSatang: tickets + fnbC + fnbC2 + merch + dropoff,
      txnCount: 9,
      creditPaidSatang: b.creditUsedC - b.refundC,
      guestsKids: 1 + 3 + 1 + b.bookingKids + 1 + 2,
      guestsAdults: 1 + 1 + 1 + b.bookingAdults + 1,
      mix1h: mix.h1,
      mix2h: mix.h2,
      mixFullDay: mix.full,
      partiesCount: 0,
      refundsSatang: b.refundC + b.refundC2 + gD,
      discountsSatang: discounts,
      compsSatang: 0,
      vatSatang: vat,
      serviceSatang: service,
      byChannel: { [SALES_BOOTH_CHANNEL]: { revenue: gG, txn_count: 1 } },
    });
  });

  it('today’s hours add up to today, bucket by bucket', async () => {
    const day = (await dayRow(T))!;
    const hours = await hourRows(T);
    const sum = (k: 'ticketsSatang' | 'fnbSatang' | 'merchSatang' | 'dropoffSatang' | 'revenueSatang' | 'txnCount' | 'guests') =>
      hours.reduce((s, h) => s + h[k], 0);
    expect(sum('ticketsSatang')).toBe(day.ticketsSatang);
    expect(sum('fnbSatang')).toBe(day.fnbSatang);
    expect(sum('merchSatang')).toBe(day.merchSatang);
    expect(sum('dropoffSatang')).toBe(day.dropoffSatang);
    expect(sum('revenueSatang')).toBe(day.revenueSatang);
    expect(sum('txnCount')).toBe(day.txnCount);
    expect(sum('guests')).toBe(day.guestsKids + day.guestsAdults);
  });

  it('O carries its 01:30 sale and the refund made today; each lands in the hour it was rung up', async () => {
    const gO1 = (await saleOf(built.O1)).grossSatang;
    const gO2 = (await saleOf(built.O2)).grossSatang;
    expect(await dayRow(O)).toMatchObject({
      provisional: false,
      ticketsSatang: gO1 - built.refundO1 + gO2,
      revenueSatang: gO1 - built.refundO1 + gO2,
      txnCount: 2,
      refundsSatang: built.refundO1,
      guestsKids: 2,
      guestsAdults: 2,
      mix1h: 2,
      mix2h: 2,
    });
    expect((await hourRows(O)).map((h) => [h.hour, h.revenueSatang, h.txnCount, h.guests])).toEqual([
      [1, gO2, 1, 2],
      [14, gO1 - built.refundO1, 1, 2],
    ]);
    // Nothing of O's reached today.
    const today = (await dayRow(T))!;
    expect(today.refundsSatang).toBe(built.refundC + built.refundC2 + (await saleOf(built.D)).grossSatang);
  });

  it('a box sale for O synced after O was rolled marks O and is corrected on the next run, in its own hour', async () => {
    const before = (await dayRow(O))!;
    const late = await boxSale(new Date(`${O}T15:10:00+07:00`), { packageId: oneHourId, kids: 1, adults: 1 });
    expect(await salesMarks()).toEqual([O]);
    const gLate = (await saleOf(late)).grossSatang;
    await rollAll();
    expect(await dayRow(O)).toMatchObject({
      ticketsSatang: before.ticketsSatang + gLate,
      revenueSatang: before.revenueSatang + gLate,
      txnCount: before.txnCount + 1,
      guestsKids: before.guestsKids + 1,
      guestsAdults: before.guestsAdults + 1,
      mix1h: before.mix1h + 2,
      provisional: false,
    });
    expect((await hourRows(O)).find((h) => h.hour === 15)).toMatchObject({ revenueSatang: gLate, txnCount: 1, guests: 2 });
    expect(await salesMarks()).toEqual([]);
  });

  it('H4 — credit is counted once: granted with the ticket, never again when it is spent', async () => {
    const today = (await dayRow(T))!;
    // Revenue is the money that came in for the day's counted sales, less what
    // went back out as money: credit spent, and credit restored, are neither.
    const counted = [built.A, built.B, built.C, built.C2, built.D, built.G, built.H, built.I, built.J];
    const attempts = await ctx.db.select().from(paymentAttempt).where(inArray(paymentAttempt.saleId, counted));
    const moneyIn = attempts
      .filter((a) => a.status === 'approved' && a.method !== 'wallet')
      .reduce((s, a) => s + a.amountSatang, 0);
    const refunds = await ctx.db.select().from(refund).where(inArray(refund.saleId, counted));
    const refundIds = refunds.map((r) => r.id);
    const restored = refundIds.length
      ? (await ctx.db.select().from(walletEntry).where(and(inArray(walletEntry.refundId, refundIds), eq(walletEntry.kind, 'refund'))))
          .reduce((s, e) => s + e.amountSatang, 0)
      : 0;
    const moneyOut = refunds.reduce((s, r) => s + r.amountSatang, 0) - restored;
    expect(today.revenueSatang).toBe(moneyIn - moneyOut);
    expect(today.creditPaidSatang).toBe(built.creditUsedC - built.refundC);
  });

  it('H8 — the booking is counted once: its gateway payment carries no sale and adds nothing', async () => {
    const bookingAttempts = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(and(eq(paymentAttempt.branchId, branchId), sql`${paymentAttempt.saleId} is null and ${paymentAttempt.status} = 'approved'`));
    expect(bookingAttempts.length).toBeGreaterThanOrEqual(1);
    const today = (await dayRow(T))!;
    // Rolled again from scratch, the booking still sits in Tickets exactly once.
    await ctx.db.delete(dailySummary).where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, T)));
    await rollupDailyBranchDay(ctx.db, clock, T, new Date());
    expect((await dayRow(T))!.ticketsSatang).toBe(today.ticketsSatang);
    const redemption = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, built.H));
    expect(redemption.reduce((s, a) => s + a.amountSatang, 0)).toBe(built.bookingTotal);
  });
});

// --- The frozen flag -------------------------------------------------------------------

describe('lane G review: a frozen day is never rewritten by any job or hook', () => {
  it('H10 — O frozen: a further refund, a late box sale, every job and the Health control leave its rows exactly as they were', async () => {
    await ctx.db
      .update(dailySummary)
      .set({ frozen: true })
      .where(and(eq(dailySummary.branchId, branchId), eq(dailySummary.businessDate, O), eq(dailySummary.source, 'oto_pos')));
    const legacyId = newId();
    await ctx.db.insert(dailySummary).values({
      id: legacyId,
      operatorId,
      branchId,
      businessDate: T,
      source: 'pisell',
      formulaVersion: 30,
      frozen: true,
      computedAt: new Date('2026-01-01T00:00:00Z'),
      revenueSatang: 123_400,
      inputFingerprint: 'legacy',
    });
    const before = await dayRow(O);
    const hoursBefore = await hourRows(O);
    const legacyBefore = await dayRow(T, 'pisell');

    // The hooks: a refund of O's sale, and another of O's box sales arriving now.
    await refundOf(built.O1, { mode: 'custom', amountSatang: 10_000 });
    await boxSale(new Date(`${O}T16:45:00+07:00`), { packageId: twoHoursId, kids: 1, adults: 1 });
    expect(await salesMarks()).toContain(O);

    // Every job, directly, through the runner, and through the Health page.
    await rollAll();
    await runWalletLiabilityJob(ctx.db, new Date());
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused', PROCESS_ROLES: 'api,jobs' });
    const runner = createJobRunner({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    expect(await runner.runJob(ROLLUP_DAILY_JOB, { force: true })).toBe('ok');
    expect(await runner.runJob(ROLLUP_HOURLY_JOB, { force: true })).toBe('ok');
    const control = await post(admin, '/ops/test-controls/rollup.run');
    expect(control.statusCode, control.body).toBe(200);
    // A run the next day, when O is long over and today is no longer provisional.
    await rollAll(new Date(Date.now() + 24 * 60 * 60 * 1000));

    expect(await dayRow(O)).toEqual(before);
    expect(await hourRows(O)).toEqual(hoursBefore);
    expect(await dayRow(T, 'pisell')).toEqual(legacyBefore);
    // Its marks were spent, not left to be retried forever.
    expect(await salesMarks()).not.toContain(O);
  });
});

// --- Races and replays -----------------------------------------------------------------

let receipt = 0;

/** A finalised cash sale written as the ledger holds one, through any connection. */
async function ledgerSale(db: Db, date: string, at: Date, grossSatang: number): Promise<string> {
  const saleId = newId();
  receipt += 1;
  await db.insert(sale).values({
    id: saleId,
    operatorId,
    branchId,
    stationId: tillId,
    businessDate: date,
    businessDayStart: '05:00',
    timezone: 'Asia/Bangkok',
    occurredAt: at,
    createdByAccountId: receptionAccountId,
    pricingMode: 'weekday',
    pricingModeReason: 'Weekday pricing',
    customerTier: 'tourist',
    engineVersion: 's216-review',
    taxConfig: {},
    taxBreakdown: {},
    subtotalSatang: grossSatang,
    netSatang: grossSatang,
    grossSatang,
    receiptSeries: 'RV9',
    receiptSeq: receipt,
    receiptNumber: `RV9-${receipt}`,
    status: 'finalised',
    finalisedAt: at,
  });
  await db.insert(saleLine).values({
    id: newId(),
    saleId,
    operatorId,
    branchId,
    businessDate: date,
    lineNo: 1,
    cartLineId: newId(),
    kind: 'kids',
    ticketPackageId: twoHoursId,
    label: '2 Hours Play — Kids',
    taxableCategory: 'tickets',
    quantity: 1,
    unitSatang: grossSatang,
    baseSatang: grossSatang,
    netSatang: grossSatang,
    grossSatang,
    customerTier: 'tourist',
    kidCount: 1,
    stayHours: 2,
  });
  await db.insert(paymentAttempt).values({
    id: newId(),
    operatorId,
    branchId,
    saleId,
    stationId: tillId,
    businessDate: date,
    method: 'cash',
    methodCode: 'cash',
    status: 'approved',
    amountSatang: grossSatang,
    paidAt: at,
    createdAt: at,
  });
  return saleId;
}

describe('lane G review: races and replays', () => {
  it('a sale that commits while the rollup is writing its day is not lost: its mark outlives the claim', async () => {
    await ledgerSale(ctx.db, M, new Date(`${M}T11:00:00+07:00`), 50_000);
    const claimedBy = 'review:mid-rollup';
    const claims = await claimDirtyDates(ctx.db, 'sales', claimedBy, new Date());
    const claimM = claims.find((c) => c.businessDate === M)!;
    expect(claimM).toBeDefined();
    for (const other of claims.filter((c) => c !== claimM)) await releaseDirtyClaim(ctx.db, other, claimedBy);

    // A second connection writes a sale for M and holds its transaction open.
    const client = new pg.Client({ connectionString: ctx.app.env.DATABASE_URL });
    await client.connect();
    try {
      const other = drizzle(client, { schema }) as unknown as Db;
      await client.query('BEGIN');
      await ledgerSale(other, M, new Date(`${M}T12:00:00+07:00`), 70_000);

      // The rollup writes M meanwhile, and spends its claim.
      expect(await rollupDailyBranchDay(ctx.db, clock, M, new Date(), { claim: claimM, claimedBy })).toBe('written');
      expect((await dayRow(M))!.revenueSatang).toBe(50_000);
      expect(await salesMarks()).not.toContain(M);

      // The sale commits: its mark lands, unclaimed, for the next run.
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
    const [mark] = await ctx.db
      .select()
      .from(dirtyDate)
      .where(and(eq(dirtyDate.kind, 'sales'), eq(dirtyDate.branchId, branchId), eq(dirtyDate.businessDate, M)));
    expect(mark).toMatchObject({ claimedAt: null, claimedBy: null });
    await rollAll();
    expect(await dayRow(M)).toMatchObject({ revenueSatang: 120_000, txnCount: 2 });
    expect((await hourRows(M)).map((h) => [h.hour, h.revenueSatang])).toEqual([
      [11, 50_000],
      [12, 70_000],
    ]);
  });

  it('a mark that lands between the claim and the write keeps its row for the next run', async () => {
    const claimedBy = 'review:between';
    await ledgerSale(ctx.db, M, new Date(`${M}T13:00:00+07:00`), 10_000);
    const [claim] = (await claimDirtyDates(ctx.db, 'sales', claimedBy, new Date())).filter((c) => c.businessDate === M);
    expect(claim).toBeDefined();
    // Another sale for M commits after the claim was taken.
    await ledgerSale(ctx.db, M, new Date(`${M}T14:00:00+07:00`), 20_000);
    await rollupDailyBranchDay(ctx.db, clock, M, new Date(), { claim: claim!, claimedBy });
    expect(await salesMarks()).toContain(M);
    await rollAll();
    expect(await salesMarks()).not.toContain(M);
    expect(await dayRow(M)).toMatchObject({ revenueSatang: 150_000, txnCount: 4 });
  });

  it('H9 — two whole runs at once, with marks on several days, write one row per day with the right figures', async () => {
    for (const date of [O, M, T]) {
      await ctx.db.execute(sql`select analytics.mark_dirty_date(${operatorId}::uuid, ${branchId}::uuid, ${date}::date, 'sales', 'review')`);
    }
    const before = await ctx.db.select().from(dailySummary).where(eq(dailySummary.branchId, branchId)).orderBy(dailySummary.businessDate);
    const now = new Date();
    await Promise.all([runDailyRollupJob(ctx.db, now), runDailyRollupJob(ctx.db, now), runHourlyRollupJob(ctx.db, now)]);
    await Promise.all([runHourlyRollupJob(ctx.db, now), runHourlyRollupJob(ctx.db, now)]);
    const after = await ctx.db.select().from(dailySummary).where(eq(dailySummary.branchId, branchId)).orderBy(dailySummary.businessDate);
    const keys = after.map((r) => `${r.businessDate}|${r.source}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Nothing moved in the ledger, so nothing was rewritten.
    expect(after).toEqual(before);
    expect(await salesMarks()).toEqual([]);
  });

  it('a replayed job writes nothing, through the runner and the Health page alike', async () => {
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused', PROCESS_ROLES: 'api,jobs' });
    const runner = createJobRunner({ db: ctx.db, env, log: ctx.app.log, channels: [] });
    expect(await runner.runJob(ROLLUP_DAILY_JOB, { force: true })).toBe('ok');
    expect(await runner.runJob(ROLLUP_HOURLY_JOB, { force: true })).toBe('ok');
    const daily = await ctx.db.select().from(dailySummary).orderBy(dailySummary.id);
    const hourly = await ctx.db.select().from(hourlySummary).orderBy(hourlySummary.id);
    expect(await runner.runJob(ROLLUP_DAILY_JOB, { force: true })).toBe('ok');
    expect(await runner.runJob(ROLLUP_HOURLY_JOB, { force: true })).toBe('ok');
    expect((await post(admin, '/ops/test-controls/rollup.run')).statusCode).toBe(200);
    expect(await ctx.db.select().from(dailySummary).orderBy(dailySummary.id)).toEqual(daily);
    expect(await ctx.db.select().from(hourlySummary).orderBy(hourlySummary.id)).toEqual(hourly);
    const runs = await ctx.db.select().from(opsRun).where(eq(opsRun.name, ROLLUP_DAILY_JOB)).orderBy(opsRun.startedAt);
    expect(runs.at(-1)).toMatchObject({ outcome: 'ok' });
    expect((runs.at(-1)!.detail as Record<string, number>).written).toBe(0);
  });
});
