import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { branch, wallet } from '@oto/db';
import {
  BandScanQuerySchema,
  WalletLookupQuerySchema,
  WalletReactivateBodySchema,
  WalletReportQuerySchema,
  type BandStayView,
} from '@oto/shared';
import { bandStayViewOf, stayForKey } from '../services/band-food';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { hasPermission } from '../services/permissions';
import { opCtx, withTx } from '../services/tx';
import {
  creditRedeemedOn,
  ledgerOf,
  reactivateWallet,
  walletFor,
  walletPolicyViewOf,
  walletReportOf,
  walletViewOf,
} from '../services/wallet';

/**
 * S2-14a — reading a wallet (round 1) and the round-3 surfaces (plan
 * docs/progress/plans/wallet/PLAN.md §2.1, §2.5). Registered under `/wallets`.
 *
 * The Wallet view: scan or type a key — a band's signed code or its short
 * code, a voucher's `QR-…` — and get the wallet it names, its balance, status,
 * expiry and its ledger; or open a wallet by id. Both behind
 * `pos:wallet:read` at the session's park. Identity is operator-wide; the
 * issuing park does not restrict spending or counter lookup.
 *
 * Round 3 adds: bringing expired credit back (`POST /:id/reactivate`, behind
 * `pos:wallet:reactivate` at the wallet's park, with a typed reason, audited),
 * the branch's wallet rules (`GET /policy`), the Wallet & Promo report's
 * credit half (`GET /report`, `analytics:read`) and the End of day `credit`
 * line (`GET /credit-day`).
 *
 * Credit is granted by closing a sale and loaded by checking a child in;
 * spending is the sale's wallet tender; expiry is the day-end job
 * (`services/wallet.ts`).
 */

const notFound = () =>
  new AppError(404, 'WALLET_NOT_FOUND', 'No wallet carries that band or voucher — check the code and scan again.');

