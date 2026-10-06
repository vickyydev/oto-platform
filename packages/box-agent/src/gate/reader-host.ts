/**
 * THE READER'S HTTP CONTRACT, hosted on the gate box (Gate Interface Spec
 * §1-2; DEVICE_INVENTORY §6.1).
 *
 * The reader pushes to US: it POSTs every scan to `/interaction/Api/checkCard`
 * and a heartbeat to `/interaction/Api/heartbeat` on its own fixed interval.
 * Every value is a string. The scan carries `card` (base64 of the raw card id
 * or QR text), `type` ("0" card, "1" QR), `serial` (the gate's serial) and
 * `reader` ("0" entry, "1" exit). Our `code` decides: "1" opens, "0" does not,
 * and `message` is shown on the reader — the ONLY thing a guest sees.
 *
 * Tolerant of what a real reader might do differently from its document:
 * numbers where strings were promised, a form body instead of JSON, a card
 * field sent raw instead of base64. Strict about the one thing that matters —
 * nothing that is not a decision ever answers "1".
 *
 * Missed heartbeats make the reader OFFLINE, which the host reports through
 * the box's existing device reports (reachability `unreachable` → Health's
 * `device.unreachable` alert).
 */

import http from 'node:http';

import type { GateDirection } from './config';

export const READER_CHECK_CARD_PATH = '/interaction/Api/checkCard';
export const READER_HEARTBEAT_PATH = '/interaction/Api/heartbeat';

/** What the reader is answered with. Strings, as the spec requires. */
export interface ReaderAnswer {
  code: '0' | '1';
  message: string;
}

export interface ReaderScan {
  serial: string;
  direction: GateDirection;
  /** "0" card, "1" QR. */
  cardType: 'card' | 'qr';
  /** The decoded card id / QR text. A credential: never logged. */
  code: string;
}

export interface ReaderRequest {
  method: string;
  path: string;
  /** Parsed JSON or form body; anything else as a string. */
  body: unknown;
}

export interface ReaderResponse {
  status: number;
  body: ReaderAnswer;
}

export interface ReaderState {
  serial: string;
  direction: GateDirection;
  lastSeenAt: number | null;
  online: boolean;
}

export interface ReaderHostOptions {
  /** Decide a scan. Must answer; a throw is answered "do not open". */
  onScan: (scan: ReaderScan) => Promise<ReaderAnswer>;
  now?: () => number;
  /**
   * A reader not heard from for this long is offline. The heartbeat interval
   * is fixed by the reader and not yet known (DEVICE_INVENTORY §6.5), so the
   * default is generous; the station's config can tighten it.
   */
  offlineAfterMs?: number;
  /** The fallback answer's message when a scan cannot be decided. */
  failMessage?: string;
}

export const READER_OFFLINE_AFTER_MS = 90_000;
export const READER_OK_MESSAGE = 'Operation successful';

