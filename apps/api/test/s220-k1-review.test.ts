import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
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
  device,
  deviceCredential,
  kioskSession,
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
import {
  KIOSK_DEVICE_SCOPES,
  KIOSK_REASONS,
  KIOSK_REDEEM_SCOPE,
  newId,
  type KioskRedeemAnswer,
  type PrinterFault,
} from '@oto/shared';
import {
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { injectedTransport, type CuttableLink } from './box-link';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { bookingQrOf } from '../src/services/booking-payment';
import { redeemBookingAtCounter } from '../src/services/booking-redemption';
import { authenticateKiosk, redeemAtKiosk, type KioskDeviceAuth, type KioskPrinter } from '../src/services/kiosk';

/**
 * S2-20 K1 (SCRUM-217) — INDEPENDENT REVIEW of the kiosk redemption core.
 *
 * Written against the lane, not with it: every attack here is one the review
 * brief names, driven on the virtual kiosk box (`createBoxAgent`, the code a Pi
 * runs, attached in-process as the api attaches its own):
 *
 *   1. the money and the band — a print fault AFTER the bands were minted (the
 *      printer check passed, a band already came out) leaves the booking paid
 *      and redeemable, no claim, sale, band, grant, job or box command, and
 *      the till can still redeem it;
 *   2. idempotency — the same action id replayed across a box restart issues
 *      once; a press a dead process left open; two kiosks racing one booking
 *      make one redemption, whichever of them wins the row lock;
 *   3. the credential — staff without the device credential, the device
 *      credential on every other route in the api, a second park's kiosk on
 *      this park's booking, a credential revoked between the bearer check and
 *      the sale;
 *   4. the audit rows carry the station, the box and the credential;
 *   5. the kiosk reuses the till's redemption services and keeps no copy.
 */

const PGW_SECRET = randomBytes(32).toString('hex');
const SECRET_A = randomBytes(32).toString('hex');
const SECRET_B = randomBytes(32).toString('hex');
const SECRET_CHALONG = randomBytes(32).toString('hex');
const SHA = (value: string) => createHash('sha256').update(value).digest('hex');
const KIOSK_ROUTE = '/box/v1/station/:stationId/kiosk/redeem';

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
let chalongId: string;
let tillId: string;
let twoHoursId: string;

interface Kiosk {
  stationId: string;
  boxId: string | null;
  credentialId: string;
  secret: string;
  bandPrinterId: string | null;
  receiptPrinterId: string | null;
  creds: CredentialStore;
  agent: BoxAgent | null;
}
let A: Kiosk;
let B: Kiosk;
let CHALONG: Kiosk;

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.220.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

interface Paid {
  id: string;
  reference: string;
  qr: string;
  totalSatang: number;
}

/** Book and pay the way a family does: the public route, then the simulated gateway's hosted page. */
async function bookAndPay(kids = 2, adults = 1, extra: Record<string, unknown> = {}): Promise<Paid> {
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
      lines: [{ packageId: twoHoursId, kids, adults, ...extra }],
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
  const qr = bookingQrOf(row!);
  expect(qr).toBeTruthy();
  return { id, reference: row!.reference, qr: qr!, totalSatang: row!.totalSatang };
}

type Answer = KioskRedeemAnswer & { error?: { code: string } };

async function press(
  kiosk: Kiosk,
  qr: string,
  opts: { actionId?: string; path?: string; headers?: Record<string, string> } = {},
): Promise<{ statusCode: number; body: Answer; actionId: string }> {
  const actionId = opts.actionId ?? newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${opts.path ?? kiosk.stationId}/kiosk/redeem`,
    headers: opts.headers ?? { authorization: `Bearer ${kiosk.secret}` },
    payload: { actionId, qr },
  });
  return { statusCode: res.statusCode, body: res.json() as Answer, actionId };
}

/** A box agent over the test platform, with its own credential store so a "restart" keeps its identity. */
function makeAgent(boxId: string, name: string, creds: CredentialStore): BoxAgent {
  const link: CuttableLink = { cut: false };
  return createBoxAgent({
    apiBaseUrl: `http://${name}.test`,
    credentials: creds,
    hostname: name,
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    printing: { retryDelayMs: 0 },
    terminal: { timeouts: { saleMs: 300, probeMs: 300 } },
    bands: { key: currentBandKey },
  });
}

async function bootAgent(kiosk: Kiosk, name: string): Promise<BoxAgent> {
  const agent = makeAgent(kiosk.boxId!, name, kiosk.creds);
  // True on a first registration; a restart loads the identity it already holds and answers false.
  await agent.ensureRegistered();
  expect(agent.state.registered).toBe(true);
  expect(agent.state.boxId).toBe(kiosk.boxId);
  await agent.syncConfig();
  attachInProcessBox(agent);
  return agent;
}

