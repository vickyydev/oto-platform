import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { opCtx, withTx } from '../services/tx';
import {
  holdVoucher,
  loadRedemptionStation,
  lookupVoucher,
  prepareHold,
  releaseVoucher,
  type RedemptionActor,
  type RedemptionStation,
} from '../services/vouchers';

/**
 * S2-10b (SCRUM-207) — a voucher at the counter.
 *
 *   GET    /vouchers/lookup?code=          what is this voucher? Consumes nothing.
 *   POST   /sales/:id/vouchers             put it on the cart the till is ringing up.
 *   DELETE /sales/:id/vouchers/:voucherId  take it off again.
 *
 * Using it up is not a route: it happens inside the transaction that closes
 * the sale (`finaliseSale`, and the ฿0 close in `commitSale`), so a voucher is
 * redeemed exactly when the money is in and never on its own.
 *
 * WHO AND WHERE. Every route acts at the till THIS SESSION is standing at
 * (`PUT /me/session/station`) — never at a station the request names, because
 * the guessing limit is per till and a till chosen by the caller is a limit the
 * caller resets. `pos:voucher:redeem` is checked at that till's branch, and the
 * three routes share it: there is no read-only voucher permission, and a look-up
 * is the first half of a redemption, not a report.
 *
 * `:id` is the sale id the till minted for its cart — the same one it sends to
 * `POST /sales` — so it usually names no row yet. See `holdVoucher`.
 */

const SaleParams = z.object({ id: z.string().uuid() });
const ReleaseParams = z.object({ id: z.string().uuid(), voucherId: z.string().uuid() });
/** What a scanner or a person types. Normalised and checked by the service, never trusted. */
const Code = z.string().min(1).max(64);

export async function voucherRoutes(app: App): Promise<void> {
  /** The till, the permission at its branch, and who is asking — in that order. */
  const standing = async (
    req: FastifyRequest,
  ): Promise<{ actor: RedemptionActor; at: RedemptionStation }> => {
    const auth = req.requireAuth();
    const at = await loadRedemptionStation(app.db, auth.operatorId, auth.stationId);
    await req.requirePermission('pos:voucher:redeem', { branchId: at.branchId });
    return {
      actor: { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id },
      at,
    };
  };

  app.get(
    '/vouchers/lookup',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'What a scanned or typed voucher code is and what it is worth here, or why it cannot be ' +
          'used: Invalid code, not synced yet, already redeemed (who, when, where), expired, in use ' +
          'at another till. Consumes nothing. A wrong code counts towards the till’s guessing limit.',
        querystring: z.object({ code: Code }),
      },
    },
    async (req) => {
      const { actor, at } = await standing(req);
      return lookupVoucher(app.db, actor, at, req.query.code);
    },
  );

  app.post(
    '/sales/:id/vouchers',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Hold a voucher for the sale this till is ringing up (the till’s own sale id, usually ' +
          'before Pay). Answers what it is worth; the sale is priced with it when its code is on ' +
          'the cart, and it is used up when the sale is paid. One voucher per sale.',
        params: SaleParams,
        body: z.object({ code: Code }),
      },
    },
    async (req) => {
      const { actor, at } = await standing(req);
      const now = new Date();
      // The code check and its miss are committed on their own, before the
      // hold's transaction: a refusal must still count against the till.
      const { voucherId, legacyFormat } = await prepareHold(app.db, actor, at, req.body.code, now);
      return withTx(app.db, opCtx(req), 'voucher.hold', (tx) =>
        holdVoucher(tx, actor, at, req.params.id, voucherId, legacyFormat, now),
      );
    },
  );

  app.delete(
    '/sales/:id/vouchers/:voucherId',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Take a voucher off a cart that has not been rung up yet. Answers released: false when ' +
          'it is no longer held for that sale. A sale already rung up is voided instead, which ' +
          'releases its voucher.',
        params: ReleaseParams,
      },
    },
    async (req) => {
      const { actor, at } = await standing(req);
      return withTx(app.db, opCtx(req), 'voucher.release', (tx) =>
        releaseVoucher(tx, actor, at, req.params.id, req.params.voucherId),
      );
    },
  );
}
