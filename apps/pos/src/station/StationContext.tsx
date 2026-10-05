import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import { ScannerMode, StationProfile } from '@/types';
import { useBranch } from '@/branch/BranchContext';
import { useOperator } from '@/auth/OperatorContext';
import { stationsApi, type ApiStation, type PickableStation } from '@/api/platform';
import { ApiError, isMissingRoute } from '@/api/client';
import { forgetStationDevices, rememberStation, toStationProfile } from '@/station/fleet';
import { forgetStaffToken, rememberStaffToken } from '@/auth/staffToken';
import { setLaneStation } from '@/lib/lane';

interface StationContextValue {
  /** The station this till is working, or null while none has been picked. */
  station: StationProfile | null;
  /** The whole record behind it, for the screens that need the box as well. */
  active: ApiStation | null;
  /** What this account may pick at this branch; null while it is being read. */
  stations: PickableStation[] | null;
  /**
   * False when this deployment's API has no fleet routes yet, in which case the
   * POS keeps the prototype's own station setup and nothing is gated on a pick.
   */
  fleetAvailable: boolean;
  /**
   * False until the API has answered "which stations are this account's" for
   * the first time. Nothing should decide whether to ask for a station before
   * then, or a deployment that has no fleet at all shows the picker for the
   * half-second it takes to find that out.
   */
  resolved: boolean;
  loading: boolean;
  /** The platform could not be reached; the picker offers to try again. */
  error: string | null;
  /** Why the station this device remembered is not the one it is working. */
  notice: string | null;
  /** Take a station. Rejects when the API refuses it. */
  pick: (stationId: string, scannerMode?: ScannerMode) => Promise<void>;
  /** Read the list again — after the wizard has changed it, or on a retry. */
  reload: () => Promise<void>;
  /** Save a station profile on this device only: the no-API path. */
  setStation: (profile: StationProfile) => void;
  /** Forget the station this device is working and return to the picker. */
  clearStation: () => void;
}

const StationContext = createContext<StationContextValue | null>(null);

/**
 * The station this device is working, kept in localStorage.
 *
 * This is the one thing the POS puts in browser storage, and it is deliberate:
 * a station is a fact about the iPad on a particular counter, not about the
 * person holding it or about the session, so it has to outlive both a reload
 * and a shift change. Everything else the till knows comes from the API on
 * purpose. Each new session re-asserts the remembered station against the API
 * before using it, so a device cannot hand somebody a station that is no longer
 * theirs to work.
 */
interface RememberedStation {
  id: string;
  name: string;
  /**
   * Camera, or a scanner paired to this iPad. A scanner plugged into the box
   * belongs to the station and comes back from the API with it; these two are
   * facts about the device in somebody's hands, so they are kept here.
   */
  scannerMode?: ScannerMode;
}

const storeKey = (branchId: string) => `oto.pos.station.${branchId}`;

