import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { branch, registration, sale, supervisionWaiver } from '@oto/db';
import {
  AddRegistrationChildrenSchema,
  AttachRegistrationPhotoSchema,
  CheckInNowSchema,
  CreateRegistrationSchema,
  CreateWaiverSchema,
  LeaveAsBookedSchema,
} from '@oto/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { REPLAY_HEADER, claimClientId } from '../services/client-id';
import {
  addRegistrationChildren,
  attachRegistrationPhoto,
  checkInNow,
  createRegistration,
  getRegistration,
  leaveAsBooked,
  loadRegistration,
  nannyRosterOf,
  recordWaiver,
  registrationsAwaitingCheckIn,
  supervisionConfigOf,
  waiverViewOf,
  type Actor,
} from '../services/checkin';
import { opCtx, withTx } from '../services/tx';

/**
 * S2-13 round 1 — the supervision gate's routes (plan
 * docs/progress/plans/checkin/PLAN.md §2.2), online.
 *
 * The till calls these where the prototype called its in-memory mutators:
 * the gate registers the family (`POST /checkin/registrations`), records a
 * staff-accepted waiver (`POST /checkin/waivers`) and attaches the consent
 * photo; after payment the check-in choice either puts the children in the
 * park with their bands (`POST /checkin/check-in-now`) or leaves them booked
 * (`POST /checkin/leave-as-booked`).
 *
 * Every route is a staff session's — a paired display never reaches them, so
 * the waiver is staff-only by construction as well as by permission (OD-C3).
 */

const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;

function actorOf(req: FastifyRequest): Actor {
  const auth = req.requireAuth();
  const sent = req.headers['x-oto-action-id'];
  return {
    accountId: auth.accountId,
    operatorId: auth.operatorId,
    requestId: req.id,
    actionId: typeof sent === 'string' && ACTION_ID.test(sent) ? sent : null,
  };
}

