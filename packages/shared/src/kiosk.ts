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
} as const;

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
