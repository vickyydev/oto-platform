import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  booking,
  box,
  branch,
  checkin,
  device,
  displayPairingRequest,
  kioskSession,
  opsRun,
  sale,
  station,
  stationDevice,
  ticketPackage,
} from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import {
  KIOSK_PRIVATE_FIELD,
  KIOSK_REASONS,
  KioskAbandonAnswerSchema,
  KioskDeskAnswerSchema,
  KioskHealthAnswerSchema,
  KioskPairingStatusSchema,
  KioskRedeemAnswerSchema,
  KioskSessionAnswerSchema,
  KioskStateSchema,
  newId,
  type KioskDeskEntry,
  type KioskRedeemAnswer,
} from '@oto/shared';
import {
  ADMIN,
  BRANCH_MANAGER,
  CENTRAL_BRANCH_CODE,
  CHALONG_BRANCH_CODE,
  RECEPTION,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { bookingQrOf } from '../src/services/booking-payment';
import { KIOSK_PRINT_RUN, authenticateKiosk, redeemAtKiosk, type KioskPrinter } from '../src/services/kiosk';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-20 K2 (SCRUM-217) — FOCUSED REVIEW OF THE KIOSK SURFACE, the API half.
 *
 * Written by the reviewer against the round's authority (events-kiosk PLAN §9
 * K2, §10, Q9, Q11) and the builder's own suite (`s220-k2-kiosk-surface`),
 * attacking what that suite leaves to trust:
 *
 *   1. every failure ending the simulators and the guest can drive — a
 *      printer fault part-way through a set, paper out, box offline, already
 *      redeemed, a booking that is no longer paid, a code that is not a
 *      booking, another park's booking — each its own reason, nothing kept;
 *   2. Q9's idle timeout against a press that is running: walking away never
 *      writes off a scan, a new guest never supersedes one, a race between the
 *      two lands on exactly one ending, and an abandoned session leaves the
 *      booking redeemable;
 *   3. privacy over every answer the kiosk is given in this file;
 *   4. pairing as a display pairs: an expired, an expired-by-the-kiosk and a
 *      rotated code are refused, a paired secret cannot mint another code, a
 *      kiosk reaches no other kiosk's routes and none of the staff side, and
 *      the Health tile's numbers are the sessions written, exactly;
 *   5. the staff desk lists a failed or handed-over session's booking — and
 *      keeps listing it until the desk has done its part.
 *
 * The virtual kiosk box is the builder's: a kiosk-role box with a simulated
 * band and receipt printer, run in this process. A second kiosk station on
 * the same box ("Review Kiosk") is paired from its own code and used only by
 * the Health test and the cross-station refusals, so its numbers are exact.
 */

const PGW_SECRET = randomBytes(32).toString('hex');
const SHA = (value: string) => createHash('sha256').update(value).digest('hex');
const bearer = () => randomBytes(32).toString('hex');

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
let admin: string;
let reception: string;
let manager: string;
let operatorId: string;
let centralId: string;
let tillId: string;
let kioskBoxId: string;
let bandPrinterId: string;
let receiptPrinterId: string;
let twoHoursId: string;
let oneHourId: string;
let chalongPackageId: string;
let confirmationIds: string[];
let agent: BoxAgent;
const link: CuttableLink = { cut: false };

interface Kiosk {
  stationId: string;
  name: string;
  secret: string;
}
let K1: Kiosk;
let KR: Kiosk;

/** Every answer a kiosk was given in this file, swept for private fields at the end (attack 3). */
const toldTheKiosk: unknown[] = [];

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.219.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

const ALLERGIC_CHILD = { childName: 'Ploy', ageYears: 6, allergies: 'Peanuts' };
const PHONE = '0812345678';
const PARENT = 'Khun Mali';

interface Paid {
  id: string;
  reference: string;
  qr: string;
}

async function bookAndPay(
  lines: Array<Record<string, unknown>>,
  opts: { supervised?: boolean; branchCode?: string } = {},
): Promise<Paid> {
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: opts.branchCode ?? CENTRAL_BRANCH_CODE,
      phone: PHONE,
      parentName: PARENT,
      tier: 'tourist',
      visitDate: WEEKDAY,
      ...(opts.supervised ? { consentAck: true, acknowledgedConfirmationIds: confirmationIds } : {}),
      lines,
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

// --- The kiosk's own calls ------------------------------------------------------

const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });

async function startSession(k: Kiosk, sessionId = newId()): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${k.stationId}/kiosk/sessions`,
    headers: auth(k.secret),
    payload: { sessionId },
  });
  expect(res.statusCode, res.body).toBe(200);
  toldTheKiosk.push(KioskSessionAnswerSchema.parse(res.json()));
  return sessionId;
}

async function abandon(k: Kiosk, sessionId: string, cause: 'idle' | 'cancelled' = 'idle') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${k.stationId}/kiosk/sessions/${sessionId}/abandon`,
    headers: auth(k.secret),
    payload: { cause },
  });
  if (res.statusCode === 200) toldTheKiosk.push(KioskAbandonAnswerSchema.parse(res.json()));
  return res;
}

