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
// The stream is not the only way in. Where it cannot open — on staging the POS
// is a static site, and its `/api/*` rewrite on Render never passes a
// streaming answer through (SCRUM-392) — the same scans are read by polling
// `GET /stations/:id/scans`, which answers from the api's tape of each
// station's last hundred scans. `useStationScans` below decides which.
//
// What travels is the box's answer. A band code is a gate credential and never
// travels — the tape keeps a fingerprint of it. For a product the answer names
// the item and the size when the code was on one, and carries the catalogue
// SKU, which for a size's barcode is the code itself: a product barcode is
// printed on the product and is no secret.

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
 * How long the stream has to open before this screen stops waiting for it.
 *
 * On the api's own origin the channel answers in well under a second, so four
 * seconds is room for a slow counter network — and short enough that nobody
 * scans into silence for long while the screen makes up its mind.
 */
const STREAM_OPEN_TIMEOUT_MS = 4_000;

/** How long after one poll is answered the next one goes out. */
const POLL_INTERVAL_MS = 1_500;

/**
 * A screen whose last answered poll is older than this was away — asleep,
 * frozen in a background tab, or off the network — and it does not act on the
 * scans it missed meanwhile. That is what the stream does: a screen that
 * reconnects hears the scans from then on and none from before, and an iPad
 * woken with a tag already in the guest's hand must not put last minute's
 * scan on the cart next to the one it is about to hear.
 */
const AWAY_AFTER_MS = 10_000;

/**
 * The answers that end the polling rather than being tried again: the channel
 * route's own refusals — a malformed request (400), no session (401), a
 * session not allowed to watch this station (403), no such station (404), no
 * box behind it (409). A stream ends on each of them too. Anything else — a
 * locked session (423), a proxy's 502 while the api redeploys, a dropped
 * connection — passes, and the next poll goes out on time.
 */
const POLL_REFUSALS = new Set([400, 401, 403, 404, 409]);

/**
 * Hear every scan at one station while this screen is open.
 *
 * **The stream, first.** An `EventSource` on the channel, on the api's own
 * path: same-origin, so the session cookie goes with it and the service worker
 * leaves it alone (`/api/*` is never cached, pwa/service-worker.js). It
 * reconnects by itself after a dropped connection.
 *
 * **The poll, where the stream cannot open (SCRUM-392).** On staging the POS
 * is a static site whose `/api/*` rewrite on Render never passes a streaming
 * answer through: the channel there gets no status, no headers and no bytes
 * for minutes, and a screen waiting on it hears nothing. So a stream that has
 * not fired `open` within `STREAM_OPEN_TIMEOUT_MS` is closed, and the screen
 * polls `GET /stations/:id/scans` instead — first without `after`, which takes
 * the tape's current number and replays nothing (a scan from before the screen
 * was listening must not land on its cart), then with `after` set to the
 * `next` of the previous answer, `POLL_INTERVAL_MS` after each answer, so
 * polls never overlap and no scan falls between two of them. Each scan is
 * handed to `onScan` exactly as the stream would hand it. A stream the
 * browser has given up on — an answer that is not a stream, such as a proxy's
 * error page on a reconnect during a deploy, after which an `EventSource`
 * never tries again — is the same verdict, sooner.
 *
 * Once polling, the screen polls for as long as it is open. It is the simplest
 * rule there is, and the stream has just shown it cannot open from here; a
 * screen that went back to it would have to hand over between the two without
 * losing a scan or hearing one twice. A refusal ends the polling as it ends a
 * stream; a failure that passes keeps the interval.
 *
 * `onScan` is read through a ref, so a screen can hand in a fresh closure on
 * every render (its stage, its grid) without reopening anything.
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
    if (!stationId) return;
    const base = `/api/stations/${encodeURIComponent(stationId)}`;
    /** Set on unmount and on a change of station: nothing is delivered after it. */
    let stopped = false;

    const deliver = (message: StationScanEvent) => {
      if (!stopped && message.kind === 'scan') handler.current(message);
    };

    // --- The poll -------------------------------------------------------------
    let polling = false;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;
    /** The `next` of the last answer; null until the first poll has taken it. */
    let cursor: number | null = null;
    let answeredAt = 0;

    const schedule = () => {
      if (!stopped) pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
    };

    const pollOnce = async () => {
      pollTimer = null;
      const sentAt = Date.now();
      const query = cursor === null ? 'view=staff' : `view=staff&after=${cursor}`;
      const abort = new AbortController();
      inFlight = abort;
      let res: Response;
      let page: { next?: unknown; scans?: unknown };
      try {
        res = await fetch(`${base}/scans?${query}`, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: abort.signal,
        });
        if (stopped) return;
        if (POLL_REFUSALS.has(res.status)) return; // refused: polling ends here
        if (!res.ok) {
          schedule();
          return;
        }
        page = (await res.json()) as { next?: unknown; scans?: unknown };
      } catch {
        // No answer, or not one that reads: the next poll goes out on time.
        schedule();
        return;
      } finally {
        if (inFlight === abort) inFlight = null;
      }
      if (stopped) return;
      if (typeof page.next === 'number') {
        const away = cursor !== null && sentAt - answeredAt > AWAY_AFTER_MS;
        if (cursor !== null && !away && Array.isArray(page.scans)) {
          for (const scan of page.scans as StationScanEvent[]) deliver(scan);
        }
        cursor = page.next;
        answeredAt = Date.now();
      }
      schedule();
    };

    // --- The stream -----------------------------------------------------------
    let source: EventSource | null = null;
    let openTimer: ReturnType<typeof setTimeout> | null = null;

    const listener = (event: MessageEvent<string>) => {
      let message: StationScanEvent;
      try {
        message = JSON.parse(event.data) as StationScanEvent;
      } catch {
        return; // a message that is not JSON is not a scan
      }
      deliver(message);
    };
    const onOpen = () => {
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
    };
    const onError = () => {
      // CLOSED, not CONNECTING: the browser will not try this stream again.
      if (source?.readyState === EventSource.CLOSED) startPolling();
    };

    const closeStream = () => {
      if (openTimer) clearTimeout(openTimer);
      openTimer = null;
      if (!source) return;
      source.removeEventListener('scan', listener as EventListener);
      source.removeEventListener('open', onOpen);
      source.removeEventListener('error', onError);
      source.close();
      source = null;
    };

    const startPolling = () => {
      if (stopped || polling) return;
      polling = true;
      closeStream();
      void pollOnce();
    };

    if (typeof EventSource === 'undefined') {
      // No stream in this browser at all: the verdict is in before it is asked.
      startPolling();
    } else {
      source = new EventSource(`${base}/channel?view=staff`);
      source.addEventListener('scan', listener as EventListener);
      source.addEventListener('open', onOpen);
      source.addEventListener('error', onError);
      openTimer = setTimeout(startPolling, STREAM_OPEN_TIMEOUT_MS);
    }

    return () => {
      stopped = true;
      closeStream();
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      inFlight?.abort();
      inFlight = null;
    };
  }, [stationId]);
}
