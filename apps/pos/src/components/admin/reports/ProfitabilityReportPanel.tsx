import { useState } from 'react';
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
import type { ProfitabilityReport } from '@oto/shared';
import { defaultReportFilters, type ProfitabilityRow, type ReportFilters } from '@/lib/reporting';
import { analyticsReportsApi } from '@/api/analyticsReports';
import {
  ReportFilterBar,
  ReportCard,
  ExportCsvButton,
  EmptyRow,
  ReportLoadError,
  ShellBanner,
  csvBaht,
  thbFromSatang,
  usePlatformReport,
} from './shared';

/** No figures yet, or none for the range. */
export const EMPTY_PROFITABILITY_REPORT: ProfitabilityReport = {
  from: '',
  to: '',
  branches: [],
  omitted: [],
  fnb: [],
  merch: [],
};

function ProfitabilityTable({ rows, exportName, filters }: { rows: ProfitabilityRow[]; exportName: string; filters: { startDate: string; endDate: string } }) {
  const totalRevenue = rows.reduce((s, r) => s + r.revenueSatang, 0);
  const totalCogs = rows.reduce((s, r) => s + r.cogsSatang, 0);
  const totalMargin = totalRevenue - totalCogs;

  return (
    <ReportCard
      title={`Revenue ${thbFromSatang(totalRevenue)} · COGS ${thbFromSatang(totalCogs)} · Margin ${thbFromSatang(totalMargin)}`}
      action={
        <ExportCsvButton
          onExport={() =>
            downloadCsv(
              `${exportName}_${filters.startDate}_${filters.endDate}`,
              ['Item', 'Qty', 'Revenue', 'COGS', 'Margin', 'Margin %', 'Cost tracked'],
              rows.map((r) => [
                r.name,
                r.qty,
                csvBaht(r.revenueSatang),
                csvBaht(r.cogsSatang),
                csvBaht(r.marginSatang),
                r.marginPercent.toFixed(1),
                r.costTracked ? 'yes' : 'no',
              ])
            )
          }
        />
      }
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead className="text-right">Qty</TableHead>
            <TableHead className="text-right">Revenue</TableHead>
            <TableHead className="text-right">COGS</TableHead>
            <TableHead className="text-right">Margin</TableHead>
            <TableHead className="text-right">Margin %</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && <EmptyRow colSpan={6} />}
          {rows.map((r) => (
            <TableRow key={r.itemId}>
              <TableCell className="flex items-center gap-1.5">
                {r.name}
                {!r.costTracked && (
                  <Badge variant="outline" className="text-[10px] text-foreground/40">
                    no cost set
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{r.qty}</TableCell>
              <TableCell className="text-right tabular-nums">{thbFromSatang(r.revenueSatang)}</TableCell>
              <TableCell className="text-right tabular-nums">{thbFromSatang(r.cogsSatang)}</TableCell>
              <TableCell className="text-right tabular-nums">{thbFromSatang(r.marginSatang)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {r.costTracked ? `${r.marginPercent.toFixed(1)}%` : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ReportCard>
  );
}

/**
 * Profitability report — F&B and merch margin against the cost of goods.
 * S2-15b round 4: the platform's daily item rows
 * (`GET /analytics/reports/profitability`): revenue as sold, and the cost
 * frozen on the stock ledger when each line sold — the catalogue's cost where
 * nothing moved (S2-14b round 4's rule). Items with units of no known cost
 * are flagged rather than silently treated as free.
 */
export function ProfitabilityReportPanel() {
  const [filters, setFilters] = useState(defaultReportFilters());
  const { data, error } = usePlatformReport(filters, analyticsReportsApi.profitability, EMPTY_PROFITABILITY_REPORT);
  return <ProfitabilityReportView filters={filters} onFiltersChange={setFilters} report={data} error={error} />;
}

/** The panel as drawn from one answer. */
export function ProfitabilityReportView({
  filters,
  onFiltersChange,
  report,
  error = null,
}: {
  filters: ReportFilters;
  onFiltersChange: (next: ReportFilters) => void;
  report: ProfitabilityReport;
  error?: string | null;
}) {
  const fnbRows: ProfitabilityRow[] = report.fnb;
  const merchRows: ProfitabilityRow[] = report.merch;
  const anyUntracked = [...fnbRows, ...merchRows].some((r) => !r.costTracked && r.qty > 0);

  return (
    <div className="flex flex-col gap-5">
      <ReportFilterBar filters={filters} onChange={onFiltersChange} />
      <ReportLoadError error={error} />
      {anyUntracked && (
        <ShellBanner>
          Some items sold in this range have no cost-to-park set in the catalog. Their COGS shows
          as ฿0 and margin is understated — set a cost on those items (Admin → F&B Menu / Merch)
          for an accurate figure.
        </ShellBanner>
      )}
      <ProfitabilityTable rows={fnbRows} exportName="fnb-profitability" filters={filters} />
      <ProfitabilityTable rows={merchRows} exportName="merch-profitability" filters={filters} />
    </div>
  );
}
