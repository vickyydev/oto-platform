import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { opCtx, withTx } from '../services/tx';
import { createSaleExtension, readSaleExtensions, reselectExtensionBands } from '../services/sale-extensions';
import type { ActorContext } from '../services/sale';

const Params = z.object({ id: z.string().uuid() });
const Body = z.object({
  actionId: z.string().min(1).max(160), stationId: z.string().uuid(), optionId: z.string().min(1).max(40),
  selection: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('bands'), bandIds: z.array(z.string().uuid()).min(1).max(500) }),
    z.object({ mode: z.literal('count'), braceletCount: z.number().int().min(1).max(500) }),
  ]),
});

/**
 * The admission's branch is not in the URL: the service loads the sale inside
 * the caller's operator and checks the permission against the branch on the
 * row it found, as the refund and finalise routes do.
 */
function actorOf(req: FastifyRequest, permission: Permission): ActorContext {
  const auth = req.requireAuth();
  return { accountId: auth.accountId, operatorId: auth.operatorId, branchId: auth.branchId, requestId: req.id,
    assertBranchAllowed: async (branchId: string) => { await req.requirePermission(permission, { branchId }); } };
}

export async function saleExtensionRoutes(app: App) {
  app.get('/sales/:id/extensions', { config: { permission: 'pos:sale:read' }, schema: {
    description: 'The Add time options, the eligible bracelets and the time already added for one admission sale',
    params: Params } }, async (req) => {
    return readSaleExtensions(app.db, actorOf(req, 'pos:sale:read'), req.params.id);
  });
  app.post('/sales/:id/extensions', { config: { permission: 'pos:sale:create', stationTrading: true }, schema: {
    description: 'Open a separate charge for extra play time on an admission, at the session counter; replays by actionId',
    params: Params, body: Body } }, async (req) => {
    const auth = req.requireAuth();
    if (auth.stationId !== req.body.stationId) throw errors.conflict('EXTENSION_COUNTER_REQUIRED', 'Choose this counter before taking an extra-time payment.');
    return withTx(app.db, opCtx(req), 'sale.extension.create', (tx) => createSaleExtension(tx,
      actorOf(req, 'pos:sale:create'), req.params.id, req.body));
  });
  app.post('/sales/:id/extensions/:extensionId/bands', {
    config: { permission: 'pos:sale:create', stationTrading: true },
    schema: { description: 'Move a time addition onto replacement bracelets of the same admission; replays by actionId',
      params: Params.extend({ extensionId: z.string().uuid() }),
      body: z.object({ actionId: z.string().min(1).max(160), stationId: z.string().uuid(), bandIds: z.array(z.string().uuid()).min(1).max(500) }).strict() },
  }, async (req) => {
    const auth = req.requireAuth();
    if (auth.stationId !== req.body.stationId) throw errors.conflict('EXTENSION_COUNTER_REQUIRED', 'Choose this counter before updating replacement bracelets.');
    return withTx(app.db, opCtx(req), 'sale.extension.reselect', (tx) => reselectExtensionBands(tx,
      actorOf(req, 'pos:sale:create'), req.params.id, req.params.extensionId, req.body));
  });

}
