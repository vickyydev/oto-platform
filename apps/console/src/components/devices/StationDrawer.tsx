import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  fleetApi,
  mergeRouting,
  staffCandidates,
  STATION_CAPABILITIES,
  STATION_KINDS,
  type BoxRow,
  type BranchStaffMember,
  type PaymentRouting,
  type StationAccessScope,
  type StationCapability,
  type StationDeviceRole,
  type StationKind,
  type StationRow,
  type StationWrite,
} from '@/api/fleet';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/Drawer';
import { EmptyState, ErrorNote, Loading } from '@/components/Panel';
import { Chip } from '@/components/Status';
import { CheckRow, ChoiceRow, Field, NumberInput, Select, Step, TextInput } from '@/components/Form';
import type { BoxDeviceList } from '@/lib/deviceList';
import {
  accessSentence,
  capabilityWord,
  deviceKindWord,
  deviceRoleWord,
  roleAccepts,
  rolesForStationKind,
  stationKindWord,
} from '@/lib/fleetWords';

/**
 * Setting a station up, in the order the park described it.
 *
 * The box first, because it is a machine already standing at a counter. Then
 * what the station is. Then its devices — and only ever the ones that box
 * reported, because a printer is reachable through the box it is plugged into
 * and nowhere else. Then how money reaches it. And last, who may use it,
 * chosen from the staff of that branch or left open to all of them.
 *
 * Staff never see this screen. A station is set up by a manager or an
 * administrator; the people who work at it sign in, pick one from a list, and
 * that is the whole of their involvement.
 */
