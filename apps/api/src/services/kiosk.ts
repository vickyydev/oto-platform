import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  band,
  booking,
  boxState,
  branch,
  deviceCredential,
  kioskSession,
  operator,
  printJob,
  station,
  type Db,
} from '@oto/db';
import {
  KIOSK_REASONS,
  KIOSK_REDEEM_SCOPE,
  bandShortCode,
  newId,
  type KioskDeviceScope,
  type KioskRedeemAnswer,
  type KioskRedeemRequest,
  type KioskSessionOutcome,
} from '@oto/shared';
import type { PrintNowOptions, PrintNowOutcome, PrintRequest } from '@oto/box-agent';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { inProcessBox } from './box';
import { redeemBookingAtCounter } from './booking-redemption';
import {
  linesOf,
  loadBookingByQr,
  readBookings,
  redemptionView,
  type BookingRow,
  type RedemptionView,
} from './bookings';
import { buildPrintDocument } from './sale-printing';
import { withTx, type OpContext } from './tx';
import { grantsOfSale } from './wallet';

/**
 * S2-20 K1 (SCRUM-217) — THE SELF-SERVICE KIOSK'S REDEMPTION CORE.
 *
 * A family scans their booking QR at a kiosk. Their bands print and their
 * wallet credit is loaded — or, for a drop-off or nanny child, they are sent
 * to the staff desk. The prototype has no kiosk; the authority is the
 * events-kiosk plan (`docs/progress/plans/events-kiosk/PLAN.md` §5, §8, §10, the
 * K1 row of §9), PROJECT_CONTEXT §7.6 and R-80.
 *
 * ONE REDEMPTION, TWO SURFACES. Nothing here prices a ticket, claims a booking,
 * mints a band or grants credit: `redeemBookingAtCounter` does all of that, as
 * it does for the till — the same claim under the booking's row lock, the same
 * sale at the prices the family paid, the same paid-online tender, the same
 * bands and grants. What the kiosk adds is three things the ticket asks for
 * and a counter does not need:
 *
 *   1. THE SUPERVISED SPLIT (R-80). A drop-off or nanny child is never issued
 *      here. A booking that is nothing but supervised children issues nothing
 *      and sends the family to the desk; a mixed booking is redeemed exactly
 *      as the till redeems it — the regular bands come out here, and the
 *      supervised children are left booked for the desk's "Check in now",
 *      which is where their bands are minted (S2-13).
 *
 *   2. ISSUE, THEN PRINT, THEN COMMIT. The till's paper is a box command
 *      collected after its sale commits; a jammed printer there is a reprint.
 *      An unattended kiosk cannot work that way: bands that never came out
 *      are a family at a dead screen holding a redeemed booking. So here the
 *      redemption's transaction stays open while the kiosk box prints its
 *      jobs (`printNow` — routed, rendered and every printer asked first), and
 *      it commits only when every job came out. A printer fault, paper out or
 *      a box that is not reachable rolls the whole of it back: no claim, no
 *      sale, no band, no grant. The booking stays paid and unredeemed, the
 *      session is `failed` with the reason, and the till can redeem it.
 *
 *   3. NO PERSON. The actor is the kiosk's paired credential, carrying
 *      `pos:kiosk:redeem` (a device scope no role holds), and the sale names
 *      it (`pos.sale.device_credential_id`). A press is idempotent by its
 *      action id, kept on the session row (`kiosk_session_action_unique`): the
 *      same press sent twice is answered from the row and issues nothing again.
 *
 * WHAT THE KIOSK IS NEVER TOLD (R-58, H15): an allergy, a medical note, a
 * name, a phone or a guardian. The answer is `KioskRedeemAnswerSchema`, strict.
 *
 * THE PRINTER IS REACHED IN THIS PROCESS — the virtual kiosk box, the agent
 * the api runs. A Raspberry Pi kiosk is reached through its own box and is
 * S2-24's (`KioskPrinter` is the seam); until then a kiosk whose box is not
 * running here is a box offline, and its redemption is called off like one.
 */

// --- The kiosk's credential ---------------------------------------------------

/** One refusal for every way of not being a paired kiosk, as the display and the booth have. */
export const kioskUnpaired = (): AppError =>
  new AppError(401, 'KIOSK_UNPAIRED', 'This screen is not paired to a kiosk');

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The paired kiosk behind a request, for the route that declared `credential: 'kiosk'`. */
export interface KioskDeviceAuth {
  credentialId: string;
  label: string | null;
  /** The kiosk station the credential is paired to — `kind = 'kiosk'`, never archived. */
  station: typeof station.$inferSelect;
}

