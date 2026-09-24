import { createHash } from 'node:crypto';

import { isLegacyBoothCode, normaliseBoothCode, verifyBoothCode } from '@oto/shared';

import type { StationScanMessage } from './contract';
import type { BoxStore, StationEventSource } from './store';
import { silentLog, type AgentLog } from './transport';

/**
 * The scanning service (S2-06): one code, several ways in, one place it lands.
 *
 * A park has a scanner at the gate, a scanner at the till, a camera on an iPad
 * and a Console panel that pretends to be any of them, and every one of them
 * produces the same thing: a string somebody pointed a machine at. What the
 * string MEANS — a band admitted, a booking redeemed, a voucher spent, a
 * product added — belongs to the tickets that own those flows, so this file is
 * deliberately the seam and not the handlers. S2-11, S2-12 and S2-13 each
 * register their own; a code nothing claims resolves `unhandled`, which is a
 * real outcome and is shown as one.
 *
 * The one handler that lives here is `productBarcodeHandler` (S2-09b), and it
 * is here because the thing it decides — what a retail barcode LOOKS like — is
 * a property of the scanner and the printed label rather than of any catalogue.
 * The lookup it needs is handed in, so this package still knows nothing about
 * products and carries no database dependency.
 *
 * **Where scans come from, and where they do not.** The Zebra DS2278 is on the
 * BOX, not on the iPad (DEVICE_INVENTORY D2): the box reads it over USB CDC or
 * through an exclusive evdev grab and delivers it here, so the till, the
 * display, the gate and the kiosk all receive scans the same way, online or
 * offline. A Bluetooth scanner paired to an iPad and the iPad's own camera
 * remain supported (PROJECT_CONTEXT §7.4) and arrive at the same door from the
 * other side.
 *
 * **What is written down.** A line on the station's own tape
 * (`edge.station_event`, kind `scan`, thirty days) carrying a FINGERPRINT of
 * the code and never the code. A band code is a gate credential: it is signed
 * so that a box can admit a guest with no network, which is exactly what makes
 * it worth stealing, and the tape is read on a web page. Sixteen hex
 * characters of SHA-256 answer every question the tape is for — was this the
 * same code twice, did the gate see what the till printed, which of these
 * thirty scans failed — and open nothing.
 */

/** Where a scan came from. Mirrors `SCAN_SOURCES` in `@oto/shared`. */
export const SCAN_SOURCES = [
  'box_hid',
  'box_serial',
  'camera',
  'keyboard',
  'simulator',
  'manual',
] as const;
export type ScanSource = (typeof SCAN_SOURCES)[number];

/** Mirrors `SCAN_CODE_KINDS` in `@oto/shared`. */
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

/** Mirrors `SCAN_OUTCOMES` in `@oto/shared`. */
export const SCAN_OUTCOMES = ['handled', 'unhandled', 'refused', 'error'] as const;
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

/** Mirrors `SCAN_FINGERPRINT_LENGTH` in `@oto/shared`. */
export const SCAN_FINGERPRINT_LENGTH = 16;

/** The longest code this service will look at. A QR holds far less than this. */
export const SCAN_MAX_LENGTH = 4096;

export interface ScanInput {
  code: string;
  source: ScanSource;
  /** When the last character arrived, by the sending device's clock. */
  scannedAt?: string;
  /** `x-oto-action-id`: one gesture, one id, from the button to the tape. */
  actionId?: string | null;
  /** Who was standing there, when a screen sent it. Never invented by the box. */
  accountId?: string | null;
}

export interface ScanHandlerContext {
  stationId: string;
  boxId: string;
  /** The raw code. This is the last place it exists in full. */
  code: string;
  kind: ScanCodeKind;
  source: ScanSource;
  actionId: string | null;
  accountId: string | null;
  at: Date;
}

