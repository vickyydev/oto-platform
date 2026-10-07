import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  booking,
  bookingRedemption,
  box,
  boxCommand,
  branch,
  checkin,
  device,
  deviceCredential,
  kioskSession,
  printJob,
  rolePermission,
  sale,
  station,
  stationDevice,
  ticketPackage,
  walletEntry,
} from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import {
  KIOSK_DEVICE_SCOPES,
  KIOSK_PRIVATE_FIELD,
  KIOSK_REASONS,
  KIOSK_REDEEM_SCOPE,
  KioskRedeemAnswerSchema,
  PERMISSIONS,
  ROLE_BUNDLES,
  mintBookingQr,
  newId,
  type KioskRedeemAnswer,
} from '@oto/shared';
import {
  ADMIN,
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
import { commitSale } from '../src/services/sale';
import { resetDemoData } from '../src/services/demo-reset';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * S2-20 K1 (SCRUM-217) — THE SELF-SERVICE KIOSK'S REDEMPTION CORE, against the
 * virtual kiosk box.
 *
 * The box is `createBoxAgent` — the code a Raspberry Pi runs — registered into
 * a kiosk-role box row at Central Floresta, with a kiosk station, a simulated
 * band printer and a simulated receipt printer, attached in-process as the api
 * attaches its virtual box. The kiosk speaks with its paired credential only,
 * carrying `pos:kiosk:redeem`; nobody is signed in.
 *
 * Every booking is made the way a family makes one — the public route, paid
 * through the simulated gateway's hosted page — so the QR the kiosk scans is
 * the one the platform signed when the money was confirmed.
 *
 * The plan's checks (docs/progress/plans/events-kiosk/PLAN.md §9, K1 row):
 *
 *   5. a paid unredeemed booking for this branch issues its bands and wallet
 *      credit once and prints them; scanning it again shows already-redeemed;
 *      a booking that is all drop-off issues nothing and shows the desk; a
 *      mixed booking issues the regular bands and shows the desk for the rest;
 *   6. with the kiosk printer forced offline the same redemption aborts: the
 *      booking stays paid and unredeemed, the guest is sent to the desk, no
 *      hand-off is recorded, and the till can still redeem it;
 *
 * and a replayed press issues once (H17), with H13-H16 beside them.
 */

const PGW_SECRET = randomBytes(32).toString('hex');
const KIOSK_SECRET = randomBytes(32).toString('hex');
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
let admin: string;
let reception: string;
let operatorId: string;
let centralId: string;
let tillId: string;
let kioskId: string;
let kioskBoxId: string;
let credentialId: string;
let bandPrinterId: string;
let receiptPrinterId: string;
let twoHoursId: string;
let oneHourId: string;
let chalongPackageId: string;
let confirmationIds: string[];
let agent: BoxAgent;
const link: CuttableLink = { cut: false };

let family = 0;
const familyAddress = () => {
  family += 1;
  return `10.217.${Math.floor(family / 250)}.${(family % 250) + 1}`;
};

const SUPERVISED_CHILD = { childName: 'Ploy', ageYears: 6, allergies: 'Peanuts' };

interface Paid {
  id: string;
  reference: string;
  qr: string;
  totalSatang: number;
}

/** Book and pay the way a family does: the public route, then the simulated gateway's hosted page. */
async function bookAndPay(
  lines: Array<Record<string, unknown>>,
  opts: { branchCode?: string; supervised?: boolean } = {},
): Promise<Paid> {
  const made = await ctx.app.inject({
    method: 'POST',
    url: '/public/bookings',
    remoteAddress: familyAddress(),
    payload: {
      branchCode: opts.branchCode ?? CENTRAL_BRANCH_CODE,
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
  const qr = bookingQrOf(row!);
  expect(qr, 'the paid booking carries the QR the park signed').toBeTruthy();
  return { id, reference: row!.reference, qr: qr!, totalSatang: row!.totalSatang };
}

async function kioskRedeem(
  qr: string,
  opts: { actionId?: string; secret?: string; stationId?: string } = {},
): Promise<{ statusCode: number; body: KioskRedeemAnswer & { error?: { code: string } }; actionId: string }> {
  const actionId = opts.actionId ?? newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/box/v1/station/${opts.stationId ?? kioskId}/kiosk/redeem`,
    headers: { authorization: `Bearer ${opts.secret ?? KIOSK_SECRET}` },
    payload: { actionId, qr },
  });
  return { statusCode: res.statusCode, body: res.json(), actionId };
}

/** Every key, nested ones included, of an answer the kiosk is shown. */
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

function expectNothingPrivate(answer: unknown): void {
  // The answer is exactly the strict schema, and no key in it is a private field (H15).
  expect(() => KioskRedeemAnswerSchema.parse(answer)).not.toThrow();
  expect(keysOf(answer).filter((k) => KIOSK_PRIVATE_FIELD.test(k))).toEqual([]);
  expect(JSON.stringify(answer)).not.toContain('Peanuts');
  expect(JSON.stringify(answer)).not.toContain('Mali');
  expect(JSON.stringify(answer)).not.toContain('0812345678');
}

/** The constraint a refused statement names, or null when it was not refused. */
async function constraintOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work;
    return null;
  } catch (err) {
    const e = err as { constraint?: string; cause?: { constraint?: string } };
    return e.cause?.constraint ?? e.constraint ?? 'refused without a constraint';
  }
}

const printouts = (deviceId: string) => agent.printing()!.printouts(deviceId).length;

async function auditRows(action: string, entityId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));
}

async function salesOf(bookingId: string) {
  return ctx.db.select().from(sale).where(eq(sale.bookingId, bookingId));
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

  const [central] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
  const [chalong] = await ctx.db.select().from(branch).where(eq(branch.code, CHALONG_BRANCH_CODE));
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
  const [chalongPackage] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.branchId, chalong!.id));
  chalongPackageId = chalongPackage!.id;
  const catalogue = await ctx.app.inject({ method: 'GET', url: `/public/branches/${CENTRAL_BRANCH_CODE}/catalog` });
  expect(catalogue.statusCode, catalogue.body).toBe(200);
  confirmationIds = (
    catalogue.json().supervision as { policy: { confirmations: Array<{ id: string; required: boolean }> } }
  ).policy.confirmations
    .filter((c) => c.required)
    .map((c) => c.id);

  // THE VIRTUAL KIOSK BOX: a kiosk-role box, its two printers, the kiosk station.
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

  // The kiosk's paired credential, as a redeemed pairing code leaves it.
  credentialId = newId();
  await ctx.db.insert(deviceCredential).values({
    id: credentialId,
    operatorId,
    branchId: centralId,
    kind: 'kiosk',
    stationId: kioskId,
    label: 'Kiosk 1 screen',
    secretHash: SHA(KIOSK_SECRET),
    scopes: [...KIOSK_DEVICE_SCOPES],
    pairedAt: new Date(),
  });

  agent = linkedAgent(ctx, kioskBoxId, 'kiosk-box', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  attachInProcessBox(agent);
  // The kiosk box drives both of its printers.
  expect(agent.printing()!.simulators().map((s) => s.deviceId).sort()).toEqual(
    [bandPrinterId, receiptPrinterId].sort(),
  );
}, 240_000);

afterAll(async () => {
  if (agent) {
    agent.stop();
    detachInProcessBox(agent);
  }
  await ctx?.close();
  await teardownAll();
});

describe('check 5 — the kiosk redeems a paid booking for this branch', () => {
  let paid: Paid;
  let first: Awaited<ReturnType<typeof kioskRedeem>>;

  it('issues its bands and wallet credit once, printed on the kiosk box before anything is committed', async () => {
    paid = await bookAndPay([{ packageId: twoHoursId, kids: 2, adults: 1 }]);
    const bandsBefore = printouts(bandPrinterId);
    first = await kioskRedeem(paid.qr);
    expect(first.statusCode, JSON.stringify(first.body)).toBe(200);
    const answer = first.body;
    expect(answer.outcome).toBe('issued');
    expect(answer.reason).toBeNull();
    expect(answer.replay).toBe(false);
    expect(answer.booking).toEqual({ reference: paid.reference, kids: 2, adults: 1 });
    expect(answer.bands.map((b) => b.kind).sort()).toEqual(['adult', 'kid', 'kid']);
    for (const b of answer.bands) expect(b.shortCode).toMatch(/^K1-/);
    expect(answer.walletCreditSatang).toBeGreaterThan(0);
    expect(answer.desk).toEqual({ required: false, supervisedChildren: 0 });
    expect(answer.alreadyRedeemed).toBeNull();
    expectNothingPrivate(answer);

    // The booking is redeemed once, at the kiosk, by nobody signed in.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(row!.status).toBe('redeemed');
    const [claim] = await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id));
    expect(claim).toMatchObject({ stationId: kioskId, accountId: null });
    expect(claim!.bandCodes).toHaveLength(3);

    // The sale names the kiosk's credential, not a person: the till's own redemption.
    const sales = await salesOf(paid.id);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({
      stationId: kioskId,
      boxId: kioskBoxId,
      createdByAccountId: null,
      deviceCredentialId: credentialId,
      salesChannel: 'booking',
      status: 'finalised',
      grossSatang: paid.totalSatang,
      actionId: first.actionId,
    });
    expect(sales[0]!.receiptNumber).toMatch(/^K1-/);
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, sales[0]!.id));
    expect(bands).toHaveLength(3);
    const grants = await ctx.db
      .select()
      .from(walletEntry)
      .where(and(eq(walletEntry.saleId, sales[0]!.id), eq(walletEntry.kind, 'grant')));
    expect(grants.reduce((s, g) => s + g.amountSatang, 0)).toBe(answer.walletCreditSatang);

    // Every job printed through the kiosk box, in this request — and no box
    // command was left behind to print any of them a second time.
    const jobs = await ctx.db.select().from(printJob).where(eq(printJob.stationId, kioskId));
    expect(jobs.length).toBeGreaterThanOrEqual(4);
    expect(jobs.every((j) => j.status === 'printed'), JSON.stringify(jobs.map((j) => [j.kind, j.status]))).toBe(true);
    expect(jobs.filter((j) => j.kind === 'kids_wristband')).toHaveLength(2);
    expect(jobs.filter((j) => j.kind === 'adult_wristband')).toHaveLength(1);
    expect(jobs.some((j) => j.kind === 'credit_voucher'), 'the credit voucher printed too').toBe(true);
    const commands = await ctx.db.select().from(boxCommand).where(eq(boxCommand.boxId, kioskBoxId));
    expect(commands.filter((c) => (c.payload as { printJobId?: string }).printJobId)).toEqual([]);
    expect(printouts(bandPrinterId) - bandsBefore).toBe(3);

    // The session, and the audit row naming the station and the box.
    const [session] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, answer.sessionId));
    expect(session).toMatchObject({
      stationId: kioskId,
      boxId: kioskBoxId,
      deviceCredentialId: credentialId,
      actionId: first.actionId,
      bookingId: paid.id,
      saleId: sales[0]!.id,
      outcome: 'issued',
      reason: null,
    });
    expect([...(session!.bandIds as string[])].sort()).toEqual(bands.map((b) => b.id).sort());
    const redeemed = await auditRows('kiosk.redeem', answer.sessionId);
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]!.actorAccountId).toBeNull();
    expect(redeemed[0]!.actionId).toBe(first.actionId);
    expect(redeemed[0]!.after).toMatchObject({
      stationId: kioskId,
      boxId: kioskBoxId,
      deviceCredentialId: credentialId,
      saleId: sales[0]!.id,
    });
    expect(await auditRows('kiosk.handoff', answer.sessionId)).toHaveLength(0);
    const shared = await auditRows('booking.redeem.sale', paid.id);
    expect(shared[0]!.after).toMatchObject({ surface: 'kiosk', stationId: kioskId, deviceCredentialId: credentialId });
  });

  it('H17 — the same press sent again issues nothing twice and is answered as the first', async () => {
    const bandsPrinted = printouts(bandPrinterId);
    const again = await kioskRedeem(paid.qr, { actionId: first.actionId });
    expect(again.statusCode, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toEqual({ ...first.body, replay: true });
    expect(await salesOf(paid.id)).toHaveLength(1);
    const [only] = await salesOf(paid.id);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, only!.id))).toHaveLength(3);
    expect(printouts(bandPrinterId)).toBe(bandsPrinted);
    expect(await ctx.db.select().from(kioskSession).where(eq(kioskSession.actionId, first.actionId))).toHaveLength(1);
    expect(await auditRows('kiosk.redeem', first.body.sessionId)).toHaveLength(1);
  });

  it('scanning it again shows already-redeemed — when and where, with nobody named', async () => {
    const scan = await kioskRedeem(paid.qr);
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.outcome).toBe('failed');
    expect(scan.body.reason).toBe('BOOKING_ALREADY_REDEEMED');
    expect(scan.body.alreadyRedeemed).toMatchObject({ stationName: 'Kiosk 1' });
    expect(scan.body.alreadyRedeemed!.at).toBeTruthy();
    expect(scan.body.bands).toEqual([]);
    expect(scan.body.desk.required).toBe(true);
    expectNothingPrivate(scan.body);
    expect(await salesOf(paid.id)).toHaveLength(1);
    const aborted = await auditRows('kiosk.abort', scan.body.sessionId);
    expect(aborted).toHaveLength(1);
    expect(aborted[0]!.after).toMatchObject({ stationId: kioskId, boxId: kioskBoxId, reason: 'BOOKING_ALREADY_REDEEMED' });
    expect(aborted[0]!.actionId).toBe(scan.actionId);
  });

  it('a booking that is all drop-off issues nothing and shows the staff desk; the till then redeems it', async () => {
    const dropOff = await bookAndPay([{ packageId: oneHourId, kids: 1, adults: 0, supervision: SUPERVISED_CHILD }], {
      supervised: true,
    });
    const bandsPrinted = printouts(bandPrinterId);
    const scan = await kioskRedeem(dropOff.qr);
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.outcome).toBe('handed_off');
    expect(scan.body.reason).toBe(KIOSK_REASONS.supervised);
    expect(scan.body.bands).toEqual([]);
    expect(scan.body.walletCreditSatang).toBe(0);
    expect(scan.body.desk).toEqual({ required: true, supervisedChildren: 1 });
    expectNothingPrivate(scan.body);
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, dropOff.id));
    expect(row!.status).toBe('paid');
    expect(await salesOf(dropOff.id)).toHaveLength(0);
    expect(printouts(bandPrinterId)).toBe(bandsPrinted);
    const handoff = await auditRows('kiosk.handoff', scan.body.sessionId);
    expect(handoff).toHaveLength(1);
    expect(handoff[0]!.after).toMatchObject({ stationId: kioskId, boxId: kioskBoxId, issued: false, supervisedChildren: 1 });
    expect(await auditRows('kiosk.redeem', scan.body.sessionId)).toHaveLength(0);

    // The desk: reception redeems it at the till, as before.
    const redeemed = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${dropOff.id}/redeem`,
      headers: { cookie: reception },
      payload: {},
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
  });

  it('a mixed booking issues the regular bands and sends the rest to the desk, whose check-in prints at the till', async () => {
    const mixed = await bookAndPay(
      [
        { packageId: twoHoursId, kids: 1, adults: 1 },
        { packageId: oneHourId, kids: 1, adults: 0, supervision: SUPERVISED_CHILD },
      ],
      { supervised: true },
    );
    const scan = await kioskRedeem(mixed.qr);
    expect(scan.statusCode, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.outcome).toBe('handed_off');
    expect(scan.body.reason).toBe(KIOSK_REASONS.supervisedRest);
    expect(scan.body.bands.map((b) => b.kind).sort()).toEqual(['adult', 'kid']);
    expect(scan.body.desk).toEqual({ required: true, supervisedChildren: 1 });
    expectNothingPrivate(scan.body);

    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, mixed.id));
    expect(row!.status).toBe('redeemed');
    const [kioskSale] = await salesOf(mixed.id);
    expect(kioskSale).toMatchObject({ stationId: kioskId, deviceCredentialId: credentialId });
    const checkinId = (row!.payload as { lines: Array<{ supervision?: { checkinId: string } }> }).lines[1]!.supervision!
      .checkinId;
    const [stay] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(stay).toMatchObject({ status: 'registered', saleId: kioskSale!.id, bandId: null });
    expect(stay!.scheduledFor).not.toBeNull();
    // The supervised child got no band here: two bands, the regular line's.
    expect(await ctx.db.select().from(band).where(eq(band.saleId, kioskSale!.id))).toHaveLength(2);
    expect(await auditRows('kiosk.redeem', scan.body.sessionId)).toHaveLength(1);
    const handoff = await auditRows('kiosk.handoff', scan.body.sessionId);
    expect(handoff).toHaveLength(1);
    expect(handoff[0]!.after).toMatchObject({ stationId: kioskId, boxId: kioskBoxId, issued: true, saleId: kioskSale!.id });

    // The desk checks the child in. A session standing at no till is refused,
    // because the band would otherwise print in the kiosk's tray.
    const loose = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: loose },
      payload: { entries: [{ checkinId }] },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.code).toBe('CHECKIN_KIOSK_SALE_NEEDS_TILL');

    const checked = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/check-in-booked',
      headers: { cookie: reception },
      payload: { entries: [{ checkinId }] },
    });
    expect(checked.statusCode, checked.body).toBe(200);
    const [inPark] = await ctx.db.select().from(checkin).where(eq(checkin.id, checkinId));
    expect(inPark!.status).toBe('in_park');
    const [deskJob] = await ctx.db
      .select()
      .from(printJob)
      .where(and(eq(printJob.subjectType, 'band'), eq(printJob.subjectId, inPark!.bandId!)));
    expect(deskJob, 'the supervised child’s band prints at the till the desk stands at').toMatchObject({
      stationId: tillId,
      kind: 'kids_wristband',
    });
  });
});

