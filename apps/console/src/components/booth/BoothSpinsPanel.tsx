import { useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { voucherLedgerApi, type BoothSpinRow, type BoothSpins } from '@/api/vouchers';
import { ErrorNote, Loading } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { formatWhen } from '@/lib/time';
import { cn } from '@/lib/utils';
import { logTime } from './todayStaff';

/** A page of spins: the route's own limit, and what Previous and Next step by. */
const PAGE = 50;

/**
 * Every recorded press at this booth on one trading day, newest first — the
 * artboard's activity card (SCRUM-474), with the day chosen on the title row.
 *
 * The card reads its own route and keeps its own day and page, so the rest of
 * the page is not re-read when somebody looks at last Saturday. What it hands
 * up is today's answer alone (`onToday`): the day's totals for the tiles, and
 * whether the rows on screen are the WHOLE day, which is what lets the wheel
 * count each prize's wins without pretending fifty rows are a day.
 */
export function BoothSpinsPanel({
  id,
  timezone,
  inks,
  onToday,
}: {
  id: string;
  timezone?: string | null;
  /** Each prize's colour on the page, so a spin's dot is the wedge it landed on. */
  inks?: ReadonlyMap<string, string>;
  /** Today's spins as read, and whether every one of them is on screen. */
  onToday?: (spins: BoothSpins, whole: boolean) => void;
}) {
  const [date, setDate] = useState('');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<BoothSpins | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The newest callback, read when an answer lands, so a new function from
  // the page's render does not send the read again.
  const onTodayRef = useRef(onToday);
  useEffect(() => {
    onTodayRef.current = onToday;
  });

  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void voucherLedgerApi
      .spins(id, date, offset)
      .then((answer) => {
        if (!active) return;
        setData(answer);
        if (date === '') {
          onTodayRef.current?.(answer, offset === 0 && answer.spins.length >= answer.total);
        }
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not read spins.');
      });
    return () => {
      active = false;
    };
  }, [id, date, offset, refresh]);

  return (
    <CardShell
      icon={Activity}
      title="Spins"
      note={
        data
          ? `every recorded press on ${data.businessDate}, newest first — offline presses appear after the box syncs; simulated spins are excluded`
          : 'every recorded press for the trading day, newest first — offline presses appear after the box syncs; simulated spins are excluded'
      }
      actions={
        <>
          <label className="inline-flex items-center gap-2">
            <span className="sr-only">Trading day</span>
            <input
              type="date"
              className="h-9 rounded-full border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              value={date || data?.businessDate || ''}
              onChange={(e) => {
                setDate(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full px-3.5"
            onClick={() => setRefresh((n) => n + 1)}
          >
            Refresh
          </Button>
        </>
      }
      footer={
        data ? (
          <>
            <span className="tabular-nums">
              {data.summary.spins} spins · {data.summary.unattributed} unattributed ·{' '}
              {data.summary.printed} printed · {data.summary.redeemed} redeemed
            </span>
            <span className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                className="rounded-full px-3.5"
                disabled={!offset}
                onClick={() => setOffset((n) => Math.max(0, n - PAGE))}
              >
                Previous
              </Button>
              <span className="text-sm tabular-nums">
                {data.total ? offset + 1 : 0}–{offset + data.spins.length} of {data.total}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="rounded-full px-3.5"
                disabled={offset + data.spins.length >= data.total}
                onClick={() => setOffset((n) => n + PAGE)}
              >
                Next
              </Button>
            </span>
          </>
        ) : undefined
      }
    >
      {error ? (
        <ErrorNote message={error} onRetry={() => setRefresh((n) => n + 1)} />
      ) : !data ? (
        <Loading what="spins" />
      ) : data.spins.length === 0 ? (
        <EmptyNote
          className="py-3"
          icon={Activity}
          title="No spins for this day"
          detail="Nothing was pressed at this booth on this trading day, or the box has not synced it yet."
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="hidden gap-3.5 px-3 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80 @lg:grid @lg:grid-cols-[56px_minmax(0,1fr)_minmax(0,170px)_minmax(0,190px)]">
            <span>Time</span>
            <span>Prize</span>
            <span>Staff</span>
            <span>Voucher</span>
          </div>
          <StripedList label="Spins">
            {data.spins.map((s) => (
              <SpinLine key={s.id} spin={s} timezone={timezone} ink={s.prize ? inks?.get(s.prize.id) : undefined} />
            ))}
          </StripedList>
        </div>
      )}
    </CardShell>
  );
}

/** One press: when, what it landed on, who was signed in, and the paper it minted. */
function SpinLine({
  spin: s,
  timezone,
  ink,
}: {
  spin: BoothSpinRow;
  timezone?: string | null;
  ink: string | undefined;
}) {
  const prizeName =
    s.prize?.nameEn ?? (s.outcome === 'no_prize' ? 'No prize' : 'Prize not recorded');
  const won = s.prize !== null;
  return (
    <li className="flex flex-wrap gap-x-3.5 gap-y-1 px-3 py-[9px] text-[13.5px] @lg:grid @lg:grid-cols-[56px_minmax(0,1fr)_minmax(0,170px)_minmax(0,190px)] @lg:items-center">
      <span className="text-[12.5px] text-muted-foreground tabular-nums">
        {logTime(s.occurredAt, timezone)}
        {s.clockSuspect && (
          <span className="block text-[11px] text-status-warn">Clock uncertain</span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-[9px]">
        <span
          aria-hidden="true"
          className={cn(
            'h-[9px] w-[9px] shrink-0 rounded-full',
            !won && 'border-2 border-foreground/35 bg-card',
          )}
          style={won ? { backgroundColor: ink } : undefined}
        />
        <span className={cn('min-w-0 break-words', won ? 'font-semibold' : 'text-muted-foreground')}>
          {prizeName}
        </span>
      </span>
      <span className="min-w-0 break-words text-muted-foreground">
        {s.staff ? `${s.staff.name ?? 'Staff'} (${s.staff.code})` : 'Unattributed'}
      </span>
      <span
        className={cn(
          'min-w-0 break-words font-mono text-xs',
          s.redeemed ? 'text-status-ok' : 'text-muted-foreground',
        )}
      >
        {voucherWords(s, timezone)}
      </span>
    </li>
  );
}

/**
 * The paper: the code's last four, then whether it printed, and when it was
 * redeemed once it has been. "Not reported yet" is the box that has not said,
 * which is not a failed print.
 */
function voucherWords(s: BoothSpinRow, timezone?: string | null): string {
  if (s.codeLast4 === null) return '—';
  if (s.redeemed) return `····-${s.codeLast4} · redeemed ${formatWhen(s.redeemedAt, timezone)}`;
  const print =
    s.print === 'printed'
      ? 'printed'
      : s.print === 'failed'
        ? 'print failed'
        : s.print === 'not_reported'
          ? 'print not reported yet'
          : 'no voucher';
  return `····-${s.codeLast4} · ${print}`;
}
