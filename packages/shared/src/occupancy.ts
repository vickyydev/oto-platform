/**
 * The live head count, as `GET /branches/:id/occupancy` answers it (S2-12
 * round 4, plan §2.6) and the till's occupancy chip reads it.
 *
 * `adults`, `kids` and `total` are the prototype's `LiveOccupancy` shape
 * (`apps/pos/src/types.ts`), unchanged, so the chip renders exactly what it
 * rendered on mock data. The rest is what the prototype never had to say,
 * because its count was in the same browser as the gate: WHEN the cloud last
 * heard from the gate, and whether that is recent enough to be believed.
 *
 *   asOf    the newest moment the platform can vouch for: the most recent
 *           contact from the branch's gate box(es). Null when the branch has
 *           no gate box at all.
 *   stale   true when a gate box has not been heard from within
 *           `staleAfterSeconds`, or holds gate facts it has not handed over
 *           for that long, or when the branch has no gate box. The chip then
 *           says "stale since {asOf}" rather than presenting the number as live.
 *   gates   how many gate boxes the answer is built from.
 */

import { z } from 'zod';

/** A gate box silent longer than this makes the count stale (heartbeat is 60 s). */
export const OCCUPANCY_STALE_AFTER_S = 150;

export const LiveOccupancyViewSchema = z.object({
  adults: z.number().int().min(0),
  kids: z.number().int().min(0),
  total: z.number().int().min(0),
  asOf: z.string().datetime().nullable(),
  stale: z.boolean(),
  staleAfterSeconds: z.number().int(),
  gates: z.number().int().min(0),
  /** The trading day the count covers (yyyy-mm-dd at the branch). */
  businessDate: z.string(),
});
export type LiveOccupancyView = z.infer<typeof LiveOccupancyViewSchema>;
