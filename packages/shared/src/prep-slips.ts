import { PARTY_SLIP_HEADING, type PartySlipDocument, type PartySlipLine, type PartySlipStation } from './party-slips';
import { PREP_TICKET_TITLE, PRINTING_PREP_STATIONS, type PrintingPrepStation } from './print';
import { salePrepDocument, type SalePrintSnapshot } from './sale-print';

/**
 * SCRUM-861 — A VOID SLIP AND AN UPDATED-ITEMS SLIP REACH THE KITCHEN AND THE
 * BAR (the owner, 8 and 12 November: "When an order, or an item in a birthday
 * package, is cancelled, send a void receipt and an updated-items receipt to
 * the kitchen and bar").
 *
 * A kitchen or bar ticket prints once, when the sale closes (`salePrintRequests`),
 * and a party's slips print once at the party's slip time (`composePartySlips`).
 * What the station is told AFTER that is composed here, by pure functions, so
 * the api's refund, its party job and a test all read the same paper:
 *
 *   - a VOID slip: the lines that station no longer makes — a cancelled
 *     order's lines, the lines a partial refund took off, a party dish the
 *     BEO removed or cut down — headed VOID, with the original order's
 *     number (or the party's name), the time, and who voided it;
 *   - an UPDATED slip: what that station still has to make after the change,
 *     headed UPDATED with the same number — the whole remaining ticket, so the
 *     kitchen works from one piece of paper and not from a ticket and a
 *     correction side by side.
 *
 * A station with no line affected gets nothing. A station whose every line
 * went gets the VOID slip alone: there is nothing to list as still to make.
 *
 * THE SLIP IS THE PREP TICKET (`PrepTicketData` in `@oto/print`) with three
 * things on it a plain ticket lacks: `variant`, which the renderer draws as
 * an inverted VOID or UPDATED band under the header; `details`, the "voided
 * by" lines; and a `title` that carries the word too. The title is there for
 * a box whose renderer predates `variant`: it prints the title it knows at
 * the top of every ticket, so even an un-updated box never hands the kitchen
 * a void slip that reads like a fresh order.
 */

export const PREP_SLIP_VARIANTS = ['void', 'updated'] as const;
export type PrepSlipVariant = (typeof PREP_SLIP_VARIANTS)[number];

/** What caused the slips: a sale's refund, or a party's plan changing after its slips printed. */
export const PREP_SLIP_SOURCES = ['refund', 'party'] as const;
export type PrepSlipSource = (typeof PREP_SLIP_SOURCES)[number];

/** Queued to the station's printer of its kind, or not: no box, or no printer of that kind on the station. */
export const PREP_SLIP_STATUSES = ['printed', 'no_printer'] as const;
export type PrepSlipStatus = (typeof PREP_SLIP_STATUSES)[number];

/** The word the slip is headed with, as the renderer prints it. */
export const PREP_SLIP_WORD: Record<PrepSlipVariant, string> = { void: 'VOID', updated: 'UPDATED' };

/** "VOID — Kitchen": the ticket's title with the word in front, for every renderer generation. */
export function prepSlipTitle(station: PrintingPrepStation, variant: PrepSlipVariant): string {
  return `${PREP_SLIP_WORD[variant]} — ${PREP_TICKET_TITLE[station]}`;
}

/** What the slip says about a party whose plan changed, and about one that was cancelled. */
export const PARTY_PLAN_CHANGED = 'Plan changed in the OTO App';
export const PARTY_CANCELLED = 'Party cancelled';

/**
 * A void or updated slip, as the prep ticket's document with its variant: the
 * renderer draws `variant`, `heading`, `details` and READY BY on a ticket that
 * carries them, and a box released before them prints the rest, title first.
 */
export interface PrepSlipDocument {
  /** `VOID — Kitchen`, `UPDATED — Bar` (`prepSlipTitle`). */
  title: string;
  variant: PrepSlipVariant;
  /** A party's slip says "Birthday party"; a sale's has none and prints its order number with a `#`. */
  heading?: string;
  /** The original order's number (its pickup code, else its receipt number), or the party's name. */
  orderRef: string;
  /** When the void or the change was made, "HH:MM" on the park's clock. */
  time: string;
  holderName?: string;
  allergiesMedical?: string;
  /** Who voided it and the refund's number; a party's room and children, and that its plan changed. */
  details: string[];
  readyBy?: string;
  readyByNote?: string;
  lines: PartySlipLine[];
  orderNote?: string;
}

