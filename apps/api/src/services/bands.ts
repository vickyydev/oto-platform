import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm';
import { band, bandEvent, checkin, child, saleLine, ticketPackage, visitChild, type sale } from '@oto/db';
import {
  BAND_CODE_BODY_LENGTH,
  BAND_CODE_SIGNATURE_LENGTH,
  bandShortCode,
  mintBandCode,
  newId,
  normaliseBandCode,
  parseBandCode,
  parseBandShortCode,
  planLedgerBands,
  ulidFromUuid,
} from '@oto/shared';
import type { Exec, Tx } from './tx';

/**
 * S2-11 — the bands a ticket sale issues, minted inside finalisation.
 *
 * THE RULE BEING PORTED is the prototype's `sale.bracelets` (`lib/sale.ts:
 * 293-315`): one kids band per child ticket and one adult band per adult on
 * every ticket line, free adults included — `bracelets.adults` is the line's
 * whole `adults` count, not the paid part. `lib/printRouting.tsx:ticketPrintJobs`
 * then prints a kids group and an adult group; the codes are this file's.
 *
 * MINTED HERE FOR NOW, on the box later. The code format is already the one a
 * box verifies offline (`mintBandCode` in `@oto/shared`), and the minting moves
 * to the box with offline selling (SCRUM-269). Until then a band exists from
 * the moment the platform finalises its sale.
 */

// --- The key ------------------------------------------------------------------

let bandKey: string | null = null;

/**
 * Set once when the app is built (`buildApp`), from `resolveBandKey(env)`.
 *
 * Module state rather than a parameter because a sale finalises through four
 * doors — the till's press, a ฿0 comp's commit, the gateway's webhook and an
 * offline replay — and each has its own context object. The key is the
 * deployment's, not the request's, so it is held where every door can see it.
 */
export function configureBandKey(key: string | null): void {
  bandKey = key;
}

/** The key, or null when this deployment cannot mint a band. */
export function currentBandKey(): string | null {
  return bandKey;
}

// --- What a sale owes ---------------------------------------------------------

type SaleLineRow = typeof saleLine.$inferSelect;
type BandRow = typeof band.$inferSelect;

/** One band a sale owes: which kind, which ticket unit it is issued against, and its gate access. */
export interface PlannedBand {
  kind: 'kid' | 'adult';
  saleLineId: string | null;
  cartLineId: string | null;
  /** From the line's ticket package for an adult band; never for a kids band. */
  gateAccess: boolean;
}

/**
 * The bands a sale's ticket lines owe, in cart order: each cart line's kids,
 * then its adults. A kids band is issued against the line's `kids` unit; an
 * adult band against `adults_paid` for the paid adults and `adults_free` for
 * the free ones, falling back to any unit of the line when that row is absent
 * (a line whose adults were all free has no paid row).
 *
 * `gateAccess` is each ticket package's Gate access setting by package id
 * (`packageGateAccess`). An adult band takes its line's; a package missing
 * from the map reads as off, as the approved design's
 * `line.ticketType.gateAccess ?? false` does (`lib/sale.ts:buildPersonGrants`).
 */
export function planBands(
  lines: readonly SaleLineRow[],
  gateAccess: ReadonlyMap<string, boolean> = new Map(),
): PlannedBand[] {
  // The one rule, shared with a box that mints the bands of a sale it takes
  // with no internet (offline plan OD-13): the same lines owe the same bands.
  return planLedgerBands(
    lines.map((line) => ({
      id: line.id,
      cartLineId: line.cartLineId,
      kind: line.kind,
      ticket: line.ticketPackageId !== null,
      kidCount: line.kidCount,
      adultCount: line.adultCount,
      freeAdultCount: line.freeAdultCount,
      gateAccess: line.ticketPackageId ? gateAccess.get(line.ticketPackageId) === true : false,
    })),
  );
}

/**
 * The Gate access setting of every ticket package the lines name, by package
 * id — read when the bands are minted, so a band keeps the setting its ticket
 * had when it was issued (`mockApi.ts:issueWalkInBands`: "from the adult's
 * ticket package").
 */
