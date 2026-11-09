import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  branchHoliday,
  partyEdit,
  partySettlement,
  product,
  sale,
  type Db,
} from '@oto/db';
import {
  PARTY_DEPOSIT_TENDER,
  PARTY_INCLUDED_COMPONENT,
  PARTY_PACKAGE_COMPONENT,
  PARTY_SETTLE_REFUSALS,
  composePartySettlement,
  deriveId,
  getRateModeForDate,
  partySettlementLive,
  type PartyComposition,
  type PartyLineRole,
  type PartyPlan,
  type PartySettleAnswer,
  type PartySettleBody,
  type PartySettleLine,
  type PartySettlePreviewAnswer,
  type PartySettlePreviewBody,
  type PartySettleQuote,
  type PartySettlementView,
  type RateMode,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { linksOfEvents } from './event-writes';
import { eventPackagesNotGranted, type SeamEvent } from './otoapp-events';
import { readPartyPlan } from './party-plan';
import type { OtoAppDirectory } from './otoapp-directory';
import { branchClockOf, partyOf, pushPartyEdit, stationAt } from './parties';
import { lockParty, partyLedgersOf, partySettlementStateOf } from './party-tab';
import { openAttempt, settleAttempt } from './payments/attempt';
import {
  SALE_KIDS_WITHOUT_REGISTRATION,
  commitSale,
  finaliseSale,
  priceCart,
  type ActorContext,
  type CommitSaleInput,
  type PartySettlementCart,
  type PartySettlementCartLine,
  type PricedLine,
} from './sale';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * SCRUM-804 — A PARTY SETTLED AS ONE REAL SALE (birthday plan §4, Lane 2).
 *
 * Plan in the OTO App, execute in the POS. The app publishes each party's plan
 * in `otoapp_v.event_packages` (SCRUM-803); the till confirms who actually came
 * and settles the party as ONE sale through the sale engine every other sale
 * goes through (`commitSale` → `finaliseSale`, the close that prints):
 *
 *   - the package fee at the package's own price for the party's date (a
 *     `party_package` add-on line, taxed as tickets), and each included item as
 *     a 0-baht `party_included` line under its own label, so the receipt shows
 *     what the price covers;
 *   - the children and adults on an admission line at ฿0, the package's
 *     included adults free and the rest at the package's own extra-adult price,
 *     and the children beyond the included count on a second admission line at
 *     the package's own extra-child price — so a band prints for every one of
 *     them at the close, as for any ticket sale;
 *   - the package's socks as free Regular Socks (the ticket's free items,
 *     SCRUM-768, taken off the Regular Socks shelf like any socks), the pairs
 *     beyond them at the socks product's price;
 *   - the plan's add-ons and entertainment staff kept, at the plan's prices: an
 *     add-on that is F&B credit grants it when the sale closes and its voucher
 *     prints on the receipt; one that prints a voucher without credit rides the
 *     admission line, so its item voucher prints as a ticket add-on's does;
 *   - the deposit already paid in the app recorded on the sale as "Deposit
 *     (paid in advance)", so the receipt reads the balance, which the till then
 *     takes through its ordinary payment stage.
 *
 * The party's tab stays for what is added on the day. Once a settlement holds
 * the package (its sale open or paid), the tab's bill is its own charges and
 * payments only (`billOfParty`), so the package is never taken twice.
 */

/** What the routes hand the settlement. */
export interface PartySettlementDeps {
  db: Db;
  directory?: OtoAppDirectory | null;
  log?: FastifyBaseLogger;
}

// --- The cart a settlement is -----------------------------------------------------------

const SOCKS_CODE = 'AO-SOCKS';

/** The branch's Regular Socks product, else the operator-wide one; null when the park sells none. */
async function socksProductOf(db: Exec, operatorId: string, branchId: string): Promise<string | null> {
  const rows = await db
    .select({ id: product.id, branchId: product.branchId })
    .from(product)
    .where(and(eq(product.operatorId, operatorId), eq(product.code, SOCKS_CODE), isNull(product.archivedAt)));
  return (rows.find((r) => r.branchId === branchId) ?? rows.find((r) => !r.branchId))?.id ?? null;
}

