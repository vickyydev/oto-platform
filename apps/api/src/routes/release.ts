import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { guardian, release } from '@oto/db';
import { AddGuardianSchema, CreateReleaseSchema, EditGuardianSchema } from '@oto/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { REPLAY_HEADER, claimClientId } from '../services/client-id';
import { gatewayFor } from '../services/payments/gateway';
import { settleGatewayRefunds } from '../services/refunds';
import {
  addGuardian,
  editGuardian,
  loadGuardianForPickups,
  loadRegistrationForPickups,
  loadStayForRelease,
  pickupsOf,
  releaseChild,
  releaseContextOf,
  releaseViewOf,
  revokeGuardian,
  stationAtBranch,
  type ReleaseActor,
} from '../services/release';
import { opCtx, withTx } from '../services/tx';

/**
 * S2-13 round 3 — the pickup list and the release (plan docs/progress/plans/
 * checkin/PLAN.md §2.4), online. Registered under `/checkin/pickups`.
 *
 * The board's sheet and release modal call these where the prototype called
 * `getAuthorizedPickups`, `addGuardianToRegistration`, `editGuardian`,
 * `addPickupFromChatPhoto` and `checkOut`. Every route is a staff session's
 * and every one is guarded at the park the registration or stay is at:
 * reading behind `pos:checkin:read`, changing the list behind
 * `pos:checkin:guardian_manage`, releasing behind `pos:checkin:release`. The
 * photos themselves are read through `GET /files/:id/url`, which access-logs
 * every read (R-94).
 */

const ACTION_ID = /^[A-Za-z0-9._-]{8,64}$/;

function actorOf(req: FastifyRequest, stationId: string | null): ReleaseActor {
  const auth = req.requireAuth();
  const sent = req.headers['x-oto-action-id'];
  return {
    accountId: auth.accountId,
    operatorId: auth.operatorId,
    stationId,
    requestId: req.id,
    actionId: typeof sent === 'string' && ACTION_ID.test(sent) ? sent : null,
  };
}

export async function releaseRoutes(app: App): Promise<void> {
  app.get(
    '/registrations/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "A registration's authorised-pickup list: the dropper-off first, with the sign-up photo, then everyone added and not revoked",
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const reg = await loadRegistrationForPickups(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:read', { branchId: reg.branchId });
      return { registrationId: reg.id, branchId: reg.branchId, pickups: await pickupsOf(app.db, reg) };
    },
  );

  app.post(
    '/registrations/:id/guardians',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Add someone to the pickup list: in person, promoted from a chat photo, or on the spot at pickup (name and photo required). ' +
          'Client-minted id (OD-12): the same id again answers with that person under x-oto-replay.',
        params: z.object({ id: z.string().uuid() }),
        body: AddGuardianSchema,
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const reg = await loadRegistrationForPickups(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:guardian_manage', { branchId: reg.branchId });
      const actor = actorOf(req, await stationAtBranch(app.db, auth.stationId, reg.branchId));
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(guardian).where(eq(guardian.id, id)).limit(1))[0],
        (row) => row.operatorId === auth.operatorId && row.registrationId === reg.id,
      );
      if (claim.replay) {
        reply.header(REPLAY_HEADER, 'true');
        return (await pickupsOf(app.db, reg)).find((p) => p.id === claim.id) ?? null;
      }
      return withTx(app.db, { ...opCtx(req), branchId: reg.branchId }, 'guardian.create', (tx) =>
        addGuardian(tx, actor, reg, { ...req.body, id: claim.id }),
      );
    },
  );

  app.patch(
    '/guardians/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description: "Edit a listed person's name, phone, relationship or photo; audited before and after",
        params: z.object({ id: z.string().uuid() }),
        body: EditGuardianSchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const found = await loadGuardianForPickups(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:guardian_manage', { branchId: found.registration.branchId });
      const actor = actorOf(req, await stationAtBranch(app.db, auth.stationId, found.registration.branchId));
      return withTx(app.db, { ...opCtx(req), branchId: found.registration.branchId }, 'guardian.update', (tx) =>
        editGuardian(tx, actor, found, req.body),
      );
    },
  );

  app.post(
    '/guardians/:id/revoke',
    {
      config: { dynamicPermission: true },
      schema: {
        description: 'Take someone off the pickup list (R-91): revoked and audited, never deleted. Revoking again answers the first.',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const found = await loadGuardianForPickups(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:guardian_manage', { branchId: found.registration.branchId });
      const actor = actorOf(req, await stationAtBranch(app.db, auth.stationId, found.registration.branchId));
      return withTx(app.db, { ...opCtx(req), branchId: found.registration.branchId }, 'guardian.revoke', (tx) =>
        revokeGuardian(tx, actor, found),
      );
    },
  );

  app.get(
    '/stays/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          "What the release modal shows: the child, the pickup list, the stored sign-up photo's file id, the prepaid food reconciliation in satang and the branch's policy, and the release once there is one",
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const stay = await loadStayForRelease(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:read', { branchId: stay.branchId });
      return releaseContextOf(app.db, stay);
    },
  );

  app.post(
    '/stays/:id/release',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Release a child (R-92, enforced here): the collector is the dropper-off, a listed and unrevoked person, or someone added on the spot with name and photo; ' +
          'the live pickup photo is mandatory; the verifier is the signed-in account. The stay goes out (the nanny is freed), unused prepaid food is refunded ' +
          'against the linked sale by the branch policy or recorded refund_no_sale, and release.create is audited with the station. ' +
          'Client-minted id (OD-12): the same id again answers with the release under x-oto-replay.',
        params: z.object({ id: z.string().uuid() }),
        body: CreateReleaseSchema,
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const stay = await loadStayForRelease(app.db, auth.operatorId, req.params.id);
      await req.requirePermission('pos:checkin:release', { branchId: stay.branchId });
      const stationId =
        (await stationAtBranch(app.db, req.body.stationId, stay.branchId)) ??
        (await stationAtBranch(app.db, auth.stationId, stay.branchId));
      const actor = actorOf(req, stationId);
      const claim = await claimClientId(
        req.body.id,
        async (id) => (await app.db.select().from(release).where(eq(release.id, id)).limit(1))[0],
        (row) => row.operatorId === auth.operatorId && row.checkinId === stay.id,
      );
      if (claim.replay) {
        reply.header(REPLAY_HEADER, 'true');
        return { replay: true, release: await releaseViewOf(app.db, claim.row) };
      }
      const result = await withTx(app.db, { ...opCtx(req), branchId: stay.branchId }, 'release.create', (tx) =>
        releaseChild(tx, actor, stay.id, { ...req.body, id: claim.id }),
      );
      if (result.replay) reply.header(REPLAY_HEADER, 'true');
      const refund = result.refund?.refund;
      if (refund?.tenderAllocation.some((s) => s.route === 'gateway_refund' && s.status === 'pending')) {
        // After the commit, as the refund route does: a call to the gateway
        // never holds the sale's row lock.
        await settleGatewayRefunds(app.db, opCtx(req), refund.id, gatewayFor(app.env, req.log).qr);
      }
      return { replay: result.replay, release: result.release };
    },
  );
}
