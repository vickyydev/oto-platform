import { createHash } from 'node:crypto';

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
 * register their own; today nothing is registered and every scan resolves
 * `unhandled`, which is a real outcome and is shown as one.
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

export class ScanRouter {
  private readonly options: ScanRouterOptions;
  private readonly handlers: ScanHandler[] = [];
  private readonly log: AgentLog;

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

  /** Registered handler names, in match order. What the Box log drawer lists. */
  registered(): string[] {
    return this.handlers.map((h) => h.name);
  }

  /**
   * What the box thinks a code is, before any handler runs.
   *
   * Everything is `unknown` until a ticket registers a matcher for its own
   * kind. That is the honest state today: band codes are minted by S2-11,
   * booking QRs redeemed by S2-12, and inventing a shape for them here would
   * be inventing a format the code that mints them would then have to match.
   */
  classify(code: string): { kind: ScanCodeKind; handler: ScanHandler | null } {
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
