import { z } from 'zod';

/**
 * S2-20 K1 (SCRUM-217) — THE SELF-SERVICE KIOSK'S REDEMPTION, as the kiosk and
 * the platform both read it.
 *
 * The prototype has no kiosk. The authority is PROJECT_CONTEXT §7.6 ("one
 * implementation, two surfaces"), R-80, the proposal's story 18 ("device
 * failure never marks handoff") and the events-kiosk plan
 * (`docs/progress/plans/events-kiosk/PLAN.md` §5, §8, §10). So this file adds
 * no rule of its own: it states the words the two halves exchange.
 *
 * **What the kiosk is never told** (R-58, hazard H15): a child's allergy or
 * medical note, a phone number, a name, a guardian, a contact channel. The
 * answer below is `.strict()`, so a field that would put one on a screen in a
 * shopping centre has to be added here first, where a test reads every key.
 */

/**
 * THE KIOSK'S DEVICE SCOPE — carried by a kiosk's paired credential and by no
 * person (plan §10).
 *
 * Deliberately NOT in `PERMISSIONS`: `platform_admin` and `operator_admin` hold
 * the whole of that list (`ROLE_BUNDLES`), so a device scope declared there
 * would be held by every administrator. A device scope is a capability of a
 * machine, like the display's `display:read`, and lives beside it rather than
 * in the human vocabulary a role is built from.
 */
export const KIOSK_REDEEM_SCOPE = 'pos:kiosk:redeem' as const;

/** Every scope a kiosk credential carries, as `core.device_credential.scopes` holds them. */
export const KIOSK_DEVICE_SCOPES = [KIOSK_REDEEM_SCOPE] as const;
export type KioskDeviceScope = (typeof KIOSK_DEVICE_SCOPES)[number];

/**
 * How a kiosk session ends (`pos.kiosk_session.outcome`; null while it runs).
 *
 *   issued      the booking was redeemed here and every band came out of the
 *               kiosk's printer: nothing is left for the desk.
 *   handed_off  the guest is sent to the staff desk for a supervised child —
 *               after the rest of the booking was issued and printed (a mixed
 *               booking), or with nothing issued at all (every line is a
 *               drop-off or nanny line). Never written for a printer fault.
 *   failed      nothing was redeemed: a refusal (already redeemed, not paid,
 *               another park's booking, a QR the park did not sign) or an
 *               abort (a printer fault, paper out, the box offline). The
 *               booking is exactly as it was, and the till can redeem it.
 *   abandoned   the guest walked away (the idle timeout — the surface round).
 */
export const KIOSK_SESSION_OUTCOMES = ['issued', 'handed_off', 'failed', 'abandoned'] as const;
export type KioskSessionOutcome = (typeof KIOSK_SESSION_OUTCOMES)[number];

/**
 * The reasons the platform itself names, beside the refusal codes the shared
 * redemption already speaks (`BOOKING_ALREADY_REDEEMED`, `BOOKING_NOT_REDEEMABLE`,
 * `BOOKING_QR_SIGNATURE_INVALID`, `BOOKING_TOTAL_DRIFT`, …) and the printer's
 * own (`PRINTER_UNREACHABLE`, `PRINTER_PAPER_OUT`, …), which are passed through.
 */
export const KIOSK_REASONS = {
  /** Every line is a drop-off or nanny child: the desk issues them (R-80). */
  supervised: 'KIOSK_SUPERVISED_AT_DESK',
  /** A mixed booking: the regular bands came out here, the rest is the desk's. */
  supervisedRest: 'KIOSK_SUPERVISED_REST_AT_DESK',
  /** The kiosk's box is offline or not reachable, so nothing can print. */
  boxOffline: 'KIOSK_BOX_OFFLINE',
  /** The booking is another park's. */
  otherBranch: 'KIOSK_BOOKING_OTHER_BRANCH',
  /** What was scanned is not a booking QR at all. */
  notABookingQr: 'KIOSK_NOT_A_BOOKING_QR',
  /** The press is already being redeemed (the same press, sent again while it runs). */
  inProgress: 'KIOSK_REDEEM_IN_PROGRESS',
  /** The kiosk has no band printer for a band the booking owes. */
  noBandPrinter: 'KIOSK_NO_BAND_PRINTER',
  /** The redemption minted no band (no band key on this deployment). */
  bandsNotIssued: 'KIOSK_BANDS_NOT_ISSUED',
  /** The paper could not be composed for the redemption's sale. */
  printRouting: 'KIOSK_PRINT_ROUTING_FAILED',
  /** A press that never finished (the process stopped mid-redemption). */
  interrupted: 'KIOSK_INTERRUPTED',
  /** Anything else the platform did not expect. */
  internal: 'KIOSK_INTERNAL_ERROR',
  /**
   * S2-20 K2 — Q9: nobody touched the screen or scanned for
   * `KIOSK_IDLE_TIMEOUT_MS`, so the kiosk went back to its attract screen.
   */
  idle: 'KIOSK_IDLE_TIMEOUT',
  /** S2-20 K2 — the guest pressed "Start over" before scanning anything. */
  cancelled: 'KIOSK_GUEST_CANCELLED',
  /**
   * S2-20 K2 — the screen opened a new session while an earlier one at the
   * same kiosk was still open with nothing scanned: the earlier guest had
   * gone, and the screen could not say so (a dropped answer, a reload).
   */
  superseded: 'KIOSK_SESSION_SUPERSEDED',
} as const;

