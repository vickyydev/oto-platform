import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  BridgeStatusSchema,
  BridgeUnlockRequestSchema,
  BridgeUnlockResponseSchema,
  STATION_VIEWS,
  StationIntentSchema,
  StationSessionDocumentSchema,
} from '@oto/shared';
import { BridgeError, type BridgeTillCaller } from '@oto/box-agent';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { displayDeviceOf } from '../plugins/credential';
import { holdsGrantAt } from '../services/access-control';
import { displayIntent, displaySession } from '../services/display';
import { bridgeForStation, platformCaller, unlockThroughBridge } from '../services/station-bridge';
import { loadStationRow, type StationRow } from '../services/station-session';
import { actionIdOf, openChannel } from './stations';

/**
 * THE STATION BRIDGE, ON THE API — the virtual box's mount (offline plan §2.2,
 * Round 3; SCRUM-269).
 *
 * `/box/v1/station/:stationId/*`, the contract a Raspberry Pi also serves
 * (`@oto/box-agent` `station-bridge.ts`, `runner/bridge-server.ts`), so a till
 * talks to its box in one set of words whichever kind of box it is standing
 * at. Three things are true of this mount and not of the Pi's:
 *
 *   - **The platform session is the credential** (OD-2), standing at the
 *     station it saved — the same test `routes/stations.ts` applies, asked
 *     again per request because a grant can be taken away mid-shift. An
 *     observer holding `admin:station:read` at the station's branch may read
 *     the status and the document, and nothing else.
 *   - **It is outside the `stationTrading` guard, on purpose.** It is the
 *     box's surface, not the platform's trading surface, so it keeps working
 *     with the station forced offline — which is exactly the demonstration:
 *     the till's lane arbiter moves here when the platform answers
 *     `503 STATION_FORCED_OFFLINE`, and finds members, signs families up and
 *     prices a cart from the box's own copies.
 *   - **The customer display** reads it with its paired credential, through
 *     the same guard `/display/session` uses, and is only ever handed the
 *     redacted document (OD-10).
 *
 * Round 4 sells here: `sale.finalise` (cash, or a ฿0 comp) and `payment.*`
 * (a card or the PAX QR on the counter's own terminal) are written by the
 * virtual box's own sale queue — one store transaction for the number, the
 * bands, the paper and the fact — and printed from its queue. What the
 * capability list refuses offline is refused here in its words.
 */

const Params = z.object({ stationId: z.string().uuid() });
const ViewQuery = z.object({ view: z.enum(STATION_VIEWS).default('staff') });

const SnapshotSchema = z.object({
  view: z.enum(STATION_VIEWS),
  document: StationSessionDocumentSchema,
  serverTime: z.string(),
});

const LeaseAnswer = z.object({
  lease: z.record(z.string(), z.unknown()),
  takenOver: z.boolean(),
  document: StationSessionDocumentSchema,
});

const IntentAnswer = z.object({
  document: StationSessionDocumentSchema,
  result: z.record(z.string(), z.unknown()).optional(),
});

/** A bridge refusal, in the api's envelope with the bridge's own status and code. */
function asAppError(err: unknown): unknown {
  if (err instanceof BridgeError) {
    return new AppError(err.status, err.code, err.message, err.details);
  }
  return err;
}

async function bridged<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw asAppError(err);
  }
}

