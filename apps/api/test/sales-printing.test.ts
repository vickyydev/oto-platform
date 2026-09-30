import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  band,
  bandEvent,
  boxCommand,
  branch,
  child,
  device,
  member,
  paymentAttempt,
  printJob,
  product,
  refund,
  sale,
  station,
  ticketPackage,
  visit,
} from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch } from '@oto/box-agent';
import {
  bandShortCode,
  businessDate,
  newId,
  parseDayStart,
  verifyBandCode,
} from '@oto/shared';
import { DEV_BAND_HMAC_KEY } from '../src/env';
import { provisionVirtualBox } from '../src/services/box';
import { gatewayFor } from '../src/services/payments/gateway';
import {
  BRANCH_MANAGER,
  CHALONG_MANAGER,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';

/**
 * S2-11 (SCRUM-208) — sale printing and signed bands, and History's refunds,
 * voids and reprints, driven through the routes the till and the box call.
 *
 * The prototype sources each block ports are named on the block. Every sale
 * here is rung up at Reception Till 1, which the seed gives a receipt printer,
 * a kitchen printer and both band printers — and NO bar printer, which is what
 * makes the "not printed" case real rather than contrived.
 */

let ctx: TestContext;
let reception: string;
let manager: string;
let chalongManager: string;
let boxCredential = '';
let branchId: string;
let operatorId: string;
let stationId: string;
let timezone: string;
let dayStart: string;
let twoHoursId: string;
let maliId: string;
let jamesId: string;
let maliChildren: { id: string; name: string; allergies: string | null }[];
let cardDeviceId: string;
const productByCode = new Map<string, string>();

const today = (): string => businessDate(new Date(), timezone, parseDayStart(dayStart));

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  manager = await signInAs(ctx.app, BRANCH_MANAGER.phone, BRANCH_MANAGER.password);
  chalongManager = await signInAs(ctx.app, CHALONG_MANAGER.phone, CHALONG_MANAGER.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central')!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;
  timezone = hkt.timezone;
  dayStart = hkt.businessDayStart;

  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;

  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  maliId = members.find((m) => m.phone === '+66811111111')!.id;
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;
  maliChildren = await ctx.db
    .select({ id: child.id, name: child.name, allergies: child.allergies })
    .from(child)
    .where(and(eq(child.memberId, maliId), isNull(child.archivedAt)));

  const devices = await ctx.db.select().from(device).where(eq(device.branchId, branchId));
  cardDeviceId = devices.find((d) => d.label === 'EDC 1')!.id;

  for (const row of await ctx.db.select().from(product).where(eq(product.operatorId, operatorId))) {
    if (row.code) productByCode.set(row.code, row.id);
  }

  // The box, registered by its own agent, so the test can speak as it.
  const transport = injectTransport();
  const agent = createBoxAgent({
    apiBaseUrl: 'http://printing.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-printing-test',
    fetch: async (url, init) => {
      const auth = init.headers?.authorization;
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) boxCredential = auth.slice(7);
      return transport(url, init);
    },
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

// --- Helpers -----------------------------------------------------------------

async function visitFor(memberId: string, childIds: string[]): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/visits',
    headers: { cookie: reception },
    payload: { memberId, childIds },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().id as string;
}

async function commit(payload: Record<string, unknown>) {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie: reception },
    payload: { id: saleId, stationId, ...payload },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().outstandingSatang as number };
}

async function finalise(saleId: string, payload: Record<string, unknown> = {}) {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie: reception },
    payload,
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** A ticket sale, finalised in cash. */
async function ticketSale(opts: { kids: number; adults: number; memberId?: string; visitId?: string }) {
  const { saleId } = await commit({
    memberId: opts.memberId ?? jamesId,
    ...(opts.visitId ? { visitId: opts.visitId } : {}),
    lines: [{ id: newId(), packageId: twoHoursId, kids: opts.kids, adults: opts.adults }],
  });
  const done = await finalise(saleId);
  return { saleId, done };
}

