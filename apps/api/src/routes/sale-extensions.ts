import { z } from 'zod';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { opCtx, withTx } from '../services/tx';
import { createSaleExtension, readSaleExtensions } from '../services/sale-extensions';

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  actionId: z.string().min(1).max(160), stationId: z.string().uuid(), optionId: z.string().min(1).max(40),
  selection: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('bands'), bandIds: z.array(z.string().uuid()).min(1).max(500) }),
    z.object({ mode: z.literal('count'), braceletCount: z.number().int().min(1).max(500) }),
  ]),
});

export async function saleExtensionRoutes(app: App) {
  app.get('/sales/:id/extensions', { config: { permission: 'pos:sale:read' }, schema: { params: Params } }, async (req) => {
    const auth = req.requireAuth();
    return readSaleExtensions(app.db, { ...auth, requestId: req.id,
      assertBranchAllowed: async (branchId) => { await req.requirePermission('pos:sale:read', { branchId }); } }, req.params.id);
  });
  app.post('/sales/:id/extensions', { config: { permission: 'pos:sale:create', stationTrading: true }, schema: { params: Params, body: Body } }, async (req) => {
    const auth = req.requireAuth();
    if (auth.stationId !== req.body.stationId) throw errors.conflict('EXTENSION_COUNTER_REQUIRED', 'Choose this counter before taking an extra-time payment.');
    return withTx(app.db, opCtx(req), 'sale.extension.create', (tx) => createSaleExtension(tx,
      { ...auth, requestId: req.id, assertBranchAllowed: async (branchId) => { await req.requirePermission('pos:sale:create', { branchId }); } }, req.params.id, req.body));
  });
}
