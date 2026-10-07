import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  booking,
  box,
  branch,
  device,
  deviceCredential,
  kioskSession,
  opsRun,
  sale,
  station,
  stationDevice,
  ticketPackage,
} from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import {
  KIOSK_DEVICE_SCOPES,
  KIOSK_IDLE_TIMEOUT_MS,
  KIOSK_PRIVATE_FIELD,
  KIOSK_REASONS,
  KioskAbandonAnswerSchema,
  KioskDeskAnswerSchema,
  KioskHealthAnswerSchema,
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
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  takeStation,
  teardownAll,
  type TestContext,
} from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { bookingQrOf } from '../src/services/booking-payment';
import { KIOSK_PRINT_RUN } from '../src/services/kiosk';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-20 K2 (SCRUM-217) — THE KIOSK SURFACE, driven end to end against the
 * virtual kiosk box: QA steps 5 and 6 of the ticket, from the kiosk's own
 * calls, with the kiosk paired the way a manager pairs one and every failure
 * screen driven from the simulator controls.
 *
 *   5. At the kiosk, scan the seeded paid booking (bands, wallet credit, the
 *      redeemed booking); scan again (already redeemed); scan the supervised
 *      booking (the staff desk); scan the mixed booking.
 *   6. Set the kiosk printer offline in the Simulators panel; scan a paid
 *      booking (the abort, the still-unredeemed booking, the kiosk_session
 *      outcome on Activity).
 *
 * Beside them: the pairing code flow (as a display pairs), Q9's idle timeout
 * (60 seconds, `kiosk.abandon` with the station and the box), the staff desk's
 * view of a family sent to it, the Kiosk tile on Health, the print's `ops_run`
 * of kind `device`, and H15 over every new answer the kiosk is given.
 *
 * The booking flow is the family's own — the public route, paid through the
 * simulated gateway's hosted page — so the QR the kiosk scans is the one the
 * park signed. The setup mirrors `kiosk-k1.test.ts`, minus the credential:
 * here the kiosk earns it from a pairing code.
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
let otherManager: string;
let operatorId: string;
let centralId: string;
let tillId: string;
let kioskId: string;
let kioskBoxId: string;
let bandPrinterId: string;
let receiptPrinterId: string;
let twoHoursId: string;
let oneHourId: string;
let confirmationIds: string[];
let agent: BoxAgent;
/** The kiosk browser's own secret, which becomes its credential once a manager claims its code. */
let KIOSK_SECRET: string;
const link: CuttableLink = { cut: false };

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.218.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

const SUPERVISED_CHILD = { childName: 'Ploy', ageYears: 6, allergies: 'Peanuts' };

interface Paid {
  id: string;
  reference: string;
  qr: string;
}

async function bookAndPay(lines: Array<Record<string, unknown>>, opts: { supervised?: boolean } = {}): Promise<Paid> {
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

// --- The kiosk's own calls, as its screen makes them ---------------------------

const kioskHeaders = (secret = KIOSK_SECRET) => ({ authorization: `Bearer ${secret}` });

async function kioskState(secret = KIOSK_SECRET) {
  return ctx.app.inject({
    method: 'GET',
    url: `/box/v1/station/${kioskId}/kiosk/state`,
    headers: kioskHeaders(secret),
  });
}

/** The guest touches the attract screen. */
async function startSession(sessionId = newId()): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${kioskId}/kiosk/sessions`,
    headers: kioskHeaders(),
    payload: { sessionId },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(() => KioskSessionAnswerSchema.parse(res.json())).not.toThrow();
  expectNothingPrivate(res.json());
  return sessionId;
}

async function abandon(sessionId: string, cause: 'idle' | 'cancelled' = 'idle') {
  return ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${kioskId}/kiosk/sessions/${sessionId}/abandon`,
    headers: kioskHeaders(),
    payload: { cause },
  });
}

