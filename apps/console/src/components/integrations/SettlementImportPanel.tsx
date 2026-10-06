import { useEffect, useRef, useState } from 'react';
import { businessDate, parseDayStart, formatTHB } from '@oto/shared';
import { FileSpreadsheet } from 'lucide-react';
import { ApiError, idemKey } from '@/api/client';
import { directoryApi, type BranchRow } from '@/api/platform';
import {
  MAX_SETTLEMENT_FILE_BYTES,
  settlementApi,
  type SettlementImportResult,
  type SettlementSummary,
} from '@/api/settlements';
import { useSession } from '@/auth/SessionContext';
import { Button } from '@/components/ui/button';
import { CardShell } from '@/components/redesign/layout';

export function SettlementImportPanel() {
  const { has, me, permissions } = useSession();
  if (!has('pos:payment:settle')) return null;
  return (
    <SettlementImportForm
      key={me?.account.id}
      initialBranchId={me?.branch?.id ?? ''}
      permissions={permissions}
    />
  );
}

function SettlementImportForm({
  initialBranchId,
  permissions,
}: {
  initialBranchId: string;
  permissions: Array<{ permission: string; scopeType: string; scopeId: string | null }>;
}) {
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState(initialBranchId);
  const [date, setDate] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<SettlementImportResult | null>(null);
  const [data, setData] = useState<SettlementSummary | null>(null);
  const importIdentity = useRef<{ branchId: string; date: string; file: File; key: string } | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    void directoryApi
      .branches()
      .then(({ branches: rows }) => {
        if (!active) return;
        const allowed = rows.filter(
          (row) =>
            !row.archived &&
            permissions.some(
              (p) =>
                p.permission === 'pos:payment:settle' &&
                (p.scopeType === 'operator' || (p.scopeType === 'branch' && p.scopeId === row.id)),
            ),
        );
        setBranches(allowed);
        setBranchId((id) => (allowed.some((row) => row.id === id) ? id : (allowed[0]?.id ?? '')));
        const selected = allowed.find((row) => row.id === initialBranchId) ?? allowed[0];
        if (selected?.businessDayStart)
          setDate(
            (value) =>
              value ||
              businessDate(
                new Date(),
                selected.timezone,
                parseDayStart(selected.businessDayStart!),
              ),
          );
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not read parks.');
      });
    return () => {
      active = false;
    };
  }, [permissions, initialBranchId]);

  useEffect(() => {
    let active = true;
    setData(null);
    if (branchId && date)
      void settlementApi
        .read(branchId, date)
        .then((answer) => {
          if (active) setData(answer);
        })
        .catch((err: unknown) => {
          if (active) setError(err instanceof Error ? err.message : 'Could not read settlement.');
        });
    return () => {
      active = false;
    };
  }, [branchId, date, refresh]);

  async function importFile() {
    if (!branchId || !date || !file || busy) return;
    setError(null);
    setResult(null);
    if (file.size === 0 || file.size > MAX_SETTLEMENT_FILE_BYTES) {
      setError('Choose a non-empty CSV no larger than 2 MB.');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Choose a .csv file.');
      return;
    }
    const previous = importIdentity.current;
    const identity =
      previous?.branchId === branchId && previous.date === date && previous.file === file
        ? previous
        : { branchId, date, file, key: idemKey() };
    importIdentity.current = identity;
    setBusy(true);
    try {
      const csv = await file.text();
      const answer = await settlementApi.import(branchId, date, file.name, csv, identity.key);
      setResult(answer);
      importIdentity.current = null;
      setRefresh((value) => value + 1);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500 && err.code !== 'IDEMPOTENCY_IN_FLIGHT') importIdentity.current = null;
      setError(err instanceof Error ? err.message : 'Could not import settlement.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell
      span={12}
      icon={FileSpreadsheet}
      title="2C2P settlement import"
      note="Match a settlement file against recorded payments; a closed End of Day stays unchanged."
    >
      <p className="text-sm text-muted-foreground">
        Manual import uses the documented fixture CSV format. Compatibility with a bank's live
        settlement file must be verified before importing it.
      </p>
      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex flex-col gap-1 text-sm min-w-0 flex-1">
          Park
          <select
            aria-label="Settlement park"
            className="h-10 rounded-lg border bg-background px-2 min-w-0"
            value={branchId}
            disabled={busy}
            onChange={(event) => {
              setBranchId(event.target.value);
              setResult(null);
              setError(null);
            }}
          >
            <option value="">Choose park</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Business date
          <input
            aria-label="Settlement business date"
            className="h-10 rounded-lg border bg-background px-2"
            type="date"
            value={date}
            disabled={busy}
            onChange={(event) => {
              setDate(event.target.value);
              setResult(null);
              setError(null);
            }}
          />
        </label>
        <Button
          variant="outline"
          disabled={busy || !branchId || !date}
          onClick={() => {
            setError(null);
            setRefresh((value) => value + 1);
          }}
        >
          Refresh matches
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm min-w-0 flex-1">
          Settlement CSV · maximum 2 MB
          <input
            aria-label="2C2P settlement CSV"
            className="w-full min-w-0 text-sm"
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setResult(null);
              setError(null);
              importIdentity.current = null;
            }}
          />
        </label>
        <Button disabled={busy || !file || !branchId || !date} onClick={() => void importFile()}>
          {busy ? 'Importing…' : 'Import settlement'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Choose the park and business date covered by the file. Only payments from that park and day
        can match. Maximum 10,000 detail rows.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Fixture CSV format</summary>
        <p className="mt-2 break-all">
          TYPE_TABLE,invoiceNo,tranRef,paymentID,amount,currencyCode,transactionType,method
        </p>
        <p className="mt-1">
          Include an H row and D detail rows. Method is card or qr; amounts are in baht and currency
          is THB. Transaction type is payment, refund or chargeback. Refunds and chargebacks stay
          visible for review and do not confirm a payment.
        </p>
      </details>
      {error && (
        <p role="alert" className="text-sm text-amber-600">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm">
          {result.replayed ? 'This file was already imported.' : 'Import recorded.'}{' '}
          {result.matched} matched · {result.unmatched} unmatched · {result.mismatched} differ.{' '}
          {result.state === 'attention'
            ? 'Review the differences before accepting the figures.'
            : ''}
        </p>
      )}
      {data && (
        <div className="space-y-2">
          <p className="text-sm font-semibold">
            {data.batches.length} batches · {data.unmatchedAttempts.length} payments without a
            matched settlement
          </p>
          {data.lines.length > 0 && (
            <details className="rounded-lg border p-3">
              <summary className="cursor-pointer text-sm">
                Review batch lines ({data.lines.length})
              </summary>
              <ul className="divide-y mt-2">
                {data.lines.map((line) => (
                  <li key={line.id} className="py-2 text-sm break-words">
                    <div className="flex flex-wrap justify-between gap-2">
                      <span>
                        {line.invoiceNo ?? line.tranRef ?? 'No reference'} ·{' '}
                        {line.method.toUpperCase()} · {line.transactionType ?? 'payment'}
                      </span>
                      <strong>{formatTHB(line.amountSatang)}</strong>
                    </div>
                    <p className={line.match === 'matched' ? 'text-emerald-600' : 'text-amber-600'}>
                      {line.match.replaceAll('_', ' ')}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </CardShell>
  );
}
