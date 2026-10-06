import { Cpu, ExternalLink, FileText } from 'lucide-react';
import { Loading, RouteUnavailable, StaleNote, Unreadable } from '@/components/Panel';
import { StatusMark } from '@/components/Status';
import { StatusChip, TONE_INK } from '@/components/redesign/chips';
import { CardShell, FactLine, FactList, RailNote } from '@/components/redesign/layout';
import { toneForPaper, toneForReachability } from '@/lib/fleetWords';
import { formatWhen, timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';
import type { BoothStatus } from './boothApi';
import type { Read } from './readState';

/** The till's origin, whose back office holds the Print Templates panel (`env.d.ts`). */
const POS_URL = import.meta.env.VITE_POS_URL?.trim();

/**
 * What the booth's box is actually doing, as against what somebody is editing
 * — the artboard's "The box" card (SCRUM-474), which is where the live facts
 * that used to head the page now live.
 *
 * Every reading here is the cloud's copy of what the box last REPORTED, which
 * is why the heartbeat's age sits beside it: a booth that went offline at
 * lunchtime shows lunchtime's answers. `runningVersion` null is "the box has
 * not said", not "the box is running nothing".
 *
 * **Which is why "Wheel" compares two numbers rather than showing one.**
 * `GET /booths/:id/status` answers with both the published version and the
 * version the box reports running, and the line goes amber and names both
 * whenever they differ. A page that showed only what had been published would
 * let a manager believe a wheel had changed in a shopping centre when it had
 * not — and on this build that is the ordinary case rather than a rare one,
 * because nothing on a running box re-pulls the cache the wheel arrives in
 * (`@oto/box-agent` calls `syncCache()` at boot and from no timer). Until
 * that is fixed, the booth adopts a publish when its agent next restarts, and
 * this reading is what says whether it has.
 */
export function BoothBoxCard({
  status,
  boothId,
  timezone,
  onRetry,
  id,
  className,
}: {
  status: Read<BoothStatus | null>;
  /** The booth on screen: a reading held from the booth before it is not shown under this one's name. */
  boothId: string;
  timezone?: string | null;
  onRetry: () => void;
  id?: string;
  className?: string;
}) {
  const s = status.value && status.value.booth.id === boothId ? status.value : null;
  const behind =
    s !== null &&
    s.config.runningVersion !== null &&
    s.config.publishedVersion !== null &&
    s.config.runningVersion < s.config.publishedVersion;
  const boxTone = s === null ? 'idle' : s.box.id === null ? 'idle' : s.box.online ? 'ok' : 'down';

  return (
    <CardShell
      id={id}
      className={className}
      icon={Cpu}
      title="The box"
      note="from the box’s last heartbeat and the rows it has synced — nothing here asks the booth anything"
    >
      {status.state === 'absent' ? (
        <RouteUnavailable what="This booth’s live status" />
      ) : status.state === 'failed' ? (
        <Unreadable what="This booth’s live status" message={status.error} onRetry={onRetry} />
      ) : s === null ? (
        <Loading what="the booth’s status" />
      ) : (
        <>
          {status.state === 'stale' && status.readAt !== null && (
            <StaleNote readAt={status.readAt} message={status.error} onRetry={onRetry} />
          )}
          <FactList>
            <FactLine label="Box">
              <span className={cn('inline-flex items-center gap-[7px]', TONE_INK[boxTone])}>
                <StatusMark tone={boxTone} className="w-2.5 h-2.5" />
                {s.box.id === null
                  ? 'no box yet'
                  : `${s.box.online ? 'online' : 'not reporting'} · ${
                      s.box.lastHeartbeatAt
                        ? `seen ${timeAgo(s.box.lastHeartbeatAt)}`
                        : 'never reported'
                    }`}
              </span>
              {s.box.slot && (
                <span className="block font-mono text-xs font-normal text-muted-foreground">
                  {s.box.slot}
                  {s.box.inProcess ? ' · the platform’s virtual box' : ''}
                </span>
              )}
            </FactLine>
            <FactLine label="Wheel">
              {s.config.runningVersion === null ? (
                <span className="font-normal text-muted-foreground">not reported</span>
              ) : behind ? (
                <span className="inline-flex items-center gap-[7px] text-status-warn">
                  <StatusMark tone="warn" className="w-2.5 h-2.5" />
                  running {s.config.runningVersion}, {s.config.publishedVersion} published
                </span>
              ) : (
                `running version ${s.config.runningVersion}`
              )}
            </FactLine>
            <FactLine label="Printer">
              {s.printer === null ? (
                <span className="font-normal text-muted-foreground">no printer on this booth</span>
              ) : (
                <span className="flex flex-wrap items-center justify-end gap-1.5">
                  {s.printer.label && <span>{s.printer.label}</span>}
                  <StatusChip tone={toneForReachability(s.printer.reachability)}>
                    {s.printer.reachability}
                  </StatusChip>
                  <StatusChip tone={toneForPaper(s.printer.paperStatus)}>
                    paper {s.printer.paperStatus}
                  </StatusChip>
                </span>
              )}
            </FactLine>
            <FactLine label="Last spin">
              {s.lastSpinAt ? (
                formatWhen(s.lastSpinAt, timezone)
              ) : (
                <span className="font-normal text-muted-foreground">none recorded</span>
              )}
            </FactLine>
          </FactList>
          <TemplatesLink />
          {/*
            The tiles above say "Spins today", and this says which day that is.
            The count is filed by TRADING day, which starts at the branch's day
            start rather than at midnight, while a slip prints the calendar
            date it was won on — so between midnight and the day start the two
            disagree, and a manager reading one against the other needs to
            know why.
          */}
          <RailNote>
            Today means the trading day ({s.today.businessDate}), which starts at the branch’s day
            start, not at midnight: after midnight the count and the date stay on the day before
            until then, while a slip is dated with the calendar day it was won.
          </RailNote>
        </>
      )}
    </CardShell>
  );
}

/**
 * Where a printout's layout is changed, beside the printer that prints it
 * (SCRUM-468) — the owner looked for it on this page, at the park, and nothing
 * here led to it.
 *
 * The receipt and slip templates are the till's back office's Print
 * Templates panel (`apps/pos`, Operations › Print Templates). The back office
 * gives each panel an address (`/admin?panel=…`, SCRUM-470), so this lands on
 * that panel directly — and still does for a person who is signed out there:
 * the sign-in wall renders in place and keeps the query string. It does not
 * open with this booth's printer chosen: a template is the branch's, not a
 * device's, and the panel is the list of them. With no till origin configured
 * (`VITE_POS_URL`) the words stay and the link does not — a dead address is
 * worse than a sentence.
 *
 * The booth's own voucher slip has no template there: its logo, header and
 * footer lines, Staff row and terms are this booth's, set on this page under
 * Voucher slip (SCRUM-471), and its prize words are its voucher type's, which
 * the prize editor links to. That is why the link names the panel and not a
 * template: the booth's slip is in none of them.
 */
function TemplatesLink() {
  const label = (
    <>
      <FileText className="w-3.5 h-3.5 shrink-0" />
      Receipt and slip templates
    </>
  );
  return (
    <span className="flex flex-col gap-0.5 px-3 text-xs">
      {POS_URL ? (
        <a
          href={`${POS_URL}/admin?panel=templates`}
          className="inline-flex items-center gap-1.5 font-semibold text-primary-ink underline underline-offset-4"
        >
          {label}
          <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
        </a>
      ) : (
        <span className="inline-flex items-center gap-1.5 font-semibold">{label}</span>
      )}
      <span className="text-muted-foreground">
        {POS_URL
          ? 'Opens the till’s back office on its Print Templates screen (Operations › Print Templates). '
          : 'In the till’s back office, under Operations › Print Templates. '}
        The booth’s own voucher slip is set on this page, under Voucher slip.
      </span>
    </span>
  );
}