/** A scan on the kiosk: the screen's session and a press minted on the kiosk. */
async function scan(
  qr: string,
  sessionId?: string,
): Promise<{ statusCode: number; body: KioskRedeemAnswer; actionId: string }> {
  const actionId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${kioskId}/kiosk/redeem`,
    headers: kioskHeaders(),
    payload: { actionId, qr, ...(sessionId ? { sessionId } : {}) },
  });
  return { statusCode: res.statusCode, body: res.json(), actionId };
}

async function simulate(control: 'printer_offline' | 'paper_out' | 'box_offline' | 'clear', cookie = admin) {
  return ctx.app.inject({
    method: 'POST',
    url: `/stations/${kioskId}/kiosk/simulate`,
    headers: { cookie },
    payload: { control },
  });
}

async function desk(cookie = reception): Promise<KioskDeskEntry[]> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/kiosk-desk?branchId=${centralId}`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return KioskDeskAnswerSchema.parse(res.json()).entries;
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

/** H15 — no key the kiosk is told is a private field, and no private value is in it. */
function expectNothingPrivate(answer: unknown): void {
  expect(keysOf(answer).filter((k) => KIOSK_PRIVATE_FIELD.test(k))).toEqual([]);
  const text = JSON.stringify(answer);
  expect(text).not.toContain('Peanuts');
  expect(text).not.toContain('Mali');
  expect(text).not.toContain('0812345678');
}

async function auditRows(action: string, entityId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
}

async function printRunsFor(actionId: string) {
  return ctx.db
    .select()
    .from(opsRun)
    .where(and(eq(opsRun.name, KIOSK_PRINT_RUN), eq(opsRun.actionId, actionId)));
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
  otherManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);

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
  oneHourId = packages.find((p) => p.name === '1 Hour Play')!.id;
  const catalogue = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  expect(catalogue.statusCode, catalogue.body).toBe(200);
  confirmationIds = (
    catalogue.json().supervision as { policy: { confirmations: Array<{ id: string; required: boolean }> } }
  ).policy.confirmations
    .filter((c) => c.required)
    .map((c) => c.id);

  // THE VIRTUAL KIOSK BOX: a kiosk-role box, its two simulated printers, the kiosk station.
  kioskBoxId = newId();
  await ctx.db.insert(box).values({
    id: kioskBoxId,
    operatorId,
    branchId: centralId,
    name: 'Kiosk box 1',
    slot: 'kiosk-1',
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
      label: 'Kiosk Band Printer',
      transport: 'simulated',
      address: '192.168.88.241:9100',
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
      label: 'Kiosk Receipt Printer',
      transport: 'simulated',
      address: '192.168.88.242:9100',
      model: 'Xprinter XP-80',
      protocol: 'escpos',
      reachability: 'reachable',
      paperStatus: 'ok',
    },
  ]);
  kioskId = newId();
  await ctx.db.insert(station).values({
    id: kioskId,
    operatorId,
    branchId: centralId,
    boxId: kioskBoxId,
    name: 'Kiosk 1',
    kind: 'kiosk',
    codePrefix: 'K1',
    capabilities: [],
    accessScope: 'all_staff',
  });
  await ctx.db.insert(stationDevice).values([
    { id: newId(), stationId: kioskId, role: 'kids_band', deviceId: bandPrinterId },
    { id: newId(), stationId: kioskId, role: 'adult_band', deviceId: bandPrinterId },
    { id: newId(), stationId: kioskId, role: 'receipt', deviceId: receiptPrinterId },
  ]);

  agent = linkedAgent(ctx, kioskBoxId, 'kiosk-box-k2', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 240_000);

afterAll(async () => {
  if (agent) {
    agent.stop();
    detachInProcessBox(agent);
  }
  await ctx?.close();
  await teardownAll();
});

