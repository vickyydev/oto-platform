// The occupancy chip's read — S2-12 round 4.
//
// The chip used to derive its count in the browser from the mock store
// (`getLiveOccupancy` in mockApi). The count now lives on the platform, built
// from the gate box's committed passages (`GET /branches/:id/occupancy`,
// `apps/api/src/services/occupancy.ts`), and this is the one seam the chip
// reads it through. The shape the chip renders — adults, kids, total — is
// unchanged; what is added is whether the number can be believed: `stale`
// and `asOf`, which the chip shows as "stale since" rather than presenting an
// old count as live.
import type { LiveOccupancyView } from '@oto/shared';
import { getActiveBranch } from '@/store/catalogStore';
import { api } from './client';

export interface ChipOccupancy {
  adults: number;
  kids: number;
  total: number;
  /** True when the gate behind the count is not current, or there is no gate. */
  stale: boolean;
  /** The last moment the platform heard from the gate; null when never. */
  asOf: string | null;
  /** How many gate boxes the count is built from; 0 means nothing counts people in. */
  gates: number;
}

/**
 * The live count at the active branch. A branch the platform does not know
 * (a mock-only branch, nobody signed in) has no count to read, and says so as
 * a stale zero with no gate rather than as a number.
 */
export async function fetchLiveOccupancy(): Promise<ChipOccupancy> {
  const branchApiId = getActiveBranch().apiId;
  if (!branchApiId) {
    return { adults: 0, kids: 0, total: 0, stale: true, asOf: null, gates: 0 };
  }
  const view = await api.get<LiveOccupancyView>(`/branches/${branchApiId}/occupancy`);
  return {
    adults: view.adults,
    kids: view.kids,
    total: view.total,
    stale: view.stale,
    asOf: view.asOf,
    gates: view.gates,
  };
}
