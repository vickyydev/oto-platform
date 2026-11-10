import { and, asc, eq, inArray } from 'drizzle-orm';
import { branch, operator, partySettlement, paymentAttempt, sale, saleLine, station } from '@oto/db';
import {
  PARTY_LINE_ROLES,
  PARTY_SETTLE_REFUSALS,
  PAYMENT_ATTEMPT_TAKEN_STATUSES,
  isPartyDepositAttempt,
  partySettleFormDefaults,
  partySettlementLive,
  receiptTenderLabel,
  type PartyBillingAnswer,
  type PartyBillingSale,
  type PartyLineRole,
  type PartySettlementView,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { eventPackagesNotGranted, getEventAtBranches } from './otoapp-events';
import { seamRead } from './parties';
import { readPartyPlan } from './party-plan';
import { quotePartySettlement } from './party-settlement';
import { overlayPartyEdits, partyLedgersOf } from './party-tab';
import type { Exec } from './tx';

/**
 * SCRUM-822 — THE PARTY'S MONEY, AS THE TILL HOLDS IT, for the OTO App.
 *
 * The owner's ruling (10 November): one place for the money — the till's
 * payments are the ledger — and the app's billing kept, mounted in the BEO and
 * fed from here over the API so the two never disagree. The app's server asks
 * with its provisioning key (`GET /otoapp/parties/:eventId/billing`); the
 * operator is the key's, and an event at none of its branches is not found.
 *
 * Read, never written: the same request twice answers the same figures for the
 * same state of the party. Two answers, from the code the till itself runs:
 *
 *   - BEFORE settlement, the QUOTE: what the till's Settle form would show
 *     today — the counts it opens with (`partySettleFormDefaults`, the form's
 *     own rule) priced by `quotePartySettlement`, the preview's own code: the
 *     package at the party's day price (a branch holiday counts as weekend),
 *     the extras, the add-ons and entertainment, the items the BEO added
 *     (SCRUM-828), the free lines at 0, the deposit the app recorded (SCRUM-813)
 *     as paid in advance, and the balance. Where the till would refuse the
 *     counts (no package, an extra the package names no price for, children
 *     with no adult) the answer is `no_quote` with the till's own words;
 *   - AFTER settlement — a settlement sale open or paid holds the party — the
 *     SALE: its receipt number, its lines as the receipt lists them, every
 *     payment taken on it (the deposit among them), its totals, when it was
 *     settled and at which till. A voided or refunded settlement releases the
 *     party, so it is quoted again.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const partyNotFound = () => errors.notFound('Party not found');

const roleOf = (payload: unknown): PartyLineRole | null => {
  const role = (payload as { party?: { role?: unknown } } | null)?.party?.role;
  return typeof role === 'string' && (PARTY_LINE_ROLES as readonly string[]).includes(role) ? (role as PartyLineRole) : null;
};

/** The settlement sale, read live: its lines, the payments taken on it, and the till it was settled at. */
async function saleOf(db: Exec, s: PartySettlementView): Promise<PartyBillingSale> {
  const [row] = await db
    .select({ receiptNumber: sale.receiptNumber, stationName: station.name })
    .from(partySettlement)
    .innerJoin(sale, eq(sale.id, partySettlement.saleId))
    .leftJoin(station, eq(station.id, partySettlement.stationId))
    .where(eq(partySettlement.id, s.id))
    .limit(1);
  const lines = await db
    .select({
      label: saleLine.label,
      quantity: saleLine.quantity,
      unitSatang: saleLine.unitSatang,
      grossSatang: saleLine.grossSatang,
      payload: saleLine.payload,
    })
    .from(saleLine)
    .where(eq(saleLine.saleId, s.saleId))
    .orderBy(asc(saleLine.lineNo));
  const taken = await db
    .select()
    .from(paymentAttempt)
    .where(and(eq(paymentAttempt.saleId, s.saleId), inArray(paymentAttempt.status, [...PAYMENT_ATTEMPT_TAKEN_STATUSES])))
    .orderBy(asc(paymentAttempt.createdAt));
  return {
    saleId: s.saleId,
    settlementId: s.id,
    state: s.state,
    receiptNumber: row?.receiptNumber ?? s.receiptNumber,
    lines: lines.map((l) => ({
      role: roleOf(l.payload),
      label: l.label,
      quantity: l.quantity,
      unitSatang: l.unitSatang,
      totalSatang: l.grossSatang,
    })),
    payments: taken.map((a) => ({
      id: a.id,
      label: receiptTenderLabel({ method: a.methodCode ?? a.method, last4: a.last4 }),
      methodCode: a.methodCode ?? a.method,
      amountSatang: a.amountSatang,
      deposit: isPartyDepositAttempt(a),
      paidAt: (a.paidAt ?? a.createdAt)?.toISOString() ?? null,
    })),
    grossSatang: s.grossSatang,
    paidSatang: s.paidSatang,
    depositSatang: s.depositSatang,
    outstandingSatang: s.outstandingSatang,
    kids: s.kids,
    adults: s.adults,
    createdAt: s.createdAt,
    settledAt: s.settledAt,
    stationName: row?.stationName ?? null,
  };
}

/** `GET /otoapp/parties/:eventId/billing` — the quote before settlement, the sale after it. */
export async function partyBillingForOtoApp(
  db: Exec,
  q: { operatorId: string; eventId: string },
  now: Date = new Date(),
): Promise<PartyBillingAnswer> {
  if (!UUID.test(q.eventId)) throw partyNotFound();
  const [op] = await db.select({ name: operator.name }).from(operator).where(eq(operator.id, q.operatorId)).limit(1);
  if (!op) throw partyNotFound();
  const parks = await db
    .select({ id: branch.id, name: branch.name, address: branch.address })
    .from(branch)
    .where(eq(branch.operatorId, q.operatorId));
  const found = await seamRead(() => getEventAtBranches(db, { branchIds: parks.map((p) => p.id), eventId: q.eventId }));
  if (!found || found.type !== 'party') throw partyNotFound();
  const park = parks.find((p) => p.id === found.branchId)!;
  const branchId = park.id;
  const ledgers = (await partyLedgersOf(db, { branchId, eventIds: [found.id] })).get(found.id)!;
  // The party as the till shows it: the app's, under a till's edits it has not taken yet.
  const event = overlayPartyEdits(found, ledgers.edits);
  const base = {
    eventId: found.id,
    park: { name: op.name, branchName: park.name, address: park.address?.trim() ? park.address.trim() : null },
  };
  const party = (packageName: string | null, kids: number | null, adults: number | null) => ({
    title: event.title,
    date: event.startDate,
    startTime: event.startTime ?? null,
    endTime: event.endTime ?? null,
    packageName,
    kids,
    adults,
  });

  const settlement = ledgers.settlement;
  if (settlement && partySettlementLive(settlement)) {
    const [row] = await db
      .select({ plan: partySettlement.plan })
      .from(partySettlement)
      .where(eq(partySettlement.id, settlement.id))
      .limit(1);
    const packageName = (row?.plan as { package?: { name?: unknown } } | null)?.package?.name;
    return {
      ...base,
      state: 'sale',
      party: party(typeof packageName === 'string' ? packageName : null, settlement.kids, settlement.adults),
      quote: null,
      sale: await saleOf(db, settlement),
      noQuote: null,
    };
  }

  const { plan, status } = await readPartyPlan(db, { branchId, eventId: event.id });
  if (status === 'seam_not_granted') {
    const err = eventPackagesNotGranted();
    throw new AppError(503, 'EVENTS_SEAM_NOT_GRANTED', err.message, { missing: err.missing });
  }
  if (!plan) {
    return {
      ...base,
      state: 'no_quote',
      party: party(null, event.expectedKids, event.expectedAdults),
      quote: null,
      sale: null,
      noQuote: { code: PARTY_SETTLE_REFUSALS.NO_PLAN.code, message: PARTY_SETTLE_REFUSALS.NO_PLAN.message },
    };
  }
  const form = partySettleFormDefaults(plan, event);
  try {
    // Nobody is at a till: priced as the Settle form's preview, with no account and no station.
    const quote = await quotePartySettlement(
      db,
      { accountId: null, operatorId: q.operatorId, branchId },
      { branchId, event, plan, body: { branchId, ...form } },
      now,
    );
    return {
      ...base,
      state: 'quote',
      party: party(plan.package.name, form.kids, form.adults),
      quote,
      sale: null,
      noQuote: null,
    };
  } catch (err) {
    // The till's own refusal of these counts: said, as the Settle form says it.
    if (err instanceof AppError && err.statusCode === 409) {
      return {
        ...base,
        state: 'no_quote',
        party: party(plan.package.name, form.kids, form.adults),
        quote: null,
        sale: null,
        noQuote: { code: err.code, message: err.message },
      };
    }
    throw err;
  }
}