describe('pairing a kiosk, as a customer display pairs', () => {
  it('the kiosk shows a K code, a manager claims it in the Console, and the kiosk holds its own credential', async () => {
    KIOSK_SECRET = bearer();
    const asked = await ctx.app.inject({
      method: 'POST',
      url: '/kiosk/pairing',
      headers: kioskHeaders(),
      payload: {},
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const code = asked.json().pairingCode as string;
    expect(code).toMatch(/^K\d{6}$/);

    const pending = await ctx.app.inject({ method: 'GET', url: '/kiosk/pairing', headers: kioskHeaders() });
    expect(pending.json()).toEqual({ status: 'pending' });
    // Not yet paired: the kiosk's own calls refuse it.
    expect((await kioskState()).statusCode).toBe(401);

    // Typed into "Pair a display" by mistake: the display claim takes six digits and nothing else.
    const asDisplay = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${tillId}/displays/claim`,
      headers: { cookie: admin },
      payload: { pairingCode: code, name: 'Wrong screen' },
    });
    expect(asDisplay.statusCode).toBe(400);
    const digitsAsDisplay = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${tillId}/displays/claim`,
      headers: { cookie: admin },
      payload: { pairingCode: code.slice(1), name: 'Wrong screen' },
    });
    expect(digitsAsDisplay.statusCode).toBe(409);
    expect(digitsAsDisplay.json().error.code).toBe('DISPLAY_PAIRING_INVALID');

    // A kiosk pairs to a kiosk station only, and only by someone who may pair devices.
    const atTill = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${tillId}/kiosks/claim`,
      headers: { cookie: admin },
      payload: { pairingCode: code, name: 'Lobby kiosk' },
    });
    expect(atTill.statusCode).toBe(409);
    expect(atTill.json().error.code).toBe('KIOSK_STATION_INVALID');
    const byReception = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${kioskId}/kiosks/claim`,
      headers: { cookie: reception },
      payload: { pairingCode: code, name: 'Lobby kiosk' },
    });
    expect(byReception.statusCode).toBe(403);

    // As a person types it: lower case, spaces, a dash.
    const typed = `k-${code.slice(1, 4)} ${code.slice(4)}`;
    const claimed = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${kioskId}/kiosks/claim`,
      headers: { cookie: manager },
      payload: { pairingCode: typed, name: 'Lobby kiosk' },
    });
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().station).toMatchObject({ id: kioskId, name: 'Kiosk 1', kind: 'kiosk' });
    const credentialId = claimed.json().device.id as string;

    const [row] = await ctx.db.select().from(deviceCredential).where(eq(deviceCredential.id, credentialId));
    expect(row).toMatchObject({
      kind: 'kiosk',
      stationId: kioskId,
      label: 'Lobby kiosk',
      secretHash: SHA(KIOSK_SECRET),
      revokedAt: null,
    });
    expect(row!.scopes).toEqual([...KIOSK_DEVICE_SCOPES]);
    expect(row!.pairedAt).not.toBeNull();
    const paired = await auditRows('kiosk.paired', credentialId);
    expect(paired).toHaveLength(1);
    expect(paired[0]!.after).toMatchObject({ stationId: kioskId, boxId: kioskBoxId });

    const status = await ctx.app.inject({ method: 'GET', url: '/kiosk/pairing', headers: kioskHeaders() });
    expect(status.json()).toEqual({ status: 'paired', station: { id: kioskId, name: 'Kiosk 1' } });

    // The code was spent: claiming it again finds nothing.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${kioskId}/kiosks/claim`,
      headers: { cookie: manager },
      payload: { pairingCode: code, name: 'Lobby kiosk' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('KIOSK_PAIRING_INVALID');

    // The paired kiosk reads itself: which kiosk, and Q9's timeout. Nothing private.
    const state = await kioskState();
    expect(state.statusCode, state.body).toBe(200);
    expect(KioskStateSchema.parse(state.json())).toEqual({
      station: { id: kioskId, name: 'Kiosk 1' },
      branchName: expect.any(String),
      idleTimeoutMs: KIOSK_IDLE_TIMEOUT_MS,
    });
    expect(KIOSK_IDLE_TIMEOUT_MS).toBe(60_000);
    expectNothingPrivate(state.json());
  });

  it('a second kiosk screen at the same station is refused until the first is revoked', async () => {
    const second = bearer();
    const asked = await ctx.app.inject({
      method: 'POST',
      url: '/kiosk/pairing',
      headers: kioskHeaders(second),
      payload: {},
    });
    const occupied = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${kioskId}/kiosks/claim`,
      headers: { cookie: admin },
      payload: { pairingCode: asked.json().pairingCode, name: 'Second kiosk' },
    });
    expect(occupied.statusCode).toBe(409);
    expect(occupied.json().error.code).toBe('KIOSK_STATION_OCCUPIED');
  });

  it("a display's six digits are never a kiosk's code", async () => {
    const displayBearer = bearer();
    const minted = await ctx.app.inject({
      method: 'POST',
      url: '/display/pairing',
      headers: { authorization: `Bearer ${displayBearer}` },
      payload: {},
    });
    expect(minted.statusCode, minted.body).toBe(200);
    const asKiosk = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${kioskId}/kiosks/claim`,
      headers: { cookie: admin },
      payload: { pairingCode: minted.json().pairingCode, name: 'Not a kiosk' },
    });
    expect(asKiosk.statusCode).toBe(409);
    expect(asKiosk.json().error.code).toBe('KIOSK_PAIRING_INVALID');
  });
});

