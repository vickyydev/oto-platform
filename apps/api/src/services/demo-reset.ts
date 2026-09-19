import { inArray, ne } from 'drizzle-orm';
import {
  attendee,
  auditLog,
  band,
  booking,
  child,
  member,
  memberTierVerification,
  paymentAttempt,
  sale,
  saleLine,
  stockLevel,
  visit,
  visitChild,
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
  'wallet',
  'band',
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

  counts.visit_child = (
    await tx.delete(visitChild).returning({ visitId: visitChild.visitId })
  ).length;
  counts.visit = (await tx.delete(visit).returning({ id: visit.id })).length;

  counts.sale_line = (await tx.delete(saleLine).returning({ id: saleLine.id })).length;
  counts.payment_attempt = (
    await tx.delete(paymentAttempt).returning({ id: paymentAttempt.id })
  ).length;
  counts.sale = (await tx.delete(sale).returning({ id: sale.id })).length;

  counts.attendee = (await tx.delete(attendee).returning({ id: attendee.id })).length;
  counts.booking = (await tx.delete(booking).returning({ id: booking.id })).length;

  counts.wallet_entry = (await tx.delete(walletEntry).returning({ id: walletEntry.id })).length;
  counts.wallet = (await tx.delete(wallet).returning({ id: wallet.id })).length;

  counts.band = (await tx.delete(band).returning({ id: band.id })).length;
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
