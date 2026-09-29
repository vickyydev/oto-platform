import { inArray, isNotNull, ne, or } from 'drizzle-orm';
import {
  attendee,
  auditLog,
  band,
  bandEvent,
  booking,
  child,
  member,
  memberTierVerification,
  paymentAttempt,
  paymentNotification,
  refund,
  sale,
  saleDiscount,
  saleLine,
  saleTierClaim,
  stockLevel,
  visit,
  visitChild,
  voucher,
  wallet,
  walletEntry,
} from '@oto/db';
import type { Exec } from './tx';

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
];

/** Rows removed per table, for the response and the audit entry. */
export type DemoResetCounts = Record<string, number>;

/**
 * Deletes in foreign-key-safe order: children of a row before the row. Every
 * statement runs on the caller's transaction handle, so a failure anywhere
 * leaves the deployment exactly as it was rather than half-wiped.
 */
export async function resetDemoData(tx: Exec): Promise<DemoResetCounts> {
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
  counts.booking = (await tx.delete(booking).returning({ id: booking.id })).length;

  counts.wallet_entry = (await tx.delete(walletEntry).returning({ id: walletEntry.id })).length;
  counts.wallet = (await tx.delete(wallet).returning({ id: wallet.id })).length;

  // The stocked things and where they live are catalogue; the COUNT is what a
  // day of play moves, so only the levels go.
  counts.stock_level = (await tx.delete(stockLevel).returning({ id: stockLevel.id })).length;

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