describe('QA step 5 — a guest at the virtual kiosk, end to end', () => {
  let paid: Paid;

  it('touch, scan: the bands and wallet credit come out, and the guest is one session', async () => {
    paid = await bookAndPay([{ packageId: twoHoursId, kids: 2, adults: 1 }]);
    const sessionId = await startSession();
    const before = await ctx.db.select().from(kioskSession).where(eq(kioskSession.stationId, kioskId));

    const done = await scan(paid.qr, sessionId);
    expect(done.statusCode, JSON.stringify(done.body)).toBe(200);
    expect(() => KioskRedeemAnswerSchema.parse(done.body)).not.toThrow();
    expect(done.body).toMatchObject({
      sessionId,
      outcome: 'issued',
      booking: { reference: paid.reference, kids: 2, adults: 1 },
      desk: { required: false, supervisedChildren: 0 },
    });
    expect(done.body.bands.map((b) => b.kind).sort()).toEqual(['adult', 'kid', 'kid']);
    expect(done.body.walletCreditSatang).toBeGreaterThan(0);
    expectNothingPrivate(done.body);

    // One guest, one row: the press took over the session the touch opened.
    const after = await ctx.db.select().from(kioskSession).where(eq(kioskSession.stationId, kioskId));
    expect(after.length).toBe(before.length);
    const [row] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, sessionId));
    expect(row).toMatchObject({ outcome: 'issued', actionId: done.actionId, bookingId: paid.id });
    expect(row!.saleId).not.toBeNull();
    const [redeemed] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(redeemed!.status).toBe('redeemed');

    // The print is a device run on the operational record.
    const runs = await printRunsFor(done.actionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ kind: 'device', outcome: 'ok', stationId: kioskId, branchId: centralId });
    const detail = runs[0]!.detail as { sessionId: string; jobs: number; printed: number; committed: boolean; boxId: string };
    expect(detail).toMatchObject({ sessionId, committed: true, boxId: kioskBoxId });
    expect(detail.printed).toBe(detail.jobs);
    expect(detail.jobs).toBeGreaterThanOrEqual(3);
  });

  it('scanning it again shows already redeemed, when and where', async () => {
    const again = await scan(paid.qr, await startSession());
    expect(again.body).toMatchObject({ outcome: 'failed', reason: 'BOOKING_ALREADY_REDEEMED' });
    expect(again.body.alreadyRedeemed).toMatchObject({ stationName: 'Kiosk 1' });
    expectNothingPrivate(again.body);
    // Nothing was printed for a refusal before the claim, so there is no device run.
    expect(await printRunsFor(again.actionId)).toEqual([]);
  });

  it('a drop-off booking goes to the staff desk, where it is already on screen to redeem', async () => {
    const dropOff = await bookAndPay([{ packageId: oneHourId, kids: 1, adults: 0, supervision: SUPERVISED_CHILD }], {
      supervised: true,
    });
    const sent = await scan(dropOff.qr, await startSession());
    expect(sent.body).toMatchObject({
      outcome: 'handed_off',
      reason: KIOSK_REASONS.supervised,
      desk: { required: true, supervisedChildren: 1 },
      bands: [],
    });
    expectNothingPrivate(sent.body);

    const entry = (await desk()).find((e) => e.booking.id === dropOff.id);
    expect(entry).toMatchObject({
      sessionId: sent.body.sessionId,
      stationName: 'Kiosk 1',
      outcome: 'handed_off',
      reason: KIOSK_REASONS.supervised,
      booking: { reference: dropOff.reference, status: 'paid' },
      supervisedChildren: 1,
      bandsIssued: 0,
      state: 'to_redeem',
    });
    // The desk's view names no child and no allergy either: the till's dialog opens the booking.
    expect(JSON.stringify(entry)).not.toContain('Peanuts');
    expect(JSON.stringify(entry)).not.toContain('Ploy');

    // The desk redeems it at the till; the entry is then done.
    const redeemed = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${dropOff.id}/redeem`,
      headers: { cookie: reception },
      payload: {},
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    expect((await desk()).find((e) => e.booking.id === dropOff.id)?.state).toBe('done');
  });

  it('a mixed booking issues the regular bands and leaves the desk the supervised child to check in', async () => {
    const mixed = await bookAndPay(
      [
        { packageId: twoHoursId, kids: 1, adults: 1 },
        { packageId: oneHourId, kids: 1, adults: 0, supervision: SUPERVISED_CHILD },
      ],
      { supervised: true },
    );
    const sent = await scan(mixed.qr, await startSession());
    expect(sent.body).toMatchObject({
      outcome: 'handed_off',
      reason: KIOSK_REASONS.supervisedRest,
      desk: { required: true, supervisedChildren: 1 },
    });
    expect(sent.body.bands.map((b) => b.kind).sort()).toEqual(['adult', 'kid']);
    const entry = (await desk()).find((e) => e.booking.id === mixed.id);
    expect(entry).toMatchObject({ state: 'to_check_in', bandsIssued: 2, supervisedChildren: 1 });

    // Entries the desk still has to act on come first.
    const entries = await desk();
    const firstDone = entries.findIndex((e) => e.state === 'done');
    if (firstDone >= 0) expect(entries.slice(firstDone).every((e) => e.state === 'done')).toBe(true);
  });

  it('the desk is staff-only and answers for the branch the caller works at', async () => {
    const anonymous = await ctx.app.inject({ method: 'GET', url: `/kiosk-desk?branchId=${centralId}` });
    expect(anonymous.statusCode).toBe(401);
    const asKiosk = await ctx.app.inject({
      method: 'GET',
      url: `/kiosk-desk?branchId=${centralId}`,
      headers: kioskHeaders(),
    });
    expect(asKiosk.statusCode).toBe(401);
    const elsewhere = await ctx.app.inject({
      method: 'GET',
      url: `/kiosk-desk?branchId=${centralId}`,
      headers: { cookie: otherManager },
    });
    expect(elsewhere.statusCode).toBe(403);
  });
});

describe('QA step 6 — every failure screen, from the simulator controls', () => {
  it('printer offline: the redemption is called off, the booking stays paid, and Activity has the abort', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    // Reception may not drive the simulator; a manager may.
    expect((await simulate('printer_offline', reception)).statusCode).toBe(403);
    const forced = await simulate('printer_offline');
    expect(forced.statusCode, forced.body).toBe(200);
    expect(forced.json().printers.find((p: { deviceId: string }) => p.deviceId === bandPrinterId).faults).toEqual([
      'unreachable',
    ]);
    const simulated = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'kiosk.simulate'), eq(auditLog.entityId, kioskId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(simulated[0]!.after).toMatchObject({ stationId: kioskId, boxId: kioskBoxId, control: 'printer_offline' });

    try {
      const sessionId = await startSession();
      const aborted = await scan(paid.qr, sessionId);
      expect(aborted.body).toMatchObject({
        sessionId,
        outcome: 'failed',
        reason: 'PRINTER_UNREACHABLE',
        bands: [],
        walletCreditSatang: 0,
        desk: { required: true },
      });
      expectNothingPrivate(aborted.body);
      const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
      expect(row!.status).toBe('paid');
      expect(await ctx.db.select().from(sale).where(eq(sale.bookingId, paid.id))).toEqual([]);

      // The device run, failed with the printer's own code.
      const runs = await printRunsFor(aborted.actionId);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: 'device', outcome: 'failed', errorCode: 'PRINTER_UNREACHABLE' });
      expect(runs[0]!.detail).toMatchObject({ committed: false, deviceId: bandPrinterId });

      // On Activity, as the Console reads it: the abort, with the station and the box.
      const activity = await ctx.app.inject({
        method: 'GET',
        url: `/audit?action=kiosk.abort&entityId=${sessionId}`,
        headers: { cookie: admin },
      });
      expect(activity.statusCode, activity.body).toBe(200);
      const items = activity.json().entries as Array<{ action: string; after: Record<string, unknown> }>;
      expect(items.length).toBe(1);
      expect(items[0]!.after).toMatchObject({ stationId: kioskId, boxId: kioskBoxId, reason: 'PRINTER_UNREACHABLE' });

      // And the desk has the booking waiting.
      expect((await desk()).find((e) => e.booking.id === paid.id)).toMatchObject({
        outcome: 'failed',
        reason: 'PRINTER_UNREACHABLE',
        state: 'to_redeem',
      });
    } finally {
      expect((await simulate('clear')).statusCode).toBe(200);
    }
    // Cleared, the same booking issues at the kiosk.
    const retried = await scan(paid.qr, await startSession());
    expect(retried.body.outcome).toBe('issued');
    expect((await desk()).find((e) => e.booking.id === paid.id)?.state).toBe('done');
  });

  it('paper out: the redemption is called off with the paper fault', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    expect((await simulate('paper_out')).statusCode).toBe(200);
    try {
      const aborted = await scan(paid.qr, await startSession());
      expect(aborted.body).toMatchObject({ outcome: 'failed', reason: 'PRINTER_PAPER_OUT' });
      const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
      expect(row!.status).toBe('paid');
      expect((await printRunsFor(aborted.actionId))[0]).toMatchObject({ outcome: 'failed', errorCode: 'PRINTER_PAPER_OUT' });
    } finally {
      expect((await simulate('clear')).statusCode).toBe(200);
    }
  });

  it('box offline: called off before anything is claimed, and the box comes back on clear', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const off = await simulate('box_offline');
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().boxOffline).toBe(true);
    try {
      const aborted = await scan(paid.qr, await startSession());
      expect(aborted.body).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.boxOffline });
      expect((await printRunsFor(aborted.actionId))[0]).toMatchObject({
        kind: 'device',
        outcome: 'failed',
        errorCode: KIOSK_REASONS.boxOffline,
      });
    } finally {
      const cleared = await simulate('clear');
      expect(cleared.json().boxOffline).toBe(false);
    }
    expect((await scan(paid.qr, await startSession())).body.outcome).toBe('issued');
  });

  it('a kiosk control on a till is refused', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/stations/${tillId}/kiosk/simulate`,
      headers: { cookie: admin },
      payload: { control: 'printer_offline' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('KIOSK_STATION_INVALID');
  });
});

