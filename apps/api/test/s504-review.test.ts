import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify as verifyArgon } from '@node-rs/argon2';
import {
  auditLog,
  band,
  booking,
  bookingRedemption,
  box,
  boxCommand,
  branch,
  closeDb,
  device,
  deviceCredential,
  getDb,
  kioskSession,
  opsRun,
  paymentAttempt,
  printJob,
  sale,
  schema,
  station,
  stationDevice,
  syncChange,
  ticketPackage,
  wallet,
  walletEntry,
  type Db,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type BoxAgent,
  type CredentialStore,
  type PrintNowOutcome,
  type PrintRequest,
} from '@oto/box-agent';
import { KIOSK_DEVICE_SCOPES, KIOSK_REASONS, newId, type KioskRedeemAnswer, type PrinterFault } from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { injectedTransport, type CuttableLink } from './box-link';
import { boxStoreFor } from '../src/lib/box-store';
import { AppError } from '../src/lib/errors';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { bookingQrOf } from '../src/services/booking-payment';
import { BOOKING_CLAIM_WAIT_MS, redeemBooking } from '../src/services/bookings';
import {
  KIOSK_PRINT_BUDGET_MS,
  KIOSK_PRINT_KEEPALIVE_MS,
  KIOSK_PRINT_RUN,
  authenticateKiosk,
  redeemAtKiosk,
  startKioskSession,
  type KioskDeviceAuth,
  type KioskPrinter,
} from '../src/services/kiosk';
import { kioskDesk } from '../src/services/kiosk-staff';

/**
 * SCRUM-504 — INDEPENDENT REVIEW of fix lane F1 (the kiosk print window).
 *
 * Written against the lane, not with it, on the virtual kiosk box (the code a
 * Pi runs, attached in-process) and a pool built the way production builds
 * one. Every attack is the review brief's, driven with the clock:
 *
 *   1. the money and the paper with the windows scaled down — the
 *      idle-in-transaction window below a slow print, at production's own
 *      ratios: bands out, a structured `failed` ending carrying the true count,
 *      the booking still redeemable, a retry that issues once, and the
 *      connection never ended by the server;
 *   2. the cap — a set bound to outlast the budget is called off inside the
 *      window, with and without the keep-alive;
 *   3. the till kept waiting behind a long print, a real concurrent caller:
 *      refused by name within its bound, told "already redeemed" when the
 *      print commits inside it, and served when the print is called off;
 *   4. the order — receipt first: a receipt fault puts out no band; a band
 *      fault after the receipt, and what the guest, the desk and the next
 *      family's receipt are told;
 *   5. (the wording is pinned in apps/pos/test/s504-review-wording.test.ts);
 *   6. the production pool and a lost hold.
 */

const PGW_SECRET = randomBytes(32).toString('hex');
const SECRET_A = randomBytes(32).toString('hex');
const SECRET_B = randomBytes(32).toString('hex');
const SHA = (value: string) => createHash('sha256').update(value).digest('hex');

/** A plain weekday a week out, clear of weekends and the seeded holiday range. */
const WEEKDAY = (() => {
  const day = new Date(Date.now() + 7 * 86_400_000);
  for (;;) {
    const iso = new Date(day.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
    const nearHoliday = iso >= '2026-11-23' && iso <= '2026-11-25';
    if (dow !== 0 && dow !== 6 && !nearHoliday) return iso;
    day.setUTCDate(day.getUTCDate() + 1);
  }
})();

let ctx: TestContext;
let reception: string;
let operatorId: string;
let centralId: string;
let tillId: string;
let twoHoursId: string;

interface Kiosk {
  stationId: string;
  boxId: string;
  credentialId: string;
  secret: string;
  bandPrinterId: string;
  receiptPrinterId: string;
  creds: CredentialStore;
  agent: BoxAgent | null;
}
let A: Kiosk;
let B: Kiosk;

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.504.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

interface Paid {
  id: string;
  reference: string;
  qr: string;
}

async function bookAndPay(kids = 2, adults = 1): Promise<Paid> {
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: CENTRAL_BRANCH_CODE,
      phone: '0812345678',
      parentName: 'Khun Mali',
      tier: 'tourist',
      visitDate: WEEKDAY,
      lines: [{ packageId: twoHoursId, kids, adults }],
    },
  });
  expect(made.statusCode, made.body).toBe(200);
  const id = made.json().id as string;
  const opened = await ctx.app.inject({
    method: 'POST',
    url: `/public/bookings/${id}/checkout`,
    remoteAddress: familyAddress(),
    payload: { method: 'card' },
  });
  expect(opened.statusCode, opened.body).toBe(200);
  const pressed = await ctx.app.inject({
    method: 'POST',
    url: `/webhooks/2c2p/hosted/${opened.json().attemptId as string}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'action=pay',
  });
  expect(pressed.statusCode, pressed.body).toBe(200);
  const [row] = await ctx.db.select().from(booking).where(eq(booking.id, id));
  expect(row!.status).toBe('paid');
  return { id, reference: row!.reference, qr: bookingQrOf(row!)! };
}

async function press(kiosk: Kiosk, qr: string): Promise<{ statusCode: number; body: KioskRedeemAnswer }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${kiosk.stationId}/kiosk/redeem`,
    headers: { authorization: `Bearer ${kiosk.secret}` },
    payload: { actionId: newId(), qr },
  });
  return { statusCode: res.statusCode, body: res.json() as KioskRedeemAnswer };
}

