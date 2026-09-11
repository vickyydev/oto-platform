import { useQuery } from '@tanstack/react-query';
import { Users, Baby, User } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { getLiveOccupancy } from '@/mockApi';

/**
 * Persistent top-bar occupancy chip: an always-visible best-effort count of
 * people currently inside the park, tappable to reveal the adults/kids split.
 *
 * Reactivity: the mock store is in-memory with no global change events, so we
 * poll getLiveOccupancy via React Query (short interval + refetch on focus) so
 * the count follows new sales and drop-off check-ins/check-outs without each
 * page having to push updates. Swappable for a real backend at the getter seam.
 */
export function OccupancyChip() {
  const { data } = useQuery({
    queryKey: ['liveOccupancy'],
    queryFn: getLiveOccupancy,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  });

  const adults = data?.adults ?? 0;
  const kids = data?.kids ?? 0;
  const total = data?.total ?? 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="People in park now"
          aria-label={`${total} people in park now`}
          className="rounded-md h-9 px-3 flex items-center gap-2 bg-muted hover:bg-muted/80 text-sm font-semibold transition-colors shrink-0"
        >
          <Users className="w-4 h-4 text-primary" />
          <span className="tabular-nums">{total.toLocaleString()}</span>
          {/* Hide the word on the tightest widths; the icon + number stay legible. */}
          <span className="hidden md:inline text-muted-foreground font-normal">in park</span>
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
          Best-effort live count from today's wristbands.
        </p>
      </PopoverContent>
    </Popover>
  );
}