/** A spec value: a string, or a number a reader sent anyway. */
function str(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function directionOf(reader: string | null): GateDirection | null {
  if (reader === '0') return 'entry';
  if (reader === '1') return 'exit';
  return null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The card field, decoded. The spec says base64; a reader that sends the text
 * raw is read raw — decided by whether the base64 reading is printable text,
 * because a band code (it contains a `.`) is never valid base64 itself.
 */
export function decodeCardField(card: string): string | null {
  const trimmed = card.trim();
  if (!trimmed) return null;
  if (BASE64.test(trimmed) && trimmed.length % 4 === 0) {
    const text = Buffer.from(trimmed, 'base64').toString('utf8');
    if (text && /^[\x20-\x7e]+$/.test(text)) return text.trim();
  }
  return /^[\x20-\x7e]+$/.test(trimmed) ? trimmed : null;
}

export interface ReaderHost {
  handle(request: ReaderRequest): Promise<ReaderResponse>;
  /** Every reader heard from, and every one expected (`expect`). */
  states(at?: number): ReaderState[];
  /** Declare a reader that should be heard from, so silence from the start counts. */
  expect(serial: string, direction: GateDirection): void;
  forget(): void;
}

export function createReaderHost(options: ReaderHostOptions): ReaderHost {
  const now = options.now ?? Date.now;
  const offlineAfter = options.offlineAfterMs ?? READER_OFFLINE_AFTER_MS;
  const startedAt = now();
  const seen = new Map<
    string,
    { serial: string; direction: GateDirection; lastSeenAt: number | null }
  >();
  const keyOf = (serial: string, direction: GateDirection): string => `${serial}|${direction}`;

  function mark(serial: string, direction: GateDirection): void {
    seen.set(keyOf(serial, direction), { serial, direction, lastSeenAt: now() });
  }

  const refuse = (message: string): ReaderResponse => ({
    status: 200,
    body: { code: '0', message },
  });
  const failMessage = options.failMessage ?? 'Please see reception';

  return {
    async handle(request) {
      const path = request.path.split('?')[0]!.replace(/\/+$/, '').toLowerCase();
      if (request.method.toUpperCase() !== 'POST') {
        return { status: 405, body: { code: '0', message: 'POST only' } };
      }
      const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<
        string,
        unknown
      >;
      const serial = str(body.serial);
      const direction = directionOf(str(body.reader));

      if (path === READER_HEARTBEAT_PATH.toLowerCase()) {
        if (!serial || !direction) return refuse('serial and reader are required');
        mark(serial, direction);
        return { status: 200, body: { code: '1', message: READER_OK_MESSAGE } };
      }
      if (path !== READER_CHECK_CARD_PATH.toLowerCase()) {
        return { status: 404, body: { code: '0', message: 'not found' } };
      }
      if (!serial || !direction) return refuse(failMessage);
      // A scan is a sign of life as good as a heartbeat.
      mark(serial, direction);
      const card = str(body.card);
      const code = card ? decodeCardField(card) : null;
      if (!code) return refuse(failMessage);
      const cardType = str(body.type) === '0' ? 'card' : 'qr';
      try {
        const answer = await options.onScan({ serial, direction, cardType, code });
        return {
          status: 200,
          body: { code: answer.code === '1' ? '1' : '0', message: answer.message },
        };
      } catch {
        return refuse(failMessage);
      }
    },

    expect(serial, direction) {
      const key = keyOf(serial, direction);
      if (!seen.has(key)) seen.set(key, { serial, direction, lastSeenAt: null });
    },

    forget() {
      seen.clear();
    },

    states(at = now()) {
      return [...seen.values()].map((r) => ({
        serial: r.serial,
        direction: r.direction,
        lastSeenAt: r.lastSeenAt,
        online: at - (r.lastSeenAt ?? startedAt) <= offlineAfter,
      }));
    },
  };
}

// --- The listener -----------------------------------------------------------------

export interface ReaderServer {
  readonly port: number;
  close(): Promise<void>;
}

const MAX_BODY = 8 * 1024;

function parseBody(raw: string, contentType: string | undefined): unknown {
  if (!raw) return {};
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Some readers send a form body with a JSON content type, or none.
    return raw.includes('=') ? Object.fromEntries(new URLSearchParams(raw)) : {};
  }
}

/**
 * Serve the reader's two calls on the LAN. Both endpoints and nothing else:
 * this listener is reachable from the gate's network, so it answers nothing
 * a reader does not ask.
 */
export function startReaderServer(
  host: ReaderHost,
  listen: { port: number; host?: string },
): Promise<ReaderServer> {
  const server = http.createServer((req, res) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const reply = (status: number, body: ReaderAnswer): void => {
        const text = JSON.stringify(body);
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
        });
        res.end(text);
      };
      if (tooBig) return reply(413, { code: '0', message: 'too large' });
      const body = parseBody(Buffer.concat(chunks).toString('utf8'), req.headers['content-type']);
      host
        .handle({ method: req.method ?? 'GET', path: req.url ?? '/', body })
        .then((r) => reply(r.status, r.body))
        .catch(() => reply(200, { code: '0', message: 'Please see reception' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host ?? '0.0.0.0', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : listen.port;
      resolve({
        port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
