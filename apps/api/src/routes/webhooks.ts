import { z } from 'zod';
import { GATEWAY_EVENTS } from '@oto/shared';
import type { App } from '../app';
import { ipLimited } from '../plugins/rate-limit';
import {
  gatewayStatus,
  handleNotification,
  simulateGatewayEvent,
} from '../services/payments/gateway';

/**
 * WHAT THE PAYMENT GATEWAY POSTS TO US, and the panel that pretends to be it
 * (S2-10a, SCRUM-206, Slice D).
 *
 *   POST /webhooks/2c2p/payment     a payment notification, signed HS256
 *   GET  /webhooks/2c2p/simulator   what this deployment's gateway is, and the
 *                                   QRs still waiting to be paid
 *   POST /webhooks/2c2p/simulator   one press of a simulator button
 *
 * THREE THINGS ABOUT THE FIRST ONE decide its shape, all from
 * `docs/architecture/PAYMENT_GATEWAY.md:641-670`:
 *
 *  - **The caller is a machine with no session**, so it declares `public` and
 *    sits beside `routes/public.ts` rather than behind the session plugin. Its
 *    own JWT signature is the authentication. `PGW_WEBHOOK_SECRET` on the URL
 *    is a cheap filter for internet noise and is NOT authentication — said
 *    twice in the document, and it is worth saying a third time here because
 *    the word "secret" in the variable name invites the opposite reading.
 *  - **It answers 200 within a second, always — even when it refuses.** A 4xx
 *    here is a bug, not a defence: 2C2P retries on anything else, and a park
 *    whose webhook answers 400 to a notification it could not match gets the
 *    same notification again all evening. The handler never throws; every
 *    refusal is a value in its answer, recorded as an `ops_run`.
 *  - **The notification is a trigger, not the truth.** A Payment Inquiry on
 *    the same `invoiceNo` has to agree before anything is released.
 *
 * WHY THE SIMULATOR'S TWO ROUTES ARE HERE, beside a webhook rather than with
 * the other simulators on `/boxes/:id/simulate`. Every other simulator in this
 * platform pretends to be a DEVICE, and a device belongs to a box: the command
 * rides the box queue and the panel on the Devices page sends it. A gateway is
 * not on a box and has no device row at all — a 2C2P QR is minted by this api
 * and paid in somebody's banking app, with no Raspberry Pi anywhere in the
 * path. What it is the twin of is the notification route directly above it:
 * these two exist only to make that one fire, with a real signature, through
 * the real handler. So they live beside it.
 *
 * THE SECRET NEVER REACHES THE BROWSER, which is the other reason the press is
 * a route and not something the Console does for itself. The panel names an
 * attempt and an event; this process signs the synthetic notification with the
 * configured key and posts it to its own handler.
 */
