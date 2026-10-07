import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  EventDetailAnswerSchema,
  PartyChargeBodySchema,
  PartyPatchBodySchema,
  PartyPaymentBodySchema,
  PartyQuerySchema,
  PartyWriteAnswerSchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { chargeParty, getParty, payParty, updateParty } from '../services/parties';
import { queueDrawerKick } from '../services/payments/drawer';
import type { ActorContext } from '../services/sale';
import { opCtx } from '../services/tx';

/**
 * S2-20 E4 — THE PARTY TAB (SCRUM-217; plan
 * docs/progress/plans/events-kiosk/PLAN.md §3, §8, §10 and the E4 row of §9).
 *
 * A party is an OTO App event (C10); these are the POS's actions on it, the
 * ports of `updateParty`, `addPartyExtraCharge` and `addPartyPayment`:
 *
 *   GET   /parties/:id            the party, its bill, its ledgers, the edit stamp
 *   PATCH /parties/:id            edit its own fields — written back to the OTO App
 *   POST  /parties/:id/charges    extra tickets or F&B on the tab — a ledger entry, not a sale
 *   POST  /parties/:id/payments   money against the balance — a real tender, not a sale of goods
 *
 * Branch-scoped like every events route: the permission is checked at the
 * branch the till names, and the service loads that branch inside the
 * caller's operator before the OTO App's views are asked. Every write is keyed
 * by the id the till minted, so the same id again answers what it made
 * (under `x-oto-replay`) and writes nothing.
 */

const PartyParams = z.object({ id: z.string().uuid() });

/** The acting account, with the scope check for the branch the write turns out to be for. */
function actorOf(req: FastifyRequest, permission: Permission): ActorContext {
  const auth = req.requireAuth();
  return {
    accountId: auth.accountId,
    operatorId: auth.operatorId,
    branchId: auth.branchId,
    requestId: req.id,
    assertBranchAllowed: async (branchId: string) => {
      await req.requirePermission(permission, { branchId });
    },
  };
}

/** The press: the body's action id, else the header's. */
function actionIdOf(req: FastifyRequest, bodyActionId: string | undefined): string | undefined {
  const header = req.headers['x-oto-action-id'];
  return bodyActionId ?? (typeof header === 'string' && header.length <= 200 ? header : undefined);
}

export async function partyRoutes(app: App): Promise<void> {
  const deps = (req: FastifyRequest) => ({ db: app.db, directory: app.otoAppDirectory, log: req.log });

  app.get(
    '/:id',
    {
      config: { permission: 'pos:event:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          "One of the branch's parties: the OTO App's booking and bill, laid under the edits a till made that the app " +
          "has not taken yet, with the tab's POS ledgers — the walk-ups, the charges and the payments — the till's " +
          'edit stamp and the bill (total = base + charges; outstanding = total − deposit − payments, never below ' +
          'zero). 404 for anything that is not one of the branch\'s parties.',
        params: PartyParams,
        querystring: PartyQuerySchema,
        response: { 200: EventDetailAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return getParty(app.db, {
        operatorId: auth.operatorId,
        branchId: req.query.branchId,
        partyId: req.params.id,
        date: req.query.date,
        now: new Date(),
      });
    },
  );

  app.patch(
    '/:id',
    {
      config: {
        permission: 'pos:party:update',
        target: { branchId: 'body.branchId' },
        stationTrading: true,
      },
      schema: {
        description:
          "Edit a party's own fields (`updateParty`) — those the OTO App's record holds: title, status, date, times, " +
          'room, headcount, child, parent and WhatsApp, decoration, activities, base price, deposit and its date. Its ' +
          'id, its branch, its charges and its payments are protected and never change here: a body carrying them, or ' +
          'a field the app has no home for, is saved without them and the answer names them (`edit.ignored`). The edit ' +
          'is stamped with who and when, committed, then written back to the OTO App under the till\'s `editId` ' +
          '(`edit.syncState`); a write the app has not taken is retried from Failures. The same edit id again answers ' +
          'what it made, under x-oto-replay.',
        params: PartyParams,
        body: PartyPatchBodySchema,
        response: { 200: PartyWriteAnswerSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:party:update');
      const answer = await updateParty(deps(req), opCtx(req), actor, req.params.id, {
        ...req.body,
        actionId: actionIdOf(req, req.body.actionId),
      });
      if (answer.replayed) reply.header('x-oto-replay', 'true');
      return answer;
    },
  );

  app.post(
    '/:id/charges',
    {
      config: {
        permission: 'pos:party:charge',
        target: { branchId: 'body.branchId' },
        stationTrading: true,
      },
      schema: {
        description:
          "Charge extra tickets or F&B to a party's tab (`addPartyExtraCharge`): a ledger entry of the till's items " +
          'and its total, clamped at ฿0. Not a sale — no receipt, no kitchen ticket, no stock movement, no bands — so ' +
          "the money reaches the books only when the party's balance is paid. The same charge id again answers what " +
          'it made, under x-oto-replay.',
        params: PartyParams,
        body: PartyChargeBodySchema,
        response: { 200: PartyWriteAnswerSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:party:charge');
      const answer = await chargeParty(deps(req), opCtx(req), actor, req.params.id, {
        ...req.body,
        actionId: actionIdOf(req, req.body.actionId),
      });
      if (answer.replayed) reply.header('x-oto-replay', 'true');
      return answer;
    },
  );

  app.post(
    '/:id/payments',
    {
      config: {
        permission: 'pos:party:payment',
        target: { branchId: 'body.branchId' },
        stationTrading: true,
      },
      schema: {
        description:
          "Take money against a party's balance (`addPartyPayment`): whole baht, capped at what is outstanding, " +
          'refused when nothing is. Recorded through the tender machine as a real tender at the counter (a cash ' +
          'one opens the drawer) with no sale behind it — not a sale of goods — and counted by End of Day on the ' +
          "party prepayments line on the day it is taken, for that day's party, never on the cash, card or QR line. " +
          'A balance that moved since the till showed it (`expectedOutstandingSatang`) is refused 409 ' +
          'PARTY_BALANCE_CHANGED with nothing taken. The same payment id again answers what it took, under ' +
          'x-oto-replay, and takes nothing.',
        params: PartyParams,
        body: PartyPaymentBodySchema,
        response: { 200: PartyWriteAnswerSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:party:payment');
      const { answer, drawerKick } = await payParty(deps(req), opCtx(req), actor, req.params.id, {
        ...req.body,
        actionId: actionIdOf(req, req.body.actionId),
      });
      // Cash in the till opens the till, once the money is committed (S2-10a O-4).
      if (drawerKick) await queueDrawerKick(app.db, opCtx(req), actor, drawerKick);
      if (answer.replayed) reply.header('x-oto-replay', 'true');
      return answer;
    },
  );
}
