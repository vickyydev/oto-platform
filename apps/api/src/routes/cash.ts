import { z } from 'zod';
import {
  CashDrawerViewSchema,
  CashMovementBodySchema,
  CashMovementResultSchema,
  CashSessionCloseBodySchema,
  CashSessionOpenBodySchema,
  CashSessionViewSchema,
} from '@oto/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import {
  closeSession,
  drawerViewOf,
  loadCashSession,
  loadCashStation,
  openSession,
  recordMovement,
  sessionViewOf,
  verifySecondPerson,
  type CashActor,
} from '../services/cash';
import { opCtx, withTx } from '../services/tx';

/**
 * S2-15a round 1 — the drawer (plan docs/progress/plans/cash/PLAN.md §2.2).
 *
 * The till's "Cash" action and the End of Day screen's drawer card read and
 * write here: the station's drawer, opening a session, a paid-out / safe drop
 * / top-up, and the count that closes it. Every write is one transaction
 * through `services/cash.ts`, audited, action-keyed (the body's `actionId` or
 * the `x-oto-action-id` header), and behind the global idempotency key.
 *
 * PERMISSIONS, at the station's own park — the station or session is loaded
 * inside the caller's operator first, then the permission is asked at the
 * branch that comes back (SCRUM-290's pattern):
 *   reading the drawer, opening it     pos:cash:session_open
 *   a paid-out, safe drop, top-up      pos:cash:movement (+ the second person's
 *                                      own pos:cash:approve for a paid-out)
 *   counting and closing               pos:cash:session_close
 *
 * THE SECOND PERSON signs on the till with their own phone and password,
 * verified on the pool BEFORE the movement's transaction (a failure counter
 * must survive the refusal). The till sends no Idempotency-Key with those two
 * kinds, so no hash of a body carrying a password is ever stored; the
 * movement's action id is their replay net (unique per operator).
 */

const StationParams = z.object({ stationId: z.string().uuid() });
const SessionParams = z.object({ sessionId: z.string().uuid() });
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function actionIdOf(req: FastifyRequest, fromBody: string | undefined): string | null {
  if (fromBody) return fromBody;
  const header = req.headers['x-oto-action-id'];
  return typeof header === 'string' && header.length > 0 && header.length <= 200 ? header : null;
}