export async function stationBridgeRoutes(app: App): Promise<void> {
  /**
   * Who is asking, from the session. A holder is standing at this station and
   * still holds a grant at its branch; an observer may watch with
   * `admin:station:read` there. Anything that works the station needs the
   * holder.
   */
  async function standing(
    req: FastifyRequest,
    stationId: string,
    allowObserver: boolean,
  ): Promise<{ row: StationRow; caller: BridgeTillCaller | null }> {
    const auth = req.requireAuth();
    const row = await loadStationRow(app.db, auth.operatorId, stationId);
    const effective = await req.effectivePermissions();
    if (auth.stationId === stationId && holdsGrantAt(effective, auth.operatorId, row.branchId)) {
      return {
        row,
        caller: platformCaller(auth.accountId, auth.operatorId, row.branchId, effective),
      };
    }
    if (!allowObserver) {
      throw new AppError(
        403,
        'STATION_NOT_PICKED',
        `Take ${row.name} first — a session that is not standing at a station cannot work it`,
      );
    }
    await req.requirePermission('admin:station:read', { branchId: row.branchId });
    return { row, caller: null };
  }

  app.get(
    '/box/v1/station/:stationId/status',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "How this station's box stands: its link to the platform, how old its copies are (OD-5), what is waiting to go up. What the till's lane arbiter and offline banner read. No personal data.",
        params: Params,
        response: { 200: BridgeStatusSchema },
      },
    },
    async (req, reply) => {
      const { row } = await standing(req, req.params.stationId, true);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      reply.header('cache-control', 'private, no-store');
      return bridged(() => bridge.status(row.id));
    },
  );

  app.post(
    '/box/v1/station/:stationId/unlock',
    {
      /**
       * `secretResponse`: the answer carries a box session, which is a
       * credential and must never sit in a store that replays a body to anyone
       * holding the key. A retry is a second attempt and counts as one, as a
       * second `POST /auth/unlock` does.
       */
      config: { dynamicPermission: true, secretResponse: true },
      schema: {
        description:
          "Unlock this till through its box: the staff token and the password checked against the box's own copy of the staff list and the deny-list (OD-2). A fresh sign-in with no live token is admitted for somebody the box has seen in 30 days while it holds a deny-list pulled within 72 hours (OD-6). Takes the lock off the platform session and records both halves together.",
        params: Params,
        body: BridgeUnlockRequestSchema,
        response: { 200: BridgeUnlockResponseSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { row } = await standing(req, req.params.stationId, false);
      return bridged(() =>
        unlockThroughBridge(
          app.db,
          app.env,
          row,
          {
            sessionId: auth.sessionId,
            accountId: auth.accountId,
            operatorId: auth.operatorId,
            branchId: auth.branchId,
            requestId: req.id,
          },
          req.body,
          req.log,
        ),
      );
    },
  );

  app.post(
    '/box/v1/station/:stationId/lock',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'End the box session this till holds (at lock or sign-out). Unknown sessions are not an error.',
        params: Params,
        response: { 200: z.object({ ended: z.boolean() }) },
      },
    },
    async (req) => {
      const { row } = await standing(req, req.params.stationId, false);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? null;
      return { ended: bridge.end(bearer) };
    },
  );

  app.get(
    '/box/v1/station/:stationId/session',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "The station's document as the box holds it. The customer view is redacted by the box, not by the screen.",
        params: Params,
        querystring: ViewQuery,
        response: { 200: SnapshotSchema },
      },
    },
    async (req, reply) => {
      const { row, caller } = await standing(req, req.params.stationId, true);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      const snapshot = await bridged(() => bridge.session(row.id, caller, req.query.view));
      reply.header('cache-control', 'private, no-store');
      return { view: snapshot.view, document: snapshot.document, serverTime: snapshot.serverTime };
    },
  );

  app.get(
    '/box/v1/station/:stationId/channel',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "Snapshots of this station's document as server-sent events: the current one on connect, then one per change.",
        params: Params,
        querystring: ViewQuery,
      },
    },
    async (req, reply) => {
      const { row, caller } = await standing(req, req.params.stationId, true);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      const view = req.query.view;
      const first = await bridged(() => bridge.session(row.id, caller, view));
      openChannel(req, reply, row.id, view, (send) => {
        send(first);
        return bridge.subscribe(row.id, caller, view, send);
      });
      return reply;
    },
  );

  app.post(
    '/box/v1/station/:stationId/lease',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Take this station for this screen, on the box. A live lease held by another account is refused.',
        params: Params,
        body: z.object({ holder: z.string().min(1).max(64) }),
        response: { 200: LeaseAnswer },
      },
    },
    async (req) => {
      const { row, caller } = await standing(req, req.params.stationId, false);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      const result = await bridged(() =>
        bridge.claim(row.id, caller!, req.body.holder, actionIdOf(req)),
      );
      return { lease: { ...result.lease }, takenOver: result.takenOver, document: result.document };
    },
  );

  app.post(
    '/box/v1/station/:stationId/lease/renew',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'The 15-second heartbeat for a lease held through the bridge.',
        params: Params,
        body: z.object({ leaseId: z.string().uuid() }),
        response: { 200: LeaseAnswer },
      },
    },
    async (req) => {
      const { row, caller } = await standing(req, req.params.stationId, false);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      const result = await bridged(() => bridge.renew(row.id, caller!, req.body.leaseId));
      return { lease: { ...result.lease }, takenOver: false, document: result.document };
    },
  );

  app.post(
    '/box/v1/station/:stationId/lease/release',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Give the station up. Only the account the lease was claimed by may.',
        params: Params,
        body: z.object({ leaseId: z.string().uuid() }),
        response: { 200: z.object({ released: z.boolean() }) },
      },
    },
    async (req) => {
      const { row, caller } = await standing(req, req.params.stationId, false);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      const result = await bridged(() =>
        bridge.release(row.id, caller!, req.body.leaseId, actionIdOf(req)),
      );
      return { released: result.ok && result.released };
    },
  );

  app.get(
    '/box/v1/station/:stationId/members/lookup',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "A member by phone, from the box's own copy with what this counter recorded offline laid over it (plan §2.3). Needs pos:member:read at the station's branch.",
        params: Params,
        querystring: z.object({ phone: z.string().max(40) }),
        response: { 200: z.object({ member: z.record(z.string(), z.unknown()).nullable() }) },
      },
    },
    async (req, reply) => {
      const { row, caller } = await standing(req, req.params.stationId, false);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      reply.header('cache-control', 'private, no-store');
      const member = await bridged(() => bridge.lookup(row.id, caller!, req.query.phone));
      return { member: member as unknown as Record<string, unknown> | null };
    },
  );

  app.post(
    '/box/v1/station/:stationId/intents',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "Ask the box to act: the session manager's intents, `cart.quote` priced from the box's catalogue, the member, child, visit and tier-change records written to its outbox and overlay under the till's ids, and selling (Round 4): `sale.finalise`, `payment.start`, `payment.inquire`, `payment.confirm`, `payment.status`, `sale.reprint` and `receipt.observed`. The 2C2P QR, vouchers, wallet spend, booking redemption, refunds and voids are refused in the capability list's words.",
        params: Params,
        body: StationIntentSchema,
        response: { 200: IntentAnswer },
      },
    },
    async (req) => {
      const { row, caller } = await standing(req, req.params.stationId, false);
      const { bridge } = await bridgeForStation(app.db, row, req.log);
      const intent = { ...req.body, actionId: req.body.actionId ?? actionIdOf(req) ?? undefined };
      return bridged(() => bridge.intent(row.id, caller!, intent));
    },
  );

  // --- The customer display, with its own credential (OD-10) ----------------

  app.get(
    '/box/v1/station/:stationId/display/session',
    {
      config: { credential: 'display', displayScope: 'display:read' },
      schema: {
        description:
          "The paired display's station document through its box, redacted by the box. A display paired to another station is refused.",
        params: Params,
        response: {
          200: z.object({
            station: z.object({ id: z.string().uuid(), name: z.string(), kind: z.string() }),
            device: z.object({ id: z.string().uuid(), name: z.string() }),
            document: StationSessionDocumentSchema,
          }),
        },
      },
    },
    async (req, reply) => {
      const device = displayDeviceOf(req);
      if (device.station.id !== req.params.stationId) {
        throw new AppError(
          403,
          'DISPLAY_OTHER_STATION',
          'This display is paired to another station',
        );
      }
      /**
       * On a virtual box the bridge's display read IS the platform's display
       * read — the same session manager and the same box redaction — so it
       * goes through `displaySession`, which also keeps the Console's record
       * of what this display was last answered (SCRUM-201). A Pi answers the
       * same path from its own bridge (`runner/bridge-server.ts`).
       */
      reply.header('cache-control', 'private, no-store');
      return displaySession(app.db, device, req.log);
    },
  );

  app.post(
    '/box/v1/station/:stationId/display/intents',
    {
      config: { credential: 'display', displayScope: 'display:intents' },
      schema: {
        description:
          "A customer display's own intent — an answer to the till's prompt, the language toggle — through its box. Source and station come from the credential.",
        params: Params,
        body: StationIntentSchema,
        response: { 200: z.object({ document: StationSessionDocumentSchema }) },
      },
    },
    async (req) => {
      const device = displayDeviceOf(req);
      if (device.station.id !== req.params.stationId) {
        throw new AppError(
          403,
          'DISPLAY_OTHER_STATION',
          'This display is paired to another station',
        );
      }
      // As the read above: the platform's display intent, with its record.
      return displayIntent(app.db, device, req.body, req.log);
    },
  );
}
