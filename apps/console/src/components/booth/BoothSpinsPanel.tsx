import { useEffect, useState } from 'react';
import { voucherLedgerApi, type BoothSpins } from '@/api/vouchers';
import { CONTROL, Labelled } from '@/components/Filters';
import { EmptyState, ErrorNote, Loading, Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/lib/time';

export function BoothSpinsPanel({ id, timezone }: { id: string; timezone?: string }) {
  const [date, setDate] = useState('');
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<BoothSpins | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void voucherLedgerApi
      .spins(id, date, offset)
      .then((answer) => {
        if (active) setData(answer);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not read spins.');
      });
    return () => {
      active = false;
    };
  }, [id, date, offset, refresh]);
  return (
    <Panel
      title="Spins"
      description="Every recorded press for this trading day, newest first. Offline presses appear after the box syncs; simulated spins are excluded."
      actions={
        <>
          <Labelled label="Trading day">
            <input
              className={CONTROL}
              type="date"
              value={date || data?.businessDate || ''}
              onChange={(e) => {
                setDate(e.target.value);
                setOffset(0);
              }}
            />
          </Labelled>
          <Button size="sm" variant="outline" onClick={() => setRefresh((n) => n + 1)}>
            Refresh
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorNote message={error} onRetry={() => setRefresh((n) => n + 1)} />
      ) : !data ? (
        <Loading what="spins" />
      ) : (
        <>
          <p className="mb-3 text-sm">
            {data.summary.spins} spins · {data.summary.unattributed} unattributed ·{' '}
            {data.summary.printed} printed · {data.summary.redeemed} redeemed
          </p>
          {data.spins.length === 0 ? (
            <EmptyState title="No spins for this day" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr>
                    {['Time', 'Staff', 'Prize', 'Code · last 4', 'Print', 'Redeemed'].map((h) => (
                      <th key={h} className="p-2 border-b">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.spins.map((s) => (
                    <tr key={s.id} className="border-b">
                      <td className="p-2">
                        {formatWhen(s.occurredAt, timezone)}
                        {s.clockSuspect && <div>Clock uncertain</div>}
                      </td>
                      <td className="p-2">
                        {s.staff ? `${s.staff.name ?? 'Staff'} (${s.staff.code})` : 'Unattributed'}
                      </td>
                      <td className="p-2">
                        {s.prize?.nameEn ??
                          (s.outcome === 'no_prize' ? 'No prize' : 'Prize not recorded')}
                      </td>
                      <td className="p-2 font-mono">{s.codeLast4 ?? '—'}</td>
                      <td className="p-2">
                        {s.print === 'printed'
                          ? 'Printed'
                          : s.print === 'failed'
                            ? 'Failed'
                            : s.print === 'not_reported'
                              ? 'Not reported yet'
                              : 'No voucher'}
                      </td>
                      <td className="p-2">
                        {s.redeemed ? formatWhen(s.redeemedAt, timezone) : 'No'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-end items-center gap-3 mt-3">
            <Button
              size="sm"
              variant="outline"
              disabled={!offset}
              onClick={() => setOffset((n) => Math.max(0, n - 50))}
            >
              Previous
            </Button>
            <span className="text-sm">
              {data.total ? offset + 1 : 0}–{offset + data.spins.length} of {data.total}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + data.spins.length >= data.total}
              onClick={() => setOffset((n) => n + 50)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}
