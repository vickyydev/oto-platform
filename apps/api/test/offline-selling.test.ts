import { generateKeyPairSync } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  band,
  bandEvent,
  child,
  employee,
  member,
  paymentAttempt,
  printJob,
  sale,
  saleExtension,
  saleExtensionBand,
  station,
  syncAnomaly,
  ticketPackage,
} from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import {
  newId,
  saleBandDocument,
  saleReceiptDocument,
  type BridgeSaleAnswer,
} from '@oto/shared';
import {
  RECEPTION,
  boxBySlot,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { salePrintSnapshotOf } from '../src/services/sale-printing';
import { linkedAgent, type CuttableLink } from './box-link';

/**
 * SELLING OFFLINE — offline plan Round 4, the acceptance (SCRUM-269; SCRUM-206's
 * offline half).
 *
 * "A forced-offline virtual station sells with cash and the simulated terminal
 * and prints from the box queue; after reconnect each sale shows once in
 * History under its printed number."
 *
 * The till reaches its box the way a staging till does: through the api's
 * mount of the station bridge, behind the platform session, with its station
 * forced offline so the platform's own trading routes refuse. The box is the
 * virtual box's agent (`createBoxAgent`, the code a Pi runs), on the seed's
 * simulated printers and terminals, with its link to the platform cut. Then
 * the link comes back and the ledger is read.
 */

const keys = generateKeyPairSync('ed25519');

let ctx: TestContext;
let cookie: string;
let tillId: string;
let branchId: string;
let packageId: string;
let maliId: string;
let children: string[];
let staffName: string;
let agent: BoxAgent;
const link: CuttableLink = { cut: false };

async function call(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie, ...headers },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  return { statusCode: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
}

const bridge = (rest: string) => `/box/v1/station/${tillId}/${rest}`;

async function onBox(type: string, payload: Record<string, unknown>): Promise<BridgeSaleAnswer> {
  const res = await call('POST', bridge('intents'), {
    type,
    lastSeenSequence: 0,
    payload,
    actionId: `sell-${newId().slice(-12)}`,
  });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return res.body.result as unknown as BridgeSaleAnswer;
}

const goOffline = async (): Promise<void> => {
  await agent.setOffline(true, { reason: 'offline selling, round 4' });
  link.cut = true;
};
const goOnline = async (): Promise<void> => {
  link.cut = false;
  await agent.setOffline(false);
  // Everything queued goes up, in order, until the queue is empty.
  for (let i = 0; i < 10; i += 1) {
    const outcome = await agent.outbox()!.flush();
    if (outcome.state !== 'pushed') break;
  }
};

/** Two kids and an adult on two hours, for Mali — a cart as the till builds it. */
function familyCart() {
  return { memberId: maliId, lines: [{ id: newId(), packageId, kids: 2, adults: 1 }] };
}

async function platformTotal(cart: Record<string, unknown>): Promise<number> {
  const res = await call('POST', '/sales/quote', { stationId: tillId, ...cart });
  expect(res.statusCode, JSON.stringify(res.body)).toBe(200);
  return (res.body.quote as { totals: { grossSatang: number } }).totals.grossSatang;
}

interface CashTender {
  actionId: string;
  method: string;
  kind: string;
  amountSatang: number;
  tenderedSatang: number;
  changeSatang: number;
}

function saleBody(cart: Record<string, unknown>, total: number, tender: CashTender | null) {
  return {
    saleId: newId(),
    actionId: `pay-${newId().slice(-12)}`,
    staffName,
    visitChildIds: children,
    cart: { ...cart, expectedTotalSatang: total },
    tender,
  };
}

const cash = (total: number): CashTender => ({
  actionId: `cash-${newId().slice(-12)}`,
  method: 'cash',
  kind: 'cash',
  amountSatang: total,
  tenderedSatang: total + 10_000,
  changeSatang: 10_000,
});

const saleRow = async (id: string) => (await ctx.db.select().from(sale).where(eq(sale.id, id)))[0];
const attemptsOf = (id: string) => ctx.db.select().from(paymentAttempt).where(eq(paymentAttempt.saleId, id));

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      OPS_TEST_CONTROLS: 'true',
      STAFF_TOKEN_PRIVATE_KEY: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
  });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const box1 = await boxBySlot(ctx.db, 'virtual-1');
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.boxId, box1.id), eq(station.name, 'Reception Till 1')));
  tillId = till!.id;
  branchId = till!.branchId;
  expect((await call('PUT', '/me/session/station', { stationId: tillId })).statusCode).toBe(200);
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  packageId = pkg!.id;
  const [mali] = await ctx.db.select().from(member).where(eq(member.phone, '+66811111111'));
  maliId = mali!.id;
  children = (
    await ctx.db.select({ id: child.id }).from(child).where(eq(child.memberId, maliId)).orderBy(asc(child.name))
  ).map((c) => c.id);
  const [staff] = await ctx.db
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.phone, RECEPTION.phone));
  staffName = staff?.nickname ?? staff?.name ?? 'Reception';
  agent = linkedAgent(ctx, box1.id, 'selling-box', link, { devices: true });
  expect(await agent.ensureRegistered()).toBe(true);
  await agent.syncConfig();
  await agent.syncCache();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent?.stop();
  if (agent) detachInProcessBox(agent);
  await ctx.close();
  await teardownAll();
});

