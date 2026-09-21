import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import {
  boxVitals,
  fleetApi,
  isMissingRoute,
  DEVICE_KINDS,
  DEVICE_TRANSPORTS,
  type BoxCommandKind,
  type BoxCommandRow,
  type BoxHeartbeatRow,
  type BoxLogLine,
  type BoxRow,
  type DeviceKind,
  type DeviceRow,
  type DeviceTransport,
  type StationAssignmentRef,
  type StationRow,
} from '@/api/fleet';
import { Button } from '@/components/ui/button';
import { Drawer } from '@/components/Drawer';
import { EmptyState, Fact, Loading, RouteUnavailable } from '@/components/Panel';
import { Chip, StatusMark, StatusPill } from '@/components/Status';
import { Field, Select, TextInput } from '@/components/Form';
import { OneTimeCode } from '@/components/devices/OneTimeCode';
import { SimulatorPanel } from '@/components/devices/SimulatorPanel';
import { PrintPanel } from '@/components/devices/PrintPanel';
import {
  boxRoleWord,
  boxStatusWord,
  commandWord,
  deviceKindWord,
  deviceRoleWord,
  toneForBoxStatus,
  toneForCommandState,
  toneForPaper,
  toneForReachability,
  transportWord,
} from '@/lib/fleetWords';
import { elapsed, formatExact, formatWhen, millis, timeAgo } from '@/lib/time';

/**
 * One box, everything about it, and the buttons that make it do something.
 *
 * The drawer is arranged the way a person troubleshoots: what this box is,
 * what is plugged into it, what I can ask it to do, what I asked it before,
 * and then the log — which is last because it is the place you go when the
 * four above have not answered the question. Pressing a command mints an
 * action id and carries it into the log filter, so "did my test print reach
 * the printer" is one press and one glance rather than a search through a
 * working box's chatter.
 */