/** The party's date's rate: weekend on a Saturday, a Sunday or a branch holiday. */
async function rateModeOf(db: Exec, branchId: string, date: string): Promise<RateMode> {
  const holidays = await db
    .select({ name: branchHoliday.name, startsOn: branchHoliday.startsOn, endsOn: branchHoliday.endsOn })
    .from(branchHoliday)
    .where(and(eq(branchHoliday.branchId, branchId), isNull(branchHoliday.archivedAt)));
  return getRateModeForDate(date, holidays).mode;
}

interface BuiltSettlement {
  plan: PartyPlan;
  composition: PartyComposition;
  cart: PartySettlementCart;
  socksProductId: string | null;
}

function refuse(result: { code: string; message: string; details?: Record<string, unknown> }): never {
  throw errors.conflict(result.code, result.message, result.details);
}

/**
 * The lines a settlement is made of, from the plan and the counts staff
 * confirmed — the composer's counts (`composePartySettlement`) laid out as the
 * engine's lines. Every id is derived from the settlement's, so a retry of the
 * same press is the same cart.
 */
async function buildSettlement(
  db: Exec,
  actor: Pick<ActorContext, 'operatorId'>,
  branchId: string,
  event: SeamEvent,
  plan: PartyPlan,
  body: PartySettlePreviewBody,
  settlementId: string,
): Promise<BuiltSettlement> {
  const rateMode = await rateModeOf(db, branchId, plan.partyDate);
  const composed = composePartySettlement(plan, body, rateMode);
  if (!composed.ok) refuse(composed);
  const c = composed.composition;
  // No child is sold a ticket alone (SCRUM-478's rule, at the one place a sale
  // passes): a party's children are settled beside at least one adult.
  if (body.kids > 0 && body.adults === 0) {
    throw errors.conflict(
      SALE_KIDS_WITHOUT_REGISTRATION,
      "Children can't be settled on their own. Count the adults who came with the party. Nothing was saved.",
      { kids: body.kids, adults: body.adults, reason: 'no_registration' },
    );
  }
  const socksGiven = c.freeSocks + c.paidSocks;
  const socksProductId = socksGiven > 0 ? await socksProductOf(db, actor.operatorId, branchId) : null;
  if (socksGiven > 0 && !socksProductId) {
    throw errors.conflict('PARTY_NO_SOCKS', 'This park sells no Regular Socks, so socks cannot be handed out on this party');
  }

  const lineId = (name: string) => deriveId(settlementId, `party-settlement:${name}`);
  const pkg = plan.package;
  const holder = event.parentName ?? event.bookingName ?? event.title;
  // An add-on that is only a voucher rides the admission line, so its item
  // voucher prints as a ticket add-on's does; credit and plain add-ons ride
  // their own line, whose wallet is spent by its QR.
  const voucherOnly = c.addOns.filter((a) => a.qty > 0 && a.printsVoucher && a.fnbCreditSatang === 0);
  const otherAddOns = c.addOns.filter((a) => a.qty > 0 && !voucherOnly.includes(a));
  const addOnOf = (a: PartyComposition['addOns'][number]): PartySettlementCartLine['addOns'][number] => ({
    id: `party_add_on:${a.id}`,
    name: a.name,
    unitSatang: a.unitPriceSatang,
    quantity: a.qty,
    role: 'add_on',
    ...(a.fnbCreditSatang > 0 ? { fnbCreditSatang: a.fnbCreditSatang, creditHolder: holder ? `${a.name} · ${holder}` : a.name } : {}),
  });
  // The free pairs sit on a line with children: the package's, else the extras'.
  const freeOnGuests = c.packageKids > 0 ? c.freeSocks : 0;
  const freeOnExtras = c.packageKids > 0 ? 0 : c.freeSocks;
  const blank = { kids: 0, kidUnitSatang: 0, adults: 0, adultsFree: 0, adultUnitSatang: 0, socks: 0, freeSocks: 0 };
  const lines: PartySettlementCartLine[] = [
    {
      ...blank,
      id: lineId('package'),
      role: 'package',
      ticket: false,
      addOns: [
        {
          id: PARTY_PACKAGE_COMPONENT,
          name: pkg.name,
          unitSatang: c.packageSatang,
          quantity: 1,
          taxCategory: 'tickets',
          role: 'package',
        },
        ...c.includedLabels.map((label) => ({
          id: PARTY_INCLUDED_COMPONENT,
          name: label,
          unitSatang: 0,
          quantity: 1,
          taxCategory: 'tickets' as const,
          role: 'included' as PartyLineRole,
        })),
      ],
    },
    {
      ...blank,
      id: lineId('guests'),
      role: 'guests',
      ticket: true,
      kids: c.packageKids,
      adults: c.packageAdults + c.extraAdults,
      adultsFree: c.packageAdults,
      adultUnitSatang: c.extraAdultUnitSatang,
      socks: freeOnGuests,
      freeSocks: freeOnGuests,
      addOns: voucherOnly.map(addOnOf),
      labels: { kids: 'Children (in the package)', adultsFree: 'Adults (in the package)', adultsPaid: 'Extra adult' },
    },
  ];
  if (c.extraChildren > 0) {
    lines.push({
      ...blank,
      id: lineId('extra-children'),
      role: 'extra_children',
      ticket: true,
      kids: c.extraChildren,
      kidUnitSatang: c.extraChildUnitSatang,
      socks: freeOnExtras,
      freeSocks: freeOnExtras,
      addOns: [],
      labels: { kids: 'Extra child' },
    });
  }
  if (c.paidSocks > 0) {
    lines.push({ ...blank, id: lineId('socks'), role: 'socks', ticket: true, socks: c.paidSocks, addOns: [] });
  }
  const extras = [
    ...otherAddOns.map(addOnOf),
    ...c.entertainment.flatMap((e) => [
      { id: `party_entertainment:${e.id}`, name: e.name, unitSatang: e.priceSatang, quantity: 1, role: 'entertainment' as PartyLineRole },
      ...(e.extraChildren > 0
        ? [
            {
              id: `party_entertainment_extra:${e.id}`,
              name: `${e.name} — extra child`,
              unitSatang: e.extraChildPriceSatang ?? 0,
              quantity: e.extraChildren,
              role: 'entertainment' as PartyLineRole,
            },
          ]
        : []),
    ]),
  ];
  if (extras.length > 0) {
    lines.push({ ...blank, id: lineId('add-ons'), role: 'add_on', ticket: false, addOns: extras });
  }
  return {
    plan,
    composition: c,
    cart: { eventId: event.id, settlementId, hours: pkg.hours, lines },
    socksProductId,
  };
}

