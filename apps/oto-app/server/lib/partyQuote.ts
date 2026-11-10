import puppeteer from "puppeteer";
import { bahtOfSatang, type TillBilling } from "@shared/tillBilling";
import { wrapContentInDocument } from "../pdf";
import { formatParkSignedDate } from "../timezone-utils";

/**
 * THE QUOTE PDF (SCRUM-822): what a party is expected to come to, from the
 * till, on paper for the family.
 *
 * The figures are the till's quote (`GET /otoapp/parties/:eventId/billing`,
 * read by server/lib/tillBilling.ts): the package at the party's day price, the
 * extras, add-ons, entertainment and the items the BEO added, the free lines,
 * the deposit paid in advance and the balance. Nothing is added up here: every
 * amount on the page is one the till answered.
 *
 * Made with the PDF facility the BEO's own PDF uses (server/pdf.ts, Chromium
 * through Puppeteer): `wrapContentInDocument` lays the park's header (its
 * logo, name and address, as on the BEO PDF) over this content, and the page
 * is printed to A4. `partyQuoteContent` is the content alone, pure, so a
 * check reads exactly what the PDF says.
 */

const esc = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "Wednesday 18 November 2026" from "2026-11-18"; the text as given when it is not a day. */
export function quoteDayOf(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return date;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(at.getTime())) return date;
  return `${DAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** The words under the figures: what the quote is, and is not. */
export const QUOTE_VALIDITY_NOTE =
  "This quote is valid on the date it was issued: the figures are the park's for the party's day as they stand today, " +
  "for the guests shown. The final bill is settled at the till on the day, for the guests who come and anything added on the day.";

/**
 * The quote's content, from the till's answer in its `quote` state; null for
 * any other state (a settled party has a receipt, not a quote).
 */
export function partyQuoteContent(billing: TillBilling, issuedAt: Date): string | null {
  const q = billing.quote;
  if (billing.state !== "quote" || !q) return null;
  const p = billing.party;
  const time = p.startTime ? `${p.startTime.slice(0, 5)}${p.endTime ? ` – ${p.endTime.slice(0, 5)}` : ""}` : null;
  const guests = [
    p.kids != null ? `${p.kids} ${p.kids === 1 ? "child" : "children"}` : null,
    p.adults != null ? `${p.adults} ${p.adults === 1 ? "adult" : "adults"}` : null,
  ].filter(Boolean).join(", ");
  const row = (label: string, value: string) =>
    `<tr><td style="padding: 3px 12px 3px 0; color: #4a5568;">${esc(label)}</td><td style="padding: 3px 0; font-weight: 600;">${esc(value)}</td></tr>`;
  const lines = q.lines
    .map(
      (l) => `<tr data-quote-line="">
        <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${esc(l.label)}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; text-align: right;">${l.quantity}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; text-align: right;">${l.totalSatang === 0 ? "Included" : esc(bahtOfSatang(l.totalSatang))}</td>
      </tr>`,
    )
    .join("");
  const total = (label: string, value: string, strong = false) =>
    `<tr><td colspan="2" style="padding: 6px 8px; text-align: right;${strong ? " font-weight: 700;" : ""}">${esc(label)}</td><td style="padding: 6px 8px; text-align: right;${strong ? " font-weight: 700;" : ""}">${esc(value)}</td></tr>`;
  return `
<h1>Party quote</h1>
<p style="color: #4a5568;">Issued ${esc(formatParkSignedDate(issuedAt))} &middot; ${esc(billing.park.name)}, ${esc(billing.park.branchName)}</p>
<table style="border-collapse: collapse; margin-bottom: 16px;">
  ${row("Party", p.title)}
  ${row("Date", quoteDayOf(p.date))}
  ${time ? row("Time", time) : ""}
  ${guests ? row("Guests", guests) : ""}
  ${row("Package", `${q.packageName} (${q.rateMode} price)`)}
</table>
<h2>What the party comes to</h2>
<table style="border-collapse: collapse; width: 100%;">
  <thead>
    <tr>
      <th style="text-align: left; padding: 6px 8px; border-bottom: 2px solid #1a365d;">Item</th>
      <th style="text-align: right; padding: 6px 8px; border-bottom: 2px solid #1a365d;">Qty</th>
      <th style="text-align: right; padding: 6px 8px; border-bottom: 2px solid #1a365d;">Amount</th>
    </tr>
  </thead>
  <tbody>${lines}</tbody>
  <tfoot>
    ${total("Total", bahtOfSatang(q.totalSatang), true)}
    ${total("Deposit paid", q.depositSatang > 0 ? `-${bahtOfSatang(q.depositSatang)}` : bahtOfSatang(0))}
    ${total("Balance to pay", bahtOfSatang(q.balanceSatang), true)}
  </tfoot>
</table>
${q.creditSatang > 0 ? `<p>Includes ${esc(bahtOfSatang(q.creditSatang))} of food and drink credit, given when the bill is paid.</p>` : ""}
<p style="margin-top: 24px; font-size: 12px; color: #4a5568;">${esc(QUOTE_VALIDITY_NOTE)}</p>`;
}

/** The quote, printed to an A4 PDF under the park's header, as the BEO PDF is. */
export async function generatePartyQuotePdf(
  content: string,
  header: { name: string; address: string; logoUrl?: string },
): Promise<Buffer> {
  const html = await wrapContentInDocument(content, header);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const bytes = await page.pdf({
      format: "A4",
      margin: { top: "15mm", right: "15mm", bottom: "15mm", left: "15mm" },
      printBackground: true,
    });
    return Buffer.from(bytes);
  } finally {
    await browser.close();
  }
}
