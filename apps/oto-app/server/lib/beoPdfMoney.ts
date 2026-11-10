import { TILL_NOT_REACHABLE, bahtOfSatang, tillFiguresOf, tillProblemOf, type TillBillingReading } from "@shared/tillBilling";

/**
 * THE BEO PDF'S MONEY (SCRUM-822).
 *
 * The printed BEO's POS section is the editor's Party Details box on paper,
 * and its money is the till's, as on every BEO screen (shared/tillBilling.ts):
 * the total (Expected total before the party, Total once settled), the deposit
 * paid and what is outstanding, read from the platform when the PDF is made.
 * It used to print "POS Total" as Party Details' typed base price plus its
 * extras' prices and "Outstanding Balance" as that less the deposit, so the
 * printed BEO could disagree with the screen beside it (with the base price
 * left at 0, "POS Total 0฿ / Outstanding Balance -3,000฿"). Without the till
 * it prints why there is no figure ("Till not reachable") and no number.
 */

const esc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The POS section's money rows: the till's three figures, or the reason there are none. */
export function beoPdfTillMoneyHtml(reading: TillBillingReading | undefined, depositDate?: string): string {
  const figures = tillFiguresOf(reading);
  if (!figures) {
    const headline = tillProblemOf(reading)?.headline ?? TILL_NOT_REACHABLE;
    return `<table class="info-table" style="margin-top: 8px;" data-till-money="none">
          <tr><td style="font-weight: 600;">Party money:</td><td style="font-weight: 600; color: #b7791f;">${esc(headline)}</td></tr>
        </table>`;
  }
  const owed = figures.outstandingSatang > 0;
  const row = (label: string, value: string, style = "") =>
    `<tr><td${style ? ` style="${style}"` : ""}>${esc(label)}</td><td${style ? ` style="${style}"` : ""}>${esc(value)}</td></tr>`;
  return `<table class="info-table" style="margin-top: 8px;" data-till-money="${figures.kind}">
          ${row(figures.kind === "sale" ? "Total (from the till):" : "Expected total (from the till):", bahtOfSatang(figures.expectedSatang), "font-weight: 700;")}
          ${row("Deposit paid:", bahtOfSatang(figures.depositSatang), "color: #38a169;")}
          ${depositDate && figures.depositSatang > 0 ? row("Deposit Date:", depositDate) : ""}
          ${row("Outstanding:", bahtOfSatang(figures.outstandingSatang), `font-weight: 700; color: ${owed ? "#e53e3e" : "#38a169"};`)}
          ${figures.kind === "sale" && figures.receiptNumber ? row("Receipt:", figures.receiptNumber) : ""}
        </table>`;
}
