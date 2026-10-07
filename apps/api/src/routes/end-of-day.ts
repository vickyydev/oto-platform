import { z } from 'zod';
import {
  CashMovementAnswerSchema,
  CashMovementBodySchema,
  CashMovementsAnswerSchema,
  CashMovementsQuerySchema,
  EndOfDayCloseBodySchema,
  EndOfDayQuerySchema,
  EndOfDayRecordSchema,
  EndOfDayReprintBodySchema,
  StrandedResolveAnswerSchema,
  StrandedResolveBodySchema,
} from '@oto/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import {
  closeEndOfDay,
  getEndOfDay,
  listCashMovements,
  recordMovement,
  reprintEndOfDayReceipt,
  resolveStranded,
  type CashActor,
} from '../services/end-of-day';
import { hasPermission } from '../services/permissions';
import { opCtx, withTx } from '../services/tx';

/**
 * S2-15a round 1 — the End of Day and the cash taken out of the drawers
 * (plan docs/progress/plans/cash/PLAN.md, revised 2 Oct).
 *
 * Branch-scoped, all of them: the guard checks the permission against the
 * branch in the path, and the service loads that branch inside the caller's
 * operator before anything is read or written. The writes are one
 * transaction each, audited, and behind the global idempotency key: the same
 * key and body replay the first answer, the same key with another body is 409.
 */

const BranchParams = z.object({ branchId: z.string().uuid() });

function actorOf(req: FastifyRequest): CashActor {
  const auth = req.requireAuth();
  return { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id, stationId: auth.stationId };
}

/** The actor, and whether it holds `pos:cash:approve` at this branch (a manager's override). */
async function closerOf(req: FastifyRequest, branchId: string): Promise<CashActor> {
  const actor = actorOf(req);
  const effective = await req.effectivePermissions();
  return { ...actor, canApprove: hasPermission(effective, 'pos:cash:approve', { operatorId: actor.operatorId, branchId }) };
}

export async function endOfDayRoutes(app: App): Promise<void> {
  app.get(
    '/branches/:branchId/end-of-day',
    {
      config: { permission: 'pos:cash:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "One business day's End of Day for the branch. A closed day is answered exactly as it was saved (read-only); " +
          'an open one is worked out fresh from the records: the expected side per channel — cash (every station, one ' +
          'combined count, less the day’s paid-outs and safe drops), PromptPay / QR, a card line per terminal TID, card ' +
          'money with no TID, other tenders, e-wallet, bank transfer, party prepayments and credit — net of refunds on ' +
          "their original sale's day, with the float carried from the latest earlier close or the standard ฿6,000. " +
          'An open day also lists the boxes that keep it provisional (undelivered records, an unmeasured clock) and ' +
          'who is still counted inside; a closed day carries any manager override and its End of Day receipt. 503 ' +
          '(`EVENTS_SEAM_NOT_GRANTED`, `EVENTS_SEAM_MISSING`) when an open day has party money and the OTO App events ' +
          'seam cannot be read to work out which day each party is held on — never a party prepayment line of ฿0.',
        params: BranchParams,
        querystring: EndOfDayQuerySchema,
        response: { 200: EndOfDayRecordSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return getEndOfDay(app.db, auth.operatorId, req.params.branchId, req.query.date, new Date());
    },
  );

  app.post(
    '/branches/:branchId/end-of-day/close',
    {
      config: { permission: 'pos:cash:day_close', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Close Day: lock the branch’s business day. Only what staff entered is read — the actual per channel, the ' +
          'counted cash, the float left for tomorrow, the voucher counts and the notes; the expected side and the ' +
          'totals are worked out again here. Allowed with lines off or not entered, and without notes. 409 when the day ' +
          'is already closed (reload it to see the locked record), while any box keeps it provisional, and while ' +
          'anybody is still counted inside unless `override.reason` is given by a holder of pos:cash:approve (403 for ' +
          'anybody else; audited end_of_day.override). The End of Day receipt is numbered on the series of the ' +
          'counter this session took and queued on its receipt printer. With no counter taken, or a counter without ' +
          'a box or a receipt series, the day still closes and its receipt waits: the closed day says so, and a ' +
          'reprint from a counter numbers and prints it. A counter of another branch is refused (404). 503 as the read ' +
          'is when the day has party money and the events seam cannot be read: nothing is closed.',
        params: BranchParams,
        body: EndOfDayCloseBodySchema,
        response: { 200: EndOfDayRecordSchema },
      },
    },
    async (req) => {
      const actor = await closerOf(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'end_of_day.close', (tx) =>
        closeEndOfDay(tx, actor, req.params.branchId, req.body, new Date()),
      );
    },
  );

  app.post(
    '/branches/:branchId/end-of-day/stranded/resolve',
    {
      config: { permission: 'pos:cash:day_close', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Clear one row still counted inside at close — a band whose last passage was an entry, or a child still ' +
          'checked in — with the reason (left without scanning, band lost, gate fault); who did it is recorded from ' +
          'the session and the resolution is audited gate.manual_resolution. The row leaves the count from now on; ' +
          'the gate journal, the check-in and the count before now are kept. Answers the list as it now stands. 409 ' +
          'when the day is closed or the row is no longer counted inside.',
        params: BranchParams,
        body: StrandedResolveBodySchema,
        response: { 200: StrandedResolveAnswerSchema },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      return withTx(app.db, opCtx(req), 'gate.manual_resolution', (tx) =>
        resolveStranded(tx, actor, req.params.branchId, req.body, new Date()),
      );
    },
  );

  app.post(
    '/branches/:branchId/end-of-day/reprint',
    {
      config: { permission: 'pos:cash:day_close', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "Print a closed day's End of Day receipt again at the counter this session took, " +
          'as a copy of the original carrying the figures exactly as they were locked. A day closed without a ' +
          'receipt is numbered here, on this counter’s series, and printed as its first receipt. Answers the closed ' +
          'day. 409 when the day is not closed or the counter cannot print.',
        params: BranchParams,
        body: EndOfDayReprintBodySchema,
        response: { 200: EndOfDayRecordSchema },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      return withTx(app.db, opCtx(req), 'print_job.reprint', (tx) =>
        reprintEndOfDayReceipt(tx, actor, req.params.branchId, req.body, new Date()),
      );
    },
  );

  app.get(
    '/branches/:branchId/cash-movements',
    {
      config: { permission: 'pos:cash:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "The paid-outs and safe drops of one business day at the branch (today's when no date is given), and the " +
          'people who can be named as the second person on the next one — whether each can approve a paid-out.',
        params: BranchParams,
        querystring: CashMovementsQuerySchema,
        response: { 200: CashMovementsAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return listCashMovements(app.db, auth.operatorId, req.params.branchId, req.query.date);
    },
  );

  app.post(
    '/branches/:branchId/cash-movements',
    {
      config: { permission: 'pos:cash:movement', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "Record cash taken out of the branch's drawers today: a paid-out, approved by somebody else holding " +
          'pos:cash:approve at the branch, or a safe drop, witnessed by somebody else at the branch. Either reduces the ' +
          'cash the day’s count expects. 409 once the day is closed.',
        params: BranchParams,
        body: CashMovementBodySchema,
        response: { 200: CashMovementAnswerSchema },
      },
    },
    async (req) => {
      const actor = actorOf(req);
      return withTx(app.db, opCtx(req), `cash_movement.${req.body.kind}`, (tx) =>
        recordMovement(tx, actor, req.params.branchId, req.body, new Date()),
      );
    },
  );
}
