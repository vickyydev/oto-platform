import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  BoxCommandPollRequestSchema,
  BoxCommandResultRequestSchema,
  BoxHeartbeatRequestSchema,
  BoxRegisterRequestSchema,
} from '@oto/box-agent';
import {
  SYNC_CHANGE_SCOPES,
  SYNC_PUSH_MAX_BYTES,
  SyncPushRequestSchema,
} from '@oto/shared';
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
import {
  CACHE_SCOPES,
  SYNC_EVENT_TYPES,
  SyncKeyRegisterSchema,
  assertBundleReadable,
  bundleVersionCovers,
  cacheBundle,
  pullChanges,
  pushEvents,
  registerSyncKey,
} from '../services/sync';
import { recordPrintJobResult } from '../services/print';
import type { OpContext } from '../services/tx';

/**
 * What a box says about a print job (S2-06).
 *
 * Declared here rather than in `@oto/shared` because it is a box-to-cloud
 * message like every other schema in this file, and the box builds it from
 * `PrintJobOutcome` in `@oto/box-agent`. Nothing personal crosses it: a device
 * id, a role, an attempt count and a short error code — never a printed line.
 */
const PrintJobResultSchema = z.object({
  status: z.enum(['queued', 'printed', 'failed', 'skipped']),
  attempts: z.number().int().min(0).max(1000),
  deviceId: z.string().uuid().nullish(),
  role: z.string().max(32).nullish(),
  stationId: z.string().uuid().nullish(),
  errorCode: z.string().max(64).nullish(),
  errorMessage: z.string().max(500).nullish(),
  /** Layout complaints from the renderer: "the name was cut to fit". */
  overflow: z.array(z.string().max(200)).max(20).optional(),
  elapsedMs: z.number().int().min(0).nullish(),
});

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
          'Say this box is alive: clock, uptime, temperature, outbox depth and age, device reachability, paper, lease holders and error fingerprints. A box that registered before the sync core hands over its signing key here. The box declares its own measurement of its clock in `clock`; a heartbeat whose `reportedAt` is further out than BOX_MAX_CLOCK_SKEW_S is refused as BOX_CLOCK_SKEW with the server’s time in `error.details.serverTime`, so the box can measure itself against it and report again. One at or before the last `reportedAt` accepted is refused as BOX_HEARTBEAT_STALE, with the server’s time and that last one in `error.details` (`serverTime`, `lastAcceptedReportedAt`), so a box that restarted behind it measures itself and reports after it.',
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
        description:
          'Take the oldest queued commands for this box and mark them running. `kinds` narrows what may be claimed — an offline box asks for `go_online` alone, and everything else stays queued until it is back.',
        body: BoxCommandPollRequestSchema,
      },
    },
    async (req) => {
      const auth = boxAuth(req);
      const commands = await pollCommands(app.db, auth, req.body.max, req.body.kinds);
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

  // --- Printing (S2-06) -----------------------------------------------------

  app.post(
    '/print-jobs/:id/result',
    {
      config: { credential: 'box', ...limited },
      schema: {
        description:
          'What happened to a print job. Its own endpoint rather than a command result: a job that waited half an hour on an empty roll reports long after the command that queued it was acknowledged. Safe to retry — a terminal job is answered as a replay.',
        params: z.object({ id: z.string().uuid() }),
        body: PrintJobResultSchema,
      },
    },
    async (req) => {
      const auth = boxAuth(req);
      return recordPrintJobResult(app.db, boxCtx(req, auth), auth, req.params.id, req.body);
    },
  );

  // --- The sync core (S2-05) ------------------------------------------------

  app.post(
    '/sync/key',
    {
      config: { credential: 'box', ...limited },
      schema: {
        description:
          'Register the public half of the keypair this box signs its events with. Rotating it invalidates events already queued under the old key.',
        body: SyncKeyRegisterSchema,
      },
    },
    async (req) => {
      const auth = boxAuth(req);
      return registerSyncKey(app.db, auth, req.body, boxCtx(req, auth));
    },
  );

  app.post(
    '/sync/push',
    {
      config: { credential: 'box', ...limited },
      /**
       * The byte cap from `@oto/shared`, applied by Fastify before the body is
       * parsed rather than counted afterwards: a box that has been offline for
       * a week and tries to send its whole journal at once is refused at the
       * socket, not after a megabyte has been through zod. The event cap is on
       * the schema, which is where a reader looks for it.
       */
      bodyLimit: SYNC_PUSH_MAX_BYTES,
      schema: {
        description:
          `Hand over a batch of facts. Each event is validated and applied on its own, under its own SAVEPOINT: a duplicate is dropped, and a conflict, a malformed envelope or a poison payload is quarantined without costing the rest of the batch. An old journal epoch is refused. Types this api applies: ${SYNC_EVENT_TYPES.join(', ')}.`,
        body: SyncPushRequestSchema,
      },
    },
    async (req) => {
      const auth = boxAuth(req);
      return pushEvents(app.db, auth, req.body, boxCtx(req, auth));
    },
  );

  app.get(
    '/sync/pull',
    {
      config: { credential: 'box', ...limited },
      schema: {
        description:
          'The cloud-authoritative changes this box has not seen: its branch’s, its operator’s, and the ones addressed to it by name',
        querystring: z.object({
          cursorSeq: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(200),
          /** Comma-separated; absent means every scope this box caches. */
          scopes: z.string().max(200).optional(),
        }),
      },
    },
    async (req) => {
      const auth = boxAuth(req);
      const scopes = parseList(req.query.scopes, SYNC_CHANGE_SCOPES);
      return pullChanges(app.db, auth, {
        cursorSeq: req.query.cursorSeq,
        limit: req.query.limit,
        scopes: scopes.length > 0 ? scopes : undefined,
      });
    },
  );

  app.get(
    '/cache',
    {
      config: { credential: 'box', ...limited },
      schema: {
        description:
          'Everything this box needs to run its counter with no internet, as one versioned document applied whole or not at all. A bundle newer than the agent can read is refused with an alert.',
        querystring: z.object({
          scopes: z.string().max(200).optional(),
          /**
           * The highest bundle version this agent can read. Lower than what
           * this api builds is refused with an alert rather than half-applied:
           * an agent that silently drops a field it does not recognise leaves a
           * counter running on a price list missing whatever was added last
           * week. Zero is allowed and means "none of them", which is the only
           * value an agent older than version 1 could honestly send.
           */
          schemaVersion: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(5_000).optional(),
          /** Pages one scope; ask for that scope on its own. */
          cursor: z.string().max(100).optional(),
        }),
      },
    },
    async (req, reply) => {
      const auth = boxAuth(req);
      await assertBundleReadable(app.db, auth, req.query.schemaVersion);
      const bundle = await cacheBundle(app.db, auth, {
        scopes: parseList(req.query.scopes, CACHE_SCOPES),
        supportedSchemaVersion: req.query.schemaVersion,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      /**
       * Same `If-None-Match` courtesy as the config bundle: a box polls this
       * and the answer usually has not moved, so the ordinary case is a 304
       * with no body rather than the branch's whole member list again.
       *
       * **Only when the version stands for something in the answer**
       * (SCRUM-322). The version is hashed over the administered scopes, so an
       * answer made of volatile ones alone — `?scopes=receipt_series`, which is
       * how the agent reads the receipt mark every tick — has a version hashed
       * over nothing, identical to every other such answer. Sending it would
       * make the next tick a 304 and freeze the mark at whatever the box first
       * saw. No validator is sent for one of those, so it is always answered
       * whole; it is a few hundred bytes.
       */
      if (bundleVersionCovers(bundle)) {
        const etag = `"${bundle.bundleVersion}"`;
        reply.header('etag', etag);
        const inm = req.headers['if-none-match'];
        if (typeof inm === 'string' && inm.split(',').some((v) => v.trim() === etag)) {
          return reply.code(304).send();
        }
      }
      return bundle;
    },
  );
}

/**
 * A comma-separated query value, narrowed to a known vocabulary.
 *
 * Unknown names are DROPPED rather than refused: a box newer than this api
 * asking for a scope it does not build yet should get the scopes that do exist,
 * not a 400 that leaves its cache empty.
 */
function parseList<T extends string>(raw: string | undefined, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const wanted = new Set(raw.split(',').map((s) => s.trim()));
  return allowed.filter((a) => wanted.has(a));
}
