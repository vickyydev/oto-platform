import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { StationProfile } from '@/types';
import { useBranch } from '@/branch/BranchContext';

interface StationContextValue {
  /** The active station profile for THIS iPad/branch, or null when not yet set up. */
  station: StationProfile | null;
  /** Save (or replace) the active station profile. Stamps the active branchId. */
  setStation: (profile: StationProfile) => void;
  /** Clear the active station for the current branch (forces setup again). */
  clearStation: () => void;
}

const StationContext = createContext<StationContextValue | null>(null);

// App-wide, in-memory active station profiles keyed by branch ID. In production
// this is persisted per-device by the local print agent on the branch mini-PC;
// here it lives in React state only and resets on a full reload by design
// (no browser storage). Storing a Record<branchId, profile> means switching
// branches restores the previously configured station for that branch.
export function StationProvider({ children }: { children: ReactNode }) {
  const { branch } = useBranch();
  const [stations, setStations] = useState<Record<string, StationProfile>>({});

  // Derived: active station is the one stored for the current branch (or null).
  const station = stations[branch.id] ?? null;

  const setStation = useCallback(
    (profile: StationProfile) =>
      setStations((prev) => ({
        ...prev,
        [branch.id]: { ...profile, branchId: branch.id },
      })),
    [branch.id],
  );

  const clearStation = useCallback(
    () =>
      setStations((prev) => {
        const next = { ...prev };
        delete next[branch.id];
        return next;
      }),
    [branch.id],
  );

  return (
    <StationContext.Provider value={{ station, setStation, clearStation }}>
      {children}
    </StationContext.Provider>
  );
}

export function useStation(): StationContextValue {
  const ctx = useContext(StationContext);
  if (!ctx) throw new Error('useStation must be used within a StationProvider');
  return ctx;
}