describe('check 6 — the kiosk printer forced offline aborts the whole redemption', () => {
  let paid: Paid;
  let aborted: Awaited<ReturnType<typeof kioskRedeem>>;

  it('leaves the booking paid and unredeemed, records no hand-off, and sends the guest to the desk', async () => {
    paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    // The Console's simulator, as staff would force it: the kiosk's band printer unreachable.
    const fault = await ctx.app.inject({
      method: 'POST',
      url: `/boxes/${kioskBoxId}/simulate`,
      headers: { cookie: admin },
      payload: { action: 'printer.fault', deviceId: bandPrinterId, fault: 'unreachable' },
    });
    expect(fault.statusCode, fault.body).toBe(200);
    await agent.runPendingCommands();
    const bandsPrinted = printouts(bandPrinterId);
    const receiptsPrinted = printouts(receiptPrinterId);
    const jobsBefore = (await ctx.db.select().from(printJob).where(eq(printJob.stationId, kioskId))).length;

    aborted = await kioskRedeem(paid.qr);
    expect(aborted.statusCode, JSON.stringify(aborted.body)).toBe(200);
    expect(aborted.body.outcome).toBe('failed');
    expect(aborted.body.reason).toBe('PRINTER_UNREACHABLE');
    expect(aborted.body.bands).toEqual([]);
    expect(aborted.body.walletCreditSatang).toBe(0);
    expect(aborted.body.desk.required).toBe(true);
    expectNothingPrivate(aborted.body);

    // H13 — nothing half-redeemed: no claim, no sale, no band, no print job, no paper.
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(row!.status).toBe('paid');
    expect(await ctx.db.select().from(bookingRedemption).where(eq(bookingRedemption.bookingId, paid.id))).toEqual([]);
    expect(await salesOf(paid.id)).toEqual([]);
    expect((await ctx.db.select().from(printJob).where(eq(printJob.stationId, kioskId))).length).toBe(jobsBefore);
    expect(printouts(bandPrinterId)).toBe(bandsPrinted);
    expect(printouts(receiptPrinterId), 'the healthy receipt printer printed nothing either').toBe(receiptsPrinted);
    const [session] = await ctx.db.select().from(kioskSession).where(eq(kioskSession.id, aborted.body.sessionId));
    expect(session).toMatchObject({ outcome: 'failed', reason: 'PRINTER_UNREACHABLE', saleId: null, bookingId: paid.id });
    expect(session!.bandIds).toEqual([]);
    expect(session!.detail).toMatchObject({ stage: 'print', printed: 0, deviceId: bandPrinterId });

    // No hand-off is recorded; the abort is, with the station and the box.
    expect(await auditRows('kiosk.handoff', aborted.body.sessionId)).toEqual([]);
    expect(await auditRows('kiosk.redeem', aborted.body.sessionId)).toEqual([]);
    const abort = await auditRows('kiosk.abort', aborted.body.sessionId);
    expect(abort).toHaveLength(1);
    expect(abort[0]!.after).toMatchObject({
      stationId: kioskId,
      boxId: kioskBoxId,
      deviceCredentialId: credentialId,
      reason: 'PRINTER_UNREACHABLE',
      stage: 'print',
    });

    // The roll of the wire comes back: nothing was queued, so nothing prints late.
    const clear = await ctx.app.inject({
      method: 'POST',
      url: `/boxes/${kioskBoxId}/simulate`,
      headers: { cookie: admin },
      payload: { action: 'printer.clear', deviceId: bandPrinterId },
    });
    expect(clear.statusCode, clear.body).toBe(200);
    await agent.runPendingCommands();
    await agent.printing()!.jobs.tick();
    expect(printouts(bandPrinterId)).toBe(bandsPrinted);
  });

  it('the same press again is answered with the same abort, and redeems nothing', async () => {
    const again = await kioskRedeem(paid.qr, { actionId: aborted.actionId });
    expect(again.statusCode).toBe(200);
    expect(again.body).toEqual({ ...aborted.body, replay: true });
    expect(await salesOf(paid.id)).toEqual([]);
  });

  it('and the till can still redeem it', async () => {
    const redeemed = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${paid.id}/redeem`,
      headers: { cookie: reception },
      payload: {},
    });
    expect(redeemed.statusCode, redeemed.body).toBe(200);
    const sales = await salesOf(paid.id);
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ stationId: tillId, deviceCredentialId: null });
  });

  it('paper out on the receipt printer calls it off before a band comes out', async () => {
    const next = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    agent.printing()!.setFault(receiptPrinterId, 'paper_out');
    const bandsPrinted = printouts(bandPrinterId);
    try {
      const scan = await kioskRedeem(next.qr);
      expect(scan.body.outcome).toBe('failed');
      expect(scan.body.reason).toBe('PRINTER_PAPER_OUT');
      expect(printouts(bandPrinterId), 'the printers were asked first, so no band came out').toBe(bandsPrinted);
      expect(await salesOf(next.id)).toEqual([]);
    } finally {
      agent.printing()!.clearFaults(receiptPrinterId);
    }
  });

  it('a kiosk box switched offline calls it off before anything is claimed', async () => {
    const next = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    await agent.setOffline(true, { reason: 'kiosk offline test' });
    try {
      const scan = await kioskRedeem(next.qr);
      expect(scan.body.outcome).toBe('failed');
      expect(scan.body.reason).toBe(KIOSK_REASONS.boxOffline);
      expect(await salesOf(next.id)).toEqual([]);
      const [row] = await ctx.db.select().from(booking).where(eq(booking.id, next.id));
      expect(row!.status).toBe('paid');
    } finally {
      await agent.setOffline(false);
    }
    // Back online, the same booking redeems at the kiosk.
    const retried = await kioskRedeem(next.qr);
    expect(retried.body.outcome).toBe('issued');
  });
});

describe('what the kiosk refuses by name', () => {
  it('a QR the park did not sign, and a scan that is not a booking QR at all', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const forged = await kioskRedeem(mintBookingQr(paid.id, 'a-key-this-park-never-issued-with-000'));
    expect(forged.body).toMatchObject({ outcome: 'failed', reason: 'BOOKING_QR_SIGNATURE_INVALID', booking: null });
    const junk = await kioskRedeem('NOT-A-BOOKING');
    expect(junk.body).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.notABookingQr });
    const [row] = await ctx.db.select().from(booking).where(eq(booking.id, paid.id));
    expect(row!.status).toBe('paid');
  });

  it('another park’s booking', async () => {
    const elsewhere = await bookAndPay([{ packageId: chalongPackageId, kids: 1, adults: 1 }], {
      branchCode: CHALONG_BRANCH_CODE,
    });
    const scan = await kioskRedeem(elsewhere.qr);
    expect(scan.body).toMatchObject({ outcome: 'failed', reason: KIOSK_REASONS.otherBranch });
    expect(await salesOf(elsewhere.id)).toEqual([]);
  });
});

describe('H16 — the kiosk scope is a device’s, and no person holds it', () => {
  it('is in no role bundle, not in the human vocabulary, and on no role row', async () => {
    expect((PERMISSIONS as readonly string[]).includes(KIOSK_REDEEM_SCOPE)).toBe(false);
    for (const [role, bundle] of Object.entries(ROLE_BUNDLES)) {
      expect((bundle as readonly string[]).includes(KIOSK_REDEEM_SCOPE), role).toBe(false);
    }
    const rows = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(rolePermission)
      .where(eq(rolePermission.permission, KIOSK_REDEEM_SCOPE));
    expect(rows[0]!.n).toBe(0);
  });

  it('the kiosk’s credential reaches no staff route, and a staff session does not reach the kiosk’s', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const asStaff = await ctx.app.inject({
      method: 'POST',
      url: `/bookings/${paid.id}/redeem`,
      headers: { authorization: `Bearer ${KIOSK_SECRET}` },
      payload: { stationId: kioskId },
    });
    expect(asStaff.statusCode).toBe(401);
    const staffAtKiosk = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/station/${kioskId}/kiosk/redeem`,
      headers: { cookie: admin },
      payload: { actionId: newId(), qr: paid.qr },
    });
    expect(staffAtKiosk.statusCode).toBe(401);
    expect(staffAtKiosk.json().error.code).toBe('KIOSK_UNPAIRED');
    expect(await salesOf(paid.id)).toEqual([]);
  });

  it('a credential is answered at its own kiosk only, and not once revoked or without the scope', async () => {
    const paid = await bookAndPay([{ packageId: twoHoursId, kids: 1, adults: 1 }]);
    const otherStation = await kioskRedeem(paid.qr, { stationId: tillId });
    expect(otherStation.statusCode).toBe(403);
    expect(otherStation.body.error?.code).toBe('KIOSK_OTHER_STATION');

    const unscopedSecret = randomBytes(32).toString('hex');
    await ctx.db.insert(deviceCredential).values({
      id: newId(),
      operatorId,
      branchId: centralId,
      kind: 'kiosk',
      stationId: kioskId,
      secretHash: SHA(unscopedSecret),
      scopes: [],
      pairedAt: new Date(),
    });
    expect((await kioskRedeem(paid.qr, { secret: unscopedSecret })).statusCode).toBe(401);

    const revokedSecret = randomBytes(32).toString('hex');
    await ctx.db.insert(deviceCredential).values({
      id: newId(),
      operatorId,
      branchId: centralId,
      kind: 'kiosk',
      stationId: kioskId,
      secretHash: SHA(revokedSecret),
      scopes: [...KIOSK_DEVICE_SCOPES],
      pairedAt: new Date(),
      revokedAt: new Date(),
      revokedReason: 'test',
    });
    expect((await kioskRedeem(paid.qr, { secret: revokedSecret })).statusCode).toBe(401);
    expect(await salesOf(paid.id)).toEqual([]);
  });

  it('a sale names a device only at that device’s kiosk, and only to redeem a booking', async () => {
    const [central] = await ctx.db.select().from(branch).where(eq(branch.id, centralId));
    const deviceActor = { accountId: null, deviceCredentialId: credentialId, operatorId, branchId: central!.id };
    const lines = [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }];
    await expect(
      ctx.db.transaction((tx) => commitSale(tx, deviceActor, { id: newId(), stationId: tillId, lines })),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      ctx.db.transaction((tx) => commitSale(tx, deviceActor, { id: newId(), stationId: kioskId, lines })),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('the database refuses a sale that names nobody', async () => {
    // A sale still tendering (the freeze trigger leaves it writable), rung up at the till.
    const id = newId();
    const rung = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: { id, stationId: tillId, lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }] },
    });
    expect(rung.statusCode, rung.body).toBe(200);
    expect(
      await constraintOf(ctx.db.execute(sql`update pos.sale set created_by_account_id = null where id = ${id}`)),
    ).toBe('sale_actor_check');
  });
});