// --- S2-20 K2: the kiosk's own screen ---------------------------------------

/**
 * Q9 (the owner's default): 60 seconds of no touch or scan returns the kiosk
 * to its attract screen, and a session that scanned nothing is recorded
 * `abandoned` (`kiosk.abandon`, with the station and the box). A press in
 * flight is never timed out: the guest is watching the printer.
 */
export const KIOSK_IDLE_TIMEOUT_MS = 60_000;

/** Why a session was abandoned, as the screen says it. */
export const KIOSK_ABANDON_CAUSES = ['idle', 'cancelled'] as const;
export type KioskAbandonCause = (typeof KIOSK_ABANDON_CAUSES)[number];

/**
 * A guest leaving the attract screen: the session is opened before anything
 * is scanned, so walking away from it can be recorded at all. The id is minted
 * on the kiosk, which makes a resent start the same session.
 */
export const KioskSessionStartRequestSchema = z
  .object({
    sessionId: z.string().uuid(),
  })
  .strict();
export type KioskSessionStartRequest = z.infer<typeof KioskSessionStartRequestSchema>;

/** A session as the kiosk is told about it: when, and how it ended. Nothing else. */
export const KioskSessionAnswerSchema = z
  .object({
    sessionId: z.string().uuid(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    outcome: z.enum(KIOSK_SESSION_OUTCOMES).nullable(),
  })
  .strict();
export type KioskSessionAnswer = z.infer<typeof KioskSessionAnswerSchema>;

export const KioskAbandonRequestSchema = z
  .object({
    cause: z.enum(KIOSK_ABANDON_CAUSES),
  })
  .strict();
export type KioskAbandonRequest = z.infer<typeof KioskAbandonRequestSchema>;

/**
 * What abandoning answered. `abandoned` is false when the session had already
 * ended (the press decided it) or a press is still running on it — a session
 * that scanned something is never written off as walked away from.
 */
export const KioskAbandonAnswerSchema = KioskSessionAnswerSchema.extend({
  abandoned: z.boolean(),
}).strict();
export type KioskAbandonAnswer = z.infer<typeof KioskAbandonAnswerSchema>;

/** What the kiosk's screen reads about itself: which kiosk it is, and its idle timeout. */
export const KioskStateSchema = z
  .object({
    station: z.object({ id: z.string().uuid(), name: z.string() }).strict(),
    branchName: z.string().nullable(),
    idleTimeoutMs: z.number().int().positive(),
  })
  .strict();
export type KioskState = z.infer<typeof KioskStateSchema>;

/**
 * THE KIOSK'S PAIRING CODE — a display's six digits behind a `K`.
 *
 * A kiosk pairs the way a customer display does: the screen makes its own
 * secret, shows a short code, and a manager types the code into Console >
 * Devices. The two kinds of code share one store, so the letter is what keeps
 * them apart: a display's code is six digits and the display claim takes
 * nothing else, and a kiosk's is `K` and six digits and the kiosk claim takes
 * nothing else. A kiosk code typed into "Pair a display" is refused, and the
 * other way round, instead of pairing a kiosk screen as somebody's display.
 */
export const KIOSK_PAIRING_CODE_PREFIX = 'K';
export const KioskPairingCodeSchema = z.string().regex(/^K\d{6}$/);

/** A code as a person typed it — spaces, a dash, a lower-case k or no K at all — or null. */
export function normaliseKioskPairingCode(raw: string): string | null {
  const compact = raw.replace(/[\s-]/g, '').toUpperCase();
  if (/^\d{6}$/.test(compact)) return `${KIOSK_PAIRING_CODE_PREFIX}${compact}`;
  return /^K\d{6}$/.test(compact) ? compact : null;
}

/** `K482913` as the screen shows it: `K 482 913`. */
export function formatKioskPairingCode(code: string): string {
  return /^K\d{6}$/.test(code) ? `${code[0]} ${code.slice(1, 4)} ${code.slice(4)}` : code;
}

export const KioskPairingStartAnswerSchema = z
  .object({
    pairingCode: KioskPairingCodeSchema,
    expiresAt: z.string(),
  })
  .strict();

export const KioskPairingStatusSchema = z
  .object({
    status: z.enum(['pending', 'paired', 'expired']),
    station: z.object({ id: z.string().uuid(), name: z.string() }).strict().optional(),
  })
  .strict();
export type KioskPairingStatus = z.infer<typeof KioskPairingStatusSchema>;

/**
 * THE STAFF DESK'S VIEW of the families a kiosk sent to it today (S2-20 K2).
 *
 *   to_redeem    nothing was issued (a printer fault, the box offline, every
 *                child supervised) and the booking is still paid: the desk
 *                redeems it at the till.
 *   to_check_in  the kiosk issued the regular bands and left drop-off or nanny
 *                children booked: the desk checks them in on the board.
 *   done         the desk (or another kiosk) has finished it since.
 *
 * Staff-facing, so the booking is named; still no child, no allergy, no phone
 * — the till's redeem dialog reads those when it opens the booking.
 */
export const KIOSK_DESK_STATES = ['to_redeem', 'to_check_in', 'done'] as const;
export type KioskDeskState = (typeof KIOSK_DESK_STATES)[number];

export const KioskDeskEntrySchema = z
  .object({
    sessionId: z.string().uuid(),
    stationId: z.string().uuid(),
    stationName: z.string(),
    endedAt: z.string(),
    outcome: z.enum(['failed', 'handed_off']),
    reason: z.string().nullable(),
    booking: z
      .object({
        id: z.string().uuid(),
        reference: z.string(),
        kids: z.number().int().nonnegative(),
        adults: z.number().int().nonnegative(),
        status: z.string(),
      })
      .strict(),
    supervisedChildren: z.number().int().nonnegative(),
    bandsIssued: z.number().int().nonnegative(),
    state: z.enum(KIOSK_DESK_STATES),
  })
  .strict();
export type KioskDeskEntry = z.infer<typeof KioskDeskEntrySchema>;

export const KioskDeskAnswerSchema = z
  .object({
    businessDate: z.string(),
    entries: z.array(KioskDeskEntrySchema),
  })
  .strict();
export type KioskDeskAnswer = z.infer<typeof KioskDeskAnswerSchema>;

/** The Console's Kiosk tile on Health: one row per kiosk station in the reader's reach. */
export const KioskHealthRowSchema = z
  .object({
    stationId: z.string().uuid(),
    name: z.string(),
    branchId: z.string().uuid(),
    branchName: z.string(),
    box: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        online: z.boolean(),
        lastHeartbeatAt: z.string().nullable(),
      })
      .strict()
      .nullable(),
    screen: z
      .object({
        paired: z.boolean(),
        label: z.string().nullable(),
        lastSeenAt: z.string().nullable(),
        online: z.boolean(),
      })
      .strict(),
    printer: z
      .object({
        deviceId: z.string().uuid(),
        label: z.string(),
        reachability: z.string(),
        paperStatus: z.string(),
        faults: z.array(z.string()),
      })
      .strict()
      .nullable(),
    today: z
      .object({
        businessDate: z.string(),
        sessions: z.number().int().nonnegative(),
        issued: z.number().int().nonnegative(),
        handedOff: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        abandoned: z.number().int().nonnegative(),
        open: z.number().int().nonnegative(),
      })
      .strict(),
    lastRedemptionAt: z.string().nullable(),
  })
  .strict();
