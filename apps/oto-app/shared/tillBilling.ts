import { z } from "zod";

/**
 * A PARTY'S MONEY, FROM THE TILL (SCRUM-822).
 *
 * The owner's ruling (10 November): one place for the money — the till's
 * payments are the ledger. The BEO's billing stays, mounted in the editor, but
 * the figures a party is quoted and charged are read from the till over the
 * platform's API (`GET /otoapp/parties/:eventId/billing`, with this app's
 * provisioning key: server/lib/tillBilling.ts), never worked out here:
 *
 *   - before the party is settled, the QUOTE: what the till's Settle form
 *     would show today — the package at the party's day price, the extras,
 *     add-ons, entertainment, the items the BEO added, free lines at 0, the
 *     deposit (the BEO's one figure, SCRUM-813) as paid in advance, the balance;
 *   - once settled, the SALE: the receipt number, its lines, the payments
 *     taken (the deposit among them), its totals, when and at which till.
 *
 * Every screen that shows a party's money — the Billing section's "From the
 * till" panel, the Party Details box, the Day-of view's POS section, the
 * view-only page, the BEO PDF and the Quote PDF — reads the same three figures
 * from here (`tillFiguresOf`). Money
 * arrives in SATANG and is shown in baht by `bahtOfSatang` only: a package
 * snapshot's satang read as baht printed ฿1,690,000 for a ฿16,900 package
 * (SCRUM-833). When the till cannot be reached the screens say so ("Till not
 * reachable"), never a figure of their own.
 */

const Int = z.number().int();

const TillLineSchema = z.object({
  role: z.string().nullable(),
  label: z.string(),
  quantity: Int,
  unitSatang: Int,
  totalSatang: Int,
});

/** The platform's answer (its `PartyBillingAnswerSchema`), as far as this app reads it. */
export const TillBillingSchema = z.object({
  eventId: z.string(),
  state: z.enum(["quote", "sale", "no_quote"]),
  park: z.object({ name: z.string(), branchName: z.string(), address: z.string().nullable() }),
  party: z.object({
    title: z.string(),
    date: z.string(),
    startTime: z.string().nullable(),
    endTime: z.string().nullable(),
    packageName: z.string().nullable(),
    kids: Int.nullable(),
    adults: Int.nullable(),
  }),
  quote: z
    .object({
      partyDate: z.string(),
      rateMode: z.enum(["weekday", "weekend"]),
      packageName: z.string(),
      lines: z.array(TillLineSchema),
      packageSatang: Int,
      totalSatang: Int,
      creditSatang: Int,
      depositSatang: Int,
      balanceSatang: Int,
      walkUps: Int,
      walkUpsSatang: Int,
    })
    .nullable(),
  sale: z
    .object({
      saleId: z.string(),
      settlementId: z.string(),
      state: z.enum(["open", "settled", "voided", "refunded"]),
      receiptNumber: z.string().nullable(),
      lines: z.array(TillLineSchema),
      payments: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          methodCode: z.string().nullable(),
          amountSatang: Int,
          deposit: z.boolean(),
          paidAt: z.string().nullable(),
        }),
      ),
      grossSatang: Int,
      paidSatang: Int,
      depositSatang: Int,
      outstandingSatang: Int,
      kids: Int,
      adults: Int,
      createdAt: z.string(),
      settledAt: z.string().nullable(),
      stationName: z.string().nullable(),
    })
    .nullable(),
  noQuote: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type TillBilling = z.infer<typeof TillBillingSchema>;
export type TillLine = z.infer<typeof TillLineSchema>;

/**
 * What `GET /api/events/:eventId/beo/till-billing` answers the browser: the
 * till's figures, or why there are none. Never a figure of the app's own.
 */
export type TillBillingReading =
  | { status: "ok"; billing: TillBilling; readAt: string }
  | { status: "not_reachable" | "not_linked" | "unconfigured"; message: string };

/** The words every screen shows when it has no figures from the till. */
export const TILL_NOT_REACHABLE = "Till not reachable";

/** The party's money as every screen shows it: from the till, in satang. */
export interface TillFigures {
  /** `quote` before the party is settled; `sale` once a settlement sale holds it. */
  kind: "quote" | "sale";
  /** What the party comes to: the quote's total, or the sale's gross. */
  expectedSatang: number;
  /** The deposit paid in advance, as the till reads it. */
  depositSatang: number;
  /** What is left to take at the till. */
  outstandingSatang: number;
  /** The package's own line (its price for the party's day). */
  packageSatang: number;
  packageName: string | null;
  lines: TillLine[];
  /** The sale's, once settled. */
  receiptNumber: string | null;
  saleState: "open" | "settled" | "voided" | "refunded" | null;
}

/** The three figures and the breakdown, or null when the till gave none (not reachable, or it cannot price the party). */
export function tillFiguresOf(reading: TillBillingReading | null | undefined): TillFigures | null {
  if (!reading || reading.status !== "ok") return null;
  const b = reading.billing;
  if (b.state === "quote" && b.quote) {
    return {
      kind: "quote",
      expectedSatang: b.quote.totalSatang,
      depositSatang: b.quote.depositSatang,
      outstandingSatang: b.quote.balanceSatang,
      packageSatang: b.quote.packageSatang,
      packageName: b.quote.packageName,
      lines: b.quote.lines,
      receiptNumber: null,
      saleState: null,
    };
  }
  if (b.state === "sale" && b.sale) {
    return {
      kind: "sale",
      expectedSatang: b.sale.grossSatang,
      depositSatang: b.sale.depositSatang,
      outstandingSatang: b.sale.outstandingSatang,
      packageSatang: b.sale.lines.filter((l) => l.role === "package").reduce((sum, l) => sum + l.totalSatang, 0),
      packageName: b.party.packageName,
      lines: b.sale.lines,
      receiptNumber: b.sale.receiptNumber,
      saleState: b.sale.state,
    };
  }
  return null;
}

/**
 * Why there are no figures, in words a screen shows under "Till not
 * reachable" (or the till's own refusal, for a party it cannot price); null
 * when there are figures.
 */
export function tillProblemOf(reading: TillBillingReading | null | undefined): { headline: string; detail: string } | null {
  if (!reading) return null;
  if (reading.status !== "ok") return { headline: TILL_NOT_REACHABLE, detail: reading.message };
  if (reading.billing.state === "no_quote") {
    return { headline: "No quote from the till", detail: reading.billing.noQuote?.message ?? "The till cannot price this party yet." };
  }
  return tillFiguresOf(reading) ? null : { headline: TILL_NOT_REACHABLE, detail: "The till's answer could not be read." };
}

/** Satang in baht, as the till writes money: "฿16,900", "฿125.50", "-฿3,000". */
export function bahtOfSatang(satang: number): string {
  const sign = satang < 0 ? "-" : "";
  const abs = Math.abs(Math.round(satang));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}฿${grouped}${cents ? `.${cents.toString().padStart(2, "0")}` : ""}`;
}