function stopAgent(kiosk: Kiosk): void {
  if (!kiosk.agent) return;
  kiosk.agent.stop();
  detachInProcessBox(kiosk.agent);
  kiosk.agent = null;
}

/** The label counter of a simulated printer (the simulator keeps only the last 20 printouts). */
function seqOf(kiosk: Kiosk, deviceId: string | null): number {
  const sim = kiosk.agent?.printing()?.simulator(deviceId ?? '');
  return sim?.printouts().at(-1)?.seq ?? 0;
}

/**
 * Inject a fault into a simulated printer at a chosen moment — when `when()`
 * first holds at a channel open. The printer check (`probe`) opens a channel
 * too, so a trigger on "a band already came out" passes the check and fails
 * the job after it, which is the case the lane's own tests do not reach.
 */
function faultWhen(kiosk: Kiosk, deviceId: string, fault: PrinterFault, when: () => boolean): () => void {
  const sim = kiosk.agent!.printing()!.simulator(deviceId)!;
  const original = sim.connect;
  (sim as { connect: typeof sim.connect }).connect = () => {
    if (when()) sim.setFault(fault);
    return original.call(sim);
  };
  return () => {
    (sim as { connect: typeof sim.connect }).connect = original;
    sim.clearFaults();
  };
}

/** Everything a redemption would write, counted platform-wide. */
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
      ctx.db
        .select({ n })
        .from(syncChange)
        .where(and(eq(syncChange.entityType, 'booking'), eq(syncChange.entityId, bookingId))),
    ),
    redeemAudit: await count(
      ctx.db
        .select({ n })
        .from(auditLog)
        .where(and(eq(auditLog.entityId, bookingId), like(auditLog.action, 'booking.redeem%'))),
    ),
  };
}

async function bookingStatus(id: string): Promise<string> {
  const [row] = await ctx.db.select({ status: booking.status }).from(booking).where(eq(booking.id, id));
  return row!.status;
}

async function kioskAudit(sessionId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, sessionId), like(auditLog.action, 'kiosk.%')));
}

/** The kiosk audit rows name the station, the box and the credential, and the press. */
function expectWhere(row: typeof auditLog.$inferSelect, kiosk: Kiosk, actionId: string): void {
  expect(row.actorAccountId).toBeNull();
  expect(row.actionId).toBe(actionId);
  expect(row.after).toMatchObject({
    stationId: kiosk.stationId,
    boxId: kiosk.boxId,
    deviceCredentialId: kiosk.credentialId,
  });
}

async function deviceOf(kiosk: Kiosk): Promise<KioskDeviceAuth> {
  return authenticateKiosk(ctx.db, `Bearer ${kiosk.secret}`);
}

/** A printer that prints nothing and says every job came out — for the side of a race that is not under test. */
function okPrinter(deviceId: string): KioskPrinter {
  return {
    async printNow(requests: readonly PrintRequest[]): Promise<PrintNowOutcome> {
      return {
        complete: true,
        printed: requests.length,
        fault: null,
        outcomes: requests.map((r) => ({
          id: r.id,
          status: 'printed' as const,
          attempts: 1,
          deviceId,
          role: r.role ?? null,
          stationId: r.stationId ?? null,
          errorCode: null,
          errorMessage: null,
          overflow: [],
          elapsedMs: 1,
        })),
      };
    },
  };
}

/** A printer held at a gate: the redemption's transaction stays open (and the booking row locked) until released. */
function gatedPrinter(real: KioskPrinter) {
  let release!: (print: boolean) => void;
  let entered!: () => void;
  const gate = new Promise<boolean>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const printer: KioskPrinter = {
    async printNow(requests, options) {
      entered();
      if (await gate) return real.printNow(requests, options);
      const first = requests[0]!;
      const fault = {
        id: first.id,
        status: 'failed' as const,
        attempts: 1,
        deviceId: null,
        role: first.role ?? null,
        stationId: first.stationId ?? null,
        errorCode: 'PRINTER_UNREACHABLE',
        errorMessage: 'gated printer told to fail',
        overflow: [],
        elapsedMs: null,
      };
      return { complete: false, printed: 0, outcomes: [fault], fault };
    },
  };
  return { printer, release, reached };
}

