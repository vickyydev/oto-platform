import { bandShortCode } from './band-code';
import { wallClockMinutesInTz } from './business-date';
import { isoDateInTz } from './dates';
import { formatTHB } from './money';
import { groupPrepTickets, type PrintKind } from './print';
import { summarizeTax, type TaxBreakdown } from './tax';

/**
 * WHAT A SALE PUTS ON PAPER — ONE COMPOSER, TWO FEEDERS (offline plan §2.5,
 * Round 4; S2-11).
 *
 * The receipt, the bands, the prep tickets and the item vouchers a finalised
 * sale prints are composed here from one snapshot of the sale, by pure
 * functions that own no clock, no database and no formatter of their own. The
 * platform feeds them the ledger's rows (`services/sale-printing.ts`, which
 * builds `SalePrintSnapshot` from `pos.sale`, its lines, its attempts and its
 * bands); a box with no internet feeds them the sale it has just finalised on
 * its own disk (`packages/box-agent`, `SaleQueue.record`). Same snapshot in,
 * same document out — so the paper a guest is handed at an offline counter is
 * the paper History would reprint, and the renderer (`@oto/print`) turns both
 * into the same bytes.
 *
 * THE ROUTING IS THE PROTOTYPE'S (`lib/printRouting.tsx`), ported rule by rule
 * when S2-11 wrote it for the platform and moved here unchanged:
 *
 *   - a TICKET sale: one receipt; a kids band per child and an adult band per
 *     adult; one item voucher per socks / add-on / free-item grant, grouped by
 *     label;
 *   - an F&B order: one receipt carrying only the whole-order note, and one
 *     prep ticket per station that has items — kitchen, then bar — each with
 *     the allergy line, its own items' notes and the order note;
 *   - a SHOP sale: the receipt.
 *
 * The document shapes are `@oto/print`'s (`templates/data.ts`), declared here
 * structurally because this package is read by browsers and that one is Node
 * only; `apps/api/test/sales-printing.test.ts` and the box's print queue hold
 * the two to one another.
 */

// --- What a sale is, for printing ------------------------------------------------

/** One line of the sale as the ledger files it: one priced unit. */
export interface SalePrintLine {
  /** The sale line's id (`deriveSaleLineId`), so a band and a voucher can name it. */
  id: string;
  /** The ledger's kind: `kids`, `adults_paid`, `socks`, `fnb_item`, `merch_item`… */
  kind: string;
  label: string;
  quantity: number;
  grossSatang: number;
  /** True on a ticket line's units (`ticket_package_id` set). */
  ticket: boolean;
  /** What the line carries beside its money — see `SaleLinePayload` in the api. */
  payload: {
    modifiers?: { optionName: string }[];
    variant?: { variantLabel: string };
    note?: string;
    prepStation?: string;
    pickupCode?: string;
  } | null;
  stayHours: number | null;
  stayDurationLabel: string | null;
}

/** Money taken, as the receipt lists it. Only tenders that took money belong here. */
export interface SalePrintTender {
  /** The configured token staff chose, else the ledger's method word. */
  method: string;
  last4: string | null;
  amountSatang: number;
  tenderedSatang: number | null;
  changeSatang: number | null;
}

/** A band the sale issued, with what its paper says about who wears it. */
export interface SalePrintBand {
  id: string;
  kind: 'kid' | 'adult';
  /** The signed code — a gate credential. Printed as the QR, never on the receipt. */
  code: string;
  saleLineId: string | null;
  childName: string | null;
  allergies: string | null;
  medicalNotes: string | null;
  dietary: string | null;
  /**
   * S2-13 — the supervision badge of a dropped-off or nanny-supervised child,
   * and the nanny assigned. Configured on the kids band template since the
   * prototype and never printed by it (R-50); printed now. Absent on every
   * band that is not a supervised child's, and on a box's offline snapshot
   * until round 4 carries it.
   */
  supervisionBadge?: 'DROP-OFF' | 'NANNY' | null;
  nannyName?: string | null;
}

