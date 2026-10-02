import { eq, inArray, isNotNull, ne, notInArray, or, sql } from 'drizzle-orm';
import {
  attendee,
  auditLog,
  band,
  bandEvent,
  booking,
  bookingRedemption,
  cashMovement,
  cashSession,
  child,
  endOfDay,
  eodCorrection,
  member,
  memberAlias,
  memberTierVerification,
  paymentAttempt,
  paymentNotification,
  purchaseOrder,
  purchaseOrderLine,
  reconLine,
  refund,
  sale,
  saleDiscount,
  saleLine,
  saleTierClaim,
  settlementBatch,
  settlementLine,
  stockAttention,
  stockMovement,
  stockTake,
  stockTakeLine,
  visit,
  visitChild,
  voucher,
  wallet,
  walletEntry,
  walletKey,
} from '@oto/db';
import type { Exec, Tx } from './tx';

/**
 * "Reset demo data" — S2-01c.
 *
 * The park's team are meant to play with the staging deployment: ring sales
 * up, book, check children in, make a mess. What they must never lose doing
 * it is the way back in and the prices they configured. So the reset
 * separates the two by OWNER rather than by age:
 *
 *   facts         what a day of play produces — visits, bookings, sales,
 *                 payments, wallets, bands, stock counts, and the members
 *                 walked up to the counter during the session
 *   configuration what someone sat down and set up — operators, branches,
 *                 departments, employees, accounts, roles and assignments,
 *                 tiers, packages, holidays, tax, products, stations
 *
 * Only the first list is deleted, and only on a deployment that opted in
 * (OPS_TEST_CONTROLS). See routes/ops.ts for the gate.
 */

/**
 * Typed by the caller, sent in the request body as well as shown in the UI,
 * so the endpoint cannot be triggered by a stray curl or a mis-click.
 */
export const DEMO_RESET_CONFIRMATION = 'RESET DEMO DATA';

/**
 * A member the SEED owns, told apart by `created_via`.
 *
 * The seed writes its six demo families as `import`; the till writes `pos`
 * and the booking site writes `booking`. That is the distinction the column
 * already exists to make, so the reset needs no marker of its own — and
 * because the seed only ever ADDS a family it does not find, `pnpm db:seed`
 * still restores the demo set if one of these rows is ever lost.
 *
 * Keeping them is what the QA scripts depend on: +66811111111 must still be
 * Mali with her two children the moment the reset returns.
 */
const SEEDED_MEMBER_CREATED_VIA = 'import';

/**
 * Audit rows ABOUT a fact go with the fact. Rows about an account, a role, a
 * branch, a package or a session stay: they are the record of who configured
 * what and who signed in, which the reset is not entitled to rewrite.
 */
const FACT_ENTITY_TYPES = [
  'visit',
  'member',
  'child',
  'member_tier_verification',
  'booking',
  'sale',
  'sale_line',
  'payment_attempt',
  /**
   * S2-10a. A gateway notification is a fact of a day of play, and its audit
   * rows go with it. `payment_method` is NOT here: the tenders the park takes
   * money in are configuration, like a ticket package or a tax rule, and a
   * reset that emptied the method list would leave the till with no way to take
   * money at all.
   */
  'payment_notification',
  'wallet',
  'band',
  // S2-11: a refund is a fact of the sale it refunds, and goes with it.
  'refund',
  'stock_level',
  /**
   * S2-15a: a drawer's session and its ledger are a day of play's cash, and go
   * with it. A branch's cash settings (default float, tolerance) are
   * configuration on `core.branch` and stay.
   */
  'cash_session',
  'cash_movement',
];

/** Rows removed per table, for the response and the audit entry. */
export type DemoResetCounts = Record<string, number>;

/**
 * Deletes in foreign-key-safe order: children of a row before the row. Every
 * statement runs on the caller's transaction handle, so a failure anywhere
 * leaves the deployment exactly as it was rather than half-wiped.
 */
