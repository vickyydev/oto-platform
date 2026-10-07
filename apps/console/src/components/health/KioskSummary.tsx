import { useEffect, useState, type ReactNode } from 'react';
import { ScanLine } from 'lucide-react';
import { KioskHealthAnswerSchema, type KioskHealthRow } from '@oto/shared';
import { api } from '@/api/client';
import { StatusMark, type Tone } from '@/components/Status';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell } from '@/components/redesign/layout';
import { toneForPaper, toneForReachability } from '@/lib/fleetWords';
import { formatWhen, timeAgo } from '@/lib/time';

/**
 * S2-20 K2 (SCRUM-217) — THE KIOSK TILE ON HEALTH: is each self-service kiosk
 * up, can it print, and how did today go.
 *
 * Read from `GET /ops/kiosks` (`admin:health:read`, in the reader's reach):
 * the box and the screen online, the band printer and its paper, today's
 * sessions by outcome — abandoned among them, the families who walked away —
 * and when it last redeemed a booking. Names, states and counts only, as the
 * rest of this page.
 *
 * Beside the booths, and for the same reason: a kiosk is a box with a printer,
 * so the Boxes card above already says when its machine went quiet; this adds
 * the half no box-shaped row carries. It draws nothing where there is no kiosk
 * or the deployment has no kiosk route.
 */
export function KioskSummary({ timezone, refreshKey }: { timezone?: string | null; refreshKey?: unknown }) {
  const [kiosks, setKiosks] = useState<KioskHealthRow[] | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .get<unknown>('/ops/kiosks')
      .then((answer) => {
        if (live) setKiosks(KioskHealthAnswerSchema.parse(answer).kiosks);
      })
      .catch(() => {
        // No route, no permission or no answer: the tile is simply absent, as the booths' is.
        if (live) setKiosks(null);
      });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (!kiosks || kiosks.length === 0) return null;

  return (
    <CardShell
      span={12}
      icon={ScanLine}
      title="Kiosks"
      note="each self-service kiosk: whether it is up, whether it can print, and how today went"
    >
      <div className="flex flex-col gap-3" data-testid="kiosk-health">
        {kiosks.map((kiosk) => (
          <KioskCard key={kiosk.stationId} kiosk={kiosk} timezone={timezone} />
        ))}
      </div>
    </CardShell>
  );
}

function KioskCard({ kiosk, timezone }: { kiosk: KioskHealthRow; timezone?: string | null }) {
  const up = !!kiosk.box?.online && kiosk.screen.online;
  const printer = kiosk.printer;
  const printerDown = !!printer && (printer.reachability === 'unreachable' || printer.paperStatus === 'out');
  const tone: Tone = !kiosk.screen.paired ? 'idle' : !up || printerDown ? 'down' : 'ok';
  const today = kiosk.today;

  return (
    <article className="rounded-[14px] bg-foreground/[0.025] px-4 py-3.5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusMark tone={tone} />
        <span className="font-semibold min-w-0 break-words">{kiosk.name}</span>
        <span className="text-sm text-muted-foreground">
          {kiosk.box ? `${kiosk.box.name} · ` : ''}
          {kiosk.branchName}
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0">
          {kiosk.screen.lastSeenAt ? `screen seen ${timeAgo(kiosk.screen.lastSeenAt)}` : 'screen never seen'}
        </span>
      </header>

      <dl className="mt-3 grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
        <Reading label="Online">
          {!kiosk.screen.paired ? (
            <Muted>no screen paired — Devices, Pair a kiosk</Muted>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusChip tone={kiosk.box?.online ? 'ok' : 'down'}>
                box {kiosk.box?.online ? 'online' : 'offline'}
              </StatusChip>
              <StatusChip tone={kiosk.screen.online ? 'ok' : 'down'}>
                screen {kiosk.screen.online ? 'online' : 'offline'}
              </StatusChip>
            </span>
          )}
        </Reading>

        <Reading label="Band printer">
          {printer ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusChip tone={toneForReachability(printer.reachability)}>{printer.reachability}</StatusChip>
              <StatusChip tone={toneForPaper(printer.paperStatus)}>paper {printer.paperStatus}</StatusChip>
            </span>
          ) : (
            <Muted>no band printer assigned</Muted>
          )}
        </Reading>

        <Reading label={`Sessions today (${today.businessDate})`}>
          {today.sessions === 0 ? (
            <Muted>none yet</Muted>
          ) : (
            <span data-testid="kiosk-health-today">
              {today.sessions}: {today.issued} issued, {today.handedOff} to the desk, {today.failed} failed,{' '}
              {today.abandoned} abandoned{today.open > 0 ? `, ${today.open} in progress` : ''}
            </span>
          )}
        </Reading>

        <Reading label="Last redemption">
          {kiosk.lastRedemptionAt ? formatWhen(kiosk.lastRedemptionAt, timezone) : <Muted>none yet</Muted>}
        </Reading>
      </dl>
    </article>
  );
}

function Reading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
