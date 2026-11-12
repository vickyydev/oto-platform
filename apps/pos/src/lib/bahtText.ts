import { formatBahtAmount, satangFromBaht } from '@oto/shared';

/**
 * SCRUM-933 — EVERY AMOUNT ON THE STAFF TILL, through the one formatter.
 *
 * The ported screens carry baht as numbers (`api/mappers.ts`), and wrote
 * them by hand: `฿{total}`, a code's discount `toFixed(0)`, a figure over 100.
 * With a 10 percent code on ฿1,605 that put the same money three ways on one
 * screen — the code's badge "-161", Total and Pay "1444.5", the customer
 * display "1,444.50". These read the figure to the satang and hand it to
 * `formatBahtAmount` (`@oto/shared`): a whole-baht amount reads exactly as it
 * always has ("1605"), an amount with satang shows its two places ("1444.50",
 * "160.50"), and nothing is rounded to the baht. The sign stays with the
 * caller (`฿{bahtText(total)}`), as it always was.
 */
export function bahtText(baht: number): string {
  return formatBahtAmount(satangFromBaht(baht));
}

/** The same, from satang — the ledger's own unit (`฿{satangText(grossSatang)}`). */
export function satangText(satang: number): string {
  return formatBahtAmount(Math.round(satang));
}
