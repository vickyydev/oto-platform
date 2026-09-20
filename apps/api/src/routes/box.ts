import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  BoxCommandPollRequestSchema,
  BoxCommandResultRequestSchema,
  BoxHeartbeatRequestSchema,
  BoxRegisterRequestSchema,
} from '@oto/box-agent';
import type { App } from '../app';
import { boxAuthOf } from '../plugins/credential';
import {
  boxSettings,
  completeCommand,
  configBundle,
  pollCommands,
  recordHeartbeat,
  registerBox,
  type BoxAuth,
} from '../services/box';
import type { OpContext } from '../services/tx';

/**
 * What a box may say to the cloud (S2-04).
 *
 * **These routes are not session-authenticated, and that is the whole point.**
 * A box is a machine in a shopping mall with no person at it — there is no
 * cookie, no account and no permission to resolve. It carries a credential
 * instead, and `services/box.ts` checks it on every call and derives the box
 * id from it, so no body below can name a box other than the one calling.
 *
 * Because that is a third kind of guard, the routes declare it —
 * `config: { credential: 'box' }` — rather than borrowing `public: true`.
 * `routes-guarded.test.ts` enumerates the registry and would fail a route with
 * no declared guard; calling these public would have passed that test while
 * putting them in the pinned list of genuinely open endpoints, which is
 * exactly the kind of quiet reclassification that list exists to prevent.
 *
 * That declaration is now what DOES the authenticating: `plugins/credential.ts`
 * reads it and refuses the caller before the handler runs. It used to be a
 * label, and the surface was safe only because every handler below remembered
 * to check for itself — which a sixth route would not have had to.
 *
 * Two rate-limit buckets sit under them, for two different attackers: a
 * per-IP bucket on each route (generous, because the whole park shares one
 * public address) and a per-box bucket inside `authenticateBox` (a ceiling on
 * one box in a retry loop). Registration adds a third, keyed on the claim code
 * being guessed rather than on where the guess came from.
 */
export async function boxRoutes(app: App): Promise<void> {
  const settings = boxSettings();
  /**
   * One bucket per route per address. The park's boxes, the office and a mall
   * full of visitors leave through very few public addresses, so this is a
   * ceiling on absurdity rather than a tuned limit — the per-box bucket is
   * what actually bounds a box.
   */
  const limited = { rateLimit: { max: settings.ipRateMax, timeWindow: 60_000 } };

  /** Already authenticated by the credential guard; this only reads the result. */
  const boxAuth = (req: FastifyRequest): BoxAuth => boxAuthOf(req);

  /**
   * The operation context for a box's own writes. `actorAccountId` is null and
   * stays null: a box is not a person, and attributing its heartbeat to
   * whoever last touched it would put a name on the audit trail that did not
   * do the thing.
   */
  const boxCtx = (req: FastifyRequest, auth: BoxAuth): OpContext => ({
    requestId: req.id,
    actorAccountId: null,
    operatorId: auth.operatorId,
    branchId: auth.branchId,
    log: req.log,
  });

  app.post(
    '/register',
    {
      /**
       * `secretResponse`: the answer is the box's live 256-bit secret, and
       * the idempotency store keeps a response body for a day. Declared even
       * though `credential` already fences this surface off, because what
       * makes THIS route unstorable is what it returns, not who calls it.
       */
      config: { credential: 'box-claim', secretResponse: true, ...limited },
      schema: {
        description:
          'Redeem a single-use claim code for this box’s own secret. The secret is returned once and never again.',
        body: BoxRegisterRequestSchema,
      },
    },
    async (req) =>
      registerBox(app.db, req.body, {
        ip: req.ip,
        requestId: req.id,
        actorAccountId: null,
        log: req.log,
      }),
  );

  app.post(
    '/heartbeat',
    {
      config: { credential: 'box', ...limited },
      schema: {
        description:
          'Say this box is alive: clock, uptime, temperature, outbox depth, device reachability and paper',
        body: BoxHeartbeatRequestSchema,
      },
    },
    async (req) => {
      const auth = boxAuth(req);
      return recordHeartbeat(app.db, auth, req.body, boxCtx(req, auth));
    },
  );

  app.get(
    '/config',
    {
      config: { credential: 'box', ...limited },
      schema: {
        description:
          'Everything this box needs to run its counter, as one versioned document. Honours If-None-Match.',
      },
    },
    async (req, reply) => {
      const auth = boxAuth(req);
      const bundle = await configBundle(app.db, auth);
      const etag = `"${bundle.configVersion}"`;
      reply.header('etag', etag);
      /**
       * A box polls this on a timer and the answer rarely changes, so the
       * ordinary case is a 304 with no body. `if-none-match` can carry a list;
       * matching on inclusion keeps a proxy that rewrote it from turning every
       * poll back into a full bundle.
       */
      const inm = req.headers['if-none-match'];
      if (typeof inm === 'string' && inm.split(',').some((v) => v.trim() === etag)) {
        return reply.code(304).send();
      }
      return bundle;
    },
  );

  app.post(
    '/commands/poll',
    {
      config: { credential: 'box', ...limited },
      schema: {
        description: 'Take the oldest queued commands for this box and mark them running',
        body: BoxCommandPollRequestSchema,
      },
    },
    async (req) => {
      const auth = boxAuth(req);
      const commands = await pollCommands(app.db, auth, req.body.max);
      return { commands, serverTime: new Date().toISOString() };
    },
  );

  app.post(
    '/commands/:commandId/result',
    {
      config: { credential: 'box', ...limited },
      schema: {
        description:
          'Report what the box made of a command. Safe to retry: a second result is answered as a replay.',
        params: z.object({ commandId: z.string().uuid() }),
        body: BoxCommandResultRequestSchema,
      },
    },
    async (req) => {
      const auth = boxAuth(req);
      return completeCommand(app.db, auth, req.params.commandId, req.body, boxCtx(req, auth));
    },
  );
}
