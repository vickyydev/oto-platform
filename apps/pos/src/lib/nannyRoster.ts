import { useEffect, useState } from 'react';
import { checkinApi, type ApiNanny } from '@/api/checkin';
import { apiBranchIdForSlug } from '@/api/catalogBridge';

const NONE: readonly ApiNanny[] = [];

/**
 * THE NANNY ROSTER A DROP-OFF LINE PICKS FROM (S2-13, round-1 fix, finding 3).
 *
 * The prototype's `DropOffLineConfig` read `getNannyRoster` itself. The port
 * takes the roster as a prop, so the till can re-read who is on shift when
 * the gate opens — and a screen that passed none (the mobile till) got an
 * empty list and could never pick a nanny, which blocked every nanny sale
 * there.
 *
 * So: a roster passed in is used exactly as given and nothing is asked;
 * without one, the hook reads the platform's (`GET /checkin/config`) for the
 * park on screen, by the PLATFORM's branch id (finding R1), and a till with no
 * platform branch gets an empty roster rather than a request the platform
 * would refuse. An answer that arrives after the screen went away, or after
 * the park changed, is dropped.
 */
export function useNannyRoster(branchSlug: string, provided?: readonly ApiNanny[]): readonly ApiNanny[] {
  const [own, setOwn] = useState<readonly ApiNanny[]>(NONE);
  const readOwn = provided === undefined;
  useEffect(() => {
    if (!readOwn) return;
    const platformBranchId = apiBranchIdForSlug(branchSlug);
    if (!platformBranchId) {
      setOwn(NONE);
      return;
    }
    let live = true;
    void checkinApi
      .config(platformBranchId)
      .then((config) => {
        if (live) setOwn(config.nannies);
      })
      .catch(() => {
        if (live) setOwn(NONE);
      });
    return () => {
      live = false;
    };
  }, [branchSlug, readOwn]);
  return provided ?? own;
}
