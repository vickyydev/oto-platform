import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Loader2, Plus, RefreshCw, ShieldOff } from 'lucide-react';
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
import { EmptyState, ErrorNote, Loading, Panel, RouteUnavailable } from '@/components/Panel';
import { Chip, StatusMark, StatusPill, type Tone } from '@/components/Status';
import { Field, Select, TextInput } from '@/components/Form';
import { BoxDrawer } from '@/components/devices/BoxDrawer';
import { OneTimeCode } from '@/components/devices/OneTimeCode';
import { StationDrawer } from '@/components/devices/StationDrawer';
import { useSession } from '@/auth/SessionContext';
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
  const { me, has } = useSession();
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
  const currentBranchName = branchName(branchId) ?? 'this branch';

  return (
    <div className="flex flex-col gap-4">
      {branches && branches.length > 1 && (
        <Panel>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Branch">
              <Select
                value={branchId}
                onChange={setBranchId}
                options={branches.map((b) => ({ value: b.id, label: b.name }))}
              />
            </Field>
          </div>
        </Panel>
      )}

      {fleet.error && <ErrorNote message={fleet.error} onRetry={fleet.reload} />}

      <Panel
        title="Boxes"
        description="The machine at each counter, gate and booth. It holds the station's sale, drives its devices and keeps working when the internet does not."
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2"
              onClick={fleet.reload}
              disabled={fleet.loading}
            >
              {fleet.loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
              Refresh
            </Button>
            {canRegisterBox && !fleet.missing.boxes && (
              <AddBoxButton branchId={branchId} onAdded={fleet.reload} />
            )}
          </div>
        }
      >
        {fleet.missing.boxes ? (
          <RouteUnavailable
            what="The box register"
            detail="Boxes appear here as soon as the fleet API is deployed to this environment; the virtual box registers itself on first boot."
          />
        ) : fleet.loading && fleet.boxes.length === 0 ? (
          <Loading what="boxes" />
        ) : fleet.boxes.length === 0 ? (
          <EmptyState
            title="No box at this branch yet"
            detail="Add one to get a claim code; the Pi redeems it the first time it boots on site."
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {fleet.boxes.map((box) => (
              <BoxListRow
                key={box.id}
                box={box}
                deviceCount={fleet.devices.filter((d) => d.boxId === box.id && !d.archived).length}
                stationCount={fleet.stations.filter((s) => s.box?.id === box.id && !s.archived).length}
                timezone={timezone}
                onOpen={() => setOpenBox(box)}
              />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Stations"
        description="Where a session is held. Staff sign in, pick one of these and work — they never set one up themselves."
        actions={
          <div className="flex items-center gap-2">
            {fleet.stations.some((s) => s.archived) && (
              <Button variant="outline" size="sm" onClick={() => setShowArchived((v) => !v)}>
                {showArchived ? 'Hide archived' : 'Show archived'}
              </Button>
            )}
            {canCreateStation && !fleet.missing.stations && (
              <Button
                size="sm"
                className="h-9 gap-2"
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
          </div>
        }
      >
        {fleet.missing.stations ? (
          <RouteUnavailable what="The station register" />
        ) : fleet.loading && stations.length === 0 ? (
          <Loading what="stations" />
        ) : stations.length === 0 ? (
          <EmptyState
            title="No stations yet"
            detail="A station names a box, the devices it drives and who may pick it."
          />
        ) : (
          <ul className="flex flex-col divide-y">
            {stations.map((station) => (
              <StationListRow
                key={station.id}
                station={station}
                branchLabel={branchName(station.branchId) ?? currentBranchName}
                onOpen={() => setOpenStation(station)}
              />
            ))}
          </ul>
        )}
      </Panel>

      <PairedScreens
        credentials={fleet.credentials}
        missing={fleet.missing.credentials}
        stations={fleet.stations.filter((s) => !s.archived)}
        stationName={stationName}
        timezone={timezone}
        canPair={canPair}
        canRevoke={canRevoke}
        onChanged={fleet.reload}
      />

      {openBox && (
        <BoxDrawer
          box={openBox}
          devices={fleet.devices.filter((d) => d.boxId === openBox.id)}
          stations={fleet.stations.filter((s) => s.box?.id === openBox.id)}
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
          devices={fleet.devices.filter((d) => !d.archived)}
          canEdit={openStation === 'new' ? canCreateStation : canUpdateStation}
          onClose={() => setOpenStation(null)}
          onSaved={() => {
            setOpenStation(null);
            fleet.reload();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading the branch's fleet
// ---------------------------------------------------------------------------

interface Fleet {
  boxes: BoxRow[];
  stations: StationRow[];
  devices: DeviceRow[];
  credentials: CredentialRow[];
  /** Per list, because the API half of this ticket lands route by route. */
  missing: { boxes: boolean; stations: boolean; credentials: boolean };
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function useFleet(branchId: string): Fleet {
  const [boxes, setBoxes] = useState<BoxRow[]>([]);
  const [stations, setStations] = useState<StationRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [missing, setMissing] = useState({ boxes: false, stations: false, credentials: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      fleetApi.credentials(branchId),
    ]);

    const failures: string[] = [];
    const absent = { boxes: false, stations: false, credentials: false };

    const take = <T,>(
      result: PromiseSettledResult<T>,
      key: keyof typeof absent,
      apply: (value: T) => void,
    ) => {
      if (result.status === 'fulfilled') {
        apply(result.value);
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
    // the box it is plugged into. One request per box, and a box whose devices
    // cannot be read contributes none rather than failing the page.
    const deviceResults = await Promise.allSettled(
      loadedBoxes.map((box) => fleetApi.boxDevices(box.id)),
    );
    setDevices(
      deviceResults.flatMap((r) => (r.status === 'fulfilled' ? r.value.devices : [])),
    );

    setMissing(absent);
    setError(failures[0] ?? null);
    setLoading(false);
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    boxes,
    stations,
    devices,
    credentials,
    missing,
    loading,
    error,
    reload: () => void load(),
  };
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

function BoxListRow({
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
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusMark tone={tone} />
        <button
          type="button"
          onClick={onOpen}
          className="text-sm font-bold min-w-0 break-words text-left hover:underline underline-offset-4"
        >
          {box.name}
        </button>
        <Chip>{boxRoleWord(box.role)}</Chip>
        <StatusPill tone={toneForBoxStatus(box.status)}>{boxStatusWord(box.status)}</StatusPill>
        {box.archived && <Chip>archived</Chip>}
        <span className="text-sm text-muted-foreground ml-auto tabular-nums whitespace-nowrap">
          {vitals.heartbeatAgeSeconds === null
            ? 'never reported'
            : `heartbeat ${elapsed(vitals.heartbeatAgeSeconds)} old`}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-mono">{box.slot}</span>
        {box.hostname && <span className="font-mono break-all">{box.hostname}</span>}
        {vitals.agentVersion && <span>agent {vitals.agentVersion}</span>}
        {vitals.uptimeSeconds !== null && <span>up {elapsed(vitals.uptimeSeconds)}</span>}
        {vitals.outboxDepth !== null && <span>outbox {vitals.outboxDepth}</span>}
        <span>
          {devices} device{devices === 1 ? '' : 's'} · {stations} station{stations === 1 ? '' : 's'}
        </span>
        <button type="button" onClick={onOpen} className="ml-auto font-semibold hover:text-foreground">
          Open
        </button>
      </div>

      {box.claimCodeOutstanding && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          A claim code is outstanding
          {box.claimCodeExpiresAt ? ` until ${formatWhen(box.claimCodeExpiresAt, timezone)}` : ''} — the
          box registers itself the first time it boots with it.
        </p>
      )}
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
        className="h-9 gap-2"
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
  const [claimCode, setClaimCode] = useState<{ code: string; expiresAt?: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const created = await fleetApi.createBox(branchId, {
        name: name.trim(),
        slot: slot.trim(),
        role,
      });
      onAdded();
      if (created.claimCode) {
        setClaimCode({ code: created.claimCode, expiresAt: created.claimCodeExpiresAt });
      } else {
        onClose();
      }
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The box could not be added');
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

      {claimCode ? (
        <>
          <OneTimeCode
            label="Claim code"
            code={claimCode.code}
            expiresAt={claimCode.expiresAt}
            detail="Only its hash is stored, so this is the one time it can be read. Issue a new one from the box if it is lost."
          />
          <Button onClick={onClose}>Done</Button>
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

function StationListRow({
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
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusMark tone={station.archived ? 'idle' : station.box ? 'ok' : 'warn'} />
        <button
          type="button"
          onClick={onOpen}
          className="text-sm font-bold min-w-0 break-words text-left hover:underline underline-offset-4"
        >
          {station.name}
        </button>
        <Chip>{stationKindWord(station.kind)}</Chip>
        {station.codePrefix && <Chip>{station.codePrefix}</Chip>}
        {station.archived && <Chip>archived</Chip>}
        <span className="text-sm text-muted-foreground ml-auto whitespace-nowrap tabular-nums">
          config v{station.configVersion ?? 1}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{station.box ? `on ${station.box.name}` : 'no box assigned'}</span>
        {deviceCount > 0 && (
          <span>
            {deviceCount} device{deviceCount === 1 ? '' : 's'} assigned
          </span>
        )}
        {capabilities.length > 0 && <span>{capabilities.map(capabilityWord).join(', ')}</span>}
        <button type="button" onClick={onOpen} className="ml-auto font-semibold hover:text-foreground">
          Edit
        </button>
      </div>

      <p className="mt-1.5 flex items-start gap-2 text-xs text-muted-foreground">
        {station.accessScope === 'selected_staff' && (
          <ShieldOff className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        )}
        <span className="min-w-0 break-words">
          {accessSentence(
            { accessScope: station.accessScope, staffCount: station.staff?.length ?? 0 },
            branchLabel,
          )}
        </span>
      </p>
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
  stationName,
  timezone,
  canPair,
  canRevoke,
  onChanged,
}: {
  credentials: CredentialRow[];
  missing: boolean;
  stations: StationRow[];
  stationName: (id: string | null | undefined) => string | null;
  timezone?: string | null;
  canPair: boolean;
  canRevoke: boolean;
  onChanged: () => void;
}) {
  const [pairing, setPairing] = useState(false);
  const live = credentials.filter((c) => !c.revokedAt);

  return (
    <Panel
      title="Paired screens"
      description="A customer display, a kiosk or a booth holds a credential of its own rather than a person's session. A box pairs with a claim code instead."
      actions={
        canPair && !missing && stations.length > 0 ? (
          <Button size="sm" className="h-9 gap-2" onClick={() => setPairing(true)}>
            <Plus className="w-4 h-4" />
            Pair a screen
          </Button>
        ) : undefined
      }
    >
      {missing ? (
        <RouteUnavailable what="Pairing" />
      ) : live.length === 0 ? (
        <EmptyState
          title="Nothing is paired yet"
          detail="Pair a screen to get a code; the screen redeems it once and holds a secret of its own afterwards."
        />
      ) : (
        <ul className="flex flex-col divide-y">
          {live.map((credential) => (
            <CredentialRowItem
              key={credential.id}
              credential={credential}
              stationLabel={stationName(credential.stationId)}
              timezone={timezone}
              canRevoke={canRevoke}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}

      {pairing && (
        <PairPanel stations={stations} onClose={() => setPairing(false)} onPaired={onChanged} />
      )}
    </Panel>
  );
}

function CredentialRowItem({
  credential,
  stationLabel,
  timezone,
  canRevoke,
  onChanged,
}: {
  credential: CredentialRow;
  stationLabel: string | null;
  timezone?: string | null;
  canRevoke: boolean;
  onChanged: () => void;
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
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusMark tone={outstanding ? 'idle' : 'ok'} />
        <span className="text-sm font-semibold min-w-0 break-words">
          {credential.label ?? credentialKindWord(credential.kind)}
        </span>
        <Chip>{credentialKindWord(credential.kind)}</Chip>
        {stationLabel && <span className="text-sm text-muted-foreground">on {stationLabel}</span>}
        {canRevoke && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => void revoke()}
            disabled={busy}
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Revoke
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {outstanding
          ? `Waiting to be paired${credential.pairingCodeExpiresAt ? `; the code expires ${formatWhen(credential.pairingCodeExpiresAt, timezone)}` : ''}.`
          : `Paired ${formatWhen(credential.pairedAt, timezone)}${credential.lastSeenAt ? `, last seen ${timeAgo(credential.lastSeenAt)}` : ', never seen since'}.`}
      </p>
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
  const [kind, setKind] = useState<CredentialKind>('display');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt?: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const result = await fleetApi.pair(stationId, { kind, label: label.trim() || undefined });
      onPaired();
      if (result.pairingCode) setCode({ code: result.pairingCode, expiresAt: result.expiresAt });
      else onClose();
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

      {code ? (
        <>
          <OneTimeCode
            label="Pairing code"
            code={code.code}
            expiresAt={code.expiresAt}
            detail="Only its hash is stored. If it is lost, revoke the credential and pair again."
          />
          <Button onClick={onClose}>Done</Button>
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
              options={PAIRABLE_KINDS.map((k) => ({ value: k, label: credentialKindWord(k) }))}
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
 * A short form over the page. The drawer is for one record's detail; these two
 * are one question each, and a slide-over for "name this box" would be a lot
 * of furniture for three fields.
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
  return (
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
    </div>
  );
}
