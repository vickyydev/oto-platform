import { useEffect, useMemo, useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { downloadCsv } from '@/lib/csv';
import {
  defaultReportFilters,
  platformWalletCreditReport,
  promoUsageSummary,
  type WalletCreditReport,
} from '@/lib/reporting';
import { ReportFilterBar, ReportCard, ExportCsvButton, EmptyRow, ShellBanner, csvBaht, thbFromSatang } from './shared';

const EMPTY_REPORT: WalletCreditReport = {
  summary: { grantedSatang: 0, spentSatang: 0, refundedSatang: 0, expiredSatang: 0, netOutstandingSatang: 0, entryCount: 0 },
  rows: [],
  totalEntries: 0,
};

/**
 * Wallet-credit + promo-code usage report.
 *
 * S2-14a round 3 — the wallet half reads the PLATFORM's ledger
 * (`platformWalletCreditReport`, `GET /wallets/report`): the figures are the
 * entries summed by kind over the range's business dates, the live balance is
 * the sum of every wallet's balance today, and a wallet belongs to the park
 * that issued it, so the branch filter now applies to it. The promo half is
 * still the catalog's mock counters until vouchers move (round 5).
 *
 * Note: usedCount/usageLimit on each promo row are lifetime, network-wide
 * catalog counters, but totalDiscountValueSatang is scoped to the current date
 * range + branch filter — the two numbers describe different windows by
 * design, and the table header/CSV label reflect that.
 */
export function WalletPromoReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());
  const [report, setReport] = useState<WalletCreditReport>(EMPTY_REPORT);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setLoadError(null);
    platformWalletCreditReport(filters)
      .then((next) => { if (live) setReport(next); })
      .catch((err: unknown) => {
        if (!live) return;
        setReport(EMPTY_REPORT);
        setLoadError(err instanceof Error ? err.message : 'The wallet figures could not be loaded.');
      });
    return () => { live = false; };
  }, [filters]);
  const summary = report.summary;
  const ledger = report.rows;
  const promos = useMemo(() => promoUsageSummary(filters), [filters]);

  const exportLedger = async () => {
    const all = await platformWalletCreditReport(filters, 1000);
    downloadCsv(
      `wallet-ledger_${filters.startDate}_${filters.endDate}`,
      ['Wristband', 'Customer', 'Kind', 'Amount', 'Source', 'At', 'By'],
      all.rows.map((r) => [
        r.wristbandCode,
        r.customerNickname,
        r.kind,
        csvBaht(r.amountSatang),
        r.source,
        r.at,
        r.by ?? '',
      ])
    );
  };

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={setFilters} />

      {loadError && (
        <ShellBanner>
          The wallet figures could not be loaded from the platform — {loadError}
        </ShellBanner>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { label: 'Granted', value: summary.grantedSatang },
          { label: 'Spent', value: summary.spentSatang },
          { label: 'Refunded', value: summary.refundedSatang },
          { label: 'Expired', value: summary.expiredSatang },
          { label: 'Live balance (today)', value: summary.netOutstandingSatang },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="text-[11px] uppercase tracking-wide text-foreground/45">{s.label}</div>
            <div className="mt-1 text-lg font-bold tabular-nums">{thbFromSatang(s.value)}</div>
          </div>
        ))}
      </div>
      {(summary.reactivatedSatang ?? 0) > 0 && (
        <p className="-mt-3 text-xs text-foreground/50">
          Includes {thbFromSatang(summary.reactivatedSatang ?? 0)} of expired credit a manager reactivated in this range.
        </p>
      )}

      <ReportCard
        title={`Wallet ledger — ${ledger.length} of ${summary.entryCount} entries shown`}
        action={<ExportCsvButton onExport={() => { void exportLedger(); }} />}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Wristband</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ledger.length === 0 && <EmptyRow colSpan={6} />}
            {ledger.map((r, i) => (
              <TableRow key={`${r.wristbandCode}-${i}`}>
                <TableCell className="font-mono text-xs">{r.wristbandCode}</TableCell>
                <TableCell>{r.customerNickname}</TableCell>
                <TableCell className="capitalize">{r.kind}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(r.amountSatang)}</TableCell>
                <TableCell className="text-xs text-foreground/60">{r.source}</TableCell>
                <TableCell className="text-xs text-foreground/60">
                  {new Date(r.at).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>

      <ReportCard
        title="Promo code usage"
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `promo-code-usage_${filters.startDate}_${filters.endDate}`,
                ['Code', 'Label', 'Type', 'Used', 'Limit', 'Active', 'Total discount value'],
                promos.map((p) => [
                  p.code,
                  p.label,
                  p.type,
                  p.usedCount,
                  p.usageLimit ?? '',
                  p.active ? 'yes' : 'no',
                  csvBaht(p.totalDiscountValueSatang),
                ])
              )
            }
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Used</TableHead>
              <TableHead className="text-right">Limit</TableHead>
              <TableHead className="text-right">Discount value (range)</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {promos.length === 0 && <EmptyRow colSpan={7} label="No promo codes have been used yet." />}
            {promos.map((p) => (
              <TableRow key={p.code}>
                <TableCell className="font-mono text-xs">{p.code}</TableCell>
                <TableCell>{p.label}</TableCell>
                <TableCell className="capitalize">{p.type.replace('_', ' ')}</TableCell>
                <TableCell className="text-right tabular-nums">{p.usedCount}</TableCell>
                <TableCell className="text-right tabular-nums">{p.usageLimit ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{thbFromSatang(p.totalDiscountValueSatang)}</TableCell>
                <TableCell>
                  <Badge variant={p.active ? 'secondary' : 'outline'} className="text-[10px]">
                    {p.active ? 'active' : 'inactive'}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ReportCard>
    </div>
  );
}