async function assertWalletBranch(req: FastifyRequest, branchId: string | null): Promise<void> {
  if (!branchId) return;
  try {
    await req.requirePermission('pos:wallet:read', { branchId });
  } catch {
    throw notFound();
  }
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function walletRoutes(app: App): Promise<void> {
  app.get(
    '/lookup',
    {
      config: { permission: 'pos:wallet:read' },
      schema: {
        description:
          'The wallet a scanned or typed key names — a band (full or short code) or a voucher QR — with its balance, ' +
          'status, credit expiry, its keys (a band by its short code only) and its ledger, oldest first. 404 when no wallet of this operator carries it.',
        querystring: WalletLookupQuerySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const found = await walletFor(app.db, auth.operatorId, req.query.key);
      if (!found) throw notFound();
      return {
        wallet: await walletViewOf(app.db, found),
        ledger: await ledgerOf(app.db, auth.operatorId, found.id),
      };
    },
  );

  /**
   * SCRUM-494 — THE F&B AND SHOP COUNTERS' SCAN. The wallet the key names, as
   * `/lookup` answers it, and beside it the child's stay the band belongs to at
   * this park, in the park: the allergy and medical alert, the food
   * restrictions, whether the parent authorised food and the food they prepaid
   * — what the design's band carried (`types.ts:Wristband`). Either may be
   * absent; 404 only when the key names neither. The stay is read with
   * `pos:checkin:read` at the park and left out for an account without it.
   */
  app.get(
    '/scan',
    {
      config: { permission: 'pos:wallet:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          'The counter’s band scan: the wallet a key names (balance, keys, ledger) and the child’s in-park stay at this ' +
          'park behind the band — allergies/medical, food restrictions, mayOrderFood and the prepaid food with each ' +
          'prepaid item’s served count. Either half may be null; 404 when the key names neither.',
        querystring: BandScanQuerySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const branchId = req.query.branchId ?? auth.branchId ?? null;
      const found = await walletFor(app.db, auth.operatorId, req.query.key);
      let stay: BandStayView | null = null;
      if (branchId) {
        const allowed = await req
          .requirePermission('pos:checkin:read', { branchId })
          .then(() => true)
          .catch(() => false);
        const row = allowed ? await stayForKey(app.db, auth.operatorId, branchId, req.query.key, found?.id ?? null) : null;
        stay = row ? await bandStayViewOf(app.db, row) : null;
      }
      if (!found && !stay) throw notFound();
      return {
        wallet: found ? await walletViewOf(app.db, found) : null,
        ledger: found ? await ledgerOf(app.db, auth.operatorId, found.id) : [],
        stay,
      };
    },
  );

  app.get(
    '/policy',
    {
      config: { permission: 'pos:wallet:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          "The branch's wallet rules: when credit expires (same_day | days_n | never), the offline cap per wallet per day, " +
          'and what happens to a child’s unused prepaid food. The seeded defaults when the branch has no row.',
        querystring: z.object({ branchId: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [br] = await app.db
        .select({ id: branch.id })
        .from(branch)
        .where(and(eq(branch.id, req.query.branchId), eq(branch.operatorId, auth.operatorId)))
        .limit(1);
      if (!br) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
      return walletPolicyViewOf(app.db, br.id);
    },
  );

  app.get(
    '/report',
    {
      config: { permission: 'analytics:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          'The Wallet & Promo report’s credit half: granted / spent / refunded back / expired / reactivated over the ' +
          'business dates from..to, the outstanding snapshot (sum of live balances, not date-ranged) beside the ' +
          'ledger’s own sum of it, and the newest ledger rows. Without branchId: every park this account reads reports for.',
        querystring: WalletReportQuerySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const { branchId, from, to, limit } = req.query;
      if (from > to) throw new AppError(400, 'BAD_REQUEST', 'The report’s start date is after its end date.');
      let branchIds: string[];
      if (branchId) {
        branchIds = [branchId];
      } else {
        // Every park of the operator this account holds the report for — an
        // account scoped to one park sees that park, never the network.
        const effective = await req.effectivePermissions();
        const parks = await app.db
          .select({ id: branch.id })
          .from(branch)
          .where(and(eq(branch.operatorId, auth.operatorId), isNull(branch.archivedAt)));
        branchIds = parks
          .filter((p) => hasPermission(effective, 'analytics:read', { operatorId: auth.operatorId, branchId: p.id }))
          .map((p) => p.id);
      }
      return walletReportOf(app.db, auth.operatorId, { branchIds, from, to, limit });
    },
  );

  app.get(
    '/credit-day',
    {
      config: { permission: 'pos:wallet:read', target: { branchId: 'query.branchId' } },
      schema: {
        description:
          'The End of day `credit` line: wallet credit redeemed at the F&B and shop counters on the business date, ' +
          'net of what refunds put back through those spends.',
        querystring: z.object({ branchId: z.string().uuid(), date: DATE }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return creditRedeemedOn(app.db, auth.operatorId, req.query.branchId, req.query.date);
    },
  );

  app.get(
    '/:id',
    {
      config: { permission: 'pos:wallet:read' },
      schema: {
        description: 'One operator wallet by id: its balance, keys and ledger, readable from the current park.',
        params: z.object({ id: z.string().uuid() }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [found] = await app.db
        .select()
        .from(wallet)
        .where(and(eq(wallet.id, req.params.id), eq(wallet.operatorId, auth.operatorId)))
        .limit(1);
      if (!found) throw notFound();
      return {
        wallet: await walletViewOf(app.db, found),
        ledger: await ledgerOf(app.db, auth.operatorId, found.id),
      };
    },
  );

  app.post(
    '/:id/reactivate',
    {
      config: { permission: 'pos:wallet:reactivate' },
      schema: {
        description:
          'Bring expired credit back: exactly the remainder the last expiry took, as its own `reactivate` entry with a ' +
          'fresh expiry from today’s policy. Needs pos:wallet:reactivate at the wallet’s park and a typed reason; audited ' +
          'with before/after. 409 when the credit has not expired or ran out before it did.',
        params: z.object({ id: z.string().uuid() }),
        body: WalletReactivateBodySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const [found] = await app.db
        .select()
        .from(wallet)
        .where(and(eq(wallet.id, req.params.id), eq(wallet.operatorId, auth.operatorId)))
        .limit(1);
      if (!found) throw notFound();
      // A park this session cannot read answers as nothing; one it reads but
      // may not reactivate at answers 403, naming the permission.
      await assertWalletBranch(req, found.branchId);
      if (found.branchId) await req.requirePermission('pos:wallet:reactivate', { branchId: found.branchId });
      const written = await withTx(app.db, opCtx(req), 'wallet.reactivate', (tx) =>
        reactivateWallet(
          tx,
          { accountId: auth.accountId, operatorId: auth.operatorId, requestId: req.id },
          { walletId: found.id, reason: req.body.reason, stationId: auth.stationId ?? null },
        ),
      );
      return {
        replayed: written.replayed,
        wallet: await walletViewOf(app.db, written.wallet),
        ledger: await ledgerOf(app.db, auth.operatorId, found.id),
      };
    },
  );
}