async function documentOf(jobId: string) {
  return ctx.app.inject({
    method: 'GET',
    url: `/box/v1/print-jobs/${jobId}/document`,
    headers: { authorization: `Bearer ${boxCredential}` },
  });
}

async function refundAs(cookie: string, saleId: string, body: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/refunds`, headers: { cookie }, payload: body });
}

async function detail(saleId: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: reception } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function saleRow(id: string) {
  const [row] = await ctx.db.select().from(sale).where(eq(sale.id, id));
  return row!;
}

// --- Printing a ticket sale (printRouting.tsx:ticketPrintJobs) ---------------

describe('a finalised ticket sale prints its receipt and its signed bands', () => {
  it('2 kids and 1 adult: one receipt, two kids bands, one adult band — all queued for the box', async () => {
    const visitId = await visitFor(maliId, maliChildren.map((c) => c.id));
    const { saleId, done } = await ticketSale({ kids: 2, adults: 1, memberId: maliId, visitId });

    expect(done.finalised).toBe(true);
    const kinds = (done.printing.jobs as { kind: string }[]).map((j) => j.kind);
    expect(kinds).toEqual(['receipt', 'kids_wristband', 'kids_wristband', 'adult_wristband']);
    expect((done.printing.jobs as { status: string }[]).every((j) => j.status === 'queued')).toBe(true);
    expect(done.printing.notes).toEqual([]);

    // The bands: signed with the park's key, each code naming its own row.
    const bands = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    expect(bands.map((b) => b.kind).sort()).toEqual(['adult', 'kid', 'kid']);
    for (const b of bands) {
      const verified = verifyBandCode(b.code, DEV_BAND_HMAC_KEY);
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(verified.bandId).toBe(b.id);
        expect(verified.prefix).toBe('T1');
      }
      expect(b.status).toBe('active');
      expect(b.printedJobId).not.toBeNull();
    }
    // The kids bands went to the children the visit named; the adult's names none.
    expect(bands.filter((b) => b.kind === 'kid').map((b) => b.childId).sort()).toEqual(
      maliChildren.map((c) => c.id).sort(),
    );
    expect(bands.find((b) => b.kind === 'adult')!.childId).toBeNull();
    const minted = await ctx.db.select().from(bandEvent);
    expect(minted.filter((e) => bands.some((b) => b.id === e.bandId) && e.kind === 'minted')).toHaveLength(3);
    // No event carries the credential.
    expect(JSON.stringify(minted)).not.toContain(bands[0]!.code);

    // One box command per job, naming the job and nothing a printout says.
    const jobIds = (done.printing.jobs as { id: string }[]).map((j) => j.id);
    const commands = (await ctx.db.select().from(boxCommand).where(eq(boxCommand.kind, 'test_print'))).filter(
      (c) => jobIds.includes((c.payload as { printJobId?: string }).printJobId ?? ''),
    );
    expect(commands).toHaveLength(4);
    for (const c of commands) {
      expect((c.payload as { document?: string }).document).toBe('platform');
      expect(JSON.stringify(c.payload)).not.toContain(bands[0]!.code);
    }

    // The receipt the box fetches: Thai header, VAT rows, member, short band codes.
    const receiptJob = (done.printing.jobs as { id: string; kind: string }[]).find((j) => j.kind === 'receipt')!;
    const doc = await documentOf(receiptJob.id);
    expect(doc.statusCode, doc.body).toBe(200);
    const receipt = doc.json();
    expect(receipt.job.kind).toBe('receipt');
    expect(receipt.job.data.receiptNumber).toBe((await saleRow(saleId)).receiptNumber);
    expect(receipt.job.data.taxInvoiceLines).toContain('ใบกำกับภาษีอย่างย่อ');
    expect(receipt.job.data.vat).toMatch(/^฿/);
    expect(receipt.job.data.taxRows.some((r: { kind: string }) => r.kind === 'tax_included')).toBe(true);
    expect(receipt.job.data.memberNickname).toBe('Mali');
    expect(receipt.job.data.tenders[0]).toMatchObject({ label: 'Cash' });
    expect(receipt.job.data.bandCodes.sort()).toEqual(bands.map((b) => bandShortCode(b.code)).sort());

    // A kids band: the signed code for the QR, the short code under it, the allergy line.
    const kidJob = (done.printing.jobs as { id: string; kind: string; subjectId: string }[]).find(
      (j) => j.kind === 'kids_wristband',
    )!;
    const kid = (await documentOf(kidJob.id)).json();
    const kidBand = bands.find((b) => b.id === kidJob.subjectId)!;
    expect(kid.job).toMatchObject({
      kind: 'kids_wristband',
      data: { bandCode: kidBand.code, shortCode: bandShortCode(kidBand.code) },
    });
    const holder = maliChildren.find((c) => c.id === kidBand.childId)!;
    expect(kid.job.data.holderName).toBe(holder.name);
    if (holder.allergies) expect(kid.job.data.allergy).toContain(holder.allergies);
    expect(kid.job.data.duration).toMatch(/valid until \d{2}:\d{2}$/);
  });

  it('refuses a print document the asking box does not own', async () => {
    const res = await documentOf(newId());
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PRINT_JOB_NOT_FOUND');
  });
});

// --- Printing an F&B order (printRouting.tsx:fnbPrintJobs) --------------------

describe('an F&B order prints one prep ticket per station', () => {
  it('kitchen and bar items: a kitchen ticket with the allergy line, and a bar ticket skipped for want of a printer', async () => {
    const { saleId } = await commit({
      memberId: maliId,
      channel: 'fnb',
      pickupCode: '42',
      note: 'Birthday table',
      items: [
        { id: newId(), productId: productByCode.get('FB-HOTDOG')!, quantity: 1, note: 'no onions' },
        { id: newId(), productId: productByCode.get('FB-JUICE')!, quantity: 2 },
      ],
    });
    const done = await finalise(saleId);
    expect(done.finalised).toBe(true);
    expect((await saleRow(saleId)).status).toBe('finalised');

    const jobs = done.printing.jobs as { id: string; kind: string; status: string; errorCode: string | null }[];
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([
      ['receipt', 'queued'],
      ['kitchen_ticket', 'queued'],
      ['bar_ticket', 'skipped'],
    ]);
    expect(jobs[2]!.errorCode).toBe('NO_DEVICE_FOR_ROLE');
    expect(done.printing.notes).toEqual(['Bar ticket not printed — no bar printer at this station']);
    // A skipped job wakes no box.
    const commandFor = (await ctx.db.select().from(boxCommand)).filter(
      (c) => (c.payload as { printJobId?: string } | null)?.printJobId === jobs[2]!.id,
    );
    expect(commandFor).toHaveLength(0);

    const kitchen = (await documentOf(jobs[1]!.id)).json();
    expect(kitchen.job.kind).toBe('kitchen_ticket');
    expect(kitchen.job.data).toMatchObject({ title: 'Kitchen', orderRef: '42', orderNote: 'Birthday table' });
    expect(kitchen.job.data.lines).toEqual([expect.objectContaining({ qty: 1, note: 'no onions' })]);
    const allergic = maliChildren.find((c) => c.allergies)!;
    expect(kitchen.job.data.allergiesMedical).toContain(allergic.allergies);

    // The receipt carries only the whole-order note.
    const receipt = (await documentOf(jobs[0]!.id)).json();
    expect(receipt.job.data.orderNote).toBe('Birthday table');
  });
});

// --- Refunds (mockApi.ts:recordRefund) ------------------------------------------

describe('refunds — manager approval, the clamp, the status walk, the allocation', () => {
  it('refuses reception without pos:refund:approve, by name', async () => {
    const { saleId } = await ticketSale({ kids: 1, adults: 1 });
    const res = await refundAs(reception, saleId, { mode: 'whole', reason: 'Guest left' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('REFUND_APPROVAL_REQUIRED');
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(0);
  });

  it('walks paid → partially_refunded → refunded, clamps to what is left, and hands cash back', async () => {
    const { saleId } = await ticketSale({ kids: 1, adults: 1 });
    const gross = (await saleRow(saleId)).grossSatang;
    const actionId = newId();

    const first = await refundAs(manager, saleId, {
      mode: 'custom',
      amountSatang: 10_000,
      reason: 'Closed slide',
      actionId,
    });
    expect(first.statusCode, first.body).toBe(200);
    const one = first.json();
    expect(one.refund.number).toMatch(/^T1-R-\d{6}$/);
    expect(one.refund.amountSatang).toBe(10_000);
    expect(one.refund.tenderAllocation).toEqual([
      expect.objectContaining({ route: 'cash', status: 'done', amountSatang: 10_000 }),
    ]);
    expect(one.refundStatus).toBe('partially_refunded');
    expect(one.sale.status).toBe('finalised');
    expect(one.refund.approvedBy.accountId).toBeTruthy();

    // The same press again is the same refund.
    const again = await refundAs(manager, saleId, { mode: 'custom', amountSatang: 10_000, reason: 'Closed slide', actionId });
    expect(again.statusCode).toBe(200);
    expect(again.json().replay).toBe(true);
    expect(await ctx.db.select().from(refund).where(eq(refund.saleId, saleId))).toHaveLength(1);

    // More than is left is clamped, and the answer says so.
    const rest = await refundAs(manager, saleId, { mode: 'custom', amountSatang: gross * 2, reason: 'Guest unwell' });
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json()).toMatchObject({
      clamped: true,
      requestedSatang: gross * 2,
      refundStatus: 'refunded',
      refundableSatang: 0,
      refund: { amountSatang: gross - 10_000 },
    });
    const after = await saleRow(saleId);
    expect(after.status).toBe('refunded');
    expect(after.refundedSatang).toBe(gross);
    expect(after.receiptNumber).not.toBeNull();

    const nothing = await refundAs(manager, saleId, { mode: 'whole', reason: 'Again' });
    expect(nothing.statusCode).toBe(409);
    expect(nothing.json().error.code).toBe('SALE_FULLY_REFUNDED');

    const read = await detail(saleId);
    expect(read.refundStatus).toBe('refunded');
    expect(read.refunds.map((r: { number: string }) => r.number)).toHaveLength(2);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.refund')));
    expect(audits).toHaveLength(2);
  });

  it('refunds chosen lines once, and refuses the same line twice', async () => {
    const { saleId } = await ticketSale({ kids: 1, adults: 1 });
    const lines = (await detail(saleId)).lines as { id: string; kind: string; grossSatang: number }[];
    const kids = lines.find((l) => l.kind === 'kids')!;
    const res = await refundAs(manager, saleId, { mode: 'items', lineIds: [kids.id], reason: 'Child unwell' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refund).toMatchObject({ amountSatang: kids.grossSatang, mode: 'items' });
    expect(res.json().refund.lines).toEqual([expect.objectContaining({ saleLineId: kids.id, restock: false })]);
    const twice = await refundAs(manager, saleId, { mode: 'items', lineIds: [kids.id], reason: 'Again' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error.code).toBe('REFUND_LINE_ALREADY_REFUNDED');
  });

  it('revokes the sale’s bands when a refund empties it, and leaves them on a partial', async () => {
    const visitId = await visitFor(maliId, maliChildren.map((c) => c.id));
    const { saleId } = await ticketSale({ kids: 2, adults: 1, memberId: maliId, visitId });
    const bandIds = (await ctx.db.select().from(band).where(eq(band.saleId, saleId))).map((b) => b.id);
    expect(bandIds).toHaveLength(3);

    // A partial refund leaves the party's bands alone — some of them are still inside.
    const partial = await refundAs(manager, saleId, { mode: 'custom', amountSatang: 5_000, reason: 'Slide closed' });
    expect(partial.statusCode, partial.body).toBe(200);
    const midway = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    expect(midway.every((b) => b.status === 'active')).toBe(true);

    // Refunding the rest empties the sale, and its bands die with it.
    const rest = await refundAs(manager, saleId, { mode: 'whole', reason: 'Guest unwell' });
    expect(rest.statusCode, rest.body).toBe(200);
    expect(rest.json().refundStatus).toBe('refunded');
    const refundId = rest.json().refund.id as string;

    const revoked = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    expect(revoked.every((b) => b.status === 'revoked')).toBe(true);
    // Each band carries a `revoked` event naming the refund, in the refund's own transaction.
    const events = await ctx.db.select().from(bandEvent).where(inArray(bandEvent.bandId, bandIds));
    const revokedEvents = events.filter((e) => e.kind === 'revoked');
    expect(revokedEvents).toHaveLength(3);
    expect(revokedEvents.every((e) => (e.detail as { refundId?: string }).refundId === refundId)).toBe(true);
    // The refund's audit names what it killed; the partial's names nothing.
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, saleId), eq(auditLog.action, 'sale.refund')));
    const revokedLists = audits.map((a) => (a.after as { revokedBandIds?: string[] }).revokedBandIds ?? []);
    expect(revokedLists.some((ids) => [...ids].sort().join() === [...bandIds].sort().join())).toBe(true);
    expect(revokedLists.some((ids) => ids.length === 0)).toBe(true);
  });

  it('voids a whole card tender on its terminal, and falls back to cash when the terminal refuses', async () => {
    for (const outcome of ['approved', 'declined'] as const) {
      const { saleId, owed } = await commit({
        memberId: jamesId,
        lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
      });
      const attemptId = newId();
      await ctx.db.insert(paymentAttempt).values({
        id: attemptId,
        operatorId,
        branchId,
        saleId,
        stationId,
        deviceId: cardDeviceId,
        businessDate: today(),
        method: 'card',
        methodCode: 'card',
        provider: 'simulator',
        status: 'approved',
        amountSatang: owed,
        tranRef: `TR${attemptId.slice(-8)}`,
        approvalCode: 'A1B2C3',
        last4: '4242',
        paidAt: new Date(),
        payload: { tender: 'card' },
      });
      await finalise(saleId);

      const res = await refundAs(manager, saleId, { mode: 'whole', reason: 'Charged twice' });
      expect(res.statusCode, res.body).toBe(200);
      const [slice] = res.json().refund.tenderAllocation;
      expect(slice).toMatchObject({ attemptId, route: 'terminal_void', status: 'pending', amountSatang: owed });
      // The void is queued for the box, keyed on the card's own reference.
      const [voidCommand] = (await ctx.db.select().from(boxCommand).where(eq(boxCommand.actionId, slice.actionId)));
      expect(voidCommand!.kind).toBe('terminal_sale');
      expect(voidCommand!.payload).toMatchObject({ mode: 'void', attemptId, tranRef: `TR${attemptId.slice(-8)}` });

      // The box answers the void on the attempt's result route.
      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/payments/attempts/${attemptId}/result`,
        headers: { authorization: `Bearer ${boxCredential}`, 'x-oto-action-id': slice.actionId },
        payload: {
          stage: 'final',
          outcome,
          approvedSatang: outcome === 'approved' ? owed : null,
          responseCode: outcome === 'approved' ? '00' : '205',
          responseText: outcome === 'approved' ? null : 'Transaction already settle',
        },
      });
      expect(answered.statusCode, answered.body).toBe(200);
      expect(answered.json().phase).toBe('void');
      const [settled] = (await detail(saleId)).refunds[0].tenderAllocation;
      if (outcome === 'approved') {
        expect(settled).toMatchObject({ status: 'done', route: 'terminal_void' });
      } else {
        expect(settled).toMatchObject({ status: 'failed', fallback: 'cash' });
      }
      // The attempt is still the money that was taken.
      const [attempt] = await ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.id, attemptId));
      expect(attempt!.status).toBe('approved');
    }
  });

  it('refunds a gateway QR through QrPayment.refund', async () => {
    const { saleId, owed } = await commit({
      memberId: jamesId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 0 }],
    });
    const invoiceNo = `S211${Date.now().toString().slice(-10)}`;
    const qr = gatewayFor(ctx.app.env).qr as unknown as {
      createQr: (input: Record<string, unknown>) => Promise<unknown>;
      apply: (invoiceNo: string, event: string) => unknown;
    };
    await qr.createQr({ attemptId: newId(), invoiceNo, amountSatang: owed, description: 'test', expiryMinutes: 10 });
    qr.apply(invoiceNo, 'paid');
    await ctx.db.insert(paymentAttempt).values({
      id: newId(),
      operatorId,
      branchId,
      saleId,
      stationId,
      businessDate: today(),
      method: 'qr',
      methodCode: 'promptpay',
      provider: 'simulator',
      status: 'approved',
      amountSatang: owed,
      invoiceNo,
      paidAt: new Date(),
    });
    await finalise(saleId);

    const res = await refundAs(manager, saleId, { mode: 'custom', amountSatang: 5_000, reason: 'Discount missed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().refund.tenderAllocation).toEqual([
      expect.objectContaining({ route: 'gateway_refund', status: 'done', processType: 'V', respCode: '00' }),
    ]);
  });
});