export async function cashRoutes(app: App): Promise<void> {
  const actorOf = (req: FastifyRequest): CashActor => {
    const auth = req.requireAuth();
    return { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id };
  };

  app.get(
    '/stations/:stationId/cash',
    {
      config: { permission: 'pos:cash:session_open' },
      schema: {
        description:
          "The station's cash drawer: its open session (float, movements and the expected cash read from the ledger), " +
          'its latest close, and what a session opened now would start with — the last close’s float left, or the ' +
          'branch’s standard float. With `date`, the session shown is the latest one opened on that business date.',
        params: StationParams,
        querystring: z.object({ date: DATE.optional() }),
        response: { 200: CashDrawerViewSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { station } = await loadCashStation(app.db, auth.operatorId, req.params.stationId);
      await req.requirePermission('pos:cash:session_open', { branchId: station.branchId });
      return drawerViewOf(app.db, auth.operatorId, station.id, req.query.date);
    },
  );

  app.post(
    '/stations/:stationId/cash/sessions',
    {
      config: { permission: 'pos:cash:session_open' },
      schema: {
        description:
          'Open the drawer at this station with its carried-over float (the last close’s float left, else the ' +
          'branch’s standard ฿6,000). One open session per station: 409 CASH_SESSION_ALREADY_OPEN; a station routed ' +
          '`cash: none` has no drawer: 409 CASH_NO_DRAWER. Audited as cash_session.open.',
        params: StationParams,
        body: CashSessionOpenBodySchema,
        response: { 200: z.object({ replayed: z.boolean(), session: CashSessionViewSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { station } = await loadCashStation(app.db, auth.operatorId, req.params.stationId);
      await req.requirePermission('pos:cash:session_open', { branchId: station.branchId });
      const actionId = actionIdOf(req, req.body.actionId);
      return withTx(app.db, opCtx(req), 'cash_session.open', (tx) =>
        openSession(tx, actorOf(req), station.id, { id: req.body.id ?? null, actionId }, new Date()),
      );
    },
  );

  app.get(
    '/cash/sessions/:sessionId',
    {
      config: { permission: 'pos:cash:session_open' },
      schema: {
        description: 'One drawer session: its float, movements, the expected cash and — once closed — the count, variance and sign-off.',
        params: SessionParams,
        response: { 200: CashSessionViewSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadCashSession(app.db, auth.operatorId, req.params.sessionId);
      await req.requirePermission('pos:cash:session_open', { branchId: row.branchId });
      return sessionViewOf(app.db, row);
    },
  );

  app.post(
    '/cash/sessions/:sessionId/movements',
    {
      config: { permission: 'pos:cash:movement' },
      schema: {
        description:
          'Record a paid-out (an approver — not you — with pos:cash:approve signs with their phone and password), a safe ' +
          'drop (a witness — not you — signs the same way) or a top-up, with a reason, on an open session. Action-keyed: ' +
          'the same action id answers the movement already written. Audited as cash_movement.<kind>.',
        params: SessionParams,
        body: CashMovementBodySchema,
        response: { 200: CashMovementResultSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadCashSession(app.db, auth.operatorId, req.params.sessionId);
      await req.requirePermission('pos:cash:movement', { branchId: row.branchId });
      const limits = { maxFailures: app.env.AUTH_MAX_FAILURES, cooldownSeconds: app.env.AUTH_COOLDOWN_SECONDS };
      const body = req.body;
      const approverAccountId =
        body.kind === 'paid_out' && body.approver
          ? await verifySecondPerson(app.db, auth.operatorId, body.approver, limits)
          : null;
      const witnessAccountId =
        body.kind === 'safe_drop' && body.witness
          ? await verifySecondPerson(app.db, auth.operatorId, body.witness, limits)
          : null;
      const actionId = actionIdOf(req, body.actionId);
      return withTx(app.db, opCtx(req), `cash_movement.${body.kind}`, (tx) =>
        recordMovement(
          tx,
          actorOf(req),
          row.id,
          {
            kind: body.kind,
            amountSatang: body.amountSatang,
            reason: body.reason,
            approverAccountId,
            witnessAccountId,
            actionId,
          },
          new Date(),
        ),
      );
    },
  );

  app.post(
    '/cash/sessions/:sessionId/close',
    {
      config: { permission: 'pos:cash:session_close' },
      schema: {
        description:
          'Count and close the drawer: the count in satang, the float left for the next session (default: the ' +
          'branch’s standard float, never more than the count). Stores the expected cash read from the ledger and ' +
          'the variance, held against — and signed off by — the person closing. Outside the branch tolerance (฿1) a ' +
          'note is required: 400 CASH_VARIANCE_NOTE_REQUIRED. Audited as cash_session.close.',
        params: SessionParams,
        body: CashSessionCloseBodySchema,
        response: { 200: z.object({ replayed: z.boolean(), session: CashSessionViewSchema }) },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const row = await loadCashSession(app.db, auth.operatorId, req.params.sessionId);
      await req.requirePermission('pos:cash:session_close', { branchId: row.branchId });
      const actionId = actionIdOf(req, req.body.actionId);
      return withTx(app.db, opCtx(req), 'cash_session.close', (tx) =>
        closeSession(
          tx,
          actorOf(req),
          row.id,
          {
            countedSatang: req.body.countedSatang,
            floatLeftSatang: req.body.floatLeftSatang ?? null,
            note: req.body.note ?? null,
            actionId,
          },
          new Date(),
        ),
      );
    },
  );
}
