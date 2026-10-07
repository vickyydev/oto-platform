import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
  KIOSK_IDLE_TIMEOUT_MS,
  KIOSK_REASONS,
  KIOSK_REDEEM_SCOPE,
  bandShortCode,
  newId,
  type KioskAbandonAnswer,
  type KioskAbandonRequest,
  type KioskDeviceScope,
  type KioskRedeemAnswer,
  type KioskRedeemRequest,
  type KioskSessionAnswer,
  type KioskSessionOutcome,
  type KioskSessionStartRequest,
  type KioskState,
} from '@oto/shared';
import {
  PRINT_CALLED_OFF,
  type PrintJobOutcome,
  type PrintNowOptions,
  type PrintNowOutcome,
  type PrintRequest,
} from '@oto/box-agent';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { audit } from './audit';
import { recordRun } from './ops';
import { inProcessBox } from './box';
import { redeemBookingAtCounter } from './booking-redemption';
import { bookingPassDirectory, sendBookingPassCheckins, storedEventPassesOf } from './booking-event-passes';
import {
  kioskPressedAtOf,
  linesOf,
  loadBookingByQr,
  readBookings,
  redemptionView,
  type BookingRow,
  type RedemptionView,
} from './bookings';
import { buildPrintDocument } from './sale-printing';
import { withTx, type OpContext, type Tx } from './tx';
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
 *      An unattended kiosk cannot work that way for its bands: bands that
 *      never came out are a family at a dead screen holding a redeemed
 *      booking. So here the redemption's transaction stays open while the
 *      kiosk box prints the bands (`printNow` — routed, rendered and the band
 *      printer asked first), and it commits only when every band came out. A
 *      band printer fault, paper out or a box that is not reachable rolls the
 *      whole of it back: no claim, no sale, no band, no grant. The booking
 *      stays paid and unredeemed, the session is `failed` with the reason, and
 *      the till can redeem it.
 *
 *      SCRUM-504 — THE HOLD WHILE IT PRINTS. A real label printer may take
 *      seconds a band, and the pool ends a connection that sits idle in a
 *      transaction for thirty. So the open transaction is touched while the
 *      set prints (`KIOSK_PRINT_KEEPALIVE_MS`), and the set is held to a
 *      budget below that window (`KIOSK_PRINT_BUDGET_MS`): whichever gives
 *      first ends the print as a `failed` session with the bands that came
 *      out counted, never as a dead connection and a 500. The connection is
 *      listened on while it is held (`watchConnection`), so losing it ends the
 *      print at once and never reaches the process as an uncaught error.
 *
 *      SCRUM-504 — THE PLAIN PAPER AFTER THE COMMIT. Only the bands print
 *      inside the hold. The receipt and the credit vouchers are queued to the
 *      kiosk's box as a till's are, in the same transaction, and print once
 *      it commits: a receipt never carries a number from the station's series
 *      that a rollback then gives to the next family, a voucher never shows
 *      credit in a wallet that was rolled back, and a fault on plain paper is
 *      a reprint from History, never a redemption called off.
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
    /** `commit`: every job came out, and what failed was writing the redemption down after it (SCRUM-504). */
    readonly stage: 'lookup' | 'claim' | 'print' | 'commit',
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
  /** Tests only: the print's keep-alive and budget, scaled down with a test's own idle window. */
  printLimits?: Partial<KioskPrintLimits>;
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
  sessionId?: string,
): Promise<{ row: SessionRow; fresh: boolean }> {
  // The same press again, wherever it was first written down.
  const [pressed] = await db
    .select()
    .from(kioskSession)
    .where(and(eq(kioskSession.stationId, device.station.id), eq(kioskSession.actionId, actionId)))
    .limit(1);
  if (pressed) {
    ctx.log?.info({ sessionId: pressed.id, outcome: pressed.outcome }, 'kiosk press replayed');
    return { row: pressed, fresh: false };
  }
  /**
   * S2-20 K2 — THE GUEST'S SESSION, taken over by their first press. The
   * screen opened it when they left the attract screen; the press writes its
   * action id onto it, conditional on nothing having been pressed on it and it
   * not having ended (an idle timeout, a newer session), so one guest is one
   * row on the Kiosk tile. Any miss falls through to a row of the press's own,
   * as K1 wrote it — a second scan by the same guest, after the first one's
   * answer, is a second session.
   *
   * `detail.pressedAt` is when the press arrived, which is what "still being
   * redeemed or left open by a stopped process" is measured from: the
   * session's own `started_at` is when the guest first touched the screen.
   */
  if (sessionId) {
    const [taken] = await db
      .update(kioskSession)
      .set({ actionId, detail: { pressedAt: now.toISOString() } })
      .where(
        and(
          eq(kioskSession.id, sessionId),
          eq(kioskSession.stationId, device.station.id),
          isNull(kioskSession.actionId),
          isNull(kioskSession.outcome),
        ),
      )
      .returning()
      .catch((err: unknown) => {
        // Two copies of one press racing: the other took the action id first.
        if (pgErrorOf(err)?.code === '23505') return [];
        throw err;
      });
    if (taken) return { row: taken, fresh: true };
  }
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
    calledOffBands: calledOffBandsOf(row),
    walletCreditSatang: grants.reduce((sum, g) => sum + g.creditSatang, 0),
    // A guest is sent to the desk for every ending but a whole issue.
    desk: { required: outcome !== 'issued', supervisedChildren },
    alreadyRedeemed: redeemed ?? null,
  };
}

