import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signMetaPayload } from '../src/webhook';
import type { RawWebhook } from '../src/contract';
import type { FetchLike } from '../src/whatsapp-cloud';

/**
 * FIXTURE PROVENANCE. Every file under `fixtures/whatsapp/` was written by
 * hand for SCRUM-580 from the payload shapes Meta documents for the WhatsApp
 * Cloud API — the "Webhooks" reference (`object`, `entry[].changes[]` with
 * `field: "messages"`, `value.metadata`, `contacts[]`, `messages[]`,
 * `statuses[]`, the per-type objects `text`, `image`, `audio`, `document`,
 * `interactive`, `context`, `errors[]`), the "Messages" send reference (the
 * `messages[].id` answer), the media reference (`url`, `mime_type`, `sha256`,
 * `file_size`, `id`) and the Graph error envelope (`error.code`,
 * `error_data.details`, `fbtrace_id`). Error codes and titles are the ones
 * Meta's error-code table lists (131047, 131051, 130429, 190).
 *
 * None of it was captured from a live account — none exists (owner Q22). Every
 * id, phone number and name is fictional: business ids are runs of zeros,
 * customer WhatsApp ids are `668000000NN` / `790000000NN`, names read
 * "Fictional …", and the digests are base64 of the word "fixture". When a
 * Meta account exists, the first real deliveries replace these, and any shape
 * that differs is a parser change with its own check.
 *
 * The files are read as BYTES, pretty-printed as they are, so a signature is
 * computed over exactly what a provider would have sent — re-serialising a
 * fixture before signing would hide the raw-body requirement.
 */

const here = dirname(fileURLToPath(import.meta.url));

export function fixtureBytes(name: string): Buffer {
  return readFileSync(join(here, 'fixtures', 'whatsapp', `${name}.json`));
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureBytes(name).toString('utf8'));
}

export const APP_SECRET = 'test-app-secret-not-a-real-one';
export const VERIFY_TOKEN = 'test-verify-token';
export const PHONE_NUMBER_ID = '100000000000001';

/** A POST delivery of a fixture, signed over its raw bytes with `secret`. */
export function signedDelivery(name: string, secret = APP_SECRET): RawWebhook {
  const rawBody = fixtureBytes(name);
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': signMetaPayload(rawBody, secret),
    },
    query: {},
    rawBody,
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A `fetch` that answers from a queue of canned responses and records every
 * call. It never opens a socket: a test that runs out of answers fails loudly
 * rather than reaching the network.
 */
export function fakeFetch(
  answers: Array<{ status: number; json?: unknown; bytes?: Uint8Array } | 'network-error'>,
): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...answers];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const next = queue.shift();
    if (next === undefined)
      return Promise.reject(new Error(`fakeFetch: no answer queued for ${url}`));
    if (next === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: () =>
        next.json === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(next.json),
      arrayBuffer: () => {
        const b = next.bytes ?? new Uint8Array();
        return Promise.resolve(
          b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
        );
      },
    });
  };
  return { fetch, calls };
}
