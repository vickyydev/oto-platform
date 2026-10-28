/**
 * The hand-typed call sites still to move onto `@oto/api-types` (SCRUM-272),
 * file by file — the migration list, and the ratchet that keeps it from
 * growing.
 *
 * A call site is hand-typed when its response type argument is written out
 * (`api.get<{ member: ApiMember }>(…)`) rather than named from the generated
 * description (`api.get<ApiResponse<'/members/{id}', 'get'>>(…)`). The seam
 * walker counts them per file and requires the count to be exactly this
 * number: a new hand-typed site fails the run, and a migrated one asks for its
 * number here to come down, so this list is always the work that remains.
 *
 * HOW TO MIGRATE A FILE, mechanically, as `apps/pos/src/api/benefits.ts` was:
 * 1. Add `@oto/api-types` to the app's devDependencies if it is not there.
 * 2. For each call, replace the type argument with
 *    `ApiResponse<'<path as the document spells it>', '<method>'>` — the
 *    walker fails if the path or method named is not the route the call
 *    reaches — and a written body type with `ApiBody<…>`.
 * 3. Replace the exported interfaces the screens import with aliases taken
 *    from those types (`ApiResponse<…>['templates'][number]`), keeping their
 *    names, and delete the hand-written copies.
 * 4. Run the app's typecheck; a screen that relied on a field the api does
 *    not send is the drift this exists to find.
 *
 * WHAT CAN MOVE NOW. A route whose schema declares no response body has
 * nothing to generate from: its `ApiResponse` is `unknown`. On 2026-10-14,
 * 167 of the 380 sites below call a route that describes its answer and can
 * move today; the other 213 wait on the api declaring a response schema for
 * the route, which changes what the route sends (Fastify's serializer drops
 * undeclared fields) and so is api work, route by route, not part of this
 * list. The files whose sites are all on described routes: console
 * analytics, print, settlements, vouchers, simulatorApi, PrintPanel,
 * KioskSummary; pos analytics, analyticsReports, bridge, display, endOfDay,
 * events, kioskDesk, occupancy, parties, payments, settlements, stock,
 * templatesApi, VoucherPromotionsPanel, displaySession, station/link. Most of
 * console fleet (26 of 27) and boothApi (21 of 30) are too. The files with
 * none: console bookings, observability, platform, sync; launcher platform;
 * pos bookings, checkin, history, members, menu, release, sales, vouchers,
 * wallet, usePaymentStage.
 */
export const HAND_TYPED: Record<string, number> = {
  'apps/booth/src/booth/client.ts': 8,
  'apps/console/src/api/analytics.ts': 1,
  'apps/console/src/api/bookings.ts': 1,
  'apps/console/src/api/fleet.ts': 27,
  'apps/console/src/api/observability.ts': 6,
  'apps/console/src/api/platform.ts': 9,
  'apps/console/src/api/print.ts': 1,
  'apps/console/src/api/settlements.ts': 2,
  'apps/console/src/api/sync.ts': 4,
  'apps/console/src/api/vouchers.ts': 2,
  'apps/console/src/components/booth/boothApi.ts': 30,
  'apps/console/src/components/devices/PrintPanel.tsx': 2,
  'apps/console/src/components/devices/simulatorApi.ts': 3,
  'apps/console/src/components/health/KioskSummary.tsx': 1,
  'apps/console/src/components/integrations/GatewaySimulatorPanel.tsx': 2,
  'apps/launcher/src/api/platform.ts': 14,
  'apps/pos/src/api/analytics.ts': 1,
  'apps/pos/src/api/bookings.ts': 5,
  'apps/pos/src/api/bridge.ts': 11,
  'apps/pos/src/api/checkin.ts': 18,
  'apps/pos/src/api/display.ts': 5,
  'apps/pos/src/api/endOfDay.ts': 6,
  'apps/pos/src/api/events.ts': 7,
  'apps/pos/src/api/history.ts': 9,
  'apps/pos/src/api/kioskDesk.ts': 1,
  'apps/pos/src/api/members.ts': 1,
  'apps/pos/src/api/occupancy.ts': 1,
  'apps/pos/src/api/parties.ts': 4,
  'apps/pos/src/api/payments.ts': 5,
  'apps/pos/src/api/platform.ts': 46,
  'apps/pos/src/api/release.ts': 9,
  'apps/pos/src/api/sales.ts': 8,
  'apps/pos/src/api/settlements.ts': 2,
  'apps/pos/src/api/stock.ts': 5,
  'apps/pos/src/api/vouchers.ts': 7,
  'apps/pos/src/api/wallet.ts': 3,
  // SCRUM-619: the same legacy callers moved behind the host API seam.
  // Described outputs migrated; routes without an output schema retain their DTO.
  'packages/admin-screens/src/lifted/api/platform.ts': 16,
  'packages/admin-screens/src/lifted/api/wallet.ts': 5,
  'apps/pos/src/lib/displaySession.ts': 1,
  'apps/pos/src/lib/usePaymentStage.ts': 1,
  'apps/pos/src/station/link.ts': 1,
};
