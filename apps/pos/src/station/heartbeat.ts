import { useEffect } from 'react';
import { SCREEN_HEARTBEAT_INTERVAL_S, type StationHeartbeatResponse } from '@oto/shared';
import { api } from '@/api/client';
import { lastScanSecondsAgo } from '@/lib/scannerUse';

/**
 * SCRUM-771 — THIS TILL'S SCREEN, STILL THERE.
 *
 * A box tells the platform it is alive every minute; the iPad running the till
 * told it nothing, so a till that had gone dark looked exactly like one nobody
 * had needed for an hour. While a station is held this sends
 * `POST /me/station/heartbeat` every `SCREEN_HEARTBEAT_INTERVAL_S` seconds —
 * at once on taking the station, and again the moment the iPad wakes or its
 * Wi-Fi returns, rather than waiting out the minute. It carries how long ago a
 * scanner last typed into this till (`lib/scannerUse.ts`), which is the only
 * presence a cradle plugged into the iPad has. The Console shows both.
 *
 * It runs at the lock screen too: a locked till is still standing at the
 * counter, and the platform lets this one call through a lock. A heartbeat that
 * fails is simply the next one's job; nothing on screen depends on it.
 */
export const stationHeartbeatApi = {
  send: () =>
    api.post<StationHeartbeatResponse>('/me/station/heartbeat', {
      lastScanSecondsAgo: lastScanSecondsAgo(),
    }),
};

export function useStationHeartbeat(stationId: string | null): void {
  useEffect(() => {
    if (!stationId) return;
    let stopped = false;
    let inFlight = false;
    const beat = () => {
      if (stopped || inFlight) return;
      inFlight = true;
      void stationHeartbeatApi
        .send()
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    beat();
    const timer = setInterval(beat, SCREEN_HEARTBEAT_INTERVAL_S * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') beat();
    };
    // Either may be absent, or a stand-in with no events, where the till is
    // driven without a browser; the minute's beat does not need them.
    const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
    const hasDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
    if (hasWindow) window.addEventListener('online', beat);
    if (hasDocument) document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (hasWindow) window.removeEventListener('online', beat);
      if (hasDocument) document.removeEventListener('visibilitychange', onVisible);
    };
  }, [stationId]);
}