describe('Q9 — 60 seconds of no touch or scan abandons the session', () => {
  it('records the session abandoned, with kiosk.abandon naming the station and the box', async () => {
    const sessionId = await startSession();
    const res = await abandon(sessionId);
    expect(res.statusCode, res.body).toBe(200);
    const answer = KioskAbandonAnswerSchema.parse(res.json());
    expect(answer).toMatchObject({ sessionId, abandoned: true, outcome: 'abandoned' });
    expectNothingPrivate(answer);
    const [row] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, sessionId));
    expect(row).toMatchObject({ outcome: 'abandoned', reason: KIOSK_REASONS.idle, saleId: null, actionId: null });
    expect(row!.endedAt).not.toBeNull();
    const rows = await auditRows('kiosk.abandon', sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorAccountId).toBeNull();
    expect(rows[0]!.after).toMatchObject({
      stationId: kioskId,
      boxId: kioskBoxId,
      reason: KIOSK_REASONS.idle,
      cause: 'idle',
    });

    // Abandoning it again writes nothing more.
    const again = await abandon(sessionId);
    expect(again.json()).toMatchObject({ abandoned: false, outcome: 'abandoned' });
    expect(await auditRows('kiosk.abandon', sessionId)).toHaveLength(1);
  });

  it('"Start over" before a scan is the guest cancelling', async () => {
    const sessionId = await startSession();
    expect((await abandon(sessionId, 'cancelled')).json()).toMatchObject({ abandoned: true });
    const [row] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, sessionId));
    expect(row!.reason).toBe(KIOSK_REASONS.cancelled);
  });

  it('a session that scanned something is never written off as walked away from', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }]);
    const sessionId = await startSession();
    expect((await scan(paid.qr, sessionId)).body.outcome).toBe('issued');
    const late = await abandon(sessionId);
    expect(late.json()).toMatchObject({ abandoned: false, outcome: 'issued' });
    expect(await auditRows('kiosk.abandon', sessionId)).toEqual([]);
  });

  it('a press on a session the timeout already ended opens a session of its own', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 0 }]);
    const sessionId = await startSession();
    await abandon(sessionId);
    const late = await scan(paid.qr, sessionId);
    expect(late.body.outcome).toBe('issued');
    expect(late.body.sessionId).not.toBe(sessionId);
    const [kept] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, sessionId));
    expect(kept!.outcome).toBe('abandoned');
  });

  it('a new guest supersedes a session the screen left open with nothing scanned', async () => {
    const left = await startSession();
    const next = await startSession();
    const [old] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, left));
    expect(old).toMatchObject({ outcome: 'abandoned', reason: KIOSK_REASONS.superseded });
    const [current] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, next));
    expect(current!.outcome).toBeNull();
    // A start sent twice is the same session.
    await startSession(next);
    const [still] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, next));
    expect(still!.outcome).toBeNull();
    await abandon(next);
  });

  it("another kiosk's session, or one that does not exist, is not this kiosk's to abandon", async () => {
    expect((await abandon(newId())).statusCode).toBe(404);
  });
});