/** The sale a settlement is, for the engine. */
function cartInputOf(
  built: BuiltSettlement,
  event: SeamEvent,
  q: { branchId: string; saleId?: string; actionId?: string | null; expectedTotalSatang?: number },
): Omit<CommitSaleInput, 'stationId'> {
  return {
    ...(q.saleId ? { id: q.saleId } : {}),
    branchId: q.branchId,
    ...(built.socksProductId ? { socks: { addOnId: built.socksProductId } } : {}),
    partySettlement: built.cart,
    note: `Party: ${event.title}`,
    customerPhone: event.parentPhone,
    ...(q.actionId ? { actionId: q.actionId } : {}),
    ...(q.expectedTotalSatang !== undefined ? { expectedTotalSatang: q.expectedTotalSatang } : {}),
  };
}

const partyRoleOf = (line: Pick<PricedLine, 'payload'>): PartyLineRole | null => line.payload?.party?.role ?? null;

/** The settlement's figures, read off the engine's priced lines and nothing else. */
function quoteOf(
  built: BuiltSettlement,
  lines: readonly Pick<PricedLine, 'label' | 'quantity' | 'unitSatang' | 'grossSatang' | 'payload'>[],
  grossSatang: number,
): PartySettleQuote {
  const shown: PartySettleLine[] = lines.flatMap((line) => {
    const role = partyRoleOf(line);
    return role
      ? [{ role, label: line.label, quantity: line.quantity, unitSatang: line.unitSatang, totalSatang: line.grossSatang }]
      : [];
  });
  const sum = (role: PartyLineRole) => shown.filter((l) => l.role === role).reduce((total, l) => total + l.totalSatang, 0);
  const c = built.composition;
  const depositSatang = Math.min(built.plan.settlement.depositSatang, grossSatang);
  return {
    partyDate: built.plan.partyDate,
    rateMode: c.rateMode,
    packageName: built.plan.package.name,
    lines: shown,
    packageSatang: sum('package'),
    extraChildren: c.extraChildren,
    extraChildrenSatang: sum('extra_children'),
    extraAdults: c.extraAdults,
    extraAdultsSatang: sum('extra_adults'),
    freeSocks: c.freeSocks,
    paidSocks: c.paidSocks,
    socksSatang: sum('socks'),
    addOnsSatang: sum('add_on'),
    entertainmentSatang: sum('entertainment'),
    totalSatang: grossSatang,
    creditSatang: c.addOns.reduce((total, a) => total + a.qty * a.fnbCreditSatang, 0),
    depositSatang,
    balanceSatang: grossSatang - depositSatang,
  };
}