export async function packageGateAccess(
  db: Exec,
  lines: readonly Pick<SaleLineRow, 'ticketPackageId'>[],
): Promise<Map<string, boolean>> {
  const ids = [...new Set(lines.map((l) => l.ticketPackageId).filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: ticketPackage.id, gateAccess: ticketPackage.gateAccess })
    .from(ticketPackage)
    .where(inArray(ticketPackage.id, ids));
  return new Map(rows.map((r) => [r.id, r.gateAccess]));
}
/** The children a sale's visit named, in the order reception confirmed them. */
async function visitChildrenOf(db: Exec, visitId: string | null): Promise<string[]> {
  if (!visitId) return [];
  const rows = await db
    .select({ childId: visitChild.childId })
    .from(visitChild)
    .innerJoin(child, eq(child.id, visitChild.childId))
    .where(and(eq(visitChild.visitId, visitId), isNull(child.archivedAt)))
    .orderBy(asc(visitChild.confirmedAt), asc(child.name));
  return rows.map((r) => r.childId);
}

export interface MintBandsResult {
  /** Every band the sale now has, oldest first — the ones it already had included. */
  bands: BandRow[];
  /** The ones this call minted. */
  minted: BandRow[];
}

/**
 * Mint whatever bands the sale still owes, and nothing it already has.
 *
 * Idempotent by construction: it counts the sale's existing bands of each kind
 * against the plan and mints only the difference, so a second call — a band
 * reprint on a sale finalised while this deployment had no key — issues the
 * missing bands and never a duplicate. Kids bands take the visit's children in
 * the order they were confirmed, skipping any child already banded on this
 * sale; a child ticket with no named child gets a band with no name on it.
 *
 * @throws when there is no key or the station has no code prefix; the caller
 *   decides whether that stops anything (finalisation: it does not).
 */
/**
 * S2-13 — THE SUPERVISED CHILDREN'S LINES, which finalisation leaves alone.
 *
 * A drop-off or nanny child's cart line is minted by the till under the id of
 * its `pos.checkin` row (`schema/checkin.ts`), so its sale lines carry
 * `cart_line_id = checkin.id`. Those children's bands wait for the check-in
 * choice the prototype makes after payment (`pages/Till.tsx:finalizeSale`,
 * which prints only the non-drop-off kids): "Check in now" mints them through
 * this same function with `checkins`, "Leave as booked" mints nothing.
 */
async function supervisedCheckinsOf(
  db: Exec,
  operatorId: string,
  lines: readonly SaleLineRow[],
): Promise<Map<string, string | null>> {
  const cartLineIds = [...new Set(lines.map((l) => l.cartLineId).filter((id): id is string => !!id))];
  if (cartLineIds.length === 0) return new Map();
  const rows = await db
    .select({ id: checkin.id, childId: checkin.childId })
    .from(checkin)
    .where(and(eq(checkin.operatorId, operatorId), inArray(checkin.id, cartLineIds)));
  return new Map(rows.map((r) => [r.id, r.childId]));
}

export interface MintSaleBandsOptions {
  /**
   * S2-13 — mint the bands of THESE supervised children and nothing else:
   * one kids band on each one's line, named for its child. Idempotent per
   * line — a line that already has its band is skipped.
   */
  checkins?: readonly { id: string; childId: string | null }[];
}