function tillRedeem(bookingId: string) {
  return ctx.app.inject({
    method: 'POST',
    url: `/bookings/${bookingId}/redeem`,
    headers: { cookie: reception },
    payload: {},
  });
}

async function bootAgent(kiosk: Kiosk, name: string): Promise<BoxAgent> {
  const link: CuttableLink = { cut: false };
  const agent = createBoxAgent({
    apiBaseUrl: `http://${name}.test`,
    credentials: kiosk.creds,
    hostname: name,
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, kiosk.boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { timeouts: { saleMs: 300, probeMs: 300 } },
    bands: { key: currentBandKey },
  });
  await agent.ensureRegistered();
  expect(agent.state.boxId).toBe(kiosk.boxId);
  await agent.syncConfig();
  attachInProcessBox(agent);
  return agent;
}

function stopAgent(kiosk: Kiosk | undefined): void {
  if (!kiosk?.agent) return;
  kiosk.agent.stop();
  detachInProcessBox(kiosk.agent);
  kiosk.agent = null;
}

/** The label counter of a simulated printer: what physically came out. */
function seqOf(kiosk: Kiosk, deviceId: string): number {
  return kiosk.agent?.printing()?.simulator(deviceId)?.printouts().at(-1)?.seq ?? 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, holds: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await holds())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await sleep(20);
  }
}

/** A fault on a simulated printer from the n-th channel it opens (its status check is the first). */
function faultFromOpen(kiosk: Kiosk, deviceId: string, fault: PrinterFault, nth: number): () => void {
  const sim = kiosk.agent!.printing()!.simulator(deviceId)!;
  const original = sim.connect;
  let opens = 0;
  (sim as { connect: typeof sim.connect }).connect = () => {
    opens += 1;
    if (opens >= nth) sim.setFault(fault);
    return original.call(sim);
  };
  return () => {
    (sim as { connect: typeof sim.connect }).connect = original;
    sim.clearFaults();
  };
}

/**
 * A band printer that takes `ms` to put each band out, as a real 4B-2082A
 * may: the label counts as out only when its session closes, after the delay.
 * A status check writes nothing and is as quick as ever.
 */
function slowLabels(kiosk: Kiosk, ms: number): () => void {
  const sim = kiosk.agent!.printing()!.simulator(kiosk.bandPrinterId)!;
  const original = sim.connect;
  (sim as { connect: typeof sim.connect }).connect = () => {
    const channel = original.call(sim);
    let wrote = false;
    return {
      write: (bytes: Uint8Array) => {
        wrote = true;
        return channel.write(bytes);
      },
      query: (bytes: Uint8Array, expect: number, timeoutMs: number) => channel.query(bytes, expect, timeoutMs),
      close: async () => {
        if (wrote) await sleep(ms);
        return channel.close();
      },
    };
  };
  return () => {
    (sim as { connect: typeof sim.connect }).connect = original;
  };
}

/**
 * A pool with production's own settings (`packages/db` `getDb`: a 10 s
 * statement timeout, an idle-in-transaction window) with the window scaled
 * down, named so its connection can be found. It COUNTS every error and every
 * end its clients see: a connection the server ended is one that errored.
 */
function prodLikePool(idleInTransactionMs: number, applicationName: string) {
  const url = (ctx.db as unknown as { $client: { options: { connectionString: string } } }).$client.options
    .connectionString;
  const pool = new pg.Pool({
    connectionString: url,
    idle_in_transaction_session_timeout: idleInTransactionMs,
    statement_timeout: 10_000,
    application_name: applicationName,
  } as pg.PoolConfig);
  const seen = { clientErrors: [] as string[], clientEnds: 0, poolErrors: 0 };
  pool.on('error', () => {
    seen.poolErrors += 1;
  });
  pool.on('connect', (client) => {
    client.on('error', (err: Error & { code?: string }) => seen.clientErrors.push(err.code ?? err.message));
    client.on('end', () => {
      seen.clientEnds += 1;
    });
  });
  return { db: drizzle(pool, { schema }) as unknown as Db, seen, end: () => pool.end().catch(() => undefined) };
}

/** A printer that records every request it is handed and passes it to the kiosk box's own. */
function recording(kiosk: Kiosk): { printer: KioskPrinter; requests: PrintRequest[] } {
  const real = kiosk.agent!.printing()!;
  const requests: PrintRequest[] = [];
  return {
    requests,
    printer: {
      printNow(reqs, options) {
        requests.push(...reqs);
        return real.printNow(reqs, options);
      },
    },
  };
}

/** A printer held at a gate: the redemption stays open, the booking row claimed, until released. */
function gatedPrinter(real: KioskPrinter) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const printer: KioskPrinter = {
    async printNow(requests, options): Promise<PrintNowOutcome> {
      entered();
      await gate;
      return real.printNow(requests, options);
    },
  };
  return { printer, release, reached };
}

