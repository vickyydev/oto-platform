import { Link } from 'wouter';
import { clockOffsetWords } from '@/api/fleet';
import type { HealthBox } from '@/api/observability';
import { Cpu } from 'lucide-react';
import { Loading, RouteUnavailable } from '@/components/Panel';
import { StatusMark, toneForHealth } from '@/components/Status';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell, StripedList, type Span } from '@/components/redesign/layout';
import { EmptyNote, UnreadNote } from '@/components/redesign/StatTile';
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
export function FleetSummary({ boxes, loading, missing, error, onRetry, timezone, span }: {
  boxes?: readonly HealthBox[];
  loading: boolean;
  missing: boolean;
  error: string | null;
  onRetry: () => void;
  timezone?: string | null;
  span?: Span;
}) {
  const withoutHours = Array.from(new Map((boxes ?? [])
    .filter((box) => box.openingHours === 'not_set')
    .map((box) => [box.branchId, { id: box.branchId, name: box.branchName }])).values());

  return (
    <CardShell
      span={span}
      icon={Cpu}
      title="The boxes"
      note="the machine at each counter, gate and booth, and whether it is still talking to us"
    >
      {missing || (!loading && !error && boxes === undefined) ? (
        <RouteUnavailable
          what="The box health record"
          detail="Boxes report here when the health API includes their current state."
        />
      ) : error ? (
        <UnreadNote what="The box list" onRetry={onRetry} />
      ) : boxes === undefined ? (
        <Loading what="boxes" />
      ) : boxes.length === 0 ? (
        <EmptyNote
          title="No box is registered"
          detail="Nothing is running the tills yet, so there is nothing here to be offline. Boxes are added on Devices."
        />
      ) : (
        <StripedList label="Boxes">
          {boxes.map((box) => (
              <BoxHealthRow
                key={box.id}
                box={box}
                timezone={timezone}
              />
            ))}
        </StripedList>
      )}

      {!error && withoutHours.map((branch) => (
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
  timezone,
}: {
  box: HealthBox;
  timezone?: string | null;
}) {
  const devices = box.devices ?? [];
  const tone = toneForHealth(box.state);

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
          {box.agentVersion ? `agent ${box.agentVersion}` : box.slot}
        </span>
        <span className="text-right text-[12.5px] text-muted-foreground tabular-nums whitespace-nowrap">
          {box.heartbeatAgeSeconds == null
            ? 'never reported'
            : `heartbeat ${elapsed(box.heartbeatAgeSeconds)} old`}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground">
        <StatusChip tone={toneForBoxStatus(box.status)}>{boxStatusWord(box.status)}</StatusChip>
        {box.agentVersion && <span className="@lg:hidden">agent {box.agentVersion}</span>}
        {box.uptimeSeconds != null && <span>up {elapsed(box.uptimeSeconds)}</span>}
        {box.outboxDepth != null && <span>outbox {box.outboxDepth}</span>}
        {box.oldestUnackedAgeS != null && <span>oldest waiting {elapsed(box.oldestUnackedAgeS)}</span>}
        {box.clockOffsetMs != null && <span>clock {clockOffsetWords(box.clockOffsetMs)}</span>}
        <span>{box.lastSyncAt ? `last sync ${timeAgo(box.lastSyncAt)}` : 'last sync not recorded'}</span>
        {box.agentVersion && box.minAgentVersion && <span>minimum agent {box.minAgentVersion}</span>}
        {box.agentVersion && box.agentBelowMinimum && <StatusChip tone="warn">Below minimum</StatusChip>}
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
