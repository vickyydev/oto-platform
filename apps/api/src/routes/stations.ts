import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  STATION_LEASE_HEARTBEAT_S,
  STATION_LEASE_TTL_S,
  STATION_VIEWS,
  StationIntentSchema,
} from '@oto/shared';
/**
 * The channel's own types come from `@oto/box-agent` rather than from
 * `@oto/shared`, even though the two are asserted identical item for item by
 * `test/contract-drift.test.ts`. What is being plumbed here are values the
 * MANAGER produces, so they are typed as the manager types them; taking the
 * mirrored copies would mean a structural conversion at every call for no gain.
 */
import type { StationChannelMessage, StationView } from '@oto/box-agent';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { stationChannels } from '../lib/station-channel';
import {
  loadStationRow,
  managerForStation,
  stationLink,
  type StationRow,
} from '../services/station-session';

/**
 * The station session document, over HTTP (S2-05).
 *
 * A till and a customer display are two screens onto one document, and this is
 * the surface between them and the box that owns it. Four shapes, and the
 * split between them is the design rather than a layout:
 *
 *   - **The lease** — claim, renew every 15 seconds, release. It is a fencing
 *     token: an intent is valid because it quotes the value on the row, not
 *     because a clock somewhere says it should still be valid. The token
 *     fences and does not authorise — see "Who may do what" below.
 *   - **Intents** — the only way the document changes. Each carries the lease
 *     it was sent under and the sequence its sender last saw, and the box
 *     applies it as one compare-and-set against both; a miss is `409 STALE`
 *     with the current document attached, so a displaced till rehydrates in
 *     the same round trip rather than needing a second one.
 *   - **The channel** — snapshots out, one per change, to every screen
 *     watching. One-way by nature, which is why it is server-sent events
 *     rather than a WebSocket: nothing travels UP it, the intents above are
 *     ordinary requests, and an EventSource reconnects on its own where a
 *     socket needs a reconnect loop written by hand. It is also the one thing
 *     `/ready` can count, so it opens and closes `stationChannels`.
 *   - **The link** — what the till's banner reads to say whether the counter
 *     is working with the internet or without it.
 *
 * **Who may do what.** Two roles, decided here and never sent by the client:
 *
 *   - the account whose session has PICKED this station is standing at it. It
 *     may hold the lease and send a till's intents, and its `source` is
 *     `till`;
 *   - anyone else who may look at the station — `admin:station:read` at the
 *     station's branch — is an OBSERVER. It receives every snapshot, holds no
 *     lease, and its `source` is `console`, which no intent spec in
 *     `@oto/box-agent` admits. That is what read-only means here: not a flag a
 *     screen is trusted to honour, but a source no rule accepts.
 *
 * Taking a LIVE station from the till holding it is the one thing an observer
 * cannot simply do, and the one thing an ordinary till cannot do either: it
 * needs `pos:station:takeover`, it names the account that did it, and it is
 * audited as `station.takeover`. An EXPIRED lease needs none of that — it is
 * claimable by anybody after 60 seconds, which is what makes a closed browser
 * tab something reception recovers from on its own.
 *
 * **And standing there is not holding it.** Two tills can both be standing at
 * one station — both sessions picked it — and only one of them holds the
 * lease. The other is a holder by the rule above, so it may ask for the lease
 * and be refused; what it may not do is work the sale anyway. It could try,
 * because `GET /stations/:id/session` hands the lease id to every reader: that
 * is deliberate, and it is why the id is not what the box checks. Every call
 * that carries a lease — renew, release, and an intent that needs one — is
 * passed `auth.accountId` and the box compares it with the account the lease
 * was claimed by. The refusal is `403 STATION_NOT_PERMITTED`, the same answer
 * an observer gets, because it is the same fact: you may not, whatever you are
 * holding. One person's second tab or a reloaded browser is the SAME account
 * and carries on working; a colleague at the next till is not and has to go
 * through a manager.
 */

const IdParams = z.object({ id: z.string().uuid() });
const ViewQuery = z.object({ view: z.enum(STATION_VIEWS).default('staff') });

/** The document as it goes out. Open records, because their shapes are later tickets'. */
const LeaseSchema = z.object({
  leaseId: z.string().uuid(),
  holder: z.string(),
  holderKind: z.string(),
  accountId: z.string().uuid().nullable(),
  startedAt: z.string(),
  heartbeatAt: z.string(),
  expiresAt: z.string(),
});