export function webhookRoutes(app: App): Promise<void> {
  /**
   * The path filter, which is NOT authentication.
   *
   * It travels as a query parameter rather than as a path segment, and that is
   * a deliberate deviation from the document's "may carry `PGW_WEBHOOK_SECRET`
   * as a segment": a segment means a route parameter, and a route parameter on
   * an open route is a thing `route-scope-target.test.ts` and every reader has
   * to reason about. The URL is ours — it is whatever `PGW_BACKEND_RETURN_URL`
   * says — so the token goes in the query string of that URL and is compared
   * here. The document's purpose ("cheap filtering of internet noise") is met
   * either way.
   *
   * A wrong or missing token is still answered 200 and still recorded. Telling
   * a scanner it found the right path and the wrong token is telling it there
   * is a right token.
   */
  const pathTokenOk = (supplied: string | undefined): boolean => {
    const configured = app.env.PGW_WEBHOOK_SECRET.trim();
    return configured.length === 0 || supplied === configured;
  };

  app.post(
    '/2c2p/payment',
    {
      config: {
        public: true,
        /**
         * A generous per-address bucket. This endpoint is the gateway's and it
         * must not be the thing that drops a real payment notification, so the
         * limit is here to bound an internet scanner rather than to police a
         * caller we want to hear from — and the poller settles anything a
         * dropped delivery would have.
         */
        ...ipLimited,
        rateLimit: { max: 600, timeWindow: 60_000 },
      },
      schema: {
        description:
          'The payment gateway reporting a payment. Signed HS256 under the merchant secret; unauthenticated by session, because the signature is the authentication. It ALWAYS answers 200, including when it refuses the delivery — a non-200 makes 2C2P redeliver, and a refusal is not a delivery failure.',
        querystring: z.object({
          /**
           * `PGW_WEBHOOK_SECRET`, when one is configured. A filter, not a
           * credential check — and DELIBERATELY UNBOUNDED, for the same reason
           * the body below is unshaped. A `.max()` here would answer **400** to
           * an over-long token before the handler ever ran, and a 400 is the
           * one thing this endpoint must never say. A token of any length that
           * is not the configured one is compared, refused, recorded as an
           * `ops_run` and answered 200 like every other refusal.
           */
          t: z.string().optional(),
        }),
        /**
         * DELIBERATELY UNSHAPED. A zod schema here would answer 400 to
         * anything that is not `{payload: string}` — and a 400 is the one
         * thing this endpoint must never say, because it is what makes 2C2P
         * redeliver. The shape is checked inside the handler, where "this is
         * not a notification" is an outcome recorded and answered 200 like
         * every other refusal. What arrives is `{"payload": "<jwt>"}` and
         * nothing else ever should; this is about what happens when it is not.
         */
        body: z.unknown(),
        response: {
          200: z.object({
            /** What was done with it. 2C2P documents no required body (UNCERTAIN, U5). */
            outcome: z.string(),
          }),
        },
      },
    },
    async (req, reply) => {
      const { outcome } = await handleNotification(app.db, app.env, req.log, {
        body: req.body,
        sourceIp: req.ip,
        /**
         * A NAMED SUBSET, never the whole bag. `req.headers` carries cookies
         * and authorization on some callers, and this record is read on a
         * Failures page in a back office.
         */
        headers: {
          'user-agent': headerOf(req.headers['user-agent']),
          'content-type': headerOf(req.headers['content-type']),
          'x-forwarded-for': headerOf(req.headers['x-forwarded-for']),
        },
        requestId: req.id,
        pathTokenOk: pathTokenOk(req.query.t),
      });
      // Explicit, so that nothing in a later refactor can make this a 4xx by
      // throwing somewhere it used to return.
      return reply.status(200).send({ outcome });
    },
  );

  // --- The gateway simulator -----------------------------------------------

  app.get(
    '/2c2p/simulator',
    {
      config: { permission: 'admin:health:read' },
      schema: {
        description:
          "Which QR gateway this deployment runs, whether it fell back to the simulator and why, and the QRs still waiting to be paid. Names and states only — no value of any PGW_* variable appears in the answer.",
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return gatewayStatus(app.db, app.env, auth.operatorId);
    },
  );

  app.post(
    '/2c2p/simulator',
    {
      config: { permission: 'admin:ops:manage' },
      schema: {
        description:
          'Make the simulated gateway do something: customer paid, decline, expire, late payment, or suppress the webhook. Each of the first four SIGNS a synthetic notification with the configured secret and sends it through the real webhook handler, so the production path is what is exercised. Refused on a deployment configured for the real gateway.',
        body: z.object({
          attemptId: z.string().uuid(),
          event: z.enum(GATEWAY_EVENTS),
          /**
           * Pay a figure that is not the one asked for. It is how the amount
           * mismatch — the case that must never close a sale — is demonstrated
           * rather than asserted.
           */
          amountSatang: z.number().int().min(0).optional(),
        }),
        response: {
          200: z.object({
            event: z.string(),
            attemptId: z.string(),
            invoiceNo: z.string(),
            webhookOutcome: z.string().nullable(),
            gatewayState: z.string(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      /**
       * At the BRANCH of the attempt, not at the session's. The attempt is
       * found inside the service, which scopes it to the operator; the branch
       * check cannot be made from the request because the request names an
       * attempt id and nothing else. Scoping to the operator is what stops a
       * press reaching another park's tender.
       */
      await req.requirePermission('admin:ops:manage');
      return simulateGatewayEvent(app.db, app.env, req.log, {
        attemptId: req.body.attemptId,
        event: req.body.event,
        amountSatang: req.body.amountSatang,
        operatorId: auth.operatorId,
        requestId: req.id,
        sourceIp: req.ip,
      });
    },
  );

  return Promise.resolve();
}

function headerOf(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
