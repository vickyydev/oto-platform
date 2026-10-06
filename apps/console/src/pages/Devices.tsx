import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Cpu,
  CreditCard,
  DoorOpen,
  FerrisWheel,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Router,
  ShieldOff,
  Tablet,
  type LucideIcon,
} from 'lucide-react';
import {
  boxVitals,
  fleetApi,
  isMissingRoute,
  BOX_ROLES,
  HEARTBEAT_LATE_AFTER_S,
  type BoxRole,
  type BoxRow,
  type CredentialKind,
  type CredentialRow,
  type DeviceRow,
  type StationRow,
} from '@/api/fleet';
import { directoryApi, type BranchRow } from '@/api/platform';
import { Button } from '@/components/ui/button';
import { ErrorNote, Loading, RouteUnavailable } from '@/components/Panel';
import { StatusMark, type Tone } from '@/components/Status';
import { CommandBar } from '@/components/redesign/CommandBar';
import {
  FilterChip,
  SelectChip,
  StatusChip,
  Tag,
  TitleChip,
  TONE_INK,
} from '@/components/redesign/chips';
import {
  CardFoot,
  CardGroup,
  CardShell,
  DashedSlot,
  PageGrid,
  StripedList,
} from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Field, Select, TextInput } from '@/components/Form';
import { BoxDrawer } from '@/components/devices/BoxDrawer';
import { DisplayPairPanel } from '@/components/devices/DisplayPairPanel';
import { DisplaySnapshotPanel } from '@/components/devices/DisplaySnapshotPanel';
import { DisplayIntentTestPanel } from '@/components/devices/DisplayDiagnosticsPanel';
import { OneTimeCode } from '@/components/devices/OneTimeCode';
import { StationDrawer } from '@/components/devices/StationDrawer';
import { TerminalSimulatorPanel } from '@/components/devices/TerminalSimulatorPanel';
import { useSession } from '@/auth/SessionContext';
import {
  devicesFailed,
  devicesRead,
  readFailureMessage,
  readingDevices,
  UNREAD_DEVICES,
  type BoxDeviceList,
} from '@/lib/deviceList';
import {
  PAIRABLE_KINDS,
  accessSentence,
  boxRoleWord,
  boxStatusWord,
  capabilityWord,
  credentialKindWord,
  stationKindWord,
  toneForBoxStatus,
} from '@/lib/fleetWords';
import { elapsed, formatWhen, timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * The views the chip row offers (SCRUM-474). Each shows one of the page's own
 * panels; "All" is the page as it always was. Nothing is fetched differently.
 */
const VIEWS = [
  { id: 'all', label: 'All' },
  { id: 'boxes', label: 'Boxes' },
  { id: 'stations', label: 'Stations' },
  { id: 'screens', label: 'Paired screens' },
  { id: 'terminals', label: 'Card terminals' },
] as const;
type View = (typeof VIEWS)[number]['id'];

/**
 * The fleet, as an administrator sets it up.
 *
 * The order of this page is the order the park described, and it is not
 * arbitrary: the BOX comes first, because it is a Raspberry Pi already
 * standing at a counter; the DEVICES that can then be offered are only the
 * ones that box reported, because a printer is reachable through the box it is
 * plugged into and nowhere else; and last comes who may use the station.
 *
 * The rule that shapes the station panel is that ACCESS SCOPE DRIVES
 * VISIBILITY. A station restricted to named staff is absent from everybody
 * else's picker — not greyed out, not present and refusing — so the page says
 * that in as many words wherever it is true. Somebody who cannot use a till
 * should not be looking at it wondering why.
 */
export function Devices() {
  const { me, has, permissions } = useSession();
  const timezone = me?.branch?.timezone;

  const canRegisterBox = has('admin:box:register');
  const canCommandBox = has('admin:box:command');
  const canUpdateBox = has('admin:box:update');
  const canCreateStation = has('admin:station:create');
  const canUpdateStation = has('admin:station:update');
  const canCreateDevice = has('admin:device:create');
  const canUpdateDevice = has('admin:device:update');
  const canPair = has('admin:device:pair');
  const canRevoke = has('admin:device:revoke');

  const [branches, setBranches] = useState<BranchRow[] | null>(null);
  const [branchId, setBranchId] = useState(me?.branch?.id ?? '');

  useEffect(() => {
    void directoryApi
      .branches()
      .then((r) => {
        const live = r.branches.filter((b) => !b.archived);
        setBranches(live);
        // A platform-wide account has no branch of its own on /me, and every
        // read on this page is branch-scoped, so it opens on the first branch
        // rather than on nothing.
        setBranchId((current) => current || (live[0]?.id ?? ''));
      })
      .catch(() => setBranches(null));
  }, []);

  const fleet = useFleet(branchId);
  const [openBox, setOpenBox] = useState<BoxRow | null>(null);
  const [openStation, setOpenStation] = useState<StationRow | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const branchName = useCallback(
    (id: string | null | undefined): string | null =>
      id ? (branches?.find((b) => b.id === id)?.name ?? null) : null,
    [branches],
  );

  const stationName = useCallback(
    (id: string | null | undefined): string | null =>
      id ? (fleet.stations.find((s) => s.id === id)?.name ?? null) : null,
    [fleet.stations],
  );

  const stations = fleet.stations.filter((s) => showArchived || !s.archived);
  const displayStations = fleet.stations.filter(
    (s) =>
      !s.archived &&
      s.branchId === branchId &&
      s.boxId &&
      (s.kind === 'till' || s.kind === 'kiosk') &&
      permissions.some(
        (grant) =>
          grant.permission === 'admin:device:pair' &&
          (grant.scopeType === 'operator'
            ? grant.scopeId === null || grant.scopeId === me?.account.operatorId
            : grant.scopeType === 'branch' && grant.scopeId === s.branchId),
      ),
  );
  const currentBranchName = branchName(branchId) ?? 'this branch';
  const canReadUnassignedSnapshots = permissions.some(
    (grant) =>
      grant.permission === 'admin:station:read' &&
      (grant.scopeType === 'operator'
        ? grant.scopeId === null || grant.scopeId === me?.account.operatorId
        : grant.scopeType === 'branch' && grant.scopeId === branchId),
  );
  const snapshotStations = fleet.stations.filter(
    (s) => s.branchId === branchId && canReadUnassignedSnapshots,
  );
  const boxLogStations = fleet.stations.filter(s => s.branchId === branchId &&
    fleet.boxes.some(box => box.id === s.boxId) && permissions.some(grant =>
      grant.permission === 'admin:box:read' && (grant.scopeType === 'operator'
        ? grant.scopeId === null || grant.scopeId === me?.account.operatorId
        : grant.scopeType === 'branch' && grant.scopeId === s.branchId)));

  const [view, setView] = useState<View>('all');
  const showing = (id: View) => view === 'all' || view === id;
  const liveBoxes = fleet.boxes.filter((b) => !b.archived);
  const onlineBoxes = liveBoxes.filter((b) => b.status === 'online').length;
  const liveStations = fleet.stations.filter((s) => !s.archived).length;
  // Each half of the chip only once ITS read has answered for this branch: a
  // 500, or a 403 for an account with this page but not admin:box:read, leaves
  // the rows empty, and an empty array is not "0 boxes".
  const fleetCounts = [
    fleet.read.boxes &&
      `${liveBoxes.length} box${liveBoxes.length === 1 ? '' : 'es'} · ${onlineBoxes} online`,
    fleet.read.stations && `${liveStations} station${liveStations === 1 ? '' : 's'}`,
  ].filter(Boolean);

  return (
    <>
      <CommandBar
        sectionId="devices"
        place={branchName(branchId)}
        badges={
          fleetCounts.length > 0 ? <TitleChip>{fleetCounts.join(' · ')}</TitleChip> : undefined
        }
        actions={
          <>
            {branches && branches.length > 1 && (
              // SCRUM-435: sized by its longest option, so a name like "Oto
              // Play Park, Robinson Chalong" is never cut to "…Chal…".
              <SelectChip
                label="Branch"
                showLabel
                value={branchId}
                onChange={setBranchId}
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
              />
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 rounded-full px-3.5"
              onClick={fleet.reload}
              disabled={fleet.loading}
            >
              {fleet.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Show">
        {VIEWS.map((v) => (
          <FilterChip key={v.id} active={view === v.id} onClick={() => setView(v.id)}>
            {v.label}
          </FilterChip>
        ))}
      </div>

      {fleet.error && <ErrorNote message={fleet.error} onRetry={fleet.reload} />}

      <PageGrid>
        {showing('boxes') && (
          <CardGroup
            title="Boxes"
            icon={Cpu}
            note="the machine at each counter, gate and booth — it holds the station's sale, drives its devices and keeps working when the internet does not"
          >
            {fleet.missing.boxes ? (
              <RouteUnavailable
                what="The box register"
                detail="Boxes appear here as soon as the fleet API is deployed to this environment; the virtual box registers itself on first boot."
              />
            ) : fleet.loading && fleet.boxes.length === 0 ? (
              <Loading what="boxes" />
            ) : (
              <ul className="grid grid-cols-1 gap-5 @2xl:grid-cols-2 @4xl:grid-cols-3">
                {fleet.boxes.map((box) => (
                  <BoxCard
                    key={box.id}
                    box={box}
                    deviceCount={fleet.devices.filter((d) => d.boxId === box.id && !d.archived).length}
                    stationCount={fleet.stations.filter((s) => s.boxId === box.id && !s.archived).length}
                    timezone={timezone}
                    onOpen={() => setOpenBox(box)}
                  />
                ))}
                {canRegisterBox ? (
                  <li className="min-w-0 flex">
                    <DashedSlot
                      className="flex-1"
                      icon={Plus}
                      title={fleet.boxes.length === 0 ? 'No box at this branch yet' : 'Another box'}
                      detail="Add one to get a claim code; the Pi redeems it the first time it boots on site."
                      action={<AddBoxButton branchId={branchId} onAdded={fleet.reload} />}
                    />
                  </li>
                ) : fleet.boxes.length === 0 ? (
                  <li className="min-w-0 flex">
                    <DashedSlot
                      className="flex-1"
                      title="No box at this branch yet"
                      detail="Adding one needs admin:box:register. Once it is added, the Pi redeems its claim code the first time it boots on site."
                    />
                  </li>
                ) : null}
              </ul>
            )}
          </CardGroup>
        )}

        {showing('stations') && (
          <CardGroup
            title="Stations"
            icon={Router}
            note="where a session is held — staff sign in, pick one of these and work; they never set one up themselves"
            actions={
              <>
                {fleet.stations.some((s) => s.archived) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full px-3.5"
                    onClick={() => setShowArchived((v) => !v)}
                  >
                    {showArchived ? 'Hide archived' : 'Show archived'}
                  </Button>
                )}
                {canCreateStation && !fleet.missing.stations && (
                  <Button
                    size="sm"
                    className="h-9 gap-2 rounded-full px-4 font-bold"
                    disabled={!branchId || fleet.boxes.length === 0}
                    title={
                      !branchId
                        ? 'Choose a branch first'
                        : fleet.boxes.length === 0
                          ? 'A station sits on a box, and this branch has none yet'
                          : undefined
                    }
                    onClick={() => setOpenStation('new')}
                  >
                    <Plus className="w-4 h-4" />
                    New station
                  </Button>
                )}
              </>
            }
          >
            {fleet.missing.stations ? (
              <RouteUnavailable what="The station register" />
            ) : fleet.loading && stations.length === 0 ? (
              <Loading what="stations" />
            ) : stations.length === 0 ? (
              <DashedSlot
                title="No stations yet"
                detail={`A station names a box, the devices it drives and who may pick it. ${
                  !canCreateStation
                    ? 'Adding one needs admin:station:create.'
                    : fleet.boxes.length === 0
                      ? 'It sits on a box, so the branch needs a box before New station, above, can add one.'
                      : 'New station, above, adds the first.'
                }`}
              />
            ) : (
              <ul className="grid grid-cols-1 gap-5 @2xl:grid-cols-2 @4xl:grid-cols-3">
                {stations.map((station) => (
                  <StationCard
                    key={station.id}
                    station={station}
                    branchLabel={branchName(station.branchId) ?? currentBranchName}
                    onOpen={() => setOpenStation(station)}
                  />
                ))}
              </ul>
            )}
          </CardGroup>
        )}

        {showing('screens') && (
          <PairedScreens
            key={branchId}
            credentials={fleet.credentials}
            missing={fleet.missing.credentials}
            stations={fleet.stations.filter((s) => !s.archived)}
            displayStations={displayStations}
            snapshotStations={snapshotStations}
            canReadUnassignedSnapshots={canReadUnassignedSnapshots}
            boxLogStations={boxLogStations}
            stationName={stationName}
            timezone={timezone}
            canPair={canPair}
            canRevoke={canRevoke}
            onChanged={fleet.reload}
            onOpenBoxLog={stationId => {
              const boxId = boxLogStations.find(station => station.id === stationId)?.boxId;
              const box = fleet.boxes.find(candidate => candidate.id === boxId);
              if (box) setOpenBox(box);
            }}
          />
        )}

        {/**
         * The card terminals (S2-10a, SCRUM-206).
         *
         * On the PAGE rather than inside the box drawer, where the printer
         * simulator sits, and for a reason a reader should be able to see: these
         * controls do not ride the command queue — an approval code cannot be
         * stored in a command payload the drawer renders as history — so they are
         * not "things to ask a box to do". A tender is routed to a terminal by
         * the STATION it hangs off, which is the list above this, and both of the
         * park's EDCs are on one box anyway.
         */}
        {showing('terminals') && (
          <TerminalSimulatorPanel devices={fleet.devices} canCommand={canCommandBox} />
        )}
      </PageGrid>

      {openBox && (
        <BoxDrawer
          box={openBox}
          deviceList={fleet.deviceList(openBox.id)}
          onRetryDevices={() => fleet.retryDevices(openBox.id)}
          stations={fleet.stations.filter((s) => s.boxId === openBox.id)}
          timezone={timezone}
          canCommand={canCommandBox}
          canUpdateBox={canUpdateBox}
          canCreateDevice={canCreateDevice}
          canUpdateDevice={canUpdateDevice}
          onClose={() => setOpenBox(null)}
          onChanged={fleet.reload}
        />
      )}

      {openStation && (
        <StationDrawer
          station={openStation === 'new' ? null : openStation}
          branchId={branchId}
          branchLabel={currentBranchName}
          boxes={fleet.boxes.filter((b) => !b.archived)}
          deviceList={fleet.deviceList}
          onRetryDevices={fleet.retryDevices}
          canEdit={openStation === 'new' ? canCreateStation : canUpdateStation}
          onClose={() => setOpenStation(null)}
          onSaved={() => {
            setOpenStation(null);
            fleet.reload();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Loading the branch's fleet
// ---------------------------------------------------------------------------

interface Fleet {
  boxes: BoxRow[];
  stations: StationRow[];
  /** Every device held right now, across the branch's boxes. Counts use it. */
  devices: DeviceRow[];
  /** One box's device list, and whether that list can be believed. */
  deviceList: (boxId: string) => BoxDeviceList;
  /** Re-read one box's devices — the "try again" the panels offer. */
  retryDevices: (boxId: string) => void;
  credentials: CredentialRow[];
  /** Per list, because the API half of this ticket lands route by route. */
  missing: { boxes: boolean; stations: boolean; credentials: boolean };
  /** Per list: the last read for this branch answered, so its rows are a reading. */
  read: { boxes: boolean; stations: boolean; credentials: boolean };
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function useFleet(branchId: string): Fleet {
  const [boxes, setBoxes] = useState<BoxRow[]>([]);
  const [stations, setStations] = useState<StationRow[]>([]);
  const [deviceLists, setDeviceLists] = useState<Record<string, BoxDeviceList>>({});
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [missing, setMissing] = useState({ boxes: false, stations: false, credentials: false });
  /**
   * Which of the three reads last ANSWERED for this branch. Missing (404) and
   * failed (anything else) both leave it false, so a count is only ever drawn
   * from rows the API returned — never from the empty arrays this starts with.
   */
  const [read, setRead] = useState(NOTHING_READ);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which read is the newest one asked for, per box.
   *
   * Two reads of the same box can be in flight at once — the page re-reads
   * itself after a command, and a panel's "try again" asks for one box on its
   * own — and answers come back in whatever order the network gives them. Only
   * the newest read asked for a box is allowed to write that box's state, so a
   * slow answer cannot land on top of a fresher one and be stamped with the
   * time it landed.
   */
  const newestRead = useRef(new Map<string, number>());
  const reads = useRef(0);

  const readDevices = useCallback(async (boxId: string) => {
    reads.current += 1;
    const ticket = reads.current;
    newestRead.current.set(boxId, ticket);
    setDeviceLists((held) => ({ ...held, [boxId]: readingDevices(held[boxId]) }));
    try {
      const { devices } = await fleetApi.boxDevices(boxId);
      if (newestRead.current.get(boxId) !== ticket) return;
      setDeviceLists((held) => ({ ...held, [boxId]: devicesRead(devices) }));
    } catch (err) {
      if (newestRead.current.get(boxId) !== ticket) return;
      const message = readFailureMessage(err);
      setDeviceLists((held) => ({ ...held, [boxId]: devicesFailed(held[boxId], message) }));
    }
  }, []);

  // A different branch is a different fleet: nothing read for the last one
  // says anything about this one, so none of it is carried across.
  useEffect(() => {
    newestRead.current.clear();
    setDeviceLists({});
    setRead(NOTHING_READ);
  }, [branchId]);

  const load = useCallback(async () => {
    if (!branchId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    // Three independent reads. One route being absent or refused must not empty
    // the other panels, so each settles on its own and the page reports the
    // first real failure rather than the first absence.
    const [boxRes, stationRes, credentialRes] = await Promise.allSettled([
      fleetApi.boxes(branchId),
      fleetApi.stations(branchId),
      fleetApi.credentials(branchId, true),
    ]);

    const failures: string[] = [];
    const absent = { boxes: false, stations: false, credentials: false };
    const answered = { ...NOTHING_READ };

    const take = <T,>(
      result: PromiseSettledResult<T>,
      key: keyof typeof absent,
      apply: (value: T) => void,
    ) => {
      if (result.status === 'fulfilled') {
        apply(result.value);
        answered[key] = true;
        return;
      }
      if (isMissingRoute(result.reason)) {
        absent[key] = true;
        return;
      }
      failures.push(
        result.reason instanceof Error ? result.reason.message : `Could not read the ${key}`,
      );
    };

    let loadedBoxes: BoxRow[] = [];
    take(boxRes, 'boxes', (v) => {
      loadedBoxes = v.boxes;
      setBoxes(v.boxes);
    });
    take(stationRes, 'stations', (v) => setStations(v.stations));
    take(credentialRes, 'credentials', (v) => setCredentials(v.credentials));

    // Devices are asked for per box, never per branch — a printer belongs to
    // the box it is plugged into. One request per box, and a box whose request
    // fails does not fail the page: it keeps whatever was last read for it,
    // marked stale, or says it could not be read if there is nothing to keep.
    //
    // What it must NOT do is contribute an empty list, which is what it used to
    // do. An empty list is indistinguishable on screen from a box with nothing
    // plugged in, and the drawer's panels then state that as fact — so a failed
    // request became "No simulated printer on this box" and sent somebody to
    // check a box that was fine. `readDevices` carries the difference.
    await Promise.all(loadedBoxes.map((box) => readDevices(box.id)));

    setMissing(absent);
    setRead(answered);
    setError(failures[0] ?? null);
    setLoading(false);
  }, [branchId, readDevices]);

  useEffect(() => {
    void load();
  }, [load]);

  // Scoped to the boxes this branch currently has, so a box that has gone does
  // not go on contributing devices to counts and pickers.
  const devices = useMemo(
    () => boxes.flatMap((box) => deviceLists[box.id]?.devices ?? []),
    [boxes, deviceLists],
  );

  const deviceList = useCallback(
    (boxId: string): BoxDeviceList => deviceLists[boxId] ?? UNREAD_DEVICES,
    [deviceLists],
  );

  return {
    boxes,
    stations,
    devices,
    deviceList,
    retryDevices: (boxId: string) => void readDevices(boxId),
    credentials,
    missing,
    read,
    loading,
    error,
    reload: () => void load(),
  };
}

/** No read has answered yet — for a new branch, and before the first answer. */
const NOTHING_READ = { boxes: false, stations: false, credentials: false };

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

/**
 * One box as one equal card: what it is, where it stands, and whether it is
 * still talking to us. The name is the button that opens its drawer.
 */
function BoxCard({
  box,
  deviceCount,
  stationCount,
  timezone,
  onOpen,
}: {
  box: BoxRow;
  deviceCount: number;
  stationCount: number;
  timezone?: string | null;
  onOpen: () => void;
}) {
  const vitals = boxVitals(box);
  const tone = boxTone(box, vitals.heartbeatAgeSeconds);
  const devices = box.deviceCount ?? deviceCount;
  const stations = box.stationCount ?? stationCount;

  return (
    <li
      className={cn(
        'min-w-0 flex flex-col gap-3 rounded-[20px] border border-card-border bg-card p-[22px]',
        box.archived && 'opacity-60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-primary/10 text-primary">
          <Cpu className="w-5 h-5" aria-hidden="true" />
        </span>
        <span className="flex flex-wrap justify-end gap-1.5">
          {box.archived && <Tag upper>archived</Tag>}
          <Tag upper variant="mint">
            {boxRoleWord(box.role)}
          </Tag>
        </span>
      </div>

      <div className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          className="text-left text-[15.5px] font-bold break-words hover:underline underline-offset-4"
        >
          {box.name}
        </button>
        <p className="text-[12.5px] text-muted-foreground break-words">
          <span className="font-mono">{box.slot}</span>
          {box.hostname && (
            <>
              {' · '}
              <span className="font-mono break-all">{box.hostname}</span>
            </>
          )}
          {vitals.agentVersion && ` · agent ${vitals.agentVersion}`}
        </p>
      </div>

      <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {devices} device{devices === 1 ? '' : 's'} · {stations} station{stations === 1 ? '' : 's'}
        </span>
        {vitals.uptimeSeconds !== null && <span>up {elapsed(vitals.uptimeSeconds)}</span>}
        {vitals.outboxDepth !== null && <span>outbox {vitals.outboxDepth}</span>}
      </p>

      {box.claimCodeOutstanding && (
        <p className="text-xs text-muted-foreground">
          A claim code is outstanding
          {box.claimCodeExpiresAt ? ` until ${formatWhen(box.claimCodeExpiresAt, timezone)}` : ''} — the
          box registers itself the first time it boots with it.
        </p>
      )}

      <CardFoot>
        <span className={cn('inline-flex min-w-0 items-center gap-[7px] font-semibold', TONE_INK[tone])}>
          <StatusMark tone={tone} />
          <span className="min-w-0">
            {boxStatusWord(box.status)} ·{' '}
            {vitals.heartbeatAgeSeconds === null
              ? 'never reported'
              : `heartbeat ${elapsed(vitals.heartbeatAgeSeconds)} old`}
          </span>
        </span>
        <button type="button" onClick={onOpen} className="font-semibold text-primary-ink hover:underline underline-offset-4">
          Open →
        </button>
      </CardFoot>
    </li>
  );
}

/**
 * What the mark beside a box means. The status column is the watchdog's
 * verdict and it is the one that opens alerts, but a box whose heartbeat has
 * simply gone quiet is worth showing as amber here before the watchdog has
 * caught up — the page is refreshed by hand and the watchdog runs on a timer.
 */
function boxTone(box: BoxRow, heartbeatAgeSeconds: number | null): Tone {
  if (
    box.status === 'online' &&
    heartbeatAgeSeconds !== null &&
    heartbeatAgeSeconds > HEARTBEAT_LATE_AFTER_S
  ) {
    return 'warn';
  }
  return toneForBoxStatus(box.status);
}

function AddBoxButton({ branchId, onAdded }: { branchId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        className="h-9 gap-2 rounded-full px-4 font-bold"
        disabled={!branchId}
        title={branchId ? undefined : 'Choose a branch first'}
        onClick={() => setOpen(true)}
      >
        <Plus className="w-4 h-4" />
        Add a box
      </Button>
      {open && <AddBoxPanel branchId={branchId} onClose={() => setOpen(false)} onAdded={onAdded} />}
    </>
  );
}

function AddBoxPanel({
  branchId,
  onClose,
  onAdded,
}: {
  branchId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [name, setName] = useState('');
  const [slot, setSlot] = useState('');
  const [role, setRole] = useState<BoxRole>('counter');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // The box id is kept as well as the code, because a request that was replayed
  // answers with the box and no code — and issuing a fresh one needs the id.
  const [created, setCreated] = useState<{
    boxId: string;
    code?: string;
    expiresAt?: string;
  } | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const result = await fleetApi.createBox(branchId, {
        name: name.trim(),
        slot: slot.trim(),
        role,
      });
      onAdded();
      setCreated({ boxId: result.box.id, code: result.claimCode, expiresAt: result.expiresAt });
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The box could not be added');
    } finally {
      setBusy(false);
    }
  };

  const issueFresh = async () => {
    if (!created) return;
    setBusy(true);
    setFailed(null);
    try {
      const result = await fleetApi.reissueClaimCode(created.boxId);
      onAdded();
      setCreated({ boxId: created.boxId, code: result.claimCode, expiresAt: result.expiresAt });
      if (!result.claimCode) setFailed('That request was replayed too. Press it once more.');
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not issue a claim code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Add a box" onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        This creates the row and its claim code. The Pi redeems the code once, at first boot, and
        mints its own secret from it.
      </p>

      {created?.code ? (
        <>
          <OneTimeCode
            label="Claim code"
            code={created.code}
            expiresAt={created.expiresAt}
            detail="Only its hash is kept, and it is left out of the response the API files against this request — so this is the one time it can be read. Issue a new one from the box if it is lost."
          />
          <Button onClick={onClose}>Done</Button>
        </>
      ) : created ? (
        <>
          <CodeWithheld
            what="The box was added, but its claim code is not in this answer."
            detail="That happens when the same request reaches the API twice — a double press, or a retry on a flaky connection. The code was minted once and only its hash was kept, so it cannot be read back. Issue a fresh one; it supersedes the first."
          />
          {failed && <p className="text-sm text-destructive break-words">{failed}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Later
            </Button>
            <Button onClick={() => void issueFresh()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Issue a new claim code
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field label="Name" hint="What a person calls it: “Counter 1 box”.">
            <TextInput value={name} onChange={setName} placeholder="Counter 1 box" />
          </Field>
          <Field
            label="Slot"
            hint="The position on site. It stays put when a dead Pi is swapped for the spare, and the stations follow it."
          >
            <TextInput value={slot} onChange={setSlot} placeholder="counter-1" />
          </Field>
          <Field label="Role">
            <Select
              value={role}
              onChange={(v) => setRole(v as BoxRole)}
              options={BOX_ROLES.map((r) => ({ value: r, label: boxRoleWord(r) }))}
            />
          </Field>
          {failed && <p className="text-sm text-destructive break-words">{failed}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy || !name.trim() || !slot.trim()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Add the box
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Stations
// ---------------------------------------------------------------------------

const STATION_ICONS: Record<string, LucideIcon> = {
  till: CreditCard,
  kiosk: Tablet,
  gate: DoorOpen,
  display: Monitor,
  booth: FerrisWheel,
};

/** One station as one equal card; its name opens the editor. */
function StationCard({
  station,
  branchLabel,
  onOpen,
}: {
  station: StationRow;
  branchLabel: string;
  onOpen: () => void;
}) {
  const capabilities = station.capabilities ?? [];
  const deviceCount = station.devices?.length ?? 0;
  const Icon = STATION_ICONS[station.kind] ?? Router;
  const tone: Tone = station.archived ? 'idle' : station.boxId ? 'ok' : 'warn';
  return (
    <li
      className={cn(
        'min-w-0 flex flex-col gap-3 rounded-[20px] border border-card-border bg-card p-[22px]',
        station.archived && 'opacity-60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-primary/10 text-primary">
          <Icon className="w-5 h-5" aria-hidden="true" />
        </span>
        <span className="flex flex-wrap justify-end gap-1.5">
          {station.archived && <Tag upper>archived</Tag>}
          {station.codePrefix && <Tag variant="mint">{station.codePrefix}</Tag>}
          <Tag upper>{stationKindWord(station.kind)}</Tag>
        </span>
      </div>

      <div className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          className="text-left text-[15.5px] font-bold break-words hover:underline underline-offset-4"
        >
          {station.name}
        </button>
        <p className="text-[12.5px] text-muted-foreground break-words">
          {deviceCount > 0 ? `${deviceCount} device${deviceCount === 1 ? '' : 's'} assigned` : 'no device assigned'}
          {' · '}
          <span className="tabular-nums">config v{station.configVersion ?? 1}</span>
        </p>
      </div>

      {capabilities.length > 0 && (
        <p className="text-xs text-muted-foreground">{capabilities.map(capabilityWord).join(', ')}</p>
      )}

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        {station.accessScope === 'selected_staff' && <ShieldOff className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
        <span className="min-w-0 break-words">
          {accessSentence(
            { accessScope: station.accessScope, staffCount: station.staff?.length ?? 0 },
            branchLabel,
          )}
        </span>
      </p>

      <CardFoot>
        <span className={cn('inline-flex min-w-0 items-center gap-[7px] font-semibold', TONE_INK[tone])}>
          <StatusMark tone={tone} />
          <span className="min-w-0 break-words">
            {station.boxId ? `on ${station.boxName ?? 'its box'}` : 'no box assigned'}
          </span>
        </span>
        <button type="button" onClick={onOpen} className="font-semibold text-primary-ink hover:underline underline-offset-4">
          Edit →
        </button>
      </CardFoot>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Paired screens
// ---------------------------------------------------------------------------

function PairedScreens({
  credentials,
  missing,
  stations,
  displayStations,
  snapshotStations,
  canReadUnassignedSnapshots,
  boxLogStations,
  stationName,
  timezone,
  canPair,
  canRevoke,
  onChanged,
  onOpenBoxLog,
}: {
  credentials: CredentialRow[];
  missing: boolean;
  stations: StationRow[];
  displayStations: StationRow[];
  snapshotStations: StationRow[];
  canReadUnassignedSnapshots: boolean;
  boxLogStations: StationRow[];
  stationName: (id: string | null | undefined) => string | null;
  timezone?: string | null;
  canPair: boolean;
  canRevoke: boolean;
  onChanged: () => void;
  onOpenBoxLog: (stationId: string) => void;
}) {
  const [pairing, setPairing] = useState(false);
  const [pairingDisplay, setPairingDisplay] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const snapshot = credentials.find((credential) => credential.id === snapshotId);
  const tested = credentials.find(credential => credential.id === testId);
  const shown = credentials.filter((c) => showRevoked || !c.revokedAt);
  const canReadSnapshot = (credential: CredentialRow) => credential.kind === 'display' && (
    credential.stationId
      ? snapshotStations.some((station) => station.id === credential.stationId)
      : canReadUnassignedSnapshots
  );

  return (
    <CardShell
      span={12}
      icon={MonitorSmartphone}
      title="Paired screens"
      note="a customer display, a kiosk or a booth holds a credential of its own rather than a person's session; a box pairs with a claim code instead"
      actions={
        !missing ? (
          <>
            {credentials.some((credential) => credential.revokedAt) && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-full px-3.5"
                onClick={() => setShowRevoked((value) => !value)}
              >
                {showRevoked ? 'Hide revoked' : 'Show revoked'}
              </Button>
            )}
            {displayStations.length > 0 && (
              <Button
                size="sm"
                className="h-9 gap-2 rounded-full px-4 font-bold"
                onClick={() => setPairingDisplay(true)}
              >
                <Plus className="w-4 h-4" />
                Pair a display
              </Button>
            )}
            {canPair && stations.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-2 rounded-full px-4"
                onClick={() => setPairing(true)}
              >
                <Plus className="w-4 h-4" />
                Pair a screen
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {missing ? (
        <RouteUnavailable what="Pairing" />
      ) : shown.length === 0 ? (
        <EmptyNote
          className="py-3"
          icon={MonitorSmartphone}
          title="Nothing is paired yet"
          detail="Open the customer display to get its code, then pair it to a station here. Kiosks and booths use Pair a screen."
        />
      ) : (
        <StripedList>
          {shown.map((credential) => (
            <CredentialRowItem
              key={credential.id}
              credential={credential}
              stationLabel={stationName(credential.stationId)}
              timezone={timezone}
              canRevoke={canRevoke}
              canSnapshot={canReadSnapshot(credential)}
              onSnapshot={() => setSnapshotId(credential.id)}
              canTest={credential.kind === 'display' && !!credential.pairedAt && !credential.revokedAt
                && !credential.pairingOutstanding && displayStations.some(station => station.id === credential.stationId)}
              onTest={() => setTestId(credential.id)}
              canBoxLog={credential.kind === 'display' && boxLogStations.some(station => station.id === credential.stationId)}
              onBoxLog={() => { if (credential.stationId) onOpenBoxLog(credential.stationId); }}
              onChanged={onChanged}
            />
          ))}
        </StripedList>
      )}

      {pairing && (
        <PairPanel stations={stations} onClose={() => setPairing(false)} onPaired={onChanged} />
      )}
      {pairingDisplay && displayStations.length > 0 && (
        <Dialog title="Pair a display" onClose={() => setPairingDisplay(false)}>
          <DisplayPairPanel
            stations={displayStations}
            onClose={() => setPairingDisplay(false)}
            onPaired={onChanged}
          />
        </Dialog>
      )}
      {snapshot && canReadSnapshot(snapshot) && (
          <Dialog
            title={`${snapshot.label ?? 'Display'} snapshot`}
            onClose={() => setSnapshotId(null)}
          >
            <DisplaySnapshotPanel
              key={`${snapshot.id}:${snapshot.stationId ?? 'unassigned'}`}
              credentialId={snapshot.id}
              stationId={snapshot.stationId ?? null}
              stationLabel={stationName(snapshot.stationId) ?? 'the selected station'}
              timezone={timezone}
              revoked={Boolean(snapshot.revokedAt)}
            />
            <Button variant="outline" onClick={() => setSnapshotId(null)}>
              Close
            </Button>
          </Dialog>
        )}
      {tested?.stationId && !tested.revokedAt && displayStations.some(station => station.id === tested.stationId) && (
        <Dialog title={`${tested.label ?? 'Display'} test intent`} onClose={() => setTestId(null)}>
          <DisplayIntentTestPanel key={`${tested.id}:${tested.stationId}`} stationId={tested.stationId} displayId={tested.id}
            onOpenBoxLog={boxLogStations.some(station => station.id === tested.stationId) ? () => {
              setTestId(null); onOpenBoxLog(tested.stationId!);
            } : undefined} />
          <Button variant="outline" onClick={() => setTestId(null)}>Close</Button>
        </Dialog>
      )}
    </CardShell>
  );
}

function CredentialRowItem({
  credential,
  stationLabel,
  timezone,
  canRevoke,
  canSnapshot,
  onSnapshot,
  onChanged,
  canTest,
  onTest,
  canBoxLog,
  onBoxLog,
}: {
  credential: CredentialRow;
  stationLabel: string | null;
  timezone?: string | null;
  canRevoke: boolean;
  canSnapshot: boolean;
  onSnapshot: () => void;
  onChanged: () => void;
  canTest: boolean;
  onTest: () => void;
  canBoxLog: boolean;
  onBoxLog: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const outstanding = credential.pairingOutstanding || !credential.pairedAt;

  const revoke = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await fleetApi.revokeCredential(credential.id, 'Revoked from the console');
      onChanged();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not revoke it');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusMark tone={credential.revokedAt || outstanding ? 'idle' : 'ok'} />
        <span className="text-sm font-semibold min-w-0 break-words">
          {credential.label ?? credentialKindWord(credential.kind)}
        </span>
        <Tag>{credentialKindWord(credential.kind)}</Tag>
        {credential.revokedAt && <StatusChip tone="idle">Access revoked</StatusChip>}
        {stationLabel && <span className="text-sm text-muted-foreground">on {stationLabel}</span>}
        {canSnapshot && (
          <Button variant="outline" size="sm" className="ml-auto rounded-full bg-card" onClick={onSnapshot}>
            Snapshot
          </Button>
        )}
        {canTest && (
          <Button variant="outline" size="sm" className="rounded-full bg-card" onClick={onTest}>
            Send test intent
          </Button>
        )}
        {canBoxLog && (
          <Button variant="outline" size="sm" className="rounded-full bg-card" onClick={onBoxLog}>
            Open Box refusal log
          </Button>
        )}
        {canRevoke && !credential.revokedAt && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto rounded-full bg-card"
            onClick={() => void revoke()}
            disabled={busy}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Revoke
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {credential.revokedAt
          ? `Revoked ${formatWhen(credential.revokedAt, timezone)}.`
          : outstanding
            ? `Waiting to be paired${credential.pairingCodeExpiresAt ? `; the code expires ${formatWhen(credential.pairingCodeExpiresAt, timezone)}` : ''}.`
            : `Paired ${formatWhen(credential.pairedAt, timezone)}${credential.lastSeenAt ? `, last seen ${timeAgo(credential.lastSeenAt)}` : ', never seen since'}.`}
      </p>
      {credential.kind === 'display' && (
        <div className="mt-1 text-xs text-muted-foreground space-y-1">
          <p>{credential.lastSeenAt
              ? `Last seen ${formatWhen(credential.lastSeenAt, timezone)} (${timeAgo(credential.lastSeenAt)}).`
              : 'Not seen since pairing.'}</p>
          <p>{credential.lastRejectedAt
              ? `Last protected call rejected ${formatWhen(credential.lastRejectedAt, timezone)}${credential.lastRejectedCode ? ` · ${credential.lastRejectedCode}` : ''}.`
              : 'No rejected protected call recorded.'}</p>
        </div>
      )}
      {failed && <p className="mt-1 text-sm text-destructive">{failed}</p>}
    </li>
  );
}

function PairPanel({
  stations,
  onClose,
  onPaired,
}: {
  stations: StationRow[];
  onClose: () => void;
  onPaired: () => void;
}) {
  const [stationId, setStationId] = useState(stations[0]?.id ?? '');
  const [kind, setKind] = useState<CredentialKind>('kiosk');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // The credential as well as the code: a replayed request answers with the
  // credential and no code, and the credential is then the thing to supersede.
  const [paired, setPaired] = useState<{
    credentialId: string;
    code?: string;
    expiresAt?: string;
  } | null>(null);

  const mint = async () => {
    const result = await fleetApi.pair(stationId, { kind, label: label.trim() || undefined });
    onPaired();
    setPaired({
      credentialId: result.credential.id,
      code: result.pairingCode,
      expiresAt: result.expiresAt,
    });
    if (!result.pairingCode && paired) {
      setFailed('That request was replayed too. Press it once more.');
    }
  };

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await mint();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The screen could not be paired');
    } finally {
      setBusy(false);
    }
  };

  const pairAgain = async () => {
    if (!paired) return;
    setBusy(true);
    setFailed(null);
    try {
      try {
        // A credential whose code nobody saw can never be redeemed, so it is
        // revoked rather than left in Paired screens waiting for a screen that
        // is never coming.
        await fleetApi.revokeCredential(paired.credentialId, 'Superseded: its code was not shown');
      } catch {
        // Not worth stopping for. Somebody is standing at the screen waiting
        // for a code, and the stale row can be revoked from the list below.
      }
      await mint();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The screen could not be paired');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Pair a screen" onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        The screen opens its address, someone types this code once, and it holds a secret of its own
        from then on — bound to this station and nothing else.
      </p>

      {paired?.code ? (
        <>
          <OneTimeCode
            label="Pairing code"
            code={paired.code}
            expiresAt={paired.expiresAt}
            detail="Only its hash is kept, and it is left out of the response the API files against this request. If it is lost, revoke the credential and pair again."
          />
          <Button onClick={onClose}>Done</Button>
        </>
      ) : paired ? (
        <>
          <CodeWithheld
            what="The credential was created, but its pairing code is not in this answer."
            detail="That happens when the same request reaches the API twice — a double press, or a retry on a flaky connection. The code was minted once and only its hash was kept, so it cannot be read back. Pairing again revokes that credential and mints a fresh code."
          />
          {failed && <p className="text-sm text-destructive break-words">{failed}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Later
            </Button>
            <Button onClick={() => void pairAgain()} disabled={busy}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Pair again
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field label="Station">
            <Select
              value={stationId}
              onChange={setStationId}
              options={stations.map((s) => ({
                value: s.id,
                label: `${s.name} — ${stationKindWord(s.kind)}`,
              }))}
            />
          </Field>
          <Field label="What is being paired">
            <Select
              value={kind}
              onChange={(v) => setKind(v as CredentialKind)}
              options={PAIRABLE_KINDS.filter((k) => k !== 'display').map((k) => ({
                value: k,
                label: credentialKindWord(k),
              }))}
            />
          </Field>
          <Field label="Label" hint="Which screen this is, so the right one can be revoked later.">
            <TextInput value={label} onChange={setLabel} placeholder="Counter 1 iPad" />
          </Field>
          {failed && <p className="text-sm text-destructive break-words">{failed}</p>}
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={busy || !stationId}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Get a code
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

/**
 * Why there is no code on screen when somebody is waiting to read one out.
 *
 * A one-time code is deliberately left out of the response the API files
 * against an Idempotency-Key, so a request that arrived twice answers with the
 * record and nothing else. Closing the panel on that would look like success
 * and lose the code; saying it plainly, and offering a fresh one, is the only
 * honest way out of it.
 */
function CodeWithheld({ what, detail }: { what: string; detail: string }) {
  return (
    <div
      className="rounded-xl border p-4"
      style={{
        borderColor: 'hsl(var(--status-warn) / 0.35)',
        backgroundColor: 'hsl(var(--status-warn) / 0.08)',
      }}
    >
      <p className="text-sm font-semibold">{what}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

/**
 * A short form over the page. The drawer is for one record's detail; these two
 * are one question each, and a slide-over for "name this box" would be a lot
 * of furniture for three fields.
 *
 * IT IS MOUNTED ON THE BODY, and that is the whole of SCRUM-377.
 *
 * Both of the buttons that open one — "Add a box" and "Pair a screen" — sit in
 * a `Panel`, which is a `<section>` carrying `backdrop-blur-sm`. A
 * backdrop-filter makes that section the containing block for fixed-position
 * descendants AND a stacking context of its own, so a dialog rendered where it
 * is written resolved `fixed inset-0` to the Boxes panel's box — 1022×271 at
 * y=57, not the 1440×1024 viewport — and `z-50` could not lift it above the
 * next panel. Cancel and "Add the box" landed under the Stations card:
 * `elementFromPoint` at their centres returned that card's heading, a real
 * mouse press went to the panel behind, and nobody could add a box from the
 * Console at all. The portal puts the same markup on `document.body`, where
 * `fixed` means the viewport again and z-50 is in the page's own stacking
 * order — the reason `Drawer` was never affected, since it is mounted beside
 * the panels rather than inside one.
 */
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[90dvh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border bg-background shadow-2xl p-5 flex flex-col gap-4">
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}