/** A child on the order, for the kitchen's allergy line. */
export interface SalePrintChild {
  name: string;
  allergies: string | null;
  medicalNotes: string | null;
}

export interface SalePrintSnapshot {
  saleId: string;
  receiptNumber: string | null;
  /** When the sale closed (else when it was rung up), ISO. Every printed time is read from it. */
  at: string;
  /** The branch's zone. The composer owns no clock and no zone of its own. */
  timezone: string;
  operatorName: string | null;
  branchName: string | null;
  staffName: string | null;
  memberNickname: string | null;
  lines: SalePrintLine[];
  subtotalSatang: number;
  grossSatang: number;
  taxBreakdown: TaxBreakdown;
  tenders: SalePrintTender[];
  /** In the order they were minted. */
  bands: SalePrintBand[];
  orderChildren: SalePrintChild[];
  /**
   * SCRUM-494 — the child whose band the F&B order was taken against (the
   * design's `buildPrepTickets` reads the band holder). When present the prep
   * ticket carries this child's own name and allergy line and nobody else's.
   */
  bandHolder?: SalePrintBandHolder | null;
  note: string | null;
}

/** The band holder of an F&B order, for the prep ticket. */
export interface SalePrintBandHolder {
  name: string;
  /** Allergies and medical notes, joined; null when the parent declared none. */
  allergiesMedical: string | null;
}

// --- The documents (`@oto/print` `templates/data.ts`, structurally) ----------------

export interface SalePrintedLine {
  qty: number;
  name: string;
  price?: string;
  note?: string;
}

export interface SaleReceiptDocument {
  title: string;
  taxInvoiceLines?: string[];
  receiptNumber?: string;
  dateTime?: string;
  staffName?: string;
  memberNickname?: string;
  lines: SalePrintedLine[];
  subtotal?: string;
  service?: string;
  vat?: string;
  total: string;
  tenders?: { label: string; amount: string }[];
  bandCodes?: string[];
  creditGrants?: string[];
  orderNote?: string;
  /** Each row of `summarizeTax(sale.tax_breakdown)`: service, VAT included, VAT added. */
  taxRows?: { label: string; amount: string; kind: string }[];
  /** True on a copy History (or the box's reprint) asked for. */
  copy?: boolean;
}

export interface SalePrepDocument {
  title: string;
  orderRef: string;
  time: string;
  holderName?: string;
  allergiesMedical?: string;
  lines: SalePrintedLine[];
  orderNote?: string;
}

export interface SaleBandDocument {
  holderName?: string;
  duration?: string;
  dietaryRequirement?: string;
  allergy?: string;
  /** S2-13 — the badge on a supervised child's kids band. The template's own field names (`BandData`). */
  supervisionMode?: 'DROP-OFF' | 'NANNY';
  assignedNannyName?: string;
  bandCode?: string;
  shortCode?: string;
}

export interface SaleItemVoucherDocument {
  label: string;
  quantity: number;
}

export type SalePrintDocument =
  | { kind: 'receipt'; data: SaleReceiptDocument }
  | { kind: 'kitchen_ticket' | 'bar_ticket'; data: SalePrepDocument }
  | { kind: 'kids_wristband' | 'adult_wristband'; data: SaleBandDocument }
  | { kind: 'item_voucher'; data: SaleItemVoucherDocument };

/** One printout a sale owes, named by what it is about. */
export interface SalePrintRequest {
  kind: Extract<
    PrintKind,
    'receipt' | 'kitchen_ticket' | 'bar_ticket' | 'kids_wristband' | 'adult_wristband' | 'item_voucher'
  >;
  subjectType: 'sale' | 'band' | 'sale_line';
  subjectId: string;
}

// --- The small rules -----------------------------------------------------------------

/** The ticket units that are things to collect rather than admission (`buildCreditGrants`). */
const ITEM_VOUCHER_KINDS = new Set(['socks', 'addon', 'promo_item']);