const DocumentSchema = z.object({
  stationId: z.string().uuid(),
  boxId: z.string().uuid(),
  schemaVersion: z.number().int(),
  sequence: z.number().int(),
  stage: z.string(),
  step: z.number().int().nullable().optional(),
  cart: z.record(z.string(), z.unknown()).nullable().optional(),
  member: z.record(z.string(), z.unknown()).nullable().optional(),
  totals: z.record(z.string(), z.unknown()).nullable().optional(),
  payment: z.record(z.string(), z.unknown()).nullable().optional(),
  prompt: z.record(z.string(), z.unknown()).nullable().optional(),
  language: z.string(),
  lease: LeaseSchema.nullable(),
  takeoverCount: z.number().int(),
  updatedAt: z.string(),
});

const SessionSchema = z.object({
  view: z.enum(STATION_VIEWS),
  /** `till` when the caller is standing at this station, `console` when watching. */
  source: z.enum(['till', 'console']),
  document: DocumentSchema,
  /** So a till knows when to renew without hard-coding the box's numbers. */
  leaseHeartbeatSeconds: z.number().int(),
  leaseTtlSeconds: z.number().int(),
  serverTime: z.string(),
});

const StationLinkSchema = z.object({
  stationId: z.string().uuid(),
  boxId: z.string().uuid().nullable(),
  boxName: z.string().nullable(),
  boxStatus: z.string().nullable(),
  offline: z.boolean(),
  offlineSince: z.string().nullable(),
  offlineReason: z.string().nullable(),
  outboxDepth: z.number().int().nullable(),
  oldestUnackedSeconds: z.number().int().nullable(),
  lastSyncAt: z.string().nullable(),
  syncStale: z.boolean(),
  cacheAppliedAt: z.string().nullable(),
  cacheAgeSeconds: z.number().int().nullable(),
  journalEpoch: z.number().int().nullable(),
});

/** Where the caller is standing. Derived from the session, never from the body. */
type Role = 'holder' | 'observer';