async function scan(k: Kiosk, qr: string, sessionId?: string): Promise<{ body: KioskRedeemAnswer; actionId: string }> {
  const actionId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${k.stationId}/kiosk/redeem`,
    headers: auth(k.secret),
    payload: { actionId, qr, ...(sessionId ? { sessionId } : {}) },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = KioskRedeemAnswerSchema.parse(res.json());
  toldTheKiosk.push(body);
  return { body, actionId };
}

async function simulate(control: 'printer_offline' | 'paper_out' | 'box_offline' | 'clear', stationId = K1.stationId) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/stations/${stationId}/kiosk/simulate`,
    headers: { cookie: admin },
    payload: { control },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { boxOffline: boolean; printers: Array<{ deviceId: string; faults: string[] }> };
}

async function desk(): Promise<KioskDeskEntry[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/kiosk-desk?branchId=${centralId}`,
    headers: { cookie: reception },
  });
  expect(res.statusCode, res.body).toBe(200);
  const parsed = KioskDeskAnswerSchema.parse(res.json());
  // Staff-facing, but still no child, allergy or phone (the desk opens the booking for those).
  const text = JSON.stringify(parsed);
  expect(text).not.toContain(ALLERGIC_CHILD.allergies);
  expect(text).not.toContain(ALLERGIC_CHILD.childName);
  expect(text).not.toContain(PHONE);
  return parsed.entries;
}

const deskEntry = async (bookingId: string) => (await desk()).find((e) => e.booking.id === bookingId);

async function auditCount(action: string, entityId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
  return row!.n;
}

async function salesOf(bookingId: string) {
  return ctx.db.select({ id: sale.id }).from(sale).where(eq(sale.bookingId, bookingId));
}

async function bookingStatus(bookingId: string) {
  const [row] = await ctx.db.select({ status: booking.status }).from(booking).where(eq(booking.id, bookingId));
  return row!.status;
}

async function sessionRow(id: string) {
  const [row] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, id));
  return row!;
}

function keysOf(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.push(k);
      keysOf(v, into);
    }
  }
  return into;
}

/** The kiosk's own device, as the route resolves it, for driving the service with a printer a test holds. */
const deviceOf = (k: Kiosk) => authenticateKiosk(ctx.db, `Bearer ${k.secret}`);

/** The virtual box's own printers, held at a gate the test opens: a press caught mid-print. */
function gatedPrinter(): { printer: KioskPrinter; reached: Promise<void>; open: () => void } {
  const real = agent.printing()!;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  return {
    printer: {
      async printNow(requests, options) {
        entered();
        await gate;
        return real.printNow(requests, options);
      },
    },
    reached,
    open,
  };
}

/** A kiosk paired exactly as the Console pairs one: its own secret, its K code, a manager's claim. */
async function pairKiosk(stationId: string, name: string): Promise<Kiosk> {
  const secret = bearer();
  const asked = await ctx.app.inject({ method: 'POST', url: '/kiosk/pairing', headers: auth(secret), payload: {} });
  expect(asked.statusCode, asked.body).toBe(200);
  const claimed = await ctx.app.inject({
    method: 'POST',
    url: `/stations/${stationId}/kiosks/claim`,
    headers: { cookie: manager },
    payload: { pairingCode: asked.json().pairingCode as string, name },
  });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const [st] = await ctx.db.select({ name: station.name }).from(station).where(eq(station.id, stationId));
  return { stationId, name: st!.name, secret };
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
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);

  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  centralId = central!.id;
  operatorId = central!.operatorId;
  const [chalong] = await ctx.db.select().from(branch).where(eq(branch.code, CHALONG_BRANCH_CODE));
  const [chalongPackage] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, chalong!.id));
  chalongPackageId = chalongPackage!.id;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, centralId), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  await takeStation(ctx.app, reception, tillId);

  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, centralId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
  const catalogue = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  expect(catalogue.statusCode, catalogue.body).toBe(200);
  confirmationIds = (
    catalogue.json().supervision as { policy: { confirmations: Array<{ id: string; required: boolean }> } }
  ).policy.confirmations
    .filter((c) => c.required)
    .map((c) => c.id);

  // THE VIRTUAL KIOSK BOX — as the builder's suite builds it — with two kiosk stations on it.
  kioskBoxId = newId();
  await ctx.db.insert(box).values({
    id: kioskBoxId,
    operatorId,
    branchId: centralId,
    name: 'Review kiosk box',
    slot: 'kiosk-review',
    role: 'kiosk',
    status: 'unclaimed',
  });
  bandPrinterId = newId();
  receiptPrinterId = newId();
  await ctx.db.insert(device).values([
    {
      id: bandPrinterId,
      operatorId,
      branchId: centralId,
      boxId: kioskBoxId,
      kind: 'band_printer',
      label: 'Review Band Printer',
      transport: 'simulated',
      address: '192.168.88.231:9100',
      model: '4B-2082A',
      protocol: 'tspl2',
      reachability: 'reachable',
      paperStatus: 'ok',
    },
    {
      id: receiptPrinterId,
      operatorId,
      branchId: centralId,
      boxId: kioskBoxId,
      kind: 'receipt_printer',
      label: 'Review Receipt Printer',
      transport: 'simulated',
      address: '192.168.88.232:9100',
      model: 'Xprinter XP-80',
      protocol: 'escpos',
      reachability: 'reachable',
      paperStatus: 'ok',
    },
  ]);
  const stations: Array<{ id: string; name: string; prefix: string }> = [
    { id: newId(), name: 'Kiosk 1', prefix: 'K1' },
    { id: newId(), name: 'Review Kiosk', prefix: 'KR' },
  ];
  for (const st of stations) {
    await ctx.db.insert(station).values({
      id: st.id,
      operatorId,
      branchId: centralId,
      boxId: kioskBoxId,
      name: st.name,
      kind: 'kiosk',
      codePrefix: st.prefix,
      capabilities: [],
      accessScope: 'all_staff',
    });
    await ctx.db.insert(stationDevice).values([
      { id: newId(), stationId: st.id, role: 'kids_band', deviceId: bandPrinterId },
      { id: newId(), stationId: st.id, role: 'adult_band', deviceId: bandPrinterId },
      { id: newId(), stationId: st.id, role: 'receipt', deviceId: receiptPrinterId },
    ]);
  }

  agent = linkedAgent(ctx, kioskBoxId, 'kiosk-box-k2-review', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);

  K1 = await pairKiosk(stations[0]!.id, 'Lobby kiosk');
  KR = await pairKiosk(stations[1]!.id, 'Review kiosk screen');
}, 240_000);

afterAll(async () => {
  if (agent) {
    agent.stop();
    detachInProcessBox(agent);
  }
  await ctx?.close();
  await teardownAll();
});

// --- 1 ------------------------------------------------------------------------------

/** How many labels a simulated printer has put out so far. */
function printedOn(deviceId: string): number {
  return agent.printing()!.simulator(deviceId)?.printouts().at(-1)?.seq ?? 0;
}

/**
 * A fault that arrives part-way through a set: armed at the printer's next
 * channel open once `when()` holds (the check before the set opens a channel
 * too, so "after one band came out" passes the check and fails the job after
 * it). The same mechanism the K1 review used; the fault is left standing for
 * the kiosk's own Clear to take away.
 */
function faultPartWay(deviceId: string, fault: 'unreachable' | 'paper_out', when: () => boolean): () => void {
  const sim = agent.printing()!.simulator(deviceId)!;
  const original = sim.connect;
  (sim as { connect: typeof sim.connect }).connect = () => {
    if (when()) sim.setFault(fault);
    return original.call(sim);
  };
  return () => {
    (sim as { connect: typeof sim.connect }).connect = original;
  };
}

describe('attack 1 — every failure ending, each its own reason, nothing kept', () => {
  /**
   * SCRUM-504 — the plain paper (the receipt, any credit voucher) prints
   * before the bands, so a receipt-printer fault now stops the set before a
   * band is sent: the case that once let every band out and then failed on
   * the receipt is the receipt failing with no band out. `faultOn` decides,
   * at each session the printer opens, whether the fault arrives there; the
   * printer check opens one too, so "the second session" is its first job.
   */
  const cases = [
    {
      what: 'the band printer stops after the first band',
      deviceId: () => bandPrinterId,
      fault: 'unreachable' as const,
      reason: 'PRINTER_UNREACHABLE',
      bandsOut: 1,
      faultOn: (start: number) => () => printedOn(bandPrinterId) - start >= 1,
    },
    {
      what: 'the band printer runs out of paper after the first band',
      deviceId: () => bandPrinterId,
      fault: 'paper_out' as const,
      reason: 'PRINTER_PAPER_OUT',
      bandsOut: 1,
      faultOn: (start: number) => () => printedOn(bandPrinterId) - start >= 1,
    },
    {
      what: 'the receipt printer stops at its first job, before any band',
      deviceId: () => receiptPrinterId,
      fault: 'unreachable' as const,
      reason: 'PRINTER_UNREACHABLE',
      bandsOut: 0,
      faultOn: () => {
        let opens = 0;
        return () => (opens += 1) >= 2;
      },
    },
  ];
  for (const c of cases) {
    it(`a printer fault part-way through the set (${c.what}) calls the whole set off`, async () => {
      const paid = await bookAndPay([{ packageId: twoHoursId, kids: 2, adults: 1 }]);
      const startBand = printedOn(bandPrinterId);
      const startReceipt = printedOn(receiptPrinterId);
      const undo = faultPartWay(c.deviceId(), c.fault, c.faultOn(startBand));
      try {
        const sessionId = await startSession(K1);
        const aborted = await scan(K1, paid.qr, sessionId);
        expect(aborted.body).toMatchObject({
          sessionId,
          outcome: 'failed',
          reason: c.reason,
          bands: [],
          calledOffBands: c.bandsOut,
          walletCreditSatang: 0,
          desk: { required: true },
        });
        expect(printedOn(bandPrinterId) - startBand, 'bands out before the fault').toBe(c.bandsOut);
        // Nothing of the redemption stands: the booking is still the family's to redeem.
        expect(await bookingStatus(paid.id)).toBe('paid');
        expect(await salesOf(paid.id)).toEqual([]);
        // The device run says the set stopped part-way: paper out, the rest not, nothing committed.
        const runs = await ctx.db
          .select()
          .from(opsRun)
          .where(and(eq(opsRun.name, KIOSK_PRINT_RUN), eq(opsRun.actionId, aborted.actionId)));
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ kind: 'device', outcome: 'failed', errorCode: c.reason, stationId: K1.stationId });
        const detail = runs[0]!.detail as {
          printed: number;
          bandsPrinted: number;
          jobs: number;
          committed: boolean;
          deviceId: string;
        };
        // Everything that came out is counted: the plain paper first, then the bands.
        const plainPaper = printedOn(receiptPrinterId) - startReceipt;
        expect(detail).toMatchObject({
          committed: false,
          deviceId: c.deviceId(),
          printed: plainPaper + c.bandsOut,
          bandsPrinted: c.bandsOut,
        });
        if (c.bandsOut > 0) expect(plainPaper, 'the plain paper printed before any band').toBeGreaterThan(0);
        else expect(plainPaper, 'the receipt printer failed at its first job').toBe(0);
        expect(detail.printed).toBeLessThan(detail.jobs);
        // Activity has the abort, and the desk has the family, with the booking, to redeem — and the bands to collect.
        expect(await auditCount('kiosk.abort', sessionId)).toBe(1);
        expect(await deskEntry(paid.id)).toMatchObject({
          sessionId,
          outcome: 'failed',
          reason: c.reason,
          state: 'to_redeem',
          bandsIssued: 0,
          calledOffBands: c.bandsOut,
        });
      } finally {
        undo();
        // The kiosk's own Clear puts every printer on the kiosk back, the receipt printer included.
        const cleared = await simulate('clear');
        expect(cleared.printers.every((p) => p.faults.length === 0)).toBe(true);
      }
      const again = await scan(K1, paid.qr, await startSession(K1));
      expect(again.body.outcome).toBe('issued');
      expect(await salesOf(paid.id)).toHaveLength(1);
      expect((await deskEntry(paid.id))?.state).toBe('done');
    });
  }

  it('each simulator control gives its own reason, and Clear always brings the kiosk back', async () => {
    const seen = new Map<string, string>();
    for (const control of ['printer_offline', 'paper_out', 'box_offline'] as const) {
      const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
      await simulate(control);
      try {
        const res = await scan(K1, paid.qr, await startSession(K1));
        expect(res.body.outcome).toBe('failed');
        expect(res.body.bands).toEqual([]);
        seen.set(control, res.body.reason ?? '');
        expect(await bookingStatus(paid.id)).toBe('paid');
        expect((await deskEntry(paid.id))?.state).toBe('to_redeem');
      } finally {
        const cleared = await simulate('clear');
        expect(cleared.boxOffline).toBe(false);
      }
      expect((await scan(K1, paid.qr, await startSession(K1))).body.outcome).toBe('issued');
    }
    expect(Object.fromEntries(seen)).toEqual({
      printer_offline: 'PRINTER_UNREACHABLE',
      paper_out: 'PRINTER_PAPER_OUT',
      box_offline: KIOSK_REASONS.boxOffline,
    });
  });

  it('a booking that is no longer paid is refused by name, kept untouched, and left with the desk', async () => {
    for (const status of ['cancelled', 'expired'] as const) {
      const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
      // The family still holds the confirmation's QR; the booking behind it was called off since.
      await ctx.db.update(booking).set({ status }).where(eq(booking.id, paid.id));
      const res = await scan(K1, paid.qr, await startSession(K1));
      expect(res.body).toMatchObject({
        outcome: 'failed',
        reason: 'BOOKING_NOT_REDEEMABLE',
        bands: [],
        booking: { reference: paid.reference },
      });
      expect(await bookingStatus(paid.id)).toBe(status);
      expect(await salesOf(paid.id)).toEqual([]);
      expect(await deskEntry(paid.id)).toMatchObject({ reason: 'BOOKING_NOT_REDEEMABLE', state: 'to_redeem' });
    }
  });

  it('already redeemed: when and where, nothing new issued, and nothing left for the desk', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    expect((await scan(K1, paid.qr, await startSession(K1))).body.outcome).toBe('issued');
    const again = await scan(K1, paid.qr, await startSession(K1));
    expect(again.body).toMatchObject({ outcome: 'failed', reason: 'BOOKING_ALREADY_REDEEMED', bands: [] });
    expect(again.body.alreadyRedeemed).toMatchObject({ stationName: 'Kiosk 1' });
    expect(await salesOf(paid.id)).toHaveLength(1);
    // Listed, but as done: the till's panel draws only what is left to do.
    expect((await deskEntry(paid.id))?.state).toBe('done');
  });

  it('a code that is not a booking, or one this park did not sign, opens nothing and puts nobody on the desk', async () => {
    const before = (await desk()).length;
    const junk = await scan(K1, 'NOT-A-BOOKING', await startSession(K1));
    expect(junk.body).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.notABookingQr, booking: null });
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const forged = paid.qr.slice(0, -4) + (paid.qr.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const bad = await scan(K1, forged, await startSession(K1));
    expect(bad.body).toMatchObject({ outcome: 'failed', booking: null });
    expect(bad.body.reason).toBe('BOOKING_QR_SIGNATURE_INVALID');
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect((await desk()).length).toBe(before);
  });

  it("another park's booking is refused by name and issues nothing here", async () => {
    const elsewhere = await bookAndPay([{ packageId: chalongPackageId, kids: 1, adults: 1 }], {
      branchCode: CHALONG_BRANCH_CODE,
    });
    const res = await scan(K1, elsewhere.qr, await startSession(K1));
    expect(res.body).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.otherBranch, bands: [] });
    expect(await bookingStatus(elsewhere.id)).toBe('paid');
    expect(await salesOf(elsewhere.id)).toEqual([]);
  });
});

// --- 2 ------------------------------------------------------------------------------

describe('attack 2 — Q9, the idle timeout, against a press that is running', () => {
  it('walking away while the bands are printing writes nothing off: the press ends the session', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const sessionId = await startSession(K1);
    const held = gatedPrinter();
    const pending = redeemAtKiosk(ctx.db, { requestId: newId(), printer: held.printer }, await deviceOf(K1), {
      actionId: newId(),
      qr: paid.qr,
      sessionId,
    });
    await held.reached;
    try {
      // The screen's 60 seconds cannot fire mid-print, but a late or duplicated abandon can still arrive.
      const late = await abandon(K1, sessionId, 'idle');
      expect(late.statusCode, late.body).toBe(200);
      expect(late.json()).toMatchObject({ sessionId, abandoned: false, outcome: null });
      // A new guest starting meanwhile does not supersede a session whose press is running.
      const next = await startSession(K1);
      expect((await sessionRow(sessionId)).outcome).toBeNull();
      await abandon(K1, next, 'cancelled');
    } finally {
      held.open();
    }
    const answer = await pending;
    expect(answer).toMatchObject({ sessionId, outcome: 'issued' });
    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({ outcome: 'issued', reason: null });
    expect(await auditCount('kiosk.abandon', sessionId)).toBe(0);
    expect(await auditCount('kiosk.redeem', sessionId)).toBe(1);
  });

  it('an abandon racing the first scan lands on exactly one ending, and the booking is redeemed once', async () => {
    for (let round = 0; round < 4; round += 1) {
      const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }]);
      const sessionId = await startSession(K1);
      const [walked, pressed] = await Promise.all([abandon(K1, sessionId, 'idle'), scan(K1, paid.qr, sessionId)]);
      const gone = (walked.json() as { abandoned: boolean }).abandoned;
      const row = await sessionRow(sessionId);
      expect(pressed.body.outcome).toBe('issued');
      if (gone) {
        // The timeout won: the session is the guest who walked away; the scan is a session of its own.
        expect(row).toMatchObject({ outcome: 'abandoned', reason: KIOSK_REASONS.idle, actionId: null, saleId: null });
        expect(pressed.body.sessionId).not.toBe(sessionId);
        expect(await auditCount('kiosk.abandon', sessionId)).toBe(1);
      } else {
        // The scan won: it is the guest's session, and walking away wrote nothing.
        expect(pressed.body.sessionId).toBe(sessionId);
        expect(row.outcome).toBe('issued');
        expect(await auditCount('kiosk.abandon', sessionId)).toBe(0);
      }
      expect(await salesOf(paid.id)).toHaveLength(1);
    }
  });

  it('an abandoned session leaves the booking redeemable, puts nothing on the desk, and the next guest issues it', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const deskBefore = (await desk()).length;
    const sessionId = await startSession(K1);
    const walked = await abandon(K1, sessionId, 'idle');
    expect(walked.json()).toMatchObject({ abandoned: true, outcome: 'abandoned' });
    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({ outcome: 'abandoned', reason: KIOSK_REASONS.idle, bookingId: null, saleId: null });
    expect(row.endedAt).not.toBeNull();
    const [audited] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'kiosk.abandon'), eq(auditLog.entityId, sessionId)));
    expect(audited!.actorAccountId).toBeNull();
    expect(audited!.after).toMatchObject({ stationId: K1.stationId, boxId: kioskBoxId, cause: 'idle' });
    expect(await bookingStatus(paid.id)).toBe('paid');
    expect((await desk()).length).toBe(deskBefore);
    const next = await scan(K1, paid.qr, await startSession(K1));
    expect(next.body.outcome).toBe('issued');
  });

  it('an abandon names only a cause the screen has, and only a session at this kiosk', async () => {
    const sessionId = await startSession(K1);
    const bogus = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/station/${K1.stationId}/kiosk/sessions/${sessionId}/abandon`,
      headers: auth(K1.secret),
      payload: { cause: 'printed' },
    });
    expect(bogus.statusCode).toBe(400);
    // The Review Kiosk cannot end Kiosk 1's guest, even naming the session on its own station's route.
    const foreign = await abandon(KR, sessionId);
    expect(foreign.statusCode).toBe(404);
    expect((await sessionRow(sessionId)).outcome).toBeNull();
    // Nor take its id for a session of its own.
    const taken = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/station/${KR.stationId}/kiosk/sessions`,
      headers: auth(KR.secret),
      payload: { sessionId },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('KIOSK_SESSION_TAKEN');
    await abandon(K1, sessionId, 'cancelled');
    // Those refusals wrote no session at the Review Kiosk (its Health numbers below are exact).
    const [n] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(kioskSession)
      .where(eq(kioskSession.stationId, KR.stationId));
    expect(n!.n).toBe(0);
  });
});

// --- 4 ------------------------------------------------------------------------------

describe('attack 4 — pairing, as a display pairs', () => {
  const claim = (stationId: string, pairingCode: string) =>
    ctx.app.inject({
      method: 'POST',
      url: `/stations/${stationId}/kiosks/claim`,
      headers: { cookie: manager },
      payload: { pairingCode, name: 'Spare kiosk' },
    });

  /** A third kiosk station with a box and no screen yet, for codes that must not pair. */
  async function spareKioskStation(): Promise<string> {
    const id = newId();
    await ctx.db.insert(station).values({
      id,
      operatorId,
      branchId: centralId,
      boxId: kioskBoxId,
      name: `Spare Kiosk ${id.slice(-4)}`,
      kind: 'kiosk',
      codePrefix: `S${id.slice(-3)}`,
      capabilities: [],
      accessScope: 'all_staff',
    });
    return id;
  }

  it('a code that ran out is refused, and the kiosk reads it as expired', async () => {
    const spare = await spareKioskStation();
    const secret = bearer();
    const asked = await ctx.app.inject({ method: 'POST', url: '/kiosk/pairing', headers: auth(secret), payload: {} });
    const code = asked.json().pairingCode as string;
    await ctx.db
      .update(displayPairingRequest)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(displayPairingRequest.tokenHash, SHA(secret)));
    const res = await claim(spare, code);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('KIOSK_PAIRING_INVALID');
    const status = await ctx.app.inject({ method: 'GET', url: '/kiosk/pairing', headers: auth(secret) });
    expect(KioskPairingStatusSchema.parse(status.json())).toEqual({ status: 'expired' });
    expect((await ctx.app.inject({ method: 'GET', url: `/box/v1/station/${spare}/kiosk/state`, headers: auth(secret) })).statusCode).toBe(401);
  });

  it('a code the kiosk called off is refused, and so is the first of two codes once it rotated', async () => {
    const spare = await spareKioskStation();
    const secret = bearer();
    const first = await ctx.app.inject({ method: 'POST', url: '/kiosk/pairing', headers: auth(secret), payload: {} });
    const rotated = await ctx.app.inject({ method: 'POST', url: '/kiosk/pairing', headers: auth(secret), payload: {} });
    const firstCode = first.json().pairingCode as string;
    const secondCode = rotated.json().pairingCode as string;
    expect(secondCode).not.toBe(firstCode);
    expect((await claim(spare, firstCode)).json().error.code).toBe('KIOSK_PAIRING_INVALID');
    const off = await ctx.app.inject({ method: 'POST', url: '/kiosk/pairing/expire', headers: auth(secret), payload: {} });
    expect(off.statusCode, off.body).toBe(200);
    expect((await claim(spare, secondCode)).json().error.code).toBe('KIOSK_PAIRING_INVALID');
    expect(await auditCount('kiosk.paired', spare)).toBe(0);
  });

  it('a paired kiosk cannot mint itself another code, as a kiosk or as a display', async () => {
    const asKiosk = await ctx.app.inject({ method: 'POST', url: '/kiosk/pairing', headers: auth(K1.secret), payload: {} });
    expect(asKiosk.statusCode).toBe(409);
    expect(asKiosk.json().error.code).toBe('KIOSK_ALREADY_PAIRED');
    const asDisplay = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: auth(K1.secret), payload: {} });
    expect(asDisplay.statusCode).toBe(409);
    const status = await ctx.app.inject({ method: 'GET', url: '/kiosk/pairing', headers: auth(K1.secret) });
    const read = KioskPairingStatusSchema.parse(status.json());
    toldTheKiosk.push(read);
    expect(read).toEqual({ status: 'paired', station: { id: K1.stationId, name: 'Kiosk 1' } });
  });

  it("a kiosk reaches none of another kiosk's routes", async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const other = K1.stationId;
    const calls = [
      { method: 'GET' as const, url: `/box/v1/station/${other}/kiosk/state` },
      { method: 'POST' as const, url: `/box/v1/station/${other}/kiosk/sessions`, payload: { sessionId: newId() } },
      {
        method: 'POST' as const,
        url: `/box/v1/station/${other}/kiosk/sessions/${newId()}/abandon`,
        payload: { cause: 'idle' },
      },
      { method: 'POST' as const, url: `/box/v1/station/${other}/kiosk/redeem`, payload: { actionId: newId(), qr: paid.qr } },
    ];
    for (const call of calls) {
      const res = await ctx.app.inject({ ...call, headers: auth(KR.secret) });
      expect(res.statusCode, `${call.method} ${call.url}`).toBe(403);
      expect(res.json().error.code).toBe('KIOSK_OTHER_STATION');
    }
    expect(await bookingStatus(paid.id)).toBe('paid');
  });

  it("a kiosk's credential opens none of the staff side of the kiosk, and a display's opens none of the kiosk's", async () => {
    const staffSide = [
      { method: 'GET' as const, url: `/kiosk-desk?branchId=${centralId}` },
      { method: 'GET' as const, url: '/ops/kiosks' },
      { method: 'POST' as const, url: `/stations/${K1.stationId}/kiosk/simulate`, payload: { control: 'box_offline' } },
      { method: 'POST' as const, url: `/stations/${K1.stationId}/kiosks/claim`, payload: { pairingCode: 'K000000', name: 'x' } },
    ];
    for (const call of staffSide) {
      const res = await ctx.app.inject({ ...call, headers: auth(K1.secret) });
      expect(res.statusCode, `${call.method} ${call.url}`).toBeGreaterThanOrEqual(400);
    }
    expect(agent.state.offline).toBe(false);

    // A customer display paired the display's way, at a till.
    const displaySecret = bearer();
    const minted = await ctx.app.inject({ method: 'POST', url: '/display/pairing', headers: auth(displaySecret), payload: {} });
    const paired = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${tillId}/displays/claim`,
      headers: { cookie: manager },
      payload: { pairingCode: minted.json().pairingCode as string, name: 'Till display' },
    });
    expect(paired.statusCode, paired.body).toBe(200);
    for (const url of [
      `/box/v1/station/${K1.stationId}/kiosk/state`,
      `/box/v1/station/${tillId}/kiosk/state`,
    ]) {
      expect((await ctx.app.inject({ method: 'GET', url, headers: auth(displaySecret) })).statusCode).toBe(401);
    }
    const viaDisplay = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/station/${tillId}/kiosk/sessions`,
      headers: auth(displaySecret),
      payload: { sessionId: newId() },
    });
    expect(viaDisplay.statusCode).toBe(401);
    // And the kiosk's secret is not a display's.
    expect((await ctx.app.inject({ method: 'GET', url: '/display/session', headers: auth(K1.secret) })).statusCode).toBe(401);
  });

  it("the Kiosk tile's numbers are the sessions written, exactly", async () => {
    const issued = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const dropOff = await bookAndPay([{ packageId: oneHourId, kids: 1, adults: 0, supervision: ALLERGIC_CHILD }], {
      supervised: true,
    });
    // One of each ending at the Review Kiosk, and one guest still at the screen.
    expect((await scan(KR, issued.qr, await startSession(KR))).body.outcome).toBe('issued');
    expect((await scan(KR, dropOff.qr, await startSession(KR))).body.outcome).toBe('handed_off');
    expect((await scan(KR, 'NOT-A-BOOKING', await startSession(KR))).body.outcome).toBe('failed');
    expect((await abandon(KR, await startSession(KR), 'idle')).json().abandoned).toBe(true);
    expect((await abandon(KR, await startSession(KR), 'cancelled')).json().abandoned).toBe(true);
    const left = await startSession(KR);
    const still = await startSession(KR); // supersedes `left`
    expect((await sessionRow(left)).reason).toBe(KIOSK_REASONS.superseded);
    // The screen's poll, so the tile can say it is up.
    const state = await ctx.app.inject({
      method: 'GET',
      url: `/box/v1/station/${KR.stationId}/kiosk/state`,
      headers: auth(KR.secret),
    });
    toldTheKiosk.push(KioskStateSchema.parse(state.json()));

    const res = await ctx.app.inject({ method: 'GET', url: '/ops/kiosks', headers: { cookie: manager } });
    expect(res.statusCode, res.body).toBe(200);
    const tile = KioskHealthAnswerSchema.parse(res.json()).kiosks.find((k) => k.stationId === KR.stationId)!;
    expect(tile.today).toMatchObject({
      sessions: 7,
      issued: 1,
      handedOff: 1,
      failed: 1,
      abandoned: 3,
      open: 1,
    });
    // And the same, counted from the rows themselves.
    const rows = await ctx.db.select().from(kioskSession).where(eq(kioskSession.stationId, KR.stationId));
    expect(rows).toHaveLength(7);
    const by = (o: string | null) => rows.filter((r) => r.outcome === o).length;
    expect([by('issued'), by('handed_off'), by('failed'), by('abandoned'), by(null)]).toEqual([1, 1, 1, 3, 1]);
    expect(rows.find((r) => r.outcome === null)!.id).toBe(still);
    const lastIssued = rows
      .filter((r) => (r.outcome === 'issued' || r.outcome === 'handed_off') && r.saleId)
      .map((r) => r.endedAt!.getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    expect(new Date(tile.lastRedemptionAt!).getTime()).toBe(lastIssued);
    expect(tile).toMatchObject({
      name: 'Review Kiosk',
      box: { id: kioskBoxId, online: true },
      screen: { paired: true, label: 'Review kiosk screen', online: true },
      printer: { deviceId: bandPrinterId, faults: [] },
    });
    await abandon(KR, still, 'cancelled');
  });
});

// --- 5 ------------------------------------------------------------------------------

describe('attack 5 — the desk shows a failed or handed-over session’s booking until the desk has done its part', () => {
  it('a drop-off booking sent over stays to redeem until the till redeems it', async () => {
    const dropOff = await bookAndPay([{ packageId: oneHourId, kids: 1, adults: 0, supervision: ALLERGIC_CHILD }], {
      supervised: true,
    });
    const sent = await scan(K1, dropOff.qr, await startSession(K1));
    expect(sent.body).toMatchObject({ outcome: 'handed_off', reason: KIOSK_REASONS.supervised, bands: [] });
    // Scanned again by the same family: still the desk's, still to redeem.
    const again = await scan(K1, dropOff.qr, await startSession(K1));
    expect(again.body.outcome).toBe('handed_off');
    const entries = (await desk()).filter((e) => e.booking.id === dropOff.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ state: 'to_redeem', booking: { reference: dropOff.reference } });
  });

  /**
   * Fixed at landing: the desk once kept only the LATEST failed or
   * handed-off session per booking, and this test pinned that wrong answer. A
   * family with a mixed booking gets their regular bands at the kiosk and is
   * told to see the desk for their drop-off child (`to_check_in`). If they
   * scan the same QR again — to check, or a sibling presses on — the kiosk
   * answers "already redeemed", a `failed` session with no sale. That one is
   * now the latest, and with no sale the desk reads the booking's status
   * (`redeemed`) and calls it `done`: the till's "Sent from the kiosk" panel
   * drops the family while their supervised child is still booked and not
   * checked in. The check-in board still lists the child, so nobody is lost —
   * but the desk's list is wrong about who is waiting.
   */
  it('a mixed booking scanned again stays at the desk while its supervised child waits', async () => {
    const mixed = await bookAndPay(
      [
        { packageId: twoHoursId, kids: 1, adults: 1 },
        { packageId: oneHourId, kids: 1, adults: 0, supervision: ALLERGIC_CHILD },
      ],
      { supervised: true },
    );
    const sent = await scan(K1, mixed.qr, await startSession(K1));
    expect(sent.body).toMatchObject({ outcome: 'handed_off', reason: KIOSK_REASONS.supervisedRest });
    expect((await deskEntry(mixed.id))?.state).toBe('to_check_in');

    const again = await scan(K1, mixed.qr, await startSession(K1));
    expect(again.body).toMatchObject({ outcome: 'failed', reason: 'BOOKING_ALREADY_REDEEMED' });
    // The supervised child is still booked, not checked in.
    const [saleRow] = await salesOf(mixed.id);
    const waiting = await ctx.db
      .select({ status: checkin.status })
      .from(checkin)
      .where(eq(checkin.saleId, saleRow!.id));
    expect(waiting.some((c) => c.status === 'registered')).toBe(true);
    // The session with the sale speaks for the booking: the family stays
    // listed for their drop-off child, whatever a later fruitless scan said.
    expect((await deskEntry(mixed.id))?.state).toBe('to_check_in');
  });
});

// --- 3 ------------------------------------------------------------------------------

describe('attack 3 — privacy over everything the kiosk was told in this file', () => {
  it('no private key and no private value in any answer', () => {
    expect(toldTheKiosk.length).toBeGreaterThan(40);
    const keys = toldTheKiosk.flatMap((a) => keysOf(a));
    expect(keys.filter((k) => KIOSK_PRIVATE_FIELD.test(k))).toEqual([]);
    const text = JSON.stringify(toldTheKiosk);
    for (const secretValue of [ALLERGIC_CHILD.allergies, ALLERGIC_CHILD.childName, PARENT, 'Mali', PHONE, '+66812345678']) {
      expect(text).not.toContain(secretValue);
    }
  });
});
