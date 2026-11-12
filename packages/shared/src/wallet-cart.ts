import { cartUnits } from './cart-totals';
import { ledgerUnitKindOf } from './ledger-lines';
import type { PricingContext, TicketCartLine } from './pricing';
import { grantLinesOfLedger, type GrantLedgerRow, type GrantLine } from './wallet';

/**
 * SCRUM-883 — THE GRANT LAW, READ FROM A CART BEFORE THE SALE CLOSES.
 *
 * The platform grants a sale's credit from its LEDGER (`grantSaleCredit`):
 * the engine's units (`cartUnits`), each filed as `ledgerUnitKindOf` names it
 * with the row's quantity and unit (`buildPricedLines` in the api), read back
 * by `grantLinesOfLedger`. A till, a booking screen or a box that wants to
 * say what a cart WILL earn reads the same rows here, from the same engine, so
 * what it promises is what the platform grants.
 *
 * Found on staging on 12 November 2026: the till built its own list from the
 * adult rule alone, so an adult a rate's free items let in (the ledger's
 * `adults_free`, at ฿0) was counted as paying ฿350 and earning ฿350 under a
 * full-price rule, while the platform granted nothing.
 *
 * Read off the ledger, two things follow that the adult rule alone does not
 * say: an adult the free items let in is a free adult (nothing under
 * `full_price` or `percent`, the rule's value under `fixed`), and a child the
 * free items let in is not among the line's paid children (`kids-free` is a
 * second `kids` row, and the grant law reads the first), so earns nothing.
 */
export function grantLedgerRowsOfCart(lines: readonly TicketCartLine[], ctx: PricingContext): GrantLedgerRow[] {
  return cartUnits(lines, ctx).map((unit, index) => ({
    cartLineId: unit.lineId,
    kind: ledgerUnitKindOf(unit),
    ticketPackageId: unit.packageId || null,
    quantity: unit.row?.quantity ?? 1,
    unitSatang: unit.row?.unitPrice ?? unit.base,
    lineNo: index + 1,
  }));
}

/**
 * The grant law's lines for a cart, as the platform will read them from the
 * ledger this cart writes. `supervisedLineIds` are the drop-off and nanny
 * children's lines (their food is their own wallet); `giftLineIds` the lines
 * a Golden Ticket admitted (SCRUM-798).
 */
export function grantLinesOfCart(
  lines: readonly TicketCartLine[],
  ctx: PricingContext,
  packages: ReadonlyMap<string, { creditRule: unknown; gateAccess: boolean }>,
  supervisedLineIds: ReadonlySet<string> = new Set(),
  giftLineIds: ReadonlySet<string> = new Set(),
): GrantLine[] {
  return grantLinesOfLedger(grantLedgerRowsOfCart(lines, ctx), packages, supervisedLineIds, giftLineIds);
}
