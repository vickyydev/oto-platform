import { z } from 'zod';
import { EventDropInPricingAnswerSchema, EventDropInPricingSchema } from '@oto/shared';
import type { App } from '../app';
import { getEventDropInPricing, putEventDropInPricing } from '../services/event-writes';
import { opCtx } from '../services/tx';

/**
 * S2-20 E2 — THE BRANCH'S WALK-UP PRICES (Q8), registered under `/branches`:
 * camp day, event day and party guest, each a weekday/weekend pair in satang.
 * Only the party-guest price is read anywhere (a pass is priced from its event);
 * all three are stored and shown on the Admin Events panel.
 */
export async function eventPricingRoutes(app: App): Promise<void> {
  const BranchParams = z.object({ branchId: z.string().uuid() });

  app.get(
    '/:branchId/event-drop-in-pricing',
    {
      // The board reads the party-guest price to say what a walk-up adds to the tab.
      config: { permission: 'pos:event:read', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "The branch's walk-up prices — camp day, event day and party guest, each weekday/weekend in satang. A " +
          'branch nobody priced answers ฿0 for each with `configured: false`, the prototype\'s own unpriced branch.',
        params: BranchParams,
        response: { 200: EventDropInPricingAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return getEventDropInPricing(app.db, { operatorId: auth.operatorId, branchId: req.params.branchId });
    },
  );

  app.put(
    '/:branchId/event-drop-in-pricing',
    {
      config: { permission: 'admin:event_pricing:manage', target: { branchId: 'params.branchId' } },
      schema: {
        description:
          "Set the branch's three walk-up prices (all of them, every time). Audited as `event_pricing.update` with " +
          'the prices before and after.',
        params: BranchParams,
        body: EventDropInPricingSchema,
        response: { 200: EventDropInPricingAnswerSchema },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      return putEventDropInPricing(app.db, opCtx(req), {
        operatorId: auth.operatorId,
        accountId: auth.accountId,
        branchId: req.params.branchId,
        pricing: req.body,
        requestId: req.id,
      });
    },
  );
}