/** The party, its plan and the counts priced into a settlement: refused by name where it cannot be. */
async function partyAndPlan(
  db: Exec,
  actor: ActorContext,
  body: { branchId: string },
  partyId: string,
) {
  const branchClock = await branchClockOf(db, actor.operatorId, body.branchId);
  await actor.assertBranchAllowed?.(branchClock.id);
  const event = await partyOf(db, branchClock.id, partyId);
  const { plan, status } = await readPartyPlan(db, { branchId: branchClock.id, eventId: event.id });
  if (status === 'seam_not_granted') {
    const err = eventPackagesNotGranted();
    throw new AppError(503, 'EVENTS_SEAM_NOT_GRANTED', err.message, { missing: err.missing });
  }
  if (!plan) throw errors.conflict(PARTY_SETTLE_REFUSALS.NO_PLAN.code, PARTY_SETTLE_REFUSALS.NO_PLAN.message, { planStatus: status });
  return { branchId: branchClock.id, event, plan };
}

// --- The preview ---------------------------------------------------------------------------

/**
 * `POST /parties/:id/settle/preview` — what settling the party with these
 * counts comes to, priced by the engine exactly as the settlement will be, and
 * written nowhere.
 */
export async function previewPartySettlement(
  deps: PartySettlementDeps,
  actor: ActorContext,
  partyId: string,
  body: PartySettlePreviewBody,
  now: Date = new Date(),
): Promise<PartySettlePreviewAnswer> {
  const db = deps.db;
  const { branchId, event, plan } = await partyAndPlan(db, actor, body, partyId);
  // A preview's ids are its own: nothing is written under them.
  const built = await buildSettlement(db, actor, branchId, event, plan, body, deriveId(event.id, 'party-settlement:preview'));
  const priced = await priceCart(db, { ...actor, branchId }, cartInputOf(built, event, { branchId }), now, {
    mode: 'quote',
    stationId: body.stationId ?? null,
  });
  return { quote: quoteOf(built, priced.lines, priced.money.grossSatang) };
}

// --- The settlement --------------------------------------------------------------------------

type SettlementRow = typeof partySettlement.$inferSelect;

