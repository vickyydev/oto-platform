import { z } from 'zod';

/**
 * Scanning (S2-06): one service, several input sources, one event on the
 * station channel — and **no new table**.
 *
 * That last part is the decision, so here is the reasoning rather than the
 * conclusion alone. A scan is not a fact about the business; it is the moment
 * somebody pointed a scanner at something. What it MEANS — a band admitted at
 * the gate, a booking redeemed, a voucher spent, a product added to a cart — is
 * written by the ticket that registers the handler (S2-11, S2-12, S2-13, S2-14)
 * into that ticket's own tables, with its own audit row. A `scan` table beside
 * those would hold a second, weaker copy of the same history and would be read
 * by nobody.
 *
 * What the scan itself needs is to be followable for a few days: "I scanned it
 * and nothing happened". That is `edge.station_event`, which already exists,
 * already has `scan` in `STATION_EVENT_KINDS`, already carries the action id
 * and the source, and is already swept after thirty days. This file is the
 * shape of its `payload` for that kind — which is the part that needed
 * deciding, because the obvious payload is wrong.
 */

/** Where a scan came from. */
export const SCAN_SOURCES = [
  /** The DS2278 on the box, read through evdev with an exclusive grab (D2). */
  'box_hid',
  /** The same scanner in USB CDC mode on `/dev/ttyACM*`. */
  'box_serial',
  /** A camera on the till or kiosk, the fallback when no scanner is attached. */
  'camera',
  /** A Bluetooth scanner paired to the iPad, typing into the browser (§7.4). */
  'keyboard',
  /** The scanner simulator in the Console's Simulators panel. */
  'simulator',
  /** Typed in by a person because the code would not read. */
  'manual',
] as const;
export type ScanSource = (typeof SCAN_SOURCES)[number];

/**
 * What the scanning service decided the code was, before any handler ran.
 *
 * Classification is by shape and prefix and happens on the box, offline: a band
 * code is a station-prefixed ULID with an HMAC, a booking QR and a benefit QR
 * are signed tokens with their own headers, a product barcode is an EAN or
 * Code 128 from the catalogue cache. `unknown` is a real outcome and the till
 * shows it as one — "that code means nothing here" is more useful than silence.
 */
export const SCAN_CODE_KINDS = [
  'band',
  'booking',
  'voucher',
  'benefit',
  'product',
  'staff_badge',
  'legacy',
  'unknown',
] as const;
export type ScanCodeKind = (typeof SCAN_CODE_KINDS)[number];

/** What became of it once the registered handlers had their turn. */
export const SCAN_OUTCOMES = ['handled', 'unhandled', 'refused', 'error'] as const;
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

/**
 * How much of a scanned code may be written down.
 *
 * **A band code is a credential.** It opens the gate, it is signed so that a
 * box can admit a guest with no network, and it is exactly what somebody
 * photographing a queue would want. `edge.station_event` is telemetry: it is
 * read on a Console page, kept for thirty days, and carries a rule from the
 * heartbeat protocol that nothing personal goes up it. Writing the raw code
 * there would put a working gate credential in a log with a month's retention
 * and a web page over it.
 *
 * So the tape holds a fingerprint instead: the first sixteen hex characters of
 * the SHA-256 of the code. That is enough to answer every question the tape is
 * for — was this the same code twice, did the code the gate saw match the one
 * the till printed, which of these thirty scans was the one that failed — and
 * not enough to open anything.
 */
export const SCAN_FINGERPRINT_LENGTH = 16;

/**
 * The redacted `payload` of an `edge.station_event` row with `kind = 'scan'`.
 *
 * `codePrefix` is the human-readable station prefix a band code starts with
 * (`T1`, `B1`) where there is one — it identifies the till that minted a band,
 * which is a routine support question, and it is printed on the band in large
 * type anyway.
 */
export const ScanEventPayloadSchema = z
  .object({
    source: z.enum(SCAN_SOURCES),
    codeKind: z.enum(SCAN_CODE_KINDS),
    /** SHA-256 of the raw code, first `SCAN_FINGERPRINT_LENGTH` hex characters. */
    codeFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
    /** How many characters the code was. A truncated scan is visible from this alone. */
    codeLength: z.number().int().min(0).max(4096),
    codePrefix: z.string().max(8).optional(),
    outcome: z.enum(SCAN_OUTCOMES),
    /** Which registered handler took it, by name. Absent when nothing did. */
    handler: z.string().max(64).optional(),
    /** Short, non-leaking, as `ops_run.error_code` is. */
    errorCode: z.string().max(64).optional(),
    /** Milliseconds from the last character to the handler returning. */
    durationMs: z.number().int().min(0).optional(),
  })
  .strict();
export type ScanEventPayload = z.infer<typeof ScanEventPayloadSchema>;

/**
 * What a scanner simulator, or an iPad-paired scanner, sends to the box.
 *
 * The raw code IS here — it has to be, this is the input — and it is the
 * boundary at which it stops travelling: the box classifies it, hands it to the
 * handlers, and writes only the fingerprint to the tape.
 */
export const ScanInputSchema = z.object({
  code: z.string().min(1).max(4096),
  source: z.enum(SCAN_SOURCES),
  /** When the last character arrived, by the sending device's clock. */
  scannedAt: z.string().optional(),
  /** `x-oto-action-id`, so the Box log drawer line and the till line are the same event. */
  actionId: z.string().max(64).optional(),
});
export type ScanInput = z.infer<typeof ScanInputSchema>;

/**
 * The physical USB button beside the counter, which is not a scan.
 *
 * It arrives on the same HID device path as a keyboard-wedge scanner, which is
 * why it needs to be distinguishable at all: the acceptance criterion is that
 * a button press is told apart from a scanner's Enter. It is told apart by the
 * key it sends, configured per device in `core.device.settings.scanner
 * .buttonKey`, which is refused if anybody sets it to Enter.
 */
export const ButtonPressSchema = z.object({
  key: z.string().min(1).max(24),
  actionId: z.string().max(64).optional(),
});
export type ButtonPress = z.infer<typeof ButtonPressSchema>;