export async function checkinRoutes(app: App): Promise<void> {
  app.get(
    '/config',
    {
      config: { permission: 'pos:checkin:read', target: { branchId: 'query.branchId' } },
      schema: {
        description: "The branch's supervision policy, confirmations, drop-off pricing and nanny roster",
        querystring: z.object({ branchId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await assertBranchOfOperator(app, auth.operatorId, req.query.branchId);
      const config = await supervisionConfigOf(app.db, req.query.branchId);
      return { ...config, nannies: await nannyRosterOf(app.db, req.query.branchId) };
    },
  );

  app.get(
    '/registrations',
    {
      config: { permission: 'pos:checkin:read', target: { branchId: 'query.branchId' } },
      schema: {
        description: 'Registrations at the branch still waiting for a child to be checked in',
        querystring: z.object({ branchId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return { registrations: await registrationsAwaitingCheckIn(app.db, auth.operatorId, req.query.branchId) };
    },
  );

  app.post(
    '/registrations',
    {
      config: { permission: 'pos:checkin:create', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Register the children left with the park, with the consent taken on the customer display. ' +
          'Client-minted id (OD-12): the same id again answers with the registration under x-oto-replay.',
        body: CreateRegistrationSchema,
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(registration).where(eq(registration.id, id)).limit(1))[0],
        (row) => row.operatorId === actor.operatorId && row.branchId === req.body.branchId,
      );
      if (claim.replay) {
        reply.header(REPLAY_HEADER, 'true');
        return getRegistration(app.db, actor.operatorId, claim.id);
      }
      const config = await supervisionConfigOf(app.db, req.body.branchId);
      return withTx(app.db, { ...opCtx(req), branchId: req.body.branchId }, 'registration.create', (tx) =>
        createRegistration(tx, actor, { ...req.body, id: claim.id }, config),
      );
    },
  );

  app.get(
    '/registrations/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'One registration with its children',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const reg = await loadRegistration(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:read', { branchId: reg.branchId });
      return getRegistration(app.db, actor.operatorId, reg.id);
    },
  );

  app.post(
    '/registrations/:id/children',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Add a sibling to a registration still waiting to be checked in',
        params: z.object({ id: z.string().uuid() }),
        body: AddRegistrationChildrenSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const reg = await loadRegistration(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:create', { branchId: reg.branchId });
      const config = await supervisionConfigOf(app.db, reg.branchId);
      return withTx(app.db, { ...opCtx(req), branchId: reg.branchId }, 'checkin.create', (tx) =>
        addRegistrationChildren(tx, actor, reg, req.body.children, config),
      );
    },
  );

  app.post(
    '/registrations/:id/photo',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Attach the uploaded child-and-guardian photo to the registration',
        params: z.object({ id: z.string().uuid() }),
        body: AttachRegistrationPhotoSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const reg = await loadRegistration(app.db, actor.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:update', { branchId: reg.branchId });
      return withTx(app.db, { ...opCtx(req), branchId: reg.branchId }, 'registration.photo', (tx) =>
        attachRegistrationPhoto(tx, actor, reg, req.body),
      );
    },
  );

  app.post(
    '/waivers',
    {
      // OD-C3: staff only, ENFORCED. The prototype stored `staffOnly` and never
      // read it; here the permission is the rule, on a staff session.
      config: { permission: 'pos:checkin:update', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Record a staff-accepted sibling waiver. Refused when the policy does not allow it for these two children. ' +
          'Client-minted id (OD-12).',
        body: CreateWaiverSchema,
      },
    },
    async (req, reply) => {
      const actor = actorOf(req);
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(supervisionWaiver).where(eq(supervisionWaiver.id, id)).limit(1))[0],
        (row) => row.operatorId === actor.operatorId && row.branchId === req.body.branchId,
      );
      if (claim.replay) {
        reply.header(REPLAY_HEADER, 'true');
        return waiverViewOf(claim.row);
      }
      const config = await supervisionConfigOf(app.db, req.body.branchId);
      return withTx(app.db, { ...opCtx(req), branchId: req.body.branchId }, 'supervision_waiver.create', (tx) =>
        recordWaiver(tx, actor, { ...req.body, id: claim.id }, config),
      );
    },
  );

  app.post(
    '/check-in-now',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "After payment: put the registration's children in the park, link the sale, mint and print their bands — one transaction",
        body: CheckInNowSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const branchId = await saleBranchOf(app, actor.operatorId, req.body.saleId);
      await req.requirePermission('pos:checkin:update', { branchId });
      return withTx(app.db, { ...opCtx(req), branchId }, 'checkin.check_in', (tx) => checkInNow(tx, actor, req.body));
    },
  );

  app.post(
    '/leave-as-booked',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'After payment: keep the children registered with the booked start and length; no band',
        body: LeaveAsBookedSchema,
      },
    },
    async (req) => {
      const actor = actorOf(req);
      const branchId = await saleBranchOf(app, actor.operatorId, req.body.saleId);
      await req.requirePermission('pos:checkin:update', { branchId });
      return withTx(app.db, { ...opCtx(req), branchId }, 'checkin.leave_booked', (tx) =>
        leaveAsBooked(tx, actor, req.body),
      );
    },
  );
}

async function assertBranchOfOperator(app: App, operatorId: string, branchId: string): Promise<void> {
  const [row] = await app.db.select({ operatorId: branch.operatorId }).from(branch).where(eq(branch.id, branchId)).limit(1);
  if (!row || row.operatorId !== operatorId) throw errors.notFound('Branch not found');
}

async function saleBranchOf(app: App, operatorId: string, saleId: string): Promise<string> {
  const [row] = await app.db
    .select({ branchId: sale.branchId, operatorId: sale.operatorId })
    .from(sale)
    .where(eq(sale.id, saleId))
    .limit(1);
  if (!row || row.operatorId !== operatorId) throw errors.notFound('Sale not found');
  return row.branchId;
}
