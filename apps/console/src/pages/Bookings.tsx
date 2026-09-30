import { useEffect, useState } from 'react';
import { formatTHB } from '@oto/shared';
import { useSession } from '@/auth/SessionContext';
import { directoryApi, type BranchRow } from '@/api/platform';
import {
  BOOKING_PAGE,
  BOOKING_STATUSES,
  bookingLedgerApi,
  type BookingLedger,
  type BookingLedgerFilters,
} from '@/api/bookings';
import { CONTROL, Labelled, SelectFilter } from '@/components/Filters';
import { EmptyState, ErrorNote, Loading, Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/lib/time';

/**
 * THE BOOKINGS LIST (S2-12, SCRUM-209 round 1).
 *
 * Online bookings at one park in every state, newest first, with the payment
 * behind each. A booking is `Paid` only when the payment gateway confirmed the
 * money to the platform — the column beside it names the `WEB` invoice and
 * what the gateway made of it, so "the family says they paid" has an answer.
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

export function Bookings() {
  const { me } = useSession();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState(me?.branch?.id ?? '');
  const [filters, setFilters] = useState<BookingLedgerFilters>({});
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<BookingLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timezone = branches.find((b) => b.id === branchId)?.timezone ?? me?.branch?.timezone;

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

  const change = (next: Partial<BookingLedgerFilters>) => {
    setOffset(0);
    setFilters((held) => ({ ...held, ...next }));
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Bookings"
        description="Online bookings and the payment behind each. A booking is paid only when the payment gateway confirms the money to the platform."
        actions={
          <Button size="sm" variant="outline" onClick={() => setRefresh((n) => n + 1)}>
            Refresh
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Labelled label="Branch">
            <select
              className={CONTROL}
              value={branchId}
              onChange={(e) => {
                setBranchId(e.target.value);
                setFilters({});
                setOffset(0);
              }}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled label="Visit from">
            <input
              className={CONTROL}
              type="date"
              value={filters.from ?? ''}
              onChange={(e) => change({ from: e.target.value || undefined })}
            />
          </Labelled>
          <Labelled label="Visit to">
            <input
              className={CONTROL}
              type="date"
              value={filters.to ?? ''}
              onChange={(e) => change({ to: e.target.value || undefined })}
            />
          </Labelled>
          <SelectFilter
            label="Status"
            value={filters.status ?? ''}
            onChange={(value) => change({ status: (value as BookingLedgerFilters['status']) || undefined })}
            options={BOOKING_STATUSES.map((value) => ({ value, label: statusWords[value] ?? value }))}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Times use {timezone ?? 'the branch timezone'}. The payment day is the day the money was taken,
          which is the day it appears on the gateway's settlement — not the visit day.
        </p>
      </Panel>
      {error && <ErrorNote message={error} onRetry={() => setRefresh((n) => n + 1)} />}
      {!data && !error && <Loading what="bookings" />}
      {data && (
        <Panel title={`${data.total} bookings`}>
          {data.rows.length === 0 ? (
            <EmptyState title="No bookings match" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr>
                    {['Booked at', 'Reference', 'Visit', 'Family', 'Party', 'Total', 'Status', 'Payment', 'Redemption'].map(
                      (h) => (
                        <th key={h} className="p-2 border-b whitespace-nowrap">
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id} className="border-b align-top">
                      <td className="p-2 whitespace-nowrap">{formatWhen(r.createdAt, timezone)}</td>
                      <td className="p-2 font-mono whitespace-nowrap">{r.reference}</td>
                      <td className="p-2 whitespace-nowrap">
                        {r.bookingDate}
                        {r.rateMode && <div className="text-muted-foreground">{r.rateMode} prices</div>}
                      </td>
                      <td className="p-2">
                        {r.parentName ?? '—'}
                        {r.phone && <div className="text-muted-foreground">{r.phone}</div>}
                      </td>
                      <td className="p-2 whitespace-nowrap">
                        {r.kidsCount} kids · {r.adultsCount} adults
                      </td>
                      <td className="p-2 whitespace-nowrap">{formatTHB(r.totalSatang)}</td>
                      <td className="p-2">
                        {statusWords[r.status] ?? r.status}
                        {r.status === 'pending' && r.expiresAt && (
                          <div className="text-muted-foreground">held until {formatWhen(r.expiresAt, timezone)}</div>
                        )}
                        {r.paidAt && <div className="text-muted-foreground">paid {formatWhen(r.paidAt, timezone)}</div>}
                        {r.qrIssued && <div className="text-muted-foreground">signed QR issued</div>}
                      </td>
                      <td className="p-2 min-w-48">
                        {r.payment ? (
                          <>
                            <div className="font-mono">{r.payment.invoiceNo ?? '—'}</div>
                            <div>
                              {attemptWords[r.payment.status] ?? r.payment.status} · {r.payment.method} ·{' '}
                              {r.payment.provider}
                            </div>
                            <div className="text-muted-foreground">payment day {r.payment.businessDate}</div>
                          </>
                        ) : r.legacy ? (
                          <span className="text-muted-foreground">
                            Marked paid before online payment was real — no payment on record
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Not started</span>
                        )}
                      </td>
                      <td className="p-2 min-w-40">
                        {r.redemption ? (
                          <>
                            {formatWhen(r.redemption.at, timezone)}
                            <div>{[r.redemption.stationName, r.redemption.staffName].filter(Boolean).join(' · ')}</div>
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center justify-end gap-3 mt-4">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset((n) => Math.max(0, n - BOOKING_PAGE))}
            >
              Previous
            </Button>
            <span className="text-sm">
              {data.total ? offset + 1 : 0}–{offset + data.rows.length} of {data.total}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + data.rows.length >= data.total}
              onClick={() => setOffset((n) => n + BOOKING_PAGE)}
            >
              Next
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}
