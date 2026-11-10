import { PartyBillingAnswerSchema, PartyBillingParamsSchema } from '@oto/shared';
import type { App } from '../app';
import { otoAppProvisionerOf } from '../plugins/credential';
import { partyBillingForOtoApp } from '../services/party-billing';

/**
 * SCRUM-822 — the OTO App's read of a party's money, from the till.
 *
 * Its caller is the app's SERVER, with its provisioning key (`credential:
 * 'otoapp-provision'`, SCRUM-539's key, as SCRUM-828's door): the operator is
 * the key's, and an event at none of that operator's branches is 404. The BEO's
 * Billing section, its Party Details box, its Day-of Execution view and its
 * Quote PDF all read these figures through it, so the app never works a party's
 * money out for itself. What it answers, and why, is written at
 * `services/party-billing.ts`. A read: nothing is written, and the same request
 * again answers the same figures.
 */
export async function otoAppPartyBillingRoutes(app: App): Promise<void> {
  app.get(
    '/parties/:eventId/billing',
    {
      config: { credential: 'otoapp-provision' },
      schema: {
        description:
          "OTO App server only (provisioning key): a party's money as the till holds it, for the BEO's Billing section, " +
          'its Party Details box, its Day-of Execution view and its Quote PDF. Before the party is settled, the quote ' +
          "(`state: quote`): what the till's Settle form would show today, priced by the sale engine as the settlement " +
          "will be — the package at the party's day price, the extras, the add-ons and entertainment, the items the BEO " +
          'added, the free lines at 0, the deposit recorded as paid in advance and the balance, in satang with labels. ' +
          'Once a settlement sale holds it (`state: sale`): the receipt number, the lines, every payment taken (the ' +
          'deposit among them), the totals, when it was settled and at which till. `state: no_quote` with the till\'s ' +
          'own refusal where it cannot price the party (no package in the OTO App, an extra the package names no price ' +
          "for). The operator is the key's: an event at none of its branches is 404. Read only.",
        params: PartyBillingParamsSchema,
        response: { 200: PartyBillingAnswerSchema },
      },
    },
    async (req) => {
      const { operatorId } = otoAppProvisionerOf(req);
      return partyBillingForOtoApp(app.db, { operatorId, eventId: req.params.eventId });
    },
  );
}