export async function resetDemoData(exec: Exec): Promise<DemoResetCounts> {
  // One transaction of its own (a savepoint inside the caller's), so the stock
  // ledger's purge flag below is local to it whichever handle the caller holds.
  return exec.transaction((tx) => resetDemoDataIn(tx));
}

async function resetDemoDataIn(tx: Tx): Promise<DemoResetCounts> {
  const counts: DemoResetCounts = {};

  // The members the session created. Collected first: the facts below are
  // deleted wholesale, but their children and tier evidence are not, and a
  // member cannot go while either still points at it.
  const doomedMembers = await tx
    .select({ id: member.id })
    .from(member)
    .where(ne(member.createdVia, SEEDED_MEMBER_CREATED_VIA));
  const doomedIds = doomedMembers.map((m) => m.id);

  /**
   * S2-11: a band points at its sale and at the ticket unit it was issued
   * against, and a band's events at the band, all ON DELETE RESTRICT — so the
   * events go, then the bands, before the lines and the sale they hang off. A
   * refund points at its sale the same way.
   */
  /**
   * S2-14a: a wallet entry points at the sale, refund and payment attempt it
   * moved money for (ON DELETE RESTRICT), and a key at its wallet — so the
   * ledger and the keys go first, then the wallets, before anything they name.
   */
  /**
   * S2-14b: the stock ledger's day of play, back to the counted opening. A
   * movement points at the sale line, sale and refund it moved stock for (ON
   * DELETE RESTRICT), so it goes first. The ledger is append-only by trigger;
   * the purge flag, local to this transaction, is the one door through it.
   * What stays is the opening count (OD-S5) — the stock take marked `opening`
   * and the movements its lines wrote — and every level is set back to the sum
   * of the movements that remain, so the projection still adds up.
   */
  await tx.execute(sql`select set_config('oto.stock_ledger_purge', 'on', true)`);
  const openingTakes = (
    await tx.select({ id: stockTake.id }).from(stockTake).where(eq(stockTake.opening, true))
  ).map((r) => r.id);
  const openingLines = openingTakes.length
    ? (
        await tx
          .select({ id: stockTakeLine.id })
          .from(stockTakeLine)
          .where(inArray(stockTakeLine.stockTakeId, openingTakes))
      ).map((r) => r.id)
    : [];
  counts.stock_attention = (await tx.delete(stockAttention).returning({ id: stockAttention.id })).length;
  counts.stock_movement = (
    await tx
      .delete(stockMovement)
      .where(
        openingLines.length
          ? or(sql`${stockMovement.stockTakeLineId} is null`, notInArray(stockMovement.stockTakeLineId, openingLines))
          : undefined,
      )
      .returning({ id: stockMovement.id })
  ).length;
  counts.stock_take_line = (
    await tx
      .delete(stockTakeLine)
      .where(openingTakes.length ? notInArray(stockTakeLine.stockTakeId, openingTakes) : undefined)
      .returning({ id: stockTakeLine.id })
  ).length;
  counts.stock_take = (
    await tx
      .delete(stockTake)
      .where(eq(stockTake.opening, false))
      .returning({ id: stockTake.id })
  ).length;
  counts.purchase_order_line = (
    await tx.delete(purchaseOrderLine).returning({ id: purchaseOrderLine.id })
  ).length;
  counts.purchase_order = (await tx.delete(purchaseOrder).returning({ id: purchaseOrder.id })).length;
  await tx.execute(sql`
    update pos.stock_level l
       set quantity = coalesce((select sum(m.quantity) from pos.stock_movement m
                                 where m.stock_item_id = l.stock_item_id
                                   and m.stock_location_id = l.stock_location_id), 0),
           updated_at = now()`);
  // Shut the door again. `set_config(…, true)` lasts until the OUTER transaction
  // ends, not this savepoint, so left on it would keep the ledger deletable for
  // whatever the caller does after the reset returns.
  await tx.execute(sql`select set_config('oto.stock_ledger_purge', 'off', true)`);

  counts.wallet_entry = (await tx.delete(walletEntry).returning({ id: walletEntry.id })).length;
  counts.wallet_key = (await tx.delete(walletKey).returning({ id: walletKey.id })).length;
  counts.wallet = (await tx.delete(wallet).returning({ id: wallet.id })).length;

  /**
   * S2-15a: the drawers' day. A cash movement points at the refund it handed
   * money back for (`refund_id`, ON DELETE RESTRICT) and at its session, a
   * recon line at the session it counted, a correction at its End of Day, and
   * a settlement line at the payment attempt it matched — all restricting, so
   * they go before the refunds and attempts below. The cash ledger is
   * append-only by trigger like the stock ledger; `oto.cash_ledger_purge`,
   * local to this transaction, is its one door, shut again straight after.
   * A session names the close its float was carried from
   * (`float_source_session_id`, restricting, to itself), so that edge is cut
   * before the sessions go.
   */
  counts.recon_line = (await tx.delete(reconLine).returning({ id: reconLine.id })).length;
  counts.eod_correction = (
    await tx.delete(eodCorrection).returning({ id: eodCorrection.id })
  ).length;
  counts.end_of_day = (await tx.delete(endOfDay).returning({ id: endOfDay.id })).length;
  await tx.execute(sql`select set_config('oto.cash_ledger_purge', 'on', true)`);
  counts.cash_movement = (await tx.delete(cashMovement).returning({ id: cashMovement.id })).length;
  await tx.execute(sql`select set_config('oto.cash_ledger_purge', 'off', true)`);
  await tx
    .update(cashSession)
    .set({ floatSourceSessionId: null })
    .where(isNotNull(cashSession.floatSourceSessionId));
  counts.cash_session = (await tx.delete(cashSession).returning({ id: cashSession.id })).length;
  counts.settlement_line = (
    await tx.delete(settlementLine).returning({ id: settlementLine.id })
  ).length;
  counts.settlement_batch = (
    await tx.delete(settlementBatch).returning({ id: settlementBatch.id })
  ).length;

  counts.band_event = (await tx.delete(bandEvent).returning({ id: bandEvent.id })).length;
  counts.band = (await tx.delete(band).returning({ id: band.id })).length;
  counts.refund = (await tx.delete(refund).returning({ id: refund.id })).length;

  counts.sale_line = (await tx.delete(saleLine).returning({ id: saleLine.id })).length;
  // S2-09a: a sale's discounts are rows of their own now, and they point at
  // the sale with ON DELETE RESTRICT — so a day with one manual discount on it
  // would otherwise make the whole reset fail.
  counts.sale_discount = (
    await tx.delete(saleDiscount).returning({ id: saleDiscount.id })
  ).length;
  /**
   * S2-10a: a gateway notification points at the attempt it settled with ON
   * DELETE RESTRICT — the evidence of a payment may not be quietly detached
   * from the payment — so the notifications go first.
   */
  counts.payment_notification = (
    await tx.delete(paymentNotification).returning({ id: paymentNotification.id })
  ).length;
  /**
   * S2-12: a booking names the one gateway attempt it is paid through
   * (`booking.payment_attempt_id`, ON DELETE RESTRICT), while the attempts go
   * here and the bookings further down — after the sales, which name a booking
   * of their own (`pos.sale.booking_id`). That is a cycle of restricting keys,
   * so one edge is cut first, as with the tier claims below: the bookings
   * forget their attempts, then the attempts go. Without it, the first booking
   * of a session that reached the payment page made the whole reset fail.
   */
  await tx
    .update(booking)
    .set({ paymentAttemptId: null })
    .where(isNotNull(booking.paymentAttemptId));
  counts.payment_attempt = (
    await tx.delete(paymentAttempt).returning({ id: paymentAttempt.id })
  ).length;
  /**
   * SCRUM-311: a sale and the document check that priced it point at each
   * other — `sale.tier_claim_id` at the claim, `sale_tier_claim.spent_by_sale_id`
   * back at the sale — and BOTH keys restrict, because neither row may be
   * quietly detached from the other in normal service. A cycle of restricting
   * keys cannot be deleted from either end, so one edge is cut first: the
   * claims are unspent, then the sales go, then the claims. The unspend is
   * done on the claim side because `pos.sale_freeze` would refuse the same
   * statement on a finalised sale — as it should.
   */
  await tx.update(saleTierClaim).set({ spentBySaleId: null, spentAt: null });
  /**
   * S2-10b: a redeemed voucher names the sale that used it
   * (`promo.voucher.sale_id`, ON DELETE RESTRICT), so a day with one
   * redemption on it would otherwise make the whole reset fail; and a held one
   * names a cart whose sale is about to go. The VOUCHER stays: it is the
   * booth's record, printed and still in a family's hands, and it stays
   * redeemed. Only its links to the day's sales go, holds included.
   *
   * The redemption ledger (`promo.voucher_redemption`) is left exactly as it
   * is. It is append-only and refuses a delete or an update from any caller,
   * this one included, and its sale ids are history carried by no foreign key —
   * a reset is not entitled to rewrite the record of who gave away what.
   *
   * Not in the counts: those are rows removed, and no voucher is.
   */
  await tx
    .update(voucher)
    .set({
      saleId: null,
      heldSaleId: null,
      heldStationId: null,
      heldByAccountId: null,
      heldAt: null,
      updatedAt: new Date(),
    })
    .where(or(isNotNull(voucher.saleId), isNotNull(voucher.heldSaleId)));
  counts.sale = (await tx.delete(sale).returning({ id: sale.id })).length;
  /**
   * The visits go AFTER the sales, because a sale names the visit it was rung
   * up for (`pos.sale.visit_id`, ON DELETE RESTRICT). They went first until
   * S2-11, which was only safe while no test rang a sale for a visit — the
   * first day of play that did would have made the whole reset fail.
   */
  counts.visit_child = (
    await tx.delete(visitChild).returning({ visitId: visitChild.visitId })
  ).length;
  counts.visit = (await tx.delete(visit).returning({ id: visit.id })).length;
  counts.sale_tier_claim = (
    await tx.delete(saleTierClaim).returning({ id: saleTierClaim.id })
  ).length;

  counts.attendee = (await tx.delete(attendee).returning({ id: attendee.id })).length;
  /**
   * A booking claimed at a counter has its claim row (`booking_redemption`,
   * ON DELETE RESTRICT on the booking). It is a fact of the day's play like the
   * booking itself, and it goes first — or a single redeemed booking made the
   * whole reset fail.
   */
  counts.booking_redemption = (
    await tx.delete(bookingRedemption).returning({ id: bookingRedemption.id })
  ).length;
  counts.booking = (await tx.delete(booking).returning({ id: booking.id })).length;

  // The stocked things and where they live are catalogue; what a day of play
  // moved went with the stock ledger above (S2-14b), back to the opening count.

  counts.member_tier_verification = doomedIds.length
    ? (
        await tx
          .delete(memberTierVerification)
          .where(inArray(memberTierVerification.memberId, doomedIds))
          .returning({ id: memberTierVerification.id })
      ).length
    : 0;
  counts.child = doomedIds.length
    ? (
        await tx.delete(child).where(inArray(child.memberId, doomedIds)).returning({ id: child.id })
      ).length
    : 0;
  /**
   * Offline plan Round 3: an id merged into a member at sync is kept as an
   * alias of it (`crm.member_alias`, ON DELETE RESTRICT), so the aliases of a
   * member the session created go before the member does.
   */
  counts.member_alias = doomedIds.length
    ? (
        await tx
          .delete(memberAlias)
          .where(inArray(memberAlias.memberId, doomedIds))
          .returning({ id: memberAlias.aliasMemberId })
      ).length
    : 0;
  counts.member = doomedIds.length
    ? (await tx.delete(member).where(inArray(member.id, doomedIds)).returning({ id: member.id }))
        .length
    : 0;

  counts.audit_log = (
    await tx
      .delete(auditLog)
      .where(inArray(auditLog.entityType, FACT_ENTITY_TYPES))
      .returning({ id: auditLog.id })
  ).length;

  return counts;
}
