import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, desc, eq, inArray, isNotNull, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  printJob,
  sale,
  schema,
  station,
  stationDevice,
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
} from '@oto/box-agent';
import { KIOSK_DEVICE_SCOPES, KIOSK_REASONS, newId, type KioskRedeemAnswer, type PrinterFault } from '@oto/shared';
import { CENTRAL_BRANCH_CODE, createTestContext, teardownAll, type TestContext } from './helpers';
import { injectedTransport, type CuttableLink } from './box-link';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox, issueClaimCode } from '../src/services/box';
import { bookingQrOf } from '../src/services/booking-payment';
import { KIOSK_PRINT_RUN, authenticateKiosk, redeemAtKiosk, type KioskDeviceAuth, type KioskPrinter } from '../src/services/kiosk';
import { kioskDesk } from '../src/services/kiosk-staff';
import { buildPrintDocument } from '../src/services/sale-printing';

/**
 * SCRUM-504 — RE-CHECK of fix lane F1 after its fix round, written against
 * the lane, not with it. The fix round moved the receipt and the vouchers out
 * of the kiosk's hold (queued to the box with the sale, printed after the
 * commit) and listened on the held connection (`watchConnection`). These cases
 * attack the new path with the clock and with the production pool's shape:
 *
 *   R1. the idle window below a slow print, on the NEW path: the plain paper
 *       is never out for a set called off, no command of it survives the
 *       rollback, and the retry's receipt is printed once, with its own number;
 *   R2. the keep-alive starved (none at all, budget above the window), on a
 *       pool built exactly as `getDb` builds one (no client listener): the
 *       SERVER's idle window ends the held connection — heard by the kiosk, a
 *       structured lost-hold ending with the true count, no uncaught error;
 *   R3. the connection lost AFTER every band came out, on `getDb` itself:
 *       answered, never a 500 nor an uncaught error, and the answer agrees
 *       with what the database kept; R3b the same, deterministically, with the
 *       print over and the redemption's post-print write waiting on a lock
 *       (the outer catch's `commit` ending);
 *   R4. the connection lost with a keep-alive in flight, on `getDb`, again
 *       and again: nothing escapes the process;
 *   R5. a receipt stuck on an empty roll does not hold the next family's
 *       bands up (no head-of-line blocking on the box);
 *   R6. a band fault after one band: the guest and the desk are told of that
 *       band, no plain paper is out, and the receipt series has no gap and no
 *       duplicate.
 *
 * Every case also asserts that nothing reached the process as an uncaught
 * exception or an unhandled rejection: on one of those `src/index.ts` exits
 * the api.
 */

const PGW_SECRET = randomBytes(32).toString('hex');
const SECRET_R = randomBytes(32).toString('hex');
const SHA = (value: string) => createHash('sha256').update(value).digest('hex');

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
let operatorId: string;
let centralId: string;
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
let R: Kiosk;

