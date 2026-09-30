/**
 * THE TILL'S OLDER CALCULATOR IS GONE — SCRUM-271, plan
 * `docs/progress/plans/offline/PLAN.md` Round 2 ("one calculator").
 *
 * This file was the prototype's baht-float tax and service engine
 * (`computeTaxBreakdown`, `summarizeTax`, `roundTHB`, `groupTaxInputs`), and
 * with `computeTotals`, `computeFnbTotals` and `computeMerchTotals` it priced
 * every screen and report on the till. None of that arithmetic exists any more:
 * every figure comes from the satang engine in `@oto/shared` through
 * `lib/cartWire.ts`.
 *
 * WHAT IS LEFT IS NOT ARITHMETIC — three names from the display edge in
 * `lib/cartWire.ts`, re-exported under their old names for ONE importer:
 * `components/merch/MerchCustomerDisplay.tsx`, which is held unchanged while
 * another lane's work on it is open. `summarizeTax` here is `taxRowsOf` (the
 * engine's rows, summed in satang), `roundTHB` is `shownBaht` (a figure to the
 * satang, for printing) and `TaxBreakdown` is `TaxBreakdownBaht`. When that
 * file imports those from `@/lib/cartWire`, delete this one; the lint rule in
 * `eslint.config.mjs` already refuses any other import of it.
 */
export {
  taxRowsOf as summarizeTax,
  shownBaht as roundTHB,
  type TaxBreakdownBaht as TaxBreakdown,
} from '@/lib/cartWire';
