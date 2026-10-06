import { useQuery } from '@tanstack/react-query';
import { Users, Baby, User } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { fetchLiveOccupancy, type ChipOccupancy } from '@/api/occupancy';

/**
 * Persistent top-bar occupancy chip: an always-visible best-effort count of
 * people currently inside the park, tappable to reveal the adults/kids split.
 *
 * Reactivity: polled via React Query (short interval + refetch on focus).
 *
 * S2-12 round 4: the getter seam reads the platform's count, built from the
 * gate box's committed passages (`GET /branches/:id/occupancy` through
 * `api/occupancy.ts`). When the gate behind it is not current — or the read
 * itself failed — the chip says "stale since" instead of presenting the last
 * number as live.
 */

/**
 * What the chip can honestly say about its number (S2-12 round 4; SCRUM-477).
 *
 * `line` is the whole sentence, for the tooltip and the popover; `mark` is the
 * short form that sits on the chip itself beside the amber dot — "stale since
 * 14:02", "no gate" — because a dot alone next to a zero read as a live zero,
 * and the words were only in a tooltip nobody hovers at a counter.
 */
export function occupancyStandingOf(
  data: ChipOccupancy | undefined,
  isError: boolean,
): { stale: boolean; line: string; mark: string | null } {
  const stale = isError || !data || data.stale;
  if (!stale) return { stale: false, line: 'People in park now', mark: null };
  if (data && data.gates === 0) {
    return { stale: true, line: 'No gate is reporting at this branch.', mark: 'no gate' };
  }
  const since = data?.asOf
    ? new Date(data.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  return since
    ? {
        stale: true,
        line: `Stale since ${since}: the gate has not reported since.`,
        mark: `stale since ${since}`,
      }
    : { stale: true, line: 'Stale: the gate has not reported.', mark: 'stale' };
}

export function OccupancyChip() {
  const { data, isError } = useQuery({
    queryKey: ['liveOccupancy'],
    queryFn: fetchLiveOccupancy,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  const adults = data?.adults ?? 0;
  const kids = data?.kids ?? 0;
  const total = data?.total ?? 0;
  const standing = occupancyStandingOf(data, isError);
  const { stale, line: staleLine } = standing;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={staleLine}
          aria-label={stale ? `${total} people in park. ${staleLine}` : `${total} people in park now`}
          className="rounded-md h-9 px-3 flex items-center gap-2 bg-muted hover:bg-muted/80 text-sm font-semibold transition-colors shrink-0"
        >
          <Users className="w-4 h-4 text-primary" />
          <span className="tabular-nums">{total.toLocaleString()}</span>
          {/* Hide the word on the tightest widths; the icon + number stay legible. */}
          <span className="hidden md:inline text-muted-foreground font-normal">in park</span>
          {/* S2-12 round 4: an honest mark on the chip itself when the count is
              not current — and, since SCRUM-477, the words beside it. */}
          {stale && (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
              <span className="text-xs font-normal text-amber-500" aria-hidden="true">
                {standing.mark}
              </span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
          In park now
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm">
              <User className="w-4 h-4 text-muted-foreground" />
              Adults
            </span>
            <span className="text-lg font-bold tabular-nums">{adults.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm">
              <Baby className="w-4 h-4 text-muted-foreground" />
              Kids
            </span>
            <span className="text-lg font-bold tabular-nums">{kids.toLocaleString()}</span>
          </div>
          <div className="flex items-center justify-between border-t pt-2 mt-2">
            <span className="text-sm font-semibold">Total</span>
            <span className="text-lg font-bold tabular-nums text-primary">
              {total.toLocaleString()}
            </span>
          </div>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground mt-3">
          {stale ? staleLine : "Best-effort live count from today's wristbands."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
