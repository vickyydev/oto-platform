import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import {
  PartyChargeBodySchema,
  PartyDetailAnswerSchema,
  PartyPatchBodySchema,
  PartyPaymentBodySchema,
  PartyQuerySchema,
  PartySettleAnswerSchema,
  PartySettleBodySchema,
  PartySettlePreviewAnswerSchema,
  PartySettlePreviewBodySchema,
  PartyTenderBodySchema,
  PartyWriteAnswerSchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { chargeParty, getParty, payParty, startPartyTender, updateParty } from '../services/parties';
import { readPartyPlan } from '../services/party-plan';
import { previewPartySettlement, settleParty } from '../services/party-settlement';
import { queueDrawerKick } from '../services/payments/drawer';
import type { ActorContext } from '../services/sale';
import { AttemptSchema } from './payments';
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
function actorOf(req: FastifyRequest, permission: Permission, ...also: Permission[]): ActorContext {
  const auth = req.requireAuth();
  return {
    accountId: auth.accountId,
    operatorId: auth.operatorId,
    branchId: auth.branchId,
    requestId: req.id,
    assertBranchAllowed: async (branchId: string) => {
      await req.requirePermission(permission, { branchId });
      for (const more of also) await req.requirePermission(more, { branchId });
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
          'zero). 404 for anything that is not one of the branch\'s parties. SCRUM-804 — with the plan the OTO App ' +
          'published for it (`plan`: the package with its limits and prices, the counts, the add-ons, the ' +
          'entertainment, the set menu, the food times and the deposit, money in satang), or null and the reason ' +
          '(`planStatus`); and its settlement sale (`event.party.settlement`): while the package and its deposit ' +
          'are that sale\'s, the bill is the tab\'s own charges and payments.',
        params: PartyParams,
        querystring: PartyQuerySchema,
        response: { 200: PartyDetailAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const answer = await getParty(app.db, {
        operatorId: auth.operatorId,
        branchId: req.query.branchId,
        partyId: req.params.id,
        date: req.query.date,
        now: new Date(),
      });
      const { plan, status } = await readPartyPlan(app.db, { branchId: req.query.branchId, eventId: answer.event.id });
      return { ...answer, plan, planStatus: status };
    },
  );

  app.post(
    '/:id/settle/preview',
    {
      config: { permission: 'pos:party:charge', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'SCRUM-804 — what settling a party as one sale comes to with these counts: the package at its own price ' +
          "for the party's date, the children and adults beyond its included counts at its own extra prices, the " +
          "socks beyond its free pairs, and the plan's add-ons and entertainment kept, priced by the sale engine " +
          'exactly as the settlement will be, with the F&B credit the add-ons grant, the deposit recorded as paid ' +
          'in advance and the balance. Writes nothing. 409 PARTY_NO_PACKAGE for a party the OTO App has no package ' +
          'for, and the refusals a settlement makes for counts it cannot price.',
        params: PartyParams,
        body: PartySettlePreviewBodySchema,
        response: { 200: PartySettlePreviewAnswerSchema },
      },
    },
    async (req) => {
      const actor = actorOf(req, 'pos:party:charge');
      return previewPartySettlement({ db: app.db, log: req.log }, actor, req.params.id, req.body);
    },
  );

  app.post(
    '/:id/settle',
    {
      config: {
        permission: 'pos:sale:create',
        target: { branchId: 'body.branchId' },
        stationTrading: true,
      },
      schema: {
        description:
          "SCRUM-804 — settle a party as ONE sale from the OTO App's plan: the package fee, the included items as " +
          '0-baht lines, the children and adults on admission lines (a band prints for each at the close), the free ' +
          'and sold socks (taken off the Regular Socks shelf), the add-ons and entertainment kept (an F&B credit ' +
          'add-on grants its credit and prints its voucher at the close), and the deposit recorded on the sale as ' +
          '"Deposit (paid in advance)". The sale is left at the payment stage for the balance (POST ' +
          '/sales/:id/finalise and the tender routes, as any sale); a deposit that covers it all closes it here. ' +
          'When it closes, the sale id is written back to the OTO App through the party edit path. Refused 409 ' +
          'PARTY_ALREADY_SETTLED while an earlier settlement sale is open or paid (void or refund it first), 409 ' +
          'PARTY_PAID_ON_TAB when the tab already took money for the package, and as the preview refuses. The same ' +
          'settlement id again answers what it made, under x-oto-replay.',
        params: PartyParams,
        body: PartySettleBodySchema,
        response: { 200: PartySettleAnswerSchema },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:sale:create', 'pos:party:charge');
      const actionId = actionIdOf(req, req.body.actionId);
      const answer = await settleParty(
        { db: app.db, directory: app.otoAppDirectory, log: req.log },
        opCtx(req),
        actor,
        req.params.id,
        { ...req.body, ...(actionId ? { actionId } : {}) },
      );
      if (answer.replayed) reply.header('x-oto-replay', 'true');
      return answer;
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
          'PARTY_BALANCE_CHANGED with nothing taken. This call counts as confirmation that the money was taken, so a ' +
          'QR, or a card with no approval code off its slip, is refused 409 PARTY_TENDER_ROUTED: those go by ' +
          '/payments/tender. The same payment id again answers what it took, under x-oto-replay, and takes nothing; ' +
          'one whose tender has not been paid is refused 409 PARTY_PAYMENT_NOT_TAKEN.',
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

  app.post(
    '/:id/payments/tender',
    {
      config: {
        permission: 'pos:party:payment',
        target: { branchId: 'body.branchId' },
        stationTrading: true,
      },
      schema: {
        description:
          "Take money against a party's balance by a tender that answers later, routed by the station as a sale's " +
          'tender is: a QR through the gateway or the terminal, a card on the terminal. The answer is the attempt the ' +
          'till then polls on GET /payments/attempts/:id, with the QR to show. Nothing is on the bill until the attempt ' +
          'is paid; meanwhile what it asked for is reserved, and another payment over the rest of the balance is ' +
          'refused 409 PAYMENT_IN_FLIGHT. A station that keys cards in by hand answers route `manual` and opens ' +
          'nothing. The same payment id again answers the same tender. Once it is paid, POST /parties/:id/payments ' +
          'under the same payment id answers what it took.',
        params: PartyParams,
        body: PartyTenderBodySchema,
        response: {
          200: z.object({
            route: z.enum(['card_terminal', 'manual', 'gateway']),
            attempt: AttemptSchema.nullable(),
            replayed: z.boolean(),
            outstandingSatang: z.number().int(),
            qrPayload: z.string().nullable(),
            qrImageUrl: z.string().nullable(),
            expiresAt: z.string().nullable(),
            expiryTimerMs: z.number().int().nullable(),
          }),
        },
      },
    },
    async (req, reply) => {
      const actor = actorOf(req, 'pos:party:payment');
      const answer = await startPartyTender(
        { ...deps(req), env: app.env, log: req.log },
        opCtx(req),
        actor,
        req.params.id,
        { ...req.body, actionId: actionIdOf(req, req.body.actionId) },
      );
      if (answer.replayed) reply.header('x-oto-replay', 'true');
      return answer;
    },
  );
}
