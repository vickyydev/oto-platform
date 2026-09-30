import type { ReactNode } from 'react';
import type { AlertRow, BoothHealth, HealthBox } from '@/api/observability';
import { FerrisWheel } from 'lucide-react';
import { StatusMark, toneForHealth, type Tone } from '@/components/Status';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell } from '@/components/redesign/layout';
import { toneForPaper, toneForReachability } from '@/lib/fleetWords';
import { formatWhen, timeAgo } from '@/lib/time';

/**
 * The Lucky Wheel booths, on the page that answers "is anything wrong right
 * now" (S2-07a).
 *
 * A booth is a box with a printer, so most of what can go wrong with one is
 * already said elsewhere: it is on the Boxes panel above like every other box,
 * and its printer is on Devices with the rest of the park's printers. What
 * this section adds is the half of a booth that no box-shaped view can show —
 * which wheel it is running, whether anybody is signed in at it, how many
 * vouchers it is still holding, and the two conditions that are the booth's
 * own: prizes it has given away with nobody signed in, and prizes it has no
 * more of today.
 *
 * **Most of this is what the box last REPORTED, and one reading is not.** The
 * wheel, the printer, the sign-in and the queue are the booth's own
 * measurements off its last heartbeat, so a booth that went offline at
 * lunchtime shows lunchtime's answers and the heartbeat's age beside them is
 * how a reader tells. The unattributed count is the opposite: it is counted
 * from rows that have ARRIVED, so an offline booth's morning shows and its
 * afternoon does not.
 *
 * Nothing on this panel asks a booth anything. A question would be answered by
 * the virtual box in the api process and by no Raspberry Pi in any mall.
 */
export function BoothSummary({
  boxes,
  alerts,
  timezone,
}: {
  /** Undefined where this deployment's /ops/health does not report boxes at all. */
  boxes: HealthBox[] | undefined;
  alerts: AlertRow[];
  timezone?: string | null;
}) {
  const withBooths = (boxes ?? []).filter((b) => (b.booths?.length ?? 0) > 0);

  /**
   * A park with no booth gets no panel at all, rather than an empty one.
   *
   * The distinction the panel cannot make is between "this operator runs no
   * booths" and "no box has been configured with one yet", and both read the
   * same from here — so it says nothing rather than saying the wrong one.
   */
  if (withBooths.length === 0) return null;

  return (
    <CardShell
      span={12}
      icon={FerrisWheel}
      title="Booths"
      note="the Lucky Wheel at each branch: the wheel it is running, who is signed in, and what it is still holding"
    >
      <div className="flex flex-col gap-3">
        {withBooths.flatMap((box) =>
          (box.booths ?? []).map((booth) => (
            <BoothCard
              key={booth.stationId}
              box={box}
              booth={booth}
              alerts={alertsAbout(alerts, box, booth)}
              timezone={timezone}
            />
          )),
        )}
      </div>
    </CardShell>
  );
}

/**
 * The open alerts worth showing under one booth.
 *
 * Three sources, because a booth's faults are raised against three different
 * subjects and only this view puts them back together: the booth's own
 * conditions are keyed by its station, the box's — offline, clock, stale sync
 * — by the box, and a printer out of paper by the DEVICE. All three are
 * genuinely about the wheel in the mall, so all three belong here.
 *
 * A box with a booth and a second station would show that station's device
 * alerts here too. That is the shape of the key, not an oversight to be worked
 * around by guessing which printer is the booth's: the booth's own printer
 * state is on the card above, measured by the booth module itself.
 */
function alertsAbout(alerts: AlertRow[], box: HealthBox, booth: BoothHealth): AlertRow[] {
  const subjects = new Set<string>([
    booth.stationId,
    box.id,
    ...(box.devices ?? []).map((d) => d.id),
  ]);
  return alerts.filter((a) => {
    const id = a.key.slice(a.key.indexOf(':') + 1);
    return a.key.includes(':') && subjects.has(id);
  });
}