/** Wait until some other backend is blocked on a lock — proof the second claim is really waiting. */
async function untilSomeoneWaitsOnALock(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const [row] = (
      await ctx.db.execute(sql`select count(*)::int as n from pg_locks where not granted`)
    ).rows as Array<{ n: number }>;
    if (row!.n > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('nobody ever waited on the booking row lock');
}

async function insertKiosk(
  branchId: string,
  name: string,
  prefix: string,
  secret: string,
  withBox: boolean,
  addr: number,
): Promise<Kiosk> {
  let boxId: string | null = null;
  let bandPrinterId: string | null = null;
  let receiptPrinterId: string | null = null;
  if (withBox) {
    boxId = newId();
    await ctx.db.insert(box).values({
      id: boxId,
      operatorId,
      branchId,
      name: `${name} box`,
      slot: `review-${prefix.toLowerCase()}`,
      role: 'kiosk',
      status: 'unclaimed',
    });
    bandPrinterId = newId();
    receiptPrinterId = newId();
    await ctx.db.insert(device).values([
      {
        id: bandPrinterId,
        operatorId,
        branchId,
        boxId,
        kind: 'band_printer',
        label: `${name} Band Printer`,
        transport: 'simulated',
        address: `192.168.88.${addr}:9100`,
        model: '4B-2082A',
        protocol: 'tspl2',
        reachability: 'reachable',
        paperStatus: 'ok',
      },
      {
        id: receiptPrinterId,
        operatorId,
        branchId,
        boxId,
        kind: 'receipt_printer',
        label: `${name} Receipt Printer`,
        transport: 'simulated',
        address: `192.168.88.${addr + 1}:9100`,
        model: 'Xprinter XP-80',
        protocol: 'escpos',
        reachability: 'reachable',
        paperStatus: 'ok',
      },
    ]);
  }
  const stationId = newId();
  await ctx.db.insert(station).values({
    id: stationId,
    operatorId,
    branchId,
    boxId,
    name,
    kind: 'kiosk',
    codePrefix: prefix,
    capabilities: [],
    accessScope: 'all_staff',
  });
  if (bandPrinterId && receiptPrinterId) {
    await ctx.db.insert(stationDevice).values([
      { id: newId(), stationId, role: 'kids_band', deviceId: bandPrinterId },
      { id: newId(), stationId, role: 'adult_band', deviceId: bandPrinterId },
      { id: newId(), stationId, role: 'receipt', deviceId: receiptPrinterId },
    ]);
  }
  const credentialId = newId();
  await ctx.db.insert(deviceCredential).values({
    id: credentialId,
    operatorId,
    branchId,
    kind: 'kiosk',
    stationId,
    label: `${name} screen`,
    secretHash: SHA(secret),
    scopes: [...KIOSK_DEVICE_SCOPES],
    pairedAt: new Date(),
  });
  return {
    stationId,
    boxId,
    credentialId,
    secret,
    bandPrinterId,
    receiptPrinterId,
    creds: memoryCredentialStore(),
    agent: null,
  };
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
  const [chalong] = await ctx.db.select().from(branch).where(eq(branch.code, CHALONG_BRANCH_CODE));
  centralId = central!.id;
  chalongId = chalong!.id;
  operatorId = central!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, centralId), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  await takeStation(ctx.app, reception, tillId);
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, centralId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  // Two kiosks at Central, each on its own box with its own two printers; a third at Chalong.
  A = await insertKiosk(centralId, 'Review Kiosk A', 'RA', SECRET_A, true, 201);
  B = await insertKiosk(centralId, 'Review Kiosk B', 'RB', SECRET_B, true, 211);
  CHALONG = await insertKiosk(chalongId, 'Review Kiosk Chalong', 'RC', SECRET_CHALONG, false, 0);
  A.agent = await bootAgent(A, 'review-kiosk-a');
  B.agent = await bootAgent(B, 'review-kiosk-b');
}, 240_000);

afterAll(async () => {
  stopAgent(A);
  stopAgent(B);
  await ctx?.close();
  await teardownAll();
});