// --- Reprints (TransactionDetail.tsx, mockApi.ts:recordReprint) -----------------

describe('reprints from History', () => {
  it('reprints the receipt as a new job pointing at the original, with an audit row', async () => {
    const { saleId, done } = await ticketSale({ kids: 1, adults: 1 });
    const original = (done.printing.jobs as { id: string; kind: string }[]).find((j) => j.kind === 'receipt')!;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/reprints`,
      headers: { cookie: reception },
      payload: { kind: 'receipt' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const [copy] = res.json().jobs;
    expect(copy).toMatchObject({ kind: 'receipt', reprintOf: original.id, status: 'queued' });
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, copy.id), eq(auditLog.action, 'print_job.reprint')));
    expect(audits).toHaveLength(1);
    // A copy of a copy still points at the original.
    const third = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/reprints`,
      headers: { cookie: reception },
      payload: { kind: 'receipt' },
    });
    expect(third.json().jobs[0].reprintOf).toBe(original.id);
    const doc = (await documentOf(copy.id)).json();
    expect(doc.job.data.title).toBe('Receipt (copy)');
    // The detail shows the jobs, reprints marked.
    const jobs = (await detail(saleId)).printJobs as { id: string; reprintOf: string | null }[];
    expect(jobs.filter((j) => j.reprintOf === original.id)).toHaveLength(2);
  });

  it('names on the sale detail who asked for a reprint', async () => {
    const { saleId } = await ticketSale({ kids: 1, adults: 1 });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/reprints`,
      headers: { cookie: reception },
      payload: { kind: 'receipt' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const copyId = res.json().jobs[0].id as string;
    const jobs = (await detail(saleId)).printJobs as {
      id: string;
      reprintOf: string | null;
      requestedByName: string | null;
    }[];
    const copy = jobs.find((j) => j.id === copyId)!;
    // A reprint carries the account that asked for it, resolved to a display name.
    expect(copy.reprintOf).not.toBeNull();
    expect(copy.requestedByName).toBe('Som (Reception)');
  });

  it('reprints a band group keeping each band’s id and code, and marks the old print replaced', async () => {
    const { saleId, done } = await ticketSale({ kids: 2, adults: 1 });
    const before = await ctx.db.select().from(band).where(and(eq(band.saleId, saleId), eq(band.kind, 'kid')));
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/reprints`,
      headers: { cookie: reception },
      payload: { kind: 'kids_bands', reason: 'Band tore' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().jobs).toHaveLength(2);
    const after = await ctx.db.select().from(band).where(and(eq(band.saleId, saleId), eq(band.kind, 'kid')));
    for (const b of after) {
      const was = before.find((x) => x.id === b.id)!;
      expect(b.code).toBe(was.code);
      expect(b.status).toBe('active');
      expect(b.printedJobId).not.toBe(was.printedJobId);
      const [event] = await ctx.db
        .select()
        .from(bandEvent)
        .where(and(eq(bandEvent.bandId, b.id), eq(bandEvent.kind, 'reprinted')));
      expect(event!.detail).toMatchObject({ replacedPrintJobId: was.printedJobId, printJobId: b.printedJobId, reason: 'Band tore' });
      const [job] = await ctx.db.select().from(printJob).where(eq(printJob.id, b.printedJobId!));
      expect(job!.reprintOf).toBe(was.printedJobId);
    }
    expect((done.printing.jobs as unknown[]).length).toBe(4);
  });

  it('refuses a pick-up ticket reprint for a sale with no food on it', async () => {
    const { saleId } = await ticketSale({ kids: 1, adults: 0 });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/sales/${saleId}/reprints`,
      headers: { cookie: reception },
      payload: { kind: 'prep' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NOTHING_TO_REPRINT');
  });
});

// --- History's search (band and phone) ------------------------------------------

describe('History finds a sale by band code and by phone', () => {
  it('by the signed code, by the short code and by a phone in Thai local format', async () => {
    const visitId = await visitFor(maliId, [maliChildren[0]!.id]);
    const { saleId } = await ticketSale({ kids: 1, adults: 1, memberId: maliId, visitId });
    const [kid] = await ctx.db.select().from(band).where(and(eq(band.saleId, saleId), eq(band.kind, 'kid')));

    for (const q of [`band=${encodeURIComponent(kid!.code)}`, `band=${bandShortCode(kid!.code)}`, 'phone=081-111-1111']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/sales/lookup?${q}`, headers: { cookie: reception } });
      expect(res.statusCode, `${q}: ${res.body}`).toBe(200);
      expect(res.json().sales.map((s: { id: string }) => s.id), q).toContain(saleId);
    }
  });

  it('refuses a search naming both a band and a phone, and a branch the caller does not hold', async () => {
    const both = await ctx.app.inject({
      method: 'GET',
      url: '/sales/lookup?band=T1-AAAAAA&phone=0811111111',
      headers: { cookie: reception },
    });
    expect(both.statusCode).toBe(400);
    const elsewhere = await ctx.app.inject({
      method: 'GET',
      url: `/sales/lookup?phone=0811111111&branchId=${branchId}`,
      headers: { cookie: chalongManager },
    });
    expect(elsewhere.statusCode).toBe(403);
  });
});

// --- The sale stores its visit (SCRUM-208 contract) -----------------------------

describe('a sale carries its membership visit', () => {
  it('refuses a visit rung up at another park, before anything is written', async () => {
    const [chalong] = await ctx.db.select().from(branch).where(eq(branch.code, 'robinson-chalong'));
    const foreignVisitId = newId();
    await ctx.db.insert(visit).values({
      id: foreignVisitId,
      operatorId,
      branchId: chalong!.id,
      visitDate: today(),
      status: 'draft',
    });
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/sales',
      headers: { cookie: reception },
      payload: {
        id: newId(),
        stationId,
        memberId: jamesId,
        visitId: foreignVisitId,
        lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
      },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toContain('another branch');
    // Nothing was written under that visit.
    expect(await ctx.db.select().from(sale).where(eq(sale.visitId, foreignVisitId))).toHaveLength(0);
  });
});
