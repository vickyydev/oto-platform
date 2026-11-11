import {
  PartyDepositActionAnswerSchema,
  PartyDepositActionBodySchema,
  PartyDepositAnswerSchema,
  PartyDepositParamsSchema,
  PartyDepositRequestBodySchema,
  PartyDepositRequestParamsSchema,
  PartyMenuLinkBodySchema,
  PartyMenuReceivedBodySchema,
  PartyMessageAnswerSchema,
} from '@oto/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { otoAppProvisionerOf } from '../plugins/credential';
import {
  cancelPartyDeposit,
  partyDepositOf,
  postPartyMenuLink,
  postPartyMenuReceived,
  requestPartyDeposit,
  resendPartyDeposit,
} from '../services/party-deposit';
import { opCtx } from '../services/tx';

/**
 * SCRUM-825 — the OTO App's doors for a party's deposit request, the parent's
 * set-menu link and their choices. The home is the BEO's Billing section; the
 * platform mints the gateway link, has the assistant post it, watches the
 * payment and writes the deposit back (`services/party-deposit.ts`).
 *
 * Their caller is the app's SERVER, with its provisioning key (`credential:
 * 'otoapp-provision'`, SCRUM-539's key, as SCRUM-822's and SCRUM-828's doors):
 * the operator is the key's, and an event at none of its branches is 404.
 * Every write takes the app's Idempotency-Key and honours it in the service
 * rather than the replay store (a service key is not a session): the
 * request's id, and each posted line's id, is derived from the key, so the
 * same press is the same request and the same line, never a second.
 */
export async function otoAppPartyDepositRoutes(app: App): Promise<void> {
  const keyOf = (req: FastifyRequest): string => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
      throw errors.badRequest('An Idempotency-Key is required');
    }
    return key;
  };

  app.get(
    '/parties/:eventId/deposit-request',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          "OTO App server only (provisioning key): a party's deposit requests as the platform holds them — the open one (else the newest) and every one, each with its state (requested, paid, expired, cancelled), the payment link and its validity, when it was reminded, handed over or paid, the deposit figure it set and the write-back's state; and whether the party is linked to an inbox conversation the assistant can post in. Read only.",
        params: PartyDepositParamsSchema,
        response: { 200: PartyDepositAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      return partyDepositOf(app.db, { operatorId, eventId: req.params.eventId });
    },
  );

  app.post(
    '/parties/:eventId/deposit-request',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          'OTO App server only (provisioning key): "Request deposit" from the BEO. Mints a gateway payment link for the amount (a station-less invoice on the WEB segment, the hosted page valid PARTY_DEPOSIT_LINK_VALIDITY_MIN), records the request, and has the inbox assistant post ONE message in the family\'s linked conversation — the amount, the party\'s date, the link and its validity, in the family\'s language — with a "deposit requested" pill. Idempotent on the Idempotency-Key the app sends: the same key answers the same request; a different body under it is refused 409. One open request per party (409 DEPOSIT_REQUEST_OPEN); a party with no linked conversation is refused (409 PARTY_NO_CONVERSATION).',
        params: PartyDepositParamsSchema,
        body: PartyDepositRequestBodySchema,
        response: { 200: PartyDepositActionAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      return requestPartyDeposit(app.db, app.env, req.log, opCtx(req), {
        operatorId,
        eventId: req.params.eventId,
        amountSatang: req.body.amountSatang,
        idempotencyKey: keyOf(req),
        actorAppUserId: req.body.actorAppUserId,
        conversationId: req.body.conversationId ?? null,
      });
    },
  );

  app.post(
    '/parties/:eventId/deposit-request/:requestId/resend',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          'OTO App server only (provisioning key): "Resend" — the open request\'s link posted again by the assistant, ONE line per Idempotency-Key. Refused 409 for a request that is no longer open, or whose link has run out (press Request deposit for a fresh one).',
        params: PartyDepositRequestParamsSchema,
        body: PartyDepositActionBodySchema,
        response: { 200: PartyDepositActionAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      return resendPartyDeposit(app.db, req.log, opCtx(req), {
        operatorId,
        eventId: req.params.eventId,
        requestId: req.params.requestId,
        idempotencyKey: keyOf(req),
        actorAppUserId: req.body.actorAppUserId,
      });
    },
  );

  app.post(
    '/parties/:eventId/deposit-request/:requestId/cancel',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          'OTO App server only (provisioning key): "Cancel request" — the open request closed cancelled, its gateway attempt closed with it (the gateway told, best effort), a "deposit cancelled" pill on the thread; nothing is said to the family. Cancelling twice is the same act.',
        params: PartyDepositRequestParamsSchema,
        body: PartyDepositActionBodySchema,
        response: { 200: PartyDepositActionAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      return cancelPartyDeposit(app.db, app.env, req.log, opCtx(req), {
        operatorId,
        eventId: req.params.eventId,
        requestId: req.params.requestId,
        idempotencyKey: keyOf(req),
        actorAppUserId: req.body.actorAppUserId,
      });
    },
  );

  app.post(
    '/parties/:eventId/menu-link',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          "OTO App server only (provisioning key): \"Send the menu choice link\" from the BEO — the parent's set-menu selection link posted by the inbox assistant in the family's linked conversation, with the right words in their language, and a \"menu link sent\" pill. ONE line per Idempotency-Key.",
        params: PartyDepositParamsSchema,
        body: PartyMenuLinkBodySchema,
        response: { 200: PartyMessageAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      return postPartyMenuLink(app.db, req.log, opCtx(req), {
        operatorId,
        eventId: req.params.eventId,
        link: req.body.link,
        idempotencyKey: keyOf(req),
        actorAppUserId: req.body.actorAppUserId,
      });
    },
  );

  app.post(
    '/parties/:eventId/menu-received',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          "OTO App server only (provisioning key): the parent's menu choices landed in the app — the inbox assistant confirms them in the family's linked conversation, with a \"menu choices received\" pill. ONE line per Idempotency-Key (the app keys it by the submission).",
        params: PartyDepositParamsSchema,
        body: PartyMenuReceivedBodySchema,
        response: { 200: PartyMessageAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      return postPartyMenuReceived(app.db, req.log, opCtx(req), {
        operatorId,
        eventId: req.params.eventId,
        idempotencyKey: keyOf(req),
        submittedAt: req.body.submittedAt ?? null,
      });
    },
  );
}
