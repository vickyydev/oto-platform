import { useEffect, useState, type ReactNode } from 'react';
import { CalendarCheck, Check, QrCode, RefreshCw } from 'lucide-react';
import { branchToday, formatTHB } from '@oto/shared';
import { useSession } from '@/auth/SessionContext';
import { directoryApi, type BranchRow } from '@/api/platform';
import {
  BOOKING_PAGE,
  BOOKING_STATUSES,
  bookingLedgerApi,
  type BookingLedger,
  type BookingLedgerFilters,
  type BookingLedgerRow,
} from '@/api/bookings';
import { ErrorNote, Loading } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { BarChip, FilterChip, SelectChip, StatusChip, TitleChip } from '@/components/redesign/chips';
import { CardShell, Eyebrow, PageGrid, Rail, RailNote, StripedList } from '@/components/redesign/layout';
import { EmptyNote, StatTile } from '@/components/redesign/StatTile';
import { formatWhen } from '@/lib/time';
import { cn } from '@/lib/utils';

/**
 * THE BOOKINGS LIST (S2-12, SCRUM-209 round 1; restyled SCRUM-474 phase 2a,
 * Bookings.dc.html).
 *
 * Online bookings at one park in every state, newest first, with the payment
 * behind each. A booking is `Paid` only when the payment gateway confirmed the
 * money to the platform — the line under each row names the `WEB` invoice and
 * what the gateway made of it, so "the family says they paid" has an answer.
 *
 * The artboard's six columns are the row; everything the old table's Payment
 * and Redemption columns held is the small line beneath it, which wraps
 * instead of being cut off at the card's edge. The rail on the right is built
 * from the rows on screen and says so: the ledger route answers a page and a
 * total, nothing else, and no figure here pretends to more than that.
 */
const statusWords: Record<string, string> = {
  pending: 'Waiting for payment',
  paid: 'Paid',
  redeemed: 'Redeemed',
  expired: 'Expired unpaid',
  cancelled: 'Payment failed',
};

const attemptWords: Record<string, string> = {
  created: 'Opening',
  sent_to_terminal: 'On the payment page',
  approved: 'Paid',
  declined: 'Declined',
  cancelled: 'Closed unpaid',
  unknown: 'No answer',
  inquiring: 'Checking',
  not_found: 'Unknown to the gateway',
  awaiting_staff_confirmation: 'Needs a person',
  awaiting_settlement: 'Awaiting settlement',
};

/** The pill's shorter words; the filter chips keep the fuller ones above. */
const pillWords: Record<string, string> = {
  pending: 'Pending',
  paid: 'Paid',
  redeemed: 'Redeemed',
  expired: 'Expired',
  cancelled: 'Payment failed',
};

/**
 * The row's six columns: booking, visit, family, party, total, state. Fixed
 * widths for everything but the family, so each row — a grid of its own —
 * lines up with the header and with its neighbours. From 36rem of CARD, which
 * is a 1280 px laptop with the sidebar open; below that the cells wrap.
 */
const ROW_COLUMNS =
  '@2xl:grid @2xl:grid-cols-[84px_96px_minmax(0,1fr)_60px_76px_144px] @2xl:gap-x-3';