/**
 * SCRUM-504 — wristbands that came out for a set the kiosk then called off:
 * read from a `failed` session's detail (`bandsPrinted`, and one more when a
 * band may still have been printing as the kiosk stopped waiting). Nothing was
 * committed, so the gate refuses every one of them; the guest and the desk are
 * told to collect them. Zero on every other ending.
 */
export function calledOffBandsOf(row: Pick<SessionRow, 'outcome' | 'detail'>): number {
  if (row.outcome !== 'failed') return 0;
  const detail = (row.detail ?? {}) as { bandsPrinted?: unknown; bandMayBeOut?: unknown };
  const printed = typeof detail.bandsPrinted === 'number' && detail.bandsPrinted > 0 ? detail.bandsPrinted : 0;
  return printed + (detail.bandMayBeOut === true ? 1 : 0);
}

// --- The print, with the redemption held open (SCRUM-504) --------------------------

/**
 * The pool ends a connection left idle inside a transaction for thirty
 * seconds (`idle_in_transaction_session_timeout`, `packages/db` `getDb`), and
 * one label job alone may take fifteen (`CHANNEL_TIMEOUTS.jobCompleteMs`). The
 * redemption's transaction is open, and otherwise idle, for the whole print.
 */
export interface KioskPrintLimits {
  /** How often the open transaction is touched (`select 1`) while the set prints. Well inside the window. */
  keepaliveMs: number;
  /**
   * The longest the kiosk waits on a set with its redemption open. Below the
   * window, so that even with no keep-alive at all the redemption is rolled
   * back by the kiosk, not ended by the database: the set is called off (no
   * further job starts), the kiosk stops waiting, and the bands that came out
   * are counted. A set this long is one the desk issues instead.
   */
  budgetMs: number;
}

export const KIOSK_PRINT_KEEPALIVE_MS = 5_000;
export const KIOSK_PRINT_BUDGET_MS = 25_000;

const PRINT_LIMITS: KioskPrintLimits = { keepaliveMs: KIOSK_PRINT_KEEPALIVE_MS, budgetMs: KIOSK_PRINT_BUDGET_MS };

/** What came of the print, as far as the kiosk waited for it. */
interface HeldPrint {
  /** The printer's own answer; null when the kiosk stopped waiting before it came. */
  paper: PrintNowOutcome | null;
  /** Why the kiosk stopped the print from its side, if it did: the budget ran out, or the hold was lost. */
  stopped: 'budget' | 'hold' | null;
}

/**
 * SCRUM-504 — THE CONNECTION THE REDEMPTION HOLDS, listened on for as long as
 * it is held.
 *
 * pg's client EMITS 'error' when its connection ends under it (the server's
 * idle-in-transaction window, a restart, the network), with or without a query
 * in flight, and a pool takes its own listener off a client while the client
 * is checked out (pg-pool) — so on production's pool (`packages/db` `getDb`) a
 * transaction's connection has none. Unheard, that event is an uncaught
 * exception, and `index.ts` exits the process on one: every till and kiosk
 * drops. The kiosk holds its connection open, and otherwise idle, for as long
 * as its bands print, so it listens on it from its first statement until the
 * transaction has given it back to the pool. A connection lost while the
 * bands print ends the print at once (`KIOSK_PRINT_HOLD_LOST`), not at the
 * next keep-alive.
 */
interface ConnectionWatch {
  /** Whether the connection has ended under the redemption. */
  readonly lost: boolean;
  /** Listen on the transaction's own connection: the first thing the transaction does. */
  attach(tx: Tx): void;
  /** Be told the moment the connection is lost (at once, if it already is). Returns how to stop being told. */
  onLost(fn: () => void): () => void;
  /** Stop listening, once the transaction has given its connection back: the pool listens from then on. */
  detach(): void;
}

type ErrorListener = (err: unknown) => void;
interface ErrorEmitter {
  on(event: 'error', listener: ErrorListener): unknown;
  off(event: 'error', listener: ErrorListener): unknown;
}

/** The connection under a transaction: Drizzle's node-postgres session keeps the checked-out client. */
function connectionOf(tx: Tx): ErrorEmitter | null {
  const client = (tx as unknown as { session?: { client?: Partial<ErrorEmitter> } }).session?.client;
  return client && typeof client.on === 'function' && typeof client.off === 'function' ? (client as ErrorEmitter) : null;
}