export function StationDrawer({
  station,
  branchId,
  branchLabel,
  boxes,
  deviceList,
  onRetryDevices,
  canEdit,
  onClose,
  onSaved,
}: {
  /** Null for a station that does not exist yet. */
  station: StationRow | null;
  branchId: string;
  branchLabel: string;
  boxes: BoxRow[];
  /**
   * The chosen box's devices, and whether that list can be believed. Step 3
   * offers devices and step 1 explains an empty step 3, and neither may say
   * "this box has none" on the strength of a read that has not come back.
   */
  deviceList: (boxId: string) => BoxDeviceList;
  onRetryDevices: (boxId: string) => void;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [boxId, setBoxId] = useState(station?.boxId ?? boxes[0]?.id ?? '');
  const [name, setName] = useState(station?.name ?? '');
  const [kind, setKind] = useState<StationKind>((station?.kind as StationKind) ?? 'till');
  const [codePrefix, setCodePrefix] = useState(station?.codePrefix ?? '');
  const [capabilities, setCapabilities] = useState<StationCapability[]>(
    (station?.capabilities as StationCapability[]) ?? [],
  );
  const [assignments, setAssignments] = useState<Partial<Record<StationDeviceRole, string | null>>>(
    () => initialAssignments(station),
  );
  const [routing, setRouting] = useState<PaymentRouting>(station?.paymentRouting ?? {});
  const [walletCap, setWalletCap] = useState<number | null>(station?.offlineWalletCapSatang ?? null);
  const [accessScope, setAccessScope] = useState<StationAccessScope>(
    (station?.accessScope as StationAccessScope) ?? 'all_staff',
  );
  const [staffIds, setStaffIds] = useState<string[]>(
    station?.staff?.map((s) => s.accountId) ?? [],
  );

  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const boxList = deviceList(boxId);
  const boxDevices = useMemo(
    () => boxList.devices.filter((d) => !d.archived && d.boxId === boxId),
    [boxList, boxId],
  );
  const roles = rolesForStationKind(kind);
  const takesMoney = kind === 'till' || kind === 'kiosk' || kind === 'booth';

  const write = (): StationWrite => ({
    name: name.trim(),
    kind,
    boxId: boxId || null,
    capabilities: kind === 'till' ? capabilities : [],
    accessScope,
    // The whole list every time, not a delta: one call, one audit row, and a
    // before and after that reads as what it is.
    staffAccountIds: accessScope === 'selected_staff' ? staffIds : [],
    devices: Object.entries(assignments)
      .filter(([, deviceId]) => Boolean(deviceId))
      .map(([role, deviceId]) => ({ role: role as StationDeviceRole, deviceId: deviceId as string })),
    codePrefix: codePrefix.trim().toUpperCase() || null,
    // Merged rather than replaced: the routing document is shared with tenders
    // this page does not know about yet, and sending only what it understands
    // would delete the rest.
    paymentRouting: takesMoney ? mergeRouting(station?.paymentRouting, routing) : null,
    offlineWalletCapSatang: walletCap,
  });

  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      if (station) await fleetApi.updateStation(station.id, write());
      else await fleetApi.createStation(branchId, write());
      onSaved();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The station could not be saved');
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!station) return;
    setBusy(true);
    setFailed(null);
    try {
      await fleetApi.archiveStation(station.id);
      onSaved();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The station could not be archived');
    } finally {
      setBusy(false);
    }
  };

  const ready = name.trim().length > 0 && boxId.length > 0;

  return (
    <Drawer
      title={station ? station.name : 'New station'}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Chip>{stationKindWord(kind)}</Chip>
          {station && <span>config v{station.configVersion ?? 1}</span>}
          <span>at {branchLabel}</span>
        </span>
      }
      onClose={onClose}
      footer={
        canEdit ? (
          <div className="flex flex-wrap gap-2 justify-end">
            {station && !station.archived && (
              <Button
                variant="outline"
                size="sm"
                className="mr-auto"
                disabled={busy}
                onClick={() => void archive()}
              >
                Archive this station
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={busy || !ready}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {station ? 'Save the station' : 'Create the station'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Read only — changing a station needs{' '}
            <code className="font-mono text-xs">admin:station:update</code>.
          </p>
        )
      }
    >
      {failed && <ErrorNote message={failed} />}

      {station && (
        <p className="text-xs text-muted-foreground">
          Saving bumps the config version. The box compares that number on its next poll and applies
          the whole bundle, so "which devices is this till using" has one answer rather than a guess.
        </p>
      )}

      <Step
        n={1}
        title="The box"
        detail="Pick the machine this station runs on. Everything it can print or scan with comes from that box."
      >
        <Field label="Box">
          <Select
            value={boxId}
            onChange={(next) => {
              setBoxId(next);
              // Assignments name devices on the old box, and a device is
              // reachable only through its own box — so they cannot follow.
              setAssignments({});
            }}
            placeholder={boxes.length === 0 ? 'No box at this branch yet' : undefined}
            disabled={!canEdit}
            options={boxes.map((b) => ({ value: b.id, label: `${b.name} — ${b.slot}` }))}
          />
        </Field>
        {boxId && boxDevices.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {boxList.state === 'unread'
              ? "Reading this box's devices…"
              : boxList.state === 'failed'
                ? "This box's devices could not be read, so step 3 has nothing to offer — which is not the same as this box having none. Any assignment made now would be made blind."
                : boxList.state === 'stale'
                  ? 'This box reported no devices when this list was last read, and the refresh since has failed.'
                  : 'This box has reported no devices yet, so step 3 has nothing to offer. The station can be created anyway and given its devices when they appear.'}
          </p>
        )}
        {boxId && boxList.state === 'failed' && !boxList.refreshing && (
          <button
            type="button"
            onClick={() => onRetryDevices(boxId)}
            className="self-start text-xs font-semibold underline underline-offset-4"
          >
            Try reading them again
          </button>
        )}
      </Step>

      <Step n={2} title="What this station is">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" hint="What staff see in their picker.">
            <TextInput
              value={name}
              onChange={setName}
              placeholder="Reception Till 1"
              disabled={!canEdit}
            />
          </Field>
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(v) => setKind(v as StationKind)}
              disabled={!canEdit}
              options={STATION_KINDS.map((k) => ({ value: k, label: stationKindWord(k) }))}
            />
          </Field>
          <Field
            label="Code prefix"
            hint="Leads every band code and receipt number this station mints. Two live stations cannot share one."
          >
            <TextInput
              value={codePrefix}
              onChange={(v) => setCodePrefix(v.toUpperCase())}
              placeholder="T1"
              maxLength={6}
              disabled={!canEdit}
            />
          </Field>
        </div>

        {kind === 'till' && (
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
              What it sells
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Leave all of them unticked for a till that does everything — which is how a station with
              no answer here has always behaved.
            </p>
            <div className="mt-1">
              {STATION_CAPABILITIES.map((capability) => (
                <CheckRow
                  key={capability}
                  checked={capabilities.includes(capability)}
                  disabled={!canEdit}
                  label={capabilityWord(capability)}
                  onChange={(on) =>
                    setCapabilities((prev) =>
                      on ? [...prev, capability] : prev.filter((c) => c !== capability),
                    )
                  }
                />
              ))}
            </div>
          </div>
        )}
      </Step>

      <Step
        n={3}
        title="Its devices"
        detail="One device per job, offered from this box only. A job left unset simply is not available at this station."
      >
        {roles.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            A customer display drives nothing of its own — it is a screen paired to a till, and the
            till's devices are the ones that act.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {roles.map((role) => {
              const options = boxDevices
                .filter((d) => roleAccepts(role, d.kind))
                .map((d) => ({ value: d.id, label: `${d.label} — ${deviceKindWord(d.kind)}` }));
              return (
                <Field key={role} label={deviceRoleWord(role)}>
                  <Select
                    value={assignments[role] ?? ''}
                    onChange={(next) => setAssignments((prev) => ({ ...prev, [role]: next || null }))}
                    placeholder={options.length === 0 ? 'Nothing on this box fits' : 'Not set'}
                    disabled={!canEdit || options.length === 0}
                    options={options}
                  />
                </Field>
              );
            })}
          </div>
        )}
      </Step>

      {takesMoney && (
        <Step n={4} title="How money reaches it">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cards">
              <Select
                value={(routing.card as string) ?? ''}
                onChange={(v) => setRouting((r) => ({ ...r, card: v || undefined }))}
                placeholder="Not set"
                disabled={!canEdit}
                options={[
                  { value: 'card_terminal', label: 'The card terminal above' },
                  { value: 'manual', label: 'On the terminal itself, recorded by hand' },
                ]}
              />
            </Field>
            <Field label="QR">
              <Select
                value={(routing.qr as string) ?? ''}
                onChange={(v) => setRouting((r) => ({ ...r, qr: v || undefined }))}
                placeholder="Not set"
                disabled={!canEdit}
                options={[
                  { value: 'gateway', label: 'The payment gateway, on the customer display' },
                  { value: 'qr_terminal', label: 'The QR terminal above' },
                  { value: 'none', label: 'Not taken here' },
                ]}
              />
            </Field>
            <Field label="Cash">
              <Select
                value={(routing.cash as string) ?? ''}
                onChange={(v) => setRouting((r) => ({ ...r, cash: v || undefined }))}
                placeholder="Not set"
                disabled={!canEdit}
                options={[
                  { value: 'cash_drawer', label: 'The drawer above' },
                  { value: 'none', label: 'Not taken here' },
                ]}
              />
            </Field>
            <Field
              label="Offline wallet cap (satang)"
              hint="What one wallet may spend here per day while the box is offline. Empty means the platform default, not “no limit”."
            >
              <NumberInput value={walletCap} onChange={setWalletCap} min={0} disabled={!canEdit} />
            </Field>
          </div>

          {routing.card === 'card_terminal' && !assignments.card_terminal && (
            <p className="text-xs" style={{ color: 'hsl(var(--status-warn))' }}>
              Cards are routed to a card terminal, but no terminal is assigned in step 3 — so a card
              payment here would have nothing to talk to.
            </p>
          )}
          {routing.qr === 'qr_terminal' && !assignments.qr_terminal && (
            <p className="text-xs" style={{ color: 'hsl(var(--status-warn))' }}>
              QR is routed to a terminal, but no QR terminal is assigned in step 3.
            </p>
          )}
        </Step>
      )}

      <Step
        n={takesMoney ? 5 : 4}
        title="Who may use it"
        detail="Either everybody at this branch, or the people named here. Nobody sets a station up for themselves."
      >
        <ChoiceRow
          value={accessScope}
          onChange={(v) => setAccessScope(v as StationAccessScope)}
          disabled={!canEdit}
          options={[
            { value: 'all_staff', label: 'All staff at this branch' },
            { value: 'selected_staff', label: 'Only the people I name' },
          ]}
        />

        <p className="text-xs text-muted-foreground">
          {accessSentence(
            { accessScope, staffCount: accessScope === 'selected_staff' ? staffIds.length : null },
            branchLabel,
          )}
        </p>

        {accessScope === 'selected_staff' && (
          <StaffList
            branchId={station?.branchId ?? branchId}
            selected={staffIds}
            onChange={setStaffIds}
            disabled={!canEdit}
          />
        )}
      </Step>
    </Drawer>
  );
}