/**
 * Who is calling, from `Authorization: Bearer <secret>`: the 256-bit secret a
 * kiosk is given when it is paired, 64 hex characters, stored only as its hash.
 *
 * Live checks on every call, as the display's (`authenticateDisplay`): the
 * credential is a kiosk's, paired, not revoked, carrying the scope this route
 * needs; its station is a kiosk, not archived, at a branch and operator that
 * are not archived. Any miss is the same 401, so a caller learns nothing
 * about which secrets exist. `last_seen_at` is written on a hit, outside any
 * transaction, as the booth's is.
 */
export async function authenticateKiosk(
  db: Db,
  authorization: string | undefined,
  scope: KioskDeviceScope = KIOSK_REDEEM_SCOPE,
): Promise<KioskDeviceAuth> {
  const match = /^Bearer ([0-9a-f]{64})$/i.exec(authorization ?? '');
  if (!match) throw kioskUnpaired();
  const hash = sha256Hex(match[1]!.toLowerCase());
  const [row] = await db
    .select({ credential: deviceCredential, station })
    .from(deviceCredential)
    .innerJoin(
      station,
      and(
        eq(deviceCredential.stationId, station.id),
        eq(deviceCredential.operatorId, station.operatorId),
        eq(deviceCredential.branchId, station.branchId),
      ),
    )
    .innerJoin(branch, and(eq(branch.id, station.branchId), eq(branch.operatorId, station.operatorId)))
    .innerJoin(operator, eq(operator.id, station.operatorId))
    .where(
      and(
        eq(deviceCredential.secretHash, hash),
        eq(deviceCredential.kind, 'kiosk'),
        isNull(deviceCredential.revokedAt),
        isNull(station.archivedAt),
        isNull(branch.archivedAt),
        isNull(operator.archivedAt),
      ),
    )
    .limit(1);
  const stored = row?.credential.secretHash ?? '';
  const same =
    stored.length === hash.length && timingSafeEqual(Buffer.from(stored, 'utf8'), Buffer.from(hash, 'utf8'));
  if (
    !row ||
    !same ||
    !row.credential.pairedAt ||
    row.station.kind !== 'kiosk' ||
    !row.credential.scopes.includes(scope)
  ) {
    throw kioskUnpaired();
  }
  await db
    .update(deviceCredential)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(deviceCredential.id, row.credential.id), isNull(deviceCredential.revokedAt)));
  return { credentialId: row.credential.id, label: row.credential.label, station: row.station };
}

// --- The kiosk's printer --------------------------------------------------------

/** How the redemption reaches the kiosk box's printers: now, or not at all. */
export interface KioskPrinter {
  printNow(requests: readonly PrintRequest[], options?: PrintNowOptions): Promise<PrintNowOutcome>;
}

/**
 * The kiosk box's printer, or why it cannot be reached.
 *
 * Offline is three different facts, and each calls the redemption off: the
 * Console's offline switch for the box (`edge.box_state.offline`), a box that
 * is not running in this process (a Pi kiosk, or an api instance without the
 * edge role), and a box whose own link to the platform is down.
 */
async function kioskPrinterOf(db: Db, boxId: string | null): Promise<KioskPrinter | null> {
  if (!boxId) return null;
  const [state] = await db
    .select({ offline: boxState.offline })
    .from(boxState)
    .where(eq(boxState.boxId, boxId))
    .limit(1);
  if (state?.offline) return null;
  const agent = inProcessBox(boxId);
  if (!agent || !agent.state.linkUp || agent.state.offline) return null;
  const printing = agent.printing();
  return printing ? { printNow: (requests, options) => printing.printNow(requests, options) } : null;
}

// --- Stopping -------------------------------------------------------------------

/**
 * A kiosk redemption that cannot go on: a refusal before the claim, a print
 * fault after it. Thrown inside the transaction, it rolls the whole redemption
 * back; caught outside, it ends the session `failed`.
 */
class KioskStop extends Error {
  /** `withTx` names a failed operation by its `code`. */
  readonly code: string;

  constructor(
    readonly reason: string,
    readonly stage: 'lookup' | 'claim' | 'print',
    readonly detail: Record<string, unknown> = {},
    readonly bookingId: string | null = null,
  ) {
    super(reason);
    this.name = 'KioskStop';
    this.code = reason;
  }
}

