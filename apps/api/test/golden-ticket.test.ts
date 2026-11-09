import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  branch,
  product,
  redemptionThrottle,
  sale,
  saleDiscount,
  station,
  ticketPackage,
  voucher,
  voucherDefinition,
  voucherMiss,
  voucherSaleItem,
  walletEntry,
} from '@oto/db';
import { syncGoldenTicket } from '@oto/db/seed';
import {
  GIFT_TICKET_MESSAGES,
  GOLDEN_TICKET_DEFINITION_CODE,
  giftTicketChoices,
  giftTicketEntitlement,
  newId,
  saleReceiptDocument,
} from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { salePrintSnapshotOf } from '../src/services/sale-printing';

/**
 * SCRUM-798 — THE GOLDEN TICKET, end to end through the real routes.
 *
 * The owner's definition (9 November 2026): "Gift voucher for full-day entry
 * for one child, with free socks if needed. For kids 5 and up, the parent can
 * choose free drop-off or stay with the child. If the parent stays, print an
 * adult wristband for free entry with no food voucher. For kids under 5, the
 * parent stays and gets the same free entry and adult wristband. Please link
 * the Drop-Off Form only when drop-off is selected for a child aged 5 or
 * older."
 *
 * THE FIXTURES are the seeded park: Reception Till 1 (T1) at Central
 * Floresta. The Golden Ticket items are the park's shop items, created here
 * under their real codes as an administrator created them on staging, and the
 * platform-sync step links them. The Full Day Pass is the seeded package:
 * ฿1,090 a kid at the tourist rate, the adult at ฿350 on a weekday and ฿500
 * at the weekend, and every adult on it earns their ticket back as food
 * credit — which a Golden Ticket's parent must not.
 */

let ctx: TestContext;
let till: string;
let operatorId: string;
let hktId: string;
let t1: typeof station.$inferSelect;
let fullDayHkt: string;
let twoHoursHkt: string;
let goldenHkt: string;

const b = (baht: number): number => Math.round(baht * 100);
const SOCKS = { addOnId: 'a-socks', unitSatang: b(60), label: 'Regular Socks' };
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

async function pick(cookie: string, stationId: string): Promise<void> {
  const res = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/station',
    headers: { cookie },
    payload: { stationId },
  });
  if (res.statusCode !== 200) throw new Error(`station pick failed (${res.statusCode}): ${res.body}`);
}

const lookup = (code: string) =>
  ctx.app.inject({ method: 'GET', url: `/vouchers/lookup?code=${encodeURIComponent(code)}`, headers: { cookie: till } });