export async function mintSaleBands(
  tx: Tx,
  saleRow: typeof sale.$inferSelect,
  stationPrefix: string,
  scope: { stationId: string | null; boxId: string | null; now: Date },
  options: MintSaleBandsOptions = {},
): Promise<MintBandsResult> {
  const key = currentBandKey();
  if (!key) throw new BandKeyMissingError();
  const allLines = await tx
    .select()
    .from(saleLine)
    .where(eq(saleLine.saleId, saleRow.id))
    .orderBy(asc(saleLine.lineNo));
  const allExisting = await tx
    .select()
    .from(band)
    .where(eq(band.saleId, saleRow.id))
    .orderBy(asc(band.createdAt), asc(band.id));

  const supervised = await supervisedCheckinsOf(tx, saleRow.operatorId, allLines);
  const isSupervised = (line: SaleLineRow): boolean => !!line.cartLineId && supervised.has(line.cartLineId);
  const requested = options.checkins ? new Map(options.checkins.map((c) => [c.id, c.childId])) : null;
  // The lines this call owes bands for: the named check-ins' lines, or every
  // line that is NOT a supervised child's.
  const lines = requested
    ? allLines.filter((l) => !!l.cartLineId && requested.has(l.cartLineId))
    : allLines.filter((l) => !isSupervised(l));
  const lineIds = new Set(lines.map((l) => l.id));
  const existing = allExisting.filter((b) => (b.saleLineId ? lineIds.has(b.saleLineId) : !requested));
  const plan = planBands(lines, await packageGateAccess(tx, lines));
  const have = { kid: existing.filter((b) => b.kind === 'kid').length, adult: existing.filter((b) => b.kind === 'adult').length };
  const seen = { kid: 0, adult: 0 };
  const owed = requested
    ? plan.filter((p) => !existing.some((b) => b.saleLineId === p.saleLineId && b.kind === p.kind))
    : plan.filter((p) => {
        seen[p.kind] += 1;
        return seen[p.kind] > have[p.kind];
      });
  if (owed.length === 0) return { bands: allExisting, minted: [] };

  // A supervised child's band is named by its check-in; every other kids band
  // takes the visit's children in order — never one of the supervised ones,
  // whose bands are theirs to mint at check-in.
  const supervisedChildren = new Set([...supervised.values()].filter((id): id is string => !!id));
  const bandedChildren = new Set(allExisting.map((b) => b.childId).filter((id): id is string => !!id));
  const children = requested
    ? []
    : (await visitChildrenOf(tx, saleRow.visitId)).filter(
        (id) => !bandedChildren.has(id) && !supervisedChildren.has(id),
      );

  const minted: BandRow[] = [];
  let at = scope.now.getTime();
  for (const planned of owed) {
    const id = newId();
    const childId =
      planned.kind !== 'kid'
        ? null
        : requested
          ? (planned.cartLineId ? (requested.get(planned.cartLineId) ?? null) : null)
          : (children.shift() ?? null);
    const [row] = await tx
      .insert(band)
      .values({
        id,
        operatorId: saleRow.operatorId,
        branchId: saleRow.branchId,
        saleId: saleRow.id,
        saleLineId: planned.saleLineId,
        memberId: saleRow.memberId,
        childId,
        kind: planned.kind,
        gateAccess: planned.gateAccess,
        code: mintBandCode(stationPrefix, ulidFromUuid(id), key),
        status: 'active',
        // A millisecond apart, so "oldest first" is the order they were minted.
        createdAt: new Date(at),
        updatedAt: new Date(at),
      })
      .returning();
    at += 1;
    if (!row) throw new Error('the band was not written');
    await tx.insert(bandEvent).values({
      id: newId(),
      bandId: row.id,
      kind: 'minted',
      stationId: scope.stationId,
      boxId: scope.boxId,
      // The facts of the issue. Never the code: it is a gate credential.
      detail: { saleId: saleRow.id, saleLineId: planned.saleLineId, childId, gateAccess: planned.gateAccess },
      createdAt: new Date(row.createdAt.getTime()),
    });
    minted.push(row);
  }
  return { bands: [...allExisting, ...minted], minted };
}

// --- Event bands (S2-20 E3) -------------------------------------------------------

export interface MintEventBandsInput {
  operatorId: string;
  branchId: string;
  /** The check-in that issues them, and the group the kid follows. */
  eventCheckinId: string;
  /** The saved child the till pre-filled the attendee from, when it did. */
  childId: string | null;
  memberId: string | null;
  /** A parent band too: the parent is staying (`parentAttending`). */
  parentAttending: boolean;
  stationPrefix: string;
  stationId: string | null;
  boxId: string | null;
  now: Date;
  /** The facts of the issue for the `minted` event: the event and the attendee. Never a code. */
  detail: Record<string, unknown>;
}

