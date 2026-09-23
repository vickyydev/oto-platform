import type { App } from '../app';

/**
 * WHAT THE PAYMENT GATEWAY POSTS TO US (S2-10a, SCRUM-206) — registered, and
 * deliberately empty until Slice D fills it.
 *
 *   POST /webhooks/2c2p/payment   a payment notification, signed HS256
 *
 * THREE THINGS ABOUT THIS SURFACE that decide its shape before a line of it
 * exists, all from `docs/architecture/PAYMENT_GATEWAY.md:641-670`:
 *
 *  - **The caller is a machine with no session**, so it belongs beside
 *    `routes/public.ts` rather than behind the session plugin, and its own
 *    signature check is the authentication. `PGW_WEBHOOK_SECRET` in the path
 *    is a cheap filter and is NOT authentication.
 *  - **It answers 200 within a second, always — even when it refuses.** A 4xx
 *    here is a bug, not a defence: 2C2P retries on anything else, and a park
 *    whose webhook answers 400 to a notification it could not match gets the
 *    same notification again all evening.
 *  - **The notification is a trigger, not the truth.** A Payment Inquiry on
 *    the same `invoiceNo` has to agree before anything is released.
 *
 * The shell exists now so that `app.ts` — which this slice owns and the later
 * ones do not — is not touched again when that route lands. It registers no
 * route, which is why no list in `route-write-conformance.test.ts` changes.
 */
export function webhookRoutes(_app: App): Promise<void> {
  // Slice D.
  return Promise.resolve();
}