/** Everything that reached the process unheard. */
const escaped: string[] = [];
const onUncaught = (err: unknown) => {
  escaped.push(`uncaught: ${err instanceof Error ? `${(err as { code?: string }).code ?? ''} ${err.message}` : String(err)}`);
};
const onUnhandled = (err: unknown) => {
  escaped.push(`unhandled: ${err instanceof Error ? err.message : String(err)}`);
};

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.514.${Math.floor(family / 250)}.${(family % 250) + 1}`;
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

function urlOf(): string {
  return (ctx.db as unknown as { $client: { options: { connectionString: string } } }).$client.options.connectionString;
}

/** A pool with production's own settings and the window scaled, its clients counted (a listener on each). */
function countingPool(idleInTransactionMs: number, applicationName: string) {
  const pool = new pg.Pool({
    connectionString: urlOf(),
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

/**
 * A pool built EXACTLY as `packages/db` `getDb` builds one — a pool 'error'
 * listener and NO client listener — with only the idle-in-transaction window
 * scaled down. What production would do when that window is reached.
 */
function getDbShapedPool(idleInTransactionMs: number, applicationName: string) {
  const pool = new pg.Pool({
    connectionString: urlOf(),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: idleInTransactionMs,
    application_name: applicationName,
  } as pg.PoolConfig);
  const poolErrors: string[] = [];
  pool.on('error', (err: Error & { code?: string }) => poolErrors.push(err.code ?? err.message));
  return {
    db: drizzle(pool, { schema }) as unknown as Db,
    pool: pool as pg.Pool & { _clients: pg.PoolClient[]; _idle: Array<{ client: pg.PoolClient }> },
    poolErrors,
    end: () => pool.end().catch(() => undefined),
  };
}

async function collect(kiosk: Kiosk): Promise<void> {
  const printing = kiosk.agent!.printing()!;
  for (let round = 0; round < 50; round += 1) {
    const ran = await kiosk.agent!.runPendingCommands();
    await printing.jobs.tick();
    if (ran === 0) break;
  }
  for (let round = 0; round < 5 && printing.jobs.pending().length > 0; round += 1) await printing.jobs.tick();
}

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

async function deviceOf(kiosk: Kiosk): Promise<KioskDeviceAuth> {
  return authenticateKiosk(ctx.db, `Bearer ${kiosk.secret}`);
}

async function deskEntryOf(bookingId: string) {
  return (await kioskDesk(ctx.db, operatorId, centralId)).entries.find((e) => e.booking.id === bookingId);
}

/** The plain paper (anything but a band) a sale queued. */
async function plainJobsOf(saleRow: { id: string; actionId: string | null }) {
  return ctx.db
    .select()
    .from(printJob)
    .where(and(eq(printJob.actionId, saleRow.actionId!), sql`${printJob.kind} not in ('kids_wristband', 'adult_wristband')`));
}

const numberOn = (job: unknown) => /"receiptNumber":"([^"]+)"/.exec(JSON.stringify(job))?.[1] ?? null;

type Detail = { stage: string; printed: number; bandsPrinted: number; bandMayBeOut?: boolean; jobs: number };

async function insertKiosk(name: string, prefix: string, secret: string, addr: number): Promise<Kiosk> {
  const boxId = newId();
  await ctx.db.insert(box).values({
    id: boxId,
    operatorId,
    branchId: centralId,
    name: `${name} box`,
    slot: `s504r-${prefix.toLowerCase()}`,
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
      address: `192.168.91.${addr}:9100`,
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
      address: `192.168.91.${addr + 1}:9100`,
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
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  ctx = await createTestContext({
    env: {
      PROCESS_ROLES: 'api,jobs',
      PGW_PROVIDER: 'simulator',
      PGW_MERCHANT_ID: 'OTOTESTMERCHANT',
      PGW_SECRET_KEY: PGW_SECRET,
      PGW_WEBHOOK_SECRET: 'a-path-filter-not-a-credential',
    },
  });
  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  centralId = central!.id;
  operatorId = central!.operatorId;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, centralId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  R = await insertKiosk('S504R Kiosk', 'SR', SECRET_R, 61);
  R.agent = await bootAgent(R, 's504r-kiosk');
}, 240_000);

afterEach(() => {
  expect(escaped, 'nothing reached the process unheard').toEqual([]);
});

afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  process.off('unhandledRejection', onUnhandled);
  if (R?.agent) {
    R.agent.stop();
    detachInProcessBox(R.agent);
  }
  await closeDb().catch(() => undefined);
  await ctx?.close();
  await teardownAll();
});

describe('R1 — the clock on the new path: the plain paper never out for a set called off', () => {
  it('five bands at 1 s against a 2 s window: called off at its budget, no command of the plain paper survives, the retry prints its receipt once with its own number', async () => {
    await collect(R);
    const paid = await bookAndPay(3, 2);
    const prod = countingPool(2_000, 's504r-clock');
    const before = await footprint(paid.id);
    const startBand = seqOf(R, R.bandPrinterId);
    const startReceipt = seqOf(R, R.receiptPrinterId);
    const device = await deviceOf(R);
    const actionId = newId();
    const undo = slowLabels(R, 1_000);
    let answer: KioskRedeemAnswer;
    try {
      answer = await redeemAtKiosk(
        prod.db,
        { requestId: newId(), printLimits: { keepaliveMs: 250, budgetMs: 1_500 } },
        device,
        { actionId, qr: paid.qr },
      );
      await sleep(1_600);
    } finally {
      undo();
    }
    expect(prod.seen, 'the server never ended the connection').toEqual({ clientErrors: [], clientEnds: 0, poolErrors: 0 });
    await prod.end();
    const physical = seqOf(R, R.bandPrinterId) - startBand;
    expect(answer).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printTimeout, bands: [], walletCreditSatang: 0 });
    expect(physical).toBeGreaterThanOrEqual(1);
    expect(physical).toBeLessThan(5);
    expect(answer.calledOffBands, 'the tray, counted').toBe(physical);
    const detail = (await sessionOf(actionId)).detail as Detail;
    expect(detail.jobs, 'the hold printed the bands alone').toBe(5);

    // The box collects everything it holds: nothing of the called-off sale is there to print.
    await collect(R);
    expect(seqOf(R, R.receiptPrinterId) - startReceipt, 'no receipt and no voucher for a set called off').toBe(0);
    expect(seqOf(R, R.bandPrinterId) - startBand, 'no band late').toBe(physical);
    expect(await footprint(paid.id), 'not a command, job, band or wallet kept').toEqual(before);
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await deskEntryOf(paid.id)).toMatchObject({ state: 'to_redeem', calledOffBands: physical });

    // The retry issues it once; its plain paper is the box's and comes out once, with the sale's number.
    const retried = await press(R, paid.qr);
    expect(retried.body).toMatchObject({ outcome: 'issued', calledOffBands: 0 });
    const sales = await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id));
    expect(sales).toHaveLength(1);
    const plain = await plainJobsOf(sales[0]!);
    expect(plain.map((j) => j.kind)).toContain('receipt');
    expect(plain.map((j) => j.kind), 'the credit package queues its voucher too').toContain('credit_voucher');
    await collect(R);
    await until('the plain paper is printed', async () => {
      const rows = await ctx.db.select().from(printJob).where(inArray(printJob.id, plain.map((j) => j.id)));
      return rows.every((j) => j.status === 'printed');
    });
    expect(seqOf(R, R.receiptPrinterId) - startReceipt, 'each plain job once').toBe(plain.length);
    await collect(R);
    expect(seqOf(R, R.receiptPrinterId) - startReceipt, 'and never a second time').toBe(plain.length);
    const receiptJob = plain.find((j) => j.kind === 'receipt')!;
    const document = await buildPrintDocument(ctx.db, { boxId: R.boxId, operatorId }, receiptJob.id);
    expect(numberOn(document.job)).toBe(sales[0]!.receiptNumber);
  }, 60_000);
});

describe('R2 — the keep-alive starved: the server’s own idle window ends the hold, on a pool shaped as getDb', () => {
  it('no keep-alive and a budget above the window: the window ends the connection, the kiosk hears it, a lost hold with the true count, nothing escapes, the retry issues once', async () => {
    await collect(R);
    const paid = await bookAndPay(3, 2);
    const prod = getDbShapedPool(1_000, 's504r-window');
    const before = await footprint(paid.id);
    const startBand = seqOf(R, R.bandPrinterId);
    const startReceipt = seqOf(R, R.receiptPrinterId);
    const device = await deviceOf(R);
    const actionId = newId();
    // Five bands at 0.6 s: a three-second set; the window is one second; nothing touches the transaction.
    const undo = slowLabels(R, 600);
    let answer: KioskRedeemAnswer | null = null;
    let threw: unknown = null;
    const started = Date.now();
    let answeredAfter = 0;
    try {
      answer = await redeemAtKiosk(
        prod.db,
        { requestId: newId(), printLimits: { keepaliveMs: 60_000, budgetMs: 10_000 } },
        device,
        { actionId, qr: paid.qr },
      ).catch((err: unknown) => {
        threw = err;
        return null;
      });
      answeredAfter = Date.now() - started;
      // Let the band in the printer as the kiosk stopped waiting come out.
      await sleep(900);
    } finally {
      undo();
    }
    await prod.end();
    expect(threw, 'a structured answer, never a thrown 500').toBeNull();
    expect(answer).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printHoldLost, bands: [] });
    expect(answeredAfter, 'answered when the window ended it, not at the end of the set or the budget').toBeLessThan(3_000);
    const physical = seqOf(R, R.bandPrinterId) - startBand;
    expect(physical).toBeLessThan(5);
    expect(answer!.calledOffBands, 'the tray, counted').toBe(physical);
    await collect(R);
    expect(seqOf(R, R.receiptPrinterId) - startReceipt).toBe(0);
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
    const [run] = await ctx.db.select().from(opsRun).where(and(eq(opsRun.name, KIOSK_PRINT_RUN), eq(opsRun.actionId, actionId)));
    expect(run).toMatchObject({ outcome: 'failed', errorCode: KIOSK_REASONS.printHoldLost });
    expect(await deskEntryOf(paid.id)).toMatchObject({ state: 'to_redeem', calledOffBands: physical });
    const retried = await press(R, paid.qr);
    expect(retried.body).toMatchObject({ outcome: 'issued' });
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
  }, 60_000);
});

describe('R3 — the connection lost after every band came out, on getDb itself', () => {
  it('answered, never a 500 nor an uncaught error, and the answer agrees with what the database kept', async () => {
    await collect(R);
    const paid = await bookAndPay(2, 1);
    const before = await footprint(paid.id);
    const prod = getDb(urlOf(), { applicationName: 's504r-after' });
    const device = await deviceOf(R);
    const actionId = newId();
    const real = R.agent!.printing()!;
    const startBand = seqOf(R, R.bandPrinterId);
    // Every band out, THEN the connection ended — fired as the printer answers, so it lands on what follows the print.
    const printer: KioskPrinter = {
      async printNow(requests, options) {
        const outcome = await real.printNow(requests, options);
        await ctx.db.execute(
          sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 's504r-after' and xact_start is not null`,
        );
        return outcome;
      },
    };
    let answer: KioskRedeemAnswer | null = null;
    let threw: unknown = null;
    try {
      answer = await redeemAtKiosk(prod, { requestId: newId(), printer }, device, { actionId, qr: paid.qr }).catch(
        (err: unknown) => {
          threw = err;
          return null;
        },
      );
      await sleep(300);
    } finally {
      await closeDb().catch(() => undefined);
    }
    expect(threw, 'a structured answer, never a thrown 500').toBeNull();
    expect(seqOf(R, R.bandPrinterId) - startBand, 'every band came out').toBe(3);
    const status = await bookingStatus(paid.id);
    if (answer!.outcome === 'issued') {
      // The commit beat the termination: then it is whole.
      expect(status).toBe('redeemed');
      expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    } else {
      expect(answer).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printHoldLost, bands: [] });
      expect(answer!.calledOffBands, 'all three bands are in the tray, and the guest is told').toBe(3);
      expect(status).toBe('paid');
      expect(await footprint(paid.id)).toEqual(before);
      expect(await deskEntryOf(paid.id)).toMatchObject({ state: 'to_redeem', calledOffBands: 3 });
      const retried = await press(R, paid.qr);
      expect(retried.body).toMatchObject({ outcome: 'issued' });
      expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
    }
  }, 60_000);
});

