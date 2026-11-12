import { and, eq, inArray, isNull } from 'drizzle-orm';
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
  isPartyMenuCode,
  itemTaxCategory,
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
  type TaxableCategory,
} from '@oto/shared';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { linksOfEvents } from './event-writes';
import { resolveItemTaxCategories } from './menu';
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
  type SaleActor,
} from './sale';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * SCRUM-804 — A PARTY SETTLED AS ONE REAL SALE (birthday plan §4, Lane 2).
 *
 * Plan in the OTO App, execute in the POS. The app publishes each party's plan
 * through the events seam (its event packages view, read in `otoapp-events.ts`;
 * SCRUM-803); the till confirms who actually came
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
 *   - the items the BEO added that the catalogue did not have (SCRUM-828: a
 *     special cake, a dish the family asked for), found by their codes like
 *     every set-menu line: a priced one at its till product's price, a free /
 *     included / alternate one as a 0-baht line (`partyMenuChargesOf`);
 *   - SCRUM-906: the kitchen plan's EXTRA lines (the owner's decision 2: "Not
 *     0 baht, charge it according to the right entered price"): a line the BEO
 *     badges EXTRA is charged at the price entered on it; one with no price
 *     entered that is a till item, at the till's price for the party's date;
 *     a set-menu (SET) line stays the package's (`partyExtraChargesOf`);
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

/** One item the BEO added, as the settlement charges it. */
interface PartyMenuCharge {
  /** The add-on's id on the sale line: the code's, or the BEO line's for a line with none. */
  id: string;
  code: string | null;
  name: string;
  qty: number;
  unitSatang: number;
  taxCategory: TaxableCategory;
}

/**
 * SCRUM-828 — the items the BEO added to the party that the till's catalogue
 * did not have, as the settlement charges them.
 *
 * Which lines: the plan's set-menu lines whose code is one the BEO's "New
 * item" door minted (`isPartyMenuCode`) and that a live product of the
 * operator still carries — the lookup the party's slips make
 * (`prepStationsByCode` in `party-slips.ts`). A catalogue item the set menu
 * names is part of the package and is not charged here, whatever its
 * BEO-only flag says.
 *
 * The price is the till PRODUCT's, for the party's date as the till prices
 * any menu item (its weekend price on a weekend or a branch holiday, where the
 * Console set one): the code is what the settlement finds the item by, and
 * the product is what the Console edits; the price the BEO line shows in baht
 * was copied from it when the item was made and can drift after an edit. A
 * product priced 0 is a free / included / alternate item: a 0-baht line, so
 * the receipt still names it. Taxed as the product's own category resolves
 * (the Party menu category is F&B), as any menu item is.
 *
 * One charge per code, its lines' quantities added up (a line with no
 * quantity counts one, the BEO's own default), in the order the plan first
 * names them.
 */
async function partyMenuChargesOf(
  db: Exec,
  operatorId: string,
  setMenu: PartyPlan['setMenu'],
  rateMode: RateMode,
): Promise<PartyMenuCharge[]> {
  const codes = [...new Set(setMenu.map((m) => m.productCode).filter(isPartyMenuCode))];
  if (codes.length === 0) return [];
  const rows = await db
    .select()
    .from(product)
    .where(and(eq(product.operatorId, operatorId), inArray(product.code, codes), isNull(product.archivedAt)));
  const areas = await resolveItemTaxCategories(db, rows);
  const byCode = new Map(rows.flatMap((row) => (row.code ? [[row.code, row] as const] : [])));
  const charges = new Map<string, PartyMenuCharge>();
  for (const line of setMenu) {
    const row = line.productCode ? byCode.get(line.productCode) : undefined;
    const qty = line.qty ?? 1;
    if (!row?.code || qty <= 0) continue;
    const held = charges.get(row.code);
    if (held) {
      held.qty += qty;
      continue;
    }
    charges.set(row.code, {
      id: `party_menu:${row.code}`,
      code: row.code,
      name: row.name,
      qty,
      unitSatang: rateMode === 'weekend' ? (row.priceWeekendSatang ?? row.priceSatang) : row.priceSatang,
      taxCategory: itemTaxCategory(row.kind === 'merch' ? 'merch' : 'menu', areas.get(row.id)),
    });
  }
  return [...charges.values()];
}