export type KioskHealthRow = z.infer<typeof KioskHealthRowSchema>;

export const KioskHealthAnswerSchema = z.object({ kiosks: z.array(KioskHealthRowSchema) }).strict();
export type KioskHealthAnswer = z.infer<typeof KioskHealthAnswerSchema>;

/**
 * THE VIRTUAL KIOSK'S SIMULATOR CONTROLS (S2-20 K2): every failure screen the
 * kiosk has, driven without hardware. Applied at once to the box this api
 * runs, as the terminal simulator's are — a guest is standing at the screen
 * in the rehearsal, and "on its next poll" is a guest who scanned first.
 *
 *   printer_offline  the kiosk's band printer stops answering
 *   paper_out        the kiosk's band printer answers, with no paper
 *   box_offline      the kiosk's box cuts its link to the platform
 *   clear            every printer fault cleared and the box back online
 */
export const KIOSK_SIMULATOR_CONTROLS = ['printer_offline', 'paper_out', 'box_offline', 'clear'] as const;
export type KioskSimulatorControl = (typeof KIOSK_SIMULATOR_CONTROLS)[number];

export const KioskSimulatorRequestSchema = z
  .object({
    control: z.enum(KIOSK_SIMULATOR_CONTROLS),
  })
  .strict();

export const KioskSimulatorAnswerSchema = z
  .object({
    stationId: z.string().uuid(),
    boxId: z.string().uuid(),
    control: z.enum(KIOSK_SIMULATOR_CONTROLS),
    boxOffline: z.boolean(),
    printers: z.array(
      z
        .object({
          deviceId: z.string().uuid(),
          label: z.string(),
          faults: z.array(z.string()),
        })
        .strict(),
    ),
    actionId: z.string(),
  })
  .strict();