export interface ScanHandlerResult {
  outcome: Exclude<ScanOutcome, 'unhandled'>;
  /** Short and non-leaking, the way `ops_run.error_code` is. */
  errorCode?: string;
  /**
   * What the till should do with it. Goes to the screens on the station
   * channel and NOT onto the tape — a handler may want to say "member Mali,
   * two children", and the tape is not the place for that.
   */
  detail?: Record<string, unknown>;
}

export interface ScanHandler {
  /** Shown on the tape and in the Box log drawer. Short. */
  name: string;
  /** What this handler says the code is. */
  kind: ScanCodeKind;
  /**
   * Cheap, synchronous and total: it runs on every scan, including ones meant
   * for another handler. A matcher that throws is treated as "not mine" and
   * logged, because one broken handler must not stop the gate reading bands.
   */
  matches(code: string): boolean;
  handle(ctx: ScanHandlerContext): Promise<ScanHandlerResult | void> | ScanHandlerResult | void;
}

export interface ScanResult {
  /** Always true when the service accepted the input; the OUTCOME is separate. */
  accepted: boolean;
  kind: ScanCodeKind;
  outcome: ScanOutcome;
  handler: string | null;
  errorCode: string | null;
  codeFingerprint: string;
  codeLength: number;
  codePrefix?: string;
  detail?: Record<string, unknown>;
  durationMs: number;
  actionId: string | null;
}

export interface ScanRouterOptions {
  boxId: string;
  store: BoxStore;
  /** Fans the scan out to the screens watching this station. */
  publish?: (stationId: string, message: StationScanMessage) => void;
  now?: () => Date;
  log?: AgentLog;
}

/** SHA-256 of the code, first `SCAN_FINGERPRINT_LENGTH` hex characters. */
export function scanFingerprint(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, SCAN_FINGERPRINT_LENGTH);
}

/**
 * The station prefix a code starts with, when it has one.
 *
 * A band code is a station-prefixed ULID (PROJECT_CONTEXT §8) and the prefix is
 * printed on the band in large type, so keeping it on the tape costs nothing
 * and answers the routine support question — which till printed this? It is a
 * HEURISTIC over the shape and nothing more: `T1-…` yields `T1`, a bare code
 * yields nothing, and no part of the system decides anything from it.
 */
export function scanPrefix(code: string): string | undefined {
  const match = /^([A-Z0-9]{1,4})[-_:]/.exec(code);
  return match ? match[1] : undefined;
}

/**
 * Which `edge.station_event.source` a scan is recorded under.
 *
 * Two different vocabularies meet here and neither is wrong: the tape's
 * `source` is the SCREEN or the box (its CHECK constraint says so), and a
 * scan's `source` is the piece of hardware. So the hardware source travels in
 * the payload, and the row says where it entered the system. A scanner on the
 * box — and the simulator, which pretends to be one — is `box`; a camera or a
 * paired keyboard belongs to the screen that sent it.
 */
export function stationSourceForScan(
  source: ScanSource,
  screen: StationEventSource = 'till',
): StationEventSource {
  return source === 'box_hid' || source === 'box_serial' || source === 'simulator'
    ? 'box'
    : screen;
}

// --- The product barcode handler (S2-09b) -----------------------------------

/**
 * The name this handler goes by on the tape and in the Box log drawer.
 *
 * Exported because registration has to be idempotent: the api's fallback router
 * is built per request, but when this process runs the box's own agent the
 * router is the agent's and lives as long as the process — registering on every
 * scan would stack a hundred copies of the same handler behind each other.
 */
export const PRODUCT_BARCODE_HANDLER = 'product-barcode';

/**
 * What the handler asks of whoever owns the catalogue.
 *
 * The box does not know what a product is and must not: `packages/box-agent`
 * has no database of its own on a Pi and no `@oto/db` dependency here, and the
 * merch row lives in Postgres behind the api. So the SHAPE of a barcode is
 * decided on this side — it is a property of the scanner and the label, not of
 * the catalogue — and the LOOKUP is handed in.
 *
 * `null` means the shape was a barcode and nothing in this park sells it. That
 * is a different answer from "no handler claimed the code", and the till says
 * two different things about them.
 */