function BoothCard({
  box,
  booth,
  alerts,
  timezone,
}: {
  box: HealthBox;
  booth: BoothHealth;
  /** The open alerts about this booth or the box under it. */
  alerts: AlertRow[];
  timezone?: string | null;
}) {
  const reported = booth.reported;
  const name = booth.codePrefix ? `${booth.name} (${booth.codePrefix})` : booth.name;
  const open = alerts.filter((a) => !a.resolvedAt);
  /**
   * The booth's own figure where it sent one, the cloud's copy of the box's
   * outbox otherwise, and null where neither could say — which on a Raspberry
   * Pi that has not called home is the honest answer, because its queue is a
   * file in a mall.
   */
  const waiting = reported?.vouchersPending ?? box.outboxDepth ?? null;

  return (
    <article className="rounded-[14px] bg-foreground/[0.025] px-4 py-3.5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusMark tone={toneForHealth(box.state)} />
        <span className="font-semibold min-w-0 break-words">{name}</span>
        <span className="text-sm text-muted-foreground">
          {box.name} · {box.branchName}
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0">
          {box.lastHeartbeatAt
            ? `reported ${timeAgo(box.lastHeartbeatAt)}`
            : 'has never called home'}
        </span>
      </header>

      {/*
        The wheel first, because it is the one answer that decides whether the
        booth does anything at all: a booth that has never synced a wheel shows
        a television asking for the internet and a button that does nothing.
      */}
      <dl className="mt-3 grid gap-3 @md:grid-cols-2 @3xl:grid-cols-4">
        <Reading label="Wheel">
          {reported === null ? (
            <Muted>not reported</Muted>
          ) : reported.configVersion === null ? (
            <span className="inline-flex items-center gap-1.5 text-status-down">
              <StatusMark tone="down" className="w-2.5 h-2.5" />
              never synced a wheel
            </span>
          ) : (
            <>version {reported.configVersion}</>
          )}
        </Reading>

        <Reading label="Signed in">
          {reported === null ? (
            <Muted>not reported</Muted>
          ) : reported.staffSignedIn ? (
            'somebody is at the booth'
          ) : (
            'nobody'
          )}
        </Reading>

        <Reading label="Printer">
          {reported === null ? (
            <Muted>not reported</Muted>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusChip tone={toneForReachability(reported.printerReachable)}>
                {reported.printerReachable}
              </StatusChip>
              <StatusChip tone={toneForPaper(reported.paperStatus)}>
                paper {reported.paperStatus}
              </StatusChip>
            </span>
          )}
        </Reading>

        <Reading label="Last spin">
          {reported?.lastSpinAt ? (
            formatWhen(reported.lastSpinAt, timezone)
          ) : reported === null ? (
            <Muted>not reported</Muted>
          ) : (
            <Muted>none since it started</Muted>
          )}
        </Reading>

        {/*
          The booth module counts the box's WHOLE outbox, not its vouchers: a
          press files two or three facts and a booth box carries little else,
          so this is the right order of magnitude and the wrong noun. It is
          labelled for what it measures rather than for what it is nearly.
        */}
        <Reading label="Waiting to sync">
          {waiting === null ? (
            <Muted>not reported</Muted>
          ) : waiting === 0 ? (
            'nothing waiting'
          ) : (
            <>{waiting} event(s) held on the box</>
          )}
        </Reading>

        <Reading label={`Unattributed today (${booth.businessDate})`}>
          {booth.unattributedToday === null ? (
            <Muted>could not be counted</Muted>
          ) : booth.unattributedToday === 0 ? (
            'none — every voucher has a name against it'
          ) : (
            <span className="inline-flex items-center gap-1.5 text-status-warn">
              <StatusMark tone="warn" className="w-2.5 h-2.5" />
              {booth.unattributedToday} voucher(s) with nobody signed in
            </span>
          )}
        </Reading>

        <Reading label="Prizes at today's cap">
          {reported === null ? (
            <Muted>not reported</Muted>
          ) : reported.dailyCapsReached.length === 0 ? (
            'none — every slice still has prizes'
          ) : (
            `${reported.dailyCapsReached.length} of its prizes`
          )}
        </Reading>
      </dl>

      {open.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1 border-t border-card-border pt-3">
          {open.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-sm">
              <StatusMark tone={severityTone(a.severity)} className="w-2.5 h-2.5 mt-1.5" />
              <span className="min-w-0 break-words">{a.detail ?? a.title}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function Reading({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

/** "We could not ask" and "nothing happened" both read grey, and neither reads as a fault. */
function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/**
 * `info` is news rather than a fault, and it is drawn as neither green nor
 * amber: a prize reaching its daily cap is the wheel working as designed, and
 * painting it amber is how a reader learns to stop looking.
 */
function severityTone(severity: string): Tone {
  if (severity === 'critical') return 'down';
  if (severity === 'warning') return 'warn';
  return 'idle';
}