/** A station's pair: the void slip, the updated slip; null where there is nothing of that kind to print. */
export interface PrepSlipPair {
  void: PrepSlipDocument | null;
  updated: PrepSlipDocument | null;
}
export type PrepSlipsByStation = Record<PrintingPrepStation, PrepSlipPair>;

/** The order the slips are queued in: the kitchen's before the bar's, each station's void before its updated. */
export function prepSlipTargets(
  slips: PrepSlipsByStation,
): { station: PrintingPrepStation; variant: PrepSlipVariant; document: PrepSlipDocument }[] {
  const out: { station: PrintingPrepStation; variant: PrepSlipVariant; document: PrepSlipDocument }[] = [];
  for (const station of PRINTING_PREP_STATIONS) {
    for (const variant of PREP_SLIP_VARIANTS) {
      const document = slips[station][variant];
      if (document) out.push({ station, variant, document });
    }
  }
  return out;
}

const emptyPair = (): PrepSlipPair => ({ void: null, updated: null });

// --- A sale's refund ----------------------------------------------------------------

export interface RefundPrepSlipsInput {
  /** The sale as the composer reads it (`salePrintSnapshotOf`): its lines, its holder, its allergy line. */
  snapshot: SalePrintSnapshot;
  refund: {
    /** `T1-R-000003`, as History shows it. */
    number: string;
    /** The sale lines this refund covers, by id. Empty for a custom amount. */
    coveredLineIds: readonly string[];
    /** The lines earlier refunds of the same sale covered. */
    earlierLineIds: readonly string[];
    /** True when this refund takes everything the sale had left: every standing line is cancelled. */
    full: boolean;
    /** Who approved it, by name; null when nothing names the account. */
    byName: string | null;
  };
  /** When the refund was made, "HH:MM" on the park's clock. */
  time: string;
}

/** The prep station a sale line was routed to at its close; null for `none`, which prints nowhere. */
function stationOfLine(line: SalePrintSnapshot['lines'][number]): PrintingPrepStation | null {
  const station = line.payload?.prepStation ?? 'kitchen';
  return station === 'kitchen' || station === 'bar' ? station : null;
}

/**
 * The slips a refund sends: for each station, a VOID slip of the lines the
 * refund cancelled there and an UPDATED slip of what it still has to make.
 *
 *   - the whole sale, or a refund that empties it (`full`): every line still
 *     standing is cancelled, on the VOID slip of its station; no UPDATED slip;
 *   - chosen lines: those lines on their station's VOID slip, and that
 *     station's UPDATED slip lists the lines no refund has touched;
 *   - a custom amount that leaves the sale open names no line, so no station
 *     is affected and nothing prints — the order stands as it was.
 *
 * Each slip is the station's ordinary prep ticket (`salePrepDocument`) over
 * the lines in question, so the holder, the allergy line and the order note
 * print on it exactly as they did on the ticket it corrects.
 */
export function refundPrepSlips(input: RefundPrepSlipsInput): PrepSlipsByStation {
  const { snapshot, refund } = input;
  const covered = new Set(refund.coveredLineIds);
  const earlier = new Set(refund.earlierLineIds);
  const fnb = snapshot.lines.filter((l) => l.kind === 'fnb_item' && stationOfLine(l) !== null);
  const standing = fnb.filter((l) => !earlier.has(l.id));
  const cancelled = refund.full ? standing : standing.filter((l) => covered.has(l.id));
  const remaining = refund.full ? [] : standing.filter((l) => !covered.has(l.id));
  const by = refund.byName?.trim() || 'staff';

  const out: PrepSlipsByStation = { kitchen: emptyPair(), bar: emptyPair() };
  for (const station of PRINTING_PREP_STATIONS) {
    const cancelledHere = cancelled.filter((l) => stationOfLine(l) === station);
    if (cancelledHere.length === 0) continue;
    const voided = salePrepDocument({ ...snapshot, lines: cancelledHere }, station);
    out[station].void = {
      ...voided,
      title: prepSlipTitle(station, 'void'),
      variant: 'void',
      time: input.time,
      details: [`Voided by ${by}`, `Refund ${refund.number}`],
    };
    const remainingHere = remaining.filter((l) => stationOfLine(l) === station);
    if (remainingHere.length === 0) continue;
    const updated = salePrepDocument({ ...snapshot, lines: remainingHere }, station);
    out[station].updated = {
      ...updated,
      title: prepSlipTitle(station, 'updated'),
      variant: 'updated',
      time: input.time,
      details: [`Still to make after refund ${refund.number}`, `Updated by ${by}`],
    };
  }
  return out;
}