export type ProductBarcodeLookup = (
  ctx: ScanHandlerContext,
) => Promise<ProductBarcodeMatch | null> | ProductBarcodeMatch | null;

/** The one sellable thing a barcode names. */
export interface ProductBarcodeMatch {
  productId: string;
  name: string;
  /**
   * The code as the catalogue holds it — the item's own `product.sku`, or the
   * barcode on the size it names.
   */
  sku: string;
  priceSatang: number;
  /** Null on the row means "the same as the weekday price". */
  priceWeekendSatang?: number | null;
  categoryId?: string | null;
  branchId?: string | null;
  /**
   * The size the barcode is on, when it is on one of the item's sizes
   * (`product.variants`, S2-09b) rather than on the item itself. Null for the
   * item's own code, which names no size — the till asks for one then, when
   * the item has more than one.
   */
  variant?: { id: string; label: string } | null;
}

/** What the till is told a barcode meant. `SCAN_MAX_LENGTH` still applies. */
export const UNKNOWN_BARCODE = 'UNKNOWN_BARCODE';

/**
 * Is this string shaped like a retail barcode?
 *
 * Digits only, and eight to fourteen of them: EAN-8 and UPC-E are 8, UPC-A is
 * 12, EAN-13 is 13 — `8850000000017` is a Thai EAN-13, the 885 prefix being
 * GS1 Thailand — and ITF-14 on a case is 14. The check digit is NOT verified:
 * the scanner already did it in hardware and refuses to transmit a code whose
 * check digit fails, so re-deriving it here could only ever reject a label a
 * park had deliberately printed for itself.
 *
 * It is a shape test and nothing more. A band code is a station-prefixed ULID
 * and a booking QR carries a header, so neither is digits-only; both would be
 * claimed by their own handler first in any case, which is what the
 * registration-order note on `register` is about — this matcher is the BROAD
 * one and belongs last.
 */
export function isProductBarcode(code: string): boolean {
  return /^[0-9]{8,14}$/.test(code);
}

/**
 * The handler: a barcode off the counter scanner becomes one merch line.
 *
 * A miss is `refused`, not `error`: a code the shop does not sell is an
 * ordinary event at a till — somebody scanned the wrong side of the box, or a
 * bottle they brought in with them — and `error` is reserved for the handler
 * itself failing. Either way NOTHING is added, and `detail` carries the
 * sentence the screen shows.
 */
export function productBarcodeHandler(lookup: ProductBarcodeLookup): ScanHandler {
  return {
    name: PRODUCT_BARCODE_HANDLER,
    kind: 'product',
    matches: isProductBarcode,
    async handle(ctx) {
      const match = await lookup(ctx);
      if (!match) {
        return {
          outcome: 'refused',
          errorCode: UNKNOWN_BARCODE,
          detail: { message: 'Unknown barcode', barcodeLength: ctx.code.length },
        };
      }
      return {
        outcome: 'handled',
        /**
         * The line the shop screen adds, as an INTENT rather than a rendered
         * row: the cart owns quantity, merging and modifiers, and a scan is
         * one guest putting one thing on the counter. It rides the station
         * channel (`StationScanMessage.detail`) and never the tape — the tape
         * is a thirty-day table behind a web page, and this names a product
         * and a price.
         */
        detail: {
          add: {
            kind: 'product',
            productId: match.productId,
            name: match.name,
            // What was scanned, in words: the item, and the size when the code
            // is on one — "Grip Socks M". The shop line itself is built from
            // `productId` and `variant`, so this is for whoever reads the answer.
            label: match.variant ? `${match.name} ${match.variant.label}` : match.name,
            sku: match.sku,
            priceSatang: match.priceSatang,
            priceWeekendSatang: match.priceWeekendSatang ?? null,
            categoryId: match.categoryId ?? null,
            branchId: match.branchId ?? null,
            variant: match.variant ?? null,
            quantity: 1,
          },
        },
      };
    },
  };
}