/** What a stored redemption view says on a kiosk: when and where, never who. */
function redeemedWhereAndWhen(view: RedemptionView | null | undefined) {
  return view ? { at: view.at, branchName: view.branchName, stationName: view.stationName } : null;
}

// --- The session row -------------------------------------------------------------

type SessionRow = typeof kioskSession.$inferSelect;

/** How long a press may stay unfinished before a replay of it reads as interrupted. */
export const KIOSK_PRESS_STALE_MS = 2 * 60 * 1000;

export interface KioskContext {
  requestId: string;
  log?: FastifyBaseLogger;
  now?: () => Date;
  /** Tests only: a printer to use instead of the kiosk box's own. */
  printer?: KioskPrinter | null;
}

function opCtxOf(ctx: KioskContext, device: KioskDeviceAuth): OpContext {
  return {
    requestId: ctx.requestId,
    actorAccountId: null,
    operatorId: device.station.operatorId,
    branchId: device.station.branchId,
    ...(ctx.log ? { log: ctx.log } : {}),
  };
}

/** Where every kiosk audit row says it happened (plan §10: the audit table has no station or box column). */
function whereOf(device: KioskDeviceAuth): Record<string, unknown> {
  return {
    stationId: device.station.id,
    boxId: device.station.boxId,
    deviceCredentialId: device.credentialId,
  };
}

/**
 * THE PRESS, written down before anything is looked up — in its own
 * transaction, so a second request carrying the same action id finds it
 * (`kiosk_session_action_unique`) however the first one ends.
 */
async function openSession(
  db: Db,
  ctx: KioskContext,
  device: KioskDeviceAuth,
  actionId: string,
  now: Date,
): Promise<{ row: SessionRow; fresh: boolean }> {
  const id = newId();
  const [inserted] = await db
    .insert(kioskSession)
    .values({
      id,
      operatorId: device.station.operatorId,
      branchId: device.station.branchId,
      stationId: device.station.id,
      deviceCredentialId: device.credentialId,
      boxId: device.station.boxId,
      actionId,
      startedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted, fresh: true };
  const [held] = await db
    .select()
    .from(kioskSession)
    .where(and(eq(kioskSession.stationId, device.station.id), eq(kioskSession.actionId, actionId)))
    .limit(1);
  if (!held) throw new Error('a kiosk press was neither written nor found');
  ctx.log?.info({ sessionId: held.id, outcome: held.outcome }, 'kiosk press replayed');
  return { row: held, fresh: false };
}

/**
 * End a session that issued nothing (`failed`), with the `kiosk.abort` row —
 * in one transaction, conditional on the session still being open, so two
 * endings cannot both be written.
 */
async function endFailed(
  db: Db,
  ctx: KioskContext,
  device: KioskDeviceAuth,
  session: SessionRow,
  stop: KioskStop,
  now: Date,
): Promise<SessionRow> {
  return withTx(db, opCtxOf(ctx, device), 'kiosk.abort', async (tx) => {
    const [ended] = await tx
      .update(kioskSession)
      .set({
        outcome: 'failed',
        reason: stop.reason,
        endedAt: now,
        bookingId: stop.bookingId,
        detail: { stage: stop.stage, ...stop.detail },
      })
      .where(and(eq(kioskSession.id, session.id), isNull(kioskSession.outcome)))
      .returning();
    if (!ended) {
      const [current] = await tx.select().from(kioskSession).where(eq(kioskSession.id, session.id)).limit(1);
      return current!;
    }
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: device.station.operatorId,
      branchId: device.station.branchId,
      action: 'kiosk.abort',
      entityType: 'kiosk_session',
      entityId: session.id,
      before: { outcome: null },
      after: {
        ...whereOf(device),
        outcome: 'failed',
        reason: stop.reason,
        stage: stop.stage,
        bookingId: stop.bookingId,
        ...stop.detail,
      },
      requestId: ctx.requestId,
      actionId: session.actionId,
    });
    return ended;
  });
}