/**
 * THE BANDS AN EVENT CHECK-IN ISSUES (`checkInEventAttendee`,
 * mockApi.ts:3808-3837): a kid band always — no gate access, its own allergy
 * and diet lines on paper — and, when the parent is attending, a parent band
 * that operates the gate. Both name the check-in (`event_checkin_id`), which is
 * the group the kid follows in the occupancy count, and neither names a sale.
 * Event bands carry no credit (nothing is granted here).
 *
 * Idempotent like `mintSaleBands`: a band the check-in already has is not
 * minted again, so a reprint of a check-in made while this deployment had no
 * key issues what is missing and never a second band.
 *
 * @throws `BandKeyMissingError` when there is no key; the caller decides.
 */
export async function mintEventBands(
  tx: Tx,
  input: MintEventBandsInput,
): Promise<{ kid: BandRow; parent: BandRow | null; minted: BandRow[] }> {
  const key = currentBandKey();
  if (!key) throw new BandKeyMissingError();
  if (!input.stationPrefix) throw new Error('the station has no code prefix');
  const existing = await tx
    .select()
    .from(band)
    .where(eq(band.eventCheckinId, input.eventCheckinId))
    .orderBy(asc(band.createdAt), asc(band.id));
  let kid = existing.find((b) => b.kind === 'kid') ?? null;
  let parent = existing.find((b) => b.kind === 'adult') ?? null;
  const minted: BandRow[] = [];
  let at = input.now.getTime();
  const mint = async (kind: 'kid' | 'adult'): Promise<BandRow> => {
    const id = newId();
    const [row] = await tx
      .insert(band)
      .values({
        id,
        operatorId: input.operatorId,
        branchId: input.branchId,
        saleId: null,
        eventCheckinId: input.eventCheckinId,
        saleLineId: null,
        memberId: input.memberId,
        childId: kind === 'kid' ? input.childId : null,
        kind,
        // The kid band never opens the gate; the parent band does.
        gateAccess: kind === 'adult',
        code: mintBandCode(input.stationPrefix, ulidFromUuid(id), key),
        status: 'active',
        createdAt: new Date(at),
        updatedAt: new Date(at),
      })
      .returning();
    at += 1;
    if (!row) throw new Error('the band was not written');
    await tx.insert(bandEvent).values({
      id: newId(),
      bandId: row.id,
      kind: 'minted',
      stationId: input.stationId,
      boxId: input.boxId,
      // The facts of the issue. Never the code: it is a gate credential.
      detail: { ...input.detail, eventCheckinId: input.eventCheckinId, gateAccess: kind === 'adult' },
      createdAt: new Date(row.createdAt.getTime()),
    });
    minted.push(row);
    return row;
  };
  if (!kid) kid = await mint('kid');
  if (input.parentAttending && !parent) parent = await mint('adult');
  return { kid, parent, minted };
}

/** No key, so no band. The sale still finalises; the answer says why no band printed. */
export class BandKeyMissingError extends Error {
  readonly code = 'BAND_KEY_MISSING';
  constructor() {
    super('This deployment has no band key, so no band can be issued');
    this.name = 'BandKeyMissingError';
  }
}

// --- Reading ------------------------------------------------------------------

/** A band as History and the sale detail show it: the short code, never the credential. */
export interface BandView {
  id: string;
  kind: 'kid' | 'adult';
  status: string;
  /** `T1-7KMQ4X` — what is printed under the QR and on the receipt. Not a credential. */
  shortCode: string | null;
  saleLineId: string | null;
  childId: string | null;
  childName: string | null;
  printedJobId: string | null;
  createdAt: string;
}

export async function bandsOfSale(db: Exec, saleId: string): Promise<BandView[]> {
  const rows = await db
    .select({ band, childName: child.name })
    .from(band)
    .leftJoin(child, eq(child.id, band.childId))
    .where(eq(band.saleId, saleId))
    .orderBy(asc(band.createdAt), asc(band.id));
  return rows.map(({ band: b, childName }) => ({
    id: b.id,
    kind: b.kind,
    status: b.status,
    shortCode: bandShortCode(b.code),
    saleLineId: b.saleLineId,
    childId: b.childId,
    childName: b.kind === 'kid' ? childName : null,
    printedJobId: b.printedJobId,
    createdAt: b.createdAt.toISOString(),
  }));
}