describe('the kiosk session table', () => {
  it('holds one row per press, and a failed one never names a sale', async () => {
    const sessions = await ctx.db.select().from(kioskSession).where(eq(kioskSession.stationId, kioskId));
    expect(sessions.length).toBeGreaterThan(5);
    for (const s of sessions) {
      if (s.outcome === 'failed') {
        expect(s.saleId).toBeNull();
        expect(s.bandIds).toEqual([]);
        expect(s.reason).toBeTruthy();
      }
      if (s.outcome === 'issued') expect(s.saleId).not.toBeNull();
      expect(s.endedAt).not.toBeNull();
    }
    const failed = sessions.find((s) => s.outcome === 'failed')!;
    const [someSale] = await ctx.db.select({ id: sale.id }).from(sale).where(inArray(sale.stationId, [kioskId])).limit(1);
    expect(
      await constraintOf(
        ctx.db.execute(sql`update pos.kiosk_session set sale_id = ${someSale!.id} where id = ${failed.id}`),
      ),
    ).toBe('kiosk_session_no_sale_check');
  });

  it('is a day of play: the demo reset clears it with the sales and bookings it names', async () => {
    /**
     * NOT THE KIOSK'S: the reset does not know S2-13's stays yet — a stay
     * names its sale and its band (ON DELETE RESTRICT), so a day with one
     * drop-off child redeemed or checked in fails the whole reset, at a till
     * as much as here (reported with this round). This file's stays are taken
     * out of the way first, so what is asserted is the kiosk's half.
     */
    await ctx.db.execute(
      sql`delete from pos.checkin where sale_id in (select id from pos.sale where booking_id is not null)`,
    );
    const counts = await resetDemoData(ctx.db);
    expect(counts.kiosk_session).toBeGreaterThan(5);
    expect(await ctx.db.select().from(kioskSession)).toEqual([]);
    expect(await ctx.db.select().from(sale).where(eq(sale.stationId, kioskId))).toEqual([]);
  });
});
