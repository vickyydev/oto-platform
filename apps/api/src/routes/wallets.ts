import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { wallet } from '@oto/db';
import { WalletLookupQuerySchema } from '@oto/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { ledgerOf, walletFor, walletViewOf } from '../services/wallet';

/**
 * S2-14a round 1 — reading a wallet (plan docs/progress/plans/wallet/PLAN.md
 * §2.1, §2.5). Registered under `/wallets`.
 *
 * What the round-3 Wallet view builds on: scan or type a key — a band's
 * signed code or its short code, a voucher's `QR-…` — and get the wallet it
 * names, its balance and its ledger; or open a wallet by id. Both behind
 * `pos:wallet:read`, at the session's park and again at the park that issued
 * the wallet: a wallet at another park is answered exactly like a key that
 * names nothing, so a scan cannot be used to learn that one exists.
 *
 * Nothing here writes. Credit is granted by closing a sale and loaded by
 * checking a child in (`services/wallet.ts`); spending is round 2's tender.
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

export async function walletRoutes(app: App): Promise<void> {
  app.get(
    '/lookup',
    {
      config: { permission: 'pos:wallet:read' },
      schema: {
        description:
          'The wallet a scanned or typed key names — a band (full or short code) or a voucher QR — with its balance, ' +
          'its keys (a band by its short code only) and its ledger, oldest first. 404 when nothing at this park carries it.',
        querystring: WalletLookupQuerySchema,
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const found = await walletFor(app.db, auth.operatorId, req.query.key);
      if (!found) throw notFound();
      await assertWalletBranch(req, found.branchId);
      return {
        wallet: await walletViewOf(app.db, found),
        ledger: await ledgerOf(app.db, auth.operatorId, found.id),
      };
    },
  );

  app.get(
    '/:id',
    {
      config: { permission: 'pos:wallet:read' },
      schema: {
        description: "One wallet by id: its balance, keys and ledger. 404 for a wallet at a park this session cannot read.",
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
      await assertWalletBranch(req, found.branchId);
      return {
        wallet: await walletViewOf(app.db, found),
        ledger: await ledgerOf(app.db, auth.operatorId, found.id),
      };
    },
  );
}