describe('a forced-offline virtual station sells, prints from the box queue, and each sale lands once under its printed number (plan §4, Round 4)', () => {
  const taken: Array<{ id: string; receipt: string; kind: string }> = [];

  it('takes cash, a card and the PAX QR on the box with the platform refusing', async () => {
    const cart = familyCart();
    const total = await platformTotal(cart);
    const mark = (await agent.sales()!.receiptMark(tillId))!.highWaterMark;
    await goOffline();
    // The platform's own trading route refuses: the till moves to its box.
    const refused = await call('POST', '/sales/quote', { stationId: tillId, ...cart });
    expect(refused.statusCode).toBe(503);

    const inCash = await onBox('sale.finalise', saleBody(cart, total, cash(total)));
    expect(inCash.finalised).toBe(true);
    expect(inCash.sale.receiptNumber).toBe(`T1-${String(mark + 1).padStart(6, '0')}`);
    expect(inCash.attempt?.status).toBe('approved');
    expect(inCash.printing.jobs.find((j) => j.kind === 'receipt')?.status).toBe('printed');
    expect(inCash.printing.jobs.filter((j) => j.kind === 'kids_wristband')).toHaveLength(2);
    expect(inCash.printing.jobs.filter((j) => j.kind === 'adult_wristband')).toHaveLength(1);
    expect(inCash.drawer).not.toBe('not_asked');
    taken.push({ id: inCash.sale.id, receipt: inCash.sale.receiptNumber!, kind: 'cash' });

    const cardCart = familyCart();
    const byCard = await onBox('payment.start', {
      ...saleBody(cardCart, total, null),
      tender: { actionId: `card-${newId().slice(-12)}`, method: 'card', kind: 'card', amountSatang: total },
    });
    expect(byCard.finalised).toBe(true);
    expect(byCard.attempt?.status).toBe('approved');
    expect(byCard.sale.receiptNumber).toBe(`T1-${String(mark + 2).padStart(6, '0')}`);
    taken.push({ id: byCard.sale.id, receipt: byCard.sale.receiptNumber!, kind: 'card' });

    const qrCart = familyCart();
    const byQr = await onBox('payment.start', {
      ...saleBody(qrCart, total, null),
      tender: { actionId: `qr-${newId().slice(-12)}`, method: 'promptpay', kind: 'qr', amountSatang: total },
    });
    expect(byQr.finalised).toBe(true);
    expect(byQr.attempt?.status).toBe('awaiting_settlement');
    taken.push({ id: byQr.sale.id, receipt: byQr.sale.receiptNumber!, kind: 'qr' });

    // Nothing has reached the ledger: the link is down.
    for (const s of taken) expect(await saleRow(s.id)).toBeUndefined();
    const status = await call('GET', bridge('status'));
    expect(status.body.outboxDepth).toBeGreaterThanOrEqual(3);
  });

  it('the link comes back: each sale once, finalised under its printed number, in History', async () => {
    await goOnline();
    const listed = await call('GET', `/sales?branchId=${branchId}&limit=200`);
    expect(listed.statusCode).toBe(200);
    const inHistory = listed.body.sales as Array<{ id: string; receiptNumber: string | null }>;
    for (const s of taken) {
      const row = await saleRow(s.id);
      expect(row!.status).toBe('finalised');
      expect(row!.origin).toBe('box');
      expect(row!.receiptNumber).toBe(s.receipt);
      expect(inHistory.filter((h) => h.id === s.id)).toEqual([
        expect.objectContaining({ receiptNumber: s.receipt }),
      ]);
      const attempts = await attemptsOf(s.id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.offline).toBe(true);
    }
    const [card] = await attemptsOf(taken[1]!.id);
    expect(card!.approvalCode).toBeTruthy();
    const [qr] = await attemptsOf(taken[2]!.id);
    expect(qr!.status).toBe('awaiting_settlement');
  });

  it('the bands the box minted are the ledger’s, and the paper is the same from either end', async () => {
    const cashSale = taken[0]!;
    const logged = await agent.sales()!.recorded(cashSale.id);
    const rows = await ctx.db.select().from(band).where(eq(band.saleId, cashSale.id)).orderBy(asc(band.createdAt));
    expect(rows.map((b) => b.id)).toEqual(logged!.bands.map((b) => b.id));
    expect(rows.map((b) => b.code)).toEqual(logged!.bands.map((b) => b.code));
    expect(rows.filter((b) => b.kind === 'kid').map((b) => b.childId)).toEqual(children);
    const events = await ctx.db.select().from(bandEvent).where(eq(bandEvent.bandId, rows[0]!.id));
    expect(events[0]!.detail).toMatchObject({ origin: 'box' });

    // Same snapshot in, same document out: the receipt and every band the box
    // printed are what the platform would print from its own rows today.
    const platform = await salePrintSnapshotOf(ctx.db, (await saleRow(cashSale.id))!);
    expect(saleReceiptDocument(platform)).toEqual(saleReceiptDocument(logged!.snapshot!));
    for (const b of platform.bands) {
      const boxBand = logged!.snapshot!.bands.find((x) => x.id === b.id)!;
      expect(saleBandDocument(platform, b)).toEqual(saleBandDocument(logged!.snapshot!, boxBand));
    }
  });

  it('a replay twice gives one sale: the box resends its batch and the till resends its press', async () => {
    const requeued = await agent.outbox()!.replayLastBatch(50);
    expect(requeued).toBeGreaterThan(0);
    await goOnline();
    for (const s of taken) {
      expect(await ctx.db.select().from(sale).where(eq(sale.id, s.id))).toHaveLength(1);
      expect(await attemptsOf(s.id)).toHaveLength(1);
    }
    // The till pressing again answers from the box's log and queues nothing.
    const depth = (await agent.outbox()!.depth()).queued;
    const logged = await agent.sales()!.recorded(taken[0]!.id);
    const memo = logged!.memo as { view: { totals: { grossSatang: number } } };
    const again = await onBox('sale.finalise', {
      saleId: taken[0]!.id,
      actionId: 'pay-again',
      cart: { ...familyCart(), expectedTotalSatang: memo.view.totals.grossSatang },
      tender: cash(memo.view.totals.grossSatang),
    });
    expect(again.replay).toBe(true);
    expect(again.sale.receiptNumber).toBe(taken[0]!.receipt);
    expect((await agent.outbox()!.depth()).queued).toBe(depth);
  });
});