async function footprint(bookingId: string) {
  const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;
  const n = sql<number>`count(*)::int`;
  return {
    sales: await count(ctx.db.select({ n }).from(sale).where(eq(sale.bookingId, bookingId))),
    claims: await count(ctx.db.select({ n }).from(bookingRedemption).where(eq(bookingRedemption.bookingId, bookingId))),
    bands: await count(ctx.db.select({ n }).from(band)),
    jobs: await count(ctx.db.select({ n }).from(printJob)),
    commands: await count(ctx.db.select({ n }).from(boxCommand)),
    wallets: await count(ctx.db.select({ n }).from(wallet)),
    walletEntries: await count(ctx.db.select({ n }).from(walletEntry)),
    attemptsOnASale: await count(
      ctx.db
        .select({ n })
        .from(paymentAttempt)
        .where(and(sql`${paymentAttempt.payload} ->> 'bookingId' = ${bookingId}`, sql`${paymentAttempt.saleId} is not null`)),
    ),
    deltas: await count(
      ctx.db.select({ n }).from(syncChange).where(and(eq(syncChange.entityType, 'booking'), eq(syncChange.entityId, bookingId))),
    ),
    redeemAudit: await count(
      ctx.db.select({ n }).from(auditLog).where(and(eq(auditLog.entityId, bookingId), like(auditLog.action, 'booking.redeem%'))),
    ),
  };
}

async function bookingStatus(id: string): Promise<string> {
  const [row] = await ctx.db.select({ status: booking.status }).from(booking).where(eq(booking.id, id));
  return row!.status;
}

async function sessionOf(actionId: string) {
  const [row] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.actionId, actionId));
  return row!;
}

async function printRunOf(actionId: string) {
  const rows = await ctx.db.select().from(opsRun).where(and(eq(opsRun.name, KIOSK_PRINT_RUN), eq(opsRun.actionId, actionId)));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function deviceOf(kiosk: Kiosk): Promise<KioskDeviceAuth> {
  return authenticateKiosk(ctx.db, `Bearer ${kiosk.secret}`);
}

async function deskEntryOf(bookingId: string) {
  return (await kioskDesk(ctx.db, operatorId, centralId)).entries.find((e) => e.booking.id === bookingId);
}

type Detail = { stage: string; printed: number; bandsPrinted: number; bandMayBeOut?: boolean; jobs: number };

async function insertKiosk(name: string, prefix: string, secret: string, addr: number): Promise<Kiosk> {
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId,
    branchId: centralId,
    name: `${name} box`,
    slot: `s504-${prefix.toLowerCase()}`,
    role: 'kiosk',
    status: 'unclaimed',
  });
  const bandPrinterId = newId();
  const receiptPrinterId = newId();
  await ctx.db.insert(device).values([
    {
      id: bandPrinterId,
      operatorId,
      branchId: centralId,
      boxId,
      kind: 'band_printer',
      label: `${name} Band Printer`,
      transport: 'simulated',
      address: `192.168.89.${addr}:9100`,
      model: '4B-2082A',
      protocol: 'tspl2',
      reachability: 'reachable',
      paperStatus: 'ok',
    },
    {
      id: receiptPrinterId,
      operatorId,
      branchId: centralId,
      boxId,
      kind: 'receipt_printer',
      label: `${name} Receipt Printer`,
      transport: 'simulated',
      address: `192.168.89.${addr + 1}:9100`,
      model: 'Xprinter XP-80',
      protocol: 'escpos',
      reachability: 'reachable',
      paperStatus: 'ok',
    },
  ]);
  const stationId = newId();
  await ctx.db.insert(station).values({
    id: stationId,
    operatorId,
    branchId: centralId,
    boxId,
    name,
    kind: 'kiosk',
    codePrefix: prefix,
    capabilities: [],
    accessScope: 'all_staff',
  });
  await ctx.db.insert(stationDevice).values([
    { id: newId(), stationId, role: 'kids_band', deviceId: bandPrinterId },
    { id: newId(), stationId, role: 'adult_band', deviceId: bandPrinterId },
    { id: newId(), stationId, role: 'receipt', deviceId: receiptPrinterId },
  ]);
  const credentialId = newId();
  await ctx.db.insert(deviceCredential).values({
    id: credentialId,
    operatorId,
    branchId: centralId,
    kind: 'kiosk',
    stationId,
    label: `${name} screen`,
    secretHash: SHA(secret),
    scopes: [...KIOSK_DEVICE_SCOPES],
    pairedAt: new Date(),
  });
  return { stationId, boxId, credentialId, secret, bandPrinterId, receiptPrinterId, creds: memoryCredentialStore(), agent: null };
}

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTOTESTMERCHANT',
      PGW_SECRET_KEY: PGW_SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  centralId = central!.id;
  operatorId = central!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, centralId), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  await takeStation(ctx.app, reception, tillId);
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, centralId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  A = await insertKiosk('S504 Kiosk A', 'SA', SECRET_A, 31);
  B = await insertKiosk('S504 Kiosk B', 'SB', SECRET_B, 41);
  A.agent = await bootAgent(A, 's504-kiosk-a');
  B.agent = await bootAgent(B, 's504-kiosk-b');
}, 240_000);

afterAll(async () => {
  stopAgent(A);
  stopAgent(B);
  await closeDb().catch(() => undefined);
  await ctx?.close();
  await teardownAll();
});

// --- 1 ------------------------------------------------------------------------------

