import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTHB } from '@oto/shared';
import { ApiError, idemKey } from '@/api/client';
import { settlementsApi, settlementWord, type SettlementSummary } from '@/api/settlements';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

/** Settlement stays separate from the count: it never rewrites a locked End of Day. */
export function SettlementPanel({
  branchId,
  date,
  canSettle,
}: {
  branchId: string;
  date: string;
  canSettle: boolean;
}) {
  const [data, setData] = useState<SettlementSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState('');
  const [tid, setTid] = useState('');
  const current = useRef(`${branchId}:${date}`);
  const scope = `${branchId}:${date}`;
  current.current = scope;
  // A lost answer is retried with the same identity; never silently settle twice.
  const runKeys = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    try {
      const result = await settlementsApi.read(branchId, date);
      if (current.current === scope) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (current.current === scope)
        setError(err instanceof Error ? err.message : 'Could not read settlement.');
    }
  }, [branchId, date, scope]);
  useEffect(() => {
    setData(null);
    setError(null);
    setNotice(null);
    setDeviceId('');
    setTid('');
    void load();
    const timer = window.setInterval(() => {
      void load();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function run() {
    if (running || !deviceId) return;
    const key = `${scope}:${deviceId}`;
    const idempotencyKey = runKeys.current.get(key) ?? idemKey();
    runKeys.current.set(key, idempotencyKey);
    setRunning(key);
    setError(null);
    setNotice(null);
    try {
      await settlementsApi.run(branchId, date, deviceId, idempotencyKey);
      runKeys.current.delete(key);
      if (current.current === scope) {
        setNotice('Settlement requested. Waiting for the terminal result.');
        await load();
      }
    } catch (err) {
      if (err instanceof ApiError && err.status < 500 && err.code !== 'IDEMPOTENCY_IN_FLIGHT') runKeys.current.delete(key);
      if (current.current === scope)
        setError(err instanceof Error ? err.message : 'Could not request settlement.');
    } finally {
      setRunning(null);
    }
  }

  async function download() {
    if (!tid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await settlementsApi.export(branchId, date, tid);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `settlement-${date}-${tid.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      if (current.current === scope)
        setError(err instanceof Error ? err.message : 'Could not download settlement.');
    } finally {
      setBusy(false);
    }
  }

  const tids = [
    ...new Set(
      [...(data?.devices ?? []), ...(data?.batches ?? []), ...(data?.unmatchedAttempts ?? [])]
        .map((row) => row.tid)
        .filter((value): value is string => !!value),
    ),
  ];
  const waiting = data?.batches.some(
    (batch) => batch.deviceId === deviceId && batch.state === 'pending',
  );
  return (
    <Card className="p-4 sm:p-5 bg-card/50 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Payment settlement</h3>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          Refresh settlement
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Compare terminal and 2C2P batches with recorded payments. A closed day's cash count stays
        unchanged.
      </p>
      {error && (
        <p role="alert" className="text-sm text-amber-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {!data && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading settlement…
        </p>
      )}
      {data && (
        <>
          {canSettle && (
            <div className="flex flex-wrap gap-2 items-end">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground flex-1 min-w-0">
                Terminal
                <select
                  aria-label="Settlement terminal"
                  className="h-10 rounded-lg bg-muted border border-border px-2 text-sm text-foreground w-full"
                  value={deviceId}
                  onChange={(event) => setDeviceId(event.target.value)}
                  disabled={!!running}
                >
                  <option value="">Choose terminal</option>
                  {data.devices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {device.label} · {device.tid ?? 'No TID'}
                      {device.provider === 'simulator' ? ' (simulator)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                disabled={!deviceId || !!running || waiting}
                onClick={() => void run()}
              >
                {running || waiting ? 'Waiting for terminal…' : 'Run settlement'}
              </Button>
            </div>
          )}
          {canSettle && data.devices.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No active payment terminal is configured for this park.
            </p>
          )}
          <SettlementResults data={data} />
          <div className="flex flex-wrap gap-2 items-end">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground flex-1 min-w-0">
              Export terminal
              <select
                aria-label="Export settlement TID"
                className="h-10 rounded-lg bg-muted border border-border px-2 text-sm text-foreground w-full"
                value={tid}
                onChange={(event) => setTid(event.target.value)}
              >
                <option value="">Choose TID</option>
                {tids.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <Button variant="outline" disabled={!tid || busy} onClick={() => void download()}>
              {busy ? 'Downloading…' : 'Download CSV'}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export function SettlementResults({ data }: { data: SettlementSummary }) {
  return (
    <div className="space-y-3 text-sm">
      {data.batches.length === 0 && (
        <p className="text-muted-foreground">No settlement batches for this day.</p>
      )}
      {data.batches.map((batch) => (
        <div key={batch.id} className="rounded-xl border border-border p-3 space-y-1">
          <div className="flex flex-wrap justify-between gap-2">
            <strong>
              {batch.source === '2c2p' ? '2C2P import' : `Terminal ${batch.tid ?? 'without TID'}`}
            </strong>
            <span className={batch.state === 'matched' ? 'text-emerald-600' : 'text-amber-600'}>
              {settlementWord(batch.state)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            {batch.matched} matched · {batch.unmatched} unmatched · {batch.mismatched} differ
          </p>
          {batch.state === 'unsupported' && (
            <p className="text-xs">
              This terminal cannot provide settlement through the box. No payments were marked
              settled.
            </p>
          )}
        </div>
      ))}
      {data.lines.length > 0 && (
        <details className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer font-medium">
            Batch lines ({data.lines.length})
          </summary>
          <ul className="mt-2 divide-y divide-border">
            {data.lines.map((line) => (
              <li key={line.id} className="py-2 break-words">
                <div className="flex flex-wrap justify-between gap-1">
                  <span>
                    {line.method === 'card' ? 'Card' : 'QR'} · {line.tid ?? 'No TID'} · {line.transactionType ?? 'payment'}
                  </span>
                  <strong>{formatTHB(line.amountSatang)}</strong>
                </div>
                <p>{settlementWord(line.match)}</p>
                <p className="text-xs text-muted-foreground break-all">
                  Invoice: {line.invoiceNo ?? '—'} · Approval: {line.approvalCode ?? '—'} ·
                  Reference: {line.tranRef ?? '—'}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {data.unmatchedAttempts.length > 0 && (
        <details className="rounded-xl border border-amber-500/30 p-3">
          <summary className="cursor-pointer font-medium">
            Payments without a matched settlement ({data.unmatchedAttempts.length})
          </summary>
          <ul className="mt-2 divide-y divide-border">
            {data.unmatchedAttempts.map((attempt) => (
              <li key={attempt.id} className="py-2 break-words">
                <div className="flex flex-wrap justify-between gap-1">
                  <span>
                    {attempt.method === 'card' ? 'Card' : 'QR'} · {attempt.tid ?? 'No TID'}
                  </span>
                  <strong>{formatTHB(attempt.amountSatang)}</strong>
                </div>
                <p className="text-xs text-muted-foreground break-all">
                  {attempt.invoiceNo ?? 'No invoice'} ·{' '}
                  {attempt.status === 'awaiting_settlement'
                    ? 'Awaiting settlement'
                    : 'Approved payment'}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