describe('a ฿0 comp taken offline replays (S2-09a; plan §2.6)', () => {
  it('closes on the box with no tender, and files under its printed number with its bands', async () => {
    const cart = {
      ...familyCart(),
      manualDiscounts: [{ id: newId(), scope: 'order', type: 'comp', value: 0, reason: 'Staff / family' }],
    };
    await goOffline();
    const comp = await onBox('sale.finalise', saleBody(cart, 0, null));
    expect(comp.finalised).toBe(true);
    expect(comp.attempt).toBeNull();
    await goOnline();
    const row = await saleRow(comp.sale.id);
    expect(row!.status).toBe('finalised');
    expect(row!.grossSatang).toBe(0);
    expect(row!.receiptNumber).toBe(comp.sale.receiptNumber);
    expect(await attemptsOf(comp.sale.id)).toHaveLength(0);
    expect(await ctx.db.select().from(band).where(eq(band.saleId, comp.sale.id))).toHaveLength(3);
  });
});

describe('a lane switch mid-sale converges (OD-1)', () => {
  it('rung up on the platform, paid on the box: one sale, closed under the box’s number', async () => {
    await agent.syncCache();
    const cart = familyCart();
    const total = await platformTotal(cart);
    const body = saleBody(cart, total, cash(total));
    const committed = await call(
      'POST',
      '/sales',
      { id: body.saleId, actionId: body.actionId, stationId: tillId, ...body.cart, finalise: false },
      { 'idempotency-key': `sale:${body.saleId}`, 'x-oto-action-id': body.actionId },
    );
    expect(committed.statusCode, JSON.stringify(committed.body)).toBe(200);
    expect((await saleRow(body.saleId))!.status).toBe('tendering');

    await goOffline();
    const paid = await onBox('sale.finalise', body);
    expect(paid.finalised).toBe(true);
    await goOnline();
    const rows = await ctx.db.select().from(sale).where(eq(sale.id, body.saleId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('finalised');
    expect(rows[0]!.receiptNumber).toBe(paid.sale.receiptNumber);
    expect(await attemptsOf(body.saleId)).toHaveLength(1);
  });

  it.each(['adult', 'kid'] as const)('closed on the platform with its answer lost: %s extension survives replacement without another charge', async (selectedKind) => {
    const cart = familyCart();
    const total = await platformTotal(cart);
    const body = saleBody(cart, total, cash(total));
    const committed = await call(
      'POST',
      '/sales',
      { id: body.saleId, actionId: body.actionId, stationId: tillId, ...body.cart, finalise: false },
      { 'idempotency-key': `sale:${body.saleId}`, 'x-oto-action-id': body.actionId },
    );
    expect(committed.statusCode, JSON.stringify(committed.body)).toBe(200);
    // The platform closes it, numbers it, bands it and queues its paper for
    // the box — and the till never hears the answer.
    const tender = body.tender!;
    const closed = await call(
      'POST',
      `/sales/${body.saleId}/finalise`,
      {
        actionId: tender.actionId,
        method: 'cash',
        kind: 'cash',
        amountSatang: total,
        tenderedSatang: total,
        changeSatang: 0,
        tender: { method: 'cash', kind: 'cash', amountSatang: total, tenderedSatang: total, changeSatang: 0 },
      },
      { 'idempotency-key': `fin:${body.saleId}`, 'x-oto-action-id': tender.actionId },
    );
    expect(closed.statusCode, JSON.stringify(closed.body)).toBe(200);
    const platformNumber = (await saleRow(body.saleId))!.receiptNumber!;
    const platformBands = await ctx.db.select().from(band).where(eq(band.saleId, body.saleId));
    expect(platformBands.length).toBeGreaterThan(0);
    const platformJobs = await ctx.db.select().from(printJob).where(eq(printJob.actionId, tender.actionId));
    expect(platformJobs.length).toBeGreaterThan(0);

    // SCRUM-495 review reproduction: the platform receipt is already visible
    // before the box delivers its replacement-band fact.
    const appliedExtension = await call('POST', `/sales/${body.saleId}/extensions`, {
      actionId: newId(), stationId: tillId, optionId: 'ext-30',
      selection: { mode: 'bands', bandIds: [platformBands.find((entry) => entry.kind === 'adult')!.id, platformBands.find((entry) => entry.kind === 'kid')!.id] },
    });
    expect(appliedExtension.statusCode).toBe(200);
    const appliedChargeId = (appliedExtension.body.sale as { id: string }).id;
    expect((await call('POST', `/sales/${appliedChargeId}/finalise`, { actionId: newId(), method: 'cash' })).statusCode).toBe(200);
    const extension = await call('POST', `/sales/${body.saleId}/extensions`, {
      actionId: newId(), stationId: tillId, optionId: 'ext-30',
      selection: { mode: 'bands', bandIds: [platformBands.find((entry) => entry.kind === selectedKind)!.id] },
    });
    expect(extension.statusCode, JSON.stringify(extension.body)).toBe(200);
    const chargeId = (extension.body.sale as { id: string }).id;
    const partial = await call('POST', `/sales/${chargeId}/finalise`, {
      actionId: newId(), method: 'cash', amountSatang: 3000,
    });
    expect(partial.statusCode, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body.finalised).toBe(false);

    // The till switches lanes and pays again on the box — the same press.
    await goOffline();
    const onTheBox = await onBox('sale.finalise', body);
    expect(onTheBox.finalised).toBe(true);
    const boxNumber = onTheBox.sale.receiptNumber!;

    // Back online: the box collects the platform's print commands for a sale
    // it has already printed, and refuses them.
    await goOnline();
    for (let drain = 0; drain < 6; drain += 1) await agent.runPendingCommands();
    const jobs = await ctx.db.select().from(printJob).where(eq(printJob.actionId, tender.actionId));
    expect(jobs.length).toBe(platformJobs.length);
    for (const job of jobs) {
      expect(job.status, `${job.kind}`).toBe('skipped');
      expect(job.errorCode).toBe('PRINTED_ON_BOX');
    }

    // One sale, one payment, the family's bands the box's, the platform's replaced.
    expect(await ctx.db.select().from(sale).where(eq(sale.id, body.saleId))).toHaveLength(1);
    expect(await attemptsOf(body.saleId)).toHaveLength(1);
    const after = await ctx.db.select().from(band).where(eq(band.saleId, body.saleId));
    const boxBands = (await agent.sales()!.recorded(body.saleId))!.bands.map((b) => b.id);
    expect(after.filter((b) => b.status === 'active').map((b) => b.id).sort()).toEqual([...boxBands].sort());
    expect(after.filter((b) => platformBands.some((p) => p.id === b.id)).every((b) => b.status === 'replaced')).toBe(true);

    const appliedId = (appliedExtension.body.extension as { id: string }).id;
    const [paidBeforeRepair] = await ctx.db.select().from(saleExtension).where(eq(saleExtension.id, appliedId));
    const activeAdult = after.find((entry) => entry.status === 'active' && entry.kind === 'adult')!.id;
    const activeKids = after.filter((entry) => entry.status === 'active' && entry.kind === 'kid').map((entry) => entry.id);
    const paidRepairPath = `/sales/${body.saleId}/extensions/${appliedId}/bands`;
    const paidRepair = { actionId: newId(), stationId: tillId, bandIds: [activeAdult, activeKids[0]!] };
    const changedActive = await call('POST', paidRepairPath, { ...paidRepair, bandIds: activeKids });
    expect(changedActive.statusCode).toBe(409);
    expect(changedActive.body.error).toMatchObject({ code: 'EXTENSION_ACTIVE_BAND_FIXED' });
    const paidFixed = await call('POST', paidRepairPath, paidRepair);
    expect(paidFixed.statusCode, JSON.stringify(paidFixed.body)).toBe(200);
    expect((await call('POST', paidRepairPath, paidRepair)).body.replay).toBe(true);
    const [paidAfterRepair] = await ctx.db.select().from(saleExtension).where(eq(saleExtension.id, appliedId));
    expect(paidAfterRepair!.appliedAt).toEqual(paidBeforeRepair!.appliedAt);
    expect(paidAfterRepair!.amountSatang).toBe(paidBeforeRepair!.amountSatang);
    const extensionId = (extension.body.extension as { id: string }).id;
    const selectionRead = await call('GET', `/sales/${body.saleId}/extensions`);
    const selectedRead = (selectionRead.body.extensions as Array<{ id: string; needsReselection: boolean }>).find((entry) => entry.id === extensionId)!;
    expect(selectedRead.needsReselection).toBe(selectedKind === 'kid');
    if (selectedKind === 'kid') {
      const refused = await call('POST', `/sales/${chargeId}/finalise`, { actionId: newId(), method: 'cash' });
      expect(refused.statusCode).toBe(409);
      expect(refused.body.error).toMatchObject({ code: 'EXTENSION_BAND_UNAVAILABLE' });
      expect(await attemptsOf(chargeId)).toHaveLength(1);
      const replacementId = after.find((entry) => entry.status === 'active' && entry.kind === 'kid')!.id;
      const repair = { actionId: newId(), stationId: tillId, bandIds: [replacementId] };
      const path = `/sales/${body.saleId}/extensions/${extensionId}/bands`;
      expect((await call('POST', path, { ...repair, amountSatang: 1 })).statusCode).toBe(400);
      expect((await call('POST', path, { ...repair, bandIds: [newId()] })).statusCode).toBe(409);
      const repaired = await call('POST', path, repair);
      expect(repaired.statusCode, JSON.stringify(repaired.body)).toBe(200);
      expect((await call('POST', path, repair)).body.replay).toBe(true);
      expect((await call('POST', path, { ...repair, bandIds: [newId()] })).statusCode).toBe(409);
    }
    const finished = await call('POST', `/sales/${chargeId}/finalise`, { actionId: newId(), method: 'cash' });
    expect(finished.statusCode, JSON.stringify(finished.body)).toBe(200);
    expect(finished.body.finalised).toBe(true);
    const entries = await ctx.db.select().from(saleExtension).where(eq(saleExtension.sourceSaleId, body.saleId));
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.status).toBe('applied');
      const expectedIds = entry.id === extensionId
        ? [platformBands.find((value) => value.kind === selectedKind)!.id]
        : [platformBands.find((value) => value.kind === 'adult')!.id, platformBands.find((value) => value.kind === 'kid')!.id].sort();
      expect(entry.selection).toEqual({ mode: 'bands', bandIds: expectedIds });
      const selected = await ctx.db.select().from(saleExtensionBand).where(eq(saleExtensionBand.extensionId, entry.id));
      expect(selected).toHaveLength(expectedIds.length);
      for (const current of selected) {
        expect(boxBands).toContain(current.bandId);
        expect(current.minutesAdded).toBe(30);
      }
    }
    expect(await attemptsOf(chargeId)).toHaveLength(2);
    expect(await attemptsOf(appliedChargeId)).toHaveLength(1);
    const counted = await call('POST', `/sales/${body.saleId}/extensions`, {
      actionId: newId(), stationId: tillId, optionId: 'ext-30', selection: { mode: 'count', braceletCount: boxBands.length },
    });
    expect(counted.statusCode, JSON.stringify(counted.body)).toBe(200);
    const countId = (counted.body.sale as { id: string }).id;
    expect((await call('POST', `/sales/${countId}/void`, { reason: 'Fixture count cleared' })).statusCode).toBe(200);
    const row = await saleRow(body.saleId);
    expect(row!.receiptNumber).toBe(platformNumber);
    if (boxNumber !== platformNumber) {
      const anomalies = await ctx.db.select().from(syncAnomaly).where(eq(syncAnomaly.kind, 'receipt_collision'));
      expect(anomalies.map((a) => a.detail)).toContainEqual(
        expect.objectContaining({ boxReceiptNumber: boxNumber, receiptNumber: platformNumber }),
      );
    }
  });
});