export function Bookings() {
  const { me } = useSession();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState(me?.branch?.id ?? '');
  const [filters, setFilters] = useState<BookingLedgerFilters>({});
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<BookingLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const branch = branches.find((b) => b.id === branchId);
  const timezone = branch?.timezone ?? me?.branch?.timezone;
  const branchName = branch?.name ?? me?.branch?.name;

  useEffect(() => {
    void directoryApi
      .branches()
      .then((b) => {
        const live = b.branches.filter((row) => !row.archived);
        setBranches(live);
        setBranchId((id) => id || live[0]?.id || '');
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the parks.'));
  }, []);

  useEffect(() => {
    if (!branchId) return;
    let active = true;
    setData(null);
    setError(null);
    void bookingLedgerApi
      .list(branchId, filters, offset)
      .then((answer) => {
        if (active) setData(answer);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not read bookings.');
      });
    return () => {
      active = false;
    };
  }, [branchId, filters, offset, refresh]);

  // A pending pill counts its hold down, so the clock it reads moves while the
  // page is open: once a half-minute, and only while there is a hold to count.
  const hasPending = data?.rows.some((r) => r.status === 'pending') ?? false;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasPending) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [hasPending, data]);

  const change = (next: Partial<BookingLedgerFilters>) => {
    setOffset(0);
    setFilters((held) => ({ ...held, ...next }));
  };

  const today = timezone ? safeToday(timezone) : null;
  // Every matching row is on screen, so a sum over them is the sum for the
  // filters and not for one page of them.
  const whole = data !== null && data.rows.length >= data.total;
  const paidOnlineSatang = data && whole ? paidOnline(data.rows) : null;

  return (
    <>
      <CommandBar
        sectionId="bookings"
        place={branchName}
        badges={<TitleChip>paid online, redeemed at reception</TitleChip>}
        actions={
          <>
            {data && (
              <BarChip title="Matching the filters, across every page">
                {data.total} booking{data.total === 1 ? '' : 's'}
              </BarChip>
            )}
            {paidOnlineSatang !== null && (
              <BarChip
                tone="ok"
                title="Paid and redeemed bookings matching the filters, gateway-confirmed only"
              >
                {formatTHB(paidOnlineSatang)} paid online
              </BarChip>
            )}
            <SelectChip
              label="Branch"
              showLabel
              value={branchId}
              onChange={(value) => {
                setBranchId(value);
                setFilters({});
                setOffset(0);
              }}
              options={branches.map((b) => ({ value: b.id, label: b.name }))}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-2 rounded-full px-3.5"
              onClick={() => setRefresh((n) => n + 1)}
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Status">
          <FilterChip active={!filters.status} onClick={() => change({ status: undefined })}>
            All
          </FilterChip>
          {BOOKING_STATUSES.map((value) => (
            <FilterChip
              key={value}
              active={filters.status === value}
              onClick={() => change({ status: value })}
            >
              {statusWords[value] ?? value}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 @2xl:ml-auto">
          <DateChip label="Visit from" value={filters.from ?? ''} onChange={(from) => change({ from })} />
          <DateChip label="Visit to" value={filters.to ?? ''} onChange={(to) => change({ to })} />
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={() => setRefresh((n) => n + 1)} />}
      {!data && !error && <Loading what="bookings" />}
      {data && (
        <PageGrid>
          <CardShell
            span={9}
            title="Bookings"
            note={`newest first · times in ${timezone ?? 'the branch timezone'}`}
            footer={
              <>
                <span>A booking is paid only when the gateway says so — never by the browser.</span>
                <span className="flex items-center gap-3">
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full px-3.5"
                    disabled={offset === 0}
                    onClick={() => setOffset((n) => Math.max(0, n - BOOKING_PAGE))}
                  >
                    Previous
                  </Button>
                  <span className="text-sm tabular-nums">
                    {data.total ? offset + 1 : 0}–{offset + data.rows.length} of {data.total}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full px-3.5"
                    disabled={offset + data.rows.length >= data.total}
                    onClick={() => setOffset((n) => n + BOOKING_PAGE)}
                  >
                    Next
                  </Button>
                </span>
              </>
            }
          >
            {data.rows.length === 0 ? (
              <EmptyNote
                icon={CalendarCheck}
                title="No bookings match"
                detail="Nothing was booked under these filters. Widen the visit days, or choose All above."
              />
            ) : (
              <div className="flex min-w-0 flex-col gap-1">
                <div
                  aria-hidden="true"
                  className={cn(
                    'hidden px-3 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80',
                    ROW_COLUMNS,
                  )}
                >
                  <span>Booking</span>
                  <span>Visit</span>
                  <span>Family</span>
                  <span>Party</span>
                  <span className="text-right">Total</span>
                  <span className="text-right">State</span>
                </div>
                <StripedList as="ol" label="Bookings">
                  {data.rows.map((r) => (
                    <BookingRow key={r.id} row={r} timezone={timezone} today={today} now={now} />
                  ))}
                </StripedList>
              </div>
            )}
          </CardShell>

          <Rail span={3}>
            <RedemptionRail ledger={data} timezone={timezone} whole={whole} />
          </Rail>
        </PageGrid>
      )}
    </>
  );
}

/**
 * A visit-day bound, dressed as the command bar's chips are. Native, because a
 * date input a keyboard and a phone already know how to drive is worth more
 * here than a prettier one; labelled visibly, so "from" and "to" read as a pair.
 */
function DateChip({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string | undefined) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2">
      <span className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
        {label}
      </span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="h-9 rounded-full border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </label>
  );
}

/** One booking: the artboard's six columns, and the money's story beneath. */
function BookingRow({
  row: r,
  timezone,
  today,
  now,
}: {
  row: BookingLedgerRow;
  timezone?: string | null;
  today: string | null;
  now: number;
}) {
  return (
    <li
      className={cn(
        'flex flex-wrap gap-x-3.5 gap-y-1.5 px-3 py-[11px] text-[13.5px] @2xl:items-start',
        ROW_COLUMNS,
        r.status === 'expired' && 'opacity-60',
      )}
    >
      <Cell label="Booking">
        <span className="font-mono text-xs">{r.reference}</span>
        <span className="block text-xs text-muted-foreground">{formatWhen(r.createdAt, timezone)}</span>
      </Cell>
      <Cell label="Visit" className="text-muted-foreground">
        <span title={r.bookingDate}>{visitWord(r.bookingDate, today)}</span>
        {r.rateMode && <span className="block text-xs">{r.rateMode} prices</span>}
      </Cell>
      <Cell label="Family">
        <span className="font-semibold">{r.parentName ?? '—'}</span>
        {r.phone && (
          <span className="block text-xs text-muted-foreground whitespace-nowrap">{r.phone}</span>
        )}
      </Cell>
      <Cell label="Party" className="text-muted-foreground whitespace-nowrap">
        {count(r.kidsCount, 'kid')}
        <span className="block text-xs">{count(r.adultsCount, 'adult')}</span>
      </Cell>
      <Cell label="Total" className="font-semibold tabular-nums @2xl:text-right">
        {formatTHB(r.totalSatang)}
      </Cell>
      <Cell label="State" className="@2xl:flex @2xl:flex-col @2xl:items-end @2xl:text-right">
        <StatePill row={r} now={now} />
        {r.status === 'pending' && r.expiresAt && (
          <span className="mt-1 block text-xs text-muted-foreground">
            held until {formatWhen(r.expiresAt, timezone)}
          </span>
        )}
        {r.paidAt && (
          <span className="mt-1 block text-xs text-muted-foreground">paid {formatWhen(r.paidAt, timezone)}</span>
        )}
      </Cell>
      <MoneyLine row={r} timezone={timezone} />
    </li>
  );
}

/**
 * A cell of the row. The column it sits under is read out before its value,
 * because the stacked phone layout has no header row to say what a figure is.
 */
function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 break-words', className)}>
      <span className="sr-only">{label}: </span>
      {children}
    </div>
  );
}