describe('R3b — the connection lost while the redemption writes itself down after a whole print, on getDb', () => {
  /**
   * Deterministic: once every band is out, another connection holds the
   * press's own session row, so the kiosk's post-print write of it waits on a
   * lock with its query in flight; the kiosk's connection is ended there. The
   * print is over (`printHoldingTheRedemption` has returned), so this is the
   * ending the redemption's outer catch makes — stage `commit`.
   */
  it('a lost hold at stage commit, every band counted, nothing kept, nothing escapes, the retry issues once', async () => {
    await collect(R);
    const paid = await bookAndPay(2, 1);
    const before = await footprint(paid.id);
    const prod = getDb(urlOf(), { applicationName: 's504r-commit' });
    const device = await deviceOf(R);
    const actionId = newId();
    const real = R.agent!.printing()!;
    const startBand = seqOf(R, R.bandPrinterId);
    const holder = await (ctx.db as unknown as { $client: pg.Pool }).$client.connect();
    let holding = false;
    const printer: KioskPrinter = {
      async printNow(requests, options) {
        const outcome = await real.printNow(requests, options);
        const session = await sessionOf(actionId);
        await holder.query('begin');
        await holder.query('select id from pos.kiosk_session where id = $1 for update', [session.id]);
        holding = true;
        return outcome;
      },
    };
    let settled = false;
    const pending = redeemAtKiosk(prod, { requestId: newId(), printer }, device, { actionId, qr: paid.qr }).finally(() => {
      settled = true;
    });
    let answer: KioskRedeemAnswer | null = null;
    let threw: unknown = null;
    try {
      await until('the print is over and the session row held', () => holding);
      await until('the kiosk waits on the session row', async () => {
        const rows = (
          await ctx.db.execute(
            sql`select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
                where not l.granted and a.application_name = 's504r-commit'`,
          )
        ).rows as Array<{ n: number }>;
        return rows[0]!.n > 0;
      });
      expect(settled).toBe(false);
      await ctx.db.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 's504r-commit' and xact_start is not null`,
      );
      await until('the kiosk’s backend is gone', async () => {
        const rows = (
          await ctx.db.execute(
            sql`select count(*)::int as n from pg_stat_activity where application_name = 's504r-commit' and xact_start is not null`,
          )
        ).rows as Array<{ n: number }>;
        return rows[0]!.n === 0;
      });
      // The row is let go: the kiosk's own failed ending writes the same row.
      await holder.query('rollback');
      await until('the kiosk answers', () => settled);
      answer = await pending.catch((err: unknown) => {
        threw = err;
        return null;
      });
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
      await pending.catch(() => undefined);
      await sleep(100);
      await closeDb().catch(() => undefined);
    }
    expect(threw, 'a structured answer, never a thrown 500').toBeNull();
    expect(seqOf(R, R.bandPrinterId) - startBand, 'every band came out').toBe(3);
    expect(answer).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printHoldLost, bands: [], walletCreditSatang: 0 });
    expect(answer!.calledOffBands, 'all three bands are in the tray, and the guest is told').toBe(3);
    expect((await sessionOf(actionId)).detail).toMatchObject({ stage: 'commit', printed: 3, bandsPrinted: 3, jobs: 3 });
    const [run] = await ctx.db.select().from(opsRun).where(and(eq(opsRun.name, KIOSK_PRINT_RUN), eq(opsRun.actionId, actionId)));
    // The print itself worked; the redemption around it did not stand.
    expect(run).toMatchObject({ outcome: 'ok' });
    expect(run!.detail).toMatchObject({ committed: false, printed: 3, bandsPrinted: 3 });
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect(await footprint(paid.id)).toEqual(before);
    expect(await deskEntryOf(paid.id)).toMatchObject({ state: 'to_redeem', calledOffBands: 3 });
    await collect(R);
    const retried = await press(R, paid.qr);
    expect(retried.body).toMatchObject({ outcome: 'issued', calledOffBands: 0 });
    expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toHaveLength(1);
  }, 60_000);
});

describe('R4 — the connection lost with a keep-alive in flight, on getDb, again and again', () => {
  it('every time a lost hold, every time nothing escapes, the listener off once the pool has the connection back', async () => {
    for (let round = 0; round < 4; round += 1) {
      const paid = await bookAndPay(1, 1);
      const before = await footprint(paid.id);
      const prod = getDb(urlOf(), { applicationName: `s504r-ka-${round}` });
      const pool = (prod as unknown as {
        $client: pg.Pool & { _clients: pg.PoolClient[]; _idle: Array<{ client: pg.PoolClient }> };
      }).$client;
      const device = await deviceOf(R);
      const actionId = newId();
      const gated = gatedPrinter(R.agent!.printing()!);
      let settled = false;
      const pending = redeemAtKiosk(
        prod,
        // A keep-alive every 10 ms: one is in flight, or about to be, when the connection ends.
        { requestId: newId(), printer: gated.printer, printLimits: { keepaliveMs: 10, budgetMs: 20_000 } },
        device,
        { actionId, qr: paid.qr },
      ).finally(() => {
        settled = true;
      });
      let answer: KioskRedeemAnswer | null = null;
      let threw: unknown = null;
      let held: pg.PoolClient | undefined;
      try {
        await gated.reached;
        await sleep(25 + round * 7);
        const idle = new Set(pool._idle.map((i) => i.client));
        held = pool._clients.find((c) => !idle.has(c));
        await ctx.db.execute(
          sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${`s504r-ka-${round}`} and xact_start is not null`,
        );
        await until('the kiosk answers', () => settled);
        answer = await pending.catch((err: unknown) => {
          threw = err;
          return null;
        });
      } finally {
        gated.release();
        await pending.catch(() => undefined);
        await sleep(100);
        await closeDb().catch(() => undefined);
      }
      expect(threw, `round ${round}: a structured answer`).toBeNull();
      expect(answer, `round ${round}`).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.printHoldLost, bands: [] });
      expect(answer!.calledOffBands).toBe(1);
      expect(await bookingStatus(paid.id)).toBe('paid');
      expect(await footprint(paid.id)).toEqual(before);
      expect(held?.listeners('error').length ?? 0, 'the kiosk’s listener is off the connection').toBeLessThanOrEqual(1);
      expect(escaped, `round ${round}: nothing reached the process unheard`).toEqual([]);
    }
  }, 120_000);
});

