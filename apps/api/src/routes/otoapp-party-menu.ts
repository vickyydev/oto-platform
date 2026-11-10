import { PartyMenuProductAnswerSchema, PartyMenuProductBodySchema } from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { otoAppProvisionerOf } from '../plugins/credential';
import { createPartyMenuProduct } from '../services/party-menu';
import { opCtx } from '../services/tx';

/**
 * SCRUM-828 — the OTO App's door for a new menu item added from the BEO.
 *
 * Its caller is the app's SERVER, with its provisioning key (`credential:
 * 'otoapp-provision'`, SCRUM-539's key): the operator is the key's, and the
 * body's branch must be that operator's. What the door makes, and why the
 * Idempotency-Key is honoured by the service rather than the replay store, is
 * written at `services/party-menu.ts`.
 */
export async function otoAppPartyMenuRoutes(app: App): Promise<void> {
  app.post(
    '/party-menu/products',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          "OTO App server only (provisioning key): a new menu item added from the BEO, made a till product of the party's branch in the operator's Party menu category and marked BEO-only — never on the till's selling grids or its F&B menu, found by its code by the party's plan and its kitchen and bar slips. Idempotent on the Idempotency-Key the app sends: the same key and body answer the same product, a different body is refused 409.",
        body: PartyMenuProductBodySchema,
        response: { 200: PartyMenuProductAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
        throw errors.badRequest('An Idempotency-Key is required');
      }
      return createPartyMenuProduct(app.db, opCtx(req), { operatorId, idempotencyKey: key, ...req.body });
    },
  );
}