function readRemembered(branchId: string): RememberedStation | null {
  try {
    const raw = window.localStorage.getItem(storeKey(branchId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedStation>;
    return parsed.id && parsed.name
      ? { id: parsed.id, name: parsed.name, scannerMode: parsed.scannerMode }
      : null;
  } catch {
    // Private browsing, blocked site data, or a value from an older shape:
    // forgetting the station only costs one extra tap at the picker.
    return null;
  }
}

function writeRemembered(branchId: string, value: RememberedStation): void {
  try {
    window.localStorage.setItem(storeKey(branchId), JSON.stringify(value));
  } catch {
    // As above — the station still works for this session, it is simply not
    // remembered for the next one.
  }
}

function forgetRemembered(branchId: string): void {
  try {
    window.localStorage.removeItem(storeKey(branchId));
  } catch {
    // Nothing to do: the next read will fail the same way and return null.
  }
}

/**
 * Keep the shift token the pick just handed back (S2-06).
 *
 * The one moment it can be obtained is this one — it is minted in the same
 * transaction as the pick — and the one moment it is spent is hours later at a
 * locked screen with no internet. Anything the API could not give us
 * (no signing key on this deployment) leaves the till working exactly as
 * before and unable to unlock offline, which the lock screen says when asked
 * rather than pretending now.
 */
function keepStaffToken(picked: {
  station: ApiStation;
  staffToken: { token: string; jti: string; expiresAt: string } | null;
}): void {
  if (!picked.staffToken) {
    forgetStaffToken();
    return;
  }
  rememberStaffToken({
    ...picked.staffToken,
    stationId: picked.station.id,
    stationName: picked.station.name,
  });
}

const failure = (err: unknown): string =>
  err instanceof Error ? err.message : 'Could not reach the platform';

export function StationProvider({ children }: { children: ReactNode }) {
  const { branch, switching } = useBranch();
  const { operator, mustChangePassword } = useOperator();
  const scopeKey = `${branch.id}:${operator?.id ?? ''}:${mustChangePassword}:${switching}`;
  const scope = useRef({ key: scopeKey, generation: 0 });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, generation: scope.current.generation + 1 };
  const generation = scope.current.generation;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const [stations, setStations] = useState<PickableStation[] | null>(null);
  const [active, setActive] = useState<ApiStation | null>(null);
  const [picked, setPicked] = useState<StationProfile | null>(null);
  const [fleetAvailable, setFleetAvailable] = useState(true);
  const [resolved, setResolved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The prototype's own station profiles, keyed by branch, for a deployment
  // whose API has no fleet routes yet. In-memory by design, as before: they
  // describe mock devices, so surviving a reload would only mislead.
  const [localProfiles, setLocalProfiles] = useState<Record<string, StationProfile>>({});

  const adopt = useCallback(
    (station: ApiStation, scannerMode?: ScannerMode) => {
      const mode = scannerMode ?? readRemembered(branch.id)?.scannerMode;
      rememberStation(station);
      setActive(station);
      setPicked(toStationProfile(station, branch.id, mode));
      writeRemembered(branch.id, { id: station.id, name: station.name, scannerMode: mode });
      setNotice(null);
    },
    [branch.id],
  );

  const pick = useCallback(
    async (stationId: string, scannerMode?: ScannerMode) => {
      if (!mounted.current || switching || scope.current.generation !== generation) throw new Error('Wait for the park selection to finish, then pick a station.');
      const picked = await stationsApi.pick(stationId);
      if (!mounted.current || scope.current.generation !== generation) return;
      keepStaffToken(picked);
      adopt(picked.station, scannerMode);
    },
    [adopt, generation, switching],
  );

  const readList = useCallback(async (): Promise<void> => {
    if (!mounted.current || switching || scope.current.generation !== generation) return;
    setLoading(true);
    setError(null);
    try {
      const { stations: list } = await stationsApi.mine();
      if (!mounted.current || scope.current.generation !== generation) return;
      setStations(list);
      setFleetAvailable(true);
    } catch (err) {
      if (!mounted.current || scope.current.generation !== generation) return;
      if (isMissingRoute(err)) {
        // The fleet routes are not deployed here yet. Rather than block the
        // till behind a picker that can never fill, the POS falls back to the
        // prototype's own station setup until they arrive.
        setFleetAvailable(false);
        setStations([]);
      } else {
        setStations([]);
        setError(failure(err));
      }
    } finally {
      if (mounted.current && scope.current.generation === generation) setLoading(false);
    }
  }, [generation, switching]);

  // Read the list and re-assert the remembered station. Runs on sign-in and on
  // a branch change, which are the two moments the answer can differ — the
  // account id rather than the operator object, so a re-render of the same
  // shift does not go and ask again.
  //
  // And on the end of a temporary password (SCRUM-235). `GET /me/stations` is
  // one of the routes refused while one is held, so asking during it buys a
  // 403 and an audit row saying reception was denied something it is entitled
  // to. The account id does not change when the password does, so without
  // this the picker kept showing the refusal it got before the change — the
  // person fixed the thing they were told to fix and the screen did not move.
  const accountId = operator?.id ?? null;
  useEffect(() => {
    if (!accountId || mustChangePassword || switching) {
      setStations(null);
      setActive(null);
      setPicked(null);
      setNotice(null);
      setResolved(false);
      setLoading(switching);
      forgetStationDevices();
      return;
    }
    let cancelled = false;
    setActive(null);
    setPicked(null);
    setStations(null);
    setResolved(false);
    forgetStationDevices();

    void (async () => {
      setLoading(true);
      setError(null);
      let routesMissing = false;
      try {
        const { stations: list } = await stationsApi.mine();
        if (cancelled) return;
        setStations(list);
        setFleetAvailable(true);
      } catch (err) {
        if (cancelled) return;
        if (isMissingRoute(err)) {
          routesMissing = true;
          setFleetAvailable(false);
          setStations([]);
        } else {
          setStations([]);
          setError(failure(err));
        }
      }

      const remembered = routesMissing ? null : readRemembered(branch.id);
      if (remembered && !cancelled) {
        try {
          const picked = await stationsApi.pick(remembered.id);
          if (!cancelled) {
            keepStaffToken(picked);
            adopt(picked.station, remembered.scannerMode);
          }
        } catch (err) {
          if (cancelled) return;
          if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
            // The API refused it: the station was archived, or it is now kept
            // for named staff this account is not among. Forget it and say so,
            // because a picker that has quietly lost a station is worse than
            // one sentence explaining where it went.
            forgetRemembered(branch.id);
            setNotice(`${remembered.name} is no longer yours to work. Pick another station.`);
          } else {
            // Not a refusal — the API did not answer at all. Keep working the
            // station this device remembers rather than stopping the counter
            // over a network that may already be back.
            setPicked({
              stationId: remembered.id,
              stationName: remembered.name,
              branchId: branch.id,
              scannerMode: remembered.scannerMode ?? 'camera',
            });
          }
        }
      }
      if (!cancelled) {
        setLoading(false);
        setResolved(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [accountId, mustChangePassword, branch.id, adopt, switching]);

  const setStation = useCallback(
    (profile: StationProfile) => {
      setLocalProfiles((prev) => ({ ...prev, [branch.id]: { ...profile, branchId: branch.id } }));
    },
    [branch.id],
  );

  const clearStation = useCallback(() => {
    forgetRemembered(branch.id);
    forgetStationDevices();
    setActive(null);
    setPicked(null);
    setLocalProfiles((prev) => {
      const next = { ...prev };
      delete next[branch.id];
      return next;
    });
  }, [branch.id]);

  const station = fleetAvailable ? picked : localProfiles[branch.id] ?? null;

  /**
   * The lane arbiter follows the station this till is standing at (offline
   * plan OD-1): its box is the one the station bridge reaches. A prototype
   * profile from a deployment with no fleet routes has no box, so no lane.
   */
  const laneStationId = fleetAvailable ? (picked?.stationId ?? null) : null;
  useEffect(() => {
    setLaneStation(laneStationId);
  }, [laneStationId]);

  return (
    <StationContext.Provider
      value={{
        station,
        active,
        stations,
        fleetAvailable,
        resolved,
        loading,
        error,
        notice,
        pick,
        reload: readList,
        setStation,
        clearStation,
      }}
    >
      {children}
    </StationContext.Provider>
  );
}

export function useStation(): StationContextValue {
  const ctx = useContext(StationContext);
  if (!ctx) throw new Error('useStation must be used within a StationProvider');
  return ctx;
}