/**
 * The state, in the ledger's chip language (chips.tsx). The two states somebody
 * may still act on carry a status ink WITH its shape — paid and waiting for the
 * family (the dot), pending with its hold counting down (the triangle). The
 * finished ones carry no status ink: redeemed on the mint wash with a tick,
 * expired and failed on the neutral one.
 */
function StatePill({ row, now }: { row: BookingLedgerRow; now: number }) {
  if (row.status === 'paid') return <StatusChip tone="ok">Paid</StatusChip>;
  if (row.status === 'pending') {
    return (
      <StatusChip tone="warn">
        Pending · {holdWord(row.expiresAt, now)}
      </StatusChip>
    );
  }
  const redeemed = row.status === 'redeemed';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-[11px] py-1 text-xs font-bold whitespace-nowrap',
        redeemed ? 'bg-secondary text-secondary-foreground' : 'bg-muted text-muted-foreground',
      )}
    >
      {redeemed && <Check className="w-3 h-3" strokeWidth={3} aria-hidden="true" />}
      {pillWords[row.status] ?? row.status}
    </span>
  );
}

/**
 * The line under a row: the payment the gateway holds for it, the signed QR,
 * and the redemption — every fact the old Payment and Redemption columns
 * carried, on a line that wraps rather than one that is cut off at the edge.
 */
function MoneyLine({ row: r, timezone }: { row: BookingLedgerRow; timezone?: string | null }) {
  const facts: ReactNode[] = [];
  if (r.payment) {
    facts.push(
      <span key="payment">
        <span className="font-mono">{r.payment.invoiceNo ?? '—'}</span> ·{' '}
        {attemptWords[r.payment.status] ?? r.payment.status} · {r.payment.method} · {r.payment.provider} ·
        payment day {r.payment.businessDate}
      </span>,
    );
  } else if (r.legacy) {
    facts.push(
      <span key="payment">Marked paid before online payment was real — no payment on record</span>,
    );
  } else {
    facts.push(<span key="payment">Payment not started</span>);
  }
  if (r.qrIssued) facts.push(<span key="qr">signed QR issued</span>);
  if (r.redemption) {
    const where = [r.redemption.stationName, r.redemption.staffName].filter(Boolean).join(' · ');
    facts.push(
      <span key="redemption">
        redeemed {formatWhen(r.redemption.at, timezone)}
        {where ? ` · ${where}` : ''}
      </span>,
    );
  }
  return (
    <div className="flex w-full min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground @2xl:col-span-full">
      {facts.map((fact, i) => (
        <span key={i} className="flex min-w-0 flex-wrap gap-x-3 break-words">
          {i > 0 && <span aria-hidden="true">—</span>}
          {fact}
        </span>
      ))}
    </div>
  );
}