// --- The Lucky Wheel voucher code (S2-10b, SCRUM-207) -----------------------

/**
 * The name the voucher handler goes by on the tape, in the Box log drawer and
 * on the station channel. The tills read it to know a scan is a voucher
 * (`apps/pos/src/lib/scanChannel.ts`).
 */
export const VOUCHER_CODE_HANDLER = 'voucher';

/**
 * Is this string a Lucky Wheel voucher code, by its shape?
 *
 * A booth has printed two kinds, and both are claimed:
 *   - eleven characters whose check character is right (`verifyBoothCode`,
 *     ISO/IEC 7064 MOD 37-2) — every code a box mints today;
 *   - ten characters of the shape every booth printed before the check existed
 *     (`isLegacyBoothCode`) — still in families' hands, and looked up as they
 *     are.
 * An eleven-character code with a WRONG check is not claimed: no booth printed
 * it, so it is a misread, and it resolves `unknown` like any other string.
 *
 * Read the way the platform reads one (`normaliseBoothCode`): upper case, with
 * spaces and dashes dropped, so a code typed by hand into the Console's
 * simulator and the same code read off the slip's QR are one code.
 *
 * DIGITS ALONE ARE NOT A VOUCHER. A retail barcode is digits only, eight to
 * fourteen of them (`isProductBarcode`), and a ten- or eleven-digit string can
 * pass the booth shape as well — the booth alphabet keeps 2 to 9. Such a string
 * is left to the shop rather than sent to a till as a voucher, where a
 * bottle's barcode would be counted as a wrong code against the till's
 * guessing limit. A printed voucher is never digits alone in practice — the
 * park's booth prefixes carry a letter (`B1`) — and one that was would still
 * go in through the till's Redeem voucher entry.
 *
 * A shape test and nothing more: the box validates nothing (spec §8).
 */
export function isBoothVoucherCode(code: string): boolean {
  const normalised = normaliseBoothCode(code);
  if (/^[0-9]+$/.test(normalised)) return false;
  return verifyBoothCode(normalised).ok || isLegacyBoothCode(normalised);
}

/**
 * The handler: a voucher code read at the counter goes to the till as it is.
 *
 * THE BOX DECIDES NOTHING ABOUT IT. Whether the voucher exists, has been used,
 * has expired or is on another till's cart is answered by the platform alone,
 * at the till's request (`GET /vouchers/lookup`) — spec §8, "server validation
 * only", and the owner's rule that a printed slip is never trusted offline. So
 * the answer is always `handled`, never `refused`: this says what the string
 * IS, not whether it is any good.
 *
 * THE CODE TRAVELS, and has to: it is the one thing the till must ask the cloud
 * about. A voucher code is not a credential the way a band code is — a band
 * code opens a gate with no network, a voucher code opens nothing on its own:
 * it is redeemed by a signed-in till, online, once, under a guessing limit. It
 * rides the station channel to the staff screens (`StationScanMessage.detail`)
 * and never the tape, which keeps the fingerprint as it does for every scan.
 */
export function voucherCodeHandler(): ScanHandler {
  return {
    name: VOUCHER_CODE_HANDLER,
    kind: 'voucher',
    matches: isBoothVoucherCode,
    handle(ctx) {
      return { outcome: 'handled', detail: { code: normaliseBoothCode(ctx.code) } };
    },
  };
}

export class ScanRouter {
  private readonly options: ScanRouterOptions;
  private readonly handlers: ScanHandler[] = [];
  private readonly log: AgentLog;
  /**
   * S2-10b — the voucher code is claimed by the router itself, ahead of every
   * registered handler, in every router: the agent's on a box, and the one the
   * api builds for a station whose box runs elsewhere.
   *
   * Its shape is the platform's own — a box mints these codes (`booth.ts`) —
   * so no ticket registers a meaning for it and no broad matcher registered
   * later may take one. `registered()` lists it first, because that is where
   * it matches.
   */
  private readonly voucher = voucherCodeHandler();

