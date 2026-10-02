import { useCallback, useEffect, useState } from 'react';
import type { CashDrawerView } from '@oto/shared';
import { CASH_DRAWER_CHANGED, getDrawer } from '@/api/cash';
import { useStation } from '@/station/StationContext';

/**
 * S2-15a round 1 — this counter's cash drawer, from the platform.
 *
 * `stationId` is null when there is no platform station to ask about — a
 * deployment without the fleet, or a till that has not picked one — and the
 * screens then keep the prototype's own figures. `date` asks for the session
 * opened on that business date (the End of Day's day) instead of the open one.
 * Re-read whenever any screen changes the drawer (`CASH_DRAWER_CHANGED`).
 */
export interface CashDrawerRead {
  stationId: string | null;
  view: CashDrawerView | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useCashDrawer(date?: string): CashDrawerRead {
  const { station, fleetAvailable } = useStation();
  const stationId = fleetAvailable ? (station?.stationId ?? null) : null;
  const [view, setView] = useState<CashDrawerView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    const onChange = () => setTick((n) => n + 1);
    window.addEventListener(CASH_DRAWER_CHANGED, onChange);
    return () => window.removeEventListener(CASH_DRAWER_CHANGED, onChange);
  }, []);

  useEffect(() => {
    if (!stationId) {
      setView(null);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    getDrawer(stationId, date)
      .then((v) => {
        if (!live) return;
        setView(v);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(err instanceof Error ? err.message : 'The drawer could not be read from the platform.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [stationId, date, tick]);

  return { stationId, view, loading, error, reload };
}