function watchConnection(log: FastifyBaseLogger | undefined, sessionId: string): ConnectionWatch {
  let client: ErrorEmitter | null = null;
  let lost = false;
  let notify: (() => void) | null = null;
  const listener: ErrorListener = (err) => {
    if (lost) return;
    lost = true;
    log?.warn({ err, sessionId }, 'the kiosk redemption lost its connection to the database');
    notify?.();
  };
  return {
    get lost() {
      return lost;
    },
    attach(tx) {
      if (client) return;
      client = connectionOf(tx);
      client?.on('error', listener);
    },
    onLost(fn) {
      notify = fn;
      if (lost) fn();
      return () => {
        if (notify === fn) notify = null;
      };
    },
    detach() {
      client?.off('error', listener);
      client = null;
      notify = null;
    },
  };
}

/**
 * Print the set with the redemption's transaction held open: touched every
 * `keepaliveMs` so the database does not end it, and given up after
 * `budgetMs` so the kiosk ends it first if nothing else does. A keep-alive
 * that fails, or the connection heard ending (`watch`), means the hold is
 * gone — the set is called off at once, since nothing printed after it could
 * be committed.
 *
 * `out` is filled as each job comes out (`PrintNowOptions.onPrinted`), so a
 * kiosk that stops waiting still knows what is in the tray.
 */
async function printHoldingTheRedemption(
  tx: Tx,
  printer: KioskPrinter,
  requests: readonly PrintRequest[],
  out: PrintJobOutcome[],
  limits: KioskPrintLimits,
  watch: ConnectionWatch,
  log: FastifyBaseLogger | undefined,
): Promise<HeldPrint> {
  const controller = new AbortController();
  let stopped: HeldPrint['stopped'] = null;
  let wake!: () => void;
  const interrupted = new Promise<null>((resolve) => {
    wake = () => resolve(null);
  });
  const stop = (why: 'budget' | 'hold') => {
    if (stopped) return;
    stopped = why;
    controller.abort();
    wake();
  };
  const unwatch = watch.onLost(() => stop('hold'));
  let touching: Promise<void> = Promise.resolve();
  const keepalive = setInterval(() => {
    touching = touching
      .then(() => tx.execute(sql`select 1`))
      .then(
        () => undefined,
        (err: unknown) => {
          log?.warn({ err }, 'the kiosk redemption lost its hold on the database while it printed');
          stop('hold');
        },
      );
  }, limits.keepaliveMs);
  const budget = setTimeout(() => stop('budget'), limits.budgetMs);

  // Counted only while the kiosk waits: a band that comes out after it stopped
  // waiting is the one `bandMayBeOut` already stands for.
  const printing = Promise.resolve().then(() =>
    printer.printNow(requests, {
      signal: controller.signal,
      onPrinted: (o) => {
        if (!stopped) out.push(o);
      },
    }),
  );
  let paper: PrintNowOutcome | null;
  try {
    paper = await Promise.race([printing, interrupted]);
  } finally {
    clearInterval(keepalive);
    clearTimeout(budget);
    unwatch();
    // A keep-alive in flight lands before the transaction is used again.
    await touching;
  }
  if (!paper) {
    // The set goes on to the end of the job in hand; say what it did, when it does.
    printing.then(
      (late) =>
        log?.warn(
          { printed: late.printed, complete: late.complete, fault: late.fault?.errorCode ?? null },
          'a kiosk set the redemption stopped waiting for has answered',
        ),
      (err: unknown) => log?.warn({ err }, 'a kiosk set the redemption stopped waiting for failed'),
    );
  }
  const why = stopped as HeldPrint['stopped'];
  // Every job was out before the budget was noticed: the set is whole after all.
  if (!paper && why === 'budget' && out.length === requests.length) {
    return { paper: { complete: true, printed: out.length, outcomes: [...out], fault: null }, stopped: null };
  }
  // A keep-alive that failed as the last job came out: the hold is gone all the same.
  return { paper, stopped: why === 'hold' ? 'hold' : paper ? null : why };
}

/**
 * Whether an error is the database connection going away (ended by the
 * server, the network, or a pool that closed it) rather than a refusal.
 * Drizzle wraps the driver's error, so the whole `cause` chain is read.
 */
