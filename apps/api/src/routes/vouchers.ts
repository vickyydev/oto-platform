import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { loadBranchForOperator } from '../services/fleet';
import { opCtx, withTx } from '../services/tx';
import {
  VOUCHER_LEDGER_STATUSES,
  listVoucherLedger,
  voucherLedgerCsv,
} from '../services/voucher-ledger';
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
 *
 * THE CONSOLE'S LEDGER (owner, 28 September) is the other pair here:
 *
 *   GET    /vouchers?branchId=…          every voucher issued at a branch, paged, with totals per type.
 *   GET    /vouchers/export?branchId=…   the same filters, every row, as a CSV file.
 *
 * Reads, guarded like the voucher types they list — `admin:booth:read` — and
 * scoped to the branch in the query, which is loaded inside the caller's
 * operator before anything is read. What each column means is in
 * `services/voucher-ledger.ts`.
 */

const SaleParams = z.object({ id: z.string().uuid() });

/** A trading day, as the ledger filters on it. */
const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');

/** What the ledger and its download are filtered by. Every filter but the branch is optional. */
const LedgerQuery = z.object({
  branchId: z.string().uuid(),
  /** Trading days, inclusive; absent is today at the branch. At most 366 days. */
  from: IsoDay.optional(),
  to: IsoDay.optional(),
  /** A voucher type. */
  definitionId: z.string().uuid().optional(),
  /** The booth whose spins minted them. */
  stationId: z.string().uuid().optional(),
  /** Who was signed in when it was issued, or `unattributed`. */
  issuedBy: z.union([z.string().uuid(), z.literal('unattributed')]).optional(),
  status: z.enum(VOUCHER_LEDGER_STATUSES).optional(),
});

const LedgerPersonSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().nullable(),
  code: z.string(),
});

const LedgerResponse = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  total: z.number().int(),
  rows: z.array(
    z.object({
      id: z.string().uuid(),
      issuedAt: z.string(),
      businessDate: z.string(),
      type: z.object({
        id: z.string().uuid(),
        code: z.string(),
        nameEn: z.string(),
        nameTh: z.string().nullable(),
        kind: z.string(),
      }),
      prize: z.object({ id: z.string().uuid(), nameEn: z.string() }).nullable(),
      value: z.object({
        kind: z.enum(['money', 'percent', 'item', 'ticket', 'gift']),
        text: z.string(),
        redeemedSatang: z.number().int().nullable(),
      }),
      place: z.object({
        kind: z.enum(['booth', 'counter', 'import']),
        stationId: z.string().uuid().nullable(),
        name: z.string(),
      }),
      issuedBy: LedgerPersonSchema.nullable(),
      codeLast4: z.string(),
      source: z.string(),
      status: z.enum(VOUCHER_LEDGER_STATUSES),
      printCount: z.number().int(),
      expiresAt: z.string().nullable(),
      redeemed: z
        .object({
          at: z.string(),
          branchName: z.string().nullable(),
          stationName: z.string().nullable(),
          by: LedgerPersonSchema.nullable(),
          saleId: z.string().uuid().nullable(),
          receiptNumber: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  totals: z.array(
    z.object({
      type: z.object({
        id: z.string().uuid(),
        code: z.string(),
        nameEn: z.string(),
        kind: z.string(),
      }),
      valueKind: z.enum(['money', 'percent', 'item', 'ticket', 'gift']),
      issued: z.number().int(),
      redeemed: z.number().int(),
      redemptionRate: z.number().nullable(),
      expired: z.number().int(),
      handedOverSatang: z.number().int(),
    }),
  ),
});
const ReleaseParams = z.object({ id: z.string().uuid(), voucherId: z.string().uuid() });
/** What a scanner or a person types. Normalised and checked by the service, never trusted. */
const Code = z.string().min(1).max(64);

export async function voucherRoutes(app: App): Promise<void> {
  // --- The Console's ledger (owner, 28 September) ---------------------------

  app.get(
    '/vouchers',
    {
      config: { permission: 'admin:booth:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          'Every voucher issued at a branch, whatever made it — a booth spin, a counter issue, the import of the old system’s codes — newest first and paged: when, its type and the prize it was won as, what it hands over (and, once used, what the till took off for it), the booth or counter, who was signed in (null: unattributed), the last four characters of its code and never the whole code, its status, and where, when, by whom and on which sale it was redeemed. Filtered by trading day (from, to — today when absent, at most 366 days), voucher type, booth, who issued it and status. Status is read from the whole row: redeemed, void, held on a till’s cart, expired once its date has passed, printed once paper exists, issued otherwise. `totals` has one line per voucher type over every filter but status: issued, redeemed, the redemption rate, expired, and the money the tills took off for the redeemed ones.',
        querystring: LedgerQuery.extend({
          limit: z.coerce.number().int().min(1).max(200).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: LedgerResponse },
      },
    },
    /**
     * The guard checks the permission at the branch the query names; the
     * branch is then LOADED inside the caller's operator, because a grant at
     * operator scope says yes to any branch id (SCRUM-267).
     */
    async (req) => {
      const auth = req.requireAuth();
      const { branchId, limit, offset, ...filters } = req.query;
      const br = await loadBranchForOperator(app.db, auth.operatorId, branchId);
      return listVoucherLedger(app.db, auth.operatorId, br, filters, { limit, offset });
    },
  );

  app.get(
    '/vouchers/export',
    {
      config: { permission: 'admin:booth:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          'The voucher ledger as a CSV file: the same filters as `GET /vouchers`, every row rather than a page, times on the branch’s clock, amounts in baht, and the code as its last four characters.',
        querystring: LedgerQuery,
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const { branchId, ...filters } = req.query;
      const br = await loadBranchForOperator(app.db, auth.operatorId, branchId);
      const { filename, csv } = await voucherLedgerCsv(app.db, auth.operatorId, br, filters);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'no-store')
        .send(csv);
    },
  );

  // --- A voucher at the counter (S2-10b) -------------------------------------

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
