import type { ScreenPresenceView, TillScreenView } from '@/api/fleet';
import { StatusMark } from '@/components/Status';
import { StatusChip, TONE_INK } from '@/components/redesign/chips';
import { screenPresenceWord, toneForScreenPresence } from '@/lib/fleetWords';
import { elapsed, formatWhen } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * SCRUM-771 — whether a screen is still there, in the box card's own words:
 * the status, then how long ago it was last heard from. A customer display is
 * heard on every call it makes; a till's screen (the iPad) sends a heartbeat
 * every minute. Both are offline once quiet for longer than a box may be. The
 * ages are the API's count, never this laptop's clock.
 */

/** "Offline · last seen 12m ago", or "never reported". */
export function presenceSentence(presence: ScreenPresenceView): string {
  const age = presence.lastSeenAgeSeconds;
  const when = age === null || age === undefined ? 'never reported' : `${presence.state === 'online' ? 'seen' : 'last seen'} ${elapsed(age)} ago`;
  return `${screenPresenceWord(presence.state)} · ${when}`;
}

/** The badge beside a paired display's name. */
export function PresenceChip({ presence }: { presence: ScreenPresenceView }) {
  return (
    <StatusChip tone={toneForScreenPresence(presence.state)}>{screenPresenceWord(presence.state)}</StatusChip>
  );
}

/** The status line under a paired display, as the box card's foot reads. */
export function DisplayPresenceLine({
  presence,
  timezone,
}: {
  presence: ScreenPresenceView;
  timezone?: string | null;
}) {
  const tone = toneForScreenPresence(presence.state);
  return (
    <p className={cn('mt-1 inline-flex min-w-0 items-center gap-[7px] text-xs font-semibold', TONE_INK[tone])}
      title={presence.lastSeenAt ? formatWhen(presence.lastSeenAt, timezone) : undefined}>
      <StatusMark tone={tone} />
      <span className="min-w-0">
        {presenceSentence(presence)}
        {presence.state === 'offline' && presence.offlineAfterSeconds
          ? ` — quiet for longer than ${elapsed(presence.offlineAfterSeconds)}`
          : ''}
      </span>
    </p>
  );
}

/**
 * A till's screen and its scanner, on the station card.
 *
 * The scanner line says what the time is, because it is not what a box says
 * about its scanner: a cradle plugged into the iPad is a keyboard to it, so the
 * till knows it only by the codes it types (or a code pasted into the wristband
 * field), and the time of the last one is its only presence.
 */
export function TillScreenPresence({ screen, timezone }: { screen: TillScreenView; timezone?: string | null }) {
  const tone = toneForScreenPresence(screen.state);
  const scanAge = screen.scannerLastUsedAgeSeconds;
  return (
    <div className="space-y-1 text-xs">
      <p className={cn('inline-flex min-w-0 items-center gap-[7px] font-semibold', TONE_INK[tone])}
        title={screen.lastSeenAt ? formatWhen(screen.lastSeenAt, timezone) : undefined}>
        <StatusMark tone={tone} />
        <span className="min-w-0">Till screen {presenceSentence(screen).replace(/^./, (c) => c.toLowerCase())}</span>
      </p>
      <p className="text-muted-foreground" title={screen.scannerLastUsedAt ? formatWhen(screen.scannerLastUsedAt, timezone) : undefined}>
        {scanAge === null || scanAge === undefined
          ? 'Scanner: no scan reported from this till screen yet.'
          : `Scanner last used ${elapsed(scanAge)} ago.`}{' '}
        A scanner plugged into the iPad types like a keyboard, so the last code it typed is the only sign of it.
      </p>
    </div>
  );
}