function connectionLost(err: unknown): boolean {
  const raw = pgErrorOf(err)?.code;
  const code = typeof raw === 'string' ? raw : '';
  if (code.startsWith('08') || ['57P01', '57P02', '57P03', '25P03'].includes(code)) return true;
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : '';
    if (/connection (terminated|ended|closed|lost)|terminating connection|Client has encountered a connection error|Client was closed/i.test(message)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// --- The redemption ---------------------------------------------------------------

/**
 * The jobs the kiosk prints inside its hold: the wristbands, and nothing else
 * (SCRUM-504). The receipt and the vouchers are queued to the box with the
 * sale (`dispatch: 'caller'`, `sale-printing.ts`) and print after the commit.
 */
const BAND_KINDS: ReadonlySet<string> = new Set(['kids_wristband', 'adult_wristband']);

/** What a print had put out when it stopped, for the session and the device run. */
interface PaperOut {
  requests: readonly PrintRequest[];
  bandJobIds: ReadonlySet<string>;
  /** Every job the printer said came out, in order. */
  out: PrintJobOutcome[];
  /** The kiosk stopped waiting before the printer answered: the next job may be coming out. */
  unanswered: boolean;
  /** The job the printer said did not come out, when it said so. */
  fault: PrintJobOutcome | null;
}

function countOut(paper: PaperOut) {
  const printed = paper.out.length;
  const bandsPrinted = paper.out.filter((o) => paper.bandJobIds.has(o.id)).length;
  const next = paper.requests[printed];
  // The kiosk stopped waiting with a band in the printer, or the printer failed
  // a band part-way through it (`partial`): either may be in the tray.
  const bandMayBeOut =
    (paper.unanswered && !!next && paper.bandJobIds.has(next.id)) ||
    (paper.fault?.partial === true && paper.bandJobIds.has(paper.fault.id));
  return { printed, bandsPrinted, ...(bandMayBeOut ? { bandMayBeOut: true } : {}), jobs: paper.requests.length };
}

/**
 * Redeem one scanned booking at a kiosk: refuse it, send it to the desk, or
 * issue it — bands printed before anything is committed.
 *
 * Every ending is a 200 with the session's outcome: a refusal and a printer
 * fault are what happened at the kiosk, not errors in the request. A fault the
 * platform did not expect BEFORE the print began ends the session `failed`
 * (`KIOSK_INTERNAL_ERROR`) and is thrown, so it is a 500 and a log line as
 * well. Once the print has begun, paper may be in the tray, so every ending is
 * a `failed` session that counts it — a lost connection included (SCRUM-504)
 * — answered as a 200 and logged; never a 500 at the guest.
 */
export async function redeemAtKiosk(
  db: Db,
  ctx: KioskContext,
  device: KioskDeviceAuth,
  input: KioskRedeemRequest,
): Promise<KioskRedeemAnswer> {
  const now = ctx.now?.() ?? new Date();
  const st = device.station;

  const opened = await openSession(db, ctx, device, input.actionId, now, input.sessionId);
  if (!opened.fresh) {
    if (opened.row.outcome) return answerOf(db, opened.row, true);
    // The same press while it is still running — or one a stopped process
    // left open, which is ended now rather than answered "in progress" for ever.
    if (now.getTime() - kioskPressedAtOf(opened.row).getTime() < KIOSK_PRESS_STALE_MS) {
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
  /** S2-20 K2 — what the print did, set where it happened and written down once the redemption ends. */
  let printRun: KioskPrintRun | null = null;
  /**
   * SCRUM-504 — the print as the endings read it, kept outside the
   * transaction. `sheet` is set once the first printer is asked: from then on,
   * paper may be in the tray. `stop` is the print's own ending: when the
   * connection has gone, the rollback fails and its error is what the
   * transaction throws, but the ending is still this one.
   */
  const track: { sheet: PaperOut | null; stop: KioskStop | null } = { sheet: null, stop: null };
  /** S2-20 E5 — the event check-ins the redemption made, written back to the OTO App once it commits. */
  const owedCheckins: { ids: string[] } = { ids: [] };
  const stopPrint = (stop: KioskStop): KioskStop => {
    track.stop = stop;
    return stop;
  };
  /** SCRUM-504 — the redemption's own connection, listened on while it holds it (`watchConnection`). */
  const watch = watchConnection(ctx.log, session.id);
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

    // 2. THE SUPERVISED SPLIT (R-80). S2-20 E5 — event passes are issued here
    // as the till issues them (Q11), so a booking of passes alone is redeemed,
    // and one whose tickets are all supervised still issues its passes.
    const lines = linesOf(found).filter((l) => l.packageId && (l.kids > 0 || l.adults > 0));
    const passCount = storedEventPassesOf(found.payload).length;
    if (lines.length === 0 && passCount === 0) throw new KioskStop('BOOKING_NOTHING_TO_ISSUE', 'lookup', {}, found.id);
    const supervised = lines.filter((l) => l.supervision);
    const supervisedChildren = supervised.reduce((sum, l) => sum + l.kids, 0);
    const owesTicketBands = lines.some((l) => !l.supervision);
    if (lines.length > 0 && supervised.length === lines.length && passCount === 0) {
      const ended = await endHandedOffToDesk(db, ctx, device, session, found, supervisedChildren, now);
      return answerOf(db, ended, false);
    }

    // 3. THE KIOSK'S PRINTER, before anything is claimed: a box that cannot
    // print is a redemption that cannot finish.
    const printer = ctx.printer !== undefined ? ctx.printer : await kioskPrinterOf(db, st.boxId);
    if (!printer || !st.boxId) {
      // The kiosk's print, called off before it began: still the device's run (S2-20 K2).
      printRun = { startedAt: new Date(), finishedAt: new Date(), jobs: 0, printed: 0, bandsPrinted: 0,
        complete: false, errorCode: KIOSK_REASONS.boxOffline, deviceId: null };
      throw new KioskStop(KIOSK_REASONS.boxOffline, 'lookup', {}, found.id);
    }
    const boxId = st.boxId;
    const bookingId = found.id;

    // The press names its booking before it takes the lock (SCRUM-504): a till
    // or another kiosk kept waiting behind this redemption's print is told
    // where the booking is being redeemed (`redeemBooking`'s bounded wait).
    await db
      .update(kioskSession)
      .set({ bookingId })
      .where(and(eq(kioskSession.id, session.id), isNull(kioskSession.outcome)));

    // 4. ISSUE, THEN PRINT, THEN COMMIT — one transaction, its connection
    // listened on until it is back in the pool (SCRUM-504).
    const ended = await withTx(db, opCtxOf(ctx, device), 'kiosk.redeem', async (tx) => {
      watch.attach(tx);
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
      // S2-20 E5 — the booking's event passes (Q11): a check-in that could
      // not be made calls the whole redemption off, as a band that does not
      // print does; the till redeems it, and says why.
      const passes = done.eventPasses;
      if (passes.checkins.some((c) => c.outcome === 'failed')) {
        throw new KioskStop(KIOSK_REASONS.eventPassFailed, 'claim', {}, bookingId);
      }
      // Every band the redemption owes — the tickets' and each checked-in
      // pass's kid and parent band — prints here, before anything commits.
      const passBandJobs = passes.jobs.filter((j) => BAND_KINDS.has(j.kind));
      const bandJobs = [...printing.jobs.filter((j) => BAND_KINDS.has(j.kind)), ...passBandJobs];
      const allBands = [...done.bands, ...passes.bands];
      const passWithoutBands = passes.checkins.some((c) => c.outcome === 'checked_in' && !c.checkin?.kidBand);
      if ((owesTicketBands && done.bands.length === 0) || passWithoutBands || bandJobs.length < allBands.length) {
        throw new KioskStop(KIOSK_REASONS.bandsNotIssued, 'print', {}, bookingId);
      }
      if (bandJobs.some((j) => j.status !== 'queued')) {
        throw new KioskStop(KIOSK_REASONS.noBandPrinter, 'print', {}, bookingId);
      }
      // The bands, and only the bands (SCRUM-504): the receipt and the vouchers
      // are already queued to the box with the sale, and print once this
      // commits. A job this kiosk has no printer for was written `skipped`.
      const toPrint = bandJobs;
      const paperQueued = printing.jobs.filter((j) => j.status === 'queued' && !BAND_KINDS.has(j.kind));
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
      const sheet: PaperOut = {
        requests,
        bandJobIds: new Set(toPrint.map((j) => j.id)),
        out: [],
        unanswered: false,
        fault: null,
      };
      // From here on, any ending counts the paper (SCRUM-504).
      track.sheet = sheet;
      const printStartedAt = new Date();
      const runOf = (errorCode: string | null, deviceId: string | null): KioskPrintRun => {
        const counted = countOut(sheet);
        return {
          startedAt: printStartedAt,
          finishedAt: new Date(),
          jobs: requests.length,
          printed: counted.printed,
          bandsPrinted: counted.bandsPrinted,
          complete: errorCode === null,
          errorCode,
          deviceId,
        };
      };
      let held: HeldPrint;
      try {
        // S2-20 E5 — a booking whose only passes are for a later day owes no
        // band today: nothing to print, and the printer is not asked.
        held =
          requests.length === 0
            ? { paper: { complete: true, printed: 0, outcomes: [], fault: null }, stopped: null }
            : await printHoldingTheRedemption(
                tx,
                printer,
                requests,
                sheet.out,
                { ...PRINT_LIMITS, ...ctx.printLimits },
                watch,
                ctx.log,
              );
      } catch (err) {
        // The box's own print call threw: the paper counted so far is all the kiosk knows of.
        ctx.log?.error({ err, sessionId: session.id }, 'the kiosk print failed unexpectedly');
        sheet.unanswered = true;
        printRun = runOf('PRINT_FAILED', null);
        throw stopPrint(new KioskStop('PRINT_FAILED', 'print', countOut(sheet), bookingId));
      }
      if (held.stopped || !held.paper) {
        // The kiosk stopped the print: the budget ran out, or the hold on the database was lost.
        sheet.unanswered = !held.paper;
        const reason = held.stopped === 'hold' ? KIOSK_REASONS.printHoldLost : KIOSK_REASONS.printTimeout;
        if (held.paper) {
          sheet.out.splice(0, sheet.out.length, ...held.paper.outcomes.filter((o) => o.status === 'printed'));
          sheet.fault = held.paper.fault;
        }
        printRun = runOf(reason, null);
        throw stopPrint(new KioskStop(reason, 'print', countOut(sheet), bookingId));
      }
      const paper = held.paper;
      // The printer's answer is the record of what came out.
      sheet.out.splice(0, sheet.out.length, ...paper.outcomes.filter((o) => o.status === 'printed'));
      if (!paper.complete) {
        sheet.fault = paper.fault;
        const code = paper.fault?.errorCode === PRINT_CALLED_OFF ? KIOSK_REASONS.printTimeout : (paper.fault?.errorCode ?? 'PRINT_FAILED');
        const deviceId = paper.fault?.deviceId ?? null;
        printRun = runOf(code, deviceId);
        throw stopPrint(new KioskStop(code, 'print', { ...countOut(sheet), deviceId }, bookingId));
      }
      printRun = requests.length > 0 ? runOf(null, null) : null;
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
       * Q11 (the owner's default: yes) — redeeming a booking at the kiosk also
       * checked in the event passes it carries, as the till's redemption does
       * (`Till.tsx` 437-462): `redeemBookingAtCounter` made the check-ins in
       * this transaction, and their bands were in the set that just printed.
       * A pass the OTO App no longer has for this child, or not for today,
       * is the desk's to sort out — never a false "all done".
       */
      const passesForDesk = passes.checkins.filter(
        (c) => c.outcome === 'not_found' || c.outcome === 'not_registered',
      ).length;
      const outcome: KioskSessionOutcome = supervised.length > 0 || passesForDesk > 0 ? 'handed_off' : 'issued';
      const handOffReason = supervised.length > 0 ? KIOSK_REASONS.supervisedRest : KIOSK_REASONS.eventPassAtDesk;
      const bandIds = allBands.map((b) => b.id);
      const detail = {
        stage: 'print',
        supervisedChildren,
        printed: paper.printed,
        bandsPrinted: countOut(sheet).bandsPrinted,
        jobs: requests.length,
        // SCRUM-504 — the receipt and vouchers queued to the box, printing after this commits.
        paperQueued: paperQueued.length,
        walletGrants: done.grants.length,
        // S2-20 E5 — the booking's event passes: checked in here, and left for the desk.
        eventPasses: passes.checkins.length,
        eventPassesCheckedIn: passes.checkinIds.length,
        eventPassesForDesk: passesForDesk,
      };
      owedCheckins.ids = passes.checkinIds;
      const [row] = await tx
        .update(kioskSession)
        .set({
          outcome,
          reason: outcome === 'handed_off' ? handOffReason : null,
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
          queuedPrintJobIds: paperQueued.map((j) => j.id),
          walletIds: done.grants.map((g) => g.walletId),
          // S2-20 E5 — the event passes checked in by this redemption (Q11).
          eventCheckinIds: passes.checkinIds,
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
            reason: handOffReason,
            bookingId,
            reference: done.booking.reference,
            saleId: done.sale.id,
            supervisedChildren,
            eventPassesForDesk: passesForDesk,
            issued: true,
          },
          requestId: ctx.requestId,
          actionId: input.actionId,
        });
      }
      return row;
    });
    // The connection is back in the pool, which listens on it from here.
    watch.detach();
    await recordKioskPrintRun(db, ctx, device, session, input.actionId, printRun, true);
    // S2-20 E5 — the OTO App is told of the passes this redemption checked in,
    // after the commit (E3's write-back): what fails waits on Failures.
    const directory = bookingPassDirectory();
    if (directory && owedCheckins.ids.length > 0) {
      await sendBookingPassCheckins({ db, directory, ...(ctx.log ? { log: ctx.log } : {}) }, owedCheckins.ids, {
        requestId: ctx.requestId,
      });
    }
    return answerOf(db, ended, false);
  } catch (err) {
    // After the transaction gave its connection back, whichever way it ended.
    watch.detach();
    const sheet = track.sheet;
    let stop: KioskStop;
    if (err instanceof KioskStop) stop = err;
    else if (track.stop) {
      // The print's own ending; the error is the rollback after it, on a connection already gone.
      stop = track.stop;
      ctx.log?.warn({ err, sessionId: session.id, reason: stop.reason }, 'the kiosk redemption could not roll back; nothing was committed');
    } else if (sheet) {
      /**
       * SCRUM-504 — something the platform did not expect, after the print
       * began: the connection ended under the commit, or a write after the
       * paper failed. Nothing was committed, and paper may be in the tray, so
       * the session counts it and the guest is answered, not given a 500.
       */
      const complete = sheet.out.length === sheet.requests.length;
      stop = new KioskStop(
        watch.lost || connectionLost(err) ? KIOSK_REASONS.printHoldLost : KIOSK_REASONS.internal,
        complete ? 'commit' : 'print',
        countOut(sheet),
        found?.id ?? null,
      );
      ctx.log?.error(
        { err, sessionId: session.id, reason: stop.reason, printed: sheet.out.length },
        'a kiosk redemption failed after its print began; ended failed with the paper counted',
      );
    } else {
      stop = new KioskStop(KIOSK_REASONS.internal, 'claim', {}, found?.id ?? null);
      ctx.log?.error({ err, sessionId: session.id }, 'a kiosk redemption failed unexpectedly; nothing was issued');
    }
    // After the rollback, on the pool: the record of the attempt outlives it (services/ops.ts).
    await recordKioskPrintRun(db, ctx, device, session, input.actionId, printRun, false);
    const ended = await endFailed(db, ctx, device, session, stop, now);
    // Before the print began, a fault nobody expected is a 500 as well; after it, never.
    if (!(err instanceof KioskStop) && !track.stop && !sheet) throw err;
    return answerOf(db, ended, false);
  }
}

// --- The print, on the operational record (S2-20 K2) ---------------------------

/** What the kiosk's print did, captured inside the redemption and written down after it. */
interface KioskPrintRun {
  startedAt: Date;
  finishedAt: Date;
  jobs: number;
  printed: number;
  /** SCRUM-504 — how many of `printed` were wristbands: all of them, since the kiosk prints nothing else in its hold. */
  bandsPrinted: number;
  complete: boolean;
  /**
   * The printer's own code (`PRINTER_UNREACHABLE`, `PRINTER_PAPER_OUT`, …),
   * `KIOSK_BOX_OFFLINE`, or the kiosk's own stop (`KIOSK_PRINT_TIMEOUT`,
   * `KIOSK_PRINT_HOLD_LOST`, SCRUM-504).
   */
  errorCode: string | null;
  deviceId: string | null;
}

/** The ops_run name of every kiosk print: one name, so the Failures page groups by the fault. */
export const KIOSK_PRINT_RUN = 'device:kiosk.print';

/**
 * THE KIOSK'S PRINT IS A DEVICE RUN (plan §10: `ops_run` kind `device` for the
 * kiosk print). One row per press that reached the printer — or was called off
 * because the box could not be reached — `ok` when every job came out and
 * `failed` with the printer's code otherwise, so "the kiosk printer keeps
 * running out of paper" is one line on Failures and its last success is on the
 * register.
 *
 * `committed` says whether the redemption around the paper stood: a print that
 * came out whole under a redemption that then failed (its connection lost
 * under the commit, SCRUM-504) is still a print that worked, and the detail
 * says the rest — `printed` and `bandsPrinted` are the paper in the tray.
 *
 * Never thrown from: the guest's answer does not wait on the record of it.
 */
async function recordKioskPrintRun(
  db: Db,
  ctx: KioskContext,
  device: KioskDeviceAuth,
  session: SessionRow,
  actionId: string,
  run: KioskPrintRun | null,
  committed: boolean,
): Promise<void> {
  if (!run) return;
  try {
    await recordRun(db, {
      kind: 'device',
      name: KIOSK_PRINT_RUN,
      outcome: run.complete ? 'ok' : 'failed',
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      ...(run.complete
        ? {}
        : { error: new AppError(500, run.errorCode ?? 'PRINT_FAILED', 'The kiosk print did not complete') }),
      detail: {
        sessionId: session.id,
        jobs: run.jobs,
        printed: run.printed,
        bandsPrinted: run.bandsPrinted,
        deviceId: run.deviceId,
        boxId: device.station.boxId,
        committed,
      },
      requestId: ctx.requestId,
      actionId,
      operatorId: device.station.operatorId,
      branchId: device.station.branchId,
      stationId: device.station.id,
    });
  } catch (err) {
    ctx.log?.warn({ err, sessionId: session.id }, 'the kiosk print run could not be recorded');
  }
}

// --- The guest's session (S2-20 K2) ----------------------------------------------

function sessionAnswerOf(row: SessionRow) {
  return {
    sessionId: row.id,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    outcome: (row.outcome ?? null) as KioskSessionOutcome | null,
  };
}

/** How many superseded sessions get an audit row each on one start. */
const SUPERSEDE_AUDIT_LIMIT = 20;

/**
 * A GUEST LEAVES THE ATTRACT SCREEN: their session opens before anything is
 * scanned, so walking away from it can be recorded (Q9).
 *
 * The id is the screen's, so a start sent twice is one session. Any earlier
 * session at this kiosk that is still open with nothing pressed on it is
 * ended `abandoned` (`KIOSK_SESSION_SUPERSEDED`) in the same transaction: the
 * screen is one guest at a time, and a new guest means the last one left
 * without the screen being able to say so. A session with a press running is
 * left alone — its press decides it.
 */
export async function startKioskSession(
  db: Db,
  ctx: KioskContext,
  device: KioskDeviceAuth,
  input: KioskSessionStartRequest,
): Promise<KioskSessionAnswer> {
  const now = ctx.now?.() ?? new Date();
  const st = device.station;
  return withTx(db, opCtxOf(ctx, device), 'kiosk.session_start', async (tx) => {
    const [existing] = await tx.select().from(kioskSession).where(eq(kioskSession.id, input.sessionId)).limit(1);
    if (existing) {
      if (existing.stationId !== st.id) {
        throw new AppError(409, 'KIOSK_SESSION_TAKEN', 'That session id belongs to another kiosk');
      }
      return sessionAnswerOf(existing);
    }
    const left = await tx
      .update(kioskSession)
      .set({
        outcome: 'abandoned',
        reason: KIOSK_REASONS.superseded,
        endedAt: now,
        detail: { stage: 'attract' },
      })
      .where(and(eq(kioskSession.stationId, st.id), isNull(kioskSession.outcome), isNull(kioskSession.actionId)))
      .returning({ id: kioskSession.id });
    // One audit row each, up to a bound: a screen that lost every answer for a day is one line too many.
    for (const gone of left.slice(0, SUPERSEDE_AUDIT_LIMIT)) {
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: st.operatorId,
        branchId: st.branchId,
        action: 'kiosk.abandon',
        entityType: 'kiosk_session',
        entityId: gone.id,
        before: { outcome: null },
        after: { ...whereOf(device), outcome: 'abandoned', reason: KIOSK_REASONS.superseded },
        requestId: ctx.requestId,
      });
    }
    const [row] = await tx
      .insert(kioskSession)
      .values({
        id: input.sessionId,
        operatorId: st.operatorId,
        branchId: st.branchId,
        stationId: st.id,
        deviceCredentialId: device.credentialId,
        boxId: st.boxId,
        startedAt: now,
      })
      .returning();
    return sessionAnswerOf(row!);
  });
}