/** Role → device id, flattened from the assignments the API sends. */
function initialAssignments(
  station: StationRow | null,
): Partial<Record<StationDeviceRole, string | null>> {
  const out: Partial<Record<StationDeviceRole, string | null>> = {};
  for (const assignment of station?.devices ?? []) {
    out[assignment.role as StationDeviceRole] = assignment.deviceId;
  }
  return out;
}

/**
 * The people who may pick this station.
 *
 * Adding somebody makes the station appear in their picker on their next load;
 * removing somebody takes it out of the next one, and never out of their hands
 * mid-sale — a station taken off a list while it is being worked is kept until
 * that person switches or signs out.
 */
function StaffList({
  branchId,
  selected,
  onChange,
  disabled,
}: {
  branchId: string;
  selected: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const [candidates, setCandidates] = useState<BranchStaffMember[] | null>(null);
  const [branchFiltered, setBranchFiltered] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void staffCandidates(branchId)
      .then((result) => {
        if (cancelled) return;
        setCandidates(result.staff);
        setBranchFiltered(result.branchFiltered);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCandidates([]);
        setFailed(err instanceof Error ? err.message : 'Could not read the staff list');
      });
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const shown = (candidates ?? []).filter((account) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    // An account with a role at this branch and no employee record behind it
    // has no name — searching by phone is how that person is found at all.
    return (
      (account.name ?? '').toLowerCase().includes(q) ||
      (account.phone ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="rounded-xl border p-3 flex flex-col gap-2">
      {!branchFiltered && candidates !== null && (
        <p className="text-xs text-muted-foreground">
          This deployment cannot yet narrow the list to one branch, so every account under the
          operator is shown. Pick from the people who actually work here.
        </p>
      )}

      <Field label="Search">
        <TextInput value={query} onChange={setQuery} placeholder="Name or phone" disabled={disabled} />
      </Field>

      {failed && <p className="text-sm text-destructive">{failed}</p>}

      {candidates === null ? (
        <Loading what="staff" />
      ) : shown.length === 0 ? (
        <EmptyState title={query ? 'Nobody matches that' : 'No staff to choose from'} />
      ) : (
        <div className="max-h-64 overflow-y-auto">
          {shown.map((account) => {
            // Somebody with no employee record behind their account is named by
            // their phone; the line under it then carries the status alone
            // rather than the same number twice.
            const named = Boolean(account.name);
            const label = account.name ?? account.phone ?? account.accountId;
            const under = named ? (account.phone ?? undefined) : undefined;
            const status =
              account.status && account.status !== 'active' ? account.status : undefined;
            return (
              <CheckRow
                key={account.accountId}
                checked={selected.includes(account.accountId)}
                disabled={disabled}
                label={label}
                detail={[under, status].filter(Boolean).join(' — ') || undefined}
                onChange={(on) =>
                  onChange(
                    on
                      ? [...selected, account.accountId]
                      : selected.filter((id) => id !== account.accountId),
                  )
                }
              />
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {selected.length === 0
          ? 'Nobody is ticked, so nobody will see this station.'
          : `${selected.length} ticked. Everybody else's picker will not show this station at all.`}
      </p>
    </div>
  );
}