export type KioskSimulatorAnswer = z.infer<typeof KioskSimulatorAnswerSchema>;

/**
 * One scan's redemption, pressed at the kiosk.
 *
 * `actionId` is minted on the kiosk at the press and is the redemption's
 * identity: the same press sent twice (a dropped answer, a double tap) is
 * answered with what the first one did, and issues nothing twice (H17).
 *
 * `qr` is the WHOLE signed booking QR — the proof that the person in front of
 * the kiosk holds the booking. A typed reference is not taken here: at a
 * counter a person looks at who is asking, and at a kiosk nobody does (an
 * owner question, raised with this round).
 */
export const KioskRedeemRequestSchema = z
  .object({
    actionId: z.string().uuid(),
    qr: z.string().min(1).max(128),
    /**
     * S2-20 K2 — the session the screen opened when the guest left the
     * attract screen. The press takes that row over, so one guest is one
     * session; absent (a K1 caller) or already ended, the press opens its own.
     */
    sessionId: z.string().uuid().optional(),
  })
  .strict();
export type KioskRedeemRequest = z.infer<typeof KioskRedeemRequestSchema>;

/** One band the kiosk printed: its kind and the short code under its QR — never the code itself. */
export const KioskBandSchema = z
  .object({
    kind: z.enum(['kid', 'adult']),
    shortCode: z.string().nullable(),
  })
  .strict();

/**
 * What the kiosk is answered with — whatever the outcome, and the same on a
 * replay of the same press.
 */
export const KioskRedeemAnswerSchema = z
  .object({
    sessionId: z.string().uuid(),
    outcome: z.enum(KIOSK_SESSION_OUTCOMES),
    /** A code, never a sentence with a name in it; null when the booking was simply issued. */
    reason: z.string().nullable(),
    /** True when this press was answered before and nothing was done again. */
    replay: z.boolean(),
    /** What the booking is for, as the screen reads it back. Null when no booking was found. */
    booking: z
      .object({
        reference: z.string(),
        kids: z.number().int().nonnegative(),
        adults: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    /** The bands that came out of the kiosk's printer. */
    bands: z.array(KioskBandSchema),
    /** Wallet credit the tickets loaded (S2-14a), in satang. */
    walletCreditSatang: z.number().int().nonnegative(),
    /** Whether the guest must see the staff desk, and for how many supervised children. */
    desk: z
      .object({
        required: z.boolean(),
        supervisedChildren: z.number().int().nonnegative(),
      })
      .strict(),
    /** When the booking was already redeemed: when and where. No staff names. */
    alreadyRedeemed: z
      .object({
        at: z.string(),
        branchName: z.string().nullable(),
        stationName: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type KioskRedeemAnswer = z.infer<typeof KioskRedeemAnswerSchema>;

/**
 * The key shapes a kiosk answer must never carry (H15). Read by the tests over
 * every key of every answer, nested ones included.
 */
export const KIOSK_PRIVATE_FIELD = /allerg|medical|diet|phone|contact|email|guardian|parent|nickname|childname|note/i;
