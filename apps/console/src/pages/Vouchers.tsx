import { useEffect, useState } from 'react';
import { formatTHB } from '@oto/shared';
import { useSession } from '@/auth/SessionContext';
import { directoryApi, type BranchRow } from '@/api/platform';
import { staffCandidates, type BranchStaffMember } from '@/api/fleet';
import {
  voucherLedgerApi,
  VOUCHER_LEDGER_STATUSES,
  type VoucherLedger,
  type VoucherLedgerFilters,
} from '@/api/vouchers';
import {
  boothApi,
  type BoothListRow,
  type VoucherDefinitionRow,
} from '@/components/booth/boothApi';
import { CONTROL, Labelled, SelectFilter } from '@/components/Filters';
import { EmptyState, ErrorNote, Loading, Panel } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { formatWhen } from '@/lib/time';

const statusWords = {
  issued: 'Issued, not printed',
  printed: 'Printed',
  held: 'On a till’s cart',
  redeemed: 'Redeemed',
  expired: 'Expired',
  void: 'Void',
};

export function Vouchers() {
  const { me } = useSession();
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState(me?.branch?.id ?? '');
  const [types, setTypes] = useState<VoucherDefinitionRow[]>([]);
  const [booths, setBooths] = useState<BoothListRow[]>([]);
  const [staff, setStaff] = useState<BranchStaffMember[]>([]);
  const [filters, setFilters] = useState<VoucherLedgerFilters>({});
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<VoucherLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const timezone = branches.find((b) => b.id === branchId)?.timezone ?? me?.branch?.timezone;

  useEffect(() => {
    void Promise.all([directoryApi.branches(), boothApi.voucherDefinitions(true)])
      .then(([b, t]) => {
        const live = b.branches.filter((row) => !row.archived);
        setBranches(live);
        setBranchId((id) => id || live[0]?.id || '');
        setTypes(t.definitions);
      })
      .catch((e: unknown) =>
        setLookupError(e instanceof Error ? e.message : 'Could not load filters.'),
      );
  }, []);

  useEffect(() => {
    if (!branchId) return;
    let active = true;
    setBooths([]);
    setStaff([]);
    void Promise.allSettled([boothApi.list(branchId), staffCandidates(branchId)]).then(([b, s]) => {
      if (!active) return;
      if (b.status === 'fulfilled') setBooths(b.value.booths);
      if (s.status === 'fulfilled') setStaff(s.value.staff);
      setLookupError(
        b.status === 'rejected' || s.status === 'rejected'
          ? 'Some filter names could not be loaded. The voucher list is still available.'
          : null,
      );
    });
    return () => {
      active = false;
    };
  }, [branchId]);

  useEffect(() => {
    if (!branchId) return;
    let active = true;
    setData(null);
    setError(null);
    void voucherLedgerApi
      .list(branchId, filters, offset)
      .then((answer) => {
        if (active) setData(answer);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not read vouchers.');
      });
    return () => {
      active = false;
    };
  }, [branchId, filters, offset, refresh]);

  const change = (next: Partial<VoucherLedgerFilters>) => {
    setOffset(0);
    setFilters((held) => ({ ...held, ...next }));
  };
  const download = async () => {
    setDownloading(true);
    try {
      const response = await fetch(voucherLedgerApi.exportUrl(branchId, filters), {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? 'The download failed.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download =
        response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        'vouchers.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The download failed.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Vouchers"
        description="Booth and counter vouchers, by the park’s trading day. Only the last four characters of each code are shown."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setRefresh((n) => n + 1)}>
              Refresh
            </Button>
            <Button size="sm" disabled={!data || downloading} onClick={() => void download()}>
              Download CSV
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
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
          <Labelled label="From day">
            <input
              className={CONTROL}
              type="date"
              value={filters.from ?? data?.range.from ?? ''}
              onChange={(e) => change({ from: e.target.value || undefined })}
            />
          </Labelled>
          <Labelled label="To day">
            <input
              className={CONTROL}
              type="date"
              value={filters.to ?? data?.range.to ?? ''}
              onChange={(e) => change({ to: e.target.value || undefined })}
            />
          </Labelled>
          <SelectFilter
            label="Voucher type"
            value={filters.definitionId ?? ''}
            onChange={(value) => change({ definitionId: value || undefined })}
            options={types.map((t) => ({ value: t.id, label: t.nameEn }))}
          />
          <SelectFilter
            label="Booth / counter"
            value={filters.stationId ?? ''}
            onChange={(value) => change({ stationId: value || undefined })}
            options={[
              ...booths.map((b) => ({ value: b.id, label: b.name })),
              { value: 'counter', label: 'Counter issues' },
            ]}
          />
          <SelectFilter
            label="Issued by"
            value={filters.issuedBy ?? ''}
            onChange={(value) => change({ issuedBy: value || undefined })}
            options={[
              { value: 'unattributed', label: 'Unattributed' },
              ...staff.map((s) => ({ value: s.accountId, label: s.name ?? s.accountId })),
            ]}
          />
          <SelectFilter
            label="Status"
            value={filters.status ?? ''}
            onChange={(value) =>
              change({ status: (value as VoucherLedgerFilters['status']) || undefined })
            }
            options={VOUCHER_LEDGER_STATUSES.map((value) => ({ value, label: statusWords[value] }))}
          />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Dates and times use {timezone ?? 'the branch timezone'}. Offline booth activity appears
          after the box syncs.
        </p>
        {lookupError && <p className="mt-2 text-sm text-muted-foreground">{lookupError}</p>}
      </Panel>
      {error && <ErrorNote message={error} onRetry={() => setRefresh((n) => n + 1)} />}
      {!data && !error && <Loading what="vouchers" />}
      {data && (
        <>
          <Panel
            title="Totals by voucher type"
            description="All rows matching the filters, across every page. Value handed over is what the redeeming sale took off; gifts without a sale price are counted separately."
          >
            {data.totals.length === 0 ? (
              <EmptyState title="No vouchers in this range" />
            ) : (
              <div className="flex flex-wrap gap-3">
                {data.totals.map((t) => (
                  <div key={t.type.id} className="rounded-xl border p-3 min-w-56">
                    <p className="font-semibold">{t.type.nameEn}</p>
                    <p className="text-sm">
                      {t.issued} issued · {t.redeemed} redeemed · {t.expired} expired
                    </p>
                    <p className="text-sm">
                      {((t.redemptionRate ?? 0) * 100).toFixed(1)}% redeemed ·{' '}
                      {t.valueKind === 'gift'
                        ? `${t.redeemed} gifts handed over`
                        : `${formatTHB(t.handedOverSatang)} handed over`}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title={`${data.total} vouchers`}>
            {data.rows.length === 0 ? (
              <EmptyState title="No matching vouchers" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead>
                    <tr>
                      {[
                        'Issued at',
                        'Type / prize',
                        'Value handed over',
                        'Booth / counter',
                        'Issued by',
                        'Code · last 4',
                        'Status',
                        'Redemption',
                      ].map((h) => (
                        <th key={h} className="p-2 border-b whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id} className="border-b align-top">
                        <td className="p-2 whitespace-nowrap">
                          {formatWhen(r.issuedAt, timezone)}
                        </td>
                        <td className="p-2">
                          {r.type.nameEn}
                          {r.prize && r.prize.nameEn !== r.type.nameEn && (
                            <div className="text-muted-foreground">{r.prize.nameEn}</div>
                          )}
                        </td>
                        <td className="p-2">
                          {r.value.text}
                          <div className="text-muted-foreground">
                            {r.value.redeemedSatang !== null
                              ? `${formatTHB(r.value.redeemedSatang)} handed over`
                        : r.redeemed
                          ? r.value.kind === 'gift' ? 'Gift handed over' : 'Value not recorded'
                                : 'Not redeemed'}
                          </div>
                        </td>
                        <td className="p-2">{r.place.name}</td>
                        <td className="p-2">
                          {r.issuedBy
                            ? `${r.issuedBy.name ?? 'Staff'} (${r.issuedBy.code})`
                            : 'Unattributed'}
                        </td>
                        <td className="p-2 font-mono">{r.codeLast4}</td>
                        <td className="p-2">{statusWords[r.status]}</td>
                        <td className="p-2 min-w-56">
                          {r.redeemed ? (
                            <>
                              {formatWhen(r.redeemed.at, timezone)}
                              <div>
                                {r.redeemed.branchName} · {r.redeemed.stationName}
                              </div>
                              <div>
                                {r.redeemed.by?.name ?? r.redeemed.by?.code ?? 'Unattributed'}
                              </div>
                              <div className="break-all">
                                Sale:{' '}
                                {r.redeemed.receiptNumber ?? r.redeemed.saleId ?? 'Not recorded'}
                              </div>
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
                onClick={() => setOffset((n) => Math.max(0, n - 50))}
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
                onClick={() => setOffset((n) => n + 50)}
              >
                Next
              </Button>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