/** A booking that is nothing but supervised children: sent to the desk, nothing issued. */
async function endHandedOffToDesk(
  db: Db,
  ctx: KioskContext,
  device: KioskDeviceAuth,
  session: SessionRow,
  found: BookingRow,
  supervisedChildren: number,
  now: Date,
): Promise<SessionRow> {
  return withTx(db, opCtxOf(ctx, device), 'kiosk.handoff', async (tx) => {
    const [ended] = await tx
      .update(kioskSession)
      .set({
        outcome: 'handed_off',
        reason: KIOSK_REASONS.supervised,
        endedAt: now,
        bookingId: found.id,
        detail: { stage: 'lookup', supervisedChildren },
      })
      .where(and(eq(kioskSession.id, session.id), isNull(kioskSession.outcome)))
      .returning();
    if (!ended) {
      const [current] = await tx.select().from(kioskSession).where(eq(kioskSession.id, session.id)).limit(1);
      return current!;
    }
    await audit.record(tx, {
      actorAccountId: null,
      operatorId: device.station.operatorId,
      branchId: device.station.branchId,
      action: 'kiosk.handoff',
      entityType: 'kiosk_session',
      entityId: session.id,
      before: { outcome: null },
      after: {
        ...whereOf(device),
        outcome: 'handed_off',
        reason: KIOSK_REASONS.supervised,
        bookingId: found.id,
        reference: found.reference,
        supervisedChildren,
        issued: false,
      },
      requestId: ctx.requestId,
      actionId: session.actionId,
    });
    return ended;
  });
}

// --- The answer -------------------------------------------------------------------

/**
 * The answer, read back from the session row — the first time and on every
 * replay of the same press, so the two cannot differ but for `replay`.
 */
async function answerOf(db: Db, row: SessionRow, replay: boolean): Promise<KioskRedeemAnswer> {
  const detail = (row.detail ?? {}) as Record<string, unknown>;
  const [held] = row.bookingId
    ? await db
        .select({ reference: booking.reference, kids: booking.kidsCount, adults: booking.adultsCount })
        .from(booking)
        .where(eq(booking.id, row.bookingId))
        .limit(1)
    : [];
  const bandIds = Array.isArray(row.bandIds) ? row.bandIds : [];
  const bands = bandIds.length
    ? await db
        .select({ id: band.id, kind: band.kind, code: band.code, createdAt: band.createdAt })
        .from(band)
        .where(inArray(band.id, bandIds))
    : [];
  const grants = row.saleId ? await grantsOfSale(db, row.saleId) : [];
  const outcome = (row.outcome ?? 'failed') as KioskSessionOutcome;
  const supervisedChildren = typeof detail.supervisedChildren === 'number' ? detail.supervisedChildren : 0;
  const redeemed = detail.alreadyRedeemed as KioskRedeemAnswer['alreadyRedeemed'] | undefined;
  return {
    sessionId: row.id,
    outcome,
    reason: row.reason,
    replay,
    booking: held ? { reference: held.reference, kids: held.kids, adults: held.adults } : null,
    bands: bands
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((b) => ({ kind: b.kind, shortCode: bandShortCode(b.code) })),
    walletCreditSatang: grants.reduce((sum, g) => sum + g.creditSatang, 0),
    // A guest is sent to the desk for every ending but a whole issue.
    desk: { required: outcome !== 'issued', supervisedChildren },
    alreadyRedeemed: redeemed ?? null,
  };
}

// --- The redemption ---------------------------------------------------------------

/** Wristbands first: the hand-over is the bands, and a fault on them should cost no other paper. */
const BAND_KINDS: ReadonlySet<string> = new Set(['kids_wristband', 'adult_wristband']);

/**
 * Redeem one scanned booking at a kiosk: refuse it, send it to the desk, or
 * issue it — bands printed before anything is committed.
 *
 * Every ending is a 200 with the session's outcome: a refusal and a printer
 * fault are what happened at the kiosk, not errors in the request. A fault the
 * platform did not expect ends the session `failed` (`KIOSK_INTERNAL_ERROR`)
 * and is thrown, so it is a 500 and a log line as well.
 */