/**
 * Q9 — THE GUEST WALKED AWAY: 60 seconds of no touch or scan (or "Start
 * over" before any scan) returns the kiosk to its attract screen, and the
 * session is recorded `abandoned` with `kiosk.abandon`, naming the station and
 * the box.
 *
 * Only a session that scanned nothing is abandoned. One whose press is
 * running, or has ended, is answered as it stands with `abandoned: false` —
 * the press decides how a session that scanned something ended, and a
 * redemption is never written off as walked away from.
 */
export async function abandonKioskSession(
  db: Db,
  ctx: KioskContext,
  device: KioskDeviceAuth,
  sessionId: string,
  input: KioskAbandonRequest,
): Promise<KioskAbandonAnswer> {
  const now = ctx.now?.() ?? new Date();
  const st = device.station;
  const reason = input.cause === 'cancelled' ? KIOSK_REASONS.cancelled : KIOSK_REASONS.idle;
  return withTx(db, opCtxOf(ctx, device), 'kiosk.abandon', async (tx) => {
    const [ended] = await tx
      .update(kioskSession)
      .set({ outcome: 'abandoned', reason, endedAt: now, detail: { stage: 'scan', cause: input.cause } })
      .where(
        and(
          eq(kioskSession.id, sessionId),
          eq(kioskSession.stationId, st.id),
          isNull(kioskSession.outcome),
          isNull(kioskSession.actionId),
        ),
      )
      .returning();
    if (ended) {
      await audit.record(tx, {
        actorAccountId: null,
        operatorId: st.operatorId,
        branchId: st.branchId,
        action: 'kiosk.abandon',
        entityType: 'kiosk_session',
        entityId: ended.id,
        before: { outcome: null },
        after: { ...whereOf(device), outcome: 'abandoned', reason, cause: input.cause },
        requestId: ctx.requestId,
      });
      return { ...sessionAnswerOf(ended), abandoned: true };
    }
    const [held] = await tx
      .select()
      .from(kioskSession)
      .where(and(eq(kioskSession.id, sessionId), eq(kioskSession.stationId, st.id)))
      .limit(1);
    if (!held) throw new AppError(404, 'KIOSK_SESSION_NOT_FOUND', 'No such session at this kiosk');
    return { ...sessionAnswerOf(held), abandoned: false };
  });
}

/** What the kiosk's screen reads about itself. Polled, so it is also how the Console knows the screen is up. */
export async function kioskState(db: Db, device: KioskDeviceAuth): Promise<KioskState> {
  const [br] = await db
    .select({ name: branch.name })
    .from(branch)
    .where(eq(branch.id, device.station.branchId))
    .limit(1);
  return {
    station: { id: device.station.id, name: device.station.name },
    branchName: br?.name ?? null,
    idleTimeoutMs: KIOSK_IDLE_TIMEOUT_MS,
  };
}