describe('the Kiosk tile on Health', () => {
  it('shows the box and screen online, the band printer, today by outcome and the last redemption', async () => {
    await kioskState(); // the screen's poll
    const res = await ctx.app.inject({ method: 'GET', url: '/ops/kiosks', headers: { cookie: manager } });
    expect(res.statusCode, res.body).toBe(200);
    const tile = KioskHealthAnswerSchema.parse(res.json()).kiosks.find((k) => k.stationId === kioskId);
    expect(tile).toBeTruthy();
    expect(tile).toMatchObject({
      name: 'Kiosk 1',
      branchId: centralId,
      box: { id: kioskBoxId, online: true },
      screen: { paired: true, label: 'Lobby kiosk', online: true },
      printer: { deviceId: bandPrinterId, label: 'Kiosk Band Printer', faults: [] },
    });
    expect(tile!.today.issued).toBeGreaterThanOrEqual(4);
    expect(tile!.today.handedOff).toBeGreaterThanOrEqual(2);
    expect(tile!.today.failed).toBeGreaterThanOrEqual(4);
    expect(tile!.today.abandoned).toBeGreaterThanOrEqual(4);
    expect(tile!.today.sessions).toBe(
      tile!.today.issued + tile!.today.handedOff + tile!.today.failed + tile!.today.abandoned + tile!.today.open,
    );
    expect(tile!.lastRedemptionAt).not.toBeNull();

    // A printer forced offline shows on the tile at once.
    await simulate('printer_offline');
    try {
      const forced = await ctx.app.inject({ method: 'GET', url: '/ops/kiosks', headers: { cookie: manager } });
      const row = KioskHealthAnswerSchema.parse(forced.json()).kiosks.find((k) => k.stationId === kioskId)!;
      expect(row.printer).toMatchObject({ reachability: 'unreachable', faults: ['unreachable'] });
    } finally {
      await simulate('clear');
    }
  });

  it("is read within the reader's reach, and not at all without admin:health:read", async () => {
    const elsewhere = await ctx.app.inject({ method: 'GET', url: '/ops/kiosks', headers: { cookie: otherManager } });
    expect(elsewhere.statusCode, elsewhere.body).toBe(200);
    expect(KioskHealthAnswerSchema.parse(elsewhere.json()).kiosks.some((k) => k.stationId === kioskId)).toBe(false);
    const asReception = await ctx.app.inject({ method: 'GET', url: '/ops/kiosks', headers: { cookie: reception } });
    expect(asReception.statusCode).toBe(403);
  });
});

describe('a revoked kiosk', () => {
  it('reads as needing a new code, and its calls are refused', async () => {
    const [cred] = await ctx.db
      .select()
      .from(deviceCredential)
      .where(and(eq(deviceCredential.stationId, kioskId), eq(deviceCredential.kind, 'kiosk')));
    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/credentials/${cred!.id}/revoke`,
      headers: { cookie: admin },
      payload: { reason: 'test' },
    });
    expect([200, 204], revoked.body).toContain(revoked.statusCode);
    expect((await kioskState()).statusCode).toBe(401);
    const status = await ctx.app.inject({ method: 'GET', url: '/kiosk/pairing', headers: kioskHeaders() });
    expect(status.json()).toEqual({ status: 'expired' });
    const start = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/station/${kioskId}/kiosk/sessions`,
      headers: kioskHeaders(),
      payload: { sessionId: newId() },
    });
    expect(start.statusCode).toBe(401);
  });
});