export function BoxDrawer({
  box,
  devices,
  stations,
  timezone,
  canCommand,
  canUpdateBox,
  canCreateDevice,
  canUpdateDevice,
  onClose,
  onChanged,
}: {
  box: BoxRow;
  devices: DeviceRow[];
  stations: StationRow[];
  timezone?: string | null;
  canCommand: boolean;
  canUpdateBox: boolean;
  canCreateDevice: boolean;
  canUpdateDevice: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const vitals = boxVitals(box);
  const [actionFilter, setActionFilter] = useState('');
  const [commandsAt, setCommandsAt] = useState(0);

  return (
    <Drawer
      title={box.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <Chip>{boxRoleWord(box.role)}</Chip>
          <StatusPill tone={toneForBoxStatus(box.status)}>{boxStatusWord(box.status)}</StatusPill>
          <span>
            {vitals.heartbeatAgeSeconds === null
              ? 'has never reported'
              : `heartbeat ${elapsed(vitals.heartbeatAgeSeconds)} old`}
          </span>
        </span>
      }
      onClose={onClose}
    >
      <section>
        <h3 className="text-sm font-bold mb-2">What this box is</h3>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label="Slot">
            <span className="font-mono text-xs">{box.slot}</span>
          </Fact>
          <Fact label="Hostname">
            {box.hostname ? <span className="font-mono text-xs break-all">{box.hostname}</span> : '—'}
          </Fact>
          <Fact label="Agent version">{vitals.agentVersion ?? '—'}</Fact>
          <Fact label="Journal epoch">{box.currentEpoch ?? '—'}</Fact>
          <Fact label="Uptime">{elapsed(vitals.uptimeSeconds)}</Fact>
          <Fact label="Outbox">
            {vitals.outboxDepth === null
              ? '—'
              : `${vitals.outboxDepth} event${vitals.outboxDepth === 1 ? '' : 's'} unsynced`}
          </Fact>
          <Fact label="Clock offset">
            {vitals.clockOffsetMs === null ? '—' : millis(Math.abs(vitals.clockOffsetMs))}
          </Fact>
          <Fact label="Temperature">
            {vitals.tempC === null ? 'not reported' : `${vitals.tempC.toFixed(1)} °C`}
          </Fact>
          <Fact label="Registered">{formatWhen(box.registeredAt, timezone)}</Fact>
          <Fact label="Last heartbeat">{formatExact(box.lastHeartbeatAt, timezone)}</Fact>
        </dl>

        {box.status === 'unclaimed' && (
          <ClaimCodeRow box={box} canUpdateBox={canUpdateBox} timezone={timezone} onChanged={onChanged} />
        )}
      </section>

      <BoxDevices
        box={box}
        devices={devices}
        canCreate={canCreateDevice}
        canUpdate={canUpdateDevice}
        timezone={timezone}
        onChanged={onChanged}
      />

      {canCommand && (
        <BoxControls
          box={box}
          stations={stations}
          outboxDepth={vitals.outboxDepth}
          onSent={(actionId) => {
            if (actionId) setActionFilter(actionId);
            setCommandsAt(Date.now());
            onChanged();
          }}
        />
      )}

      <CommandHistory
        boxId={box.id}
        refreshedAt={commandsAt}
        timezone={timezone}
        onFilterByAction={setActionFilter}
      />

      <BoxLog
        boxId={box.id}
        actionFilter={actionFilter}
        onActionFilterChange={setActionFilter}
        refreshedAt={commandsAt}
        timezone={timezone}
      />

      <Heartbeats boxId={box.id} timezone={timezone} />

      {/* Same `onSent` as the Controls above: a simulator press filters the Box
          log by the action id the API stamped on it, which is how "did my
          paper-out reach the printer" stays one press and one glance. */}
      <SimulatorPanel
        box={box}
        devices={devices}
        canCommand={canCommand}
        onSent={(actionId) => {
          if (actionId) setActionFilter(actionId);
          setCommandsAt(Date.now());
        }}
      />

      {/* What the faults above actually did to paper (S2-06): the queue, and
          the picture the simulator rebuilt from the bytes it was sent. */}
      <PrintPanel box={box} devices={devices} />
    </Drawer>
  );
}

// ---------------------------------------------------------------------------

function ClaimCodeRow({
  box,
  canUpdateBox,
  timezone,
  onChanged,
}: {
  box: BoxRow;
  canUpdateBox: boolean;
  timezone?: string | null;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt?: string } | null>(null);

  const reissue = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const result = await fleetApi.reissueClaimCode(box.id);
      onChanged();
      if (result.claimCode) {
        setCode({ code: result.claimCode, expiresAt: result.expiresAt });
      } else {
        // The API keeps a one-time code out of the body it files against an
        // Idempotency-Key, so a request that arrived twice answers with no
        // code at all. Pressing again mints one and supersedes the last.
        setFailed('That request reached the API twice, so its code cannot be shown. Press again.');
      }
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not issue a claim code');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 flex flex-col gap-3">
      {code ? (
        <OneTimeCode
          label="Claim code"
          code={code.code}
          expiresAt={code.expiresAt}
          detail="Only its hash is kept, and it is left out of the response the API files against this request, so this is the one time it can be read."
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          No Pi has registered against this row yet.
          {box.claimCodeOutstanding
            ? ` A code is outstanding${box.claimCodeExpiresAt ? ` until ${formatWhen(box.claimCodeExpiresAt, timezone)}` : ''}.`
            : ' There is no code outstanding.'}
        </p>
      )}
      {canUpdateBox && (
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => void reissue()} disabled={busy}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Issue a new claim code
          </Button>
          {failed && <span className="text-sm text-destructive">{failed}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Devices on this box
// ---------------------------------------------------------------------------

function BoxDevices({
  box,
  devices,
  canCreate,
  canUpdate,
  timezone,
  onChanged,
}: {
  box: BoxRow;
  devices: DeviceRow[];
  canCreate: boolean;
  canUpdate: boolean;
  timezone?: string | null;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const live = devices.filter((d) => !d.archived);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-bold">Devices on this box</h3>
        {canCreate && !adding && (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdding(true)}>
            <Plus className="w-3.5 h-3.5" />
            Add a device
          </Button>
        )}
      </div>

      <p className="mb-3 text-xs text-muted-foreground">
        A station can only be given devices from its own box — a printer is reachable through the box
        it is plugged into and nowhere else. Anything the box finds by itself appears here on its own;
        a printer at a fixed address on the LAN has to be declared.
      </p>

      {adding && (
        <AddDeviceForm boxId={box.id} onClose={() => setAdding(false)} onAdded={onChanged} />
      )}

      {live.length === 0 ? (
        <EmptyState
          title="This box has reported no devices"
          detail="Until it does, a station on this box has nothing to print or scan with."
        />
      ) : (
        <ul className="flex flex-col divide-y">
          {live.map((device) => (
            <DeviceRowItem
              key={device.id}
              device={device}
              canUpdate={canUpdate}
              timezone={timezone}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DeviceRowItem({
  device,
  canUpdate,
  timezone,
  onChanged,
}: {
  device: DeviceRow;
  canUpdate: boolean;
  timezone?: string | null;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const isPrinter = device.kind.endsWith('printer');

  if (editing) {
    return (
      <li className="py-3 first:pt-0 last:pb-0">
        <EditDeviceForm device={device} onClose={() => setEditing(false)} onSaved={onChanged} />
      </li>
    );
  }

  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusMark tone={toneForReachability(device.reachability)} />
        <span className="text-sm font-semibold min-w-0 break-words">{device.label}</span>
        <Chip>{deviceKindWord(device.kind)}</Chip>
        <Chip>{transportWord(device.transport)}</Chip>
        {isPrinter && device.paperStatus && device.paperStatus !== 'unknown' && (
          <StatusPill tone={toneForPaper(device.paperStatus)}>paper {device.paperStatus}</StatusPill>
        )}
        {canUpdate && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            Edit
          </button>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {device.model && <span>{device.model}</span>}
        {device.protocol && <span className="font-mono">{device.protocol}</span>}
        {device.address && <span className="font-mono break-all">{device.address}</span>}
        {device.terminalId && <span className="font-mono">TID {device.terminalId}</span>}
        {device.serialNumber && <span className="font-mono">SN {device.serialNumber}</span>}
        {device.lastSeenAt && <span title={formatExact(device.lastSeenAt, timezone)}>seen {timeAgo(device.lastSeenAt)}</span>}
      </div>
      {device.lastError && (
        <p className="mt-1 text-xs break-words" style={{ color: 'hsl(var(--status-down))' }}>
          {device.lastError}
        </p>
      )}
    </li>
  );
}

function AddDeviceForm({
  boxId,
  onClose,
  onAdded,
}: {
  boxId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [kind, setKind] = useState<DeviceKind>('receipt_printer');
  const [label, setLabel] = useState('');
  const [transport, setTransport] = useState<DeviceTransport>('lan');
  const [address, setAddress] = useState('');
  const [model, setModel] = useState('');
  const [protocol, setProtocol] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await fleetApi.createDevice(boxId, {
        kind,
        label: label.trim(),
        transport,
        address: address.trim() || undefined,
        model: model.trim() || undefined,
        protocol: protocol.trim() || undefined,
      });
      onAdded();
      onClose();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The device could not be added');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 rounded-xl border bg-muted/20 p-3 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What it is">
          <Select
            value={kind}
            onChange={(v) => setKind(v as DeviceKind)}
            options={DEVICE_KINDS.map((k) => ({ value: k, label: deviceKindWord(k) }))}
          />
        </Field>
        <Field label="Label">
          <TextInput value={label} onChange={setLabel} placeholder="Receipt Printer 1" />
        </Field>
        <Field label="How the box reaches it">
          <Select
            value={transport}
            onChange={(v) => setTransport(v as DeviceTransport)}
            options={DEVICE_TRANSPORTS.map((t) => ({ value: t, label: transportWord(t) }))}
          />
        </Field>
        <Field label="Address" hint="192.168.88.204:9100, or /dev/ttyACM0.">
          <TextInput value={address} onChange={setAddress} placeholder="192.168.88.204:9100" />
        </Field>
        <Field label="Model">
          <TextInput value={model} onChange={setModel} placeholder="Xprinter XP-80" />
        </Field>
        <Field label="Protocol" hint="escpos, tspl2, ghl_linkpos, digio_tlv, hid.">
          <TextInput value={protocol} onChange={setProtocol} placeholder="escpos" />
        </Field>
      </div>
      {failed && <p className="text-sm text-destructive break-words">{failed}</p>}
      <div className="flex gap-2 justify-end">
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={busy || !label.trim()}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Add it
        </Button>
      </div>
    </div>
  );
}

function EditDeviceForm({
  device,
  onClose,
  onSaved,
}: {
  device: DeviceRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(device.label);
  const [address, setAddress] = useState(device.address ?? '');
  const [model, setModel] = useState(device.model ?? '');
  const [protocol, setProtocol] = useState(device.protocol ?? '');
  const [terminalId, setTerminalId] = useState(device.terminalId ?? '');
  const [merchantId, setMerchantId] = useState(device.merchantId ?? '');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [orphaned, setOrphaned] = useState<StationAssignmentRef[] | null>(null);

  const save = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await fleetApi.updateDevice(device.id, {
        label: label.trim(),
        address: address.trim() || null,
        model: model.trim() || null,
        protocol: protocol.trim() || null,
        terminalId: terminalId.trim() || null,
        merchantId: merchantId.trim() || null,
      });
      onSaved();
      onClose();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The device could not be saved');
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const result = await fleetApi.archiveDevice(device.id);
      onSaved();
      const left = result.stillAssignedTo ?? [];
      // A station that was using it has quietly lost that job. The form stays
      // up to say which, because the alternative is a till finding out at the
      // moment somebody is waiting for a receipt.
      if (left.length === 0) onClose();
      else setOrphaned(left);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'The device could not be archived');
    } finally {
      setBusy(false);
    }
  };

  const isTerminal = device.kind === 'terminal';

  if (orphaned) {
    return (
      <div
        className="rounded-xl border p-3 flex flex-col gap-2"
        style={{
          borderColor: 'hsl(var(--status-warn) / 0.35)',
          backgroundColor: 'hsl(var(--status-warn) / 0.08)',
        }}
      >
        <p className="text-sm font-semibold">{device.label} is archived.</p>
        <p className="text-xs text-muted-foreground">
          It was still doing a job at {orphaned.length} station
          {orphaned.length === 1 ? '' : 's'}, and that job is now unset — assign another device on
          each of them, or the station simply goes without.
        </p>
        <ul className="text-xs text-muted-foreground flex flex-col gap-0.5">
          {orphaned.map((ref) => (
            <li key={`${ref.stationId}-${ref.role}`} className="break-words">
              {ref.stationName} — {deviceRoleWord(ref.role)}
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-muted/20 p-3 flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">
          <TextInput value={label} onChange={setLabel} />
        </Field>
        <Field label="Address">
          <TextInput value={address} onChange={setAddress} />
        </Field>
        <Field label="Model">
          <TextInput value={model} onChange={setModel} />
        </Field>
        <Field label="Protocol">
          <TextInput value={protocol} onChange={setProtocol} />
        </Field>
        {isTerminal && (
          <>
            <Field label="Terminal id (TID)">
              <TextInput value={terminalId} onChange={setTerminalId} />
            </Field>
            <Field label="Merchant id (MID)">
              <TextInput value={merchantId} onChange={setMerchantId} />
            </Field>
          </>
        )}
      </div>
      {failed && <p className="text-sm text-destructive break-words">{failed}</p>}
      <div className="flex flex-wrap gap-2 justify-end">
        {/*
          Archiving rather than deleting: the station assignments and the
          command history still point at this row, and a device that left the
          park is a fact worth keeping.
        */}
        <Button
          variant="outline"
          size="sm"
          className="mr-auto"
          onClick={() => void archive()}
          disabled={busy}
        >
          Archive it
        </Button>
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={busy || !label.trim()}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** The commands worth a button, in the order somebody reaches for them. */
const SAFE_COMMANDS: { kind: BoxCommandKind; needsStation?: boolean; detail: string }[] = [
  { kind: 'test_print', needsStation: true, detail: 'Prints a test on the station’s receipt printer.' },
  { kind: 'config_apply', detail: 'Pulls the station bundle again without waiting for the next poll.' },
  { kind: 'collect_logs', detail: 'Uploads the agent’s recent log for the drawer below.' },
  { kind: 'clear_cache', detail: 'Throws the cached catalogue and members away and pulls them whole.' },
  { kind: 'restart', detail: 'Restarts the agent. The sale in progress survives; the connection drops for a moment.' },
  { kind: 'go_offline', detail: 'Cuts the box off from the cloud on purpose, to watch it keep selling.' },
  { kind: 'go_online', detail: 'Lets it talk to the cloud again and drain its outbox.' },
];

function BoxControls({
  box,
  stations,
  outboxDepth,
  onSent,
}: {
  box: BoxRow;
  stations: StationRow[];
  outboxDepth: number | null;
  onSent: (actionId?: string | null) => void;
}) {
  const [stationId, setStationId] = useState(stations[0]?.id ?? '');
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const send = async (kind: BoxCommandKind, payload?: Record<string, unknown>) => {
    setBusyKind(kind);
    setNote(null);
    setFailed(null);
    try {
      const result = await fleetApi.sendCommand(box.id, { kind, payload });
      setNote(`${commandWord(kind)} queued. The box takes it on its next poll.`);
      onSent(result.actionId);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : `${commandWord(kind)} could not be queued`);
    } finally {
      setBusyKind(null);
    }
  };

  return (
    <section>
      <h3 className="text-sm font-bold mb-2">Controls</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Every one of these is queued rather than sent: the box takes it on its next poll and reports
        back, so a box that is asleep or offline collects its instructions when it wakes.
      </p>

      {stations.length > 0 && (
        <div className="mb-3">
          <Field label="Station a test print goes to">
            <Select
              value={stationId}
              onChange={setStationId}
              options={stations.map((s) => ({ value: s.id, label: s.name }))}
            />
          </Field>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {SAFE_COMMANDS.map((command) => {
          const blocked = command.needsStation && !stationId;
          return (
            <Button
              key={command.kind}
              variant="outline"
              size="sm"
              title={blocked ? 'This box has no station to print from yet' : command.detail}
              disabled={busyKind !== null || blocked}
              onClick={() =>
                void send(command.kind, command.needsStation ? { stationId } : undefined)
              }
            >
              {busyKind === command.kind ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {commandWord(command.kind)}
            </Button>
          );
        })}
      </div>

      {note && <p className="mt-2 text-sm text-muted-foreground">{note}</p>}
      {failed && <p className="mt-2 text-sm text-destructive break-words">{failed}</p>}

      <div className="mt-4 rounded-xl border border-dashed p-3">
        <p className="text-sm font-semibold">Reset the store</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Wipes everything the box is holding and mints a new journal epoch, so anything left from
          the old one is recognisably stale rather than replayed. Used when a box is repurposed or
          its store is corrupt — never to clear a fault.
        </p>
        {outboxDepth !== null && outboxDepth > 0 ? (
          <p className="mt-2 text-sm" style={{ color: 'hsl(var(--status-warn))' }}>
            {outboxDepth} event{outboxDepth === 1 ? '' : 's'} on this box have not reached the cloud
            yet. Resetting now would destroy {outboxDepth === 1 ? 'it' : 'them'}, so it is refused
            until the outbox is empty.
          </p>
        ) : resetting ? (
          <ResetConfirm
            boxName={box.name}
            busy={busyKind === 'reset_store'}
            onCancel={() => setResetting(false)}
            onConfirm={() => {
              // The confirmation stays up, with its spinner, until the command
              // is actually queued: closing it on the press would leave a
              // failure with nothing on screen that had asked for it.
              void send('reset_store').finally(() => setResetting(false));
            }}
          />
        ) : (
          <Button variant="outline" size="sm" className="mt-2" onClick={() => setResetting(true)}>
            Reset the store…
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * Typed confirmation, because this is the one control on the page that
 * destroys something. Typing the box's name is not ceremony: it is what stops
 * the wrong box being reset from a list where every row looks alike.
 */
function ResetConfirm({
  boxName,
  busy,
  onCancel,
  onConfirm,
}: {
  boxName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <div className="mt-2 flex flex-col gap-2">
      <Field label={`Type “${boxName}” to confirm`}>
        <TextInput value={typed} onChange={setTyped} placeholder={boxName} />
      </Field>
      <div className="flex gap-2 justify-end">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={busy || typed.trim() !== boxName}
          onClick={onConfirm}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Reset the store
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Command history
// ---------------------------------------------------------------------------

function CommandHistory({
  boxId,
  refreshedAt,
  timezone,
  onFilterByAction,
}: {
  boxId: string;
  /** Bumped when a command is sent, so the list reloads without a second button. */
  refreshedAt: number;
  timezone?: string | null;
  onFilterByAction: (actionId: string) => void;
}) {
  const [commands, setCommands] = useState<BoxCommandRow[] | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { commands: list } = await fleetApi.commands(boxId);
      setCommands(list);
      setMissing(false);
    } catch (err) {
      setCommands([]);
      setMissing(isMissingRoute(err));
    }
  }, [boxId]);

  useEffect(() => {
    void load();
  }, [load, refreshedAt]);

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-bold">Command history</h3>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()}>
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh
        </Button>
      </div>

      {missing ? (
        <RouteUnavailable what="Command history" />
      ) : commands === null ? (
        <Loading what="commands" />
      ) : commands.length === 0 ? (
        <EmptyState title="Nothing has been asked of this box yet" />
      ) : (
        <ul className="flex flex-col divide-y">
          {commands.map((command) => (
            <li key={command.id} className="py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <StatusPill tone={toneForCommandState(command.state)}>{command.state}</StatusPill>
                <span className="text-sm font-semibold">{commandWord(command.kind)}</span>
                <span className="text-xs text-muted-foreground ml-auto whitespace-nowrap">
                  {timeAgo(command.createdAt)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span title={formatExact(command.createdAt, timezone)}>
                  queued {formatWhen(command.createdAt, timezone)}
                </span>
                {command.finishedAt && <span>finished {formatWhen(command.finishedAt, timezone)}</span>}
                {command.attempts !== null && command.attempts !== undefined && command.attempts > 1 && (
                  <span>{command.attempts} attempts</span>
                )}
                {command.actionId && (
                  <button
                    type="button"
                    onClick={() => onFilterByAction(command.actionId ?? '')}
                    className="font-mono break-all font-semibold hover:text-foreground"
                    title="Show only this action in the log"
                  >
                    {command.actionId}
                  </button>
                )}
              </div>
              {command.errorMessage && (
                <p className="mt-1 text-xs break-words" style={{ color: 'hsl(var(--status-down))' }}>
                  {command.errorCode ? `${command.errorCode}: ` : ''}
                  {command.errorMessage}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Box log
// ---------------------------------------------------------------------------

function BoxLog({
  boxId,
  actionFilter,
  onActionFilterChange,
  refreshedAt,
  timezone,
}: {
  boxId: string;
  actionFilter: string;
  onActionFilterChange: (next: string) => void;
  refreshedAt: number;
  timezone?: string | null;
}) {
  const [lines, setLines] = useState<BoxLogLine[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fleetApi.log(boxId, {
        actionId: actionFilter.trim() || undefined,
      });
      setLines(result.lines);
      setTruncated(result.truncated === true);
      setMissing(false);
    } catch (err) {
      setLines([]);
      setMissing(isMissingRoute(err));
    } finally {
      setLoading(false);
    }
  }, [boxId, actionFilter]);

  useEffect(() => {
    void load();
  }, [load, refreshedAt]);

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-bold">Box log</h3>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Refresh
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Field label="Action id" className="flex-1 min-w-[12rem]">
          <TextInput
            value={actionFilter}
            onChange={onActionFilterChange}
            placeholder="Everything this box has said"
          />
        </Field>
        {actionFilter && (
          <Button variant="outline" size="sm" className="h-9" onClick={() => onActionFilterChange('')}>
            Clear
          </Button>
        )}
      </div>

      {missing ? (
        <RouteUnavailable
          what="The box log"
          detail="It arrives with the box agent; until then a command's result is the only thing the box says back."
        />
      ) : lines === null ? (
        <Loading what="the log" />
      ) : lines.length === 0 ? (
        <EmptyState
          title={actionFilter ? 'Nothing under that action id' : 'The log is empty'}
          detail={
            actionFilter
              ? 'Either the box has not reached that command yet, or it wrote nothing about it.'
              : 'The box has said nothing since it last uploaded its log.'
          }
        />
      ) : (
        <>
          <ul className="rounded-xl border divide-y max-h-96 overflow-y-auto">
            {lines.map((line, index) => (
              <LogLine
                key={`${line.at}-${index}`}
                line={line}
                timezone={timezone}
                onFilter={onActionFilterChange}
              />
            ))}
          </ul>
          {truncated && (
            <p className="mt-2 text-xs text-muted-foreground">
              The last 500 lines. Filter by an action id to see one command's own account of itself.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * One line, laid out rather than dumped: the time, how bad it was, which part
 * of the agent said it, and then the words. The action id sits at the end as a
 * button, because the useful next move from a line is almost always "show me
 * everything else that belonged to this".
 */
function LogLine({
  line,
  timezone,
  onFilter,
}: {
  line: BoxLogLine;
  timezone?: string | null;
  onFilter: (actionId: string) => void;
}) {
  const tone =
    line.level === 'error' ? 'down' : line.level === 'warn' ? 'warn' : line.level === 'debug' ? 'idle' : 'ok';
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-xs">
      <StatusMark tone={tone} className="w-2 h-2 self-center" />
      <span className="font-mono text-muted-foreground tabular-nums shrink-0">
        {formatWhen(line.at, timezone)}
      </span>
      {line.source && <span className="font-mono text-muted-foreground shrink-0">{line.source}</span>}
      <span className="min-w-0 flex-1 break-words">{line.message}</span>
      {line.actionId && (
        <button
          type="button"
          onClick={() => onFilter(line.actionId ?? '')}
          className="font-mono text-[11px] text-muted-foreground hover:text-foreground shrink-0"
          title="Show only this action"
        >
          {line.actionId.slice(0, 8)}
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Heartbeats
//
// The simulator that used to sit here as a placeholder is now its own file,
// `SimulatorPanel.tsx`, because it drives devices rather than describes them.
// ---------------------------------------------------------------------------

function Heartbeats({ boxId, timezone }: { boxId: string; timezone?: string | null }) {
  const [rows, setRows] = useState<BoxHeartbeatRow[] | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fleetApi
      .heartbeats(boxId)
      .then(({ heartbeats }) => {
        if (!cancelled) setRows(heartbeats);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRows([]);
        setMissing(isMissingRoute(err));
      });
    return () => {
      cancelled = true;
    };
  }, [boxId]);

  return (
    <section>
      <h3 className="text-sm font-bold mb-2">Recent heartbeats</h3>
      {missing ? (
        <RouteUnavailable what="Heartbeat history" />
      ) : rows === null ? (
        <Loading what="heartbeats" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No heartbeat has arrived"
          detail="A box reports every 60 seconds. Silence is how the watchdog decides it is offline."
        />
      ) : (
        <ul className="rounded-xl border divide-y max-h-64 overflow-y-auto">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-xs text-muted-foreground"
            >
              <span className="tabular-nums" title={formatExact(row.receivedAt, timezone)}>
                {formatWhen(row.receivedAt, timezone)}
              </span>
              {row.agentVersion && <span>v{row.agentVersion}</span>}
              {row.uptimeS !== null && row.uptimeS !== undefined && <span>up {elapsed(row.uptimeS)}</span>}
              {row.outboxDepth !== null && row.outboxDepth !== undefined && (
                <span>outbox {row.outboxDepth}</span>
              )}
              {row.tempC !== null && row.tempC !== undefined && <span>{row.tempC.toFixed(1)} °C</span>}
              {row.clockOffsetMs !== null && row.clockOffsetMs !== undefined && (
                <span className="ml-auto tabular-nums">
                  clock {row.clockOffsetMs > 0 ? '+' : ''}
                  {row.clockOffsetMs} ms
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

