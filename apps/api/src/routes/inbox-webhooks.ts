import { z } from 'zod';
import type { App } from '../app';
import { ipLimited } from '../plugins/rate-limit';
import { answerChallenge, ingestDelivery } from '../services/inbox/ingest';

/**
 * WHAT A MESSAGING PROVIDER POSTS TO US (S2-19 I2d, SCRUM-583; plan
 * `docs/progress/plans/inbox-build/PLAN.md` §3.3, §3.4).
 *
 *   GET  /webhooks/inbox/:channelAccountId   Meta's subscription challenge
 *   POST /webhooks/inbox/:channelAccountId   a delivery: messages, statuses
 *
 * THE SAME THREE RULES AS THE 2C2P WEBHOOK (`routes/webhooks.ts`):
 *  - the caller is a machine with no session, so the route is `public` and
 *    the provider's SIGNATURE is the authentication — verified on the raw
 *    bytes before a single field is read;
 *  - it ANSWERS 200, ALWAYS, refusals included: a non-200 makes Meta retry
 *    the same delivery for days. A refusal is a value, recorded as a
 *    `webhook_receipt` (`signature_ok=false`) and an `ops_run`;
 *  - the delivery is its own idempotency key (the receipt's unique
 *    `(channel_account_id, provider_event_id)`), so a retry changes nothing.
 *
 * THE RAW BODY. Meta signs the bytes it sent, and `JSON.stringify(JSON.parse
 * (body))` is not what it sent. This plugin is registered ENCAPSULATED (no
 * `fastify-plugin` wrapper), so the buffer-keeping JSON parser below applies
 * to these two routes and to nothing else on the api.
 *
 * THE URL NAMES THE CHANNEL ACCOUNT, and the account names the operator: no
 * other route reaches the ingest without one. An id that names nothing is
 * answered 200 like any other refusal — telling a scanner which ids exist is
 * telling it something.
 */
export function inboxWebhookRoutes(app: App): Promise<void> {
  const keepBytes = (_req: unknown, body: Buffer, done: (err: Error | null, body?: unknown) => void) => done(null, body);
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_048_576 }, keepBytes);
  // Anything else is still answered 200 (and refused by its signature),
  // never a 415 a provider would retry.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1_048_576 }, keepBytes);

  app.get(
    '/webhooks/inbox/:channelAccountId',
    {
      config: { public: true, ...ipLimited, rateLimit: { max: 120, timeWindow: 60_000 } },
      schema: {
        description:
          "Meta's webhook subscription challenge for one inbox channel account: echoes hub.challenge as plain text when hub.mode is subscribe and hub.verify_token is this deployment's; 403 otherwise. Public — the verify token is the check.",
        params: z.object({ channelAccountId: z.string() }),
        querystring: z.object({
          'hub.mode': z.string().optional(),
          'hub.verify_token': z.string().optional(),
          'hub.challenge': z.string().optional(),
        }),
      },
    },
    async (req, reply) => {
      const answer = await answerChallenge(app.db, app.inboxChannels, req.params.channelAccountId, req.query);
      reply.header('cache-control', 'no-store');
      if (answer === null) return reply.status(403).type('text/plain; charset=utf-8').send('refused');
      return reply.status(200).type('text/plain; charset=utf-8').send(answer);
    },
  );

  app.post(
    '/webhooks/inbox/:channelAccountId',
    {
      config: {
        public: true,
        /**
         * A generous per-address bucket, as the 2C2P webhook's: it bounds an
         * internet scanner and must not be the thing that drops a real
         * customer's message.
         */
        ...ipLimited,
        rateLimit: { max: 600, timeWindow: 60_000 },
      },
      schema: {
        description:
          "A messaging provider's delivery for one inbox channel account (WhatsApp Cloud API shape; the simulator signs the same). Verified on its raw bytes (X-Hub-Signature-256), recorded as a webhook receipt keyed on the delivery, its messages deduplicated on their provider ids, filed, routed and, out of hours, answered. It ALWAYS answers 200, refusals included — a non-200 makes the provider redeliver.",
        params: z.object({ channelAccountId: z.string() }),
        /** DELIBERATELY UNSHAPED, as the 2C2P webhook's: a 400 is the one answer this route must never give. */
        body: z.unknown(),
        response: {
          200: z.object({
            /** What was done with it. Meta reads only the status code. */
            outcome: z.string(),
          }),
        },
      },
    },
    async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body === undefined ? '' : JSON.stringify(req.body));
      const result = await ingestDelivery(
        app.db,
        { channels: app.inboxChannels, log: req.log, storage: app.fileStorage },
        {
          channelAccountId: req.params.channelAccountId,
          webhook: {
            method: 'POST',
            // A NAMED SUBSET, never the whole bag: the signature and the type.
            headers: {
              'x-hub-signature-256': req.headers['x-hub-signature-256'],
              'content-type': req.headers['content-type'],
            },
            query: {},
            rawBody: raw,
          },
          requestId: req.id,
          sourceIp: req.ip,
        },
      );
      return reply.status(200).send({ outcome: result.outcome });
    },
  );

  return Promise.resolve();
}
