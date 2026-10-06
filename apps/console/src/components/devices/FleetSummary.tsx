import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import {
  boxVitals,
  fleetApi,
  isMissingRoute,
  HEARTBEAT_LATE_AFTER_S,
  type BoxRow,
  type DeviceRow,
} from '@/api/fleet';
import { directoryApi, type BranchRow } from '@/api/platform';
import { Cpu } from 'lucide-react';
import { Loading, RouteUnavailable } from '@/components/Panel';
import { StatusMark, type Tone } from '@/components/Status';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell, StripedList, type Span } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import {
  boxRoleWord,
  boxStatusWord,
  deviceKindWord,
  toneForBoxStatus,
  toneForPaper,
  toneForReachability,
} from '@/lib/fleetWords';
import { elapsed, formatWhen, timeAgo } from '@/lib/time';

/**
 * The boxes, on the page that answers "is anything wrong right now".
 *
 * Health carries the summary and Devices carries the detail, deliberately: a
 * box that has gone quiet belongs beside the failing database and the late
 * job, because it is the same question; what its printers are called and which
 * station sits on it is a different question, asked at a different moment.
 * Each row links across rather than repeating the drawer here.
 */
export function FleetSummary({ timezone, span }: { timezone?: string | null; span?: Span }) {
  const [boxes, setBoxes] = useState<BoxRow[] | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Boxes are asked for per branch and devices per box, because that is
      // how they are owned. The estate is a handful of branches and a box or
      // two each, so walking it is a few requests rather than a page of them.
      let live: BranchRow[] = [];
      try {
        const { branches: list } = await directoryApi.branches();
        live = list.filter((b) => !b.archived);
      } catch {
        // An account may read health without reading the branch list. Nothing
        // below can be asked for without a branch, so the panel says as much.
      }
      if (cancelled) return;
      setBranches(live);

      const boxResults = await Promise.allSettled(live.map((b) => fleetApi.boxes(b.id)));
      if (cancelled) return;
      const found = boxResults.flatMap((r) => (r.status === 'fulfilled' ? r.value.boxes : []));
      const everyReadMissing =
        boxResults.length > 0 &&
        boxResults.every((r) => r.status === 'rejected' && isMissingRoute(r.reason));
      setMissing(everyReadMissing);
      setBoxes(found);

      const deviceResults = await Promise.allSettled(
        found.filter((box) => !box.archived).map((box) => fleetApi.boxDevices(box.id)),
      );
      if (cancelled) return;
      setDevices(deviceResults.flatMap((r) => (r.status === 'fulfilled' ? r.value.devices : [])));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Only branches that report hours AND have none set. An undefined field is a
  // deployment that does not send them, which is not a fact about the branch.
  const withoutHours = branches.filter((b) => b.openingHours === null);

  return (
    <CardShell
      span={span}
      icon={Cpu}
      title="The boxes"
      note="the machine at each counter, gate and booth, and whether it is still talking to us"
    >
      {missing ? (
        <RouteUnavailable
          what="The box register"
          detail="Boxes report in as soon as the fleet API is deployed to this environment."
        />
      ) : boxes === null ? (
        <Loading what="boxes" />
      ) : boxes.length === 0 ? (
        <EmptyNote
          title="No box is registered"
          detail="Nothing is running the tills yet, so there is nothing here to be offline. Boxes are added on Devices."
        />
      ) : (
        <StripedList label="Boxes">
          {boxes
            .filter((box) => !box.archived)
            .map((box) => (
              <BoxHealthRow
                key={box.id}
                box={box}
                devices={devices.filter((d) => d.boxId === box.id && !d.archived)}
                timezone={timezone}
              />
            ))}
        </StripedList>
      )}

      {withoutHours.map((branch) => (
        <p key={branch.id} className="flex items-start gap-2 px-3 text-xs text-muted-foreground">
          <StatusMark tone="idle" className="mt-0.5" />
          <span>
            Opening hours are not set for {branch.name}. A box is only called offline during trading,
            so with no hours to compare against that alert never fires here — set them on the till's
            Branches panel.
          </span>
        </p>
      ))}
    </CardShell>
  );
}

function BoxHealthRow({
  box,
  devices,
  timezone,
}: {
  box: BoxRow;
  devices: DeviceRow[];
  timezone?: string | null;
}) {
  const vitals = boxVitals(box);
  const late =
    box.status === 'online' &&
    vitals.heartbeatAgeSeconds !== null &&
    vitals.heartbeatAgeSeconds > HEARTBEAT_LATE_AFTER_S;
  const tone: Tone = late ? 'warn' : toneForBoxStatus(box.status);

  return (
    <li className="px-3 py-2.5">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1 text-[13.5px] @lg:grid-cols-[minmax(0,1fr)_150px_130px]">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <StatusMark tone={tone} />
          <Link
            href="/devices"
            className="min-w-0 font-semibold break-words hover:underline underline-offset-4"
          >
            {box.name}
          </Link>
          <span className="text-xs text-muted-foreground">{boxRoleWord(box.role)}</span>
        </span>
        <span className="hidden font-mono text-xs text-muted-foreground @lg:block">
          {vitals.agentVersion ? `agent ${vitals.agentVersion}` : box.slot}
        </span>
        <span className="text-right text-[12.5px] text-muted-foreground tabular-nums whitespace-nowrap">
          {vitals.heartbeatAgeSeconds === null
            ? 'never reported'
            : `heartbeat ${elapsed(vitals.heartbeatAgeSeconds)} old`}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground">
        <StatusChip tone={toneForBoxStatus(box.status)}>{boxStatusWord(box.status)}</StatusChip>
        {vitals.agentVersion && <span className="@lg:hidden">agent {vitals.agentVersion}</span>}
        {vitals.uptimeSeconds !== null && <span>up {elapsed(vitals.uptimeSeconds)}</span>}
        {vitals.outboxDepth !== null && <span>outbox {vitals.outboxDepth}</span>}
        {box.lastHeartbeatAt && (
          <span title={formatWhen(box.lastHeartbeatAt, timezone)}>
            last heard {timeAgo(box.lastHeartbeatAt)}
          </span>
        )}
      </div>

      {devices.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
          {devices.map((device) => (
            <span key={device.id} className="inline-flex items-center gap-1.5 text-xs">
              <StatusMark tone={toneForReachability(device.reachability)} className="w-2.5 h-2.5" />
              <span className="text-muted-foreground">{device.label}</span>
              {device.kind.endsWith('printer') &&
                device.paperStatus &&
                device.paperStatus !== 'unknown' &&
                device.paperStatus !== 'ok' && (
                  <StatusChip tone={toneForPaper(device.paperStatus)} className="px-1.5 py-0">
                    paper {device.paperStatus}
                  </StatusChip>
                )}
              <span className="sr-only">{deviceKindWord(device.kind)}</span>
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
