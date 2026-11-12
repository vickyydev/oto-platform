import {
  PartyMenuCatalogueAnswerSchema,
  PartyMenuCatalogueQuerySchema,
  PartyMenuProductAnswerSchema,
  PartyMenuProductBodySchema,
} from '@oto/shared';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { otoAppProvisionerOf } from '../plugins/credential';
import { createPartyMenuProduct } from '../services/party-menu';
import { readPartyMenuCatalogue } from '../services/party-menu-catalogue';
import { opCtx } from '../services/tx';

/**
 * SCRUM-828 — the OTO App's door for a new menu item added from the BEO.
 *
 * Its caller is the app's SERVER, with its provisioning key (`credential:
 * 'otoapp-provision'`, SCRUM-539's key): the operator is the key's, and the
 * body's branch must be that operator's. What the door makes, and why the
 * Idempotency-Key is honoured by the service rather than the replay store, is
 * written at `services/party-menu.ts`.
 *
 * SCRUM-905 — and its read of the till's food and drink, for the BEO's
 * kitchen and bar plan pickers: the same key, the branch the key operator's,
 * what is answered written at `services/party-menu-catalogue.ts`.
 */
export async function otoAppPartyMenuRoutes(app: App): Promise<void> {
  app.get(
    '/party-menu/catalogue',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          "OTO App server only (provisioning key): the till's live food and drink at one of the key operator's branches, for the BEO's kitchen and bar plan pickers. Each menu item of the branch (or operator-wide) that is not archived, is on sale, carries a code and is made at the kitchen or the bar: its code, name, category, station, weekday and weekend price in satang, and whether the BEO made it (BEO-only). Another operator's branch, or an archived one, is 404. Writes nothing.",
        querystring: PartyMenuCatalogueQuerySchema,
        response: { 200: PartyMenuCatalogueAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      return readPartyMenuCatalogue(app.db, { operatorId, branchId: req.query.branchId });
    },
  );

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
