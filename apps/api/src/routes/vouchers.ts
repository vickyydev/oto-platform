import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { branch } from '@oto/db';
import {
  PromoVoucherReportQuerySchema,
  PromoVoucherReportSchema,
  VoucherCampaignBodySchema,
  VoucherIssueBodySchema,
} from '@oto/shared';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { loadBranchForOperator } from '../services/fleet';
import { hasPermission } from '../services/permissions';
import { opCtx, withTx } from '../services/tx';
import {
  campaignCodesCsv,
  issuableDefinitionsAt,
  issueVoucherAtTill,
  listVoucherCampaigns,
  mintVoucherCampaign,
  printVoucherCredit,
  promoVoucherReportOf,
  voucherCreditOf,
} from '../services/voucher-promotions';
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

/**
 * What a till says when a voucher is tried on a station that is offline. The
 * generic forced-offline sentence talks about taking payment, which a voucher
 * look-up is not; this is the same voice as the refund path's own wording, and
 * it is spoken here — platform-side — so every till says it identically. The
 * refusal keeps the `STATION_FORCED_OFFLINE` code (the lane arbiter reads it);
 * only the sentence changes (offline finding 6).
 */
const VOUCHER_OFFLINE_MESSAGE =
  'Online only — a voucher is checked by the platform, so redeem it when the station is back online.';

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
  stationId: z.union([z.string().uuid(), z.literal('counter')]).optional(),
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
          'Every voucher issued at a branch, whatever made it — a booth spin, a counter issue, the import of the old system’s codes — newest first and paged: when, its type and the prize it was won as, what it hands over (and, once used, what the till took off for it), the booth or counter, who was signed in (null: unattributed), the last four characters of its code and never the whole code, its status, and where, when, by whom and on which sale it was redeemed. Filtered by trading day (from, to — today when absent, at most 366 days), voucher type, booth, who issued it and status. Status is read from the whole row: redeemed, void, held on a till’s cart, expired once its date has passed, printed once paper exists, issued otherwise. `totals` has one line per voucher type over all filters: issued, redeemed, the redemption rate, expired, and the money the tills took off for the redeemed ones.',
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
      config: {
        dynamicPermission: true,
        stationTrading: true,
        stationOfflineMessage: VOUCHER_OFFLINE_MESSAGE,
      },
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
      config: {
        dynamicPermission: true,
        stationTrading: true,
        stationOfflineMessage: VOUCHER_OFFLINE_MESSAGE,
      },
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

  // --- S2-14a round 5: promotional vouchers ----------------------------------

  app.get(
    '/vouchers/issuable',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'What the till this session stands at may issue today: the operator’s switched-on, unarchived voucher ' +
          'definitions whose promotion has not ended on the branch’s trading day, with their window, global limit ' +
          'and how many are used. Needs pos:print:voucher at the till’s branch.',
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const at = await loadRedemptionStation(app.db, auth.operatorId, auth.stationId);
      await req.requirePermission('pos:print:voucher', { branchId: at.branchId });
      return issuableDefinitionsAt(app.db, auth.operatorId, at.branchId);
    },
  );

  app.post(
    '/vouchers/issue',
    {
      config: {
        dynamicPermission: true,
        stationTrading: true,
        stationOfflineMessage: VOUCHER_OFFLINE_MESSAGE,
      },
      schema: {
        description:
          'Issue one voucher of a definition at the till this session stands at, and print it on the till’s receipt ' +
          'printer as a voucher slip. The code is minted on the platform on the till’s prefix (the booth scheme, with ' +
          'its check character), recorded as issued by the person at the till, and audited. `print.status` is queued, ' +
          'skipped (no receipt printer at this till) or none (no box). Refused for a switched-off or archived ' +
          'definition, and for a promotion that has ended. Needs pos:print:voucher at the till’s branch.',
        body: VoucherIssueBodySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const at = await loadRedemptionStation(app.db, auth.operatorId, auth.stationId);
      await req.requirePermission('pos:print:voucher', { branchId: at.branchId });
      return withTx(app.db, opCtx(req), 'voucher.issue', (tx) =>
        issueVoucherAtTill(
          tx,
          { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id },
          at,
          req.body,
        ),
      );
    },
  );

  app.get(
    '/vouchers/:id/credit',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The wallet a wallet-credit voucher loaded when the sale carrying it closed: its balance, keys, expiry and ' +
          'its ONE voucher QR. `wallet` is null while the voucher has loaded nothing. Read at the till this session ' +
          'stands at, with pos:voucher:redeem there; a wallet another park issued answers 404.',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const { actor, at } = await standing(req);
      const credit = await voucherCreditOf(app.db, actor.operatorId, req.params.id);
      if (credit.wallet?.branchId && credit.wallet.branchId !== at.branchId) {
        return { voucherId: req.params.id, wallet: null, qrCode: null };
      }
      return credit;
    },
  );

  app.post(
    '/vouchers/:id/credit/print',
    {
      config: {
        dynamicPermission: true,
        stationTrading: true,
        stationOfflineMessage: VOUCHER_OFFLINE_MESSAGE,
      },
      schema: {
        description:
          'Print the credit voucher for the wallet a wallet-credit voucher loaded, on the till’s receipt printer ' +
          '(the landed credit voucher, its QR and the credit). 409 VOUCHER_CREDIT_NOT_LOADED before the sale ' +
          'carrying the voucher has closed. Needs pos:print:voucher at the till’s branch; audited.',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const at = await loadRedemptionStation(app.db, auth.operatorId, auth.stationId);
      await req.requirePermission('pos:print:voucher', { branchId: at.branchId });
      return withTx(app.db, opCtx(req), 'voucher.credit_print', (tx) =>
        printVoucherCredit(
          tx,
          { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id },
          at,
          req.params.id,
        ),
      );
    },
  );

  app.get(
    '/vouchers/promotions/report',
    {
      config: { permission: 'analytics:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          'Foregone revenue from promotional vouchers — its own line, separate from manual discounts and promo codes: ' +
          'per voucher definition, the vouchers used up on a sale whose trading day is in from..to, and what those ' +
          'sales did not charge for them (each voucher’s own discount row, the engine’s figure). A wallet-credit ' +
          'voucher’s loaded credit is reported beside it (stored value, owed until spent or expired), never in it. ' +
          'Without branchId: every park this account reads reports for.',
        querystring: PromoVoucherReportQuerySchema,
        response: { 200: PromoVoucherReportSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { branchId, from, to } = req.query;
      if (from > to) throw new AppError(400, 'BAD_REQUEST', 'The report’s start date is after its end date.');
      let branchIds: string[];
      if (branchId) {
        const br = await loadBranchForOperator(app.db, auth.operatorId, branchId);
        branchIds = [br.id];
      } else {
        // Every park of the operator this account holds the report for, as the
        // wallet report reads it — an account scoped to one park sees that park.
        const effective = await req.effectivePermissions();
        const parks = await app.db
          .select({ id: branch.id })
          .from(branch)
          .where(and(eq(branch.operatorId, auth.operatorId), isNull(branch.archivedAt)));
        branchIds = parks
          .filter((p) =>
            hasPermission(effective, 'analytics:read', { operatorId: auth.operatorId, branchId: p.id }),
          )
          .map((p) => p.id);
      }
      return promoVoucherReportOf(app.db, auth.operatorId, { branchIds, from, to });
    },
  );

  app.get(
    '/voucher-campaigns',
    {
      config: { permission: 'admin:booth:read' },
      schema: {
        description:
          'The operator’s voucher campaigns, newest first: name, definition, branch, how many codes were minted and ' +
          'how many have been used. Never the codes — those are read through the export.',
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return listVoucherCampaigns(app.db, auth.operatorId);
    },
  );

  app.post(
    '/voucher-campaigns',
    {
      config: { permission: 'admin:booth:manage', target: { branchId: 'body.branchId' } },
      schema: {
        description:
          'Mint a campaign: a batch of codes of one definition, issued at one branch in one transaction, every code ' +
          'unique (the booth scheme on the campaign prefix, with its check character). The campaign row and one ' +
          'audit row record the batch; the answer never carries the codes (each is a bearer credential) — read them ' +
          'with GET /voucher-campaigns/:id/codes. Refused for a switched-off definition and an ended promotion.',
        body: VoucherCampaignBodySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return withTx(app.db, opCtx(req), 'voucher_campaign.create', (tx) =>
        mintVoucherCampaign(
          tx,
          { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id },
          req.body,
        ),
      );
    },
  );

  app.get(
    '/voucher-campaigns/:id/codes',
    {
      config: { permission: 'admin:booth:manage' },
      schema: {
        description:
          'A campaign’s codes as a CSV file — code, status, expiry — for the manager to hand out. The one place the ' +
          'whole codes are given; never cached.',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const { filename, csv } = await campaignCodesCsv(app.db, auth.operatorId, req.params.id);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .header('cache-control', 'no-store')
        .send(csv);
    },
  );

  app.delete(
    '/sales/:id/vouchers/:voucherId',
    {
      config: {
        dynamicPermission: true,
        stationTrading: true,
        stationOfflineMessage: VOUCHER_OFFLINE_MESSAGE,
      },
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