// --- A party's plan, changed after its slips printed --------------------------------

/**
 * What a station holds: the fingerprint of the slip it was last given (of the
 * plain slip, before any VOID or UPDATED dressing), its lines, and the name
 * the slip carried. Null when it was last given nothing.
 */
export interface PartySlipHeld {
  fingerprint: string;
  lines: readonly PartySlipLine[];
  orderRef: string;
}

export interface PartyPrepSlipsInput {
  /** What each station was last given; null when it was given nothing. */
  before: Record<PartySlipStation, PartySlipHeld | null>;
  /** What the plan says now, composed as the slips are; ignored when the party is cancelled. */
  after: Record<PartySlipStation, PartySlipDocument | null>;
  cancelled: boolean;
  /** When the change was seen, "HH:MM" on the park's clock. */
  time: string;
}

/** A dish's name as the kitchen reads it: case and spacing aside. */
const foldName = (name: string): string => name.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');

/** The lines of a slip, folded by name and note, their counts summed (a dish with no count is `null`). */
function tallyOf(lines: readonly PartySlipLine[]): Map<string, { line: PartySlipLine; qty: number | null }> {
  const out = new Map<string, { line: PartySlipLine; qty: number | null }>();
  for (const line of lines) {
    const key = `${foldName(line.name)}|${line.note?.trim() ?? ''}`;
    const held = out.get(key);
    if (!held) out.set(key, { line, qty: line.qty ?? null });
    else if (held.qty !== null && line.qty !== undefined) held.qty += line.qty;
    else held.qty = null;
  }
  return out;
}

/**
 * The lines a station lost between two slips: a dish no longer on the slip,
 * whole; one with a smaller count, by the difference; a dish printed with no
 * count that is gone. A dish added, or counted up, is not a loss and appears
 * on the UPDATED slip alone.
 */
export function partySlipLinesRemoved(
  before: readonly PartySlipLine[],
  after: readonly PartySlipLine[],
): PartySlipLine[] {
  const was = tallyOf(before);
  const now = tallyOf(after);
  const removed: PartySlipLine[] = [];
  for (const [key, b] of was) {
    const a = now.get(key);
    if (!a) {
      removed.push(b.line);
      continue;
    }
    if (b.qty !== null && a.qty !== null && b.qty > a.qty) removed.push({ ...b.line, qty: b.qty - a.qty });
  }
  return removed;
}

/** A value as one stable string: object keys in order at every depth, so a jsonb round trip reads the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** A slip's content as a short stable string, the printed time left out: two slips that say the same thing match. */
export function partySlipFingerprint(document: PartySlipDocument | null): string {
  if (!document) return 'none';
  const { time: _time, ...rest } = document;
  return fnv1a(canonical(rest));
}

/** 64 bits of FNV-1a as sixteen hex digits: a fingerprint, not a credential. */
function fnv1a(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x811c9dc5 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * The slips a party's change sends: for each station whose slip would now read
 * differently, a VOID slip of what it lost and an UPDATED slip of the whole
 * slip as the plan now has it. A cancelled party sends every station that had
 * lines its VOID slip and nothing else. A station whose slip is unchanged — the
 * BEO added a drink and the kitchen's food stands — gets nothing.
 */
export function partyPrepSlips(input: PartyPrepSlipsInput): PrepSlipsByStation {
  const out: PrepSlipsByStation = { kitchen: emptyPair(), bar: emptyPair() };
  for (const station of PRINTING_PREP_STATIONS) {
    const before = input.before[station];
    const after = input.cancelled ? null : input.after[station];
    if ((before?.fingerprint ?? partySlipFingerprint(null)) === partySlipFingerprint(after)) continue;
    const removed = partySlipLinesRemoved(before?.lines ?? [], after?.lines ?? []);
    const orderRef = before?.orderRef ?? after?.orderRef;
    if (removed.length > 0 && orderRef) {
      out[station].void = {
        title: prepSlipTitle(station, 'void'),
        variant: 'void',
        heading: PARTY_SLIP_HEADING,
        orderRef,
        time: input.time,
        details: [input.cancelled ? PARTY_CANCELLED : PARTY_PLAN_CHANGED],
        lines: removed,
      };
    }
    if (after) {
      out[station].updated = {
        ...after,
        title: prepSlipTitle(station, 'updated'),
        variant: 'updated',
        time: input.time,
        details: [PARTY_PLAN_CHANGED, ...after.details],
      };
    }
  }
  return out;
}