describe('attack 1 — the clock: the idle-in-transaction window below a slow print', () => {
  it('the production limits sit inside the production window, and the claim bound inside the statement timeout', () => {
    // `packages/db` getDb: idle_in_transaction_session_timeout 30 s, statement_timeout 10 s.
    expect(KIOSK_PRINT_KEEPALIVE_MS).toBeLessThan(30_000 / 2);
    expect(KIOSK_PRINT_BUDGET_MS).toBeLessThan(30_000);
    expect(BOOKING_CLAIM_WAIT_MS).toBeLessThan(10_000);
  });

  /**
   * Production's ratios scaled down by about twenty: the window is 2 s, the
   * keep-alive 0.25 s, the budget 1.5 s, and a band takes 1 s — five bands,
   * a five-second set, two and a half windows long.
   */
  it('a five-band set at 1 s a band against a 2 s window: called off at its budget, the true count, nothing kept, no connection ended, the retry issues once', async () => {
    const paid = await bookAndPay(3, 2);
    const prod = prodLikePool(2_000, 's504-clock');
    const before = await footprint(paid.id);
    const startBand = seqOf(A, A.bandPrinterId);
    const startReceipt = seqOf(A, A.receiptPrinterId);
    const device = await deviceOf(A);
    const actionId = newId();
    const undo = slowLabels(A, 1_000);
    let answer: KioskRedeemAnswer;
    let threw: unknown = null;
    try {
      answer = await redeemAtKiosk(
        prod.db,
        { requestId: newId(), printLimits: { keepaliveMs: 250, budgetMs: 1_500 } },
        device,
        { actionId, qr: paid.qr },
      ).catch((err: unknown) => {
        threw = err;
        throw err;
      });
      // Let the band that was in the printer when the kiosk stopped waiting come out.
      await sleep(1_600);
    } finally {
      undo();
    }
    expect(threw, 'a structured answer, never a thrown 500').toBeNull();
    const physical = seqOf(A, A.bandPrinterId) - startBand;
    const receipts = seqOf(A, A.receiptPrinterId) - startReceipt;

    // The server never ended the redemption's connection.
    expect(prod.seen).toEqual({ clientErrors: [], clientEnds: 0, poolErrors: 0 });
    await prod.end();

    // The answer: failed, the kiosk's own stop, and the count the tray really holds.
    expect(answer!).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printTimeout, bands: [], walletCreditSatang: 0 });
    expect(answer!.desk.required).toBe(true);
    expect(physical, 'some bands came out, not all').toBeGreaterThanOrEqual(1);
    const session = await sessionOf(actionId);
    const detail = session.detail as Detail;
    const totalBands = detail.jobs - receipts;
    expect(totalBands).toBe(5);
    expect(physical).toBeLessThan(totalBands);
    expect(answer!.calledOffBands, 'the guest is told exactly what is in the tray').toBe(physical);
    expect(detail.bandsPrinted + (detail.bandMayBeOut ? 1 : 0)).toBe(physical);
    expect(detail.printed).toBe(receipts + detail.bandsPrinted);
    expect(session).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printTimeout, saleId: null, bookingId: paid.id });
    const run = await printRunOf(actionId);
    expect(run).toMatchObject({ outcome: 'failed', errorCode: KIOSK_REASONS.printTimeout });
    expect(run.detail).toMatchObject({ committed: false, printed: detail.printed, bandsPrinted: detail.bandsPrinted });

    // The money: nothing of the redemption was kept, and nothing prints late.
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
    await A.agent!.printing()!.jobs.tick();
    expect(seqOf(A, A.bandPrinterId) - startBand).toBe(physical);

    // The desk is told the bands to take back.
    expect(await deskEntryOf(paid.id)).toMatchObject({ state: 'to_redeem', bandsIssued: 0, calledOffBands: physical });

    // The retry at the kiosk issues it — once.
    const retried = await press(A, paid.qr);
    expect(retried.statusCode).toBe(200);
    expect(retried.body).toMatchObject({ outcome: 'issued', calledOffBands: 0 });
    expect(retried.body.bands).toHaveLength(5);
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    // Asked again, nothing more.
    const again = await press(A, paid.qr);
    expect(again.body).toMatchObject({ outcome: 'failed', reason: 'BOOKING_ALREADY_REDEEMED', calledOffBands: 0 });
  }, 60_000);

  it('each band slower than the whole window: the keep-alive holds the redemption, and the set commits whole with no connection ended', async () => {
    const paid = await bookAndPay(2, 1);
    // A band takes 1.2 s; the window is 1 s.
    const prod = prodLikePool(1_000, 's504-keepalive');
    const startBand = seqOf(A, A.bandPrinterId);
    const device = await deviceOf(A);
    const actionId = newId();
    const undo = slowLabels(A, 1_200);
    let answer: KioskRedeemAnswer;
    try {
      answer = await redeemAtKiosk(
        prod.db,
        { requestId: newId(), printLimits: { keepaliveMs: 200, budgetMs: 15_000 } },
        device,
        { actionId, qr: paid.qr },
      );
    } finally {
      undo();
    }
    expect(prod.seen).toEqual({ clientErrors: [], clientEnds: 0, poolErrors: 0 });
    await prod.end();
    expect(answer).toMatchObject({ outcome: 'issued', reason: null, calledOffBands: 0 });
    expect(answer.bands).toHaveLength(3);
    expect(seqOf(A, A.bandPrinterId) - startBand).toBe(3);
    expect(await bookingStatus(paid.id)).toBe('redeemed');
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    expect((await printRunOf(actionId)).detail).toMatchObject({ committed: true, bandsPrinted: 3 });
  }, 60_000);
});