/**
 * SCRUM-906 — THE KITCHEN PLAN'S EXTRA LINES, as the settlement charges them
 * (the owner's decision 2 of 12 November: "Not 0 baht, charge it according to
 * the right entered price").
 *
 * Which lines: the food and bar lines the BEO badges EXTRA (`origin` `extra`,
 * published with the whole kitchen plan, app migration 0050). A SET line is
 * part of the package and is not charged; an item made for the party alone
 * (a `PARTY-` code) is charged by `partyMenuChargesOf` above, as before; a plan
 * published before the whole kitchen plan names no badge, and nothing more is
 * charged on it than before.
 *
 * The price: the one entered on the BEO line (per unit, its quantity times);
 * where none was entered and a live till product carries the line's code, the
 * product's price for the party's date, as the till prices any menu item.
 * A line with neither — typed by hand with no price — is not charged: no price
 * is invented for it; it prints for the kitchen, marked not on the till menu.
 *
 * Taxed as the product's own category resolves; a line no product carries, as
 * the menu's food (`fnb`) for a food line and the bar's (`bar`) for a bar line.
 * One charge per code and price, or per BEO line for a line with no code, in
 * the order the plan names them.
 */
async function partyExtraChargesOf(
  db: Exec,
  operatorId: string,
  plan: Pick<PartyPlan, 'setMenu' | 'barItems'>,
  rateMode: RateMode,
): Promise<PartyMenuCharge[]> {
  type Extra = { productCode: string | null; name: string; qty: number; unitPriceSatang?: number | undefined; lineId?: string | undefined };
  const extras: { line: Extra; area: 'fnb' | 'bar'; place: number }[] = [
    ...plan.setMenu.flatMap((m, i) =>
      m.origin === 'extra' ? [{ line: { ...m, qty: m.qty ?? 1 }, area: 'fnb' as const, place: i }] : [],
    ),
    ...plan.barItems.flatMap((b, i) => (b.origin === 'extra' ? [{ line: b, area: 'bar' as const, place: i }] : [])),
  ];
  if (extras.length === 0) return [];
  const codes = [...new Set(extras.map((e) => e.line.productCode).filter((c): c is string => !!c))];
  const rows = codes.length
    ? await db
        .select()
        .from(product)
        .where(and(eq(product.operatorId, operatorId), inArray(product.code, codes), isNull(product.archivedAt)))
    : [];
  const areas = await resolveItemTaxCategories(db, rows);
  const byCode = new Map(rows.flatMap((row) => (row.code ? [[row.code, row] as const] : [])));
  const charges = new Map<string, PartyMenuCharge>();
  for (const { line, area, place } of extras) {
    const qty = line.qty;
    if (qty <= 0) continue;
    const row = line.productCode ? byCode.get(line.productCode) : undefined;
    const tillPrice = row ? (rateMode === 'weekend' ? (row.priceWeekendSatang ?? row.priceSatang) : row.priceSatang) : null;
    const unit = line.unitPriceSatang ?? tillPrice;
    if (unit === null || unit === undefined) continue;
    const key = row?.code ? `code:${row.code}:${unit}` : `line:${area}:${line.lineId ?? place}`;
    const held = charges.get(key);
    if (held) {
      held.qty += qty;
      continue;
    }
    charges.set(key, {
      id: row?.code ? `party_extra:${row.code}:${unit}` : `party_extra_line:${area}:${line.lineId ?? place}`,
      code: row?.code ?? null,
      name: row?.name ?? (line.name.trim() || 'Extra'),
      qty,
      unitSatang: unit,
      taxCategory: row ? itemTaxCategory(row.kind === 'merch' ? 'merch' : 'menu', areas.get(row.id)) : area,
    });
  }
  return [...charges.values()];
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
  const partyMenu = [
    ...(await partyMenuChargesOf(db, actor.operatorId, plan.setMenu, c.rateMode)),
    ...(await partyExtraChargesOf(db, actor.operatorId, plan, c.rateMode)),
  ];

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
    // SCRUM-828: what the add-ons come to includes a priced item the BEO added;
    // a free one is one of what the package covers, at 0.
    ...partyMenu.map((m) => ({
      id: m.id,
      name: m.name,
      unitSatang: m.unitSatang,
      quantity: m.qty,
      taxCategory: m.taxCategory,
      role: (m.unitSatang > 0 ? 'add_on' : 'included') as PartyLineRole,
    })),
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

/** Walk-up guests the check-in board billed to the party's tab, and what they came to there. */
interface WalkUpsOnTab {
  count: number;
  satang: number;
}

/**
 * The party's walk-ups on its tab (`billing = 'party_tab'`), counted as the
 * tab's bill counts them (`liveBill` in `parties.ts`).
 *
 * Not settled on the sale. Whether a guest the board added pays the board's
 * walk-up price or the package's extra-child price, and whether the board's
 * band and the settlement's band are the same guest's, is the owner's to rule;
 * until then a party with any walk-up is refused (`PARTY_WALK_UPS_ON_TAB`) and
 * its balance is taken on the tab, as before this ticket, so no guest is
 * charged or banded twice. The preview says how many, so the form says why.
 */
async function walkUpsOnTab(db: Exec, branchId: string, eventId: string): Promise<WalkUpsOnTab> {
  const walkUps = (await linksOfEvents(db, { branchId, eventIds: [eventId] })).filter((l) => l.billing === 'party_tab');
  return { count: walkUps.length, satang: walkUps.reduce((sum, l) => sum + l.priceSnapshotSatang, 0) };
}

/** The settlement's figures, read off the engine's priced lines and nothing else. */
function quoteOf(
  built: BuiltSettlement,
  lines: readonly Pick<PricedLine, 'label' | 'quantity' | 'unitSatang' | 'grossSatang' | 'payload'>[],
  grossSatang: number,
  walkUps: WalkUpsOnTab,
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
    walkUps: walkUps.count,
    walkUpsSatang: walkUps.satang,
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
  return { quote: await quotePartySettlement(db, actor, { branchId, event, plan, body }, now) };
}

/**
 * What settling the party with these counts comes to, priced by the engine
 * exactly as the settlement will be, and written nowhere: the till's preview,
 * and (SCRUM-822) the quote the OTO App reads for a party not settled yet
 * (`party-billing.ts`), so the app's figures are the till's. The caller has
 * found the party and its plan inside its operator; refused by name (409)
 * where the counts cannot be priced, as the preview is.
 */
export async function quotePartySettlement(
  db: Exec,
  actor: SaleActor,
  q: { branchId: string; event: SeamEvent; plan: PartyPlan; body: PartySettlePreviewBody },
  now: Date = new Date(),
): Promise<PartySettleQuote> {
  const { branchId, event, plan, body } = q;
  // A preview's ids are its own: nothing is written under them.
  const built = await buildSettlement(db, actor, branchId, event, plan, body, deriveId(event.id, 'party-settlement:preview'));
  const priced = await priceCart(db, { ...actor, branchId }, cartInputOf(built, event, { branchId }), now, {
    mode: 'quote',
    stationId: body.stationId ?? null,
  });
  // Answered, not refused: the form shows the walk-ups and why Confirm is off.
  const walkUps = await walkUpsOnTab(db, branchId, event.id);
  return quoteOf(built, priced.lines, priced.money.grossSatang, walkUps);
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
 * names no price for); a party with walk-up guests the board already billed to
 * its tab (`walkUpsOnTab`), taken on the tab until the owner rules; a tab that
 * already took money for the package (the tab's payments beyond its own
 * charges), which settling would take again; and every refusal the sale engine
 * itself makes (stock, a station that cannot number a receipt, a total that
 * moved since the preview).
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
    // Walk-ups the board already billed to the tab: not settled here until the
    // owner rules how they meet the package (`walkUpsOnTab`).
    const walkUps = await walkUpsOnTab(tx, branchId, event.id);
    if (walkUps.count > 0) {
      throw errors.conflict(PARTY_SETTLE_REFUSALS.WALK_UPS.code, PARTY_SETTLE_REFUSALS.WALK_UPS.message, {
        walkUps: walkUps.count,
        walkUpsSatang: walkUps.satang,
      });
    }
    // Money for the package already taken on the tab — its payments beyond
    // its own charges — would be taken again by the sale.
    const tabCharges = walkUps.satang + ledgers.charges.reduce((sum, c) => sum + c.totalSatang, 0);
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
    const quote = quoteOf(built, committed.lines, gross, walkUps);

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
