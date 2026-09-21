/**
 * What each printout is given.
 *
 * Money and times arrive **already formatted**. That is not laziness: this
 * package must produce the same bytes on a Raspberry Pi with no real-time clock
 * and on a cloud instance in whatever locale the container happens to have, so
 * it owns no clock, no timezone and no number formatter. Baht strings come from
 * `formatTHB` in `@oto/shared` — `฿1,090` whole, `฿1,090.50` otherwise — and
 * times from the caller's branch-timezone helpers. `test/money-contract.test.ts`
 * pins the fixture strings to what `formatTHB` actually emits, so the two
 * cannot drift.
 */

export interface PrintLine {
  qty: number;
  name: string;
  /** Pre-formatted, e.g. "฿700". Omitted on a prep ticket, which has no prices. */
  price?: string;
  note?: string;
}

export interface ReceiptData {
  /** The caps sub-title under the header, e.g. "Receipt". */
  title: string;
  /**
   * The abbreviated tax-invoice header block (S2-11).
   *
   * A slot, not a schema. PROJECT_CONTEXT §8 says the receipt-number prefix
   * scheme is still to be confirmed with the park's accountant against Thai
   * abbreviated tax-invoice rules, and the required fields
   * (ใบกำกับภาษีอย่างย่อ — seller name and TIN, the Thai document title, a
   * running number, date, description, the VAT-inclusive amount and a statement
   * that VAT is included) are settled in no repository document. Lines given
   * here print between the header and the receipt number.
   */
  taxInvoiceLines?: string[];
  /** Receipt number with its per-station prefix (PROJECT_CONTEXT §8). */
  receiptNumber?: string;
  dateTime?: string;
  staffName?: string;
  memberNickname?: string;
  lines: PrintLine[];
  subtotal?: string;
  service?: string;
  vat?: string;
  total: string;
  tenders?: { label: string; amount: string }[];
  /** Band codes issued by this sale, printed so staff can match band to sale. */
  bandCodes?: string[];
  /** "฿100 credit", "2× Grip socks to collect" — as the prototype phrases them. */
  creditGrants?: string[];
  /** F&B receipts carry only the whole-order note (`printRouting.tsx:180-184`). */
  orderNote?: string;
}

export interface PrepTicketData {
  /** `Kitchen` or `Bar` — the titles `lib/fnb.ts:204` gives them. */
  title: string;
  orderRef: string;
  time: string;
  holderName?: string;
  /** The band's allergy/medical text, before the "⚠ ALLERGY (name):" wrapper. */
  allergiesMedical?: string;
  lines: PrintLine[];
  orderNote?: string;
}

export type SupervisionMode = 'DROP-OFF' | 'NANNY';

export interface BandData {
  holderName?: string;
  supervisionMode?: SupervisionMode;
  /** e.g. "10:00 – 12:00" */
  startEndTime?: string;
  /** e.g. "2 hours · valid until 16:32" */
  duration?: string;
  partyName?: string;
  dietaryRequirement?: string;
  assignedNannyName?: string;
  /** Kids bands only; the adult template has no allergy field at all. */
  allergy?: string;
  /**
   * The signed band code — a station-prefixed ULID plus an HMAC (D4,
   * PROJECT_CONTEXT §8). Printed as a QR, because it does not fit a 1D strip.
   */
  bandCode?: string;
  /** The short human-readable code under the QR, e.g. "HKT-4821". */
  shortCode?: string;
}

export interface CreditVoucherData {
  /** Pre-formatted, e.g. "฿150". */
  balance?: string;
  /** The wallet key; the same QR resolves the wallet the band does. */
  qrCode?: string;
  holderName?: string;
}

export interface ItemVoucherData {
  /** e.g. "Free: Ice Cream Cone" */
  label: string;
  quantity: number;
  /**
   * Seeds from the grant id — the same seed the customer display uses, so the
   * printed slip and the on-screen QR resolve identically
   * (`printRouting.tsx:122-123`).
   */
  qrCode?: string;
}

/**
 * The booth voucher (S2-07a).
 *
 * **Nullable rather than optional, almost everywhere.** `staff`, `expiresAt`
 * and `prizeLineThai` are each a fact the booth genuinely may not have — nobody
 * was signed in, the prize never expires, the Thai name was never filled in —
 * and each is nullable in the shape it comes from: `SpinResponse.staffAccountId`
 * and `.expiresAt` in `@oto/shared`, `booth_prize.name_th` in the config
 * bundle. Optional (`?`) would let a caller reach the printer having simply
 * forgotten one, and the slip would come out silently short a row. Required and
 * nullable makes the caller write the word `null`, and the template prints a
 * visible answer for it.
 */
export interface BoothVoucherData {
  /** "Oto — Kids Play Park · Central Phuket" (DEVICE_INVENTORY §7). */
  venueLine: string;
  /** The prize in English — `booth_prize.name_en`, e.g. "150 THB VOUCHER". */
  prizeLine: string;
  /**
   * The same prize in Thai — `booth_prize.name_th`, which is nullable in the
   * bundle. Null prints the English line alone: a prize whose Thai name an
   * administrator has not filled in, not a rendering failure.
   */
  prizeLineThai: string | null;
  /** "Show this QR at OTO Reception and get 150 THB off your ticket order." */
  redemptionLine: string;
  /**
   * The terms, one line each — `promo.voucher_definition.terms_en` and
   * `terms_th`, both nullable columns, so an empty array is a real value and
   * prints no terms at all. That is the definition missing its terms, and the
   * place to fix it is the definition.
   */
  terms: string[];
  /**
   * Ten characters: two of booth prefix and eight drawn from the unambiguous
   * alphabet (D8, `boothCode` in `@oto/shared`). Printed twice — as the QR's
   * payload and as text under it — from this one string, so the two can never
   * disagree.
   */
  voucherCode: string;
  /**
   * When it was printed, date and time together, e.g. "17 Sep 2026 15:04".
   *
   * This is the sample's `Date` row and the specification's "issue time" at
   * finer grain: one fact, so one row. Formatted by the caller in the branch's
   * timezone — this package owns no clock (see the note at the top of the file)
   * and a booth box has no real-time clock to own one with.
   */
  issuedAt: string;
  /** Which booth printed it, e.g. "Central Phuket · G floor". */
  booth: string;
  /**
   * Name and staff code, e.g. "Nok (S-014)".
   *
   * **Null is expected, not exceptional.** A sign-in problem must never take
   * the booth down (`docs/features/booth.md`), so the wheel spins with nobody
   * signed in and the spin is flagged unattributed. The template prints that
   * on the slip rather than leaving the row off, because the row going missing
   * and the row saying "nobody" look identical to reception otherwise.
   */
  staff: string | null;
  /** Formatted by the caller. Null when the voucher never expires. */
  expiresAt: string | null;
  footerLine: string;
}

export interface TestPageData {
  deviceLabel: string;
  model: string;
  address: string;
  transport: string;
  /** As rendered, so a 512-dot unit is visibly a 512-dot unit. */
  widthDots: number;
  rendererVersion: string;
  fontVersions: string[];
  /** The templates currently seeded for the branch, by name. */
  seededTemplates: string[];
  /** A sample code, so the QR and the Code 128 are exercised at real sizes. */
  sampleCode: string;
}
