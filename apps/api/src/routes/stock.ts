import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { branch } from '@oto/db';
import {
  PurchaseOrderAddBodySchema,
  PurchaseOrderAnswerSchema,
  PurchaseOrderLineQuantityBodySchema,
  PurchaseOrderMarkOrderedBodySchema,
  PurchaseOrderReceiveBodySchema,
  PurchaseOrderReceiveResultSchema,
  PurchaseOrdersSchema,
  SellableStockSchema,
  StockAdjustBodySchema,
  StockAdjustResultSchema,
  StockAttentionsSchema,
  StockItemBodySchema,
  StockItemResultSchema,
  StockLevelsSchema,
  StockLocationBodySchema,
  StockLocationPatchSchema,
  StockLocationsSchema,
  StockLocationViewSchema,
  StockMovementsSchema,
  StockPlaceOpeningsSchema,
  StockCostOfGoodsSchema,
  StockReceiveBodySchema,
  StockReceiveResultSchema,
  StockReportQuerySchema,
  StockReportsSchema,
  StockTakeBodySchema,
  StockTakeResultSchema,
  StockTransferBodySchema,
  StockTransferResultSchema,
} from '@oto/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { hasPermission } from '../services/permissions';
import {
  addToPurchaseOrders,
  adjustStock,
  commitStockTake,
  createLocation,
  listLocations,
  listPurchaseOrders,
  listStockAttention,
  markPurchaseOrderOrdered,
  movementsOf,
  receivePurchaseOrderLine,
  receiveStock,
  removePurchaseOrderLine,
  resolveStockAttention,
  saveStockItem,
  sellableStock,
  setPurchaseOrderLineQuantity,
  setSellPoint,
  stockCostOfGoods,
  stockLevelsOf,
  stockPlaceOpenings,
  stockReports,
  transferStock,
  updateLocation,
  type StockActor,
} from '../services/stock';
import { opCtx, withTx } from '../services/tx';

/**
 * S2-14b — the stock routes (plan docs/progress/plans/stock/PLAN.md §2.2-§2.3).
 *
 * Round 1 opened the READS: what the till's grids, size pickers and guard read,
 * and the levels and ledger the stock screens build on. Round 2 adds the stock
 * module's own WRITES — transfers, deliveries, purchase orders, counts, the
 * manager's corrections and setup — each one transaction through
 * `services/stock.ts`, audited, and behind the global idempotency key.
 *
 * WHO MAY DO WHAT (OD-S4, rule R-76): every member of staff moves stock between
 * shelves, takes a delivery and counts (`pos:stock:transfer`,
 * `pos:stock:receive`, `pos:stock:count`); purchase orders are a manager's
 * (`pos:stock:order`), and so is setup — items, sizes, packs, places — and a
 * correction outside a count (`pos:stock:adjust`, which only managers hold).
 *
 * Branch-scoped, all of them: a branch's stock is that park's shelves, and the
 * branch in the path is checked against the caller's operator before anything
 * is read or written (the door `routes/menu.ts` opens with, SCRUM-290).
 */