export async function redeemAtKiosk(
  db: Db,
  ctx: KioskContext,
  device: KioskDeviceAuth,
  input: KioskRedeemRequest,
): Promise<KioskRedeemAnswer> {
  const now = ctx.now?.() ?? new Date();
  const st = device.station;

  const opened = await openSession(db, ctx, device, input.actionId, now);
  if (!opened.fresh) {
    if (opened.row.outcome) return answerOf(db, opened.row, true);
    // The same press while it is still running — or one a stopped process
    // left open, which is ended now rather than answered "in progress" for ever.
    if (now.getTime() - opened.row.startedAt.getTime() < KIOSK_PRESS_STALE_MS) {
      throw new AppError(409, KIOSK_REASONS.inProgress, 'This scan is still being redeemed — wait a moment', {
        sessionId: opened.row.id,
      });
    }
    const ended = await endFailed(
      db,
      ctx,
      device,
      opened.row,
      new KioskStop(KIOSK_REASONS.interrupted, 'claim', {}, opened.row.bookingId),
      now,
    );
    return answerOf(db, ended, true);
  }
  const session = opened.row;

  let found: BookingRow | null = null;
  try {
    // 1. WHICH BOOKING — the whole signed QR, checked against the signature the
    // park stored when it was paid; anything else opens nothing.
    try {
      found = await loadBookingByQr(db, st.operatorId, input.qr);
    } catch (err) {
      if (err instanceof AppError && err.statusCode < 500) {
        throw new KioskStop(err.code === 'BAD_REQUEST' ? KIOSK_REASONS.notABookingQr : err.code, 'lookup');
      }
      throw err;
    }
    if (found.branchId !== st.branchId) {
      throw new KioskStop(KIOSK_REASONS.otherBranch, 'lookup', {}, found.id);
    }
    // The refusals a family hears by name, before anything is locked: the claim
    // below asks them again under the row lock, and a race lands there.
    if (found.status === 'redeemed') {
      const read = await readBookings(db, [found]);
      const stored = read.redemptions.get(found.id);
      throw new KioskStop(
        'BOOKING_ALREADY_REDEEMED',
        'lookup',
        { alreadyRedeemed: redeemedWhereAndWhen(stored ? redemptionView(stored, read.names) : null) },
        found.id,
      );
    }
    if (found.status !== 'paid') {
      throw new KioskStop('BOOKING_NOT_REDEEMABLE', 'lookup', { status: found.status }, found.id);
    }

    // 2. THE SUPERVISED SPLIT (R-80).
    const lines = linesOf(found).filter((l) => l.packageId && (l.kids > 0 || l.adults > 0));
    if (lines.length === 0) throw new KioskStop('BOOKING_NOTHING_TO_ISSUE', 'lookup', {}, found.id);
    const supervised = lines.filter((l) => l.supervision);
    const supervisedChildren = supervised.reduce((sum, l) => sum + l.kids, 0);
    if (supervised.length === lines.length) {
      const ended = await endHandedOffToDesk(db, ctx, device, session, found, supervisedChildren, now);
      return answerOf(db, ended, false);
    }

    // 3. THE KIOSK'S PRINTER, before anything is claimed: a box that cannot
    // print is a redemption that cannot finish.
    const printer = ctx.printer !== undefined ? ctx.printer : await kioskPrinterOf(db, st.boxId);
    if (!printer || !st.boxId) throw new KioskStop(KIOSK_REASONS.boxOffline, 'lookup', {}, found.id);
    const boxId = st.boxId;
    const bookingId = found.id;

    // 4. ISSUE, THEN PRINT, THEN COMMIT — one transaction.
    const ended = await withTx(db, opCtxOf(ctx, device), 'kiosk.redeem', async (tx) => {
      let done;
      try {
        done = await redeemBookingAtCounter(tx, {
          bookingId,
          operatorId: st.operatorId,
          actorAccountId: null,
          deviceCredentialId: device.credentialId,
          stationId: st.id,
          requestId: ctx.requestId,
          actionId: input.actionId,
          printing: 'direct',
          now,
        });
      } catch (err) {
        // A refusal the claim made under the lock (another kiosk or a till got
        // there first): the same ending as the one asked before the lock.
        if (err instanceof AppError && err.statusCode < 500) {
          const details = (err.details ?? {}) as { redemption?: RedemptionView | null };
          throw new KioskStop(
            err.code,
            'claim',
            err.code === 'BOOKING_ALREADY_REDEEMED' ? { alreadyRedeemed: redeemedWhereAndWhen(details.redemption) } : {},
            bookingId,
          );
        }
        throw err;
      }

      const printing = done.printing;
      if (!printing || printing.failed) throw new KioskStop(KIOSK_REASONS.printRouting, 'print', {}, bookingId);
      const bandJobs = printing.jobs.filter((j) => BAND_KINDS.has(j.kind));
      if (done.bands.length === 0 || bandJobs.length < done.bands.length) {
        throw new KioskStop(KIOSK_REASONS.bandsNotIssued, 'print', {}, bookingId);
      }
      if (bandJobs.some((j) => j.status !== 'queued')) {
        throw new KioskStop(KIOSK_REASONS.noBandPrinter, 'print', {}, bookingId);
      }
      // Bands first; then the rest that has a printer here (a receipt, a credit
      // voucher). A job this kiosk has no printer for was written `skipped`.
      const toPrint = [
        ...printing.jobs.filter((j) => j.status === 'queued' && BAND_KINDS.has(j.kind)),
        ...printing.jobs.filter((j) => j.status === 'queued' && !BAND_KINDS.has(j.kind)),
      ];
      const requests: PrintRequest[] = [];
      for (const job of toPrint) {
        const document = await buildPrintDocument(tx, { boxId, operatorId: st.operatorId }, job.id);
        requests.push({
          id: job.id,
          kind: document.kind,
          job: document.job,
          stationId: st.id,
          role: document.role,
          copies: 1,
          actionId: input.actionId,
          templateId: document.templateId,
          templateVersion: document.templateVersion,
        });
      }
      const paper = await printer.printNow(requests);
      if (!paper.complete) {
        throw new KioskStop(
          paper.fault?.errorCode ?? 'PRINT_FAILED',
          'print',
          { printed: paper.printed, deviceId: paper.fault?.deviceId ?? null, jobs: requests.length },
          bookingId,
        );
      }
      const printedAt = new Date();
      for (const outcome of paper.outcomes.filter((o) => o.status === 'printed')) {
        await tx
          .update(printJob)
          .set({
            status: 'printed',
            attempts: 1,
            deviceId: outcome.deviceId,
            startedAt: now,
            finishedAt: printedAt,
            updatedAt: printedAt,
          })
          .where(eq(printJob.id, outcome.id));
      }

      /**
       * Q11 (the owner's default: yes) — redeeming a booking at the kiosk
       * also checks in the event passes it carries, as the till's redemption
       * does (`Till.tsx` 437-462). Not on main: online event passes, and the
       * check-in they need, arrive with the events rounds (E3, E5). This is
       * where that call goes, inside this transaction and after the paper.
       */

      const outcome: KioskSessionOutcome = supervised.length > 0 ? 'handed_off' : 'issued';
      const bandIds = done.bands.map((b) => b.id);
      const detail = {
        stage: 'print',
        supervisedChildren,
        printed: paper.printed,
        jobs: requests.length,
        walletGrants: done.grants.length,
      };
      const [row] = await tx
        .update(kioskSession)
        .set({
          outcome,
          reason: outcome === 'handed_off' ? KIOSK_REASONS.supervisedRest : null,
          endedAt: printedAt,
          bookingId,
          saleId: done.sale.id,
          bandIds,
          detail,
        })
        .where(and(eq(kioskSession.id, session.id), isNull(kioskSession.outcome)))
        .returning();
      if (!row) throw new Error('the kiosk session ended under another request');
      const where = whereOf(device);
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: st.operatorId,
        branchId: st.branchId,
        action: 'kiosk.redeem',
        entityType: 'kiosk_session',
        entityId: session.id,
        before: { outcome: null },
        after: {
          ...where,
          outcome,
          bookingId,
          reference: done.booking.reference,
          saleId: done.sale.id,
          receiptNumber: done.sale.receiptNumber,
          bandIds,
          printJobIds: requests.map((r) => r.id),
          walletIds: done.grants.map((g) => g.walletId),
        },
        requestId: ctx.requestId,
        actionId: input.actionId,
      });
      if (outcome === 'handed_off') {
        // Recorded only now, after the self-service half printed: never a false hand-off.
        await audit.record(tx, {
          actorAccountId: null,
          operatorId: st.operatorId,
          branchId: st.branchId,
          action: 'kiosk.handoff',
          entityType: 'kiosk_session',
          entityId: session.id,
          before: { outcome: null },
          after: {
            ...where,
            outcome,
            reason: KIOSK_REASONS.supervisedRest,
            bookingId,
            reference: done.booking.reference,
            saleId: done.sale.id,
            supervisedChildren,
            issued: true,
          },
          requestId: ctx.requestId,
          actionId: input.actionId,
        });
      }
      return row;
    });
    return answerOf(db, ended, false);
  } catch (err) {
    const stop =
      err instanceof KioskStop
        ? err
        : new KioskStop(KIOSK_REASONS.internal, 'claim', {}, found?.id ?? null);
    if (!(err instanceof KioskStop)) {
      ctx.log?.error({ err, sessionId: session.id }, 'a kiosk redemption failed unexpectedly; nothing was issued');
    }
    const ended = await endFailed(db, ctx, device, session, stop, now);
    if (!(err instanceof KioskStop)) throw err;
    return answerOf(db, ended, false);
  }
}