// --- 2 ------------------------------------------------------------------------------

describe('attack 2 — the cap', () => {
  it('no keep-alive at all: a band longer than the window, the budget below it — called off and rolled back by the kiosk before the server would end it', async () => {
    const paid = await bookAndPay(2, 1);
    // The window 1.6 s, the budget 1 s, one band alone 2 s; the keep-alive never fires.
    const prod = prodLikePool(1_600, 's504-cap');
    const before = await footprint(paid.id);
    const startBand = seqOf(A, A.bandPrinterId);
    const device = await deviceOf(A);
    const actionId = newId();
    const undo = slowLabels(A, 2_000);
    let answer: KioskRedeemAnswer;
    const started = Date.now();
    let answeredAfter = 0;
    try {
      answer = await redeemAtKiosk(
        prod.db,
        { requestId: newId(), printLimits: { keepaliveMs: 60_000, budgetMs: 1_000 } },
        device,
        { actionId, qr: paid.qr },
      );
      answeredAfter = Date.now() - started;
      // The window passes with the connection back in the pool: nothing to end.
      await sleep(2_300);
    } finally {
      undo();
    }
    expect(prod.seen, 'the server never ended the connection').toEqual({ clientErrors: [], clientEnds: 0, poolErrors: 0 });
    await prod.end();
    expect(answeredAfter, 'answered inside the window plus the lookup').toBeLessThan(1_600 + 1_500);
    expect(answer).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printTimeout, bands: [] });
    const physical = seqOf(A, A.bandPrinterId) - startBand;
    expect(physical, 'the band in the printer came out; none after it started').toBe(1);
    expect(answer.calledOffBands).toBe(1);
    const detail = (await sessionOf(actionId)).detail as Detail;
    expect(detail).toMatchObject({ stage: 'print', bandsPrinted: 0, bandMayBeOut: true });
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
  }, 60_000);

  it('with the keep-alive holding it past the window, the budget is still the cap', async () => {
    const paid = await bookAndPay(3, 2);
    // The window 0.8 s, the budget 2.5 s, five bands at 1 s each.
    const prod = prodLikePool(800, 's504-cap-held');
    const startBand = seqOf(A, A.bandPrinterId);
    const device = await deviceOf(A);
    const actionId = newId();
    const undo = slowLabels(A, 1_000);
    let answer: KioskRedeemAnswer;
    const started = Date.now();
    let answeredAfter = 0;
    try {
      answer = await redeemAtKiosk(
        prod.db,
        { requestId: newId(), printLimits: { keepaliveMs: 200, budgetMs: 2_500 } },
        device,
        { actionId, qr: paid.qr },
      );
      answeredAfter = Date.now() - started;
      await sleep(1_300);
    } finally {
      undo();
    }
    expect(prod.seen).toEqual({ clientErrors: [], clientEnds: 0, poolErrors: 0 });
    await prod.end();
    expect(answer).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printTimeout });
    expect(answeredAfter, 'stopped at the budget, not at the end of a five-second set').toBeLessThan(4_500);
    const physical = seqOf(A, A.bandPrinterId) - startBand;
    expect(physical).toBeGreaterThanOrEqual(2);
    expect(physical).toBeLessThan(5);
    expect(answer.calledOffBands).toBe(physical);
    expect(await bookingStatus(paid.id)).toBe('paid');
  }, 60_000);
});

// --- 3 ------------------------------------------------------------------------------