describe('attack 1 — a print fault after the bands were issued', () => {
  it('a band that fails after the printer check passed and one band came out: nothing redeemed, the till redeems it', async () => {
    const paid = await bookAndPay(2, 1);
    const before = await footprint(paid.id);
    const startBand = seqOf(A, A.bandPrinterId);
    const startReceipt = seqOf(A, A.receiptPrinterId);
    // The check passes (no band yet), the first band prints, the second meets an unplugged printer.
    const undo = faultWhen(A, A.bandPrinterId!, 'unreachable', () => seqOf(A, A.bandPrinterId) - startBand >= 1);
    let scan: Awaited<ReturnType<typeof press>>;
    try {
      scan = await press(A, paid.qr);
    } finally {
      undo();
    }
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE', bands: [], walletCreditSatang: 0 });
    expect(scan.body.desk.required).toBe(true);
    // One band physically came out before the fault; nothing else did.
    expect(seqOf(A, A.bandPrinterId) - startBand).toBe(1);
    expect(seqOf(A, A.receiptPrinterId) - startReceipt).toBe(0);

    // The money and the band: not one row of the redemption survived.
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);

    // The session says what happened, and that a band is out to be taken back.
    const [session] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, scan.body.sessionId));
    expect(session).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE', saleId: null, bookingId: paid.id });
    expect(session!.bandIds).toEqual([]);
    expect(session!.detail).toMatchObject({ stage: 'print', printed: 1, deviceId: A.bandPrinterId });
    const rows = await kioskAudit(scan.body.sessionId);
    expect(rows.map((r) => r.action)).toEqual(['kiosk.abort']);
    expectWhere(rows[0]!, A, scan.actionId);
    expect(rows[0]!.after).toMatchObject({ reason: 'PRINTER_UNREACHABLE', stage: 'print', printed: 1 });

    // Nothing was queued, so nothing prints late when the printer comes back.
    await A.agent!.printing()!.jobs.tick();
    expect(seqOf(A, A.bandPrinterId) - startBand).toBe(1);

    // The till redeems it, once; the kiosk then reads it as redeemed.
    const till = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${paid.id}/redeem`,
      headers: { cookie: reception },
      payload: {},
    });
    expect(till.statusCode, till.body).toBe(200);
    const sales = await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id));
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ stationId: tillId, deviceCredentialId: null });
    const again = await press(A, paid.qr);
    expect(again.body).toMatchObject({ outcome: 'failed', reason: 'BOOKING_ALREADY_REDEEMED' });
  });

  it('the receipt printer failing after every band came out: still nothing redeemed, and the session counts the bands out', async () => {
    const paid = await bookAndPay(2, 1);
    const before = await footprint(paid.id);
    const startBand = seqOf(A, A.bandPrinterId);
    const undo = faultWhen(A, A.receiptPrinterId!, 'unreachable', () => seqOf(A, A.bandPrinterId) - startBand >= 3);
    let scan: Awaited<ReturnType<typeof press>>;
    try {
      scan = await press(A, paid.qr);
    } finally {
      undo();
    }
    expect(scan.body).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE' });
    expect(seqOf(A, A.bandPrinterId) - startBand, 'all three bands came out before the receipt failed').toBe(3);
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
    const [session] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, scan.body.sessionId));
    expect(session!.detail).toMatchObject({ stage: 'print', printed: 3, deviceId: A.receiptPrinterId });

    // With the printer back, a new press at the kiosk issues it — once.
    const retried = await press(A, paid.qr);
    expect(retried.body.outcome).toBe('issued');
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
  });

  /**
   * REVIEW DEFECT, PINNED AS IT STANDS — this test describes today's wrong
   * behaviour on purpose, so the suite is green while the defect stands and
   * goes red the day it is fixed. Whoever fixes it rewrites the last block to
   * the right ending: the redemption commits, or it ends `failed` with the
   * bands that came out counted (`detail.printed`), as a 200 answer.
   *
   * The redemption's transaction sits open and idle for the whole of
   * `printNow`. Production's pool (`packages/db` `getDb`) sets
   * `idle_in_transaction_session_timeout: 30_000`, and one label job alone may
   * take up to `CHANNEL_TIMEOUTS.jobCompleteMs` (15 s): a large family's set,
   * or one slow job, outlasts the window. Postgres ends the connection after
   * the bands are out; nothing commits (the money is safe, and the gate refuses
   * a band it has no row for), but the press throws (a 500 at the kiosk) and
   * the session says `KIOSK_INTERNAL_ERROR` at stage `claim` with no `printed`
   * count, so nothing tells staff a whole set of bands is in the tray. Every
   * retry of a set that size does the same. The window is scaled down here
   * (1.5 s against a 2.5 s print) so the test is quick; the mechanism is the
   * production one.
   */
  it('REVIEW DEFECT (pinned): a print set longer than the idle-in-transaction window loses the bands it printed', async () => {
    const paid = await bookAndPay(2, 1);
    const url = (ctx.db as unknown as { $client: { options: { connectionString: string } } }).$client.options
      .connectionString;
    const pool = new pg.Pool({ connectionString: url, idle_in_transaction_session_timeout: 1_500 } as pg.PoolConfig);
    pool.on('error', () => undefined);
    // Postgres ends the idle connection itself; its client must not take the test process down with it.
    pool.on('connect', (client) => client.on('error', () => undefined));
    const prodLike = drizzle(pool, { schema }) as unknown as Db;
    const real = A.agent!.printing()!;
    const slow: KioskPrinter = {
      async printNow(requests, options) {
        await new Promise((r) => setTimeout(r, 2_500));
        return real.printNow(requests, options);
      },
    };
    const before = await footprint(paid.id);
    const startBand = seqOf(A, A.bandPrinterId);
    const device = await deviceOf(A);
    const actionId = newId();
    let thrown: unknown = null;
    try {
      await redeemAtKiosk(prodLike, { requestId: newId(), printer: slow }, device, { actionId, qr: paid.qr });
    } catch (err) {
      thrown = err;
    } finally {
      await pool.end().catch(() => undefined);
    }
    // What holds: nothing of the redemption was kept.
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
    // What is wrong: three bands came out, the press threw, and the session does not count them.
    expect(seqOf(A, A.bandPrinterId) - startBand).toBe(3);
    // The connection Postgres ended, surfacing as the transaction's failed rollback — not a kiosk ending.
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toMatch(/rollback|connection|terminat/i);
    const [session] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.actionId, actionId));
    expect(session).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.internal, saleId: null });
    expect(session!.detail).toEqual({ stage: 'claim' });
  }, 30_000);
});

describe('the device actor rings up every kind of line a booking carries', () => {
  it('socks and catalogue add-ons redeem at the kiosk at the price paid, with nobody signed in', async () => {
    const paid = await bookAndPay(1, 1, { socks: 2, addOns: [{ id: 'a-locker', quantity: 1 }, { id: 'a-cup', quantity: 1 }] });
    const scan = await press(A, paid.qr);
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.outcome, JSON.stringify(scan.body)).toBe('issued');
    const [only] = await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id));
    expect(only).toMatchObject({
      grossSatang: paid.totalSatang,
      createdByAccountId: null,
      deviceCredentialId: A.credentialId,
      status: 'finalised',
    });
  });
});

describe('attack 2 — idempotency', () => {
  it('the same action id replayed across a kiosk box restart issues once, and a press while the box is down issues nothing', async () => {
    const paid = await bookAndPay(2, 1);
    const first = await press(A, paid.qr);
    expect(first.body.outcome, JSON.stringify(first.body)).toBe('issued');
    const [only] = await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id));

    // The box goes down: a press for another booking meets a box that is not there.
    const other = await bookAndPay(1, 1);
    stopAgent(A);
    const whileDown = await press(A, other.qr);
    expect(whileDown.body).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.boxOffline });
    expect(await bookingStatus(other.id)).toBe('paid');
    const replayWhileDown = await press(A, paid.qr, { actionId: first.actionId });
    expect(replayWhileDown.body).toEqual({ ...first.body, replay: true });

    // The box restarts with the identity it had, and the press is sent again.
    A.agent = await bootAgent(A, 'review-kiosk-a');
    const startBand = seqOf(A, A.bandPrinterId);
    const replay = await press(A, paid.qr, { actionId: first.actionId });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual({ ...first.body, replay: true });
    expect(seqOf(A, A.bandPrinterId) - startBand, 'the restarted box printed nothing for the replay').toBe(0);
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, only!.id))).toHaveLength(3);
    expect(await ctx.db.select().from(kioskSession).where(eq(kioskSession.actionId, first.actionId))).toHaveLength(1);
    const rows = await kioskAudit(first.body.sessionId);
    expect(rows.map((r) => r.action)).toEqual(['kiosk.redeem']);
    expectWhere(rows[0]!, A, first.actionId);

    // The press made while it was down is answered as it was, and a new one issues.
    const replayDown = await press(A, other.qr, { actionId: whileDown.actionId });
    expect(replayDown.body).toEqual({ ...whileDown.body, replay: true });
    expect(await bookingStatus(other.id)).toBe('paid');
    const fresh = await press(A, other.qr);
    expect(fresh.body.outcome).toBe('issued');
  });

  it('a press a stopped process left open is ended as interrupted — and one still running is refused, not re-run', async () => {
    const paid = await bookAndPay(1, 1);
    const stale = newId();
    const running = newId();
    const insertOpen = (actionId: string, startedAt: Date) =>
      ctx.db.insert(kioskSession).values({
        id: newId(),
        operatorId,
        branchId: centralId,
        stationId: A.stationId,
        deviceCredentialId: A.credentialId,
        boxId: A.boxId,
        actionId,
        startedAt,
      });
    await insertOpen(stale, new Date(Date.now() - 3 * 60_000));
    await insertOpen(running, new Date());
    const before = await footprint(paid.id);

    const inFlight = await press(A, paid.qr, { actionId: running });
    expect(inFlight.statusCode).toBe(409);
    expect(inFlight.body.error?.code).toBe(KIOSK_REASONS.inProgress);

    const ended = await press(A, paid.qr, { actionId: stale });
    expect(ended.statusCode).toBe(200);
    expect(ended.body).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.interrupted, replay: true, bands: [] });
    expect(await footprint(paid.id)).toEqual(before);
    const rows = await kioskAudit(ended.body.sessionId);
    expect(rows.map((r) => r.action)).toEqual(['kiosk.abort']);
    expectWhere(rows[0]!, A, stale);
  });

  it('the same press sent twice at once issues once', async () => {
    const paid = await bookAndPay(2, 1);
    const actionId = newId();
    const [x, y] = await Promise.all([press(A, paid.qr, { actionId }), press(A, paid.qr, { actionId })]);
    const answers = [x, y];
    expect(answers.filter((a) => a.statusCode === 200 && a.body.outcome === 'issued')).toHaveLength(answers.filter((a) => a.statusCode === 200).length);
    for (const a of answers) expect([200, 409]).toContain(a.statusCode);
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    expect(await ctx.db.select().from(kioskSession).where(eq(kioskSession.actionId, actionId))).toHaveLength(1);
  });

  it('two kiosks racing one booking through the route make one redemption and one set of bands', async () => {
    const paid = await bookAndPay(2, 1);
    const startA = seqOf(A, A.bandPrinterId);
    const startB = seqOf(B, B.bandPrinterId);
    const [a, b] = await Promise.all([press(A, paid.qr), press(B, paid.qr)]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const outcomes = [a.body.outcome, b.body.outcome].sort();
    expect(outcomes).toEqual(['failed', 'issued']);
    const loser = a.body.outcome === 'failed' ? a : b;
    const loserKiosk = loser === a ? A : B;
    expect(loser.body.reason).toBe('BOOKING_ALREADY_REDEEMED');
    expect(loser.body.bands).toEqual([]);
    const sales = await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id));
    expect(sales).toHaveLength(1);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, sales[0]!.id))).toHaveLength(3);
    expect(await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id))).toHaveLength(1);
    expect(seqOf(A, A.bandPrinterId) - startA + (seqOf(B, B.bandPrinterId) - startB), 'one set of bands on paper').toBe(3);
    const lost = await kioskAudit(loser.body.sessionId);
    expect(lost.map((r) => r.action)).toEqual(['kiosk.abort']);
    expectWhere(lost[0]!, loserKiosk, loser.actionId);
  });

  it('the second kiosk waits on the first one’s row lock while it prints, then reads the booking as redeemed', async () => {
    const paid = await bookAndPay(2, 1);
    const devA = await deviceOf(A);
    const devB = await deviceOf(B);
    const gated = gatedPrinter(A.agent!.printing()!);
    const first = redeemAtKiosk(ctx.db, { requestId: newId(), printer: gated.printer }, devA, { actionId: newId(), qr: paid.qr });
    await gated.reached;
    const second = redeemAtKiosk(ctx.db, { requestId: newId(), printer: okPrinter(B.bandPrinterId!) }, devB, {
      actionId: newId(),
      qr: paid.qr,
    });
    await untilSomeoneWaitsOnALock();
    gated.release(true);
    const [a, b] = await Promise.all([first, second]);
    expect(a.outcome).toBe('issued');
    expect(b).toMatchObject({ outcome: 'failed', reason: 'BOOKING_ALREADY_REDEEMED', bands: [] });
    const [lost] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, b.sessionId));
    expect(lost!.detail).toMatchObject({ stage: 'claim' });
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
  });

  it('and when the first kiosk’s printer fails while the second waits, the second issues it — still one redemption', async () => {
    const paid = await bookAndPay(2, 1);
    const devA = await deviceOf(A);
    const devB = await deviceOf(B);
    const gated = gatedPrinter(A.agent!.printing()!);
    const startB = seqOf(B, B.bandPrinterId);
    const first = redeemAtKiosk(ctx.db, { requestId: newId(), printer: gated.printer }, devA, { actionId: newId(), qr: paid.qr });
    await gated.reached;
    const second = redeemAtKiosk(ctx.db, { requestId: newId() }, devB, { actionId: newId(), qr: paid.qr });
    await untilSomeoneWaitsOnALock();
    gated.release(false);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE' });
    expect(b.outcome).toBe('issued');
    expect(seqOf(B, B.bandPrinterId) - startB).toBe(3);
    const sales = await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id));
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ stationId: B.stationId, deviceCredentialId: B.credentialId });
  });
});

describe('attack 3 — the credential', () => {
  it('a staff session without the device credential is refused, even standing at a till and carrying other device bearers', async () => {
    const paid = await bookAndPay(1, 1);
    const cookieOnly = await press(A, paid.qr, { headers: { cookie: reception } });
    expect(cookieOnly.statusCode).toBe(401);
    expect(cookieOnly.body.error?.code).toBe('KIOSK_UNPAIRED');

    // A display credential paired to the kiosk station, even with the kiosk scope written into it.
    const displaySecret = randomBytes(32).toString('hex');
    await ctx.db.insert(deviceCredential).values({
      id: newId(),
      operatorId,
      branchId: centralId,
      kind: 'display',
      stationId: A.stationId,
      secretHash: SHA(displaySecret),
      scopes: ['display:read', KIOSK_REDEEM_SCOPE],
      pairedAt: new Date(),
    });
    // A kiosk credential with the scope, but paired to a till rather than a kiosk.
    const tillKioskSecret = randomBytes(32).toString('hex');
    await ctx.db.insert(deviceCredential).values({
      id: newId(),
      operatorId,
      branchId: centralId,
      kind: 'kiosk',
      stationId: tillId,
      secretHash: SHA(tillKioskSecret),
      scopes: [...KIOSK_DEVICE_SCOPES],
      pairedAt: new Date(),
    });
    // A kiosk credential minted but never paired.
    const unpairedSecret = randomBytes(32).toString('hex');
    await ctx.db.insert(deviceCredential).values({
      id: newId(),
      operatorId,
      branchId: centralId,
      kind: 'kiosk',
      stationId: A.stationId,
      secretHash: SHA(unpairedSecret),
      scopes: [...KIOSK_DEVICE_SCOPES],
    });
    for (const secret of [displaySecret, tillKioskSecret, unpairedSecret]) {
      const refused = await press(A, paid.qr, { headers: { cookie: reception, authorization: `Bearer ${secret}` } });
      expect(refused.statusCode).toBe(401);
      expect(refused.body.error?.code).toBe('KIOSK_UNPAIRED');
    }
    const atTill = await press(A, paid.qr, {
      path: tillId,
      headers: { authorization: `Bearer ${tillKioskSecret}` },
    });
    expect(atTill.statusCode).toBe(401);
    // Kiosk A's credential on kiosk B's path.
    const crossed = await press(A, paid.qr, { path: B.stationId });
    expect(crossed.statusCode).toBe(403);
    expect(crossed.body.error?.code).toBe('KIOSK_OTHER_STATION');
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toEqual([]);
  });

  it('a second park’s kiosk is refused this park’s booking — at the route, at the service with a working printer, and in the shared redemption', async () => {
    const paid = await bookAndPay(1, 1);
    const before = await footprint(paid.id);
    const scan = await press(CHALONG, paid.qr);
    expect(scan.statusCode).toBe(200);
    expect(scan.body).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.otherBranch, bands: [] });
    const rows = await kioskAudit(scan.body.sessionId);
    expect(rows.map((r) => r.action)).toEqual(['kiosk.abort']);
    expectWhere(rows[0]!, CHALONG, scan.actionId);

    // Not the missing box that stops it: given a printer that works, the branch rule still does.
    const devChalong = await deviceOf(CHALONG);
    const served = await redeemAtKiosk(
      ctx.db,
      { requestId: newId(), printer: okPrinter(A.bandPrinterId!) },
      devChalong,
      { actionId: newId(), qr: paid.qr },
    );
    expect(served).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.otherBranch });

    // And the shared redemption itself will not file Central's booking at Chalong's kiosk.
    await expect(
      ctx.db.transaction((tx) =>
        redeemBookingAtCounter(tx, {
          bookingId: paid.id,
          operatorId,
          actorAccountId: null,
          deviceCredentialId: CHALONG.credentialId,
          stationId: CHALONG.stationId,
          printing: 'direct',
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
  });

  it('a credential revoked between the bearer check and the sale rings nothing up', async () => {
    const paid = await bookAndPay(1, 1);
    const secret = randomBytes(32).toString('hex');
    const kiosk: Kiosk = { ...A, credentialId: newId(), secret };
    await ctx.db.insert(deviceCredential).values({
      id: kiosk.credentialId,
      operatorId,
      branchId: centralId,
      kind: 'kiosk',
      stationId: A.stationId,
      secretHash: SHA(secret),
      scopes: [...KIOSK_DEVICE_SCOPES],
      pairedAt: new Date(),
    });
    const dev = await deviceOf(kiosk);
    await ctx.db
      .update(deviceCredential)
      .set({ revokedAt: new Date(), revokedReason: 'review: revoked mid-press' })
      .where(eq(deviceCredential.id, kiosk.credentialId));
    const before = await footprint(paid.id);
    const startBand = seqOf(A, A.bandPrinterId);
    const answer = await redeemAtKiosk(ctx.db, { requestId: newId() }, dev, { actionId: newId(), qr: paid.qr });
    expect(answer).toMatchObject({ outcome: 'failed', reason: 'FORBIDDEN', bands: [] });
    expect(seqOf(A, A.bandPrinterId) - startBand).toBe(0);
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
  });

  it('the kiosk’s credential is refused on every other route the api serves', async () => {
    const paid = await bookAndPay(1, 1);
    const fill = (url: string) =>
      url
        .replace(/:stationId/g, A.stationId)
        .replace(/:bookingId|:id(?=\/|$)/g, paid.id)
        .replace(/:[A-Za-z]+/g, () => newId())
        .replace(/\*/g, 'x');
    const routes = ctx.app.routeRegistry.filter(
      (r) =>
        r.method !== 'HEAD' &&
        r.method !== 'OPTIONS' &&
        !r.config.public &&
        r.url !== '/*' &&
        r.url.replace(/\/$/, '') !== KIOSK_ROUTE,
    );
    expect(routes.length).toBeGreaterThan(100);
    const call = (r: (typeof routes)[number], headers: Record<string, string>) => {
      const withBody = r.method === 'POST' || r.method === 'PUT' || r.method === 'PATCH';
      return Promise.race([
        ctx.app.inject({
          method: r.method as 'GET',
          url: fill(r.url),
          headers,
          ...(withBody ? { payload: {} } : {}),
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
    };
    const reached: string[] = [];
    const notTheKiosks: string[] = [];
    const open = (x: Awaited<ReturnType<typeof call>>) => !!x && x.statusCode < 400;
    for (const r of routes) {
      const res = await call(r, { authorization: `Bearer ${A.secret}` });
      if (res && res.statusCode >= 400) continue;
      /**
       * Let in, or at least not refused: is that the kiosk credential's doing,
       * or does the route answer anybody — no credential at all, or a bearer
       * nobody issued (the display's pairing routes take any 64-hex bearer as
       * an unpaired screen's own self-minted token)?
       */
      const anonymous = await call(r, {});
      const stranger = await call(r, { authorization: `Bearer ${randomBytes(32).toString('hex')}` });
      const what = `${r.method} ${r.url} -> ${res ? res.statusCode : 'hung'}`;
      if (open(anonymous) || open(stranger)) notTheKiosks.push(what);
      else reached.push(what);
    }
    expect(reached, 'routes the kiosk credential opened that no stranger can').toEqual([]);
    // Informational: these answer any caller alike, so the kiosk credential adds nothing there.
    console.info(`[s220-k1-review] routes that answer any bearer alike: ${JSON.stringify(notTheKiosks)}`);
    expect(await bookingStatus(paid.id)).toBe('paid');
  }, 600_000);
});

describe('attack 4 — every kiosk audit row says where', () => {
  it('redeem, handoff and abort rows all carry the station, the box, the credential and the press', async () => {
    const rows = await ctx.db.select().from(auditLog).where(inArray(auditLog.action, ['kiosk.redeem', 'kiosk.handoff', 'kiosk.abort']));
    expect(new Set(rows.map((r) => r.action))).toEqual(new Set(['kiosk.redeem', 'kiosk.abort']));
    const kiosks = new Map([A, B, CHALONG].map((k) => [k.stationId, k]));
    for (const row of rows) {
      const after = row.after as Record<string, unknown>;
      const kiosk = kiosks.get(after.stationId as string);
      expect(kiosk, `${row.action} ${row.id} names a review kiosk`).toBeDefined();
      expect(row.actionId, `${row.action} ${row.id} carries its press`).toBeTruthy();
      expect(row.actorAccountId).toBeNull();
      expect(after).toHaveProperty('boxId', kiosk!.boxId);
      expect(after.deviceCredentialId).toBeTruthy();
      const [session] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, row.entityId!));
      expect(session!.actionId).toBe(row.actionId);
      expect(session!.stationId).toBe(after.stationId);
      expect(session!.boxId).toBe(after.boxId ?? null);
    }
  });
});

describe('attack 5 — the kiosk reuses the till’s redemption and keeps no copy', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'kiosk.ts'), 'utf8');

  it('calls the shared services by name', () => {
    expect(source).toMatch(/import \{ redeemBookingAtCounter \} from '\.\/booking-redemption'/);
    expect(source).toMatch(/loadBookingByQr/);
    expect(source).toMatch(/import \{ buildPrintDocument \} from '\.\/sale-printing'/);
    expect(source).toMatch(/redeemBookingAtCounter\(tx, \{/);
  });

  it('prices, claims, sells, mints and grants nothing of its own', () => {
    for (const forbidden of [
      /\bcommitSale\(/,
      /\bfinaliseSale\(/,
      /\bpriceCart\(/,
      /\bredeemBooking\(/,
      /\bmintBands?\(/,
      /\brouteSalePrinting\(/,
      /\.insert\((sale|saleLine|band|bookingRedemption|wallet|walletEntry|paymentAttempt|printJob|boxCommand|syncChange)\)/,
      /\.update\((booking|sale|band|wallet|walletEntry|bookingRedemption|paymentAttempt)\)/,
      /\.delete\(/,
      /\bsignBandCode\b|\bmintBandCode\b|\bbandKey\b/,
    ]) {
      expect(source, String(forbidden)).not.toMatch(forbidden);
    }
    // Its only writes: the session row, the print jobs' outcome, the credential's last-seen.
    // `createHash('sha256').update(value)` is the secret's hash, not a table.
    const writes = [
      ...source.replace(/createHash\('sha256'\)\.update\(/g, 'createHash(').matchAll(/\.(insert|update)\((\w+)\)/g),
    ].map((m) => `${m[1]}:${m[2]}`);
    expect(new Set(writes)).toEqual(
      new Set(['insert:kioskSession', 'update:kioskSession', 'update:printJob', 'update:deviceCredential']),
    );
  });
});
