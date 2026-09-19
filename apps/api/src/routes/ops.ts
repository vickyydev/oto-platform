import { z } from 'zod';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { opCtx, withTx } from '../services/tx';
import { isPlatformWide } from '../services/permissions';
import { DEMO_RESET_CONFIRMATION, resetDemoData } from '../services/demo-reset';

/**
 * S2-01c — operational controls for a staging deployment.
 *
 * Two gates, both required. `OPS_TEST_CONTROLS` is the DEPLOYMENT saying it
 * is a playground, and the platform-wide assignment is the CALLER saying who
 * they are; neither substitutes for the other, so the control simply does not
 * exist on production even for the platform admin who built it.
 */
export async function opsRoutes(app: App): Promise<void> {
  const requirePlatform = async (req: FastifyRequest) => {
    const auth = req.requireAuth();
    if (!app.env.OPS_TEST_CONTROLS) {
      throw errors.forbidden('Operational test controls are off on this deployment');
    }
    const effective = await req.effectivePermissions();
    if (!isPlatformWide(effective)) throw errors.forbidden('Platform administrator only');
    return auth;
  };

  /**
   * Whether this caller, on this deployment, may reset. Answered rather than
   * refused so the console can hide the control without every admin console
   * load recording a denial for the staff who will never see it.
   */
  app.get(
    '/demo-reset',
    {
      config: { auth: 'session' },
      schema: { description: 'Whether the demo reset is available to this caller' },
    },
    async (req) => {
      req.requireAuth();
      const effective = await req.effectivePermissions();
      return {
        available: app.env.OPS_TEST_CONTROLS && isPlatformWide(effective),
        confirmationPhrase: DEMO_RESET_CONFIRMATION,
      };
    },
  );

  app.post(
    '/demo-reset',
    {
      config: { platformWide: true },
      schema: {
        description: 'Delete the demo facts, keeping accounts and the catalogue',
        body: z.object({ confirm: z.string() }).strict(),
      },
    },
    async (req) => {
      const auth = await requirePlatform(req);
      if (req.body.confirm !== DEMO_RESET_CONFIRMATION) {
        throw errors.badRequest(`Type "${DEMO_RESET_CONFIRMATION}" to confirm`);
      }
      // One transaction: a reset that half ran would leave the deployment in a
      // state neither the client nor the seed can describe.
      return withTx(app.db, opCtx(req), 'ops.demo_reset', async (tx) => {
        const deleted = await resetDemoData(tx);
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'ops.demo_reset',
          entityType: 'operation',
          entityId: req.id,
          after: { deleted },
          requestId: req.id,
        });
        return { deleted };
      });
    },
  );
}