describe('attack 3 — the till kept waiting behind a long print (a real concurrent caller)', () => {
  it('a print longer than the bound: the till is refused by name within it, then reads the booking redeemed', async () => {
    const paid = await bookAndPay(2, 1);
    const prod = prodLikePool(30_000, 's504-till-long');
    const startReceipt = seqOf(A, A.receiptPrinterId);
    const device = await deviceOf(A);
    const undo = slowLabels(A, 2_500);
    let kiosk: Promise<KioskRedeemAnswer> | null = null;
    try {
      kiosk = redeemAtKiosk(prod.db, { requestId: newId(), printLimits: { keepaliveMs: 250, budgetMs: 20_000 } }, device, {
        actionId: newId(),
        qr: paid.qr,
      });
      // The receipt is out: the booking is claimed, and the bands are printing.
      await until('the kiosk receipt is out', () => seqOf(A, A.receiptPrinterId) > startReceipt);
      const started = Date.now();
      const till = await tillRedeem(paid.id);
      const waited = Date.now() - started;
      expect(till.statusCode, till.body).toBe(409);
      expect(till.json().error.code).toBe('BOOKING_REDEMPTION_IN_PROGRESS');
      expect(till.json().error.message).toContain('S504 Kiosk A');
      expect(waited, 'the till waited its own bound, no longer').toBeGreaterThanOrEqual(BOOKING_CLAIM_WAIT_MS - 300);
      expect(waited).toBeLessThan(BOOKING_CLAIM_WAIT_MS + 2_500);
      expect((await kiosk).outcome).toBe('issued');
    } finally {
      undo();
      await kiosk?.catch(() => undefined);
      await prod.end();
    }
    const again = await tillRedeem(paid.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('BOOKING_ALREADY_REDEEMED');
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
  }, 60_000);

  it('a print that commits inside the bound: the waiting till is told "already redeemed", not refused as in progress', async () => {
    const paid = await bookAndPay(2, 1);
    const startReceipt = seqOf(A, A.receiptPrinterId);
    const device = await deviceOf(A);
    const undo = slowLabels(A, 1_000);
    let kiosk: Promise<KioskRedeemAnswer> | null = null;
    try {
      kiosk = redeemAtKiosk(ctx.db, { requestId: newId(), printLimits: { keepaliveMs: 250, budgetMs: 20_000 } }, device, {
        actionId: newId(),
        qr: paid.qr,
      });
      await until('the kiosk receipt is out', () => seqOf(A, A.receiptPrinterId) > startReceipt);
      const started = Date.now();
      const till = await tillRedeem(paid.id);
      const waited = Date.now() - started;
      expect(till.statusCode, till.body).toBe(409);
      expect(till.json().error.code).toBe('BOOKING_ALREADY_REDEEMED');
      expect(waited).toBeLessThan(BOOKING_CLAIM_WAIT_MS);
      expect(waited, 'it really waited on the print').toBeGreaterThan(1_500);
      expect((await kiosk).outcome).toBe('issued');
    } finally {
      undo();
      await kiosk?.catch(() => undefined);
    }
  }, 60_000);

  it('a print called off at its budget while the till waits: the till then redeems it, once, and the desk is told of the kiosk bands', async () => {
    const paid = await bookAndPay(2, 1);
    const startReceipt = seqOf(A, A.receiptPrinterId);
    const startBand = seqOf(A, A.bandPrinterId);
    const device = await deviceOf(A);
    const actionId = newId();
    const undo = slowLabels(A, 1_500);
    let kiosk: Promise<KioskRedeemAnswer> | null = null;
    try {
      kiosk = redeemAtKiosk(ctx.db, { requestId: newId(), printLimits: { keepaliveMs: 250, budgetMs: 2_000 } }, device, {
        actionId,
        qr: paid.qr,
      });
      await until('the kiosk receipt is out', () => seqOf(A, A.receiptPrinterId) > startReceipt);
      const started = Date.now();
      const till = await tillRedeem(paid.id);
      expect(till.statusCode, till.body).toBe(200);
      expect(Date.now() - started).toBeLessThan(BOOKING_CLAIM_WAIT_MS);
      const answer = await kiosk;
      expect(answer).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printTimeout });
      await sleep(1_700);
      const physical = seqOf(A, A.bandPrinterId) - startBand;
      expect(physical).toBeGreaterThanOrEqual(1);
      expect(answer.calledOffBands).toBe(physical);
      const sales = await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id));
      expect(sales).toHaveLength(1);
      expect(sales[0]).toMatchObject({ stationId: tillId, deviceCredentialId: null });
      // Redeemed at the till, the family is done at the desk — and still told to hand the kiosk bands back.
      expect(await deskEntryOf(paid.id)).toMatchObject({ state: 'done', calledOffBands: physical });
    } finally {
      undo();
      await kiosk?.catch(() => undefined);
    }
  }, 60_000);

  it('the bound is the claim statement alone: the caller’s own statement timeout is put back, timed out or not, and its transaction stays usable', async () => {
    const paid = await bookAndPay(1, 1);
    const holder = await (ctx.db as unknown as { $client: pg.Pool }).$client.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from pos.booking where id = $1 for update', [paid.id]);
      const read = async (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) =>
        ((await tx.execute(sql`select current_setting('statement_timeout') as v`)).rows[0] as { v: string }).v;
      const seen = await ctx.db
        .transaction(async (tx) => {
          await tx.execute(sql`set local statement_timeout = '7s'`);
          const started = Date.now();
          let refused: unknown = null;
          try {
            await redeemBooking(tx, {
              bookingId: paid.id,
              operatorId,
              actorAccountId: null,
              stationId: tillId,
              bandCodes: [],
              claimWaitMs: 400,
            });
          } catch (err) {
            refused = err;
          }
          const waited = Date.now() - started;
          const after = await read(tx);
          throw Object.assign(new Error('roll back'), { probe: { refused, waited, after } });
        })
        .catch((err: { probe?: { refused: unknown; waited: number; after: string } }) => err.probe!);
      expect(seen.refused).toBeInstanceOf(AppError);
      expect((seen.refused as AppError).code).toBe('BOOKING_REDEMPTION_IN_PROGRESS');
      expect(seen.waited).toBeLessThan(2_000);
      expect(seen.after, 'the caller’s own 7 s is back after a timed-out claim').toBe('7s');
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    // Free, the claim goes through and the setting is still the caller's.
    const free = await ctx.db
      .transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '7s'`);
        const row = await redeemBooking(tx, {
          bookingId: paid.id,
          operatorId,
          actorAccountId: null,
          stationId: tillId,
          bandCodes: [],
          claimWaitMs: 400,
        });
        const after = ((await tx.execute(sql`select current_setting('statement_timeout') as v`)).rows[0] as { v: string }).v;
        throw Object.assign(new Error('roll back'), { probe: { status: row.status, after } });
      })
      .catch((err: { probe?: { status: string; after: string } }) => err.probe!);
    expect(free).toEqual({ status: 'redeemed', after: '7s' });
    expect(await bookingStatus(paid.id)).toBe('paid');
  }, 60_000);

  /**
   * REVIEW NOTE (pinned as it stands) — the refusal names "the earliest press
   * still running on this booking", ordered by `kiosk_session.started_at`:
   * since K2 that is when the guest first touched the screen, not when the
   * press arrived (`detail.pressedAt`). A second kiosk whose guest touched its
   * screen first, and pressed second, is WAITING — yet it is the one named. In
   * a three-way race the till is told the wrong kiosk. Goes red when fixed.
   */
  it('REVIEW NOTE (pinned): in a three-way race the waiting till is told the kiosk that is itself waiting', async () => {
    const paid = await bookAndPay(1, 1);
    const devA = await deviceOf(A);
    const devB = await deviceOf(B);
    // B's guest touches the screen first.
    const bSession = newId();
    await startKioskSession(ctx.db, { requestId: newId() }, devB, { sessionId: bSession });
    await sleep(50);
    const gated = gatedPrinter(A.agent!.printing()!);
    const first = redeemAtKiosk(ctx.db, { requestId: newId(), printer: gated.printer }, devA, { actionId: newId(), qr: paid.qr });
    let second: Promise<KioskRedeemAnswer> | null = null;
    try {
      await gated.reached;
      const till = tillRedeem(paid.id);
      await until('the till waits on the claim', async () => {
        const rows = (await ctx.db.execute(sql`select count(*)::int as n from pg_locks where not granted`)).rows as Array<{ n: number }>;
        return rows[0]!.n > 0;
      });
      await sleep(400);
      // B's guest presses second, and waits behind A as the till does.
      second = redeemAtKiosk(ctx.db, { requestId: newId(), printer: B.agent!.printing()! }, devB, {
        actionId: newId(),
        qr: paid.qr,
        sessionId: bSession,
      });
      const told = await till;
      expect(told.statusCode, told.body).toBe(409);
      expect(told.json().error.code).toBe('BOOKING_REDEMPTION_IN_PROGRESS');
      // A holds the claim and is printing; the till is told B.
      expect(told.json().error.message).toContain('S504 Kiosk B');
      expect(told.json().error.message).not.toContain('S504 Kiosk A');
    } finally {
      gated.release();
    }
    expect((await first).outcome).toBe('issued');
    // B, still inside its own bound when A committed, reads it redeemed.
    expect((await second!).reason).toBe('BOOKING_ALREADY_REDEEMED');
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
  }, 60_000);
});

// --- 4 ------------------------------------------------------------------------------

describe('attack 4 — the order: the receipt first, the bands last', () => {
  it('the receipt printer out of paper at its first job: no band came out, nothing redeemed, the guest told nothing came out', async () => {
    const paid = await bookAndPay(2, 1);
    const before = await footprint(paid.id);
    const startBand = seqOf(A, A.bandPrinterId);
    const startReceipt = seqOf(A, A.receiptPrinterId);
    const undo = faultFromOpen(A, A.receiptPrinterId, 'paper_out', 2);
    let scan: Awaited<ReturnType<typeof press>>;
    try {
      scan = await press(A, paid.qr);
    } finally {
      undo();
    }
    expect(scan.statusCode).toBe(200);
    expect(scan.body).toMatchObject({ outcome: 'failed', reason: 'PRINTER_PAPER_OUT', calledOffBands: 0 });
    expect(seqOf(A, A.bandPrinterId) - startBand).toBe(0);
    expect(seqOf(A, A.receiptPrinterId) - startReceipt).toBe(0);
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
  }, 30_000);

  /**
   * REVIEW DEFECT (pinned as it stands) — the receipt printed before a band
   * set that then failed is NOT plain paper waste.
   *
   * The kiosk's sale is numbered inside the redemption from the kiosk
   * station's gapless series (`allocateReceipt`, FOR UPDATE on
   * `receipt_series`). The receipt now prints FIRST, carrying that number;
   * a band fault then rolls the redemption back — and the number with it. The
   * next sale at the kiosk is given the same number. Two families hold
   * receipts bearing one receipt number, and only one of them is a sale.
   *
   * And nobody is told: the guest's answer counts bands only (`calledOffBands`
   * 0, so the screen says "Nothing was used up"), and the desk entry says
   * "nothing was issued" with no word of the receipt in the family's hand.
   * With bands first (before this lane) a band fault never put a receipt out.
   *
   * Goes red the day it is fixed: whoever fixes it rewrites the pinned block.
   */
  it('REVIEW DEFECT (pinned): a band fault after the receipt leaves a numbered receipt for no sale, and the next family is given its number', async () => {
    const first = await bookAndPay(2, 1);
    const before = await footprint(first.id);
    const startBand = seqOf(A, A.bandPrinterId);
    const startReceipt = seqOf(A, A.receiptPrinterId);
    const device = await deviceOf(A);
    const rec = recording(A);
    const actionId = newId();
    // The band printer's status check passes; its first band meets an unplugged printer.
    const undo = faultFromOpen(A, A.bandPrinterId, 'unreachable', 2);
    let answer: KioskRedeemAnswer;
    try {
      answer = await redeemAtKiosk(ctx.db, { requestId: newId(), printer: rec.printer }, device, { actionId, qr: first.qr });
    } finally {
      undo();
    }
    expect(answer).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE', bands: [] });
    expect(seqOf(A, A.bandPrinterId) - startBand, 'no band came out').toBe(0);
    const plainPaper = seqOf(A, A.receiptPrinterId) - startReceipt;
    expect(plainPaper, 'the plain paper did').toBeGreaterThanOrEqual(1);
    expect(await bookingStatus(first.id)).toBe('paid');
    expect(await footprint(first.id)).toEqual(before);
    const detail = (await sessionOf(actionId)).detail as Detail;
    expect(detail).toMatchObject({ stage: 'print', printed: plainPaper, bandsPrinted: 0 });
    // What came out, in order: the receipt — and, on a package that loads credit, a credit
    // voucher showing credit (and a QR) for a wallet that was rolled back with the rest.
    const out = rec.requests.slice(0, plainPaper).map((r) => r.kind);
    expect(out).toContain('receipt');
    expect(out.every((k) => k === 'receipt' || k === 'credit_voucher')).toBe(true);
    const firstReceipt = rec.requests.find((r) => r.kind === 'receipt');
    const firstReceiptText = JSON.stringify(firstReceipt!.job);

    // What the guest and the desk are told: no paper at all.
    expect(answer.calledOffBands).toBe(0);
    expect(Object.keys(answer)).not.toContain('printed');
    expect(await deskEntryOf(first.id)).toMatchObject({ reason: 'PRINTER_UNREACHABLE', calledOffBands: 0, state: 'to_redeem' });

    // The next family at the same kiosk.
    const next = await bookAndPay(1, 1);
    const recNext = recording(A);
    const issued = await redeemAtKiosk(ctx.db, { requestId: newId(), printer: recNext.printer }, device, {
      actionId: newId(),
      qr: next.qr,
    });
    expect(issued.outcome).toBe('issued');
    const [nextSale] = await ctx.db.select().from(sale).where(eq(sale.bookingId, next.id));
    expect(nextSale!.receiptNumber).toBeTruthy();
    const nextReceiptText = JSON.stringify(recNext.requests.find((r) => r.kind === 'receipt')!.job);
    const numberOn = (text: string) => /"receiptNumber":"([^"]+)"/.exec(text)?.[1] ?? null;
    expect(numberOn(nextReceiptText)).toBe(nextSale!.receiptNumber);
    // PINNED: the first family's receipt — for a sale that does not exist — bears the next family's number.
    expect(numberOn(firstReceiptText)).toBe(nextSale!.receiptNumber);
  }, 30_000);
});

// --- 6 ------------------------------------------------------------------------------

describe('attack 6 — the production pool and a lost hold', () => {
  /**
   * REVIEW DEFECT (pinned as it stands) — the lost-hold ending
   * (`KIOSK_PRINT_HOLD_LOST`, "answered — not a 500") is only reachable on a
   * pool whose clients carry an 'error' listener. The lane's own test builds
   * one (`prodLikeDb` adds `client.on('error')`); production's `getDb` does
   * not, and pg-pool takes its idle listener off a client while it is checked
   * out. When the server ends the connection of a redemption holding its
   * transaction through a print, pg's client EMITS 'error' (with or without a
   * query in flight: the socket's end does it); with no listener that is an
   * uncaught exception, and `apps/api/src/index.ts` exits the process on one.
   * The kiosk's hold makes that window up to the whole budget long. (A probe
   * run during this review on `getDb` itself: "UNCAUGHT 57P01".)
   *
   * Pinned on production's own pool: the redemption's client has no 'error'
   * listener while the print holds it, and a termination arrives on it as an
   * 'error' EVENT. Goes red when a listener is attached (kiosk or pool).
   */
  it('REVIEW DEFECT (pinned): on production’s pool a connection lost during the print is an unhandled error event, not a kiosk ending', async () => {
    const paid = await bookAndPay(1, 1);
    const url = (ctx.db as unknown as { $client: { options: { connectionString: string } } }).$client.options
      .connectionString;
    const prod = getDb(url, { applicationName: 's504-getdb' });
    const pool = (prod as unknown as {
      $client: pg.Pool & { _clients: pg.PoolClient[]; _idle: Array<{ client: pg.PoolClient }> };
    }).$client;
    const device = await deviceOf(A);
    const gated = gatedPrinter(A.agent!.printing()!);
    const pending = redeemAtKiosk(
      prod,
      { requestId: newId(), printer: gated.printer, printLimits: { keepaliveMs: 60_000 } },
      device,
      { actionId: newId(), qr: paid.qr },
    );
    let answer: KioskRedeemAnswer | null = null;
    try {
      await gated.reached;
      const idle = new Set(pool._idle.map((i) => i.client));
      const held = pool._clients.filter((c) => !idle.has(c));
      expect(held, 'the redemption holds one connection while it prints').toHaveLength(1);
      // PINNED: nothing listens for an error on it.
      expect(held[0]!.listenerCount('error')).toBe(0);
      // Observe — only now, so the test process survives it — what the client does when the server ends it.
      const events: string[] = [];
      held[0]!.on('error', (err: Error & { code?: string }) => events.push(err.code ?? err.message));
      await ctx.db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 's504-getdb' and xact_start is not null`,
      );
      await until('the client hears of it', () => events.length > 0);
      expect(events[0], 'an error EVENT, which without a listener is an uncaught exception').toBe('57P01');
    } finally {
      gated.release();
      answer = await pending.catch(() => null);
      await closeDb().catch(() => undefined);
    }
    // With the listener this test added, the lane's ending is what it says.
    expect(answer?.outcome).toBe('failed');
    expect(await bookingStatus(paid.id)).toBe('paid');
  }, 60_000);
});
