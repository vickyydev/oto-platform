import { useEffect, useRef } from 'react';

// THE STATION CHANNEL, FOR SCANS (S2-09b).
//
// The api streams each station's session to every screen watching it:
// `GET /stations/:id/channel`, server-sent events (apps/api/src/routes/
// stations.ts). A scan rides the same stream as an `event: scan` message —
// whatever read the code: the scanner on the box, the Console's scanner
// simulator (which reaches the box as a command), or this screen's own
// `POST /stations/:id/scan`. The box decides what the code means and says so in
// the message; this file only listens and reads the answer.
//
// It is the first screen in the POS to open the channel. The till's own
// session document does not ride it yet, so nothing here holds a lease or sends
// an intent: a screen that only listens needs neither.
//
// What travels is the box's answer and never the code. A band code is a gate
// credential and the tape keeps a fingerprint of it; for a product the answer
// names the item, and the size when the code was on one.

/** One scan as the channel carries it — `StationScanMessage` in `@oto/box-agent`. */
export interface StationScanEvent {
  kind: 'scan';
  source: string;
  codeKind: string;
  codeFingerprint: string;
  outcome: string;
  handler: string | null;
  errorCode: string | null;
  detail: Record<string, unknown> | null;
  actionId: string | null;
  scannedAt: string;
}

/**
 * The line a product scan asks the shop to add — `detail.add` from the box's
 * product handler (`productBarcodeHandler` in packages/box-agent/src/scan.ts).
 * An INTENT, not a priced row: the cart owns quantity and merging, and the
 * platform prices the sale.
 */
export interface ProductScanLine {
  productId: string;
  /** The item's name. */
  name: string;
  /** What was scanned, in words — "Grip Socks M". */
  label: string;
  /** The size the code was on, or null for the item's own code. */
  variant: { id: string; label: string } | null;
  quantity: number;
}

/** What a scan means to the shop screen. Null = not a product scan, so not the shop's. */
export type ProductScan =
  | { kind: 'add'; line: ProductScanLine }
  | { kind: 'unknown'; message: string }
  | null;

/** The name the box's product handler goes by (`PRODUCT_BARCODE_HANDLER`). */
export const PRODUCT_BARCODE_HANDLER = 'product-barcode';
/** What the box answers for a barcode this park does not sell (`UNKNOWN_BARCODE`). */
export const UNKNOWN_BARCODE = 'UNKNOWN_BARCODE';

const isSize = (value: unknown): value is { id: string; label: string } =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as { id?: unknown }).id === 'string' &&
  typeof (value as { label?: unknown }).label === 'string';

/**
 * Read a scan as the shop reads it.
 *
 * Two outcomes matter here and both come from the box's product handler: a
 * line to add (`handled`, with `detail.add`), and "Unknown barcode" (`refused`,
 * `UNKNOWN_BARCODE`), which adds nothing. Anything else — a band, a booking, a
 * code no handler claimed — belongs to another screen and answers null.
 */
export function readProductScan(event: StationScanEvent): ProductScan {
  if (event.codeKind !== 'product') return null;
  if (event.outcome === 'refused' && event.errorCode === UNKNOWN_BARCODE) {
    const message = event.detail?.message;
    return { kind: 'unknown', message: typeof message === 'string' ? message : 'Unknown barcode' };
  }
  if (event.outcome !== 'handled' || event.handler !== PRODUCT_BARCODE_HANDLER) return null;
  const add = event.detail?.add as Record<string, unknown> | undefined;
  if (!add || add.kind !== 'product' || typeof add.productId !== 'string') return null;
  const name = typeof add.name === 'string' ? add.name : '';
  return {
    kind: 'add',
    line: {
      productId: add.productId,
      name,
      label: typeof add.label === 'string' ? add.label : name,
      variant: isSize(add.variant) ? { id: add.variant.id, label: add.variant.label } : null,
      quantity: typeof add.quantity === 'number' && add.quantity > 0 ? add.quantity : 1,
    },
  };
}

/**
 * Hear every scan at one station while this screen is open.
 *
 * An `EventSource` on the api's own path, same-origin, so the session cookie
 * goes with it and the service worker leaves it alone (`/api/*` is never
 * cached, pwa/service-worker.js). It reconnects by itself after a dropped
 * connection. A refusal — no box behind the station, or a session not standing
 * at it — is a closed stream and is not retried, which is the EventSource's own
 * rule for an answer that is not a stream.
 *
 * `onScan` is read through a ref, so a screen can hand in a fresh closure on
 * every render (its stage, its grid) without reopening the connection.
 */
export function useStationScans(
  stationId: string | null | undefined,
  onScan: (event: StationScanEvent) => void,
): void {
  const handler = useRef(onScan);
  useEffect(() => {
    handler.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!stationId || typeof EventSource === 'undefined') return;
    const source = new EventSource(
      `/api/stations/${encodeURIComponent(stationId)}/channel?view=staff`,
    );
    const listener = (event: MessageEvent<string>) => {
      let message: StationScanEvent;
      try {
        message = JSON.parse(event.data) as StationScanEvent;
      } catch {
        return; // a message that is not JSON is not a scan
      }
      if (message.kind === 'scan') handler.current(message);
    };
    source.addEventListener('scan', listener as EventListener);
    return () => {
      source.removeEventListener('scan', listener as EventListener);
      source.close();
    };
  }, [stationId]);
}