  constructor(options: ScanRouterOptions) {
    this.options = options;
    this.log = options.log ?? silentLog;
  }

  /**
   * Later tickets add their handlers here rather than editing this file.
   * Registration order is match order: the first handler that claims a code
   * gets it, so a narrow matcher (a booking QR's header) must be registered
   * before a broad one (anything numeric is a product barcode).
   */
  register(handler: ScanHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const at = this.handlers.indexOf(handler);
      if (at >= 0) this.handlers.splice(at, 1);
    };
  }

  /**
   * The handlers a code can reach, by name, in match order — what the Box log
   * drawer and the `/scanning` answer list. The router's own voucher handler
   * (`voucher` above) is first: it is always on and claims its shape before
   * any registration, so a list without it would describe a router that does
   * not exist. The tickets' registrations follow in the order they were made.
   */
  registered(): string[] {
    return [this.voucher.name, ...this.handlers.map((h) => h.name)];
  }

  /**
   * What the box thinks a code is, before any handler runs.
   *
   * A kind is `unknown` until a ticket registers a matcher for it. Band codes
   * are minted by S2-11 and booking QRs redeemed by S2-12, and inventing a
   * shape for those here would be inventing a format the code that mints them
   * would then have to match. A retail barcode is the exception and is matched
   * (`isProductBarcode`), because its shape was decided by GS1 long before
   * this park existed — and so is a Lucky Wheel voucher code, whose shape the
   * platform decided and every booth mints (`isBoothVoucherCode`, S2-10b).
   */
  classify(code: string): { kind: ScanCodeKind; handler: ScanHandler | null } {
    // The router's own first: see `voucher`. A shape test on a string, total
    // and synchronous, so it needs none of the guarding a ticket's matcher gets.
    if (this.voucher.matches(code)) return { kind: this.voucher.kind, handler: this.voucher };
    for (const handler of this.handlers) {
      let claimed = false;
      try {
        claimed = handler.matches(code);
      } catch (err) {
        // One broken matcher must not stop the gate reading bands.
        this.log.warn(
          { err: String(err), handler: handler.name, module: 'scan' },
          'a scan matcher threw; treating the code as not its own',
        );
      }
      if (claimed) return { kind: handler.kind, handler };
    }
    return { kind: 'unknown', handler: null };
  }

  /**
   * Take one scan: classify it, give it to whoever claimed it, write the
   * redacted line, and tell the screens.
   *
   * It never throws for a bad code — a scanner pointed at a crisp packet is an
   * ordinary event at a counter — and it never lets a handler's failure become
   * the caller's exception: the outcome is `error` with a code, the tape says
   * so, and the till shows it.
   */
  async deliver(
    stationId: string,
    input: ScanInput,
    opts: { screen?: StationEventSource } = {},
  ): Promise<ScanResult> {
    const at = this.options.now ? this.options.now() : new Date();
    const started = Date.now();
    const actionId = input.actionId ?? null;
    // Trailing CR/LF is the scanner's suffix, not part of the code. A code with
    // spaces at either end is a person typing it in.
    const code = input.code.replace(/[\r\n]+$/, '').trim();
    const fingerprint = scanFingerprint(code);
    const prefix = scanPrefix(code);

    const refuse = async (errorCode: string): Promise<ScanResult> => {
      const result: ScanResult = {
        accepted: false,
        kind: 'unknown',
        outcome: 'refused',
        handler: null,
        errorCode,
        codeFingerprint: fingerprint,
        codeLength: code.length,
        codePrefix: prefix,
        durationMs: Date.now() - started,
        actionId,
      };
      await this.record(stationId, input, result, opts.screen, at);
      this.publish(stationId, input, result, at);
      return result;
    };

    if (code.length === 0) return refuse('SCAN_EMPTY');
    if (code.length > SCAN_MAX_LENGTH) return refuse('SCAN_TOO_LONG');

    const { kind, handler } = this.classify(code);
    let outcome: ScanOutcome = 'unhandled';
    let errorCode: string | null = null;
    let detail: Record<string, unknown> | undefined;

    if (handler) {
      try {
        const answer = await handler.handle({
          stationId,
          boxId: this.options.boxId,
          code,
          kind,
          source: input.source,
          actionId,
          accountId: input.accountId ?? null,
          at,
        });
        if (answer) {
          outcome = answer.outcome;
          errorCode = answer.errorCode ?? null;
          detail = answer.detail;
        } else {
          // A handler that claimed the code and returned nothing HANDLED it:
          // the alternative reading — "it silently declined" — would leave the
          // till saying "that code means nothing here" about a code that had
          // just been acted on.
          outcome = 'handled';
        }
      } catch (err) {
        outcome = 'error';
        errorCode = 'SCAN_HANDLER_FAILED';
        this.log.error(
          { err: String(err), handler: handler.name, module: 'scan', stationId },
          'a scan handler threw',
        );
      }
    }

    const result: ScanResult = {
      accepted: true,
      kind,
      outcome,
      handler: handler?.name ?? null,
      errorCode,
      codeFingerprint: fingerprint,
      codeLength: code.length,
      codePrefix: prefix,
      detail,
      durationMs: Date.now() - started,
      actionId,
    };
    await this.record(stationId, input, result, opts.screen, at);
    this.publish(stationId, input, result, at);
    return result;
  }

  private async record(
    stationId: string,
    input: ScanInput,
    result: ScanResult,
    screen: StationEventSource | undefined,
    at: Date,
  ): Promise<void> {
    try {
      await this.options.store.recordStationEvent(
        {
          stationId,
          boxId: this.options.boxId,
          kind: 'scan',
          source: stationSourceForScan(input.source, screen),
          outcome: result.outcome,
          errorCode: result.errorCode,
          actorAccountId: input.accountId ?? null,
          actionId: result.actionId,
          // The redacted payload, exactly as `ScanEventPayloadSchema` in
          // `@oto/shared` defines it. No `detail`: a handler's answer can name
          // a member, and this row is kept for thirty days behind a web page.
          payload: {
            source: input.source,
            codeKind: result.kind,
            codeFingerprint: result.codeFingerprint,
            codeLength: result.codeLength,
            ...(result.codePrefix ? { codePrefix: result.codePrefix } : {}),
            outcome: result.outcome,
            ...(result.handler ? { handler: result.handler } : {}),
            ...(result.errorCode ? { errorCode: result.errorCode } : {}),
            durationMs: result.durationMs,
          },
          occurredAt: (input.scannedAt ?? at.toISOString()) || at.toISOString(),
        },
        at.toISOString(),
      );
    } catch (err) {
      // The tape is telemetry. A scan that worked must not be reported as
      // failed because a log row could not be written.
      this.log.warn(
        { err: String(err), module: 'scan', stationId },
        'a scan happened but its station event could not be written',
      );
    }
  }

  private publish(
    stationId: string,
    input: ScanInput,
    result: ScanResult,
    at: Date,
  ): void {
    if (!this.options.publish) return;
    try {
      this.options.publish(stationId, {
        kind: 'scan',
        source: input.source,
        codeKind: result.kind,
        codeFingerprint: result.codeFingerprint,
        outcome: result.outcome,
        handler: result.handler,
        errorCode: result.errorCode,
        detail: result.detail ?? null,
        actionId: result.actionId,
        scannedAt: input.scannedAt ?? at.toISOString(),
      });
    } catch (err) {
      this.log.warn({ err: String(err), module: 'scan' }, 'a scan could not be published');
    }
  }
}