const BranchParams = z.object({ branchId: z.string().uuid() });
const OrderParams = BranchParams.extend({ orderId: z.string().uuid() });
const OrderLineParams = OrderParams.extend({ lineId: z.string().uuid() });
const LocationParams = BranchParams.extend({ locationId: z.string().uuid() });
const ItemParams = BranchParams.extend({ groupId: z.string().uuid() });
const AttentionParams = BranchParams.extend({ attentionId: z.string().uuid() });
const Ok = z.object({ ok: z.literal(true) });

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
  /** The caller, at the branch in the path — checked to be theirs first. */
  async function actorFor(req: FastifyRequest, branchId: string): Promise<StockActor> {
    const auth = req.requireAuth();
    await loadStockBranch(app, branchId, auth.operatorId);
    return {
      operatorId: auth.operatorId,
      branchId,
      accountId: auth.accountId,
      requestId: req.id,
      stationId: auth.stationId ?? null,
    };
  }

  // --- Reads (round 1) -----------------------------------------------------------------

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
        description:
          "The branch's live stock places, in the order a sale takes from them — every place, retired ones too, with all=true",
        params: BranchParams,
        querystring: z.object({ all: z.enum(['true', 'false']).optional() }),
        response: { 200: StockLocationsSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      return {
        locations: await listLocations(app.db, req.params.branchId, { includeRetired: req.query.all === 'true' }),
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

  // --- Reports from the ledger (round 4, plan §2.5) ----------------------------------------

  app.get(
    '/branches/:branchId/stock/reports',
    {
      config: { permission: 'pos:stock:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "The stock module's reports over business dates, each from the ledger: discrepancies (counts), usage (sales net of refunds), shrinkage (count variances and corrections down), purchases (orders and their receipts) and value (on hand × cost, no cost flagged). Cost figures only to a manager",
        params: BranchParams,
        querystring: StockReportQuerySchema,
        response: { 200: StockReportsSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      const withCost = await seesCost(req, auth.operatorId, req.params.branchId);
      return stockReports(app.db, {
        operatorId: auth.operatorId,
        branchId: req.params.branchId,
        from: req.query.from,
        to: req.query.to,
        withCost,
      });
    },
  );

  app.get(
    '/branches/:branchId/stock/reports/cost-of-goods',
    {
      config: { permission: 'analytics:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Cost of goods per product over business dates: units sold net of refunds at the cost frozen on each sale line — the profitability report reads this',
        params: BranchParams,
        querystring: StockReportQuerySchema,
        response: { 200: StockCostOfGoodsSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      return stockCostOfGoods(app.db, {
        operatorId: auth.operatorId,
        branchId: req.params.branchId,
        from: req.query.from,
        to: req.query.to,
      });
    },
  );

  // --- Moving stock (all staff, OD-S4) ----------------------------------------------------

  app.post(
    '/branches/:branchId/stock/transfers',
    {
      config: { permission: 'pos:stock:transfer', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Move stock between two places of the branch. Each line clamps to what the source holds; the answer says what moved',
        params: BranchParams,
        body: StockTransferBodySchema,
        response: { 200: StockTransferResultSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock.transfer', (tx) => transferStock(tx, actor, req.body, new Date()));
    },
  );

  app.post(
    '/branches/:branchId/stock/receipts',
    {
      config: { permission: 'pos:stock:receive', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Take a delivery that came with no purchase order onto a shelf. A reason is required',
        params: BranchParams,
        body: StockReceiveBodySchema,
        response: { 200: StockReceiveResultSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock.receive', (tx) => receiveStock(tx, actor, req.body, new Date()));
    },
  );

  app.get(
    '/branches/:branchId/stock/openings',
    {
      config: { permission: 'pos:stock:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "Whether each of the branch's places has had its opening count yet — a place's first count is its opening: it sets the starting figures and flags nothing. The count's review screen asks before committing",
        params: BranchParams,
        response: { 200: StockPlaceOpeningsSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      return { places: await stockPlaceOpenings(app.db, auth.operatorId, req.params.branchId) };
    },
  );

  app.post(
    '/branches/:branchId/stock/stock-takes',
    {
      config: { permission: 'pos:stock:count', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "Commit a count: each counted shelf is set to what was counted, a difference above three is flagged, all of it audited. Each place's first count is that place's opening, and is never flagged",
        params: BranchParams,
        body: StockTakeBodySchema,
        response: { 200: StockTakeResultSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock.count', (tx) => commitStockTake(tx, actor, req.body, new Date()));
    },
  );

  // --- Purchase orders (a manager's; receiving against one is everyone's) -----------------

  app.get(
    '/branches/:branchId/stock/purchase-orders',
    {
      config: { permission: 'pos:stock:read', target: { branchId: 'params.branchId' } },
      schema: {
        description: "The branch's purchase orders, newest first, with their lines",
        params: BranchParams,
        response: { 200: PurchaseOrdersSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      return { orders: await listPurchaseOrders(app.db, auth.operatorId, req.params.branchId) };
    },
  );

  app.post(
    '/branches/:branchId/stock/purchase-orders/lines',
    {
      config: { permission: 'pos:stock:order', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "Put sizes on each supplier's open order (created when there is none); a size already on it has its quantity added",
        params: BranchParams,
        body: PurchaseOrderAddBodySchema,
        response: { 200: PurchaseOrdersSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'purchase_order.add_lines', async (tx) => ({
        orders: await addToPurchaseOrders(tx, actor, req.body, new Date()),
      }));
    },
  );

  app.patch(
    '/branches/:branchId/stock/purchase-orders/:orderId/lines/:lineId',
    {
      config: { permission: 'pos:stock:order', target: { branchId: 'params.branchId' } },
      schema: {
        description: "Change a line's quantity while the order is still to be placed — one each at least",
        params: OrderLineParams,
        body: PurchaseOrderLineQuantityBodySchema,
        response: { 200: PurchaseOrderAnswerSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'purchase_order.line_update', async (tx) => ({
        order: await setPurchaseOrderLineQuantity(tx, actor, req.params.orderId, req.params.lineId, req.body.quantity, new Date()),
      }));
    },
  );

  app.delete(
    '/branches/:branchId/stock/purchase-orders/:orderId/lines/:lineId',
    {
      config: { permission: 'pos:stock:order', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Take a line off an order still to be placed; removing the last line deletes the order (answers null)',
        params: OrderLineParams,
        response: { 200: PurchaseOrderAnswerSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'purchase_order.line_remove', async (tx) => ({
        order: await removePurchaseOrderLine(tx, actor, req.params.orderId, req.params.lineId, new Date()),
      }));
    },
  );

  app.post(
    '/branches/:branchId/stock/purchase-orders/:orderId/ordered',
    {
      config: { permission: 'pos:stock:order', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Mark the order placed with the supplier, with its expected arrival (default: today + the largest lead time)',
        params: OrderParams,
        body: PurchaseOrderMarkOrderedBodySchema,
        response: { 200: PurchaseOrderAnswerSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'purchase_order.ordered', async (tx) => ({
        order: await markPurchaseOrderOrdered(tx, actor, req.params.orderId, req.body, new Date()),
      }));
    },
  );

  app.post(
    '/branches/:branchId/stock/purchase-orders/:orderId/lines/:lineId/receive',
    {
      config: { permission: 'pos:stock:receive', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Receive against an order line into the place chosen, clamped to what is outstanding; the order closes when every line is in',
        params: OrderLineParams,
        body: PurchaseOrderReceiveBodySchema,
        response: { 200: PurchaseOrderReceiveResultSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'purchase_order.receive', (tx) =>
        receivePurchaseOrderLine(tx, actor, req.params.orderId, req.params.lineId, req.body, new Date()),
      );
    },
  );

  // --- A manager's correction and setup ----------------------------------------------------

  app.post(
    '/branches/:branchId/stock/adjustments',
    {
      config: { permission: 'pos:stock:adjust', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "A manager's correction with a reason — shrinkage, damage, staff use. Never past what the branch holds",
        params: BranchParams,
        body: StockAdjustBodySchema,
        response: { 200: StockAdjustResultSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock.adjust', (tx) => adjustStock(tx, actor, req.body, new Date()));
    },
  );

  app.post(
    '/branches/:branchId/stock/locations',
    {
      config: { permission: 'pos:stock:adjust', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'A new stock place. A FOH rotation place becomes the sell point when the branch has none',
        params: BranchParams,
        body: StockLocationBodySchema,
        response: { 200: StockLocationViewSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock_location.create', (tx) => createLocation(tx, actor, req.body, new Date()));
    },
  );

  app.patch(
    '/branches/:branchId/stock/locations/:locationId',
    {
      config: { permission: 'pos:stock:adjust', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Rename, retype, retire or reactivate a place. The sell point can be neither retired nor retyped',
        params: LocationParams,
        body: StockLocationPatchSchema,
        response: { 200: StockLocationViewSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock_location.update', (tx) =>
        updateLocation(tx, actor, req.params.locationId, req.body, new Date()),
      );
    },
  );

  app.post(
    '/branches/:branchId/stock/locations/:locationId/sell-point',
    {
      config: { permission: 'pos:stock:adjust', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Make an active FOH rotation place the sell point — the one place a sale takes from first',
        params: LocationParams,
        response: { 200: StockLocationViewSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock_location.sell_point', (tx) =>
        setSellPoint(tx, actor, req.params.locationId, new Date()),
      );
    },
  );

  app.post(
    '/branches/:branchId/stock/items',
    {
      config: { permission: 'pos:stock:adjust', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'A new stocked item with its sizes, packs, pars and reorder settings, linked to what it stocks. Starting stock is recorded as an audited movement at the sell point',
        params: BranchParams,
        body: StockItemBodySchema,
        response: { 200: StockItemResultSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock_item.create', (tx) => saveStockItem(tx, actor, null, req.body, new Date()));
    },
  );

  app.put(
    '/branches/:branchId/stock/items/:groupId',
    {
      config: { permission: 'pos:stock:adjust', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          'Replace a stocked item’s settings and sizes. A size that still holds stock at any place (a retired one included) or is outstanding on an open purchase order cannot be removed; a sized product links all its sizes or none',
        params: ItemParams,
        body: StockItemBodySchema,
        response: { 200: StockItemResultSchema },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock_item.update', (tx) =>
        saveStockItem(tx, actor, req.params.groupId, req.body, new Date()),
      );
    },
  );

  // --- Attention --------------------------------------------------------------------------

  app.get(
    '/branches/:branchId/stock/attention',
    {
      config: { permission: 'pos:stock:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "What about the branch's stock needs a person: low stock with the rule that fired (quiet while an order covers it), and paid sales the record could not fill",
        params: BranchParams,
        response: { 200: StockAttentionsSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      await loadStockBranch(app, req.params.branchId, auth.operatorId);
      // A READ, and nothing but (round 4, handover Q4): the rows are kept up
      // to date where stock moves — every stock write, a sale's decrement and a
      // refund's restock (`syncStockAttention`) — and by the daily stock job as
      // the usage window slides (`runStockDailyJob`).
      return { attention: await listStockAttention(app.db, auth.operatorId, req.params.branchId) };
    },
  );

  app.post(
    '/branches/:branchId/stock/attention/:attentionId/resolve',
    {
      config: { permission: 'pos:stock:count', target: { branchId: 'params.branchId' } },
      schema: {
        description: 'Close one stock alert once somebody has looked. A low-stock rule still firing raises a fresh one',
        params: AttentionParams,
        response: { 200: Ok },
      },
    },
    async (req) => {
      const actor = await actorFor(req, req.params.branchId);
      return withTx(app.db, opCtx(req), 'stock_attention.resolve', async (tx) => {
        await resolveStockAttention(tx, actor, req.params.attentionId, new Date());
        return { ok: true as const };
      });
    },
  );
}
