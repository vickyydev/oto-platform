import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isMissingRoute } from '@/api/client';
import { healthApi, type HealthSnapshot, type Readiness } from '@/api/observability';

/**
 * One reading of "is anything wrong", shared by the whole console.
 *
 * It lives above the pages rather than inside the Health page because the
 * sidebar shows an open-alert count on every page: a person who wandered into
 * Activity should not have to go back to Health to learn that something started
 * failing while they were reading.
 */
interface PlatformStatus {
  ready: Readiness | null;
  snapshot: HealthSnapshot | null;
  /** True when this deployment's API has no /ops/health yet. */
  snapshotMissing: boolean;
  /** A real failure, as opposed to a route that is simply not there. */
  error: string | null;
  loading: boolean;
  lastCheckedAt: number | null;
  refresh: () => Promise<void>;
}

const PlatformStatusContext = createContext<PlatformStatus | null>(null);

/**
 * Thirty seconds while the tab is in front of someone, nothing at all while it
 * is not. A console left open on a spare screen overnight should cost the API
 * nothing, and the first thing it does on being looked at again is refresh —
 * so what a returning reader sees is current, not eight hours stale.
 */
const POLL_MS = 30_000;

export function PlatformStatusProvider({
  enabled,
  children,
}: {
  /** Off until someone is signed in and holds `admin:health:read`. */
  enabled: boolean;
  children: ReactNode;
}) {
  const [ready, setReady] = useState<Readiness | null>(null);
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [snapshotMissing, setSnapshotMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      // /ready is public and exists on every deployment, so the top-line verdict
      // never depends on the richer route having landed.
      const readiness = await healthApi.ready().catch(() => null);
      setReady(readiness);
      try {
        setSnapshot(await healthApi.snapshot());
        setSnapshotMissing(false);
        setError(null);
      } catch (err) {
        if (isMissingRoute(err)) {
          setSnapshotMissing(true);
          setError(null);
        } else {
          setError(err instanceof Error ? err.message : 'Could not read the platform status');
        }
      }
      setLastCheckedAt(Date.now());
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    let timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      timer = 0;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, refresh]);

  const value = useMemo<PlatformStatus>(
    () => ({ ready, snapshot, snapshotMissing, error, loading, lastCheckedAt, refresh }),
    [ready, snapshot, snapshotMissing, error, loading, lastCheckedAt, refresh],
  );

  return <PlatformStatusContext.Provider value={value}>{children}</PlatformStatusContext.Provider>;
}

export function usePlatformStatus(): PlatformStatus {
  const ctx = useContext(PlatformStatusContext);
  if (!ctx) throw new Error('usePlatformStatus must be used within a PlatformStatusProvider');
  return ctx;
}

/** Alerts that are open and not yet acknowledged — the number worth a badge. */
export function unacknowledgedAlerts(snapshot: HealthSnapshot | null): number {
  if (!snapshot) return 0;
  return snapshot.alerts.filter((a) => !a.acknowledgedAt && !a.resolvedAt).length;
}
