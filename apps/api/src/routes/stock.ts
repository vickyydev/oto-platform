import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { branch } from '@oto/db';
import {
  SellableStockSchema,
  StockLevelsSchema,
  StockLocationsSchema,
  StockMovementsSchema,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { hasPermission } from '../services/permissions';
import { branchLocations, movementsOf, sellableStock, stockLevelsOf } from '../services/stock';

/**
 * S2-14b round 1 — the stock READ routes: what the till's grids, size pickers
 * and guard read, and the levels and ledger the stock screens build on (plan
 * docs/progress/plans/stock/PLAN.md §2.2). Every write to stock in this round
 * happens inside a sale, a refund or a product's link (`services/stock.ts`);
 * the stock module's own writes — transfers, receiving, orders, counts — are
 * round 2.
 *
 * Branch-scoped, all of them: a branch's stock is that park's shelves, and the
 * branch in the path is checked against the caller's operator before anything
 * is read (the door `routes/menu.ts` opens with, SCRUM-290).
 */

const BranchParams = z.object({ branchId: z.string().uuid() });

async function loadStockBranch(app: App, branchId: string, operatorId: string) {
  const [row] = await app.db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('Branch not found');
  return row;
}

/**
 * Whether this caller is answered the cost per each: a manager's figure, held
 * with `pos:stock:order` at the branch (`StockPlaceViewSchema`'s note). The
 * counter reads the same levels and ledger without it.
 */
async function seesCost(
  req: { effectivePermissions: () => Promise<Parameters<typeof hasPermission>[0]> },
  operatorId: string,
  branchId: string,
): Promise<boolean> {
  return hasPermission(await req.effectivePermissions(), 'pos:stock:order', { operatorId, branchId });
}

export async function stockRoutes(app: App): Promise<void> {
  app.get(
    '/branches/:branchId/stock/sellable',
    {
      config: { permission: 'pos:stock:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Every stock-tracked product at the branch, each size with what the branch holds of it — the till reads this',
        params: BranchParams,
        response: { 200: SellableStockSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      return sellableStock(app.db, auth.operatorId, req.params.branchId);
    },
  );

  app.get(
    '/branches/:branchId/stock/levels',
    {
      config: { permission: 'pos:stock:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "The branch's stock items, with what each place holds and the item's settings. Cost per each only to a manager",
        params: BranchParams,
        response: { 200: StockLevelsSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      const withCost = await seesCost(req, auth.operatorId, req.params.branchId);
      return stockLevelsOf(app.db, auth.operatorId, req.params.branchId, { withCost });
    },
  );

  app.get(
    '/branches/:branchId/stock/locations',
    {
      config: { permission: 'pos:stock:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: "The branch's live stock places, in the order a sale takes from them",
        params: BranchParams,
        response: { 200: StockLocationsSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      const rows = await branchLocations(app.db, req.params.branchId);
      return {
        locations: rows.map((l) => ({ id: l.id, name: l.name, type: l.type, sellPoint: l.sellPoint, active: l.active })),
      };
    },
  );

  app.get(
    '/branches/:branchId/stock/movements',
    {
      config: { permission: 'pos:stock:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "The branch's stock ledger, newest first — for one item or one sale when asked. Cost per each only to a manager",
        params: BranchParams,
        querystring: z.object({
          stockItemId: z.string().uuid().optional(),
          saleId: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
        response: { 200: StockMovementsSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      const withCost = await seesCost(req, auth.operatorId, req.params.branchId);
      const movements = await movementsOf(app.db, auth.operatorId, req.params.branchId, req.query, { withCost });
      return { movements };
    },
  );
}