/**
 * The band a code or a short code names, inside one operator — History's
 * search box. A full code is matched exactly (the table stores it normalised);
 * a short code `T1-7KMQ4X` is matched on its prefix and the tail of its body,
 * which is how it was made. No signature check: the database is the authority
 * here, and History finds a band, it does not admit anybody.
 */
export async function findBandsByCode(
  db: Exec,
  operatorId: string,
  raw: string,
): Promise<BandRow[]> {
  const parsed = parseBandCode(raw);
  if (parsed) {
    return db
      .select()
      .from(band)
      .where(and(eq(band.operatorId, operatorId), eq(band.code, normaliseBandCode(raw))))
      .limit(5);
  }
  const short = parseBandShortCode(raw);
  if (!short) return [];
  /**
   * The short code is the prefix and the LAST six body characters, so the
   * code it came from is exactly: the prefix, 21 body characters, the tail, a
   * dot and 12 signature characters. `_` matches one character and neither
   * `_` nor `%` can occur in a band code, so this pattern is exact rather than
   * a fuzzy search — it matches only codes of that precise shape.
   */
  const pattern = `${short.prefix}${'_'.repeat(BAND_CODE_BODY_LENGTH - short.tail.length)}${short.tail}.${'_'.repeat(BAND_CODE_SIGNATURE_LENGTH)}`;
  return db
    .select()
    .from(band)
    .where(and(eq(band.operatorId, operatorId), like(band.code, pattern)))
    .orderBy(asc(band.createdAt))
    .limit(20);
}

/** Mark a band's paper replaced by a new print job: the band, its id and its code stay. */
export async function recordBandReprint(
  tx: Tx,
  row: BandRow,
  input: { printJobId: string; reason: string; stationId: string | null; boxId: string | null; accountId: string },
): Promise<void> {
  await tx.update(band).set({ printedJobId: input.printJobId, updatedAt: new Date() }).where(eq(band.id, row.id));
  await tx.insert(bandEvent).values({
    id: newId(),
    bandId: row.id,
    kind: 'reprinted',
    stationId: input.stationId,
    boxId: input.boxId,
    detail: {
      printJobId: input.printJobId,
      // The paper this one replaces. Null when the band had never printed.
      replacedPrintJobId: row.printedJobId,
      reason: input.reason,
      accountId: input.accountId,
    },
  });
}

/**
 * Revoke a sale's active bands when a refund takes it fully refunded (S2-11).
 * The status becomes `revoked` and a `revoked` band_event names the refund; the
 * band's id and code stay, so the paper still in a guest's hand is a credential
 * the gate refuses tomorrow. A band already replaced or revoked is left as it
 * is. Called inside the refund's own transaction; returns the ids revoked, for
 * the refund's audit row. A partial refund does not call this.
 */
export async function revokeSaleBands(
  tx: Tx,
  saleId: string,
  input: { refundId: string; reason: string; stationId: string | null; accountId: string },
): Promise<string[]> {
  const rows = await tx
    .select()
    .from(band)
    .where(and(eq(band.saleId, saleId), eq(band.status, 'active')));
  if (rows.length === 0) return [];
  const now = new Date();
  for (const row of rows) {
    await tx.update(band).set({ status: 'revoked', updatedAt: now }).where(eq(band.id, row.id));
    await tx.insert(bandEvent).values({
      id: newId(),
      bandId: row.id,
      kind: 'revoked',
      stationId: input.stationId,
      boxId: null,
      // The refund that killed it, and why. Never the code — it is a credential.
      detail: { refundId: input.refundId, reason: input.reason, accountId: input.accountId },
      createdAt: now,
    });
  }
  return rows.map((r) => r.id);
}

/** The bands of several sales, for a lookup: which sale each belongs to. */
export async function saleIdsOfBands(db: Exec, bandIds: readonly string[]): Promise<string[]> {
  if (bandIds.length === 0) return [];
  const rows = await db.select({ saleId: band.saleId }).from(band).where(inArray(band.id, [...bandIds]));
  // S2-20 E3 — an event band has no sale to name.
  return [...new Set(rows.map((r) => r.saleId).filter((id): id is string => id !== null))];
}
