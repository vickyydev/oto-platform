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
// printed on the product and is no secret. A Lucky Wheel voucher's code
// travels too (S2-10b): it is the one thing the till must ask the platform
// about, and it opens nothing on its own — see `readVoucherScan`.

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

/** The name the box's voucher handler goes by (`VOUCHER_CODE_HANDLER` in `@oto/box-agent`). */
export const VOUCHER_CODE_HANDLER = 'voucher';

/**
 * Read a scan as the tills read it (S2-10b, SCRUM-207): the code of a Lucky
 * Wheel voucher, or null when the scan is some other screen's.
 *
 * The box classes a code by its shape and validates nothing — whether the
 * voucher exists, is used or has expired is the platform's answer, asked by
 * the till (`lib/tillVoucher.ts`). So there is one outcome to read here:
 * `handled` by the voucher handler, with the code in `detail.code`.
 */
export function readVoucherScan(event: StationScanEvent): string | null {
  if (event.codeKind !== 'voucher') return null;
  if (event.outcome !== 'handled' || event.handler !== VOUCHER_CODE_HANDLER) return null;
  const code = event.detail?.code;
  return typeof code === 'string' && code.length > 0 ? code : null;
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
 * How long one poll may take before it is given up (SCRUM-424, audit L39). A
 * poll that hangs — under load, or while the api redeploys — used to hang the
 * screen's listening with it, since the next poll goes out only after an
 * answer. It is aborted instead, and the next poll goes out with the same
 * cursor, so whatever was scanned meanwhile rides that one.
 */
const POLL_TIMEOUT_MS = 10_000;

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
 * stream; a failure that passes, or a poll that runs past `POLL_TIMEOUT_MS`,
 * keeps the interval and the cursor.
 *
 * **A hidden screen does not act on scans (SCRUM-424).** Asleep, frozen in a
 * background tab or with another app in front — `document.visibilityState` is
 * `hidden` — the screen stops polling, and when it is shown again it takes the
 * tape's number afresh: it hears the scans from then on and none from before,
 * which is what the stream does for a screen that reconnects, and what an
 * iPad woken with a tag already in the guest's hand needs — last minute's
 * scan must not land on the cart beside the one it is about to hear. Whether
 * the screen was away is read from its visibility alone: a poll that failed
 * or timed out says nothing about it, and the scans of that gap are delivered
 * by the next poll that answers.
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
    /**
     * The `next` of the last answer; null until the first poll has taken it,
     * and set back to null when the screen is shown again after being hidden,
     * so the next answer takes the number afresh and delivers nothing.
     */
    let cursor: number | null = null;

    /** Asleep, a background tab, another app in front: nothing heard now is this screen's. */
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

    const schedule = () => {
      if (!stopped && !hidden()) pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
    };

    const pollOnce = async () => {
      pollTimer = null;
      if (stopped || hidden()) return; // resumed by `onVisibility`
      const query = cursor === null ? 'view=staff' : `view=staff&after=${cursor}`;
      const abort = new AbortController();
      inFlight = abort;
      // The one controller serves the timeout and the unmount alike.
      const deadline = setTimeout(() => abort.abort(), POLL_TIMEOUT_MS);
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
        // No answer in time, or not one that reads: the next poll goes out on
        // time, with the same cursor, and hears what this one would have.
        schedule();
        return;
      } finally {
        clearTimeout(deadline);
        if (inFlight === abort) inFlight = null;
      }
      if (stopped) return;
      if (typeof page.next === 'number') {
        // The first poll, and the first after the screen was hidden, only take
        // the tape's number: nothing from before the screen was listening lands.
        if (cursor !== null && Array.isArray(page.scans)) {
          for (const scan of page.scans as StationScanEvent[]) deliver(scan);
        }
        cursor = page.next;
      }
      schedule();
    };

    const onVisibility = () => {
      if (stopped || !polling) return;
      if (hidden()) {
        // Paused. A poll still in flight is left to answer — `schedule` sends
        // no next one while hidden — and one due is not sent.
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        return;
      }
      // Shown again: the number is taken afresh, so the scans of meanwhile are
      // not delivered — by the poll in flight, if there is one, else by a new one.
      cursor = null;
      if (!pollTimer && !inFlight) void pollOnce();
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
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      stopped = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      closeStream();
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      inFlight?.abort();
      inFlight = null;
    };
  }, [stationId]);
}