export async function stationSessionRoutes(app: App): Promise<void> {
  /**
   * Resolve the station and who is asking about it.
   *
   * The holder check is `session.station_id`, the same field
   * `PUT /me/session/station` writes, so "may I work this station" was already
   * answered by the picker's visibility rule and is not asked twice in two
   * different ways here. Everyone else has to hold the fleet's read
   * permission AT THIS STATION'S BRANCH — a manager scoped to one branch
   * cannot watch a till at another.
   */
  async function standing(req: FastifyRequest, stationId: string): Promise<{
    row: StationRow;
    role: Role;
  }> {
    const auth = req.requireAuth();
    const row = await loadStationRow(app.db, auth.operatorId, stationId);
    if (auth.stationId === stationId) return { row, role: 'holder' };
    await req.requirePermission('admin:station:read', { branchId: row.branchId });
    return { row, role: 'observer' };
  }

  /** A till's own work needs the till to be standing there. */
  function requireHolder(role: Role, row: StationRow): void {
    if (role === 'observer') {
      throw new AppError(
        403,
        'STATION_NOT_PICKED',
        `Take ${row.name} first — a session that is not standing at a station cannot work it`,
      );
    }
  }

  const sourceFor = (role: Role): 'till' | 'console' => (role === 'holder' ? 'till' : 'console');

  /**
   * A refusal from the box, as HTTP.
   *
   * Three statuses for three different next moves. `stale`, `no_lease` and
   * `wrong_stage` are 409 and carry the current document, because what the
   * client does is rehydrate and decide again rather than show an error.
   * `not_permitted` is 403: you may not, whatever you are holding — it is what
   * an observer gets. `unknown_intent` is 400, because the request itself is
   * the problem: a till newer than its box, which is the ordinary state of a
   * fleet mid-rollout and is worth naming rather than retrying.
   */
  const REFUSAL_STATUS: Record<string, number> = {
    not_permitted: 403,
    unknown_intent: 400,
  };

  function refusalError(refusal: string, message: string, document: unknown): AppError {
    return new AppError(
      REFUSAL_STATUS[refusal] ?? 409,
      `STATION_${refusal.toUpperCase()}`,
      message,
      { document },
    );
  }

  // --- The till's banner ----------------------------------------------------

  app.get(
    '/me/station/link',
    {
      config: { auth: 'session' },
      schema: {
        description:
          'Whether the station this session is standing at is working with the internet or without it: the box, its offline state, how much is queued on it and how old its cache is.',
        response: { 200: StationLinkSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      if (!auth.stationId) {
        throw new AppError(
          409,
          'NO_STATION_PICKED',
          'This session is not standing at a station yet',
        );
      }
      return stationLink(app.db, auth.stationId);
    },
  );

  // --- The document ---------------------------------------------------------

  app.get(
    '/stations/:id/session',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The station session document as it stands. The customer view is redacted by the box, not by the screen.',
        params: IdParams,
        querystring: ViewQuery,
        response: { 200: SessionSchema },
      },
    },
    async (req) => {
      const { row, role } = await standing(req, req.params.id);
      const { manager } = managerForStation(app.db, row, req.log);
      const held = await manager.open(row.id);
      /**
       * Through the manager's own snapshot, never straight from the row.
       *
       * `snapshotFor` is where the customer view is computed, and it is the
       * ONLY place: a screen asking for `view=customer` here and a screen
       * watching the channel have to be told the same thing, or a display that
       * rehydrated over HTTP would be showing a child's allergy note that the
       * live stream takes out.
       */
      const snapshot = manager.snapshotFor(held, req.query.view, null);
      return {
        view: snapshot.view,
        source: sourceFor(role),
        document: snapshot.document,
        leaseHeartbeatSeconds: STATION_LEASE_HEARTBEAT_S,
        leaseTtlSeconds: STATION_LEASE_TTL_S,
        serverTime: snapshot.serverTime,
      };
    },
  );

  // --- The lease ------------------------------------------------------------

  app.post(
    '/stations/:id/lease',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Take this station for this screen. A free or expired lease is claimed outright; a live one is refused unless `takeover` is set, which needs pos:station:takeover and is audited as station.takeover.',
        params: IdParams,
        body: z.object({
          /** An opaque per-client id — a browser tab, not a person. */
          holder: z.string().min(1).max(64),
          takeover: z.boolean().default(false),
        }),
        response: {
          200: z.object({
            lease: LeaseSchema,
            takenOver: z.boolean(),
            document: DocumentSchema,
            leaseHeartbeatSeconds: z.number().int(),
            leaseTtlSeconds: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { row, role } = await standing(req, req.params.id);
      requireHolder(role, row);
      if (req.body.takeover) {
        // The manager gate. Asked at the STATION's branch rather than the
        // session's, so a manager scoped to one branch cannot reach across to
        // another — even though the holder check above already means they are
        // standing at this one.
        await req.requirePermission('pos:station:takeover', { branchId: row.branchId });
      }
      const { manager } = managerForStation(app.db, row, req.log);
      const result = await manager.claim({
        stationId: row.id,
        holder: req.body.holder,
        holderKind: 'till',
        // From the session, never from the body: this is the name that ends up
        // on the audit row when a live till is displaced.
        accountId: auth.accountId,
        takeover: req.body.takeover,
        actionId: actionIdOf(req),
      });
      if (!result.ok) throw refusalError(result.refusal, result.message, result.document);
      return {
        lease: result.lease,
        takenOver: result.takenOver,
        document: result.document,
        leaseHeartbeatSeconds: STATION_LEASE_HEARTBEAT_S,
        leaseTtlSeconds: STATION_LEASE_TTL_S,
      };
    },
  );

  app.post(
    '/stations/:id/lease/renew',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The 15-second heartbeat. It moves the expiry and nothing else — in particular not the sequence, or two screens could never agree on a number for longer than one heartbeat. Only the account the lease was claimed by may send it; anyone else quoting the id gets 403 STATION_NOT_PERMITTED.',
        params: IdParams,
        body: z.object({ leaseId: z.string().uuid() }),
        response: {
          200: z.object({ lease: LeaseSchema, document: DocumentSchema }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { row, role } = await standing(req, req.params.id);
      requireHolder(role, row);
      const { manager } = managerForStation(app.db, row, req.log);
      const result = await manager.renew(row.id, req.body.leaseId, { accountId: auth.accountId });
      if (!result.ok) throw refusalError(result.refusal, result.message, result.document);
      return { lease: result.lease, document: result.document };
    },
  );

  app.post(
    '/stations/:id/lease/release',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Give the station up. The next screen claims it immediately rather than waiting out the 60-second TTL. Only the account the lease was claimed by may give it up; anyone else quoting the id gets 403 STATION_NOT_PERMITTED.',
        params: IdParams,
        body: z.object({ leaseId: z.string().uuid() }),
        response: { 200: z.object({ released: z.boolean() }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { row, role } = await standing(req, req.params.id);
      requireHolder(role, row);
      const { manager } = managerForStation(app.db, row, req.log);
      const result = await manager.release(row.id, req.body.leaseId, {
        accountId: auth.accountId,
        actionId: actionIdOf(req),
      });
      if (!result.ok) throw refusalError(result.refusal, result.message, result.document);
      // False when the lease had already moved on, which is not an error: the
      // tab closing after a takeover is the ordinary case.
      return { released: result.released };
    },
  );

  // --- Intents --------------------------------------------------------------

  app.post(
    '/stations/:id/intents',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Ask the box to change the document. Applied as one compare-and-set against the lease and the sequence; a miss answers 409 STATION_STALE with the current document attached. Quoting the lease is not holding it: an intent from an account other than the one that claimed it answers 403 STATION_NOT_PERMITTED.',
        params: IdParams,
        body: StationIntentSchema,
        response: { 200: z.object({ document: DocumentSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { row, role } = await standing(req, req.params.id);
      const { manager } = managerForStation(app.db, row, req.log);
      const result = await manager.applyIntent(
        row.id,
        { ...req.body, actionId: req.body.actionId ?? actionIdOf(req) ?? undefined },
        {
          // The source the box judges this by. An observer is `console`, which
          // matches no intent spec at all — so a Console tab is refused
          // whatever it sends and whatever lease it quotes.
          source: sourceFor(role),
          // And for a till, the account the box checks the quoted lease
          // against: being at the station is not holding it, and the lease id
          // is in every snapshot this station sends out.
          accountId: auth.accountId,
        },
      );
      if (!result.ok) throw refusalError(result.refusal, result.message, result.document);
      return { document: result.document };
    },
  );

  // --- The channel ----------------------------------------------------------

  app.get(
    '/stations/:id/channel',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Snapshots of this station’s document, as server-sent events: the current one on connect, then one per change. Counted by /ready.',
        params: IdParams,
        querystring: ViewQuery,
      },
    },
    async (req, reply) => {
      // The role decides nothing here beyond the right to watch at all: both a
      // till and an observer receive the same stream, redacted by the view
      // they asked for and by nothing else.
      const { row } = await standing(req, req.params.id);
      const { manager } = managerForStation(app.db, row, req.log);
      const view = req.query.view;
      const document = await manager.open(row.id);
      openChannel(req, reply, row.id, view, (send) => {
        // The current state first, so a screen that reconnects is correct
        // after one message and needs no catch-up protocol.
        send(manager.snapshotFor(document, view, null));
        return manager.subscribe(row.id, view, send);
      });
      // Hijacked: the stream is written to `reply.raw` for as long as the
      // screen is there, so nothing is returned for Fastify to serialise.
      return reply;
    },
  );

}

/** The same shape the telemetry plugin accepts, so one id follows one gesture. */
const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;

function actionIdOf(req: FastifyRequest): string | null {
  const sent = req.headers['x-oto-action-id'];
  // Refused rather than echoed when it is the wrong shape: a header copied
  // into a log line is a header that could forge one.
  return typeof sent === 'string' && ACTION_ID.test(sent) ? sent : null;
}

/**
 * How long a channel may sit silent before something is written down it.
 *
 * Not for the browser, which is happy to wait: for everything between. A mall's
 * router and Render's own proxy both drop an idle connection after a minute or
 * two, and a comment line costs nothing and keeps it open.
 */
const CHANNEL_KEEPALIVE_MS = 25_000;

/**
 * Open a server-sent event stream and keep `/ready`'s count honest.
 *
 * The count is the whole reason this is one function rather than inline: a
 * connection opened and never closed is a station that reads as busy forever,
 * and there are four ways a stream ends — the screen navigates away, the
 * socket errors, the process shuts down, the request is aborted mid-flight.
 * All four land on `finish`, once.
 */
function openChannel(
  req: FastifyRequest,
  reply: FastifyReply,
  stationId: string,
  view: StationView,
  attach: (send: (message: StationChannelMessage) => void) => () => void,
): void {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Render and nginx both buffer a response body by default, which turns a
    // live stream into a screen that updates when the connection closes.
    'x-accel-buffering': 'no',
  });

  stationChannels.open(stationId);
  let closed = false;

  const send = (message: StationChannelMessage): void => {
    if (closed) return;
    raw.write(`event: ${message.kind}\ndata: ${JSON.stringify(message)}\n\n`);
  };

  let unsubscribe: (() => void) | null = null;
  const keepalive = setInterval(() => {
    if (!closed) raw.write(`: ${new Date().toISOString()}\n\n`);
  }, CHANNEL_KEEPALIVE_MS);
  keepalive.unref?.();

  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe?.();
    stationChannels.close(stationId);
    raw.end();
  };

  raw.on('close', finish);
  raw.on('error', finish);
  req.raw.on('aborted', finish);

  try {
    unsubscribe = attach(send);
  } catch (err) {
    req.log.error({ err, stationId, view }, 'a station channel could not be attached');
    finish();
  }
}