/**
 * The rail: what the rows ON SCREEN say about redemption, and nothing more.
 * The ledger route answers one page and a count; it has no "redeemed today"
 * and no week, so the rail counts the page and says which page it counted.
 */
function RedemptionRail({
  ledger,
  timezone,
  whole,
}: {
  ledger: BookingLedger;
  timezone?: string | null;
  /** Every matching row is on screen, so the counts are the counts for the filters. */
  whole: boolean;
}) {
  const shown = ledger.rows;
  const redeemed = shown
    .flatMap((r) => (r.redemption ? [{ row: r, redemption: r.redemption }] : []))
    .sort((a, b) => (a.redemption.at < b.redemption.at ? 1 : -1));
  const scope = whole
    ? `of the ${ledger.total} matching the filters`
    : `of the ${shown.length} on this page`;
  const states = BOOKING_STATUSES.map((status) => ({
    status,
    count: shown.filter((r) => r.status === status).length,
  })).filter((s) => s.count > 0);

  return (
    <>
      <CardShell title="Redemption" icon={QrCode}>
        <StatTile inset label="Redeemed" value={redeemed.length} detail={scope} />
        {redeemed.length > 0 ? (
          <ol className="flex flex-col gap-2 text-[12.5px]" aria-label="Latest redemptions">
            {redeemed.slice(0, 6).map(({ row: r, redemption }) => (
              <li key={r.id} className="flex flex-col">
                <span className="flex justify-between gap-3">
                  <span className="font-mono text-xs">{r.reference}</span>
                  <span className="text-muted-foreground">{formatWhen(redemption.at, timezone)}</span>
                </span>
                <span className="text-muted-foreground">
                  {[redemption.stationName, redemption.staffName].filter(Boolean).join(' · ') ||
                    'station and staff not recorded'}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <RailNote>No redemption among the bookings shown.</RailNote>
        )}
        <RailNote>
          Reception scans the signed QR at the counter; a booking is redeemed once, and the platform
          keeps where and by whom.
        </RailNote>
      </CardShell>

      <CardShell className="flex-1">
        <Eyebrow>{whole ? 'Matching the filters' : 'On this page'}</Eyebrow>
        {states.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
            {states.map((s) => (
              <li key={s.status} className="flex justify-between gap-3">
                <span>{statusWords[s.status] ?? s.status}</span>
                <span className="font-semibold text-foreground tabular-nums">{s.count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <RailNote>Nothing to count.</RailNote>
        )}
        <RailNote className="mt-auto">
          The payment day is the day the money was taken, which is the day it appears on the
          gateway's settlement — not the visit day.
        </RailNote>
      </CardShell>
    </>
  );
}

/** What the gateway confirmed: paid and redeemed rows, never a legacy "paid" with nothing behind it. */
function paidOnline(rows: BookingLedgerRow[]): number {
  return rows
    .filter((r) => (r.status === 'paid' || r.status === 'redeemed') && !r.legacy)
    .reduce((sum, r) => sum + r.totalSatang, 0);
}

/** How much of a pending booking's hold is left, as the pill says it: "18 min". */
function holdWord(expiresAt: string | null, now: number): string {
  if (!expiresAt) return 'awaiting payment';
  const left = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(left)) return 'awaiting payment';
  if (left <= 0) return 'hold ended';
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`;
}

/** A visit day as the artboard reads it: "today", or "4 Oct" (with the year when it is another one). */
function visitWord(isoDate: string, today: string | null): string {
  if (today && isoDate === today) return 'today';
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDate;
  const sameYear = !today || today.slice(0, 4) === isoDate.slice(0, 4);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  }).format(date);
}

/** Today at the park, or nothing when the zone the branch names cannot be read. */
function safeToday(timezone: string): string | null {
  try {
    return branchToday(timezone);
  } catch {
    return null;
  }
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