describe('R5 — a receipt stuck on an empty roll does not hold the next family up', () => {
  it('the first family’s receipt waits on the box; the next family’s bands come out at once and its sale is whole', async () => {
    await collect(R);
    const sim = R.agent!.printing()!.simulator(R.receiptPrinterId)!;
    const startReceipt = seqOf(R, R.receiptPrinterId);
    const bookings: string[] = [];
    sim.setFault('paper_out');
    try {
      const one = await bookAndPay(1, 1);
      bookings.push(one.id);
      const first = await press(R, one.qr);
      expect(first.body).toMatchObject({ outcome: 'issued' });
      // The box tries the receipt and meets the empty roll: it stays with the box.
      await collect(R);
      const two = await bookAndPay(2, 1);
      bookings.push(two.id);
      const startBand = seqOf(R, R.bandPrinterId);
      const started = Date.now();
      const second = await press(R, two.qr);
      expect(second.body).toMatchObject({ outcome: 'issued', calledOffBands: 0 });
      expect(Date.now() - started, 'not held behind the stuck receipt').toBeLessThan(5_000);
      expect(seqOf(R, R.bandPrinterId) - startBand).toBe(3);
      await collect(R);
      expect(seqOf(R, R.receiptPrinterId) - startReceipt, 'nothing from the empty roll').toBe(0);
      const sales = await ctx.db.select().from(sale).where(inArray(sale.bookingId, [one.id, two.id]));
      expect(sales).toHaveLength(2);
      expect(new Set(sales.map((s) => s.receiptNumber)).size, 'two sales, two numbers').toBe(2);
    } finally {
      sim.clearFaults();
      await collect(R);
    }
    // Whatever came out once the roll was in, each plain job came out at most once: the paper out is the jobs printed.
    const out = seqOf(R, R.receiptPrinterId) - startReceipt;
    const sales = await ctx.db.select().from(sale).where(inArray(sale.bookingId, bookings));
    const plain = (await Promise.all(sales.map((s) => plainJobsOf(s)))).flat();
    expect(plain.length, 'two receipts and their vouchers').toBeGreaterThanOrEqual(2);
    expect(out, JSON.stringify(plain.map((j) => [j.kind, j.status, j.attempts]))).toBe(
      plain.filter((j) => j.status === 'printed').length,
    );
  }, 60_000);
});

