import type { App } from '../app';

/**
 * THE TENDER SURFACE (S2-10a, SCRUM-206) — registered, and deliberately empty
 * until Slice C2 fills it.
 *
 * WHY IT IS `/payments/*` AND NOT UNDER `/sales/*`. `apps/api/test/sales.test.ts`
 * pins the `/sales` path list and the six route guards exactly, in both
 * directions, so a terminal or an inquiry route added there is a test failure
 * by construction — on purpose: `/sales` is the ledger's surface and a tender
 * in flight is not a sale. Card routing, the inquiry, the audited staff
 * confirmation and manual entry all live here instead:
 *
 *   POST /payments/attempts            open an attempt and send it to a terminal
 *   POST /payments/attempts/:id/result the box reports what the terminal said
 *   POST /payments/attempts/:id/confirm a person says what the terminal's own
 *                                      screen said, when no inquiry is possible
 *
 * WHY THE OUTCOME COMES BACK ON ITS OWN ROUTE rather than on the command's
 * acknowledgement: the customer-interaction budget is 120 seconds
 * (`DEVICE_INVENTORY.md:948`) and a command poll is five, so an HTTP call held
 * open for a guest tapping a card is a till that looks hung. A print job's
 * outcome already works this way (`services/print.ts`, `POST
 * /box/v1/print-jobs/:id/result`) and this follows it.
 *
 * The shell exists now so that `app.ts` — which this slice owns and the later
 * ones do not — is not touched again when those routes land. It registers no
 * route, which is why no list in `route-write-conformance.test.ts` changes.
 */
export function paymentRoutes(_app: App): Promise<void> {
  // Slice C2.
  return Promise.resolve();
}