/** The settlement as the party page shows it, read back. */
async function settlementViewOf(db: Exec, row: SettlementRow): Promise<PartySettlementView> {
  const ledgers = (await partyLedgersOf(db, { branchId: row.branchId, eventIds: [row.otoappEventId] })).get(
    row.otoappEventId,
  );
  if (ledgers?.settlement && ledgers.settlement.id === row.id) return ledgers.settlement;
  // A released settlement is not on the tab any more: answered from its own row.
  const [s] = await db.select().from(sale).where(eq(sale.id, row.saleId)).limit(1);
  return {
    id: row.id,
    saleId: row.saleId,
    state: partySettlementStateOf(s?.status ?? 'voided'),
    receiptNumber: s?.receiptNumber ?? null,
    grossSatang: s?.grossSatang ?? 0,
    paidSatang: 0,
    outstandingSatang: 0,
    depositSatang: row.depositSatang,
    kids: row.kids,
    adults: row.adults,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    writeBack: null,
  };
}

async function answerOf(
  db: Exec,
  row: SettlementRow,
  replayed: boolean,
  printingNotes: string[],
): Promise<PartySettleAnswer> {
  const view = await settlementViewOf(db, row);
  const [s] = await db.select().from(sale).where(eq(sale.id, row.saleId)).limit(1);
  const snapshot = row.plan as { quote?: PartySettleQuote };
  if (!s || !snapshot.quote) throw new Error(`party settlement ${row.id} has no sale or no priced snapshot`);
  return {
    replayed,
    quote: snapshot.quote,
    settlement: view,
    sale: {
      id: s.id,
      status: s.status,
      receiptNumber: s.receiptNumber,
      grossSatang: s.grossSatang,
      outstandingSatang: view.state === 'open' ? view.outstandingSatang : 0,
    },
    printingNotes,
  };
}

/** The deposit's press: one record of it per settlement, whatever retries. */
const depositActionId = (settlementId: string) => `party-settlement:${settlementId}:deposit`;

/**
 * `POST /parties/:id/settle` — settle the party as one sale, and leave it at
 * the payment stage for the balance.
 *
 * Refused, with nothing written: a party with no package in the OTO App; one
 * already settled by a sale that is open or paid (a voided or refunded one
 * releases it); counts the package cannot price (an extra child or adult it
 * names no price for); a tab that already took money for the package (the
 * tab's payments beyond its own charges), which settling would take again; and
 * every refusal the sale engine itself makes (stock, a station that cannot
 * number a receipt, a total that moved since the preview).
 *
 * In one transaction under the party's lock: the sale (`commitSale`), the
 * deposit on it as paid in advance (a `pos.payment_attempt` of the deposit
 * tender, with no station: it never passed a counter, so End of Day leaves it
 * out of the till's takings and no drawer opens), and the settlement row. When
 * the deposit covers the whole of it the sale is closed in the same
 * transaction, which prints; otherwise the till takes the balance through its
 * payment stage, and the close (`finaliseSale`) settles the party. The same
 * settlement id again answers what it made.
 */