describe('R6 — a band fault after one band: the guest and the desk told, no plain paper, the series whole', () => {
  it('one band out then the band printer unplugged: calledOffBands 1, no receipt or voucher out, and the next sale takes the next number in the series', async () => {
    await collect(R);
    // The last committed kiosk sale's place in its series.
    const [last] = await ctx.db
      .select({ series: sale.receiptSeries, seq: sale.receiptSeq })
      .from(sale)
      .where(and(eq(sale.stationId, R.stationId), isNotNull(sale.receiptSeq)))
      .orderBy(desc(sale.receiptSeq))
      .limit(1);
    const paid = await bookAndPay(2, 1);
    const before = await footprint(paid.id);
    const startBand = seqOf(R, R.bandPrinterId);
    const startReceipt = seqOf(R, R.receiptPrinterId);
    // Its status check (1st open), the first band (2nd), then unplugged at the second band (3rd).
    const undo = faultFromOpen(R, R.bandPrinterId, 'unreachable', 3);
    let scan: Awaited<ReturnType<typeof press>>;
    try {
      scan = await press(R, paid.qr);
    } finally {
      undo();
    }
    expect(scan.statusCode).toBe(200);
    expect(scan.body).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE', bands: [], walletCreditSatang: 0 });
    expect(seqOf(R, R.bandPrinterId) - startBand).toBe(1);
    expect(scan.body.calledOffBands, 'the guest is told of the band in the tray').toBe(1);
    expect(await deskEntryOf(paid.id)).toMatchObject({ reason: 'PRINTER_UNREACHABLE', calledOffBands: 1, state: 'to_redeem' });
    await collect(R);
    expect(seqOf(R, R.receiptPrinterId) - startReceipt, 'no receipt, no voucher').toBe(0);
    expect(await footprint(paid.id)).toEqual(before);

    // The next family: the next number in the series, no gap and no duplicate, printed once.
    const next = await bookAndPay(1, 1);
    const issued = await press(R, next.qr);
    expect(issued.body.outcome).toBe('issued');
    const [nextSale] = await ctx.db.select().from(sale).where(eq(sale.bookingId, next.id));
    if (last && last.series === nextSale!.receiptSeries) expect(nextSale!.receiptSeq).toBe(last.seq! + 1);
    const plain = await plainJobsOf(nextSale!);
    await collect(R);
    await until('the plain paper is printed', async () => {
      const rows = await ctx.db.select().from(printJob).where(inArray(printJob.id, plain.map((j) => j.id)));
      return rows.every((j) => j.status === 'printed');
    });
    expect(seqOf(R, R.receiptPrinterId) - startReceipt).toBe(plain.length);
    const receipt = plain.find((j) => j.kind === 'receipt')!;
    const document = await buildPrintDocument(ctx.db, { boxId: R.boxId, operatorId }, receipt.id);
    expect(numberOn(document.job)).toBe(nextSale!.receiptNumber);
    const sameNumber = await ctx.db
      .select({ id: sale.id })
      .from(sale)
      .where(and(eq(sale.stationId, R.stationId), eq(sale.receiptNumber, nextSale!.receiptNumber!)));
    expect(sameNumber).toHaveLength(1);
  }, 60_000);
});
