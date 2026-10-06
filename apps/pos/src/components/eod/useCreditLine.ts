import { useEffect, useState } from 'react';
import { getCreditDay } from '@/api/wallet';
import { getBranches } from '@/store/catalogStore';

/**
 * S2-14a round 3 — the End of day `credit` line from the platform: wallet
 * credit redeemed at the F&B and shop counters on the business date, net of
 * what refunds put back through those spends. `key` names the day and branch
 * the figure belongs to, so a figure that arrives after the screen moved to
 * another day is never put on the wrong record.
 */
export interface CreditLineRead {
  key: string;
  /** Baht, the End of day record's unit; null until read, or when it could not be. */
  expectedTHB: number | null;
  error: string | null;
}

export const creditLineKey = (date: string, branch: string): string => `${branch}:${date}`;

export function useCreditLine(date: string, branch: string): CreditLineRead {
  const key = creditLineKey(date, branch);
  const [read, setRead] = useState<CreditLineRead>({ key, expectedTHB: null, error: null });
  useEffect(() => {
    let live = true;
    const apiId = getBranches().find((b) => b.id === branch)?.apiId;
    if (!apiId) {
      setRead({ key, expectedTHB: null, error: null });
      return;
    }
    getCreditDay(apiId, date)
      .then((day) => { if (live) setRead({ key, expectedTHB: day.netSatang / 100, error: null }); })
      .catch((err: unknown) => {
        if (live) setRead({ key, expectedTHB: null, error: err instanceof Error ? err.message : 'The credit figure could not be read.' });
      });
    return () => { live = false; };
  }, [key, date, branch]);
  return read;
}