describe('the terminal on the box lane (OD-3)', () => {
  it('a GHL card with no answer is confirmed by staff with the typed code, and filed for end-of-day', async () => {
    const card = (
      agent.config()!.stations.find((s) => s.id === tillId)!.devices.find((d) => d.role === 'card_terminal')
    )!;
    agent.terminal()!.setOutcome(card.id, 'no_response');
    try {
      const cart = familyCart();
      const total = await platformTotal(cart);
      await goOffline();
      const body = {
        ...saleBody(cart, total, null),
        tender: { actionId: `card-${newId().slice(-12)}`, method: 'card', kind: 'card', amountSatang: total },
      };
      const held = await onBox('payment.start', body);
      expect(held.finalised).toBe(false);
      expect(held.attempt?.status).toBe('awaiting_staff_confirmation');
      const confirmed = await onBox('payment.confirm', {
        saleId: body.saleId,
        attemptId: held.attempt!.id,
        took: true,
        approvalCode: '778899',
      });
      expect(confirmed.finalised).toBe(true);
      await goOnline();
      const [attempt] = await attemptsOf(body.saleId);
      expect(attempt!.approvalCode).toBe('778899');
      expect(attempt!.staffConfirmedByAccountId).toBeTruthy();
      expect((attempt!.payload as { staffConfirmation?: unknown }).staffConfirmation).toMatchObject({
        offline: true,
        reconcile: 'end_of_day',
      });
    } finally {
      agent.terminal()!.setOutcome(card.id, 'approved');
    }
  });
});