function hhmm(instant: Date, timezone: string): string {
  const minutes = wallClockMinutesInTz(instant, timezone);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `2026-09-30 14:05` in the branch's own time. */
function stampIn(instant: Date, timezone: string): string {
  return `${isoDateInTz(instant, timezone)} ${hhmm(instant, timezone)}`;
}

function lineName(line: SalePrintLine): string {
  const payload = line.payload ?? {};
  const extras = [
    payload.variant?.variantLabel,
    ...(payload.modifiers ?? []).map((m) => m.optionName),
  ].filter((v): v is string => !!v);
  return extras.length ? `${line.label} (${extras.join(', ')})` : line.label;
}

function lineNote(line: SalePrintLine): string | undefined {
  const note = line.payload?.note?.trim();
  return note || undefined;
}

/** How a tender reads on the receipt: "Cash", "Card •••• 4242", "QR". */
function tenderLabel(tender: SalePrintTender): string {
  const token = tender.method;
  const word = token.charAt(0).toUpperCase() + token.slice(1).replace(/_/g, ' ');
  return tender.last4 ? `${word} •••• ${tender.last4}` : word;
}

/**
 * The allergy line for a prep ticket: each child's allergies and medical notes,
 * named. Every child on the order, because the kitchen cannot know which child
 * a plate is for and an allergy left off is the one mistake that matters.
 */
function allergyTextOf(rows: readonly SalePrintChild[]): string | undefined {
  const parts = rows
    .map((c) => {
      const bits = [c.allergies?.trim(), c.medicalNotes?.trim()].filter((v): v is string => !!v);
      return bits.length ? `${c.name}: ${bits.join('; ')}` : null;
    })
    .filter((v): v is string => v !== null);
  return parts.length ? parts.join(' · ') : undefined;
}

/** The item vouchers a ticket sale's lines owe: one per label, the first line standing for the group. */
export function saleItemVoucherGroups(
  lines: readonly SalePrintLine[],
): { lineId: string; label: string; quantity: number }[] {
  const groups = new Map<string, { lineId: string; label: string; quantity: number }>();
  for (const line of lines) {
    if (!line.ticket || !ITEM_VOUCHER_KINDS.has(line.kind) || line.quantity <= 0) continue;
    const found = groups.get(line.label);
    if (found) found.quantity += line.quantity;
    else groups.set(line.label, { lineId: line.id, label: line.label, quantity: line.quantity });
  }
  return [...groups.values()];
}

// --- The documents ---------------------------------------------------------------------

/**
 * The receipt, as the abbreviated tax invoice the park prints.
 *
 * The Thai title is the document's name under the Revenue Code; the seller's
 * tax id is the park's own footer line on the receipt template. The band codes
 * are the SHORT ones: a staff member matches a band to its sale by them, and a
 * receipt carrying the signed code would be a second gate credential.
 */
export function saleReceiptDocument(snapshot: SalePrintSnapshot, copy = false): SaleReceiptDocument {
  const rows = summarizeTax(snapshot.taxBreakdown);
  const included = rows.filter((r) => r.kind === 'tax_included').reduce((sum, r) => sum + r.amount, 0);
  const service = rows.filter((r) => r.kind === 'service').reduce((sum, r) => sum + r.amount, 0);
  const tenders: { label: string; amount: string }[] = [];
  for (const tender of snapshot.tenders) {
    tenders.push({ label: tenderLabel(tender), amount: formatTHB(tender.amountSatang) });
    if (tender.tenderedSatang !== null && tender.changeSatang !== null && tender.changeSatang > 0) {
      tenders.push({ label: 'Cash tendered', amount: formatTHB(tender.tenderedSatang) });
      tenders.push({ label: 'Change', amount: formatTHB(tender.changeSatang) });
    }
  }
  const hasFnb = snapshot.lines.some((l) => l.kind === 'fnb_item');
  const vouchers = saleItemVoucherGroups(snapshot.lines);
  const named = snapshot.operatorName && snapshot.branchName;
  return {
    title: copy ? 'Receipt (copy)' : 'Receipt',
    taxInvoiceLines: [
      'ใบกำกับภาษีอย่างย่อ',
      'ABBREVIATED TAX INVOICE',
      ...(named ? [`${snapshot.operatorName} · ${snapshot.branchName}`] : []),
      ...(included > 0 ? ['VAT included'] : []),
    ],
    receiptNumber: snapshot.receiptNumber ?? undefined,
    dateTime: stampIn(new Date(snapshot.at), snapshot.timezone),
    staffName: snapshot.staffName ?? undefined,
    memberNickname: snapshot.memberNickname || undefined,
    lines: snapshot.lines
      .filter((l) => l.quantity > 0)
      .map((l) => ({ qty: l.quantity, name: lineName(l), price: formatTHB(l.grossSatang), note: lineNote(l) })),
    subtotal: formatTHB(snapshot.subtotalSatang),
    service: service > 0 ? formatTHB(service) : undefined,
    vat: included > 0 ? formatTHB(included) : undefined,
    total: formatTHB(snapshot.grossSatang),
    tenders,
    bandCodes: snapshot.bands
      .map((b) => bandShortCode(b.code))
      .filter((c): c is string => c !== null),
    creditGrants: vouchers.map((v) => `${v.quantity}× ${v.label} to collect`),
    orderNote: hasFnb && snapshot.note ? snapshot.note : undefined,
    taxRows: rows.map((r) => ({ label: r.label, amount: formatTHB(r.amount), kind: r.kind })),
    copy,
  };
}

/** One prep station's ticket: its own items, the pick-up code and the allergy line. */
export function salePrepDocument(
  snapshot: SalePrintSnapshot,
  station: 'kitchen' | 'bar',
): SalePrepDocument {
  const lines = snapshot.lines.filter((l) => l.kind === 'fnb_item');
  const ticket = groupPrepTickets(
    lines.map((l) => ({ ...l, prepStation: l.payload?.prepStation ?? null })),
  ).find((t) => t.station === station);
  const pickup = lines[0]?.payload?.pickupCode;
  const at = new Date(snapshot.at);
  // An order taken against a band prints that band's holder and their own
  // allergy line (the design's `buildPrepTickets`), never a sibling's.
  const holder = snapshot.bandHolder ?? null;
  return {
    title: ticket?.title ?? (station === 'kitchen' ? 'Kitchen' : 'Bar'),
    orderRef: pickup ?? snapshot.receiptNumber ?? snapshot.saleId.slice(-6),
    time: hhmm(at, snapshot.timezone),
    holderName: holder ? holder.name || undefined : snapshot.memberNickname || undefined,
    allergiesMedical: holder
      ? holder.allergiesMedical?.trim() || undefined
      : allergyTextOf(snapshot.orderChildren),
    lines: (ticket?.lines ?? []).map((l) => ({ qty: l.quantity, name: lineName(l), note: lineNote(l) })),
    orderNote: snapshot.note ?? undefined,
  };
}

/** One band's paper: who wears it, for how long, what the gate reads. */
export function saleBandDocument(snapshot: SalePrintSnapshot, band: SalePrintBand): SaleBandDocument {
  const line = band.saleLineId ? snapshot.lines.find((l) => l.id === band.saleLineId) : undefined;
  const start = new Date(snapshot.at);
  const duration =
    line?.stayHours && line.stayHours > 0
      ? `${line.stayDurationLabel ?? `${line.stayHours} hours`} · valid until ${hhmm(
          new Date(start.getTime() + line.stayHours * 3_600_000),
          snapshot.timezone,
        )}`
      : (line?.stayDurationLabel ?? undefined);
  const allergy =
    band.kind === 'kid'
      ? [band.allergies?.trim(), band.medicalNotes?.trim()]
          .filter((v): v is string => !!v)
          .join('; ') || undefined
      : undefined;
  return {
    holderName:
      band.kind === 'kid' ? (band.childName ?? undefined) : snapshot.memberNickname || undefined,
    duration,
    dietaryRequirement: band.kind === 'kid' ? band.dietary?.trim() || undefined : undefined,
    allergy,
    ...(band.kind === 'kid' && band.supervisionBadge ? { supervisionMode: band.supervisionBadge } : {}),
    ...(band.kind === 'kid' && band.supervisionBadge && band.nannyName?.trim()
      ? { assignedNannyName: band.nannyName.trim() }
      : {}),
    bandCode: band.code,
    shortCode: bandShortCode(band.code) ?? undefined,
  };
}

/** An item voucher: the label and how many of it the sale owes. */
export function saleItemVoucherDocument(
  snapshot: SalePrintSnapshot,
  lineId: string,
): SaleItemVoucherDocument | null {
  const line = snapshot.lines.find((l) => l.id === lineId);
  if (!line) return null;
  const group = saleItemVoucherGroups(snapshot.lines).find((g) => g.label === line.label);
  return { label: line.label, quantity: group?.quantity ?? line.quantity };
}

/**
 * Everything a finalised sale prints, in the order it is asked for: the
 * receipt, the kids bands, the adult bands, the item vouchers, then one prep
 * ticket per station with items. A box that polls the oldest first prints the
 * receipt before the vouchers behind it.
 */
export function salePrintRequests(snapshot: SalePrintSnapshot): SalePrintRequest[] {
  const requests: SalePrintRequest[] = [
    { kind: 'receipt', subjectType: 'sale', subjectId: snapshot.saleId },
  ];
  if (snapshot.lines.some((l) => l.ticket)) {
    for (const band of snapshot.bands.filter((b) => b.kind === 'kid')) {
      requests.push({ kind: 'kids_wristband', subjectType: 'band', subjectId: band.id });
    }
    for (const band of snapshot.bands.filter((b) => b.kind === 'adult')) {
      requests.push({ kind: 'adult_wristband', subjectType: 'band', subjectId: band.id });
    }
    for (const group of saleItemVoucherGroups(snapshot.lines)) {
      requests.push({ kind: 'item_voucher', subjectType: 'sale_line', subjectId: group.lineId });
    }
  }
  const fnb = snapshot.lines.filter((l) => l.kind === 'fnb_item');
  for (const ticket of groupPrepTickets(
    fnb.map((l) => ({ id: l.id, prepStation: l.payload?.prepStation ?? null })),
  )) {
    requests.push({
      kind: ticket.station === 'kitchen' ? 'kitchen_ticket' : 'bar_ticket',
      subjectType: 'sale',
      subjectId: snapshot.saleId,
    });
  }
  return requests;
}

/** The document one request prints, or null when the snapshot has nothing for it. */
export function salePrintDocumentOf(
  snapshot: SalePrintSnapshot,
  request: SalePrintRequest,
  copy = false,
): SalePrintDocument | null {
  switch (request.kind) {
    case 'receipt':
      return { kind: 'receipt', data: saleReceiptDocument(snapshot, copy) };
    case 'kitchen_ticket':
    case 'bar_ticket':
      return {
        kind: request.kind,
        data: salePrepDocument(snapshot, request.kind === 'kitchen_ticket' ? 'kitchen' : 'bar'),
      };
    case 'kids_wristband':
    case 'adult_wristband': {
      const band = snapshot.bands.find((b) => b.id === request.subjectId);
      return band
        ? {
            kind: band.kind === 'kid' ? 'kids_wristband' : 'adult_wristband',
            data: saleBandDocument(snapshot, band),
          }
        : null;
    }
    case 'item_voucher': {
      const data = saleItemVoucherDocument(snapshot, request.subjectId);
      return data ? { kind: 'item_voucher', data } : null;
    }
  }
}