export async function settleParty(
  deps: PartySettlementDeps,
  ctx: OpContext,
  actor: ActorContext,
  partyId: string,
  body: PartySettleBody,
  now: Date = new Date(),
): Promise<PartySettleAnswer> {
  const db = deps.db;
  const replay = async (row: SettlementRow): Promise<PartySettleAnswer> => {
    if (row.operatorId !== actor.operatorId || row.otoappEventId !== partyId.toLowerCase()) {
      throw errors.conflict('SETTLEMENT_ID_IN_USE', 'That settlement id already belongs to another settlement', {
        settlementId: row.id,
      });
    }
    await actor.assertBranchAllowed?.(row.branchId);
    return answerOf(db, row, true, []);
  };
  const [prior] = await db.select().from(partySettlement).where(eq(partySettlement.id, body.settlementId)).limit(1);
  if (prior) return replay(prior);

  const { branchId, event, plan } = await partyAndPlan(db, actor, body, partyId);
  if (event.archived) throw errors.conflict('EVENT_ARCHIVED', 'This party has been archived in the OTO App');
  const counter = await stationAt(db, actor.operatorId, branchId, body.stationId);
  if (!counter) throw errors.badRequest('A party is settled at a counter: name the station');
  const built = await buildSettlement(db, actor, branchId, event, plan, body, body.settlementId);
  const actionId = body.actionId ?? null;

  const done: { raced: SettlementRow | null; row: SettlementRow | null; notes: string[]; closed: boolean } = {
    raced: null,
    row: null,
    notes: [],
    closed: false,
  };
  await withTx(db, ctx, 'party.settle', async (tx) => {
    await lockParty(tx, event.id);
    const [again] = await tx.select().from(partySettlement).where(eq(partySettlement.id, body.settlementId)).limit(1);
    if (again) {
      done.raced = again;
      return undefined;
    }
    const ledgers = (await partyLedgersOf(tx, { branchId, eventIds: [event.id] })).get(event.id)!;
    // One live settlement per party: a voided or refunded one is released.
    const held = ledgers.settlement;
    if (held && partySettlementLive(held)) {
      throw errors.conflict(PARTY_SETTLE_REFUSALS.ALREADY.code, PARTY_SETTLE_REFUSALS.ALREADY.message, {
        settlementId: held.id,
        saleId: held.saleId,
        state: held.state,
        receiptNumber: held.receiptNumber,
        outstandingSatang: held.outstandingSatang,
      });
    }
    if (held) {
      await tx
        .update(partySettlement)
        .set({ releasedAt: now, updatedAt: now })
        .where(eq(partySettlement.id, held.id));
    }
    // Money for the package already taken on the tab — its payments beyond
    // its own charges and walk-ups — would be taken again by the sale.
    const walkUps = (await linksOfEvents(tx, { branchId, eventIds: [event.id] }))
      .filter((l) => l.billing === 'party_tab')
      .reduce((sum, l) => sum + l.priceSnapshotSatang, 0);
    const tabCharges = walkUps + ledgers.charges.reduce((sum, c) => sum + c.totalSatang, 0);
    const tabPaid = ledgers.payments.reduce((sum, p) => sum + p.amountSatang, 0);
    if (tabPaid > tabCharges) {
      throw errors.conflict(PARTY_SETTLE_REFUSALS.PAID_ON_TAB.code, PARTY_SETTLE_REFUSALS.PAID_ON_TAB.message, {
        paidOnTabSatang: tabPaid,
        tabChargesSatang: tabCharges,
      });
    }

    const committed = await commitSale(
      tx,
      actor,
      {
        ...cartInputOf(built, event, {
          branchId,
          saleId: body.saleId,
          actionId,
          ...(body.expectedTotalSatang !== undefined ? { expectedTotalSatang: body.expectedTotalSatang } : {}),
        }),
        stationId: counter.id,
      },
      now,
    );
    if (committed.replay) {
      throw errors.conflict('SALE_ID_IN_USE', 'That sale id already belongs to another sale — nothing was saved');
    }
    const gross = committed.sale.totals.grossSatang;
    const quote = quoteOf(built, committed.lines, gross);

    let depositAttemptId: string | null = null;
    if (quote.depositSatang > 0) {
      const opened = await openAttempt(tx, {
        saleId: committed.sale.id,
        operatorId: actor.operatorId,
        branchId,
        // Paid in the OTO App before the party: it never passed a counter.
        stationId: null,
        businessDate: committed.sale.businessDate,
        method: 'other',
        methodCode: PARTY_DEPOSIT_TENDER.code,
        amountSatang: quote.depositSatang,
        actionId: depositActionId(body.settlementId),
        payload: {
          partyDeposit: true,
          partyEventId: event.id,
          settlementId: body.settlementId,
          depositSatang: plan.settlement.depositSatang,
          recordedByAccountId: actor.accountId,
          ...(actionId ? { actionId } : {}),
        },
      });
      await settleAttempt(tx, opened.id, { paidAt: now });
      depositAttemptId = opened.id;
    }

    const [row] = await tx
      .insert(partySettlement)
      .values({
        id: body.settlementId,
        operatorId: actor.operatorId,
        branchId,
        otoappEventId: event.id,
        saleId: committed.sale.id,
        kids: body.kids,
        adults: body.adults,
        socksGiven: body.socksGiven,
        tier: body.tier ?? null,
        rateMode: built.composition.rateMode,
        partyDate: plan.partyDate,
        plan: {
          package: plan.package,
          addOnIds: body.addOnIds,
          entertainmentIds: body.entertainmentIds,
          quote,
        },
        depositSatang: quote.depositSatang,
        depositAttemptId,
        accountId: actor.accountId,
        stationId: counter.id,
        boxId: counter.boxId,
        actionId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId,
      action: 'party.settle',
      entityType: 'party_settlement',
      entityId: body.settlementId,
      actionId,
      requestId: actor.requestId,
      after: {
        eventId: event.id,
        saleId: committed.sale.id,
        package: plan.package.name,
        packageTemplateId: plan.package.templateId,
        partyDate: plan.partyDate,
        rateMode: built.composition.rateMode,
        kids: body.kids,
        adults: body.adults,
        extraChildren: built.composition.extraChildren,
        extraAdults: built.composition.extraAdults,
        socksGiven: body.socksGiven,
        freeSocks: built.composition.freeSocks,
        addOnIds: body.addOnIds,
        entertainmentIds: body.entertainmentIds,
        tier: body.tier ?? null,
        grossSatang: gross,
        depositSatang: quote.depositSatang,
        balanceSatang: quote.balanceSatang,
        creditSatang: quote.creditSatang,
        stationId: counter.id,
        boxId: counter.boxId,
        ...(held ? { releasedSettlementId: held.id } : {}),
      },
    });
    done.row = row!;

    // The deposit covers the whole of it: closed here, which prints and settles the party.
    if (quote.balanceSatang === 0) {
      const closed = await finaliseSale(tx, actor, committed.sale.id, {
        actionId: `party-settlement:${body.settlementId}:close`,
      });
      done.notes = closed.printing?.notes ?? [];
      done.closed = closed.finalised;
    }
    return undefined;
  });
  if (done.raced) return replay(done.raced);
  if (done.closed) await writeBackPartySettlement(db, deps.log, body.saleId, deps.directory ?? null);
  const [now_] = await db.select().from(partySettlement).where(eq(partySettlement.id, body.settlementId)).limit(1);
  return answerOf(db, now_ ?? done.row!, false, done.notes);
}

