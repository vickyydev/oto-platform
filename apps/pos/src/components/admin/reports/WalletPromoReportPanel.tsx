import { useMemo, useState } from 'react';
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
  walletCreditSummary,
  walletLedgerRows,
  promoUsageSummary,
} from '@/lib/reporting';
import { ReportFilterBar, ReportCard, ExportCsvButton, EmptyRow, ShellBanner, thb } from './shared';

/**
 * Wallet-credit + promo-code usage report. Wristband records carry no
 * branchId in the data model, so the wallet section is always network-wide
 * (flagged below) regardless of the branch filter — the date range still
 * applies to ledger entries.
 *
 * Note: usedCount/usageLimit on each promo row are lifetime, network-wide
 * catalog counters, but totalDiscountValueTHB is scoped to the current date
 * range + branch filter — the two numbers describe different windows by
 * design, and the table header/CSV label reflect that.
 */
export function WalletPromoReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());
  const summary = useMemo(() => walletCreditSummary(filters), [filters]);
  const ledger = useMemo(() => walletLedgerRows(filters).slice(0, 100), [filters]);
  const promos = useMemo(() => promoUsageSummary(filters), [filters]);

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={setFilters} />

      <ShellBanner>
        Wristband wallet balances are not tagged by branch in the data model — this section is
        always network-wide, regardless of the branch filter above.
      </ShellBanner>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          { label: 'Granted', value: summary.grantedTHB },
          { label: 'Spent', value: summary.spentTHB },
          { label: 'Refunded', value: summary.refundedTHB },
          { label: 'Expired', value: summary.expiredTHB },
          { label: 'Live balance (today)', value: summary.netOutstandingTHB },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-3">
            <div className="text-[11px] uppercase tracking-wide text-foreground/45">{s.label}</div>
            <div className="mt-1 text-lg font-bold tabular-nums">{thb(s.value)}</div>
          </div>
        ))}
      </div>

      <ReportCard
        title={`Wallet ledger — ${ledger.length} of ${summary.entryCount} entries shown`}
        action={
          <ExportCsvButton
            onExport={() =>
              downloadCsv(
                `wallet-ledger_${filters.startDate}_${filters.endDate}`,
                ['Wristband', 'Customer', 'Kind', 'Amount', 'Source', 'At', 'By'],
                walletLedgerRows(filters).map((r) => [
                  r.wristbandCode,
                  r.customerNickname,
                  r.kind,
                  r.amountTHB.toFixed(2),
                  r.source,
                  r.at,
                  r.by ?? '',
                ])
              )
            }
          />
        }
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
                <TableCell className="text-right tabular-nums">{thb(r.amountTHB)}</TableCell>
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
                  p.totalDiscountValueTHB.toFixed(2),
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
                <TableCell className="text-right tabular-nums">{thb(p.totalDiscountValueTHB)}</TableCell>
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