const hold = (saleId: string, code: string) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/vouchers`, headers: { cookie: till }, payload: { code } });
const quote = (payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/sales/quote', headers: { cookie: till }, payload });
const commit = (payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url: '/sales', headers: { cookie: till }, payload });
const finalise = (saleId: string) =>
  ctx.app.inject({ method: 'POST', url: `/sales/${saleId}/finalise`, headers: { cookie: till } });
const detail = (saleId: string) =>
  ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: till } });

/** Sell `quantity` Golden Tickets at the till in cash, and answer the close. */
async function sellGolden(quantity = 1) {
  const saleId = newId();
  const rung = await commit({
    id: saleId,
    stationId: t1.id,
    items: [{ id: newId(), productId: goldenHkt, quantity }],
  });
  expect(rung.statusCode, rung.body).toBe(200);
  const closed = await finalise(saleId);
  expect(closed.statusCode, closed.body).toBe(200);
  return { saleId, answer: closed.json() as { issuedVouchers: { id: string; code: string; nameEn: string }[] } };
}

/** A drop-off stay registered for one child of this age, as the Drop-Off form registers it. */
async function registerStay(ageYears: number, service: 'drop_off' | 'nanny' | 'none'): Promise<string> {
  const checkinId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie: till },
    payload: {
      id: newId(),
      branchId: hktId,
      stationId: t1.id,
      guardianName: 'ZZ TEST Parent',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [
        {
          checkinId,
          name: 'ZZ TEST Child',
          ageYears,
          service,
          allergies: null,
          foodRestrictions: null,
          foodProvision: { mode: 'none', paidSatang: 0 },
        },
      ],
    },
  });
  if (res.statusCode !== 200) throw new Error(`stay registration failed (${res.statusCode}): ${res.body}`);
  return checkinId;
}

/** The Golden Ticket's line, the parent staying: one child, one adult, socks on request. */
const parentStays = (socks: number) => ({
  id: newId(),
  packageId: fullDayHkt,
  kids: 1,
  adults: 1,
  socks,
  voucherGift: true,
});

beforeAll(async () => {
  ctx = await createTestContext();
  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central')!;
  hktId = hkt.id;
  operatorId = hkt.operatorId;
  const stations = await ctx.db.select().from(station).where(eq(station.operatorId, operatorId));
  t1 = stations.find((s) => s.branchId === hktId && s.codePrefix === 'T1')!;
  const packages = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.operatorId, operatorId));
  fullDayHkt = packages.find((p) => p.branchId === hktId && p.name === 'Full Day Pass')!.id;
  twoHoursHkt = packages.find((p) => p.branchId === hktId && p.name === '2 Hours Play')!.id;

  // The park's shop item, as an administrator made it on staging.
  const [plush] = await ctx.db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, 'MR-PLUSH'), eq(product.branchId, hktId)));
  goldenHkt = newId();
  await ctx.db.insert(product).values({
    id: goldenHkt,
    operatorId,
    branchId: hktId,
    categoryId: plush!.categoryId,
    kind: 'merch',
    code: 'CF-TK-GOLDEN',
    name: 'Golden Ticket',
    priceSatang: b(1500),
  });

  till = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  await pick(till, t1.id);
}, 180_000);

afterEach(async () => {
  await ctx.db.delete(redemptionThrottle);
  await ctx.db.delete(voucherMiss);
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

describe('the owner’s rule, as one answer', () => {
  it('offers drop-off from 5, and only the parent staying below it', () => {
    expect(giftTicketChoices(4)).toEqual(['parent_stays']);
    expect(giftTicketChoices(5)).toEqual(['parent_stays', 'drop_off']);
    expect(giftTicketChoices(11)).toEqual(['parent_stays', 'drop_off']);
  });

  it('the parent staying: one free adult band, no drop-off, no food credit — at any age', () => {
    for (const age of [2, 4, 5, 9]) {
      expect(giftTicketEntitlement(age, 'parent_stays')).toEqual({
        ok: true,
        choice: 'parent_stays',
        freeKids: 1,
        freeAdultBand: true,
        dropOff: false,
        freeSocks: 1,
        foodCredit: false,
      });
    }
  });

  it('drop-off for a child of 5 or over: the registration, no adult band; refused under 5', () => {
    expect(giftTicketEntitlement(5, 'drop_off')).toMatchObject({ ok: true, freeAdultBand: false, dropOff: true });
    expect(giftTicketEntitlement(4, 'drop_off')).toEqual({
      ok: false,
      reason: 'Drop-off on the Golden Ticket is for a child aged 5 or over — under 5 the parent stays',
    });
    expect(giftTicketEntitlement(null, 'parent_stays')).toEqual({ ok: false, reason: GIFT_TICKET_MESSAGES.noAge });
  });
});

describe('platform-sync lays the voucher type and links the shop items', () => {
  it('a gift-day free ticket on the Full Day Pass, offline refused, linked to the item; a second run writes nothing', async () => {
    // The seed sells no Golden Ticket, so its own sync laid no type: the
    // type comes with the park's item, created above.
    const seeded = await ctx.db
      .select({ id: voucherDefinition.id })
      .from(voucherDefinition)
      .where(and(eq(voucherDefinition.operatorId, operatorId), eq(voucherDefinition.code, GOLDEN_TICKET_DEFINITION_CODE)));
    expect(seeded).toEqual([]);
    const first = await syncGoldenTicket(ctx.db);
    expect(first).toEqual({ definitionsCreated: 1, itemsLinked: 1 });
    const [def] = await ctx.db
      .select()
      .from(voucherDefinition)
      .where(and(eq(voucherDefinition.operatorId, operatorId), eq(voucherDefinition.code, GOLDEN_TICKET_DEFINITION_CODE)));
    expect(def).toMatchObject({
      nameEn: 'Golden Ticket',
      kind: 'free_ticket',
      ticketOffer: 'gift_day',
      offlinePolicy: 'refuse',
      singleUse: true,
      expiryDays: null,
    });
    const [pkg] = await ctx.db.select().from(ticketPackage).where(eq(ticketPackage.id, def!.ticketPackageId!));
    expect(pkg!.name).toBe('Full Day Pass');
    const links = await ctx.db.select().from(voucherSaleItem).where(eq(voucherSaleItem.productId, goldenHkt));
    expect(links).toEqual([expect.objectContaining({ voucherDefinitionId: def!.id, operatorId })]);
    expect(await syncGoldenTicket(ctx.db)).toEqual({ definitionsCreated: 0, itemsLinked: 0 });
  });

  it('a Golden Ticket type with no item linked is still never issued free: off the picker, refused at Issue and as a campaign', async () => {
    const definitionId = newId();
    await ctx.db.insert(voucherDefinition).values({
      id: definitionId,
      operatorId,
      ticketPackageId: fullDayHkt,
      code: `zz-test-gift-unlinked-${definitionId}`,
      nameEn: 'ZZ TEST Unlinked gift',
      kind: 'free_ticket',
      valueType: 'item',
      ticketOffer: 'gift_day',
    });
    expect(await ctx.db.select().from(voucherSaleItem).where(eq(voucherSaleItem.voucherDefinitionId, definitionId))).toEqual([]);

    const picker = await ctx.app.inject({ method: 'GET', url: '/vouchers/issuable', headers: { cookie: till } });
    expect(picker.statusCode, picker.body).toBe(200);
    expect((picker.json() as { definitions: { id: string }[] }).definitions.map((d) => d.id)).not.toContain(definitionId);

    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/vouchers/issue',
      headers: { cookie: till, 'idempotency-key': newId() },
      payload: { definitionId },
    });
    expect(issued.statusCode, issued.body).toBe(409);
    expect(issued.json().error.code).toBe('VOUCHER_SOLD_AS_ITEM');

    const admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
    const campaign = await ctx.app.inject({
      method: 'POST',
      url: '/voucher-campaigns',
      headers: { cookie: admin, 'idempotency-key': newId() },
      payload: { definitionId, branchId: hktId, name: 'ZZ TEST Free gift days', quantity: 2 },
    });
    expect(campaign.statusCode, campaign.body).toBe(409);
    expect(campaign.json().error.code).toBe('VOUCHER_SOLD_AS_ITEM');
    expect(await ctx.db.select().from(voucher).where(eq(voucher.voucherDefinitionId, definitionId))).toEqual([]);
  });
});

describe('selling the item issues one single-use voucher per unit, tied to the sale', () => {
  it('the close answers the code, the row names the sale, the receipt prints it, the audit has its last four', async () => {
    const { saleId, answer } = await sellGolden(1);
    expect(answer.issuedVouchers).toHaveLength(1);
    const issued = answer.issuedVouchers[0]!;
    expect(issued).toMatchObject({ nameEn: 'Golden Ticket', definitionCode: GOLDEN_TICKET_DEFINITION_CODE, status: 'issued' });
    expect(issued.code).toMatch(/^T1[0-9A-Z]{9}$/);
    const [row] = await ctx.db.select().from(voucher).where(eq(voucher.id, issued.id));
    expect(row).toMatchObject({ issuedSaleId: saleId, source: 'manual', status: 'issued', branchId: hktId, saleId: null });

    // History's read shows the same code.
    const read = await detail(saleId);
    expect(read.json().issuedVouchers).toEqual([expect.objectContaining({ id: issued.id, code: issued.code })]);

    // The receipt prints it under the item's line.
    const [saleRow] = await ctx.db.select().from(sale).where(eq(sale.id, saleId));
    const receipt = saleReceiptDocument(await salePrintSnapshotOf(ctx.db, saleRow!));
    const line = receipt.lines.find((l) => l.name === 'Golden Ticket');
    expect(line?.note).toBe(`Voucher code: ${issued.code}`);

    const trail = await ctx.db.select().from(auditLog).where(and(eq(auditLog.entityId, issued.id), eq(auditLog.action, 'voucher.issue')));
    expect(trail).toHaveLength(1);
    expect(trail[0]!.after).toMatchObject({ issuedSaleId: saleId, codeLast4: issued.code.slice(-4) });
    expect(JSON.stringify(trail[0]!.after)).not.toContain(issued.code);
  });

  it('two units, two codes; a replayed close mints nothing more', async () => {
    const { saleId, answer } = await sellGolden(2);
    expect(answer.issuedVouchers).toHaveLength(2);
    expect(new Set(answer.issuedVouchers.map((v) => v.code)).size).toBe(2);
    const again = await finalise(saleId);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().issuedVouchers.map((v: { id: string }) => v.id)).toEqual(answer.issuedVouchers.map((v) => v.id));
    expect(await ctx.db.select().from(voucher).where(eq(voucher.issuedSaleId, saleId))).toHaveLength(2);
  });

  it('is issued by its sale only: not on the Issue picker, refused there and as a campaign', async () => {
    const [def] = await ctx.db
      .select({ id: voucherDefinition.id })
      .from(voucherDefinition)
      .where(and(eq(voucherDefinition.operatorId, operatorId), eq(voucherDefinition.code, GOLDEN_TICKET_DEFINITION_CODE)));
    const picker = await ctx.app.inject({ method: 'GET', url: '/vouchers/issuable', headers: { cookie: till } });
    expect(picker.statusCode, picker.body).toBe(200);
    const listed = (picker.json() as { definitions: { id: string; code: string }[] }).definitions;
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.map((d) => d.code)).not.toContain(GOLDEN_TICKET_DEFINITION_CODE);
    const issued = await ctx.app.inject({
      method: 'POST',
      url: '/vouchers/issue',
      headers: { cookie: till, 'idempotency-key': newId() },
      payload: { definitionId: def!.id },
    });
    expect(issued.statusCode).toBe(409);
    expect(issued.json().error).toMatchObject({
      code: 'VOUCHER_SOLD_AS_ITEM',
      message: 'Golden Ticket is sold as a shop item — selling it issues the voucher',
    });
  });

  it('a sale with no Golden Ticket on it issues nothing', async () => {
    const saleId = newId();
    expect((await commit({ id: saleId, stationId: t1.id, lines: [parentStays(0)] })).statusCode).toBe(200);
    const closed = await finalise(saleId);
    expect(closed.json().issuedVouchers).toEqual([]);
  });
});

describe('redeeming it at the till', () => {
  it('a scan says what it is and consumes nothing', async () => {
    const { answer } = await sellGolden(1);
    const code = answer.issuedVouchers[0]!.code;
    const looked = await lookup(code);
    expect(looked.statusCode, looked.body).toBe(200);
    expect(looked.json().voucher).toMatchObject({
      kind: 'free_ticket',
      prize: { nameEn: 'Golden Ticket' },
      effect: { type: 'gift_ticket', package: { id: fullDayHkt, name: 'Full Day Pass' }, dropOffMinAge: 5 },
      summary: 'Full Day Pass for one child — parent free, or drop-off from age 5; free socks on request; no food credit',
      redeemableOffline: false,
    });
  });

  it('the parent stays: the child, one adult and one pair of socks at ฿0, no food credit, the voucher used with the sale', async () => {
    const { answer } = await sellGolden(1);
    const v = answer.issuedVouchers[0]!;
    const saleId = newId();
    expect((await hold(saleId, v.code)).statusCode).toBe(200);
    const cart = { stationId: t1.id, socks: SOCKS, lines: [parentStays(1)], promoCodes: [v.code] };
    const priced = await quote(cart);
    expect(priced.statusCode, priced.body).toBe(200);
    expect(priced.json().voucher).toMatchObject({ applicable: true, reason: null });
    expect(priced.json().totals.grossSatang).toBe(0);
    expect(priced.json().voucher.amountSatang).toBe(priced.json().totals.subtotalSatang);

    expect((await commit({ id: saleId, ...cart })).statusCode).toBe(200);
    const closed = await finalise(saleId);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id], grants: [] });
    const [row] = await ctx.db.select().from(voucher).where(eq(voucher.id, v.id));
    expect(row).toMatchObject({ status: 'redeemed', saleId, redeemedStationId: t1.id });
    // "Free entry with no food voucher": no wallet was granted on this sale.
    expect(await ctx.db.select().from(walletEntry).where(eq(walletEntry.saleId, saleId))).toEqual([]);
    const [discount] = await ctx.db.select().from(saleDiscount).where(eq(saleDiscount.saleId, saleId));
    expect(discount).toMatchObject({ scope: 'line', targetLineId: cart.lines[0]!.id });
  });

  it('the same line without the voucher pays in full and the adult earns credit — the contrast', async () => {
    const saleId = newId();
    expect((await commit({ id: saleId, stationId: t1.id, lines: [parentStays(0)] })).statusCode).toBe(200);
    const closed = await finalise(saleId);
    expect(closed.json().grants).toHaveLength(1);
  });

  it('a second pair of socks and a second adult are the family’s to pay', async () => {
    const { answer } = await sellGolden(1);
    const v = answer.issuedVouchers[0]!;
    const saleId = newId();
    expect((await hold(saleId, v.code)).statusCode).toBe(200);
    const line = { ...parentStays(2), adults: 2 };
    const priced = await quote({ stationId: t1.id, socks: SOCKS, lines: [line], promoCodes: [v.code] });
    expect(priced.statusCode, priced.body).toBe(200);
    const { totals } = priced.json();
    const plain = await quote({ stationId: t1.id, socks: SOCKS, lines: [{ ...parentStays(1), adults: 1 }] });
    // What is left is one adult and one pair of socks.
    expect(totals.grossSatang).toBe(totals.subtotalSatang - plain.json().totals.subtotalSatang);
    expect(totals.grossSatang).toBeGreaterThan(0);
  });

  it('drop-off for a child of 6: the child and the drop-off fee at ฿0', async () => {
    const { answer } = await sellGolden(1);
    const v = answer.issuedVouchers[0]!;
    const stayId = await registerStay(6, 'drop_off');
    const saleId = newId();
    expect((await hold(saleId, v.code)).statusCode).toBe(200);
    const cart = {
      stationId: t1.id,
      lines: [
        {
          id: stayId,
          packageId: fullDayHkt,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: b(300) },
          voucherGift: true,
        },
      ],
      promoCodes: [v.code],
    };
    const priced = await quote(cart);
    expect(priced.statusCode, priced.body).toBe(200);
    expect(priced.json().voucher).toMatchObject({ applicable: true });
    expect(priced.json().totals).toMatchObject({ subtotalSatang: b(1090) + b(300), grossSatang: 0 });
    expect((await commit({ id: saleId, ...cart })).statusCode).toBe(200);
    const closed = await finalise(saleId);
    expect(closed.json()).toMatchObject({ finalised: true, redeemedVoucherIds: [v.id] });
  });

  it('a stay for a child under 5 is not the gift’s to pay for: the parent stays', async () => {
    const { answer } = await sellGolden(1);
    const v = answer.issuedVouchers[0]!;
    const stayId = await registerStay(4, 'nanny');
    const saleId = newId();
    expect((await hold(saleId, v.code)).statusCode).toBe(200);
    const cart = {
      stationId: t1.id,
      lines: [
        {
          id: stayId,
          packageId: fullDayHkt,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Nanny (8h)', amountSatang: b(1600) },
          voucherGift: true,
        },
      ],
      promoCodes: [v.code],
    };
    const priced = await quote(cart);
    expect(priced.json().voucher).toMatchObject({
      applicable: false,
      reason: 'Drop-off on the Golden Ticket is for a child aged 5 or over — under 5 the parent stays',
    });
    const rung = await commit({ id: saleId, ...cart });
    expect(rung.statusCode).toBe(409);
    expect(rung.json().error.code).toBe('VOUCHER_NOT_APPLICABLE');
  });

  it('a sale with no Full Day Pass child on it is refused by name', async () => {
    const { answer } = await sellGolden(1);
    const v = answer.issuedVouchers[0]!;
    const saleId = newId();
    expect((await hold(saleId, v.code)).statusCode).toBe(200);
    const cart = {
      stationId: t1.id,
      lines: [{ id: newId(), packageId: twoHoursHkt, kids: 1, adults: 1 }],
      promoCodes: [v.code],
    };
    const priced = await quote(cart);
    expect(priced.json().voucher).toMatchObject({
      applicable: false,
      reason: 'The Golden Ticket needs one child on a Full Day Pass ticket on this sale',
    });
    expect((await commit({ id: saleId, ...cart })).json().error.code).toBe('VOUCHER_NOT_APPLICABLE');
  });

  it('used once: a second redemption is refused with who, when and where', async () => {
    const { answer } = await sellGolden(1);
    const v = answer.issuedVouchers[0]!;
    const saleId = newId();
    expect((await hold(saleId, v.code)).statusCode).toBe(200);
    expect((await commit({ id: saleId, stationId: t1.id, lines: [parentStays(0)], promoCodes: [v.code] })).statusCode).toBe(200);
    expect((await finalise(saleId)).statusCode).toBe(200);

    const again = await lookup(v.code);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ALREADY_REDEEMED');
    expect(again.json().error.message).toMatch(/^Already redeemed on .+ at .+ by .+$/);
    const reheld = await hold(newId(), v.code);
    expect(reheld.statusCode).toBe(409);
    expect(reheld.json().error.code).toBe('ALREADY_REDEEMED');
  });

  it('an unknown code is refused in the counter’s words', async () => {
    const res = await lookup('ZZ99');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'INVALID_CODE', message: 'Invalid code' });
  });
});