// --- The write-back ------------------------------------------------------------------------

let directoryOf: (() => OtoAppDirectory) | null = null;

/** The app's directory, as the app holds it (set once at start-up, read at each push). */
export function configurePartySettlementDirectory(resolve: (() => OtoAppDirectory) | null): void {
  directoryOf = resolve;
}

/**
 * After a sale's close has committed: if it settled a party, tell the OTO App
 * which sale did (the edit the close wrote, `pending`). The till's close of a
 * settlement and the payment answers are its chances; one that fails waits on
 * the Failures page as any party edit does. Never fails its caller.
 */
export async function writeBackPartySettlement(
  db: Db,
  log: FastifyBaseLogger | undefined,
  saleId: string,
  directory: OtoAppDirectory | null = null,
): Promise<void> {
  const resolved = directory ?? directoryOf?.() ?? null;
  if (!resolved) return;
  try {
    const [owed] = await db
      .select({ editId: partyEdit.id, state: partyEdit.syncState })
      .from(partySettlement)
      .innerJoin(partyEdit, eq(partyEdit.id, partySettlement.writeBackEditId))
      .where(eq(partySettlement.saleId, saleId))
      .limit(1);
    if (!owed || owed.state === 'synced') return;
    await pushPartyEdit({ db, directory: resolved, ...(log ? { log } : {}) }, owed.editId);
  } catch (err) {
    log?.error({ err, saleId }, 'a party settlement could not be written back to the OTO App');
  }
}
